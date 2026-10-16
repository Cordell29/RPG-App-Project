import type { GameEvent } from '@tavern/shared';
import { useMemo } from 'react';
import { useRoom } from './store.ts';

export type AssetStatus = 'pending' | 'ready' | 'failed';

export interface MediaIndex {
  status: Map<string, AssetStatus>;
  /** Latest portrait request per character (so a regeneration shows "painting…"). */
  portraitRequest: Map<string, string>;
  /** NPC/scene illustrations the GM asked for during a turn, by turnId. */
  byTurn: Map<string, { assetId: string; kind: 'scene' | 'npc'; subject: string }[]>;
  /** The newest scene request (may still be pending). */
  latestScene: string | null;
  /** AI-voice clip per narration seq. */
  voice: Map<number, string>;
}

/** Folds image/audio events into lookups the UI needs. Pure, so it is cheap to memoise. */
export function buildMedia(events: GameEvent[]): MediaIndex {
  const m: MediaIndex = { status: new Map(), portraitRequest: new Map(), byTurn: new Map(), latestScene: null, voice: new Map() };
  for (const e of events) {
    if (e.type === 'image_requested') {
      const { assetId, kind, subject, characterId } = e.payload;
      m.status.set(assetId, 'pending');
      if (kind === 'portrait' && characterId) m.portraitRequest.set(characterId, assetId);
      if (kind === 'scene') m.latestScene = assetId;
      if (kind !== 'portrait' && e.turnId) {
        const list = m.byTurn.get(e.turnId) ?? [];
        list.push({ assetId, kind, subject });
        m.byTurn.set(e.turnId, list);
      }
    } else if (e.type === 'image_ready') m.status.set(e.payload.assetId, 'ready');
    else if (e.type === 'image_failed') m.status.set(e.payload.assetId, 'failed');
    else if (e.type === 'audio_ready') m.voice.set(e.payload.narrationSeq, e.payload.assetId);
  }
  return m;
}

export const imageUrl = (roomId: string, assetId: string) => `/assets/${encodeURIComponent(roomId)}/${encodeURIComponent(assetId)}.webp`;
export const voiceUrl = (roomId: string, assetId: string) => `/assets/${encodeURIComponent(roomId)}/${encodeURIComponent(assetId)}.wav`;

export function useMedia(): MediaIndex {
  const events = useRoom((s) => s.events);
  return useMemo(() => buildMedia(events), [events]);
}
