import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path = process.env.DB_PATH ?? "data/allowance.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS policies (id INTEGER PRIMARY KEY AUTOINCREMENT, source_text TEXT NOT NULL, rules_json TEXT NOT NULL, sources_json TEXT NOT NULL, compiled_by TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, vendor TEXT NOT NULL, item TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL,
    category_guess TEXT, recurring INTEGER NOT NULL DEFAULT 0, justification TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, decision TEXT, rule TEXT, reason TEXT, classifier_json TEXT,
    paypal_order_id TEXT, capture_id TEXT, approve_url TEXT, refund_id TEXT, error TEXT, decline_reason TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER, counted_at INTEGER, captured_at INTEGER, refunded_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, intent_id TEXT);
  `);
  return db;
}
export type Db = ReturnType<typeof openDb>;

export const getSetting = (db: Db, k: string): string | null => (db.prepare("SELECT value FROM settings WHERE key=?").get(k) as any)?.value ?? null;
export const setSetting = (db: Db, k: string, v: string) => { db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); };
export const delSetting = (db: Db, k: string) => { db.prepare("DELETE FROM settings WHERE key=?").run(k); };
export const logActivity = (db: Db, kind: string, message: string, intentId?: string) => { db.prepare("INSERT INTO activity(ts,kind,message,intent_id) VALUES(?,?,?,?)").run(Date.now(), kind, message, intentId ?? null); };
