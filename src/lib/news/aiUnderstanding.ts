import { randomUUID } from "node:crypto";
import { REFERENCE_SERIES, TRADABLE_UNIVERSE } from "../universe";
import type { NoveltyLevel, RawHeadline, StructuredNewsAnalysis } from "../types";
import { callJsonLlm, isLlmConfigured } from "../llm/client";
import { recordConnectorHealth } from "../ingestion/connectorHealth";

const ASSET_SYMBOLS = [...TRADABLE_UNIVERSE.map((i) => i.symbol), ...REFERENCE_SERIES];

const SYSTEM_PROMPT = `You are the AI News Understanding Engine inside a trading-intelligence system.
Your ONLY job is to explain what a news story means — you never decide whether to trade.
Given one or more related headlines (a "story"), return a single JSON object with EXACTLY
these keys:

headline (string, the clearest single-sentence summary of the story)
originalSource (string)
sourceQuality (integer 0-100)
affectedCountries (string[])
affectedCurrencies (string[], ISO-style 3-letter codes)
affectedCommodities (string[])
affectedIndices (string[])
eventType (string, short category e.g. "geopolitical", "central_bank", "economic_data", "supply_shock")
sourceAttribution (string or null — WHO said it, e.g. "Fed Chair Powell", "ECB's Lagarde", "Reuters
 sourcing"; null if this is a data release or the source isn't a quoted individual/institution)
confirmed (boolean — does this read as confirmed fact (an official statement, a released data
 print) rather than an unconfirmed/rumored/sourced-but-unofficial report?)
severity (integer 0-100, how large a market-moving event this is)
confidence (integer 0-100, your confidence in this read)
expectedDurationMinutes (integer, how long this catalyst should realistically matter for a DAY trading horizon)
inflationImpact ("higher" | "lower" | "neutral")
growthImpact ("higher" | "lower" | "neutral")
interestRateImpact ("hawkish" | "dovish" | "neutral")
riskImpact ("risk_on" | "risk_off" | "neutral")
expectedAssetImpact (array of {symbol, score}), where symbol is drawn ONLY from this exact list:
${ASSET_SYMBOLS.join(", ")}
 — score is an integer from -100 to +100 (positive = the story should push that instrument's
 price UP, negative = DOWN). Only include instruments genuinely relevant to this story.
causalChain (string[], each entry one link in the causal chain from the event to the asset
 reaction, e.g. ["Strait of Hormuz disruption", "potential oil-supply shortage", "oil prices
 higher", "inflation expectations higher", "risk-off environment", "equities pressured", "gold
 safe-haven demand potentially higher"])

Return ONLY the JSON object, no prose.`;

export async function analyzeStory(params: {
  storyId: string;
  headlines: RawHeadline[];
  novelty: NoveltyLevel;
}): Promise<StructuredNewsAnalysis> {
  const latest = params.headlines[params.headlines.length - 1];
  let base: LlmShape;
  if (isLlmConfigured()) {
    base = await analyzeWithLlm(params.headlines);
  } else {
    recordConnectorHealth("llm", "sample", "OPENAI_API_KEY not set — using keyword heuristic fallback");
    base = analyzeWithHeuristicFallback(params.headlines);
  }

  return {
    storyId: params.storyId,
    timestampUtc: latest.timestampUtc,
    novelty: params.novelty,
    headline: base.headline,
    originalSource: base.originalSource,
    sourceQuality: base.sourceQuality,
    affectedCountries: base.affectedCountries,
    affectedCurrencies: base.affectedCurrencies,
    affectedCommodities: base.affectedCommodities,
    affectedIndices: base.affectedIndices,
    eventType: base.eventType,
    sourceAttribution: base.sourceAttribution,
    confirmed: base.confirmed,
    severity: base.severity,
    confidence: base.confidence,
    expectedDurationMinutes: base.expectedDurationMinutes,
    inflationImpact: base.inflationImpact,
    growthImpact: base.growthImpact,
    interestRateImpact: base.interestRateImpact,
    riskImpact: base.riskImpact,
    expectedAssetImpact: sanitizeAssetImpact(base.expectedAssetImpact),
    causalChain: base.causalChain,
  };
}

type LlmShape = Omit<StructuredNewsAnalysis, "storyId" | "timestampUtc" | "novelty">;

async function analyzeWithLlm(headlines: RawHeadline[]): Promise<LlmShape> {
  const context = headlines
    .map((h) => `[${h.timestampUtc}] (${h.source}, quality ${h.sourceQuality}) ${h.headline}${h.body ? `\n${h.body}` : ""}`)
    .join("\n\n");

  try {
    const result = await callJsonLlm<LlmShape>({
      system: SYSTEM_PROMPT,
      user: `Story headlines (oldest to newest):\n\n${context}`,
    });
    recordConnectorHealth("llm", "live", "ok");
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("LLM news analysis failed, falling back to heuristic:", err);
    recordConnectorHealth("llm", "blocked", detail);
    return analyzeWithHeuristicFallback(headlines);
  }
}

/** Deterministic, keyword-based fallback used when OPENAI_API_KEY is unset
 * (or the LLM call fails) so the pipeline still runs end-to-end in dev. This
 * is intentionally simple — it exists to keep demos and tests working
 * offline, not as a substitute for real LLM understanding in production. */
function analyzeWithHeuristicFallback(headlines: RawHeadline[]): LlmShape {
  const latest = headlines[headlines.length - 1];
  const text = headlines.map((h) => `${h.headline} ${h.body ?? ""}`).join(" ").toLowerCase();

  const hit = (words: string[]) => words.some((w) => text.includes(w));
  const riskOff = hit(["threatens", "strike", "war", "conflict", "escalat", "tension", "attack", "retaliat"]);
  const hawkish = hit(["hot cpi", "inflation", "hike", "hawkish", "beat expectations", "tariff"]);
  const dovish = hit(["cut rate", "dovish", "cuts", "jobless claims jump", "stagnation", "slowdown"]);
  const oil = hit(["oil", "crude", "opec", "hormuz", "energy"]);

  const impact: { symbol: string; score: number }[] = [];
  if (oil) impact.push({ symbol: "WTI", score: riskOff ? 70 : 20 });
  if (riskOff) {
    impact.push({ symbol: "XAUUSD", score: 60 }, { symbol: "VIX", score: 65 }, { symbol: "ES", score: -50 }, { symbol: "NQ", score: -45 });
  }
  if (hawkish) {
    impact.push({ symbol: "DXY", score: 40 }, { symbol: "XAUUSD", score: -30 });
  }
  if (dovish) {
    impact.push({ symbol: "DXY", score: -35 }, { symbol: "XAUUSD", score: 30 });
  }
  if (impact.length === 0) impact.push({ symbol: "DXY", score: 5 });

  return {
    headline: latest.headline,
    originalSource: latest.source,
    sourceQuality: latest.sourceQuality,
    affectedCountries: [],
    affectedCurrencies: [],
    affectedCommodities: oil ? ["WTI"] : [],
    affectedIndices: riskOff ? ["ES", "NQ"] : [],
    eventType: riskOff ? "geopolitical" : hawkish || dovish ? "central_bank" : "general",
    sourceAttribution: null, // the heuristic can't reliably extract "who said it" from keyword matching
    confirmed: true, // headlines from a verified_news wire are treated as reported fact by default; this heuristic can't judge rumor-vs-confirmed nuance the way the LLM can
    severity: riskOff ? 60 : 35,
    confidence: 40, // deliberately capped low — this is a heuristic, not real understanding
    expectedDurationMinutes: riskOff ? 90 : 45,
    inflationImpact: hawkish ? "higher" : dovish ? "lower" : "neutral",
    growthImpact: dovish ? "lower" : "neutral",
    interestRateImpact: hawkish ? "hawkish" : dovish ? "dovish" : "neutral",
    riskImpact: riskOff ? "risk_off" : "neutral",
    expectedAssetImpact: impact,
    causalChain: [
      "[heuristic fallback — no OPENAI_API_KEY configured]",
      latest.headline,
      riskOff ? "risk sentiment deteriorates" : "market digests the headline",
    ],
  };
}

function sanitizeAssetImpact(items: { symbol: string; score: number }[]): { symbol: string; score: number }[] {
  const known = new Set(ASSET_SYMBOLS);
  return items
    .filter((i) => known.has(i.symbol))
    .map((i) => ({ symbol: i.symbol, score: Math.max(-100, Math.min(100, Math.round(i.score))) }));
}

export function newStoryId(): string {
  return `story-${randomUUID()}`;
}

/** Deterministic classification of which engine(s) a story is relevant to.
 * A high-severity structural story (central bank pivot, major geopolitical
 * escalation) matters to both a same-day reaction AND the medium-term
 * thesis; a routine data print or transient headline is day-only. */
export function classifyTradingHorizon(analysis: StructuredNewsAnalysis): "day" | "swing" | "both" {
  const structuralType = analysis.eventType === "central_bank" || analysis.eventType === "geopolitical";
  if (structuralType && analysis.severity >= 60) return "both";
  if (analysis.severity >= 75) return "both";
  return "day";
}
