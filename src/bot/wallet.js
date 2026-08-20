import { InlineKeyboard } from 'grammy';
import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';
import { money, num, escapeHtml } from '../utils.js';
import { createTopUpOrder, createManualTopUpOrder, notifyManualPending } from '../services/orders.js';
import { payKeyboard, manualPayKeyboard } from './keyboards.js';
import { sendMessageSafe } from './delivery.js';

const PRESETS = [5, 10, 25, 50, 100];

// Customer conversation state (custom amount entry).
const custState = new Map();
export function clearWalletState(id) { custState.delete(String(id)); }

async function walletSend(ctx, text, keyboard) {
  const opts = { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, opts); return; }
    catch (e) { if (!String(e.description || e.message).includes('not modified')) await ctx.reply(text, opts).catch(() => {}); return; }
  }
  await ctx.reply(text, opts);
}

export async function showWallet(ctx) {
  clearWalletState(ctx.from.id);
  const u = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
  const text =
    `💰 <b>Your Wallet</b>\n\n` +
    `💳 Balance: <b>${money(num(u.balance))}</b>\n` +
    `🧾 Total spent: <b>${money(num(u.totalSpent))}</b>\n\n` +
    `Top up with crypto and pay instantly from your balance — or request credit from our team.`;
  const kb = new InlineKeyboard()
    .text('💳 Top Up (crypto)', 'w:topup')
    .row()
    .text('🙋 Request Credit', 'w:req')
    .row()
    .text('🏠 Main Menu', 'menu');
  await walletSend(ctx, text, kb);
}

function amountKeyboard(prefix, includeCustom = true) {
  const kb = new InlineKeyboard();
  PRESETS.forEach((a, i) => {
    kb.text(money(a), `${prefix}:${a}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row();
  if (includeCustom) kb.text('✏️ Custom amount', `${prefix}custom`).row();
  kb.text('⬅️ Wallet', 'balance');
  return kb;
}

async function showTopUp(ctx) {
  const hasManual = config.manualMethods.length > 0;
  const text = hasManual
    ? '💳 <b>Top Up Wallet</b>\n\nChoose an amount, then pick your payment method:'
    : '💳 <b>Top Up Wallet</b>\n\nChoose an amount to add with crypto:';
  await walletSend(ctx, text, amountKeyboard('w:tu'));
}
async function showRequest(ctx) {
  await walletSend(ctx, '🙋 <b>Request Store Credit</b>\n\nChoose how much credit to request from the admin:', amountKeyboard('w:rq'));
}

async function startTopUp(ctx, amount) {
  await ctx.answerCallbackQuery({ text: 'Creating invoice…' }).catch(() => {});
  let result;
  try {
    result = await createTopUpOrder({ user: ctx.dbUser, amount });
  } catch (e) {
    logger.error({ err: e.message }, 'top-up failed');
    return walletSend(ctx, '⚠️ Could not create the top-up invoice. Please try again shortly.', new InlineKeyboard().text('⬅️ Wallet', 'balance'));
  }
  const { order } = result;
  const text =
    `💳 <b>Top Up ${money(num(order.amount))}</b>\n` +
    `🧾 <code>${escapeHtml(order.publicId)}</code>\n\n` +
    `Tap <b>Pay Now</b> to pay with crypto. Your balance updates <b>automatically</b> once the payment confirms. ⚡`;
  await walletSend(ctx, text, payKeyboard(order));
}

async function startManualTopUp(ctx, method, amount) {
  const m = config.manualMethod(method);
  if (!m) {
    return ctx.answerCallbackQuery({ text: 'Payment method unavailable.', show_alert: true }).catch(() => {});
  }
  await ctx.answerCallbackQuery({ text: 'Creating order…' }).catch(() => {});
  let result;
  try {
    result = await createManualTopUpOrder({ user: ctx.dbUser, amount, method: m.key });
  } catch (e) {
    logger.error({ err: e.message, method: m.key }, 'manual top-up failed');
    return walletSend(ctx, '⚠️ Could not create the top-up order. Please try again shortly.', new InlineKeyboard().text('⬅️ Wallet', 'balance'));
  }
  const { order } = result;
  const text =
    `${m.emoji} <b>Top Up ${money(num(order.amount))} via ${escapeHtml(m.label)}</b>\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `💵 Send exactly: <b>${money(num(order.amount))}</b>\n` +
    `🆔 ${escapeHtml(m.idLabel)}: <code>${escapeHtml(m.payId)}</code>\n` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>\n\n` +
    `After sending, tap <b>"I've Paid"</b> below. Your balance is credited once ` +
    `our team verifies it. ⚡`;
  const kb = new InlineKeyboard()
    .text("✅ I've Paid — Notify Admin", `mpaid:${order.id}`).row()
    .text('❌ Cancel', `mcancel:${order.id}`).text('⬅️ Wallet', 'balance');
  await walletSend(ctx, text, kb);
}

async function createCreditRequest(ctx, amount) {
  const u = ctx.dbUser;
  const req = await prisma.creditRequest.create({
    data: { userId: u.id, telegramId: u.telegramId, username: u.username || null, amount, note: '', status: 'PENDING' },
  });
  // Notify admins with approve/decline buttons.
  const name = u.username ? '@' + u.username : (u.firstName || 'User');
  const adminText =
    `🙋 <b>Credit Request</b>\n\n` +
    `👤 ${escapeHtml(name)} (<code>${u.telegramId}</code>)\n` +
    `💰 Amount: <b>${money(amount)}</b>\n` +
    `🆔 Request #${req.id}`;
  const kb = new InlineKeyboard().text('✅ Approve', `a:crok:${req.id}`).text('❌ Decline', `a:crno:${req.id}`);
  for (const id of config.telegram.adminIds) {
    await sendMessageSafe(id, adminText, { reply_markup: kb });
  }
  await walletSend(
    ctx,
    `✅ <b>Request sent!</b>\n\nYou asked for <b>${money(amount)}</b> in store credit. Our team will review it shortly and you'll get a message here. 🙌`,
    new InlineKeyboard().text('⬅️ Wallet', 'balance').text('🏠 Menu', 'menu')
  );
}

// Handle a text message when the customer is entering a custom amount.
export async function handleWalletText(ctx) {
  const st = custState.get(String(ctx.from.id));
  if (!st) return false;
  const amount = parseFloat(String(ctx.message.text).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!(amount > 0)) {
    await ctx.reply('❌ Please send a valid amount, e.g. 15');
    return true;
  }
  if (amount > 100000) { await ctx.reply('❌ That amount is too large.'); return true; }
  clearWalletState(ctx.from.id);
  if (st === 'topup') await startTopUp(ctx, +amount.toFixed(2));
  else if (st === 'request') await createCreditRequest(ctx, +amount.toFixed(2));
  return true;
}

export function registerWalletHandlers(bot) {
  bot.callbackQuery('w:topup', async (ctx) => { await ctx.answerCallbackQuery().catch(() => {}); await showTopUp(ctx); });
  bot.callbackQuery('w:req', async (ctx) => { await ctx.answerCallbackQuery().catch(() => {}); await showRequest(ctx); });
  bot.callbackQuery('w:tucustom', async (ctx) => {
    custState.set(String(ctx.from.id), 'topup');
    await ctx.answerCallbackQuery().catch(() => {});
    await walletSend(ctx, '✏️ Send the <b>amount</b> you want to top up (e.g. 15):', new InlineKeyboard().text('⬅️ Wallet', 'balance'));
  });
  bot.callbackQuery('w:rqcustom', async (ctx) => {
    custState.set(String(ctx.from.id), 'request');
    await ctx.answerCallbackQuery().catch(() => {});
    await walletSend(ctx, '✏️ Send the <b>amount</b> of credit to request (e.g. 15):', new InlineKeyboard().text('⬅️ Wallet', 'balance'));
  });
  bot.callbackQuery(/^w:tu:(\d+(?:\.\d+)?)$/, async (ctx) => {
    const amount = parseFloat(ctx.match[1]);
    const hasCrypto = Boolean(config.cryptomus.merchantId && config.cryptomus.paymentKey);
    const manual = config.manualMethods;

    // More than one way to pay → let the customer choose.
    if ((hasCrypto ? 1 : 0) + manual.length > 1) {
      await ctx.answerCallbackQuery().catch(() => {});
      const kb = new InlineKeyboard();
      if (hasCrypto) kb.text('💳 Crypto (auto)', `w:tuc:${amount}`).row();
      for (const m of manual) kb.text(`${m.emoji} ${m.label} (manual)`, `w:mt:${m.key}:${amount}`).row();
      kb.text('⬅️ Back', 'w:topup');
      await walletSend(ctx, `💳 <b>Top Up ${money(amount)}</b>\n\nChoose your payment method:`, kb);
    } else if (!hasCrypto && manual.length === 1) {
      await startManualTopUp(ctx, manual[0].key, amount);
    } else {
      await startTopUp(ctx, amount);
    }
  });
  // Direct crypto top-up (after method picker)
  bot.callbackQuery(/^w:tuc:(\d+(?:\.\d+)?)$/, async (ctx) => { await startTopUp(ctx, parseFloat(ctx.match[1])); });
  // Manual top-up for a specific method
  bot.callbackQuery(/^w:mt:([A-Z]+):(\d+(?:\.\d+)?)$/, async (ctx) => { await startManualTopUp(ctx, ctx.match[1], parseFloat(ctx.match[2])); });
  // Legacy Binance-only top-up button still live in older chat messages.
  bot.callbackQuery(/^w:bt:(\d+(?:\.\d+)?)$/, async (ctx) => { await startManualTopUp(ctx, 'BINANCE', parseFloat(ctx.match[1])); });
  bot.callbackQuery(/^w:rq:(\d+(?:\.\d+)?)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Sending request…' }).catch(() => {});
    await createCreditRequest(ctx, parseFloat(ctx.match[1]));
  });
}
