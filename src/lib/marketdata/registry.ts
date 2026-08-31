import { YahooProvider } from "./providers/yahoo";
import { TwelveDataProvider } from "./providers/twelvedata";
import { CmeProvider } from "./providers/cme";
import type { MarketDataProvider } from "./types";

const yahoo = new YahooProvider();

/**
 * Yahoo is always available as the fallback/backup provider (per spec:
 * "do not make the entire trading engine dependent on one unofficial price
 * endpoint" — meaning don't depend on it as the *only* option, not that it
 * can't be used at all). Set MARKET_DATA_PROVIDER=twelvedata (with
 * TWELVE_DATA_API_KEY) to make Twelve Data primary instead.
 */
export function getPrimaryProvider(): MarketDataProvider {
  const selected = (process.env.MARKET_DATA_PROVIDER || "yahoo").toLowerCase();
  if (selected === "twelvedata") {
    const key = process.env.TWELVE_DATA_API_KEY;
    if (!key) throw new Error("MARKET_DATA_PROVIDER=twelvedata but TWELVE_DATA_API_KEY is not set");
    return new TwelveDataProvider(key);
  }
  if (selected === "cme") {
    return new CmeProvider();
  }
  return yahoo;
}

export function getFallbackProvider(): MarketDataProvider {
  return yahoo;
}
