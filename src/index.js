/**
 * Lotsy Telegram Bot — Cloudflare Worker
 * -----------------------------------------------------------------------------
 * Webhook handler for @LotsyInventoryBot. Lets you (and your wife) manage
 * inventory by texting commands in a Telegram group.
 *
 * DEPLOY:
 *   1. Paste this file into a Cloudflare Worker (Workers & Pages → Create Worker).
 *   2. Add these Secrets in the Worker dashboard (Settings → Variables):
 *        TELEGRAM_BOT_TOKEN       — from @BotFather
 *        ALLOWED_USERS            — comma-separated Telegram user IDs: "123,456"
 *        SUPABASE_URL             — https://zofjrvsyntdifdafvqxq.supabase.co
 *        SUPABASE_SERVICE_ROLE_KEY — Supabase dashboard → Settings → API → service_role
 *   3. Deploy. Copy the worker URL (e.g. https://lotsy-bot.kyle.workers.dev).
 *   4. Set the Telegram webhook:
 *        https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>
 *      Should reply {"ok":true}.
 *   5. In BotFather: /mybots → your bot → Bot Settings → Group Privacy → DISABLE
 *      (so the bot can read all group messages, not just /commands)
 *
 * LOG:
 *   The worker prints detailed logs visible in Cloudflare dashboard → Workers
 *   → your worker → Logs. Watch these if something seems wrong.
 * =============================================================================
 */

// ============================================================================
// TELEGRAM API HELPERS
// ============================================================================

async function sendMessage(env, chatId, text, opts = {}) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'HTML', ...opts };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('Telegram sendMessage failed:', await res.text());
  }
  return res;
}

// ============================================================================
// SUPABASE REST HELPERS
// ----------------------------------------------------------------------------
// Using raw REST instead of the supabase-js client because Workers don't
// support it cleanly and the REST surface we need is small.
// ============================================================================

async function sb(env, method, path, body = null, headers = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' || method === 'PATCH' ? 'return=representation' : '',
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Supabase ${method} ${path} failed:`, err);
    throw new Error(err);
  }
  if (res.status === 204) return null;
  return res.json();
}

const loadSkus = (env) => sb(env, 'GET', 'skus?select=*&order=sku_code');
const loadUnitsForSku = (env, skuId, status = 'inventory') =>
  sb(env, 'GET', `units?sku_id=eq.${skuId}&status=eq.${status}&select=*&order=unit_code&limit=100`);
const loadUnitByCode = (env, unitCode) =>
  sb(env, 'GET', `units?unit_code=eq.${encodeURIComponent(unitCode)}&select=*,skus(*)`);
const markUnitSold = (env, unitId) =>
  sb(env, 'PATCH', `units?id=eq.${unitId}`, { status: 'sold' });
const insertSale = (env, sale) => sb(env, 'POST', 'sales', sale);
const insertDamage = (env, report) => sb(env, 'POST', 'damage_reports', report);

// ============================================================================
// FUZZY SKU MATCHING
// ----------------------------------------------------------------------------
// Handles "busy book", "busybook", "busy buk", and partial names. Returns the
// best match plus the next-best alternatives for ambiguity resolution.
// ============================================================================

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreMatch(query, sku) {
  const q = normalize(query);
  const name = normalize(sku.name);
  const code = normalize(sku.sku_code);
  if (q === name || q === code) return 1000;
  if (name.startsWith(q) || q.startsWith(name)) return 500;
  if (name.includes(q) || q.includes(name)) return 300;
  // Token-level match — every query word appears in name
  const qTokens = q.split(' ').filter(Boolean);
  const nameTokens = new Set(name.split(' ').filter(Boolean));
  const allMatch = qTokens.every(t => [...nameTokens].some(nt => nt.includes(t) || t.includes(nt)));
  if (allMatch && qTokens.length > 0) return 150;
  // Character-level last resort
  if (code.includes(q)) return 100;
  return 0;
}

function findSku(skus, query) {
  const scored = skus.map(s => ({ sku: s, score: scoreMatch(query, s) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    best: scored[0]?.sku || null,
    bestScore: scored[0]?.score || 0,
    alternatives: scored.slice(1, 4).map(x => x.sku),
    ambiguous: scored.length > 1 && scored[0].score - scored[1].score < 50,
  };
}

// ============================================================================
// COMMAND PARSER
// ----------------------------------------------------------------------------
// Accepts loose natural language: "sold busy book 22", "mark busy book sold 22",
// "busy book gone, 22 bucks", etc. Returns { cmd, args } or { cmd: 'unknown' }.
// ============================================================================

const PLATFORM_KEYWORDS = {
  fb_marketplace: ['fb', 'facebook', 'marketplace', 'fbm'],
  ebay: ['ebay'],
  mercari: ['mercari'],
  offerup: ['offerup', 'offer up'],
};

function extractPlatform(text) {
  const t = text.toLowerCase();
  for (const [key, words] of Object.entries(PLATFORM_KEYWORDS)) {
    if (words.some(w => t.includes(w))) return key;
  }
  return 'fb_marketplace'; // default
}

function extractPrice(text, skipValue) {
  // Prefer explicit $-prefixed numbers (highest confidence)
  const dollar = text.match(/\$(\d+(?:\.\d{1,2})?)/);
  if (dollar) return parseFloat(dollar[1]);
  // Next-best: "for N" or "at N" pattern
  const forAt = text.match(/\b(?:for|at)\s+\$?(\d+(?:\.\d{1,2})?)\b/i);
  if (forAt) return parseFloat(forAt[1]);
  // Fallback: the LAST plain number in the string, skipping a specific value
  // (used to avoid grabbing the qty number as the price)
  const matches = [...text.matchAll(/\b(\d+(?:\.\d{1,2})?)\b/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const val = parseFloat(matches[i][1]);
    if (skipValue != null && val === skipValue) continue;
    return val;
  }
  return null;
}

function extractQty(text) {
  // "sold 2 <word>" or "sell 5 of"
  const m = text.match(/\b(?:sold|sell|sale|mark|marked)\s+(\d+)\s+\w/i);
  if (m) {
    const n = parseInt(m[1]);
    if (n >= 1 && n <= 50) return n;
  }
  return 1;
}

function extractUnitCode(text) {
  // Match patterns like "QM-001-A015", "ADS-052-A001"
  const m = text.match(/\b([A-Z]{2,4}-\d{2,4}-A\d{1,5})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function parseCommand(text) {
  const raw = text.trim();
  const t = raw.toLowerCase();

  if (!t) return { cmd: 'unknown' };

  // Help
  if (/^(help|\/help|\/start|commands)$/i.test(t)) return { cmd: 'help' };

  // Undo — optional argument picks which of last 5 actions to reverse
  const undoMatch = t.match(/^(?:undo|\/undo|revert|nvm|nevermind)(?:\s+(\w+))?$/i);
  if (undoMatch) return { cmd: 'undo', which: undoMatch[1] || null };

  // Today / week / total / stock
  if (/^(today|\/today|today.?s)$/i.test(t)) return { cmd: 'summary', range: 'today' };
  if (/^(week|\/week|this week)$/i.test(t)) return { cmd: 'summary', range: 'week' };
  if (/^(total|\/total|all time|lifetime)$/i.test(t)) return { cmd: 'summary', range: 'all' };

  // Stock [sku]
  const stockMatch = t.match(/^(?:stock|inventory|how many)\s*(.*)/);
  if (stockMatch) {
    return { cmd: 'stock', query: stockMatch[1].trim() };
  }

  // Digest — current status of all active listings
  if (/^(digest|status|brief|performance)$/i.test(t)) return { cmd: 'digest' };

  // Pause/resume monitoring on a specific unit
  const pauseMatch = t.match(/^(?:pause|mute)\s+([A-Z]{2,4}-\d{2,4}-A\d{1,5})$/i);
  if (pauseMatch) return { cmd: 'pause_monitor', unitCode: pauseMatch[1].toUpperCase() };
  const resumeMatch = t.match(/^(?:resume|unmute)\s+([A-Z]{2,4}-\d{2,4}-A\d{1,5})$/i);
  if (resumeMatch) return { cmd: 'resume_monitor', unitCode: resumeMatch[1].toUpperCase() };

  // Metrics reply — detected by shape (contains "N: ..." pattern)
  // This goes AFTER word-based commands so "stock", "sold" etc don't get misrouted.
  if (looksLikeMetricsReply(raw)) {
    return { cmd: 'metrics_reply', text: raw };
  }

  // Sold — multiple patterns
  // "sold <sku> <price> [platform]"
  // "sold 2 <sku> for <price>"
  // "<sku> sold <price>"
  // "sold a <sku> for <price>"
  if (/\b(sold|sell|sale|gone)\b/i.test(t)) {
    const unitCode = extractUnitCode(raw);
    const qty = extractQty(raw);
    const price = extractPrice(raw, qty > 1 ? qty : null);
    const platform = extractPlatform(raw);
    // Strip command words + price + platform to get what's left (the SKU name)
    let query = raw
      .replace(/\b(sold|sell|sale|gone|a|for|at|the|mark|marked|bucks|dollars)\b/gi, ' ')
      .replace(/\$?\d+(?:\.\d{1,2})?/g, ' ')
      .replace(new RegExp(`\\b(${Object.values(PLATFORM_KEYWORDS).flat().join('|')})\\b`, 'gi'), ' ')
      .replace(new RegExp(unitCode || '__nomatch__', 'gi'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { cmd: 'sold', query, price, platform, unitCode, qty };
  }

  // Damage
  if (/\b(damage[d]?|broken|cracked|ruined)\b/i.test(t)) {
    const unitCode = extractUnitCode(raw);
    const qtyMatch = raw.match(/\b(\d+)\s*(?:units?|pcs?|pieces?|items?)?\b/);
    const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
    let query = raw
      .replace(/\b(damage[d]?|broken|cracked|ruined|units?|pcs?|pieces?|items?|the|a)\b/gi, ' ')
      .replace(/\d+/g, ' ')
      .replace(new RegExp(unitCode || '__nomatch__', 'gi'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { cmd: 'damage', query, qty, unitCode };
  }

  return { cmd: 'unknown', raw };
}

// ============================================================================
// COMMAND HANDLERS — each returns a reply string
// ============================================================================

const HELP_TEXT = `<b>Lotsy commands</b>

<b>Mark sold</b>
• <code>sold busy book 22</code>
• <code>sold QM-001-A015 22</code>
• <code>sold busy book 22 ebay</code>

<b>Check stock</b>
• <code>stock</code> — full summary
• <code>stock busy book</code> — one SKU

<b>Report damage</b>
• <code>damaged busy book 3</code>
• <code>damaged QM-001-A015</code>

<b>Numbers</b>
• <code>today</code> — today's sales
• <code>week</code> — this week
• <code>total</code> — all time

<b>Oops</b>
• <code>undo</code> — shows last 5 actions, pick which to reverse
• <code>undo 3</code> — reverses action #3 from the list
• <code>undo last</code> — reverses the most recent action

<b>Listing performance</b>
• <code>digest</code> — current status of all active listings
• Reply to a check round with lines like <code>1: 12 2 0</code>
• <code>skip</code> — skip the current round
• <code>pause QM-001-A015</code> — stop monitoring a listing
• <code>resume QM-001-A015</code> — turn monitoring back on

Default platform is FB Marketplace. Add <code>ebay</code>, <code>mercari</code>, or <code>offerup</code> to override.`;

async function handleSold(env, parsed, userName) {
  // Case 1: explicit unit code — mark that specific unit (qty always 1)
  if (parsed.unitCode) {
    const rows = await loadUnitByCode(env, parsed.unitCode);
    const unit = rows[0];
    if (!unit) return `❌ Unit <code>${parsed.unitCode}</code> not found.`;
    if (unit.status === 'sold') return `⚠️ ${parsed.unitCode} is already sold.`;

    if (!parsed.price) return `How much did ${unit.skus.name} (${parsed.unitCode}) sell for? Reply <code>sold ${parsed.unitCode} 22</code>.`;

    const saleResult = await insertSale(env, {
      unit_id: unit.id,
      platform: parsed.platform,
      sold_price: parsed.price,
      sold_at: new Date().toISOString(),
      notes: `via Telegram (${userName})`,
    });
    await markUnitSold(env, unit.id);

    // Remember for undo
    await rememberLastAction(env, parsed._userId, {
      type: 'sold',
      payload: {
        sale_ids: saleResult && saleResult[0] ? [saleResult[0].id] : [],
        unit_ids: [unit.id],
        sku_name: unit.skus.name,
        qty: 1,
      },
    });

    const remaining = await loadUnitsForSku(env, unit.sku_id);
    return `✅ Sold <b>${unit.skus.name}</b> (${parsed.unitCode}) for $${parsed.price} via ${platformLabel(parsed.platform)}.\n<i>${remaining.length} in stock.</i>`;
  }

  // Case 2: SKU name/query — find the SKU and pick next available unit(s)
  if (!parsed.query) {
    return `I need a SKU name. Try: <code>sold busy book 22</code>`;
  }
  if (!parsed.price) {
    return `What price? Try: <code>sold ${parsed.query} 22</code>`;
  }

  const qty = parsed.qty || 1;
  const skus = await loadSkus(env);
  const match = findSku(skus, parsed.query);
  if (!match.best) {
    return `❌ No SKU matches "${parsed.query}". Try <code>stock</code> to see your SKUs.`;
  }
  if (match.ambiguous && match.alternatives.length > 0) {
    const options = [match.best, ...match.alternatives]
      .map((s, i) => `${i + 1}. ${s.name} (${s.sku_code})`).join('\n');
    return `🤔 Did you mean one of these?\n${options}\n\nReply with the full name, e.g. <code>sold ${match.best.name.toLowerCase()} ${parsed.price}</code>`;
  }

  const sku = match.best;
  const availableUnits = await loadUnitsForSku(env, sku.id);
  if (availableUnits.length === 0) {
    return `❌ No ${sku.name} in stock.`;
  }
  if (availableUnits.length < qty) {
    return `❌ Only ${availableUnits.length} ${sku.name} in stock (you asked for ${qty}).`;
  }

  // Sell N units at $price each
  const unitsToSell = availableUnits.slice(0, qty);
  const soldCodes = [];
  const saleIds = [];
  for (const unit of unitsToSell) {
    const saleResult = await insertSale(env, {
      unit_id: unit.id,
      platform: parsed.platform,
      sold_price: parsed.price,
      sold_at: new Date().toISOString(),
      notes: `via Telegram (${userName})`,
    });
    await markUnitSold(env, unit.id);
    soldCodes.push(unit.unit_code);
    if (saleResult && saleResult[0]) saleIds.push(saleResult[0].id);
  }

  // Remember for undo — last action wins (batch sales remembered as a group)
  await rememberLastAction(env, parsed._userId, {
    type: 'sold',
    payload: {
      sale_ids: saleIds,
      unit_ids: unitsToSell.map(u => u.id),
      sku_name: sku.name,
      qty,
    },
  });

  const remaining = availableUnits.length - qty;
  if (qty === 1) {
    return `✅ Sold <b>${sku.name}</b> (${soldCodes[0]}) for $${parsed.price} via ${platformLabel(parsed.platform)}.\n<i>${remaining} in stock. — ${userName}</i>`;
  } else {
    const total = (qty * parsed.price).toFixed(2);
    return `✅ Sold <b>${qty}× ${sku.name}</b> at $${parsed.price} each = <b>$${total} total</b> via ${platformLabel(parsed.platform)}.\n<i>${remaining} in stock. — ${userName}</i>\n\nIf you meant "$${parsed.price} total" instead of "each", reply <code>undo</code>.`;
  }
}

async function handleStock(env, parsed) {
  const skus = await loadSkus(env);
  if (skus.length === 0) return '📦 No SKUs in the system yet.';

  // All-inventory summary
  if (!parsed.query) {
    // One batched call for all units
    const allUnits = await sb(env, 'GET', 'units?select=sku_id,status');
    const bySku = {};
    allUnits.forEach(u => {
      if (!bySku[u.sku_id]) bySku[u.sku_id] = { inventory: 0, listed: 0, sold: 0 };
      if (bySku[u.sku_id][u.status] !== undefined) bySku[u.sku_id][u.status]++;
    });

    const totalInv = allUnits.filter(u => u.status === 'inventory').length;
    const lines = skus
      .map(s => ({ sku: s, counts: bySku[s.id] || { inventory: 0, listed: 0, sold: 0 } }))
      .sort((a, b) => b.counts.inventory - a.counts.inventory)
      .slice(0, 15)
      .map(({ sku, counts }) =>
        `• <b>${sku.name}</b>: ${counts.inventory} in stock`
      );

    return `📦 <b>${totalInv} total units in stock</b>\n\n${lines.join('\n')}`;
  }

  // Single-SKU lookup
  const match = findSku(skus, parsed.query);
  if (!match.best) return `❌ No SKU matches "${parsed.query}".`;
  const sku = match.best;
  const [inv, listed, sold] = await Promise.all([
    loadUnitsForSku(env, sku.id, 'inventory'),
    loadUnitsForSku(env, sku.id, 'listed'),
    loadUnitsForSku(env, sku.id, 'sold'),
  ]);
  return `📦 <b>${sku.name}</b> (${sku.sku_code})\n` +
         `• ${inv.length} in stock\n` +
         `• ${listed.length} listed\n` +
         `• ${sold.length} sold`;
}

async function handleDamage(env, parsed, userName) {
  if (parsed.unitCode) {
    const rows = await loadUnitByCode(env, parsed.unitCode);
    const unit = rows[0];
    if (!unit) return `❌ Unit <code>${parsed.unitCode}</code> not found.`;

    const report = await insertDamage(env, {
      unit_id: unit.id,
      sku_id: unit.sku_id,
      damage_count: 1,
      reason: 'Reported via Telegram',
      claim_status: 'open',
      reported_at: new Date().toISOString(),
      supplier_notes: `Reported by ${userName}`,
    });
    await sb(env, 'PATCH', `units?id=eq.${unit.id}`, { status: 'damaged' });

    await rememberLastAction(env, parsed._userId, {
      type: 'damage',
      payload: {
        report_id: report && report[0] ? report[0].id : null,
        unit_id: unit.id,
        sku_name: unit.skus?.name,
      },
    });

    return `⚠️ Damage report opened for <b>${unit.skus?.name || parsed.unitCode}</b>.\n<i>Add photos + claim amount via the Lotsy app.</i>`;
  }

  if (!parsed.query) return `I need a SKU. Try: <code>damaged busy book 3</code>`;
  const skus = await loadSkus(env);
  const match = findSku(skus, parsed.query);
  if (!match.best) return `❌ No SKU matches "${parsed.query}".`;

  const report = await insertDamage(env, {
    sku_id: match.best.id,
    damage_count: parsed.qty,
    reason: 'Reported via Telegram',
    claim_status: 'open',
    reported_at: new Date().toISOString(),
    supplier_notes: `${parsed.qty} units reported by ${userName}`,
  });

  await rememberLastAction(env, parsed._userId, {
    type: 'damage',
    payload: {
      report_id: report && report[0] ? report[0].id : null,
      sku_name: match.best.name,
    },
  });

  return `⚠️ Damage report opened: <b>${parsed.qty}× ${match.best.name}</b>.\n<i>Add photos + claim amount via the Lotsy app.</i>`;
}

async function handleSummary(env, range) {
  let startIso;
  const now = new Date();
  if (range === 'today') {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    startIso = s.toISOString();
  } else if (range === 'week') {
    const s = new Date(now); s.setDate(s.getDate() - 7);
    startIso = s.toISOString();
  } else {
    startIso = '1970-01-01T00:00:00Z';
  }

  const sales = await sb(env, 'GET',
    `sales?sold_at=gte.${startIso}&select=*&order=sold_at.desc`);

  if (sales.length === 0) {
    return `📊 <b>${range === 'today' ? 'Today' : range === 'week' ? 'This week' : 'All time'}</b>\nNo sales yet.`;
  }

  const revenue = sales.reduce((s, r) => s + Number(r.sold_price || 0), 0);
  const byPlatform = {};
  sales.forEach(s => {
    byPlatform[s.platform] = (byPlatform[s.platform] || 0) + 1;
  });

  const label = range === 'today' ? 'Today' : range === 'week' ? 'This week' : 'All time';
  const platformLines = Object.entries(byPlatform)
    .map(([p, n]) => `• ${platformLabel(p)}: ${n}`).join('\n');

  return `📊 <b>${label}</b>\n` +
         `${sales.length} sold • $${revenue.toFixed(2)} revenue\n\n` +
         platformLines;
}

// ============================================================================
// UNDO — keep last action per user in Workers KV or in Durable Objects
// For v1 we keep it in Supabase via a simple last_telegram_action table if it
// exists, otherwise gracefully no-op.
// ============================================================================

async function rememberLastAction(env, userId, action) {
  try {
    await sb(env, 'POST', 'telegram_actions', {
      telegram_user_id: String(userId),
      action_type: action.type,
      payload: action.payload,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // Table doesn't exist — fine, undo just won't work. Not fatal.
    console.warn('telegram_actions table missing, undo disabled:', e.message);
  }
}

// ============================================================================
// UNDO — shows last 5 undoable actions, lets user pick which to reverse
// ----------------------------------------------------------------------------
// `undo`         → lists last 5 actions
// `undo 3`       → reverses action #3 from the list
// `undo last`    → reverses most recent (equivalent to `undo 1`)
// ============================================================================

function formatActionSummary(action) {
  const p = action.payload || {};
  const when = new Date(action.created_at);
  const timeAgo = humanTimeAgo(when);
  if (action.action_type === 'sold') {
    const qty = p.qty || (p.sale_ids ? p.sale_ids.length : 1);
    return `Sold ${qty}× ${p.sku_name || 'unit'} · ${timeAgo}`;
  }
  if (action.action_type === 'damage') {
    return `Damage report: ${p.sku_name || 'unit'} · ${timeAgo}`;
  }
  return `${action.action_type} · ${timeAgo}`;
}

function humanTimeAgo(date) {
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

async function reverseAction(env, action) {
  const p = action.payload || {};
  if (action.action_type === 'sold') {
    const saleIds = p.sale_ids || (p.sale_id ? [p.sale_id] : []);
    const unitIds = p.unit_ids || (p.unit_id ? [p.unit_id] : []);
    if (saleIds.length === 0) return { error: 'no sale IDs recorded' };
    for (const saleId of saleIds) {
      await sb(env, 'DELETE', `sales?id=eq.${saleId}`);
    }
    for (const unitId of unitIds) {
      await sb(env, 'PATCH', `units?id=eq.${unitId}`, { status: 'inventory' });
    }
    await sb(env, 'PATCH', `telegram_actions?id=eq.${action.id}`, { undone: true });
    return { ok: true, message: `${saleIds.length > 1 ? `${saleIds.length} sales` : 'sale'} of <b>${p.sku_name || 'unit'}</b>` };
  }
  if (action.action_type === 'damage' && p.report_id) {
    await sb(env, 'DELETE', `damage_reports?id=eq.${p.report_id}`);
    if (p.unit_id) await sb(env, 'PATCH', `units?id=eq.${p.unit_id}`, { status: 'inventory' });
    await sb(env, 'PATCH', `telegram_actions?id=eq.${action.id}`, { undone: true });
    return { ok: true, message: `damage report for <b>${p.sku_name || 'unit'}</b>` };
  }
  return { error: 'unknown action type' };
}

async function undoLastAction(env, userId, which) {
  try {
    // Pull last 5 actions that haven't been undone yet
    const rows = await sb(env, 'GET',
      `telegram_actions?telegram_user_id=eq.${userId}&undone=eq.false&order=created_at.desc&limit=5`);

    if (rows.length === 0) return `Nothing to undo.`;

    // `undo last` or `undo` with no number → always reverse #1 (most recent)
    // But if there are multiple and user just typed `undo`, show the list first
    const asNum = which != null ? parseInt(which, 10) : null;
    const isLastShortcut = which === 'last' || which === '1';

    // No argument → show the list for picking
    if ((which === undefined || which === null || which === '') && rows.length > 1) {
      const lines = rows.map((a, i) => `${i + 1}. ${formatActionSummary(a)}`).join('\n');
      return `<b>Which action should I undo?</b>\n${lines}\n\nReply with <code>undo 1</code>, <code>undo 2</code>, etc.\nOr <code>undo last</code> for the most recent.`;
    }

    // Pick specific action by index
    let target;
    if (isLastShortcut || (which === undefined || which === null || which === '')) {
      target = rows[0];
    } else if (!isNaN(asNum) && asNum >= 1 && asNum <= rows.length) {
      target = rows[asNum - 1];
    } else {
      return `I don't see that action. Reply <code>undo</code> to see the list.`;
    }

    const result = await reverseAction(env, target);
    if (result.error) return `Couldn't undo — ${result.error}`;
    return `↩️ Undone: ${result.message} reversed.`;
  } catch (e) {
    return `Undo unavailable — ${e.message.slice(0, 100)}`;
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function platformLabel(p) {
  return {
    fb_marketplace: 'FB Marketplace',
    ebay: 'eBay',
    mercari: 'Mercari',
    offerup: 'OfferUp',
  }[p] || p;
}

// ============================================================================
// LISTING MONITORING — manual performance tracking via Telegram
// ---------------------------------------------------------------------------
// Kyle gets 3 pings/day (morning/afternoon/evening) listing all active
// listings with a number. He replies with "N: views saves messages" per line.
// Bot parses, stores metrics, scores each listing, and flags recommendations.
//
// Schedule (jittered daily by cron trigger in wrangler.toml):
//   Morning window:   08:00 – 11:00
//   Afternoon window: 13:00 – 16:00
//   Evening window:   19:00 – 22:00
//
// Scoring:
//   NEW   — days < 3
//   HOT   — views/day >= 10 or messages >= 3 in last 7 days
//   FINE  — views/day 3-10, no red flags
//   SLOW  — views/day < 3 after day 7 OR 0 messages by day 7
//   COLD  — age 21-30 days regardless of velocity
//   DEAD  — age 30+ days, needs action
// ============================================================================

async function loadActiveListings(env) {
  // Listings in 'active' status + not paused from monitoring
  return sb(env, 'GET',
    'listings?status=eq.active&monitor_paused=eq.false&select=*,units(unit_code,sku_id,skus(name,sku_code))&order=created_at.asc'
  );
}

async function loadRecentMetrics(env, listingId, days = 14) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return sb(env, 'GET',
    `listing_metrics?listing_id=eq.${listingId}&checked_at=gte.${since}&order=checked_at.desc`
  );
}

async function loadPendingRound(env, userId) {
  // Find the most recent round that hasn't been responded to yet
  const rows = await sb(env, 'GET',
    `monitor_rounds?telegram_user_id=eq.${userId}&responded_at=is.null&order=sent_at.desc&limit=1`
  );
  return rows[0] || null;
}

function scoreOneListing(listing, metrics) {
  // metrics: array of { checked_at, views, saves, messages } sorted DESC (newest first)
  const createdAt = new Date(listing.created_at);
  const ageDays = Math.floor((Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000));

  // Filter to last 7 days for velocity calculation
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = metrics.filter(m => new Date(m.checked_at).getTime() >= sevenDaysAgo && m.views != null);

  if (recent.length === 0) {
    return {
      score: ageDays < 3 ? 'new' : 'fine',
      notes: ageDays < 3 ? 'Just posted, need more data.' : 'No recent metric data.',
      ageDays,
      latestViews: null, latestSaves: null, latestMessages: null,
      viewsPerDay: null, totalMessages: null,
    };
  }

  // Latest snapshot values
  const latest = recent[0];
  const oldest = recent[recent.length - 1];

  // Views-per-day over the observation window
  const windowDays = Math.max(1,
    (new Date(latest.checked_at).getTime() - new Date(oldest.checked_at).getTime()) / (24 * 60 * 60 * 1000)
  );
  const viewsDelta = Number(latest.views) - Number(oldest.views || 0);
  const viewsPerDay = windowDays > 0 ? Math.max(0, viewsDelta / windowDays)
    : Number(latest.views || 0);

  // Total messages over recent window
  const totalMessages = Math.max(...recent.map(m => Number(m.messages) || 0));
  const totalSaves = Math.max(...recent.map(m => Number(m.saves) || 0));

  // === Scoring rules ===
  let score, notes;

  if (ageDays < 3) {
    score = 'new';
    notes = 'Too early to tell. Check back in a few days.';
  } else if (ageDays >= 30) {
    score = 'dead';
    notes = 'Over 30 days listed. Delist, bundle into clearance, or drop 30-40%.';
  } else if (ageDays >= 21) {
    score = 'cold';
    notes = 'Stale. Try dropping price 25-30%, adding a new hero photo, or bundling.';
  } else if (viewsPerDay >= 10 || totalMessages >= 3) {
    score = 'hot';
    if (totalMessages >= 3 && viewsPerDay >= 10) {
      notes = `Strong traffic + buyer interest. You're likely underpricing — try raising 10-15%.`;
    } else if (totalMessages >= 3) {
      notes = 'Buyers are messaging — consider raising price or holding firm on offers.';
    } else {
      notes = `High views (${viewsPerDay.toFixed(1)}/day) but few msgs. Good demand — test a price bump.`;
    }
  } else if (ageDays >= 14 && viewsPerDay < 3) {
    score = 'slow';
    notes = 'Two weeks with weak traffic. Drop price 15-20% and refresh the hero photo.';
  } else if (ageDays >= 7 && viewsPerDay < 3) {
    score = 'slow';
    notes = `Week in with only ${viewsPerDay.toFixed(1)} views/day. Title + hero photo may need work.`;
  } else if (ageDays >= 7 && totalMessages === 0 && viewsPerDay >= 5) {
    score = 'slow';
    notes = `Decent views (${viewsPerDay.toFixed(1)}/d) but 0 messages. Rework title/description — or price is scaring buyers.`;
  } else if (ageDays >= 5 && viewsPerDay >= 10 && totalSaves === 0) {
    score = 'slow';
    notes = 'High views but no saves — wrong category or hero photo missing the mark.';
  } else {
    score = 'fine';
    notes = `On track: ${viewsPerDay.toFixed(1)} views/day, ${totalMessages} msgs in last 7d.`;
  }

  return {
    score, notes, ageDays,
    latestViews: Number(latest.views) || 0,
    latestSaves: Number(latest.saves) || 0,
    latestMessages: Number(latest.messages) || 0,
    viewsPerDay, totalMessages,
  };
}

async function updateListingScore(env, listingId, scoreData) {
  await sb(env, 'PATCH', `listings?id=eq.${listingId}`, {
    check_score: scoreData.score,
    check_notes: scoreData.notes,
    last_check_at: new Date().toISOString(),
  });
}

function determineRoundType() {
  // Based on current UTC hour, guess which window we're in
  // Assumes Kyle is in US Central (UTC-5 or UTC-6). Adjust if needed.
  const utcHour = new Date().getUTCHours();
  // Rough mapping for Central time
  if (utcHour >= 13 && utcHour < 17) return 'morning';     // 08:00-12:00 CT
  if (utcHour >= 18 && utcHour < 22) return 'afternoon';   // 13:00-17:00 CT
  return 'evening';                                         // 19:00+ CT
}

async function sendCheckRound(env, roundType) {
  const listings = await loadActiveListings(env);
  if (!listings || listings.length === 0) {
    console.log(`Round ${roundType}: no active listings, skipping`);
    return;
  }

  const userId = (env.ALLOWED_USERS || '').split(',').map(s => s.trim())[0];
  if (!userId) {
    console.error('No primary user in ALLOWED_USERS — cannot send check round');
    return;
  }

  // Check if there's an unresponded prior round to nudge about
  const pending = await loadPendingRound(env, userId);
  let nudge = '';
  if (pending && !pending.reminded) {
    const missedType = pending.round_type;
    nudge = `\n<i>⏰ Also: you didn't reply to the ${missedType} check. Include those numbers here or reply "skip" to ignore.</i>\n`;
    await sb(env, 'PATCH', `monitor_rounds?id=eq.${pending.id}`, { reminded: true });
  }

  // Build the numbered message
  const emoji = roundType === 'morning' ? '☀️' : roundType === 'afternoon' ? '🌤' : '🌙';
  const timeLabel = roundType[0].toUpperCase() + roundType.slice(1);
  const when = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  const lines = listings.map((l, i) => {
    const sku = l.units?.skus;
    const unitCode = l.units?.unit_code || '';
    const name = sku?.name || l.units?.sku_id || 'unknown';
    const days = Math.floor((Date.now() - new Date(l.created_at).getTime()) / (24 * 60 * 60 * 1000));
    const platform = (l.platform || 'fb').replace('_marketplace', '').replace('fb', 'FB');
    return `${i + 1}. ${name} <code>${unitCode}</code> · d${days} · $${l.listed_price} (${platform})`;
  }).join('\n');

  const msg =
    `${emoji} <b>${timeLabel} check</b> · ${when}\n` +
    `${listings.length} active listing${listings.length !== 1 ? 's' : ''}\n` +
    `${nudge}\n` +
    `${lines}\n\n` +
    `<b>Reply format:</b> one line per item\n` +
    `<code>1: views saves messages</code>\n` +
    `<code>2: 12 2 0</code>\n` +
    `<code>3: skip</code>\n\n` +
    `Or just reply <code>skip</code> to skip the whole round.`;

  // Create the round record
  const roundRow = await sb(env, 'POST', 'monitor_rounds', {
    round_type: roundType,
    telegram_user_id: userId,
    listing_ids: listings.map(l => l.id),
  });

  await sendMessage(env, userId, msg);
  console.log(`Sent ${roundType} round to ${userId} with ${listings.length} listings`);
}

// Parse a user reply containing multi-line metric updates.
// Accepts formats:
//   "1: 12 2 0"
//   "1 12 2 0"
//   "1: skip"
// Returns { updates: [{ index, views, saves, messages, skipped }], skipAll }
function parseMetricsReply(text) {
  const trimmed = text.trim();
  // Global skip
  if (/^skip$/i.test(trimmed)) return { skipAll: true, updates: [] };

  const updates = [];
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;
    // Match: "N: v s m" or "N v s m" or "N: skip"
    const skipMatch = clean.match(/^(\d+)[\s:.)]*\s*skip\b/i);
    if (skipMatch) {
      updates.push({ index: parseInt(skipMatch[1]), skipped: true });
      continue;
    }
    const m = clean.match(/^(\d+)[\s:.)]*\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) {
      updates.push({
        index: parseInt(m[1]),
        views: parseInt(m[2]),
        saves: parseInt(m[3]),
        messages: parseInt(m[4]),
      });
      continue;
    }
    // Match without separators e.g. just "5 10 0 1"
    const m2 = clean.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (m2) {
      updates.push({
        index: parseInt(m2[1]),
        views: parseInt(m2[2]),
        saves: parseInt(m2[3]),
        messages: parseInt(m2[4]),
      });
    }
  }
  return { skipAll: false, updates };
}

function looksLikeMetricsReply(text) {
  // Heuristic: has at least one line matching "N: ..." or is bare "skip"
  const t = text.trim();
  if (/^skip$/i.test(t)) return true;
  const lines = t.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.some(l => /^\d+[\s:.)]/.test(l.trim()));
}

async function handleMetricsReply(env, userId, text) {
  const pending = await loadPendingRound(env, userId);
  if (!pending) {
    return `🤔 No check round is pending. Try <code>digest</code> to see current status, or wait for the next check ping.`;
  }

  const { skipAll, updates } = parseMetricsReply(text);
  const batchId = pending.id;
  const nowIso = new Date().toISOString();

  if (skipAll || updates.length === 0) {
    await sb(env, 'PATCH', `monitor_rounds?id=eq.${pending.id}`, {
      responded_at: nowIso, skipped: true,
    });
    return `⏭️ Skipped ${pending.round_type} round. You'll get the next one at its scheduled window.`;
  }

  // Pull the listings for this round so we know how to map indices → listing_ids
  const listingRows = await sb(env, 'GET',
    `listings?id=in.(${pending.listing_ids.join(',')})&select=id,listed_price,units(unit_code,skus(name))`
  );
  // Re-order to match the order we sent them in (listing_ids order)
  const orderedListings = pending.listing_ids
    .map(id => listingRows.find(l => l.id === id))
    .filter(Boolean);

  let logged = 0, skipped = 0, errors = [];

  for (const u of updates) {
    if (u.index < 1 || u.index > orderedListings.length) {
      errors.push(`#${u.index} out of range`);
      continue;
    }
    const listing = orderedListings[u.index - 1];
    if (u.skipped) {
      skipped++;
      continue;
    }
    try {
      await sb(env, 'POST', 'listing_metrics', {
        listing_id: listing.id,
        views: u.views,
        saves: u.saves,
        messages: u.messages,
        source: 'telegram_manual',
        check_batch_id: batchId,
      });
      logged++;

      // Re-score the listing with fresh data
      const metrics = await loadRecentMetrics(env, listing.id);
      const scoreData = scoreOneListing(listing, metrics);
      await updateListingScore(env, listing.id, scoreData);
    } catch (e) {
      errors.push(`#${u.index}: ${e.message?.slice(0, 60)}`);
    }
  }

  // Mark round as responded
  await sb(env, 'PATCH', `monitor_rounds?id=eq.${pending.id}`, {
    responded_at: nowIso,
  });

  // Build recap with score changes
  const allListingsNow = await sb(env, 'GET',
    `listings?id=in.(${pending.listing_ids.join(',')})&select=id,check_score,check_notes,listed_price,units(unit_code,skus(name))`
  );

  const byScore = { hot: [], slow: [], cold: [], dead: [], fine: [], new: [] };
  for (const l of allListingsNow) {
    const s = l.check_score || 'fine';
    if (byScore[s]) byScore[s].push(l);
  }

  let recap = `✅ Logged ${logged} listing${logged !== 1 ? 's' : ''}`;
  if (skipped > 0) recap += `, skipped ${skipped}`;
  if (errors.length) recap += `\n⚠️ Errors: ${errors.slice(0, 3).join('; ')}`;
  recap += '\n';

  const fmt = (l) => `• ${l.units?.skus?.name || 'unknown'} <code>${l.units?.unit_code || ''}</code> — $${l.listed_price}\n   <i>${l.check_notes || '—'}</i>`;

  if (byScore.hot.length > 0) {
    recap += `\n🔥 <b>HOT</b> (${byScore.hot.length})\n` + byScore.hot.map(fmt).join('\n') + '\n';
  }
  if (byScore.slow.length > 0) {
    recap += `\n🐢 <b>SLOW</b> (${byScore.slow.length})\n` + byScore.slow.map(fmt).join('\n') + '\n';
  }
  if (byScore.cold.length > 0) {
    recap += `\n❄️ <b>COLD</b> (${byScore.cold.length})\n` + byScore.cold.map(fmt).join('\n') + '\n';
  }
  if (byScore.dead.length > 0) {
    recap += `\n☠️ <b>DEAD</b> (${byScore.dead.length})\n` + byScore.dead.map(fmt).join('\n') + '\n';
  }
  if (byScore.fine.length > 0) {
    recap += `\n✅ ${byScore.fine.length} on track\n`;
  }
  if (byScore.new.length > 0) {
    recap += `\n✨ ${byScore.new.length} too new to score\n`;
  }

  return recap;
}

async function handleDigest(env, userId) {
  const listings = await loadActiveListings(env);
  if (!listings || listings.length === 0) {
    return '📊 No active listings to score.';
  }

  // Re-score everything using existing metrics
  for (const l of listings) {
    const metrics = await loadRecentMetrics(env, l.id);
    const scoreData = scoreOneListing(l, metrics);
    await updateListingScore(env, l.id, scoreData);
  }

  const byScore = { hot: [], slow: [], cold: [], dead: [], fine: [], new: [] };
  const fresh = await sb(env, 'GET',
    `listings?status=eq.active&monitor_paused=eq.false&select=id,check_score,check_notes,listed_price,created_at,units(unit_code,skus(name))&order=created_at.asc`
  );
  for (const l of fresh) {
    const s = l.check_score || 'fine';
    if (byScore[s]) byScore[s].push(l);
  }

  const fmt = (l) => `• ${l.units?.skus?.name || '?'} <code>${l.units?.unit_code || ''}</code> — $${l.listed_price}\n   <i>${l.check_notes || '—'}</i>`;

  let msg = `📊 <b>Lotsy digest</b> · ${listings.length} active\n`;
  if (byScore.hot.length > 0) msg += `\n🔥 <b>HOT</b> (${byScore.hot.length})\n${byScore.hot.map(fmt).join('\n')}\n`;
  if (byScore.slow.length > 0) msg += `\n🐢 <b>SLOW</b> (${byScore.slow.length})\n${byScore.slow.map(fmt).join('\n')}\n`;
  if (byScore.cold.length > 0) msg += `\n❄️ <b>COLD</b> (${byScore.cold.length})\n${byScore.cold.map(fmt).join('\n')}\n`;
  if (byScore.dead.length > 0) msg += `\n☠️ <b>DEAD</b> (${byScore.dead.length})\n${byScore.dead.map(fmt).join('\n')}\n`;
  if (byScore.fine.length > 0) msg += `\n✅ FINE (${byScore.fine.length}) — on track\n`;
  if (byScore.new.length > 0) msg += `\n✨ NEW (${byScore.new.length}) — too early\n`;

  return msg;
}

async function handlePauseMonitor(env, unitCode, pause) {
  const rows = await loadUnitByCode(env, unitCode);
  const unit = rows[0];
  if (!unit) return `❌ Unit <code>${unitCode}</code> not found.`;

  const listings = await sb(env, 'GET',
    `listings?unit_id=eq.${unit.id}&status=eq.active&select=id,units(skus(name))`
  );
  if (listings.length === 0) return `❌ No active listing for ${unitCode}.`;

  for (const l of listings) {
    await sb(env, 'PATCH', `listings?id=eq.${l.id}`, { monitor_paused: pause });
  }
  const name = listings[0].units?.skus?.name || unitCode;
  return pause
    ? `🔕 Paused monitoring for <b>${name}</b> (${unitCode}). Use <code>resume ${unitCode}</code> to turn back on.`
    : `🔔 Resumed monitoring for <b>${name}</b> (${unitCode}).`;
}

export default {
  async fetch(request, env, ctx) {
    // Health check
    if (request.method === 'GET') {
      return new Response('Lotsy Telegram Bot — alive 🟢', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    const message = update.message || update.edited_message;
    if (!message || !message.text) {
      return new Response('ok'); // Telegram likes a 200 even if we ignore
    }

    const userId = String(message.from.id);
    const userName = message.from.first_name || message.from.username || 'someone';
    const chatId = message.chat.id;
    const text = message.text;

    // DEBUG LOGGING — visible in Cloudflare Observability Live logs
    console.log(JSON.stringify({
      event: 'incoming_message',
      userId,
      userName,
      chatId,
      chatType: message.chat.type,
      text: text.slice(0, 100),
      allowedUsersRaw: env.ALLOWED_USERS,
    }));

    // /whoami — works for everyone, no auth needed. Useful for onboarding.
    if (/^\/?whoami\b/i.test(text.trim())) {
      const allowed = (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
      const isAuthed = allowed.includes(userId);
      await sendMessage(env, chatId,
        `<b>Your Telegram info</b>\n` +
        `• User ID: <code>${userId}</code>\n` +
        `• Name: ${userName}\n` +
        `• Chat type: ${message.chat.type}\n` +
        `• Authorized: ${isAuthed ? '✅ yes' : '❌ no'}\n\n` +
        (isAuthed ? '' : `Ask the owner to add <code>${userId}</code> to ALLOWED_USERS.`)
      );
      return new Response('ok');
    }

    // Whitelist check — but reply with a helpful message instead of silent drop
    const allowed = (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(userId)) {
      console.log(`Unauthorized user: ${userId} not in [${allowed.join(', ')}]`);
      await sendMessage(env, chatId,
        `👋 Hi ${userName}, I see your message but you're not on my allowlist.\n\n` +
        `Your Telegram ID: <code>${userId}</code>\n` +
        `(Currently allowed: <code>${allowed.join(', ') || '(none)'}</code>)\n\n` +
        `Ask the owner to add your ID to the <code>ALLOWED_USERS</code> environment variable in Cloudflare, then message again.`
      );
      return new Response('ok');
    }

    // In groups, only respond if the message actually starts with a command word
    // or mentions the bot. Otherwise people chatting in the group won't trigger the bot.
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
    const lc = text.toLowerCase().trim();
    const triggerWords = /^(sold|sell|sale|mark|stock|inventory|damage|broken|today|week|total|undo|help|list|\/)/i;
    if (isGroup && !triggerWords.test(lc) && !lc.includes('@lotsy')) {
      return new Response('ok');
    }

    // Parse + route
    try {
      const parsed = parseCommand(text);
      parsed._userId = userId;  // needed by handlers to record undoable actions
      let reply;

      switch (parsed.cmd) {
        case 'help':
          reply = HELP_TEXT;
          break;
        case 'sold':
          reply = await handleSold(env, parsed, userName);
          break;
        case 'stock':
          reply = await handleStock(env, parsed);
          break;
        case 'damage':
          reply = await handleDamage(env, parsed, userName);
          break;
        case 'summary':
          reply = await handleSummary(env, parsed.range);
          break;
        case 'undo':
          reply = await undoLastAction(env, userId, parsed.which);
          break;
        case 'digest':
          reply = await handleDigest(env, userId);
          break;
        case 'metrics_reply':
          reply = await handleMetricsReply(env, userId, parsed.text);
          break;
        case 'pause_monitor':
          reply = await handlePauseMonitor(env, parsed.unitCode, true);
          break;
        case 'resume_monitor':
          reply = await handlePauseMonitor(env, parsed.unitCode, false);
          break;
        default:
          reply = `🤷 Not sure what you meant. Try <code>help</code>.`;
      }

      await sendMessage(env, chatId, reply);
    } catch (err) {
      console.error('Handler error:', err);
      await sendMessage(env, chatId, `⚠️ Error: ${err.message?.slice(0, 200) || 'unknown'}`);
    }

    return new Response('ok');
  },

  // ============================================================================
  // CRON TRIGGER — fires at scheduled times to send check-in rounds
  // ============================================================================
  // Wrangler.toml defines 3 crons (morning/afternoon/evening windows).
  // Each fires within its window; within the handler we add small jitter
  // so consecutive days don't land at identical clock times.
  async scheduled(controller, env, ctx) {
    const roundType = determineRoundType();
    // Add a random delay of 0-15 min to vary the exact send time
    const jitterMs = Math.floor(Math.random() * 15 * 60 * 1000);
    await new Promise(r => setTimeout(r, Math.min(jitterMs, 25000))); // cap at 25s to stay within worker runtime

    try {
      await sendCheckRound(env, roundType);
    } catch (e) {
      console.error('Scheduled round failed:', e.message);
    }
  },
};
