import { useState } from 'react';
import { useRoom } from '../lib/store.ts';
import { CharacterSheet, Portrait } from './CharacterSheet.tsx';

/** Everyone at the table: compact cards that expand into full sheets. */
export function PartyPanel() {
  const state = useRoom((s) => s.state);
  const online = useRoom((s) => s.online);
  const me = useRoom((s) => s.creds?.playerId);
  const isHost = useRoom((s) => s.isHost);
  const [open, setOpen] = useState<string | null>(null);
  const players = state.players.filter((p) => p.active);

  return (
    <div className="space-y-2" data-testid="party-panel">
      {players.map((p) => {
        const c = state.party.find((x) => x.id === p.characterId);
        const here = online.includes(p.id);
        const expanded = c && open === c.id;
        return (
          <div key={p.id} className="rounded-[var(--t-radius)] border border-line" data-testid="party-member">
            <button
              type="button"
              className="flex w-full items-center gap-3 p-2 text-left"
              aria-expanded={!!expanded}
              disabled={!c}
              onClick={() => c && setOpen(expanded ? null : c.id)}
            >
              {c ? (
                <Portrait character={c} size={40} />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-[var(--t-radius)] border-2 border-dashed border-line" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${here ? 'bg-good' : 'bg-muted opacity-50'}`} aria-label={here ? 'online' : 'away'} />
                  <span className="truncate font-semibold">{c?.name ?? p.displayName}</span>
                  {p.isHost && <span className="text-xs text-muted">host</span>}
                </div>
                <div className="truncate text-xs text-muted">
                  {c ? `${p.displayName} · ${c.class} ${c.level}` : `${p.displayName} · still creating a character`}
                </div>
              </div>
              {c && (
                <div className="shrink-0 text-right text-xs tabular-nums">
                  <div>
                    <span className="text-muted">HP</span> <strong>{c.hp.current}</strong>/{c.hp.max}
                  </div>
                  <div>
                    <span className="text-muted">AC</span> <strong>{c.ac}</strong>
                  </div>
                </div>
              )}
            </button>
            {c && c.conditions.length > 0 && !expanded && (
              <p className="px-2 pb-2 text-xs capitalize text-bad">{c.conditions.join(', ')}</p>
            )}
            {expanded && (
              <div className="border-t border-line p-3">
                <CharacterSheet character={c} setting={state.setting} canEdit={c.playerId === me || isHost} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
