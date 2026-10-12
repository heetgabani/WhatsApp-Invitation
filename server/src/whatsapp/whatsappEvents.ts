import { Request, Response } from 'express';
import { whatsappWeb, WhatsAppConnectionStatus } from './whatsappClient.js';

/**
 * Server-Sent Events stream of connection status (including the QR image while waiting for a scan).
 * The UI subscribes once instead of polling or re-initializing the client to get a fresh QR.
 */
export function streamWhatsAppStatus(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Stop proxies (incl. the Vite dev proxy) from buffering the stream
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (status: WhatsAppConnectionStatus) => {
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
  };

  send(whatsappWeb.getStatus());
  whatsappWeb.on('status', send);

  // Comment line every 25s keeps the connection open through idle periods
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    whatsappWeb.off('status', send);
  });
}
