import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import stationsRouter from "./stations.js";
import marketsRouter from "./markets.js";
import snapshotsRouter from "./snapshots.js";
import approvalsRouter from "./approvals.js";
import pipelineHealthRouter from "./pipeline-health.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stationsRouter);
router.use(marketsRouter);
router.use(snapshotsRouter);
router.use(approvalsRouter);
router.use(pipelineHealthRouter);

export default router;
