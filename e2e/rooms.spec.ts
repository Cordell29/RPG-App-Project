import { type Browser, type Page, expect, test } from '@playwright/test';

/**
 * Phase 2 acceptance: two browsers see the same chat and rolls; dropping one browser's
 * connection mid-session and reconnecting loses nothing and duplicates nothing.
 */

async function createFantasyRoom(page: Page, mode: 'solo' | 'group' = 'group') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New campaign' }).click();
  await page.getByRole('button', { name: 'Play Fantasy' }).click();
  await page.getByLabel('Campaign name').fill('The Gilded Goose');
  await page.getByLabel('Your name').fill('Cordell');
  await page.getByRole('radio', { name: mode === 'solo' ? /Solo/ : /With friends/ }).check();
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByRole('heading', { name: 'Save your host link' })).toBeVisible();
  const hostLink = (await page.getByTestId('host-link').textContent())!;
  const invite = mode === 'group' ? (await page.getByTestId('invite-code').textContent())!.trim() : '';
  await page.getByLabel("I've saved my host link").check();
  await page.getByRole('button', { name: 'Enter the tavern' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  return { hostLink, invite };
}

async function joinAs(browser: Browser, invite: string, name: string, roomName = 'The Gilded Goose') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/join/${invite}`);
  await expect(page.getByTestId('join-room-name')).toHaveText(roomName);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Take a seat' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  return page;
}

async function chat(page: Page, text: string) {
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

const chatLines = (page: Page) => page.getByTestId('chat-line').allTextContents();
const rollLines = (page: Page) => page.getByTestId('roll-entry').allTextContents();

test('two players share chat and dice, and a dropped connection catches up exactly', async ({ page: host, browser }) => {
  const { invite } = await createFantasyRoom(host);
  await expect(host.locator('html')).toHaveAttribute('data-theme', 'parchment');
  expect(invite).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const guest = await joinAs(browser, invite, 'Bea');
  for (const [p, other] of [[host, 'Bea'], [guest, 'Cordell']] as const) {
    await p.getByRole('tab', { name: 'Party' }).click();
    await expect(p.getByTestId('party-panel')).toContainText(other);
    await p.getByRole('tab', { name: 'Chat' }).click();
  }

  // Chat both ways.
  await chat(host, 'Welcome to the Goose!');
  await chat(guest, 'Thanks, first round is on me.');
  for (const p of [host, guest]) {
    await expect(p.getByTestId('chat-line')).toHaveText(['Cordell: Welcome to the Goose!', 'Bea: Thanks, first round is on me.']);
  }

  // Quick roll from the host, custom roll from the guest: identical results on both screens.
  await host.getByRole('button', { name: /^d20/ }).click();
  await expect(guest.getByTestId('roll-entry')).toHaveCount(1);
  await guest.getByLabel('Custom roll').fill('2d6+3');
  await guest.getByLabel('For (optional)').fill('damage');
  await guest.getByRole('button', { name: 'Roll', exact: true }).click();
  await expect(host.getByTestId('roll-entry')).toHaveCount(2);
  await expect(guest.getByTestId('roll-entry')).toHaveCount(2);
  expect(await rollLines(guest)).toEqual(await rollLines(host));
  await expect(host.getByTestId('latest-roll')).toContainText('Bea rolled 2d6+3');
  // The die animation lands on the server's value on both screens.
  await expect(host.getByTestId('die')).not.toHaveAttribute('data-value', '');
  await expect(guest.getByTestId('die')).toHaveAttribute('data-value', (await host.getByTestId('die').getAttribute('data-value'))!);

  // Kill the guest's connection mid-session.
  await guest.evaluate(() => (window as unknown as { __tavern: { drop: () => void } }).__tavern.drop());
  await expect(guest.getByTestId('connection-status')).toHaveAttribute('data-status', 'reconnecting');
  await chat(host, 'Are you still there?');
  await chat(host, 'Bea?');
  await host.getByRole('button', { name: /^d6/ }).click();
  await chat(host, 'Rolling without you.');
  await expect(host.getByTestId('chat-line')).toHaveCount(5);
  await expect(guest.getByTestId('chat-line')).toHaveCount(2);

  // Reconnect: everything missed arrives once, in order.
  await guest.evaluate(() => (window as unknown as { __tavern: { restore: () => void } }).__tavern.restore());
  await expect(guest.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  await expect(guest.getByTestId('chat-line')).toHaveCount(5);
  await expect(guest.getByTestId('roll-entry')).toHaveCount(3);
  await chat(guest, 'Back! Wifi hiccup.');
  await expect(host.getByTestId('chat-line')).toHaveCount(6);
  await expect(guest.getByTestId('chat-line')).toHaveCount(6);
  expect(await chatLines(guest)).toEqual(await chatLines(host));
  expect(await rollLines(guest)).toEqual(await rollLines(host));

  // A full reload rebuilds from the saved seat with the same history and no duplicates.
  await guest.reload();
  await expect(guest.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  await expect(guest.getByTestId('chat-line')).toHaveCount(6);
  expect(await chatLines(guest)).toEqual(await chatLines(host));
  expect(await rollLines(guest)).toEqual(await rollLines(host));
});

test('the host link restores host controls in a fresh browser', async ({ page, browser }) => {
  const { hostLink, invite } = await createFantasyRoom(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto(hostLink);
  await expect(other.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  await expect(other).not.toHaveURL(/host=/);
  await expect(other.getByText("You're the host")).toBeVisible();
  await expect(other.getByTestId('room-invite-code')).toHaveText(invite);
});

test('describe your own world, play solo, then open the table to friends', async ({ page, browser }) => {
  await page.goto('/new');
  await page.getByLabel('Your world').fill('A drowned city of canals where rival glassblower guilds fight over living light.');
  await page.getByRole('button', { name: 'Draft my world' }).click();
  await expect(page.getByRole('heading', { name: '1 · Review your world' })).toBeVisible();
  await page.getByLabel('Setting name').fill('Lanternwake');
  await page.getByLabel('Currency').fill('glass beads');
  await page.getByRole('button', { name: 'Neon' }).click();
  await page.getByRole('button', { name: 'Looks good' }).click();
  await page.getByLabel('Campaign name').fill('Lanternwake');
  await page.getByLabel('Your name').fill('Cordell');
  await page.getByRole('radio', { name: /Solo/ }).check();
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await page.getByLabel("I've saved my host link").check();
  await page.getByRole('button', { name: 'Enter the tavern' }).click();

  await expect(page.getByTestId('room-name')).toHaveText('Lanternwake');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'neon');
  await expect(page.getByText('Lanternwake · Solo')).toBeVisible();
  await expect(page.getByTestId('room-invite-code')).toHaveCount(0);

  await page.getByRole('button', { name: 'Invite friends' }).click();
  const code = (await page.getByTestId('room-invite-code').textContent())!;
  const guest = await joinAs(browser, code.replace('-', '').toLowerCase(), 'Bea', 'Lanternwake');
  await page.getByRole('tab', { name: 'Party' }).click();
  await expect(page.getByTestId('party-panel')).toContainText('Bea');
  await expect(guest.locator('html')).toHaveAttribute('data-theme', 'neon');
});

test('bad invite codes and invalid dice are handled kindly', async ({ page }) => {
  await page.goto('/join/ZZZZ-ZZZZ');
  await expect(page.getByRole('alert')).toHaveText('No room has that invite code.');

  await createFantasyRoom(page, 'solo');
  await page.getByLabel('Custom roll').fill('2d6 adv');
  await expect(page.locator('#dice-error')).toHaveText('Advantage and disadvantage apply to a single d20 only.');
  await expect(page.getByRole('button', { name: 'Roll', exact: true })).toBeDisabled();
});
