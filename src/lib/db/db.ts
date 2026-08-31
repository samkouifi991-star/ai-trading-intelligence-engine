import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

let instance: Database.Database | null = null;

function resolveDbPath(): string {
  const configured = process.env.TRADING_DB_PATH || "./data/trading.db";
  const resolved = path.isAbsolute(configured)
    ? configured
    : path.join(process.cwd(), configured);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

export function getDb(): Database.Database {
  if (instance) return instance;
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = fs.readFileSync(
    path.join(process.cwd(), "src/lib/db/schema.sql"),
    "utf-8"
  );
  db.exec(schema);
  instance = db;
  return instance;
}
