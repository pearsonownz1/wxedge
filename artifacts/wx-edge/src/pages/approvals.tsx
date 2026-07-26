/**
 * Approvals page — human-in-the-loop trading queue.
 *
 * Desktop-only for v1. Pending proposals appear as trade cards with a
 * countdown to expiry. The human can Approve (with one confirm tap) or Deny.
 * Decided proposals appear in the history table below.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradeCard {
  headline:         string;
  model_pct:        number;
  implied_pct:      number;
  edge_pts:         number;
  max_loss_cents:   number;
  running_high_f:   number | null;
  hours_to_settle:  number | null;
  bracket_label:    string;
  station_id:       string;
}

interface ApprovalRecord {
  id:               number;
  signal_id:        number;
  ticker:           string;
  side:             string;
  station_id:       string;
  proposed_ts:      string;
  expires_ts:       string;
  card_json:        string | null;
  decision:         string | null;
  decision_ts:      string | null;
  latency_ms:       number | null;
  recheck_ok:       boolean | null;
  recheck_note:     string | null;
  limit_price_cents: number;
  decider:          string | null;
  llm_rationale:    string | null;
  llm_confidence:   number | null;
}

interface ApprovalsResponse {
  pending: ApprovalRecord[];
  history: ApprovalRecord[];
}

interface PatchResponse {
  result: "order_placed" | "denied" | "stale" | "conflict";
  recheck_note?: string;
  diff?: Record<string, { at_proposal: unknown; now: unknown }>;
  decision?: string;
  order?: { id: number; ticker: string; side: string; limit_price_cents: number; contracts: number; status: string };
}

// ─── Countdown hook ───────────────────────────────────────────────────────────

function useCountdown(expiresTs: string): string {
  const [label, setLabel] = useState("");

  useEffect(() => {
    const update = () => {
      const remainMs = new Date(expiresTs).getTime() - Date.now();
      if (remainMs <= 0) { setLabel("Expired"); return; }
      const totalSec = Math.floor(remainMs / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      setLabel(`${min}:${sec.toString().padStart(2, "0")}`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [expiresTs]);

  return label;
}

// ─── Proposal card ────────────────────────────────────────────────────────────

function ProposalCard({
  approval,
  onDecision,
}: {
  approval: ApprovalRecord;
  onDecision: (id: number, action: "approve" | "deny") => void;
}) {
  const card: TradeCard | null = approval.card_json
    ? (JSON.parse(approval.card_json) as TradeCard)
    : null;

  const countdown = useCountdown(approval.expires_ts);
  const isUrgent  = new Date(approval.expires_ts).getTime() - Date.now() < 5 * 60_000;

  return (
    <div className="border rounded-lg p-4 bg-card space-y-3">
      {/* Headline */}
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold text-sm leading-snug">
          {card?.headline ?? `${approval.side} ${approval.ticker}`}
        </p>
        <span className={`text-xs font-mono shrink-0 tabular-nums px-2 py-0.5 rounded-full border ${isUrgent ? "text-destructive border-destructive" : "text-muted-foreground border-border"}`}>
          {countdown}
        </span>
      </div>

      {/* Stats row */}
      {card && (
        <div className="grid grid-cols-4 gap-2 text-xs">
          <Stat label="Model" value={`${card.model_pct.toFixed(1)}%`} />
          <Stat label="Market" value={`${card.implied_pct}¢`} />
          <Stat label="Edge" value={`${card.edge_pts > 0 ? "+" : ""}${card.edge_pts.toFixed(1)} pts`} highlight />
          <Stat label="Max loss" value={`${card.max_loss_cents}¢`} danger />
        </div>
      )}

      {/* Why-now row */}
      {card && (card.running_high_f !== null || card.hours_to_settle !== null) && (
        <div className="text-xs text-muted-foreground flex gap-4">
          {card.running_high_f !== null && (
            <span>Running high: <strong className="text-foreground">{card.running_high_f.toFixed(1)}°F</strong></span>
          )}
          {card.hours_to_settle !== null && (
            <span>To peak: <strong className="text-foreground">~{card.hours_to_settle.toFixed(1)} h</strong></span>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={() => onDecision(approval.id, "approve")}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => onDecision(approval.id, "deny")}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  danger,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p className={`font-semibold tabular-nums ${highlight ? "text-green-500" : danger ? "text-destructive" : ""}`}>
        {value}
      </p>
    </div>
  );
}

// ─── Stale diff panel ─────────────────────────────────────────────────────────

function StaleDiffPanel({
  note,
  diff,
  onClose,
}: {
  note: string;
  diff: Record<string, { at_proposal: unknown; now: unknown }>;
  onClose: () => void;
}) {
  return (
    <div className="border border-yellow-500/40 rounded-lg p-4 bg-yellow-950/20 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-yellow-400">Conditions changed — no order placed</p>
        <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">dismiss</button>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="space-y-1">
        {Object.entries(diff).map(([field, { at_proposal, now }]) => (
          <div key={field} className="grid grid-cols-3 gap-2 text-xs">
            <span className="text-muted-foreground font-mono">{field}</span>
            <span className="text-muted-foreground line-through">{String(at_proposal)}</span>
            <span className="text-yellow-400 font-semibold">{String(now)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── History table ────────────────────────────────────────────────────────────

function HistoryTable({ items }: { items: ApprovalRecord[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">No decisions yet.</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="text-left py-2 pr-3 font-medium">Ticker</th>
          <th className="text-left py-2 pr-3 font-medium">Side</th>
          <th className="text-right py-2 pr-3 font-medium">Max loss</th>
          <th className="text-left py-2 pr-3 font-medium">Decision</th>
          <th className="text-right py-2 pr-3 font-medium">Latency</th>
          <th className="text-right py-2 font-medium">Proposed</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const card: TradeCard | null = item.card_json ? JSON.parse(item.card_json) as TradeCard : null;
          const isExpanded = expandedId === item.id;
          const hasLlmRationale = item.decider === "llm" && item.llm_rationale;
          return (
            <>
              <tr
                key={item.id}
                className={`border-b border-border/40 hover:bg-muted/20 ${hasLlmRationale ? "cursor-pointer" : ""}`}
                onClick={() => hasLlmRationale && setExpandedId(isExpanded ? null : item.id)}
              >
                <td className="py-2 pr-3 font-mono">{item.ticker}</td>
                <td className="py-2 pr-3">
                  <Badge variant={item.side === "YES" ? "default" : "secondary"} className="text-[10px] px-1.5">
                    {item.side}
                  </Badge>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {card ? `${card.max_loss_cents}¢` : `${item.limit_price_cents}¢`}
                </td>
                <td className="py-2 pr-3">
                  <DecisionBadge decision={item.decision} recheckOk={item.recheck_ok} decider={item.decider} />
                  {item.llm_confidence !== null && item.decider === "llm" && (
                    <span className="ml-1.5 text-muted-foreground tabular-nums">
                      {Math.round(item.llm_confidence * 100)}%
                    </span>
                  )}
                  {hasLlmRationale && (
                    <span className="ml-1 text-muted-foreground">{isExpanded ? "▲" : "▼"}</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                  {item.latency_ms !== null
                    ? item.latency_ms < 60_000
                      ? `${(item.latency_ms / 1000).toFixed(0)}s`
                      : `${(item.latency_ms / 60_000).toFixed(1)}m`
                    : "—"}
                </td>
                <td className="py-2 text-right text-muted-foreground">
                  {new Date(item.proposed_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </td>
              </tr>
              {isExpanded && item.llm_rationale && (
                <tr key={`${item.id}-rationale`} className="border-b border-border/40 bg-muted/10">
                  <td colSpan={6} className="px-2 py-2">
                    <p className="text-xs text-muted-foreground leading-relaxed italic">
                      🤖 {item.llm_rationale}
                    </p>
                  </td>
                </tr>
              )}
            </>
          );
        })}
      </tbody>
    </table>
  );
}

function DecisionBadge({
  decision,
  recheckOk,
  decider,
}: {
  decision: string | null;
  recheckOk: boolean | null;
  decider: string | null;
}) {
  const deciderIcon = decider === "llm" ? "🤖" : decider === "human" ? "👤" : null;

  if (!decision) return <span className="text-muted-foreground">pending</span>;
  if (decision === "approved" && recheckOk === false) {
    return (
      <span className="text-yellow-500 font-medium">
        {deciderIcon} approved (stale)
      </span>
    );
  }
  const colors: Record<string, string> = {
    approved: "text-green-500",
    denied:   "text-muted-foreground",
    expired:  "text-destructive",
  };
  return (
    <span className={`font-medium ${colors[decision] ?? ""}`}>
      {deciderIcon} {decision}
    </span>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Approvals() {
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Confirm dialog state
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [confirmCard, setConfirmCard] = useState<TradeCard | null>(null);

  // Stale diff state (per approval id)
  const [staleDiff, setStaleDiff] = useState<{
    id: number;
    note: string;
    diff: Record<string, { at_proposal: unknown; now: unknown }>;
  } | null>(null);

  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/approvals`);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json() as ApprovalsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError("Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const t = setInterval(() => void fetchData(), 30_000);
    return () => clearInterval(t);
  }, [fetchData]);

  // ── Confirm / action handler ──────────────────────────────────────────────

  const handleDecision = useCallback((id: number, action: "approve" | "deny") => {
    if (action === "approve") {
      const approval = data?.pending.find((p) => p.id === id);
      const card = approval?.card_json ? JSON.parse(approval.card_json) as TradeCard : null;
      setConfirmId(id);
      setConfirmCard(card);
    } else {
      void submitAction(id, "deny");
    }
  }, [data]);

  const submitAction = useCallback(async (id: number, action: "approve" | "deny") => {
    setActionLoading(id);
    setConfirmId(null);
    try {
      const res = await fetch(`${BASE}/api/approvals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json() as PatchResponse;

      if (json.result === "stale" && json.diff) {
        setStaleDiff({
          id,
          note: json.recheck_note ?? "Conditions changed",
          diff: json.diff,
        });
      }

      // Refresh to reflect new state
      await fetchData();
    } catch {
      setError("Request failed — please retry");
    } finally {
      setActionLoading(null);
    }
  }, [fetchData]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Shell>
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-8 w-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Approval Queue</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pending proposals · auto-refreshes every 30 s
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchData()}>
            Refresh
          </Button>
        </div>

        {error && (
          <div className="border border-destructive/40 rounded-md p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Stale diff */}
        {staleDiff && (
          <StaleDiffPanel
            note={staleDiff.note}
            diff={staleDiff.diff}
            onClose={() => setStaleDiff(null)}
          />
        )}

        {/* Pending queue */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Pending ({data?.pending.length ?? 0})
          </h2>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : data?.pending.length === 0 ? (
            <div className="border border-dashed rounded-lg p-8 text-center">
              <p className="text-sm text-muted-foreground">No pending proposals</p>
              <p className="text-xs text-muted-foreground mt-1">
                New proposals appear here when the signal engine finds edge
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {data!.pending.map((approval) => (
                <div key={approval.id} className={actionLoading === approval.id ? "opacity-50 pointer-events-none" : ""}>
                  <ProposalCard
                    approval={approval}
                    onDecision={handleDecision}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Decision history */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            History
          </h2>
          {data && <HistoryTable items={data.history} />}
        </section>
      </div>

      {/* Confirm dialog */}
      <AlertDialog open={confirmId !== null} onOpenChange={(open) => { if (!open) setConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm order</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {confirmCard && (
                  <p className="text-sm">{confirmCard.headline}</p>
                )}
                <p className="text-sm font-semibold">
                  Place order: 1 contract, max loss{" "}
                  <span className="text-destructive">
                    {confirmCard ? `${confirmCard.max_loss_cents}¢` : "—"}
                  </span>
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmId !== null && void submitAction(confirmId, "approve")}
            >
              Place order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  );
}
