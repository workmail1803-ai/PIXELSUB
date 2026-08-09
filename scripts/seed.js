// Seed the catalog shown in the reference screenshot.
// Usage:
//   node scripts/seed.js                 -> products only (safe; add real stock in admin)
//   node scripts/seed.js --with-demo-stock  -> also add placeholder stock (DEMO ONLY)
import prisma from '../src/db.js';
import { ensureDefaults } from '../src/services/settings.js';
import { ensureBootstrapAdmin } from '../src/web/auth.js';

const withDemoStock = process.argv.includes('--with-demo-stock');

const CATALOG = [
  { name: 'CapCut Pro 1 Month (Shared)', emoji: '✂️', price: 2.3, demoStock: 12 },
  { name: 'CapCut Pro 6 Months (Individual)', emoji: '👑', price: 12.0, demoStock: 8 },
  { name: 'Grok Premium 1 Month', emoji: '🤖', price: 7.0, demoStock: 6 },
  { name: 'Gemini Advanced 1 Year', emoji: '💎', price: 5.0, demoStock: 7 },
  { name: 'ChatGPT Plus 1 Month', emoji: '💬', price: 4.0, demoStock: 15 },
  { name: 'Canva EDU Owner (500 Members)', emoji: '🎨', price: 9.0, demoStock: 5 },
  { name: 'Spotify Premium 1 Month', emoji: '🟢', price: 1.7, demoStock: 20 },
  { name: 'Prime Video Premium 1 Month', emoji: '🎬', price: 1.2, demoStock: 18 },
  { name: 'Veo3 Ultra 1 Month', emoji: '✨', price: 4.0, demoStock: 6 },
];

async function main() {
  console.log('Seeding defaults & admin…');
  await ensureDefaults();
  await ensureBootstrapAdmin();

  let sort = 0;
  for (const item of CATALOG) {
    sort += 1;
    const existing = await prisma.product.findFirst({ where: { name: item.name } });
    let product;
    if (existing) {
      product = await prisma.product.update({
        where: { id: existing.id },
        data: { emoji: item.emoji, price: item.price, sortOrder: sort, isActive: true },
      });
      console.log(`↺ updated: ${item.emoji} ${item.name}`);
    } else {
      product = await prisma.product.create({
        data: {
          name: item.name,
          emoji: item.emoji,
          price: item.price,
          sortOrder: sort,
          usesStock: true,
          description: `Premium ${item.name}. Instant automatic delivery after crypto payment.`,
        },
      });
      console.log(`＋ created: ${item.emoji} ${item.name}`);
    }

    if (withDemoStock) {
      const have = await prisma.stockItem.count({ where: { productId: product.id, isSold: false } });
      const need = Math.max(0, item.demoStock - have);
      if (need > 0) {
        await prisma.stockItem.createMany({
          data: Array.from({ length: need }, (_, i) => ({
            productId: product.id,
            content: `DEMO-${product.id}-${have + i + 1} — REPLACE THIS in the admin panel before going live`,
          })),
        });
        console.log(`   + ${need} DEMO stock item(s)`);
      }
    }
  }

  console.log('\n✅ Seed complete.');
  if (withDemoStock) {
    console.log('⚠️  DEMO stock was added. DELETE and replace it with real codes in the admin panel BEFORE accepting payments!');
  } else {
    console.log('ℹ️  No stock added. Add real stock per product in the admin panel (Products → Manage Stock).');
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Seed failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
