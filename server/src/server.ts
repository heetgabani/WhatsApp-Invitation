import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { closeDb, PROJECT_ROOT } from './database/db.js';
import { startMaintenance, stopMaintenance } from './services/maintenanceService.js';
import { whatsappWeb } from './whatsapp/whatsappClient.js';
import { hasSavedSession } from './whatsapp/whatsappSession.js';
import { queueManager } from './queue/sendingQueue.js';
import { logger } from './utils/logger.js';

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = '127.0.0.1'; // Enforce local-only network binding

const app = createApp();

const server = app.listen(PORT, HOST, () => {
  console.log('\n================================================================');
  console.log('   LOCAL WHATSAPP INVITATION SENDER — BACKEND');
  console.log('================================================================');
  console.log(`   Local API URL:     http://${HOST}:${PORT}`);
  console.log(`   Health Check:      http://${HOST}:${PORT}/api/health`);
  console.log(`   Client Dashboard:  http://localhost:5173 (dev)`);
  console.log('   Security:          Strictly bound to 127.0.0.1 (Localhost only)');
  console.log('   Database:          SQLite local database connected');
  console.log('================================================================\n');

  logger.info('system', `Local server running on http://${HOST}:${PORT}`);
  startMaintenance();

  // Reuse a previously linked WhatsApp session without a new QR scan
  if (hasSavedSession()) {
    logger.info('whatsapp', 'Saved WhatsApp Web session found; reconnecting...');
    whatsappWeb.connect().catch(err => logger.error('whatsapp', `Auto-connect failed: ${err.message}`));
  }
});

// Graceful shutdown handling
let shuttingDown = false;
async function handleShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  logger.info('system', `Shutdown initiated by signal ${signal}`);

  // Force exit if something hangs (covers the bounded wait for an in-flight send below)
  setTimeout(() => {
    console.error('Forcefully terminating after timeout');
    process.exit(1);
  }, 15000).unref();

  stopMaintenance();

  // 1. Pause the queue and let an in-flight WhatsApp send finish so its result is recorded
  try {
    await queueManager.shutdown(10000);
  } catch (err) {
    // ignore
  }

  // 2. Close the WhatsApp Web browser; the saved session stays on disk for the next start
  try {
    await whatsappWeb.shutdown();
  } catch (err) {
    // ignore
  }

  // 3. Close HTTP server
  server.closeAllConnections();
  server.close(() => {
    // 4. Close SQLite DB cleanly
    try {
      closeDb();
      console.log('Database connection closed cleanly.');
    } catch (err) {
      // ignore
    }
    console.log('Application stopped.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
// Windows sends SIGHUP when the console window is closed; shut down so Chrome does not stay orphaned
process.on('SIGHUP', () => handleShutdown('SIGHUP'));

