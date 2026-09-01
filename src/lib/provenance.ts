/** Friendly display label for a connector_health sourceKey — shared between
 * the Live Data Status page and any per-signal provenance panel so both
 * describe the same source the same way. */
const STATIC_LABELS: Record<string, string> = {
  calendar: "Forex Factory Calendar",
  "news:forexfactory": "Forex Factory News",
  "news:forexlive": "ForexLive (secondary)",
  gmail: "Gmail — Forex Factory Alerts",
  llm: "AI News Understanding (LLM)",
  "marketData:DXY": "US Dollar Index (DXY)",
  "marketData:VIX": "VIX",
  "marketData:US2Y_PROXY": "2Y Rate Pressure (ZT futures)",
  "marketData:US10Y_PROXY": "10Y Rate Pressure (ZN futures)",
  "marketData:FRED_DGS2": "FRED US 2Y Yield (daily)",
  "marketData:FRED_DGS10": "FRED US 10Y Yield (daily)",
};

export function sourceLabel(sourceKey: string): string {
  if (STATIC_LABELS[sourceKey]) return STATIC_LABELS[sourceKey];
  if (sourceKey.startsWith("marketData:")) return `${sourceKey.slice("marketData:".length)} price feed`;
  return sourceKey;
}
