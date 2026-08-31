import {
  getRecentStories,
  saveEventClockSnapshot,
  getEventClockForStory,
  getCapturedCheckpointSymbols,
} from "../db/repository";
import { getMarketDataConnector, getReferencePrice, type RefKey } from "../ingestion/marketData";
import { getInstrument } from "../universe";
import type { NewsStory } from "../types";

/**
 * Per-story multi-market price snapshots at fixed offsets from the story's
 * first-seen time (t0). Captured opportunistically at whatever cadence the
 * pipeline actually ticks (see orchestrator.ts) — a checkpoint's price is
 * whatever the live feed shows the first time a tick lands on or after that
 * offset, not a precisely-timed sample.
 *
 * IMPORTANT SCOPE NOTE: T-5m/T-1m (pre-event) checkpoints are meaningful
 * only for a *scheduled* catalyst (e.g. a calendar release with a known
 * eventTimeUtc) where "before" has a defined moment to capture. A breaking-
 * news story's t0 IS the moment we first learned about it — there is no
 * "before" to snapshot. This implementation only captures T0 through
 * T+60m for that reason; wiring pre-event capture for calendar-linked
 * stories (matching a story to its triggering economic_events row) is a
 * documented extension, not implemented here.
 *
 * IMPORTANT CADENCE NOTE: T+15s/T+30s genuinely need sub-minute ticking to
 * be captured close to their target offset. This app's orchestrator tick
 * (driven by an external scheduler — see README's "Scheduling" section) is
 * realistically every few minutes on typical serverless cron platforms
 * (Vercel Cron's minimum granularity is 1 minute). On that cadence, T+15s/
 * T+30s will actually be captured whenever the next tick happens to land,
 * with the REAL elapsed time recorded in captured_at_utc — never mislabeled
 * as if it were captured exactly on time. For true sub-minute fidelity, run
 * a faster poller (a persistent process hitting /api/eventclock/tick every
 * few seconds) — the capture function is cheap and idempotent per
 * checkpoint, so calling it more often than needed is harmless.
 */
const CHECKPOINTS: { label: string; offsetSeconds: number }[] = [
  { label: "T0", offsetSeconds: 0 },
  { label: "T+15s", offsetSeconds: 15 },
  { label: "T+30s", offsetSeconds: 30 },
  { label: "T+1m", offsetSeconds: 60 },
  { label: "T+2m", offsetSeconds: 120 },
  { label: "T+5m", offsetSeconds: 300 },
  { label: "T+15m", offsetSeconds: 900 },
  { label: "T+30m", offsetSeconds: 1800 },
  { label: "T+60m", offsetSeconds: 3600 },
];

const TRACKING_WINDOW_SECONDS = 3600 + 300; // stop tracking 5 min after the last checkpoint is due
const MIN_SEVERITY_TO_TRACK = 60;
const REF_KEYS: RefKey[] = ["DXY", "US2Y_PROXY", "US10Y_PROXY"];

export interface EventClockTickResult {
  storiesTracked: number;
  snapshotsRecorded: number;
  errors: string[];
}

export async function captureEventClockTicks(now: Date = new Date()): Promise<EventClockTickResult> {
  const stories = getRecentStories(30).filter(
    (s) => s.latestAnalysis.severity >= MIN_SEVERITY_TO_TRACK && secondsSince(s.firstSeenUtc, now) <= TRACKING_WINDOW_SECONDS
  );

  const { connector } = getMarketDataConnector();
  const errors: string[] = [];
  let snapshotsRecorded = 0;

  for (const story of stories) {
    const elapsedSeconds = secondsSince(story.firstSeenUtc, now);
    const dueLabels = CHECKPOINTS.filter((cp) => cp.offsetSeconds <= elapsedSeconds).map((cp) => cp.label);
    if (dueLabels.length === 0) continue;

    const already = getCapturedCheckpointSymbols(story.storyId);
    const symbols = watchlistSymbolsForStory(story);

    for (const label of dueLabels) {
      for (const symbol of symbols) {
        if (already.has(`${label}:${symbol}`)) continue;
        try {
          const price = await fetchPrice(symbol, connector);
          saveEventClockSnapshot({ storyId: story.storyId, t0Utc: story.firstSeenUtc, checkpoint: label, symbol, price });
          snapshotsRecorded++;
        } catch (err) {
          errors.push(`${story.storyId} ${label} ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  return { storiesTracked: stories.length, snapshotsRecorded, errors };
}

function secondsSince(isoTime: string, now: Date): number {
  return (now.getTime() - new Date(isoTime).getTime()) / 1000;
}

function watchlistSymbolsForStory(story: NewsStory): string[] {
  const tradableImpacts = story.latestAnalysis.expectedAssetImpact
    .filter((i) => getInstrument(i.symbol) && Math.abs(i.score) >= 10)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 3)
    .map((i) => i.symbol);
  return [...new Set([...tradableImpacts, ...REF_KEYS])];
}

async function fetchPrice(symbol: string, connector: { getSnapshot(s: string): Promise<{ last: number }> }): Promise<number> {
  if ((REF_KEYS as string[]).includes(symbol)) return getReferencePrice(symbol as RefKey);
  const snapshot = await connector.getSnapshot(symbol);
  return snapshot.last;
}

// ── Prediction vs. confirmation report (spec rule 8) ───────────────────────

export interface EventClockReactionReport {
  storyId: string;
  t0Utc: string;
  headline: string;
  predicted: { symbol: string; newsImpactScore: number }[];
  actual: { symbol: string; checkpoint: string; pctChangeSinceT0: number }[];
  confirmations: { symbol: string; predicted: number; actualPctChange: number; confirmed: boolean }[];
}

/** Builds the "NEWS IMPACT vs MARKET CONFIRMATION" report for one story by
 * comparing its predicted signed asset-impact scores against the actual
 * measured %-price-change from T0 to the latest captured checkpoint. This
 * is a read-only report over already-captured event_clock rows — it does
 * not fetch anything live itself. */
export function buildReactionReport(story: NewsStory): EventClockReactionReport {
  const rows = getEventClockForStory(story.storyId);
  const bySymbol = new Map<string, { checkpoint: string; price: number }[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push({ checkpoint: r.checkpoint, price: r.price });
    bySymbol.set(r.symbol, list);
  }

  const predicted = story.latestAnalysis.expectedAssetImpact
    .filter((i) => bySymbol.has(i.symbol))
    .map((i) => ({ symbol: i.symbol, newsImpactScore: i.score }));

  const actual: EventClockReactionReport["actual"] = [];
  const confirmations: EventClockReactionReport["confirmations"] = [];

  for (const [symbol, points] of bySymbol) {
    const t0Point = points.find((p) => p.checkpoint === "T0");
    if (!t0Point) continue;
    const latest = points[points.length - 1];
    const pctChange = t0Point.price !== 0 ? ((latest.price - t0Point.price) / t0Point.price) * 100 : 0;
    actual.push({ symbol, checkpoint: latest.checkpoint, pctChangeSinceT0: Math.round(pctChange * 1000) / 1000 });

    const predictedForSymbol = predicted.find((p) => p.symbol === symbol);
    if (predictedForSymbol) {
      const sameSign = Math.sign(predictedForSymbol.newsImpactScore) === Math.sign(pctChange);
      confirmations.push({
        symbol,
        predicted: predictedForSymbol.newsImpactScore,
        actualPctChange: Math.round(pctChange * 1000) / 1000,
        confirmed: sameSign && Math.abs(pctChange) > 0.02, // require a non-trivial move in the predicted direction
      });
    }
  }

  return { storyId: story.storyId, t0Utc: story.firstSeenUtc, headline: story.latestAnalysis.headline, predicted, actual, confirmations };
}
