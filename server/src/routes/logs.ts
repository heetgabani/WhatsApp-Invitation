import { Router, Request, Response } from 'express';
import { getDb } from '../database/db.js';

const router = Router();

/**
 * Get structured logs
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const level = req.query.level as string;
    const source = req.query.source as string;
    const search = req.query.search as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    let query = 'SELECT * FROM logs WHERE 1=1';
    const params: any[] = [];

    if (level && level !== 'ALL') {
      query += ' AND level = ?';
      params.push(level);
    }

    if (source && source !== 'ALL') {
      query += ' AND source = ?';
      params.push(source);
    }

    if (search) {
      query += ' AND (message LIKE ? OR details LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = db.prepare(query).all(...params);
    res.json({ success: true, logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Clear logs
 */
router.delete('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM logs').run();
    res.json({ success: true, message: 'Logs cleared successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

