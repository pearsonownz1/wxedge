import { Router } from "express";
import { BrowserAppendActivityBody, BrowserImportInvestorsBody } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { CrmError, STATUSES, activity, getInvestor, listInvestors, summary, transaction, upsert } from "../lib/crmData";
import { exportCsv, importCsv } from "../lib/crmCsv";
import { logger } from "../lib/logger";
const router = Router();
function id(value: string | string[]) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new CrmError("Invalid investor id");
  return n;
}
router.get("/summary", async (req, res) => {
  const expertField = req.query.expert_field;
  if (expertField !== undefined && expertField !== "Dentistry" && expertField !== "Economics" && expertField !== "Law Firms" && expertField !== "Chinese Law") throw new CrmError("Invalid expert field");
  res.json(summary(await listInvestors(pool), new Date(), expertField));
});
router.get("/investors", async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status))) throw new CrmError("Invalid status");
  res.json(await listInvestors(pool, status as string | undefined));
});
router.get("/investors/export", async (_req, res) => {
  res.type("text/csv").attachment("notara-investors.csv").send(exportCsv(await listInvestors(pool)));
});
router.post("/investors/import", async (req, res) => {
  const input = BrowserImportInvestorsBody.safeParse(req.body);
  if (!input.success) throw new CrmError("CSV text required");
  res.json(await transaction(client => importCsv(client, input.data.csv)));
});
router.post("/investors", async (req, res) => {
  const result = await transaction(client => upsert(client, req.body));
  res.status(result.created ? 201 : 200).json(result.investor);
});
router.get("/investors/:id", async (req, res) => res.json(await getInvestor(pool, id(req.params.id))));
router.patch("/investors/:id", async (req, res) => {
  const result = await transaction(client => upsert(client, req.body, id(req.params.id)));
  res.json(result.investor);
});
router.post("/investors/:id/activity", async (req, res) => {
  const parsed = BrowserAppendActivityBody.strict().safeParse(req.body);
  if (!parsed.success || !parsed.data.message.trim() || parsed.data.message.length > 50000 || (parsed.data.kind?.length ?? 0) > 100) throw new CrmError("Valid activity message required");
  const result = await transaction(async client => {
    const investorId = id(req.params.id);
    await getInvestor(client, investorId);
    // Clients cannot forge system status events used by summary metrics.
    await activity(client, investorId, parsed.data.message, "note");
    await client.query("UPDATE crm_investors SET updated_at=NOW() WHERE id=$1", [investorId]);
    return getInvestor(client, investorId);
  });
  res.status(201).json(result);
});
router.use((err: Error & { code?: string }, req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (err instanceof CrmError) {
    // Log location only, never the uploaded record's private data or pitch content.
    if (req.path === "/investors/import") logger.warn({ row: err.details?.row, field: err.details?.field, status: err.status }, "CSV import rejected");
    res.status(err.status).json({ error: err.message, ...err.details });
  }
  else if (err.code === "23505") res.status(409).json({ error: "Email or LinkedIn is already assigned to another investor" });
  else next(err);
});
export default router;
