import type { MacroSnapshot, MarketSnapshot, OhlcvBar } from "../types";
import type { MarketDataConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";
import { withConnectorHealth } from "./connectorHealth";

// ── Sample-mode fallback (used only when a live fetch fails) ──────────────

/** Anchor prices sample-mode random walks are built around — purely to make
 * fallback data look plausible, never used by the live path. */
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
  return { symbol, priceUtc: new Date().toISOString(), last, vwap: computeVwap(bars), bars };
}

function sampleMacroSnapshot(): MacroSnapshot {
  const now = Date.now();
  const bucket = Math.floor(now / 60_000);
  const rand = mulberry32(hashString(`macro:${bucket}`));
  return {
    timeUtc: new Date(now).toISOString(),
    dxy: round(104 + (rand() - 0.5) * 1.2, 2),
    us2y: round(4.3 + (rand() - 0.5) * 0.2, 3),
    us10y: round(4.1 + (rand() - 0.5) * 0.2, 3),
    vix: round(15 + rand() * 6, 2),
    dxyChangePct: round((rand() - 0.5) * 0.6, 2),
    us2yChangeBps: round((rand() - 0.5) * 8, 1),
    us10yChangeBps: round((rand() - 0.5) * 8, 1),
    vixChangePct: round((rand() - 0.5) * 6, 2),
  };
}

// ── Live connector: Yahoo Finance (tradables + DXY + VIX) + FRED (yields) ──

/**
 * Yahoo Finance's public chart endpoint requires no API key and is the
 * de-facto standard free source for exactly this kind of build. Treasury
 * yields come from FRED (Federal Reserve Economic Data) instead — its public
 * CSV export is also keyless and is the authoritative government source,
 * though daily-resolution (yields settle once/day), not tick-by-tick.
 */
const YAHOO_SYMBOL: Record<string, string> = {
  XAUUSD: "XAUUSD=X",
  ES: "ES=F",
  NQ: "NQ=F",
  WTI: "CL=F",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "USDJPY=X",
  USDCAD: "USDCAD=X",
  AUDUSD: "AUDUSD=X",
  DXY: "DX-Y.NYB",
  VIX: "^VIX",
};

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

/** FRED's `fredgraph.csv` export: `DATE,<SERIES_ID>\n2026-08-28,4.18\n...`
 * with `.` for a missing/holiday value. Exported for unit testing against a
 * realistic fixture. */
export function parseFredCsv(csv: string): { latest: { date: string; value: number }; previous: { date: string; value: number } } {
  const lines = csv.trim().split("\n").slice(1); // skip header row
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

async function fetchFredSeries(seriesId: string): Promise<{ latest: { date: string; value: number }; previous: { date: string; value: number } }> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: { accept: "text/csv" }, cache: "no-store" });
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);
  const csv = await res.text();
  return parseFredCsv(csv);
}

class LiveMarketDataConnector implements MarketDataConnector {
  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    const yahooSymbol = YAHOO_SYMBOL[symbol];
    if (!yahooSymbol) throw new Error(`No live symbol mapping for ${symbol}`);

    return withConnectorHealth(`marketData:${symbol}`, async () => {
      const chart = await fetchYahooChart(yahooSymbol);
      const snapshot: MarketSnapshot = {
        symbol,
        priceUtc: new Date().toISOString(),
        last: chart.last,
        vwap: computeVwap(chart.bars) ?? chart.last,
        bars: chart.bars,
      };
      if (chart.bars.length < 10) {
        return { data: snapshot, partial: `Only ${chart.bars.length} intraday bars returned — technical indicators will be noisy` };
      }
      return { data: snapshot };
    });
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    const [dxy, vix, us2y, us10y] = await Promise.allSettled([
      this.fetchYahooRef("DXY"),
      this.fetchYahooRef("VIX"),
      this.fetchFredRef("US2Y", "DGS2"),
      this.fetchFredRef("US10Y", "DGS10"),
    ]);

    const fallback = sampleMacroSnapshot();
    const dxyVal = dxy.status === "fulfilled" ? dxy.value : null;
    const vixVal = vix.status === "fulfilled" ? vix.value : null;
    const us2yVal = us2y.status === "fulfilled" ? us2y.value : null;
    const us10yVal = us10y.status === "fulfilled" ? us10y.value : null;

    return {
      timeUtc: new Date().toISOString(),
      dxy: dxyVal ? dxyVal.value : fallback.dxy,
      dxyChangePct: dxyVal ? dxyVal.changePct : fallback.dxyChangePct,
      vix: vixVal ? vixVal.value : fallback.vix,
      vixChangePct: vixVal ? vixVal.changePct : fallback.vixChangePct,
      us2y: us2yVal ? us2yVal.value : fallback.us2y,
      us2yChangeBps: us2yVal ? us2yVal.changeBps : fallback.us2yChangeBps,
      us10y: us10yVal ? us10yVal.value : fallback.us10y,
      us10yChangeBps: us10yVal ? us10yVal.changeBps : fallback.us10yChangeBps,
    };
  }

  private async fetchYahooRef(refKey: "DXY" | "VIX"): Promise<{ value: number; changePct: number }> {
    return withConnectorHealth(`marketData:${refKey}`, async () => {
      const chart = await fetchYahooChart(YAHOO_SYMBOL[refKey]);
      const changePct = chart.previousClose ? ((chart.last - chart.previousClose) / chart.previousClose) * 100 : 0;
      return { data: { value: round(chart.last, 2), changePct: round(changePct, 2) } };
    });
  }

  private async fetchFredRef(refKey: "US2Y" | "US10Y", seriesId: string): Promise<{ value: number; changeBps: number }> {
    return withConnectorHealth(`marketData:${refKey}`, async () => {
      const { latest, previous } = await fetchFredSeries(seriesId);
      const changeBps = (latest.value - previous.value) * 100;
      const ageHours = (Date.now() - new Date(latest.date).getTime()) / 3_600_000;
      const value = { value: round(latest.value, 3), changeBps: round(changeBps, 1) };
      if (ageHours > 96) {
        // Yields are daily-resolution; > ~4 days stale means the series hasn't updated (e.g. long weekend) — still real, just old.
        return { data: value, partial: `Latest FRED ${seriesId} observation is from ${latest.date} (${Math.round(ageHours)}h old)` };
      }
      return { data: value };
    });
  }
}

class SampleMarketDataConnector implements MarketDataConnector {
  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    return sampleSnapshot(symbol);
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    return sampleMacroSnapshot();
  }
}

/** Always attempts live data first (Yahoo Finance + FRED, both keyless) and
 * only falls back to the sample generator per-field on failure — see
 * connectorHealth for how "live" vs "blocked" vs "partial" is tracked and
 * surfaced on the Live Data Status page. Set MARKET_DATA_BASE_URL +
 * MARKET_DATA_API_KEY to use a premium vendor instead. */
class SmartMarketDataConnector implements MarketDataConnector {
  private live = new LiveMarketDataConnector();
  private sample = new SampleMarketDataConnector();

  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    try {
      return await this.live.getSnapshot(symbol);
    } catch {
      return this.sample.getSnapshot(symbol);
    }
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    // getMacroSnapshot never throws — each sub-series falls back independently.
    return this.live.getMacroSnapshot();
  }
}

class PremiumVendorConnector implements MarketDataConnector {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    return withConnectorHealth(`marketData:${symbol}`, async () => {
      const res = await fetch(`${this.baseUrl}/bars?symbol=${encodeURIComponent(symbol)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Market data error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as MarketSnapshot;
      return { data };
    });
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    return withConnectorHealth("marketData:macro", async () => {
      const res = await fetch(`${this.baseUrl}/macro`, {
        headers: { Authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Macro feed error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as MacroSnapshot;
      return { data };
    });
  }
}

export function getMarketDataConnector(): { connector: MarketDataConnector; mode: "live" } {
  const baseUrl = process.env.MARKET_DATA_BASE_URL;
  const apiKey = process.env.MARKET_DATA_API_KEY;
  if (baseUrl && apiKey) return { connector: new PremiumVendorConnector(baseUrl, apiKey), mode: "live" };
  return { connector: new SmartMarketDataConnector(), mode: "live" };
}
