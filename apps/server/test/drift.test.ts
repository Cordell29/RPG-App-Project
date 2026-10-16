import { type CharacterCreateInput, estimateTokens } from '@tavern/shared';
import { describe, expect, it } from 'vitest';
import { type TavernApp, buildApp } from '../src/app.ts';
import { BUDGETS } from '../src/gm/prompt.ts';
import { MockLLMProvider, type MockRequest } from '../src/llm/mock.ts';
import type { ChatRequest } from '../src/llm/provider.ts';
import { testDb, tmpDir } from './helpers.ts';

/**
 * Phase 5 acceptance: a scripted 200-turn campaign. The prompt must stay under 12,000 tokens
 * on every turn, and facts planted early (an NPC, a debt, a quest) must still be in the
 * prompt or canon at turn 200.
 */

const fighter: CharacterCreateInput = {
  name: 'Ayla',
  ancestry: 'Human',
  className: 'Fighter',
  roleName: 'Fighter',
  statMethod: 'standard',
  stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
  skills: ['athletics', 'perception'],
  saves: [],
  visualDescriptor: '',
  notes: '',
};

const PLACES = ['the Gilded Goose', 'Greywood', 'the old mill', 'Saltmarsh docks', 'the abbey'];

/** A mock GM with long, varied turns (to stress budgets) and summarisers that keep names. */
function scriptedLlm(characterId: () => string) {
  let turn = 0;
  return new MockLLMProvider((req: MockRequest) => {
    switch (req.purpose) {
      case 'gm_adjudicate': {
        const r = req as ChatRequest;
        if (Array.isArray(r.messages.at(-1)?.content)) return { tools: [{ name: 'end_adjudication', input: { summary: `Turn ${turn}` } }] };
        turn += 1;
        const id = characterId();
        if (turn === 3) {
          return {
            tools: [
              { name: 'upsert_canon', input: { kind: 'npc', key: 'brother_hal', aliases: ['Hal', 'the monk'], facts: ['A monk of the abbey who lent Ayla 20 gold'] } },
              { name: 'change_gold', input: { characterId: id, amount: 20, reason: 'loan from Brother Hal' } },
              { name: 'end_adjudication', input: { summary: 'Hal lends money.' } },
            ],
          };
        }
        if (turn === 5) {
          return {
            tools: [
              { name: 'update_quest', input: { key: 'hal_debt', title: 'Repay Brother Hal 20 gold', note: 'Due before the winter feast' } },
              { name: 'end_adjudication', input: { summary: 'The debt is recorded.' } },
            ],
          };
        }
        return {
          tools: [
            { name: 'request_check', input: { characterId: id, stat: 'wis', skill: 'perception', dc: 12, reason: `look around ${PLACES[turn % PLACES.length]}` } },
            { name: 'end_adjudication', input: { summary: `Turn ${turn}` } },
          ],
        };
      }
      case 'gm_narrate':
        return `Turn ${turn} at ${PLACES[turn % PLACES.length]}: ${'The wind carries rumours of distant trouble while Ayla presses on, watchful and tired. '.repeat(6)}${turn === 3 ? 'Brother Hal presses twenty gold into her hand.' : ''}\n\nSUGGESTIONS:\n- Rest\n- Ask around\n- Move on`;
      case 'chronicle_chapter': {
        const t = (req as { prompt: string }).prompt;
        const names = ['Brother Hal', 'Hal'].filter((n) => t.includes(n));
        return {
          summary: `Ayla travelled through ${PLACES.filter((p) => t.includes(p)).join(', ')}. ${names.length ? 'Brother Hal lent her 20 gold, which she owes him.' : 'Nothing remarkable happened.'} ${'She kept watch and pressed on. '.repeat(25)}`,
          canon: names.length ? [{ kind: 'npc', key: 'brother_hal', aliases: ['Hal'], facts: ['Ayla owes him 20 gold'] }] : [],
        };
      }
      case 'chronicle_arc':
        return { text: `An arc of travel. ${(req as { prompt: string }).prompt.includes('Brother Hal') ? 'Ayla owes Brother Hal 20 gold. ' : ''}${'Long roads. '.repeat(40)}` };
      case 'session_recap':
        return { text: 'Previously: Ayla travelled and owes Brother Hal 20 gold.' };
      default:
        throw new Error(`unexpected ${req.purpose}`);
    }
  });
}

describe('200-turn drift test', () => {
  it('prompt stays under budget and planted facts survive to turn 200', { timeout: 120_000 }, async () => {
    let characterId = '';
    const llm = scriptedLlm(() => characterId);
    const t: TavernApp = await buildApp({ dataDir: tmpDir(), db: testDb(), llm, rulesLookup: false });
    const room = t.rooms.createRoom({ roomName: 'Drift', hostName: 'Host', setting: (await import('@tavern/shared')).getPreset('fantasy')!, mode: 'solo' });
    const player = t.rooms.authenticate(room.roomId, room.token)!;
    let n = 0;
    const cmd = (body: object) => t.commands.execute(player, { commandId: `drift-cmd-${++n}`, ...body });
    expect(cmd({ type: 'create_character', character: fighter })).toMatchObject({ ok: true });
    characterId = t.store.getState(room.roomId).party[0]!.id;
    expect(cmd({ type: 'start_session' })).toMatchObject({ ok: true });

    const sizes: number[] = [];
    for (let i = 1; i <= 200; i++) {
      const text = i === 200 ? 'I go back to the abbey to repay Hal.' : `I explore ${PLACES[i % PLACES.length]}, turn ${i}. ${'Carefully. '.repeat(20)}`;
      expect(cmd({ type: 'submit_action', text })).toMatchObject({ ok: true });
      await t.turns.whenIdle(room.roomId);
      await t.memory.whenIdle(room.roomId);
      const budget = t.turns.lastBudget.get(room.roomId)!;
      expect(budget.total, `turn ${i}`).toBeLessThanOrEqual(BUDGETS.total);
      sizes.push(budget.total);
    }

    const state = t.store.getState(room.roomId);
    expect(state.turn.number).toBe(200);

    // Independently measure the prompts actually sent to the model.
    const gm = llm.calls.filter((c) => c.purpose === 'gm_adjudicate') as ChatRequest[];
    for (const c of gm) {
      const text = c.system.map((b) => b.text).join('') + c.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      expect(estimateTokens(text)).toBeLessThanOrEqual(BUDGETS.total);
    }
    // Cost stays flat: turn 200 is about the size of turn 50.
    expect(sizes[199]! - sizes[49]!).toBeLessThan(2500);

    // Chronicle: 19 chapters (the newest turn stays out so it can be rewound) rolled into arcs.
    const rows = t.memory.rows(room.roomId);
    expect(rows.filter((r) => r.level === 0)).toHaveLength(19);
    expect(rows.filter((r) => r.level === 1).length).toBeGreaterThanOrEqual(1);
    const chapterEvents = t.store.loadEvents(room.roomId).filter((e) => e.type === 'chapter_closed');
    expect(chapterEvents.length).toBe(rows.length);

    // Planted facts at turn 200: the NPC in canon (table and prompt), the debt quest in state.
    const lastPrompt = gm.at(-1)!; // the final turn's adjudication call
    const user = String(lastPrompt.messages[0]!.content);
    expect(user).toMatch(/<canon>[\s\S]*brother_hal[\s\S]*20 gold/);
    expect(user).toMatch(/Repay Brother Hal 20 gold/);
    const canon = t.memory.canon(room.roomId);
    expect(canon.find((c) => c.key === 'brother_hal')!.facts.join(' ')).toMatch(/20 gold/);
    const tableRows = (t.memory as unknown as { db: { $client: { prepare: (q: string) => { all: () => unknown[] } } } }).db.$client.prepare("SELECT key FROM canon WHERE key = 'brother_hal'").all();
    expect(tableRows).toHaveLength(1);
    expect(state.quests.find((q) => q.key === 'hal_debt')).toMatchObject({ status: 'active' });
    // And the chronicle remembers the loan.
    expect(lastPrompt.system[2]!.text).toMatch(/Brother Hal/);

    // End session → recap.
    expect(cmd({ type: 'end_session' })).toMatchObject({ ok: true });
    await t.memory.whenIdle(room.roomId);
    const recap = t.store.loadEvents(room.roomId).find((e) => e.type === 'session_recap');
    expect(recap?.type === 'session_recap' && recap.payload).toMatchObject({ number: 1, text: expect.stringMatching(/Brother Hal/) });
    t.io.close();
    await t.app.close();
  });
});
