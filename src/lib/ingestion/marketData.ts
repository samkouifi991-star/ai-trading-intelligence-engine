import type { MacroSnapshot, MarketSnapshot, OhlcvBar } from "../types";
import type { MarketDataConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";
import { recordConnectorHealth, resolveLiveOrFallback } from "./connectorHealth";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { isProductionMode, DataUnavailableError } from "../config/appMode";
import { getPrimaryProvider, getFallbackProvider } from "../marketdata/registry";
import { providerSymbol, isGlobalSessionOpen } from "../marketdata/instruments";
import { computeRatePressure } from "../marketdata/ratePressure";

/**
 * This is a thin adapter over the MarketDataProvider registry
 * (src/lib/marketdata/*) that preserves the existing MarketDataConnector
 * shape (getSnapshot/getMacroSnapshot) every scoring engine already depends
 * on — so switching providers, or adding a new one, never touches
 * src/lib/scoring, src/lib/crossAsset, or src/lib/technical.
 */

// ── Sample-mode fallback (development only — see appMode.ts) ──────────────

const ANCHOR_PRICE: Record<string, number> = {
  XAUUSD: 2650,
  ES: 5700,
  NQ: 20000,
  WTI: 72,
  EURUSD: 1.08,
  GBPUSD: 1.27,
  USDJPY: 152,
  USDCAD: 1.36,
  AUDUSD: 0.66,
};

const VOL_PCT: Record<string, number> = {
  XAUUSD: 0.006,
  ES: 0.004,
  NQ: 0.006,
  WTI: 0.012,
  EURUSD: 0.003,
  GBPUSD: 0.0035,
  USDJPY: 0.003,
  USDCAD: 0.0025,
  AUDUSD: 0.004,
};

function buildSampleBars(symbol: string, count: number, barMinutes: number): OhlcvBar[] {
  const anchor = ANCHOR_PRICE[symbol] ?? 100;
  const volPct = VOL_PCT[symbol] ?? 0.004;
  const now = Date.now();
  const bucket = Math.floor(now / (barMinutes * 60_000));
  const rand = mulberry32(hashString(`bars:${symbol}:${bucket}`));

  const bars: OhlcvBar[] = [];
  let price = anchor * (1 + (rand() - 0.5) * 0.01);
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(now - i * barMinutes * 60_000);
    const drift = (rand() - 0.5) * anchor * volPct;
    const open = price;
    const close = Math.max(0.0001, open + drift);
    const high = Math.max(open, close) + rand() * anchor * volPct * 0.4;
    const low = Math.min(open, close) - rand() * anchor * volPct * 0.4;
    const volume = Math.round(1000 + rand() * 5000);
    bars.push({ timeUtc: t.toISOString(), open, high, low, close, volume });
    price = close;
  }
  return bars;
}

export function computeVwap(bars: OhlcvBar[]): number | null {
  if (bars.length === 0) return null;
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function sampleSnapshot(symbol: string): MarketSnapshot {
  const bars = buildSampleBars(symbol, 120, 1);
  const last = bars[bars.length - 1]?.close ?? ANCHOR_PRICE[symbol] ?? 0;
  recordConnectorHealth(`marketData:${symbol}`, "sample", "development mode — live fetch failed, using sample fallback");
  return { symbol, priceUtc: new Date().toISOString(), last, vwap: computeVwap(bars), bars };
}

function sampleRef(key: string): { value: number; changePct: number } {
  const now = Date.now();
  const bucket = Math.floor(now / 60_000);
  const rand = mulberry32(hashString(`macro:${key}:${bucket}`));
  recordConnectorHealth(`marketData:${key}`, "sample", "development mode — live fetch failed, using sample fallback");
  if (key === "DXY") return { value: round(104 + (rand() - 0.5) * 1.2, 2), changePct: round((rand() - 0.5) * 0.6, 2) };
  if (key === "VIX") return { value: round(15 + rand() * 6, 2), changePct: round((rand() - 0.5) * 6, 2) };
  return { value: 0, changePct: round((rand() - 0.5) * 0.15, 3) }; // rate-pressure proxies only need changePct
}

// ── Live: per-instrument price snapshot (primary provider, Yahoo fallback) ─

async function attemptLiveSnapshot(symbol: string): Promise<MarketSnapshot> {
  const start = Date.now();
  const primary = getPrimaryProvider();
  const fallback = getFallbackProvider();
  const providers = primary.name === fallback.name ? [primary] : [primary, fallback];
  let lastErr: unknown = new Error("no market data provider configured");

  for (const provider of providers) {
    try {
      const sym = providerSymbol(symbol, provider.name as "yahoo" | "twelvedata");
      const bars = await provider.getCandles(sym);
      const last = bars[bars.length - 1]?.close;
      if (last === undefined) throw new Error(`${provider.name} returned no bars for ${symbol}`);
      const health = provider.getHealth();
      const partial = bars.length < 10;
      recordConnectorHealth(
        `marketData:${symbol}`,
        partial ? "partial" : "live",
        partial ? `${provider.name}: only ${bars.length} bars returned` : `${provider.name}: ok`,
        { latencyMs: Date.now() - start, realtime: health.realtime, streamingMode: health.streamingMode, marketOpen: isGlobalSessionOpen() }
      );
      return { symbol, priceUtc: new Date().toISOString(), last, vwap: computeVwap(bars) ?? last, bars };
    } catch (err) {
      lastErr = err;
    }
  }

  recordConnectorHealth(`marketData:${symbol}`, "blocked", lastErr instanceof Error ? lastErr.message : String(lastErr), {
    latencyMs: Date.now() - start,
    marketOpen: isGlobalSessionOpen(),
  });
  throw lastErr;
}

// ── Live: reference series (DXY / VIX / Treasury-futures rate proxies) ────

export type RefKey = "DXY" | "VIX" | "US2Y_PROXY" | "US10Y_PROXY";

/** Latest price for a reference series (DXY/VIX/Treasury-futures rate
 * proxies) — used by the Event Clock (pipeline/eventClock.ts) to snapshot
 * these alongside tradable instruments at each checkpoint. Throws on
 * failure rather than falling back to sample data; the Event Clock treats a
 * missed snapshot as "not captured this tick," not a fabricated price. */
export async function getReferencePrice(key: RefKey): Promise<number> {
  const { value } = await attemptRefSeries(key);
  return value;
}

async function attemptRefSeries(key: RefKey): Promise<{ value: number; changePct: number }> {
  const start = Date.now();
  const primary = getPrimaryProvider();
  const fallback = getFallbackProvider();
  const providers = primary.name === fallback.name ? [primary] : [primary, fallback];
  let lastErr: unknown = new Error(`no market data provider configured for ${key}`);

  for (const provider of providers) {
    try {
      const sym = providerSymbol(key, provider.name as "yahoo" | "twelvedata");
      const bars = await provider.getCandles(sym);
      if (bars.length === 0) throw new Error(`${provider.name} returned no bars for ${key}`);
      const last = bars[bars.length - 1].close;
      const first = bars[0].open;
      const changePct = first ? ((last - first) / first) * 100 : 0;
      const health = provider.getHealth();
      recordConnectorHealth(`marketData:${key}`, "live", `${provider.name}: ok`, {
        latencyMs: Date.now() - start,
        realtime: health.realtime,
        streamingMode: health.streamingMode,
        marketOpen: isGlobalSessionOpen(),
      });
      return { value: round(last, key === "VIX" || key === "DXY" ? 2 : 3), changePct: round(changePct, 3) };
    } catch (err) {
      lastErr = err;
    }
  }

  recordConnectorHealth(`marketData:${key}`, "blocked", lastErr instanceof Error ? lastErr.message : String(lastErr), {
    latencyMs: Date.now() - start,
    marketOpen: isGlobalSessionOpen(),
  });
  throw lastErr;
}

// ── Live: FRED daily Treasury yields (macro context only — never used for
// intraday Day-engine confirmation, see MacroSnapshot's doc comment) ───────

async function fetchFredSeries(seriesId: string): Promise<{ latest: { date: string; value: number }; previous: { date: string; value: number } }> {
  const start = Date.now();
  const sourceKey = `marketData:FRED_${seriesId}`;
  try {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
    const res = await fetchWithTimeout(url, { headers: { accept: "text/csv" }, cache: "no-store" }, 8000);
    if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);
    const csv = await res.text();
    const result = parseFredCsv(csv);
    const ageHours = (Date.now() - new Date(result.latest.date).getTime()) / 3_600_000;
    recordConnectorHealth(
      sourceKey,
      ageHours > 96 ? "partial" : "live",
      ageHours > 96 ? `Latest observation ${result.latest.date} is ${Math.round(ageHours)}h old` : "ok",
      { latencyMs: Date.now() - start, realtime: false, streamingMode: "polling" }
    );
    return result;
  } catch (err) {
    recordConnectorHealth(sourceKey, "blocked", err instanceof Error ? err.message : String(err), { latencyMs: Date.now() - start });
    throw err;
  }
}

/** FRED's `fredgraph.csv` export: `DATE,<SERIES_ID>\n2026-08-28,4.18\n...`
 * with `.` for a missing/holiday value. Exported for unit testing against a
 * realistic fixture. */
export function parseFredCsv(csv: string): { latest: { date: string; value: number }; previous: { date: string; value: number } } {
  const lines = csv.trim().split("\n").slice(1);
  const rows: { date: string; value: number }[] = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    if (!date || raw === undefined) continue;
    const value = parseFloat(raw.trim());
    if (Number.isFinite(value)) rows.push({ date: date.trim(), value });
  }
  if (rows.length < 1) throw new Error("FRED series had no numeric observations");
  const latest = rows[rows.length - 1];
  const previous = rows.length >= 2 ? rows[rows.length - 2] : latest;
  return { latest, previous };
}

// ── The adapter ─────────────────────────────────────────────────────────

class SmartMarketDataConnector implements MarketDataConnector {
  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    return resolveLiveOrFallback(
      `marketData:${symbol}`,
      () => attemptLiveSnapshot(symbol),
      () => sampleSnapshot(symbol)
    );
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    const [dxyR, vixR, r2yR, r10yR] = await Promise.allSettled([
      attemptRefSeries("DXY"),
      attemptRefSeries("VIX"),
      attemptRefSeries("US2Y_PROXY"),
      attemptRefSeries("US10Y_PROXY"),
    ]);
    const results: Record<RefKey, PromiseSettledResult<{ value: number; changePct: number }>> = {
      DXY: dxyR,
      VIX: vixR,
      US2Y_PROXY: r2yR,
      US10Y_PROXY: r10yR,
    };
    const failedKeys = (Object.keys(results) as RefKey[]).filter((k) => results[k].status === "rejected");

    // DXY/VIX/rate-pressure proxies are the Day engine's required
    // cross-market confirmation inputs — in production, if any are
    // unavailable, fail loudly rather than silently substitute fake data
    // (spec rule 5). The caller (day/swing engines) catches this and marks
    // that tick's evaluations NO_TRADE with an explicit reason.
    if (failedKeys.length > 0 && isProductionMode()) {
      throw new DataUnavailableError("marketData:macro", new Error(`Unavailable in production: ${failedKeys.join(", ")}`));
    }

    const pick = (k: RefKey) => (results[k].status === "fulfilled" ? (results[k] as PromiseFulfilledResult<{ value: number; changePct: number }>).value : sampleRef(k));
    const dxy = pick("DXY");
    const vix = pick("VIX");
    const r2y = pick("US2Y_PROXY");
    const r10y = pick("US10Y_PROXY");

    const [fred2y, fred10y] = await Promise.allSettled([fetchFredSeries("DGS2"), fetchFredSeries("DGS10")]);

    return {
      timeUtc: new Date().toISOString(),
      dxy: dxy.value,
      dxyChangePct: dxy.changePct,
      vix: vix.value,
      vixChangePct: vix.changePct,
      us2yRatePressure: computeRatePressure(r2y.changePct),
      us10yRatePressure: computeRatePressure(r10y.changePct),
      us2yDaily: fred2y.status === "fulfilled" ? fred2y.value.latest.value : null,
      us10yDaily: fred10y.status === "fulfilled" ? fred10y.value.latest.value : null,
      us2yDailyChangeBps: fred2y.status === "fulfilled" ? round((fred2y.value.latest.value - fred2y.value.previous.value) * 100, 1) : null,
      us10yDailyChangeBps: fred10y.status === "fulfilled" ? round((fred10y.value.latest.value - fred10y.value.previous.value) * 100, 1) : null,
    };
  }
}

export function getMarketDataConnector(): { connector: MarketDataConnector; mode: "live" } {
  return { connector: new SmartMarketDataConnector(), mode: "live" };
}
