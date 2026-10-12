import path from 'node:path';
import { logger } from '../utils/logger.js';
import {
  whatsappWeb,
  WhatsAppWebManager,
  WhatsAppNotReadyError,
  WhatsAppNumberNotFoundError,
  WhatsAppConnectionLostError
} from '../whatsapp/whatsappClient.js';

export type WhatsAppStatus = 'queued' | 'accepted' | 'sent' | 'delivered' | 'failed';

export interface SendMessageOptions {
  to: string; // E.164 phone number, e.g. "919876543210"
  pdfPath: string; // Absolute path to generated PDF
  captionText: string;
  recipientName?: string;
}

export interface SendResult {
  success: boolean;
  messageId: string;
  status: WhatsAppStatus;
  timestamp: string;
  error?: string;
  providerDetails?: Record<string, any>;
  // Set when the provider asked us to slow down; the queue re-queues the recipient and waits retryAfterMs
  rateLimited?: boolean;
  retryAfterMs?: number;
  // Set when the provider is not connected; the queue pauses instead of failing every recipient
  notReady?: boolean;
  // With notReady: the connection died mid-send, so this recipient may already have the message
  sendUncertain?: boolean;
}

export interface ConnectionCheckResult {
  ok: boolean;
  message: string;
  details?: Record<string, any>;
}

export interface IWhatsAppProvider {
  name: string;
  checkConnection(): Promise<ConnectionCheckResult>;
  sendInvitation(options: SendMessageOptions): Promise<SendResult>;
  getMessageStatus?(messageId: string): Promise<WhatsAppStatus>;
}

/**
 * WhatsApp Web provider (QR login on the user's own number) via whatsapp-web.js.
 * UNOFFICIAL: WhatsApp can change its web app at any time, and automating it may break
 * WhatsApp's terms and get the number restricted. Sending is paced by the queue.
 */
export class LocalWhatsAppWebProvider implements IWhatsAppProvider {
  name = 'WhatsApp Web (QR login)';

  constructor(private manager: WhatsAppWebManager = whatsappWeb) {}

  async checkConnection(): Promise<ConnectionCheckResult> {
    const status = this.manager.getStatus();
    return status.state === 'connected'
      ? { ok: true, message: `Connected as ${status.account?.name || 'WhatsApp'} (${status.account?.phoneMasked || ''})` }
      : { ok: false, message: 'WhatsApp Web is not connected. Open the WhatsApp page and scan the QR code.', details: { state: status.state } };
  }

  async sendInvitation(options: SendMessageOptions): Promise<SendResult> {
    const { to, pdfPath, captionText, recipientName } = options;
    const timestamp = () => new Date().toISOString();

    if (!this.manager.isReady()) {
      return { success: false, messageId: '', status: 'failed', timestamp: timestamp(), error: 'WhatsApp Web is not connected.', notReady: true };
    }

    try {
      const { messageId, ack } = await this.manager.sendDocument(to, pdfPath, captionText);
      logger.info('whatsapp', `[WEB] Sent invitation to ${to} (${recipientName || 'Guest'}) with PDF: ${path.basename(pdfPath)}`);
      // Library returned a message id: WhatsApp Web took it. Receipts (sent/delivered/read) arrive later as acks.
      return {
        success: true,
        messageId,
        status: ack !== undefined && ack >= 1 ? 'sent' : 'accepted',
        timestamp: timestamp()
      };
    } catch (err: any) {
      if (err instanceof WhatsAppNotReadyError) {
        return { success: false, messageId: '', status: 'failed', timestamp: timestamp(), error: err.message, notReady: true };
      }
      if (err instanceof WhatsAppConnectionLostError) {
        logger.warn('whatsapp', `[WEB] Connection lost while sending to ${to}${err.mayHaveSent ? ' (message may have been sent)' : ''}`);
        return {
          success: false,
          messageId: '',
          status: 'failed',
          timestamp: timestamp(),
          error: err.message,
          notReady: true,
          sendUncertain: err.mayHaveSent
        };
      }
      const error = err instanceof WhatsAppNumberNotFoundError
        ? err.message
        : err?.code === 'ENOENT' || err?.code === 'EACCES'
          ? `Personalized PDF is missing or unreadable: ${path.basename(pdfPath)}`
          : `WhatsApp Web send failed: ${err?.message || err}`;
      logger.error('whatsapp', `[WEB] Failed sending to ${to}: ${error}`);
      return { success: false, messageId: '', status: 'failed', timestamp: timestamp(), error };
    }
  }
}

/** The only sending method: the QR-linked WhatsApp Web session */
export function getWhatsAppProvider(): IWhatsAppProvider {
  return new LocalWhatsAppWebProvider();
}
