import type { SwingScoreBreakdown } from "../types";
import { classifyScore } from "./dayTradeScore";

export const SWING_WEIGHTS = {
  macroRegime: 0.25,
  centralBankOutlook: 0.2,
  fundamentalTrend: 0.15,
  geopoliticalTheme: 0.1,
  technicalTrend: 0.2,
  positioningFlows: 0.1,
} as const;

export interface SwingScoreInputs {
  macroRegimeScore: number;
  centralBankOutlookScore: number;
  fundamentalTrendScore: number;
  geopoliticalThemeScore: number;
  technicalTrendScore: number;
  positioningFlowsScore: number;
}

/**
 * Swing signals must reflect a *medium-term thesis change*, not a same-day
 * news bounce — callers are responsible for only feeding
 * fundamentalTrendScore/geopoliticalThemeScore from stories whose
 * classifyTradingHorizon() is "swing" or "both", using the slow swing decay
 * curve (see news/decay.ts), never from day-only transient headlines.
 */
export function computeSwingScore(inputs: SwingScoreInputs): SwingScoreBreakdown {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const macroRegimeScore = clamp(inputs.macroRegimeScore);
  const centralBankOutlookScore = clamp(inputs.centralBankOutlookScore);
  const fundamentalTrendScore = clamp(inputs.fundamentalTrendScore);
  const geopoliticalThemeScore = clamp(inputs.geopoliticalThemeScore);
  const technicalTrendScore = clamp(inputs.technicalTrendScore);
  const positioningFlowsScore = clamp(inputs.positioningFlowsScore);

  const composite =
    macroRegimeScore * SWING_WEIGHTS.macroRegime +
    centralBankOutlookScore * SWING_WEIGHTS.centralBankOutlook +
    fundamentalTrendScore * SWING_WEIGHTS.fundamentalTrend +
    geopoliticalThemeScore * SWING_WEIGHTS.geopoliticalTheme +
    technicalTrendScore * SWING_WEIGHTS.technicalTrend +
    positioningFlowsScore * SWING_WEIGHTS.positioningFlows;

  const normalized = Math.round(clamp(composite));

  return {
    macroRegimeScore,
    centralBankOutlookScore,
    fundamentalTrendScore,
    geopoliticalThemeScore,
    technicalTrendScore,
    positioningFlowsScore,
    composite: normalized,
    classification: classifyScore(normalized),
  };
}
