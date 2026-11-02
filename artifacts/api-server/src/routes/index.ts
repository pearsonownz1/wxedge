import { Router } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import crmRouter from "./crm";
import { createCrmPinAuth, crmAuthConfigFromEnv } from "../lib/crmPin";
import { verifyUserCredentials } from "../lib/crmData";
import outlookRouter from "./outlook";

const router = Router();
const pinAuth = createCrmPinAuth(() => ({
  ...crmAuthConfigFromEnv(),
  verifyUser: verifyUserCredentials,
}));

router.use(healthRouter);
router.use(authRouter);
router.use("/integrations/outlook", outlookRouter);
router.use("/crm/session", pinAuth.router);
router.use("/crm", pinAuth.requirePin, crmRouter);
router.use(["/investors", "/summary", "/kpis", "/reports", "/activity", "/team", "/calls", "/campaigns", "/whatsapp"], pinAuth.requirePin);
router.use(crmRouter);
export default router;
