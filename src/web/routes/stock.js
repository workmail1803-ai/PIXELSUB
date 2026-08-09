import express from 'express';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';

const router = express.Router();
router.use(requireAuth);

// List stock for a product (optionally only unsold)
router.get('/product/:productId', async (req, res) => {
  const productId = Number(req.params.productId);
  const onlyUnsold = req.query.unsold === '1';
  const items = await prisma.stockItem.findMany({
    where: { productId, ...(onlyUnsold ? { isSold: false } : {}) },
    orderBy: [{ isSold: 'asc' }, { id: 'desc' }],
    take: 500,
  });
  const [available, sold] = await Promise.all([
    prisma.stockItem.count({ where: { productId, isSold: false } }),
    prisma.stockItem.count({ where: { productId, isSold: true } }),
  ]);
  res.json({ items, available, sold });
});

// Bulk add stock: one item per non-empty line
router.post('/product/:productId', async (req, res) => {
  const productId = Number(req.params.productId);
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const raw = String(req.body?.content ?? '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length) return res.status(400).json({ error: 'No stock lines provided' });

  const result = await prisma.stockItem.createMany({
    data: lines.map((content) => ({ productId, content })),
  });
  const available = await prisma.stockItem.count({ where: { productId, isSold: false } });
  res.json({ ok: true, added: result.count, available });
});

// Delete a single (unsold) stock item
router.delete('/:id', async (req, res) => {
  const item = await prisma.stockItem.findUnique({ where: { id: Number(req.params.id) } });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.isSold) return res.status(400).json({ error: 'Cannot delete a sold item' });
  await prisma.stockItem.delete({ where: { id: item.id } });
  res.json({ ok: true });
});

// Clear all unsold stock for a product
router.delete('/product/:productId/clear', async (req, res) => {
  const productId = Number(req.params.productId);
  const result = await prisma.stockItem.deleteMany({ where: { productId, isSold: false } });
  res.json({ ok: true, deleted: result.count });
});

export default router;
