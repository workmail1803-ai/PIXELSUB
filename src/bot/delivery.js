import { bot } from './instance.js';
import config from '../config.js';
import logger from '../logger.js';
import { escapeHtml, money, num } from '../utils.js';
import { getSetting, render } from '../services/settings.js';

// Send the delivered goods to a customer after payment is confirmed.
export async function sendDelivery(order) {
  if (!bot) return;
  const shopName = await getSetting('shop_name');
  const paidMsg = render(await getSetting('order_paid_message'), { shop_name: shopName });

  const blocks = [];
  for (const item of order.items) {
    const lines = [`<b>${escapeHtml(item.emoji)} ${escapeHtml(item.productName)}</b> ×${item.quantity}`];
    if (item.stock && item.stock.length) {
      for (const s of item.stock) {
        lines.push(`<code>${escapeHtml(s.content)}</code>`);
      }
    } else if (item.deliveredContent) {
      lines.push(item.deliveredContent); // already-rendered fixed content (HTML-safe)
    }
    blocks.push(lines.join('\n'));
  }

  const text =
    `${paidMsg}\n\n` +
    `🧾 <b>Order</b> <code>${escapeHtml(order.publicId)}</code>\n` +
    `💵 <b>Total:</b> ${money(num(order.amount), order.currency)}\n\n` +
    `${blocks.join('\n\n')}\n\n` +
    `Thank you for shopping with <b>${escapeHtml(shopName)}</b>! 💙`;

  await bot.api.sendMessage(order.user.telegramId.toString(), text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

// Notify the user their payment is confirmed but stock ran out (needs manual handling).
export async function sendOutOfStockApology(order) {
  if (!bot) return;
  const support = config.telegram.supportUsername
    ? `@${config.telegram.supportUsername}`
    : 'support';
  const text =
    `⚠️ <b>We hit a snag with order</b> <code>${escapeHtml(order.publicId)}</code>\n\n` +
    `Your payment arrived, but an item just sold out. Our team has been alerted and will ` +
    `deliver manually or refund you right away. Please contact ${escapeHtml(support)} if you have any questions.`;
  await bot.api.sendMessage(order.user.telegramId.toString(), text, { parse_mode: 'HTML' });
}

// Ping in-bot admins about something needing attention.
export async function notifyAdmins(text) {
  if (!bot) return;
  for (const id of config.telegram.adminIds) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: 'HTML' });
    } catch (e) {
      logger.warn({ err: e.message, id }, 'Failed to notify admin');
    }
  }
}

// Generic message helper (used by broadcasts, payment status pings)
export async function sendMessageSafe(telegramId, text, extra = {}) {
  if (!bot) return { ok: false };
  try {
    await bot.api.sendMessage(telegramId.toString(), text, { parse_mode: 'HTML', ...extra });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
