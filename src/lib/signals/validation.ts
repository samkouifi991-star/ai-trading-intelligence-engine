import { canIssueNewDayTradeSignal } from "../time/session";
import type { DayScoreBreakdown, Engine, FinalStatus, SwingScoreBreakdown } from "../types";

export const ACTIONABLE_THRESHOLD = 80;
export const WATCH_THRESHOLD = 70;

// Data-quality gating bands (spec rule 6):
//   >=90        normal signal generation
//   75-89       signal allowed but confidence penalty
//   60-74       WATCH only, regardless of composite score
//   <60         NO_TRADE, regardless of composite score
const DATA_QUALITY_NORMAL = 90;
const DATA_QUALITY_PENALTY_FLOOR = 75;
const DATA_QUALITY_WATCH_ONLY_FLOOR = 60;
const MILD_PENALTY_FACTOR = 0.85; // 75-89 band
const STEEP_PENALTY_FACTOR = 0.7; // just under 75, before the hard WATCH-only cutoff takes over

export interface FinalStatusResult {
  finalStatus: FinalStatus;
  /** The composite score after any data-quality confidence penalty — this
   * is what TradeSignal.confidence is set to, so a 92 composite scored
   * against 45/100 data quality is never displayed (or gated) as a 92. */
  adjustedConfidence: number;
  dataQualityReason: string | null;
}

/**
 * THE deterministic gate. Nothing else in the system — including the LLM —
 * is allowed to mark a signal TRADE. This function is the single place that
 * decision is made, from already-computed scores, already-computed
 * cross-asset confirmation, and the data-quality score for this evaluation,
 * so it's fully auditable and testable in isolation from any AI call.
 *
 * Sample/fallback data can only reach this function at all in development
 * mode (production mode throws DataUnavailableError upstream instead — see
 * src/lib/config/appMode.ts) — but even in development, low data quality
 * (heavy reliance on sample/blocked sources) is penalized or gated here so
 * a high composite score built on fabricated inputs still can't reach TRADE.
 */
export function decideFinalStatus(params: {
  engine: Engine;
  breakdown: DayScoreBreakdown | SwingScoreBreakdown;
  crossAssetContradicted: boolean;
  dataQualityScore: number;
  now?: Date;
}): FinalStatusResult {
  const { engine, breakdown, crossAssetContradicted, dataQualityScore } = params;
  const composite = breakdown.composite;

  if (dataQualityScore < DATA_QUALITY_WATCH_ONLY_FLOOR) {
    return {
      finalStatus: "NO_TRADE",
      adjustedConfidence: composite,
      dataQualityReason: `Data quality ${dataQualityScore}/100 — below ${DATA_QUALITY_WATCH_ONLY_FLOOR}, NO_TRADE regardless of composite score (${composite}).`,
    };
  }

  let adjustedConfidence = composite;
  let dataQualityReason: string | null = null;
  if (dataQualityScore < DATA_QUALITY_NORMAL) {
    const factor = dataQualityScore < DATA_QUALITY_PENALTY_FLOOR ? STEEP_PENALTY_FACTOR : MILD_PENALTY_FACTOR;
    adjustedConfidence = Math.round(composite * factor);
    dataQualityReason = `Data quality ${dataQualityScore}/100 — confidence penalty applied (${composite} -> ${adjustedConfidence}).`;
  }

  if (dataQualityScore < DATA_QUALITY_PENALTY_FLOOR) {
    return {
      finalStatus: adjustedConfidence < WATCH_THRESHOLD ? "NO_TRADE" : "WATCH",
      adjustedConfidence,
      dataQualityReason: `Data quality ${dataQualityScore}/100 — WATCH only (${DATA_QUALITY_WATCH_ONLY_FLOOR}-${DATA_QUALITY_PENALTY_FLOOR - 1} band), regardless of composite score.`,
    };
  }

  if (adjustedConfidence < WATCH_THRESHOLD) {
    return { finalStatus: "NO_TRADE", adjustedConfidence, dataQualityReason };
  }

  if (crossAssetContradicted) {
    // Spec: "If the actual market response contradicts the fundamental
    // prediction, reduce the signal or issue NO TRADE." A contradiction is
    // disqualifying regardless of how high the score otherwise is.
    return {
      finalStatus: "NO_TRADE",
      adjustedConfidence,
      dataQualityReason: dataQualityReason ?? "Cross-market confirmation contradicted the predicted direction.",
    };
  }

  if (adjustedConfidence < ACTIONABLE_THRESHOLD) {
    return { finalStatus: "WATCH", adjustedConfidence, dataQualityReason };
  }

  if (engine === "DAY" && !canIssueNewDayTradeSignal(params.now)) {
    // Score qualifies, but we are outside the 10:00-13:00 ET issue window —
    // never emit a brand-new actionable day-trade idea outside that window.
    return { finalStatus: "WATCH", adjustedConfidence, dataQualityReason };
  }

  return { finalStatus: "TRADE", adjustedConfidence, dataQualityReason };
}
