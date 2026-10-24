import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";

const COOKIE = "crm_pin_session";
const USER_COOKIE = "crm_user_session";
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export type CrmSessionUser = { id: number; name: string; email: string; role: "admin" | "member" };
type Config = {
  pin?: string;
  signingSecret?: string;
  apiKey?: string;
  verifyUser?: (email: string, password: string) => Promise<CrmSessionUser | null>;
};
const config = (): Config => ({
  pin: process.env.CRM_PIN,
  signingSecret: process.env.SESSION_SECRET,
  apiKey: process.env.CRM_API_KEY,
});

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = createHmac("sha256", salt).update(password).digest("hex");
  return `${salt}:${hash}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  const actualHex = createHmac("sha256", salt).update(password).digest("hex");
  const a = Buffer.from(actualHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Sessions survive restarts and publishes. Changing either secret invalidates them.
export function createCrmPinAuth(getConfig: () => Config = config) {
  const attempts = new Map<string, { count: number; until: number }>();
  const signingKey = () => {
    const { pin, signingSecret } = getConfig();
    return pin && signingSecret ? createHmac("sha256", signingSecret).update(`crm-pin:${pin}`).digest() : null;
  };
  const userSigningKey = () => {
    const { pin, signingSecret } = getConfig();
    const secret = signingSecret || pin || "sellinghighs-default-secret";
    return createHmac("sha256", secret).update("crm-user-session").digest();
  };
  const sign = (payload: string, key: Buffer) => createHmac("sha256", key).update(payload).digest("base64url");

  const validPinCookie = (req: Request) => {
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

  const getSessionUser = (req: Request): CrmSessionUser | null => {
    const token: unknown = req.cookies?.[USER_COOKIE];
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [expires, encodedUser, signature] = parts;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry <= Date.now() || expiry > Date.now() + LIFETIME_MS) return null;
    const key = userSigningKey();
    const expected = Buffer.from(sign(`${expires}.${encodedUser}`, key));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      return JSON.parse(Buffer.from(encodedUser, "base64url").toString("utf8")) as CrmSessionUser;
    } catch {
      return null;
    }
  };

  const validBearerOrApiKey = (req: Request): boolean => {
    const { pin, apiKey } = getConfig();
    const authHeader = req.get("authorization") ?? "";
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const grokKey = (req.get("x-grok-api-key") ?? "").trim();
    const candidate = bearer || grokKey;
    if (!candidate) return false;
    for (const secret of [apiKey, pin].filter((x): x is string => !!x && x.length > 0)) {
      const a = createHash("sha256").update(candidate).digest();
      const b = createHash("sha256").update(secret).digest();
      if (timingSafeEqual(a, b)) return true;
    }
    return false;
  };

  const validSession = (req: Request) => validPinCookie(req) || !!getSessionUser(req) || validBearerOrApiKey(req);

  const cookieOptions = (req: Request) => ({
    httpOnly: true, sameSite: "strict" as const, secure: req.secure || process.env.NODE_ENV === "production", path: "/api",
  });
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (validBearerOrApiKey(req)) { next(); return; }
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
  router.get("/", (req, res) => {
    const user = getSessionUser(req);
    const base = { signed_in: validSession(req), configured: !!signingKey() };
    if (user) {
      res.json({ ...base, user });
      return;
    }
    res.json(base);
  });
  router.post("/", sameOrigin, async (req, res) => {
    const { pin, verifyUser } = getConfig();
    const key = signingKey();
    const now = Date.now();
    const emailInput = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const passwordInput = typeof req.body?.password === "string" ? req.body.password : "";
    if (!emailInput && (!pin || !key)) {
      res.status(503).json({ error: "CRM PIN login is not configured" }); return;
    }
    for (const [ip, item] of attempts) if (item.until <= now) attempts.delete(ip);
    const ip = req.ip ?? "unknown";
    const entry = attempts.get(ip) ?? { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 10 || (attempts.size >= 10000 && !attempts.has(ip))) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
      res.status(429).json({ error: "Too many PIN attempts. Try again in 15 minutes." }); return;
    }

    // 1. Real User Email + Password Login
    if (emailInput && passwordInput && verifyUser) {
      entry.count++;
      attempts.set(ip, entry);
      const user = await verifyUser(emailInput, passwordInput);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password" }); return;
      }
      attempts.delete(ip);
      const encodedUser = Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
      const userPayload = `${now + LIFETIME_MS}.${encodedUser}`;
      const uKey = userSigningKey();
      res.cookie(USER_COOKIE, `${userPayload}.${sign(userPayload, uKey)}`, { ...cookieOptions(req), maxAge: LIFETIME_MS });
      if (key) {
        const pinPayload = `${now + LIFETIME_MS}.${randomBytes(24).toString("hex")}`;
        res.cookie(COOKIE, `${pinPayload}.${sign(pinPayload, key)}`, { ...cookieOptions(req), maxAge: LIFETIME_MS });
      }
      res.json({ signed_in: true, configured: true, user });
      return;
    }

    // 2. PIN Login
    if (!pin || !key) { res.status(503).json({ error: "CRM PIN login is not configured" }); return; }
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
    res.clearCookie(USER_COOKIE, cookieOptions(req));
    res.json({ signed_in: false, configured: !!signingKey() });
  });
  return { router, requirePin, getSessionUser };
}
