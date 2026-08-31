import { getAllOpenLearningRecordsForReaction, recordFollowUpPrice, updateExcursions } from "../db/repository";
import { getMarketDataConnector } from "../ingestion/marketData";
import type { Direction } from "../types";

const CHECKPOINTS: { key: "1m" | "5m" | "15m" | "30m" | "60m" | "4h" | "1d"; minutes: number; column: string }[] = [
  { key: "1m", minutes: 1, column: "priceAfter1m" },
  { key: "5m", minutes: 5, column: "priceAfter5m" },
  { key: "15m", minutes: 15, column: "priceAfter15m" },
  { key: "30m", minutes: 30, column: "priceAfter30m" },
  { key: "60m", minutes: 60, column: "priceAfter60m" },
  { key: "4h", minutes: 240, column: "priceAfter4h" },
  { key: "1d", minutes: 1440, column: "priceAfter1d" },
];

export interface ReactionTrackingResult {
  openRecords: number;
  pricesRecorded: number;
  instrumentsPolled: number;
  errors: string[];
}

/**
 * Implements "record every analyzed event and its subsequent market
 * reaction": for every learning-database row still missing its 1-day
 * follow-up price, checks which time checkpoints have been crossed since
 * the record's event, fetches the current live price once per instrument
 * per tick, fills in whichever checkpoint columns just became due, and
 * updates running maximum favorable/adverse excursion every tick. This is
 * necessarily sampled at tick cadence (see orchestrator.ts) rather than
 * continuous tick-by-tick, since nothing in this deployment model runs an
 * always-on process between HTTP invocations.
 */
export async function trackReactions(now: Date = new Date()): Promise<ReactionTrackingResult> {
  const openRecords = getAllOpenLearningRecordsForReaction(30);
  const { connector } = getMarketDataConnector();
  const errors: string[] = [];

  const byInstrument = new Map<string, typeof openRecords>();
  for (const r of openRecords) {
    if (r.priceAtEvent === null) continue; // nothing to compare against
    const list = byInstrument.get(r.predictedInstrument) ?? [];
    list.push(r);
    byInstrument.set(r.predictedInstrument, list);
  }

  let pricesRecorded = 0;

  for (const [instrument, records] of byInstrument) {
    let currentPrice: number;
    try {
      const snapshot = await connector.getSnapshot(instrument);
      currentPrice = snapshot.last;
    } catch (err) {
      errors.push(`${instrument}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const record of records) {
      const elapsedMinutes = (now.getTime() - new Date(record.eventTimestampUtc).getTime()) / 60_000;

      for (const cp of CHECKPOINTS) {
        const already = (record as any)[cp.column] !== null;
        if (!already && elapsedMinutes >= cp.minutes) {
          recordFollowUpPrice(record.id, cp.key, currentPrice);
          pricesRecorded++;
        }
      }

      updateRunningExcursion(record.id, record.predictedDirection, record.priceAtEvent as number, currentPrice, record.maxFavorableExcursion, record.maxAdverseExcursion);
    }
  }

  return { openRecords: openRecords.length, pricesRecorded, instrumentsPolled: byInstrument.size, errors };
}

function updateRunningExcursion(
  recordId: string,
  direction: Direction,
  priceAtEvent: number,
  currentPrice: number,
  priorMfe: number | null,
  priorMae: number | null
): void {
  const delta = direction === "LONG" ? currentPrice - priceAtEvent : priceAtEvent - currentPrice;
  const favorableCandidate = Math.max(0, delta);
  const adverseCandidate = Math.max(0, -delta);
  const mfe = Math.max(priorMfe ?? 0, favorableCandidate);
  const mae = Math.max(priorMae ?? 0, adverseCandidate);
  if (mfe !== (priorMfe ?? 0) || mae !== (priorMae ?? 0)) {
    updateExcursions(recordId, mfe, mae);
  }
}
