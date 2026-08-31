import type { DayScoreBreakdown } from "../types";

export const DAY_WEIGHTS = {
  newsCatalyst: 0.35,
  economicSurprise: 0.2,
  crossMarketConfirmation: 0.2,
  technical: 0.15,
  marketRegime: 0.1,
} as const;

export function classifyScore(composite: number): DayScoreBreakdown["classification"] {
  if (composite >= 90) return "Exceptional";
  if (composite >= 80) return "Strong";
  if (composite >= 70) return "Watch";
  return "No Trade";
}

export interface DayScoreInputs {
  newsCatalystScore: number; // 0-100, already decay-adjusted
  economicSurpriseScore: number; // 0-100
  crossMarketConfirmationScore: number; // 0-100
  technicalScore: number; // 0-100
  marketRegimeScore: number; // 0-100
}

/**
 * Pure deterministic composite. This is the only place a day-trade
 * confidence number is produced — the LLM never scores or grades anything,
 * it only supplies the (already decay-adjusted) newsCatalystScore input via
 * the news-understanding + decay pipeline, and even that is clamped here.
 */
export function computeDayTradeScore(inputs: DayScoreInputs): DayScoreBreakdown {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const newsCatalystScore = clamp(inputs.newsCatalystScore);
  const economicSurpriseScore = clamp(inputs.economicSurpriseScore);
  const crossMarketConfirmationScore = clamp(inputs.crossMarketConfirmationScore);
  const technicalScore = clamp(inputs.technicalScore);
  const marketRegimeScore = clamp(inputs.marketRegimeScore);

  const composite =
    newsCatalystScore * DAY_WEIGHTS.newsCatalyst +
    economicSurpriseScore * DAY_WEIGHTS.economicSurprise +
    crossMarketConfirmationScore * DAY_WEIGHTS.crossMarketConfirmation +
    technicalScore * DAY_WEIGHTS.technical +
    marketRegimeScore * DAY_WEIGHTS.marketRegime;

  const normalized = Math.round(clamp(composite));

  return {
    newsCatalystScore,
    economicSurpriseScore,
    crossMarketConfirmationScore,
    technicalScore,
    marketRegimeScore,
    composite: normalized,
    classification: classifyScore(normalized),
  };
}
