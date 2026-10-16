import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const dataDir = mkdtempSync(join(tmpdir(), 'tavern-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm --filter @tavern/web build && node apps/server/src/index.ts',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' },
  },
});
