import crypto from 'crypto';
import config from '../config.js';
import logger from '../logger.js';

const { merchantId, paymentKey, apiBase } = config.cryptomus;

// Statuses Cryptomus considers a completed, spendable payment.
export const PAID_STATUSES = new Set(['paid', 'paid_over']);
// Statuses that are dead ends (won't ever become paid). NOTE: `wrong_amount`
// is deliberately NOT here — the funds *did* arrive, just slightly short of
// the invoice, so it is handled by the underpayment tolerance below instead of
// being failed outright.
export const FAILED_STATUSES = new Set(['fail', 'system_fail', 'cancel']);
// Funds received, but under the invoiced amount.
export const UNDERPAID_STATUSES = new Set(['wrong_amount']);

/**
 * How far short of the invoice a payment landed, as a percentage.
 *
 * Cryptomus reports the received value in the invoice currency as
 * `payment_amount` (with `payment_amount_usd` as a USD-denominated backup).
 * Returns null when neither is usable, so callers can fall back to failing
 * safely rather than delivering on a number they could not verify.
 */
export function shortfallPercent(info, owedAmount) {
  const owed = Number(owedAmount);
  if (!Number.isFinite(owed) || owed <= 0) return null;

  const received = Number(info?.payment_amount ?? info?.payment_amount_usd);
  if (!Number.isFinite(received) || received < 0) return null;

  if (received >= owed) return 0;
  return ((owed - received) / owed) * 100;
}

function sign(bodyStr, key = paymentKey) {
  const b64 = Buffer.from(bodyStr).toString('base64');
  return crypto.createHash('md5').update(b64 + key).digest('hex');
}

async function request(path, body, key = paymentKey) {
  const bodyStr = JSON.stringify(body);
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      merchant: merchantId,
      sign: sign(bodyStr, key),
    },
    body: bodyStr,
  });

  let json;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Cryptomus ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  // Cryptomus wraps success as { state: 0, result: {...} }
  if (json.state !== 0) {
    const msg = json.message || (json.errors ? JSON.stringify(json.errors) : 'unknown error');
    const err = new Error(`Cryptomus ${path} error: ${msg}`);
    err.cryptomus = json;
    throw err;
  }
  return json.result;
}

/**
 * Create a hosted crypto invoice.
 * @returns {{uuid, url, order_id, ...}}
 */
export async function createInvoice({ amount, currency, orderId, lifetimeSeconds }) {
  const callbackUrl = `${config.publicUrl}/api/webhook/cryptomus`;
  const body = {
    amount: String(Number(amount).toFixed(2)),
    currency: currency || config.shop.currency,
    order_id: orderId,
    url_callback: callbackUrl,
    // Where the user lands after paying / cancelling on the hosted page:
    url_return: `https://t.me`,
    url_success: `https://t.me`,
    is_payment_multiple: false,
    lifetime: Math.min(Math.max(lifetimeSeconds || 3600, 300), 43200),
    // Nice UX: let the payer choose the coin on the Cryptomus page.
  };
  logger.info({ orderId, amount: body.amount, callbackUrl }, 'Creating Cryptomus invoice');
  return request('/payment', body);
}

/**
 * Authoritative status check (server-to-server). This is the source of truth
 * used before ANY delivery — so a forged webhook can never trigger delivery.
 */
export async function getPaymentInfo({ uuid, orderId }) {
  const body = uuid ? { uuid } : { order_id: orderId };
  return request('/payment/info', body);
}

/**
 * Best-effort webhook signature verification. Cryptomus signs the JSON body
 * (minus the `sign` field). PHP's json_encode escaping differs across configs,
 * so we try both slash-escaped and unescaped serializations. Delivery does NOT
 * depend on this passing — it's a first-line filter; getPaymentInfo() is truth.
 */
export function verifyWebhookSignature(body) {
  if (!body || typeof body !== 'object' || !body.sign) return false;
  const provided = body.sign;
  const clone = { ...body };
  delete clone.sign;

  const raw = JSON.stringify(clone);
  const candidates = [
    raw, // unescaped slashes (JSON_UNESCAPED_SLASHES)
    raw.replace(/\//g, '\\/'), // PHP default (escaped slashes)
  ];
  for (const candidate of candidates) {
    const expected = crypto
      .createHash('md5')
      .update(Buffer.from(candidate).toString('base64') + paymentKey)
      .digest('hex');
    if (expected === provided) return true;
  }
  return false;
}

export function isConfigured() {
  return Boolean(merchantId && paymentKey);
}
