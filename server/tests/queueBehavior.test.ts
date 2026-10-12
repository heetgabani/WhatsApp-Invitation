import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queueManager } from '../src/queue/sendingQueue.js';
import { CampaignService, DuplicateCampaignError } from '../src/services/campaignService.js';
import { getDb } from '../src/database/db.js';
import { TEMPLATE_PDF, INDIC_FONT, LATIN_ONLY_FONT } from './fixtures.js';
import { getWhatsAppProvider, IWhatsAppProvider, SendMessageOptions, SendResult } from '../src/services/whatsappService.js';
import { PdfService } from '../src/services/pdfService.js';
import { runMaintenance } from '../src/services/maintenanceService.js';

const samplePdf = TEMPLATE_PDF;
const indicFont = INDIC_FONT;
const latinOnlyFont = LATIN_ONLY_FONT;
const outDir = path.join(os.tmpdir(), 'wis-test-output', 'behavior');

const pdfConfig = { x: 297, y: 610, size: 24, colorHex: '#000000', prefix: 'Dear ', align: 'center' as const, pageNumber: 1, fieldName: 'name' };

let phoneSeq = 0;
function makeContacts(names: string[]) {
  return names.map((name, index) => {
    // Unique phones per test so duplicate-campaign detection does not interfere
    const phone = `9198${String(Date.now()).slice(-4)}${String(phoneSeq++).padStart(4, '0')}`;
    return { index, name, phone, rawPhone: phone, isValid: true, isDuplicate: false, selected: true, customFields: {} };
  });
}

async function createCampaign(names: string[], extra: Record<string, unknown> = {}) {
  return CampaignService.createCampaign({
    name: `Behavior ${Date.now()}`,
    invitationPdfPath: samplePdf,
    fontPath: indicFont,
    outputDir: outDir,
    pdfConfig,
    messageTemplate: `Hello {{name}} ${Math.random()}`,
    minIntervalSeconds: 1,
    maxIntervalSeconds: 1,
    contacts: makeContacts(names),
    ...extra
  } as any);
}

/** Records every send; optionally scripted to fail or rate-limit */
class RecordingProvider implements IWhatsAppProvider {
  name = 'Recording test provider';
  calls: { to: string; at: number }[] = [];
  constructor(private script: Array<Partial<SendResult>> = []) {}
  async checkConnection() {
    return { ok: true, message: 'ok' };
  }
  async sendInvitation(options: SendMessageOptions): Promise<SendResult> {
    this.calls.push({ to: options.to, at: Date.now() });
    const scripted = this.script.shift();
    return {
      success: true,
      messageId: `wamid.TEST_${this.calls.length}`,
      status: 'accepted',
      timestamp: new Date().toISOString(),
      ...scripted
    };
  }
}

async function waitFor(check: () => boolean, timeoutMs = 15000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 50));
  }
}

const campaignStatus = (id: string) => (getDb().prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as any).status;
const recipients = (id: string) =>
  getDb().prepare('SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY recipient_index').all(id) as any[];

describe('Queue behaviour: sequencing, controls, recovery, provider errors', () => {
  beforeEach(() => {
    fs.mkdirSync(outDir, { recursive: true });
    queueManager.isWhatsAppWebReady = () => true;
  });

  afterEach(async () => {
    queueManager.cancelCampaign();
    queueManager.providerFactory = getWhatsAppProvider;
    // let a cancelled loop finish its last iteration
    await new Promise(r => setTimeout(r, 300));
  });

  it('sends sequentially, with no delay before the first recipient and the interval between each', async () => {
    const provider = new RecordingProvider();
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Rahul Shah', 'પ્રિયા પટેલ', 'आरव मेहता']);

    const startedAt = Date.now();
    await queueManager.startCampaign(id);
    await waitFor(() => campaignStatus(id) === 'completed');

    expect(provider.calls).toHaveLength(3);
    // first send is immediate (only PDF generation time), not after an interval
    expect(provider.calls[0].at - startedAt).toBeLessThan(1000);
    for (let i = 1; i < provider.calls.length; i++) {
      expect(provider.calls[i].at - provider.calls[i - 1].at).toBeGreaterThanOrEqual(1000);
    }
    const rows = recipients(id);
    expect(rows.every(r => r.status === 'accepted')).toBe(true);
    // accepted by the provider is not delivered
    expect(rows.every(r => r.delivered_at === null)).toBe(true);
  });

  it('pausing during the interval does not shorten it, and repeated resume never sends twice', async () => {
    const provider = new RecordingProvider();
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Guest A', 'Guest B']);

    await queueManager.startCampaign(id);
    await waitFor(() => provider.calls.length === 1);

    queueManager.pauseCampaign();
    // resume twice in a row (double click); must not start a second worker loop
    await queueManager.resumeCampaign();
    await queueManager.resumeCampaign();

    await waitFor(() => campaignStatus(id) === 'completed');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].at - provider.calls[0].at).toBeGreaterThanOrEqual(1000);
  });

  it('cancel stops further recipients from being processed', async () => {
    const provider = new RecordingProvider();
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Stop A', 'Stop B', 'Stop C']);

    await queueManager.startCampaign(id);
    await waitFor(() => provider.calls.length === 1);
    queueManager.cancelCampaign();
    await new Promise(r => setTimeout(r, 1500));

    expect(provider.calls).toHaveLength(1);
    expect(campaignStatus(id)).toBe('cancelled');
    expect((await queueManager.startCampaign(id)).success).toBe(false);
  });

  it('records provider errors as failed and keeps going', async () => {
    const provider = new RecordingProvider([{ success: false, status: 'failed', messageId: '', error: '(#131026) Message undeliverable' }]);
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Fail Guest', 'Ok Guest']);

    await queueManager.startCampaign(id);
    await waitFor(() => campaignStatus(id) === 'completed');

    const [first, second] = recipients(id);
    expect(first.status).toBe('failed');
    expect(first.error_message).toContain('131026');
    expect(second.status).toBe('accepted');
  });

  it('honours a provider-requested retry delay and re-queues the rate-limited recipient', async () => {
    const provider = new RecordingProvider([
      { success: false, status: 'failed', messageId: '', error: 'Rate limit hit', rateLimited: true, retryAfterMs: 2000 }
    ]);
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Limited Guest']);

    await queueManager.startCampaign(id);
    await waitFor(() => campaignStatus(id) === 'completed');

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].at - provider.calls[0].at).toBeGreaterThanOrEqual(2000);
    const [row] = recipients(id);
    expect(row.status).toBe('accepted');
    expect(row.retry_count).toBe(1);
  });

  it('after a restart, flags recipients interrupted mid-send instead of resending them', async () => {
    const { id } = await createCampaign(['Crash A', 'Crash B']);
    const db = getDb();
    // Simulate a crash: campaign running, first recipient was mid-request
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(id);
    db.prepare("UPDATE campaign_recipients SET status = 'sending' WHERE campaign_id = ? AND recipient_index = 0").run(id);

    queueManager.recoverInterruptedCampaigns();

    expect(campaignStatus(id)).toBe('paused');
    expect(queueManager.getStatus().state).toBe('paused');
    const [interrupted, pending] = recipients(id);
    expect(interrupted.status).toBe('failed');
    expect(interrupted.send_uncertain).toBe(1);
    expect(pending.status).toBe('queued');

    // A normal retry skips the possibly-delivered recipient
    queueManager.cancelCampaign();
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(id);
    const retry = await queueManager.retryFailed(id, { autoStart: false });
    expect(retry.success).toBe(false);
    expect(retry.skippedUncertain).toBe(1);

    const forced = await queueManager.retryFailed(id, { includeUncertain: true, autoStart: false });
    expect(forced.count).toBe(1);
  });

  it('pauses (instead of failing everyone) when WhatsApp disconnects mid-campaign', async () => {
    const provider = new RecordingProvider([
      { success: false, status: 'failed', messageId: '', error: 'WhatsApp Web is not connected.', notReady: true }
    ]);
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Offline A', 'Offline B']);

    await queueManager.startCampaign(id);
    await waitFor(() => campaignStatus(id) === 'paused');

    expect(provider.calls).toHaveLength(1);
    expect(recipients(id).every(r => r.status === 'queued')).toBe(true);
    expect(queueManager.getStatus().state).toBe('paused');
  });

  it('connection lost mid-send: flags the guest as possibly sent, pauses, and resumes after reconnect', async () => {
    const provider = new RecordingProvider([
      { success: false, status: 'failed', messageId: '', error: 'Lost connection', notReady: true, sendUncertain: true }
    ]);
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Lost A', 'Lost B']);

    await queueManager.startCampaign(id);
    await waitFor(() => campaignStatus(id) === 'paused');
    const [first, second] = recipients(id);
    expect(first.status).toBe('failed');
    expect(first.send_uncertain).toBe(1);
    expect(second.status).toBe('queued');

    // WhatsApp comes back: the queue resumes by itself and sends the next guest
    queueManager.resumeAfterReconnect();
    await waitFor(() => campaignStatus(id) === 'completed');
    expect(provider.calls).toHaveLength(2);
    expect(recipients(id)[1].status).toBe('accepted');
  });

  it('does not auto-resume a campaign the user paused', async () => {
    const provider = new RecordingProvider();
    queueManager.providerFactory = () => provider;
    const { id } = await createCampaign(['Manual A', 'Manual B']);
    await queueManager.startCampaign(id);
    await waitFor(() => provider.calls.length === 1);
    queueManager.pauseCampaign();
    queueManager.resumeAfterReconnect();
    await new Promise(r => setTimeout(r, 1500));
    expect(campaignStatus(id)).toBe('paused');
    expect(provider.calls).toHaveLength(1);
  });

  it('refuses to start a WhatsApp Web campaign while WhatsApp is not connected', async () => {
    const { id } = await createCampaign(['Web Guest']);
    const original = queueManager.isWhatsAppWebReady;
    queueManager.isWhatsAppWebReady = () => false;
    const res = await queueManager.startCampaign(id);
    queueManager.isWhatsAppWebReady = original;
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not connected/);
  });

  it('rejects a duplicate of an active campaign', async () => {
    const contacts = makeContacts(['Dup Guest']);
    const input = {
      name: 'Dup', invitationPdfPath: samplePdf, fontPath: indicFont, outputDir: outDir, pdfConfig,
      messageTemplate: 'Hello {{name}} dup', minIntervalSeconds: 1, maxIntervalSeconds: 1, contacts
    } as any;
    await CampaignService.createCampaign(input);
    await expect(CampaignService.createCampaign(input)).rejects.toBeInstanceOf(DuplicateCampaignError);
  });

  it('rejects min interval greater than max interval', async () => {
    await expect(createCampaign(['Bad Interval'], { minIntervalSeconds: 40, maxIntervalSeconds: 30 })).rejects.toThrow(/Minimum delay/);
  });
});

describe('Font glyph coverage', () => {
  it('reports Gujarati/Hindi support only for fonts that have the glyphs', async () => {
    const nirmala = await PdfService.validateFont(indicFont);
    expect(nirmala.gujaratiSupport).toBe(true);
    expect(nirmala.devanagariSupport).toBe(true);

    const arial = await PdfService.validateFont(latinOnlyFont);
    expect(arial.valid).toBe(true);
    expect(arial.indicSupport).toBe(false);
  });

  it('refuses to generate a PDF whose name would render as empty boxes', async () => {
    fs.mkdirSync(outDir, { recursive: true });
    await expect(
      PdfService.personalizePdf({
        templatePdfPath: samplePdf,
        fontPath: latinOnlyFont,
        guestName: 'પ્રિયા પટેલ',
        config: pdfConfig,
        outputPath: path.join(outDir, 'boxes.pdf')
      })
    ).rejects.toThrow(/no glyphs/);
  });

  it('uses the language-specific font for names in that script', async () => {
    const out = path.join(outDir, 'langfont.pdf');
    await PdfService.personalizePdf({
      templatePdfPath: samplePdf,
      fontPath: latinOnlyFont,
      guestName: 'પ્રિયા પટેલ',
      config: { ...pdfConfig, prefix: '', languageFonts: { gujarati: indicFont } },
      outputPath: out
    });
    expect(fs.existsSync(out)).toBe(true);
  });
});

describe('Maintenance', () => {
  it('prunes finished campaigns older than the retention period but keeps recent ones', () => {
    const db = getDb();
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE settings SET history_retention_days = 90 WHERE id = 1").run();
    db.prepare(`
      INSERT OR REPLACE INTO campaigns (id, name, status, invitation_pdf_path, font_path, output_dir, pdf_config, message_template, created_at)
      VALUES ('camp_old_retention', 'Old', 'completed', 'a.pdf', 'a.ttf', 'out', '{}', 'm', ?)
    `).run(old);

    runMaintenance();

    expect(db.prepare("SELECT id FROM campaigns WHERE id = 'camp_old_retention'").get()).toBeUndefined();
  });
});
