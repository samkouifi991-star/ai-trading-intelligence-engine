import { getSql } from "./client";

export interface MarketPriceSnapshot {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number;
  spread: number | null;
  changePct: number | null;
  provider: string;
  realtime: boolean;
  updatedAtUtc: Date;
}

/** Latest-only, one row per symbol — never tick-by-tick history (spec's
 * egress rules). Upserted every ingestion tick. */
export async function upsertMarketPrice(snapshot: Omit<MarketPriceSnapshot, "updatedAtUtc">): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO trading_intel.market_prices (symbol, bid, ask, last, spread, change_pct, provider, realtime, updated_at_utc)
    VALUES (${snapshot.symbol}, ${snapshot.bid}, ${snapshot.ask}, ${snapshot.last}, ${snapshot.spread}, ${snapshot.changePct}, ${snapshot.provider}, ${snapshot.realtime}, now())
    ON CONFLICT (symbol) DO UPDATE SET
      bid = excluded.bid, ask = excluded.ask, last = excluded.last, spread = excluded.spread,
      change_pct = excluded.change_pct, provider = excluded.provider, realtime = excluded.realtime,
      updated_at_utc = excluded.updated_at_utc
  `;
}

interface MarketPriceRow {
  symbol: string;
  bid: string | null;
  ask: string | null;
  last: string;
  spread: string | null;
  changePct: string | null;
  provider: string;
  realtime: boolean;
  updatedAtUtc: Date;
}

function toSnapshot(r: MarketPriceRow): MarketPriceSnapshot {
  return {
    symbol: r.symbol,
    bid: r.bid === null ? null : Number(r.bid),
    ask: r.ask === null ? null : Number(r.ask),
    last: Number(r.last),
    spread: r.spread === null ? null : Number(r.spread),
    changePct: r.changePct === null ? null : Number(r.changePct),
    provider: r.provider,
    realtime: r.realtime,
    updatedAtUtc: r.updatedAtUtc,
  };
}

export async function getMarketPrice(symbol: string): Promise<MarketPriceSnapshot | null> {
  const sql = getSql();
  const rows = await sql<MarketPriceRow[]>`
    SELECT symbol, bid, ask, last, spread, change_pct, provider, realtime, updated_at_utc
    FROM trading_intel.market_prices WHERE symbol = ${symbol}
  `;
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/** All latest prices in one query — used by the dashboard, never one query
 * per symbol (that would be 10 round trips instead of 1). */
export async function getAllMarketPrices(): Promise<MarketPriceSnapshot[]> {
  const sql = getSql();
  const rows = await sql<MarketPriceRow[]>`
    SELECT symbol, bid, ask, last, spread, change_pct, provider, realtime, updated_at_utc
    FROM trading_intel.market_prices
  `;
  return rows.map(toSnapshot);
}
