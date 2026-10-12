import fs from 'node:fs';
import Papa from 'papaparse';
import { logger } from '../utils/logger.js';

export interface RawContactRow {
  [key: string]: string;
}

export interface ProcessedContact {
  index: number;
  name: string;
  phone: string;
  rawPhone: string;
  isValid: boolean;
  validationError?: string;
  isDuplicate: boolean;
  selected: boolean;
  customFields: Record<string, string>;
}

export interface CsvParseResult {
  headers: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  contacts: ProcessedContact[];
  suggestedNameColumn?: string;
  suggestedPhoneColumn?: string;
}

export function sanitizePhoneNumber(phoneRaw: string): { phone: string; isValid: boolean; error?: string } {
  if (!phoneRaw || typeof phoneRaw !== 'string') {
    return { phone: '', isValid: false, error: 'Phone number is empty' };
  }

  // Remove common punctuation: spaces, hyphens, parentheses, dots
  let cleaned = phoneRaw.trim().replace(/[\s\-\(\)\.]/g, '');

  // If starts with '+', keep digits after '+'
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }

  // Only digits should remain
  if (!/^\d+$/.test(cleaned)) {
    return { phone: cleaned, isValid: false, error: 'Phone contains non-numeric characters' };
  }

  // If 10 digits (common for India / US without country code), prepend default 91 if user standard
  if (cleaned.length === 10) {
    // E.g. Indian standard mobile (starts with 6, 7, 8, 9)
    if (/^[6-9]\d{9}$/.test(cleaned)) {
      cleaned = '91' + cleaned;
    }
  }

  // International phone number length check: typically 10 to 15 digits
  if (cleaned.length < 10 || cleaned.length > 15) {
    return { 
      phone: cleaned, 
      isValid: false, 
      error: `Phone number length (${cleaned.length} digits) is invalid. Must be between 10 and 15 digits.` 
    };
  }

  return { phone: cleaned, isValid: true };
}

export function parseCsvContent(
  csvContent: string,
  nameColumn?: string,
  phoneColumn?: string
): CsvParseResult {
  // Excel's "CSV UTF-8" adds a byte-order mark that would otherwise end up in the first header name
  const parsed = Papa.parse<RawContactRow>(csvContent.charCodeAt(0) === 0xfeff ? csvContent.slice(1) : csvContent, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header: string) => header.trim()
  });

  const headers = parsed.meta.fields || [];

  // Auto-detect columns if not specified, or if the requested column is not in this file
  let detectedNameCol = nameColumn && headers.includes(nameColumn) ? nameColumn : undefined;
  let detectedPhoneCol = phoneColumn && headers.includes(phoneColumn) ? phoneColumn : undefined;

  if (!detectedNameCol) {
    detectedNameCol = headers.find(h => 
      /^(name|guest|full_?name|recipient|naam|nam)/i.test(h)
    ) || headers[1] || headers[0];
  }

  if (!detectedPhoneCol) {
    detectedPhoneCol = headers.find(h => 
      /^(phone|mobile|whatsapp|contact|tel|number|cell)/i.test(h)
    ) || headers[0];
  }

  const contacts: ProcessedContact[] = [];
  const seenPhones = new Set<string>();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  parsed.data.forEach((row, index) => {
    const rawName = (detectedNameCol ? row[detectedNameCol] : '') || '';
    const rawPhone = (detectedPhoneCol ? row[detectedPhoneCol] : '') || '';

    const name = rawName.trim();
    const phoneSanitized = sanitizePhoneNumber(rawPhone);

    let isValid = true;
    let validationError: string | undefined = undefined;

    if (!name) {
      isValid = false;
      validationError = 'Guest name is empty';
    } else if (!phoneSanitized.isValid) {
      isValid = false;
      validationError = phoneSanitized.error;
    }

    const isDuplicate = phoneSanitized.isValid && seenPhones.has(phoneSanitized.phone);
    if (isDuplicate) {
      duplicateCount++;
    } else if (phoneSanitized.isValid) {
      seenPhones.add(phoneSanitized.phone);
    }

    if (isValid && !isDuplicate) {
      validCount++;
    } else {
      invalidCount++;
    }

    // Extract custom fields (all fields except name and phone)
    const customFields: Record<string, string> = {};
    for (const key of headers) {
      if (key !== detectedNameCol && key !== detectedPhoneCol) {
        customFields[key] = (row[key] || '').trim();
      }
    }

    contacts.push({
      index,
      name,
      phone: phoneSanitized.phone,
      rawPhone,
      isValid: isValid && !isDuplicate,
      validationError: validationError || (isDuplicate ? 'Duplicate phone number' : undefined),
      isDuplicate,
      selected: isValid && !isDuplicate,
      customFields
    });
  });

  logger.info('csv', `Parsed CSV with ${contacts.length} rows (${validCount} valid, ${invalidCount} invalid/duplicate)`);

  return {
    headers,
    totalRows: contacts.length,
    validRows: validCount,
    invalidRows: invalidCount,
    duplicateRows: duplicateCount,
    contacts,
    suggestedNameColumn: detectedNameCol,
    suggestedPhoneColumn: detectedPhoneCol
  };
}

export function parseCsvFile(
  filePath: string,
  nameColumn?: string,
  phoneColumn?: string
): CsvParseResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file does not exist at path: ${filePath}`);
  }

  // Read file with UTF-8 encoding (supports Gujarati, Hindi, English, emojis)
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCsvContent(content, nameColumn, phoneColumn);
}

