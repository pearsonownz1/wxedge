/**
 * Kalshi authenticated order placement.
 *
 * Auth scheme: RSA-SHA256, PKCS1 v1.5
 *   Message  = timestampMs + METHOD.upper() + path
 *   Headers  = KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE
 *
 * Only called when NODE_ENV !== 'development'.
 * Requires KALSHI_KEY_ID + KALSHI_PRIVATE_KEY env vars.
 */

import { createSign } from "node:crypto";
import { logger } from "./logger.js";

// Kalshi's primary trading API — used for all authenticated (portfolio) endpoints.
// Market-data reads use api.elections.kalshi.com; that domain does not support auth'd writes.
const TRADING_BASE = "https://trading-api.kalshi.co/trade-api/v2";

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
        .slice(header.length, s.lastIndexOf(footer))
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

  const pem       = normalisePem(privateKey);
  const signature = createSign("SHA256").update(message).sign(pem, "base64");

  return {
    "KALSHI-ACCESS-KEY":       keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type":            "application/json",
    Accept:                    "application/json",
  };
}

// ─── Order placement ──────────────────────────────────────────────────────────

export interface KalshiOrderResult {
  order_id:     string;
  status:       string;   // "resting" | "filled" | "canceled" | "pending"
  ticker:       string;
  side:         string;
  yes_price?:   number;
  no_price?:    number;
  count:        number;
  filled_count?: number;
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

  const apiPath = "/trade-api/v2/portfolio/orders";

  const body = {
    ticker,
    action: "buy",
    type:   "limit",
    count,
    ...(side === "YES"
      ? { side: "yes", yes_price: limitPriceCents }
      : { side: "no",  no_price:  limitPriceCents }),
  };

  const headers = buildSignatureHeaders(keyId, privateKey, "POST", apiPath);

  logger.info({ ticker, side, limitPriceCents, count }, "Placing Kalshi order");

  const resp = await fetch(`${TRADING_BASE}/portfolio/orders`, {
    method:  "POST",
    headers,
    body:    JSON.stringify(body),
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `Kalshi order placement failed: HTTP ${resp.status} — ${text.slice(0, 400)}`
    );
  }

  const json = JSON.parse(text) as { order: KalshiOrderResult };
  logger.info(
    { ticker, side, limitPriceCents, orderId: json.order.order_id, status: json.order.status },
    "Kalshi order placed successfully"
  );

  return json.order;
}

/** True when we should attempt real Kalshi order placement (i.e. not running in dev). */
export function kalshiLiveOrdersEnabled(): boolean {
  return process.env["NODE_ENV"] !== "development";
}
