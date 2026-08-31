import { TRADABLE_UNIVERSE } from "../universe";
import { getRecentStories, getEventsInRange, saveSignal } from "../db/repository";
import { decayedSeverity, currentDecayFactor } from "../news/decay";
import { scoreEconomicSurprise, aggregateSurpriseScore } from "../economicSurprise/surpriseEngine";
import { getCurrentRegime } from "./regimePipeline";
import { relevantCurrenciesForInstrument } from "./economicPipeline";
import { getMarketDataConnector } from "../ingestion/marketData";
import { buildTechnicalReadout } from "../technical/indicators";
import { checkCrossAssetConfirmation } from "../crossAsset/confirmationEngine";
import { computeDayTradeScore } from "../scoring/dayTradeScore";
import { marketRegimeScore as regimeScoreOf } from "../regime/regimeEngine";
import { buildSignal } from "../signals/signalBuilder";
import { rankOpportunities } from "../scoring/rank";
import type { Direction, NewsStory, TradeSignal } from "../types";

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
  const { regime } = await getCurrentRegime();
  const { connector: marketData } = getMarketDataConnector();

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
    } catch {
      noTradeReasons.push(`${instrument.symbol}: market data unavailable.`);
      continue;
    }
    const technical = buildTechnicalReadout(snapshot);
    const macro = await marketData.getMacroSnapshot();
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
