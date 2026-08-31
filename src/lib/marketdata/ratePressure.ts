/**
 * Treasury futures move inversely to yields: futures price DOWN -> yields
 * generally UP (hawkish); futures price UP -> yields generally DOWN
 * (dovish). This normalizes a ZT (2Y) or ZN (10Y) futures intraday
 * %-price-change into a signed -100..100 "rate pressure" score so the
 * dashboard/engines never have to interpret raw futures prices themselves.
 *
 * The scale factor is a documented approximation, not a calibrated model:
 * chosen so that a ~0.15% futures price move — a genuinely large intraday
 * move for these historically low-volatility instruments, roughly what you
 * see around a hot CPI print — reads around +/-80 (clearly significant
 * without pinning at +/-100 for an ordinary move).
 */
const SCALE = 550;

export function computeRatePressure(futuresPriceChangePct: number): number {
  const pressure = -futuresPriceChangePct * SCALE;
  return Math.max(-100, Math.min(100, Math.round(pressure)));
}

export function ratePressureLabel(pressure: number): "hawkish" | "dovish" | "neutral" {
  if (pressure > 15) return "hawkish";
  if (pressure < -15) return "dovish";
  return "neutral";
}
