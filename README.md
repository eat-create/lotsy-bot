# Lotsy Telegram Bot

Cloudflare Worker that powers the @Lotsykybot Telegram bot for Lotsy inventory management.

## Deployed via Cloudflare Workers → Git connection.

Secrets (set in Cloudflare dashboard, NOT in this repo):
- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_USERS` — comma-separated Telegram user IDs
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Commands

```
sold busy book 22
stock busy book
damaged busy book 3
today | week | total
undo
help
```

Natural language variations all work: "sold a busy book for 22", "mark busy book sold 22", etc.
