import { Bot } from 'grammy';
import config from '../config.js';
import logger from '../logger.js';

// Create the bot only if a token is configured, so the web/admin panel can
// still boot (and be used to configure things) even without a bot token.
export const bot = config.telegram.token ? new Bot(config.telegram.token) : null;

if (!bot) {
  logger.warn('BOT_TOKEN is not set — Telegram bot is disabled until you configure it.');
}

export function isAdminTelegramId(id) {
  return config.telegram.adminIds.includes(String(id));
}
