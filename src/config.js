import dotenv from 'dotenv';
dotenv.config();

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    // Don't hard-crash for optional-at-boot values; surface clearly instead.
    return '';
  }
  return v.trim();
}

function int(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function float(name, fallback) {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Derive the public URL. Railway exposes RAILWAY_PUBLIC_DOMAIN.
function derivePublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${int('PORT', 8080)}`;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: int('PORT', 8080),
  publicUrl: derivePublicUrl(),

  telegram: {
    token: required('BOT_TOKEN'),
    adminIds: (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    supportUsername: (process.env.SUPPORT_USERNAME || '').replace(/^@/, ''),
    supportTelegramId: (process.env.SUPPORT_TELEGRAM_ID || '').trim(),
    // WhatsApp number, digits only (no +) for wa.me links
    whatsapp: (process.env.SUPPORT_WHATSAPP || '').replace(/[^\d]/g, ''),
  },

  database: {
    url: required('DATABASE_URL'),
    provider: process.env.DB_PROVIDER || 'postgresql',
    // Postgres supports case-insensitive search; SQLite (dev) does not.
    searchMode: (process.env.DB_PROVIDER || 'postgresql') === 'sqlite' ? undefined : 'insensitive',
  },

  cryptomus: {
    merchantId: required('CRYPTOMUS_MERCHANT_ID'),
    paymentKey: required('CRYPTOMUS_PAYMENT_API_KEY'),
    payoutKey: required('CRYPTOMUS_PAYOUT_API_KEY'),
    apiBase: 'https://api.cryptomus.com/v1',
    // Cryptomus flags a payment `wrong_amount` when the received value lands
    // even fractionally under the invoice — a customer sending a round 10 USDT
    // for a $10 order arrives ~0.1% short once the USDT rate is applied, and
    // would otherwise be told their payment failed while their money sits in
    // the merchant account. Anything short by up to this percentage is treated
    // as paid and delivered automatically.
    underpayTolerancePct: float('CRYPTOMUS_UNDERPAY_TOLERANCE_PCT', 2),
  },

  binance: {
    payId: (process.env.BINANCE_PAY_ID || '').trim(),
    // Read-only API credentials used to auto-verify incoming Binance Pay
    // transfers. Must have ONLY "Enable Reading" — never withdrawals.
    apiKey: (process.env.BINANCE_API_KEY || '').trim(),
    apiSecret: (process.env.BINANCE_API_SECRET || '').trim(),
    // How far under the invoiced amount an incoming transfer may land and
    // still be accepted (exchange-rate drift on round USDT sends).
    tolerancePct: float('BINANCE_MATCH_TOLERANCE_PCT', 2),
  },

  // Payment methods verified by hand: the customer sends funds straight to the
  // owner's exchange account, then an admin confirms it in Telegram. Adding
  // another exchange means adding one entry here — everything downstream
  // (buttons, checkout, top-ups, admin approval, poller exclusion) is driven
  // off this list. Only entries with an id configured are offered.
  manualMethods: [
    { key: 'BINANCE', label: 'Binance', emoji: '🟡', idLabel: 'Binance ID', payId: (process.env.BINANCE_PAY_ID || '').trim() },
    { key: 'BYBIT', label: 'Bybit', emoji: '🟠', idLabel: 'Bybit UID', payId: (process.env.BYBIT_PAY_ID || '').trim() },
  ].filter((m) => m.payId),

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  },

  shop: {
    currency: process.env.CURRENCY || 'USD',
    pollIntervalSec: int('PAYMENT_POLL_INTERVAL', 45),
    orderExpiryMin: int('ORDER_EXPIRY_MINUTES', 60),
  },
};

// Fast lookups for the manual methods above.
config.manualMethodKeys = new Set(config.manualMethods.map((m) => m.key));
config.manualMethod = (key) => config.manualMethods.find((m) => m.key === key) || null;

// A gentle self-check so misconfiguration is obvious in logs at boot.
config.missing = [];
if (!config.telegram.token) config.missing.push('BOT_TOKEN');
if (!config.database.url) config.missing.push('DATABASE_URL');
if (!config.cryptomus.merchantId) config.missing.push('CRYPTOMUS_MERCHANT_ID');
if (!config.cryptomus.paymentKey) config.missing.push('CRYPTOMUS_PAYMENT_API_KEY');

export default config;
