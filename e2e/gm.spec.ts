import { type Page, expect, test } from '@playwright/test';
import { createRoom, joinAs, quickCharacter } from './helpers.ts';

/**
 * Phase 4 in the browser, against the offline GM (no API key): actions go in, the server
 * rolls, narration streams in and lands in the story, suggestions fill the action box.
 */

const order = ['Strength', 'Constitution', 'Dexterity', 'Wisdom', 'Charisma', 'Intelligence'];

async function act(page: Page, text: string) {
  await page.getByLabel(/What does .* do\?/).fill(text);
  await page.getByRole('button', { name: 'Act' }).click();
}

test('solo: act, the GM rolls and narrates, suggestions and rewind work', async ({ page }) => {
  await createRoom(page, { mode: 'solo' });
  await quickCharacter(page, { role: 'Fighter', name: 'Ayla', order });

  // Opening hooks prefill the action box.
  await page.getByRole('button', { name: /dying courier/ }).click();
  await expect(page.getByLabel(/What does Ayla do\?/)).toHaveValue(/Let's begin: A dying courier/);
  await act(page, 'I search the courier for the map.');

  const feed = page.getByTestId('story-feed');
  await expect(feed.getByTestId('narration')).toHaveCount(1);
  await expect(feed.getByTestId('narration')).toContainText('The world waits for your next move.');
  await expect(feed.getByText('Ayla:')).toBeVisible();
  await expect(feed.getByRole('listitem').filter({ hasText: /vs 12/ }).first()).toBeVisible(); // the server's check
  await expect(page.getByTestId('turn-status')).toHaveText('Your move.');

  // A suggestion fills the action box.
  await page.getByTestId('suggestion').first().click();
  await expect(page.getByLabel(/What does Ayla do\?/)).toHaveValue('Look around carefully');

  // Story so far shows the whole story.
  await page.getByRole('button', { name: 'Story so far' }).click();
  await expect(page.getByTestId('story-reader')).toContainText('I search the courier for the map.');
  await page.getByTestId('story-reader').getByRole('button', { name: 'Close' }).click();

  // Rewind: the turn disappears from the story; the action is queued again.
  await page.getByRole('button', { name: 'Rewind last turn' }).click();
  await expect(feed).toHaveCount(0);
  await expect(page.getByTestId('my-pending-action')).toContainText('I search the courier for the map.');
  await page.getByRole('button', { name: 'Resolve now' }).click();
  await expect(page.getByTestId('narration')).toHaveCount(1);
});

test('group round: both actions show to the table and resolve in one GM turn', async ({ page: host, browser }) => {
  const { invite } = await createRoom(host);
  await quickCharacter(host, { role: 'Fighter', name: 'Ayla', order });
  const guest = await joinAs(browser, invite, 'Bea');
  await quickCharacter(guest, { role: 'Rogue', name: 'Bram', order: ['Dexterity', 'Charisma', 'Constitution', 'Wisdom', 'Intelligence', 'Strength'] });

  await act(host, 'I kick open the door.');
  await expect(guest.getByLabel("Other players' actions")).toContainText('Ayla: I kick open the door.');
  await expect(guest.getByTestId('turn-status')).toContainText('Waiting for Bea');
  await act(guest, 'I sneak in behind Ayla.');

  for (const p of [host, guest]) {
    await expect(p.getByTestId('story-turn')).toHaveCount(1);
    await expect(p.getByTestId('story-turn')).toContainText('Ayla: I kick open the door.');
    await expect(p.getByTestId('story-turn')).toContainText('Bram: I sneak in behind Ayla.');
    await expect(p.getByTestId('narration')).toHaveCount(1);
  }
});

test('spotlight: only the player in the spotlight can act', async ({ page: host, browser }) => {
  const { invite } = await createRoom(host);
  await quickCharacter(host, { role: 'Fighter', name: 'Ayla', order });
  const guest = await joinAs(browser, invite, 'Bea');
  await quickCharacter(guest, { role: 'Cleric', name: 'Bram', order: ['Wisdom', 'Constitution', 'Strength', 'Charisma', 'Dexterity', 'Intelligence'] });

  await host.getByLabel('Turn mode').selectOption('spotlight');
  await expect(guest.getByTestId('turn-status')).toHaveText('Spotlight: Cordell');
  await expect(guest.getByLabel(/What does Bram do\?/)).toBeDisabled();
  await act(host, 'I ask the innkeeper about the road north.');
  await expect(guest.getByTestId('turn-status')).toHaveText('Spotlight: Bea (you)');
  await expect(guest.getByLabel(/What does Bram do\?/)).toBeEnabled();
  await expect(host.getByLabel(/What does Ayla do\?/)).toBeDisabled();
});

test('the sheet shows 5e details, and players workshop abilities for host approval', async ({ page: host, browser }) => {
  const { invite } = await createRoom(host);
  await quickCharacter(host, { role: 'Wizard', name: 'Ilse', order: ['Intelligence', 'Dexterity', 'Constitution', 'Wisdom', 'Charisma', 'Strength'] });
  const sheet = host.getByTestId('character-sheet');
  await expect(sheet.getByTestId('spell-slots')).toContainText('Spell slots');
  await expect(sheet.getByTestId('abilities')).toContainText('Spellcasting (Intelligence)');
  await expect(sheet.getByTestId('skills')).toContainText('● Arcana');
  await expect(sheet.getByText('Proficiency bonus +2')).toBeVisible();

  const guest = await joinAs(browser, invite, 'Bea');
  await quickCharacter(guest, { role: 'Fighter', name: 'Bram', order });
  const gsheet = guest.getByTestId('character-sheet');
  await gsheet.getByRole('button', { name: '+ Workshop' }).click();
  await gsheet.getByLabel(/Describe it/).fill('A battle cry that steadies my allies');
  await gsheet.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(gsheet.getByLabel('Ability name')).toHaveValue('Workshopped Ability');
  await gsheet.getByLabel('Ability name').fill('Rallying Cry');
  await expect(gsheet.getByLabel('Comparable to')).toHaveValue(/Offline draft/);
  await gsheet.getByLabel('Comparable to').fill('Like Bardic Inspiration');
  await gsheet.getByRole('button', { name: 'Send to host' }).click();
  await expect(gsheet.getByText('Sent to the host for approval.')).toBeVisible();

  const queue = host.getByTestId('approval-queue');
  await expect(queue).toContainText('Rallying Cry for Bram');
  await expect(queue).toContainText('Like Bardic Inspiration');
  await queue.getByRole('button', { name: 'Approve' }).click();
  await expect(gsheet.getByTestId('abilities')).toContainText('Rallying Cry');
});

test('sci-fi sheets use Starforged-style names with Spirit and Supply', async ({ page }) => {
  await createRoom(page, { mode: 'solo', preset: 'Sci-fi', name: 'Black Meridian' });
  await quickCharacter(page, { role: 'Engineer', name: 'Vex', order: ['Wits', 'Grit', 'Edge', 'Shadow', 'Heart', 'Iron'] });
  const sheet = page.getByTestId('character-sheet');
  await expect(sheet.getByTestId('meters')).toContainText('Spirit');
  await expect(sheet.getByTestId('meters')).toContainText('Supply');
  await expect(sheet.getByTestId('spell-slots')).toContainText('Tech charges');
  await expect(sheet.getByTestId('skills')).toContainText('Precursor Lore');
  await expect(sheet.getByTestId('stat-int')).toContainText('Wits');
});

test('sessions end with a recap; chapters and world notes live in Story so far', async ({ page }) => {
  await createRoom(page, { mode: 'solo' });
  await quickCharacter(page, { role: 'Fighter', name: 'Ayla', order });
  await page.getByRole('button', { name: 'Start session 1' }).click();
  await act(page, 'I ask the innkeeper for rumours.');
  await expect(page.getByTestId('narration')).toHaveCount(1);
  await page.getByRole('button', { name: 'End session 1' }).click();
  const recap = page.getByTestId('recap');
  await expect(recap).toContainText('Previously, in session 1');
  await expect(recap).toContainText('Previously:');
  await page.getByRole('button', { name: 'Story so far' }).click();
  const reader = page.getByTestId('story-reader');
  await expect(reader).toContainText('Recap of session 1');
  await reader.getByRole('tab', { name: 'Chapters' }).click();
  await expect(reader).toContainText('Chapters are written every 10 turns.');
  await reader.getByRole('tab', { name: 'World notes' }).click();
  await expect(reader).toContainText('records people, places and factions');
});
