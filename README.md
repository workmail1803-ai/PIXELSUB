# 🛒 TeleBot Shop

A complete **Telegram digital-goods store** with **Cryptomus** crypto payments, a **wallet / store-credit** system, **automatic delivery**, and a **full admin panel inside Telegram** (plus an optional web dashboard). Built to deploy on **Railway** in minutes.

---

## ✨ What it does

**For customers (in Telegram):**
- 🛍️ Browse products with live stock counts
- 🧮 Pick quantity, pay with **crypto** (USDT, BTC, ETH, TRX… via Cryptomus)
- ⚡ **Automatic delivery** the instant payment confirms — no manual steps
- 💰 **Wallet**: top up with crypto, or **request store credit** from the admin, then **pay from balance**
- 📦 View past orders and re-read delivered items
- 💬 Support with **direct Telegram chat** + **WhatsApp** buttons

**For the admin (also entirely in Telegram — just `/start`):**
- ➕ Add products · ✏️ edit price · 👁 hide/show (exclude from shop) · 🗑 delete
- 📦 View & add stock (paste codes/accounts, one per line) — stock **auto-reduces** on each sale
- 👥 Users: view, **ban/unban**, **grant credit**, direct-message
- 💳 Approve/decline customer **credit requests**
- 📣 Broadcast to all users · 📊 live stats
- Everything works from your phone. **No separate server needed to run the store.**

**Payment auto-detection (never miss a payment):**
- Cryptomus **webhook** → instant
- Background **poller** re-checks every pending order against Cryptomus (safety net if a webhook is missed)
- Delivery is always gated on a **server-to-server status re-check**, so a spoofed webhook can never trigger delivery

**Optional bonus:** a polished **web admin dashboard** (charts, tables) at your app URL — handy on desktop, but not required.

---

## 🧱 Stack

Node.js (ESM) · [grammY](https://grammy.dev) (Telegram) · Express (webhook + optional web panel) · Prisma + PostgreSQL · Cryptomus. The bot uses **long polling** (no Telegram webhook to configure); only Cryptomus needs a public callback URL.

---

## 🚀 Deploy to Railway (recommended)

You'll need: a [Railway](https://railway.app) account, a Telegram bot token from [@BotFather](https://t.me/BotFather), and Cryptomus API keys.

### 1. Get the code onto GitHub
Push this folder to a new GitHub repository.

### 2. Create the Railway project
1. Railway → **New Project** → **Deploy from GitHub repo** → pick your repo.
2. **Add a database:** in the project, **New → Database → PostgreSQL**. Railway auto-injects `DATABASE_URL`.

### 3. Set environment variables
In your service → **Variables**, add:

| Variable | Value |
|---|---|
| `BOT_TOKEN` | from @BotFather |
| `ADMIN_TELEGRAM_IDS` | your numeric Telegram id(s), comma-separated |
| `SUPPORT_USERNAME` | your support @username (no `@`) |
| `SUPPORT_WHATSAPP` | WhatsApp number, digits only (e.g. `8801234567890`) |
| `CRYPTOMUS_MERCHANT_ID` | Cryptomus → Merchant → API |
| `CRYPTOMUS_PAYMENT_API_KEY` | Cryptomus payment API key |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | login for the optional web panel |
| `JWT_SECRET` | any long random string |
| `NODE_ENV` | `production` |

> Don't set `DB_PROVIDER` on Railway — it defaults to PostgreSQL. `PUBLIC_URL` is auto-derived from Railway's domain, but you can set it explicitly once you know it.

### 4. Deploy
Railway builds using `railway.json`:
- **Build:** `npm install && npx prisma generate`
- **Start:** `npx prisma db push` (creates tables) → `node src/index.js`
- **Health check:** `/healthz`

### 5. Point Cryptomus at your webhook
Once deployed, your public URL is `https://<your-app>.up.railway.app`.
In **Cryptomus → Merchant settings**, set the webhook/callback URL to:
```
https://<your-app>.up.railway.app/api/webhook/cryptomus
```
(The bot also polls Cryptomus, so payments are detected even without the webhook — but setting it makes confirmation instant.)

### 6. Seed your catalog (optional)
From Railway's service shell (or locally against the prod DB):
```
npm run seed                 # products only (add real stock in the bot)
npm run seed -- --with-demo-stock   # DEMO stock (delete before going live!)
```
Or just add products & stock directly in Telegram via `/start` → **Add Product**.

---

## 💻 Run locally (zero external setup)

Uses **SQLite** — no Postgres/Docker needed.

```bash
npm install
cp .env.example .env        # then edit .env
# For local dev set these in .env:
#   DB_PROVIDER=sqlite
#   DATABASE_URL=file:./dev.db
npm run dev:setup           # create local SQLite DB + client
npm run dev:seed            # seed catalog with demo stock
npm start
```

The bot goes live on long polling; the web panel is at http://localhost:8080.

---

## 🔑 Environment variables

See [`.env.example`](.env.example) for the full annotated list. Essentials: `BOT_TOKEN`, `DATABASE_URL`, `CRYPTOMUS_MERCHANT_ID`, `CRYPTOMUS_PAYMENT_API_KEY`, `ADMIN_TELEGRAM_IDS`.

---

## 🛡️ Going-live checklist

- [ ] `BOT_TOKEN` set and valid
- [ ] `ADMIN_TELEGRAM_IDS` includes your id (message the bot → `/whoami` to confirm)
- [ ] `CRYPTOMUS_MERCHANT_ID` + `CRYPTOMUS_PAYMENT_API_KEY` set
- [ ] Cryptomus webhook URL configured
- [ ] **Deleted all DEMO stock** and added real codes/accounts
- [ ] Strong `ADMIN_PASSWORD` + random `JWT_SECRET`
- [ ] Test one real purchase end-to-end

---

## 🗂️ Project structure

```
src/
  index.js            # boots web + bot + payment poller
  config.js           # env config
  bot/
    handlers.js       # customer shop flow
    wallet.js         # top-up, store credit, balance checkout
    admin.js          # full in-bot admin panel
    delivery.js       # delivery + notifications
    keyboards.js      # inline keyboards
  services/orders.js  # orders, fulfilment, top-ups, balance pay
  payments/
    cryptomus.js      # Cryptomus API client + signature verify
    poller.js         # background payment reconciliation
  web/                # Express: Cryptomus webhook + optional admin API
public/               # optional web admin dashboard (SPA)
prisma/
  schema.prisma       # PostgreSQL (production)
  schema.dev.prisma   # SQLite (local dev)
```

## 📝 Notes
- The **web admin panel is optional** — the bot is a complete admin. It exists because the Cryptomus webhook needs an HTTP server anyway.
- Store amounts are display-currency (`CURRENCY`, default USD); Cryptomus settles in crypto.
