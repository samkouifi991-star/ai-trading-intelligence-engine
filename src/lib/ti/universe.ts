/**
 * The Trading Intelligence Engine's fixed starting universe (spec section:
 * "Start with these markets"). Architected so indices/silver/oil/crypto can
 * be added later without touching the scoring engines — every engine reads
 * this list plus CURRENCIES, never a hardcoded symbol.
 */
export interface TiInstrument {
  symbol: string;
  displayName: string;
  assetClass: "fx" | "metal";
  /** The two currencies this instrument's price reflects — a metal like
   * XAUUSD is modeled as "XAU" (not a real currency-strength currency) vs
   * USD, so the currency-strength engine can still express its USD leg. */
  base: string;
  quote: string;
}

export const TI_UNIVERSE: TiInstrument[] = [
  { symbol: "EURUSD", displayName: "Euro / US Dollar", assetClass: "fx", base: "EUR", quote: "USD" },
  { symbol: "GBPUSD", displayName: "British Pound / US Dollar", assetClass: "fx", base: "GBP", quote: "USD" },
  { symbol: "USDJPY", displayName: "US Dollar / Japanese Yen", assetClass: "fx", base: "USD", quote: "JPY" },
  { symbol: "USDCHF", displayName: "US Dollar / Swiss Franc", assetClass: "fx", base: "USD", quote: "CHF" },
  { symbol: "AUDUSD", displayName: "Australian Dollar / US Dollar", assetClass: "fx", base: "AUD", quote: "USD" },
  { symbol: "NZDUSD", displayName: "New Zealand Dollar / US Dollar", assetClass: "fx", base: "NZD", quote: "USD" },
  { symbol: "USDCAD", displayName: "US Dollar / Canadian Dollar", assetClass: "fx", base: "USD", quote: "CAD" },
  { symbol: "EURJPY", displayName: "Euro / Japanese Yen", assetClass: "fx", base: "EUR", quote: "JPY" },
  { symbol: "GBPJPY", displayName: "British Pound / Japanese Yen", assetClass: "fx", base: "GBP", quote: "JPY" },
  { symbol: "XAUUSD", displayName: "Gold", assetClass: "metal", base: "XAU", quote: "USD" },
];

/** The 8 real currencies the strength engine scores. XAU (gold) is not a
 * currency and is handled separately as an asset with its own drivers. */
export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function getTiInstrument(symbol: string): TiInstrument | undefined {
  return TI_UNIVERSE.find((i) => i.symbol === symbol);
}

/** Every instrument whose price reflects this currency (either leg) — used
 * to relate a currency-strength move back to the pairs it should move. */
export function instrumentsForCurrency(currency: string): TiInstrument[] {
  return TI_UNIVERSE.filter((i) => i.base === currency || i.quote === currency);
}
