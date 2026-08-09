import prisma from '../db.js';

// Default settings — editable from the admin panel.
export const DEFAULT_SETTINGS = {
  shop_name: 'Premium Shop',
  welcome_message:
    '👋 <b>Welcome to {shop_name}!</b>\n\nBrowse our catalog of premium digital products below. Instant delivery, crypto payments, 24/7 support.',
  shop_intro: '🛒 <b>Shop — Choose a Product</b>\n\nTap a product to see details and pick your quantity. 👇',
  support_text:
    '💬 <b>Support</b>\n\nNeed help with an order or have a question? Message our support team and we\'ll get back to you fast.',
  faq_text:
    'ℹ️ <b>FAQ</b>\n\n<b>How does delivery work?</b>\nAfter your crypto payment is confirmed, your product is delivered here automatically — usually within seconds.\n\n<b>Which coins can I pay with?</b>\nUSDT, BTC, ETH, TRX and many more via Cryptomus.\n\n<b>Is my order safe?</b>\nYes. Every order is tracked and our support team can help anytime.',
  order_paid_message: '✅ <b>Payment confirmed!</b>\n\nThank you for your purchase. Your items are below. 👇',
  rules_accepted: 'true',
  maintenance_mode: 'false',
  maintenance_text: '🛠️ The shop is briefly down for maintenance. Please check back soon!',
};

// simple in-memory cache to avoid a DB hit on every message
let cache = null;
let cacheAt = 0;
const TTL = 15 * 1000;

export async function getAllSettings(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  const rows = await prisma.setting.findMany();
  const map = { ...DEFAULT_SETTINGS };
  for (const r of rows) map[r.key] = r.value;
  cache = map;
  cacheAt = Date.now();
  return map;
}

export async function getSetting(key) {
  const all = await getAllSettings();
  return all[key] ?? DEFAULT_SETTINGS[key] ?? '';
}

export async function setSetting(key, value) {
  await prisma.setting.upsert({
    where: { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
  cache = null; // invalidate
}

export async function setSettings(obj) {
  const entries = Object.entries(obj);
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    )
  );
  cache = null;
}

// Ensure defaults exist in DB (called at boot)
export async function ensureDefaults() {
  const rows = await prisma.setting.findMany({ select: { key: true } });
  const have = new Set(rows.map((r) => r.key));
  const toCreate = Object.entries(DEFAULT_SETTINGS).filter(([k]) => !have.has(k));
  if (toCreate.length) {
    // Note: skipDuplicates isn't supported on SQLite; toCreate already excludes
    // existing keys, so a plain createMany is safe on both SQLite and Postgres.
    await prisma.setting.createMany({
      data: toCreate.map(([key, value]) => ({ key, value })),
    });
  }
  cache = null;
}

// interpolate {shop_name} etc. into a template
export function render(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
