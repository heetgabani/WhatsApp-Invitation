import 'regenerator-runtime/runtime';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb, RGB, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { logger } from '../utils/logger.js';
import { validateFilePath } from '../utils/pathValidator.js';

export interface PdfOverlayConfig {
  x: number;
  y: number;
  size: number;
  colorHex: string;
  prefix?: string;
  suffix?: string;
  align?: 'left' | 'center' | 'right';
  pageNumber?: number; // 1-indexed
  fieldName?: string;
  // Optional per-script fonts; used instead of the main font when the text contains that script
  languageFonts?: {
    gujarati?: string;
    devanagari?: string;
  };
}

export interface PdfInspectionResult {
  pageCount: number;
  dimensions: {
    pageNumber: number;
    width: number;
    height: number;
  }[];
  fileSizeBytes: number;
}

export interface FontValidationResult {
  valid: boolean;
  fontFamily?: string;
  format?: string;
  error?: string;
  indicSupport?: boolean;
  gujaratiSupport?: boolean;
  devanagariSupport?: boolean;
}

const GUJARATI_RANGE = /[઀-૿]/;
const DEVANAGARI_RANGE = /[ऀ-ॿ]/;
const GUJARATI_SAMPLE = 'સ્નેહી શ્રી પ્રિયા પટેલ ભાવિન જોશી';
const DEVANAGARI_SAMPLE = 'सादर सप्रेम आरव मेहता अंजलि शर्मा';
// Joiners shape conjuncts but have no glyph of their own
const IGNORABLE_CODEPOINTS = new Set([0x200c, 0x200d, 0xfe0f]);

/**
 * Returns the characters in `text` that the font has no glyph for (rendered as empty boxes otherwise)
 */
export function findMissingGlyphs(font: PDFFont, text: string): string[] {
  const supported = new Set(font.getCharacterSet());
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (/\s/.test(ch) || IGNORABLE_CODEPOINTS.has(cp)) continue;
    if (!supported.has(cp)) missing.add(ch);
  }
  return [...missing];
}

/**
 * Picks the language-specific font for text in Gujarati / Devanagari script, else the main font
 */
export function pickFontPathForText(text: string, mainFontPath: string, languageFonts?: PdfOverlayConfig['languageFonts']): string {
  if (languageFonts?.gujarati && GUJARATI_RANGE.test(text)) return languageFonts.gujarati;
  if (languageFonts?.devanagari && DEVANAGARI_RANGE.test(text)) return languageFonts.devanagari;
  return mainFontPath;
}

/**
 * Converts Hex color string (#RRGGBB or #RGB) to pdf-lib RGB object
 */
export function hexToRgb(hex: string): RGB {
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map(c => c + c).join('');
  }
  if (clean.length !== 6) {
    return rgb(0.1, 0.1, 0.1); // default dark
  }
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return rgb(r, g, b);
}

/**
 * Clean a string for use in safe file names
 */
export function sanitizeFilename(str: string): string {
  // Replace illegal filename chars: \ / : * ? " < > |
  const cleaned = str
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim();
  return cleaned || 'Guest';
}

export class PdfService {
  /**
   * Inspect basic PDF properties such as page count and dimensions
   */
  static async inspectPdf(pdfPath: string): Promise<PdfInspectionResult> {
    const val = validateFilePath(pdfPath, ['.pdf']);
    if (!val.valid) {
      throw new Error(val.error);
    }

    const pdfBytes = fs.readFileSync(val.normalizedPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();
    const dimensions = [];

    for (let i = 0; i < pageCount; i++) {
      const page = pdfDoc.getPage(i);
      const { width, height } = page.getSize();
      dimensions.push({
        pageNumber: i + 1,
        width: Math.round(width),
        height: Math.round(height)
      });
    }

    return {
      pageCount,
      dimensions,
      fileSizeBytes: val.sizeBytes || pdfBytes.length
    };
  }

  /**
   * Validate custom font file and test glyph embedding
   */
  static async validateFont(fontPath: string): Promise<FontValidationResult> {
    const val = validateFilePath(fontPath, ['.ttf', '.otf']);
    if (!val.valid) {
      return { valid: false, error: val.error };
    }

    try {
      const fontBytes = fs.readFileSync(val.normalizedPath);
      const testDoc = await PDFDocument.create();
      testDoc.registerFontkit(fontkit);
      
      const customFont = await testDoc.embedFont(fontBytes);
      const page = testDoc.addPage([200, 100]);

      // Test standard English
      page.drawText('Sample Guest', { x: 10, y: 50, size: 14, font: customFont });

      // Check real glyph coverage: drawText does not throw for missing glyphs, it draws empty boxes
      const gujaratiSupport = findMissingGlyphs(customFont, GUJARATI_SAMPLE).length === 0;
      const devanagariSupport = findMissingGlyphs(customFont, DEVANAGARI_SAMPLE).length === 0;
      if (gujaratiSupport) page.drawText(GUJARATI_SAMPLE, { x: 10, y: 30, size: 14, font: customFont });
      if (devanagariSupport) page.drawText(DEVANAGARI_SAMPLE, { x: 10, y: 10, size: 14, font: customFont });
      if (!gujaratiSupport || !devanagariSupport) {
        logger.warn('pdf', `Font lacks ${[!gujaratiSupport && 'Gujarati', !devanagariSupport && 'Hindi'].filter(Boolean).join(' and ')} glyphs: ${path.basename(fontPath)}`);
      }

      await testDoc.save();

      return {
        valid: true,
        fontFamily: customFont.name,
        indicSupport: gujaratiSupport && devanagariSupport,
        gujaratiSupport,
        devanagariSupport
      };
    } catch (err: any) {
      return {
        valid: false,
        error: `Failed to load font: ${err.message}`
      };
    }
  }

  /**
   * Generate a single personalized PDF from template
   */
  static async personalizePdf(options: {
    templatePdfPath: string;
    fontPath: string;
    guestName: string;
    config: PdfOverlayConfig;
    outputPath: string;
  }): Promise<{ outputPath: string; fileSize: number }> {
    const { templatePdfPath, fontPath, guestName, config, outputPath } = options;

    if (!fs.existsSync(templatePdfPath)) {
      throw new Error(`Template PDF does not exist at: ${templatePdfPath}`);
    }
    // Prepare text to render
    const prefix = config.prefix || '';
    const suffix = config.suffix || '';
    const fullText = `${prefix}${guestName}${suffix}`.trim();

    const effectiveFontPath = pickFontPathForText(fullText, fontPath, config.languageFonts);
    if (!fs.existsSync(effectiveFontPath)) {
      throw new Error(`Font file does not exist at: ${effectiveFontPath}`);
    }

    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Load original template PDF
    const templateBytes = fs.readFileSync(templatePdfPath);
    const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
    pdfDoc.registerFontkit(fontkit);

    // Embed custom font
    const fontBytes = fs.readFileSync(effectiveFontPath);
    const customFont = await pdfDoc.embedFont(fontBytes, { subset: true });

    // Refuse to produce an invitation with empty boxes instead of the guest's name
    const missing = findMissingGlyphs(customFont, fullText);
    if (missing.length > 0) {
      throw new Error(
        `Font '${path.basename(effectiveFontPath)}' has no glyphs for "${missing.join(' ')}" in "${fullText}". Choose a font that supports this language.`
      );
    }

    // Target page (1-indexed)
    const targetPageIndex = (config.pageNumber || 1) - 1;
    const totalPages = pdfDoc.getPageCount();
    if (targetPageIndex < 0 || targetPageIndex >= totalPages) {
      throw new Error(`Specified page number ${config.pageNumber} is out of bounds (1 to ${totalPages})`);
    }

    const page = pdfDoc.getPage(targetPageIndex);
    const { width: pageWidth } = page.getSize();

    const fontSize = config.size || 24;
    const fontColor = hexToRgb(config.colorHex || '#000000');

    // Calculate alignment
    let drawX = config.x;
    const drawY = config.y;

    if (config.align === 'center') {
      const textWidth = customFont.widthOfTextAtSize(fullText, fontSize);
      // If config.x is close to middle or 0, center across the page or about config.x
      drawX = config.x - textWidth / 2;
    } else if (config.align === 'right') {
      const textWidth = customFont.widthOfTextAtSize(fullText, fontSize);
      drawX = config.x - textWidth;
    }

    // Draw personalized name onto page
    page.drawText(fullText, {
      x: Math.max(10, drawX),
      y: drawY,
      size: fontSize,
      font: customFont,
      color: fontColor
    });

    // Save personalized PDF
    const outputBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, outputBytes);

    logger.info('pdf', `Generated personalized PDF for '${guestName}': ${path.basename(outputPath)} (${outputBytes.length} bytes)`);

    return {
      outputPath,
      fileSize: outputBytes.length
    };
  }

  /**
   * Generates a sample preview PDF in output directory
   */
  static async generateSamplePreview(
    templatePdfPath: string,
    fontPath: string,
    sampleName: string,
    config: PdfOverlayConfig,
    outputDir: string
  ): Promise<string> {
    const filename = `Sample_Preview_${sanitizeFilename(sampleName)}.pdf`;
    const outputPath = path.join(outputDir, filename);

    await this.personalizePdf({
      templatePdfPath,
      fontPath,
      guestName: sampleName,
      config,
      outputPath
    });

    return outputPath;
  }
}
