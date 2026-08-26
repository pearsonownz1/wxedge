import { CloudRain, RefreshCw, TriangleAlert } from "lucide-react";
import {
  getGetRainMarketsQueryKey,
  useGetRainMarkets,
  type RainMarket,
} from "@workspace/api-client-react";
import { Shell } from "@/components/shell";
import { cn } from "@/lib/utils";

function cents(value: number | null): string {
  return value === null ? "—" : `${value}¢`;
}

function size(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function probability(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value)}%`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "rate_limited":
      return "Rate limited";
    case "network_error":
      return "Network error";
    case "no_current_contracts":
      return "No open contracts";
    case "unavailable":
      return "Unavailable";
    case "stale":
      return "Stale snapshot";
    default:
      return "Live";
  }
}

function MarketCard({ market }: { market: RainMarket }) {
  return (
    <article className="border bg-card p-4 grid gap-4 md:grid-cols-[minmax(180px,1.4fr)_repeat(4,minmax(90px,1fr))] md:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <CloudRain className="w-4 h-4 text-primary shrink-0" />
          <h2 className="font-bold truncate">{market.cityName}</h2>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {market.contractDate} · daily precipitation
        </div>
        <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground font-mono truncate" title={market.ticker}>
          {market.ticker}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">YES bid / ask</div>
        <div className="mt-1 font-bold data-mono">{cents(market.yesBidCents)} <span className="text-muted-foreground font-normal">/</span> {cents(market.yesAskCents)}</div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Available</div>
        <div className="mt-1 data-mono text-sm">
          <span title="YES bid size">{size(market.yesBidSize)}</span>
          <span className="text-muted-foreground"> / </span>
          <span title="YES ask size">{size(market.yesAskSize)}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">bid / ask</div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">NWS rain chance</div>
        <div className={cn("mt-1 font-bold data-mono", market.rainProbabilityPct === null && "text-muted-foreground")}>
          {probability(market.rainProbabilityPct)}
        </div>
      </div>

      <div className="md:text-right">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Settlement</div>
        <div className="mt-1 text-xs text-muted-foreground">The Weather Company</div>
        <div className="mt-1 text-[10px] text-muted-foreground">YES if precipitation &gt; 0″</div>
      </div>
    </article>
  );
}

export default function RainMarkets() {
  const { data, error, isLoading, isFetching, refetch } = useGetRainMarkets({
    query: {
      refetchInterval: 60_000,
      queryKey: getGetRainMarketsQueryKey(),
    },
  });

  const hasError = Boolean(error);
  const status = data?.feedStatus ?? (hasError ? "unavailable" : "live");

  return (
    <Shell>
      <div className="flex-1 bg-background overflow-auto">
        <div className="max-w-7xl mx-auto p-5 md:p-8">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <CloudRain className="w-6 h-6 text-primary" />
                <h1 className="text-2xl font-bold tracking-tight">Rain Markets</h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Daily KXRAIN contracts · public Kalshi quotes and NWS precipitation probability
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="inline-flex items-center justify-center gap-2 border bg-card px-3 py-2 text-xs font-bold uppercase tracking-wider hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
              Refresh
            </button>
          </div>

          {data && (
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-y py-3 text-xs text-muted-foreground">
              <span className={cn("font-bold uppercase tracking-wider", data.feedFresh ? "text-emerald-600" : "text-orange-700")}>
                <span className={cn("inline-block w-2 h-2 rounded-full mr-2", data.feedFresh ? "bg-emerald-500" : "bg-orange-500")} />
                {statusLabel(data.feedStatus)}
              </span>
              <span>{data.markets.length} active contract{data.markets.length === 1 ? "" : "s"}</span>
              {data.contractDate && <span>Contract date {data.contractDate}</span>}
              <span>Updated {new Date(data.fetchedAt).toLocaleTimeString()}</span>
            </div>
          )}

          {!data?.feedFresh && (
            <div className="mt-5 flex items-start gap-3 border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900">
              <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">
                  {hasError ? "Rain market data is unavailable." : `${statusLabel(status)} — quotes may be incomplete.`}
                </div>
                <div className="mt-1 text-xs">
                  This page never substitutes prices or probabilities when Kalshi or NWS data is unavailable.
                </div>
              </div>
            </div>
          )}

          {isLoading && (
            <div className="mt-8 border bg-card p-10 text-center text-sm text-muted-foreground">
              Loading active rain markets…
            </div>
          )}

          {!isLoading && data?.markets.length === 0 && (
            <div className="mt-8 border bg-card p-10 text-center">
              <CloudRain className="mx-auto w-8 h-8 text-muted-foreground" />
              <h2 className="mt-3 font-semibold">
                {data?.feedStatus === "no_current_contracts" ? "No rain contracts are open right now" : "No rain market data"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {data?.feedStatus === "no_current_contracts"
                  ? "The board will populate when the next daily KXRAIN contracts open."
                  : "Try refreshing when the public Kalshi feed is available."}
              </p>
            </div>
          )}

          {data && data.markets.length > 0 && (
            <div className="mt-6 space-y-3">
              {data.markets.map((market) => <MarketCard key={market.ticker} market={market} />)}
            </div>
          )}

          <div className="mt-6 text-xs text-muted-foreground">
            Probability source: {data?.probabilitySource ?? "NWS hourly precipitation probability"} · settlement source: {data?.settlementSource ?? "The Weather Company"}
          </div>
        </div>
      </div>
    </Shell>
  );
}