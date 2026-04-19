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

  // Undo
  if (/^(undo|\/undo|revert|nvm|nevermind)$/i.test(t)) return { cmd: 'undo' };

  // Today / week / total / stock
  if (/^(today|\/today|today.?s)$/i.test(t)) return { cmd: 'summary', range: 'today' };
  if (/^(week|\/week|this week)$/i.test(t)) return { cmd: 'summary', range: 'week' };
  if (/^(total|\/total|all time|lifetime)$/i.test(t)) return { cmd: 'summary', range: 'all' };

  // Stock [sku]
  const stockMatch = t.match(/^(?:stock|inventory|how many)\s*(.*)/);
  if (stockMatch) {
    return { cmd: 'stock', query: stockMatch[1].trim() };
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
• <code>undo</code> — reverses your last action

Default platform is FB Marketplace. Add <code>ebay</code>, <code>mercari</code>, or <code>offerup</code> to override.`;

async function handleSold(env, parsed, userName) {
  // Case 1: explicit unit code — mark that specific unit (qty always 1)
  if (parsed.unitCode) {
    const rows = await loadUnitByCode(env, parsed.unitCode);
    const unit = rows[0];
    if (!unit) return `❌ Unit <code>${parsed.unitCode}</code> not found.`;
    if (unit.status === 'sold') return `⚠️ ${parsed.unitCode} is already sold.`;

    if (!parsed.price) return `How much did ${unit.skus.name} (${parsed.unitCode}) sell for? Reply <code>sold ${parsed.unitCode} 22</code>.`;

    await insertSale(env, {
      unit_id: unit.id,
      platform: parsed.platform,
      sold_price: parsed.price,
      sold_at: new Date().toISOString(),
      notes: `via Telegram (${userName})`,
    });
    await markUnitSold(env, unit.id);

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
  for (const unit of unitsToSell) {
    await insertSale(env, {
      unit_id: unit.id,
      platform: parsed.platform,
      sold_price: parsed.price,
      sold_at: new Date().toISOString(),
      notes: `via Telegram (${userName})`,
    });
    await markUnitSold(env, unit.id);
    soldCodes.push(unit.unit_code);
  }

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

async function undoLastAction(env, userId) {
  try {
    const rows = await sb(env, 'GET',
      `telegram_actions?telegram_user_id=eq.${userId}&order=created_at.desc&limit=1`);
    const last = rows[0];
    if (!last) return `Nothing to undo.`;
    if (last.undone) return `Your last action is already undone.`;

    const p = last.payload;
    if (last.action_type === 'sold' && p.sale_id && p.unit_id) {
      await sb(env, 'DELETE', `sales?id=eq.${p.sale_id}`);
      await sb(env, 'PATCH', `units?id=eq.${p.unit_id}`, { status: 'inventory' });
      await sb(env, 'PATCH', `telegram_actions?id=eq.${last.id}`, { undone: true });
      return `↩️ Undone: sale of ${p.sku_name || 'unit'} reversed.`;
    }
    if (last.action_type === 'damage' && p.report_id) {
      await sb(env, 'DELETE', `damage_reports?id=eq.${p.report_id}`);
      if (p.unit_id) await sb(env, 'PATCH', `units?id=eq.${p.unit_id}`, { status: 'inventory' });
      await sb(env, 'PATCH', `telegram_actions?id=eq.${last.id}`, { undone: true });
      return `↩️ Undone: damage report reversed.`;
    }
    return `Couldn't undo — unknown action type.`;
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
// MAIN HANDLER
// ============================================================================

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
          reply = await undoLastAction(env, userId);
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
};
