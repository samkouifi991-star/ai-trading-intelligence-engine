/** Per-instrument symbol mapping, one entry per supported provider. Add a
 * new provider by adding a column here and a providers/<name>.ts — nothing
 * else needs to change. */
export const PROVIDER_SYMBOLS: Record<string, { yahoo: string; twelvedata: string }> = {
  XAUUSD: { yahoo: "XAUUSD=X", twelvedata: "XAU/USD" },
  ES: { yahoo: "ES=F", twelvedata: "ES" },
  NQ: { yahoo: "NQ=F", twelvedata: "NQ" },
  WTI: { yahoo: "CL=F", twelvedata: "CL" },
  EURUSD: { yahoo: "EURUSD=X", twelvedata: "EUR/USD" },
  GBPUSD: { yahoo: "GBPUSD=X", twelvedata: "GBP/USD" },
  USDJPY: { yahoo: "USDJPY=X", twelvedata: "USD/JPY" },
  USDCAD: { yahoo: "USDCAD=X", twelvedata: "USD/CAD" },
  AUDUSD: { yahoo: "AUDUSD=X", twelvedata: "AUD/USD" },
  // Trading Intelligence Engine's currency-strength/universe additions:
  USDCHF: { yahoo: "USDCHF=X", twelvedata: "USD/CHF" },
  NZDUSD: { yahoo: "NZDUSD=X", twelvedata: "NZD/USD" },
  EURJPY: { yahoo: "EURJPY=X", twelvedata: "EUR/JPY" },
  GBPJPY: { yahoo: "GBPJPY=X", twelvedata: "GBP/JPY" },
  DXY: { yahoo: "DX-Y.NYB", twelvedata: "DXY" },
  VIX: { yahoo: "^VIX", twelvedata: "VIX" },
  // Treasury futures — the real-time rate-pressure proxy (see ratePressure.ts).
  // Twelve Data's futures coverage varies by plan; Yahoo is the default.
  US2Y_PROXY: { yahoo: "ZT=F", twelvedata: "ZT" },
  US10Y_PROXY: { yahoo: "ZN=F", twelvedata: "ZN" },
};

export function providerSymbol(instrument: string, provider: "yahoo" | "twelvedata"): string {
  const entry = PROVIDER_SYMBOLS[instrument];
  if (!entry) throw new Error(`No provider symbol mapping for ${instrument}`);
  return entry[provider];
}

/**
 * All instruments in this build's universe trade on ~23/5 sessions (CME
 * Globex for equity/rate/energy futures, the interbank market for FX and
 * spot gold) — effectively closed only on weekends. This is a documented
 * approximation (it doesn't model the brief daily maintenance halt or
 * holidays); good enough to tell the dashboard "don't expect a fresh quote
 * right now" during the weekend gap, not a precise session calendar.
 */
export function isGlobalSessionOpen(now: Date = new Date()): boolean {
  const nyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = nyParts.find((p) => p.type === "weekday")?.value;
  const hour = parseInt(nyParts.find((p) => p.type === "hour")?.value ?? "0", 10);

  if (weekday === "Sat") return false;
  if (weekday === "Sun" && hour < 17) return false; // opens Sunday 17:00 ET
  if (weekday === "Fri" && hour >= 17) return false; // closes Friday 17:00 ET
  return true;
}
