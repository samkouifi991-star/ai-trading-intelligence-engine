import { getDb } from "../db/db";
import { isProductionMode, DataUnavailableError } from "../config/appMode";

export type ConnectorStatus = "live" | "partial" | "sample" | "blocked";
export type StreamingMode = "streaming" | "polling";

export interface ConnectorHealth {
  sourceKey: string;
  status: ConnectorStatus;
  detail: string;
  lastAttemptUtc: string;
  lastSuccessUtc: string | null;
  latencyMs: number | null;
  realtime: boolean | null;
  streamingMode: StreamingMode | null;
  marketOpen: boolean | null;
}

export interface HealthMeta {
  latencyMs?: number;
  realtime?: boolean;
  streamingMode?: StreamingMode;
  marketOpen?: boolean;
}

/**
 * Every real connector call records its outcome here — this is what the
 * Live Data Status page reads, so status reflects what actually happened on
 * the last attempt, not a static "is a key configured" flag. Stored in the
 * DB (not memory) so status is consistent across separate serverless
 * invocations, which don't share process memory.
 */
export function recordConnectorHealth(sourceKey: string, status: ConnectorStatus, detail: string, meta: HealthMeta = {}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT last_success_utc FROM connector_health WHERE source_key = ?`).get(sourceKey) as
    | { last_success_utc: string | null }
    | undefined;
  const lastSuccessUtc = status === "live" || status === "partial" ? now : existing?.last_success_utc ?? null;

  db.prepare(
    `INSERT INTO connector_health (source_key, status, detail, last_attempt_utc, last_success_utc, latency_ms, realtime, streaming_mode, market_open)
     VALUES (@sourceKey, @status, @detail, @lastAttemptUtc, @lastSuccessUtc, @latencyMs, @realtime, @streamingMode, @marketOpen)
     ON CONFLICT(source_key) DO UPDATE SET
       status = excluded.status, detail = excluded.detail,
       last_attempt_utc = excluded.last_attempt_utc, last_success_utc = excluded.last_success_utc,
       latency_ms = excluded.latency_ms, realtime = excluded.realtime,
       streaming_mode = excluded.streaming_mode, market_open = excluded.market_open`
  ).run({
    sourceKey,
    status,
    detail,
    lastAttemptUtc: now,
    lastSuccessUtc,
    latencyMs: meta.latencyMs ?? null,
    realtime: meta.realtime === undefined ? null : meta.realtime ? 1 : 0,
    streamingMode: meta.streamingMode ?? null,
    marketOpen: meta.marketOpen === undefined ? null : meta.marketOpen ? 1 : 0,
  });
}

export function getAllConnectorHealth(): ConnectorHealth[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM connector_health ORDER BY source_key ASC`).all() as any[];
  return rows.map((r) => ({
    sourceKey: r.source_key,
    status: r.status,
    detail: r.detail,
    lastAttemptUtc: r.last_attempt_utc,
    lastSuccessUtc: r.last_success_utc,
    latencyMs: r.latency_ms,
    realtime: r.realtime === null ? null : Boolean(r.realtime),
    streamingMode: r.streaming_mode,
    marketOpen: r.market_open === null ? null : Boolean(r.market_open),
  }));
}

export function getConnectorHealthFor(sourceKey: string): ConnectorHealth | null {
  return getAllConnectorHealth().find((h) => h.sourceKey === sourceKey) ?? null;
}

/**
 * Wraps a real fetch attempt: measures latency, and on success records
 * 'live' (or 'partial' if the caller's own validation flags the result
 * degraded); on failure records 'blocked' with the real error message and
 * rethrows. Nothing here ever silently swallows a failure into a fake
 * "live" status.
 */
export async function withConnectorHealth<T>(
  sourceKey: string,
  fn: () => Promise<{ data: T; partial?: string }>,
  meta: HealthMeta = {}
): Promise<T> {
  const start = Date.now();
  try {
    const { data, partial } = await fn();
    recordConnectorHealth(sourceKey, partial ? "partial" : "live", partial ?? "ok", { ...meta, latencyMs: Date.now() - start });
    return data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordConnectorHealth(sourceKey, "blocked", detail, { ...meta, latencyMs: Date.now() - start });
    throw err;
  }
}

export function recordSampleMode(sourceKey: string, reason: string): void {
  recordConnectorHealth(sourceKey, "sample", reason);
}

/**
 * THE dev/production fallback boundary (spec rule 5: "sample data may
 * never create a production trade"). `liveFn` should already be wrapped in
 * withConnectorHealth (so the failure is recorded either way). In
 * development, a failure falls back to sample data so the pipeline keeps
 * running for testing. In production, a failure throws DataUnavailableError
 * instead — callers must catch this per-instrument/per-source and mark that
 * evaluation as blocked (NO_TRADE with an explicit reason), never score on
 * fabricated inputs.
 */
export async function resolveLiveOrFallback<T>(
  sourceKey: string,
  liveFn: () => Promise<T>,
  sampleFn: () => T | Promise<T>
): Promise<T> {
  try {
    return await liveFn();
  } catch (err) {
    if (isProductionMode()) {
      throw new DataUnavailableError(sourceKey, err);
    }
    return sampleFn();
  }
}

export { DataUnavailableError };
