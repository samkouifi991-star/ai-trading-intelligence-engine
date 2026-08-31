import { getCalendarConnector } from "../ingestion/forexFactoryCalendar";
import { saveEconomicEvent } from "../db/repository";

export async function ingestEconomicCalendar(): Promise<{
  mode: "live";
  recentCount: number;
  upcomingCount: number;
}> {
  const { connector, mode } = getCalendarConnector();
  const [recent, upcoming] = await Promise.all([
    connector.fetchRecent(24),
    connector.fetchUpcoming(48),
  ]);
  for (const e of [...recent, ...upcoming]) saveEconomicEvent(e);
  return { mode, recentCount: recent.length, upcomingCount: upcoming.length };
}

const INSTRUMENT_CURRENCIES: Record<string, string[]> = {
  XAUUSD: ["USD"],
  ES: ["USD"],
  NQ: ["USD"],
  WTI: ["USD"],
  EURUSD: ["EUR", "USD"],
  GBPUSD: ["GBP", "USD"],
  USDJPY: ["USD", "JPY"],
  USDCAD: ["USD", "CAD"],
  AUDUSD: ["AUD", "USD"],
};

export function relevantCurrenciesForInstrument(symbol: string): string[] {
  return INSTRUMENT_CURRENCIES[symbol] ?? ["USD"];
}
