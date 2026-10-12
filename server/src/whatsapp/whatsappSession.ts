import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../database/db.js';

/** Stable id so the same linked-device session is reused across restarts */
export const WHATSAPP_CLIENT_ID = 'invitation-sender';

/** LocalAuth stores the browser profile (the linked-device login) here. Never served over HTTP. */
export const WHATSAPP_SESSION_DIR = process.env.WIS_WHATSAPP_SESSION_DIR || path.join(DATA_DIR, 'whatsapp-session');

/** Cached WhatsApp Web build used by whatsapp-web.js (kept out of the working directory) */
export const WHATSAPP_WEB_CACHE_DIR = path.join(DATA_DIR, 'wwebjs-cache');

/** LocalAuth's profile folder for our client id */
export function getSessionProfileDir(): string {
  return path.join(WHATSAPP_SESSION_DIR, `session-${WHATSAPP_CLIENT_ID}`);
}

/** True when a linked-device session was saved earlier (it may still have been revoked from the phone) */
export function hasSavedSession(): boolean {
  return fs.existsSync(getSessionProfileDir());
}

/** Deletes the saved login. The phone keeps a stale "linked device" entry until it is removed there or expires. */
export async function deleteSavedSession(): Promise<void> {
  await fs.promises.rm(getSessionProfileDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

/**
 * Stops Chrome processes left running on OUR session profile by a previous run that was killed
 * (e.g. the console window was closed). They hold the profile lock and would block the next start.
 * Only matches browsers whose command line contains this app's session folder, and only when the
 * Node process that launched them is gone. A browser whose launcher is still alive belongs to another
 * running copy of the app and is never touched; in that case this returns { inUse: true }.
 */
export async function killOrphanedSessionBrowsers(): Promise<{ inUse: boolean }> {
  if (process.platform !== 'win32') return { inUse: false };
  const profileDir = getSessionProfileDir().replace(/'/g, "''");
  const script = [
    "$all = Get-CimInstance Win32_Process",
    // main browser processes (no --type=) running on our profile
    `$main = $all | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${profileDir}') -and $_.CommandLine -notlike '*--type=*' }`,
    "$inUse = $false",
    "foreach ($p in $main) {",
    // a browser launched by this same server process is ours (e.g. left over from a failed reconnect)
    `  $parent = $all | Where-Object { $_.ProcessId -eq $p.ParentProcessId -and $_.Name -eq 'node.exe' -and $_.ProcessId -ne ${process.pid} }`,
    "  if ($parent) { $inUse = $true } else { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
    "}",
    "if ($inUse) { 'IN_USE' } else { 'FREE' }"
  ].join('; ');
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true }, (_err, stdout) => {
      resolve({ inUse: String(stdout).includes('IN_USE') });
    });
  });
}

/**
 * True when the media-send fix (wwebjs PR #201923) is present in the installed whatsapp-web.js.
 * Without it, sending PDFs fails on current WhatsApp Web. The app pins whatsapp-web.js to a GitHub commit that includes it.
 */
export function hasMediaSendFix(): boolean {
  try {
    const utils = path.join(path.dirname(require.resolve('whatsapp-web.js/package.json')), 'src', 'util', 'Injected', 'Utils.js');
    return fs.readFileSync(utils, 'utf8').includes('delete message.__x_id');
  } catch {
    return false;
  }
}

/** Chromium for Puppeteer: an explicit path wins (e.g. system Chrome), else Puppeteer's own download */
export function getChromeExecutablePath(): string | undefined {
  return process.env.WIS_CHROME_PATH || undefined;
}
