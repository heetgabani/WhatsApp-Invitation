import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { getDb, OUTPUT_DIR } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { PdfService, PdfOverlayConfig } from './pdfService.js';
import { z } from 'zod';
import { validateFilePath, validateDirectoryPath } from '../utils/pathValidator.js';
import { ProcessedContact, sanitizePhoneNumber } from './csvService.js';

const pdfConfigSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  size: z.number().min(4).max(200),
  colorHex: z.string().regex(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i, 'colorHex must be a hex color like #73141E'),
  prefix: z.string().max(200).optional(),
  suffix: z.string().max(200).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  pageNumber: z.number().int().min(1).optional(),
  fieldName: z.string().max(200).optional(),
  languageFonts: z.object({
    gujarati: z.string().optional(),
    devanagari: z.string().optional()
  }).optional()
});

const createCampaignSchema = z.object({
  name: z.string().max(200),
  invitationPdfPath: z.string().min(1, 'Invitation PDF path is required'),
  fontPath: z.string().min(1, 'Font path is required'),
  outputDir: z.string().min(1).optional(),
  pdfConfig: pdfConfigSchema,
  messageTemplate: z.string().min(1, 'Message template is required').max(1024, 'WhatsApp document captions are limited to 1024 characters'),
  minIntervalSeconds: z.number().int().min(1).max(3600).default(20),
  maxIntervalSeconds: z.number().int().min(1).max(3600).default(30),
  allowDuplicate: z.boolean().optional(),
  contacts: z.array(z.object({
    name: z.string(),
    phone: z.string(),
    selected: z.boolean(),
    isValid: z.boolean(),
    customFields: z.record(z.string()).optional()
  }).passthrough()).min(1, 'No contacts provided')
}).refine(v => v.minIntervalSeconds <= v.maxIntervalSeconds, {
  message: 'Minimum delay cannot exceed maximum delay.',
  path: ['minIntervalSeconds']
});

/**
 * Thrown when an identical campaign already exists; the UI may confirm and resend with allowDuplicate.
 */
export class DuplicateCampaignError extends Error {
  constructor(message: string, public existingCampaignId: string, public existingStatus: string) {
    super(message);
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
}

export interface CreateCampaignInput {
  name: string;
  invitationPdfPath: string;
  fontPath: string;
  outputDir?: string;
  pdfConfig: PdfOverlayConfig;
  messageTemplate: string;
  minIntervalSeconds?: number;
  maxIntervalSeconds?: number;
  contacts: ProcessedContact[];
  allowDuplicate?: boolean;
}

export class CampaignService {
  /**
   * Pre-flight check & create campaign
   */
  static async createCampaign(input: CreateCampaignInput): Promise<{
    id: string;
    samplePdfPath: string;
    totalRecipients: number;
  }> {
    const parsedInput = createCampaignSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(`Invalid campaign: ${formatZodError(parsedInput.error)}`);
    }
    const {
      name,
      invitationPdfPath,
      fontPath,
      outputDir,
      pdfConfig,
      messageTemplate,
      minIntervalSeconds,
      maxIntervalSeconds,
      allowDuplicate,
      contacts
    } = parsedInput.data;

    // Validate paths
    const pdfVal = validateFilePath(invitationPdfPath, ['.pdf']);
    if (!pdfVal.valid) {
      throw new Error(`Invitation PDF validation failed: ${pdfVal.error}`);
    }

    const fontVal = validateFilePath(fontPath, ['.ttf', '.otf']);
    if (!fontVal.valid) {
      throw new Error(`Font validation failed: ${fontVal.error}`);
    }

    const outVal = validateDirectoryPath(outputDir || OUTPUT_DIR, true);
    if (!outVal.valid) {
      throw new Error(`Output directory validation failed: ${outVal.error}`);
    }

    for (const [script, langFont] of Object.entries(pdfConfig.languageFonts || {})) {
      if (!langFont) continue;
      const langVal = validateFilePath(langFont, ['.ttf', '.otf']);
      if (!langVal.valid) {
        throw new Error(`${script === 'gujarati' ? 'Gujarati' : 'Hindi'} font validation failed: ${langVal.error}`);
      }
      pdfConfig.languageFonts![script as 'gujarati' | 'devanagari'] = langVal.normalizedPath;
    }

    // Re-validate on the server: names/phones may have been edited in the browser.
    // Drop invalid numbers and repeated phones so nobody gets the invitation twice.
    const seenPhones = new Set<string>();
    const selectedContacts: Array<{ name: string; phone: string; customFields?: Record<string, string> }> = [];
    for (const c of contacts.filter(c => c.selected && c.isValid)) {
      const phone = sanitizePhoneNumber(c.phone);
      const guestName = c.name.trim();
      if (!phone.isValid || !guestName || seenPhones.has(phone.phone)) continue;
      seenPhones.add(phone.phone);
      selectedContacts.push({ name: guestName, phone: phone.phone, customFields: c.customFields });
    }
    if (selectedContacts.length === 0) {
      throw new Error('No valid recipients selected for this campaign.');
    }

    // Duplicate campaign prevention: same invitation + message + recipient list
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify([pdfVal.normalizedPath.toLowerCase(), messageTemplate, [...seenPhones].sort()]))
      .digest('hex');
    const existing = getDb().prepare(`
      SELECT id, name, status FROM campaigns
      WHERE fingerprint = ? AND status IN ('draft', 'running', 'paused', 'completed')
      ORDER BY created_at DESC LIMIT 1
    `).get(fingerprint) as { id: string; name: string; status: string } | undefined;
    if (existing) {
      const active = existing.status !== 'completed';
      if (active || !allowDuplicate) {
        throw new DuplicateCampaignError(
          active
            ? `An identical campaign '${existing.name}' is already ${existing.status}. Resume or cancel it instead of creating a duplicate.`
            : `An identical campaign '${existing.name}' was already completed for these recipients. Sending again would deliver duplicate invitations.`,
          existing.id,
          existing.status
        );
      }
    }

    // Mandatory requirement: "Generate a sample PDF first. Do not begin a campaign if PDF generation fails."
    logger.info('campaign', `Running pre-flight PDF test with sample guest '${selectedContacts[0].name}'...`);
    let samplePdfPath: string;
    try {
      samplePdfPath = await PdfService.generateSamplePreview(
        pdfVal.normalizedPath,
        fontVal.normalizedPath,
        selectedContacts[0].name,
        pdfConfig,
        outVal.normalizedPath
      );
    } catch (testErr: any) {
      logger.error('campaign', `Pre-flight sample PDF generation failed: ${testErr.message}`);
      throw new Error(`Pre-flight PDF personalization failed: ${testErr.message}. Campaign creation aborted.`);
    }

    // Generate unique ID
    const campaignId = `camp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    const db = getDb();

    // Campaign and recipients are written together or not at all
    db.exec('BEGIN');
    try {
    // Insert campaign
    db.prepare(`
      INSERT INTO campaigns (
        id, name, status, total_recipients, completed_count, failed_count, current_index,
        invitation_pdf_path, font_path, output_dir, pdf_config, message_template,
        min_interval_seconds, max_interval_seconds, provider, created_at, fingerprint
      ) VALUES (
        ?, ?, 'draft', ?, 0, 0, 0,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).run(
      campaignId,
      name.trim() || `Campaign ${new Date().toLocaleDateString()}`,
      selectedContacts.length,
      pdfVal.normalizedPath,
      fontVal.normalizedPath,
      outVal.normalizedPath,
      JSON.stringify(pdfConfig),
      messageTemplate,
      minIntervalSeconds,
      maxIntervalSeconds,
      'local_web',
      now,
      fingerprint
    );

    // Insert recipients
    const insertRecipient = db.prepare(`
      INSERT INTO campaign_recipients (
        id, campaign_id, recipient_index, phone, name, raw_data,
        status, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        'queued', ?
      )
    `);

    for (let i = 0; i < selectedContacts.length; i++) {
      const c = selectedContacts[i];
      const recipId = `recip_${campaignId}_${i}`;
      insertRecipient.run(
        recipId,
        campaignId,
        i,
        c.phone,
        c.name,
        JSON.stringify(c.customFields || {}),
        now
      );
    }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    logger.info('campaign', `Created campaign '${name}' (${campaignId}) with ${selectedContacts.length} recipients.`);

    return {
      id: campaignId,
      samplePdfPath,
      totalRecipients: selectedContacts.length
    };
  }

  /**
   * List all campaigns
   */
  static listCampaigns(limit = 50, offset = 0): any[] {
    const db = getDb();
    return db.prepare(`
      SELECT 
        c.*,
        (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('sent', 'delivered', 'accepted')) as delivered_count,
        (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') as failed_count
      FROM campaigns c
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  /**
   * Get single campaign details including recipients
   */
  static getCampaign(campaignId: string): any {
    const db = getDb();
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;

    const recipients = db.prepare(`
      SELECT * FROM campaign_recipients 
      WHERE campaign_id = ? 
      ORDER BY recipient_index ASC
    `).all(campaignId);

    return {
      ...campaign,
      recipients
    };
  }

  /**
   * Export campaign report as CSV string
   */
  static exportCampaignCsv(campaignId: string): string {
    const db = getDb();
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId) as any;
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const recipients = db.prepare(`
      SELECT recipient_index + 1 as "Number",
             name as "Guest Name",
             phone as "Phone Number",
             status as "Status",
             generated_pdf_path as "PDF Path",
             whatsapp_message_id as "WhatsApp Message ID",
             interval_ms as "Delay (ms)",
             error_message as "Error Reason",
             sent_at as "Sent At",
             delivered_at as "Delivered At"
      FROM campaign_recipients 
      WHERE campaign_id = ? 
      ORDER BY recipient_index ASC
    `).all(campaignId);

    return Papa.unparse(recipients);
  }

  /**
   * Export campaign report as JSON
   */
  static exportCampaignJson(campaignId: string): any {
    return this.getCampaign(campaignId);
  }

  /**
   * Delete campaign
   */
  static deleteCampaign(campaignId: string): boolean {
    const db = getDb();
    const campaign = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId) as { status: string } | undefined;
    if (campaign && (campaign.status === 'running' || campaign.status === 'paused')) {
      throw new Error('Cancel this campaign before deleting it.');
    }
    db.prepare('DELETE FROM campaign_recipients WHERE campaign_id = ?').run(campaignId);
    const res = db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    return Number(res.changes) > 0;
  }
}

