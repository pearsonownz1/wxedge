import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { assertKalshiSigningReady } from "./kalshiOrderApi.js";

test("RSA-PSS SHA-256 preflight works with ordinary, space-separated and wrapped PEM", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  assert.doesNotThrow(() => assertKalshiSigningReady("test-key-id", pem));
  assert.doesNotThrow(() => assertKalshiSigningReady("test-key-id", pem.replace(/\n/g, " ")));
  assert.doesNotThrow(() => assertKalshiSigningReady("test-key-id", `"${pem}"`));
});

test("non-RSA, malformed and absent credentials fail before an order intent or HTTP request", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => assertKalshiSigningReady("test-key-id", pem), /requires an RSA key/);
  assert.throws(() => assertKalshiSigningReady("test-key-id", "not-a-key"));
  assert.throws(() => assertKalshiSigningReady(undefined, pem), /unavailable/);
  assert.throws(() => assertKalshiSigningReady("test-key-id", undefined), /unavailable/);
});
