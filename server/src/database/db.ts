import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Find project root
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
// WIS_DB_PATH lets automated tests use a throwaway database instead of the real one
export const DB_PATH = process.env.WIS_DB_PATH || path.join(DATA_DIR, 'database.sqlite');
export const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output', 'generated-pdfs');
export const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

// Ensure essential directories exist
export function ensureDirectories(): void {
  const dirs = [
    DATA_DIR,
    LOGS_DIR,
    OUTPUT_DIR,
    path.join(ASSETS_DIR, 'invitations'),
    path.join(ASSETS_DIR, 'fonts')
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    ensureDirectories();
    dbInstance = new DatabaseSync(DB_PATH);
    
    // Performance and safety pragmas
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    
    initSchema(dbInstance);
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore on exit
    }
    dbInstance = null;
  }
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      default_pdf_path TEXT,
      default_font_path TEXT,
      default_output_dir TEXT,
      default_message TEXT,
      default_language TEXT DEFAULT 'en',
      min_interval_seconds INTEGER DEFAULT 20,
      max_interval_seconds INTEGER DEFAULT 30,
      cleanup_temp_files INTEGER DEFAULT 0,
      history_retention_days INTEGER DEFAULT 90,
      whatsapp_provider TEXT DEFAULT 'local_web',
      whatsapp_cloud_phone_number_id TEXT DEFAULT '',
      whatsapp_cloud_access_token TEXT DEFAULT '',
      whatsapp_cloud_business_account_id TEXT DEFAULT '',
      test_mode INTEGER DEFAULT 0,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'message' or 'pdf_layout'
      content TEXT NOT NULL, -- JSON string or plain text
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL, -- 'draft', 'running', 'paused', 'completed', 'cancelled', 'failed'
      total_recipients INTEGER DEFAULT 0,
      completed_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      current_index INTEGER DEFAULT 0,
      invitation_pdf_path TEXT NOT NULL,
      font_path TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      pdf_config TEXT NOT NULL, -- JSON
      message_template TEXT NOT NULL,
      min_interval_seconds INTEGER DEFAULT 20,
      max_interval_seconds INTEGER DEFAULT 30,
      provider TEXT DEFAULT 'local_web',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      recipient_index INTEGER NOT NULL,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      raw_data TEXT, -- JSON representation of CSV row
      status TEXT NOT NULL, -- 'queued', 'accepted', 'sent', 'delivered', 'failed', 'skipped'
      generated_pdf_path TEXT,
      rendered_message TEXT,
      whatsapp_message_id TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      interval_ms INTEGER DEFAULT 0,
      sent_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL, -- 'INFO', 'WARN', 'ERROR', 'DEBUG'
      source TEXT NOT NULL, -- 'queue', 'pdf', 'csv', 'whatsapp', 'system', 'api'
      message TEXT NOT NULL,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(status);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
  `);

  // Migrations for databases created by earlier versions
  addColumnIfMissing(db, 'campaigns', 'fingerprint', 'TEXT');
  addColumnIfMissing(db, 'campaigns', 'next_eligible_at', 'TEXT');
  // 1 = the send was interrupted after the request went out, so WhatsApp may already have it
  addColumnIfMissing(db, 'campaign_recipients', 'send_uncertain', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'campaign_recipients', 'read_at', 'TEXT');
  // WhatsApp Web (QR login): display info only; the login itself lives in data/whatsapp-session
  addColumnIfMissing(db, 'settings', 'whatsapp_web_account', 'TEXT');
  addColumnIfMissing(db, 'settings', 'whatsapp_web_last_connected_at', 'TEXT');

  // Settings row with neutral defaults; no sample files, paths, or templates are seeded
  const defaultMsg = "Hello {{name}},\n\nWe are delighted to invite you to our special occasion.\nPlease find your personalized invitation attached.\n\nWe look forward to celebrating with you!";
  const existingSettings = db.prepare('SELECT id FROM settings WHERE id = 1').get();
  if (!existingSettings) {
    db.prepare(`
      INSERT INTO settings (id, default_message, min_interval_seconds, max_interval_seconds, history_retention_days, whatsapp_provider, test_mode, updated_at)
      VALUES (1, ?, 20, 30, 90, 'local_web', 0, ?)
    `).run(defaultMsg, new Date().toISOString());
  }
}

