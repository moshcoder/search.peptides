import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/**
 * One SQLite file. vendors, offers (one row per product size a vendor lists),
 * lab tests and per-peptide ratings come from the sync; vendor_contacts from enrich.js
 * (a sync never touches it); sponsors and meta are ours.
 */
let db = null;

export function open(path = config.dbPath) {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function close() {
  db?.close();
  db = null;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      shop_url TEXT,
      location TEXT,
      country TEXT,
      score INTEGER,
      rank INTEGER,
      tests INTEGER NOT NULL DEFAULT 0,
      tests_pass INTEGER NOT NULL DEFAULT 0,
      tests_fail INTEGER NOT NULL DEFAULT 0,
      latest_test TEXT,
      cost_per_mg REAL,
      ordering TEXT,
      ordering_evidence TEXT,
      payments TEXT NOT NULL DEFAULT '[]',
      payments_raw TEXT NOT NULL DEFAULT '[]',
      ships_from TEXT NOT NULL DEFAULT '[]',
      ships_to TEXT,
      shipping TEXT NOT NULL DEFAULT '[]',
      min_order TEXT,
      discounts TEXT NOT NULL DEFAULT '[]',
      coupons TEXT NOT NULL DEFAULT '[]',
      contacts TEXT NOT NULL DEFAULT '[]',
      terms_source TEXT,
      notes TEXT,
      offers INTEGER NOT NULL DEFAULT 0,
      peptides INTEGER NOT NULL DEFAULT 0,
      min_usd_per_mg REAL,
      checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY,
      vendor TEXT NOT NULL,
      peptide TEXT NOT NULL,
      peptide_slug TEXT NOT NULL,
      name TEXT,
      form TEXT,
      unit TEXT,
      amount REAL,
      pack_qty INTEGER,
      price REAL,
      currency TEXT,
      price_usd REAL,
      total_mg REAL,
      usd_per_mg REAL,
      usd_per_unit REAL,
      in_stock INTEGER,
      url TEXT,
      blend TEXT
    );
    CREATE INDEX IF NOT EXISTS offers_vendor ON offers(vendor);
    CREATE INDEX IF NOT EXISTS offers_peptide ON offers(peptide_slug);
    CREATE TABLE IF NOT EXISTS lab_tests (
      vendor TEXT NOT NULL,
      peptide TEXT NOT NULL,
      peptide_slug TEXT NOT NULL,
      tested_on TEXT,
      result TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lab_tests_vendor ON lab_tests(vendor);
    CREATE INDEX IF NOT EXISTS lab_tests_peptide ON lab_tests(peptide_slug);
    CREATE TABLE IF NOT EXISTS ratings (
      vendor TEXT NOT NULL,
      peptide TEXT NOT NULL,
      peptide_slug TEXT NOT NULL,
      rating INTEGER,
      n_tests INTEGER,
      cost_per_mg REAL
    );
    CREATE INDEX IF NOT EXISTS ratings_peptide ON ratings(peptide_slug);
    CREATE TABLE IF NOT EXISTS sponsors (
      ref TEXT PRIMARY KEY,
      vendor TEXT NOT NULL,
      email TEXT,
      usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      paid_at TEXT,
      until TEXT
    );
    CREATE TABLE IF NOT EXISTS vendor_contacts (
      vendor TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT,
      found_at TEXT NOT NULL,
      PRIMARY KEY (vendor, kind, value)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

export function getMeta(key) {
  return open().query('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  open()
    .query('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
