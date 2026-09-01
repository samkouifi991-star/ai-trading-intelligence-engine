-- Learning database schema. SQLite by default (see db.ts); swap the driver
-- behind repository.ts to move to Postgres/Supabase without touching callers.

CREATE TABLE IF NOT EXISTS economic_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  currency TEXT NOT NULL,
  event_time_utc TEXT NOT NULL,
  impact TEXT NOT NULL,
  actual REAL,
  forecast REAL,
  previous REAL,
  revised_previous REAL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  ingested_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_history (
  indicator_key TEXT NOT NULL,
  event_time_utc TEXT NOT NULL,
  actual REAL,
  forecast REAL,
  surprise REAL,
  PRIMARY KEY (indicator_key, event_time_utc)
);

CREATE TABLE IF NOT EXISTS news_stories (
  story_id TEXT PRIMARY KEY,
  cluster_key_terms TEXT NOT NULL, -- JSON array
  first_seen_utc TEXT NOT NULL,
  last_updated_utc TEXT NOT NULL,
  development_count INTEGER NOT NULL DEFAULT 1,
  trading_horizon TEXT NOT NULL,
  latest_analysis_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_headlines (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES news_stories(story_id),
  timestamp_utc TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT,
  source TEXT NOT NULL,
  source_quality INTEGER NOT NULL,
  url TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  instrument TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  final_status TEXT NOT NULL,
  story_id TEXT,
  timestamp_utc TEXT NOT NULL,
  signal_expiration_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL -- full TradeSignal, for audit/replay
);

CREATE TABLE IF NOT EXISTS learning_records (
  id TEXT PRIMARY KEY,
  story_id TEXT,
  event_timestamp_utc TEXT NOT NULL,
  predicted_instrument TEXT NOT NULL,
  predicted_direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  fundamental_score REAL,
  surprise_score REAL,
  market_regime TEXT NOT NULL,
  price_at_event REAL,
  price_after_1m REAL,
  price_after_5m REAL,
  price_after_15m REAL,
  price_after_30m REAL,
  price_after_60m REAL,
  price_after_4h REAL,
  price_after_1d REAL,
  max_favorable_excursion REAL,
  max_adverse_excursion REAL,
  became_trade INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_signals_engine_time ON signals(engine, timestamp_utc DESC);
CREATE INDEX IF NOT EXISTS idx_learning_instrument ON learning_records(predicted_instrument);
CREATE INDEX IF NOT EXISTS idx_headlines_story ON news_headlines(story_id);

-- One row per named data source (e.g. "calendar", "news", "marketData:XAUUSD",
-- "gmail", "llm"). Every real fetch attempt updates its row so the Live Data
-- Status page reflects actual outcomes, not a static config flag — and so
-- that status is consistent across separate serverless invocations.
CREATE TABLE IF NOT EXISTS connector_health (
  source_key TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- 'live' | 'partial' | 'sample' | 'blocked'
  detail TEXT NOT NULL,
  last_attempt_utc TEXT NOT NULL,
  last_success_utc TEXT,
  latency_ms INTEGER,       -- round-trip time of the most recent attempt
  realtime INTEGER,         -- 0/1 — does this source claim true real-time data (vs delayed)?
  streaming_mode TEXT,      -- 'streaming' | 'polling'
  market_open INTEGER       -- 0/1 — is the relevant market open right now (instrument sources only)?
);

-- Last completed tick per engine, so a cached (non-fresh) API read can still
-- show the regime/themes/no-trade-reasons from the last real run instead of
-- hanging on "Loading" until someone happens to hit ?fresh=1. One row per
-- engine, overwritten on every tick (fresh=1 request or scheduled cron).
CREATE TABLE IF NOT EXISTS engine_tick_summary (
  engine TEXT PRIMARY KEY, -- 'DAY' | 'SWING'
  status TEXT NOT NULL,    -- 'READY' | 'DEGRADED' | 'DATA_UNAVAILABLE' | 'ERROR'
  tick_at_utc TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

-- OAuth tokens for the Gmail Forex Factory alert ingestion. Single-row table
-- (one connected Gmail account) since this is a single-operator system.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY, -- 'gmail'
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_utc TEXT,
  connected_email TEXT,
  connected_at_utc TEXT NOT NULL,
  last_history_id TEXT
);

-- Captured once per day around 9:45 ET, before the day engine's 10:00 issue
-- window opens, so "the system began collecting/analyzing before 10:00" is
-- auditable rather than just asserted.
CREATE TABLE IF NOT EXISTS premarket_snapshots (
  id TEXT PRIMARY KEY,
  trading_day TEXT NOT NULL, -- YYYY-MM-DD in America/New_York
  captured_at_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_premarket_day ON premarket_snapshots(trading_day DESC);

-- Event Clock: one row per (story, checkpoint, market) snapshot. Captured
-- opportunistically at whatever cadence the pipeline actually ticks — see
-- src/lib/pipeline/eventClock.ts for why sub-minute checkpoints (T+15s/
-- T+30s) need a faster-than-serverless-cron poller for true fidelity.
CREATE TABLE IF NOT EXISTS event_clock (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES news_stories(story_id),
  t0_utc TEXT NOT NULL,
  checkpoint TEXT NOT NULL,  -- 'T-5m' | 'T-1m' | 'T0' | 'T+15s' | ... | 'T+60m'
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  captured_at_utc TEXT NOT NULL, -- actual capture time (may lag the checkpoint's target time)
  UNIQUE(story_id, checkpoint, symbol)
);
CREATE INDEX IF NOT EXISTS idx_event_clock_story ON event_clock(story_id);
