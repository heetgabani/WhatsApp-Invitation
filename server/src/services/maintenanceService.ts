import fs from 'node:fs';
import path from 'node:path';
import { getDb, OUTPUT_DIR } from '../database/db.js';
import { logger } from '../utils/logger.js';

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Sample previews younger than this are kept so a preview the user just opened is not deleted
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TEMP_FILE_PATTERN = /^Sample_Preview_.*\.pdf$/i;

let timer: NodeJS.Timeout | null = null;

export interface MaintenanceResult {
  campaignsDeleted: number;
  logsDeleted: number;
  tempFilesDeleted: number;
}

/**
 * Applies the "history retention" and "temporary file cleanup" settings.
 * Only finished campaigns are pruned; generated invitation PDFs are never deleted.
 */
export function runMaintenance(now = Date.now()): MaintenanceResult {
  const result: MaintenanceResult = { campaignsDeleted: 0, logsDeleted: 0, tempFilesDeleted: 0 };
  const db = getDb();
  const settings = db.prepare('SELECT history_retention_days, cleanup_temp_files, default_output_dir FROM settings WHERE id = 1').get() as
    | { history_retention_days: number | null; cleanup_temp_files: number; default_output_dir: string | null }
    | undefined;
  if (!settings) return result;

  const retentionDays = Number(settings.history_retention_days) || 0;
  if (retentionDays > 0) {
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      DELETE FROM campaign_recipients WHERE campaign_id IN (
        SELECT id FROM campaigns WHERE status IN ('completed', 'cancelled') AND created_at < ?
      )
    `).run(cutoff);
    result.campaignsDeleted = Number(
      db.prepare("DELETE FROM campaigns WHERE status IN ('completed', 'cancelled') AND created_at < ?").run(cutoff).changes
    );
    result.logsDeleted = Number(db.prepare('DELETE FROM logs WHERE timestamp < ?').run(cutoff).changes);
  }

  if (settings.cleanup_temp_files) {
    const dirs = new Set([OUTPUT_DIR, settings.default_output_dir].filter(Boolean).map(d => path.resolve(d as string)));
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!TEMP_FILE_PATTERN.test(file)) continue;
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile() && now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
            fs.unlinkSync(full);
            result.tempFilesDeleted++;
          }
        } catch {
          // file in use or already gone; try again next run
        }
      }
    }
  }

  if (result.campaignsDeleted || result.logsDeleted || result.tempFilesDeleted) {
    logger.info(
      'system',
      `Maintenance: removed ${result.campaignsDeleted} old campaign(s), ${result.logsDeleted} old log entries, ${result.tempFilesDeleted} temporary preview PDF(s).`
    );
  }
  return result;
}

export function startMaintenance(): void {
  const safeRun = () => {
    try {
      runMaintenance();
    } catch (err: any) {
      logger.error('system', `Maintenance failed: ${err.message}`);
    }
  };
  safeRun();
  timer = setInterval(safeRun, MAINTENANCE_INTERVAL_MS);
  timer.unref();
}

export function stopMaintenance(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
