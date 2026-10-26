import { pgTable, serial, text, jsonb, timestamp, integer, index } from "drizzle-orm/pg-core";

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

export const crmWhatsappMessages = pgTable("crm_whatsapp_messages", {
  id: serial("id").primaryKey(),
  investorId: integer("investor_id").references(() => crmInvestors.id),
  phone: text("phone").notNull(),
  direction: text("direction").default("outbound").notNull(),
  body: text("body").notNull(),
  sender: text("sender").default("Guy").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
