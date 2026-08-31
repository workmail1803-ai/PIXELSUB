/**
 * Dump every table to a JSON file, from whatever DATABASE_URL points at.
 *
 *   node scripts/export-backup.mjs ./backup.json
 *
 * Pair with import-backup.mjs to move between hosts. BigInt is written as a
 * "123n" string so Telegram ids survive JSON, and Decimal comes back as a
 * number, which is what Prisma accepts on the way back in.
 */
import prisma from '../src/db.js';
import fs from 'fs';

const out = process.argv[2] || `./backup-${new Date().toISOString().slice(0, 10)}.json`;
const TABLES = ['category','product','user','order','orderItem','stockItem','orderEvent','setting','adminAccount','broadcast','creditRequest'];

const data = {};
for (const t of TABLES) {
  data[t] = await prisma[t].findMany();
  console.log(`  ${t.padEnd(14)} ${data[t].length}`);
}
fs.writeFileSync(out, JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)));
console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
await prisma.$disconnect();
