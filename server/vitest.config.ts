import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20000,
    // Never touch the real data/database.sqlite from tests
    env: {
      WIS_DB_PATH: path.join(os.tmpdir(), `wis-test-${process.pid}-${Date.now()}.sqlite`),
      // Tests exercise logout/clear-session; never point them at the real linked WhatsApp session
      WIS_WHATSAPP_SESSION_DIR: path.join(os.tmpdir(), `wis-test-session-${process.pid}`),
      WIS_LOG_DIR: os.tmpdir()
    },
    // Test files share one module-level queue manager; run them one at a time
    fileParallelism: false
  }
});
