/**
 * Load a dump produced by export-backup.mjs into whatever DATABASE_URL points at.
 *
 *   node scripts/import-backup.mjs ./backup.json
 *
 * Rows keep their original ids so every foreign key survives, which on
 * PostgreSQL leaves the identity sequences at 1 — the next real order would
 * collide. They are fast-forwarded at the end. Safe to re-run: inserts skip
 * duplicates.
 */
import prisma from '../src/db.js';
import config from '../src/config.js';
import fs from 'fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/import-backup.mjs <backup.json>');
  process.exit(1);
}

// "123n" -> BigInt, and ISO date strings back into Date objects.
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const revive = (k, v) => {
  if (typeof v === 'string' && /^\d+n$/.test(v)) return BigInt(v.slice(0, -1));
  if (typeof v === 'string' && ISO.test(v)) return new Date(v);
  return v;
};

const data = JSON.parse(fs.readFileSync(file, 'utf8'), revive);

// Parents before children so foreign keys always resolve.
const ORDER = ['category','product','user','order','orderItem','stockItem','orderEvent','setting','adminAccount','broadcast','creditRequest'];
const SEQ = { category:'Category', product:'Product', user:'User', order:'Order', orderItem:'OrderItem', stockItem:'StockItem', orderEvent:'OrderEvent', adminAccount:'AdminAccount', broadcast:'Broadcast', creditRequest:'CreditRequest' };

console.log(`source file : ${file}`);
console.log(`target      : ${String(config.database.url).replace(/:\/\/[^@]*@/, '://***@')}\n`);

const counts = [];
for (const t of ORDER) {
  const rows = data[t] || [];
  if (!rows.length) { counts.push([t, 0]); continue; }
  // createMany with skipDuplicates is unsupported on SQLite; fall back per row.
  let wrote = 0;
  try {
    const res = await prisma[t].createMany({ data: rows, skipDuplicates: true });
    wrote = res.count;
  } catch {
    for (const r of rows) {
      try { await prisma[t].create({ data: r }); wrote++; } catch { /* already there */ }
    }
  }
  counts.push([t, rows.length, wrote]);
  console.log(`  ${t.padEnd(14)} read ${String(rows.length).padStart(5)}  wrote ${String(wrote).padStart(5)}`);
}

// Explicit ids were inserted, so identity sequences still start at 1.
if (!/^file:/.test(String(config.database.url))) {
  console.log('\nfast-forwarding id sequences…');
  for (const [model, table] of Object.entries(SEQ)) {
    if (!(data[model] || []).length) continue;
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    );
  }
  console.log('  done');
}

console.log('\nverifying against the target:');
let bad = 0;
for (const [t, expected] of counts) {
  const actual = await prisma[t].count();
  const ok = actual >= expected;
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${t.padEnd(14)} source ${String(expected).padStart(5)}  target ${String(actual).padStart(5)}`);
}
console.log(bad === 0 ? '\nIMPORT OK' : `\n${bad} TABLE(S) SHORT — review above`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
