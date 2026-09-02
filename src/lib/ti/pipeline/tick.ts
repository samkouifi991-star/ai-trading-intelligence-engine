import { ingestCalendar } from "../ingestion/calendar";
import { ingestMarketData } from "../ingestion/marketData";
import { scoreRecentReleases } from "../ingestion/economicSurprise";
import { ingestCurrencyStrength } from "../ingestion/currencyStrength";

export interface TiTickResult {
  calendar: { count: number };
  marketData: { succeeded: string[]; failed: string[] };
  surprises: { scored: number; skipped: number };
  currencyStrength: { currency: string; strengthScore: number }[];
  tickAtUtc: string;
}

/**
 * Phase 1's ingestion tick: calendar -> economic surprise scoring -> market
 * data -> currency strength, in that order (surprise scoring needs the
 * calendar rows that were just ingested; currency strength needs both the
 * freshly-scored surprises and the freshly-ingested prices). Called by
 * /api/ti/cron/tick (external scheduler) and /api/ti/analyze (manual
 * "Refresh now" button) — identical to the Day/Swing engine's
 * cron/tick + analyze pattern.
 */
export async function runTiTick(): Promise<TiTickResult> {
  const calendar = await ingestCalendar(72, 48);
  const marketData = await ingestMarketData();
  const surprises = await scoreRecentReleases(48);
  const currencyStrength = await ingestCurrencyStrength();

  return { calendar, marketData, surprises, currencyStrength, tickAtUtc: new Date().toISOString() };
}
