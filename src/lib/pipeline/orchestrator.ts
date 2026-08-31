import { ingestEconomicCalendar } from "./economicPipeline";
import { ingestAndAnalyzeNews } from "./newsPipeline";
import { pollGmailForexFactoryAlerts } from "./gmailPipeline";
import { runDayEngine } from "./dayEngine";
import { runSwingEngine } from "./swingEngine";
import { trackReactions } from "./reactionTracking";
import { captureEventClockTicks } from "./eventClock";
import { getDaySessionPhase } from "../time/session";

/**
 * Full tick: ingest calendar + breaking news, then re-run both engines so
 * their stored signals/dashboards reflect the latest state. Intended to be
 * invoked by an external scheduler (see app/api/cron/tick) roughly every few
 * minutes — Next.js on most hosts has no built-in always-on process, so
 * real-world scheduling is the caller's job (Vercel Cron, cron-job.org,
 * etc.).
 *
 * The day engine runs on every tick regardless of session phase — before
 * 10:00 ET this keeps the regime/catalyst read warm ("system should begin
 * collecting and analyzing market information before 10:00 AM"); the
 * session-window gate itself lives in signals/validation.ts and simply
 * downgrades any would-be TRADE to WATCH outside 10:00-13:00 ET.
 */
export async function runFullPipeline(now: Date = new Date()) {
  // Each ingestion step is isolated: in production mode a blocked source
  // throws DataUnavailableError (spec rule 5) rather than substituting sample
  // data, but ONE blocked source (say, the calendar) must not crash the
  // whole tick — the day/swing engines still run against whatever data is
  // actually available, and their own per-instrument data-quality gate is
  // what turns "calendar blocked" into a NO_TRADE/WATCH reason, not an
  // unhandled 500.
  const [calendar, news, gmail] = await Promise.all([
    safeIngest("calendar", () => ingestEconomicCalendar(), { mode: "live" as const, recentCount: 0, upcomingCount: 0 }),
    safeIngest("news", () => ingestAndAnalyzeNews(), { mode: "live" as const, headlinesSeen: 0, newStories: 0, incrementalUpdates: 0, repeatConfirmations: 0 }),
    pollGmailForexFactoryAlerts(), // never throws — already isolates its own failures
  ]);

  const [day, swing] = await Promise.all([runDayEngine(now), runSwingEngine(now)]);
  const [reactions, eventClock] = await Promise.all([trackReactions(now), captureEventClockTicks(now)]);

  return {
    tickAtUtc: now.toISOString(),
    daySessionPhase: getDaySessionPhase(now),
    calendar,
    news,
    gmail,
    day,
    swing,
    reactions,
    eventClock,
  };
}

async function safeIngest<T extends object>(label: string, fn: () => Promise<T>, fallback: T): Promise<T & { error?: string }> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runFullPipeline] ${label} ingestion failed:`, message);
    return { ...fallback, error: message };
  }
}
