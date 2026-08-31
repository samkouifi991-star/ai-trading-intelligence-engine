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
