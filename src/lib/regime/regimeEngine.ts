import type { MacroRegime, MacroSnapshot } from "../types";

const VIX_RISK_OFF_CHANGE = 3; // %
const VIX_RISK_OFF_LEVEL = 20;
const VIX_RISK_ON_LEVEL = 14;
const RATE_PRESSURE_THRESHOLD = 15; // matches ratePressureLabel's neutral band
const DXY_MOVE_THRESHOLD_PCT = 0.15;

/**
 * Deterministic macro-regime read from the reference series (DXY, VIX, and
 * the intraday Treasury-futures-derived 2Y/10Y rate-pressure proxies — NOT
 * FRED's daily yields, which cannot support an intraday regime read). This
 * is intentionally a transparent rules engine, not an ML model or LLM
 * guess — every downstream consumer (surprise-engine regime adjustment,
 * day/swing scoring) needs a regime read it can audit.
 */
export function computeMacroRegime(macro: MacroSnapshot): MacroRegime {
  const vixRising = macro.vixChangePct > VIX_RISK_OFF_CHANGE || macro.vix > VIX_RISK_OFF_LEVEL;
  const vixFalling = macro.vixChangePct < -VIX_RISK_OFF_CHANGE / 2 && macro.vix < VIX_RISK_ON_LEVEL;

  const risk: MacroRegime["risk"] = vixRising ? "risk_off" : vixFalling ? "risk_on" : "neutral";

  const shortEndHawkish = macro.us2yRatePressure > RATE_PRESSURE_THRESHOLD;
  const shortEndDovish = macro.us2yRatePressure < -RATE_PRESSURE_THRESHOLD;
  const rateBias: MacroRegime["rateBias"] = shortEndHawkish ? "hawkish" : shortEndDovish ? "dovish" : "neutral";

  const longEndRising = macro.us10yRatePressure > RATE_PRESSURE_THRESHOLD;
  const longEndFalling = macro.us10yRatePressure < -RATE_PRESSURE_THRESHOLD;
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
  const sign = (n: number) => (n >= 0 ? "+" : "");
  const dailyYields =
    macro.us2yDaily !== null && macro.us10yDaily !== null
      ? `, daily FRED context US2Y ${macro.us2yDaily.toFixed(2)}%/US10Y ${macro.us10yDaily.toFixed(2)}%`
      : "";
  return `${parts.join(" · ")} (DXY ${macro.dxy.toFixed(2)} ${sign(macro.dxyChangePct)}${macro.dxyChangePct.toFixed(2)}%, 2Y rate pressure ${sign(macro.us2yRatePressure)}${macro.us2yRatePressure}, 10Y rate pressure ${sign(macro.us10yRatePressure)}${macro.us10yRatePressure}, VIX ${macro.vix.toFixed(1)} ${sign(macro.vixChangePct)}${macro.vixChangePct.toFixed(1)}%${dailyYields})`;
}

/** 0-100 score for the "market regime" slice of both the day and swing
 * composite scores: how favorable/clear the current regime is for acting
 * decisively (a murky/unclear regime should pull scores down). */
export function marketRegimeScore(regime: MacroRegime): number {
  return regime.regimeScore;
}
