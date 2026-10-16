import { expect, test } from '@playwright/test';
import { FANTASY_STATS, createRoom, joinAs, quickCharacter } from './helpers.ts';

/** Phase 8 in the browser: returning players after a link change, and the GM pausing on budget. */

test('a returning player (new link, empty browser) asks for their character and the host lets them in', async ({ page: host, browser }) => {
  const { invite } = await createRoom(host, { name: 'Long Road' });
  await quickCharacter(host, { role: 'Fighter', name: 'Ayla', order: FANTASY_STATS });
  const bea = await joinAs(browser, invite, 'Bea');
  await quickCharacter(bea, { role: 'Rogue', name: 'Bram', order: ['Dexterity', 'Charisma', 'Constitution', 'Wisdom', 'Intelligence', 'Strength'] });
  await bea.context().close();

  // Same person, fresh browser (as after a Quick Tunnel restart changes the hostname).
  const back = await (await browser.newContext()).newPage();
  await back.goto(`/join/${invite}`);
  await back.getByRole('button', { name: /Played here before/ }).click();
  await back.getByTestId('rejoin-panel').getByRole('button', { name: /Bram/ }).click();
  await expect(back.getByTestId('rejoin-waiting')).toContainText('Bram');

  const queue = host.getByTestId('rejoin-queue');
  await expect(queue).toContainText('Bram');
  await queue.getByRole('button', { name: 'Let them in' }).click();
  await expect(queue).toHaveCount(0);

  await expect(back.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  await expect(back.getByTestId('sheet-name').first()).toHaveText('Bram');
});

test('at the room budget the GM pauses cleanly and the queued action survives', async ({ page }) => {
  await createRoom(page, { mode: 'solo' });
  await quickCharacter(page, { role: 'Fighter', name: 'Ayla', order: FANTASY_STATS });
  await page.getByRole('button', { name: 'Backup & seats' }).click();
  const budget = page.getByTestId('budget');
  await expect(budget).toContainText('of $5.00 for this room');
  await budget.getByLabel('Daily cap (US$)').fill('0');
  await budget.getByRole('button', { name: 'Set cap' }).click();
  await expect(budget).toContainText('Daily cap set to $0.00');
  await page.getByTestId('campaign-tools').getByRole('button', { name: 'Close' }).click();

  await page.getByLabel(/What does Ayla do\?/).fill('I wait for the storm to pass.');
  await page.getByRole('button', { name: 'Act', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toContainText("This room's daily AI budget ($0.00) is used up");
  await expect(page.getByTestId('my-pending-action')).toContainText('I wait for the storm to pass.');
  await expect(page.getByTestId('narration')).toHaveCount(0);

  // Raising the cap resumes the queued action.
  await page.getByRole('button', { name: 'Backup & seats' }).click();
  await budget.getByLabel('Daily cap (US$)').fill('5');
  await budget.getByRole('button', { name: 'Set cap' }).click();
  await page.getByTestId('campaign-tools').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('narration')).toHaveCount(1);
});
