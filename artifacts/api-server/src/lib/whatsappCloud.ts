import { pool } from "@workspace/db";
import { CrmError, logOutboundActivity, transaction, type Client } from "./crmData";
import { logger } from "./logger";

const GRAPH_VERSION = "v22.0";

export function getWhatsAppConfig() {
  const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "1456028954250856").trim();
  const businessAccountId = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "1114165708261816").trim();
  const appId = (process.env.WHATSAPP_APP_ID || "4523049234602869").trim();
  const fromNumber = (process.env.WHATSAPP_FROM_NUMBER || "+1 555-157-8377").trim();
  const verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN || "gcs_whatsapp_verify_2026").trim();

  return {
    accessToken,
    phoneNumberId,
    businessAccountId,
    appId,
    fromNumber,
    verifyToken,
    configured: Boolean(accessToken && phoneNumberId),
  };
}

export function normalizeWhatsAppDigits(rawPhone: string): string {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

export function formatE164Phone(rawPhone: string): string {
  const digits = normalizeWhatsAppDigits(rawPhone);
  return digits ? `+${digits}` : String(rawPhone || "").trim();
}

let schemaMigrated = false;

export async function ensureWhatsAppSchema(client: Client = pool) {
  if (schemaMigrated) return;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_whatsapp_messages (
        id SERIAL PRIMARY KEY,
        investor_id INTEGER REFERENCES crm_investors(id) ON DELETE SET NULL,
        phone TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'outbound',
        body TEXT NOT NULL,
        sender TEXT NOT NULL DEFAULT 'Guy',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE crm_whatsapp_messages ADD COLUMN IF NOT EXISTS wa_message_id TEXT;
      ALTER TABLE crm_whatsapp_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';
      ALTER TABLE crm_whatsapp_messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
      ALTER TABLE crm_whatsapp_messages ADD COLUMN IF NOT EXISTS template_name TEXT;
      ALTER TABLE crm_whatsapp_messages ADD COLUMN IF NOT EXISTS error_message TEXT;
      ALTER TABLE crm_whatsapp_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
    schemaMigrated = true;
  } catch (err) {
    logger.warn({ err }, "Could not run ensureWhatsAppSchema");
  }
}

export async function findInvestorIdByPhone(client: Client, rawPhone: string): Promise<number | null> {
  const digits = normalizeWhatsAppDigits(rawPhone);
  const last10 = digits.slice(-10);
  if (last10.length < 7) return null;
  try {
    const r = await client.query(
      `SELECT id FROM crm_investors
       WHERE regexp_replace(coalesce(data->>'phone','') || ' ' || coalesce(data->>'notes',''), '[^0-9]', '', 'g') LIKE $1
       ORDER BY id ASC LIMIT 1`,
      [`%${last10}%`],
    );
    if (r.rows[0]?.id) return Number(r.rows[0].id);
  } catch {
    // ignore lookup failure
  }
  return null;
}

export interface WhatsAppTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
}

export interface WhatsAppTemplateItem {
  id: string;
  name: string;
  status: string;
  language: string;
  category: string;
  components?: WhatsAppTemplateComponent[];
}

export async function fetchMetaPhoneStatus() {
  const cfg = getWhatsAppConfig();
  const baseStatus = {
    configured: cfg.configured,
    app_id: cfg.appId,
    phone_number_id: cfg.phoneNumberId,
    business_account_id: cfg.businessAccountId,
    display_phone_number: cfg.fromNumber,
    verified_name: "Test Number",
    quality_rating: "UNKNOWN",
    code_verification_status: "UNKNOWN",
    name_status: "UNKNOWN",
    webhook_url: "https://crm.gcs.org/api/whatsapp/webhook",
    verify_token: cfg.verifyToken,
    graph_version: GRAPH_VERSION,
    live_connected: false,
    error: null as string | null,
  };

  if (!cfg.configured) {
    return { ...baseStatus, error: "WHATSAPP_ACCESS_TOKEN is not configured" };
  }

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(cfg.phoneNumberId)}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    });
    const data = (await resp.json()) as Record<string, any>;
    if (!resp.ok) {
      return {
        ...baseStatus,
        error: data?.error?.message || `Meta Graph API HTTP ${resp.status}`,
      };
    }
    return {
      ...baseStatus,
      display_phone_number: data.display_phone_number || cfg.fromNumber,
      verified_name: data.verified_name || "Meta WhatsApp Business",
      quality_rating: data.quality_rating || "GREEN",
      code_verification_status: data.code_verification_status || "VERIFIED",
      name_status: data.name_status || "APPROVED",
      live_connected: true,
    };
  } catch (err) {
    return {
      ...baseStatus,
      error: err instanceof Error ? err.message : "Failed to connect to Meta Graph API",
    };
  }
}

export async function fetchMetaTemplates(): Promise<{ templates: WhatsAppTemplateItem[]; error: string | null }> {
  const cfg = getWhatsAppConfig();
  if (!cfg.configured) {
    return { templates: [], error: "WHATSAPP_ACCESS_TOKEN is not configured" };
  }
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(cfg.businessAccountId)}/message_templates?fields=id,name,status,language,category,components&limit=100`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    });
    const data = (await resp.json()) as { data?: WhatsAppTemplateItem[]; error?: { message?: string } };
    if (!resp.ok) {
      return {
        templates: [],
        error: data?.error?.message || `Meta Graph API HTTP ${resp.status}`,
      };
    }
    return {
      templates: Array.isArray(data.data) ? data.data : [],
      error: null,
    };
  } catch (err) {
    return {
      templates: [],
      error: err instanceof Error ? err.message : "Failed to fetch message templates",
    };
  }
}

export interface SendWhatsAppInput {
  card_id?: number;
  investor_id?: number;
  phone?: string;
  to?: string;
  body?: string;
  message?: string;
  sender?: string;
  direction?: "inbound" | "outbound";
  campaign?: string;
  mode?: "text" | "template" | "log_only";
  template_name?: string;
  template_language?: string;
  template_params?: string[];
  template_body_preview?: string;
}

export async function sendAndLogWhatsAppMessage(raw: SendWhatsAppInput) {
  await ensureWhatsAppSchema(pool);
  const cfg = getWhatsAppConfig();

  const direction = raw.direction === "inbound" ? "inbound" : "outbound";
  const mode = raw.mode || (raw.template_name ? "template" : "text");
  const templateName = (raw.template_name || "").trim();
  const templateLang = (raw.template_language || "en_US").trim();
  const templateParams = Array.isArray(raw.template_params)
    ? raw.template_params.map(x => String(x ?? "").trim()).filter(Boolean)
    : [];

  const rawPhone = String(raw.phone || raw.to || "").trim();
  if (!rawPhone) {
    throw new CrmError("Recipient WhatsApp phone number is required", 400);
  }
  const toDigits = normalizeWhatsAppDigits(rawPhone);
  if (!toDigits || toDigits.length < 8) {
    throw new CrmError("Valid WhatsApp phone number with country/area code is required (e.g. +14078021717)", 400);
  }
  const e164Phone = `+${toDigits}`;
  const sender = String(raw.sender || "Guy").trim() || "Guy";

  let textBody = String(raw.body || raw.message || "").trim();
  if (mode === "template") {
    if (!templateName) {
      throw new CrmError("Template name is required when sending a WhatsApp template", 400);
    }
    if (!textBody) {
      const preview = (raw.template_body_preview || "").trim();
      textBody = preview
        ? `[Template: ${templateName}] ${preview}`
        : `[Template: ${templateName} (${templateLang})]${templateParams.length ? ` Params: ${templateParams.join(", ")}` : ""}`;
    }
  } else if (!textBody) {
    throw new CrmError("WhatsApp message body is required", 400);
  }

  let waMessageId: string | null = null;
  let deliveryStatus = direction === "inbound" ? "received" : "logged";
  let errorMessage: string | null = null;
  let metaResponse: Record<string, unknown> = {};

  if (direction === "outbound" && mode !== "log_only") {
    if (!cfg.configured) {
      throw new CrmError("WhatsApp Cloud API token is not configured on the server", 500);
    }

    const graphPayload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toDigits,
    };

    if (mode === "template") {
      const templateObj: Record<string, unknown> = {
        name: templateName,
        language: { code: templateLang },
      };
      if (templateParams.length > 0) {
        templateObj.components = [
          {
            type: "body",
            parameters: templateParams.map(p => ({ type: "text", text: p })),
          },
        ];
      }
      graphPayload.type = "template";
      graphPayload.template = templateObj;
    } else {
      graphPayload.type = "text";
      graphPayload.text = {
        preview_url: true,
        body: textBody,
      };
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(graphPayload),
    });

    const respJson = (await resp.json().catch(() => ({}))) as Record<string, any>;
    metaResponse = respJson;

    if (!resp.ok) {
      const apiErrMsg =
        respJson?.error?.error_user_msg ||
        respJson?.error?.message ||
        `Meta WhatsApp Cloud API error (HTTP ${resp.status})`;
      errorMessage = apiErrMsg;
      deliveryStatus = "failed";

      // Record failed attempt in database for visibility before throwing
      await transaction(async client => {
        let cardId = raw.card_id || raw.investor_id ? Number(raw.card_id || raw.investor_id) : null;
        if (!cardId) cardId = await findInvestorIdByPhone(client, e164Phone);
        await client.query(
          `INSERT INTO crm_whatsapp_messages(investor_id,phone,direction,body,sender,wa_message_id,status,message_type,template_name,error_message,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            cardId,
            e164Phone,
            direction,
            textBody,
            sender,
            null,
            "failed",
            mode === "template" ? "template" : "text",
            mode === "template" ? templateName : null,
            errorMessage,
            JSON.stringify({ graph_error: respJson?.error || respJson }),
          ],
        );
      });

      throw new CrmError(apiErrMsg, resp.status >= 400 && resp.status < 500 ? resp.status : 502);
    }

    waMessageId = respJson?.messages?.[0]?.id || null;
    deliveryStatus = respJson?.messages?.[0]?.message_status || "accepted";
  }

  const created = await transaction(async client => {
    let cardId = raw.card_id || raw.investor_id ? Number(raw.card_id || raw.investor_id) : null;
    if (!cardId) {
      cardId = await findInvestorIdByPhone(client, e164Phone);
    }

    const ins = await client.query(
      `INSERT INTO crm_whatsapp_messages(investor_id,phone,direction,body,sender,wa_message_id,status,message_type,template_name,error_message,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING *`,
      [
        cardId ?? null,
        e164Phone,
        direction,
        textBody,
        sender,
        waMessageId,
        deliveryStatus,
        mode === "template" ? "template" : "text",
        mode === "template" ? templateName : null,
        errorMessage,
        JSON.stringify({
          meta: metaResponse,
          from_phone_number_id: cfg.phoneNumberId,
          waba_id: cfg.businessAccountId,
        }),
      ],
    );

    if (cardId) {
      await logOutboundActivity(client, {
        card_id: cardId,
        event_type: direction === "inbound" ? "reply_received" : "whatsapp_sent",
        subject:
          mode === "template"
            ? `WhatsApp Template (${templateName}) to ${e164Phone}`
            : `WhatsApp ${direction === "inbound" ? "Reply" : "Message"} (${e164Phone})`,
        snippet: textBody,
        campaign: raw.campaign || "whatsapp-cloud",
        actor: sender,
      });
    }

    return ins.rows[0];
  });

  return created;
}

export async function handleMetaWebhookEvents(payload: Record<string, any>) {
  await ensureWhatsAppSchema(pool);
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  let processedMessages = 0;
  let processedStatuses = 0;

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};

      // 1. Handle delivery status updates (sent, delivered, read, failed)
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const st of statuses) {
        const wamid = String(st?.id || "").trim();
        const statusVal = String(st?.status || "").trim();
        if (!wamid || !statusVal) continue;
        const errObj = Array.isArray(st?.errors) && st.errors[0] ? st.errors[0] : null;
        const errText = errObj ? `${errObj.title || errObj.message || "Delivery error"} (code ${errObj.code ?? ""})` : null;
        await pool.query(
          `UPDATE crm_whatsapp_messages
           SET status = $1,
               error_message = COALESCE($2, error_message),
               metadata = metadata || $3::jsonb
           WHERE wa_message_id = $4`,
          [statusVal, errText, JSON.stringify({ last_status_event: st }), wamid],
        );
        processedStatuses++;
      }

      // 2. Handle incoming messages
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const profileNameByWaId = new Map<string, string>();
      for (const c of contacts) {
        const waId = String(c?.wa_id || "").trim();
        const pName = String(c?.profile?.name || "").trim();
        if (waId && pName) profileNameByWaId.set(waId, pName);
      }

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const msg of messages) {
        const wamid = String(msg?.id || "").trim();
        const fromRaw = String(msg?.from || "").trim();
        if (!fromRaw) continue;
        const e164Phone = formatE164Phone(fromRaw);
        const senderName = profileNameByWaId.get(fromRaw) || e164Phone;
        const msgType = String(msg?.type || "text").trim();

        let textBody = "";
        if (msgType === "text") {
          textBody = String(msg?.text?.body || "").trim();
        } else if (msgType === "button") {
          textBody = String(msg?.button?.text || msg?.button?.payload || "[Button Reply]").trim();
        } else if (msgType === "interactive") {
          textBody = String(
            msg?.interactive?.button_reply?.title ||
              msg?.interactive?.list_reply?.title ||
              "[Interactive Reply]",
          ).trim();
        } else {
          textBody = `[${msgType.toUpperCase()} message received]`;
        }
        if (!textBody) textBody = "[WhatsApp message]";

        // Avoid duplicate insertion on webhook retries
        if (wamid) {
          const dup = await pool.query("SELECT id FROM crm_whatsapp_messages WHERE wa_message_id = $1 LIMIT 1", [wamid]);
          if (dup.rows[0]) continue;
        }

        await transaction(async client => {
          const cardId = await findInvestorIdByPhone(client, e164Phone);
          await client.query(
            `INSERT INTO crm_whatsapp_messages(investor_id,phone,direction,body,sender,wa_message_id,status,message_type,metadata)
             VALUES($1,$2,'inbound',$3,$4,$5,'received',$6,$7::jsonb)`,
            [
              cardId,
              e164Phone,
              textBody,
              senderName,
              wamid || null,
              msgType,
              JSON.stringify({ webhook_message: msg }),
            ],
          );

          if (cardId) {
            await logOutboundActivity(client, {
              card_id: cardId,
              event_type: "reply_received",
              subject: `WhatsApp Reply from ${senderName} (${e164Phone})`,
              snippet: textBody,
              campaign: "whatsapp-inbound",
              actor: senderName,
            });
          }
        });
        processedMessages++;
      }
    }
  }

  return { processed_messages: processedMessages, processed_statuses: processedStatuses };
}
