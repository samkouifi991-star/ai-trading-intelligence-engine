import type { TradeSignal } from "../types";
import { getInstrument } from "../universe";

export interface RankedOpportunity {
  rank: number;
  signal: TradeSignal;
}

export interface SuppressedOpportunity {
  signal: TradeSignal;
  reason: string;
}

/**
 * Ranks candidate signals by confidence and suppresses instruments that are
 * highly correlated with a higher-ranked pick, so the output is "the
 * cleanest expression of the catalyst" rather than a pile of near-duplicate
 * correlated positions (e.g. both ES and NQ shorts for the same risk-off
 * catalyst — only the stronger of the two survives).
 */
export function rankOpportunities(candidates: TradeSignal[]): {
  ranked: RankedOpportunity[];
  suppressed: SuppressedOpportunity[];
} {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const accepted: TradeSignal[] = [];
  const ranked: RankedOpportunity[] = [];
  const suppressed: SuppressedOpportunity[] = [];

  for (const candidate of sorted) {
    const blocker = accepted.find((a) => isCorrelated(a.instrument, candidate.instrument));
    if (blocker) {
      suppressed.push({
        signal: candidate,
        reason: `Correlated with higher-ranked ${blocker.instrument} (${blocker.direction}, confidence ${blocker.confidence}) — suppressed to avoid flooding with duplicate exposure.`,
      });
      continue;
    }
    accepted.push(candidate);
    ranked.push({ rank: ranked.length + 1, signal: candidate });
  }

  return { ranked, suppressed };
}

function isCorrelated(symbolA: string, symbolB: string): boolean {
  if (symbolA === symbolB) return true;
  const a = getInstrument(symbolA);
  const b = getInstrument(symbolB);
  if (a?.correlatedWith.includes(symbolB)) return true;
  if (b?.correlatedWith.includes(symbolA)) return true;
  return false;
}
