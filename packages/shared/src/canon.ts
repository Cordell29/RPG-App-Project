import { CANON_KINDS, type CanonKind } from './constants.ts';
import type { GameEvent } from './events.ts';

export interface CanonEntry {
  kind: CanonKind;
  key: string;
  aliases: string[];
  facts: string[];
  updatedSeq: number;
}

const MAX_FACTS = 20;

/**
 * Canon (NPCs, locations, factions, lore) is a projection of upsert_canon events, skipping
 * rewound turns. Facts accumulate (newest kept when over the limit); aliases are merged.
 */
export function deriveCanon(events: readonly GameEvent[]): CanonEntry[] {
  const voided = new Set(events.flatMap((e) => (e.type === 'turn_voided' ? [e.payload.turnId] : [])));
  const map = new Map<string, CanonEntry>();
  for (const e of events) {
    if (e.type !== 'delta_applied' || e.payload.delta.type !== 'upsert_canon') continue;
    if (e.turnId && voided.has(e.turnId)) continue;
    const d = e.payload.delta;
    if (!(CANON_KINDS as readonly string[]).includes(d.kind)) continue;
    const id = `${d.kind}:${d.key}`;
    const cur = map.get(id) ?? { kind: d.kind, key: d.key, aliases: [], facts: [], updatedSeq: e.seq };
    for (const a of d.aliases) if (!cur.aliases.includes(a)) cur.aliases.push(a);
    for (const f of d.facts) if (!cur.facts.includes(f)) cur.facts.push(f);
    cur.facts = cur.facts.slice(-MAX_FACTS);
    cur.aliases = cur.aliases.slice(-10);
    cur.updatedSeq = e.seq;
    map.set(id, cur);
  }
  return [...map.values()];
}
