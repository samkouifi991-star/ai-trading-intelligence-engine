import { ingestEconomicCalendar } from "./economicPipeline";
import { ingestAndAnalyzeNews } from "./newsPipeline";
import { pollGmailForexFactoryAlerts } from "./gmailPipeline";
import { runDayEngine } from "./dayEngine";
import { runSwingEngine } from "./swingEngine";
import { trackReactions } from "./reactionTracking";
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
  const [calendar, news, gmail] = await Promise.all([
    ingestEconomicCalendar(),
    ingestAndAnalyzeNews(),
    pollGmailForexFactoryAlerts(),
  ]);

  const [day, swing] = await Promise.all([runDayEngine(now), runSwingEngine(now)]);
  const reactions = await trackReactions(now);

  return {
    tickAtUtc: now.toISOString(),
    daySessionPhase: getDaySessionPhase(now),
    calendar,
    news,
    gmail,
    day,
    swing,
    reactions,
  };
}
