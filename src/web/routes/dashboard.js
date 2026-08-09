import express from 'express';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';

const router = express.Router();
router.use(requireAuth);

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// GET /api/dashboard — headline stats + 14-day revenue series + recent orders
router.get('/', async (req, res) => {
  const now = new Date();
  const today = startOfDay(now);
  const since = new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);

  const paidStatuses = ['PAID', 'DELIVERED', 'REFUNDED'];

  const [
    totalUsers,
    newUsersToday,
    totalOrders,
    pendingOrders,
    deliveredOrders,
    revenueAgg,
    revenueTodayAgg,
    productCount,
    lowStockProducts,
    recentOrders,
    paidForSeries,
    topProductsRaw,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: today } } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.order.count({ where: { status: 'DELIVERED' } }),
    prisma.order.aggregate({ _sum: { amount: true }, where: { status: { in: ['PAID', 'DELIVERED'] } } }),
    prisma.order.aggregate({
      _sum: { amount: true },
      where: { status: { in: ['PAID', 'DELIVERED'] }, paidAt: { gte: today } },
    }),
    prisma.product.count({ where: { isActive: true } }),
    prisma.product.findMany({
      where: { isActive: true, usesStock: true },
      select: { id: true, name: true, emoji: true, _count: { select: { stock: { where: { isSold: false } } } } },
    }),
    prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { user: true, items: true },
    }),
    prisma.order.findMany({
      where: { status: { in: ['PAID', 'DELIVERED'] }, paidAt: { gte: since } },
      select: { paidAt: true, amount: true },
    }),
    prisma.orderItem.groupBy({
      by: ['productName', 'emoji'],
      _sum: { quantity: true, lineTotal: true },
      where: { order: { status: { in: ['PAID', 'DELIVERED'] } } },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: 6,
    }),
  ]);

  // Build 14-day revenue + order-count series
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
    days.push({ date: d.toISOString().slice(0, 10), revenue: 0, orders: 0 });
  }
  const idx = new Map(days.map((d, i) => [d.date, i]));
  for (const o of paidForSeries) {
    if (!o.paidAt) continue;
    const key = startOfDay(o.paidAt).toISOString().slice(0, 10);
    const i = idx.get(key);
    if (i !== undefined) {
      days[i].revenue += num(o.amount);
      days[i].orders += 1;
    }
  }

  const lowStock = lowStockProducts
    .map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, stock: p._count.stock }))
    .filter((p) => p.stock <= 3)
    .sort((a, b) => a.stock - b.stock);

  res.json({
    stats: {
      totalUsers,
      newUsersToday,
      totalOrders,
      pendingOrders,
      deliveredOrders,
      revenue: num(revenueAgg._sum.amount),
      revenueToday: num(revenueTodayAgg._sum.amount),
      productCount,
    },
    series: days,
    lowStock,
    topProducts: topProductsRaw.map((t) => ({
      name: t.productName,
      emoji: t.emoji,
      qty: t._sum.quantity || 0,
      revenue: num(t._sum.lineTotal),
    })),
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      publicId: o.publicId,
      status: o.status,
      amount: num(o.amount),
      currency: o.currency,
      createdAt: o.createdAt,
      user: {
        telegramId: o.user.telegramId.toString(),
        username: o.user.username,
        firstName: o.user.firstName,
      },
      summary: o.items.map((i) => `${i.emoji} ${i.productName} ×${i.quantity}`).join(', '),
    })),
  });
});

export default router;
