/**
 * Kalshi authenticated order placement.
 *
 * Auth scheme: RSA-PSS SHA-256 (NOT PKCS1 v1.5!)
 *   Message  = timestampMs + METHOD.upper() + path
 *   Headers  = KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE
 *
 * v2 endpoint: POST /trade-api/v2/portfolio/events/orders
 * v2 response: flat JSON { order_id, fill_count, remaining_count, ts_ms } — no nested "order" wrapper
 *
 * Only called when NODE_ENV !== 'development'.
 * Requires KALSHI_KEY_ID + KALSHI_PRIVATE_KEY env vars.
 */

import { createPrivateKey, sign as cryptoSign, constants } from "node:crypto";
import { logger } from "./logger.js";
import { KalshiOrderPlacementError } from "./kalshiOrderErrors.js";

// Kalshi consolidated trading + market-data at a single domain.
// Per Kalshi's own error message: "API has been moved to https://api.elections.kalshi.com/"
// Both reads (kalshiApi.ts) and authenticated writes (this file) use the same base.
const TRADING_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Normalise the private key stored in the env var.
 *
 * Secrets can arrive in several broken forms:
 *   • Spaces instead of newlines between base64 lines (most common on Replit)
 *   • Literal "\n" escape sequences instead of real newlines
 *   • Raw base64 with no PEM header/footer at all
 *   • PKCS1 header ("RSA PRIVATE KEY") or PKCS8 header ("PRIVATE KEY")
 *
 * We always extract the base64 payload, strip ALL whitespace, and re-wrap
 * at 64 chars per line so Node's crypto stack gets a well-formed PEM.
 */
function normalisePem(raw: string): string {
  // Collapse literal \n escapes → real newlines, then trim
  const s = raw.replace(/\\n/g, "\n").trim();

  if (s.includes("-----BEGIN")) {
    // Extract header and footer (handles both RSA PRIVATE KEY and PRIVATE KEY)
    const headerMatch = s.match(/-----BEGIN[^-]*-----/);
    const footerMatch = s.match(/-----END[^-]*-----/);
    if (headerMatch && footerMatch) {
      const header = headerMatch[0]!;
      const footer = footerMatch[0]!;
      // Strip ALL whitespace from the body (handles spaces or newlines)
      const b64 = s
        .slice(s.indexOf(header) + header.length, s.lastIndexOf(footer))
        .replace(/\s+/g, "");
      const lines = b64.match(/.{1,64}/g) ?? [];
      return `${header}\n${lines.join("\n")}\n${footer}`;
    }
  }

  // Raw base64 with no PEM header — wrap as PKCS8 (Kalshi default)
  const b64 = s.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

function buildSignatureHeaders(
  keyId: string,
  privateKey: string,
  method: string,
  path: string,
): Record<string, string> {
  const timestampMs = Date.now().toString();
  const message     = timestampMs + method.toUpperCase() + path;

  // Kalshi v2 uses RSA-PSS (not PKCS1 v1.5).
  // Verified from official Kalshi JS client:
  //   sign("sha256", data, { key: pk, padding: RSA_PKCS1_PSS_PADDING, saltLength: RSA_PSS_SALTLEN_DIGEST })
  const pem = normalisePem(privateKey);
  const pk  = createPrivateKey({ key: pem });
  if (pk.asymmetricKeyType !== "rsa" && pk.asymmetricKeyType !== "rsa-pss") {
    throw new Error("Kalshi signing requires an RSA key for RSA-PSS SHA-256");
  }
  const signature = cryptoSign(
    "sha256",
    Buffer.from(message),
    { key: pk, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
  ).toString("base64");

  return {
    "KALSHI-ACCESS-KEY":       keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type":            "application/json",
    Accept:                    "application/json",
  };
}

/** Validate local signing BEFORE persisting an order intent.
 * This creates a signature in memory only; it makes no HTTP request.
 */
export function assertKalshiSigningReady(
  keyId: string | undefined,
  privateKey: string | undefined,
): void {
  if (!keyId || !privateKey) {
    throw new Error("Kalshi signing credentials are unavailable");
  }
  buildSignatureHeaders(keyId, privateKey, "GET", "/trade-api/v2/portfolio/balance");
}

// ─── Order placement ──────────────────────────────────────────────────────────

/** Flat response shape returned by POST /portfolio/events/orders (v2). */
export interface KalshiOrderResult {
  order_id:        string;   // UUID
  fill_count:      string;   // decimal string e.g. "0.00"
  remaining_count: string;   // decimal string e.g. "1.00"
  ts_ms:           number;   // epoch ms
  // Synthesized by us — not in the raw API response
  status?:         string;   // "resting" | "filled" (derived from fill/remaining)
}

/**
 * Place a real limit buy order on Kalshi.
 *
 * Throws if the API returns a non-2xx response.
 * Caller is responsible for deciding whether to surface the error or swallow it.
 */
export async function placeKalshiOrder(
  ticker:          string,
  side:            "YES" | "NO",
  limitPriceCents: number,
  count            = 1,
): Promise<KalshiOrderResult> {
  const keyId      = process.env["KALSHI_KEY_ID"];
  const privateKey = process.env["KALSHI_PRIVATE_KEY"];

  if (!keyId || !privateKey) {
    throw new Error("KALSHI_KEY_ID and KALSHI_PRIVATE_KEY are required for live order placement");
  }

  // Confirmed via live probe: /portfolio/events/orders returns "signature_is_missing_from_headers"
  // (meaning the path is valid and requires RSA auth), while the old /portfolio/orders returns 410.
  // /markets/{ticker}/orders returns 404 — does not exist.
  const apiPath = "/trade-api/v2/portfolio/events/orders";

  // ── v2 body format (confirmed by live probing) ──────────────────────────────
  // - side:  "bid" (buy YES contracts) | "ask" (sell YES = buy NO)
  // - price: decimal dollar STRING, e.g. "0.37" (NOT cents, NOT yes_price/no_price)
  //   - YES buy: price = limitPriceCents / 100
  //   - NO  buy: price = (100 - limitPriceCents) / 100  (implied YES ask price)
  // - count:  STRING (Go struct unmarshal requires string)
  // - time_in_force: "good_till_canceled"
  // - self_trade_prevention_type: "taker_at_cross"
  const bookSide  = side === "YES" ? "bid" : "ask";
  const priceYes  = side === "YES" ? limitPriceCents : 100 - limitPriceCents;
  const priceDollars = (priceYes / 100).toFixed(2);

  const body = {
    ticker,
    action:                      "buy",
    type:                        "limit",
    count:                       String(count),
    side:                        bookSide,
    price:                       priceDollars,
    time_in_force:               "good_till_canceled",
    self_trade_prevention_type:  "taker_at_cross",
  };

  const headers = buildSignatureHeaders(keyId, privateKey, "POST", apiPath);

  logger.info({ ticker, side, bookSide, limitPriceCents, priceDollars, count }, "Placing Kalshi order");

  const resp = await fetch(`${TRADING_BASE}/portfolio/events/orders`, {
    method:  "POST",
    headers,
    body:    JSON.stringify(body),
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new KalshiOrderPlacementError(resp.status, text);
  }

  // v2 response is a flat object — NOT wrapped in { order: ... }
  const raw = JSON.parse(text) as KalshiOrderResult;
  if (typeof raw.order_id !== "string" || !raw.order_id) {
    throw new Error("Kalshi submission response has no order_id — outcome unresolved");
  }
  const fillCents    = parseFloat(raw.fill_count);
  const remainCents  = parseFloat(raw.remaining_count);
  const derivedStatus = fillCents > 0 && remainCents === 0 ? "filled" : "resting";
  const result: KalshiOrderResult = { ...raw, status: derivedStatus };

  logger.info(
    { ticker, side, limitPriceCents, orderId: result.order_id, status: derivedStatus },
    "Kalshi order placed successfully"
  );

  return result;
}

/**
 * True when we should attempt real Kalshi order placement.
 * Normally gated to non-dev environments, but can be force-enabled in dev
 * by setting KALSHI_LIVE_ORDERS=true (for manual testing without a deploy).
 */
export function kalshiLiveOrdersEnabled(): boolean {
  if (process.env["KALSHI_LIVE_ORDERS"] === "true") return true;
  return process.env["NODE_ENV"] !== "development";
}
