import { getSql } from "./client";

export interface EconomicSurpriseRecord {
  eventId: string;
  indicatorKey: string;
  currency: string;
  currentSurpriseZ: number | null;
  revisionSurpriseZ: number | null;
  effectiveSurpriseZ: number | null;
  historicalMean: number;
  historicalStdDev: number;
  historicalSampleSize: number;
  historicalBootstrapped: boolean;
  impactWeight: number;
  regimeAtComputation: string | null;
  directionality: "hawkish" | "dovish" | "mixed" | "unclear";
  currencyScore: number;
  regimeAdjustedNote: string;
  isSampleSource: boolean;
}

/** Every calculated surprise score is stored with the full components that
 * produced it (spec: "store every calculated score and the components that
 * created it") — this is the audit trail behind the explainability panel. */
export async function saveEconomicSurprise(r: EconomicSurpriseRecord): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO trading_intel.economic_surprises
      (event_id, indicator_key, currency, current_surprise_z, revision_surprise_z, effective_surprise_z,
       historical_mean, historical_std_dev, historical_sample_size, historical_bootstrapped,
       impact_weight, regime_at_computation, directionality, currency_score, regime_adjusted_note, is_sample_source)
    VALUES
      (${r.eventId}, ${r.indicatorKey}, ${r.currency}, ${r.currentSurpriseZ}, ${r.revisionSurpriseZ}, ${r.effectiveSurpriseZ},
       ${r.historicalMean}, ${r.historicalStdDev}, ${r.historicalSampleSize}, ${r.historicalBootstrapped},
       ${r.impactWeight}, ${r.regimeAtComputation}, ${r.directionality}, ${r.currencyScore}, ${r.regimeAdjustedNote}, ${r.isSampleSource})
  `;
}

export interface RecentSurpriseRow {
  currency: string;
  currencyScore: number;
  directionality: string;
  computedAtUtc: Date;
  indicatorKey: string;
}

/** Used to avoid re-scoring the same released event on every ingestion tick
 * when nothing about it has changed — returns null if never scored. */
export async function getLatestSurpriseComputedAt(eventId: string): Promise<Date | null> {
  const sql = getSql();
  const rows = await sql<{ computedAtUtc: Date }[]>`
    SELECT computed_at_utc FROM trading_intel.economic_surprises
    WHERE event_id = ${eventId}
    ORDER BY computed_at_utc DESC
    LIMIT 1
  `;
  return rows[0]?.computedAtUtc ?? null;
}

/** Selective columns, bounded window, indexed on (currency, computed_at_utc)
 * — the query the Currency Strength Engine's economic component reads.
 * Sample-sourced surprises (development mode, live calendar unreachable)
 * are excluded — they must never silently feed a score presented as real. */
export async function getRecentSurprisesForCurrency(currency: string, sinceUtc: string): Promise<RecentSurpriseRow[]> {
  const sql = getSql();
  return sql<RecentSurpriseRow[]>`
    SELECT currency, currency_score, directionality, computed_at_utc, indicator_key
    FROM trading_intel.economic_surprises
    WHERE currency = ${currency} AND computed_at_utc >= ${sinceUtc} AND is_sample_source = false
    ORDER BY computed_at_utc DESC
    LIMIT 50
  `;
}
