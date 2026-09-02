import postgres from "postgres";

/**
 * The trading-intelligence schema's Postgres connection — a real network
 * DB (the user's existing Supabase project), never SQLite/local files. All
 * queries target the `trading_intel` schema exclusively; nothing here ever
 * reads or writes any other schema in this database, so it can safely share
 * a Supabase project with other applications' tables.
 *
 * Throws DatabaseUnconfiguredError immediately (not a lazy silent failure)
 * when DATABASE_URL is unset — per spec rule "never fabricate missing
 * data," a missing DB connection must surface as DATA UNAVAILABLE, not an
 * empty-looking success.
 */
export class DatabaseUnconfiguredError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set. The trading-intelligence engine requires a real Postgres connection " +
        "(your Supabase project's connection string, e.g. from Project Settings -> Database -> Connection string, " +
        "the 'Transaction' pooler URI on port 6543 for serverless use). See .env.example."
    );
    this.name = "DatabaseUnconfiguredError";
  }
}

let instance: ReturnType<typeof postgres> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new DatabaseUnconfiguredError();

  instance = postgres(url, {
    // Serverless-friendly: a handful of connections per warm instance, closed
    // eagerly rather than held open indefinitely — Supabase's pooler (and the
    // project's own connection cap) is shared with any other app on this
    // project, so this deliberately stays small.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required for Supabase's transaction-mode pooler (port 6543)
    transform: postgres.camel, // snake_case columns -> camelCase JS properties
  });
  return instance;
}
