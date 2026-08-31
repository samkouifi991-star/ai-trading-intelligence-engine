/**
 * Initial tradable universe for the Day Trading Engine, plus the reference
 * macro instruments both engines watch but never trade directly.
 */

export type AssetClass = "fx" | "index" | "metal" | "energy";

export interface InstrumentMeta {
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  /** Instruments whose moves are highly correlated with this one, used by the
   * opportunity ranker to avoid presenting near-duplicate trades. */
  correlatedWith: string[];
  /** Positive = instrument tends to rise with a stronger USD; negative = falls. */
  usdSensitivity: "positive" | "negative" | "mixed";
}

export const TRADABLE_UNIVERSE: InstrumentMeta[] = [
  {
    symbol: "XAUUSD",
    displayName: "Gold",
    assetClass: "metal",
    correlatedWith: ["XAGUSD"],
    usdSensitivity: "negative",
  },
  {
    symbol: "ES",
    displayName: "S&P 500 (ES)",
    assetClass: "index",
    correlatedWith: ["NQ"],
    usdSensitivity: "mixed",
  },
  {
    symbol: "NQ",
    displayName: "NASDAQ 100 (NQ)",
    assetClass: "index",
    correlatedWith: ["ES"],
    usdSensitivity: "mixed",
  },
  {
    symbol: "WTI",
    displayName: "WTI Crude Oil",
    assetClass: "energy",
    correlatedWith: [],
    usdSensitivity: "negative",
  },
  {
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    assetClass: "fx",
    correlatedWith: ["GBPUSD"],
    usdSensitivity: "negative",
  },
  {
    symbol: "GBPUSD",
    displayName: "British Pound / US Dollar",
    assetClass: "fx",
    correlatedWith: ["EURUSD"],
    usdSensitivity: "negative",
  },
  {
    symbol: "USDJPY",
    displayName: "US Dollar / Japanese Yen",
    assetClass: "fx",
    correlatedWith: [],
    usdSensitivity: "positive",
  },
  {
    symbol: "USDCAD",
    displayName: "US Dollar / Canadian Dollar",
    assetClass: "fx",
    correlatedWith: ["WTI"],
    usdSensitivity: "positive",
  },
  {
    symbol: "AUDUSD",
    displayName: "Australian Dollar / US Dollar",
    assetClass: "fx",
    correlatedWith: ["NZDUSD"],
    usdSensitivity: "negative",
  },
];

/** Reference/macro series the intelligence layer watches continuously but
 * that are never themselves tradable signals. */
export const REFERENCE_SERIES = ["DXY", "US2Y", "US10Y", "VIX"] as const;
export type ReferenceSeries = (typeof REFERENCE_SERIES)[number];

export function getInstrument(symbol: string): InstrumentMeta | undefined {
  return TRADABLE_UNIVERSE.find((i) => i.symbol === symbol);
}
