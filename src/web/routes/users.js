import express from 'express';
import prisma from '../../db.js';
import config from '../../config.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';
import { sendMessageSafe } from '../../bot/delivery.js';
import { escapeHtml } from '../../utils.js';

const router = express.Router();
router.use(requireAuth);

function serializeUser(u) {
  return {
    id: u.id,
    telegramId: u.telegramId.toString(),
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    balance: num(u.balance),
    totalSpent: num(u.totalSpent),
    isBanned: u.isBanned,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    orders: u._count ? u._count.orders : undefined,
  };
}

router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const search = (req.query.search || '').toString().trim();

  const where = {};
  if (search) {
    const M = config.database.searchMode;
    where.OR = [{ username: { contains: search, mode: M } }, { firstName: { contains: search, mode: M } }];
    if (/^\d+$/.test(search)) where.OR.push({ telegramId: BigInt(search) });
  }

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { orders: true } } },
    }),
  ]);

  res.json({ total, page, pageSize, pages: Math.ceil(total / pageSize), users: users.map(serializeUser) });
});

router.get('/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.params.id) },
    include: {
      _count: { select: { orders: true } },
      orders: { orderBy: { createdAt: 'desc' }, take: 20, include: { items: true } },
    },
  });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({
    user: serializeUser(user),
    orders: user.orders.map((o) => ({
      id: o.id,
      publicId: o.publicId,
      status: o.status,
      amount: num(o.amount),
      currency: o.currency,
      createdAt: o.createdAt,
      summary: o.items.map((i) => `${i.emoji} ${i.productName} ×${i.quantity}`).join(', '),
    })),
  });
});

router.post('/:id/ban', async (req, res) => {
  const banned = req.body?.banned !== false;
  try {
    const user = await prisma.user.update({ where: { id: Number(req.params.id) }, data: { isBanned: banned } });
    res.json({ ok: true, isBanned: user.isBanned });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Adjust balance (store credit). delta can be negative.
router.post('/:id/balance', async (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta must be a number' });
  try {
    const user = await prisma.user.update({
      where: { id: Number(req.params.id) },
      data: { balance: { increment: delta } },
    });
    res.json({ ok: true, balance: num(user.balance) });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Send a direct message to a single user
router.post('/:id/message', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  const result = await sendMessageSafe(user.telegramId, `💬 <b>Message from support</b>\n\n${escapeHtml(text)}`);
  res.json(result);
});

export default router;
