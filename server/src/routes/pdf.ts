import { Router, Request, Response } from 'express';
import { PdfService } from '../services/pdfService.js';
import { logger } from '../utils/logger.js';
import { OUTPUT_DIR } from '../database/db.js';

const router = Router();

/**
 * Inspect PDF page count and dimensions
 */
router.post('/inspect', async (req: Request, res: Response) => {
  const { pdfPath } = req.body;
  if (!pdfPath) {
    return res.status(400).json({ error: 'pdfPath is required' });
  }

  try {
    const inspection = await PdfService.inspectPdf(pdfPath);
    return res.json({ success: true, ...inspection });
  } catch (err: any) {
    logger.error('pdf', `Failed to inspect PDF: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Validate font file
 */
router.post('/validate-font', async (req: Request, res: Response) => {
  const { fontPath } = req.body;
  if (!fontPath) {
    return res.status(400).json({ error: 'fontPath is required' });
  }

  try {
    const result = await PdfService.validateFont(fontPath);
    return res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error('pdf', `Font validation error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Generate test preview PDF with given configuration
 */
router.post('/generate-preview', async (req: Request, res: Response) => {
  const { templatePdfPath, fontPath, sampleName, config, outputDir } = req.body;

  if (!templatePdfPath || !fontPath || !sampleName || !config) {
    return res.status(400).json({ error: 'Missing required parameters for preview generation' });
  }

  try {
    const targetOutDir = outputDir || OUTPUT_DIR;
    const generatedPath = await PdfService.generateSamplePreview(
      templatePdfPath,
      fontPath,
      sampleName,
      config,
      targetOutDir
    );

    return res.json({
      success: true,
      previewPdfPath: generatedPath,
      viewUrl: `/api/files/view-file?path=${encodeURIComponent(generatedPath)}`
    });
  } catch (err: any) {
    logger.error('pdf', `Failed to generate sample preview PDF: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

export default router;

