import crypto from 'node:crypto';
import path from 'node:path';
import { getDb } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { PdfService, sanitizeFilename, PdfOverlayConfig } from '../services/pdfService.js';
import { getWhatsAppProvider, IWhatsAppProvider } from '../services/whatsappService.js';
import { whatsappWeb } from '../whatsapp/whatsappClient.js';

export interface QueueStatus {
  campaignId: string | null;
  state: 'idle' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
  currentRecipient: {
    index: number;
    name: string;
    phone: string;
    pdfFilename: string;
  } | null;
  totalRecipients: number;
  completedCount: number;
  failedCount: number;
  remainingCount: number;
  progressPercentage: number;
  lastStatus: string | null;
  lastError: string | null;
  nextEligibleProcessingTime: string | null;
  nextDelaySeconds: number | null;
  lastIntervalSeconds: number | null;
  startedAt: string | null;
}

// Recipient statuses that mean WhatsApp took the message
const SUCCESS_STATUSES = "('accepted', 'sent', 'delivered')";
// A rate-limited recipient goes back into the queue at most this many times before it is marked failed
const MAX_RATE_LIMIT_REQUEUES = 3;

const DEFAULT_PDF_CONFIG: PdfOverlayConfig = {
  x: 297,
  y: 610,
  size: 26,
  colorHex: '#73141E',
  prefix: 'Dear ',
  align: 'center',
  pageNumber: 1
};

type ProviderFactory = () => IWhatsAppProvider;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Picks the text drawn on the PDF: the CSV column chosen in the editor (pdfConfig.fieldName),
 * falling back to the mapped guest name.
 */
export function resolveGuestDisplayName(recipient: { name: string; raw_data?: string | null }, fieldName?: string): string {
  if (!fieldName || fieldName === 'name') return recipient.name;
  try {
    const raw = JSON.parse(recipient.raw_data || '{}');
    const value = typeof raw[fieldName] === 'string' ? raw[fieldName].trim() : '';
    return value || recipient.name;
  } catch {
    return recipient.name;
  }
}

class CampaignQueueManager {
  private activeCampaignId: string | null = null;
  private isPaused = false;
  private isCancelled = false;
  // Only one worker loop may exist; a second loop would send the same recipient twice
  private loopPromise: Promise<void> | null = null;
  private nextEligibleTime: number | null = null;
  private lastIntervalMs: number | null = null;

  // Swappable so tests can inject failing / rate-limited providers
  public providerFactory: ProviderFactory = getWhatsAppProvider;
  // Swappable so tests can simulate a connected WhatsApp Web session
  public isWhatsAppWebReady: () => boolean = () => whatsappWeb.isReady();
  // Set when the queue paused itself because WhatsApp dropped; cleared by a manual pause/cancel
  private pausedForDisconnect = false;

  constructor() {
    // Automatically recover state on startup
    this.recoverInterruptedCampaigns();
    // Resume a campaign that paused only because WhatsApp disconnected, once it is back
    whatsappWeb.on('status', status => {
      if (status.state === 'connected') this.resumeAfterReconnect();
    });
  }

  /** Called when WhatsApp reconnects; only resumes campaigns the queue paused itself */
  public resumeAfterReconnect(): void {
    if (!this.pausedForDisconnect || !this.activeCampaignId) return;
    this.pausedForDisconnect = false;
    logger.info('queue', 'WhatsApp reconnected; resuming the paused campaign.');
    this.startCampaign(this.activeCampaignId).catch(err => logger.error('queue', `Auto-resume failed: ${err.message}`));
  }

  /**
   * Generates a secure randomized interval between minMs and maxMs (inclusive)
   * using Node.js crypto.randomInt
   */
  public getRandomInterval(minSeconds: number, maxSeconds: number): number {
    const minSec = Math.max(1, Math.min(minSeconds, maxSeconds));
    const maxSec = Math.max(minSec, maxSeconds);

    const minMs = minSec * 1000;
    const maxMs = maxSec * 1000;

    // crypto.randomInt(min, max) is [min, max), so pass maxMs + 1 to include maxMs
    return crypto.randomInt(minMs, maxMs + 1);
  }

  /**
   * On startup, check for any campaigns that were left running or paused.
   * Recipients caught mid-send are flagged instead of re-queued: the request may already
   * have reached WhatsApp, and blindly resending would duplicate the invitation.
   */
  public recoverInterruptedCampaigns(): void {
    try {
      const db = getDb();

      const inFlight = db.prepare(`
        UPDATE campaign_recipients
        SET status = 'failed',
            send_uncertain = 1,
            error_message = 'Interrupted while sending: WhatsApp may already have received this invitation. Check the chat before retrying.'
        WHERE status = 'sending'
      `).run();
      if (Number(inFlight.changes) > 0) {
        logger.warn('queue', `Flagged ${inFlight.changes} recipient(s) interrupted mid-send for manual review (not auto-resent).`);
      }

      const interrupted = db.prepare(`
        SELECT id, name, status, next_eligible_at
        FROM campaigns
        WHERE status IN ('running', 'paused')
        ORDER BY created_at DESC
        LIMIT 1
      `).get() as { id: string; name: string; status: string; next_eligible_at: string | null } | undefined;

      if (interrupted) {
        this.syncCounters(interrupted.id);
        db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(interrupted.id);
        this.activeCampaignId = interrupted.id;
        this.isPaused = true;
        this.isCancelled = false;
        this.nextEligibleTime = interrupted.next_eligible_at ? Date.parse(interrupted.next_eligible_at) : null;
        logger.info('queue', `Recovered interrupted campaign '${interrupted.name}' (${interrupted.id}). Status set to 'paused' for safe resumption.`);
      }
    } catch (err: any) {
      logger.error('queue', `Error during campaign recovery: ${err.message}`);
    }
  }

  /**
   * Start or Resume a campaign
   */
  public async startCampaign(campaignId: string): Promise<{ success: boolean; message: string }> {
    if (this.activeCampaignId && this.activeCampaignId !== campaignId) {
      return { success: false, message: 'Another campaign is currently in progress. Pause or cancel it first.' };
    }
    if (this.loopPromise && this.activeCampaignId !== campaignId) {
      // A cancelled campaign's last send is still finishing
      return { success: false, message: 'The previous campaign is still finishing its last send. Try again in a few seconds.' };
    }

    const db = getDb();
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId) as any;
    if (!campaign) {
      return { success: false, message: `Campaign not found with ID: ${campaignId}` };
    }
    if (campaign.status === 'completed') {
      return { success: false, message: 'Campaign has already completed.' };
    }
    if (campaign.status === 'cancelled') {
      return { success: false, message: 'Campaign was cancelled. Create a new campaign to send again.' };
    }

    if (this.activeCampaignId === campaignId && !this.isPaused) {
      return { success: false, message: 'Campaign is already running.' };
    }

    if (!this.isWhatsAppWebReady()) {
      return { success: false, message: 'WhatsApp Web is not connected. Open the WhatsApp page, connect, then start again.' };
    }

    if (this.activeCampaignId !== campaignId) {
      this.activeCampaignId = campaignId;
      this.nextEligibleTime = campaign.next_eligible_at ? Date.parse(campaign.next_eligible_at) : null;
      this.lastIntervalMs = null;
    }
    this.isPaused = false;
    this.isCancelled = false;

    db.prepare(`
      UPDATE campaigns
      SET status = 'running', started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `).run(new Date().toISOString(), campaignId);

    logger.info('queue', `Started/Resumed campaign '${campaign.name}' (${campaignId})`);

    // If the loop is still alive (paused mid-wait), clearing isPaused is enough
    if (!this.loopPromise) {
      this.loopPromise = this.processQueueLoop(campaignId)
        .catch(err => {
          logger.error('queue', `Fatal error in campaign queue loop: ${err.message}`);
          getDb().prepare("UPDATE campaigns SET status = 'paused', last_error = ? WHERE id = ?").run(err.message, campaignId);
          this.isPaused = true;
        })
        .finally(() => {
          this.loopPromise = null;
        });
    }

    return { success: true, message: 'Campaign started successfully.' };
  }

  /**
   * Pause active campaign
   */
  public pauseCampaign(): { success: boolean; message: string } {
    if (!this.activeCampaignId || this.isPaused) {
      return { success: false, message: 'No active campaign to pause.' };
    }

    this.isPaused = true;
    this.pausedForDisconnect = false;
    getDb().prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(this.activeCampaignId);

    logger.info('queue', `Paused campaign ${this.activeCampaignId}`);
    return { success: true, message: 'Campaign paused. The current send (if any) will finish first.' };
  }

  /**
   * Resume active paused campaign
   */
  public async resumeCampaign(): Promise<{ success: boolean; message: string }> {
    if (!this.activeCampaignId) {
      return { success: false, message: 'No campaign to resume.' };
    }
    return this.startCampaign(this.activeCampaignId);
  }

  /**
   * Cancel active campaign
   */
  public cancelCampaign(): { success: boolean; message: string } {
    if (!this.activeCampaignId) {
      return { success: false, message: 'No active campaign to cancel.' };
    }

    this.isCancelled = true;
    this.isPaused = false;
    this.pausedForDisconnect = false;

    const cancelledId = this.activeCampaignId;
    const db = getDb();
    db.prepare("UPDATE campaigns SET status = 'cancelled', next_eligible_at = NULL WHERE id = ?").run(cancelledId);

    this.activeCampaignId = null;
    this.nextEligibleTime = null;
    this.lastIntervalMs = null;

    logger.info('queue', `Cancelled campaign ${cancelledId}`);
    return { success: true, message: 'Campaign cancelled.' };
  }

  /**
   * Pause and wait (bounded) for an in-flight send to finish, so shutdown never cuts a send in half.
   */
  public async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.activeCampaignId && !this.isPaused) {
      this.pauseCampaign();
    }
    if (this.loopPromise) {
      await Promise.race([this.loopPromise, sleep(timeoutMs)]);
    }
  }

  /**
   * Retry failed recipients for a campaign, then start it unless another campaign is active.
   * Recipients flagged send_uncertain are skipped unless includeUncertain is set, because
   * they may already have received the invitation.
   */
  public async retryFailed(
    campaignId: string,
    options: { includeUncertain?: boolean; autoStart?: boolean } = {}
  ): Promise<{ success: boolean; count: number; skippedUncertain: number; message: string }> {
    const { includeUncertain = false, autoStart = true } = options;
    const db = getDb();

    const campaign = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId) as { status: string } | undefined;
    if (!campaign) {
      return { success: false, count: 0, skippedUncertain: 0, message: `Campaign not found with ID: ${campaignId}` };
    }

    const result = db.prepare(`
      UPDATE campaign_recipients
      SET status = 'queued', error_message = NULL, send_uncertain = 0, retry_count = retry_count + 1
      WHERE campaign_id = ? AND status = 'failed' ${includeUncertain ? '' : 'AND COALESCE(send_uncertain, 0) = 0'}
    `).run(campaignId);

    const { skipped } = db.prepare(`
      SELECT COUNT(*) as skipped FROM campaign_recipients
      WHERE campaign_id = ? AND status = 'failed' AND send_uncertain = 1
    `).get(campaignId) as { skipped: number };

    const count = Number(result.changes);
    if (count === 0) {
      const message = skipped > 0
        ? `${skipped} failed recipient(s) were interrupted mid-send and may already have the invitation. Confirm in WhatsApp, then retry them explicitly.`
        : 'No failed recipients found to retry.';
      return { success: false, count: 0, skippedUncertain: skipped, message };
    }

    this.syncCounters(campaignId);
    logger.info('queue', `Reset ${count} failed recipients to queued for campaign ${campaignId}`);

    // Reopen finished campaigns so the queue picks the recipients up again
    if (this.activeCampaignId !== campaignId) {
      db.prepare("UPDATE campaigns SET status = 'paused', completed_at = NULL WHERE id = ?").run(campaignId);
    }

    let message = `Queued ${count} failed recipient(s) for retry.`;
    if (skipped > 0) {
      message += ` ${skipped} interrupted recipient(s) were left out because they may already have the invitation.`;
    }

    if (autoStart && this.activeCampaignId !== campaignId) {
      const start = await this.startCampaign(campaignId);
      message += start.success ? ' Sending has started.' : ` Not started: ${start.message}`;
    }

    return { success: true, count, skippedUncertain: skipped, message };
  }

  /**
   * Recompute the stored counters from recipient rows so they never drift
   */
  private syncCounters(campaignId: string): void {
    getDb().prepare(`
      UPDATE campaigns SET
        completed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ${SUCCESS_STATUSES}),
        failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed')
      WHERE id = ?
    `).run(campaignId, campaignId, campaignId);
  }

  private shouldStop(campaignId: string): boolean {
    return this.isCancelled || this.isPaused || this.activeCampaignId !== campaignId;
  }

  /**
   * Main Queue processing loop. Exits when paused/cancelled/finished; startCampaign restarts it.
   */
  private async processQueueLoop(campaignId: string): Promise<void> {
    const db = getDb();

    while (!this.shouldStop(campaignId)) {
      // Honor the interval chosen after the previous recipient (absolute time, so pausing never shortens it)
      if (this.nextEligibleTime && Date.now() < this.nextEligibleTime) {
        await sleep(Math.min(250, this.nextEligibleTime - Date.now()));
        continue;
      }

      const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId) as any;
      if (!campaign || campaign.status === 'cancelled') {
        return;
      }

      const recipient = db.prepare(`
        SELECT * FROM campaign_recipients
        WHERE campaign_id = ? AND status = 'queued'
        ORDER BY recipient_index ASC
        LIMIT 1
      `).get(campaignId) as any;

      if (!recipient) {
        this.syncCounters(campaignId);
        db.prepare(`
          UPDATE campaigns
          SET status = 'completed', completed_at = ?, next_eligible_at = NULL
          WHERE id = ?
        `).run(new Date().toISOString(), campaignId);
        logger.info('queue', `Campaign ${campaignId} completed all recipients!`);

        this.activeCampaignId = null;
        this.nextEligibleTime = null;
        return;
      }

      const outcome = await this.processRecipient(campaign, recipient);
      this.syncCounters(campaignId);

      const { remaining } = db.prepare(`
        SELECT COUNT(*) as remaining FROM campaign_recipients
        WHERE campaign_id = ? AND status = 'queued'
      `).get(campaignId) as { remaining: number };

      if (remaining > 0) {
        // Interval between consecutive recipients only (never before the first one).
        // A provider-requested retry delay always wins over the random interval.
        const randomMs = this.getRandomInterval(campaign.min_interval_seconds || 20, campaign.max_interval_seconds || 30);
        const delayMs = Math.max(randomMs, outcome.retryAfterMs || 0);

        this.lastIntervalMs = delayMs;
        this.nextEligibleTime = Date.now() + delayMs;
        db.prepare('UPDATE campaigns SET next_eligible_at = ? WHERE id = ?')
          .run(new Date(this.nextEligibleTime).toISOString(), campaignId);
        db.prepare('UPDATE campaign_recipients SET interval_ms = ? WHERE id = ?').run(delayMs, recipient.id);

        logger.info(
          'queue',
          `Waiting ${(delayMs / 1000).toFixed(1)}s before next recipient (${new Date(this.nextEligibleTime).toLocaleTimeString()})${outcome.retryAfterMs ? ' [provider rate limit]' : ''}`
        );
      } else {
        this.nextEligibleTime = null;
        db.prepare('UPDATE campaigns SET next_eligible_at = NULL WHERE id = ?').run(campaignId);
      }
    }
  }

  /**
   * Generate the PDF and send one recipient. Returns a provider-requested delay when rate limited.
   */
  private async processRecipient(campaign: any, recipient: any): Promise<{ retryAfterMs?: number }> {
    const db = getDb();

    let pdfConfig: PdfOverlayConfig;
    try {
      pdfConfig = JSON.parse(campaign.pdf_config);
    } catch {
      pdfConfig = DEFAULT_PDF_CONFIG;
    }

    const personalizedMessage = campaign.message_template
      .replace(/\{\{name\}\}/gi, recipient.name)
      .replace(/\{\{phone\}\}/gi, recipient.phone);

    const displayName = resolveGuestDisplayName(recipient, pdfConfig.fieldName);
    const pdfFileName = `Invitation_${recipient.recipient_index + 1}_${sanitizeFilename(recipient.name)}.pdf`;
    const personalizedPdfPath = path.join(campaign.output_dir, pdfFileName);

    // Step 1: Generate personalized PDF
    try {
      await PdfService.personalizePdf({
        templatePdfPath: campaign.invitation_pdf_path,
        fontPath: campaign.font_path,
        guestName: displayName,
        config: pdfConfig,
        outputPath: personalizedPdfPath
      });
    } catch (pdfErr: any) {
      logger.error('pdf', `Failed generating PDF for ${recipient.name}: ${pdfErr.message}`);
      db.prepare(`
        UPDATE campaign_recipients SET status = 'failed', error_message = ? WHERE id = ?
      `).run(`PDF Generation Error: ${pdfErr.message}`, recipient.id);
      db.prepare('UPDATE campaigns SET current_index = ?, last_error = ? WHERE id = ?')
        .run(recipient.recipient_index + 1, pdfErr.message, campaign.id);
      return {};
    }

    // Step 2: Persist 'sending' BEFORE calling the provider so a crash mid-request is detectable on restart
    db.prepare(`
      UPDATE campaign_recipients
      SET status = 'sending', generated_pdf_path = ?, rendered_message = ?
      WHERE id = ?
    `).run(personalizedPdfPath, personalizedMessage, recipient.id);

    const provider = this.providerFactory();

    let sendResult;
    try {
      sendResult = await provider.sendInvitation({
        to: recipient.phone,
        pdfPath: personalizedPdfPath,
        captionText: personalizedMessage,
        recipientName: recipient.name
      });
    } catch (err: any) {
      sendResult = { success: false, messageId: '', status: 'failed' as const, timestamp: new Date().toISOString(), error: err.message };
    }

    const now = new Date().toISOString();

    if (sendResult.success) {
      // Provider acceptance is NOT delivery; delivered_at stays empty unless the provider reports delivery
      db.prepare(`
        UPDATE campaign_recipients
        SET status = ?, whatsapp_message_id = ?, sent_at = ?, delivered_at = ?
        WHERE id = ?
      `).run(sendResult.status, sendResult.messageId, now, sendResult.status === 'delivered' ? now : null, recipient.id);
      db.prepare('UPDATE campaigns SET current_index = ? WHERE id = ?').run(recipient.recipient_index + 1, campaign.id);
      return {};
    }

    if (sendResult.notReady) {
      if (sendResult.sendUncertain) {
        // Died mid-send: don't resend automatically, it may already be on the guest's phone
        db.prepare(`
          UPDATE campaign_recipients
          SET status = 'failed', send_uncertain = 1, sent_at = ?,
              error_message = 'Connection lost while sending: WhatsApp may already have delivered this invitation. Check the chat before retrying.'
          WHERE id = ?
        `).run(now, recipient.id);
      } else {
        // Nothing was sent: keep the recipient queued
        db.prepare("UPDATE campaign_recipients SET status = 'queued' WHERE id = ?").run(recipient.id);
      }
      const reason = 'WhatsApp disconnected. Sending is paused and resumes automatically when WhatsApp reconnects.';
      db.prepare("UPDATE campaigns SET status = 'paused', last_error = ? WHERE id = ?").run(reason, campaign.id);
      this.isPaused = true;
      this.pausedForDisconnect = true;
      logger.warn('queue', reason);
      return {};
    }

    if (sendResult.rateLimited && recipient.retry_count < MAX_RATE_LIMIT_REQUEUES) {
      // Nothing was sent; put the recipient back and wait as long as the provider asked
      db.prepare(`
        UPDATE campaign_recipients
        SET status = 'queued', retry_count = retry_count + 1, error_message = ?
        WHERE id = ?
      `).run(`Rate limited by provider, retrying: ${sendResult.error}`, recipient.id);
      db.prepare('UPDATE campaigns SET last_error = ? WHERE id = ?').run(`Rate limited: ${sendResult.error}`, campaign.id);
      logger.warn('whatsapp', `Provider rate limit hit; waiting ${Math.round((sendResult.retryAfterMs || 0) / 1000)}s before retrying ${recipient.name}`);
      return { retryAfterMs: sendResult.retryAfterMs };
    }

    db.prepare(`
      UPDATE campaign_recipients
      SET status = 'failed', error_message = ?, sent_at = ?
      WHERE id = ?
    `).run(sendResult.error || 'Send operation failed', now, recipient.id);
    db.prepare('UPDATE campaigns SET current_index = ?, last_error = ? WHERE id = ?')
      .run(recipient.recipient_index + 1, sendResult.error || 'Send operation failed', campaign.id);
    return { retryAfterMs: sendResult.retryAfterMs };
  }

  /**
   * Get current live queue status
   */
  public getStatus(): QueueStatus {
    const idle: QueueStatus = {
      campaignId: null,
      state: 'idle',
      currentRecipient: null,
      totalRecipients: 0,
      completedCount: 0,
      failedCount: 0,
      remainingCount: 0,
      progressPercentage: 0,
      lastStatus: null,
      lastError: null,
      nextEligibleProcessingTime: null,
      nextDelaySeconds: null,
      lastIntervalSeconds: null,
      startedAt: null
    };

    if (!this.activeCampaignId) return idle;

    const db = getDb();
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(this.activeCampaignId) as any;
    if (!campaign) return idle;

    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ${SUCCESS_STATUSES} THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN ('queued', 'sending') THEN 1 ELSE 0 END) as queued
      FROM campaign_recipients
      WHERE campaign_id = ?
    `).get(this.activeCampaignId) as any;

    const current = db.prepare(`
      SELECT recipient_index, name, phone, generated_pdf_path
      FROM campaign_recipients
      WHERE campaign_id = ? AND status IN ('sending', 'queued')
      ORDER BY CASE status WHEN 'sending' THEN 0 ELSE 1 END, recipient_index ASC
      LIMIT 1
    `).get(this.activeCampaignId) as any;

    const lastSent = db.prepare(`
      SELECT status FROM campaign_recipients
      WHERE campaign_id = ? AND status NOT IN ('queued', 'sending')
      ORDER BY recipient_index DESC
      LIMIT 1
    `).get(this.activeCampaignId) as { status: string } | undefined;

    const total = counts?.total || campaign.total_recipients || 0;
    const completed = counts?.completed || 0;
    const failed = counts?.failed || 0;
    const remaining = counts?.queued || 0;
    const progress = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;

    let state: QueueStatus['state'] = 'running';
    if (this.isPaused) state = 'paused';
    else if (this.isCancelled) state = 'cancelled';
    else if (remaining === 0 && total > 0) state = 'completed';

    const remainingWaitMs = this.nextEligibleTime ? Math.max(0, this.nextEligibleTime - Date.now()) : null;

    return {
      campaignId: this.activeCampaignId,
      state,
      currentRecipient: current ? {
        index: current.recipient_index,
        name: current.name,
        phone: current.phone,
        pdfFilename: current.generated_pdf_path
          ? path.basename(current.generated_pdf_path)
          : `Invitation_${current.recipient_index + 1}_${sanitizeFilename(current.name)}.pdf`
      } : null,
      totalRecipients: total,
      completedCount: completed,
      failedCount: failed,
      remainingCount: remaining,
      progressPercentage: progress,
      lastStatus: lastSent?.status || null,
      lastError: campaign.last_error || null,
      nextEligibleProcessingTime: remainingWaitMs ? new Date(this.nextEligibleTime!).toISOString() : null,
      nextDelaySeconds: remainingWaitMs ? Math.round(remainingWaitMs / 1000) : null,
      lastIntervalSeconds: this.lastIntervalMs ? Math.round(this.lastIntervalMs / 1000) : null,
      startedAt: campaign.started_at
    };
  }
}

export const queueManager = new CampaignQueueManager();
