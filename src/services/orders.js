import prisma from '../db.js';
import logger from '../logger.js';
import config from '../config.js';
import { shortId, invoiceOrderId, num } from '../utils.js';
import * as cryptomus from '../payments/cryptomus.js';
import { sendDelivery, sendOutOfStockApology, notifyAdmins, sendMessageSafe } from '../bot/delivery.js';
import { render } from './settings.js';
import { money, escapeHtml } from '../utils.js';
import { InlineKeyboard } from 'grammy';

// How many unsold stock items a product currently has.
export async function availableStock(productId) {
  return prisma.stockItem.count({ where: { productId, isSold: false } });
}

async function logEvent(orderId, type, message = '') {
  try {
    await prisma.orderEvent.create({ data: { orderId, type, message } });
  } catch (e) {
    logger.warn({ err: e.message }, 'failed to write order event');
  }
}

/**
 * Create an order for a single product + quantity, and create a Cryptomus invoice.
 * Returns { order, payUrl } or throws { code: 'OUT_OF_STOCK' | ... }.
 */
export async function createOrder({ user, product, quantity }) {
  quantity = Math.max(1, Math.floor(Number(quantity) || 1));

  if (product.usesStock) {
    const avail = await availableStock(product.id);
    if (avail < quantity) {
      const err = new Error('Not enough stock');
      err.code = 'OUT_OF_STOCK';
      err.available = avail;
      throw err;
    }
  }

  const unitPrice = num(product.price);
  const lineTotal = +(unitPrice * quantity).toFixed(2);
  const publicId = shortId('ORD');
  const invId = invoiceOrderId();
  const expiresAt = new Date(Date.now() + config.shop.orderExpiryMin * 60 * 1000);

  const order = await prisma.order.create({
    data: {
      publicId,
      userId: user.id,
      status: 'PENDING',
      method: 'CRYPTOMUS',
      amount: lineTotal,
      currency: config.shop.currency,
      invoiceOrderId: invId,
      expiresAt,
      items: {
        create: [
          {
            productId: product.id,
            productName: product.name,
            emoji: product.emoji,
            unitPrice,
            unitCost: num(product.cost),
            quantity,
            lineTotal,
          },
        ],
      },
    },
    include: { items: true, user: true },
  });

  await logEvent(order.id, 'created', `${quantity} × ${product.name}`);

  // Create the hosted crypto invoice.
  let invoice;
  try {
    invoice = await cryptomus.createInvoice({
      amount: lineTotal,
      currency: order.currency,
      orderId: invId,
      lifetimeSeconds: config.shop.orderExpiryMin * 60,
    });
  } catch (e) {
    logger.error({ err: e.message, order: publicId }, 'Cryptomus invoice creation failed');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    await logEvent(order.id, 'note', `invoice creation failed: ${e.message}`);
    const err = new Error('Payment provider error');
    err.code = 'INVOICE_FAILED';
    throw err;
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { invoiceUuid: invoice.uuid, payUrl: invoice.url },
    include: { items: true, user: true },
  });
  await logEvent(order.id, 'invoice_created', `uuid=${invoice.uuid}`);

  return { order: updated, payUrl: invoice.url };
}

/**
 * Create a wallet TOP-UP order (buy store credit). Reuses the whole Cryptomus
 * invoice + webhook + poller pipeline; on payment we credit balance instead of
 * delivering a product.
 */
export async function createTopUpOrder({ user, amount }) {
  amount = +Number(amount).toFixed(2);
  if (!(amount > 0)) {
    const err = new Error('Invalid amount');
    err.code = 'BAD_AMOUNT';
    throw err;
  }
  const publicId = shortId('TOP');
  const invId = invoiceOrderId();
  const expiresAt = new Date(Date.now() + config.shop.orderExpiryMin * 60 * 1000);

  const order = await prisma.order.create({
    data: {
      publicId,
      userId: user.id,
      status: 'PENDING',
      method: 'CRYPTOMUS',
      kind: 'TOPUP',
      amount,
      currency: config.shop.currency,
      invoiceOrderId: invId,
      expiresAt,
    },
  });
  await logEvent(order.id, 'created', `wallet top-up ${money(amount)}`);

  let invoice;
  try {
    invoice = await cryptomus.createInvoice({
      amount,
      currency: order.currency,
      orderId: invId,
      lifetimeSeconds: config.shop.orderExpiryMin * 60,
    });
  } catch (e) {
    logger.error({ err: e.message, order: publicId }, 'Cryptomus top-up invoice failed');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    const err = new Error('Payment provider error');
    err.code = 'INVOICE_FAILED';
    throw err;
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { invoiceUuid: invoice.uuid, payUrl: invoice.url },
  });
  await logEvent(order.id, 'invoice_created', `uuid=${invoice.uuid}`);
  return { order: updated, payUrl: invoice.url };
}

/**
 * Create an order for Binance Pay (manual verification).
 * No external invoice is created — the customer pays to the admin's Binance ID
 * and then clicks "I've Paid" which notifies admins to verify.
 */
export async function createManualOrder({ user, product, quantity, method = 'BINANCE' }) {
  quantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const m = config.manualMethod(method);
  if (!m) {
    const err = new Error('Payment method unavailable');
    err.code = 'BAD_METHOD';
    throw err;
  }

  if (product.usesStock) {
    const avail = await availableStock(product.id);
    if (avail < quantity) {
      const err = new Error('Not enough stock');
      err.code = 'OUT_OF_STOCK';
      err.available = avail;
      throw err;
    }
  }

  const unitPrice = num(product.price);
  const lineTotal = +(unitPrice * quantity).toFixed(2);
  const publicId = shortId('ORD');
  const expiresAt = new Date(Date.now() + config.shop.orderExpiryMin * 60 * 1000);

  const order = await prisma.order.create({
    data: {
      publicId,
      userId: user.id,
      status: 'PENDING',
      method: m.key,
      amount: lineTotal,
      currency: config.shop.currency,
      expiresAt,
      items: {
        create: [
          {
            productId: product.id,
            productName: product.name,
            emoji: product.emoji,
            unitPrice,
            unitCost: num(product.cost),
            quantity,
            lineTotal,
          },
        ],
      },
    },
    include: { items: true, user: true },
  });

  await logEvent(order.id, 'created', `${quantity} × ${product.name} (${m.label})`);
  return { order };
}

/**
 * Create a wallet top-up order via a manually-verified method.
 */
export async function createManualTopUpOrder({ user, amount, method = 'BINANCE' }) {
  amount = +Number(amount).toFixed(2);
  if (!(amount > 0)) {
    const err = new Error('Invalid amount');
    err.code = 'BAD_AMOUNT';
    throw err;
  }
  const m = config.manualMethod(method);
  if (!m) {
    const err = new Error('Payment method unavailable');
    err.code = 'BAD_METHOD';
    throw err;
  }
  const publicId = shortId('TOP');
  const expiresAt = new Date(Date.now() + config.shop.orderExpiryMin * 60 * 1000);

  const order = await prisma.order.create({
    data: {
      publicId,
      userId: user.id,
      status: 'PENDING',
      method: m.key,
      kind: 'TOPUP',
      amount,
      currency: config.shop.currency,
      expiresAt,
    },
  });
  await logEvent(order.id, 'created', `wallet top-up ${money(amount)} (${m.label})`);
  return { order };
}

// Older names kept so nothing that still imports them breaks.
export const createBinanceOrder = (args) => createManualOrder({ ...args, method: 'BINANCE' });
export const createBinanceTopUpOrder = (args) => createManualTopUpOrder({ ...args, method: 'BINANCE' });

/**
 * Notify admins that a customer claims to have paid via Binance.
 */
export async function notifyManualPending(order) {
  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  if (!user) return;
  const m = config.manualMethod(order.method) || { label: order.method, emoji: '🔔', idLabel: 'ID', payId: '' };
  const name = user.username ? '@' + user.username : (user.firstName || 'User');
  const kindLabel = order.kind === 'TOPUP' ? 'Top-Up' : 'Purchase';
  const text =
    `${m.emoji} <b>${escapeHtml(m.label)} Payment Pending</b>\n\n` +
    `👤 ${escapeHtml(name)} (<code>${user.telegramId}</code>)\n` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>\n` +
    `💰 Amount: <b>${money(num(order.amount), order.currency)}</b>\n` +
    `📋 Type: ${kindLabel}\n\n` +
    `Customer says they paid to ${escapeHtml(m.idLabel)} <code>${escapeHtml(m.payId)}</code>.\n` +
    `Please verify the payment in your ${escapeHtml(m.label)} app.`;
  const kb = new InlineKeyboard()
    .text('✅ Approve', `a:binok:${order.id}`)
    .text('❌ Decline', `a:binno:${order.id}`);
  for (const id of config.telegram.adminIds) {
    await sendMessageSafe(id, text, { reply_markup: kb });
  }
}

/**
 * A crypto payment arrived short of the invoice by more than the tolerance.
 * The money is already in the merchant account, so this must never be silent:
 * ping every admin with the real figures and one-tap approve/decline, and tell
 * the customer their payment is being looked at rather than that it failed.
 */
async function notifyUnderpaid(order, info, shortfall) {
  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  const name = user?.username ? '@' + user.username : (user?.firstName || 'User');
  const gap = shortfall === null ? 'unknown' : shortfall.toFixed(2) + '%';

  const text =
    `⚠️ <b>Underpaid Crypto Payment</b>\n\n` +
    `👤 ${escapeHtml(name)}${user ? ` (<code>${user.telegramId}</code>)` : ''}\n` +
    `🧾 Order: <b>${escapeHtml(order.publicId)}</b>\n\n` +
    `💵 Invoiced: <b>${money(num(order.amount), order.currency)}</b>\n` +
    `📥 Received: <b>${escapeHtml(String(info.payment_amount ?? '?'))} ${escapeHtml(order.currency)}</b>` +
    `${info.payer_amount ? ` (${escapeHtml(String(info.payer_amount))} ${escapeHtml(info.payer_currency || '')})` : ''}\n` +
    `📉 Short by: <b>${gap}</b>\n` +
    `${info.merchant_amount ? `🏦 Credited to you: <b>${escapeHtml(String(info.merchant_amount))}</b>\n` : ''}` +
    `${info.txid ? `🔗 <code>${escapeHtml(String(info.txid).slice(0, 24))}…</code>\n` : ''}` +
    `\nThe funds <b>did arrive</b>. Approve to deliver, or decline and refund.`;

  const kb = new InlineKeyboard()
    .text('✅ Approve & deliver', `a:binok:${order.id}`)
    .text('❌ Decline', `a:binno:${order.id}`);

  for (const id of config.telegram.adminIds) {
    await sendMessageSafe(id, text, { reply_markup: kb });
  }

  await sendMessageSafe(
    order.userId && user ? user.telegramId : order.userId,
    `⏳ <b>Payment received — being verified</b>\n\n` +
      `We got your payment for order <code>${escapeHtml(order.publicId)}</code>, but it came in slightly under the invoiced amount.\n\n` +
      `Our team is reviewing it now and you'll get your items here shortly. 🙏`
  );
}

/**
 * Admin approves a Binance payment → mark paid and deliver.
 */
export async function approveManualPayment(orderId) {
  return markPaidAndDeliver(orderId, { payer_currency: 'BINANCE' });
}

/**
 * Admin declines a Binance payment → mark order failed.
 */
export async function declineManualPayment(orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
  if (!order) return;
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(order.status)) return;
  await prisma.order.update({ where: { id: orderId }, data: { status: 'FAILED' } });
  await logEvent(orderId, 'note', 'Binance payment declined by admin');
  await sendMessageSafe(
    order.user.telegramId,
    `❌ <b>Payment not verified</b>\n\nYour payment for order <code>${escapeHtml(order.publicId)}</code> (${money(num(order.amount), order.currency)}) could not be verified.\n\nIf you believe this is an error, please contact support.`
  );
}

// Credit a top-up to the user's wallet balance (idempotent per order).
async function creditTopUp(order) {
  await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } }),
    prisma.user.update({ where: { id: order.userId }, data: { balance: { increment: order.amount } } }),
  ]);
  await logEvent(order.id, 'delivered', 'wallet credited');
  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  await sendMessageSafe(
    user.telegramId,
    `✅ <b>Wallet topped up!</b>\n\n💰 Added <b>${money(num(order.amount), order.currency)}</b>\n💳 New balance: <b>${money(num(user.balance), order.currency)}</b>\n\nUse it at checkout with “Pay with Balance”. 🛍️`
  );
  logger.info({ order: order.publicId }, 'wallet top-up credited');
}

/**
 * Pay for a product immediately using the user's wallet balance.
 * Deducts balance, creates a PAID order, and delivers right away.
 */
export async function payWithBalance({ user, product, quantity }) {
  quantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const unitPrice = num(product.price);
  const total = +(unitPrice * quantity).toFixed(2);

  // Re-read balance fresh to avoid stale reads.
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if (num(fresh.balance) < total) {
    const err = new Error('Insufficient balance');
    err.code = 'INSUFFICIENT_BALANCE';
    err.balance = num(fresh.balance);
    throw err;
  }
  if (product.usesStock) {
    const avail = await availableStock(product.id);
    if (avail < quantity) {
      const err = new Error('Not enough stock');
      err.code = 'OUT_OF_STOCK';
      err.available = avail;
      throw err;
    }
  }

  // Atomically deduct balance guarded against races (only if still sufficient).
  const dec = await prisma.user.updateMany({
    where: { id: user.id, balance: { gte: total } },
    data: { balance: { decrement: total } },
  });
  if (dec.count !== 1) {
    const err = new Error('Insufficient balance');
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }

  const order = await prisma.order.create({
    data: {
      publicId: shortId('ORD'),
      userId: user.id,
      status: 'PAID',
      method: 'BALANCE',
      kind: 'PURCHASE',
      amount: total,
      currency: config.shop.currency,
      paidAt: new Date(),
      items: {
        create: [{ productId: product.id, productName: product.name, emoji: product.emoji, unitPrice, unitCost: num(product.cost), quantity, lineTotal: total }],
      },
    },
  });
  await logEvent(order.id, 'payment_received', 'paid with wallet balance');

  const result = await fulfillAndDeliver(order.id);
  if (!result.delivered && result.reason === 'out_of_stock') {
    // Refund balance since we couldn't fulfil.
    await prisma.user.update({ where: { id: user.id }, data: { balance: { increment: total } } });
    await logEvent(order.id, 'note', 'balance refunded (stock ran out)');
    const err = new Error('Out of stock');
    err.code = 'OUT_OF_STOCK';
    throw err;
  }
  return { order, delivered: true };
}

/**
 * Atomically claim stock and mark an order delivered. Safe against oversell
 * via guarded conditional updates (works under Postgres READ COMMITTED).
 */
async function fulfillAndDeliver(orderId) {
  // Load order with items
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } }, user: true },
  });
  if (!order) return { delivered: false, reason: 'not_found' };
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(order.status)) {
    return { delivered: false, reason: 'already_final' };
  }

  const deliveredItems = [];
  let outOfStock = false;

  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      const rendered = { ...item, stock: [], deliveredContent: '' };

      // The product row can be gone (admin deleted it while this order was
      // still pending). Route to the manual-action path rather than crashing:
      // the buyer gets an apology and admins get pinged to fulfil or refund.
      if (!item.product) {
        logger.warn(
          { order: order.publicId, productName: item.productName },
          'delivery blocked: product was deleted after the order was placed'
        );
        throw new Error('OUT_OF_STOCK_AT_DELIVERY');
      }

      if (item.product.usesStock) {
        // Claim `quantity` unsold stock items, guarded against races.
        const claimed = [];
        let guard = 0;
        while (claimed.length < item.quantity && guard < item.quantity * 5) {
          guard++;
          const candidate = await tx.stockItem.findFirst({
            where: { productId: item.productId, isSold: false, orderItemId: null },
            orderBy: { id: 'asc' },
            select: { id: true, content: true },
          });
          if (!candidate) break;
          const res = await tx.stockItem.updateMany({
            where: { id: candidate.id, isSold: false },
            data: { isSold: true, soldAt: new Date(), orderItemId: item.id },
          });
          if (res.count === 1) claimed.push(candidate);
        }
        if (claimed.length < item.quantity) {
          outOfStock = true;
          // Roll back any partial claims for THIS item so inventory is accurate.
          if (claimed.length) {
            await tx.stockItem.updateMany({
              where: { id: { in: claimed.map((c) => c.id) } },
              data: { isSold: false, soldAt: null, orderItemId: null },
            });
          }
          throw new Error('OUT_OF_STOCK_AT_DELIVERY');
        }
        rendered.stock = claimed;
      } else {
        rendered.deliveredContent = render(item.product.fixedContent || '', {
          order_id: order.publicId,
        });
      }
      deliveredItems.push(rendered);
    }

    await tx.order.update({
      where: { id: order.id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    await tx.user.update({
      where: { id: order.userId },
      data: { totalSpent: { increment: order.amount } },
    });
  }).catch((e) => {
    if (e.message === 'OUT_OF_STOCK_AT_DELIVERY') {
      outOfStock = true;
    } else {
      throw e;
    }
  });

  if (outOfStock) {
    await logEvent(order.id, 'note', 'stock depleted at delivery — needs manual action');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } }).catch(() => {});
    await sendOutOfStockApology({ ...order }).catch(() => {});
    await notifyAdmins(
      `⚠️ <b>Order ${order.publicId}</b> was PAID but stock ran out at delivery. Please fulfil or refund manually.`
    ).catch(() => {});
    return { delivered: false, reason: 'out_of_stock' };
  }

  // Compose the delivery payload with claimed stock + user.
  const deliverPayload = {
    ...order,
    items: deliveredItems.map((di) => ({
      emoji: di.emoji,
      productName: di.productName,
      quantity: di.quantity,
      stock: di.stock,
      deliveredContent: di.deliveredContent,
    })),
  };

  await sendDelivery(deliverPayload).catch((e) =>
    logger.error({ err: e.message, order: order.publicId }, 'delivery message failed')
  );
  await logEvent(order.id, 'delivered', `${deliveredItems.length} item group(s)`);
  logger.info({ order: order.publicId }, 'order delivered');
  return { delivered: true };
}

/**
 * Mark an order paid (idempotent) and trigger fulfilment/delivery.
 * Called by the webhook and the poller once Cryptomus confirms payment.
 */
export async function markPaidAndDeliver(orderId, paymentMeta = {}) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(order.status)) return;

  if (order.status === 'PENDING' || order.status === 'FAILED' || order.status === 'EXPIRED') {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PAID',
        paidAt: order.paidAt || new Date(),
        payCurrency: paymentMeta.payer_currency || paymentMeta.currency || order.payCurrency,
        payAmount: paymentMeta.payer_amount || paymentMeta.amount || order.payAmount,
        network: paymentMeta.network || order.network,
      },
    });
    await logEvent(orderId, 'payment_received', `via ${paymentMeta.payer_currency || 'crypto'}`);
  }

  // Wallet top-ups credit balance instead of delivering goods.
  const paid = await prisma.order.findUnique({ where: { id: orderId } });
  if (paid.kind === 'TOPUP') {
    if (paid.status !== 'DELIVERED') await creditTopUp(paid);
    return { delivered: true, topup: true };
  }

  return fulfillAndDeliver(orderId);
}

/**
 * Query Cryptomus for the true status of a pending order and act on it.
 * Returns the resolved status string.
 */
export async function reconcileOrder(order) {
  // Manually-verified methods (Binance, Bybit, …) are confirmed by an admin,
  // never by an API call.
  if (config.manualMethodKeys.has(order.method)) return order.status;
  if (!order.invoiceUuid && !order.invoiceOrderId) return order.status;
  let info;
  try {
    info = await cryptomus.getPaymentInfo({
      uuid: order.invoiceUuid || undefined,
      orderId: order.invoiceOrderId || undefined,
    });
  } catch (e) {
    logger.warn({ err: e.message, order: order.publicId }, 'reconcile: payment info fetch failed');
    return order.status;
  }

  const status = info.payment_status;
  logger.debug({ order: order.publicId, status }, 'reconcile status');

  if (cryptomus.PAID_STATUSES.has(status)) {
    await markPaidAndDeliver(order.id, info);
    return 'PAID';
  }

  // Funds arrived but landed under the invoice — typically a customer sending a
  // round number of USDT, which the exchange rate turns into a few cents short.
  // Deliver anyway when the gap is trivial; otherwise hand it to an admin. The
  // one thing we never do is silently fail an order whose money we received.
  if (cryptomus.UNDERPAID_STATUSES.has(status)) {
    const shortfall = cryptomus.shortfallPercent(info, num(order.amount));
    const tolerance = config.cryptomus.underpayTolerancePct;

    if (shortfall !== null && shortfall <= tolerance) {
      logger.info(
        { order: order.publicId, shortfallPct: shortfall.toFixed(3), tolerance },
        'underpaid within tolerance — delivering'
      );
      await logEvent(
        order.id,
        'note',
        `underpaid by ${shortfall.toFixed(2)}% (within ${tolerance}% tolerance) — auto-delivered`
      );
      await markPaidAndDeliver(order.id, info);
      return 'PAID';
    }

    if (order.status === 'PENDING') {
      await logEvent(
        order.id,
        'note',
        `underpaid by ${shortfall === null ? 'an unknown amount' : shortfall.toFixed(2) + '%'} — awaiting admin review`
      );
      await notifyUnderpaid(order, info, shortfall);
    }
    return order.status; // stays PENDING so an admin can approve or refund
  }

  if (cryptomus.FAILED_STATUSES.has(status)) {
    if (order.status === 'PENDING') {
      await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      await logEvent(order.id, 'note', `payment ${status}`);
    }
    return 'FAILED';
  }
  return order.status; // still pending/processing
}

// Mark long-unpaid pending orders as expired.
export async function expireStaleOrders() {
  const now = new Date();
  const stale = await prisma.order.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { id: true, publicId: true },
  });
  for (const o of stale) {
    await prisma.order.update({ where: { id: o.id }, data: { status: 'EXPIRED' } });
    await logEvent(o.id, 'expired', 'no payment before expiry');
  }
  if (stale.length) logger.info({ count: stale.length }, 'expired stale orders');
  return stale.length;
}

// Admin action: re-send delivery for an order (idempotent-ish; re-claims if needed).
export async function redeliverOrder(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { stock: true, product: true } }, user: true },
  });
  if (!order) throw new Error('Order not found');

  // If stock already claimed, just re-send it; otherwise run full fulfilment.
  // A deleted product counts as claimed: its codes live on the order item, so
  // re-sending works from stored stock alone.
  const alreadyClaimed = order.items.every(
    (i) => !i.product?.usesStock || i.stock.length >= i.quantity
  );
  if ((order.status === 'DELIVERED' || order.status === 'PAID') && alreadyClaimed) {
    const payload = {
      ...order,
      items: order.items.map((i) => ({
        emoji: i.emoji,
        productName: i.productName,
        quantity: i.quantity,
        stock: i.stock,
        deliveredContent: i.product && !i.product.usesStock
          ? render(i.product.fixedContent || '', { order_id: order.publicId })
          : '',
      })),
    };
    await sendDelivery(payload);
    await logEvent(order.id, 'note', 'admin re-sent delivery');
    return { redelivered: true };
  }
  return fulfillAndDeliver(orderId);
}

// Older names kept so nothing that still imports them breaks.
export const approveBinancePayment = approveManualPayment;
export const declineBinancePayment = declineManualPayment;
export const notifyBinancePending = notifyManualPending;
