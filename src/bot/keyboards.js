import { InlineKeyboard } from 'grammy';
import { money, num } from '../utils.js';
import config from '../config.js';

const cryptomusConfigured = () => Boolean(config.cryptomus.merchantId && config.cryptomus.paymentKey);

export function mainMenuKeyboard(isAdmin = false) {
  const kb = new InlineKeyboard()
    .text('🛍️ Shop', 'shop')
    .row()
    .text('📦 My Orders', 'orders')
    .text('💰 Wallet', 'balance')
    .row()
    .text('💬 Support', 'support')
    .text('ℹ️ FAQ', 'faq');
  if (isAdmin) kb.row().text('🛠️ Admin Panel', 'a:menu');
  return kb;
}

// Product list: one product per row
export function shopKeyboard(products) {
  const kb = new InlineKeyboard();
  for (const p of products) {
    const stockLabel = p.usesStock ? ` · 📦 ${p.available}` : '';
    kb.text(`${p.emoji} ${p.name} — ${money(num(p.price))}${stockLabel}`, `p:${p.id}`).row();
  }
  kb.text('🏠 Main Menu', 'menu');
  return kb;
}

// Product detail with a quantity stepper
export function productKeyboard(product, qty, maxQty, opts = {}) {
  const kb = new InlineKeyboard();
  const canDec = qty > 1;
  const canInc = qty < maxQty;
  kb.text(canDec ? '➖' : ' ', canDec ? `q:${product.id}:${qty - 1}` : 'noop')
    .text(`Qty: ${qty}`, 'noop')
    .text(canInc ? '➕' : ' ', canInc ? `q:${product.id}:${qty + 1}` : 'noop')
    .row();
  const total = num(product.price) * qty;
  // Only show Crypto when Cryptomus is fully configured. "(Auto)" is not
  // decoration — it appears only where payment truly confirms itself.
  if (cryptomusConfigured()) {
    kb.text(`💎 Pay ${money(total)} with Crypto ⚡ (Auto)`, `checkout:${product.id}:${qty}`).row();
  }
  // One button per manually-verified method (Binance, Bybit, …).
  for (const m of config.manualMethods) {
    const auto = m.key === 'BINANCE' && config.binanceAutoVerify;
    const label = auto
      ? `${m.emoji} Pay ${money(total)} with ${m.label} ⚡ (Auto)`
      : `${m.emoji} Pay ${money(total)} with ${m.label}`;
    kb.text(label, `mchk:${m.key}:${product.id}:${qty}`).row();
  }
  // Offer wallet payment when the customer has enough balance.
  if (opts.balance !== undefined && opts.balance >= total) {
    kb.text(`💰 Pay ${money(total)} with Balance`, `paybal:${product.id}:${qty}`).row();
  }
  kb.text('⬅️ Back to Shop', 'shop').text('🏠 Menu', 'menu');
  return kb;
}

// Shown after a manually-verified order is created.
export function manualPayKeyboard(order, { autoVerify = false, payId = '', idLabel = 'ID' } = {}) {
  const kb = new InlineKeyboard();
  // Telegram's copy_text button puts the id straight on the clipboard, so the
  // customer never has to select it by hand on a phone.
  if (payId) kb.copyText(`📋 Copy ${idLabel}`, String(payId)).row();
  if (autoVerify) {
    // The prompt is already armed — this only re-arms it if they navigated away.
    kb.text('🧾 Paste Transaction ID', `mpaid:${order.id}`).row();
  } else {
    kb.text("✅ I've Paid — Notify Admin", `mpaid:${order.id}`).row();
  }
  kb.text('❌ Cancel Order', `mcancel:${order.id}`).text('🏠 Menu', 'menu');
  return kb;
}

// Older name kept for any remaining importer.
export const binancePayKeyboard = manualPayKeyboard;

// After an invoice is created
export function payKeyboard(order) {
  const kb = new InlineKeyboard();
  if (order.payUrl) kb.url('💎 Pay Now', order.payUrl).row();
  kb.text('🔄 Check Payment Status', `check:${order.id}`).row();
  kb.text('❌ Cancel Order', `cancel:${order.id}`).text('🏠 Menu', 'menu');
  return kb;
}

export function ordersKeyboard(orders) {
  const kb = new InlineKeyboard();
  for (const o of orders) {
    const emoji = statusEmoji(o.status);
    kb.text(`${emoji} ${o.publicId} — ${money(num(o.amount), o.currency)}`, `order:${o.id}`).row();
  }
  kb.text('🏠 Main Menu', 'menu');
  return kb;
}

export function orderDetailKeyboard(order) {
  const kb = new InlineKeyboard();
  if (order.status === 'PENDING' && order.payUrl) {
    kb.url('💎 Pay Now', order.payUrl).row();
  kb.text('🔄 Check Payment Status', `check:${order.id}`).row();
  }
  kb.text('⬅️ My Orders', 'orders').text('🏠 Menu', 'menu');
  return kb;
}

export function backMenuKeyboard() {
  return new InlineKeyboard().text('🏠 Main Menu', 'menu');
}

export function supportKeyboard() {
  const kb = new InlineKeyboard();
  if (config.telegram.supportTelegramId) {
    kb.url('💬 Contact Support', `tg://user?id=${config.telegram.supportTelegramId}`).row();
  } else if (config.telegram.supportUsername) {
    kb.url('💬 Chat with Admin', `https://t.me/${config.telegram.supportUsername}`).row();
  }
  if (config.telegram.whatsapp) {
    kb.url('📱 WhatsApp Admin', `https://wa.me/${config.telegram.whatsapp}`).row();
  }
  kb.text('🏠 Main Menu', 'menu');
  return kb;
}

export function statusEmoji(status) {
  return (
    {
      PENDING: '⏳',
      PAID: '💵',
      DELIVERED: '✅',
      CANCELLED: '❌',
      EXPIRED: '⌛',
      REFUNDED: '↩️',
      FAILED: '⚠️',
    }[status] || '•'
  );
}
