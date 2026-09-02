-- Trading Intelligence Engine — full schema, isolated in its own Postgres
-- schema (namespace) so it can never collide with, or need to touch, any
-- other application's tables that already live in this same Supabase
-- project. Nothing in this migration reads, writes, or references anything
-- outside `trading_intel`.
--
-- Run this against your Supabase project's SQL editor (or `psql
-- "$DATABASE_URL" -f supabase/migrations/0001_trading_intelligence_schema.sql`)
-- once, then set DATABASE_URL for the app. Idempotent — safe to re-run.
--
-- Design notes (see README's "Egress" section for the full rationale):
--  - Nothing here stores raw tick-by-tick market data. `candles` holds only
--    bounded OHLCV bars (1m/5m/15m/1h/4h/1d), and the app is responsible for
--    pruning old bars it no longer needs (see db/prune.ts, added when the
--    technical engine starts populating this table in Phase 3).
--  - "Current" values that change constantly (latest price, latest currency
--    strength, latest regime) are still persisted here for audit/history,
--    but the app must read them through the in-process cache layer
--    (src/lib/cache/*), never by polling this table directly from the
--    frontend on every render.
--  - Every entity table has a real primary key, real foreign keys, and the
--    indexes its actual query patterns need — not "add an index later."

CREATE SCHEMA IF NOT EXISTS trading_intel;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

SET search_path TO trading_intel, public;

-- ── Economic calendar + surprise scoring ────────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.economic_events (
  id TEXT PRIMARY KEY, -- deterministic id from the source feed (see ingestion)
  event TEXT NOT NULL,
  currency TEXT NOT NULL,
  country TEXT,
  event_time_utc TIMESTAMPTZ NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('high', 'medium', 'low')),
  actual NUMERIC,
  forecast NUMERIC,
  previous NUMERIC,
  revised_previous NUMERIC,
  source TEXT NOT NULL,
  description TEXT,
  ingested_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_econ_events_time ON trading_intel.economic_events (event_time_utc DESC);
CREATE INDEX IF NOT EXISTS idx_econ_events_currency_time ON trading_intel.economic_events (currency, event_time_utc DESC);

-- Historical (actual - forecast) surprise per named indicator, the input to
-- the surprise-vs-own-history z-score (never actual-minus-forecast alone).
CREATE TABLE IF NOT EXISTS trading_intel.indicator_history (
  indicator_key TEXT NOT NULL,
  event_time_utc TIMESTAMPTZ NOT NULL,
  actual NUMERIC,
  forecast NUMERIC,
  surprise NUMERIC,
  PRIMARY KEY (indicator_key, event_time_utc)
);

-- One row per computed surprise score — the full audit trail (spec: "store
-- every calculated score and the components that created it").
CREATE TABLE IF NOT EXISTS trading_intel.economic_surprises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES trading_intel.economic_events(id),
  indicator_key TEXT NOT NULL,
  currency TEXT NOT NULL,
  current_surprise_z NUMERIC,
  revision_surprise_z NUMERIC,
  effective_surprise_z NUMERIC,
  historical_mean NUMERIC NOT NULL,
  historical_std_dev NUMERIC NOT NULL,
  historical_sample_size INTEGER NOT NULL,
  historical_bootstrapped BOOLEAN NOT NULL,
  impact_weight NUMERIC NOT NULL, -- from FF impact level (high/medium/low)
  regime_at_computation TEXT, -- MacroRegime.summary snapshot, for audit
  directionality TEXT NOT NULL CHECK (directionality IN ('hawkish', 'dovish', 'mixed', 'unclear')),
  currency_score NUMERIC NOT NULL, -- -100..100, the final normalized output for `currency`
  regime_adjusted_note TEXT NOT NULL,
  -- True when the underlying economic_events row was itself sample/fallback
  -- data (development mode, live calendar unreachable) — downstream
  -- consumers (e.g. the Currency Strength Engine's economic component)
  -- must exclude these from anything presented as a real live score.
  is_sample_source BOOLEAN NOT NULL DEFAULT false,
  computed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_econ_surprises_event ON trading_intel.economic_surprises (event_id);
CREATE INDEX IF NOT EXISTS idx_econ_surprises_currency_time ON trading_intel.economic_surprises (currency, computed_at_utc DESC);

-- ── News intelligence (Phase 2) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.news_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  headline TEXT NOT NULL,
  body TEXT,
  url TEXT,
  source TEXT NOT NULL,
  source_quality INTEGER NOT NULL DEFAULT 50,
  published_at_utc TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL, -- dedupe key (normalized headline hash)
  is_promotional BOOLEAN NOT NULL DEFAULT false,
  ingested_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_articles_hash ON trading_intel.news_articles (content_hash);
CREATE INDEX IF NOT EXISTS idx_news_articles_published ON trading_intel.news_articles (published_at_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.news_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES trading_intel.news_articles(id),
  category TEXT NOT NULL,
  countries TEXT[] NOT NULL DEFAULT '{}',
  currencies TEXT[] NOT NULL DEFAULT '{}',
  markets TEXT[] NOT NULL DEFAULT '{}',
  institutions TEXT[] NOT NULL DEFAULT '{}',
  central_bank TEXT,
  severity NUMERIC NOT NULL, -- 0..100
  novelty TEXT NOT NULL,
  confidence NUMERIC NOT NULL, -- 0..100
  expected_duration_minutes INTEGER,
  monetary_policy_score NUMERIC, -- -100..100
  growth_score NUMERIC,
  inflation_score NUMERIC,
  risk_score NUMERIC,
  geopolitical_score NUMERIC,
  commodity_supply_score NUMERIC,
  expected_asset_impact JSONB NOT NULL DEFAULT '[]', -- [{symbol, score}]
  narrative_effect TEXT,
  raw_llm_response JSONB, -- full structured response, for audit
  analyzed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_analysis_article ON trading_intel.news_analysis (article_id);
CREATE INDEX IF NOT EXISTS idx_news_analysis_time ON trading_intel.news_analysis (analyzed_at_utc DESC);

-- ── Narrative memory + decay (Phase 2) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.market_narratives (
  id TEXT PRIMARY KEY, -- e.g. 'USD', 'ECB', 'Global Risk', 'Gold'
  label TEXT NOT NULL,
  current_score NUMERIC NOT NULL DEFAULT 0, -- -100..100, decay-adjusted
  last_updated_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trading_intel.narrative_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  narrative_id TEXT NOT NULL REFERENCES trading_intel.market_narratives(id),
  news_analysis_id UUID REFERENCES trading_intel.news_analysis(id),
  economic_surprise_id UUID REFERENCES trading_intel.economic_surprises(id),
  effect TEXT NOT NULL CHECK (effect IN ('strengthens', 'weakens', 'contradicts', 'reverses', 'irrelevant')),
  initial_score NUMERIC NOT NULL,
  half_life_minutes INTEGER NOT NULL,
  expires_at_utc TIMESTAMPTZ NOT NULL,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_narrative_events_narrative ON trading_intel.narrative_events (narrative_id, created_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_narrative_events_expiry ON trading_intel.narrative_events (expires_at_utc);

-- ── Currency strength ────────────────────────────────────────────────────

-- History of computed strength scores. The app's cache layer serves "current"
-- reads; this table is for audit/history/backtesting, not frontend polling.
CREATE TABLE IF NOT EXISTS trading_intel.currency_strength (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency TEXT NOT NULL,
  strength_score NUMERIC NOT NULL, -- -100..100
  economic_component NUMERIC NOT NULL,
  news_component NUMERIC NOT NULL,
  central_bank_component NUMERIC NOT NULL,
  yield_component NUMERIC NOT NULL,
  risk_component NUMERIC NOT NULL,
  price_action_component NUMERIC NOT NULL,
  components_json JSONB NOT NULL, -- full breakdown, for the explainability panel
  computed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_currency_strength_currency_time ON trading_intel.currency_strength (currency, computed_at_utc DESC);

-- ── Market data (Phase 1: prices; Phase 3: technical) ───────────────────

-- Latest snapshot only — one row per symbol, upserted. Never tick-by-tick.
CREATE TABLE IF NOT EXISTS trading_intel.market_prices (
  symbol TEXT PRIMARY KEY,
  bid NUMERIC,
  ask NUMERIC,
  last NUMERIC NOT NULL,
  spread NUMERIC,
  change_pct NUMERIC,
  provider TEXT NOT NULL,
  realtime BOOLEAN NOT NULL DEFAULT false,
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bounded OHLCV bars — the app prunes old rows per symbol/timeframe (keeps
-- only what technical calculations actually need, e.g. last ~300 bars).
CREATE TABLE IF NOT EXISTS trading_intel.candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  time_utc TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC,
  PRIMARY KEY (symbol, timeframe, time_utc)
);
CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_time ON trading_intel.candles (symbol, timeframe, time_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.technical_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  technical_score NUMERIC NOT NULL, -- -100..100
  condition TEXT NOT NULL, -- BULLISH/BEARISH/NEUTRAL/WAIT_FOR_RETEST/OVEREXTENDED/BREAKOUT/RANGE
  components_json JSONB NOT NULL,
  computed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_technical_scores_symbol_time ON trading_intel.technical_scores (symbol, computed_at_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.cross_market_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  confirmation_score NUMERIC NOT NULL, -- 0..100
  components_json JSONB NOT NULL,
  computed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cross_market_scores_symbol_time ON trading_intel.cross_market_scores (symbol, computed_at_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.market_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  economic_event_id TEXT REFERENCES trading_intel.economic_events(id),
  news_analysis_id UUID REFERENCES trading_intel.news_analysis(id),
  symbol TEXT NOT NULL,
  expected_reaction NUMERIC NOT NULL, -- -100..100
  actual_reaction NUMERIC, -- -100..100, null until measured
  reaction_confirmation_score NUMERIC, -- 0..100
  rejected_fundamental_signal BOOLEAN,
  measured_at_utc TIMESTAMPTZ,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_reactions_symbol_time ON trading_intel.market_reactions (symbol, created_at_utc DESC);

-- ── Trader intelligence (Phase 4 — schema only; DATA UNAVAILABLE until a
-- real source exists, see README) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.traders (
  id TEXT PRIMARY KEY, -- source's own trader/account id
  source TEXT NOT NULL,
  display_name TEXT,
  account_age_days INTEGER,
  quality_score NUMERIC, -- 0..100
  flagged_suspicious BOOLEAN NOT NULL DEFAULT false,
  last_updated_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trading_intel.trader_performance (
  trader_id TEXT NOT NULL REFERENCES trading_intel.traders(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  return_pct NUMERIC,
  max_drawdown_pct NUMERIC,
  trade_count INTEGER,
  win_rate NUMERIC,
  avg_win NUMERIC,
  avg_loss NUMERIC,
  risk_adjusted_return NUMERIC,
  PRIMARY KEY (trader_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS trading_intel.trader_expertise (
  trader_id TEXT NOT NULL REFERENCES trading_intel.traders(id),
  symbol TEXT NOT NULL,
  expertise_score NUMERIC NOT NULL, -- 0..100
  sample_size INTEGER NOT NULL,
  PRIMARY KEY (trader_id, symbol)
);

CREATE TABLE IF NOT EXISTS trading_intel.trader_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL REFERENCES trading_intel.traders(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  opened_at_utc TIMESTAMPTZ,
  observed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trader_positions_symbol_time ON trading_intel.trader_positions (symbol, observed_at_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.trader_consensus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  bullish_pct NUMERIC NOT NULL,
  bearish_pct NUMERIC NOT NULL,
  qualified_trader_count INTEGER NOT NULL,
  weighted_confidence NUMERIC NOT NULL,
  avg_trader_quality NUMERIC NOT NULL,
  consensus_score NUMERIC NOT NULL, -- -100..100
  computed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trader_consensus_symbol_time ON trading_intel.trader_consensus (symbol, computed_at_utc DESC);

-- ── Market regime (Phase 3) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.market_regimes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regime TEXT NOT NULL, -- RISK_ON/RISK_OFF/HIGH_VOL/... (see spec section 13)
  secondary_regimes TEXT[] NOT NULL DEFAULT '{}',
  weighting_profile_id TEXT, -- FK-by-convention to system_weights.profile_id
  summary TEXT NOT NULL,
  components_json JSONB NOT NULL,
  computed_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_regimes_time ON trading_intel.market_regimes (computed_at_utc DESC);

-- ── Trade ranking + recommendations (Phase 5) ────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.trade_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell', 'no_trade')),
  trade_score NUMERIC NOT NULL, -- 0..100
  confidence NUMERIC NOT NULL, -- 0..100
  contradiction_score NUMERIC NOT NULL, -- 0..100, higher = more conflict
  data_freshness_ok BOOLEAN NOT NULL,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trade_candidates_time ON trading_intel.trade_candidates (created_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_trade_candidates_symbol_time ON trading_intel.trade_candidates (symbol, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.trade_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES trading_intel.trade_candidates(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell', 'no_trade')),
  trade_score NUMERIC NOT NULL,
  confidence NUMERIC NOT NULL,
  price_at_recommendation NUMERIC NOT NULL,
  entry_zone_low NUMERIC,
  entry_zone_high NUMERIC,
  invalidation NUMERIC,
  target1 NUMERIC,
  target2 NUMERIC,
  risk_reward NUMERIC,
  technical_condition TEXT,
  market_regime TEXT,
  catalyst TEXT,
  catalyst_expires_at_utc TIMESTAMPTZ,
  short_explanation TEXT NOT NULL,
  full_explanation TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '[]',
  risks_json JSONB NOT NULL DEFAULT '[]',
  invalidation_thesis TEXT,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trade_recs_time ON trading_intel.trade_recommendations (created_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_trade_recs_symbol_time ON trading_intel.trade_recommendations (symbol, created_at_utc DESC);

-- Named, versioned component scores behind one recommendation — this is
-- the explainability panel's data source (spec section 26: every score must
-- be traceable to exactly which inputs produced it).
CREATE TABLE IF NOT EXISTS trading_intel.recommendation_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES trading_intel.trade_recommendations(id),
  component_key TEXT NOT NULL, -- 'economic_surprise' | 'news' | 'technical' | 'trader_consensus' | 'cross_market' | 'regime' | 'liquidity'
  weight NUMERIC NOT NULL,
  raw_score NUMERIC NOT NULL,
  weighted_contribution NUMERIC NOT NULL,
  source_refs_json JSONB NOT NULL DEFAULT '[]' -- ids of the economic_surprises/news_analysis/etc rows behind this component
);
CREATE INDEX IF NOT EXISTS idx_rec_components_rec ON trading_intel.recommendation_components (recommendation_id);

CREATE TABLE IF NOT EXISTS trading_intel.recommendation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES trading_intel.trade_recommendations(id),
  event TEXT NOT NULL, -- 'created' | 'score_changed' | 'expired' | 'superseded'
  detail TEXT,
  at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Outcome tracking / backtesting (Phase 6) ─────────────────────────────

CREATE TABLE IF NOT EXISTS trading_intel.trade_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES trading_intel.trade_recommendations(id),
  price_at_1h NUMERIC,
  price_at_4h NUMERIC,
  price_at_24h NUMERIC,
  max_favorable_excursion NUMERIC,
  max_adverse_excursion NUMERIC,
  target1_hit BOOLEAN,
  target2_hit BOOLEAN,
  invalidation_hit BOOLEAN,
  return_1h_pct NUMERIC,
  return_4h_pct NUMERIC,
  return_24h_pct NUMERIC,
  outcome TEXT, -- 'win' | 'loss' | 'breakeven' | 'pending'
  evaluated_at_utc TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_rec ON trading_intel.trade_outcomes (recommendation_id);

-- ── System configuration ─────────────────────────────────────────────────

-- Scoring weights, versioned and editable without a code deploy (spec
-- section 14: never hardcode weights in a way that blocks future tuning).
CREATE TABLE IF NOT EXISTS trading_intel.system_weights (
  profile_id TEXT PRIMARY KEY, -- 'default', or a regime-specific profile id
  label TEXT NOT NULL,
  weights_json JSONB NOT NULL, -- {economicSurprise: 25, news: 20, technical: 15, ...}
  active BOOLEAN NOT NULL DEFAULT false,
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Cache-layer backing store ────────────────────────────────────────────

-- Generic "latest value" store for anything that changes constantly and
-- should never be recomputed from a full history scan on every request:
-- current currency strength (one row per currency), current market regime,
-- current top trade, current news score, latest market price snapshot
-- summary. This is the backing store the cache abstraction
-- (src/lib/ti/cache) reads through; a real Redis instance can replace it
-- later without touching any caller (see src/lib/ti/cache/README.md).
-- Tiny, single-row-per-key, upserted — never grows unbounded, never scanned.
CREATE TABLE IF NOT EXISTS trading_intel.latest_values (
  key TEXT PRIMARY KEY, -- e.g. 'currency_strength:USD', 'market_regime:current', 'top_trade:current'
  value_json JSONB NOT NULL,
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Ingestion / connector health (freshness monitoring, spec section 27) ─

CREATE TABLE IF NOT EXISTS trading_intel.data_sources (
  source_key TEXT PRIMARY KEY, -- 'calendar', 'news:forexfactory', 'marketData:EURUSD', ...
  status TEXT NOT NULL CHECK (status IN ('live', 'partial', 'sample', 'blocked')),
  detail TEXT NOT NULL,
  last_attempt_utc TIMESTAMPTZ NOT NULL,
  last_success_utc TIMESTAMPTZ,
  latency_ms INTEGER,
  realtime BOOLEAN,
  streaming_mode TEXT
);

CREATE TABLE IF NOT EXISTS trading_intel.ingestion_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'failure')),
  detail TEXT,
  rows_ingested INTEGER,
  duration_ms INTEGER,
  at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingestion_logs_source_time ON trading_intel.ingestion_logs (source_key, at_utc DESC);

CREATE TABLE IF NOT EXISTS trading_intel.ai_analysis_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task TEXT NOT NULL, -- 'news_classifier' | 'geopolitical_analyzer' | 'central_bank_analyzer' | 'narrative_updater' | 'market_impact_analyzer' | 'trade_explanation'
  input_ref TEXT, -- id of the article/story/recommendation this ran against
  model TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  validation_error TEXT, -- set when the response failed schema validation
  latency_ms INTEGER,
  at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_logs_task_time ON trading_intel.ai_analysis_logs (task, at_utc DESC);
