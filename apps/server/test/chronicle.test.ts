import { type CharacterCreateInput, getPreset } from '@tavern/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { devMockProvider } from '../src/llm/devMock.ts';
import { LLMError } from '../src/llm/provider.ts';
import { testDb, tmpDir } from './helpers.ts';

const fighter: CharacterCreateInput = {
  name: 'Ayla', ancestry: '', className: 'Fighter', roleName: 'Fighter', statMethod: 'standard',
  stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], saves: [], visualDescriptor: '', notes: '',
};

async function setup() {
  const llm = devMockProvider();
  const t = await buildApp({ dataDir: tmpDir(), db: testDb(), llm, rulesLookup: false, turnsPerMinute: 100_000 });
  const room = t.rooms.createRoom({ roomName: 'C', hostName: 'H', setting: getPreset('fantasy')!, mode: 'solo' });
  const player = t.rooms.authenticate(room.roomId, room.token)!;
  let n = 0;
  const cmd = (body: object) => t.commands.execute(player, { commandId: `chron-cmd-${++n}`, ...body });
  cmd({ type: 'create_character', character: fighter });
  const play = async (count: number) => {
    for (let i = 0; i < count; i++) {
      expect(cmd({ type: 'submit_action', text: `I look around (${i}).` })).toMatchObject({ ok: true });
      await t.turns.whenIdle(room.roomId);
      await t.memory.whenIdle(room.roomId);
    }
  };
  return { t, llm, room, cmd, play, close: async () => { t.io.close(); await t.app.close(); } };
}

describe('chronicle', () => {
  it('a chapter waits for 11 narrated turns, so the newest stays rewindable', async () => {
    const s = await setup();
    await s.play(10);
    expect(s.t.memory.rows(s.room.roomId)).toHaveLength(0);
    await s.play(1);
    expect(s.t.memory.rows(s.room.roomId)).toMatchObject([{ level: 0, chapterNo: 1 }]);
    await s.close();
  });

  it('chapter failures do not block play and are retried on the next turn', async () => {
    const s = await setup();
    await s.play(10);
    let failChapters = true;
    const original = s.llm.structured.bind(s.llm);
    s.llm.structured = (async (req: Parameters<typeof original>[0]) => {
      if (req.purpose === 'chronicle_chapter' && failChapters) throw new LLMError('summary model down');
      return original(req);
    }) as typeof s.llm.structured;
    await s.play(1);
    expect(s.t.memory.rows(s.room.roomId)).toHaveLength(0);
    expect(s.t.store.getState(s.room.roomId).turn.number).toBe(11);
    failChapters = false;
    await s.play(1);
    expect(s.t.memory.rows(s.room.roomId)).toHaveLength(1);
    await s.close();
  });

  it('rewinding the newest turn never touches a written chapter; canon follows rewinds', async () => {
    const s = await setup();
    await s.play(11);
    expect(s.t.memory.rows(s.room.roomId)).toHaveLength(1);
    expect(s.cmd({ type: 'void_last_turn' })).toMatchObject({ ok: true });
    const chapter = s.t.store.loadEvents(s.room.roomId).find((e) => e.type === 'chapter_closed');
    const voided = s.t.store.getState(s.room.roomId).voidedTurnIds[0]!;
    const turnIdsInChapter = s.t.store
      .loadEvents(s.room.roomId)
      .filter((e) => e.type === 'turn_started' && chapter?.type === 'chapter_closed' && e.seq >= chapter.payload.fromSeq && e.seq <= chapter.payload.toSeq)
      .map((e) => e.turnId);
    expect(turnIdsInChapter).not.toContain(voided);
    await s.close();
  });

  it('write_recap: host only, needs a session, one per session', async () => {
    const s = await setup();
    expect(s.cmd({ type: 'write_recap' })).toMatchObject({ ok: false, error: 'Start a session first.' });
    s.cmd({ type: 'start_session' });
    await s.play(2);
    expect(s.cmd({ type: 'write_recap' })).toMatchObject({ ok: true });
    await s.t.memory.whenIdle(s.room.roomId);
    expect(s.t.store.loadEvents(s.room.roomId).filter((e) => e.type === 'session_recap')).toHaveLength(1);
    expect(s.cmd({ type: 'write_recap' })).toMatchObject({ ok: false, error: 'Session 1 already has a recap.' });
    await s.close();
  });
});
