import type { OhlcvBar } from "../../types";
import type { MarketDataProvider, ProviderHealth, ProviderQuote } from "../types";

interface YahooChartResult {
  last: number;
  previousClose: number;
  bars: OhlcvBar[];
}

/** Parses one Yahoo Finance `/v8/finance/chart/{symbol}` response. Exported
 * for unit testing against a realistic hand-built fixture matching the
 * endpoint's documented/observed schema — this cannot be exercised against
 * the live endpoint from inside a network-restricted environment. */
export function parseYahooChartResponse(json: any, symbolForError: string): YahooChartResult {
  const chartError = json?.chart?.error;
  if (chartError) throw new Error(`Yahoo Finance error for ${symbolForError}: ${JSON.stringify(chartError)}`);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance returned no result for ${symbolForError}`);

  const meta = result.meta ?? {};
  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? [];
  const volumes: (number | null)[] = quote.volume ?? [];

  const bars: OhlcvBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (opens[i] == null || highs[i] == null || lows[i] == null || closes[i] == null) continue; // Yahoo pads illiquid minutes with nulls
    bars.push({
      timeUtc: new Date(timestamps[i] * 1000).toISOString(),
      open: opens[i] as number,
      high: highs[i] as number,
      low: lows[i] as number,
      close: closes[i] as number,
      volume: (volumes[i] as number) ?? 0,
    });
  }

  const last = meta.regularMarketPrice ?? bars[bars.length - 1]?.close;
  if (last === undefined || last === null) throw new Error(`Yahoo Finance returned no usable price for ${symbolForError}`);
  const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? last;

  return { last, previousClose, bars };
}

async function fetchYahooChart(yahooSymbol: string): Promise<YahooChartResult> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ai-trading-intelligence-engine/1.0)", accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${yahooSymbol}`);
  const json = await res.json();
  return parseYahooChartResponse(json, yahooSymbol);
}

/**
 * Yahoo Finance's public chart endpoint: free, keyless, and the de-facto
 * standard for a build like this — but it is an unofficial, undocumented
 * public endpoint, not a contracted real-time feed. It can be delayed
 * (commonly ~15 minutes for cash equities/indices; futures/FX are often
 * closer to real-time but this is not guaranteed by any SLA), and Yahoo can
 * change or rate-limit it without notice. getHealth() reports this
 * honestly (realtime: false) rather than implying it's a trading-grade feed.
 */
export class YahooProvider implements MarketDataProvider {
  readonly name = "yahoo";
  private lastLatencyMs: number | null = null;

  async getQuote(providerSymbol: string): Promise<ProviderQuote> {
    const start = Date.now();
    const chart = await fetchYahooChart(providerSymbol);
    this.lastLatencyMs = Date.now() - start;
    return { symbol: providerSymbol, price: chart.last, timestampUtc: new Date().toISOString() };
  }

  async getCandles(providerSymbol: string): Promise<OhlcvBar[]> {
    const start = Date.now();
    const chart = await fetchYahooChart(providerSymbol);
    this.lastLatencyMs = Date.now() - start;
    return chart.bars;
  }

  /** Also exposes the previousClose alongside the quote — Yahoo bundles
   * both in one response, so callers that need %-change (macro refs) can
   * avoid a second round-trip. Not part of the MarketDataProvider interface
   * since not every provider bundles this the same way. */
  async getQuoteWithPreviousClose(providerSymbol: string): Promise<{ last: number; previousClose: number; bars: OhlcvBar[] }> {
    const start = Date.now();
    const chart = await fetchYahooChart(providerSymbol);
    this.lastLatencyMs = Date.now() - start;
    return chart;
  }

  subscribe(): null {
    return null; // Yahoo's public endpoint has no push/streaming option
  }

  getLatencyMs(): number | null {
    return this.lastLatencyMs;
  }

  getHealth(): ProviderHealth {
    return {
      providerName: "yahoo",
      realtime: false,
      streamingMode: "polling",
      label: "Yahoo Finance public chart API — free/keyless, but an unofficial, undocumented endpoint with no SLA (not guaranteed true real-time)",
    };
  }
}
