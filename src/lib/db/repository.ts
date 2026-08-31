import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  EconomicEvent,
  LearningRecord,
  NewsStory,
  RawHeadline,
  TradeSignal,
} from "../types";

// ── Economic events ─────────────────────────────────────────────────────

export function saveEconomicEvent(event: EconomicEvent): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO economic_events
      (id, event, currency, event_time_utc, impact, actual, forecast, previous, revised_previous, source, description, ingested_at_utc)
     VALUES (@id, @event, @currency, @eventTimeUtc, @impact, @actual, @forecast, @previous, @revisedPrevious, @source, @description, @ingestedAtUtc)
     ON CONFLICT(id) DO UPDATE SET
       actual=excluded.actual, forecast=excluded.forecast, previous=excluded.previous,
       revised_previous=excluded.revised_previous, ingested_at_utc=excluded.ingested_at_utc`
  ).run({ ...event, ingestedAtUtc: new Date().toISOString() });

  if (event.actual !== null) {
    const surprise =
      event.forecast !== null ? event.actual - event.forecast : null;
    db.prepare(
      `INSERT OR REPLACE INTO indicator_history (indicator_key, event_time_utc, actual, forecast, surprise)
       VALUES (?, ?, ?, ?, ?)`
    ).run(indicatorKey(event), event.eventTimeUtc, event.actual, event.forecast, surprise);
  }
}

export function getEventsInRange(fromUtc: string, toUtc: string): EconomicEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM economic_events WHERE event_time_utc BETWEEN ? AND ? ORDER BY event_time_utc ASC`
    )
    .all(fromUtc, toUtc) as any[];
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    currency: r.currency,
    eventTimeUtc: r.event_time_utc,
    impact: r.impact,
    actual: r.actual,
    forecast: r.forecast,
    previous: r.previous,
    revisedPrevious: r.revised_previous,
    source: r.source,
    description: r.description,
  }));
}

export function appendHeadlineOnly(storyId: string, headline: RawHeadline): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO news_headlines (id, story_id, timestamp_utc, headline, body, source, source_quality, url)
     VALUES (@id, @storyId, @timestampUtc, @headline, @body, @source, @sourceQuality, @url)`
  ).run({ ...headline, storyId, body: headline.body ?? null, url: headline.url ?? null });
}

export function indicatorKey(event: Pick<EconomicEvent, "event" | "currency">): string {
  return `${event.currency}:${event.event}`.toLowerCase().trim();
}

export function getIndicatorHistory(indicatorKeyValue: string, limit = 60) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM indicator_history WHERE indicator_key = ? ORDER BY event_time_utc DESC LIMIT ?`
    )
    .all(indicatorKeyValue, limit) as {
    indicator_key: string;
    event_time_utc: string;
    actual: number | null;
    forecast: number | null;
    surprise: number | null;
  }[];
}

// ── News stories ─────────────────────────────────────────────────────────

export function upsertNewsStory(story: NewsStory): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO news_stories (story_id, cluster_key_terms, first_seen_utc, last_updated_utc, development_count, trading_horizon, latest_analysis_json)
     VALUES (@storyId, @clusterKeyTerms, @firstSeenUtc, @lastUpdatedUtc, @developmentCount, @tradingHorizon, @analysisJson)
     ON CONFLICT(story_id) DO UPDATE SET
       last_updated_utc=excluded.last_updated_utc,
       development_count=excluded.development_count,
       trading_horizon=excluded.trading_horizon,
       latest_analysis_json=excluded.latest_analysis_json`
  ).run({
    storyId: story.storyId,
    clusterKeyTerms: JSON.stringify(story.clusterKeyTerms),
    firstSeenUtc: story.firstSeenUtc,
    lastUpdatedUtc: story.lastUpdatedUtc,
    developmentCount: story.developmentCount,
    tradingHorizon: story.tradingHorizon,
    analysisJson: JSON.stringify(story.latestAnalysis),
  });

  const insertHeadline = db.prepare(
    `INSERT OR IGNORE INTO news_headlines (id, story_id, timestamp_utc, headline, body, source, source_quality, url)
     VALUES (@id, @storyId, @timestampUtc, @headline, @body, @source, @sourceQuality, @url)`
  );
  for (const h of story.headlines) {
    insertHeadline.run({ ...h, storyId: story.storyId, body: h.body ?? null, url: h.url ?? null });
  }
}

export function getRecentStories(limit = 25): NewsStory[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM news_stories ORDER BY last_updated_utc DESC LIMIT ?`)
    .all(limit) as any[];
  return rows.map(rowToStory);
}

export function getStoryById(storyId: string): NewsStory | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM news_stories WHERE story_id = ?`)
    .get(storyId) as any;
  return row ? rowToStory(row) : null;
}

function rowToStory(row: any): NewsStory {
  const db = getDb();
  const headlines = db
    .prepare(`SELECT * FROM news_headlines WHERE story_id = ? ORDER BY timestamp_utc ASC`)
    .all(row.story_id) as any[];
  return {
    storyId: row.story_id,
    clusterKeyTerms: JSON.parse(row.cluster_key_terms),
    firstSeenUtc: row.first_seen_utc,
    lastUpdatedUtc: row.last_updated_utc,
    developmentCount: row.development_count,
    tradingHorizon: row.trading_horizon,
    latestAnalysis: JSON.parse(row.latest_analysis_json),
    headlines: headlines.map((h) => ({
      id: h.id,
      timestampUtc: h.timestamp_utc,
      headline: h.headline,
      body: h.body ?? undefined,
      source: h.source,
      sourceQuality: h.source_quality,
      url: h.url ?? undefined,
      contentType: "verified_news" as const,
    })),
  };
}

// ── Signals ──────────────────────────────────────────────────────────────

export function saveSignal(signal: TradeSignal): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO signals (id, engine, instrument, direction, confidence, final_status, story_id, timestamp_utc, signal_expiration_utc, payload_json)
     VALUES (@id, @engine, @instrument, @direction, @confidence, @finalStatus, @storyId, @timestampUtc, @signalExpirationUtc, @payloadJson)
     ON CONFLICT(id) DO UPDATE SET
       confidence=excluded.confidence, final_status=excluded.final_status, payload_json=excluded.payload_json`
  ).run({
    id: signal.id,
    engine: signal.engine,
    instrument: signal.instrument,
    direction: signal.direction,
    confidence: signal.confidence,
    finalStatus: signal.finalStatus,
    storyId: signal.storyId,
    timestampUtc: signal.timestampUtc,
    signalExpirationUtc: signal.signalExpirationUtc,
    payloadJson: JSON.stringify(signal),
  });
}

export function getRecentSignals(engine: "DAY" | "SWING", limit = 50): TradeSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT payload_json FROM signals WHERE engine = ? ORDER BY timestamp_utc DESC LIMIT ?`
    )
    .all(engine, limit) as { payload_json: string }[];
  return rows.map((r) => JSON.parse(r.payload_json));
}

// ── Learning records ─────────────────────────────────────────────────────

export function createLearningRecord(
  record: Omit<LearningRecord, "id">
): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO learning_records
      (id, story_id, event_timestamp_utc, predicted_instrument, predicted_direction, confidence,
       fundamental_score, surprise_score, market_regime, price_at_event, became_trade)
     VALUES (@id, @storyId, @eventTimestampUtc, @predictedInstrument, @predictedDirection, @confidence,
             @fundamentalScore, @surpriseScore, @marketRegime, @priceAtEvent, @becameTrade)`
  ).run({
    id,
    storyId: record.storyId,
    eventTimestampUtc: record.eventTimestampUtc,
    predictedInstrument: record.predictedInstrument,
    predictedDirection: record.predictedDirection,
    confidence: record.confidence,
    fundamentalScore: record.fundamentalScore,
    surpriseScore: record.surpriseScore,
    marketRegime: record.marketRegime,
    priceAtEvent: record.priceAtEvent,
    becameTrade: record.becameTrade ? 1 : 0,
  });
  return id;
}

const PRICE_COLUMNS: Record<string, string> = {
  "1m": "price_after_1m",
  "5m": "price_after_5m",
  "15m": "price_after_15m",
  "30m": "price_after_30m",
  "60m": "price_after_60m",
  "4h": "price_after_4h",
  "1d": "price_after_1d",
};

export function recordFollowUpPrice(
  learningRecordId: string,
  horizon: keyof typeof PRICE_COLUMNS,
  price: number
): void {
  const db = getDb();
  const column = PRICE_COLUMNS[horizon];
  db.prepare(`UPDATE learning_records SET ${column} = ? WHERE id = ?`).run(
    price,
    learningRecordId
  );
}

export function updateExcursions(
  learningRecordId: string,
  mfe: number,
  mae: number
): void {
  const db = getDb();
  db.prepare(
    `UPDATE learning_records SET max_favorable_excursion = ?, max_adverse_excursion = ? WHERE id = ?`
  ).run(mfe, mae, learningRecordId);
}

export function getLearningStats(): {
  totalEvents: number;
  tradedEvents: number;
  byInstrument: { instrument: string; count: number; avgConfidence: number }[];
} {
  const db = getDb();
  const totalEvents = (
    db.prepare(`SELECT COUNT(*) as c FROM learning_records`).get() as any
  ).c as number;
  const tradedEvents = (
    db.prepare(`SELECT COUNT(*) as c FROM learning_records WHERE became_trade = 1`).get() as any
  ).c as number;
  const byInstrument = db
    .prepare(
      `SELECT predicted_instrument as instrument, COUNT(*) as count, AVG(confidence) as avgConfidence
       FROM learning_records GROUP BY predicted_instrument ORDER BY count DESC`
    )
    .all() as any[];
  return { totalEvents, tradedEvents, byInstrument };
}

// ── OAuth tokens (Gmail Forex Factory alert ingestion) ────────────────────

export interface OAuthTokenRow {
  provider: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresUtc: string | null;
  connectedEmail: string | null;
  connectedAtUtc: string;
  lastHistoryId: string | null;
}

export function saveOAuthTokens(row: Omit<OAuthTokenRow, "connectedAtUtc"> & { connectedAtUtc?: string }): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO oauth_tokens (provider, refresh_token, access_token, access_token_expires_utc, connected_email, connected_at_utc, last_history_id)
     VALUES (@provider, @refreshToken, @accessToken, @accessTokenExpiresUtc, @connectedEmail, @connectedAtUtc, @lastHistoryId)
     ON CONFLICT(provider) DO UPDATE SET
       refresh_token=excluded.refresh_token, access_token=excluded.access_token,
       access_token_expires_utc=excluded.access_token_expires_utc,
       connected_email=excluded.connected_email, last_history_id=excluded.last_history_id`
  ).run({
    provider: row.provider,
    refreshToken: row.refreshToken,
    accessToken: row.accessToken,
    accessTokenExpiresUtc: row.accessTokenExpiresUtc,
    connectedEmail: row.connectedEmail,
    connectedAtUtc: row.connectedAtUtc ?? new Date().toISOString(),
    lastHistoryId: row.lastHistoryId,
  });
}

export function getOAuthTokens(provider: string): OAuthTokenRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM oauth_tokens WHERE provider = ?`).get(provider) as any;
  if (!row) return null;
  return {
    provider: row.provider,
    refreshToken: row.refresh_token,
    accessToken: row.access_token,
    accessTokenExpiresUtc: row.access_token_expires_utc,
    connectedEmail: row.connected_email,
    connectedAtUtc: row.connected_at_utc,
    lastHistoryId: row.last_history_id,
  };
}

export function updateGmailHistoryId(historyId: string): void {
  const db = getDb();
  db.prepare(`UPDATE oauth_tokens SET last_history_id = ? WHERE provider = 'gmail'`).run(historyId);
}

export function deleteOAuthTokens(provider: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM oauth_tokens WHERE provider = ?`).run(provider);
}

// ── Pre-market context snapshots ───────────────────────────────────────────

export function savePremarketSnapshot(tradingDay: string, payload: unknown): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO premarket_snapshots (id, trading_day, captured_at_utc, payload_json) VALUES (?, ?, ?, ?)`
  ).run(id, tradingDay, new Date().toISOString(), JSON.stringify(payload));
  return id;
}

export function getLatestPremarketSnapshot(tradingDay?: string): { tradingDay: string; capturedAtUtc: string; payload: any } | null {
  const db = getDb();
  const row = tradingDay
    ? (db
        .prepare(`SELECT * FROM premarket_snapshots WHERE trading_day = ? ORDER BY captured_at_utc DESC LIMIT 1`)
        .get(tradingDay) as any)
    : (db.prepare(`SELECT * FROM premarket_snapshots ORDER BY captured_at_utc DESC LIMIT 1`).get() as any);
  if (!row) return null;
  return { tradingDay: row.trading_day, capturedAtUtc: row.captured_at_utc, payload: JSON.parse(row.payload_json) };
}

// ── Learning record follow-ups (reaction tracking) ─────────────────────────

export function getAllOpenLearningRecordsForReaction(maxAgeHours = 30): {
  id: string;
  predictedInstrument: string;
  predictedDirection: "LONG" | "SHORT";
  eventTimestampUtc: string;
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
}[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
  const rows = db
    .prepare(`SELECT * FROM learning_records WHERE event_timestamp_utc > ? AND price_after_1d IS NULL ORDER BY event_timestamp_utc DESC`)
    .all(cutoff) as any[];
  return rows.map((r) => ({
    id: r.id,
    predictedInstrument: r.predicted_instrument,
    predictedDirection: r.predicted_direction,
    eventTimestampUtc: r.event_timestamp_utc,
    priceAtEvent: r.price_at_event,
    priceAfter1m: r.price_after_1m,
    priceAfter5m: r.price_after_5m,
    priceAfter15m: r.price_after_15m,
    priceAfter30m: r.price_after_30m,
    priceAfter60m: r.price_after_60m,
    priceAfter4h: r.price_after_4h,
    priceAfter1d: r.price_after_1d,
    maxFavorableExcursion: r.max_favorable_excursion,
    maxAdverseExcursion: r.max_adverse_excursion,
  }));
}

// ── Event Clock ─────────────────────────────────────────────────────────

export function saveEventClockSnapshot(params: {
  storyId: string;
  t0Utc: string;
  checkpoint: string;
  symbol: string;
  price: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO event_clock (id, story_id, t0_utc, checkpoint, symbol, price, captured_at_utc)
     VALUES (@id, @storyId, @t0Utc, @checkpoint, @symbol, @price, @capturedAtUtc)`
  ).run({
    id: `${params.storyId}:${params.checkpoint}:${params.symbol}`,
    storyId: params.storyId,
    t0Utc: params.t0Utc,
    checkpoint: params.checkpoint,
    symbol: params.symbol,
    price: params.price,
    capturedAtUtc: new Date().toISOString(),
  });
}

export interface EventClockRow {
  checkpoint: string;
  symbol: string;
  price: number;
  capturedAtUtc: string;
}

export function getEventClockForStory(storyId: string): EventClockRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT checkpoint, symbol, price, captured_at_utc FROM event_clock WHERE story_id = ? ORDER BY captured_at_utc ASC`)
    .all(storyId) as any[];
  return rows.map((r) => ({ checkpoint: r.checkpoint, symbol: r.symbol, price: r.price, capturedAtUtc: r.captured_at_utc }));
}

/** Set of "checkpoint:symbol" keys already captured for this story, so the
 * capture loop can skip live fetches it doesn't need to repeat. */
export function getCapturedCheckpointSymbols(storyId: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`SELECT checkpoint, symbol FROM event_clock WHERE story_id = ?`).all(storyId) as { checkpoint: string; symbol: string }[];
  return new Set(rows.map((r) => `${r.checkpoint}:${r.symbol}`));
}
