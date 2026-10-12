import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.ttf',
  '.otf',
  '.woff',
  '.png',
  '.jpg',
  '.jpeg',
  '.json',
  '.csv'
]);

export interface ValidationResult {
  valid: boolean;
  normalizedPath: string;
  error?: string;
  sizeBytes?: number;
  isDirectory?: boolean;
}

export function validateFilePath(inputPath: string, allowedExts?: string[]): ValidationResult {
  if (!inputPath || typeof inputPath !== 'string') {
    return { valid: false, normalizedPath: '', error: 'Path cannot be empty' };
  }

  const trimmed = inputPath.trim();
  const normalized = path.normalize(trimmed);

  try {
    if (!fs.existsSync(normalized)) {
      return { valid: false, normalizedPath: normalized, error: `File not found: ${normalized}` };
    }

    const stat = fs.statSync(normalized);
    if (!stat.isFile()) {
      return { valid: false, normalizedPath: normalized, error: `Path is not a regular file: ${normalized}` };
    }

    const ext = path.extname(normalized).toLowerCase();
    const effectiveAllowed = allowedExts ? new Set(allowedExts.map(e => e.toLowerCase())) : ALLOWED_EXTENSIONS;

    if (!effectiveAllowed.has(ext)) {
      return { 
        valid: false, 
        normalizedPath: normalized, 
        error: `File extension '${ext}' is not permitted. Permitted: ${Array.from(effectiveAllowed).join(', ')}` 
      };
    }

    return {
      valid: true,
      normalizedPath: normalized,
      sizeBytes: stat.size,
      isDirectory: false
    };
  } catch (err: any) {
    return { valid: false, normalizedPath: normalized, error: err.message || 'File validation error' };
  }
}

export function validateDirectoryPath(inputPath: string, createIfMissing = false): ValidationResult {
  if (!inputPath || typeof inputPath !== 'string') {
    return { valid: false, normalizedPath: '', error: 'Directory path cannot be empty' };
  }

  const trimmed = inputPath.trim();
  const normalized = path.normalize(trimmed);

  try {
    if (!fs.existsSync(normalized)) {
      if (createIfMissing) {
        fs.mkdirSync(normalized, { recursive: true });
      } else {
        return { valid: false, normalizedPath: normalized, error: `Directory does not exist: ${normalized}` };
      }
    }

    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return { valid: false, normalizedPath: normalized, error: `Path is not a directory: ${normalized}` };
    }

    return {
      valid: true,
      normalizedPath: normalized,
      isDirectory: true
    };
  } catch (err: any) {
    return { valid: false, normalizedPath: normalized, error: err.message || 'Directory validation error' };
  }
}

