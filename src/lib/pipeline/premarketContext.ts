import { getRecentStories, getEventsInRange, savePremarketSnapshot, getLatestPremarketSnapshot } from "../db/repository";
import { getCurrentRegime } from "./regimePipeline";
import { decayedSeverity } from "../news/decay";
import { nyDateKey, minutesSincePremarketTarget } from "../time/session";
import type { MacroRegime, NewsStory } from "../types";

export interface PremarketContext {
  tradingDay: string;
  regime: MacroRegime;
  overnightStories: { headline: string; severity: number; eventType: string; riskImpact: string; originalSource: string }[];
  todaysCalendar: { event: string; currency: string; impact: string; eventTimeUtc: string; source: string }[];
}

/**
 * Captures the "complete daily market regime" the spec requires to be ready
 * before the day engine's 10:00 ET issue window opens — meant to be called
 * once by an external scheduler around 09:45 ET (see app/api/premarket/
 * capture), so the system demonstrably "began collecting and analyzing
 * market information before 10:00 AM" rather than starting cold at 10:00.
 */
export async function capturePremarketContext(now: Date = new Date()): Promise<PremarketContext> {
  const { regime } = await getCurrentRegime();

  const stories = getRecentStories(60).filter(
    (s) => (s.tradingHorizon === "day" || s.tradingHorizon === "both") && decayedSeverity(s, "day", now) >= 5
  );
  const overnightStories = [...stories]
    .sort((a, b) => decayedSeverity(b, "day", now) - decayedSeverity(a, "day", now))
    .slice(0, 10)
    .map(summarizeStory);

  const todaysCalendar = getEventsInRange(now.toISOString(), endOfNyDayUtc(now))
    .filter((e) => e.impact === "high" || e.impact === "medium")
    .map((e) => ({ event: e.event, currency: e.currency, impact: e.impact, eventTimeUtc: e.eventTimeUtc, source: e.source }));

  const context: PremarketContext = { tradingDay: nyDateKey(now), regime, overnightStories, todaysCalendar };
  savePremarketSnapshot(context.tradingDay, context);
  return context;
}

function summarizeStory(s: NewsStory) {
  return {
    headline: s.latestAnalysis.headline,
    severity: s.latestAnalysis.severity,
    eventType: s.latestAnalysis.eventType,
    riskImpact: s.latestAnalysis.riskImpact,
    originalSource: s.latestAnalysis.originalSource,
  };
}

function endOfNyDayUtc(now: Date): string {
  // Rough end-of-trading-day bound (24h ahead is a safe superset; the
  // dashboard filters further). Precision here doesn't matter much since
  // this only bounds the calendar query window.
  return new Date(now.getTime() + 24 * 3600_000).toISOString();
}

export type PremarketFreshness = "fresh" | "stale" | "missing";

export function getLatestPremarketContext(now: Date = new Date()): {
  freshness: PremarketFreshness;
  capturedAtUtc: string | null;
  context: PremarketContext | null;
} {
  const today = nyDateKey(now);
  const latest = getLatestPremarketSnapshot(today);
  if (!latest) return { freshness: "missing", capturedAtUtc: null, context: null };

  // "fresh" = captured today and we're within a couple hours of the 09:45
  // ET target (covers a scheduler that's a little early/late, or a manual
  // capture during prep); otherwise it's still today's snapshot but stale.
  const minutesFromTarget = Math.abs(minutesSincePremarketTarget(new Date(latest.capturedAtUtc)));
  const freshness: PremarketFreshness = minutesFromTarget <= 120 ? "fresh" : "stale";
  return { freshness, capturedAtUtc: latest.capturedAtUtc, context: latest.payload as PremarketContext };
}
