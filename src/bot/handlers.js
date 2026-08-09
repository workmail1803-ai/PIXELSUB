import prisma from '../db.js';
import logger from '../logger.js';
import config from '../config.js';
import { money, num, escapeHtml } from '../utils.js';
import { getSetting, render } from '../services/settings.js';
import { createOrder, createBinanceOrder, notifyBinancePending, reconcileOrder, payWithBalance } from '../services/orders.js';
import { showWallet, handleWalletText, clearWalletState } from './wallet.js';
import {
  mainMenuKeyboard,
  shopKeyboard,
  productKeyboard,
  payKeyboard,
  binancePayKeyboard,
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
    `💎 Tap <b>Pay Now</b> to pay with crypto (USDT, BTC, ETH, TRX & more).\n` +
    `⚡ Payment is detected <b>automatically</b> — your items arrive here the moment it confirms.\n` +
    `⏱️ This invoice expires in ${config.shop.orderExpiryMin} minutes.`;

  await smartSend(ctx, text, payKeyboard(order));
}

async function doBinanceCheckout(ctx, productId, qty) {
  const product = await getProductWithStock(productId);
  if (!product || !product.isActive) {
    return ctx.answerCallbackQuery({ text: 'Product unavailable.', show_alert: true }).catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: 'Creating your order…' }).catch(() => {});

  let result;
  try {
    result = await createBinanceOrder({ user: ctx.dbUser, product, quantity: qty });
  } catch (e) {
    if (e.code === 'OUT_OF_STOCK') {
      return smartSend(
        ctx,
        `😔 Sorry, only ${e.available} left in stock. Please pick a smaller quantity.`,
        backMenuKeyboard().text('⬅️ Back', `p:${productId}`)
      );
    }
    logger.error({ err: e.message }, 'Binance checkout failed');
    return smartSend(
      ctx,
      '⚠️ We couldn\'t create your order right now. Please try again.',
      supportKeyboard()
    );
  }

  const { order } = result;
  const binanceId = config.binance.payId;
  const text =
    `🟡 <b>Pay with Binance</b>\n\n` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>\n` +
    `${escapeHtml(product.emoji)} ${escapeHtml(product.name)} ×${qty}\n` +
    `💵 <b>Amount:</b> ${money(num(order.amount), order.currency)}\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📲 <b>Send payment to this Binance ID:</b>\n` +
    `<code>${binanceId}</code>\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `💡 <b>How to pay:</b>\n` +
    `1️⃣ Open Binance app\n` +
    `2️⃣ Go to <b>Pay</b> → <b>Send</b>\n` +
    `3️⃣ Enter ID: <code>${binanceId}</code>\n` +
    `4️⃣ Send <b>${money(num(order.amount), order.currency)}</b>\n` +
    `5️⃣ Tap <b>"I've Paid"</b> below\n\n` +
    `⏱️ This order expires in ${config.shop.orderExpiryMin} minutes.`;

  await smartSend(ctx, text, binancePayKeyboard(order));
}

async function doBinancePaid(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }
  if (order.status !== 'PENDING') {
    return ctx.answerCallbackQuery({ text: `Order is already ${order.status.toLowerCase()}.`, show_alert: true }).catch(() => {});
  }

  await ctx.answerCallbackQuery({ text: 'Notifying admin…' }).catch(() => {});
  await notifyBinancePending(order);

  await smartSend(
    ctx,
    `✅ <b>Payment submitted for verification!</b>\n\n` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>\n` +
    `💵 Amount: <b>${money(num(order.amount), order.currency)}</b>\n\n` +
    `Our admin is checking your payment now. You'll receive your items here as soon as it's confirmed. ⚡\n\n` +
    `Usually takes just a few minutes. 🕐`,
    backMenuKeyboard().text('🛍️ Shop', 'shop')
  );
}

async function doBinanceCancel(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== ctx.dbUser.id) {
    return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  }
  if (order.status === 'PENDING') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await prisma.orderEvent.create({ data: { orderId: order.id, type: 'cancelled', message: 'Cancelled by user (Binance)' } });
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

  // Binance Pay handlers
  bot.callbackQuery(/^binchk:(\d+):(\d+)$/, async (ctx) => {
    await doBinanceCheckout(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery(/^binpaid:(\d+)$/, async (ctx) => {
    await doBinancePaid(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^bincancel:(\d+)$/, async (ctx) => {
    await doBinanceCancel(ctx, Number(ctx.match[1]));
  });

  // Fallback for any stray text: wallet custom-amount entry, else show the menu.
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text?.startsWith('/')) return; // unknown command
    if (await handleWalletText(ctx)) return;
    await showMainMenu(ctx);
  });
}
