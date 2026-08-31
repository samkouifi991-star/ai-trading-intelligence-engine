import type { MarketSnapshot, OhlcvBar, TechnicalReadout } from "../types";

export function computeVwap(bars: OhlcvBar[]): number | null {
  if (bars.length === 0) return null;
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

/** Simple local-extrema pivot detection: a bar is a pivot high/low if it is
 * the highest/lowest within `window` bars on each side. Returns the nearest
 * pivot below (support) and above (resistance) the current price. */
export function findSupportResistance(bars: OhlcvBar[], currentPrice: number, window = 3) {
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const slice = bars.slice(i - window, i + window + 1);
    const high = bars[i].high;
    const low = bars[i].low;
    if (slice.every((b) => b.high <= high)) pivotHighs.push(high);
    if (slice.every((b) => b.low >= low)) pivotLows.push(low);
  }
  const resistanceCandidates = pivotHighs.filter((h) => h > currentPrice).sort((a, b) => a - b);
  const supportCandidates = pivotLows.filter((l) => l < currentPrice).sort((a, b) => b - a);
  return {
    nearestResistance: resistanceCandidates[0] ?? null,
    nearestSupport: supportCandidates[0] ?? null,
  };
}

/** Rate-of-change momentum over the last `lookback` bars, normalized against
 * recent volatility so it's comparable across instruments, then clamped to
 * -100..100. */
export function computeMomentum(bars: OhlcvBar[], lookback = 20): number {
  if (bars.length < lookback + 1) return 0;
  const recent = bars.slice(-lookback);
  const change = recent[recent.length - 1].close - recent[0].close;
  const avgTrueRange = averageTrueRange(recent);
  if (avgTrueRange === 0) return 0;
  const normalized = (change / avgTrueRange) * 20; // scale factor tuned so a ~5x-ATR move over the lookback reads near +/-100
  return Math.max(-100, Math.min(100, normalized));
}

export function averageTrueRange(bars: OhlcvBar[]): number {
  if (bars.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    sum += tr;
  }
  return sum / (bars.length - 1);
}

/** Percentile rank (0-100) of recent (last 20 bars) volatility against the
 * full lookback window's volatility — how "hot" volatility is right now. */
export function computeVolatilityPercentile(bars: OhlcvBar[]): number {
  if (bars.length < 25) return 50;
  const recentAtr = averageTrueRange(bars.slice(-20));
  const windowAtrs: number[] = [];
  for (let i = 20; i <= bars.length; i++) {
    windowAtrs.push(averageTrueRange(bars.slice(i - 20, i)));
  }
  const below = windowAtrs.filter((a) => a <= recentAtr).length;
  return Math.round((below / windowAtrs.length) * 100);
}

export function computeVolumeRelative(bars: OhlcvBar[], recentN = 5): number {
  if (bars.length < recentN + 1) return 1;
  const recent = bars.slice(-recentN);
  const recentAvg = recent.reduce((a, b) => a + b.volume, 0) / recent.length;
  const baseline = bars.reduce((a, b) => a + b.volume, 0) / bars.length;
  return baseline > 0 ? Math.round((recentAvg / baseline) * 100) / 100 : 1;
}

export function buildTechnicalReadout(snapshot: MarketSnapshot): TechnicalReadout {
  const { bars, last } = snapshot;
  const vwap = snapshot.vwap ?? computeVwap(bars) ?? last;
  const vwapRelation: TechnicalReadout["vwapRelation"] =
    Math.abs(last - vwap) < vwap * 0.0002 ? "at" : last > vwap ? "above" : "below";

  const { nearestSupport, nearestResistance } = findSupportResistance(bars, last);
  const momentum = computeMomentum(bars);
  const volatilityPercentile = computeVolatilityPercentile(bars);
  const volumeRelative = computeVolumeRelative(bars);

  // Composite technical score: momentum conviction + volume confirmation +
  // clean proximity to a structure level, each 0-100 then averaged.
  const momentumScore = Math.abs(momentum);
  const volumeScore = Math.min(100, Math.round(volumeRelative * 60));
  const structureScore = nearestSupport !== null && nearestResistance !== null ? 70 : 40;
  const technicalScore = Math.round((momentumScore + volumeScore + structureScore) / 3);

  return {
    symbol: snapshot.symbol,
    vwap,
    vwapRelation,
    nearestSupport,
    nearestResistance,
    momentum,
    volatilityPercentile,
    volumeRelative,
    technicalScore: Math.max(0, Math.min(100, technicalScore)),
  };
}
