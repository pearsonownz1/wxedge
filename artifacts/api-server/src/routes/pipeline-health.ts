/**
 * Pipeline health route
 *   GET /api/pipeline-health
 *
 * Watchdog for the trading pipeline going dark: distinguishes a legitimately
 * quiet market from a systemically blocked signal engine using the
 * suppressed_reason mix in the signals table (shared logic in @workspace/db).
 */

import { Router, type IRouter } from "express";
import { computePipelineHealth } from "@workspace/db";
import { GetPipelineHealthResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/pipeline-health", async (_req, res) => {
  try {
    const health = await computePipelineHealth(24);
    res.json(GetPipelineHealthResponse.parse(health));
  } catch (err) {
    logger.error({ err }, "pipeline-health check failed");
    res.status(500).json({ error: "pipeline health check failed" });
  }
});

export default router;
