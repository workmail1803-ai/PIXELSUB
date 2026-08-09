import { InlineKeyboard } from 'grammy';
import prisma from '../db.js';
import logger from '../logger.js';
import { money, num, escapeHtml, sleep, chunk } from '../utils.js';
import { sendMessageSafe } from './delivery.js';
import { approveBinancePayment, declineBinancePayment } from '../services/orders.js';

// In-memory per-admin conversation state (fine: only admins use it, resets on restart).
const adminState = new Map();
function setState(id, s) { adminState.set(String(id), s); }
function getState(id) { return adminState.get(String(id)); }
function clearState(id) { adminState.delete(String(id)); }

// Edit-in-place when triggered from a button, else send fresh.
async function adminSend(ctx, text, keyboard) {
  const opts = { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, opts); return; }
    catch (e) {
      if (!String(e.description || e.message).includes('not modified')) await ctx.reply(text, opts).catch(() => {});
      return;
    }
  }
  await ctx.reply(text, opts);
}

function guard(ctx) {
  if (!ctx.isAdmin) {
    ctx.answerCallbackQuery?.({ text: 'Admins only.', show_alert: true }).catch(() => {});
    return false;
  }
  return true;
}

// ============================ MENUS ============================
export async function showAdminMenu(ctx) {
  clearState(ctx.from.id);
  const [users, orders, pending, products] = await Promise.all([
    prisma.user.count(),
    prisma.order.count(),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.product.count(),
  ]);
  const [revenue, pendingCredits] = await Promise.all([
    prisma.order.aggregate({ _sum: { amount: true }, where: { status: { in: ['PAID', 'DELIVERED'] } } }),
    prisma.creditRequest.count({ where: { status: 'PENDING' } }),
  ]);

  const text =
    `🛠️ <b>Admin Panel</b>\n\n` +
    `👥 Users: <b>${num(users)}</b>\n` +
    `🧾 Orders: <b>${num(orders)}</b>  ·  ⏳ Pending: <b>${num(pending)}</b>\n` +
    `🏷️ Products: <b>${num(products)}</b>\n` +
    `💰 Revenue: <b>${money(num(revenue._sum.amount))}</b>\n\n` +
    `Manage your whole store right here in Telegram. 👇`;

  const kb = new InlineKeyboard()
    .text('🏷️ Products & Stock', 'a:products')
    .row()
    .text('➕ Add Product', 'a:pnew')
    .text('📊 Stats', 'a:stats')
    .row()
    .text('👥 Users', 'a:users')
    .text(`💳 Credit Requests${pendingCredits ? ` (${pendingCredits})` : ''}`, 'a:credits')
    .row()
    .text('🧾 Orders', 'a:orders')
    .text('📣 Broadcast', 'a:bc')
    .row()
    .text('🛍️ Open Shop (as customer)', 'shop');
  await adminSend(ctx, text, kb);
}

async function showStats(ctx) {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const [users, newToday, orders, delivered, pending, rev, revToday] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: today } } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: 'DELIVERED' } }),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.order.aggregate({ _sum: { amount: true }, where: { status: { in: ['PAID', 'DELIVERED'] } } }),
    prisma.order.aggregate({ _sum: { amount: true }, where: { status: { in: ['PAID', 'DELIVERED'] }, paidAt: { gte: today } } }),
  ]);
  const text =
    `📊 <b>Store Statistics</b>\n\n` +
    `👥 Users: <b>${num(users)}</b> (+${num(newToday)} today)\n` +
    `🧾 Orders: <b>${num(orders)}</b>\n` +
    `✅ Delivered: <b>${num(delivered)}</b>\n` +
    `⏳ Pending: <b>${num(pending)}</b>\n` +
    `💰 Revenue: <b>${money(num(rev._sum.amount))}</b>\n` +
    `📈 Today: <b>${money(num(revToday._sum.amount))}</b>`;
  await adminSend(ctx, text, new InlineKeyboard().text('⬅️ Back', 'a:menu'));
}

// ============================ PRODUCTS ============================
async function listProducts(ctx) {
  clearState(ctx.from.id);
  const products = await prisma.product.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { stock: { where: { isSold: false } } } } },
  });
  const kb = new InlineKeyboard();
  for (const p of products) {
    const stock = p.usesStock ? `📦${p._count.stock}` : '♾️';
    const vis = p.isActive ? '' : '🚫';
    kb.text(`${vis}${p.emoji} ${p.name} · ${money(num(p.price))} · ${stock}`, `a:prod:${p.id}`).row();
  }
  kb.text('➕ Add Product', 'a:pnew').row().text('⬅️ Back', 'a:menu');
  const text = products.length
    ? `🏷️ <b>Products</b> (${products.length})\n\n🚫 = hidden from shop · 📦 = stock left\nTap a product to manage it.`
    : `🏷️ <b>Products</b>\n\nNo products yet. Add your first one!`;
  await adminSend(ctx, text, kb);
}

async function showProduct(ctx, id) {
  clearState(ctx.from.id);
  const p = await prisma.product.findUnique({
    where: { id },
    include: { _count: { select: { stock: { where: { isSold: false } } } } },
  });
  if (!p) return adminSend(ctx, 'Product not found.', new InlineKeyboard().text('⬅️ Products', 'a:products'));

  const sold = await prisma.stockItem.count({ where: { productId: id, isSold: true } });
  const text =
    `${escapeHtml(p.emoji)} <b>${escapeHtml(p.name)}</b>\n\n` +
    `💵 Price: <b>${money(num(p.price))}</b>\n` +
    `${p.usesStock ? `📦 In stock: <b>${p._count.stock}</b> · Sold: <b>${sold}</b>` : '♾️ Unlimited (fixed content)'}\n` +
    `👁 Visible in shop: <b>${p.isActive ? 'Yes ✅' : 'No 🚫'}</b>\n` +
    (p.description ? `\n${escapeHtml(p.description)}` : '');

  const kb = new InlineKeyboard();
  if (p.usesStock) kb.text('📦 View Stock', `a:pstock:${p.id}`).text('➕ Add Stock', `a:paddstock:${p.id}`).row();
  kb.text('💵 Edit Price', `a:pprice:${p.id}`).text(p.isActive ? '🚫 Hide' : '✅ Show', `a:ptoggle:${p.id}`).row();
  kb.text('🗑 Delete', `a:pdel:${p.id}`).row();
  kb.text('⬅️ Products', 'a:products');
  await adminSend(ctx, text, kb);
}

async function toggleProduct(ctx, id) {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p) return;
  await prisma.product.update({ where: { id }, data: { isActive: !p.isActive } });
  await ctx.answerCallbackQuery({ text: p.isActive ? 'Hidden from shop 🚫' : 'Now visible ✅' }).catch(() => {});
  await showProduct(ctx, id);
}

async function confirmDelete(ctx, id) {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p) return listProducts(ctx);

  const [orderLines, soldStock, unsoldStock] = await Promise.all([
    prisma.orderItem.count({ where: { productId: id } }),
    prisma.stockItem.count({ where: { productId: id, isSold: true } }),
    prisma.stockItem.count({ where: { productId: id, isSold: false } }),
  ]);

  let impact = '\n\n<b>What happens:</b>\n';
  impact += `• Removed from the shop immediately\n`;
  if (unsoldStock) impact += `• <b>${unsoldStock}</b> unsold stock item(s) destroyed 🗑\n`;
  if (orderLines) {
    impact +=
      `• <b>${orderLines}</b> past order line(s) are <b>kept</b> — name, price and\n` +
      `  the ${soldStock} delivered code(s) stay readable in Orders ✅\n`;
  }
  impact += `\nThis cannot be undone.`;

  const kb = new InlineKeyboard()
    .text('🗑 Yes, delete it', `a:pdelyes:${id}`)
    .text('❌ Cancel', `a:prod:${id}`)
    .row();
  // Hiding keeps it sellable-later; only worth offering if it's still visible.
  if (p.isActive) kb.text('👁 Just hide it instead', `a:ptoggle:${id}`);

  await adminSend(ctx, `⚠️ <b>Delete ${escapeHtml(p.emoji)} ${escapeHtml(p.name)}?</b>${impact}`, kb);
}

async function doDelete(ctx, id) {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p) return listProducts(ctx);

  // Unsold stock is worthless once the product is gone, so drop it. Sold stock
  // and order lines survive: their productId is set to NULL by the FK rule, so
  // delivered codes and the purchase snapshot stay intact for order history.
  const removed = await prisma.stockItem.deleteMany({ where: { productId: id, isSold: false } });
  await prisma.product.delete({ where: { id } });

  logger.info(
    { productId: id, name: p.name, unsoldRemoved: removed.count },
    'admin deleted product'
  );
  await ctx
    .answerCallbackQuery({
      text: removed.count ? `Deleted · ${removed.count} unsold item(s) removed` : 'Product deleted',
    })
    .catch(() => {});
  await listProducts(ctx);
}

async function viewStock(ctx, id) {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p) return;
  const [available, sold, items] = await Promise.all([
    prisma.stockItem.count({ where: { productId: id, isSold: false } }),
    prisma.stockItem.count({ where: { productId: id, isSold: true } }),
    prisma.stockItem.findMany({ where: { productId: id, isSold: false }, take: 15, orderBy: { id: 'asc' } }),
  ]);
  const list = items.length
    ? items.map((i, n) => `${n + 1}. <code>${escapeHtml(i.content.length > 60 ? i.content.slice(0, 60) + '…' : i.content)}</code>`).join('\n')
    : '<i>No stock available.</i>';
  const more = available > items.length ? `\n… and ${available - items.length} more` : '';
  const text =
    `📦 <b>Stock · ${escapeHtml(p.name)}</b>\n\n` +
    `Available: <b>${available}</b> · Sold: <b>${sold}</b>\n\n${list}${more}`;
  const kb = new InlineKeyboard()
    .text('➕ Add Stock', `a:paddstock:${id}`).text('🧹 Clear Unsold', `a:pclear:${id}`).row()
    .text('⬅️ Back', `a:prod:${id}`);
  await adminSend(ctx, text, kb);
}

async function clearStock(ctx, id) {
  const r = await prisma.stockItem.deleteMany({ where: { productId: id, isSold: false } });
  await ctx.answerCallbackQuery({ text: `Cleared ${r.count} unsold item(s)` }).catch(() => {});
  await viewStock(ctx, id);
}

// ============================ INPUT FLOWS ============================
function cancelKb() { return new InlineKeyboard().text('❌ Cancel', 'a:menu'); }

async function startAddProduct(ctx) {
  setState(ctx.from.id, { action: 'add_product', step: 'name', draft: {} });
  await adminSend(ctx, '➕ <b>New Product</b>\n\nStep 1/4 — Send the <b>product name</b>:', cancelKb());
}

async function startEditPrice(ctx, id) {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p) return;
  setState(ctx.from.id, { action: 'edit_price', productId: id });
  await adminSend(ctx, `💵 Send the <b>new price</b> for ${escapeHtml(p.emoji)} ${escapeHtml(p.name)} (current ${money(num(p.price))}):`, cancelKb());
}

async function startAddStock(ctx, id) {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p) return;
  setState(ctx.from.id, { action: 'add_stock', productId: id });
  await adminSend(ctx, `➕ <b>Add Stock · ${escapeHtml(p.name)}</b>\n\nSend the items — <b>one per line</b>. Each line becomes one deliverable unit.`, cancelKb());
}

async function startBroadcast(ctx) {
  setState(ctx.from.id, { action: 'broadcast' });
  await adminSend(ctx, '📣 <b>Broadcast</b>\n\nSend the message to deliver to <b>all users</b>. HTML supported.', cancelKb());
}

// Handle a text message while an admin flow is active. Returns true if consumed.
async function handleAdminText(ctx) {
  const st = getState(ctx.from.id);
  if (!st) return false;
  const text = ctx.message.text;

  // Add product wizard
  if (st.action === 'add_product') {
    if (st.step === 'name') {
      st.draft.name = text.slice(0, 200); st.step = 'emoji';
      await ctx.reply('Step 2/4 — Send an <b>emoji</b> for it (or send <code>-</code> to skip):', { parse_mode: 'HTML', reply_markup: cancelKb() });
    } else if (st.step === 'emoji') {
      st.draft.emoji = text === '-' ? '🛍️' : text.trim().slice(0, 8); st.step = 'price';
      await ctx.reply('Step 3/4 — Send the <b>price in USD</b> (e.g. 4.99):', { parse_mode: 'HTML', reply_markup: cancelKb() });
    } else if (st.step === 'price') {
      const price = parseFloat(text.replace(',', '.'));
      if (!(price >= 0)) { await ctx.reply('❌ Please send a valid number, e.g. 4.99'); return true; }
      st.draft.price = price; st.step = 'desc';
      await ctx.reply('Step 4/4 — Send a short <b>description</b> (or <code>-</code> to skip):', { parse_mode: 'HTML', reply_markup: cancelKb() });
    } else if (st.step === 'desc') {
      st.draft.description = text === '-' ? '' : text.slice(0, 500);
      const p = await prisma.product.create({
        data: { name: st.draft.name, emoji: st.draft.emoji, price: st.draft.price, description: st.draft.description, usesStock: true },
      });
      clearState(ctx.from.id);
      await ctx.reply(`✅ Created <b>${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</b> at ${money(num(p.price))}.\n\nNow add stock so customers can buy it.`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('➕ Add Stock', `a:paddstock:${p.id}`).row().text('🏷️ Products', 'a:products'),
      });
    }
    return true;
  }

  if (st.action === 'edit_price') {
    const price = parseFloat(text.replace(',', '.'));
    if (!(price >= 0)) { await ctx.reply('❌ Please send a valid number, e.g. 4.99'); return true; }
    await prisma.product.update({ where: { id: st.productId }, data: { price } });
    clearState(ctx.from.id);
    await ctx.reply(`✅ Price updated to ${money(price)}.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Product', `a:prod:${st.productId}`) });
    return true;
  }

  if (st.action === 'add_stock') {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { await ctx.reply('❌ Send at least one line.'); return true; }
    await prisma.stockItem.createMany({ data: lines.map((content) => ({ productId: st.productId, content })) });
    const available = await prisma.stockItem.count({ where: { productId: st.productId, isSold: false } });
    clearState(ctx.from.id);
    await ctx.reply(`✅ Added <b>${lines.length}</b> item(s). Available now: <b>${available}</b>.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('➕ Add More', `a:paddstock:${st.productId}`).row().text('⬅️ Product', `a:prod:${st.productId}`),
    });
    return true;
  }

  if (st.action === 'grant_credit') {
    const amount = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(amount) || amount === 0) { await ctx.reply('❌ Send a non-zero number, e.g. 10 or -5'); return true; }
    const u = await prisma.user.update({ where: { id: st.userId }, data: { balance: { increment: amount } } });
    clearState(ctx.from.id);
    await ctx.reply(`✅ Balance updated. New balance: <b>${money(num(u.balance))}</b>.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ User', `a:user:${st.userId}`) });
    await sendMessageSafe(u.telegramId, amount > 0
      ? `💰 <b>${money(amount)}</b> store credit was added to your wallet by our team!\n💳 Balance: <b>${money(num(u.balance))}</b>`
      : `ℹ️ Your wallet balance was adjusted by <b>${money(amount)}</b>.\n💳 Balance: <b>${money(num(u.balance))}</b>`);
    return true;
  }

  if (st.action === 'user_message') {
    const u = await prisma.user.findUnique({ where: { id: st.userId } });
    clearState(ctx.from.id);
    if (!u) { await ctx.reply('User not found.'); return true; }
    const r = await sendMessageSafe(u.telegramId, `💬 <b>Message from support</b>\n\n${escapeHtml(text)}`);
    await ctx.reply(r.ok ? '✅ Message delivered.' : `⚠️ Could not deliver: ${r.error || 'unknown'}`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ User', `a:user:${st.userId}`) });
    return true;
  }

  if (st.action === 'broadcast') {
    clearState(ctx.from.id);
    const users = await prisma.user.findMany({ where: { isBanned: false }, select: { telegramId: true } });
    await ctx.reply(`📣 Sending to <b>${users.length}</b> users…`, { parse_mode: 'HTML' });
    let sent = 0, failed = 0;
    const rec = await prisma.broadcast.create({ data: { text, sentCount: 0, failCount: 0 } });
    (async () => {
      for (const u of users) {
        const r = await sendMessageSafe(u.telegramId, text);
        r.ok ? sent++ : failed++;
        await sleep(40);
      }
      await prisma.broadcast.update({ where: { id: rec.id }, data: { sentCount: sent, failCount: failed } });
      await ctx.reply(`✅ Broadcast done · delivered ${sent}, failed ${failed}.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🛠️ Admin', 'a:menu') }).catch(() => {});
    })().catch((e) => logger.error({ err: e.message }, 'admin broadcast failed'));
    return true;
  }

  return false;
}

// ============================ USERS ============================
async function listUsers(ctx) {
  clearState(ctx.from.id);
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { _count: { select: { orders: true } } } });
  const kb = new InlineKeyboard();
  for (const u of users) {
    const name = u.username ? '@' + u.username : (u.firstName || 'User');
    const flag = u.isBanned ? '🚫' : '';
    kb.text(`${flag}${name} · ${money(num(u.balance))} · ${u._count.orders}🧾`, `a:user:${u.id}`).row();
  }
  kb.text('⬅️ Back', 'a:menu');
  const text = users.length ? '👥 <b>Recent Users</b>\n\nTap a user to manage.' : '👥 <b>Users</b>\n\nNo users yet.';
  await adminSend(ctx, text, kb);
}

async function showUser(ctx, id) {
  clearState(ctx.from.id);
  const u = await prisma.user.findUnique({ where: { id }, include: { _count: { select: { orders: true } } } });
  if (!u) return adminSend(ctx, 'User not found.', new InlineKeyboard().text('⬅️ Users', 'a:users'));
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || '—';
  const text =
    `👤 <b>${escapeHtml(name)}</b>\n` +
    `${u.username ? '@' + escapeHtml(u.username) + '\n' : ''}` +
    `🆔 <code>${u.telegramId}</code>\n\n` +
    `💳 Balance: <b>${money(num(u.balance))}</b>\n` +
    `🧾 Orders: <b>${u._count.orders}</b> · Spent: <b>${money(num(u.totalSpent))}</b>\n` +
    `Status: <b>${u.isBanned ? 'Banned 🚫' : 'Active ✅'}</b>`;
  const kb = new InlineKeyboard()
    .text('💰 Grant Credit', `a:ugrant:${u.id}`).text('💬 Message', `a:umsg:${u.id}`).row()
    .text(u.isBanned ? '✅ Unban' : '🚫 Ban', `a:uban:${u.id}`).row()
    .text('⬅️ Users', 'a:users');
  await adminSend(ctx, text, kb);
}

async function toggleBan(ctx, id) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return;
  await prisma.user.update({ where: { id }, data: { isBanned: !u.isBanned } });
  await ctx.answerCallbackQuery({ text: u.isBanned ? 'User unbanned ✅' : 'User banned 🚫' }).catch(() => {});
  await showUser(ctx, id);
}

async function startGrant(ctx, id) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return;
  setState(ctx.from.id, { action: 'grant_credit', userId: id });
  await adminSend(ctx, `💰 Send the amount of credit to add to <b>${escapeHtml(u.username ? '@' + u.username : u.firstName || 'user')}</b> (e.g. 10). Use a negative number to deduct.`, cancelKb());
}

async function startUserMessage(ctx, id) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return;
  setState(ctx.from.id, { action: 'user_message', userId: id });
  await adminSend(ctx, `💬 Send the message to deliver to <b>${escapeHtml(u.username ? '@' + u.username : u.firstName || 'user')}</b>:`, cancelKb());
}

// ============================ CREDIT REQUESTS ============================
async function listCredits(ctx) {
  clearState(ctx.from.id);
  const reqs = await prisma.creditRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 10 });
  const kb = new InlineKeyboard();
  for (const r of reqs) {
    const name = r.username ? '@' + r.username : `id ${r.telegramId}`;
    kb.text(`${name} · ${money(num(r.amount))}`, `a:cr:${r.id}`).row();
  }
  kb.text('⬅️ Back', 'a:menu');
  const text = reqs.length ? '💳 <b>Pending Credit Requests</b>\n\nTap to review.' : '💳 <b>Credit Requests</b>\n\nNo pending requests. 🎉';
  await adminSend(ctx, text, kb);
}

async function showCredit(ctx, id) {
  const r = await prisma.creditRequest.findUnique({ where: { id } });
  if (!r) return listCredits(ctx);
  const name = r.username ? '@' + r.username : `id ${r.telegramId}`;
  const text =
    `💳 <b>Credit Request #${r.id}</b>\n\n` +
    `👤 ${escapeHtml(name)} (<code>${r.telegramId}</code>)\n` +
    `💰 Amount: <b>${money(num(r.amount))}</b>\n` +
    `Status: <b>${r.status}</b>`;
  const kb = new InlineKeyboard();
  if (r.status === 'PENDING') kb.text('✅ Approve', `a:crok:${r.id}`).text('❌ Decline', `a:crno:${r.id}`).row();
  kb.text('⬅️ Requests', 'a:credits');
  await adminSend(ctx, text, kb);
}

async function approveCredit(ctx, id) {
  const r = await prisma.creditRequest.findUnique({ where: { id } });
  if (!r || r.status !== 'PENDING') return ctx.answerCallbackQuery({ text: 'Already handled.', show_alert: true }).catch(() => {});
  await prisma.$transaction([
    prisma.creditRequest.update({ where: { id }, data: { status: 'APPROVED' } }),
    prisma.user.update({ where: { id: r.userId }, data: { balance: { increment: r.amount } } }),
  ]);
  const u = await prisma.user.findUnique({ where: { id: r.userId } });
  await sendMessageSafe(r.telegramId, `✅ <b>Credit approved!</b>\n\n💰 <b>${money(num(r.amount))}</b> was added to your wallet.\n💳 New balance: <b>${money(num(u.balance))}</b>`);
  await ctx.answerCallbackQuery({ text: 'Approved & credited ✅' }).catch(() => {});
  await showCredit(ctx, id);
}

async function declineCredit(ctx, id) {
  const r = await prisma.creditRequest.findUnique({ where: { id } });
  if (!r || r.status !== 'PENDING') return ctx.answerCallbackQuery({ text: 'Already handled.', show_alert: true }).catch(() => {});
  await prisma.creditRequest.update({ where: { id }, data: { status: 'DECLINED' } });
  await sendMessageSafe(r.telegramId, `ℹ️ Your credit request for <b>${money(num(r.amount))}</b> was declined. Contact support if you have questions.`);
  await ctx.answerCallbackQuery({ text: 'Declined' }).catch(() => {});
  await showCredit(ctx, id);
}

// ============================ BINANCE PAYMENTS ============================
async function approveBinance(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(order.status)) {
    return ctx.answerCallbackQuery({ text: `Order already ${order.status.toLowerCase()}.`, show_alert: true }).catch(() => {});
  }
  await approveBinancePayment(orderId);
  await ctx.answerCallbackQuery({ text: 'Approved ✅ — delivering items!' }).catch(() => {});
  // Edit the admin message to reflect approval
  try {
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n✅ <b>APPROVED</b> by admin',
      { parse_mode: 'HTML' }
    );
  } catch { /* ignore edit errors */ }
}

async function declineBinance(ctx, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(order.status)) {
    return ctx.answerCallbackQuery({ text: `Order already ${order.status.toLowerCase()}.`, show_alert: true }).catch(() => {});
  }
  await declineBinancePayment(orderId);
  await ctx.answerCallbackQuery({ text: 'Declined ❌' }).catch(() => {});
  try {
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n❌ <b>DECLINED</b> by admin',
      { parse_mode: 'HTML' }
    );
  } catch { /* ignore edit errors */ }
}

// ============================ ORDERS ============================
const ORDER_PAGE_SIZE = 8;
// Telegram caps callback_data at 64 bytes, so filter keys stay short.
const ORDER_FILTERS = {
  all: { label: 'All', where: {} },
  pen: { label: '⏳ Pending', where: { status: 'PENDING' } },
  pay: { label: '💵 Paid', where: { status: 'PAID' } },
  dlv: { label: '✅ Delivered', where: { status: 'DELIVERED' } },
  bad: { label: '⚠️ Issues', where: { status: { in: ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] } } },
};

function statusDot(s) {
  return ({ PENDING: '⏳', PAID: '💵', DELIVERED: '✅', CANCELLED: '❌', EXPIRED: '⌛', REFUNDED: '↩️', FAILED: '⚠️' }[s] || '•');
}

function methodLabel(m) {
  return ({ CRYPTOMUS: '🪙 Cryptomus', BINANCE: '🟡 Binance (manual)', BALANCE: '💳 Wallet balance' }[m] || m || '—');
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
}

function customerName(u) {
  if (!u) return 'Unknown';
  if (u.username) return '@' + u.username;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || `id ${u.telegramId}`;
}

async function listOrders(ctx, filter = 'all', page = 0) {
  clearState(ctx.from.id);
  const f = ORDER_FILTERS[filter] ? filter : 'all';
  const { label, where } = ORDER_FILTERS[f];

  const [total, sum] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.aggregate({ _sum: { amount: true }, where }),
  ]);
  const pages = Math.max(1, Math.ceil(total / ORDER_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: p * ORDER_PAGE_SIZE,
    take: ORDER_PAGE_SIZE,
    include: { user: true },
  });

  const kb = new InlineKeyboard();
  for (const o of orders) {
    const kind = o.kind === 'TOPUP' ? '💰' : '🛍️';
    const who = customerName(o.user).slice(0, 16);
    kb.text(`${statusDot(o.status)}${kind} ${o.publicId} · ${money(num(o.amount), o.currency)} · ${who}`, `a:order:${o.id}`).row();
  }

  if (pages > 1) {
    if (p > 0) kb.text('⬅️ Prev', `a:ords:${f}:${p - 1}`);
    kb.text(`📄 ${p + 1}/${pages}`, 'a:noop');
    if (p < pages - 1) kb.text('Next ➡️', `a:ords:${f}:${p + 1}`);
    kb.row();
  }

  // Filter tabs — the active one is marked so the current view is obvious.
  for (const group of chunk(Object.keys(ORDER_FILTERS), 3)) {
    for (const k of group) kb.text(k === f ? `• ${ORDER_FILTERS[k].label} •` : ORDER_FILTERS[k].label, `a:ords:${k}:0`);
    kb.row();
  }
  kb.text('⬅️ Back', 'a:menu');

  const text = total
    ? `🧾 <b>Orders — ${label}</b>\n\n` +
      `Showing <b>${p * ORDER_PAGE_SIZE + 1}–${p * ORDER_PAGE_SIZE + orders.length}</b> of <b>${total}</b>\n` +
      `💵 Combined value: <b>${money(num(sum._sum.amount))}</b>\n\n` +
      `🛍️ purchase · 💰 top-up — tap any order for the full record.`
    : `🧾 <b>Orders — ${label}</b>\n\nNothing here yet.`;
  await adminSend(ctx, text, kb);
}

async function showOrder(ctx, id) {
  clearState(ctx.from.id);
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      user: true,
      items: { include: { stock: true } },
      events: { select: { id: true } },
    },
  });
  if (!o) return adminSend(ctx, 'Order not found.', new InlineKeyboard().text('⬅️ Orders', 'a:orders'));

  const lines = o.items.map((i) => {
    const gone = i.productId === null ? ' <i>(product deleted)</i>' : '';
    return `${i.emoji} ${escapeHtml(i.productName)} ×${i.quantity} @ ${money(num(i.unitPrice), o.currency)} — <b>${money(num(i.lineTotal), o.currency)}</b>${gone}`;
  });
  const codeCount = o.items.reduce((n, i) => n + i.stock.length, 0);

  const text =
    `🧾 <b>Order ${escapeHtml(o.publicId)}</b>\n\n` +
    `${statusDot(o.status)} <b>${o.status}</b> · ${o.kind === 'TOPUP' ? '💰 Wallet top-up' : '🛍️ Purchase'}\n` +
    `💳 ${methodLabel(o.method)}\n\n` +
    `👤 <b>${escapeHtml(customerName(o.user))}</b>\n` +
    `🆔 <code>${o.user.telegramId}</code>${o.user.isBanned ? ' 🚫 banned' : ''}\n` +
    `💰 Wallet ${money(num(o.user.balance))} · lifetime ${money(num(o.user.totalSpent))}\n\n` +
    `💵 Total: <b>${money(num(o.amount), o.currency)}</b>\n` +
    (o.payAmount ? `🪙 Received: <b>${escapeHtml(String(o.payAmount))} ${escapeHtml(o.payCurrency || '')}</b>${o.network ? ` · ${escapeHtml(o.network)}` : ''}\n` : '') +
    (o.invoiceUuid ? `🔗 Invoice: <code>${escapeHtml(o.invoiceUuid)}</code>\n` : '') +
    `\n🗓️ Created: ${fmtDate(o.createdAt)}\n` +
    (o.paidAt ? `💵 Paid: ${fmtDate(o.paidAt)}\n` : '') +
    (o.deliveredAt ? `📤 Delivered: ${fmtDate(o.deliveredAt)}\n` : '') +
    (o.status === 'PENDING' && o.expiresAt ? `⌛ Expires: ${fmtDate(o.expiresAt)}\n` : '') +
    (lines.length ? `\n<b>Items</b>\n${lines.join('\n')}\n` : '') +
    (codeCount ? `\n📦 <b>${codeCount}</b> delivered code(s) stored` : '');

  const kb = new InlineKeyboard();
  if (codeCount) kb.text(`🔐 View delivered (${codeCount})`, `a:oitem:${o.id}`).row();
  if (o.method === 'BINANCE' && !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(o.status)) {
    kb.text('✅ Approve payment', `a:obinok:${o.id}`).text('❌ Decline', `a:obinno:${o.id}`).row();
  }
  if (['PAID', 'DELIVERED'].includes(o.status)) kb.text('📤 Re-deliver', `a:oredeliver:${o.id}`).row();
  kb.text(`🕓 Timeline (${o.events.length})`, `a:oev:${o.id}`).text('👤 Customer', `a:user:${o.userId}`).row();
  // Only https links: Telegram rejects the whole keyboard on a malformed url.
  if (o.status === 'PENDING' && /^https:\/\//.test(o.payUrl || '')) kb.url('🔗 Payment page', o.payUrl).row();
  kb.text('⬅️ Orders', 'a:orders');
  await adminSend(ctx, text, kb);
}

// The actual delivered secrets, kept behind an extra tap so they don't sit in
// the order list by default.
async function showOrderDelivered(ctx, id) {
  const o = await prisma.order.findUnique({ where: { id }, include: { items: { include: { stock: true } } } });
  if (!o) return;

  let body = '';
  let truncated = false;
  for (const i of o.items) {
    if (!i.stock.length) continue;
    body += `\n<b>${escapeHtml(i.emoji)} ${escapeHtml(i.productName)}</b>\n`;
    for (const [n, s] of i.stock.entries()) {
      const row = `${n + 1}. <code>${escapeHtml(s.content)}</code>\n`;
      // Telegram hard-limits messages at 4096 chars; stop cleanly on a whole row.
      if (body.length + row.length > 3600) { truncated = true; break; }
      body += row;
    }
    if (truncated) break;
  }

  const text =
    `🔐 <b>Delivered · ${escapeHtml(o.publicId)}</b>\n` +
    (body || '\n<i>Nothing stored for this order.</i>') +
    (truncated ? '\n<i>… list truncated to fit one message.</i>' : '');
  await adminSend(ctx, text, new InlineKeyboard().text('⬅️ Order', `a:order:${id}`));
}

async function showOrderEvents(ctx, id) {
  const o = await prisma.order.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!o) return;

  let body = '';
  let truncated = false;
  for (const e of o.events) {
    const row =
      `<code>${fmtDate(e.createdAt)}</code>\n` +
      `• <b>${escapeHtml(e.type)}</b>${e.message ? ` — ${escapeHtml(e.message)}` : ''}\n\n`;
    if (body.length + row.length > 3600) { truncated = true; break; }
    body += row;
  }

  const text =
    `🕓 <b>Timeline · ${escapeHtml(o.publicId)}</b>\n\n` +
    (body || '<i>No events recorded.</i>') +
    (truncated ? '<i>… older events truncated.</i>' : '');
  await adminSend(ctx, text, new InlineKeyboard().text('⬅️ Order', `a:order:${id}`));
}

// Binance approve/decline invoked from the order view (as opposed to the
// notification message) — settle, then re-render the order in place.
async function decideBinanceFromOrder(ctx, orderId, approve) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return ctx.answerCallbackQuery({ text: 'Order not found.', show_alert: true }).catch(() => {});
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(order.status)) {
    return ctx.answerCallbackQuery({ text: `Already ${order.status.toLowerCase()}.`, show_alert: true }).catch(() => {});
  }
  if (approve) await approveBinancePayment(orderId);
  else await declineBinancePayment(orderId);
  await ctx.answerCallbackQuery({ text: approve ? 'Approved ✅ — delivering' : 'Declined ❌' }).catch(() => {});
  await showOrder(ctx, orderId);
}

// ============================ REGISTRATION ============================
export function registerAdminHandlers(bot) {
  bot.command('admin', async (ctx) => { if (guard(ctx)) await showAdminMenu(ctx); });

  const routes = [
    [/^a:menu$/, (ctx) => showAdminMenu(ctx)],
    [/^a:stats$/, (ctx) => showStats(ctx)],
    [/^a:products$/, (ctx) => listProducts(ctx)],
    [/^a:pnew$/, (ctx) => startAddProduct(ctx)],
    [/^a:prod:(\d+)$/, (ctx) => showProduct(ctx, Number(ctx.match[1]))],
    [/^a:ptoggle:(\d+)$/, (ctx) => toggleProduct(ctx, Number(ctx.match[1]))],
    [/^a:pprice:(\d+)$/, (ctx) => startEditPrice(ctx, Number(ctx.match[1]))],
    [/^a:pdel:(\d+)$/, (ctx) => confirmDelete(ctx, Number(ctx.match[1]))],
    [/^a:pdelyes:(\d+)$/, (ctx) => doDelete(ctx, Number(ctx.match[1]))],
    [/^a:pstock:(\d+)$/, (ctx) => viewStock(ctx, Number(ctx.match[1]))],
    [/^a:paddstock:(\d+)$/, (ctx) => startAddStock(ctx, Number(ctx.match[1]))],
    [/^a:pclear:(\d+)$/, (ctx) => clearStock(ctx, Number(ctx.match[1]))],
    [/^a:users$/, (ctx) => listUsers(ctx)],
    [/^a:user:(\d+)$/, (ctx) => showUser(ctx, Number(ctx.match[1]))],
    [/^a:uban:(\d+)$/, (ctx) => toggleBan(ctx, Number(ctx.match[1]))],
    [/^a:ugrant:(\d+)$/, (ctx) => startGrant(ctx, Number(ctx.match[1]))],
    [/^a:umsg:(\d+)$/, (ctx) => startUserMessage(ctx, Number(ctx.match[1]))],
    [/^a:credits$/, (ctx) => listCredits(ctx)],
    [/^a:cr:(\d+)$/, (ctx) => showCredit(ctx, Number(ctx.match[1]))],
    [/^a:crok:(\d+)$/, (ctx) => approveCredit(ctx, Number(ctx.match[1]))],
    [/^a:crno:(\d+)$/, (ctx) => declineCredit(ctx, Number(ctx.match[1]))],
    [/^a:orders$/, (ctx) => listOrders(ctx)],
    [/^a:ords:([a-z]+):(\d+)$/, (ctx) => listOrders(ctx, ctx.match[1], Number(ctx.match[2]))],
    [/^a:order:(\d+)$/, (ctx) => showOrder(ctx, Number(ctx.match[1]))],
    [/^a:oitem:(\d+)$/, (ctx) => showOrderDelivered(ctx, Number(ctx.match[1]))],
    [/^a:oev:(\d+)$/, (ctx) => showOrderEvents(ctx, Number(ctx.match[1]))],
    [/^a:obinok:(\d+)$/, (ctx) => decideBinanceFromOrder(ctx, Number(ctx.match[1]), true)],
    [/^a:obinno:(\d+)$/, (ctx) => decideBinanceFromOrder(ctx, Number(ctx.match[1]), false)],
    // Page indicator button — acknowledged by the wrapper, does nothing.
    [/^a:noop$/, () => {}],
    [/^a:oredeliver:(\d+)$/, async (ctx) => { const { redeliverOrder } = await import('../services/orders.js'); try { await redeliverOrder(Number(ctx.match[1])); await ctx.answerCallbackQuery({ text: 'Delivery re-sent ✅' }); } catch (e) { await ctx.answerCallbackQuery({ text: e.message, show_alert: true }); } }],
    [/^a:bc$/, (ctx) => startBroadcast(ctx)],
    [/^a:binok:(\d+)$/, (ctx) => approveBinance(ctx, Number(ctx.match[1]))],
    [/^a:binno:(\d+)$/, (ctx) => declineBinance(ctx, Number(ctx.match[1]))],
  ];

  for (const [pattern, handler] of routes) {
    bot.callbackQuery(pattern, async (ctx) => {
      if (!guard(ctx)) return;
      await ctx.answerCallbackQuery().catch(() => {});
      try { await handler(ctx); } catch (e) { logger.error({ err: e.message, cb: ctx.callbackQuery.data }, 'admin cb error'); }
    });
  }

  // Text input middleware for admin flows — runs before the customer text fallback.
  bot.on('message:text', async (ctx, next) => {
    if (!ctx.isAdmin) return next();
    const st = getState(ctx.from.id);
    if (!st) return next();
    if (ctx.message.text.startsWith('/')) { clearState(ctx.from.id); return next(); }
    const consumed = await handleAdminText(ctx).catch((e) => { logger.error({ err: e.message }, 'admin text error'); return true; });
    if (!consumed) return next();
  });
}
