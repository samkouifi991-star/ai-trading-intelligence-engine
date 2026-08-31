import { TRADABLE_UNIVERSE } from "../universe";
import { getRecentStories, getEventsInRange, saveSignal } from "../db/repository";
import { decayedSeverity, currentDecayFactor } from "../news/decay";
import { scoreEconomicSurprise, aggregateSurpriseScore } from "../economicSurprise/surpriseEngine";
import { relevantCurrenciesForInstrument } from "./economicPipeline";
import { getMarketDataConnector } from "../ingestion/marketData";
import { buildTechnicalReadout } from "../technical/indicators";
import { checkCrossAssetConfirmation } from "../crossAsset/confirmationEngine";
import { computeDayTradeScore } from "../scoring/dayTradeScore";
import { computeMacroRegime, marketRegimeScore as regimeScoreOf } from "../regime/regimeEngine";
import { buildSignal } from "../signals/signalBuilder";
import { rankOpportunities } from "../scoring/rank";
import { computeDataQualityScore, dayRequiredSources } from "../dataQuality/dataQualityEngine";
import type { Direction, MacroRegime, MacroSnapshot, NewsStory, TradeSignal } from "../types";

const MIN_DECAYED_SEVERITY_TO_CONSIDER = 8;
const MIN_ABS_IMPACT_TO_CONSIDER = 12;

export interface DayEngineResult {
  regimeSummary: string;
  candidates: TradeSignal[];
  ranked: TradeSignal[];
  suppressed: { instrument: string; reason: string }[];
  noTradeReasons: string[];
}

export async function runDayEngine(now: Date = new Date()): Promise<DayEngineResult> {
  const { connector: marketData } = getMarketDataConnector();

  // Fetched ONCE for the whole tick, not per-instrument — every instrument's
  // cross-market confirmation compares against the same macro snapshot, and
  // if it's unavailable (production mode with a required source blocked),
  // that's a "can't safely evaluate anything this tick" condition, not a
  // per-instrument one.
  let macro: MacroSnapshot;
  let regime: MacroRegime;
  try {
    macro = await marketData.getMacroSnapshot();
    regime = computeMacroRegime(macro);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      regimeSummary: `Regime unavailable: ${reason}`,
      candidates: [],
      ranked: [],
      suppressed: [],
      noTradeReasons: TRADABLE_UNIVERSE.map(
        (i) => `${i.symbol}: required cross-market confirmation data unavailable (${reason}).`
      ),
    };
  }

  const allStories = getRecentStories(60);
  const dayStories = allStories.filter(
    (s) => (s.tradingHorizon === "day" || s.tradingHorizon === "both") && decayedSeverity(s, "day", now) >= MIN_DECAYED_SEVERITY_TO_CONSIDER
  );

  const recentEvents = getEventsInRange(
    new Date(now.getTime() - 24 * 3600_000).toISOString(),
    now.toISOString()
  ).filter((e) => e.actual !== null);
  const upcomingEvents = getEventsInRange(now.toISOString(), new Date(now.getTime() + 12 * 3600_000).toISOString());
  const surprisePairs = recentEvents.map((e) => ({ event: e, result: scoreEconomicSurprise(e, regime) }));

  const candidates: TradeSignal[] = [];
  const noTradeReasons: string[] = [];

  for (const instrument of TRADABLE_UNIVERSE) {
    const catalyst = pickStrongestCatalyst(dayStories, instrument.symbol, now);
    if (!catalyst) {
      noTradeReasons.push(`${instrument.symbol}: no active news catalyst above decay threshold.`);
      continue;
    }

    const { story, impactScore, decayFactor } = catalyst;
    const direction: Direction = impactScore > 0 ? "LONG" : "SHORT";
    const newsCatalystScore = Math.min(
      100,
      Math.abs(impactScore) * decayFactor * (story.latestAnalysis.confidence / 100)
    );

    const relevantCurrencies = relevantCurrenciesForInstrument(instrument.symbol);
    const relevantSurprises = surprisePairs
      .filter((p) => relevantCurrencies.includes(p.event.currency))
      .map((p) => p.result);
    const economicSurpriseScore = aggregateSurpriseScore(relevantSurprises);

    let snapshot;
    try {
      snapshot = await marketData.getSnapshot(instrument.symbol);
    } catch (err) {
      noTradeReasons.push(`${instrument.symbol}: market data unavailable (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    const technical = buildTechnicalReadout(snapshot);
    const crossAssetCheck = checkCrossAssetConfirmation({
      symbol: instrument.symbol,
      predictedDirection: direction,
      macro,
      technical,
    });

    const breakdown = computeDayTradeScore({
      newsCatalystScore,
      economicSurpriseScore,
      crossMarketConfirmationScore: crossAssetCheck.confirmationScore,
      technicalScore: technical.technicalScore,
      marketRegimeScore: regimeScoreOf(regime),
    });

    const upcomingRisks = upcomingEvents
      .filter((e) => relevantCurrencies.includes(e.currency))
      .map((e) => `${e.event} (${e.currency}, ${e.impact} impact) at ${e.eventTimeUtc}`);

    const dataQuality = computeDataQualityScore(dayRequiredSources(instrument.symbol));

    const signal = buildSignal({
      engine: "DAY",
      instrument: instrument.symbol,
      direction,
      breakdown,
      catalyst: story.latestAnalysis.headline,
      newsSummary: story.latestAnalysis.causalChain.join(" → "),
      currentPrice: snapshot.last,
      technical,
      crossAssetCheck,
      story,
      upcomingRisks,
      newsImpactScore: impactScore,
      dataQualityScore: dataQuality.score,
      now,
    });

    saveSignal(signal);
    candidates.push(signal);
  }

  const { ranked, suppressed } = rankOpportunities(candidates);

  return {
    regimeSummary: regime.summary,
    candidates,
    ranked: ranked.map((r) => r.signal),
    suppressed: suppressed.map((s) => ({ instrument: s.signal.instrument, reason: s.reason })),
    noTradeReasons,
  };
}

function pickStrongestCatalyst(
  stories: NewsStory[],
  symbol: string,
  now: Date
): { story: NewsStory; impactScore: number; decayFactor: number } | null {
  let best: { story: NewsStory; impactScore: number; decayFactor: number } | null = null;
  for (const story of stories) {
    const impact = story.latestAnalysis.expectedAssetImpact.find((i) => i.symbol === symbol);
    if (!impact || Math.abs(impact.score) < MIN_ABS_IMPACT_TO_CONSIDER) continue;
    const decayFactor = currentDecayFactor(story, "day", now);
    const decayedAbs = Math.abs(impact.score) * decayFactor;
    if (!best || decayedAbs > Math.abs(best.impactScore) * best.decayFactor) {
      best = { story, impactScore: impact.score, decayFactor };
    }
  }
  return best;
}
