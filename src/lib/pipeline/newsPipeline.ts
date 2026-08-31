import { getNewsConnector } from "../ingestion/forexFactoryNews";
import { clusterHeadline, mergeKeyTerms } from "../news/clustering";
import { analyzeStory, classifyTradingHorizon, newStoryId } from "../news/aiUnderstanding";
import {
  appendHeadlineOnly,
  createLearningRecord,
  getRecentStories,
  upsertNewsStory,
} from "../db/repository";
import { getMarketDataConnector } from "../ingestion/marketData";
import { getInstrument } from "../universe";
import type { NewsStory, RawHeadline } from "../types";

const MAX_HEADLINES_KEPT_PER_STORY = 12;

export interface NewsIngestResult {
  mode: "live";
  headlinesSeen: number;
  newStories: number;
  incrementalUpdates: number;
  repeatConfirmations: number;
}

/**
 * Pulls the latest headlines (breaking news poller), clusters each into a
 * story, and — for anything genuinely new (new_story or incremental_update)
 * — runs the AI understanding engine and persists an updated story +
 * learning-database row. A repeat_confirmation headline is appended to its
 * story's headline list but never re-triggers the LLM or resets decay,
 * exactly as spec'd ("only genuinely new developments should materially
 * change the story's impact score").
 *
 * Also used directly by the inbound-email webhook (see app/api/ingest/email)
 * by passing a single synthetic headline through `processHeadline` so a
 * Forex Factory email alert triggers this same pipeline immediately.
 */
export async function ingestAndAnalyzeNews(): Promise<NewsIngestResult> {
  const { connector, mode } = getNewsConnector();
  const stories = getRecentStories(50);
  const sinceUtc = stories[0]?.lastUpdatedUtc; // most recent story update as watermark; connector defaults if undefined
  const headlines = await connector.fetchLatest(sinceUtc);

  let newStories = 0;
  let incrementalUpdates = 0;
  let repeatConfirmations = 0;
  const workingSet = [...stories];

  for (const headline of headlines) {
    const outcome = await processHeadline(headline, workingSet);
    if (outcome === "new_story") newStories++;
    else if (outcome === "incremental_update") incrementalUpdates++;
    else repeatConfirmations++;
  }

  return { mode, headlinesSeen: headlines.length, newStories, incrementalUpdates, repeatConfirmations };
}

/** Processes one headline against a working set of recent stories (mutated
 * in place so a batch of headlines clusters correctly against each other,
 * not just against what was in the DB at batch-start). Returns the novelty
 * classification actually applied. */
export async function processHeadline(
  headline: RawHeadline,
  workingSet: NewsStory[]
): Promise<"new_story" | "incremental_update" | "repeat_confirmation"> {
  const decision = clusterHeadline(headline, workingSet);

  if (decision.novelty === "repeat_confirmation" && decision.matchedStory) {
    appendHeadlineOnly(decision.matchedStory.storyId, headline);
    decision.matchedStory.headlines.push(headline);
    return "repeat_confirmation";
  }

  const storyId = decision.matchedStory?.storyId ?? newStoryId();
  const priorHeadlines = decision.matchedStory?.headlines ?? [];
  const allHeadlines = [...priorHeadlines, headline].slice(-MAX_HEADLINES_KEPT_PER_STORY);

  const analysis = await analyzeStory({ storyId, headlines: allHeadlines, novelty: decision.novelty });
  const tradingHorizon = classifyTradingHorizon(analysis);

  const story: NewsStory = {
    storyId,
    clusterKeyTerms: mergeKeyTerms(decision.matchedStory?.clusterKeyTerms ?? [], decision.keyTerms),
    headlines: allHeadlines,
    latestAnalysis: analysis,
    firstSeenUtc: decision.matchedStory?.firstSeenUtc ?? headline.timestampUtc,
    lastUpdatedUtc: headline.timestampUtc,
    developmentCount: (decision.matchedStory?.developmentCount ?? 0) + 1,
    tradingHorizon,
  };

  upsertNewsStory(story);

  // Keep the in-memory working set in sync so subsequent headlines in the
  // same batch cluster against the freshest state.
  const idx = workingSet.findIndex((s) => s.storyId === storyId);
  if (idx >= 0) workingSet[idx] = story;
  else workingSet.unshift(story);

  await recordLearningEntries(story);

  return decision.novelty === "new_story" ? "new_story" : "incremental_update";
}

/** Every analyzed event is stored in the learning database whether or not it
 * ever becomes a trade — one row per instrument the story's asset-impact
 * list names, so later we can learn which news types reliably move which
 * markets. */
async function recordLearningEntries(story: NewsStory): Promise<void> {
  const { connector } = getMarketDataConnector();
  const topImpacts = [...story.latestAnalysis.expectedAssetImpact]
    .filter((i) => getInstrument(i.symbol)) // only tradable instruments, not reference series
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 3);

  for (const impact of topImpacts) {
    if (Math.abs(impact.score) < 10) continue;
    let priceAtEvent: number | null = null;
    try {
      const snapshot = await connector.getSnapshot(impact.symbol);
      priceAtEvent = snapshot.last;
    } catch {
      priceAtEvent = null;
    }
    createLearningRecord({
      storyId: story.storyId,
      eventTimestampUtc: story.lastUpdatedUtc,
      predictedInstrument: impact.symbol,
      predictedDirection: impact.score > 0 ? "LONG" : "SHORT",
      confidence: story.latestAnalysis.confidence,
      fundamentalScore: null,
      surpriseScore: null,
      marketRegime: story.latestAnalysis.riskImpact,
      priceAtEvent,
      priceAfter1m: null,
      priceAfter5m: null,
      priceAfter15m: null,
      priceAfter30m: null,
      priceAfter60m: null,
      priceAfter4h: null,
      priceAfter1d: null,
      maxFavorableExcursion: null,
      maxAdverseExcursion: null,
      becameTrade: false,
    });
  }
}
