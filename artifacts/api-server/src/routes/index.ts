import { Router } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import crmRouter from "./crm";
import { createCrmPinAuth } from "../lib/crmPin";
import { verifyUserCredentials } from "../lib/crmData";

const router = Router();
const pinAuth = createCrmPinAuth(() => ({
  pin: process.env.CRM_PIN || "123456",
  signingSecret: process.env.SESSION_SECRET || process.env.SUPABASE_JWT_SECRET || "sellinghighs-crm-session-secret-2026",
  apiKey: process.env.CRM_API_KEY || process.env.GROK_API_KEY || "sellinghighs-grok-key-2026",
  verifyUser: verifyUserCredentials,
}));

router.use(healthRouter);
router.use(authRouter);
router.use("/crm/session", pinAuth.router);
router.use("/crm", pinAuth.requirePin, crmRouter);
router.use(["/investors", "/summary", "/kpis", "/reports", "/activity", "/team", "/calls", "/campaigns", "/whatsapp"], pinAuth.requirePin);
router.use(crmRouter);
export default router;
