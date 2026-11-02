import { pgTable, serial, text, jsonb, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

export const crmInvestors = pgTable("crm_investors", {
  id: serial("id").primaryKey(),
  emailKey: text("email_key").unique(),
  linkedinKey: text("linkedin_key").unique(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmActivities = pgTable("crm_activities", {
  id: serial("id").primaryKey(),
  investorId: integer("investor_id").references(() => crmInvestors.id).notNull(),
  message: text("message").notNull(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("crm_activities_investor_idx").on(table.investorId)]);

export const crmUsers = pgTable("crm_users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").default("member").notNull(),
  workspaceSettings: jsonb("workspace_settings").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmCalls = pgTable("crm_calls", {
  id: serial("id").primaryKey(),
  investorId: integer("investor_id").references(() => crmInvestors.id),
  callId: text("call_id"),
  fromNumber: text("from_number").default("+15619031414").notNull(),
  toNumber: text("to_number").notNull(),
  durationSec: integer("duration_sec").default(0).notNull(),
  recordingUrl: text("recording_url").default("").notNull(),
  aiOverview: text("ai_overview").default("").notNull(),
  outcome: text("outcome").default("connected_live").notNull(),
  sentiment: text("sentiment").default("neutral").notNull(),
  actionItems: jsonb("action_items").$type<string[]>().default([]).notNull(),
  nextSteps: text("next_steps").default("").notNull(),
  transcript: jsonb("transcript").$type<Array<{ user: string; text: string; created_at?: string }>>().default([]).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmOutlookAccounts = pgTable("crm_outlook_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  email: text("email").notNull(),
  microsoftId: text("microsoft_id").default("").notNull(),
  displayName: text("display_name").default("").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").default("").notNull(),
  autoCreatePeople: boolean("auto_create_people").default(false).notNull(),
  inboxCursor: text("inbox_cursor"),
  sentCursor: text("sent_cursor"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmOutlookMessages = pgTable("crm_outlook_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  graphId: text("graph_id").notNull(),
  conversationId: text("conversation_id").default("").notNull(),
  folder: text("folder").notNull(),
  subject: text("subject").default("").notNull(),
  preview: text("preview").default("").notNull(),
  fromEmail: text("from_email").default("").notNull(),
  fromName: text("from_name").default("").notNull(),
  participants: text("participants").default("").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  hasAttachments: boolean("has_attachments").default(false).notNull(),
  isRead: boolean("is_read").default(false).notNull(),
  webLink: text("web_link").default("").notNull(),
});

export const crmOutlookEvents = pgTable("crm_outlook_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  graphId: text("graph_id").notNull(),
  subject: text("subject").default("").notNull(),
  preview: text("preview").default("").notNull(),
  location: text("location").default("").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  organizerEmail: text("organizer_email").default("").notNull(),
  attendees: text("attendees").default("").notNull(),
  isAllDay: boolean("is_all_day").default(false).notNull(),
  webLink: text("web_link").default("").notNull(),
});

export const crmEmailTemplates = pgTable("crm_email_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  subject: text("subject").default("").notNull(),
  bodyHtml: text("body_html").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmEmailDrafts = pgTable("crm_email_drafts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  toAddresses: text("to_addresses").default("").notNull(),
  ccAddresses: text("cc_addresses").default("").notNull(),
  bccAddresses: text("bcc_addresses").default("").notNull(),
  subject: text("subject").default("").notNull(),
  bodyHtml: text("body_html").default("").notNull(),
  attachments: jsonb("attachments").$type<Array<Record<string, unknown>>>().default([]).notNull(),
  investorId: integer("investor_id"),
  replyMessageId: text("reply_message_id").default("").notNull(),
  forwardMessageId: text("forward_message_id").default("").notNull(),
  status: text("status").default("draft").notNull(),
  error: text("error").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmWhatsappMessages = pgTable("crm_whatsapp_messages", {
  id: serial("id").primaryKey(),
  investorId: integer("investor_id").references(() => crmInvestors.id),
  phone: text("phone").notNull(),
  direction: text("direction").default("outbound").notNull(),
  body: text("body").notNull(),
  sender: text("sender").default("Guy").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
