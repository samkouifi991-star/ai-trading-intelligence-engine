import { getAllConnectorHealth, type ConnectorStatus } from "../ingestion/connectorHealth";

export interface RequiredSource {
  key: string;
  weight: number;
}

export interface DataQualityBreakdownRow {
  sourceKey: string;
  status: ConnectorStatus | "unknown";
  weight: number;
  contribution: number; // 0-100, this source's own quality score
}

export interface DataQualityResult {
  score: number; // 0-100, weighted average across required sources
  breakdown: DataQualityBreakdownRow[];
}

/**
 * A source that was never attempted (no connector_health row yet) counts as
 * fully missing, not "fine by default" — a fresh deployment with a source
 * that has silently never fired should read as low quality, not 100.
 */
const STATUS_SCORE: Record<ConnectorStatus | "unknown", number> = {
  live: 100,
  partial: 65,
  sample: 40,
  blocked: 0,
  unknown: 0,
};

/**
 * Weighted data-quality score for one signal evaluation. This is what spec
 * rule 6 requires: "a trade score of 92 should NOT generate a trade when
 * critical market data quality is 45" — see
 * src/lib/signals/validation.ts's decideFinalStatus, which is the only
 * place this score is turned into a gating decision.
 */
export function computeDataQualityScore(requiredSources: RequiredSource[]): DataQualityResult {
  const health = getAllConnectorHealth();
  const byKey = new Map(health.map((h) => [h.sourceKey, h]));

  let totalWeight = 0;
  let weightedSum = 0;
  const breakdown: DataQualityBreakdownRow[] = requiredSources.map(({ key, weight }) => {
    const status = byKey.get(key)?.status ?? "unknown";
    const contribution = STATUS_SCORE[status];
    totalWeight += weight;
    weightedSum += contribution * weight;
    return { sourceKey: key, status, weight, contribution };
  });

  const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  return { score, breakdown };
}

/** Sources required to evaluate one Day-engine instrument: the shared news/
 * calendar/LLM layer, that instrument's own price feed, and the Day
 * engine's real-time cross-market confirmation inputs (DXY, both Treasury
 * rate-pressure proxies, VIX) — never FRED, which is daily-only. */
export function dayRequiredSources(symbol: string): RequiredSource[] {
  return [
    { key: "calendar", weight: 1 },
    { key: "news:forexfactory", weight: 2 }, // primary; ForexLive (secondary) is intentionally not gating
    { key: "llm", weight: 1 },
    { key: `marketData:${symbol}`, weight: 3 },
    { key: "marketData:DXY", weight: 2 },
    { key: "marketData:US2Y_PROXY", weight: 2 },
    { key: "marketData:US10Y_PROXY", weight: 2 },
    { key: "marketData:VIX", weight: 1 },
  ];
}

/** Sources required to evaluate one Swing-engine instrument: same shared
 * layer, that instrument's price feed, and daily FRED context (appropriate
 * for a medium-term thesis, unlike the Day engine's intraday need). */
export function swingRequiredSources(symbol: string): RequiredSource[] {
  return [
    { key: "calendar", weight: 1 },
    { key: "news:forexfactory", weight: 2 }, // primary; ForexLive (secondary) is intentionally not gating
    { key: "llm", weight: 1 },
    { key: `marketData:${symbol}`, weight: 2 },
    { key: "marketData:DXY", weight: 1 },
    { key: "marketData:FRED_DGS2", weight: 1 },
    { key: "marketData:FRED_DGS10", weight: 1 },
  ];
}
