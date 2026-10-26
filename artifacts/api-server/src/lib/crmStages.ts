export const STAGES = ["New", "Contacted", "Meeting set", "Proposal sent", "Contract review", "Closed"] as const;
export type Stage = typeof STAGES[number];

export const STAGE_PROBABILITIES: Record<Stage, number> = {
  "New": 0.05,
  "Contacted": 0.10,
  "Meeting set": 0.20,
  "Proposal sent": 0.50,
  "Contract review": 0.80,
  "Closed": 1.00,
};

const aliases: Record<string, Stage> = {
  new: "New",
  enriched: "New",
  "pitch drafted": "New",
  "approved to send": "New",
  contacted: "Contacted",
  sent: "Contacted",
  "email sent": "Contacted",
  "pitch sent": "Contacted",
  "followed up": "Contacted",
  "follow up": "Contacted",
  followup: "Contacted",
  "follow up sent": "Contacted",
  "followup sent": "Contacted",
  responded: "Contacted",
  replied: "Contacted",
  reply: "Contacted",
  "reply received": "Contacted",
  "meeting set": "Meeting set",
  "meeting": "Meeting set",
  "meeting scheduled": "Meeting set",
  "meeting booked": "Meeting set",
  "proposal sent": "Proposal sent",
  proposal: "Proposal sent",
  "proposal drafted": "Proposal sent",
  "contract review": "Contract review",
  contract: "Contract review",
  "contract sent": "Contract review",
  closed: "Closed",
  won: "Closed",
  lost: "Closed",
  "closed won": "Closed",
  "closed lost": "Closed",
  passed: "Closed",
  committed: "Closed",
};

// CSV imports and the startup migration share this mapping; unknown stages fail closed.
export function normalizeStage(value: unknown): Stage | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (/^(follow up|followup|followed up)(?: \d+)?$/.test(key)) return "Contacted";
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}

export function nextStageForEvent(currentStage: Stage | string | undefined, eventType: string): Stage {
  const cur = normalizeStage(currentStage) ?? "New";
  const curIdx = STAGES.indexOf(cur);
  let target: Stage = cur;
  const ev = eventType.trim().toLowerCase();
  if (["email_sent", "reply_received", "call_logged", "whatsapp_sent", "contacted"].includes(ev)) {
    target = "Contacted";
  } else if (["meeting_set", "meeting"].includes(ev)) {
    target = "Meeting set";
  } else if (["proposal_sent", "proposal"].includes(ev)) {
    target = "Proposal sent";
  } else if (["contract_sent", "contract_review", "contract"].includes(ev)) {
    target = "Contract review";
  } else if (["closed_won", "closed"].includes(ev)) {
    target = "Closed";
  }
  const targetIdx = STAGES.indexOf(target);
  return targetIdx > curIdx ? target : cur;
}
