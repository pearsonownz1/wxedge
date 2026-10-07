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
