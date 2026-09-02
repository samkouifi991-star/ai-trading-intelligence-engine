import { fetchFairEconomyCalendar, DEFAULT_CALENDAR_URL, SampleCalendarConnector } from "../../ingestion/forexFactoryCalendar";
import { withSourceHealth, resolveLiveOrSample } from "../db/dataSources";
import { upsertEconomicEvent } from "../db/economicEvents";
import type { EconomicEvent } from "../../types";

const SOURCE_KEY = "calendar";
const sampleConnector = new SampleCalendarConnector();

async function fetchLive(hoursAhead: number, hoursBack: number): Promise<EconomicEvent[]> {
  return withSourceHealth(SOURCE_KEY, async () => {
    const url = process.env.FOREX_FACTORY_CALENDAR_URL || DEFAULT_CALENDAR_URL;
    const all = await fetchFairEconomyCalendar(url);
    if (all.length === 0) {
      return { data: all, partial: "Feed reachable but returned zero parseable rows" };
    }
    const now = Date.now();
    const windowed = all.filter((e) => {
      const t = new Date(e.eventTimeUtc).getTime();
      return t >= now - hoursBack * 3_600_000 && t <= now + hoursAhead * 3_600_000;
    });
    return { data: windowed };
  });
}

/**
 * One ingestion tick: fetches the Forex Factory Calendar (live, keyless —
 * same real source as the Day/Swing engine's calendar connector), falls
 * back to sample data only in development mode when the live fetch fails,
 * and stores every event in Postgres (trading_intel.economic_events +
 * indicator_history for the surprise engine's historical distributions).
 * Returns how many events were ingested, for the caller's ingestion log.
 */
export async function ingestCalendar(hoursAhead = 72, hoursBack = 48): Promise<{ count: number }> {
  const events = await resolveLiveOrSample(
    SOURCE_KEY,
    () => fetchLive(hoursAhead, hoursBack),
    async () => {
      const [upcoming, recent] = await Promise.all([
        sampleConnector.fetchUpcoming(hoursAhead),
        sampleConnector.fetchRecent(hoursBack),
      ]);
      return [...upcoming, ...recent];
    }
  );
  for (const event of events) {
    await upsertEconomicEvent(event);
  }
  return { count: events.length };
}
