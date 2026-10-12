import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PdfService, sanitizeFilename } from '../src/services/pdfService.js';
import { ensureDirectories } from '../src/database/db.js';
import { TEMPLATE_PDF, INDIC_FONT } from './fixtures.js';

describe('PDF Service & Personalization Engine', () => {
  const samplePdf = TEMPLATE_PDF;
  const indicFont = INDIC_FONT;
  const testOutDir = path.join(os.tmpdir(), 'wis-test-output');

  beforeAll(() => {
    ensureDirectories();
    if (!fs.existsSync(testOutDir)) {
      fs.mkdirSync(testOutDir, { recursive: true });
    }
  });

  it('should inspect page count and dimensions of template PDF', async () => {
    expect(fs.existsSync(samplePdf)).toBe(true);

    const inspection = await PdfService.inspectPdf(samplePdf);
    expect(inspection.pageCount).toBeGreaterThanOrEqual(1);
    expect(inspection.dimensions.length).toBe(inspection.pageCount);
    expect(inspection.dimensions[0].width).toBe(595);
    expect(inspection.dimensions[0].height).toBe(842);
  });

  it('should validate font and detect Indic glyph capability', async () => {
    expect(fs.existsSync(indicFont)).toBe(true);

    const fontValidation = await PdfService.validateFont(indicFont);
    expect(fontValidation.valid).toBe(true);
    expect(fontValidation.indicSupport).toBe(true);
  });

  it('should personalize PDF without corrupting or overwriting original file', async () => {
    const originalBytesBefore = fs.readFileSync(samplePdf);
    const guestName = 'પ્રિયા પટેલ (Priya Patel)';
    const outPdf = path.join(testOutDir, 'Test_Priya_Patel.pdf');

    const result = await PdfService.personalizePdf({
      templatePdfPath: samplePdf,
      fontPath: indicFont,
      guestName,
      config: {
        x: 297,
        y: 610,
        size: 24,
        colorHex: '#73141E',
        prefix: 'સ્નેહી શ્રી ',
        align: 'center',
        pageNumber: 1
      },
      outputPath: outPdf
    });

    // Check generated file exists and has content
    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.fileSize).toBeGreaterThan(1000);

    // Strict non-overwrite guarantee
    const originalBytesAfter = fs.readFileSync(samplePdf);
    expect(originalBytesBefore.equals(originalBytesAfter)).toBe(true);
  });

  it('should sanitize special characters in file names safely', () => {
    expect(sanitizeFilename('Rahul / Shah : Special * ?')).toBe('Rahul_Shah_Special');
    expect(sanitizeFilename('Dr. Aarav Mehta')).toBe('Dr._Aarav_Mehta');
    expect(sanitizeFilename('   ')).toBe('Guest');
  });
});
