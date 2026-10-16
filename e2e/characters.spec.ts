import { devices, expect, test } from '@playwright/test';
import { createRoom, joinAs, quickCharacter } from './helpers.ts';

/**
 * Phase 3 acceptance: players build characters through commands, cannot change their own
 * HP or gold, and a host override appears on every client within 1 s. Desktop and mobile.
 */

test('characters live in the sidebar; host overrides reach players within a second', async ({ page: host, browser }) => {
  const { invite } = await createRoom(host);
  const guest = await joinAs(browser, invite, 'Bea');

  // The sidebar opens on the Character tab, showing the creator until you have one.
  await expect(guest.getByRole('tab', { name: 'Character' })).toHaveAttribute('aria-selected', 'true');
  await quickCharacter(guest, { role: 'Rogue', name: 'Bram', order: ['Dexterity', 'Constitution', 'Wisdom', 'Intelligence', 'Charisma', 'Strength'] });
  const sheet = guest.getByTestId('character-sheet');
  await expect(sheet.getByTestId('sheet-hp')).toHaveText('12/12'); // 10 + CON 14 (+2)
  await expect(sheet.getByTestId('sheet-ac')).toHaveText('12'); // 10 + DEX 15 (+2)
  await expect(sheet.getByTestId('sheet-gold')).toHaveText('10');
  await expect(sheet.getByTestId('inventory')).toContainText("Thieves' tools");
  await expect(sheet.getByTestId('stat-dex')).toContainText('+2');

  // Players have no controls for HP or gold, and no host button.
  await expect(guest.getByRole('button', { name: 'Host edit' })).toHaveCount(0);
  await expect(guest.getByTestId('host-controls')).toHaveCount(0);

  // Equip is allowed for your own items.
  await sheet.getByRole('button', { name: 'Equip' }).first().click();
  await expect(sheet.getByText('equipped')).toBeVisible();

  // Host finds Bram in the Party tab and applies an override.
  await host.getByRole('tab', { name: 'Party' }).click();
  await host.getByTestId('party-member').filter({ hasText: 'Bram' }).getByRole('button').first().click();
  await host.getByRole('button', { name: 'Host edit' }).click();
  const controls = host.getByTestId('host-controls');
  await controls.getByLabel('Amount').fill('4');
  const t0 = Date.now();
  await controls.getByRole('button', { name: 'Damage −4' }).click();
  await expect(sheet.getByTestId('sheet-hp')).toHaveText('8/12', { timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1000);

  await controls.getByRole('button', { name: 'gold +4' }).click();
  await expect(sheet.getByTestId('sheet-gold')).toHaveText('14', { timeout: 1000 });

  await controls.getByText('Items').click();
  await controls.getByLabel('New item name').fill('Potion of Healing');
  await controls.getByRole('button', { name: 'Give item' }).click();
  await expect(sheet.getByTestId('inventory')).toContainText('Potion of Healing', { timeout: 1000 });

  // Owners can edit their notes; the change syncs to the host's view.
  await sheet.getByRole('button', { name: 'Edit name, look and notes' }).click();
  await sheet.getByRole('textbox', { name: 'Notes' }).fill('Owes the Gilded Goose a tab.');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(host.getByTestId('sheet-notes')).toHaveText('Owes the Gilded Goose a tab.');
});

test('describe your own character, then edit the draft before creating', async ({ page }) => {
  await createRoom(page, { mode: 'solo' });
  const creator = page.getByTestId('character-creator');
  await creator.getByRole('tab', { name: 'Describe your own' }).click();
  await creator.getByLabel('Who are they?').fill('Thorga, a stubborn dwarf smith searching for her missing brother.');
  await creator.getByRole('button', { name: 'Draft my character' }).click();
  // The draft lands in the editable form with legal standard-array stats.
  await expect(creator.getByLabel('Name', { exact: true })).toHaveValue('Thorga');
  await expect(creator.getByLabel('Strength', { exact: true })).toHaveValue('15');
  await creator.getByLabel('Personal item name').fill("Brother's hammer");
  await creator.getByRole('button', { name: 'Create character' }).click();
  await expect(page.getByTestId('sheet-name')).toHaveText('Thorga');
  await expect(page.getByTestId('inventory')).toContainText("Brother's hammer");
});

test('rolled stats come from six visible server rolls', async ({ page }) => {
  await createRoom(page, { mode: 'solo' });
  const creator = page.getByTestId('character-creator');
  await creator.getByRole('radio', { name: 'Roll 4d6' }).click();
  await creator.getByRole('button', { name: 'Roll my scores' }).click();
  await expect(page.getByTestId('roll-entry')).toHaveCount(6);
  await expect(creator.getByText('Your rolls:')).toBeVisible();
  await expect(creator.getByRole('button', { name: 'Roll my scores' })).toHaveCount(0);
});

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

test.describe('on a phone', () => {
  test.use(pixel);

  test('bottom tabs reach every panel, including the character sheet', async ({ page }) => {
    await createRoom(page, { mode: 'solo', preset: 'Sci-fi', name: 'Black Meridian' });
    const nav = page.getByRole('navigation', { name: 'Table sections' });
    await expect(nav).toBeVisible();
    for (const label of ['Story', 'Sheet', 'Dice', 'Party', 'Chat']) await expect(nav.getByRole('tab', { name: label })).toBeVisible();

    // No character yet, so the Sheet tab is open with the creator.
    await expect(nav.getByRole('tab', { name: 'Sheet' })).toHaveAttribute('aria-selected', 'true');
    await quickCharacter(page, { role: 'Pilot', name: 'Vex', order: ['Reflex', 'Insight', 'Grit', 'Tech', 'Presence', 'Might'] });

    await nav.getByRole('tab', { name: 'Dice' }).click();
    await page.getByRole('button', { name: /^d20/ }).click();
    await expect(page.getByTestId('roll-entry')).toHaveCount(1);

    await nav.getByRole('tab', { name: 'Chat' }).click();
    await page.getByLabel('Message').fill('Engines hot.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-line')).toHaveText(['Cordell: Engines hot.']);

    await nav.getByRole('tab', { name: 'Party' }).click();
    await expect(page.getByTestId('party-member')).toContainText('Vex');

    // Nothing overflows sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

