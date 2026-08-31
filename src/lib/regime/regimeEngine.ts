import type { MacroRegime, MacroSnapshot } from "../types";

const VIX_RISK_OFF_CHANGE = 3; // %
const VIX_RISK_OFF_LEVEL = 20;
const VIX_RISK_ON_LEVEL = 14;
const YIELD_MOVE_THRESHOLD_BPS = 3;
const DXY_MOVE_THRESHOLD_PCT = 0.15;

/**
 * Deterministic macro-regime read from the reference series (DXY, US2Y,
 * US10Y, VIX). This is intentionally a transparent rules engine, not an ML
 * model or LLM guess — every downstream consumer (surprise-engine regime
 * adjustment, day/swing scoring) needs a regime read it can audit.
 */
export function computeMacroRegime(macro: MacroSnapshot): MacroRegime {
  const vixRising = macro.vixChangePct > VIX_RISK_OFF_CHANGE || macro.vix > VIX_RISK_OFF_LEVEL;
  const vixFalling = macro.vixChangePct < -VIX_RISK_OFF_CHANGE / 2 && macro.vix < VIX_RISK_ON_LEVEL;

  const risk: MacroRegime["risk"] = vixRising ? "risk_off" : vixFalling ? "risk_on" : "neutral";

  const shortEndHawkish = macro.us2yChangeBps > YIELD_MOVE_THRESHOLD_BPS;
  const shortEndDovish = macro.us2yChangeBps < -YIELD_MOVE_THRESHOLD_BPS;
  const rateBias: MacroRegime["rateBias"] = shortEndHawkish ? "hawkish" : shortEndDovish ? "dovish" : "neutral";

  const longEndRising = macro.us10yChangeBps > YIELD_MOVE_THRESHOLD_BPS;
  const longEndFalling = macro.us10yChangeBps < -YIELD_MOVE_THRESHOLD_BPS;
  const inflation: MacroRegime["inflation"] = longEndRising ? "rising" : longEndFalling ? "falling" : "stable";

  let growth: MacroRegime["growth"] = "unclear";
  if (risk === "risk_on" && rateBias === "hawkish") growth = "expansion";
  else if (risk === "risk_off" && rateBias === "dovish") growth = "contraction";
  else if (risk === "risk_off" && rateBias === "hawkish") growth = "slowdown"; // stagflation-leaning
  else if (risk === "risk_on" && rateBias !== "hawkish") growth = "expansion";

  const dxyMove = Math.abs(macro.dxyChangePct) > DXY_MOVE_THRESHOLD_PCT;

  const signalCount = [vixRising || vixFalling, shortEndHawkish || shortEndDovish, longEndRising || longEndFalling, dxyMove].filter(Boolean).length;
  const regimeScore = Math.round((signalCount / 4) * 100);

  const summary = buildSummary({ risk, rateBias, inflation, growth, macro });

  return {
    asOfUtc: macro.timeUtc,
    growth,
    inflation,
    risk,
    rateBias,
    summary,
    regimeScore,
  };
}

function buildSummary(params: {
  risk: MacroRegime["risk"];
  rateBias: MacroRegime["rateBias"];
  inflation: MacroRegime["inflation"];
  growth: MacroRegime["growth"];
  macro: MacroSnapshot;
}): string {
  const { risk, rateBias, inflation, growth, macro } = params;
  const parts = [
    `Risk: ${risk.replace("_", "-")}`,
    `Rate bias: ${rateBias}`,
    `Inflation expectations: ${inflation}`,
    `Growth: ${growth}`,
  ];
  return `${parts.join(" · ")} (DXY ${macro.dxy.toFixed(2)} ${macro.dxyChangePct >= 0 ? "+" : ""}${macro.dxyChangePct.toFixed(2)}%, US2Y ${macro.us2y.toFixed(2)}% ${macro.us2yChangeBps >= 0 ? "+" : ""}${macro.us2yChangeBps.toFixed(1)}bp, US10Y ${macro.us10y.toFixed(2)}% ${macro.us10yChangeBps >= 0 ? "+" : ""}${macro.us10yChangeBps.toFixed(1)}bp, VIX ${macro.vix.toFixed(1)} ${macro.vixChangePct >= 0 ? "+" : ""}${macro.vixChangePct.toFixed(1)}%)`;
}

/** 0-100 score for the "market regime" slice of both the day and swing
 * composite scores: how favorable/clear the current regime is for acting
 * decisively (a murky/unclear regime should pull scores down). */
export function marketRegimeScore(regime: MacroRegime): number {
  return regime.regimeScore;
}
