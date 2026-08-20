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

/**
 * Normalise whatever the customer pasted: Binance shows the reference with
 * spaces in some screens, and people paste it with stray punctuation.
 */
function normalizeRef(v) {
  return String(v || '').trim().replace(/\s+/g, '').replace(/^[#:]+|[.,;]+$/g, '').toUpperCase();
}

/**
 * Find the incoming transfer the customer says they sent, by the reference they
 * gave us. Binance surfaces several identifiers depending on which screen the
 * payer looks at, so all of them are accepted:
 *   - transactionId  e.g. P_A22DZ34XBFS71116
 *   - orderId        e.g. 436520167574593536
 *   - their own Binance UID (payerInfo.binanceId / counterpartyId)
 *
 * A reference alone is not enough to release goods: the transfer must also be
 * money IN, dated at/after the order, and worth what is owed within tolerance.
 * Returns { tx } on success or { error } describing precisely what was wrong,
 * so the customer gets a useful message instead of a generic failure.
 */
export async function findPaymentByReference({
  reference,
  amount,
  createdAt,
  tolerancePct = 2,
  usedTxIds = new Set(),
  graceMs = 30 * 60 * 1000,
}) {
  const ref = normalizeRef(reference);
  if (ref.length < 4) return { error: 'ref_too_short' };

  const owed = Number(amount);
  const since = new Date(createdAt).getTime() - graceMs;

  let txs;
  try {
    txs = await recentPayTransactions({ limit: 100, startTime: since });
  } catch (e) {
    logger.warn({ err: e.message }, 'binance: history lookup failed');
    return { error: 'api_error' };
  }

  const matches = (t) => {
    const txId = normalizeRef(t.transactionId);
    const ordId = normalizeRef(t.orderId);
    if (txId && (txId === ref || ref === txId || txId.includes(ref) || ref.includes(txId))) return true;
    if (ordId && (ordId === ref || ordId.includes(ref) || ref.includes(ordId))) return true;
    // Numeric reference could be the payer's own Binance UID.
    if (/^\d{6,}$/.test(ref)) {
      if (String(t.payerInfo?.binanceId || '') === ref) return true;
      if (String(t.counterpartyId || '') === ref) return true;
    }
    return false;
  };

  const found = txs.filter(matches);
  if (!found.length) return { error: 'not_found' };

  // Report the most specific problem rather than a blanket "no".
  const incoming = found.filter((t) => Number(t.amount) > 0);
  if (!incoming.length) return { error: 'not_incoming' };

  const unclaimed = incoming.filter((t) => !usedTxIds.has(String(t.transactionId)));
  if (!unclaimed.length) return { error: 'already_used' };

  const inWindow = unclaimed.filter((t) => Number(t.transactionTime) >= since);
  if (!inWindow.length) return { error: 'too_old' };

  const enough = inWindow.filter((t) => {
    const got = Number(t.amount);
    if (!Number.isFinite(got)) return false;
    if (got >= owed) return true;
    return ((owed - got) / owed) * 100 <= tolerancePct;
  });
  if (!enough.length) {
    return { error: 'wrong_amount', tx: inWindow[0], owed };
  }

  enough.sort((a, b) => Number(a.transactionTime) - Number(b.transactionTime));
  return { tx: enough[0] };
}
