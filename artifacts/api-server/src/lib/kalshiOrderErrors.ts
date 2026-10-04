/** A received Kalshi response is distinct from a lost/ambiguous submit response. */
export class KalshiOrderPlacementError extends Error {
  readonly code: string | null;

  constructor(readonly httpStatus: number, readonly responseBody: string) {
    super(`Kalshi order placement failed: HTTP ${httpStatus} — ${responseBody.slice(0, 400)}`);
    this.name = "KalshiOrderPlacementError";
    let code: unknown;
    try {
      code = (JSON.parse(responseBody) as { error?: { code?: unknown } }).error?.code;
    } catch {
      // An unrecognizable response must remain unresolved, never clear the lock.
    }
    this.code = typeof code === "string" ? code : null;
  }

  get isConfirmedRejection(): boolean {
    // Deliberately narrow: only the observed explicit no-order rejection.
    // Timeouts, transport failures, 5xx, malformed responses and other codes
    // must retain their durable submitting intent.
    return this.httpStatus === 400 && this.code === "insufficient_balance";
  }
}

export interface ConfirmedRejectedSubmission {
  orderId: number;
  approvalId: number;
  ticker: string;
  side: "YES" | "NO";
  priceCents: number;
  contracts: number;
  tsPlaced: string;
  httpStatus: 400;
  responseBody: string;
}

/** Operator-provided evidence for previously stranded intents; not an auto-retry. */
export function readConfirmedRejectedSubmissions(raw: string | undefined): ConfirmedRejectedSubmission[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new Error("Invalid KALSHI_CONFIRMED_REJECTED_SUBMISSIONS: expected at most 20 records");
  }
  for (const value of parsed) {
    const r = value as Partial<ConfirmedRejectedSubmission> | null;
    if (
      !r || !Number.isSafeInteger(r.orderId) || Number(r.orderId) < 1 ||
      !Number.isSafeInteger(r.approvalId) || Number(r.approvalId) < 1 ||
      typeof r.ticker !== "string" || !r.ticker ||
      (r.side !== "YES" && r.side !== "NO") ||
      !Number.isInteger(r.priceCents) || Number(r.priceCents) < 1 || Number(r.priceCents) > 99 ||
      !Number.isInteger(r.contracts) || Number(r.contracts) < 1 ||
      typeof r.tsPlaced !== "string" || !Number.isFinite(Date.parse(r.tsPlaced)) ||
      r.httpStatus !== 400 || typeof r.responseBody !== "string" ||
      !new KalshiOrderPlacementError(r.httpStatus, r.responseBody).isConfirmedRejection
    ) {
      throw new Error("Invalid KALSHI_CONFIRMED_REJECTED_SUBMISSIONS: missing identity or explicit rejection evidence");
    }
  }
  return parsed as ConfirmedRejectedSubmission[];
}