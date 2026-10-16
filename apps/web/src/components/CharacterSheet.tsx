import { type Character, type SettingPreset, LIMITS, MAX_LEVEL, STAT_KEYS, XP_THRESHOLDS, statModifier } from '@tavern/shared';
import { useState } from 'react';
import { useRoom } from '../lib/store.ts';
import { HostControls } from './HostControls.tsx';

const fmtMod = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

function Bar({ value, max, tone, label }: { value: number; max: number; tone: 'hp' | 'xp'; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const colour = tone === 'xp' ? 'bg-accent-2' : pct > 50 ? 'bg-good' : pct > 20 ? 'bg-accent-2' : 'bg-bad';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raised" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={`h-full ${colour} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Portrait({ character, size = 56 }: { character: Character; size?: number }) {
  const initials = character.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[var(--t-radius)] border-2 border-line bg-raised heading font-bold text-muted"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

export function vitals(c: Character) {
  const next = c.level < MAX_LEVEL ? XP_THRESHOLDS[c.level]! : null;
  const prev = XP_THRESHOLDS[c.level - 1] ?? 0;
  return { next, prev };
}

/**
 * Full character sheet. Owners can edit name/notes/look and equip items; the host
 * also gets HostControls. Every change is a server command; nothing is changed locally.
 */
export function CharacterSheet({ character: c, setting, canEdit }: { character: Character; setting: SettingPreset | null; canEdit: boolean }) {
  const send = useRoom((s) => s.send);
  const isHost = useRoom((s) => s.isHost);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: c.name, notes: c.notes, visualDescriptor: c.visualDescriptor });
  const [error, setError] = useState<string | null>(null);
  const [hostOpen, setHostOpen] = useState(false);
  const { next, prev } = vitals(c);
  const currency = setting?.currencyName ?? 'gold';

  async function saveEdits() {
    const patch: Record<string, string> = {};
    if (draft.name.trim() && draft.name !== c.name) patch.name = draft.name.trim();
    if (draft.notes !== c.notes) patch.notes = draft.notes;
    if (draft.visualDescriptor !== c.visualDescriptor) patch.visualDescriptor = draft.visualDescriptor;
    if (Object.keys(patch).length === 0) return setEditing(false);
    const res = await send({ type: 'edit_character', characterId: c.id, patch });
    if (res.ok) setEditing(false);
    else setError(res.error);
  }

  async function toggleEquip(instanceId: string, equipped: boolean) {
    const res = await send({ type: 'equip_item', characterId: c.id, instanceId, equipped });
    if (!res.ok) setError(res.error);
  }

  return (
    <article className="space-y-4" aria-label={`Character sheet: ${c.name}`} data-testid="character-sheet">
      <header className="flex items-center gap-3">
        <Portrait character={c} />
        <div className="min-w-0 flex-1">
          <h3 className="heading truncate text-xl font-bold" data-testid="sheet-name">
            {c.name}
          </h3>
          <p className="truncate text-sm text-muted">
            {[c.ancestry, c.class].filter(Boolean).join(' ')} · Level {c.level}
          </p>
        </div>
        {isHost && (
          <button type="button" className={`btn py-1 text-sm ${hostOpen ? 'btn-primary' : ''}`} aria-expanded={hostOpen} onClick={() => setHostOpen((o) => !o)}>
            Host edit
          </button>
        )}
      </header>

      {hostOpen && isHost && <HostControls character={c} setting={setting} />}

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-[var(--t-radius)] border border-line bg-raised p-2">
          <div className="label mb-0">HP</div>
          <div className="text-xl font-bold tabular-nums" data-testid="sheet-hp">
            {c.hp.current}
            <span className="text-sm font-normal text-muted">/{c.hp.max}</span>
          </div>
          <Bar value={c.hp.current} max={c.hp.max} tone="hp" label="Hit points" />
        </div>
        <div className="rounded-[var(--t-radius)] border border-line bg-raised p-2">
          <div className="label mb-0">AC</div>
          <div className="text-xl font-bold tabular-nums" data-testid="sheet-ac">
            {c.ac}
          </div>
        </div>
        <div className="rounded-[var(--t-radius)] border border-line bg-raised p-2">
          <div className="label mb-0 truncate">{currency}</div>
          <div className="text-xl font-bold tabular-nums" data-testid="sheet-gold">
            {c.gold}
          </div>
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs text-muted">
          <span>XP {c.xp}</span>
          <span>{next === null ? 'Max level' : `Level ${c.level + 1} at ${next}`}</span>
        </div>
        <Bar value={next === null ? 1 : c.xp - prev} max={next === null ? 1 : next - prev} tone="xp" label="Experience" />
      </div>

      <section aria-label="Stats" className="grid grid-cols-3 gap-2">
        {STAT_KEYS.map((k) => (
          <div key={k} className="rounded-[var(--t-radius)] border border-line p-2 text-center" data-testid={`stat-${k}`}>
            <div className="truncate text-xs font-semibold text-muted" title={setting?.statLabels[k]}>
              {setting?.statLabels[k] ?? k.toUpperCase()}
            </div>
            <div className="text-2xl font-bold tabular-nums">{fmtMod(statModifier(c.stats[k]))}</div>
            <div className="text-xs tabular-nums text-muted">{c.stats[k]}</div>
          </div>
        ))}
      </section>

      {c.conditions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Conditions">
          {c.conditions.map((x) => (
            <span key={x} className="rounded-full border border-bad px-2 py-0.5 text-xs font-semibold capitalize text-bad">
              {x}
            </span>
          ))}
        </div>
      )}

      <section aria-labelledby={`inv-${c.id}`}>
        <h4 id={`inv-${c.id}`} className="label">
          Inventory
        </h4>
        {c.inventory.length === 0 ? (
          <p className="text-sm text-muted">Empty.</p>
        ) : (
          <ul className="divide-y divide-line rounded-[var(--t-radius)] border border-line" data-testid="inventory">
            {c.inventory.map((item) => (
              <li key={item.instanceId} className="flex items-start gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="font-semibold">{item.name}</span>
                  {item.qty > 1 && <span className="text-muted"> ×{item.qty}</span>}
                  {item.equipped && <span className="ml-1.5 rounded bg-accent px-1.5 text-xs text-accent-ink">equipped</span>}
                  {item.notes && <p className="text-xs text-muted">{item.notes}</p>}
                  {item.tags.length > 0 && <p className="text-[0.7rem] uppercase tracking-wide text-muted">{item.tags.join(' · ')}</p>}
                </div>
                {canEdit && (
                  <button type="button" className="btn shrink-0 px-2 py-0.5 text-xs" onClick={() => toggleEquip(item.instanceId, !item.equipped)}>
                    {item.equipped ? 'Unequip' : 'Equip'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Look and notes" className="space-y-2">
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdits();
            }}
          >
            <div>
              <label className="label" htmlFor={`edit-name-${c.id}`}>
                Name
              </label>
              <input id={`edit-name-${c.id}`} className="field" value={draft.name} maxLength={LIMITS.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor={`edit-look-${c.id}`}>
                Look
              </label>
              <textarea
                id={`edit-look-${c.id}`}
                className="field"
                rows={2}
                maxLength={LIMITS.visualDescriptor}
                value={draft.visualDescriptor}
                onChange={(e) => setDraft({ ...draft, visualDescriptor: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor={`edit-notes-${c.id}`}>
                Notes
              </label>
              <textarea
                id={`edit-notes-${c.id}`}
                className="field"
                rows={4}
                maxLength={LIMITS.characterNotes}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary">
                Save
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            {c.visualDescriptor && (
              <div>
                <h4 className="label">Look</h4>
                <p className="text-sm">{c.visualDescriptor}</p>
              </div>
            )}
            {c.notes && (
              <div>
                <h4 className="label">Notes</h4>
                <p className="whitespace-pre-wrap text-sm" data-testid="sheet-notes">
                  {c.notes}
                </p>
              </div>
            )}
            {canEdit && (
              <button
                type="button"
                className="btn py-1 text-sm"
                onClick={() => {
                  setDraft({ name: c.name, notes: c.notes, visualDescriptor: c.visualDescriptor });
                  setEditing(true);
                }}
              >
                Edit name, look and notes
              </button>
            )}
          </>
        )}
      </section>

      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
