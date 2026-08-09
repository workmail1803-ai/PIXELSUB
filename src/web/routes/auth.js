import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyCredentials, issueToken, setAuthCookie, clearAuthCookie, requireAuth } from '../auth.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const account = await verifyCredentials(String(username), String(password));
  if (!account) return res.status(401).json({ error: 'Invalid username or password' });
  const token = issueToken(account);
  setAuthCookie(res, token);
  res.json({ ok: true, admin: { username: account.username, role: account.role }, token });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ admin: { username: req.admin.username, role: req.admin.role } });
});

export default router;
