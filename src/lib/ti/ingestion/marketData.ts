import { TI_UNIVERSE } from "../universe";
import { getPrimaryProvider, getFallbackProvider } from "../../marketdata/registry";
import { providerSymbol } from "../../marketdata/instruments";
import { withSourceHealth, resolveLiveOrSample } from "../db/dataSources";
import { upsertMarketPrice } from "../db/marketPrices";
import { hashString, mulberry32 } from "../../ingestion/seededRandom";

/**
 * Fetches a live quote+recent candles for one symbol from the primary
 * provider (Yahoo by default, keyless; Twelve Data if configured — see
 * marketdata/registry.ts), falling back to the secondary provider if the
 * primary fails, exactly like the Day/Swing engine's market data adapter.
 * No bid/ask feed is wired for either provider, so bid/ask/spread are
 * stored as null (never fabricated) rather than estimated from last price.
 */
async function fetchLiveSnapshot(symbol: string): Promise<{ last: number; changePct: number | null; provider: string; realtime: boolean }> {
  return withSourceHealth(`marketData:${symbol}`, async () => {
    const primary = getPrimaryProvider();
    const fallback = getFallbackProvider();
    const providers = primary.name === fallback.name ? [primary] : [primary, fallback];
    let lastErr: unknown = new Error("no market data provider configured");

    for (const provider of providers) {
      try {
        const sym = providerSymbol(symbol, provider.name as "yahoo" | "twelvedata");
        const bars = await provider.getCandles(sym, { intervalMinutes: 1, count: 120 });
        const last = bars[bars.length - 1]?.close;
        if (last === undefined) throw new Error(`${provider.name} returned no bars for ${symbol}`);
        const first = bars[0]?.open;
        const changePct = first ? ((last - first) / first) * 100 : null;
        const health = provider.getHealth();
        const partial = bars.length < 10;
        return {
          data: { last, changePct, provider: provider.name, realtime: health.realtime },
          partial: partial ? `${provider.name}: only ${bars.length} bars returned` : undefined,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  });
}

function sampleSnapshot(symbol: string): { last: number; changePct: number | null; provider: string; realtime: boolean } {
  const ANCHOR: Record<string, number> = {
    EURUSD: 1.08, GBPUSD: 1.27, USDJPY: 152, USDCHF: 0.88, AUDUSD: 0.66,
    NZDUSD: 0.61, USDCAD: 1.36, EURJPY: 164, GBPJPY: 193, XAUUSD: 2650,
  };
  const anchor = ANCHOR[symbol] ?? 1;
  const bucket = Math.floor(Date.now() / 60_000);
  const rand = mulberry32(hashString(`ti:sample:${symbol}:${bucket}`));
  const changePct = (rand() - 0.5) * 0.8;
  const last = anchor * (1 + changePct / 100);
  return { last, changePct, provider: "sample", realtime: false };
}

/**
 * One ingestion tick over the whole Trading Intelligence universe. Fetches
 * concurrently (Promise.allSettled — one symbol's failure never blocks the
 * rest), upserts each into the latest-only market_prices table.
 */
export async function ingestMarketData(): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  const results = await Promise.allSettled(
    TI_UNIVERSE.map(async (instrument) => {
      const snapshot = await resolveLiveOrSample(
        `marketData:${instrument.symbol}`,
        () => fetchLiveSnapshot(instrument.symbol),
        () => sampleSnapshot(instrument.symbol)
      );
      await upsertMarketPrice({
        symbol: instrument.symbol,
        bid: null,
        ask: null,
        last: snapshot.last,
        spread: null,
        changePct: snapshot.changePct,
        provider: snapshot.provider,
        realtime: snapshot.realtime,
      });
      return instrument.symbol;
    })
  );

  results.forEach((r, i) => {
    if (r.status === "fulfilled") succeeded.push(r.value);
    else failed.push(TI_UNIVERSE[i].symbol);
  });

  return { succeeded, failed };
}
