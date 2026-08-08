---
name: Kalshi RSA signing key format
description: The KALSHI_PRIVATE_KEY secret is PKCS1 with spaces instead of newlines — normalisePem must re-wrap base64, not just substitute \n.
---

# Kalshi RSA Signing Key Format

## The Rule
`KALSHI_PRIVATE_KEY` on Replit is stored as a PKCS1 PEM (`-----BEGIN RSA PRIVATE KEY-----`) with **space-separated base64 lines** instead of real newlines. Node's crypto stack rejects it with `error:1E08010C:DECODER routines::unsupported` unless re-wrapped.

**Why:** Replit secrets cannot store real newlines; the secret was pasted with the header/footer intact but spaces between base64 chunks.

## How to apply
`normalisePem()` in `artifacts/api-server/src/lib/kalshiOrderApi.ts` must:
1. Replace literal `\n` escapes with real newlines (for other formats)
2. If a `-----BEGIN ... -----` header is present, **extract the base64 body, strip ALL whitespace, and re-wrap at 64 chars/line**
3. If no header, wrap raw base64 as `-----BEGIN PRIVATE KEY-----` (PKCS8 fallback)

The key is PKCS1 (RSA), not PKCS8.

## CRITICAL: RSA-PSS Required (NOT PKCS1 v1.5)
Kalshi v2 uses **RSA-PSS**, not the old `createSign("SHA256").sign(pem)` (PKCS1 v1.5).
The old `/portfolio/orders` endpoint never checked auth (returned 410 immediately), so PKCS1 v1.5 was never caught. The v2 `/portfolio/events/orders` does check → INCORRECT_API_KEY_SIGNATURE.

Correct signing (Node.js):
```js
const pk = createPrivateKey({ key: pem });
cryptoSign("sha256", Buffer.from(message), {
  key: pk,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
}).toString("base64");
```

See kalshi-order-api-v2.md for full request format details.
