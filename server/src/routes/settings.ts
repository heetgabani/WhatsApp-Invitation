import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../database/db.js';

// Nirmala UI ships with Windows 10/11 and covers English, Gujarati and Hindi
const SYSTEM_FONT = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'Nirmala.ttf');
import { logger } from '../utils/logger.js';

const router = Router();

const settingsSchema = z.object({
  default_message: z.string().max(1024).optional(),
  min_interval_seconds: z.coerce.number().int().min(1).max(3600).optional(),
  max_interval_seconds: z.coerce.number().int().min(1).max(3600).optional(),
  cleanup_temp_files: z.union([z.boolean(), z.number()]).optional(),
  history_retention_days: z.coerce.number().int().min(0).max(3650).optional(),
});

/**
 * Get current settings
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;

    if (!settings) {
      return res.status(404).json({ error: 'Settings not initialized' });
    }


    res.json({
      success: true,
      settings: {
        default_message: settings.default_message,
        min_interval_seconds: settings.min_interval_seconds,
        max_interval_seconds: settings.max_interval_seconds,
        history_retention_days: settings.history_retention_days,
        cleanup_temp_files: settings.cleanup_temp_files,
        system_font_path: fs.existsSync(SYSTEM_FONT) ? SYSTEM_FONT : ''
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update settings
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }

    const db = getDb();
    const current = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;

    const effectiveMin = parsed.data.min_interval_seconds ?? current.min_interval_seconds;
    const effectiveMax = parsed.data.max_interval_seconds ?? current.max_interval_seconds;
    if (effectiveMin > effectiveMax) {
      return res.status(400).json({ error: `Minimum interval (${effectiveMin}s) cannot exceed maximum interval (${effectiveMax}s).` });
    }

    const { default_message, min_interval_seconds, max_interval_seconds, cleanup_temp_files, history_retention_days } = parsed.data;

    db.prepare(`
      UPDATE settings SET
        default_message = COALESCE(?, default_message),
        min_interval_seconds = COALESCE(?, min_interval_seconds),
        max_interval_seconds = COALESCE(?, max_interval_seconds),
        cleanup_temp_files = COALESCE(?, cleanup_temp_files),
        history_retention_days = COALESCE(?, history_retention_days),
        updated_at = ?
      WHERE id = 1
    `).run(
      default_message ?? null,
      min_interval_seconds ?? null,
      max_interval_seconds ?? null,
      cleanup_temp_files !== undefined ? (cleanup_temp_files ? 1 : 0) : null,
      history_retention_days ?? null,
      new Date().toISOString()
    );

    logger.info('system', 'Application settings updated');
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err: any) {
    logger.error('system', `Error updating settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * List templates (message and PDF layout presets)
 */
router.get('/templates', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const type = req.query.type as string;
    let templates;
    if (type) {
      templates = db.prepare('SELECT * FROM templates WHERE type = ? ORDER BY created_at DESC').all(type);
    } else {
      templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();
    }
    res.json({ success: true, templates });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Save or update template
 */
router.post('/templates', (req: Request, res: Response) => {
  try {
    const { id, name, type, content } = req.body;
    if (!name || !type || !content) {
      return res.status(400).json({ error: 'Name, type, and content are required' });
    }

    const templateId = id || `tpl_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    const now = new Date().toISOString();

    const db = getDb();
    db.prepare(`
      INSERT INTO templates (id, name, type, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(templateId, name, type, typeof content === 'object' ? JSON.stringify(content) : content, now, now);

    res.json({ success: true, templateId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete template
 */
router.delete('/templates/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

