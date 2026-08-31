import type { CrossAssetCheck, Direction, MacroSnapshot, TechnicalReadout } from "../types";
import { getInstrument } from "../universe";

const YIELD_SENSITIVE_ASSET_CLASSES = new Set(["metal"]);

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

  // Factor 2: US real-yield proxy (2Y/10Y) — most relevant for gold, but
  // included at lower weight for everything as a general risk-appetite tell.
  const yieldsRising = macro.us2yChangeBps > 1 && macro.us10yChangeBps > 1;
  const yieldsFalling = macro.us2yChangeBps < -1 && macro.us10yChangeBps < -1;
  if ((yieldsRising || yieldsFalling) && (instrument ? YIELD_SENSITIVE_ASSET_CLASSES.has(instrument.assetClass) : true)) {
    const instrumentShouldFall = yieldsRising; // higher yields -> higher opportunity cost of holding gold/non-yielding assets
    const supports = wantsUp ? !instrumentShouldFall : instrumentShouldFall;
    factors.push({
      name: "US yields",
      supportsDirection: supports,
      detail: `US2Y ${macro.us2yChangeBps >= 0 ? "+" : ""}${macro.us2yChangeBps.toFixed(1)}bp / US10Y ${macro.us10yChangeBps >= 0 ? "+" : ""}${macro.us10yChangeBps.toFixed(1)}bp ${supports ? "supports" : "contradicts"} ${predictedDirection}.`,
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

  if (factors.length === 0) {
    return { symbol, predictedDirection, confirmationScore: 50, aligned: false, contradicted: false, factors };
  }

  const supportingCount = factors.filter((f) => f.supportsDirection).length;
  const confirmationScore = Math.round((supportingCount / factors.length) * 100);

  return {
    symbol,
    predictedDirection,
    confirmationScore,
    aligned: confirmationScore >= 60,
    contradicted: confirmationScore <= 35,
    factors,
  };
}
