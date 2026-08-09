import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';

const COOKIE_NAME = 'telebot_admin';
const TOKEN_TTL = '7d';

// Ensure a bootstrap admin account exists (from env). Idempotent.
export async function ensureBootstrapAdmin() {
  const username = config.admin.username;
  const existing = await prisma.adminAccount.findUnique({ where: { username } });
  const hash = bcrypt.hashSync(config.admin.password, 10);
  if (!existing) {
    await prisma.adminAccount.create({
      data: { username, passwordHash: hash, role: 'owner' },
    });
    logger.info({ username }, 'Bootstrap admin account created');
  } else {
    // Keep password in sync with env so operators can rotate via env vars.
    await prisma.adminAccount.update({
      where: { username },
      data: { passwordHash: hash },
    });
  }
}

export async function verifyCredentials(username, password) {
  const account = await prisma.adminAccount.findUnique({ where: { username } });
  if (!account) return null;
  if (!bcrypt.compareSync(password, account.passwordHash)) return null;
  await prisma.adminAccount.update({
    where: { id: account.id },
    data: { lastLoginAt: new Date() },
  });
  return account;
}

export function issueToken(account) {
  return jwt.sign(
    { sub: account.id, username: account.username, role: account.role },
    config.admin.jwtSecret,
    { expiresIn: TOKEN_TTL }
  );
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Express middleware — protects the admin API.
export function requireAuth(req, res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies?.[COOKIE_NAME] || bearer;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.admin = jwt.verify(token, config.admin.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

export const AUTH_COOKIE = COOKIE_NAME;
