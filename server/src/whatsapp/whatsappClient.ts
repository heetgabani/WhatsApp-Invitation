import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import type { ClientOptions } from 'whatsapp-web.js';
import { getDb } from '../database/db.js';
import { logger, maskSensitiveData } from '../utils/logger.js';
import {
  WHATSAPP_CLIENT_ID,
  WHATSAPP_SESSION_DIR,
  WHATSAPP_WEB_CACHE_DIR,
  getChromeExecutablePath,
  hasSavedSession,
  deleteSavedSession,
  killOrphanedSessionBrowsers,
  hasMediaSendFix
} from './whatsappSession.js';

export type WhatsAppConnectionState =
  | 'idle'
  | 'initializing'
  | 'qr'
  | 'authenticating'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth_failure';

export interface WhatsAppConnectionStatus {
  state: WhatsAppConnectionState;
  /** PNG data URL of the current QR code; only set while waiting for a scan */
  qrDataUrl: string | null;
  account: { name: string; phoneMasked: string; platform: string } | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  loadingPercent: number | null;
  reconnectAttempt: number;
  hasSavedSession: boolean;
}

/** The subset of the whatsapp-web.js Client this app uses (lets tests inject a fake) */
export interface WhatsAppClientLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  getNumberId(number: string): Promise<{ _serialized: string } | null>;
  sendMessage(chatId: string, content: any, options?: Record<string, unknown>): Promise<{ id: { _serialized: string }; ack?: number }>;
  info?: { wid?: { user: string }; pushname?: string; platform?: string };
  /** Puppeteer objects exposed by whatsapp-web.js; used to notice when the hidden browser dies */
  pupBrowser?: { on(event: string, listener: () => void): unknown } | null;
  pupPage?: { on(event: string, listener: (...args: any[]) => void): unknown; mainFrame?(): unknown } | null;
}

export type WhatsAppClientFactory = (options: ClientOptions) => WhatsAppClientLike;

/** Thrown when the recipient has no WhatsApp account */
export class WhatsAppNumberNotFoundError extends Error {}
/** Thrown when sending is attempted while not connected */
export class WhatsAppNotReadyError extends Error {}
/**
 * Thrown when the browser/page died during a send. mayHaveSent is true when it happened during
 * the send call itself, so the message might have gone out.
 */
export class WhatsAppConnectionLostError extends Error {
  constructor(message: string, public mayHaveSent: boolean) {
    super(message);
  }
}

/** Puppeteer errors that mean the WhatsApp Web page/browser is gone, not that this message is bad */
export function isConnectionLostError(err: unknown): boolean {
  const msg = String((err as any)?.message || err);
  return /detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|Connection closed|browser has disconnected|Navigating frame was detached/i.test(msg);
}

const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000];

// whatsapp-web.js MessageAck values
const ACK_ERROR = -1;
const ACK_SERVER = 1;
const ACK_DEVICE = 2;
const ACK_READ = 3;

/**
 * Options for the one shared client. LocalAuth keeps the linked-device login under
 * data/whatsapp-session/session-invitation-sender so a restart does not need a new QR scan.
 */
export function buildClientOptions(): ClientOptions {
  const executablePath = getChromeExecutablePath();
  return {
    authStrategy: new LocalAuth({ clientId: WHATSAPP_CLIENT_ID, dataPath: WHATSAPP_SESSION_DIR }),
    webVersionCache: { type: 'local', path: WHATSAPP_WEB_CACHE_DIR },
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  };
}

function maskPhone(digits: string): string {
  return digits.length > 6 ? `${digits.slice(0, 4)}${'*'.repeat(digits.length - 6)}${digits.slice(-2)}` : digits;
}

/** Turns library/Puppeteer errors into something actionable, without leaking paths of the session profile */
function describeStartupError(err: any): string {
  const msg = String(err?.message || err);
  if (/already running|SingletonLock|ProcessSingleton|user data directory is already in use/i.test(msg)) {
    return 'The WhatsApp session is in use by another running copy of this app. Close the other copy (e.g. `npm run dev` and `npm run start` at the same time), then reconnect.';
  }
  if (/Could not find (Chrome|expected browser)|Browser was not found|executablePath/i.test(msg)) {
    return 'Chromium for WhatsApp Web was not found. Run `npx puppeteer browsers install chrome` in the project folder, or set WIS_CHROME_PATH in .env to your Chrome.exe.';
  }
  return maskSensitiveData(msg.replace(/[A-Z]:\\[^\s'"]+/gi, '<path>'));
}

/**
 * The single WhatsApp Web client for the whole backend. Pages never create clients;
 * they read the status and receive live updates (SSE) from this manager.
 */
export class WhatsAppWebManager extends EventEmitter {
  private client: WhatsAppClientLike | null = null;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  private status: WhatsAppConnectionStatus = {
    state: 'idle',
    qrDataUrl: null,
    account: null,
    lastConnectedAt: null,
    lastError: null,
    loadingPercent: null,
    reconnectAttempt: 0,
    hasSavedSession: false
  };

  constructor(
    private clientFactory: WhatsAppClientFactory = options => new Client(options) as unknown as WhatsAppClientLike,
    private killOrphans: () => Promise<{ inUse: boolean }> = killOrphanedSessionBrowsers
  ) {
    super();
    this.setMaxListeners(50);
  }

  /** Tests swap in a fake client */
  setClientFactory(factory: WhatsAppClientFactory): void {
    this.clientFactory = factory;
  }

  getStatus(): WhatsAppConnectionStatus {
    const saved = this.readSavedInfo();
    return {
      ...this.status,
      lastConnectedAt: this.status.lastConnectedAt || saved.lastConnectedAt,
      account: this.status.account || (this.status.state === 'connected' ? null : saved.account),
      hasSavedSession: hasSavedSession()
    };
  }

  isReady(): boolean {
    return this.status.state === 'connected' && this.client !== null;
  }

  /**
   * Starts the client once. Repeated calls while starting or connected are no-ops,
   * so opening pages or double clicks never launch a second browser on the same profile.
   */
  async connect(): Promise<WhatsAppConnectionStatus> {
    this.stopping = false;
    if (this.client || this.startPromise) {
      return this.getStatus();
    }
    this.clearReconnectTimer();
    this.startPromise = this.startClient().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
    return this.getStatus();
  }

  /** Restart the client, reusing the saved session (no new QR unless the session is invalid) */
  async reconnect(): Promise<WhatsAppConnectionStatus> {
    this.clearReconnectTimer();
    this.update({ reconnectAttempt: 0 });
    await this.destroyClient();
    return this.connect();
  }

  /** Unlink this computer from the phone and delete the saved session */
  async logout(): Promise<WhatsAppConnectionStatus> {
    this.stopping = true;
    this.clearReconnectTimer();
    const client = this.client;
    if (client && this.status.state === 'connected') {
      try {
        await client.logout();
      } catch (err: any) {
        logger.warn('whatsapp', `WhatsApp logout reported an error: ${describeStartupError(err)}`);
      }
    }
    await this.destroyClient();
    await deleteSavedSession();
    this.saveConnectionInfo(null);
    this.update({ state: 'disconnected', qrDataUrl: null, account: null, lastError: null, loadingPercent: null });
    logger.info('whatsapp', 'Logged out of WhatsApp Web and removed the local session.');
    return this.getStatus();
  }

  /** Delete the local session files without contacting WhatsApp (for a stuck or corrupt session) */
  async clearSession(): Promise<WhatsAppConnectionStatus> {
    this.stopping = true;
    this.clearReconnectTimer();
    await this.destroyClient();
    await deleteSavedSession();
    this.saveConnectionInfo(null);
    this.update({ state: 'disconnected', qrDataUrl: null, account: null, lastError: null, loadingPercent: null });
    logger.info('whatsapp', 'Cleared the local WhatsApp session. A new QR scan is required.');
    return this.getStatus();
  }

  /** Close the browser but keep the saved session, for app shutdown */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    await this.destroyClient();
  }

  /**
   * Resolve the recipient's WhatsApp id and send the PDF as a document with the caption.
   * Returns the library's message id; this is not proof of delivery.
   */
  async sendDocument(phoneDigits: string, pdfPath: string, caption: string): Promise<{ messageId: string; ack: number | undefined }> {
    const client = this.client;
    if (!client || !this.isReady()) {
      throw new WhatsAppNotReadyError('WhatsApp is not connected.');
    }

    const absolutePath = path.resolve(pdfPath);
    await fs.promises.access(absolutePath, fs.constants.R_OK);

    let chatId: { _serialized: string } | null;
    try {
      chatId = await client.getNumberId(phoneDigits);
    } catch (err) {
      // Nothing was sent yet: safe to retry this guest after reconnecting
      throw this.connectionLostOr(err, client, false);
    }
    if (!chatId) {
      throw new WhatsAppNumberNotFoundError(`+${maskPhone(phoneDigits)} is not registered on WhatsApp.`);
    }

    const media = MessageMedia.fromFilePath(absolutePath);
    try {
      const message = await client.sendMessage(chatId._serialized, media, {
        caption,
        sendMediaAsDocument: true
      });
      return { messageId: message.id._serialized, ack: message.ack };
    } catch (err) {
      // The page died during the send itself; the message may or may not have gone out
      throw this.connectionLostOr(err, client, true);
    }
  }

  /** Converts a dead-browser error into WhatsAppConnectionLostError and starts reconnecting */
  private connectionLostOr(err: unknown, client: WhatsAppClientLike, mayHaveSent: boolean): unknown {
    if (!isConnectionLostError(err)) return err;
    this.handleConnectionLost(client, 'The WhatsApp Web page stopped responding.');
    return new WhatsAppConnectionLostError('Lost connection to WhatsApp Web while sending.', mayHaveSent);
  }

  /** The hidden browser/page is gone: mark disconnected immediately and reconnect with the saved session */
  private handleConnectionLost(client: WhatsAppClientLike, reason: string): void {
    if (this.client !== client || this.stopping) return;
    logger.warn('whatsapp', `${reason} Reconnecting with the saved session...`);
    this.client = null;
    client.destroy().catch(() => {});
    this.scheduleReconnect(reason);
  }

  // ---------------------------------------------------------------------------

  private async startClient(): Promise<void> {
    this.update({
      state: this.status.reconnectAttempt > 0 ? 'reconnecting' : 'initializing',
      qrDataUrl: null,
      lastError: null,
      loadingPercent: null
    });

    if (!hasMediaSendFix()) {
      logger.warn('whatsapp', 'The installed whatsapp-web.js is missing the media-send fix; sending PDFs will fail. Run `npm install` in the project folder and restart.');
    }

    // Close browsers left on our profile by a killed run; never touch one owned by another running copy
    const { inUse } = await this.killOrphans();
    if (inUse) {
      const message = describeStartupError(new Error('SingletonLock'));
      logger.error('whatsapp', message);
      this.update({ state: 'disconnected', qrDataUrl: null, lastError: message });
      return;
    }

    const client = this.clientFactory(buildClientOptions());
    this.client = client;
    this.attachEvents(client);

    try {
      await client.initialize();
      // initialize() resolves once the page is loaded; from here on, watch for the browser dying
      client.pupBrowser?.on('disconnected', () => this.handleConnectionLost(client, 'The WhatsApp Web browser closed unexpectedly.'));
      client.pupPage?.on('close', () => this.handleConnectionLost(client, 'The WhatsApp Web page closed unexpectedly.'));
    } catch (err: any) {
      if (this.client !== client) return; // replaced or destroyed meanwhile
      const message = describeStartupError(err);
      logger.error('whatsapp', `WhatsApp Web failed to start: ${message}`);
      await this.destroyClient();
      this.update({ state: 'disconnected', qrDataUrl: null, lastError: message });
    }
  }

  private attachEvents(client: WhatsAppClientLike): void {
    // Ignore events from a client that has since been replaced
    const isCurrent = () => this.client === client;

    client.on('loading_screen', (percent: string | number) => {
      if (!isCurrent()) return;
      this.update({ loadingPercent: Number(percent) || null });
    });

    client.on('qr', async (qr: string) => {
      if (!isCurrent()) return;
      // The QR payload is a login credential: render it, never log it
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
        if (isCurrent()) this.update({ state: 'qr', qrDataUrl, reconnectAttempt: 0, lastError: null });
      } catch (err: any) {
        logger.error('whatsapp', `Could not render the WhatsApp QR code: ${err.message}`);
      }
    });

    client.on('authenticated', () => {
      if (!isCurrent()) return;
      // Authenticated is not ready: chats are still loading and sending would fail
      this.update({ state: 'authenticating', qrDataUrl: null });
      logger.info('whatsapp', 'WhatsApp Web authenticated; waiting for it to finish loading.');
    });

    client.on('auth_failure', () => {
      if (!isCurrent()) return;
      const message = 'WhatsApp rejected the saved session. Clear the session and scan a new QR code.';
      logger.error('whatsapp', message);
      this.update({ state: 'auth_failure', qrDataUrl: null, lastError: message });
    });

    client.on('ready', () => {
      if (!isCurrent()) return;
      const digits = client.info?.wid?.user || '';
      const account = {
        name: client.info?.pushname || 'WhatsApp account',
        phoneMasked: digits ? `+${maskPhone(digits)}` : '',
        platform: client.info?.platform || ''
      };
      const lastConnectedAt = new Date().toISOString();
      this.saveConnectionInfo({ account, lastConnectedAt });
      this.update({
        state: 'connected',
        qrDataUrl: null,
        account,
        lastConnectedAt,
        lastError: null,
        loadingPercent: null,
        reconnectAttempt: 0
      });
      logger.info('whatsapp', `WhatsApp Web connected as ${account.name} (${account.phoneMasked}).`);
    });

    client.on('message_ack', (message: { id?: { _serialized?: string } }, ack: number) => {
      const id = message?.id?._serialized;
      if (id) this.recordAck(id, ack);
    });

    client.on('disconnected', async (reason: string) => {
      if (!isCurrent() || this.stopping) return;
      logger.warn('whatsapp', `WhatsApp Web disconnected (${reason}).`);
      await this.destroyClient();

      if (reason === 'LOGOUT') {
        // Device was unlinked from the phone: the saved session is useless now
        await deleteSavedSession();
        this.saveConnectionInfo(null);
        this.update({
          state: 'disconnected',
          account: null,
          lastError: 'This computer was unlinked from WhatsApp on your phone. Scan a new QR code to reconnect.'
        });
        return;
      }
      this.scheduleReconnect(`Disconnected (${reason}).`);
    });
  }

  private scheduleReconnect(reason: string): void {
    const attempt = this.status.reconnectAttempt;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      this.update({ state: 'disconnected', lastError: `${reason} Automatic reconnection failed; use Reconnect.` });
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attempt];
    this.update({ state: 'reconnecting', reconnectAttempt: attempt + 1, lastError: reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
    this.reconnectTimer.unref();
  }

  /** Upgrade a recipient's status from WhatsApp's delivery receipts (never downgrade) */
  private recordAck(messageId: string, ack: number): void {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      if (ack === ACK_ERROR) {
        db.prepare(`
          UPDATE campaign_recipients SET status = 'failed', error_message = 'WhatsApp reported that the message could not be sent.'
          WHERE whatsapp_message_id = ? AND status IN ('accepted', 'sent')
        `).run(messageId);
      } else if (ack >= ACK_DEVICE) {
        db.prepare(`
          UPDATE campaign_recipients
          SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?)
          WHERE whatsapp_message_id = ? AND status IN ('accepted', 'sent', 'delivered')
        `).run(now, messageId);
        if (ack >= ACK_READ) {
          db.prepare('UPDATE campaign_recipients SET read_at = COALESCE(read_at, ?) WHERE whatsapp_message_id = ?').run(now, messageId);
        }
      } else if (ack === ACK_SERVER) {
        db.prepare(`UPDATE campaign_recipients SET status = 'sent' WHERE whatsapp_message_id = ? AND status = 'accepted'`).run(messageId);
      }
    } catch (err: any) {
      logger.warn('whatsapp', `Could not record delivery receipt: ${err.message}`);
    }
  }

  private async destroyClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.destroy();
    } catch {
      // browser already gone
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private update(patch: Partial<WhatsAppConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  private readSavedInfo(): { account: WhatsAppConnectionStatus['account']; lastConnectedAt: string | null } {
    try {
      const row = getDb().prepare('SELECT whatsapp_web_account, whatsapp_web_last_connected_at FROM settings WHERE id = 1').get() as any;
      return {
        account: row?.whatsapp_web_account ? JSON.parse(row.whatsapp_web_account) : null,
        lastConnectedAt: row?.whatsapp_web_last_connected_at || null
      };
    } catch {
      return { account: null, lastConnectedAt: null };
    }
  }

  private saveConnectionInfo(info: { account: WhatsAppConnectionStatus['account']; lastConnectedAt: string } | null): void {
    try {
      getDb()
        .prepare('UPDATE settings SET whatsapp_web_account = ?, whatsapp_web_last_connected_at = COALESCE(?, whatsapp_web_last_connected_at) WHERE id = 1')
        .run(info ? JSON.stringify(info.account) : null, info ? info.lastConnectedAt : null);
    } catch {
      // settings row missing in a fresh test DB; not critical
    }
  }
}

export const whatsappWeb = new WhatsAppWebManager();
