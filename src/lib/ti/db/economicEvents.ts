import { getSql } from "./client";
import type { EconomicEvent } from "../../types";

const CURRENCY_COUNTRY: Record<string, string> = {
  USD: "United States",
  EUR: "Eurozone",
  GBP: "United Kingdom",
  JPY: "Japan",
  CHF: "Switzerland",
  CAD: "Canada",
  AUD: "Australia",
  NZD: "New Zealand",
};

export function countryForCurrency(currency: string): string | null {
  return CURRENCY_COUNTRY[currency] ?? null;
}

export function indicatorKey(event: Pick<EconomicEvent, "event" | "currency">): string {
  return `${event.currency}:${event.event}`.toLowerCase().trim();
}

export async function upsertEconomicEvent(event: EconomicEvent): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO trading_intel.economic_events
      (id, event, currency, country, event_time_utc, impact, actual, forecast, previous, revised_previous, source, description, ingested_at_utc)
    VALUES
      (${event.id}, ${event.event}, ${event.currency}, ${countryForCurrency(event.currency)}, ${event.eventTimeUtc}, ${event.impact},
       ${event.actual}, ${event.forecast}, ${event.previous}, ${event.revisedPrevious}, ${event.source}, ${event.description}, now())
    ON CONFLICT (id) DO UPDATE SET
      actual = excluded.actual, forecast = excluded.forecast, previous = excluded.previous,
      revised_previous = excluded.revised_previous, ingested_at_utc = excluded.ingested_at_utc
  `;

  if (event.actual !== null) {
    const surprise = event.forecast !== null ? event.actual - event.forecast : null;
    await sql`
      INSERT INTO trading_intel.indicator_history (indicator_key, event_time_utc, actual, forecast, surprise)
      VALUES (${indicatorKey(event)}, ${event.eventTimeUtc}, ${event.actual}, ${event.forecast}, ${surprise})
      ON CONFLICT (indicator_key, event_time_utc) DO UPDATE SET
        actual = excluded.actual, forecast = excluded.forecast, surprise = excluded.surprise
    `;
  }
}

interface EconomicEventRow {
  id: string;
  event: string;
  currency: string;
  country: string | null;
  eventTimeUtc: Date;
  impact: "high" | "medium" | "low";
  actual: string | null; // numeric comes back as string from postgres.js
  forecast: string | null;
  previous: string | null;
  revisedPrevious: string | null;
  source: string;
  description: string | null;
}

function toEconomicEvent(r: EconomicEventRow): EconomicEvent {
  return {
    id: r.id,
    event: r.event,
    currency: r.currency,
    eventTimeUtc: r.eventTimeUtc.toISOString(),
    impact: r.impact,
    actual: r.actual === null ? null : Number(r.actual),
    forecast: r.forecast === null ? null : Number(r.forecast),
    previous: r.previous === null ? null : Number(r.previous),
    revisedPrevious: r.revisedPrevious === null ? null : Number(r.revisedPrevious),
    source: r.source,
    description: r.description ?? "",
  };
}

/** Selective columns, bounded by the caller's time range — never an
 * unbounded scan of the whole calendar table. */
export async function getEventsInRange(fromUtc: string, toUtc: string): Promise<EconomicEvent[]> {
  const sql = getSql();
  const rows = await sql<EconomicEventRow[]>`
    SELECT id, event, currency, country, event_time_utc, impact, actual, forecast, previous, revised_previous, source, description
    FROM trading_intel.economic_events
    WHERE event_time_utc BETWEEN ${fromUtc} AND ${toUtc}
    ORDER BY event_time_utc ASC
  `;
  return rows.map(toEconomicEvent);
}

export interface EconomicEventWithSurprise extends EconomicEvent {
  currencyScore: number | null;
  directionality: string | null;
  isSampleSource: boolean | null;
}

/** Events in range, left-joined to each one's most recent surprise score
 * (there's at most one meaningful score per released event under the
 * scoring engine's 6h re-score cooldown) — one query, not N+1. */
export async function getEventsWithSurpriseInRange(fromUtc: string, toUtc: string): Promise<EconomicEventWithSurprise[]> {
  const sql = getSql();
  const rows = await sql<(EconomicEventRow & { currencyScore: string | null; directionality: string | null; isSampleSource: boolean | null })[]>`
    SELECT e.id, e.event, e.currency, e.country, e.event_time_utc, e.impact, e.actual, e.forecast, e.previous, e.revised_previous, e.source, e.description,
           s.currency_score, s.directionality, s.is_sample_source
    FROM trading_intel.economic_events e
    LEFT JOIN LATERAL (
      SELECT currency_score, directionality, is_sample_source
      FROM trading_intel.economic_surprises
      WHERE event_id = e.id
      ORDER BY computed_at_utc DESC
      LIMIT 1
    ) s ON true
    WHERE e.event_time_utc BETWEEN ${fromUtc} AND ${toUtc}
    ORDER BY e.event_time_utc ASC
  `;
  return rows.map((r) => ({
    ...toEconomicEvent(r),
    currencyScore: r.currencyScore === null ? null : Number(r.currencyScore),
    directionality: r.directionality,
    isSampleSource: r.isSampleSource,
  }));
}

/** One real (never sample-sourced) scored release, most recent first — for
 * verification reporting. Returns null (never a fabricated example) if
 * nothing has been scored from a genuinely live calendar fetch yet. */
export async function getExampleRealScoredRelease(): Promise<
  (EconomicEventWithSurprise & {
    currentSurpriseZ: number | null;
    historicalMean: number;
    historicalStdDev: number;
    historicalSampleSize: number;
    regimeAdjustedNote: string;
  })
  | null
> {
  const sql = getSql();
  const rows = await sql<any[]>`
    SELECT e.id, e.event, e.currency, e.country, e.event_time_utc, e.impact, e.actual, e.forecast, e.previous, e.revised_previous, e.source, e.description,
           s.currency_score, s.directionality, s.is_sample_source, s.current_surprise_z, s.historical_mean, s.historical_std_dev, s.historical_sample_size, s.regime_adjusted_note
    FROM trading_intel.economic_surprises s
    JOIN trading_intel.economic_events e ON e.id = s.event_id
    WHERE s.is_sample_source = false
    ORDER BY s.computed_at_utc DESC
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    ...toEconomicEvent(r),
    currencyScore: Number(r.currencyScore),
    directionality: r.directionality,
    isSampleSource: r.isSampleSource,
    currentSurpriseZ: r.currentSurpriseZ === null ? null : Number(r.currentSurpriseZ),
    historicalMean: Number(r.historicalMean),
    historicalStdDev: Number(r.historicalStdDev),
    historicalSampleSize: Number(r.historicalSampleSize),
    regimeAdjustedNote: r.regimeAdjustedNote,
  };
}

export interface IndicatorHistoryRow {
  indicatorKey: string;
  eventTimeUtc: Date;
  actual: number | null;
  forecast: number | null;
  surprise: number | null;
}

export async function getIndicatorHistory(key: string, limit = 60): Promise<IndicatorHistoryRow[]> {
  const sql = getSql();
  const rows = await sql<{ indicatorKey: string; eventTimeUtc: Date; actual: string | null; forecast: string | null; surprise: string | null }[]>`
    SELECT indicator_key, event_time_utc, actual, forecast, surprise
    FROM trading_intel.indicator_history
    WHERE indicator_key = ${key}
    ORDER BY event_time_utc DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    indicatorKey: r.indicatorKey,
    eventTimeUtc: r.eventTimeUtc,
    actual: r.actual === null ? null : Number(r.actual),
    forecast: r.forecast === null ? null : Number(r.forecast),
    surprise: r.surprise === null ? null : Number(r.surprise),
  }));
}
