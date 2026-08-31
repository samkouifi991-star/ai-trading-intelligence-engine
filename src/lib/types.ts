// ── Shared domain types ──────────────────────────────────────────────────

export type Engine = "DAY" | "SWING";
export type Direction = "LONG" | "SHORT";
export type FinalStatus = "TRADE" | "WATCH" | "NO_TRADE";

// ── Economic calendar ────────────────────────────────────────────────────

export type EconomicImpact = "high" | "medium" | "low";

export interface EconomicEvent {
  id: string;
  event: string;
  currency: string;
  eventTimeUtc: string; // ISO
  impact: EconomicImpact;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revisedPrevious: number | null;
  source: string;
  description: string;
}

export interface EconomicSurpriseResult {
  eventId: string;
  indicatorKey: string;
  currentSurpriseZ: number | null;
  revisionSurpriseZ: number | null;
  effectiveSurpriseZ: number | null; // 0.75 * current + 0.25 * revision
  directionality: "hawkish" | "dovish" | "mixed" | "unclear";
  regimeAdjustedNote: string;
}

// ── News understanding ───────────────────────────────────────────────────

export type NoveltyLevel = "new_story" | "incremental_update" | "repeat_confirmation";

export interface AssetImpactScore {
  symbol: string;
  score: number; // -100..+100
}

export interface StructuredNewsAnalysis {
  storyId: string;
  timestampUtc: string;
  headline: string;
  originalSource: string;
  sourceQuality: number; // 0..100
  affectedCountries: string[];
  affectedCurrencies: string[];
  affectedCommodities: string[];
  affectedIndices: string[];
  eventType: string;
  novelty: NoveltyLevel;
  /** Who said it, when identifiable (e.g. "Fed Chair Powell", "ECB's
   * Lagarde", "Reuters sourcing"). Null when the story is a data release or
   * the source isn't a quoted individual/institution. */
  sourceAttribution: string | null;
  /** Whether this reads as confirmed fact (an official statement, a
   * released data print) vs. unconfirmed/rumored/sourced-but-unofficial.
   * Distinct from `novelty` (which is deterministic, from clustering) —
   * this is the LLM's read of the story's own certainty, still only ever
   * used as an input to deterministic scoring, never a trade decision. */
  confirmed: boolean;
  severity: number; // 0..100
  confidence: number; // 0..100
  expectedDurationMinutes: number;
  inflationImpact: "higher" | "lower" | "neutral";
  growthImpact: "higher" | "lower" | "neutral";
  interestRateImpact: "hawkish" | "dovish" | "neutral";
  riskImpact: "risk_on" | "risk_off" | "neutral";
  expectedAssetImpact: AssetImpactScore[];
  causalChain: string[];
}

export interface RawHeadline {
  id: string;
  timestampUtc: string;
  headline: string;
  body?: string;
  source: string;
  sourceQuality: number;
  url?: string;
  /** Forex Factory's own High/Medium/Low breaking-news impact rating, when
   * the headline came from Forex Factory. Used as ONE input into the news
   * score, never copied directly into the trade score (spec rule 2). */
  ffImpact?: "high" | "medium" | "low" | "unknown";
  relatedCurrency?: string | null;
  /** Every RawHeadline that reaches the pipeline is, by construction,
   * verified_news (a real breaking-news wire or calendar release) —
   * community_sentiment (e.g. Forex Factory forum/comment content) is a
   * deliberately separate, NOT-YET-IMPLEMENTED concept (see
   * CommunitySentimentSignal below) that must never be constructed as a
   * RawHeadline or enter this pipeline (spec rule 10). This field exists so
   * that guarantee is visible in the type, not just a comment. */
  contentType: "verified_news";
}

/**
 * Deliberately unused placeholder documenting spec rule 10: Forex Factory
 * comments/forum content may eventually be analyzed as crowd sentiment, but
 * must NEVER be treated as fact or enter the news/fundamental scoring
 * pipeline. Nothing in this codebase currently populates this type — it
 * exists so that if/when community-sentiment ingestion is built, its output
 * type is structurally incompatible with RawHeadline/StructuredNewsAnalysis
 * and cannot be passed into analyzeStory, clusterHeadline, or any scoring
 * function by accident.
 */
export interface CommunitySentimentSignal {
  id: string;
  timestampUtc: string;
  commentText: string;
  authorHandle: string | null;
  sourceThreadUrl: string;
  contentType: "community_sentiment"; // never "verified_news" — not type-compatible with RawHeadline
}

export interface NewsStory {
  storyId: string;
  clusterKeyTerms: string[];
  headlines: RawHeadline[];
  latestAnalysis: StructuredNewsAnalysis;
  firstSeenUtc: string;
  lastUpdatedUtc: string;
  /** Increments only on genuinely material new developments. */
  developmentCount: number;
  tradingHorizon: "day" | "swing" | "both";
}

// ── Market data ──────────────────────────────────────────────────────────

export interface OhlcvBar {
  timeUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  symbol: string;
  priceUtc: string;
  last: number;
  vwap: number | null;
  bars: OhlcvBar[]; // most recent bars, ascending time
}

export interface MacroSnapshot {
  timeUtc: string;
  dxy: number;
  dxyChangePct: number;
  vix: number;
  vixChangePct: number;

  /** Real-time proxy for 2Y/10Y rate expectations, derived from ZT=F/ZN=F
   * Treasury futures intraday price moves (inverse relationship normalized
   * into a signed hawkish(+)/dovish(-) pressure score, -100..100). THIS is
   * what the Day engine's cross-asset confirmation uses — see
   * src/lib/marketdata/ratePressure.ts. Never sourced from FRED, which is
   * daily-resolution and cannot support intraday confirmation. */
  us2yRatePressure: number;
  us10yRatePressure: number;

  /** Daily-resolution official Treasury yield levels/trend from FRED
   * (DGS2/DGS10) — real government data, but settles once/day. Useful for
   * swing-engine macro context and the dashboard's daily trend display;
   * NEVER used for Day-engine intraday cross-asset confirmation. Null if
   * the FRED fetch hasn't succeeded (production mode with FRED blocked, for
   * example) — callers must treat null as "no daily context available",
   * not fall back to a stale/fake number. */
  us2yDaily: number | null;
  us10yDaily: number | null;
  us2yDailyChangeBps: number | null;
  us10yDailyChangeBps: number | null;
}

// ── Regime ────────────────────────────────────────────────────────────────

export type GrowthRegime = "expansion" | "slowdown" | "contraction" | "unclear";
export type InflationRegime = "rising" | "falling" | "stable" | "unclear";
export type RiskRegime = "risk_on" | "risk_off" | "neutral";
export type RateBias = "hawkish" | "dovish" | "neutral";

export interface MacroRegime {
  asOfUtc: string;
  growth: GrowthRegime;
  inflation: InflationRegime;
  risk: RiskRegime;
  rateBias: RateBias;
  summary: string;
  regimeScore: number; // 0-100 confidence/clarity of the regime read
}

// ── Cross-asset confirmation ─────────────────────────────────────────────

export interface CrossAssetCheck {
  symbol: string;
  predictedDirection: Direction;
  confirmationScore: number; // 0-100, unsigned "how many factors agree with predictedDirection"
  /** Signed -100..100 read of what the market is ACTUALLY doing right now
   * (momentum + DXY reaction), computed independently of predictedDirection
   * — this is the "MARKET CONFIRMATION" half of spec rule 8's prediction-
   * vs-confirmation split, comparable in sign/scale to a story's signed
   * news-impact score for the same instrument. */
  confirmationDirectionScore: number;
  aligned: boolean;
  contradicted: boolean;
  factors: { name: string; supportsDirection: boolean; detail: string }[];
}

// ── Technicals ────────────────────────────────────────────────────────────

export interface TechnicalReadout {
  symbol: string;
  vwap: number;
  vwapRelation: "above" | "below" | "at";
  nearestSupport: number | null;
  nearestResistance: number | null;
  momentum: number; // -100..100
  volatilityPercentile: number; // 0-100 (relative to recent history)
  volumeRelative: number; // multiple of average volume, e.g. 1.4
  technicalScore: number; // 0-100 composite
}

// ── Scoring breakdown ─────────────────────────────────────────────────────

export interface DayScoreBreakdown {
  newsCatalystScore: number; // 0-100 (35%)
  economicSurpriseScore: number; // 0-100 (20%)
  crossMarketConfirmationScore: number; // 0-100 (20%)
  technicalScore: number; // 0-100 (15%)
  marketRegimeScore: number; // 0-100 (10%)
  composite: number; // 0-100 normalized
  classification: "Exceptional" | "Strong" | "Watch" | "No Trade";
}

export interface SwingScoreBreakdown {
  macroRegimeScore: number; // 25%
  centralBankOutlookScore: number; // 20%
  fundamentalTrendScore: number; // 15%
  geopoliticalThemeScore: number; // 10%
  technicalTrendScore: number; // 20%
  positioningFlowsScore: number; // 10%
  composite: number;
  classification: "Exceptional" | "Strong" | "Watch" | "No Trade";
}

// ── Signal output ─────────────────────────────────────────────────────────

export interface TradeSignal {
  id: string;
  engine: Engine;
  instrument: string;
  direction: Direction;
  /** Final confidence AFTER the data-quality gate's confidence penalty (see
   * signals/validation.ts) — never the raw composite score when data
   * quality is degraded. */
  confidence: number; // 0-100
  catalyst: string;
  newsSummary: string;

  /** Prediction vs confirmation, kept explicitly separate per spec rule 8 —
   * never blended invisibly into one number. newsImpactScore is the AI news
   * understanding engine's signed asset-impact read (what we expected to
   * happen); marketConfirmationScore is the cross-asset engine's signed
   * read of what the market is actually doing right now, independent of
   * the prediction. `direction` is the final reconciled call. */
  newsImpactScore: number | null; // -100..100
  marketConfirmationScore: number | null; // -100..100

  economicSurpriseScore: number | null;
  fundamentalScore: number | null;
  technicalScore: number | null;
  crossMarketConfirmationScore: number | null;
  marketRegimeScore: number | null;

  /** Weighted quality of the data this signal was built from (spec rule 6) —
   * see src/lib/dataQuality/dataQualityEngine.ts. A high composite score
   * built on low-quality data is penalized or gated by validation.ts, and
   * that gate's reasoning is preserved here for display. */
  dataQualityScore: number;
  dataQualityReason: string | null;

  entryZone: [number, number] | null;
  invalidation: number | null;
  target1: number | null;
  target2: number | null;
  expectedHoldingPeriod: string;
  timestampUtc: string;
  signalExpirationUtc: string;
  reasonsFor: string[];
  reasonsAgainst: string[];
  upcomingRisks: string[];
  finalStatus: FinalStatus;
  scoreBreakdown: DayScoreBreakdown | SwingScoreBreakdown;
  storyId: string | null;
}

// ── Learning database ─────────────────────────────────────────────────────

export interface LearningRecord {
  id: string;
  storyId: string | null;
  eventTimestampUtc: string;
  predictedInstrument: string;
  predictedDirection: Direction;
  confidence: number;
  fundamentalScore: number | null;
  surpriseScore: number | null;
  marketRegime: string;
  priceAtEvent: number | null;
  priceAfter1m: number | null;
  priceAfter5m: number | null;
  priceAfter15m: number | null;
  priceAfter30m: number | null;
  priceAfter60m: number | null;
  priceAfter4h: number | null;
  priceAfter1d: number | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion: number | null;
  becameTrade: boolean;
}
