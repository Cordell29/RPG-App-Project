import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { FANTASY_STATS, createRoom, quickCharacter } from './helpers.ts';

/** Phase 6 in the browser with the offline image/voice mocks (no GEMINI_API_KEY). */

test('portrait, scene illustration, AI voice and the Markdown download', async ({ page }) => {
  await createRoom(page, { mode: 'solo', name: 'Painted Hall' });
  await quickCharacter(page, { role: 'Fighter', name: 'Ayla', order: FANTASY_STATS });

  // The creation portrait is painted and served as a WebP.
  const portrait = page.getByTestId('portrait').first();
  await expect(portrait).toHaveAttribute('data-state', 'ready');
  const img = portrait.getByRole('img', { name: 'Portrait of Ayla' });
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // Host illustrates the scene: a banner appears.
  await page.getByRole('button', { name: 'Illustrate scene' }).click();
  await expect(page.getByTestId('scene-image').getByTestId('illustration')).toBeVisible();

  // AI voice: narration gets a recorded clip.
  await page.getByLabel('AI voice').click();
  await expect(page.getByLabel('AI voice')).toBeChecked(); // controlled: flips once the server broadcasts settings
  await page.getByLabel(/What does Ayla do\?/).fill('I listen at the door.');
  await page.getByRole('button', { name: 'Act', exact: true }).click();
  const speak = page.getByTestId('story-feed').getByRole('button', { name: 'Read aloud' }).first();
  await expect(speak).toHaveAttribute('data-voice', 'ai');

  // Story so far → Download gives a Markdown file with the story in it.
  await page.getByRole('button', { name: 'Story so far' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('story-reader').getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('painted-hall-story.md');
  const md = readFileSync((await download.path())!, 'utf8');
  expect(md).toContain('# Painted Hall');
  expect(md).toContain('## World notes');
  expect(md).toContain('I listen at the door.');
});
