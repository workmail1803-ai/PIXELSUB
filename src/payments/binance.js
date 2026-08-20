import crypto from 'crypto';
import config from '../config.js';
import logger from '../logger.js';

const BASE = 'https://api.binance.com';

export function isConfigured() {
  return Boolean(config.binance.apiKey && config.binance.apiSecret && config.binance.payId);
}

function signedUrl(path, params = {}) {
  const query = new URLSearchParams({
    ...params,
    timestamp: Date.now(),
    recvWindow: 10000,
  }).toString();
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(query)
    .digest('hex');
  return `${BASE}${path}?${query}&signature=${signature}`;
}

async function signedGet(path, params = {}) {
  const res = await fetch(signedUrl(path, params), {
    headers: { 'X-MBX-APIKEY': config.binance.apiKey },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Binance ${path} returned non-JSON (${res.status}): ${text.slice(0, 160)}`);
  }
  // Binance uses HTTP 200 with a code for business errors, and 4xx for auth ones.
  if (!res.ok || (json.code && json.code !== '000000' && json.code !== 200)) {
    throw new Error(`Binance ${path} error ${json.code ?? res.status}: ${json.msg || 'unknown'}`);
  }
  return json;
}

/**
 * Recent Binance Pay transactions on the account.
 * Positive `amount` = money in, negative = money out.
 */
export async function recentPayTransactions({ limit = 100, startTime } = {}) {
  const params = { limit };
  if (startTime) params.startTime = Math.floor(startTime);
  const res = await signedGet('/sapi/v1/pay/transactions', params);
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Look for an incoming Binance Pay transfer that settles an order.
 *
 * Matching is deliberately conservative:
 *  - money IN only (amount > 0)
 *  - received at or after the order was created (small clock-skew grace)
 *  - value within `tolerancePct` of what is owed
 *  - transaction id not already consumed by another order
 *
 * Binance Pay carries no order reference, so amount + time is all there is to
 * match on. The caller must persist the returned transactionId against the
 * order under a unique constraint — that, not this function, is what makes it
 * impossible for one payment to settle two orders.
 */
export async function findIncomingPayment({
  amount,
  createdAt,
  tolerancePct = 2,
  usedTxIds = new Set(),
  graceMs = 10 * 60 * 1000,
}) {
  const owed = Number(amount);
  if (!Number.isFinite(owed) || owed <= 0) return null;

  const since = new Date(createdAt).getTime() - graceMs;
  let txs;
  try {
    txs = await recentPayTransactions({ limit: 100, startTime: since });
  } catch (e) {
    logger.warn({ err: e.message }, 'binance: pay history lookup failed');
    throw e;
  }

  const candidates = txs
    .filter((t) => Number(t.amount) > 0)
    .filter((t) => Number(t.transactionTime) >= since)
    .filter((t) => !usedTxIds.has(String(t.transactionId)))
    .filter((t) => {
      const got = Number(t.amount);
      if (!Number.isFinite(got)) return false;
      if (got >= owed) return true;
      return ((owed - got) / owed) * 100 <= tolerancePct;
    })
    // Oldest first: settle the payment that has been waiting longest.
    .sort((a, b) => Number(a.transactionTime) - Number(b.transactionTime));

  return candidates[0] || null;
}
