import { TRADABLE_UNIVERSE } from "../universe";
import { getRecentStories, saveSignal } from "../db/repository";
import { decayedSeverity, currentDecayFactor } from "../news/decay";
import { getCurrentRegime } from "./regimePipeline";
import { getMarketDataConnector } from "../ingestion/marketData";
import { buildTechnicalReadout } from "../technical/indicators";
import { checkCrossAssetConfirmation } from "../crossAsset/confirmationEngine";
import { computeSwingScore } from "../scoring/swingScore";
import { marketRegimeScore as regimeScoreOf } from "../regime/regimeEngine";
import { buildSignal } from "../signals/signalBuilder";
import { rankOpportunities } from "../scoring/rank";
import type { Direction, NewsStory, TradeSignal } from "../types";

const MIN_DECAYED_SEVERITY_TO_CONSIDER = 15;

export interface SwingEngineResult {
  regimeSummary: string;
  centralBankBias: string;
  activeThemes: string[];
  candidates: TradeSignal[];
  ranked: TradeSignal[];
  suppressed: { instrument: string; reason: string }[];
  noIdeaReasons: string[];
}

export async function runSwingEngine(now: Date = new Date()): Promise<SwingEngineResult> {
  const { regime } = await getCurrentRegime();
  const { connector: marketData } = getMarketDataConnector();

  const allStories = getRecentStories(80);
  const swingStories = allStories.filter(
    (s) => (s.tradingHorizon === "swing" || s.tradingHorizon === "both") && decayedSeverity(s, "swing", now) >= MIN_DECAYED_SEVERITY_TO_CONSIDER
  );

  const macroRegimeScore = regimeScoreOf(regime);
  const centralBankOutlookScore =
    regime.rateBias === "neutral" ? 40 : Math.round(50 + regime.regimeScore / 2);

  const activeThemes = Array.from(
    new Set(swingStories.map((s) => s.latestAnalysis.eventType))
  );

  const candidates: TradeSignal[] = [];
  const noIdeaReasons: string[] = [];

  for (const instrument of TRADABLE_UNIVERSE) {
    const relevant = swingStories.filter((s) =>
      s.latestAnalysis.expectedAssetImpact.some((i) => i.symbol === instrument.symbol)
    );
    if (relevant.length === 0) {
      noIdeaReasons.push(`${instrument.symbol}: no story currently changes the medium-term thesis.`);
      continue;
    }

    const { aggregateImpact, geopoliticalImpact } = aggregateInstrumentImpact(relevant, instrument.symbol, now);
    if (Math.abs(aggregateImpact) < 10) {
      noIdeaReasons.push(`${instrument.symbol}: swing catalysts present but net impact too small/mixed.`);
      continue;
    }

    const direction: Direction = aggregateImpact > 0 ? "LONG" : "SHORT";
    const fundamentalTrendScore = Math.min(100, Math.abs(aggregateImpact));
    const geopoliticalThemeScore = geopoliticalImpact === null ? 30 : Math.min(100, Math.abs(geopoliticalImpact));

    let snapshot;
    try {
      snapshot = await marketData.getSnapshot(instrument.symbol);
    } catch {
      noIdeaReasons.push(`${instrument.symbol}: market data unavailable.`);
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

    // No live positioning/flows (COT-style) data source is wired up yet —
    // documented placeholder rather than a fabricated number.
    const positioningFlowsScore = 50;

    const breakdown = computeSwingScore({
      macroRegimeScore,
      centralBankOutlookScore,
      fundamentalTrendScore,
      geopoliticalThemeScore,
      technicalTrendScore: technical.technicalScore,
      positioningFlowsScore,
    });

    const strongest = [...relevant].sort(
      (a, b) => decayedSeverity(b, "swing", now) - decayedSeverity(a, "swing", now)
    )[0];

    const signal = buildSignal({
      engine: "SWING",
      instrument: instrument.symbol,
      direction,
      breakdown,
      catalyst: strongest.latestAnalysis.headline,
      newsSummary: relevant.map((s) => s.latestAnalysis.headline).join("; "),
      currentPrice: snapshot.last,
      technical,
      crossAssetCheck,
      story: strongest,
      upcomingRisks: [],
      now,
    });

    saveSignal(signal);
    candidates.push(signal);
  }

  const { ranked, suppressed } = rankOpportunities(candidates);

  return {
    regimeSummary: regime.summary,
    centralBankBias: `${regime.rateBias} (confidence ${regime.regimeScore}/100)`,
    activeThemes,
    candidates,
    ranked: ranked.map((r) => r.signal),
    suppressed: suppressed.map((s) => ({ instrument: s.signal.instrument, reason: s.reason })),
    noIdeaReasons,
  };
}

function aggregateInstrumentImpact(
  stories: NewsStory[],
  symbol: string,
  now: Date
): { aggregateImpact: number; geopoliticalImpact: number | null } {
  let total = 0;
  let geo: number | null = null;
  for (const story of stories) {
    const impact = story.latestAnalysis.expectedAssetImpact.find((i) => i.symbol === symbol);
    if (!impact) continue;
    const decayFactor = currentDecayFactor(story, "swing", now);
    const decayed = impact.score * decayFactor;
    total += decayed;
    if (story.latestAnalysis.eventType === "geopolitical") {
      geo = (geo ?? 0) + decayed;
    }
  }
  return { aggregateImpact: Math.max(-100, Math.min(100, total)), geopoliticalImpact: geo };
}
