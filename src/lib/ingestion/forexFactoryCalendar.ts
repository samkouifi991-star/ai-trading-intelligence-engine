import type { EconomicEvent } from "../types";
import type { CalendarConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";
import { withConnectorHealth, resolveLiveOrFallback } from "./connectorHealth";
import { fetchWithTimeout } from "./fetchWithTimeout";

const SOURCE_KEY = "calendar";

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

// ── Sample-mode fallback (used only when the live feed can't be reached) ──

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
    description: `${spec.event} (${spec.currency}) — sample-mode fixture (live calendar feed unreachable).`,
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

// ── Live connector ──────────────────────────────────────────────────────

/**
 * This IS the Forex Factory Calendar — `ff_calendar_thisweek.json` is Forex
 * Factory's own Weekly Export (JSON/CSV/XML/ICS), served from
 * nfs.faireconomy.media, which Forex Factory itself uses for this export
 * mechanism. It is not a third-party mirror or approximation; every field
 * (event, currency, impact, forecast, previous, actual) is FF's own data.
 * Rows look like: {"title":"Non-Farm Payrolls","country":"USD","date":
 * "2026-09-05T12:30:00-04:00","impact":"High","forecast":"180K",
 * "previous":"175K","actual":"187K"}. Set FOREX_FACTORY_CALENDAR_URL to
 * point at a different (e.g. a licensed Flex Account) export instead — see
 * src/lib/ingestion/README.md.
 */
const DEFAULT_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

/** Values arrive as strings with embedded units: "180K", "3.2%", "-1.5M",
 * "<0.1%", "  " (blank = not yet released), "4.50%-4.75%" (range — takes the
 * midpoint). Returns null rather than guessing when the value is genuinely
 * not a number (e.g. a qualitative/non-economic calendar row). */
export function parseFeedNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "N/A") return null;

  const rangeMatch = trimmed.match(/^(-?[\d.,]+)\s*%?\s*-\s*(-?[\d.,]+)\s*%$/);
  if (rangeMatch) {
    const a = parseFloat(rangeMatch[1].replace(/,/g, ""));
    const b = parseFloat(rangeMatch[2].replace(/,/g, ""));
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  }

  const match = trimmed.replace(/,/g, "").match(/^(<|>)?(-?\d+(?:\.\d+)?)\s*([KMB%]?)$/i);
  if (!match) return null;
  const value = parseFloat(match[2]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[3]?.toUpperCase();
  const multiplier = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
  return value * multiplier;
}

function mapImpact(raw: string): "high" | "medium" | "low" {
  const n = (raw ?? "").toLowerCase();
  if (n.includes("high")) return "high";
  if (n.includes("medium") || n.includes("med")) return "medium";
  return "low";
}

/** Maps one Forex Factory Calendar (Weekly Export) row into our
 * EconomicEvent shape. Exported for unit testing against a realistic
 * fixture (see scripts/run-tests.ts) — this parser cannot be exercised
 * against the real live endpoint from inside a network-restricted
 * environment, so its correctness is verified against a hand-built fixture
 * matching the feed's documented/observed schema instead. */
export function mapFairEconomyRow(row: any): EconomicEvent | null {
  const title = row.title ?? row.event;
  const country = row.country ?? row.currency;
  const date = row.date ?? row.eventTimeUtc;
  if (!title || !country || !date) return null;

  const eventTimeUtc = new Date(date).toISOString();
  if (Number.isNaN(new Date(eventTimeUtc).getTime())) return null;

  return {
    id: `ff-${country}-${String(title).replace(/\s+/g, "-")}-${eventTimeUtc}`,
    event: String(title),
    currency: String(country).toUpperCase(),
    eventTimeUtc,
    impact: mapImpact(row.impact ?? ""),
    actual: parseFeedNumber(row.actual),
    forecast: parseFeedNumber(row.forecast),
    previous: parseFeedNumber(row.previous),
    revisedPrevious: null, // this feed does not carry a separate revised-previous field
    source: "Forex Factory Calendar",
    description: `${title} (${country})`,
  };
}

async function fetchFairEconomyCalendar(url: string): Promise<EconomicEvent[]> {
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json" }, cache: "no-store" }, 8000);
  if (!res.ok) throw new Error(`Calendar feed HTTP ${res.status}`);
  const rows = (await res.json()) as any[];
  if (!Array.isArray(rows)) throw new Error("Calendar feed did not return an array");
  return rows.map(mapFairEconomyRow).filter((e): e is EconomicEvent => e !== null);
}

class LiveCalendarConnector implements CalendarConnector {
  constructor(private readonly url: string) {}

  async fetchUpcoming(hoursAhead = 48): Promise<EconomicEvent[]> {
    const all = await this.fetchAll();
    const now = Date.now();
    return all.filter((e) => {
      const t = new Date(e.eventTimeUtc).getTime();
      return t >= now && t <= now + hoursAhead * 3600_000;
    });
  }

  async fetchRecent(hoursBack = 24): Promise<EconomicEvent[]> {
    const all = await this.fetchAll();
    const now = Date.now();
    return all.filter((e) => {
      const t = new Date(e.eventTimeUtc).getTime();
      return t <= now && t >= now - hoursBack * 3600_000;
    });
  }

  private async fetchAll(): Promise<EconomicEvent[]> {
    return withConnectorHealth(SOURCE_KEY, async () => {
      const events = await fetchFairEconomyCalendar(this.url);
      if (events.length === 0) {
        return { data: events, partial: "Feed reachable but returned zero parseable rows" };
      }
      return { data: events };
    });
  }
}

/**
 * Always attempts the real live calendar first (no API key required — the
 * feed is public). Only falls back to sample data if the live fetch fails
 * (e.g. network egress blocked, feed schema changed) — connectorHealth
 * records exactly which happened so the Live Data Status page never shows
 * "live" for data that was actually a fallback.
 */
class SmartCalendarConnector implements CalendarConnector {
  private live: LiveCalendarConnector;
  private sample = new SampleCalendarConnector();

  constructor(url: string) {
    this.live = new LiveCalendarConnector(url);
  }

  async fetchUpcoming(hoursAhead = 48): Promise<EconomicEvent[]> {
    return resolveLiveOrFallback(
      "calendar",
      () => this.live.fetchUpcoming(hoursAhead),
      () => this.sample.fetchUpcoming(hoursAhead)
    );
  }

  async fetchRecent(hoursBack = 24): Promise<EconomicEvent[]> {
    return resolveLiveOrFallback(
      "calendar",
      () => this.live.fetchRecent(hoursBack),
      () => this.sample.fetchRecent(hoursBack)
    );
  }
}

export function getCalendarConnector(): { connector: CalendarConnector; mode: "live" } {
  const url = process.env.FOREX_FACTORY_CALENDAR_URL || DEFAULT_CALENDAR_URL;
  // "mode" here just reflects that a live attempt is always made; the *actual*
  // outcome of the most recent attempt is in connectorHealth, not this flag.
  return { connector: new SmartCalendarConnector(url), mode: "live" };
}
