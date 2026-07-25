/**
 * Snapshot routes
 *   GET /api/snapshots/:stationId        — recent raw snapshot rows for one station
 *   GET /api/snapshots/reliability       — calibration curve (all stations, closed days)
 */

import { Router, type IRouter } from "express";
import { getRecentSnapshots, getCalibrationRows } from "../lib/db.js";
import { isStation } from "../lib/stations.js";

const router: IRouter = Router();

router.get("/snapshots/reliability", async (_req, res): Promise<void> => {
  try {
    const rows = await getCalibrationRows();
    res.json({ rows, rowCount: rows.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to query calibration data", detail: String(err) });
  }
});

router.get("/snapshots/:stationId", async (req, res): Promise<void> => {
  const { stationId } = req.params;
  if (!isStation(stationId)) {
    res.status(404).json({ error: `Unknown station: ${stationId}` });
    return;
  }
  const limit = Math.min(Number(req.query["limit"] ?? 200), 2000);
  try {
    const rows = await getRecentSnapshots(stationId, limit);
    res.json({ stationId, rows, rowCount: rows.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to query snapshots", detail: String(err) });
  }
});

export default router;
