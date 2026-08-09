import prisma from '../db.js';
import { isAdminTelegramId } from './instance.js';
import { getSetting } from '../services/settings.js';

// Upsert the Telegram user, attach ctx.dbUser, enforce bans + maintenance mode.
export async function userMiddleware(ctx, next) {
  const from = ctx.from;
  if (!from || from.is_bot) return; // ignore bots / service updates without a user

  const telegramId = BigInt(from.id);
  const isAdmin = isAdminTelegramId(from.id);

  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
      languageCode: from.language_code || null,
      lastSeenAt: new Date(),
      isAdmin,
    },
    create: {
      telegramId,
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
      languageCode: from.language_code || null,
      isAdmin,
    },
  });

  ctx.dbUser = user;
  ctx.isAdmin = isAdmin;

  if (user.isBanned) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'You are blocked from using this bot.', show_alert: true }).catch(() => {});
    else await ctx.reply('⛔ You have been blocked from using this bot.').catch(() => {});
    return;
  }

  // Maintenance mode (admins bypass)
  const maintenance = (await getSetting('maintenance_mode')) === 'true';
  if (maintenance && !isAdmin) {
    const text = await getSetting('maintenance_text');
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Under maintenance', show_alert: true }).catch(() => {});
    else await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  return next();
}
