export const STAGES = ["New", "Contacted", "Followed Up", "Responded", "Meeting Set", "Closed"] as const;
export type Stage = typeof STAGES[number];

const aliases: Record<string, Stage> = {
  new: "New", enriched: "New", "pitch drafted": "New", "approved to send": "New",
  contacted: "Contacted", sent: "Contacted", "email sent": "Contacted", "pitch sent": "Contacted",
  "followed up": "Followed Up", "follow up": "Followed Up", followup: "Followed Up",
  "follow up sent": "Followed Up", "followup sent": "Followed Up",
  responded: "Responded", replied: "Responded", reply: "Responded", "reply received": "Responded",
  "meeting set": "Meeting Set", meeting: "Meeting Set", "meeting scheduled": "Meeting Set", "meeting booked": "Meeting Set",
  closed: "Closed", won: "Closed", lost: "Closed", "closed won": "Closed", "closed lost": "Closed",
  passed: "Closed", committed: "Closed",
};

// CSV imports and the one-time migration share this mapping; unknown stages fail closed.
export function normalizeStage(value: unknown): Stage | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (/^(follow up|followup|followed up)(?: \d+)?$/.test(key)) return "Followed Up";
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}
