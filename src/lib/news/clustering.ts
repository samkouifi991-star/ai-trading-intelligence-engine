import type { NewsStory, NoveltyLevel, RawHeadline } from "../types";

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "as", "at", "by",
  "is", "are", "was", "were", "be", "been", "with", "after", "over", "amid",
  "says", "say", "said", "vs", "its", "it's", "than", "into", "up", "down",
  "new", "more", "than", "will", "could", "may", "might", "signals", "sees",
]);

/** Very lightweight keyword extraction: lowercase, strip punctuation, drop
 * stopwords/short tokens. Good enough to cluster near-duplicate headlines
 * like "Iran threatens retaliation" / "Iran vows response" / "Tehran warns
 * military response coming" without needing an LLM call per headline (that
 * cost is reserved for the one analysis call per *story*, not per repeat
 * headline). */
export function extractKeyTerms(headline: string): string[] {
  const tokens = headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

const SAME_STORY_THRESHOLD = 0.32;
const MATERIAL_NEW_INFO_THRESHOLD = 0.4; // fraction of new terms not previously in the story's cluster

export interface ClusterDecision {
  matchedStory: NewsStory | null;
  novelty: NoveltyLevel;
  keyTerms: string[];
}

/** Finds the best-matching existing story for a new headline (if any) and
 * classifies novelty. Only "new_story" and "incremental_update" should
 * materially move a story's impact score — "repeat_confirmation" should not
 * (see decay.ts, which does not reset decay for repeat confirmations). */
export function clusterHeadline(headline: RawHeadline, recentStories: NewsStory[]): ClusterDecision {
  const keyTerms = extractKeyTerms(headline.headline);

  let best: { story: NewsStory; score: number } | null = null;
  for (const story of recentStories) {
    const score = jaccardSimilarity(keyTerms, story.clusterKeyTerms);
    if (score >= SAME_STORY_THRESHOLD && (!best || score > best.score)) {
      best = { story, score };
    }
  }

  if (!best) {
    return { matchedStory: null, novelty: "new_story", keyTerms };
  }

  const newTerms = keyTerms.filter((t) => !best!.story.clusterKeyTerms.includes(t));
  const noveltyFraction = keyTerms.length === 0 ? 0 : newTerms.length / keyTerms.length;
  const novelty: NoveltyLevel =
    noveltyFraction >= MATERIAL_NEW_INFO_THRESHOLD ? "incremental_update" : "repeat_confirmation";

  return { matchedStory: best.story, novelty, keyTerms };
}

export function mergeKeyTerms(existing: string[], incoming: string[]): string[] {
  return Array.from(new Set([...existing, ...incoming])).slice(0, 40);
}
