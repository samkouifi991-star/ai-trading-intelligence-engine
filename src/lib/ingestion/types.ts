import type { EconomicEvent, MacroSnapshot, MarketSnapshot, RawHeadline } from "../types";

/** Structured Forex Factory economic-calendar source. Real implementations
 * (a licensed calendar feed, or your own scraper service normalizing FF's
 * calendar into this shape) must be swapped in behind this interface —
 * nothing downstream cares where the rows came from. */
export interface CalendarConnector {
  fetchUpcoming(hoursAhead?: number): Promise<EconomicEvent[]>;
  fetchRecent(hoursBack?: number): Promise<EconomicEvent[]>;
}

/** Forex Factory breaking-news wire. */
export interface NewsConnector {
  fetchLatest(sinceUtc?: string): Promise<RawHeadline[]>;
}

/** Live/near-live market data: price bars + macro reference series. */
export interface MarketDataConnector {
  getSnapshot(symbol: string): Promise<MarketSnapshot>;
  getMacroSnapshot(): Promise<MacroSnapshot>;
}

/** Result of parsing one inbound Forex Factory email alert into the same
 * RawHeadline shape the breaking-news poller produces, so both feed the same
 * news-analysis pipeline. */
export function emailToHeadline(input: {
  subject: string;
  bodyText: string;
  receivedUtc: string;
  messageId: string;
}): RawHeadline {
  return {
    id: `ff-email-${input.messageId}`,
    timestampUtc: input.receivedUtc,
    headline: input.subject.replace(/^\s*\[?forex\s*factory\]?\s*[:\-]?\s*/i, "").trim(),
    body: input.bodyText,
    source: "Forex Factory Email Alert",
    sourceQuality: 90,
    contentType: "verified_news",
  };
}
