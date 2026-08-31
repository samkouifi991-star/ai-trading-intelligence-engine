import type { CrossAssetCheck, Direction, MacroSnapshot, TechnicalReadout } from "../types";
import { getInstrument, type InstrumentMeta } from "../universe";

const YIELD_SENSITIVE_ASSET_CLASSES = new Set(["metal"]);

/**
 * Signed -100..100 read of what the market is actually doing for this
 * instrument right now, computed independently of any prediction: real
 * measured momentum (70% weight) blended with the DXY reaction translated
 * into this instrument's own directional frame (30% weight, USD-sensitive
 * instruments only). This is the "MARKET CONFIRMATION" score — deliberately
 * never derived from predictedDirection, so it can genuinely agree or
 * disagree with the news-impact prediction rather than echoing it.
 */
function computeConfirmationDirectionScore(instrument: InstrumentMeta | undefined, macro: MacroSnapshot, technical: TechnicalReadout): number {
  let score = technical.momentum;
  if (instrument && instrument.usdSensitivity !== "mixed") {
    const dxySignedForInstrument = instrument.usdSensitivity === "negative" ? -macro.dxyChangePct : macro.dxyChangePct;
    const dxyComponent = Math.max(-100, Math.min(100, dxySignedForInstrument * 40));
    score = score * 0.7 + dxyComponent * 0.3;
  }
  return Math.max(-100, Math.min(100, Math.round(score)));
}

/**
 * Never trades purely on the AI's predicted direction. Compares the
 * *predicted* reaction against what price/DXY/yields/structure are actually
 * doing right now, and scores how well they agree. A prediction that
 * contradicts real market behavior gets its confidence cut hard (or forced
 * to NO TRADE by the scoring/validation layer downstream) rather than being
 * traded on faith.
 */
export function checkCrossAssetConfirmation(params: {
  symbol: string;
  predictedDirection: Direction;
  macro: MacroSnapshot;
  technical: TechnicalReadout;
}): CrossAssetCheck {
  const { symbol, predictedDirection, macro, technical } = params;
  const instrument = getInstrument(symbol);
  const factors: CrossAssetCheck["factors"] = [];

  const wantsUp = predictedDirection === "LONG";

  // Factor 1: USD (DXY) behavior vs. this instrument's known USD sensitivity.
  if (instrument && instrument.usdSensitivity !== "mixed") {
    const dxyRising = macro.dxyChangePct > 0.05;
    const dxyFalling = macro.dxyChangePct < -0.05;
    if (dxyRising || dxyFalling) {
      // negative sensitivity: instrument falls when DXY rises (typical of XAUUSD, EURUSD, GBPUSD, AUDUSD)
      const instrumentShouldFall =
        (instrument.usdSensitivity === "negative" && dxyRising) ||
        (instrument.usdSensitivity === "positive" && dxyFalling);
      const instrumentShouldRise = !instrumentShouldFall;
      const supports = wantsUp ? instrumentShouldRise : !instrumentShouldRise;
      factors.push({
        name: "DXY",
        supportsDirection: supports,
        detail: `DXY ${dxyRising ? "rising" : "falling"} (${macro.dxyChangePct.toFixed(2)}%) ${supports ? "supports" : "contradicts"} ${predictedDirection}.`,
      });
    }
  }

  // Factor 2: real-time rate pressure (2Y/10Y Treasury-futures-derived, NOT
  // FRED's daily yields — see MacroSnapshot's doc comment) — most relevant
  // for gold, but included at lower weight for everything as a general
  // risk-appetite tell.
  const yieldsRising = macro.us2yRatePressure > 15 && macro.us10yRatePressure > 15;
  const yieldsFalling = macro.us2yRatePressure < -15 && macro.us10yRatePressure < -15;
  if ((yieldsRising || yieldsFalling) && (instrument ? YIELD_SENSITIVE_ASSET_CLASSES.has(instrument.assetClass) : true)) {
    const instrumentShouldFall = yieldsRising; // higher yields -> higher opportunity cost of holding gold/non-yielding assets
    const supports = wantsUp ? !instrumentShouldFall : instrumentShouldFall;
    factors.push({
      name: "Rate pressure (2Y/10Y)",
      supportsDirection: supports,
      detail: `2Y rate pressure ${macro.us2yRatePressure >= 0 ? "+" : ""}${macro.us2yRatePressure} / 10Y rate pressure ${macro.us10yRatePressure >= 0 ? "+" : ""}${macro.us10yRatePressure} ${supports ? "supports" : "contradicts"} ${predictedDirection}.`,
    });
  }

  // Factor 3: price vs VWAP.
  if (technical.vwapRelation !== "at") {
    const priceAbove = technical.vwapRelation === "above";
    const supports = wantsUp ? priceAbove : !priceAbove;
    factors.push({
      name: "VWAP",
      supportsDirection: supports,
      detail: `Price is ${technical.vwapRelation} VWAP — ${supports ? "supports" : "contradicts"} ${predictedDirection}.`,
    });
  }

  // Factor 4: momentum.
  if (Math.abs(technical.momentum) > 10) {
    const momentumUp = technical.momentum > 0;
    const supports = wantsUp ? momentumUp : !momentumUp;
    factors.push({
      name: "Momentum",
      supportsDirection: supports,
      detail: `Momentum reading ${technical.momentum.toFixed(0)} ${supports ? "supports" : "contradicts"} ${predictedDirection}.`,
    });
  }

  // Factor 5: structure — did price break support (bearish) or resistance (bullish)?
  if (technical.nearestSupport !== null && technical.nearestResistance !== null) {
    // handled via technical score already; here we just check breakout direction
    // using the momentum+VWAP proxy already captured above, so this factor is
    // reserved for a genuine break which technical.ts flags via momentum extremes.
  }

  const confirmationDirectionScore = computeConfirmationDirectionScore(instrument, macro, technical);

  if (factors.length === 0) {
    return { symbol, predictedDirection, confirmationScore: 50, confirmationDirectionScore, aligned: false, contradicted: false, factors };
  }

  const supportingCount = factors.filter((f) => f.supportsDirection).length;
  const confirmationScore = Math.round((supportingCount / factors.length) * 100);

  return {
    symbol,
    predictedDirection,
    confirmationScore,
    confirmationDirectionScore,
    aligned: confirmationScore >= 60,
    contradicted: confirmationScore <= 35,
    factors,
  };
}
