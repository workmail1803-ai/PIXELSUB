import { bot } from './instance.js';
import logger from '../logger.js';
import { userMiddleware } from './middleware.js';
import { registerHandlers } from './handlers.js';
import { registerAdminHandlers } from './admin.js';
import { registerWalletHandlers } from './wallet.js';

export async function startBot() {
  if (!bot) {
    logger.warn('Bot disabled (no BOT_TOKEN). Skipping bot startup.');
    return null;
  }

  bot.use(userMiddleware);
  // Admin handlers first so in-bot admin input flows take priority over the
  // customer text fallback.
  registerAdminHandlers(bot);
  registerWalletHandlers(bot);
  registerHandlers(bot);

  // Global error boundary so one bad update never crashes the bot.
  bot.catch((err) => {
    logger.error({ err: err.error?.message || err.message, update: err.ctx?.update?.update_id }, 'bot error');
  });

  // Set the command menu shown in the Telegram UI (default: customers).
  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Open the shop' },
      { command: 'shop', description: 'Browse products' },
      { command: 'orders', description: 'My orders' },
      { command: 'help', description: 'Support & help' },
    ])
    .catch((e) => logger.warn({ err: e.message }, 'setMyCommands failed'));

  // Admin-scoped command menu (only visible to configured admins).
  const { adminIds } = (await import('../config.js')).default.telegram;
  for (const id of adminIds) {
    await bot.api
      .setMyCommands(
        [
          { command: 'admin', description: '🛠️ Admin panel' },
          { command: 'start', description: 'Admin panel' },
          { command: 'shop', description: 'Preview shop' },
        ],
        { scope: { type: 'chat', chat_id: Number(id) } }
      )
      .catch(() => {});
  }

  // Long polling — no public webhook needed for Telegram itself.
  bot.start({
    drop_pending_updates: true,
    onStart: (info) => logger.info({ username: info.username }, '🤖 Telegram bot started (long polling)'),
  });

  return bot;
}

export async function stopBot() {
  if (bot) await bot.stop();
}
