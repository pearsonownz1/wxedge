import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function isOwner(id: string | undefined): boolean {
  return !!process.env.CRM_OWNER_ID && id === process.env.CRM_OWNER_ID;
}
export function tokenMatches(header: string | undefined, token = process.env.CRM_API_TOKEN): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}
export function requireAssistantToken(req: Request, res: Response, next: NextFunction) {
  if (!tokenMatches(req.headers.authorization)) {
    res.status(401).json({ error: "Valid CRM API bearer token required" }); return;
  }
  next();
}
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({ error: "Log in required" }); return; }
  if (!isOwner(req.user.id)) { res.status(403).json({ error: "Project owner access only" }); return; }
  if (!["GET", "HEAD"].includes(req.method)) {
    const origin = req.headers.origin;
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    if (!origin || new URL(origin).host !== host) {
      res.status(403).json({ error: "Same-origin request required" }); return;
    }
  }
  next();
}
