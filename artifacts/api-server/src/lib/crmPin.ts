import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";

const COOKIE = "crm_pin_session";
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
type Config = { pin?: string; signingSecret?: string };
const config = (): Config => ({ pin: process.env.CRM_PIN, signingSecret: process.env.SESSION_SECRET });

// Sessions survive restarts and publishes. Changing either secret invalidates them.
export function createCrmPinAuth(getConfig: () => Config = config) {
  const attempts = new Map<string, { count: number; until: number }>();
  const signingKey = () => {
    const { pin, signingSecret } = getConfig();
    return pin && signingSecret ? createHmac("sha256", signingSecret).update(`crm-pin:${pin}`).digest() : null;
  };
  const sign = (payload: string, key: Buffer) => createHmac("sha256", key).update(payload).digest("base64url");
  const validSession = (req: Request) => {
    const key = signingKey();
    const token: unknown = req.cookies?.[COOKIE];
    if (!key || typeof token !== "string" || token.length > 256) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [expires, nonce, signature] = parts;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry <= Date.now() || expiry > Date.now() + LIFETIME_MS || !/^[a-f0-9]{48}$/.test(nonce)) return false;
    const expected = Buffer.from(sign(`${expires}.${nonce}`, key));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const cookieOptions = (req: Request) => ({
    httpOnly: true, sameSite: "strict" as const, secure: req.secure || process.env.NODE_ENV === "production", path: "/api",
  });
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    const host = (req.get("x-forwarded-host") ?? req.get("host"))?.split(",")[0].trim();
    try {
      if (!origin || new URL(origin).host !== host) {
        res.status(403).json({ error: "Same-origin request required" }); return;
      }
    } catch {
      res.status(403).json({ error: "Same-origin request required" }); return;
    }
    next();
  };
  const requirePin = (req: Request, res: Response, next: NextFunction) => {
    if (!validSession(req)) { res.status(401).json({ error: "PIN login required" }); return; }
    if (!["GET", "HEAD"].includes(req.method)) { sameOrigin(req, res, next); return; }
    next();
  };
  const router = Router();
  router.get("/", (req, res) => res.json({ signed_in: validSession(req), configured: !!signingKey() }));
  router.post("/", sameOrigin, (req, res) => {
    const { pin } = getConfig();
    const key = signingKey();
    if (!pin || !key) { res.status(503).json({ error: "CRM PIN login is not configured" }); return; }
    const now = Date.now();
    for (const [ip, item] of attempts) if (item.until <= now) attempts.delete(ip);
    const ip = req.ip ?? "unknown";
    const entry = attempts.get(ip) ?? { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 10 || (attempts.size >= 10000 && !attempts.has(ip))) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
      res.status(429).json({ error: "Too many PIN attempts. Try again in 15 minutes." }); return;
    }
    entry.count++;
    attempts.set(ip, entry);
    const supplied = req.body?.pin;
    if (typeof supplied !== "string" || supplied.length > 128 ||
        !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(pin).digest())) {
      res.status(401).json({ error: "Incorrect PIN" }); return;
    }
    attempts.delete(ip);
    const payload = `${now + LIFETIME_MS}.${randomBytes(24).toString("hex")}`;
    res.cookie(COOKIE, `${payload}.${sign(payload, key)}`, { ...cookieOptions(req), maxAge: LIFETIME_MS });
    res.json({ signed_in: true, configured: true });
  });
  router.delete("/", sameOrigin, (req, res) => {
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ signed_in: false, configured: !!signingKey() });
  });
  return { router, requirePin };
}
