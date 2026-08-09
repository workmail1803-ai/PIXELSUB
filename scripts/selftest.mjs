/**
 * End-to-end self-test of the shop's business logic.
 *
 *   node scripts/selftest.mjs
 *
 * Drives the real service functions against the real database, then removes
 * everything it created. Test rows are prefixed __TEST__ and the test customer
 * uses a telegram id that does not exist, so delivery messages fail harmlessly
 * instead of DMing a real person.
 *
 * Deliberately avoids the out-of-stock-at-delivery path: that one pings every
 * configured admin, and a self-test should not set off real notifications.
 */
import prisma from '../src/db.js';
import {
  availableStock,
  createOrder,
  createBinanceOrder,
  createBinanceTopUpOrder,
  approveBinancePayment,
  declineBinancePayment,
  payWithBalance,
  redeliverOrder,
  expireStaleOrders,
} from '../src/services/orders.js';

const TAG = '__TEST__';
const FAKE_TG = 990000000001n; // no such Telegram account -> sends fail safely

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label + (detail ? ` (${detail})` : ''));
    console.log(`  FAIL  ${label}${detail ? '  → ' + detail : ''}`);
  }
}

// Telegram rejecting a synthetic/blocked chat is an environment fact, not a
// defect — distinguish it from a genuine logic failure.
function isUnreachableChat(e) {
  return /chat not found|bot was blocked|user is deactivated|chat_id is empty/i.test(e?.message || '');
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 46 - name.length))}`);
}

const created = { productIds: [], userIds: [], orderIds: [] };

async function makeProduct(stockCount, price = 5) {
  const p = await prisma.product.create({
    data: { name: `${TAG}Product`, emoji: '🧪', price, description: 'self-test', usesStock: true },
  });
  created.productIds.push(p.id);
  if (stockCount > 0) {
    await prisma.stockItem.createMany({
      data: Array.from({ length: stockCount }, (_, i) => ({
        productId: p.id,
        content: `${TAG}CODE-${p.id}-${i + 1}`,
      })),
    });
  }
  return p;
}

async function makeUser(balance = 0) {
  const u = await prisma.user.create({
    data: { telegramId: FAKE_TG + BigInt(created.userIds.length), username: TAG + 'buyer', firstName: 'Test', balance },
  });
  created.userIds.push(u.id);
  return u;
}

const n = (d) => (d && typeof d.toNumber === 'function' ? d.toNumber() : Number(d));

async function run() {
  // ───────────────────────────────────────── stock accounting
  section('Stock accounting');
  const p1 = await makeProduct(3);
  check('availableStock counts unsold items', (await availableStock(p1.id)) === 3);

  // ───────────────────────────────────────── wallet checkout (happy path)
  section('Wallet checkout — happy path');
  const buyer = await makeUser(100);
  const res = await payWithBalance({ user: buyer, product: p1, quantity: 2 });
  created.orderIds.push(res.order?.id ?? res.id);

  const order = await prisma.order.findFirst({
    where: { userId: buyer.id },
    include: { items: { include: { stock: true } }, events: true },
    orderBy: { id: 'desc' },
  });
  check('order reached DELIVERED', order.status === 'DELIVERED', order.status);
  check('method recorded as BALANCE', order.method === 'BALANCE', order.method);
  check('charged unit price x qty', n(order.amount) === 10, `got ${n(order.amount)}`);
  check('2 stock items attached to the order', order.items[0].stock.length === 2);
  check('delivered codes are readable', order.items[0].stock.every((s) => s.content.startsWith(TAG)));

  const afterBuy = await prisma.user.findUnique({ where: { id: buyer.id } });
  check('balance deducted', n(afterBuy.balance) === 90, `got ${n(afterBuy.balance)}`);
  check('totalSpent incremented', n(afterBuy.totalSpent) === 10, `got ${n(afterBuy.totalSpent)}`);
  check('remaining stock is 1', (await availableStock(p1.id)) === 1);
  check('sold items flagged isSold', (await prisma.stockItem.count({ where: { productId: p1.id, isSold: true } })) === 2);
  check('audit trail written', order.events.length > 0, `${order.events.length} events`);

  // ───────────────────────────────────────── guard rails
  section('Guard rails');
  let threw = null;
  try {
    await payWithBalance({ user: afterBuy, product: p1, quantity: 5 });
  } catch (e) { threw = e; }
  check('rejects order larger than stock', threw?.code === 'OUT_OF_STOCK', threw?.code || 'no error thrown');
  const balAfterOOS = await prisma.user.findUnique({ where: { id: buyer.id } });
  check('balance untouched after stock rejection', n(balAfterOOS.balance) === 90, `got ${n(balAfterOOS.balance)}`);

  const poorUser = await makeUser(1);
  threw = null;
  try {
    await payWithBalance({ user: poorUser, product: p1, quantity: 1 });
  } catch (e) { threw = e; }
  check('rejects purchase above balance', threw?.code === 'INSUFFICIENT_BALANCE', threw?.code || 'no error thrown');
  const poorAfter = await prisma.user.findUnique({ where: { id: poorUser.id } });
  check('balance untouched after funds rejection', n(poorAfter.balance) === 1, `got ${n(poorAfter.balance)}`);
  check('stock untouched after both rejections', (await availableStock(p1.id)) === 1);

  // ───────────────────────────────────────── binance manual flow
  section('Binance manual approval');
  const p2 = await makeProduct(4, 8);
  const bUser = await makeUser(0);
  const bin = await createBinanceOrder({ user: bUser, product: p2, quantity: 1 });
  const binOrder = bin.order || bin;
  created.orderIds.push(binOrder.id);
  check('binance order starts PENDING', binOrder.status === 'PENDING', binOrder.status);
  check('binance order method is BINANCE', binOrder.method === 'BINANCE', binOrder.method);
  check('no stock claimed before approval', (await availableStock(p2.id)) === 4);

  await approveBinancePayment(binOrder.id);
  const binDone = await prisma.order.findUnique({ where: { id: binOrder.id }, include: { items: { include: { stock: true } } } });
  check('approval delivers the order', binDone.status === 'DELIVERED', binDone.status);
  check('approval claims stock', (await availableStock(p2.id)) === 3);
  check('approved order carries its code', binDone.items[0].stock.length === 1);

  const bin2 = await createBinanceOrder({ user: bUser, product: p2, quantity: 1 });
  const bin2Order = bin2.order || bin2;
  created.orderIds.push(bin2Order.id);
  await declineBinancePayment(bin2Order.id);
  const declined = await prisma.order.findUnique({ where: { id: bin2Order.id } });
  check('decline marks order FAILED', declined.status === 'FAILED', declined.status);
  check('decline releases no stock', (await availableStock(p2.id)) === 3);

  // ───────────────────────────────────────── wallet top-up
  section('Wallet top-up');
  const topUser = await makeUser(0);
  const top = await createBinanceTopUpOrder({ user: topUser, amount: 25 });
  const topOrder = top.order || top;
  created.orderIds.push(topOrder.id);
  check('top-up order kind is TOPUP', topOrder.kind === 'TOPUP', topOrder.kind);
  await approveBinancePayment(topOrder.id);
  const topAfter = await prisma.user.findUnique({ where: { id: topUser.id } });
  check('approved top-up credits the wallet', n(topAfter.balance) === 25, `got ${n(topAfter.balance)}`);

  // ───────────────────────────────────────── re-delivery
  section('Re-delivery');
  // The test customer is a synthetic Telegram id, so the final send always
  // fails with "chat not found". That is the correct production behaviour for
  // an unreachable customer (blocked bot / deleted account) and the admin
  // handler surfaces it — so only a NON-send error means something is broken.
  let redeliverErr = null;
  try {
    await redeliverOrder(order.id);
  } catch (e) { redeliverErr = e; }
  check('re-deliver has no logic error', !redeliverErr || isUnreachableChat(redeliverErr), redeliverErr?.message);
  check('re-deliver does not double-claim stock', (await availableStock(p1.id)) === 1);

  // ───────────────────────────────────────── expiry sweep
  section('Expiry sweep');
  const stale = await prisma.order.create({
    data: {
      publicId: `${TAG}STALE`, userId: buyer.id, status: 'PENDING', method: 'CRYPTOMUS',
      kind: 'PURCHASE', amount: 5, currency: 'USD',
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  created.orderIds.push(stale.id);
  await expireStaleOrders();
  const staleAfter = await prisma.order.findUnique({ where: { id: stale.id } });
  check('past-due pending order is expired', staleAfter.status === 'EXPIRED', staleAfter.status);

  // ───────────────────────────────────────── admin dashboard queries
  section('Admin orders dashboard');
  const FILTERS = {
    all: {}, pen: { status: 'PENDING' }, pay: { status: 'PAID' }, dlv: { status: 'DELIVERED' },
    bad: { status: { in: ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] } },
  };
  for (const [key, where] of Object.entries(FILTERS)) {
    let ok = true;
    try {
      await prisma.order.count({ where });
      await prisma.order.aggregate({ _sum: { amount: true }, where });
      await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: 0, take: 8, include: { user: true } });
    } catch { ok = false; }
    check(`filter "${key}" query runs`, ok);
  }
  const detail = await prisma.order.findUnique({
    where: { id: order.id },
    include: { user: true, items: { include: { stock: true } }, events: { select: { id: true } } },
  });
  check('order detail loads all relations', !!(detail.user && detail.items.length && detail.events));

  // ───────────────────────────────────────── delete product with history
  section('Delete product that has sales');
  const soldBefore = await prisma.stockItem.count({ where: { productId: p1.id, isSold: true } });
  const removed = await prisma.stockItem.deleteMany({ where: { productId: p1.id, isSold: false } });
  await prisma.product.delete({ where: { id: p1.id } });
  created.productIds = created.productIds.filter((id) => id !== p1.id);

  const histOrder = await prisma.order.findUnique({
    where: { id: order.id },
    include: { items: { include: { stock: true, product: true } } },
  });
  check('product row deleted', (await prisma.product.findUnique({ where: { id: p1.id } })) === null);
  check('unsold stock destroyed', removed.count === 1, `removed ${removed.count}`);
  check('order line survives deletion', !!histOrder.items[0]);
  check('productId nulled, relation safe', histOrder.items[0].productId === null && histOrder.items[0].product === null);
  check('name/price snapshot intact', histOrder.items[0].productName === `${TAG}Product` && n(histOrder.items[0].lineTotal) === 10);
  check('delivered codes survive deletion', histOrder.items[0].stock.length === soldBefore);

  // The real risk here is a null-product crash, not the (expected) send failure.
  let redeliverAfterDelete = null;
  try {
    await redeliverOrder(order.id);
  } catch (e) { redeliverAfterDelete = e; }
  check(
    're-deliver survives a deleted product (no null crash)',
    !redeliverAfterDelete || isUnreachableChat(redeliverAfterDelete),
    redeliverAfterDelete?.message
  );
}

async function cleanup() {
  section('Cleanup');
  await prisma.orderEvent.deleteMany({ where: { order: { user: { username: TAG + 'buyer' } } } }).catch(() => {});
  await prisma.stockItem.deleteMany({ where: { content: { startsWith: TAG } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { userId: { in: created.userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } }).catch(() => {});
  await prisma.product.deleteMany({ where: { id: { in: created.productIds } } }).catch(() => {});

  const leftovers =
    (await prisma.product.count({ where: { name: { startsWith: TAG } } })) +
    (await prisma.user.count({ where: { username: { startsWith: TAG } } })) +
    (await prisma.stockItem.count({ where: { content: { startsWith: TAG } } }));
  check('all test data removed', leftovers === 0, `${leftovers} rows left`);
}

console.log('TeleBot Shop — self-test\n');
run()
  .catch((e) => {
    fail++;
    failures.push('suite crashed: ' + e.message);
    console.error('\n  SUITE ERROR:', e.message, '\n', e.stack);
  })
  .then(cleanup)
  .catch(() => {})
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  ${pass} passed · ${fail} failed`);
    if (failures.length) {
      console.log('\n  Failures:');
      for (const f of failures) console.log('   ✗ ' + f);
    }
    console.log('═'.repeat(50));
    process.exit(fail === 0 ? 0 : 1);
  });
