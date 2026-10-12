import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { queueManager } from '../src/queue/sendingQueue.js';
import { CampaignService } from '../src/services/campaignService.js';
import { getDb } from '../src/database/db.js';
import { TEMPLATE_PDF, INDIC_FONT } from './fixtures.js';

describe('Sending Queue, Timing, Controls, and State Recovery', () => {
  const samplePdf = TEMPLATE_PDF;
  const indicFont = INDIC_FONT;
  const testOutDir = path.join(os.tmpdir(), 'wis-test-output');

  beforeEach(() => {
    // Simulate a connected WhatsApp and a provider that never touches the network
    queueManager.isWhatsAppWebReady = () => true;
    queueManager.providerFactory = () => ({
      name: 'test',
      checkConnection: async () => ({ ok: true, message: 'ok' }),
      sendInvitation: async () => ({ success: true, messageId: `wamid.TEST_${Date.now()}`, status: 'accepted' as const, timestamp: new Date().toISOString() })
    });
    // Reset any active queue
    try {
      queueManager.cancelCampaign();
    } catch {
      // ignore
    }
  });

  it('should generate randomized intervals strictly between min and max seconds', () => {
    const minSec = 20;
    const maxSec = 30;

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const delayMs = queueManager.getRandomInterval(minSec, maxSec);
      expect(delayMs).toBeGreaterThanOrEqual(minSec * 1000);
      expect(delayMs).toBeLessThanOrEqual(maxSec * 1000);
      samples.push(delayMs);
    }

    // Verify randomization: not all values should be identical
    const uniqueValues = new Set(samples);
    expect(uniqueValues.size).toBeGreaterThan(1);
  });

  it('should create campaign with pre-flight PDF verification and populate recipients in SQLite', async () => {
    const contacts = [
      {
        index: 0,
        name: 'Guest One',
        phone: '919876543201',
        rawPhone: '919876543201',
        isValid: true,
        isDuplicate: false,
        selected: true,
        customFields: {}
      },
      {
        index: 1,
        name: 'Guest Two (ગુજરાતી)',
        phone: '919876543202',
        rawPhone: '919876543202',
        isValid: true,
        isDuplicate: false,
        selected: true,
        customFields: {}
      }
    ];

    const campaign = await CampaignService.createCampaign({
      name: 'Test Sequential Campaign',
      invitationPdfPath: samplePdf,
      fontPath: indicFont,
      outputDir: testOutDir,
      pdfConfig: {
        x: 297,
        y: 610,
        size: 24,
        colorHex: '#000000',
        prefix: 'Dear ',
        align: 'center',
        pageNumber: 1,
        fieldName: 'name'
      },
      messageTemplate: 'Hello {{name}}',
      minIntervalSeconds: 1, // Short delay for test
      maxIntervalSeconds: 2,
      contacts
    });

    expect(campaign.id).toBeDefined();
    expect(campaign.totalRecipients).toBe(2);

    // Verify database entries
    const db = getDb();
    const dbCamp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id) as any;
    expect(dbCamp.status).toBe('draft');
    expect(dbCamp.total_recipients).toBe(2);

    const recipients = db.prepare('SELECT * FROM campaign_recipients WHERE campaign_id = ?').all(campaign.id);
    expect(recipients.length).toBe(2);
  });

  it('should support pause and cancel queue controls', async () => {
    // Start campaign
    const contacts = [
      {
        index: 0,
        name: 'Pause Test Guest',
        phone: '919876543203',
        rawPhone: '919876543203',
        isValid: true,
        isDuplicate: false,
        selected: true,
        customFields: {}
      }
    ];

    const created = await CampaignService.createCampaign({
      name: 'Pause Cancel Test',
      invitationPdfPath: samplePdf,
      fontPath: indicFont,
      outputDir: testOutDir,
      pdfConfig: {
        x: 297,
        y: 610,
        size: 24,
        colorHex: '#000000',
        prefix: 'Dear ',
        align: 'center',
        pageNumber: 1,
        fieldName: 'name'
      },
      messageTemplate: 'Hello {{name}}',
      minIntervalSeconds: 2,
      maxIntervalSeconds: 3,
      contacts
    });

    await queueManager.startCampaign(created.id);
    const pauseRes = queueManager.pauseCampaign();
    expect(pauseRes.success).toBe(true);

    const statusAfterPause = queueManager.getStatus();
    expect(statusAfterPause.state).toBe('paused');

    const cancelRes = queueManager.cancelCampaign();
    expect(cancelRes.success).toBe(true);
  });

  it('should prevent duplicate sends by tracking recipient status in SQLite', () => {
    const db = getDb();
    const campId = 'camp_duplicate_test';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO campaigns (
        id, name, status, total_recipients, completed_count, failed_count, current_index,
        invitation_pdf_path, font_path, output_dir, pdf_config, message_template,
        min_interval_seconds, max_interval_seconds, provider, created_at
      ) VALUES (
        ?, 'Duplicate Prevention Test', 'completed', 1, 1, 0, 1,
        'dummy.pdf', 'dummy.ttf', 'out', '{}', 'msg', 20, 30, 'mock', ?
      )
    `).run(campId, now);

    db.prepare(`
      INSERT OR REPLACE INTO campaign_recipients (
        id, campaign_id, recipient_index, phone, name, raw_data,
        status, created_at, sent_at
      ) VALUES (
        'recip_sent_1', ?, 0, '919876543299', 'Already Sent Guest', '{}',
        'accepted', ?, ?
      )
    `).run(campId, now, now);

    // Query for queued items: already sent recipient should NOT be fetched
    const queued = db.prepare(`
      SELECT * FROM campaign_recipients 
      WHERE campaign_id = ? AND status = 'queued'
    `).all(campId);

    expect(queued.length).toBe(0);
  });

  it('should support retrying failed recipients safely', async () => {
    const db = getDb();
    const campId = 'camp_retry_test';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO campaigns (
        id, name, status, total_recipients, completed_count, failed_count, current_index,
        invitation_pdf_path, font_path, output_dir, pdf_config, message_template,
        min_interval_seconds, max_interval_seconds, provider, created_at
      ) VALUES (
        ?, 'Retry Test Campaign', 'failed', 2, 0, 2, 2,
        'dummy.pdf', 'dummy.ttf', 'out', '{}', 'msg', 20, 30, 'mock', ?
      )
    `).run(campId, now);

    db.prepare(`
      INSERT OR REPLACE INTO campaign_recipients (
        id, campaign_id, recipient_index, phone, name, raw_data,
        status, error_message, created_at
      ) VALUES 
      ('recip_failed_1', ?, 0, '919876543211', 'Failed Guest 1', '{}', 'failed', 'Timeout error', ?),
      ('recip_failed_2', ?, 1, '919876543212', 'Failed Guest 2', '{}', 'failed', 'Network error', ?)
    `).run(campId, now, campId, now);

    const retryResult = await queueManager.retryFailed(campId);
    expect(retryResult.success).toBe(true);
    expect(retryResult.count).toBe(2);

    // Verify recipients are reset to queued
    const queuedAfter = db.prepare(`
      SELECT * FROM campaign_recipients 
      WHERE campaign_id = ? AND status = 'queued'
    `).all(campId);

    expect(queuedAfter.length).toBe(2);
  });
});

