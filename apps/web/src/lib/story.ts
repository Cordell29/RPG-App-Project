import type { EventOf, GameEvent, GameState } from '@tavern/shared';

export interface StoryTurn {
  turnId: string;
  number: number;
  session: number;
  actions: { who: string; text: string }[];
  rolls: EventOf<'dice_rolled'>['payload'][];
  narration: { seq: number; text: string; suggestions: string[] } | null;
}

export type StoryEntry = { kind: 'turn'; turn: StoryTurn } | { kind: 'session'; number: number; started: boolean; seq: number };

/** Folds the event log into turns (skipping rewound ones) and session markers. */
export function buildStory(events: GameEvent[], state: GameState): StoryEntry[] {
  const voided = new Set(state.voidedTurnIds);
  const actionBySeq = new Map<number, { playerId: string; characterId: string | null; text: string }>();
  const turns = new Map<string, StoryTurn>();
  const out: StoryEntry[] = [];
  let session = 0;
  let number = 0;
  const who = (characterId: string | null, playerId: string) =>
    state.party.find((c) => c.id === characterId)?.name ?? state.players.find((p) => p.id === playerId)?.displayName ?? 'Someone';

  for (const e of events) {
    if (e.type === 'action_submitted') actionBySeq.set(e.seq, e.payload);
    else if (e.type === 'action_edited') {
      const a = actionBySeq.get(e.payload.actionSeq);
      if (a) actionBySeq.set(e.payload.actionSeq, { ...a, text: e.payload.text });
    } else if (e.type === 'session_started' || e.type === 'session_ended') {
      session = e.payload.number;
      out.push({ kind: 'session', number: e.payload.number, started: e.type === 'session_started', seq: e.seq });
    } else if (e.turnId && voided.has(e.turnId)) {
      continue;
    } else if (e.type === 'turn_started') {
      const turn: StoryTurn = {
        turnId: e.payload.turnId,
        number: ++number,
        session,
        actions: e.payload.actionSeqs
          .map((s) => actionBySeq.get(s))
          .filter((a) => !!a)
          .map((a) => ({ who: who(a!.characterId, a!.playerId), text: a!.text })),
        rolls: [],
        narration: null,
      };
      turns.set(turn.turnId, turn);
      out.push({ kind: 'turn', turn });
    } else if (e.type === 'dice_rolled' && e.turnId) {
      turns.get(e.turnId)?.rolls.push(e.payload);
    } else if (e.type === 'narration') {
      const t = turns.get(e.payload.turnId);
      if (t) t.narration = { seq: e.seq, text: e.payload.text, suggestions: e.payload.suggestions ?? [] };
    }
  }
  return out;
}

/** Plain-text story for copying or printing (Phase 7 adds the Markdown export). */
export function storyText(entries: StoryEntry[]): string {
  return entries
    .map((en) => {
      if (en.kind === 'session') return `\n=== Session ${en.number} ${en.started ? 'begins' : 'ends'} ===\n`;
      const t = en.turn;
      return [...t.actions.map((a) => `> ${a.who}: ${a.text}`), '', t.narration?.text ?? '(no narration)', ''].join('\n');
    })
    .join('\n');
}
