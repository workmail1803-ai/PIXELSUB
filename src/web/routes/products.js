import express from 'express';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';

const router = express.Router();
router.use(requireAuth);

function serializeProduct(p) {
  return {
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    price: num(p.price),
    cost: num(p.cost),
    categoryId: p.categoryId,
    category: p.category ? { id: p.category.id, name: p.category.name, emoji: p.category.emoji } : null,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
    usesStock: p.usesStock,
    fixedContent: p.fixedContent,
    stock: p._count ? p._count.stock : undefined,
    createdAt: p.createdAt,
  };
}

// List all products with available-stock counts
router.get('/', async (req, res) => {
  const products = await prisma.product.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: {
      category: true,
      _count: { select: { stock: { where: { isSold: false } } } },
    },
  });
  res.json({ products: products.map(serializeProduct) });
});

router.get('/:id', async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: Number(req.params.id) },
    include: { category: true, _count: { select: { stock: { where: { isSold: false } } } } },
  });
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json({ product: serializeProduct(product) });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name || b.price == null) return res.status(400).json({ error: 'name and price are required' });
  const product = await prisma.product.create({
    data: {
      name: String(b.name).slice(0, 200),
      emoji: b.emoji || '🛍️',
      description: b.description || '',
      price: Number(b.price),
      cost: Number(b.cost) || 0,
      categoryId: b.categoryId ? Number(b.categoryId) : null,
      isActive: b.isActive !== false,
      sortOrder: Number(b.sortOrder) || 0,
      usesStock: b.usesStock !== false,
      fixedContent: b.fixedContent || '',
    },
    include: { category: true, _count: { select: { stock: { where: { isSold: false } } } } },
  });
  res.json({ product: serializeProduct(product) });
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = String(b.name).slice(0, 200);
  if (b.emoji !== undefined) data.emoji = b.emoji;
  if (b.description !== undefined) data.description = b.description;
  if (b.price !== undefined) data.price = Number(b.price);
  if (b.cost !== undefined) data.cost = Number(b.cost) || 0;
  if (b.categoryId !== undefined) data.categoryId = b.categoryId ? Number(b.categoryId) : null;
  if (b.isActive !== undefined) data.isActive = Boolean(b.isActive);
  if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder) || 0;
  if (b.usesStock !== undefined) data.usesStock = Boolean(b.usesStock);
  if (b.fixedContent !== undefined) data.fixedContent = b.fixedContent;

  try {
    const product = await prisma.product.update({
      where: { id: Number(req.params.id) },
      data,
      include: { category: true, _count: { select: { stock: { where: { isSold: false } } } } },
    });
    res.json({ product: serializeProduct(product) });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    // Block delete if the product has orders (preserve history); soft-disable instead.
    const orderItems = await prisma.orderItem.count({ where: { productId: Number(req.params.id) } });
    if (orderItems > 0) {
      const product = await prisma.product.update({
        where: { id: Number(req.params.id) },
        data: { isActive: false },
      });
      return res.json({ ok: true, softDeleted: true, note: 'Product has order history; deactivated instead of deleted.' });
    }
    await prisma.product.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// -------- Categories --------
router.get('/meta/categories', async (req, res) => {
  const categories = await prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  res.json({ categories });
});

router.post('/meta/categories', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const category = await prisma.category.create({
    data: { name: b.name, emoji: b.emoji || '📦', sortOrder: Number(b.sortOrder) || 0 },
  });
  res.json({ category });
});

router.delete('/meta/categories/:id', async (req, res) => {
  try {
    await prisma.category.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
