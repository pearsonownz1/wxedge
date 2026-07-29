/**
 * Trading Performance Dashboard
 *
 * TV-friendly overview of the AI trader's P&L, win rate, per-station
 * performance, and a live feed of recent decisions.
 * Auto-refreshes every 30 s.
 */

import { useState, useEffect, useCallback } from "react";
import { Shell } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardSummary {
  pnl_cents:        number;
  total_placed:     number;
  settled_count:    number;
  pending_count:    number;
  win_count:        number;
  loss_count:       number;
  win_rate_pct:     number | null;
  cost_today_cents: number;
  daily_cap_cents:  number;
}

interface DayRow {
  date:        string;
  pnl_cents:   number;
  cost_cents:  number;
  trade_count: number;
}

interface StationRow {
  station_id:   string;
  total_placed: number;
  settled:      number;
  win_count:    number;
  loss_count:   number;
  pnl_cents:    number;
}

interface FeedItem {
  id:                 number;
  ticker:             string;
  side:               string;
  station_id:         string;
  proposed_ts:        string;
  decision:           string | null;
  decider:            string | null;
  llm_confidence:     number | null;
  recheck_ok:         boolean | null;
  settlement_outcome: string | null;
  pnl_cents:          number | null;
  limit_price_cents:  number;
}

interface DashboardData {
  summary:     DashboardSummary;
  pnl_by_day:  DayRow[];
  by_station:  StationRow[];
  recent_feed: FeedItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function fmt$(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars >= 0 ? "+" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="border bg-card p-5 flex flex-col gap-1">
      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`text-3xl font-bold tabular-nums tracking-tight ${valueClass ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ─── P&L bar chart ────────────────────────────────────────────────────────────

function PnlChart({ data }: { data: DayRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No trade history yet
      </div>
    );
  }

  // Cumulative P&L line overlay data
  let cum = 0;
  const chartData = data.map(d => {
    cum += d.pnl_cents;
    return { ...d, cumulative: cum };
  });

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
        <XAxis
          dataKey="date"
          tickFormatter={fmtDate}
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={v => `${v}¢`}
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <Tooltip
          formatter={(value: number, name: string) => {
            if (name === "pnl_cents") return [`${value}¢`, "P&L"];
            return [value, name];
          }}
          labelFormatter={(label: string) => fmtDate(label)}
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 4,
            fontSize: 11,
          }}
        />
        <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
        <Bar dataKey="pnl_cents" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.pnl_cents >= 0
                ? "hsl(142 71% 45%)"   // green
                : "hsl(var(--destructive))"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Station leaderboard ──────────────────────────────────────────────────────

function StationLeaderboard({ rows }: { rows: StationRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">No trades yet.</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="text-left py-2 pr-3 font-medium">Station</th>
          <th className="text-right py-2 pr-2 font-medium">W</th>
          <th className="text-right py-2 pr-2 font-medium">L</th>
          <th className="text-right py-2 pr-2 font-medium">Rate</th>
          <th className="text-right py-2 font-medium">P&L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const total = r.win_count + r.loss_count;
          const rate  = total > 0 ? Math.round(r.win_count / total * 100) : null;
          const pnlPositive = r.pnl_cents >= 0;
          return (
            <tr key={r.station_id} className="border-b border-border/40">
              <td className="py-2 pr-3 font-mono font-bold">{r.station_id}</td>
              <td className="py-2 pr-2 text-right text-green-500 font-semibold tabular-nums">{r.win_count}</td>
              <td className="py-2 pr-2 text-right text-destructive font-semibold tabular-nums">{r.loss_count}</td>
              <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                {rate !== null ? `${rate}%` : "—"}
              </td>
              <td className={`py-2 text-right tabular-nums font-semibold ${pnlPositive ? "text-green-500" : "text-destructive"}`}>
                {r.pnl_cents > 0 ? "+" : ""}{r.pnl_cents}¢
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Live trading feed ────────────────────────────────────────────────────────

function TradingFeed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No decisions yet — waiting for the first signal.
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {items.map(item => {
        const isApproved = item.decision === "approved" && item.recheck_ok;
        const isDenied   = item.decision === "denied";
        const isExpired  = item.decision === "expired";
        const outcome    = item.settlement_outcome;

        let outcomeNode: React.ReactNode = null;
        if (outcome === "won") {
          outcomeNode = (
            <span className="text-green-500 font-bold text-xs tabular-nums">
              WON {item.pnl_cents !== null ? `+${item.pnl_cents}¢` : ""}
            </span>
          );
        } else if (outcome === "lost") {
          outcomeNode = (
            <span className="text-destructive font-bold text-xs tabular-nums">
              LOST {item.pnl_cents !== null ? `${item.pnl_cents}¢` : ""}
            </span>
          );
        } else if (outcome === "pending") {
          outcomeNode = <span className="text-muted-foreground text-[10px] uppercase tracking-wide">live</span>;
        }

        const deciderIcon = item.decider === "llm" ? "🤖" : item.decider === "human" ? "👤" : "";

        return (
          <div
            key={item.id}
            className="flex items-center gap-3 px-0 py-2.5 border-b border-border/40 text-xs hover:bg-muted/10 transition-colors"
          >
            {/* Time */}
            <span className="text-muted-foreground tabular-nums shrink-0 w-12">
              {fmtTime(item.proposed_ts)}
            </span>

            {/* Station */}
            <span className="font-mono font-bold text-muted-foreground shrink-0 w-11">
              {item.station_id.replace(/^K/, "")}
            </span>

            {/* Ticker (truncated) */}
            <span className="font-mono text-[10px] text-muted-foreground flex-1 min-w-0 truncate">
              {item.ticker}
            </span>

            {/* Side */}
            <Badge
              variant={item.side === "YES" ? "default" : "secondary"}
              className="text-[10px] px-1.5 shrink-0"
            >
              {item.side}
            </Badge>

            {/* Decision */}
            <span className={`shrink-0 font-medium ${
              isApproved ? "text-green-500" :
              isDenied   ? "text-muted-foreground" :
              isExpired  ? "text-destructive" : ""
            }`}>
              {deciderIcon} {item.decision ?? "pending"}
              {item.llm_confidence !== null && item.decider === "llm" && (
                <span className="ml-1 text-muted-foreground font-normal">
                  {Math.round(item.llm_confidence * 100)}%
                </span>
              )}
            </span>

            {/* Settlement outcome */}
            <span className="shrink-0 w-20 text-right">
              {outcomeNode ?? <span className="text-border">—</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Daily spend bar ──────────────────────────────────────────────────────────

function SpendBar({ spent, cap }: { spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round(spent / cap * 100)) : 0;
  const critical = pct >= 85;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>Today's spend</span>
        <span className={critical ? "text-destructive font-semibold" : ""}>{spent}¢ / {cap}¢</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${critical ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/dashboard`);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json() as DashboardData;
      setData(json);
      setError(null);
      setLastRefresh(new Date());
    } catch {
      setError("Failed to load dashboard");
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const t = setInterval(() => void fetchData(), 30_000);
    return () => clearInterval(t);
  }, [fetchData]);

  const s = data?.summary;

  return (
    <Shell>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold tracking-tight">Trading Dashboard</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                All-time performance · auto-refreshes every 30 s
                {lastRefresh && (
                  <span className="ml-2 opacity-60">· last updated {fmtTime(lastRefresh.toISOString())}</span>
                )}
              </p>
            </div>
            <button
              onClick={() => void fetchData()}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors border rounded px-2.5 py-1"
            >
              Refresh
            </button>
          </div>

          {error && (
            <div className="border border-destructive/40 rounded-md p-3 text-sm text-destructive">{error}</div>
          )}

          {/* ── Stat cards ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Net P&L"
              value={s ? fmt$(s.pnl_cents) : "—"}
              sub={s ? `${s.settled_count} settled trade${s.settled_count !== 1 ? "s" : ""}` : undefined}
              valueClass={s
                ? s.pnl_cents > 0 ? "text-green-500" : s.pnl_cents < 0 ? "text-destructive" : ""
                : ""}
            />
            <StatCard
              label="Win Rate"
              value={s?.win_rate_pct !== null && s?.win_rate_pct !== undefined ? `${s.win_rate_pct}%` : "—"}
              sub={s ? `${s.win_count}W · ${s.loss_count}L` : undefined}
              valueClass={s?.win_rate_pct !== null && (s?.win_rate_pct ?? 0) >= 50 ? "text-green-500" : ""}
            />
            <StatCard
              label="Trades Placed"
              value={s ? String(s.total_placed) : "—"}
              sub={s ? `${s.pending_count} awaiting settlement` : undefined}
            />
            <div className="border bg-card p-5 flex flex-col gap-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Today's Budget</div>
              {s ? (
                <>
                  <div className="text-3xl font-bold tabular-nums tracking-tight">
                    {s.cost_today_cents}¢
                  </div>
                  <SpendBar spent={s.cost_today_cents} cap={s.daily_cap_cents} />
                </>
              ) : (
                <div className="text-3xl font-bold">—</div>
              )}
            </div>
          </div>

          {/* ── Chart + leaderboard ────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

            {/* P&L chart — takes 2/3 width */}
            <div className="md:col-span-2 border bg-card p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Daily P&L (¢)
              </div>
              <div className="h-48">
                {data ? <PnlChart data={data.pnl_by_day} /> : (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    Loading…
                  </div>
                )}
              </div>
            </div>

            {/* Station leaderboard — 1/3 width */}
            <div className="border bg-card p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Station Performance
              </div>
              {data ? (
                <StationLeaderboard rows={data.by_station} />
              ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
            </div>
          </div>

          {/* ── Live trading feed ───────────────────────────────────────────── */}
          <div className="border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Live Trading Feed
              </div>
              {data && (
                <span className="text-[10px] text-muted-foreground">
                  Last {data.recent_feed.length} decisions
                </span>
              )}
            </div>
            {data ? (
              <TradingFeed items={data.recent_feed} />
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
            )}
          </div>

        </div>
      </div>
    </Shell>
  );
}
