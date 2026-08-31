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
  us2y: number;
  us10y: number;
  vix: number;
  dxyChangePct: number;
  us2yChangeBps: number;
  us10yChangeBps: number;
  vixChangePct: number;
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
  confirmationScore: number; // 0-100
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
  confidence: number; // 0-100
  catalyst: string;
  newsSummary: string;
  economicSurpriseScore: number | null;
  fundamentalScore: number | null;
  technicalScore: number | null;
  crossMarketConfirmationScore: number | null;
  marketRegimeScore: number | null;
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
