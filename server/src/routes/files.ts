import { Router, Request, Response } from 'express';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { ASSETS_DIR, OUTPUT_DIR, PROJECT_ROOT } from '../database/db.js';
import { validateFilePath, validateDirectoryPath } from '../utils/pathValidator.js';
import { logger } from '../utils/logger.js';

const router = Router();

const VIEWABLE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

// Configure multer for local file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.query.type as string;
    let targetDir = ASSETS_DIR;
    if (type === 'font') {
      targetDir = path.join(ASSETS_DIR, 'fonts');
    } else if (type === 'invitation') {
      targetDir = path.join(ASSETS_DIR, 'invitations');
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    // Preserve original filename safely
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

/**
 * Trigger native Windows File Picker dialog via PowerShell
 */
router.post('/pick-file', async (req: Request, res: Response) => {
  const { title = 'Select File', filter = 'All files (*.*)|*.*' } = req.body;

  // Safe PowerShell command to open OpenFileDialog on Windows
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = '${title.replace(/'/g, "''")}'
    $dialog.Filter = '${filter.replace(/'/g, "''")}'
    $dialog.RestoreDirectory = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.FileName
    }
  `.trim();

  exec(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`, (err, stdout, stderr) => {
    if (err) {
      logger.warn('system', `Windows File Picker cancelled or unavailable: ${stderr || err.message}`);
      return res.json({ selectedPath: null, error: err.message });
    }
    const selected = stdout.trim();
    if (!selected) {
      return res.json({ selectedPath: null });
    }
    logger.info('system', `User selected file via Windows Explorer: ${selected}`);
    return res.json({ selectedPath: selected });
  });
});

/**
 * Trigger native Windows Folder Picker dialog via PowerShell
 */
router.post('/pick-folder', async (req: Request, res: Response) => {
  const { title = 'Select Output Directory' } = req.body;

  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '${title.replace(/'/g, "''")}'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.SelectedPath
    }
  `.trim();

  exec(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`, (err, stdout, stderr) => {
    if (err) {
      logger.warn('system', `Windows Folder Picker cancelled or unavailable: ${stderr || err.message}`);
      return res.json({ selectedPath: null, error: err.message });
    }
    const selected = stdout.trim();
    if (!selected) {
      return res.json({ selectedPath: null });
    }
    logger.info('system', `User selected directory via Windows Explorer: ${selected}`);
    return res.json({ selectedPath: selected });
  });
});

/**
 * Validate a path directly (checks existence, type, size)
 */
router.post('/validate-path', (req: Request, res: Response) => {
  const { targetPath, isDirectory = false, allowedExtensions } = req.body;

  if (isDirectory) {
    const result = validateDirectoryPath(targetPath);
    return res.json(result);
  } else {
    const result = validateFilePath(targetPath, allowedExtensions);
    return res.json(result);
  }
});

/**
 * List files available in local assets folders
 */
router.get('/assets', (req: Request, res: Response) => {
  const readDirSafe = (dir: string) => {
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        return {
          name: file,
          fullPath,
          size: stat.size,
          modified: stat.mtime
        };
      });
    } catch {
      return [];
    }
  };

  const invitations = readDirSafe(path.join(ASSETS_DIR, 'invitations'));
  const fonts = readDirSafe(path.join(ASSETS_DIR, 'fonts'));
  const languages = readDirSafe(path.join(ASSETS_DIR, 'languages'));

  res.json({
    invitations,
    fonts,
    languages,
    defaultOutputDir: OUTPUT_DIR
  });
});

/**
 * Handle file upload from browser into assets
 */
router.post('/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  logger.info('system', `Uploaded file '${req.file.originalname}' to: ${req.file.path}`);
  res.json({
    success: true,
    fileName: req.file.filename,
    filePath: req.file.path,
    size: req.file.size
  });
});

/**
 * Serve or download a local generated PDF or asset safely
 */
router.get('/view-file', (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    return res.status(400).send('Path parameter missing');
  }

  // sendFile requires an absolute path; relative paths (e.g. 'assets/...') resolve against cwd, then the project root
  let normalized = path.resolve(path.normalize(filePath));
  if (!fs.existsSync(normalized) && !path.isAbsolute(filePath)) {
    normalized = path.resolve(PROJECT_ROOT, path.normalize(filePath));
  }
  if (!fs.existsSync(normalized)) {
    return res.status(404).send('File not found');
  }

  // Only serve the asset types this app works with, never arbitrary files from disk
  const ext = path.extname(normalized).toLowerCase();
  if (!VIEWABLE_EXTENSIONS.has(ext) || !fs.statSync(normalized).isFile()) {
    return res.status(403).send('This file type cannot be viewed');
  }
  if (ext === '.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(normalized) + '"');
  }

  res.sendFile(normalized);
});

export default router;

