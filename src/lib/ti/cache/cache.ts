import { getSql } from "../db/client";

/**
 * Cache layer for values that change constantly and must never be served by
 * re-scanning a growing history table on every dashboard request: current
 * currency strength, current market regime, latest price, current top
 * trade, current news score (see spec's "keep frequently changing values
 * in Redis/cache" guidance).
 *
 * No Redis instance is available yet (deferred per the user's own choice),
 * so this is a two-tier stand-in with the SAME interface a real Redis
 * client would have (get/set), so swapping the implementation later never
 * touches a call site:
 *
 *  1. An in-process Map with a short TTL — free, but only helps within one
 *     warm serverless instance; a cold start or a different instance always
 *     misses it. Documented honestly, not oversold as "real" caching.
 *  2. trading_intel.latest_values — a tiny single-row-per-key Postgres
 *     table (never scanned, never grows unbounded) that survives across
 *     instances/cold-starts. This is the actual cross-request cache today;
 *     the in-process layer just saves a round-trip within a warm instance.
 *
 * To upgrade to real Redis later: reimplement getCached/setCached against
 * an Upstash/Redis client instead of `latest_values` — every caller in
 * src/lib/ti keeps working unchanged.
 */

interface MemEntry<T> {
  value: T;
  expiresAtMs: number;
}

const memCache = new Map<string, MemEntry<unknown>>();

export async function getCached<T>(key: string, ttlMs: number): Promise<T | null> {
  const mem = memCache.get(key);
  if (mem && mem.expiresAtMs > Date.now()) return mem.value as T;

  const sql = getSql();
  const rows = await sql<{ valueJson: T; updatedAtUtc: Date }[]>`
    SELECT value_json, updated_at_utc FROM trading_intel.latest_values WHERE key = ${key}
  `;
  const row = rows[0];
  if (!row) return null;

  const ageMs = Date.now() - row.updatedAtUtc.getTime();
  if (ageMs > ttlMs) return null; // stale — caller should recompute, never serve indefinitely-old "current" state

  memCache.set(key, { value: row.valueJson, expiresAtMs: Date.now() + Math.min(ttlMs, 15_000) });
  return row.valueJson;
}

export async function setCached<T extends object>(key: string, value: T): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO trading_intel.latest_values (key, value_json, updated_at_utc)
    VALUES (${key}, ${sql.json(value as any)}, now())
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at_utc = excluded.updated_at_utc
  `;
  memCache.set(key, { value, expiresAtMs: Date.now() + 15_000 });
}

/** Age of a cached value in milliseconds, or null if never set — used to
 * drive freshness display (spec section 27) without transferring the value
 * itself. */
export async function getCachedAgeMs(key: string): Promise<number | null> {
  const sql = getSql();
  const rows = await sql<{ updatedAtUtc: Date }[]>`
    SELECT updated_at_utc FROM trading_intel.latest_values WHERE key = ${key}
  `;
  const row = rows[0];
  return row ? Date.now() - row.updatedAtUtc.getTime() : null;
}
