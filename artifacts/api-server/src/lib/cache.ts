/**
 * Simple in-memory TTL cache.
 * Freshness TTLs per data source:
 *   NWS observations: 5 min
 *   NWS forecast:     30 min
 *   Kalshi book:      30 s
 *   Calibration:      24 h (hardcoded seed, refreshed nightly)
 */

interface CacheEntry<T> {
  value: T;
  storedAt: number; // ms since epoch
  ttlMs: number;
}

class Cache {
  private store = new Map<string, CacheEntry<unknown>>();

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, storedAt: Date.now(), ttlMs });
  }

  get<T>(key: string): { value: T; ageMs: number } | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    const ageMs = Date.now() - entry.storedAt;
    if (ageMs > entry.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return { value: entry.value, ageMs };
  }

  /** Returns age in ms even if stale (for "last known" display). */
  peek<T>(key: string): { value: T; ageMs: number; fresh: boolean } | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    const ageMs = Date.now() - entry.storedAt;
    return { value: entry.value, ageMs, fresh: ageMs <= entry.ttlMs };
  }

  ageSeconds(key: string): number {
    const entry = this.store.get(key);
    if (!entry) return Infinity;
    return (Date.now() - entry.storedAt) / 1000;
  }
}

export const cache = new Cache();

export const TTL = {
  NWS_OBS_MS: 5 * 60 * 1000,       // 5 min
  NWS_FORECAST_MS: 30 * 60 * 1000, // 30 min
  KALSHI_BOOK_MS: 30 * 1000,        // 30 s
  CALIBRATION_MS: 24 * 60 * 60 * 1000, // 24 h
} as const;
