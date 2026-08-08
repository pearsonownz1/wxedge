---
name: Kalshi Order API v2
description: All confirmed field formats and endpoint details for placing live orders on Kalshi via the v2 API — discovered iteratively by probing the live API.
---

# Kalshi Order API v2 — Confirmed Format

## Endpoint
`POST https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders`

(Old deprecated path `/portfolio/orders` returns HTTP 410. `/markets/{ticker}/orders` returns 404.)

## Auth
- RSA-PSS SHA-256 (NOT PKCS1 v1.5!)
- Use Node.js: `cryptoSign("sha256", Buffer.from(msg), { key: pk, padding: RSA_PKCS1_PSS_PADDING, saltLength: RSA_PSS_SALTLEN_DIGEST })`
- Message: `timestampMs + METHOD.toUpperCase() + apiPath`
- Headers: `KALSHI-ACCESS-KEY` (= KALSHI_KEY_ID), `KALSHI-ACCESS-TIMESTAMP` (ms), `KALSHI-ACCESS-SIGNATURE` (base64)

## Request Body (all fields required)
```json
{
  "ticker": "KXHIGHAUS-26AUG08-B97.5",
  "action": "buy",
  "type": "limit",
  "count": "1",                              // STRING, not number
  "side": "bid",                             // "bid" = buy YES, "ask" = sell YES (= buy NO)
  "price": "0.37",                           // decimal dollar string (cents/100), 2 decimal places
  "time_in_force": "good_till_canceled",     // NOT "GTC"
  "self_trade_prevention_type": "taker_at_cross"  // NOT "cancel_resting" or any other value
}
```

### Side + Price mapping for our use case (always buying):
- **Buy YES**: `side: "bid"`, `price: String((limitPriceCents / 100).toFixed(2))`
- **Buy NO**: `side: "ask"`, `price: String(((100 - limitPriceCents) / 100).toFixed(2))`

## Response (HTTP 201, flat — NOT nested in `{ order: ... }`)
```json
{
  "fill_count": "0.00",
  "order_id": "uuid-string",
  "remaining_count": "1.00",
  "ts_ms": 1786209490564
}
```
- `fill_count = "1.00"` + `remaining_count = "0.00"` → order was immediately filled (taker)
- Otherwise → order is resting (maker)

## Cancel (v2)
`DELETE https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders/{order_id}`
Returns 200 with `{"order_id":"...","reduced_by":"1.00","ts_ms":...}`
(Old `DELETE /portfolio/orders/{id}` returns 410)

## Portfolio Reads (v1, still working)
- Balance: `GET /portfolio/balance` → `{balance: cents_int, balance_dollars: "string"}`
- Orders: `GET /portfolio/orders?limit=N` → `{orders: [{order_id, yes_price_dollars, no_price_dollars, status, fill_count_fp, ...}]}`
- Fills: `GET /portfolio/fills?limit=N`

**Why:** Discovered iteratively from HTTP 400/401/429 errors; no public OpenAPI spec available.

**How to apply:** Any code placing Kalshi orders must use exactly these field names/formats. The old `/portfolio/orders` POST is deprecated. RSA-PSS is non-negotiable — PKCS1 v1.5 gets INCORRECT_API_KEY_SIGNATURE.
