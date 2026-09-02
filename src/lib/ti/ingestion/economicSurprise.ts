import { getEventsInRange } from "../db/economicEvents";
import { getLatestSurpriseComputedAt } from "../db/economicSurprises";
import { scoreEconomicSurprise } from "../scoring/surpriseEngine";

const RESCORE_COOLDOWN_MS = 6 * 3600_000; // don't recompute an unchanged release more than once per 6h

/**
 * Scores every recently-released economic event that hasn't been scored
 * (or was last scored more than RESCORE_COOLDOWN_MS ago, in case a revision
 * came in) — this bounds Postgres writes to real new information instead of
 * recomputing identical scores every cron tick (egress-conscious by
 * design, not just by accident).
 */
export async function scoreRecentReleases(hoursBack = 48, regimeSummary: string | null = null): Promise<{ scored: number; skipped: number }> {
  const now = new Date();
  const events = (
    await getEventsInRange(new Date(now.getTime() - hoursBack * 3600_000).toISOString(), now.toISOString())
  ).filter((e) => e.actual !== null);

  let scored = 0;
  let skipped = 0;
  for (const event of events) {
    const lastComputed = await getLatestSurpriseComputedAt(event.id);
    if (lastComputed && now.getTime() - lastComputed.getTime() < RESCORE_COOLDOWN_MS) {
      skipped++;
      continue;
    }
    await scoreEconomicSurprise(event, regimeSummary);
    scored++;
  }
  return { scored, skipped };
}
