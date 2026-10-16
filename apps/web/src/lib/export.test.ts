import { type GameEvent, initialState } from '@tavern/shared';
import { describe, expect, it } from 'vitest';
import { buildMedia } from './media.ts';
import { storyMarkdown } from './story.ts';

let seq = 0;
const ev = (type: string, payload: unknown, turnId: string | null = null) =>
  ({ seq: ++seq, type, actorId: null, turnId, createdAt: '2026-01-01T00:00:00Z', payload }) as unknown as GameEvent;

describe('buildMedia', () => {
  it('tracks image status, per-character portraits, NPC art by turn and voice clips', () => {
    seq = 0;
    const m = buildMedia([
      ev('image_requested', { assetId: 'p1aaaaaa', kind: 'portrait', subject: '', characterId: 'c1' }),
      ev('image_requested', { assetId: 'n1aaaaaa', kind: 'npc', subject: 'Mara', }, 't1'),
      ev('image_requested', { assetId: 's1aaaaaa', kind: 'scene', subject: '' }),
      ev('image_ready', { assetId: 'p1aaaaaa', kind: 'portrait', characterId: 'c1' }),
      ev('image_failed', { assetId: 'n1aaaaaa', reason: 'x' }),
      ev('audio_ready', { assetId: 'v9aaaaaa', narrationSeq: 7 }),
    ]);
    expect(m.status.get('p1aaaaaa')).toBe('ready');
    expect(m.status.get('n1aaaaaa')).toBe('failed');
    expect(m.status.get('s1aaaaaa')).toBe('pending');
    expect(m.portraitRequest.get('c1')).toBe('p1aaaaaa');
    expect(m.byTurn.get('t1')).toEqual([{ assetId: 'n1aaaaaa', kind: 'npc', subject: 'Mara' }]);
    expect(m.latestScene).toBe('s1aaaaaa');
    expect(m.voice.get(7)).toBe('v9aaaaaa');
  });
});

describe('storyMarkdown', () => {
  it('includes recaps, chapters, world notes and the story', () => {
    seq = 0;
    const events = [
      ev('session_started', { number: 1 }),
      ev('turn_started', { turnId: 't1', actionSeqs: [] }, 't1'),
      ev('narration', { turnId: 't1', text: 'Rain hammers the docks.' }, 't1'),
      ev('delta_applied', { delta: { type: 'upsert_canon', kind: 'npc', key: 'mara_voss', aliases: ['Mara'], facts: ['One-eyed smuggler'] } }, 't1'),
      ev('chapter_closed', { level: 0, chapterNo: 1, fromSeq: 1, toSeq: 3, summary: 'The crew reached the docks.' }),
      ev('session_ended', { number: 1 }),
      ev('session_recap', { number: 1, text: 'Last time, the crew landed.' }),
    ];
    const md = storyMarkdown('Dock Nine', events, { ...initialState(), roomName: 'Dock Nine' }, new Date('2026-05-01T10:00:00Z'));
    expect(md).toContain('# Dock Nine');
    expect(md).toMatch(/## Session recaps\n\n### Session 1\n\nLast time, the crew landed\./);
    expect(md).toMatch(/### Chapter 1\n\nThe crew reached the docks\./);
    expect(md).toMatch(/\*\*Mara Voss\*\* \(Mara\)\n\n- One-eyed smuggler/);
    expect(md).toMatch(/## The full story[\s\S]*Rain hammers the docks\./);
  });
});
