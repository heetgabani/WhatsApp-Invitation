import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { whatsappWeb } from '../whatsapp/whatsappClient.js';
import { streamWhatsAppStatus } from '../whatsapp/whatsappEvents.js';
import { queueManager } from '../queue/sendingQueue.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Current connection status (no session data, only display info and the QR image when needed)
 */
router.get('/status', (req: Request, res: Response) => {
  res.json({ success: true, status: whatsappWeb.getStatus() });
});

/**
 * Current QR image, if WhatsApp is waiting for a scan
 */
router.get('/qr', (req: Request, res: Response) => {
  const { state, qrDataUrl } = whatsappWeb.getStatus();
  res.json({ success: true, state, qrDataUrl });
});

/**
 * Live status stream (Server-Sent Events)
 */
router.get('/events', streamWhatsAppStatus);

/**
 * Start the shared client (no-op if already starting/connected)
 */
router.post('/connect', async (req: Request, res: Response) => {
  // Don't await initialization: it can take a minute; progress arrives over /events
  whatsappWeb.connect().catch(err => logger.error('whatsapp', `Connect failed: ${err.message}`));
  res.json({ success: true, status: whatsappWeb.getStatus() });
});

router.post('/reconnect', async (req: Request, res: Response) => {
  whatsappWeb.reconnect().catch(err => logger.error('whatsapp', `Reconnect failed: ${err.message}`));
  res.json({ success: true, status: whatsappWeb.getStatus() });
});

const confirmSchema = z.object({ confirm: z.literal(true) });

function refuseWhileSending(res: Response): boolean {
  const queue = queueManager.getStatus();
  if (queue.state === 'running') {
    res.status(409).json({ success: false, error: 'A campaign is sending. Pause or cancel it before logging out.' });
    return true;
  }
  return false;
}

/**
 * Unlink this computer from the phone and delete the local session
 */
router.post('/logout', async (req: Request, res: Response) => {
  if (!confirmSchema.safeParse(req.body).success) {
    return res.status(400).json({ success: false, error: 'Logout must be confirmed ({ "confirm": true }).' });
  }
  if (refuseWhileSending(res)) return;
  try {
    const status = await whatsappWeb.logout();
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Logout failed. Try "Clear session" instead.' });
  }
});

/**
 * Delete local session files without contacting WhatsApp (stuck or corrupt session)
 */
router.post('/clear-session', async (req: Request, res: Response) => {
  if (!confirmSchema.safeParse(req.body).success) {
    return res.status(400).json({ success: false, error: 'Clearing the session must be confirmed ({ "confirm": true }).' });
  }
  if (refuseWhileSending(res)) return;
  try {
    const status = await whatsappWeb.clearSession();
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Could not delete the session folder. Stop the app, then delete data/whatsapp-session manually.' });
  }
});

export default router;
