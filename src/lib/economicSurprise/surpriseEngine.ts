import { indicatorPolarity } from "../ingestion/forexFactoryCalendar";
import type { EconomicEvent, EconomicSurpriseResult, MacroRegime } from "../types";
import { getSurpriseDistribution } from "./historicalStats";

const CURRENT_WEIGHT = 0.75;
const REVISION_WEIGHT = 0.25;

/**
 * Never treats `actual > forecast` as inherently bullish. Everything is
 * expressed as a z-score against that indicator's own historical surprise
 * distribution, blended with the revision-to-previous surprise, then
 * resolved to a hawkish/dovish/mixed read via the indicator's known economic
 * polarity — adjusted for which side of that polarity the *current macro
 * regime* is likely to prioritize (see resolveDirectionality below).
 */
export function scoreEconomicSurprise(
  event: EconomicEvent,
  regime: MacroRegime | null
): EconomicSurpriseResult {
  const dist = getSurpriseDistribution(event);

  const currentSurpriseZ =
    event.actual !== null && event.forecast !== null
      ? (event.actual - event.forecast - dist.mean) / (dist.stdDev || 1)
      : null;

  const revisionSurpriseZ =
    event.revisedPrevious !== null && event.previous !== null
      ? (event.revisedPrevious - event.previous) / (dist.stdDev || 1)
      : null;

  let effectiveSurpriseZ: number | null = null;
  if (currentSurpriseZ !== null && revisionSurpriseZ !== null) {
    effectiveSurpriseZ = CURRENT_WEIGHT * currentSurpriseZ + REVISION_WEIGHT * revisionSurpriseZ;
  } else if (currentSurpriseZ !== null) {
    effectiveSurpriseZ = currentSurpriseZ;
  } else if (revisionSurpriseZ !== null) {
    effectiveSurpriseZ = revisionSurpriseZ;
  }

  const { directionality, note } = resolveDirectionality(event, effectiveSurpriseZ, regime);

  return {
    eventId: event.id,
    indicatorKey: `${event.currency}:${event.event}`.toLowerCase(),
    currentSurpriseZ,
    revisionSurpriseZ,
    effectiveSurpriseZ,
    directionality,
    regimeAdjustedNote: note,
  };
}

/** Converts a set of recent surprise results relevant to an instrument into a
 * single 0-100 "economic surprise" score for the day-trade composite. Larger
 * |effectiveSurpriseZ| (regardless of sign) means the market has more
 * genuine economic fuel to react to; magnitude, not direction, drives the
 * score — direction is handled separately via directionality/asset impact. */
export function aggregateSurpriseScore(results: EconomicSurpriseResult[]): number {
  const withZ = results.filter((r) => r.effectiveSurpriseZ !== null) as (EconomicSurpriseResult & { effectiveSurpriseZ: number })[];
  if (withZ.length === 0) return 0;
  const maxAbsZ = Math.max(...withZ.map((r) => Math.abs(r.effectiveSurpriseZ)));
  // |z|=0 -> 0, |z|=1 -> ~55, |z|=2 -> ~86, |z|=3+ -> ~100 (diminishing returns)
  const score = 100 * (1 - Math.exp(-maxAbsZ / 1.4));
  return Math.round(Math.min(100, Math.max(0, score)));
}

function resolveDirectionality(
  event: EconomicEvent,
  effectiveZ: number | null,
  regime: MacroRegime | null
): { directionality: EconomicSurpriseResult["directionality"]; note: string } {
  if (effectiveZ === null) {
    return { directionality: "unclear", note: "No actual/forecast pair yet — awaiting release." };
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
      note: `${event.event}: ${hawkish ? "beat" : "miss"} vs. its own historical surprise distribution (z=${effectiveZ.toFixed(2)}) reads ${hawkish ? "hawkish/inflationary" : "dovish/growth-negative"}.`,
    };
  }

  if (polarity === "higher_dovish") {
    // e.g. unemployment rate, jobless claims: a positive surprise (higher
    // than expected) signals labor-market weakness → dovish.
    const dovish = positiveSurprise;
    return {
      directionality: dovish ? "dovish" : "hawkish",
      note: `${event.event}: ${dovish ? "higher than expected (labor weakness)" : "lower than expected (labor strength)"} (z=${effectiveZ.toFixed(2)}) reads ${dovish ? "dovish" : "hawkish"}.`,
    };
  }

  // context_dependent (e.g. Retail Sales): growth-positive on its face, but
  // whether the market prices it as hawkish (rates stay higher) or simply
  // risk-positive depends on the prevailing regime.
  if (regime?.inflation === "rising" || regime?.rateBias === "hawkish") {
    return {
      directionality: positiveSurprise ? "hawkish" : "dovish",
      note: `${event.event}: strong regime (${regime.inflation} inflation / ${regime.rateBias} bias) means a ${positiveSurprise ? "beat" : "miss"} (z=${effectiveZ.toFixed(2)}) is likely priced as rate-path relevant, i.e. ${positiveSurprise ? "hawkish" : "dovish"} rather than purely growth-positive.`,
    };
  }
  return {
    directionality: "mixed",
    note: `${event.event}: ${positiveSurprise ? "beat" : "miss"} (z=${effectiveZ.toFixed(2)}) is growth-relevant but regime is not clearly hawkish/dovish, so read as mixed rather than assuming a rate-path implication.`,
  };
}
