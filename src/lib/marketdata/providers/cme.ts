import type { OhlcvBar } from "../../types";
import type { MarketDataProvider, ProviderHealth, ProviderQuote } from "../types";

const NOT_IMPLEMENTED =
  "CME direct market data is not implemented. It requires a licensed CME Market Data Platform (or a redistributor) agreement, vendor-specific SDK, and per-instrument entitlements — none of which this build has credentials for. This class exists so the provider interface is complete and documented, not as a working implementation. Do not enable MARKET_DATA_PROVIDER=cme; there is nothing behind it.";

/**
 * Documented, deliberately non-functional stub. Every method throws with an
 * explanation rather than returning fabricated data — the alternative
 * (silently falling back to something else while claiming to be "CME") is
 * exactly the kind of quiet substitution this build is designed to avoid.
 */
export class CmeProvider implements MarketDataProvider {
  readonly name = "cme";

  async getQuote(): Promise<ProviderQuote> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getCandles(): Promise<OhlcvBar[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  getLatencyMs(): number | null {
    return null;
  }

  getHealth(): ProviderHealth {
    return { providerName: "cme", realtime: false, streamingMode: "polling", label: NOT_IMPLEMENTED };
  }
}
