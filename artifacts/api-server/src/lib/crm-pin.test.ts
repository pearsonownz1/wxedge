import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { createCrmPinAuth } from "./crmPin";

test("PIN protects every CRM read/write alias and sessions persist, reject tampering, expire and rotate", async () => {
  let configured = { pin: "test-only-pin", signingSecret: "test-only-signing-key" };
  const auth = createCrmPinAuth(() => configured);
  const app = express();
  app.use(express.json(), cookieParser());
  app.use("/api/crm/session", auth.router);
  const crm = express.Router();
  crm.all(["/investors", "/investors/import", "/investors/export", "/investors/:id", "/investors/:id/activity", "/summary"], (_req, res) => res.json({ allowed: true }));
  app.use("/api/crm", auth.requirePin, crm);
  app.use(["/api/investors", "/api/summary"], auth.requirePin);
  app.use("/api", crm);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method = "GET", cookie = "", body?: unknown, origin = base) =>
    fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    const routes = [
      ["GET", "/investors"], ["GET", "/investors/export"], ["GET", "/investors/1"], ["GET", "/summary"],
      ["POST", "/investors/import"], ["POST", "/investors"], ["PATCH", "/investors/1"], ["POST", "/investors/1/activity"],
    ];
    for (const prefix of ["/api", "/api/crm"]) for (const [method, path] of routes) {
      assert.equal((await request(prefix + path, method)).status, 401, `${method} ${prefix}${path} requires PIN`);
    }
    assert.deepEqual(await (await request("/api/crm/session")).json(), { signed_in: false, configured: true });
    assert.equal((await request("/api/crm/session", "POST", "", { pin: "incorrect" })).status, 401);
    assert.equal((await request("/api/crm/session", "POST", "", { pin: configured.pin }, "https://other.test")).status, 403);
    const login = await request("/api/crm/session", "POST", "", { pin: configured.pin });
    assert.equal(login.status, 200);
    const rawCookie = login.headers.get("set-cookie")!;
    assert.match(rawCookie, /HttpOnly/);
    assert.match(rawCookie, /SameSite=Strict/);
    assert.match(rawCookie, /Max-Age=2592000/);
    assert.ok(!rawCookie.includes(configured.pin));
    const cookie = rawCookie.split(";")[0];
    for (const prefix of ["/api", "/api/crm"]) for (const [method, path] of routes) {
      assert.equal((await request(prefix + path, method, cookie)).status, 200, `${method} ${prefix}${path} works with PIN session`);
    }
    assert.deepEqual(await (await request("/api/crm/session", "GET", cookie)).json(), { signed_in: true, configured: true });
    assert.equal((await request("/api/crm/investors", "PATCH", cookie, {}, "https://other.test")).status, 403);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    assert.equal((await request("/api/crm/summary", "GET", tampered)).status, 401);
    const expired = cookie.replace(/=\d+\./, `=${Date.now() - 1}.`);
    assert.equal((await request("/api/crm/summary", "GET", expired)).status, 401);
    const freshAuth = createCrmPinAuth(() => configured);
    app.use("/restart", freshAuth.requirePin, (_req, res) => res.sendStatus(200));
    assert.equal((await request("/restart", "GET", cookie)).status, 200, "Session survives server auth instance restart");
    const logout = await request("/api/crm/session", "DELETE", cookie);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /Expires=Thu, 01 Jan 1970/);
    configured = { ...configured, pin: "rotated-test-pin" };
    assert.equal((await request("/api/crm/summary", "GET", cookie)).status, 401);
    for (let i = 0; i < 10; i++) assert.equal((await request("/api/crm/session", "POST", "", { pin: "wrong" })).status, 401);
    assert.equal((await request("/api/crm/session", "POST", "", { pin: configured.pin })).status, 429);
    configured = { pin: "", signingSecret: configured.signingSecret };
    assert.equal((await request("/api/crm/investors", "GET", cookie)).status, 401);
    assert.equal((await request("/api/crm/session", "POST", "", { pin: "anything" })).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
