import config from './config.js';
import logger from './logger.js';
import prisma from './db.js';
import { startServer } from './web/server.js';
import { startBot, stopBot } from './bot/index.js';
import { startPoller, stopPoller } from './payments/poller.js';
import { verifyAccountMatchesPayId } from './payments/binance.js';
import { ensureDefaults } from './services/settings.js';
import { ensureBootstrapAdmin } from './web/auth.js';
import { acquireLeadership, releaseLeadership } from './services/leader.js';

async function main() {
  logger.info({ env: config.env, publicUrl: config.publicUrl }, '🚀 Booting TeleBot Shop');

  if (config.missing.length) {
    logger.warn({ missing: config.missing }, '⚠️ Some environment variables are missing. Configure them for full functionality.');
  }

  // DB connectivity check
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
  } catch (e) {
    logger.error({ err: e.message }, '❌ Database connection failed. Check DATABASE_URL and that migrations ran.');
    process.exit(1);
  }

  // Seed defaults + bootstrap admin
  await ensureDefaults();
  await ensureBootstrapAdmin();

  // Web server + admin panel + webhook (start first so health checks pass)
  await startServer();

  // Telegram allows a single getUpdates consumer per token, so the bot and the
  // poller run in exactly one process. On a container host that is always this
  // one; under Passenger (cPanel) other workers serve HTTP only.
  const leader = await acquireLeadership({
    onLostLeadership: async () => {
      stopPoller();
      await stopBot().catch(() => {});
    },
  });

  if (leader) {
    await startBot();
    startPoller();
  } else {
    logger.info('running as a web-only worker (bot and poller are held elsewhere)');
  }

  // Confirm the advertised Binance ID is the account our API keys can read.
  // Deliberately not awaited into the boot path — a slow exchange must never
  // delay the health check.
  verifyAccountMatchesPayId().catch(() => {});

  logger.info('🎉 TeleBot Shop is up and running');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down…');
  try {
    stopPoller();
    await stopBot();
    await releaseLeadership();
    await prisma.$disconnect();
  } catch (e) {
    logger.warn({ err: e.message }, 'error during shutdown');
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err: err.message }, 'uncaughtException'));

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, 'fatal boot error');
  process.exit(1);
});
