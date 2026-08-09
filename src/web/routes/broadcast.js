import express from 'express';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import logger from '../../logger.js';
import { sendMessageSafe } from '../../bot/delivery.js';
import { sleep } from '../../utils.js';

const router = express.Router();
router.use(requireAuth);

let inProgress = false;
let lastResult = null;

// Fire-and-forget broadcast to all non-banned users. Runs in the background,
// throttled to stay within Telegram's ~30 msg/sec limit.
router.post('/', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (inProgress) return res.status(409).json({ error: 'A broadcast is already running' });

  const users = await prisma.user.findMany({
    where: { isBanned: false },
    select: { telegramId: true },
  });

  const record = await prisma.broadcast.create({ data: { text, sentCount: 0, failCount: 0 } });

  // Respond immediately; process in background.
  res.json({ ok: true, broadcastId: record.id, recipients: users.length });

  inProgress = true;
  lastResult = { id: record.id, total: users.length, sent: 0, failed: 0, done: false };

  (async () => {
    let sent = 0;
    let failed = 0;
    for (const u of users) {
      const r = await sendMessageSafe(u.telegramId, text);
      if (r.ok) sent++;
      else failed++;
      lastResult.sent = sent;
      lastResult.failed = failed;
      // ~25 msgs/sec
      await sleep(40);
    }
    await prisma.broadcast.update({ where: { id: record.id }, data: { sentCount: sent, failCount: failed } });
    lastResult.done = true;
    inProgress = false;
    logger.info({ sent, failed }, 'broadcast finished');
  })().catch((e) => {
    inProgress = false;
    logger.error({ err: e.message }, 'broadcast failed');
  });
});

router.get('/status', (req, res) => {
  res.json({ inProgress, lastResult });
});

router.get('/history', async (req, res) => {
  const items = await prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  res.json({ items });
});

export default router;
