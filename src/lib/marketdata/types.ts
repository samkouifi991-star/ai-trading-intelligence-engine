import type { OhlcvBar } from "../types";

export interface ProviderQuote {
  symbol: string;
  price: number;
  timestampUtc: string;
}

export interface ProviderHealth {
  providerName: string;
  realtime: boolean;
  streamingMode: "streaming" | "polling";
  label: string;
}

/**
 * Every price source (Yahoo, Twelve Data, CME, ...) implements this same
 * interface. Nothing in the scoring engines talks to a provider directly —
 * they only ever see src/lib/ingestion/marketData.ts's MarketDataConnector
 * adapter, so swapping/adding a provider here never touches scoring code.
 */
export interface MarketDataProvider {
  readonly name: string;
  getQuote(providerSymbol: string): Promise<ProviderQuote>;
  getCandles(providerSymbol: string, opts?: { intervalMinutes?: number; count?: number }): Promise<OhlcvBar[]>;
  /** Returns an unsubscribe function if this provider supports push
   * streaming, or null if it doesn't (caller should poll getQuote instead). */
  subscribe?(providerSymbol: string, onQuote: (q: ProviderQuote) => void): (() => void) | null;
  getLatencyMs(): number | null;
  getHealth(): ProviderHealth;
}
