import prisma from '../db.js';
import logger from '../logger.js';
import config from '../config.js';
import { money, num, escapeHtml } from '../utils.js';
import { getSetting, render } from '../services/settings.js';
import { createOrder, createManualOrder, notifyManualPending, reconcileOrder, payWithBalance, verifyBinanceByReference } from '../services/orders.js';
import { showWallet, handleWalletText, clearWalletState } from './wallet.js';
import {
  mainMenuKeyboard,
  shopKeyboard,
  productKeyboard,
  payKeyboard,
  manualPayKeyboard,
  ordersKeyboard,
  orderDetailKeyboard,
  supportKeyboard,
  backMenuKeyboard,
  statusEmoji,
} from './keyboards.js';
import { showAdminMenu } from './admin.js';

// ---------- helpers ----------

async function smartSend(ctx, text, keyboard) {
  const opts = {
    parse_mode: 'HTML',
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  };
  // If triggered from a button, edit in place for a smooth feel.
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch (e) {
      // e.g. "message is not modified" or too old — fall through to a fresh send
      if (!String(e.description || e.message).includes('message is not modified')) {
        await ctx.reply(text, opts).catch(() => {});
      }
      return;
    }
  }
  await ctx.reply(text, opts);
}

async function getActiveProducts() {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { stock: { where: { isSold: false } } } } },
  });
  return products.map((p) => ({ ...p, available: p._count.stock }));
}

async function getProductWithStock(id) {
  const p = await prisma.product.findUnique({
    where: { id },
    include: { _count: { select: { stock: { where: { isSold: false } } } } },
  });
  if (!p) return null;
  return { ...p, available: p._count.stock };
}

async function showMainMenu(ctx) {
  clearWalletState(ctx.from.id);
  clearTxPrompt(ctx.from.id);
  // Admins get their control panel straight from /start.
  if (ctx.isAdmin) return showAdminMenu(ctx);
  const shopName = await getSetting('shop_name');
  const welcome = render(await getSetting('welcome_message'), { shop_name: shopName });
  await smartSend(ctx, welcome, mainMenuKeyboard(false));
}

async function showShop(ctx) {
  const products = await getActiveProducts();
  if (!products.length) {
    await smartSend(ctx, '🛒 The shop is being restocked. Please check back soon!', backMenuKeyboard());
    return;
  }
  const intro = await getSetting('shop_intro');
  await smartSend(ctx, intro, shopKeyboard(products));
}

async function showProduct(ctx, productId, qty = 1) {
  const product = await getProductWithStock(productId);
  if (!product || !product.isActive) {
    await ctx.answerCallbackQuery({ text: 'Product unavailable.', show_alert: true }).catch(() => {});
    return showShop(ctx);
  }

  const maxQty = product.usesStock ? Math.max(0, product.available) : 99;
  qty = Math.min(Math.max(1, qty), Math.max(1, maxQty));

  const inStock = !product.usesStock || product.available > 0;
  const stockLine = product.usesStock
    ? inStock
      ? `📦 <b>In stock:</b> ${product.available}`
      : '📦 <b>Out of stock</b>'
    : '♾️ <b>Always available</b>';

  const descBlock = product.description ? `\n\n${escapeHtml(product.description)}` : '';
  const total = num(product.price) * qty;
  const text =
    `${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b>\n` +
    `💵 <b>Price:</b> ${money(num(product.price))} each\n` +
    `${stockLine}${descBlock}` +
    `\n\n🧮 <b>Total for ${qty}:</b> ${money(total)}`;

  if (!inStock) {
    await smartSend(
      ctx,
      `${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b>\n\n😔 This item is currently out of stock. Please check back soon!`,
      backMenuKeyboard().text('⬅️ Back to Shop', 'shop')
    );
    return;
  }

  await smartSend(ctx, text, productKeyboard(product, qty, maxQty, { balance: num(ctx.dbUser.balance) }));
}

async function doPayWithBalance(ctx, productId, qty) {
  const product = await getProductWithStock(productId);
  if (!product || !product.isActive) {
    return ctx.answerCallbackQuery({ text: 'Product unavailable.', show_alert: true }).catch(() => {});
  }
  await ctx.answerCallbackQuery({ text: 'Processing…' }).catch(() => {});
  try {
    await payWithBalance({ user: ctx.dbUser, product, quantity: qty });
    // Delivery message is pushed by fulfilment; confirm succinctly here.
    await smartSend(
      ctx,
      `✅ <b>Paid with balance!</b>\n\nYour items have been delivered above. 🎁\nThank you!`,
      backMenuKeyboard().text('🛍️ Shop', 'shop')
    );
  } catch (e) {
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return smartSend(ctx, `😔 Not enough balance. Top up your wallet and try again.`, backMenuKeyboard().text('💳 Top Up', 'w:topup'));
    }
    if (e.code === 'OUT_OF_STOCK') {
      return smartSend(ctx, `😔 Sorry, that just went out of stock. Your balance was not charged.`, backMenuKeyboard().text('⬅️ Shop', 'shop'));
    }
    logger.error({ err: e.message }, 'pay with balance failed');
    return smartSend(ctx, '⚠️ Something went wrong. Your balance was not charged. Please try again.', backMenuKeyboard());
  }
}

async function doCheckout(ctx, productId, qty) {
  const product = await getProductWithStock(productId);
  if (!product || !product.isActive) {
    return ctx.answerCallbackQuery({ text: 'Product unavailable.', show_alert: true }).catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: 'Creating your invoice…' }).catch(() => {});

  let result;
  try {
    result = await createOrder({ user: ctx.dbUser, product, quantity: qty });
  } catch (e) {
    if (e.code === 'OUT_OF_STOCK') {
      return smartSend(
        ctx,
        `😔 Sorry, only ${e.available} left in stock. Please pick a smaller quantity.`,
        backMenuKeyboard().text('⬅️ Back', `p:${productId}`)
      );
    }
    logger.error({ err: e.message }, 'checkout failed');
    return smartSend(
      ctx,
      '⚠️ We couldn\'t create your payment right now. Please try again in a moment or contact support.',
      supportKeyboard()
    );
  }

  const { order } = result;
  const text =
    `🧾 <b>Order ${escapeHtml(order.publicId)}</b>\n\n` +
    `${escapeHtml(product.emoji)} ${escapeHtml(product.name)} ×${qty}\n` +
    `💵 <b>Amount:</b> ${money(num(order.amount), order.currency)}\n\n` +
    `💎 Tap <b>Pay Now</b> to pay with crypto (USDT, BTC, ETH, TRX & more).

` +
    `━━━━━━━━━━━━━━━
` +
    `⚡ <b>AUTOMATIC VERIFICATION</b>
` +
    `━━━━━━━━━━━━━━━

` +
    `🤖 Nothing else to do — we detect your payment <b>automatically</b> the moment it` +
    ` confirms on the blockchain, and your items arrive here in seconds. ✅

` +
    `⏱️ This invoice expires in ${config.shop.orderExpiryMin} minutes.`;

  await smartSend(ctx, text, payKeyboard(order));
}

async function doManualCheckout(ctx, method, productId, qty) {
  const m = config.manualMethod(method);
  if (!m) {
    return ctx.answerCallbackQuery({ text: 'Payment method unavailable.', show_alert: true }).catch(() => {});
  }
  const product = await getProductWithStock(productId);
  if (!product || !product.isActive) {
    return ctx.answerCallbackQuery({ text: 'Product unavailable.', show_alert: true }).catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: 'Creating your order…' }).catch(() => {});

  let result;
  try {
    result = await createManualOrder({ user: ctx.dbUser, product, quantity: qty, method: m.key });
  } catch (e) {
    if (e.code === 'OUT_OF_STOCK') {
      return smartSend(
        ctx,
        `😔 Sorry, only ${e.available} left in stock. Please pick a smaller quantity.`,
        backMenuKeyboard().text('⬅️ Back', `p:${productId}`)
      );
    }
    logger.error({ err: e.message, method: m.key }, 'manual checkout failed');
    return smartSend(
      ctx,
      '⚠️ We couldn\'t create your order right now. Please try again.',
      supportKeyboard()
    );
  }

  const { order } = result;
  const auto = m.key === 'BINANCE' && binanceApiReady();

  if (auto) {
    // Arm the transaction-id prompt now, so the customer can just paste it
    // after paying instead of pressing another button first.
    txPrompt.set(String(ctx.from.id), order.id);
  }

  const text =
    `${m.emoji} <b>Pay via ${escapeHtml(m.label)}</b>\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `🛍️ Item: <b>${escapeHtml(product.name)}</b>${qty > 1 ? ` ×${qty}` : ''}\n` +
    `💵 Send exactly: <b>${money(num(order.amount), order.currency)}</b>\n` +
    `🆔 ${escapeHtml(m.idLabel)}: <code>${escapeHtml(m.payId)}</code>\n` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>\n\n` +
    `⏰ This payment session expires in ${config.shop.orderExpiryMin} minutes.\n\n` +
    (auto
      ? `━━━━━━━━━━━━━━━\n` +
        `⚡ <b>AUTOMATIC VERIFICATION</b>\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `After paying, open the payment in your ${escapeHtml(m.label)} app, copy the ` +
        `<b>Transaction ID</b> (or Order ID), and <b>send it here as a message</b>.\n\n` +
        `<i>Example:</i> <code>436520167574593536</code>\n\n` +
        `🤖 We check it with ${escapeHtml(m.label)} instantly and deliver your items in ` +
        `seconds — no waiting for staff. ✅`
      : `After sending, tap <b>"I've Paid"</b> below. Our team verifies it and your ` +
        `items arrive here shortly. ⚡`);

  await smartSend(ctx, text, manualPayKeyboard(order, { autoVerify: auto }));
}

// Customers awaiting a transaction id: telegram id -> order id.
const txPrompt = new Map();
export function clearTxPrompt(id) { txPrompt.delete(String(id)); }

async function doManualPaid(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }
  if (order.status !== 'PENDING') {
    return ctx.answerCallbackQuery({ text: `Order is already ${order.status.toLowerCase()}.`, show_alert: true }).catch(() => {});
  }

  const m = config.manualMethod(order.method);
  const canAutoVerify = order.method === 'BINANCE' && binanceApiReady();

  // Binance can be checked against the exchange, so ask for the reference.
  if (canAutoVerify) {
    txPrompt.set(String(ctx.from.id), order.id);
    await ctx.answerCallbackQuery().catch(() => {});
    return smartSend(
      ctx,
      `🧾 <b>Send your Transaction ID</b>

` +
      `Order: <b>${escapeHtml(order.publicId)}</b> · ${money(num(order.amount), order.currency)}

` +
      `Open the payment in your Binance app and copy the <b>Transaction ID</b> or <b>Order ID</b>, then send it here as a message.

` +
      `<i>It looks like</i> <code>P_A22DZ34XBFS71116</code> <i>or</i> <code>436520167574593536</code>

` +
      `⚡ We'll verify it instantly and deliver your items.`,
      backMenuKeyboard().text('❌ Cancel', `mcancel:${order.id}`)
    );
  }

  // Everything else (Bybit) still goes to a human.
  await ctx.answerCallbackQuery({ text: 'Notifying admin…' }).catch(() => {});
  await notifyManualPending(order);
  await smartSend(
    ctx,
    `✅ <b>Payment submitted for verification!</b>

` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>
` +
    `💵 Amount: <b>${money(num(order.amount), order.currency)}</b>

` +
    `Our admin is checking your ${escapeHtml(m?.label || 'payment')} now. You'll receive your items here as soon as it's confirmed. ⚡

` +
    `Usually takes just a few minutes. 🕐`,
    backMenuKeyboard().text('🛍️ Shop', 'shop')
  );
}

function binanceApiReady() {
  return Boolean(config.binance.apiKey && config.binance.apiSecret && config.binance.payId);
}

// Handle a transaction id sent while an order is awaiting one. Returns true if consumed.
async function handleTxReference(ctx) {
  const orderId = txPrompt.get(String(ctx.from.id));
  if (!orderId) return false;
  // A slash command is never a transaction id — drop the prompt and let the
  // command run, so a customer can never get stuck in this state.
  if (String(ctx.message.text || '').startsWith('/')) { clearTxPrompt(ctx.from.id); return false; }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== ctx.dbUser.id) { clearTxPrompt(ctx.from.id); return false; }
  if (order.status !== 'PENDING') {
    clearTxPrompt(ctx.from.id);
    await ctx.reply(`This order is already ${order.status.toLowerCase()}.`, { reply_markup: backMenuKeyboard() });
    return true;
  }

  const reference = String(ctx.message.text || '').trim();
  const checking = await ctx.reply('🔍 Checking your payment on Binance…').catch(() => null);

  let res;
  try {
    res = await verifyBinanceByReference(order, reference);
  } catch (e) {
    logger.error({ err: e.message, order: order.publicId }, 'binance reference verification crashed');
    res = { ok: false, reason: 'api_error' };
  }
  if (checking) await ctx.api.deleteMessage(ctx.chat.id, checking.message_id).catch(() => {});

  if (res.ok) {
    clearTxPrompt(ctx.from.id);
    await ctx.reply(
      `✅ <b>Payment confirmed!</b>

` +
      `🧾 Order: <b>${escapeHtml(order.publicId)}</b>
` +
      `💵 Received: <b>${escapeHtml(String(res.tx.amount))} ${escapeHtml(res.tx.currency)}</b>

` +
      `Your items have been delivered above. Thank you! 🎁`,
      { parse_mode: 'HTML', reply_markup: backMenuKeyboard().text('🛍️ Shop', 'shop') }
    );
    return true;
  }

  const owed = money(num(order.amount), order.currency);
  const messages = {
    not_found:
      `❌ <b>We couldn't find that transaction.</b>

` +
      `Please double-check the ID and send it again. Copy it directly from the payment details in your Binance app.

` +
      `If you paid only a moment ago, wait ~30 seconds and try once more.`,
    wrong_amount:
      `⚠️ <b>Amount doesn't match.</b>

` +
      `That transfer was <b>${escapeHtml(String(res.tx?.amount ?? '?'))} ${escapeHtml(String(res.tx?.currency ?? ''))}</b>, ` +
      `but this order is for <b>${owed}</b>.

` +
      `Send the correct transaction ID, or contact support if you believe this is an error.`,
    already_used:
      `⚠️ <b>That transaction was already used</b> for another order.

` +
      `Each payment can only be applied once. Please send the ID of the payment for <b>this</b> order.`,
    not_incoming:
      `⚠️ That looks like a payment <b>you received</b>, not one you sent to us.

Please send the ID of your payment to us.`,
    too_old:
      `⚠️ <b>That transfer is older than this order.</b>

Please send the ID of the payment you made for <b>${escapeHtml(order.publicId)}</b>.`,
    ref_too_short: `⚠️ That doesn't look like a transaction ID. Please copy the full ID from your Binance app.`,
  };

  if (res.reason === 'api_error' || res.reason === 'not_configured') {
    // Our problem, not theirs — hand it to a human so nobody is left stranded.
    clearTxPrompt(ctx.from.id);
    await notifyManualPending(order);
    await ctx.reply(
      `⏳ <b>We couldn't reach Binance right now.</b>

` +
      `Don't worry — our team has been notified and will confirm your payment manually. You'll get your items here shortly. 🙏`,
      { parse_mode: 'HTML', reply_markup: supportKeyboard() }
    );
    return true;
  }

  await ctx.reply(messages[res.reason] || messages.not_found, {
    parse_mode: 'HTML',
    reply_markup: backMenuKeyboard().text('💬 Support', 'support'),
  });
  return true;
}

async function doManualCancel(ctx, orderId) {
  clearTxPrompt(ctx.from.id);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }
  if (order.status === 'PENDING') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await prisma.orderEvent.create({ data: { orderId: order.id, type: 'cancelled', message: 'Cancelled by user' } });
  }
  await ctx.answerCallbackQuery({ text: 'Order cancelled.' }).catch(() => {});
  await showShop(ctx);
}

async function doCheckStatus(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }

  if (['DELIVERED'].includes(order.status)) {
    return ctx.answerCallbackQuery({ text: '✅ Already delivered! Check the messages above.', show_alert: true }).catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: 'Checking payment…' }).catch(() => {});
  const status = await reconcileOrder(order);

  if (status === 'PAID') {
    // Delivery message is pushed by reconcile; just confirm here.
    await ctx.answerCallbackQuery({ text: '✅ Payment confirmed! Your items are on the way.', show_alert: true }).catch(() => {});
    return;
  }
  if (status === 'FAILED') {
    return smartSend(ctx, '⚠️ This payment failed or was cancelled. You can create a new order any time.', backMenuKeyboard());
  }
  await ctx.answerCallbackQuery({
    text: '⏳ Payment not detected yet. If you just paid, give it a minute — it confirms automatically.',
    show_alert: true,
  }).catch(() => {});
}

async function doCancel(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }
  if (order.status === 'PENDING') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await prisma.orderEvent.create({ data: { orderId: order.id, type: 'cancelled', message: 'Cancelled by user' } });
  }
  await ctx.answerCallbackQuery({ text: 'Order cancelled.' }).catch(() => {});
  await showShop(ctx);
}

async function showOrders(ctx) {
  const orders = await prisma.order.findMany({
    where: { userId: ctx.dbUser.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  if (!orders.length) {
    return smartSend(ctx, '📦 You have no orders yet. Visit the shop to get started!', backMenuKeyboard().text('🛍️ Shop', 'shop'));
  }
  await smartSend(ctx, '📦 <b>Your recent orders</b>\n\nTap one to view details.', ordersKeyboard(orders));
}

async function showOrderDetail(ctx, orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { stock: true } } },
  });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }

  const lines = order.items
    .map((i) => `${escapeHtml(i.emoji)} ${escapeHtml(i.productName)} ×${i.quantity} — ${money(num(i.lineTotal), order.currency)}`)
    .join('\n');

  let deliveredBlock = '';
  if (order.status === 'DELIVERED') {
    const contents = order.items.flatMap((i) => i.stock.map((s) => `<code>${escapeHtml(s.content)}</code>`));
    if (contents.length) deliveredBlock = `\n\n🎁 <b>Your items:</b>\n${contents.join('\n')}`;
  }

  const text =
    `🧾 <b>Order ${escapeHtml(order.publicId)}</b>\n` +
    `${statusEmoji(order.status)} <b>Status:</b> ${order.status}\n` +
    `💵 <b>Total:</b> ${money(num(order.amount), order.currency)}\n` +
    `🗓️ ${new Date(order.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n` +
    `${lines}${deliveredBlock}`;

  await smartSend(ctx, text, orderDetailKeyboard(order));
}

async function showSupport(ctx) {
  const text = await getSetting('support_text');
  await smartSend(ctx, text, supportKeyboard());
}

async function showFaq(ctx) {
  const text = await getSetting('faq_text');
  await smartSend(ctx, text, backMenuKeyboard());
}

// ---------- registration ----------

export function registerHandlers(bot) {
  bot.command('start', showMainMenu);
  bot.command('menu', showMainMenu);
  bot.command('shop', showShop);
  bot.command('orders', showOrders);
  bot.command('help', showSupport);
  bot.command('whoami', (ctx) =>
    ctx.reply(
      `Your Telegram ID: <code>${ctx.from.id}</code>\nUsername: @${ctx.from.username || '—'}\nAdmin: ${ctx.isAdmin ? 'yes' : 'no'}`,
      { parse_mode: 'HTML' }
    )
  );

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery().catch(() => {}));
  bot.callbackQuery('menu', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showMainMenu(ctx);
  });
  bot.callbackQuery('shop', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showShop(ctx);
  });
  bot.callbackQuery('orders', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showOrders(ctx);
  });
  bot.callbackQuery('balance', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showWallet(ctx);
  });
  bot.callbackQuery('support', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showSupport(ctx);
  });
  bot.callbackQuery('faq', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showFaq(ctx);
  });

  bot.callbackQuery(/^p:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showProduct(ctx, Number(ctx.match[1]), 1);
  });
  bot.callbackQuery(/^q:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showProduct(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery(/^checkout:(\d+):(\d+)$/, async (ctx) => {
    await doCheckout(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery(/^paybal:(\d+):(\d+)$/, async (ctx) => {
    await doPayWithBalance(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery(/^check:(\d+)$/, async (ctx) => {
    await doCheckStatus(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    await doCancel(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^order:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showOrderDetail(ctx, Number(ctx.match[1]));
  });

  // Manually-verified payments (Binance, Bybit, …)
  bot.callbackQuery(/^mchk:([A-Z]+):(\d+):(\d+)$/, async (ctx) => {
    await doManualCheckout(ctx, ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]));
  });
  bot.callbackQuery(/^mpaid:(\d+)$/, async (ctx) => {
    await doManualPaid(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^mcancel:(\d+)$/, async (ctx) => {
    await doManualCancel(ctx, Number(ctx.match[1]));
  });

  // Legacy Binance-only callbacks. Messages already sitting in customers' chats
  // still carry these buttons, so they must keep working.
  bot.callbackQuery(/^binchk:(\d+):(\d+)$/, async (ctx) => {
    await doManualCheckout(ctx, 'BINANCE', Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery(/^binpaid:(\d+)$/, async (ctx) => {
    await doManualPaid(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^bincancel:(\d+)$/, async (ctx) => {
    await doManualCancel(ctx, Number(ctx.match[1]));
  });

  // Fallback for any stray text: wallet custom-amount entry, else show the menu.
  bot.on('message:text', async (ctx) => {
    if (await handleTxReference(ctx)) return;
    if (ctx.message.text?.startsWith('/')) return; // unknown command
    if (await handleWalletText(ctx)) return;
    await showMainMenu(ctx);
  });
}
