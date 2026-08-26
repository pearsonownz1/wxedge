import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import stationsRouter from "./stations.js";
import marketsRouter from "./markets.js";
import snapshotsRouter from "./snapshots.js";
import approvalsRouter from "./approvals.js";
import pipelineHealthRouter from "./pipeline-health.js";
import dashboardRouter from "./dashboard.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stationsRouter);
router.use(marketsRouter);
router.use(snapshotsRouter);
router.use(approvalsRouter);
router.use(pipelineHealthRouter);
router.use(dashboardRouter);

export default router;
