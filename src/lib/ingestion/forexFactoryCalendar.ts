import type { EconomicEvent } from "../types";
import type { CalendarConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";

/** Reference indicators with their typical statistical shape, used both to
 * generate believable sample-mode calendar rows and as the seed catalog the
 * economic-surprise engine's historical-distribution builder bootstraps from
 * when no real history exists yet. */
export const INDICATOR_CATALOG: {
  event: string;
  currency: string;
  impact: "high" | "medium" | "low";
  typicalForecast: number;
  typicalStdDev: number;
  unit: string;
}[] = [
  { event: "CPI m/m", currency: "USD", impact: "high", typicalForecast: 0.3, typicalStdDev: 0.15, unit: "%" },
  { event: "Core CPI m/m", currency: "USD", impact: "high", typicalForecast: 0.3, typicalStdDev: 0.12, unit: "%" },
  { event: "Non-Farm Payrolls", currency: "USD", impact: "high", typicalForecast: 180, typicalStdDev: 60, unit: "k" },
  { event: "Unemployment Rate", currency: "USD", impact: "high", typicalForecast: 4.0, typicalStdDev: 0.15, unit: "%" },
  { event: "Retail Sales m/m", currency: "USD", impact: "medium", typicalForecast: 0.4, typicalStdDev: 0.3, unit: "%" },
  { event: "ISM Manufacturing PMI", currency: "USD", impact: "high", typicalForecast: 49.5, typicalStdDev: 1.5, unit: "" },
  { event: "FOMC Rate Decision", currency: "USD", impact: "high", typicalForecast: 5.25, typicalStdDev: 0.1, unit: "%" },
  { event: "PPI m/m", currency: "USD", impact: "medium", typicalForecast: 0.2, typicalStdDev: 0.15, unit: "%" },
  { event: "GDP q/q Annualized", currency: "USD", impact: "high", typicalForecast: 2.2, typicalStdDev: 0.6, unit: "%" },
  { event: "Initial Jobless Claims", currency: "USD", impact: "medium", typicalForecast: 220, typicalStdDev: 15, unit: "k" },
  { event: "ECB Rate Decision", currency: "EUR", impact: "high", typicalForecast: 4.0, typicalStdDev: 0.1, unit: "%" },
  { event: "German ZEW Economic Sentiment", currency: "EUR", impact: "medium", typicalForecast: 15, typicalStdDev: 6, unit: "" },
  { event: "BOE Rate Decision", currency: "GBP", impact: "high", typicalForecast: 5.0, typicalStdDev: 0.1, unit: "%" },
  { event: "UK CPI y/y", currency: "GBP", impact: "high", typicalForecast: 3.2, typicalStdDev: 0.3, unit: "%" },
  { event: "BOJ Rate Decision", currency: "JPY", impact: "high", typicalForecast: 0.25, typicalStdDev: 0.05, unit: "%" },
  { event: "Tokyo CPI y/y", currency: "JPY", impact: "medium", typicalForecast: 2.3, typicalStdDev: 0.3, unit: "%" },
  { event: "BOC Rate Decision", currency: "CAD", impact: "high", typicalForecast: 4.5, typicalStdDev: 0.1, unit: "%" },
  { event: "Canada Employment Change", currency: "CAD", impact: "high", typicalForecast: 25, typicalStdDev: 20, unit: "k" },
  { event: "RBA Rate Decision", currency: "AUD", impact: "high", typicalForecast: 4.35, typicalStdDev: 0.1, unit: "%" },
  { event: "Australia Employment Change", currency: "AUD", impact: "medium", typicalForecast: 25, typicalStdDev: 18, unit: "k" },
  { event: "EIA Crude Oil Inventories", currency: "USD", impact: "medium", typicalForecast: -1.5, typicalStdDev: 2.5, unit: "M bbl" },
];

/** Higher-value-is-hawkish/inflationary vs. dovish/growth-negative direction
 * table used by the surprise engine's directional interpretation. */
export function indicatorPolarity(eventName: string): "higher_hawkish" | "higher_dovish" | "context_dependent" {
  const n = eventName.toLowerCase();
  if (n.includes("unemployment") || n.includes("jobless claims")) return "higher_dovish";
  if (n.includes("cpi") || n.includes("ppi") || n.includes("payroll") || n.includes("gdp") || n.includes("pmi") || n.includes("employment change"))
    return "higher_hawkish";
  if (n.includes("retail sales")) return "context_dependent"; // growth-positive but regime-dependent for rate path
  if (n.includes("rate decision")) return "higher_hawkish";
  return "context_dependent";
}

function gaussian(rand: () => number, mean: number, stdDev: number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

function sampleEventAt(hoursOffset: number): EconomicEvent {
  const now = Date.now();
  const eventTime = new Date(now + hoursOffset * 3600_000);
  const bucket = Math.floor(eventTime.getTime() / 3_600_000);
  const catalogIndex = Math.abs(hashString(`cal:${bucket}`)) % INDICATOR_CATALOG.length;
  const spec = INDICATOR_CATALOG[catalogIndex];
  const rand = mulberry32(hashString(`cal:${bucket}:${spec.event}`));

  const previous = round(gaussian(rand, spec.typicalForecast, spec.typicalStdDev), spec.unit);
  const forecast = round(previous + gaussian(rand, 0, spec.typicalStdDev * 0.4), spec.unit);
  const isPast = hoursOffset <= 0;
  const actual = isPast ? round(forecast + gaussian(rand, 0, spec.typicalStdDev), spec.unit) : null;
  const revisedPrevious = isPast && rand() > 0.6 ? round(previous + gaussian(rand, 0, spec.typicalStdDev * 0.3), spec.unit) : null;

  return {
    id: `sample-${spec.currency}-${spec.event.replace(/\s+/g, "-")}-${eventTime.toISOString()}`,
    event: spec.event,
    currency: spec.currency,
    eventTimeUtc: eventTime.toISOString(),
    impact: spec.impact,
    actual,
    forecast,
    previous,
    revisedPrevious,
    source: "sample-fixture",
    description: `${spec.event} (${spec.currency}) — sample-mode fixture. Configure FOREX_FACTORY_CALENDAR_URL for a live structured feed.`,
  };
}

function round(n: number, unit: string): number {
  const decimals = unit === "%" ? 2 : unit === "k" || unit === "M bbl" ? 0 : 2;
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

class SampleCalendarConnector implements CalendarConnector {
  async fetchUpcoming(hoursAhead = 24): Promise<EconomicEvent[]> {
    const events: EconomicEvent[] = [];
    for (let h = 1; h <= hoursAhead; h += 3) events.push(sampleEventAt(h));
    return events.sort((a, b) => a.eventTimeUtc.localeCompare(b.eventTimeUtc));
  }

  async fetchRecent(hoursBack = 24): Promise<EconomicEvent[]> {
    const events: EconomicEvent[] = [];
    for (let h = -hoursBack; h <= 0; h += 3) events.push(sampleEventAt(h));
    return events.sort((a, b) => a.eventTimeUtc.localeCompare(b.eventTimeUtc));
  }
}

/** Live connector: expects FOREX_FACTORY_CALENDAR_URL to serve JSON rows
 * already shaped like EconomicEvent (or close to it — adjust the mapping
 * below to match your feed's actual schema). */
class LiveCalendarConnector implements CalendarConnector {
  constructor(private readonly baseUrl: string) {}

  async fetchUpcoming(hoursAhead = 24): Promise<EconomicEvent[]> {
    return this.fetch(`${this.baseUrl}?window=upcoming&hours=${hoursAhead}`);
  }

  async fetchRecent(hoursBack = 24): Promise<EconomicEvent[]> {
    return this.fetch(`${this.baseUrl}?window=recent&hours=${hoursBack}`);
  }

  private async fetch(url: string): Promise<EconomicEvent[]> {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Calendar feed error ${res.status}: ${await res.text()}`);
    }
    const rows = (await res.json()) as any[];
    return rows.map(mapRowToEvent);
  }
}

function mapRowToEvent(row: any): EconomicEvent {
  return {
    id: row.id ?? `${row.currency}-${row.event}-${row.eventTimeUtc ?? row.date}`,
    event: row.event ?? row.title,
    currency: row.currency,
    eventTimeUtc: row.eventTimeUtc ?? row.date,
    impact: (row.impact ?? "medium").toLowerCase(),
    actual: row.actual ?? null,
    forecast: row.forecast ?? null,
    previous: row.previous ?? null,
    revisedPrevious: row.revisedPrevious ?? row.revised_previous ?? null,
    source: row.source ?? "forex-factory-live",
    description: row.description ?? row.event ?? "",
  };
}

export function getCalendarConnector(): { connector: CalendarConnector; mode: "live" | "sample" } {
  const url = process.env.FOREX_FACTORY_CALENDAR_URL;
  if (url) return { connector: new LiveCalendarConnector(url), mode: "live" };
  return { connector: new SampleCalendarConnector(), mode: "sample" };
}
