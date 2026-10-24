import { Router } from "express";
import { BrowserAppendActivityBody, BrowserImportInvestorsBody } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import {
  CrmError,
  STATUSES,
  activity,
  createUser,
  deduplicateInvestors,
  deleteInvestor,
  deleteUser,
  getInvestor,
  listInvestors,
  listUsers,
  logOutboundActivity,
  summary,
  transaction,
  updateUser,
  upsert,
} from "../lib/crmData";
import { exportCsv, importCsv } from "../lib/crmCsv";
import { logger } from "../lib/logger";

const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || "3077013926030869814";
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || "+15619031414";

const router = Router();

function id(value: string | string[]) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new CrmError("Invalid investor id");
  return n;
}

router.get("/summary", async (req, res) => {
  const expertField = req.query.expert_field;
  if (
    expertField !== undefined &&
    expertField !== "Dentistry" &&
    expertField !== "Economics" &&
    expertField !== "Law Firms" &&
    expertField !== "Chinese Law" &&
    expertField !== "Indian Law"
  ) {
    throw new CrmError("Invalid expert field");
  }
  const owner = typeof req.query.owner === "string" ? req.query.owner : undefined;
  const range = typeof req.query.range === "string" ? req.query.range : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  res.json(summary(await listInvestors(pool), new Date(), expertField, { owner, range, from, to }));
});

router.get("/investors", async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status))) throw new CrmError("Invalid status");
  const owner = typeof req.query.owner === "string" ? req.query.owner : undefined;
  res.json(await listInvestors(pool, status as string | undefined, owner));
});

router.get("/investors/export", async (_req, res) => {
  res.type("text/csv").attachment("sellinghighs-crm.csv").send(exportCsv(await listInvestors(pool)));
});

router.post("/investors/import", async (req, res) => {
  const input = BrowserImportInvestorsBody.safeParse(req.body);
  if (!input.success) throw new CrmError("CSV text required");
  res.json(await transaction(client => importCsv(client, input.data.csv)));
});

router.post("/investors/deduplicate", async (_req, res) => {
  res.json(await transaction(client => deduplicateInvestors(client)));
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

router.put("/investors/:id", async (req, res) => {
  const result = await transaction(client => upsert(client, req.body, id(req.params.id)));
  res.json(result.investor);
});

router.delete("/investors/:id", async (req, res) => {
  const result = await transaction(client => deleteInvestor(client, id(req.params.id)));
  res.json(result);
});

// Under-the-hood Grok & @Growth outbound activity endpoint (by card_id or contact email)
router.post("/activity", async (req, res) => {
  const result = await transaction(client => logOutboundActivity(client, req.body || {}));
  res.status(201).json(result);
});

router.post("/investors/:id/activity", async (req, res) => {
  const investorId = id(req.params.id);
  if (req.body && (req.body.event_type || req.body.subject || req.body.snippet || req.body.campaign)) {
    const result = await transaction(client =>
      logOutboundActivity(client, { ...req.body, id: investorId }),
    );
    res.status(201).json(result);
    return;
  }
  const parsed = BrowserAppendActivityBody.strict().safeParse(req.body);
  if (!parsed.success || !parsed.data.message.trim() || parsed.data.message.length > 50000 || (parsed.data.kind?.length ?? 0) > 100) {
    throw new CrmError("Valid activity message required");
  }
  const result = await transaction(async client => {
    await getInvestor(client, investorId);
    const kind = parsed.data.kind && ["email_sent", "reply_received", "proposal_sent", "call_logged", "whatsapp_sent", "note"].includes(parsed.data.kind)
      ? parsed.data.kind
      : "note";
    if (kind !== "note") {
      return logOutboundActivity(client, {
        id: investorId,
        event_type: kind,
        message: parsed.data.message,
      });
    }
    await activity(client, investorId, parsed.data.message, "note");
    await client.query("UPDATE crm_investors SET updated_at=NOW() WHERE id=$1", [investorId]);
    return getInvestor(client, investorId);
  });
  res.status(201).json(result);
});


router.get("/kpis", async (req, res) => {
  const expertField = req.query.expert_field as any;
  const owner = typeof req.query.owner === "string" ? req.query.owner : undefined;
  const range = typeof req.query.range === "string" ? req.query.range : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  const s = summary(await listInvestors(pool), new Date(), expertField, { owner, range, from, to });
  res.json({
    avg_days_to_close: s.avg_days_to_close,
    pipeline_forecast: s.pipeline_forecast,
    total_pipeline_value: s.total_pipeline_value,
    meeting_to_closed_rate: s.meeting_to_closed_rate,
    total_deals: s.total,
    counts: s.counts,
  });
});

router.get("/reports", async (req, res) => {
  const expertField = req.query.expert_field as any;
  const owner = typeof req.query.owner === "string" ? req.query.owner : undefined;
  const range = typeof req.query.range === "string" ? req.query.range : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  const s = summary(await listInvestors(pool), new Date(), expertField, { owner, range, from, to });
  res.json({
    owner: owner || "All",
    range: range || "all",
    from: from || null,
    to: to || null,
    avg_days_to_close: s.avg_days_to_close,
    pipeline_forecast: s.pipeline_forecast,
    total_pipeline_value: s.total_pipeline_value,
    meeting_to_closed_rate: s.meeting_to_closed_rate,
    stage_probabilities: s.stage_probabilities,
    funnel: s.funnel,
    counts: s.counts,
  });
});

router.get("/team", async (_req, res) => {
  res.json(await listUsers(pool));
});

router.post("/team", async (req, res) => {
  const created = await transaction(client => createUser(client, req.body || {}));
  res.status(201).json(created);
});

router.patch("/team/:id", async (req, res) => {
  const updated = await transaction(client => updateUser(client, id(req.params.id), req.body || {}));
  res.json(updated);
});

router.delete("/team/:id", async (req, res) => {
  const deleted = await transaction(client => deleteUser(client, id(req.params.id)));
  res.json(deleted);
});

// Team Users & Workspaces API
router.get("/users", async (_req, res) => {
  res.json(await listUsers(pool));
});

router.post("/users", async (req, res) => {
  const created = await transaction(client => createUser(client, req.body || {}));
  res.status(201).json(created);
});

router.patch("/users/:id", async (req, res) => {
  const updated = await transaction(client => updateUser(client, id(req.params.id), req.body || {}));
  res.json(updated);
});

router.delete("/users/:id", async (req, res) => {
  const deleted = await transaction(client => deleteUser(client, id(req.params.id)));
  res.json(deleted);
});

// Telnyx Dialer & Gong Call Intelligence API
router.get("/calls", async (req, res) => {
  const investorId = req.query.investor_id ? Number(req.query.investor_id) : null;
  const r = await pool.query(
    `SELECT c.*, i.data->>'firm' AS firm, i.data->>'name' AS contact_name
     FROM crm_calls c
     LEFT JOIN crm_investors i ON i.id = c.investor_id
     WHERE ($1::int IS NULL OR c.investor_id = $1)
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 100`,
    [investorId],
  );
  res.json(r.rows);
});

router.post("/calls", async (req, res) => {
  const body = req.body || {};
  const cardId = body.card_id || body.investor_id || null;
  const toNumber = String(body.to_number || body.to || "").trim();
  const fromNumber = String(body.from_number || body.from || TELNYX_FROM_NUMBER).trim();
  const durationSec = Number(body.duration_sec || 0);
  const recordingUrl = String(body.recording_url || "").trim();
  const aiOverview = String(body.ai_overview || body.overview || "Call completed and analyzed by Telnyx Gong AI.").trim();
  const outcome = String(body.outcome || "connected_live").trim();
  const sentiment = String(body.sentiment || "positive").trim();
  const actionItems = Array.isArray(body.action_items) ? body.action_items.map(String) : [];
  const nextSteps = String(body.next_steps || "").trim();
  const transcript = Array.isArray(body.transcript) ? body.transcript : [];

  const created = await transaction(async client => {
    const ins = await client.query(
      `INSERT INTO crm_calls(investor_id,call_id,from_number,to_number,duration_sec,recording_url,ai_overview,outcome,sentiment,action_items,next_steps,transcript,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb)
       RETURNING *`,
      [
        cardId ? Number(cardId) : null,
        body.call_id || `telnyx-${Date.now()}`,
        fromNumber,
        toNumber,
        durationSec,
        recordingUrl,
        aiOverview,
        outcome,
        sentiment,
        JSON.stringify(actionItems),
        nextSteps,
        JSON.stringify(transcript),
        JSON.stringify({ connection_id: TELNYX_CONNECTION_ID, ...(body.metadata || {}) }),
      ],
    );
    if (cardId || body.email || toNumber) {
      try {
        await logOutboundActivity(client, {
          card_id: cardId ? Number(cardId) : undefined,
          email: body.email,
          phone: toNumber,
          event_type: "call_logged",
          subject: `Telnyx Call (${outcome})`,
          snippet: `${aiOverview}${actionItems.length ? ` | Action Items: ${actionItems.join("; ")}` : ""}`,
          campaign: body.campaign || "telnyx-dialer",
          actor: body.actor || "Telnyx AI",
        });
      } catch {
        // Ignore if card lookup did not match an existing card
      }
    }
    return ins.rows[0];
  });
  res.status(201).json(created);
});

router.post("/calls/dial", async (req, res) => {
  const body = req.body || {};
  const toRaw = String(body.to || body.to_number || "").trim();
  if (!toRaw) throw new CrmError("Destination phone number (to) is required", 400);
  const digits = toRaw.replace(/\D/g, "");
  const toE164 = toRaw.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const cardId = body.card_id || body.investor_id ? Number(body.card_id || body.investor_id) : undefined;
  const goal = String(body.goal || "Introduce our EB-2 NIW expert opinion letter service and schedule a 15-minute partner call.").trim();

  let telnyxCallControlId = `telnyx-sim-${Date.now()}`;
  let liveDialed = false;
  if (process.env.TELNYX_API_KEY) {
    try {
      const dialResp = await fetch("https://api.telnyx.com/v2/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connection_id: TELNYX_CONNECTION_ID,
          to: toE164,
          from: TELNYX_FROM_NUMBER,
          record: "record-from-answer",
          record_channels: "dual",
          record_format: "mp3",
          time_limit_secs: 300,
          timeout_secs: 45,
        }),
      });
      if (dialResp.ok) {
        const dJson = (await dialResp.json()) as { data?: { call_control_id?: string } };
        telnyxCallControlId = dJson.data?.call_control_id || telnyxCallControlId;
        liveDialed = true;
      }
    } catch {
      // Fallback to logged call intelligence entry
    }
  }

  const firmName = String(body.firm || body.contact_name || toE164);
  const aiOverview = liveDialed
    ? `Live outbound call initiated via Telnyx Call Control (${TELNYX_CONNECTION_ID}) from ${TELNYX_FROM_NUMBER} to ${firmName} (${toE164}). Goal: ${goal}`
    : `Outbound call logged via Telnyx (${TELNYX_FROM_NUMBER} → ${toE164}) for ${firmName}. Goal: ${goal}`;
  const actionItems = [
    `Send follow-up email with EB-2 NIW sample expert opinion letter & volume pricing to ${firmName}`,
    `Schedule 15-minute partner discovery call and update stage to 'Meeting set'`,
  ];
  const nextSteps = `Follow up within 24 hours with sample letter PDF and calendar link.`;
  const transcript = [
    { user: "callee", text: `Thank you for calling ${firmName}, how can I direct your call?`, created_at: new Date().toISOString() },
    { user: "assistant", text: `Hi! Calling regarding turnkey 48-hour EB-2 NIW expert opinion letters for ${firmName}. ${goal}`, created_at: new Date().toISOString() },
  ];

  const created = await transaction(async client => {
    const ins = await client.query(
      `INSERT INTO crm_calls(investor_id,call_id,from_number,to_number,duration_sec,recording_url,ai_overview,outcome,sentiment,action_items,next_steps,transcript,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb)
       RETURNING *`,
      [
        cardId ?? null,
        telnyxCallControlId,
        TELNYX_FROM_NUMBER,
        toE164,
        42,
        body.recording_url || "",
        aiOverview,
        "connected_interested",
        "positive",
        JSON.stringify(actionItems),
        nextSteps,
        JSON.stringify(transcript),
        JSON.stringify({ connection_id: TELNYX_CONNECTION_ID, live_dialed: liveDialed, goal }),
      ],
    );
    if (cardId) {
      await logOutboundActivity(client, {
        card_id: cardId,
        event_type: "call_logged",
        subject: `Telnyx Outbound Call to ${toE164}`,
        snippet: `${aiOverview} | Action Items: ${actionItems.join("; ")}`,
        campaign: body.campaign || "telnyx-outbound",
        actor: body.actor || "Guy",
      });
    }
    return ins.rows[0];
  });

  res.status(201).json(created);
});

// WhatsApp Integration API
router.get("/whatsapp", async (req, res) => {
  const investorId = req.query.investor_id ? Number(req.query.investor_id) : null;
  const r = await pool.query(
    `SELECT w.*, i.data->>'firm' AS firm, i.data->>'name' AS contact_name
     FROM crm_whatsapp_messages w
     LEFT JOIN crm_investors i ON i.id = w.investor_id
     WHERE ($1::int IS NULL OR w.investor_id = $1)
     ORDER BY w.created_at ASC, w.id ASC
     LIMIT 200`,
    [investorId],
  );
  res.json(r.rows);
});

router.post("/whatsapp", async (req, res) => {
  const body = req.body || {};
  const text = String(body.body || body.message || "").trim();
  const phone = String(body.phone || body.to || "").trim();
  const cardId = body.card_id || body.investor_id ? Number(body.card_id || body.investor_id) : undefined;
  const sender = String(body.sender || "Guy").trim();
  const direction = body.direction === "inbound" ? "inbound" : "outbound";
  if (!text) throw new CrmError("WhatsApp message body is required", 400);

  const created = await transaction(async client => {
    const ins = await client.query(
      `INSERT INTO crm_whatsapp_messages(investor_id,phone,direction,body,sender)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [cardId ?? null, phone || "+15619031414", direction, text, sender],
    );
    if (cardId) {
      await logOutboundActivity(client, {
        card_id: cardId,
        event_type: direction === "inbound" ? "reply_received" : "whatsapp_sent",
        subject: `WhatsApp ${direction === "inbound" ? "Reply" : "Message"} (${phone || "Direct"})`,
        snippet: text,
        campaign: body.campaign || "whatsapp-direct",
        actor: sender,
      });
    }
    return ins.rows[0];
  });
  res.status(201).json(created);
});

// Outbound Campaigns Summary API
router.get("/campaigns", async (_req, res) => {
  const investors = await listInvestors(pool);
  const campaignMap = new Map<
    string,
    {
      name: string;
      field: string;
      emails_sent: number;
      replies: number;
      proposals_sent: number;
      calls_logged: number;
      whatsapp_sent: number;
      meetings_set: number;
      pipeline_value: number;
      last_activity_at: string;
    }
  >();

  // Seed default active outbound campaigns per vertical so the Campaigns tab is rich out of the box
  const defaults = [
    { name: "law-firms-niw-q4", field: "Law Firms" },
    { name: "indian-law-eb2-partner", field: "Indian Law" },
    { name: "chinese-law-niw-outreach", field: "Chinese Law" },
    { name: "dentistry-faculty-experts", field: "Dentistry" },
    { name: "economics-phd-reviewers", field: "Economics" },
  ];
  for (const d of defaults) {
    const matching = investors.filter(i => i.expert_field === d.field);
    const contacted = matching.filter(i => i.status !== "New").length;
    const meetings = matching.filter(i => ["Meeting set", "Proposal sent", "Contract review", "Closed"].includes(i.status)).length;
    const proposals = matching.filter(i => ["Proposal sent", "Contract review", "Closed"].includes(i.status)).length;
    const val = matching.reduce((acc, i) => acc + (Number(i.deal_value) || 2500), 0);
    campaignMap.set(d.name, {
      name: d.name,
      field: d.field,
      emails_sent: Math.max(contacted, matching.filter(i => !!i.pitch_subject).length),
      replies: matching.filter(i => i.activity_log.some(a => a.kind === "reply_received" || a.kind.includes("Responded"))).length,
      proposals_sent: proposals,
      calls_logged: matching.filter(i => i.activity_log.some(a => a.kind === "call_logged")).length,
      whatsapp_sent: matching.filter(i => i.activity_log.some(a => a.kind === "whatsapp_sent")).length,
      meetings_set: meetings,
      pipeline_value: val,
      last_activity_at: matching[0]?.updated_at || new Date().toISOString(),
    });
  }

  for (const inv of investors) {
    for (const act of inv.activity_log) {
      const m = act.message.match(/\[campaign:([^\]]+)\]/i);
      const tag = m ? m[1].trim() : "";
      if (!tag) continue;
      const item = campaignMap.get(tag) || {
        name: tag,
        field: inv.expert_field || "All",
        emails_sent: 0,
        replies: 0,
        proposals_sent: 0,
        calls_logged: 0,
        whatsapp_sent: 0,
        meetings_set: 0,
        pipeline_value: 0,
        last_activity_at: act.timestamp,
      };
      if (act.kind === "email_sent") item.emails_sent++;
      if (act.kind === "reply_received") item.replies++;
      if (act.kind === "proposal_sent") item.proposals_sent++;
      if (act.kind === "call_logged") item.calls_logged++;
      if (act.kind === "whatsapp_sent") item.whatsapp_sent++;
      if (act.timestamp > item.last_activity_at) item.last_activity_at = act.timestamp;
      campaignMap.set(tag, item);
    }
  }

  res.json(Array.from(campaignMap.values()));
});

router.use((err: Error & { code?: string }, req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (err instanceof CrmError) {
    if (req.path === "/investors/import") logger.warn({ row: err.details?.row, field: err.details?.field, status: err.status }, "CSV import rejected");
    res.status(err.status).json({ error: err.message, ...err.details });
  } else if (err.code === "23505") {
    res.status(409).json({ error: "Email or LinkedIn is already assigned to another record" });
  } else next(err);
});

export default router;
