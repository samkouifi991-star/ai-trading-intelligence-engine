import type { OhlcvBar } from "../../types";
import type { MarketDataProvider, ProviderHealth, ProviderQuote } from "../types";
import { fetchWithTimeout } from "../../ingestion/fetchWithTimeout";

/**
 * Real Twelve Data REST + WebSocket integration, gated behind
 * TWELVE_DATA_API_KEY. This is a genuine paid-tier real-time/low-latency
 * data vendor (unlike Yahoo's unofficial endpoint) — set the key to make it
 * the primary provider (see registry.ts).
 *
 * Important honesty note on subscribe(): a true WebSocket subscription needs
 * a long-lived connection, and this app's API routes run as Next.js
 * serverless functions — request/response, no persistent process between
 * invocations. subscribe() is implemented for real (a genuine WS client
 * against Twelve Data's real endpoint) so it works correctly when called
 * from a persistent process (see scripts/streaming-worker.ts for a runnable
 * example), but calling it from inside a serverless API route would open a
 * connection that gets torn down the moment the request completes — so the
 * MarketDataConnector adapter (src/lib/ingestion/marketData.ts) uses
 * getQuote() polling for the serverless dashboard/API surface, not
 * subscribe(). This is a deployment-model constraint, not a missing feature.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";
  private lastLatencyMs: number | null = null;

  constructor(private readonly apiKey: string) {}

  async getQuote(providerSymbol: string): Promise<ProviderQuote> {
    const start = Date.now();
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(providerSymbol)}&apikey=${this.apiKey}`;
    const res = await fetchWithTimeout(url, { cache: "no-store" }, 6000);
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${providerSymbol}`);
    const json = await res.json();
    this.lastLatencyMs = Date.now() - start;
    if (json.code || json.status === "error") throw new Error(`Twelve Data error for ${providerSymbol}: ${json.message ?? JSON.stringify(json)}`);
    const price = parseFloat(json.price);
    if (!Number.isFinite(price)) throw new Error(`Twelve Data returned no usable price for ${providerSymbol}`);
    return { symbol: providerSymbol, price, timestampUtc: new Date().toISOString() };
  }

  async getCandles(providerSymbol: string, opts?: { intervalMinutes?: number; count?: number }): Promise<OhlcvBar[]> {
    const start = Date.now();
    const interval = `${opts?.intervalMinutes ?? 1}min`;
    const outputsize = opts?.count ?? 120;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(providerSymbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${this.apiKey}`;
    const res = await fetchWithTimeout(url, { cache: "no-store" }, 6000);
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${providerSymbol}`);
    const json = await res.json();
    this.lastLatencyMs = Date.now() - start;
    if (json.status === "error") throw new Error(`Twelve Data error for ${providerSymbol}: ${json.message ?? JSON.stringify(json)}`);
    const values: any[] = json.values ?? [];
    return values
      .map((v) => ({
        timeUtc: new Date(v.datetime.includes("T") ? v.datetime : `${v.datetime}Z`).toISOString(),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume ?? "0"),
      }))
      .reverse(); // Twelve Data returns newest-first; we want ascending
  }

  /** Real WebSocket subscription against Twelve Data's real endpoint — see
   * the class-level doc comment on why this is meant for a persistent
   * process, not a serverless API route. */
  subscribe(providerSymbol: string, onQuote: (q: ProviderQuote) => void): (() => void) | null {
    if (typeof WebSocket === "undefined") return null; // no native WebSocket in this runtime
    const ws = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${this.apiKey}`);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ action: "subscribe", params: { symbols: providerSymbol } }));
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (msg.event === "price" && msg.symbol === providerSymbol && typeof msg.price === "number") {
          onQuote({ symbol: providerSymbol, price: msg.price, timestampUtc: new Date().toISOString() });
        }
      } catch {
        // ignore malformed frames
      }
    });
    return () => ws.close();
  }

  getLatencyMs(): number | null {
    return this.lastLatencyMs;
  }

  getHealth(): ProviderHealth {
    return {
      providerName: "twelvedata",
      realtime: true,
      streamingMode: "streaming",
      label: "Twelve Data (paid, low-latency) — streaming only from a persistent process; serverless routes use its REST quote endpoint instead",
    };
  }
}
