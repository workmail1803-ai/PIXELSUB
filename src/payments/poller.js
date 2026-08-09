import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';
import { reconcileOrder, expireStaleOrders } from '../services/orders.js';
import { isConfigured } from './cryptomus.js';

let timer = null;
let running = false;

// Reconcile every PENDING order against Cryptomus. This is the safety net that
// guarantees payments are detected even if a webhook is missed or delayed.
async function tick() {
  if (running) return;
  running = true;
  try {
    await expireStaleOrders();

    const pending = await prisma.order.findMany({
      where: { status: 'PENDING', invoiceUuid: { not: null }, method: { not: 'BINANCE' } },
      orderBy: { createdAt: 'asc' },
      take: 40, // cap work per tick
    });

    if (pending.length) {
      logger.debug({ count: pending.length }, 'poller: reconciling pending orders');
    }
    for (const order of pending) {
      try {
        await reconcileOrder(order);
      } catch (e) {
        logger.warn({ err: e.message, order: order.publicId }, 'poller: reconcile failed');
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, 'poller tick error');
  } finally {
    running = false;
  }
}

export function startPoller() {
  if (!isConfigured()) {
    logger.warn('Cryptomus not configured — payment poller disabled.');
    return;
  }
  const intervalMs = Math.max(15, config.shop.pollIntervalSec) * 1000;
  logger.info({ everySec: intervalMs / 1000 }, 'Starting payment poller');
  timer = setInterval(tick, intervalMs);
  // Kick one off shortly after boot.
  setTimeout(tick, 5000);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
