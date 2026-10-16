import { type Browser, type BrowserContextOptions, type Page, expect } from '@playwright/test';

export async function createRoom(
  page: Page,
  opts: { mode?: 'solo' | 'group'; preset?: 'Fantasy' | 'Sci-fi'; name?: string } = {},
) {
  const { mode = 'group', preset = 'Fantasy', name = 'The Gilded Goose' } = opts;
  await page.goto('/new');
  await page.getByRole('button', { name: `Play ${preset}` }).click();
  await page.getByLabel('Campaign name').fill(name);
  await page.getByLabel('Your name').fill('Cordell');
  await page.getByRole('radio', { name: mode === 'solo' ? /Solo/ : /With friends/ }).check();
  await page.getByRole('button', { name: 'Create campaign' }).click();
  const invite = mode === 'group' ? (await page.getByTestId('invite-code').textContent())!.trim() : '';
  await page.getByLabel("I've saved my host link").check();
  await page.getByRole('button', { name: 'Enter the tavern' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  return { invite };
}

export async function joinAs(browser: Browser, invite: string, name: string, ctx: BrowserContextOptions = {}) {
  const page = await (await browser.newContext(ctx)).newPage();
  await page.goto(`/join/${invite}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Take a seat' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  return page;
}

/** Quick path: pick a role, name, standard array in the given order (highest first). */
export async function quickCharacter(page: Page, opts: { role: string; name: string; order: string[] }) {
  const creator = page.getByTestId('character-creator');
  await creator.getByText(opts.role, { exact: true }).click();
  await creator.getByLabel('Name', { exact: true }).fill(opts.name);
  const values = ['15', '14', '13', '12', '10', '8'];
  for (const [i, stat] of opts.order.entries()) {
    await creator.getByLabel(stat, { exact: true }).selectOption(values[i]!);
  }
  await creator.getByRole('button', { name: 'Create character' }).click();
  await expect(page.getByTestId('sheet-name').first()).toHaveText(opts.name);
}

export const FANTASY_STATS = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
