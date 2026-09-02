import { indicatorPolarity, INDICATOR_CATALOG } from "../../ingestion/forexFactoryCalendar";
import { getIndicatorHistory, indicatorKey } from "../db/economicEvents";
import { saveEconomicSurprise } from "../db/economicSurprises";
import type { EconomicEvent } from "../../types";

export interface SurpriseDistribution {
  mean: number;
  stdDev: number;
  sampleSize: number;
  bootstrapped: boolean;
}

const MIN_SAMPLES_FOR_REAL_STATS = 8;
const IMPACT_WEIGHT: Record<EconomicEvent["impact"], number> = { high: 1, medium: 0.6, low: 0.3 };

/**
 * Economic Surprise Engine — never treats (actual - forecast) alone as
 * bullish/bearish. Every surprise is expressed as a z-score against that
 * specific indicator's own historical surprise distribution (built from
 * trading_intel.indicator_history, which grows with every real release this
 * app ingests), blended with the revision-to-previous surprise, then
 * resolved to hawkish/dovish/mixed via the indicator's known economic
 * polarity, adjusted for FF impact level and — where a regime label is
 * supplied — the prevailing monetary-policy regime.
 *
 * Falls back to the indicator's catalog-typical std-dev only when there
 * isn't yet enough real history (a principled prior for a brand-new
 * indicator, never a naive shortcut) — see getSurpriseDistribution.
 */
export async function getSurpriseDistribution(event: Pick<EconomicEvent, "event" | "currency">): Promise<SurpriseDistribution> {
  const key = indicatorKey(event);
  const rows = (await getIndicatorHistory(key, 200)).filter((r) => r.surprise !== null);

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
  const found = INDICATOR_CATALOG.find((c) => c.event.toLowerCase() === event.event.toLowerCase() && c.currency === event.currency);
  return found ?? { typicalStdDev: 1, typicalForecast: 0, event: event.event, currency: event.currency, impact: "medium" as const, unit: "" };
}

/**
 * Pure scoring math, exported for unit testing without a live DB
 * connection: magnitude |z|=0 -> 0, |z|=1 -> ~55, |z|=2 -> ~86, |z|=3+ ->
 * ~100 (diminishing returns — one enormous surprise doesn't blow through
 * the scale any harder than a merely-large one), scaled by how much this
 * specific release matters (FF impact level), signed by directionality,
 * clamped to the spec's -100..100 range.
 */
export function computeSurpriseCurrencyScore(
  effectiveSurpriseZ: number | null,
  directionality: SurpriseScoreResult["directionality"],
  impactWeight: number
): number {
  const magnitude = effectiveSurpriseZ === null ? 0 : 100 * (1 - Math.exp(-Math.abs(effectiveSurpriseZ) / 1.4)) * impactWeight;
  const sign = directionality === "hawkish" ? 1 : directionality === "dovish" ? -1 : 0;
  return Math.round(Math.max(-100, Math.min(100, sign * magnitude)));
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface SurpriseScoreResult {
  currencyScore: number; // -100..100, the spec's normalized scale
  directionality: "hawkish" | "dovish" | "mixed" | "unclear";
  effectiveSurpriseZ: number | null;
  note: string;
}

/**
 * Scores one released economic event and persists the full audit trail.
 * `regimeSummary` is an optional free-text snapshot of the current macro
 * regime (from Phase 3's regime engine, once wired) — passed through only
 * for context_dependent indicators (e.g. Retail Sales) whose hawkish/dovish
 * read genuinely depends on the prevailing regime; every other indicator's
 * directionality is regime-independent.
 */
export async function scoreEconomicSurprise(event: EconomicEvent, regimeSummary: string | null = null): Promise<SurpriseScoreResult | null> {
  if (event.actual === null) return null; // not released yet — nothing to score

  const dist = await getSurpriseDistribution(event);

  const currentSurpriseZ = event.forecast !== null ? (event.actual - event.forecast - dist.mean) / (dist.stdDev || 1) : null;
  const revisionSurpriseZ =
    event.revisedPrevious !== null && event.previous !== null ? (event.revisedPrevious - event.previous) / (dist.stdDev || 1) : null;

  let effectiveSurpriseZ: number | null = null;
  if (currentSurpriseZ !== null && revisionSurpriseZ !== null) {
    effectiveSurpriseZ = 0.75 * currentSurpriseZ + 0.25 * revisionSurpriseZ;
  } else if (currentSurpriseZ !== null) {
    effectiveSurpriseZ = currentSurpriseZ;
  } else if (revisionSurpriseZ !== null) {
    effectiveSurpriseZ = revisionSurpriseZ;
  }

  const { directionality, note } = resolveDirectionality(event, effectiveSurpriseZ, regimeSummary);
  const impactWeight = IMPACT_WEIGHT[event.impact];
  const currencyScore = computeSurpriseCurrencyScore(effectiveSurpriseZ, directionality, impactWeight);

  await saveEconomicSurprise({
    eventId: event.id,
    indicatorKey: indicatorKey(event),
    currency: event.currency,
    currentSurpriseZ,
    revisionSurpriseZ,
    effectiveSurpriseZ,
    historicalMean: dist.mean,
    historicalStdDev: dist.stdDev,
    historicalSampleSize: dist.sampleSize,
    historicalBootstrapped: dist.bootstrapped,
    impactWeight,
    regimeAtComputation: regimeSummary,
    directionality,
    currencyScore,
    regimeAdjustedNote: note,
    isSampleSource: event.source === "sample-fixture",
  });

  return { currencyScore, directionality, effectiveSurpriseZ, note };
}

/** Exported for unit testing without a live DB connection. */
export function resolveDirectionality(
  event: EconomicEvent,
  effectiveZ: number | null,
  regimeSummary: string | null
): { directionality: SurpriseScoreResult["directionality"]; note: string } {
  if (effectiveZ === null) {
    return { directionality: "unclear", note: "No actual/forecast pair — cannot score a surprise without both." };
  }
  const polarity = indicatorPolarity(event.event);
  const positiveSurprise = effectiveZ > 0.15;
  const negativeSurprise = effectiveZ < -0.15;

  if (!positiveSurprise && !negativeSurprise) {
    return { directionality: "mixed", note: "Surprise within noise band (|z| < 0.15) — not decision-relevant." };
  }

  if (polarity === "higher_hawkish") {
    const hawkish = positiveSurprise;
    return {
      directionality: hawkish ? "hawkish" : "dovish",
      note: `${event.event}: ${hawkish ? "beat" : "miss"} vs. its own historical surprise distribution (z=${effectiveZ.toFixed(2)}) reads ${hawkish ? "hawkish/inflationary" : "dovish/growth-negative"} for ${event.currency}.`,
    };
  }

  if (polarity === "higher_dovish") {
    const dovish = positiveSurprise;
    return {
      directionality: dovish ? "dovish" : "hawkish",
      note: `${event.event}: ${dovish ? "higher than expected (labor weakness)" : "lower than expected (labor strength)"} (z=${effectiveZ.toFixed(2)}) reads ${dovish ? "dovish" : "hawkish"} for ${event.currency}.`,
    };
  }

  // context_dependent (e.g. Retail Sales): whether the market prices it as
  // rate-path-relevant depends on the regime, when one is supplied.
  if (regimeSummary && /hawkish|rising inflation/i.test(regimeSummary)) {
    return {
      directionality: positiveSurprise ? "hawkish" : "dovish",
      note: `${event.event}: current regime (${regimeSummary}) means a ${positiveSurprise ? "beat" : "miss"} (z=${effectiveZ.toFixed(2)}) is likely priced as rate-path relevant.`,
    };
  }
  return {
    directionality: "mixed",
    note: `${event.event}: ${positiveSurprise ? "beat" : "miss"} (z=${effectiveZ.toFixed(2)}) is growth-relevant but no clearly hawkish/dovish regime context is available, so read as mixed rather than assuming a rate-path implication.`,
  };
}
