import os from 'os';
import crypto from 'crypto';
import prisma from '../db.js';
import logger from '../logger.js';

/**
 * Single-writer election.
 *
 * The web server is safe to run in as many processes as the host wants, but the
 * Telegram bot is not: Telegram allows exactly one getUpdates consumer per
 * token, and a second one causes 409 Conflict with updates landing on whichever
 * process wins the race. The payment poller is likewise pointless to run twice.
 *
 * Container hosts run one process and this never matters. Passenger (cPanel
 * "Setup Node.js App") spawns workers on demand, so it matters a great deal —
 * hence a lock that lives in the database rather than in memory.
 *
 * The claim is a compare-and-swap on a Setting row: read the current value,
 * write back only if it is still exactly what we read. That is atomic on both
 * PostgreSQL and SQLite, so two workers starting simultaneously cannot both
 * win. The holder renews a heartbeat; if it dies, the lease expires and another
 * worker takes over.
 */

const LOCK_KEY = 'bot_leader_lock';
const LEASE_MS = 60_000; // a lease older than this is considered abandoned
const RENEW_MS = 20_000; // renew comfortably inside the lease

// Identifies this process specifically, so a restarted worker on the same host
// and pid cannot be mistaken for the previous holder.
const ME = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

let renewTimer = null;
let isLeader = false;
let onLost = null;

function encode(ts) {
  return JSON.stringify({ id: ME, ts });
}

function parse(value) {
  try {
    const v = JSON.parse(value);
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Compare-and-swap the lock row. Returns true if this process now holds it.
 */
async function claim() {
  const now = Date.now();
  const existing = await prisma.setting.findUnique({ where: { key: LOCK_KEY } });

  // Nobody has ever taken it. create() throws on a unique clash, which is
  // exactly the behaviour we want when two workers reach here together.
  if (!existing) {
    try {
      await prisma.setting.create({ data: { key: LOCK_KEY, value: encode(now) } });
      return true;
    } catch {
      return false;
    }
  }

  const held = parse(existing.value);
  const mine = held?.id === ME;
  const expired = !held || now - Number(held.ts || 0) > LEASE_MS;
  if (!mine && !expired) return false;

  // Only write if the row still holds precisely the value we just read.
  // Another worker that got here first changed it, and its update wins.
  const res = await prisma.setting.updateMany({
    where: { key: LOCK_KEY, value: existing.value },
    data: { value: encode(now) },
  });
  return res.count === 1;
}

/**
 * Try to become the single writer. Returns true if this process should run the
 * bot and poller. On failure the caller should still serve HTTP.
 */
export async function acquireLeadership({ onLostLeadership } = {}) {
  onLost = onLostLeadership || null;
  try {
    isLeader = await claim();
  } catch (e) {
    // A lock we cannot read must not take the whole app down. Refusing
    // leadership is the safe direction: worst case nobody polls and the order
    // is picked up on the next boot, rather than two processes fighting.
    logger.warn({ err: e.message }, 'leader election failed — running web only');
    return false;
  }

  if (!isLeader) {
    logger.info({ me: ME }, 'another process holds the bot lock — running web only');
    return false;
  }

  logger.info({ me: ME }, '👑 acquired bot lock — this process runs the bot and poller');
  renewTimer = setInterval(async () => {
    try {
      const still = await claim();
      if (!still && isLeader) {
        isLeader = false;
        logger.error('lost the bot lock — stopping bot and poller in this process');
        if (onLost) await onLost();
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'lock renewal failed — will retry');
    }
  }, RENEW_MS);
  // Never hold the event loop open on account of the heartbeat alone.
  renewTimer.unref?.();
  return true;
}

/** Release on clean shutdown so a replacement starts immediately, not in a minute. */
export async function releaseLeadership() {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  if (!isLeader) return;
  isLeader = false;
  try {
    await prisma.setting.updateMany({
      where: { key: LOCK_KEY },
      data: { value: JSON.stringify({ id: null, ts: 0 }) },
    });
    logger.info('released the bot lock');
  } catch (e) {
    logger.warn({ err: e.message }, 'could not release the bot lock — it will expire');
  }
}

export function holdsLeadership() {
  return isLeader;
}
