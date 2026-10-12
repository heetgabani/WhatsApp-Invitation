import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/** Template PDF generated for tests (A4, 595 x 842 pt); the app itself ships no sample invitation */
export const TEMPLATE_PDF = path.join(os.tmpdir(), 'wis-test-fixtures', 'Template.pdf');

/** Windows system fonts: Nirmala UI covers Latin, Gujarati and Devanagari; Arial is Latin-only */
export const INDIC_FONT = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'Nirmala.ttf');
export const LATIN_ONLY_FONT = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf');

export async function ensureFixtures(): Promise<void> {
  if (fs.existsSync(TEMPLATE_PDF)) return;
  fs.mkdirSync(path.dirname(TEMPLATE_PDF), { recursive: true });
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Test Invitation', { x: 200, y: 700, size: 24, font });
  fs.writeFileSync(TEMPLATE_PDF, await doc.save());
}
