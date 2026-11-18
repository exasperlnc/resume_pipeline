import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const SCHEMA_PATH = fileURLToPath(new URL("../schema.sql", import.meta.url));

export const DEFAULT_DB_PATH = process.env.JOBS_DB ?? "jobs.db";

/** Open the database, creating tables from schema.sql if it is empty. */
export function openDb(path: string = DEFAULT_DB_PATH): DB {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  const hasSchema = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'postings'")
    .get();
  if (!hasSchema) db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

/** Timestamp in the same format SQLite's datetime('now') produces (UTC). */
export function sqliteNow(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Convert an ISO-8601 string with any offset to SQLite UTC format, or null. */
export function toSqliteTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : sqliteNow(d);
}
