import express from 'express';
import prisma from '../../db.js';
import logger from '../../logger.js';
import { verifyWebhookSignature } from '../../payments/cryptomus.js';
import { reconcileOrder } from '../../services/orders.js';

const router = express.Router();

// Cryptomus payment callback. We ALWAYS re-verify the real status via the API
// inside reconcileOrder(), so a spoofed webhook cannot trigger delivery.
router.post('/cryptomus', async (req, res) => {
  const body = req.body || {};
  const sigOk = verifyWebhookSignature(body);
  if (!sigOk) {
    logger.warn({ order_id: body.order_id, uuid: body.uuid }, 'webhook signature check failed (will still verify via API)');
  }

  // Ack fast so Cryptomus doesn't retry storm; do the work but keep it quick.
  try {
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          body.order_id ? { invoiceOrderId: String(body.order_id) } : undefined,
          body.uuid ? { invoiceUuid: String(body.uuid) } : undefined,
        ].filter(Boolean),
      },
    });

    if (!order) {
      logger.warn({ order_id: body.order_id, uuid: body.uuid }, 'webhook: order not found');
      return res.status(200).json({ ok: true, note: 'order not found' });
    }

    // Authoritative re-check + deliver if paid.
    const status = await reconcileOrder(order);
    logger.info({ order: order.publicId, status }, 'webhook processed');
    return res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'webhook processing error');
    // Return 200 anyway; the poller will catch it on the next tick.
    return res.status(200).json({ ok: true, note: 'deferred to poller' });
  }
});

export default router;
