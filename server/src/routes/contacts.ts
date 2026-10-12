import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parseCsvFile, parseCsvContent } from '../services/csvService.js';
import { logger } from '../utils/logger.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Parse CSV from local computer file path
 */
router.post('/parse-path', (req: Request, res: Response) => {
  const { filePath, nameColumn, phoneColumn } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  try {
    const result = parseCsvFile(filePath, nameColumn, phoneColumn);
    return res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error('csv', `Error parsing CSV from path: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Parse CSV uploaded directly via browser
 */
router.post('/parse-upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  const nameColumn = req.body.nameColumn;
  const phoneColumn = req.body.phoneColumn;

  try {
    const content = req.file.buffer.toString('utf8');
    const result = parseCsvContent(content, nameColumn, phoneColumn);
    return res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error('csv', `Error parsing uploaded CSV: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

export default router;

