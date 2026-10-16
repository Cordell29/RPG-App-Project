import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** Phase 8: the shipped bundle has no keys, and the leak check really catches one. */

test('the web bundle contains no API keys', () => {
  const out = execFileSync('node', ['scripts/check-bundle.mjs', 'apps/web/dist'], {
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key-for-testing', GEMINI_API_KEY: 'AIzaNotARealKeyForTestingPurposes0000000' },
  }).toString();
  expect(out).toMatch(/files clean/);
});

test('the leak check fails on a planted key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index.js'), 'const k="sk-ant-api03-abcdefghijklmnop";');
  let code = 0;
  try {
    execFileSync('node', ['scripts/check-bundle.mjs', dir], { stdio: 'pipe' });
  } catch (e) {
    code = (e as { status: number }).status;
  }
  expect(code).toBe(1);
});

test('pages are served with a strict CSP that the app actually runs under', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text());
  });
  const res = await page.goto('/');
  expect(res!.headers()['content-security-policy']).toMatch(/script-src 'self'/);
  await expect(page.getByRole('button', { name: 'New campaign' })).toBeVisible();
  expect(errors).toEqual([]);
});
