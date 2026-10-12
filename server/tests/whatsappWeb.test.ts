import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAuth } from 'whatsapp-web.js';
import { WhatsAppWebManager, buildClientOptions, WhatsAppClientLike } from '../src/whatsapp/whatsappClient.js';
import { WHATSAPP_CLIENT_ID, WHATSAPP_SESSION_DIR } from '../src/whatsapp/whatsappSession.js';
import { LocalWhatsAppWebProvider } from '../src/services/whatsappService.js';
import { getDb } from '../src/database/db.js';

/** Stand-in for whatsapp-web.js Client: no browser, no network, nothing is ever sent */
class FakeClient extends EventEmitter implements WhatsAppClientLike {
  initializeCalls = 0;
  destroyed = false;
  sent: { chatId: string; options?: Record<string, unknown> }[] = [];
  registered = new Set<string>(['919876543210']);
  info = { wid: { user: '919999988888' }, pushname: 'Test Phone', platform: 'android' };

  async initialize() {
    this.initializeCalls++;
  }
  async destroy() {
    this.destroyed = true;
  }
  async logout() {}
  async getNumberId(number: string) {
    return this.registered.has(number) ? { _serialized: `${number}@c.us` } : null;
  }
  async sendMessage(chatId: string, _content: unknown, options?: Record<string, unknown>) {
    this.sent.push({ chatId, options });
    return { id: { _serialized: `true_${chatId}_MSG${this.sent.length}` }, ack: 0 };
  }
}

const tmpPdf = path.join(os.tmpdir(), 'wis-test-output', 'wa-web-test.pdf');

function setup() {
  const clients: FakeClient[] = [];
  const manager = new WhatsAppWebManager(
    () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    async () => ({ inUse: false }) // no real browsers to clean up in tests
  );
  return { manager, clients };
}

async function connected() {
  const ctx = setup();
  await ctx.manager.connect();
  ctx.clients[0].emit('ready');
  return ctx;
}

describe('WhatsApp Web connection manager', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
    fs.writeFileSync(tmpPdf, '%PDF-1.4 test');
  });

  it('uses LocalAuth with a stable client id and the local session folder', () => {
    const options = buildClientOptions();
    expect(options.authStrategy).toBeInstanceOf(LocalAuth);
    const auth = options.authStrategy as LocalAuth;
    expect(auth.clientId).toBe(WHATSAPP_CLIENT_ID);
    expect(path.resolve(auth.dataPath!)).toBe(path.resolve(WHATSAPP_SESSION_DIR));
    expect(options.puppeteer?.headless).toBe(true);
  });

  it('creates only one client no matter how often connect is called', async () => {
    const { manager, clients } = setup();
    await Promise.all([manager.connect(), manager.connect(), manager.connect()]);
    await manager.connect();
    expect(clients).toHaveLength(1);
    expect(clients[0].initializeCalls).toBe(1);
  });

  it('moves through QR -> authenticating -> connected and exposes the QR as an image', async () => {
    const { manager, clients } = setup();
    const states: string[] = [];
    manager.on('status', s => states.push(s.state));

    await manager.connect();
    clients[0].emit('qr', 'fake-qr-payload');
    await new Promise(r => setTimeout(r, 50)); // QR rendering is async

    const qrStatus = manager.getStatus();
    expect(qrStatus.state).toBe('qr');
    expect(qrStatus.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    clients[0].emit('authenticated');
    expect(manager.getStatus().state).toBe('authenticating');
    expect(manager.isReady()).toBe(false); // authenticated alone is not ready

    clients[0].emit('ready');
    const ready = manager.getStatus();
    expect(ready.state).toBe('connected');
    expect(ready.qrDataUrl).toBeNull();
    expect(ready.account?.name).toBe('Test Phone');
    expect(ready.account?.phoneMasked).toBe('+9199******88');
    expect(manager.isReady()).toBe(true);
    expect(states).toEqual(expect.arrayContaining(['initializing', 'qr', 'authenticating', 'connected']));
  });

  it('reports authentication failure', async () => {
    const { manager, clients } = setup();
    await manager.connect();
    clients[0].emit('auth_failure', 'bad session');
    expect(manager.getStatus().state).toBe('auth_failure');
    expect(manager.isReady()).toBe(false);
  });

  it('a device unlinked from the phone requires a new QR instead of reconnecting', async () => {
    const { manager, clients } = await connected();
    clients[0].emit('disconnected', 'LOGOUT');
    await new Promise(r => setTimeout(r, 50));
    expect(manager.getStatus().state).toBe('disconnected');
    expect(clients[0].destroyed).toBe(true);
    expect(clients).toHaveLength(1); // no automatic restart
  });

  it('other disconnects schedule a reconnect', async () => {
    const { manager, clients } = await connected();
    clients[0].emit('disconnected', 'NAVIGATION');
    await new Promise(r => setTimeout(r, 50));
    expect(manager.getStatus().state).toBe('reconnecting');
    expect(manager.getStatus().reconnectAttempt).toBe(1);
    await manager.shutdown();
  });

  it('sends the PDF as a document with the caption to the resolved chat id', async () => {
    const { manager, clients } = await connected();
    const result = await manager.sendDocument('919876543210', tmpPdf, 'Hello Rahul');
    expect(result.messageId).toContain('919876543210@c.us');
    expect(clients[0].sent[0].chatId).toBe('919876543210@c.us');
    expect(clients[0].sent[0].options).toMatchObject({ caption: 'Hello Rahul', sendMediaAsDocument: true });
  });

  it('upgrades recipient status from delivery receipts and never downgrades', async () => {
    const { clients } = await connected();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO campaigns (id, name, status, invitation_pdf_path, font_path, output_dir, pdf_config, message_template, created_at)
      VALUES ('camp_ack_test', 'Ack', 'completed', 'a.pdf', 'a.ttf', 'out', '{}', 'm', ?)
    `).run(now);
    db.prepare(`
      INSERT OR REPLACE INTO campaign_recipients (id, campaign_id, recipient_index, phone, name, status, whatsapp_message_id, created_at)
      VALUES ('recip_ack', 'camp_ack_test', 0, '919876543210', 'Ack Guest', 'accepted', 'MSG_ACK_1', ?)
    `).run(now);
    const row = () => db.prepare("SELECT status, delivered_at, read_at FROM campaign_recipients WHERE id = 'recip_ack'").get() as any;

    clients[0].emit('message_ack', { id: { _serialized: 'MSG_ACK_1' } }, 1);
    expect(row().status).toBe('sent');
    clients[0].emit('message_ack', { id: { _serialized: 'MSG_ACK_1' } }, 3);
    expect(row().status).toBe('delivered');
    expect(row().read_at).not.toBeNull();
    clients[0].emit('message_ack', { id: { _serialized: 'MSG_ACK_1' } }, 1);
    expect(row().status).toBe('delivered');
  });
});

describe('WhatsApp Web connection loss', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
    fs.writeFileSync(tmpPdf, '%PDF-1.4 test');
  });

  it('a detached frame during number lookup pauses (retry-safe) and starts reconnecting', async () => {
    const { manager, clients } = await connected();
    clients[0].getNumberId = async () => {
      throw new Error("Attempted to use detached Frame 'ABC'.");
    };
    const result = await new LocalWhatsAppWebProvider(manager).sendInvitation({ to: '919876543210', pdfPath: tmpPdf, captionText: 'Hi' });
    expect(result.notReady).toBe(true);
    expect(result.sendUncertain).toBe(false);
    expect(manager.getStatus().state).toBe('reconnecting');
    expect(manager.isReady()).toBe(false);
    await manager.shutdown();
  });

  it('a detached frame during the send itself is flagged as possibly sent', async () => {
    const { manager, clients } = await connected();
    clients[0].sendMessage = async () => {
      throw new Error('Protocol error (Runtime.callFunctionOn): Target closed.');
    };
    const result = await new LocalWhatsAppWebProvider(manager).sendInvitation({ to: '919876543210', pdfPath: tmpPdf, captionText: 'Hi' });
    expect(result.notReady).toBe(true);
    expect(result.sendUncertain).toBe(true);
    await manager.shutdown();
  });

  it('notices when the hidden browser dies and reconnects', async () => {
    const browser = new EventEmitter();
    const clients: FakeClient[] = [];
    const manager = new WhatsAppWebManager(
      () => {
        const c = new FakeClient();
        (c as any).pupBrowser = browser;
        clients.push(c);
        return c;
      },
      async () => ({ inUse: false })
    );
    await manager.connect();
    clients[0].emit('ready');
    browser.emit('disconnected');
    expect(manager.getStatus().state).toBe('reconnecting');
    expect(clients[0].destroyed).toBe(true);
    await manager.shutdown();
  });

  it('refuses to start when another running copy owns the session, without killing its browser', async () => {
    let created = 0;
    const manager = new WhatsAppWebManager(
      () => {
        created++;
        return new FakeClient();
      },
      async () => ({ inUse: true })
    );
    await manager.connect();
    expect(created).toBe(0);
    expect(manager.getStatus().state).toBe('disconnected');
    expect(manager.getStatus().lastError).toMatch(/another running copy/);
  });
});

describe('WhatsApp Web provider', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
    fs.writeFileSync(tmpPdf, '%PDF-1.4 test');
  });

  it('reports not-ready (so the queue pauses) when WhatsApp is disconnected', async () => {
    const { manager } = setup();
    const result = await new LocalWhatsAppWebProvider(manager).sendInvitation({ to: '919876543210', pdfPath: tmpPdf, captionText: 'Hi' });
    expect(result.success).toBe(false);
    expect(result.notReady).toBe(true);
  });

  it('fails a recipient who is not on WhatsApp without throwing', async () => {
    const { manager } = await connected();
    const result = await new LocalWhatsAppWebProvider(manager).sendInvitation({ to: '911111111111', pdfPath: tmpPdf, captionText: 'Hi' });
    expect(result.success).toBe(false);
    expect(result.notReady).toBeFalsy();
    expect(result.error).toMatch(/not registered on WhatsApp/);
  });

  it('fails cleanly when the PDF is missing', async () => {
    const { manager, clients } = await connected();
    const result = await new LocalWhatsAppWebProvider(manager).sendInvitation({
      to: '919876543210',
      pdfPath: path.join(os.tmpdir(), 'does-not-exist.pdf'),
      captionText: 'Hi'
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing or unreadable/);
    expect(clients[0].sent).toHaveLength(0);
  });

  it('returns the message id as accepted, not delivered', async () => {
    const { manager } = await connected();
    const result = await new LocalWhatsAppWebProvider(manager).sendInvitation({ to: '919876543210', pdfPath: tmpPdf, captionText: 'Hi' });
    expect(result.success).toBe(true);
    expect(result.status).toBe('accepted');
  });
});
