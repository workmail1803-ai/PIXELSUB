import crypto from 'crypto';
import config from './config.js';

// Short, unambiguous public order id, e.g. ORD-7K2QF9
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
export function shortId(prefix = 'ORD') {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${s}`;
}

// Unique order_id we send to Cryptomus (must be unique per invoice)
export function invoiceOrderId() {
  return `inv_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', RUB: '₽', INR: '₹', UAH: '₴' };
export function money(amount, currency = config.shop.currency) {
  const n = Number(amount);
  const sym = CURRENCY_SYMBOLS[currency] || '';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sym ? `${sym}${formatted}` : `${formatted} ${currency}`;
}

// Decimal (Prisma) -> plain number
export function num(d) {
  if (d === null || d === undefined) return 0;
  return typeof d === 'object' && typeof d.toNumber === 'function' ? d.toNumber() : Number(d);
}

// Escape user-provided text for Telegram HTML parse mode
export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
