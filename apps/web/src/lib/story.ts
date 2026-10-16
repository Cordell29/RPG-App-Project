import { type CanonEntry, type EventOf, type GameEvent, type GameState, deriveCanon } from '@tavern/shared';

export interface StoryTurn {
  turnId: string;
  number: number;
  session: number;
  actions: { who: string; text: string }[];
  rolls: EventOf<'dice_rolled'>['payload'][];
  narration: { seq: number; text: string; suggestions: string[] } | null;
}

export type StoryEntry =
  | { kind: 'turn'; turn: StoryTurn }
  | { kind: 'session'; number: number; started: boolean; seq: number }
  | { kind: 'recap'; number: number; text: string; seq: number };

export interface ChronicleEntry {
  level: 0 | 1;
  number: number;
  summary: string;
  seq: number;
}

/** Chapters and arcs, oldest first. */
export function buildChronicle(events: GameEvent[]): ChronicleEntry[] {
  return events.flatMap((e) =>
    e.type === 'chapter_closed' && e.payload.summary ? [{ level: e.payload.level, number: e.payload.chapterNo, summary: e.payload.summary, seq: e.seq }] : [],
  );
}

/** The newest recap, if any. */
export function latestRecap(events: GameEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'session_recap') return { number: e.payload.number, text: e.payload.text, seq: e.seq };
  }
  return null;
}

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
    } else if (e.type === 'session_recap') {
      out.push({ kind: 'recap', number: e.payload.number, text: e.payload.text, seq: e.seq });
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

/** Plain-text story for copying or printing. */
export function storyText(entries: StoryEntry[]): string {
  return entries
    .map((en) => {
      if (en.kind === 'session') return `\n=== Session ${en.number} ${en.started ? 'begins' : 'ends'} ===\n`;
      if (en.kind === 'recap') return `[Recap of session ${en.number}] ${en.text}\n`;
      const t = en.turn;
      return [...t.actions.map((a) => `> ${a.who}: ${a.text}`), '', t.narration?.text ?? '(no narration)', ''].join('\n');
    })
    .join('\n');
}

const KIND_HEADING: Record<CanonEntry['kind'], string> = { npc: 'People', location: 'Places', faction: 'Factions', lore: 'Lore' };
const prettyKey = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The whole campaign record as one Markdown document: recaps, chapters and arcs,
 * world notes, then the full story. Built in the browser from the event log.
 */
export function storyMarkdown(roomName: string, events: GameEvent[], state: GameState, exportedAt = new Date()): string {
  const entries = buildStory(events, state);
  const recaps = entries.filter((e) => e.kind === 'recap');
  const chronicle = buildChronicle(events);
  const canon = deriveCanon(events);
  const out: string[] = [`# ${roomName}`, '', `_Exported ${exportedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${state.setting?.name ?? 'Custom setting'}_`, ''];

  out.push('## Session recaps', '');
  if (recaps.length) for (const r of recaps) out.push(`### Session ${r.number}`, '', r.text, '');
  else out.push('_No recaps yet._', '');

  out.push('## Chapters', '');
  if (chronicle.length) for (const c of chronicle) out.push(`### ${c.level === 1 ? 'Arc' : 'Chapter'} ${c.number}`, '', c.summary, '');
  else out.push('_Chapters are written every 10 turns._', '');

  out.push('## World notes', '');
  if (!canon.length) out.push('_Nothing recorded yet._', '');
  for (const kind of Object.keys(KIND_HEADING) as CanonEntry['kind'][]) {
    const list = canon.filter((c) => c.kind === kind).sort((a, b) => a.key.localeCompare(b.key));
    if (!list.length) continue;
    out.push(`### ${KIND_HEADING[kind]}`, '');
    for (const c of list) {
      out.push(`**${prettyKey(c.key)}**${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}`, '');
      for (const f of c.facts) out.push(`- ${f}`);
      out.push('');
    }
  }

  out.push('## The full story', '');
  for (const en of entries) {
    if (en.kind === 'recap') continue;
    if (en.kind === 'session') {
      out.push(`### Session ${en.number} ${en.started ? 'begins' : 'ends'}`, '');
      continue;
    }
    for (const a of en.turn.actions) out.push(`> **${a.who}:** ${a.text}`);
    if (en.turn.actions.length) out.push('');
    out.push(en.turn.narration?.text ?? '_(no narration)_', '');
  }
  return out.join('\n');
}

export function downloadText(filename: string, text: string, type = 'text/markdown') {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }));
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
