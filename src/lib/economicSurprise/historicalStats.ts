import { getIndicatorHistory, indicatorKey } from "../db/repository";
import { INDICATOR_CATALOG } from "../ingestion/forexFactoryCalendar";
import type { EconomicEvent } from "../types";

export interface SurpriseDistribution {
  mean: number;
  stdDev: number;
  sampleSize: number;
  bootstrapped: boolean;
}

const MIN_SAMPLES_FOR_REAL_STATS = 8;

/** Historical distribution of (actual - forecast) surprises for one
 * indicator. Falls back to the catalog's typical std-dev (a reasonable prior
 * for a brand-new indicator with no accumulated history yet) so the surprise
 * engine always has *something* principled to divide by — never a naive
 * "actual > forecast = bullish" shortcut. */
export function getSurpriseDistribution(event: Pick<EconomicEvent, "event" | "currency">): SurpriseDistribution {
  const key = indicatorKey(event);
  const rows = getIndicatorHistory(key, 200).filter((r) => r.surprise !== null);

  if (rows.length >= MIN_SAMPLES_FOR_REAL_STATS) {
    const surprises = rows.map((r) => r.surprise as number);
    const mean = average(surprises);
    const stdDev = Math.sqrt(average(surprises.map((s) => (s - mean) ** 2)));
    return { mean, stdDev: stdDev || catalogFallback(event).typicalStdDev, sampleSize: surprises.length, bootstrapped: false };
  }

  const fallback = catalogFallback(event);
  return { mean: 0, stdDev: fallback.typicalStdDev, sampleSize: rows.length, bootstrapped: true };
}

function catalogFallback(event: Pick<EconomicEvent, "event" | "currency">) {
  const found = INDICATOR_CATALOG.find(
    (c) => c.event.toLowerCase() === event.event.toLowerCase() && c.currency === event.currency
  );
  return found ?? { typicalStdDev: 1, typicalForecast: 0, event: event.event, currency: event.currency, impact: "medium" as const, unit: "" };
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
