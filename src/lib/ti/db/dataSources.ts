import { getSql } from "./client";
import { isProductionMode } from "../../config/appMode";

export type SourceStatus = "live" | "partial" | "sample" | "blocked";

export interface DataSourceHealth {
  sourceKey: string;
  status: SourceStatus;
  detail: string;
  lastAttemptUtc: Date;
  lastSuccessUtc: Date | null;
  latencyMs: number | null;
  realtime: boolean | null;
  streamingMode: "streaming" | "polling" | null;
}

export interface HealthMeta {
  latencyMs?: number;
  realtime?: boolean;
  streamingMode?: "streaming" | "polling";
}

/** Thrown by a live connector when a real fetch fails in production mode
 * instead of silently substituting sample data — the trading-intelligence
 * equivalent of the Day/Swing engine's DataUnavailableError. A signal must
 * never be scored on fabricated inputs; this is caught per-source and the
 * affected computation is marked DATA UNAVAILABLE. */
export class TiDataUnavailableError extends Error {
  constructor(public readonly sourceKey: string, public readonly cause: unknown) {
    super(`Data unavailable for ${sourceKey} in production mode: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TiDataUnavailableError";
  }
}

/** Records the outcome of a real fetch attempt — every ingestion function
 * calls this on both success and failure, never silently. Backs the
 * freshness/status display (spec section 27). */
export async function recordSourceHealth(sourceKey: string, status: SourceStatus, detail: string, meta: HealthMeta = {}): Promise<void> {
  const sql = getSql();
  const now = new Date();
  const existing = await sql<{ lastSuccessUtc: Date | null }[]>`
    SELECT last_success_utc FROM trading_intel.data_sources WHERE source_key = ${sourceKey}
  `;
  const lastSuccessUtc = status === "live" || status === "partial" ? now : existing[0]?.lastSuccessUtc ?? null;

  await sql`
    INSERT INTO trading_intel.data_sources
      (source_key, status, detail, last_attempt_utc, last_success_utc, latency_ms, realtime, streaming_mode)
    VALUES
      (${sourceKey}, ${status}, ${detail}, ${now}, ${lastSuccessUtc}, ${meta.latencyMs ?? null}, ${meta.realtime ?? null}, ${meta.streamingMode ?? null})
    ON CONFLICT (source_key) DO UPDATE SET
      status = excluded.status, detail = excluded.detail,
      last_attempt_utc = excluded.last_attempt_utc, last_success_utc = excluded.last_success_utc,
      latency_ms = excluded.latency_ms, realtime = excluded.realtime, streaming_mode = excluded.streaming_mode
  `;

  await sql`
    INSERT INTO trading_intel.ingestion_logs (source_key, outcome, detail, duration_ms, at_utc)
    VALUES (${sourceKey}, ${status === "blocked" ? "failure" : status === "partial" ? "partial" : "success"}, ${detail}, ${meta.latencyMs ?? null}, ${now})
  `;
}

export async function getAllSourceHealth(): Promise<DataSourceHealth[]> {
  const sql = getSql();
  return sql<DataSourceHealth[]>`
    SELECT source_key, status, detail, last_attempt_utc, last_success_utc, latency_ms, realtime, streaming_mode
    FROM trading_intel.data_sources ORDER BY source_key ASC
  `;
}

export async function getSourceHealth(sourceKey: string): Promise<DataSourceHealth | null> {
  const sql = getSql();
  const rows = await sql<DataSourceHealth[]>`
    SELECT source_key, status, detail, last_attempt_utc, last_success_utc, latency_ms, realtime, streaming_mode
    FROM trading_intel.data_sources WHERE source_key = ${sourceKey}
  `;
  return rows[0] ?? null;
}

/** Wraps a real fetch attempt: measures latency, records 'live' (or
 * 'partial' if the caller flags the result degraded) on success, 'blocked'
 * with the real error message on failure, and rethrows — nothing here ever
 * swallows a failure into a fake "live" status. */
export async function withSourceHealth<T>(
  sourceKey: string,
  fn: () => Promise<{ data: T; partial?: string }>,
  meta: HealthMeta = {}
): Promise<T> {
  const start = Date.now();
  try {
    const { data, partial } = await fn();
    await recordSourceHealth(sourceKey, partial ? "partial" : "live", partial ?? "ok", { ...meta, latencyMs: Date.now() - start });
    return data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await recordSourceHealth(sourceKey, "blocked", detail, { ...meta, latencyMs: Date.now() - start });
    throw err;
  }
}

/** THE dev/production fallback boundary — identical rule to the Day/Swing
 * engine's resolveLiveOrFallback: in development, a failure falls back to
 * sample data so the pipeline keeps running for testing; in production, a
 * failure throws TiDataUnavailableError instead. `liveFn` should already be
 * wrapped in withSourceHealth so the failure is recorded either way. */
export async function resolveLiveOrSample<T>(
  sourceKey: string,
  liveFn: () => Promise<T>,
  sampleFn: () => T | Promise<T>
): Promise<T> {
  try {
    return await liveFn();
  } catch (err) {
    if (isProductionMode()) {
      throw new TiDataUnavailableError(sourceKey, err);
    }
    return sampleFn();
  }
}

export function recordSampleMode(sourceKey: string, reason: string): Promise<void> {
  return recordSourceHealth(sourceKey, "sample", reason);
}
