import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { ensureDirectories, PROJECT_ROOT } from './database/db.js';

// Import route modules
import filesRouter from './routes/files.js';
import contactsRouter from './routes/contacts.js';
import pdfRouter from './routes/pdf.js';
import campaignsRouter from './routes/campaigns.js';
import queueRouter from './routes/queue.js';
import settingsRouter from './routes/settings.js';
import logsRouter from './routes/logs.js';
import whatsappRouter from './routes/whatsapp.js';
import { logger } from './utils/logger.js';

export function createApp(): Express {
  // Guarantee folders exist
  ensureDirectories();

  const app = express();

  // Reject requests whose Host is not this machine (blocks DNS-rebinding attacks from web pages)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
      return next();
    }
    res.status(403).json({ error: 'Local access only' });
  });

  // Middleware
  app.use(cors({
    origin: (origin, callback) => {
      // Only allow requests from localhost / 127.0.0.1
      if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        callback(null, true);
      } else {
        callback(new Error('Blocked by local-only CORS policy'));
      }
    },
    credentials: true
  }));

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // API Routes
  app.use('/api/files', filesRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/pdf', pdfRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/queue', queueRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/whatsapp', whatsappRouter);

  // Health check endpoint
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'WhatsApp Invitation Sender Local Backend',
      host: '127.0.0.1',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });

  // Serve production client build if present
  const clientDist = path.join(PROJECT_ROOT, 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) {
        return next();
      }
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handling middleware
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    logger.error('api', `Unhandled API error on ${req.method} ${req.url}: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}

