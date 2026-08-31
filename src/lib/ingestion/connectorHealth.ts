import { getDb } from "../db/db";

export type ConnectorStatus = "live" | "partial" | "sample" | "blocked";

export interface ConnectorHealth {
  sourceKey: string;
  status: ConnectorStatus;
  detail: string;
  lastAttemptUtc: string;
  lastSuccessUtc: string | null;
}

/**
 * Every real connector call records its outcome here — this is what the
 * Live Data Status page reads, so status reflects what actually happened on
 * the last attempt, not a static "is a key configured" flag. Stored in the
 * DB (not memory) so status is consistent across separate serverless
 * invocations, which don't share process memory.
 */
export function recordConnectorHealth(sourceKey: string, status: ConnectorStatus, detail: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT last_success_utc FROM connector_health WHERE source_key = ?`).get(sourceKey) as
    | { last_success_utc: string | null }
    | undefined;
  const lastSuccessUtc = status === "live" || status === "partial" ? now : existing?.last_success_utc ?? null;

  db.prepare(
    `INSERT INTO connector_health (source_key, status, detail, last_attempt_utc, last_success_utc)
     VALUES (@sourceKey, @status, @detail, @lastAttemptUtc, @lastSuccessUtc)
     ON CONFLICT(source_key) DO UPDATE SET
       status = excluded.status, detail = excluded.detail,
       last_attempt_utc = excluded.last_attempt_utc, last_success_utc = excluded.last_success_utc`
  ).run({ sourceKey, status, detail, lastAttemptUtc: now, lastSuccessUtc });
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
  }));
}

/**
 * Wraps a real fetch attempt: on success, records 'live' (or 'partial' if
 * the caller's own validation flags the result degraded) and returns the
 * data; on failure, records 'blocked' with the real error message and
 * rethrows so the caller can fall back to sample data. Nothing here ever
 * silently swallows a failure into a fake "live" status.
 */
export async function withConnectorHealth<T>(
  sourceKey: string,
  fn: () => Promise<{ data: T; partial?: string }>
): Promise<T> {
  try {
    const { data, partial } = await fn();
    recordConnectorHealth(sourceKey, partial ? "partial" : "live", partial ?? "ok");
    return data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordConnectorHealth(sourceKey, "blocked", detail);
    throw err;
  }
}

export function recordSampleMode(sourceKey: string, reason: string): void {
  recordConnectorHealth(sourceKey, "sample", reason);
}
