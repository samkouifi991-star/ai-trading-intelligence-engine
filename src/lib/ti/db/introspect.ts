import { getSql } from "./client";

/** The complete set of tables 0001_trading_intelligence_schema.sql creates
 * — used to verify the real migration state against Supabase directly,
 * rather than assuming the code that created them ran correctly. */
export const EXPECTED_TABLES = [
  "economic_events", "indicator_history", "economic_surprises",
  "news_articles", "news_analysis",
  "market_narratives", "narrative_events",
  "currency_strength",
  "market_prices", "candles", "technical_scores", "cross_market_scores", "market_reactions",
  "traders", "trader_performance", "trader_expertise", "trader_positions", "trader_consensus",
  "market_regimes",
  "trade_candidates", "trade_recommendations", "recommendation_components", "recommendation_history",
  "trade_outcomes",
  "system_weights",
  "data_sources", "ingestion_logs", "ai_analysis_logs",
  "latest_values",
] as const;

export interface TableInventoryRow {
  tableName: string;
  approxRowCount: number;
}

/** Reads Postgres's own catalog statistics (pg_stat_user_tables) rather
 * than COUNT(*) on every table — a cheap, single system-catalog query
 * instead of 29 full/index table scans. approxRowCount is Postgres's own
 * live-tuple estimate (accurate enough for "does this table exist and have
 * data," not meant as an exact count — see getExactRowCounts for that on
 * the handful of tables Phase 1 actually needs precise deltas on). */
export async function getTableInventory(): Promise<TableInventoryRow[]> {
  const sql = getSql();
  const rows = await sql<{ tableName: string; approxRowCount: number }[]>`
    SELECT relname AS table_name, n_live_tup AS approx_row_count
    FROM pg_stat_user_tables
    WHERE schemaname = 'trading_intel'
    ORDER BY relname ASC
  `;
  return rows;
}

export interface IndexInventoryRow {
  tableName: string;
  indexName: string;
}

export async function getIndexInventory(): Promise<IndexInventoryRow[]> {
  const sql = getSql();
  const rows = await sql<{ tableName: string; indexName: string }[]>`
    SELECT tablename AS table_name, indexname AS index_name
    FROM pg_indexes
    WHERE schemaname = 'trading_intel'
    ORDER BY tablename ASC, indexname ASC
  `;
  return rows;
}

export interface ConstraintInventoryRow {
  tableName: string;
  constraintName: string;
  constraintType: string;
}

export async function getConstraintInventory(): Promise<ConstraintInventoryRow[]> {
  const sql = getSql();
  const rows = await sql<{ tableName: string; constraintName: string; constraintType: string }[]>`
    SELECT tc.table_name, tc.constraint_name, tc.constraint_type
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_schema = 'trading_intel'
    ORDER BY tc.table_name ASC, tc.constraint_type ASC
  `;
  return rows;
}

const COUNTABLE_TABLES = [
  "economic_events", "indicator_history", "economic_surprises",
  "market_prices", "currency_strength", "data_sources", "ingestion_logs", "latest_values",
] as const;
export type CountableTable = (typeof COUNTABLE_TABLES)[number];

/** Exact COUNT(*) for the handful of tables Phase 1 needs precise
 * before/after ingestion deltas on — a fixed, hardcoded query per table
 * (never string-interpolating a table name into SQL) so this can never be
 * an injection vector even though the table list itself is a compile-time
 * constant. */
export async function getExactRowCounts(): Promise<Record<CountableTable, number>> {
  const sql = getSql();
  const [events, indicatorHistory, surprises, prices, strength, sources, logs, latestValues] = await Promise.all([
    sql`SELECT count(*)::int AS c FROM trading_intel.economic_events`,
    sql`SELECT count(*)::int AS c FROM trading_intel.indicator_history`,
    sql`SELECT count(*)::int AS c FROM trading_intel.economic_surprises`,
    sql`SELECT count(*)::int AS c FROM trading_intel.market_prices`,
    sql`SELECT count(*)::int AS c FROM trading_intel.currency_strength`,
    sql`SELECT count(*)::int AS c FROM trading_intel.data_sources`,
    sql`SELECT count(*)::int AS c FROM trading_intel.ingestion_logs`,
    sql`SELECT count(*)::int AS c FROM trading_intel.latest_values`,
  ]);
  return {
    economic_events: events[0].c,
    indicator_history: indicatorHistory[0].c,
    economic_surprises: surprises[0].c,
    market_prices: prices[0].c,
    currency_strength: strength[0].c,
    data_sources: sources[0].c,
    ingestion_logs: logs[0].c,
    latest_values: latestValues[0].c,
  };
}
