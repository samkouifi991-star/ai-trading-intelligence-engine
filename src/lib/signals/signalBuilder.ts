import { randomUUID } from "node:crypto";
import type {
  CrossAssetCheck,
  DayScoreBreakdown,
  Direction,
  Engine,
  NewsStory,
  SwingScoreBreakdown,
  TechnicalReadout,
  TradeSignal,
} from "../types";
import { decideFinalStatus } from "./validation";
import { getDaySessionPhase } from "../time/session";

export interface BuildSignalParams {
  engine: Engine;
  instrument: string;
  direction: Direction;
  breakdown: DayScoreBreakdown | SwingScoreBreakdown;
  catalyst: string;
  newsSummary: string;
  currentPrice: number;
  technical: TechnicalReadout | null;
  crossAssetCheck: CrossAssetCheck | null;
  story: NewsStory | null;
  upcomingRisks: string[];
  /** Signed -100..100 predicted asset-impact score from the news
   * understanding engine, if this signal originated from a story. */
  newsImpactScore?: number | null;
  dataQualityScore: number;
  now?: Date;
}

export function buildSignal(params: BuildSignalParams): TradeSignal {
  const now = params.now ?? new Date();
  const { entryZone, invalidation, target1, target2 } = computeLevels(params);

  const { finalStatus, adjustedConfidence, dataQualityReason } = decideFinalStatus({
    engine: params.engine,
    breakdown: params.breakdown,
    crossAssetContradicted: params.crossAssetCheck?.contradicted ?? false,
    dataQualityScore: params.dataQualityScore,
    now,
  });

  const { reasonsFor, reasonsAgainst } = buildReasons(params, dataQualityReason);

  return {
    id: randomUUID(),
    engine: params.engine,
    instrument: params.instrument,
    direction: params.direction,
    confidence: adjustedConfidence,
    catalyst: params.catalyst,
    newsSummary: params.newsSummary,
    newsImpactScore: params.newsImpactScore ?? null,
    marketConfirmationScore: params.crossAssetCheck?.confirmationDirectionScore ?? null,
    economicSurpriseScore: "economicSurpriseScore" in params.breakdown ? params.breakdown.economicSurpriseScore : null,
    fundamentalScore: "fundamentalTrendScore" in params.breakdown ? params.breakdown.fundamentalTrendScore : null,
    technicalScore: pickTechnicalScore(params.breakdown),
    crossMarketConfirmationScore:
      "crossMarketConfirmationScore" in params.breakdown ? params.breakdown.crossMarketConfirmationScore : null,
    marketRegimeScore: "marketRegimeScore" in params.breakdown ? params.breakdown.marketRegimeScore : null,
    dataQualityScore: params.dataQualityScore,
    dataQualityReason,
    entryZone,
    invalidation,
    target1,
    target2,
    expectedHoldingPeriod: params.engine === "DAY" ? "Intraday (same session)" : "1-10 trading days",
    timestampUtc: now.toISOString(),
    signalExpirationUtc: computeExpiration(params.engine, now).toISOString(),
    reasonsFor,
    reasonsAgainst,
    upcomingRisks: params.upcomingRisks,
    finalStatus,
    scoreBreakdown: params.breakdown,
    storyId: params.story?.storyId ?? null,
  };
}

function pickTechnicalScore(breakdown: DayScoreBreakdown | SwingScoreBreakdown): number | null {
  if ("technicalScore" in breakdown) return breakdown.technicalScore;
  if ("technicalTrendScore" in breakdown) return breakdown.technicalTrendScore;
  return null;
}

function computeLevels(params: BuildSignalParams): {
  entryZone: [number, number] | null;
  invalidation: number | null;
  target1: number | null;
  target2: number | null;
} {
  const price = params.currentPrice;
  if (!price || price <= 0) return { entryZone: null, invalidation: null, target1: null, target2: null };

  const isLong = params.direction === "LONG";
  const buffer = price * 0.0015;
  const entryZone: [number, number] = isLong ? [price - buffer, price + buffer * 0.5] : [price - buffer * 0.5, price + buffer];

  const structuralStop = isLong ? params.technical?.nearestSupport ?? null : params.technical?.nearestResistance ?? null;
  const fallbackStopDistance = price * 0.006;
  const invalidation = structuralStop ?? (isLong ? price - fallbackStopDistance : price + fallbackStopDistance);

  const riskDistance = Math.abs(price - invalidation);
  const target1 = isLong ? price + riskDistance * 1.5 : price - riskDistance * 1.5;
  const target2 = isLong ? price + riskDistance * 2.5 : price - riskDistance * 2.5;

  return { entryZone, invalidation, target1, target2 };
}

function computeExpiration(engine: Engine, now: Date): Date {
  if (engine === "DAY") {
    const phase = getDaySessionPhase(now);
    if (phase === "active") {
      // Expires at the close of today's 13:00 ET active window.
      const nyHourString = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
      const [h, m] = nyHourString.split(":").map(Number);
      const minutesUntilClose = 13 * 60 - (h * 60 + m);
      return new Date(now.getTime() + Math.max(5, minutesUntilClose) * 60_000);
    }
    return new Date(now.getTime() + 60 * 60_000);
  }
  // Swing: expires in 10 trading days (~14 calendar days).
  return new Date(now.getTime() + 14 * 86_400_000);
}

function buildReasons(params: BuildSignalParams, dataQualityReason: string | null): { reasonsFor: string[]; reasonsAgainst: string[] } {
  const reasonsFor: string[] = [];
  const reasonsAgainst: string[] = [];

  if (dataQualityReason) reasonsAgainst.push(dataQualityReason);

  if (params.catalyst) reasonsFor.push(`Catalyst: ${params.catalyst}`);

  if (params.crossAssetCheck) {
    for (const f of params.crossAssetCheck.factors) {
      (f.supportsDirection ? reasonsFor : reasonsAgainst).push(f.detail);
    }
  }

  if ("classification" in params.breakdown) {
    if (params.breakdown.classification === "Exceptional" || params.breakdown.classification === "Strong") {
      reasonsFor.push(`Composite score ${params.breakdown.composite}/100 (${params.breakdown.classification}).`);
    } else {
      reasonsAgainst.push(`Composite score only ${params.breakdown.composite}/100 (${params.breakdown.classification}) — below the actionable threshold.`);
    }
  }

  if (params.technical) {
    if (params.technical.volumeRelative < 0.8) {
      reasonsAgainst.push(`Volume is below average (${params.technical.volumeRelative.toFixed(2)}x) — weak participation.`);
    }
  }

  if (reasonsAgainst.length === 0) reasonsAgainst.push("No material contradicting factors identified at this time.");

  return { reasonsFor, reasonsAgainst };
}
