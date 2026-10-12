import fs from 'node:fs';
import path from 'node:path';
import { getDb, LOGS_DIR } from '../database/db.js';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
export type LogSource = 'queue' | 'pdf' | 'csv' | 'whatsapp' | 'system' | 'api' | 'campaign';

// WIS_LOG_DIR lets automated tests keep their output out of the real logs/app.log
const LOG_FILE = path.join(process.env.WIS_LOG_DIR || LOGS_DIR, 'app.log');

export function maskSensitiveData(input: string): string {
  if (!input) return input;
  // Mask standalone phone numbers (10 to 15 digits). Digit runs inside IDs such as
  // camp_1791793863478_ab12 are left alone so log lines stay traceable.
  let result = input.replace(/(?<![\w.])\+?(\d{4})(\d{4,9})(\d{2})(?!\w)/g, (match, head, mid, tail) => {
    return `${head}${'*'.repeat(mid.length)}${tail}`;
  });

  // Mask access tokens or bearer tokens
  result = result.replace(/Bearer\s+[A-Za-z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED_TOKEN]');
  result = result.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token": "[REDACTED_TOKEN]"');
  result = result.replace(/token=([A-Za-z0-9_\-\.]{15,})/gi, 'token=[REDACTED_TOKEN]');

  return result;
}

export function log(level: LogLevel, source: LogSource, message: string, details?: unknown): void {
  const timestamp = new Date().toISOString();
  const safeMessage = maskSensitiveData(message);
  const detailsStr = details 
    ? maskSensitiveData(typeof details === 'string' ? details : JSON.stringify(details))
    : undefined;

  // Print to console
  const consolePrefix = `[${timestamp}] [${level}] [${source.toUpperCase()}]`;
  if (level === 'ERROR') {
    console.error(consolePrefix, safeMessage, detailsStr || '');
  } else if (level === 'WARN') {
    console.warn(consolePrefix, safeMessage, detailsStr || '');
  } else {
    console.log(consolePrefix, safeMessage, detailsStr || '');
  }

  // Append to logs/app.log file
  try {
    const fileLine = `${timestamp} [${level}] [${source}] ${safeMessage}${detailsStr ? ' | ' + detailsStr : ''}\n`;
    fs.appendFileSync(LOG_FILE, fileLine, { encoding: 'utf8' });
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }

  // Insert to SQLite logs table
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO logs (timestamp, level, source, message, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(timestamp, level, source, safeMessage, detailsStr || null);
  } catch (err) {
    // Avoid recursive log errors
  }
}

export const logger = {
  info: (source: LogSource, msg: string, details?: unknown) => log('INFO', source, msg, details),
  warn: (source: LogSource, msg: string, details?: unknown) => log('WARN', source, msg, details),
  error: (source: LogSource, msg: string, details?: unknown) => log('ERROR', source, msg, details),
  debug: (source: LogSource, msg: string, details?: unknown) => log('DEBUG', source, msg, details),
};
