import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  OutlookError,
  buildSendMailBody,
  cleanAttachments,
  createPkce,
  cronAuthorized,
  decryptSecret,
  encryptSecret,
  eventIncludes,
  htmlToText,
  messageFromGraph,
  parseAddressList,
  parseEncryptionKey,
  participantBlob,
  shouldAutoCreateSender,
  toHtmlBody,
} from "./outlookLogic";

const key = parseEncryptionKey(Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));

test("token encryption round-trips and rejects a different key", () => {
  const stored = encryptSecret("refresh-token-value", key);
  assert.equal(decryptSecret(stored, key), "refresh-token-value");
  assert.throws(() => decryptSecret(stored, parseEncryptionKey("aa".repeat(32))));
  assert.throws(() => parseEncryptionKey("short"));
  assert.equal(parseEncryptionKey("ab".repeat(32)).length, 32);
});

test("pkce challenge is the S256 digest of the verifier", () => {
  const { verifier, challenge } = createPkce();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.ok(verifier.length >= 43);
});

test("addresses, html, and auto-create stay conservative", () => {
  assert.deepEqual(parseAddressList("A@Example.com, a@example.com"), ["a@example.com"]);
  assert.throws(() => parseAddressList("not-an-email"), OutlookError);
  assert.equal(toHtmlBody("Hello\nthere"), "Hello<br>there");
  assert.equal(htmlToText("<p>Hi <b>there</b></p>"), "Hi there");
  assert.equal(shouldAutoCreateSender({ enabled: false, sender: "a@b.com", selfEmail: "me@b.com", alreadyExists: false }), false);
  assert.equal(shouldAutoCreateSender({ enabled: true, sender: "noreply@b.com", selfEmail: "me@b.com", alreadyExists: false }), false);
  assert.equal(shouldAutoCreateSender({ enabled: true, sender: "me@b.com", selfEmail: "me@b.com", alreadyExists: false }), false);
  assert.equal(shouldAutoCreateSender({ enabled: true, sender: "ada@firm.com", selfEmail: "me@b.com", alreadyExists: true }), false);
  assert.equal(shouldAutoCreateSender({ enabled: true, sender: "ada@firm.com", selfEmail: "me@b.com", alreadyExists: false }), true);
});

test("send payload is explicit and delta rows mark removals", () => {
  const payload = buildSendMailBody({ to: ["a@b.com"], subject: "Hello", html: "<p>Hi</p>" });
  assert.equal(payload.saveToSentItems, true);
  assert.equal(payload.message.toRecipients[0].emailAddress.address, "a@b.com");
  assert.equal(payload.message.attachments.length, 0);
  const removed = messageFromGraph({ id: "abc", "@removed": { reason: "deleted" } }, "inbox");
  assert.equal(removed?.removed, true);
  const kept = messageFromGraph({
    id: "m1",
    subject: "Intro",
    from: { emailAddress: { address: "Ada@Firm.com", name: "Ada" } },
    toRecipients: [{ emailAddress: { address: "guy@gcs.org" } }],
    bodyPreview: "Hello",
  }, "inbox");
  assert.equal(kept?.fromEmail, "ada@firm.com");
  assert.equal(kept?.participants, ",ada@firm.com,guy@gcs.org,");
  assert.equal(eventIncludes(participantBlob(["ada@firm.com", "guy@gcs.org"]), ["guy@gcs.org"]), true);
  assert.equal(eventIncludes(participantBlob(["ada@firm.com"]), ["other@firm.com"]), false);
  assert.throws(() => cleanAttachments([{ name: "x.txt", contentBytes: "@@@@" }]));
});

test("cron auth requires a long shared secret", () => {
  assert.equal(cronAuthorized("Bearer secret-value-123456", "secret-value-123456"), true);
  assert.equal(cronAuthorized("Bearer secret-value-123456", "different-value-1234"), false);
  assert.equal(cronAuthorized(undefined, "secret-value-123456"), false);
  assert.equal(cronAuthorized("Bearer secret-value-123456", "short"), false);
});

test("mailbox sync never calls Graph send", () => {
  const sync = readFileSync(new URL("./outlookGraph.ts", import.meta.url), "utf8");
  const send = readFileSync(new URL("./outlookSend.ts", import.meta.url), "utf8");
  assert.equal(sync.includes("sendMail"), false);
  assert.equal(sync.includes("createReply"), false);
  assert.equal(sync.includes("createForward"), false);
  assert.equal(send.includes("/me/sendMail"), true);
  assert.equal(send.includes("createReply"), true);
  assert.equal(send.includes("createForward"), true);
});
