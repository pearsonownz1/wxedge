import { Router } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import crmRouter from "./crm";
import contractsRouter from "./contracts";
import { createCrmPinAuth } from "../lib/crmPin";
import { verifyUserCredentials } from "../lib/crmData";
import { getWhatsAppConfig, handleMetaWebhookEvents } from "../lib/whatsappCloud";
import { logger } from "../lib/logger";

const router = Router();
const pinAuth = createCrmPinAuth(() => ({
  pin: process.env.CRM_PIN || "123456",
  signingSecret: process.env.SESSION_SECRET || process.env.SUPABASE_JWT_SECRET || "sellinghighs-crm-session-secret-2026",
  apiKey: process.env.CRM_API_KEY || process.env.GROK_API_KEY || "sellinghighs-grok-key-2026",
  verifyUser: verifyUserCredentials,
}));

const webhookPaths = ["/whatsapp/webhook", "/webhooks/whatsapp", "/crm/whatsapp/webhook"];

router.get(webhookPaths, (req, res) => {
  const mode = String(req.query["hub.mode"] || "").trim();
  const token = String(req.query["hub.verify_token"] || "").trim();
  const challenge = String(req.query["hub.challenge"] || "");
  const cfg = getWhatsAppConfig();
  if (mode === "subscribe" && token && token === cfg.verifyToken) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(403).json({ error: "Invalid verify token" });
});

router.post(webhookPaths, async (req, res) => {
  try {
    const result = await handleMetaWebhookEvents(req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "Failed processing Meta WhatsApp webhook event");
    res.status(200).json({ ok: false });
  }
});

router.use(healthRouter);
router.use(authRouter);
router.use("/crm/session", pinAuth.router);
router.use("/crm", pinAuth.requirePin, contractsRouter);
router.use("/crm", pinAuth.requirePin, crmRouter);
router.use(["/investors", "/summary", "/kpis", "/reports", "/activity", "/team", "/calls", "/campaigns", "/whatsapp"], pinAuth.requirePin);
router.use(crmRouter);
export default router;
