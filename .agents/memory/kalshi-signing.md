---
name: Kalshi RSA signing key format
description: Kalshi requires an RSA key and RSA-PSS SHA-256; PEM normalization alone does not establish signing compatibility.
---

# Kalshi RSA Signing Key Format

## The Rule
Kalshi requires an RSA-compatible key, regardless of whether a stored PEM parses successfully. Do not assume the current credential has the algorithm or format used in an earlier session. An Ed25519 key cannot satisfy RSA-PSS SHA-256.

**Why:** A key parsed successfully but signing failed with `ERR_OSSL_INVALID_DIGEST`; it was a non-RSA key. Separately, historical RSA PEM values arrived with space-separated base64 lines and needed re-wrapping.

## How to apply
`normalisePem()` in `artifacts/api-server/src/lib/kalshiOrderApi.ts` must:
1. Replace literal `\n` escapes with real newlines (for other formats)
2. If a `-----BEGIN ... -----` header is present, **extract the base64 body, strip ALL whitespace, and re-wrap at 64 chars/line**
3. If no header, wrap raw base64 as `-----BEGIN PRIVATE KEY-----` (PKCS8 fallback)

Validate RSA-PSS SHA-256 signing compatibility, not just PEM parsing, before reserving a submission intent. Support RSA PEM in PKCS1 or PKCS8 rather than assuming one current format. Never change credentials or substitute another signing algorithm without the user's authorization.

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
