import { canIssueNewDayTradeSignal } from "../time/session";
import type { DayScoreBreakdown, Engine, FinalStatus, SwingScoreBreakdown } from "../types";

export const ACTIONABLE_THRESHOLD = 80;
export const WATCH_THRESHOLD = 70;

/**
 * THE deterministic gate. Nothing else in the system — including the LLM —
 * is allowed to mark a signal TRADE. This function is the single place that
 * decision is made, from already-computed scores and already-computed
 * cross-asset confirmation, so it's fully auditable and testable in
 * isolation from any AI call.
 */
export function decideFinalStatus(params: {
  engine: Engine;
  breakdown: DayScoreBreakdown | SwingScoreBreakdown;
  crossAssetContradicted: boolean;
  now?: Date;
}): FinalStatus {
  const { engine, breakdown, crossAssetContradicted } = params;
  const composite = breakdown.composite;

  if (composite < WATCH_THRESHOLD) return "NO_TRADE";

  if (crossAssetContradicted) {
    // Spec: "If the actual market response contradicts the fundamental
    // prediction, reduce the signal or issue NO TRADE." A contradiction is
    // disqualifying regardless of how high the composite otherwise scored.
    return "NO_TRADE";
  }

  if (composite < ACTIONABLE_THRESHOLD) return "WATCH";

  if (engine === "DAY" && !canIssueNewDayTradeSignal(params.now)) {
    // Score qualifies, but we are outside the 10:00-13:00 ET issue window —
    // never emit a brand-new actionable day-trade idea outside that window.
    return "WATCH";
  }

  return "TRADE";
}
