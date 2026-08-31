import type { MacroSnapshot, MarketSnapshot, OhlcvBar } from "../types";
import type { MarketDataConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";

/** Anchor prices sample-mode random walks are built around, roughly current
 * as of authoring — purely to make demo data look plausible, never used by
 * a live connector. */
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

function computeVwap(bars: OhlcvBar[]): number | null {
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

class SampleMarketDataConnector implements MarketDataConnector {
  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    const bars = buildSampleBars(symbol, 120, 1); // last 120 x 1-minute bars
    const last = bars[bars.length - 1]?.close ?? ANCHOR_PRICE[symbol] ?? 0;
    return {
      symbol,
      priceUtc: new Date().toISOString(),
      last,
      vwap: computeVwap(bars),
      bars,
    };
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    const now = Date.now();
    const bucket = Math.floor(now / 60_000);
    const rand = mulberry32(hashString(`macro:${bucket}`));
    const dxy = 104 + (rand() - 0.5) * 1.2;
    const us2y = 4.3 + (rand() - 0.5) * 0.2;
    const us10y = 4.1 + (rand() - 0.5) * 0.2;
    const vix = 15 + rand() * 6;
    return {
      timeUtc: new Date(now).toISOString(),
      dxy: round(dxy, 2),
      us2y: round(us2y, 3),
      us10y: round(us10y, 3),
      vix: round(vix, 2),
      dxyChangePct: round((rand() - 0.5) * 0.6, 2),
      us2yChangeBps: round((rand() - 0.5) * 8, 1),
      us10yChangeBps: round((rand() - 0.5) * 8, 1),
      vixChangePct: round((rand() - 0.5) * 6, 2),
    };
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

class LiveMarketDataConnector implements MarketDataConnector {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    const res = await fetch(`${this.baseUrl}/bars?symbol=${encodeURIComponent(symbol)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Market data error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data as MarketSnapshot;
  }

  async getMacroSnapshot(): Promise<MacroSnapshot> {
    const res = await fetch(`${this.baseUrl}/macro`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Macro feed error ${res.status}: ${await res.text()}`);
    return (await res.json()) as MacroSnapshot;
  }
}

export function getMarketDataConnector(): { connector: MarketDataConnector; mode: "live" | "sample" } {
  const baseUrl = process.env.MARKET_DATA_BASE_URL;
  const apiKey = process.env.MARKET_DATA_API_KEY;
  if (baseUrl && apiKey) return { connector: new LiveMarketDataConnector(baseUrl, apiKey), mode: "live" };
  return { connector: new SampleMarketDataConnector(), mode: "sample" };
}
