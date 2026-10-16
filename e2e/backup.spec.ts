import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FANTASY_STATS, createRoom, joinAs, quickCharacter } from './helpers.ts';

/** Phase 7 in the browser: starting locations, export, restore into a new room, rejoin links. */

test('custom start, then re-roll somewhere else before the first turn', async ({ page }) => {
  await page.goto('/new');
  await page.getByRole('button', { name: 'Play Sci-fi' }).click();
  await page.getByLabel('Campaign name').fill('Lucky Void');
  await page.getByLabel('Your name').fill('Cordell');
  await page.getByRole('radio', { name: /Solo/ }).check();
  await page.getByRole('radio', { name: /Write your own/ }).check();
  await page.getByLabel('Name of the place (optional)').fill('The Lucky Void');
  await page.getByLabel('Describe the starting location').fill('A derelict casino orbiting a dead star. The tables are still dealing.');
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await page.getByLabel("I've saved my host link").check();
  await page.getByRole('button', { name: 'Enter the tavern' }).click();
  await expect(page.getByTestId('opening-title')).toHaveText('The Lucky Void');
  await expect(page.getByTestId('opening')).toContainText('tables are still dealing');

  await page.getByRole('button', { name: /Somewhere else/ }).click();
  await expect(page.getByTestId('opening-title')).not.toHaveText('The Lucky Void');
  await expect(page.getByTestId('opening').getByRole('listitem').first()).toBeVisible(); // table starts come with hooks
});

test('export, restore into a new room, and hand a player their seat back', async ({ page, browser }) => {
  const { invite } = await createRoom(page, { name: 'Saltreach Run' });
  await quickCharacter(page, { role: 'Fighter', name: 'Ayla', order: FANTASY_STATS });
  const guest = await joinAs(browser, invite, 'Bea');
  await quickCharacter(guest, { role: 'Rogue', name: 'Bram', order: ['Dexterity', 'Charisma', 'Constitution', 'Wisdom', 'Intelligence', 'Strength'] });
  await page.getByLabel(/What does Ayla do\?/).fill('I scout the road ahead.');
  await page.getByRole('button', { name: 'Act', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve now' }).click();
  await expect(page.getByTestId('narration')).toHaveCount(1);

  // Download the campaign file.
  await page.getByRole('button', { name: 'Backup & seats' }).click();
  const tools = page.getByTestId('campaign-tools');
  const [download] = await Promise.all([page.waitForEvent('download'), tools.getByRole('button', { name: 'Download campaign file' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^saltreach-run-\d{4}-\d{2}-\d{2}\.tavern\.json$/);
  const path = (await download.path())!;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  expect(file.format).toBe('tavern-campaign');
  await tools.getByRole('button', { name: 'Close' }).click();

  // A damaged copy is refused with a readable message.
  const restore = await (await browser.newContext()).newPage();
  await restore.goto('/');
  await restore.getByRole('button', { name: 'Restore a campaign from a backup file' }).click();
  const broken = join(tmpdir(), `broken-${Date.now()}.tavern.json`);
  writeFileSync(broken, readFileSync(path, 'utf8').slice(0, 500));
  await restore.getByLabel('Campaign file').setInputFiles(broken);
  await restore.getByRole('button', { name: 'Restore campaign' }).click();
  await expect(restore.getByTestId('import-error')).toContainText("isn't valid JSON");

  // The real file restores into a new room with the same story; the restorer is host.
  await restore.getByLabel('Campaign file').setInputFiles(path);
  await restore.getByRole('button', { name: 'Restore campaign' }).click();
  await restore.getByLabel("I've saved my host link").check();
  await restore.getByRole('button', { name: 'Enter the tavern' }).click();
  await expect(restore.getByTestId('room-name')).toHaveText('Saltreach Run');
  await expect(restore.getByTestId('narration')).toHaveCount(1);
  await expect(restore.getByTestId('sheet-name').first()).toHaveText('Ayla');
  expect(new URL(restore.url()).pathname).not.toBe(new URL(page.url()).pathname);

  // Rejoin link for Bea's seat: a fresh browser gets Bram back.
  await restore.getByRole('button', { name: 'Backup & seats' }).click();
  const seat = restore.getByTestId('seat').filter({ hasText: 'Bram' });
  restore.once('dialog', (d) => void d.accept());
  await seat.getByRole('button', { name: 'Rejoin link' }).click();
  const link = (await seat.getByTestId('seat-link').textContent())!.trim();
  const bea = await (await browser.newContext()).newPage();
  await bea.goto(link);
  await expect(bea.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  await expect(bea.getByTestId('sheet-name').first()).toHaveText('Bram');
  await expect(bea.getByTestId('room-name')).toHaveText('Saltreach Run');
  expect(bea.url()).not.toContain('seat=');
});

test('host rebuilds state and everyone stays in sync', async ({ page }) => {
  await createRoom(page, { mode: 'solo' });
  await quickCharacter(page, { role: 'Fighter', name: 'Ayla', order: FANTASY_STATS });
  await page.getByLabel(/What does Ayla do\?/).fill('I look around.');
  await page.getByRole('button', { name: 'Act', exact: true }).click();
  await expect(page.getByTestId('narration')).toHaveCount(1);
  await page.getByRole('button', { name: 'Backup & seats' }).click();
  await page.getByRole('button', { name: 'Rebuild state' }).click();
  await expect(page.getByTestId('tools-note')).toContainText('State rebuilt');
  await page.getByTestId('campaign-tools').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('narration')).toHaveCount(1);
  await expect(page.getByTestId('sheet-name').first()).toHaveText('Ayla');
});
