/**
 * One-way data copy: local SQLite (prisma/dev.db) -> Railway PostgreSQL.
 *
 *   node scripts/migrate-to-postgres.mjs "postgresql://user:pass@host:port/db"
 *
 * Reads through the normal client (SQLite, per DB_PROVIDER in .env) and writes
 * through a second client generated separately into prisma/generated-pg, so the
 * running local instance never has its client swapped out from under it.
 *
 * Rows keep their original ids to preserve every foreign key, which means the
 * Postgres identity sequences must be bumped afterwards — otherwise the next
 * insert would start at 1 and collide. That happens at the end.
 *
 * Safe to re-run: every insert uses skipDuplicates.
 */
import { PrismaClient as SqliteClient } from '@prisma/client';
import pg from '../prisma/generated-pg/index.js';

const { PrismaClient: PostgresClient } = pg;

const target = process.argv[2] || process.env.TARGET_DATABASE_URL;
if (!target || !target.startsWith('postgres')) {
  console.error('Usage: node scripts/migrate-to-postgres.mjs "postgresql://..."');
  process.exit(1);
}

const src = new SqliteClient();
const dst = new PostgresClient({ datasources: { db: { url: target } } });

// Parent-before-child so foreign keys always resolve.
const TABLES = [
  'category',
  'product',
  'user',
  'order',
  'orderItem',
  'stockItem',
  'orderEvent',
  'setting',
  'adminAccount',
  'broadcast',
  'creditRequest',
];

// Prisma model name -> actual Postgres table name (for sequence bumping).
// `setting` is keyed by a string, so it has no sequence.
const SEQUENCE_TABLES = {
  category: 'Category',
  product: 'Product',
  user: 'User',
  order: 'Order',
  orderItem: 'OrderItem',
  stockItem: 'StockItem',
  orderEvent: 'OrderEvent',
  adminAccount: 'AdminAccount',
  broadcast: 'Broadcast',
  creditRequest: 'CreditRequest',
};

const VALID_STATUS = new Set(['PENDING', 'PAID', 'DELIVERED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'FAILED']);
const VALID_METHOD = new Set(['CRYPTOMUS', 'BINANCE', 'BALANCE']);

const warnings = [];

// SQLite stores status/method as free-text; Postgres enforces them as enums.
// Catch any stray value here rather than eating an opaque insert error.
function checkOrder(row) {
  if (!VALID_STATUS.has(row.status)) {
    warnings.push(`order ${row.publicId}: unknown status "${row.status}" -> FAILED`);
    row.status = 'FAILED';
  }
  if (!VALID_METHOD.has(row.method)) {
    warnings.push(`order ${row.publicId}: unknown method "${row.method}" -> CRYPTOMUS`);
    row.method = 'CRYPTOMUS';
  }
  return row;
}

async function main() {
  console.log('source : local SQLite');
  console.log('target : ' + target.replace(/:\/\/[^@]*@/, '://***@') + '\n');

  await dst.$connect();

  const results = [];
  for (const table of TABLES) {
    const rows = await src[table].findMany();
    if (!rows.length) {
      results.push([table, 0, 0]);
      continue;
    }

    const data = table === 'order' ? rows.map(checkOrder) : rows;
    const res = await dst[table].createMany({ data, skipDuplicates: true });
    results.push([table, rows.length, res.count]);
    console.log(`  ${table.padEnd(14)} read ${String(rows.length).padStart(4)}  wrote ${String(res.count).padStart(4)}`);
  }

  // Explicit ids were inserted, so each identity sequence is still at 1.
  // Fast-forward every one to max(id) or the next insert collides immediately.
  console.log('\nresetting id sequences…');
  for (const [model, tableName] of Object.entries(SEQUENCE_TABLES)) {
    const count = results.find((r) => r[0] === model)?.[1] || 0;
    if (!count) continue;
    await dst.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${tableName}"', 'id'),
         COALESCE((SELECT MAX(id) FROM "${tableName}"), 0) + 1, false)`
    );
    console.log(`  ${tableName} sequence -> next after max(id)`);
  }

  // Read back from the target so the summary reflects Postgres, not intent.
  console.log('\nverifying target row counts:');
  let mismatch = 0;
  for (const [table, readCount] of results) {
    const actual = await dst[table].count();
    const ok = actual >= readCount;
    if (!ok) mismatch++;
    console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${table.padEnd(14)} source ${String(readCount).padStart(4)}  target ${String(actual).padStart(4)}`);
  }

  if (warnings.length) {
    console.log('\nwarnings:');
    for (const w of warnings) console.log('  ! ' + w);
  }
  console.log(mismatch === 0 ? '\nMIGRATION OK' : `\n${mismatch} TABLE(S) SHORT — review above`);
}

main()
  .catch((e) => {
    console.error('\nMIGRATION FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await src.$disconnect().catch(() => {});
    await dst.$disconnect().catch(() => {});
  });
