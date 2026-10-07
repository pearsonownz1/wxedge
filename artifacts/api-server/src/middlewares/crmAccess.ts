import type { Request, Response, NextFunction } from "express";

export function isOwner(id: string | undefined): boolean {
  return !!process.env.CRM_OWNER_ID && id === process.env.CRM_OWNER_ID;
}
export function publicReadsOwnerWrites(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD"].includes(req.method)) { next(); return; }
  requireOwner(req, res, next);
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
