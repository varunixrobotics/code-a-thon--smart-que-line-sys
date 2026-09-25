'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL,
  password_hash   TEXT,
  google_sub      TEXT UNIQUE,
  totp_secret_enc TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  INTEGER NOT NULL DEFAULT 0,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','staff','admin','system')),
  strikes         INTEGER NOT NULL DEFAULT 0,
  blocked_until   INTEGER,
  org_id          INTEGER, -- staff only: the single organisation they may operate
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_ok     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS organizations (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('government','hospital','corporate','bank')),
  address      TEXT NOT NULL,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  radius_m     INTEGER NOT NULL DEFAULT 150,
  open_min     INTEGER NOT NULL,
  close_min    INTEGER NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS services (
  id              INTEGER PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  code            TEXT NOT NULL,
  slot_capacity   INTEGER NOT NULL DEFAULT 4,
  avg_service_min INTEGER NOT NULL DEFAULT 6
);

CREATE TABLE IF NOT EXISTS counters (
  id                 INTEGER PRIMARY KEY,
  org_id             INTEGER NOT NULL REFERENCES organizations(id),
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused','closed')),
  current_booking_id INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  org_id          INTEGER NOT NULL REFERENCES organizations(id),
  service_id      INTEGER NOT NULL REFERENCES services(id),
  date            TEXT NOT NULL,
  slot_index      INTEGER NOT NULL,
  seat            INTEGER NOT NULL,
  token_no        INTEGER NOT NULL,
  token_code      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('appointment','walkin')),
  status          TEXT NOT NULL CHECK (status IN ('booked','checked_in','called','done','no_show','cancelled')),
  counter_id      INTEGER,
  deferrals       INTEGER NOT NULL DEFAULT 0,
  reschedules     INTEGER NOT NULL DEFAULT 0,
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  away_since      INTEGER,
  last_distance_m REAL,
  last_seen_at    INTEGER,
  created_at      INTEGER NOT NULL,
  checked_in_at   INTEGER,
  called_at       INTEGER,
  completed_at    INTEGER
);
-- A seat in a slot can only be held by one live booking: this is the
-- database-level guarantee against double-issuing a token under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_seat
  ON bookings(service_id, date, slot_index, seat)
  WHERE status NOT IN ('cancelled','no_show');
CREATE INDEX IF NOT EXISTS ix_bookings_day ON bookings(org_id, date, status);
CREATE INDEX IF NOT EXISTS ix_bookings_user ON bookings(user_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id INTEGER,
  type       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  id         INTEGER PRIMARY KEY,
  action     TEXT NOT NULL,
  ip         TEXT,
  score      REAL,
  verdict    TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  reasons    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_risk_created ON risk_events(created_at);
`;

function openDb(file) {
  let db;
  try {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
  } catch (err) {
    console.warn(`[db] Failed to open database at ${file} (${err.message}), falling back to :memory:`);
    db = new DatabaseSync(':memory:');
  }

  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // WAL mode not supported in some serverless/containerized environments
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive column migrations and index creations for existing databases. */
function migrate(db) {
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userCols.has('org_id')) db.exec('ALTER TABLE users ADD COLUMN org_id INTEGER');

  // Safely clean up any duplicate active bookings before creating the unique index
  try {
    db.exec(`
      UPDATE bookings
      SET status = 'cancelled'
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM bookings
        WHERE status IN ('booked','checked_in','called')
        GROUP BY user_id, org_id
      )
      AND status IN ('booked','checked_in','called');
    `);
  } catch {}

  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_user_org_live ON bookings(user_id, org_id) WHERE status IN ('booked','checked_in','called')");
  } catch (err) {
    console.warn('[db migrate ux_bookings_user_org_live error]', err.message);
  }
}

const stmtCache = new WeakMap();

/** Prepared-statement cache: each SQL string is compiled once per connection. */
function stmt(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/**
 * Run fn inside an IMMEDIATE transaction (takes the write lock up front, so
 * concurrent writers from other processes queue instead of interleaving).
 * Nested calls join the outer transaction.
 */
function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, stmt, tx };
