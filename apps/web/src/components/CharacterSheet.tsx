import {
  type Character,
  type SettingPreset,
  LIMITS,
  MAX_LEVEL,
  SKILLS,
  SKILL_KEYS,
  STAT_KEYS,
  XP_THRESHOLDS,
  acBreakdown,
  effectiveAc,
  effectiveStats,
  proficiencyBonus,
  saveModifier,
  skillLabel,
  skillModifier,
  statModifier,
} from '@tavern/shared';
import { effectText } from '../lib/items.ts';
import { imageUrl, useMedia } from '../lib/media.ts';
import { AbilityWorkshop } from './AbilityWorkshop.tsx';
import { useState } from 'react';
import { useRoom } from '../lib/store.ts';
import { HostControls } from './HostControls.tsx';

const fmtMod = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

function Pips({ current, max, label }: { current: number; max: number; label: string }) {
  return (
    <span className="inline-flex gap-0.5" role="meter" aria-label={label} aria-valuenow={current} aria-valuemin={0} aria-valuemax={max}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`h-2.5 w-2.5 rounded-full border border-accent ${i < current ? 'bg-accent' : ''}`} />
      ))}
    </span>
  );
}

const RECHARGE: Record<string, string> = { short_rest: 'short rest', long_rest: 'long rest', at_will: 'at will' };
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

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
  const roomId = useRoom((s) => s.creds?.roomId ?? '');
  const media = useMedia();
  const initials = character.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const requested = media.portraitRequest.get(character.id);
  const status = requested ? media.status.get(requested) : undefined;
  const painting = status === 'pending';
  const failed = status === 'failed' && !character.portraitAssetId;
  const id = character.portraitAssetId;
  const src = id ? imageUrl(roomId, id, media.version.get(id)) : null;
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--t-radius)] border-2 border-line bg-raised heading font-bold text-muted"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      title={failed ? `The portrait could not be painted${requested && media.failReason.get(requested) ? `: ${media.failReason.get(requested)}` : ''}` : painting ? 'Painting a portrait…' : undefined}
      data-testid="portrait"
      data-state={id ? 'ready' : painting ? 'painting' : failed ? 'failed' : 'none'}
    >
      {src && broken !== src ? (
        <img src={src} alt={`Portrait of ${character.name}`} className="h-full w-full object-cover" loading="lazy" onError={() => setBroken(src)} />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
      {painting && (
        <span className="absolute inset-0 flex animate-pulse items-center justify-center bg-black/45 text-[10px] font-normal text-white" style={{ fontSize: Math.max(9, size * 0.16) }}>
          painting…
        </span>
      )}
      {failed && (
        <span className="absolute bottom-0 right-0 rounded-tl bg-bad px-1 text-[9px] font-normal text-white" aria-label="portrait failed">
          !
        </span>
      )}
    </div>
  );
}

function NewPortraitButton({ character }: { character: Character }) {
  const send = useRoom((s) => s.send);
  const media = useMedia();
  const [error, setError] = useState<string | null>(null);
  const requested = media.portraitRequest.get(character.id);
  const busy = !!requested && media.status.get(requested) === 'pending';
  return (
    <div className="text-right">
      <button
        type="button"
        className="btn px-2 py-0.5 text-xs"
        disabled={busy}
        onClick={async () => {
          setError(null);
          const res = await send({ type: 'request_image', kind: 'portrait', characterId: character.id });
          if (!res.ok) setError(res.error);
        }}
      >
        {busy ? 'Painting…' : 'New portrait'}
      </button>
      {error && (
        <p className="mt-1 max-w-48 text-xs text-bad" role="alert">
          {error}
        </p>
      )}
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
  const [workshop, setWorkshop] = useState(false);
  const eff = effectiveStats(c);
  const pb = proficiencyBonus(c.level);
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
        <Portrait character={c} size={72} />
        <div className="min-w-0 flex-1">
          <h3 className="heading truncate text-xl font-bold" data-testid="sheet-name">
            {c.name}
          </h3>
          <p className="truncate text-sm text-muted">
            {[c.ancestry, c.class].filter(Boolean).join(' ')} · Level {c.level}
          </p>
        </div>
        {canEdit && <NewPortraitButton character={c} />}
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
            {effectiveAc(c)}
          </div>
        </div>
        <div className="rounded-[var(--t-radius)] border border-line bg-raised p-2">
          <div className="label mb-0 truncate">{currency}</div>
          <div className="text-xl font-bold tabular-nums" data-testid="sheet-gold">
            {c.gold}
          </div>
        </div>
      </div>

      <p className="-mt-2 text-center text-xs text-muted" data-testid="ac-breakdown">
        AC{' '}
        {(() => {
          const b = acBreakdown(c);
          return (
            <>
              {b.parts
                .filter((p, i) => i === 0 || p.value !== 0)
                .map((p, i) => `${i ? (p.value < 0 ? ' − ' : ' + ') : ''}${Math.abs(p.value)}${i ? ` ${p.label === 'Dex' ? (setting?.statLabels.dex ?? 'Dex') : p.label}` : ''}`)
                .join('')}{' '}
              = {b.total}
              {b.dexCapped ? ` (${setting?.statLabels.dex ?? 'Dex'} capped by armour)` : ''}
            </>
          );
        })()}
      </p>

      <div>
        <div className="flex justify-between text-xs text-muted">
          <span>XP {c.xp}</span>
          <span>{next === null ? 'Max level' : `Level ${c.level + 1} at ${next}`}</span>
        </div>
        <Bar value={next === null ? 1 : c.xp - prev} max={next === null ? 1 : next - prev} tone="xp" label="Experience" />
        <p className="mt-1 text-xs text-muted">Proficiency bonus +{pb}</p>
      </div>

      {(c.meters.spirit || c.meters.supply) && (
        <div className="grid grid-cols-2 gap-2" data-testid="meters">
          {(['spirit', 'supply'] as const).map((m) =>
            c.meters[m] ? (
              <div key={m} className="rounded-[var(--t-radius)] border border-line p-2 text-center">
                <div className="label mb-1">{m === 'spirit' ? 'Spirit' : 'Supply'}</div>
                <Pips current={c.meters[m]!.current} max={c.meters[m]!.max} label={m} />
              </div>
            ) : null,
          )}
        </div>
      )}

      <section aria-label="Stats" className="grid grid-cols-3 gap-2">
        {STAT_KEYS.map((k) => (
          <div key={k} className="rounded-[var(--t-radius)] border border-line p-2 text-center" data-testid={`stat-${k}`}>
            <div className="truncate text-xs font-semibold text-muted" title={setting?.statLabels[k]}>
              {setting?.statLabels[k] ?? k.toUpperCase()}
            </div>
            <div className="text-2xl font-bold tabular-nums">{fmtMod(statModifier(eff[k]))}</div>
            <div className="text-xs tabular-nums text-muted">
              {eff[k]}
              {eff[k] !== c.stats[k] ? '*' : ''}
            </div>
            <div className="text-[0.7rem] text-muted" title="Saving throw">
              save {fmtMod(saveModifier(c, k))}
              {c.proficiencies.saves.includes(k) ? ' ●' : ''}
            </div>
          </div>
        ))}
      </section>

      <details className="rounded-[var(--t-radius)] border border-line" open>
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Skills</summary>
        <ul className="grid grid-cols-1 gap-x-4 px-3 pb-2 text-sm sm:grid-cols-2" data-testid="skills">
          {SKILL_KEYS.map((k) => {
            const prof = c.proficiencies.skills.includes(k);
            return (
              <li key={k} className={`flex justify-between gap-2 ${prof ? 'font-semibold' : 'text-muted'}`}>
                <span className="truncate">
                  {prof ? '● ' : '○ '}
                  {skillLabel(setting, k)} <span className="text-xs opacity-70">({setting?.statLabels[SKILLS[k]].slice(0, 3) ?? SKILLS[k]})</span>
                </span>
                <span className="tabular-nums">{fmtMod(skillModifier(c, k))}</span>
              </li>
            );
          })}
        </ul>
      </details>

      {c.conditions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Conditions">
          {c.conditions.map((x) => (
            <span key={x} className="rounded-full border border-bad px-2 py-0.5 text-xs font-semibold capitalize text-bad">
              {x}
            </span>
          ))}
        </div>
      )}

      <section aria-labelledby={`abil-${c.id}`} className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 id={`abil-${c.id}`} className="label mb-0">
            Abilities
          </h4>
          {canEdit && (
            <button type="button" className="btn px-2 py-0.5 text-xs" aria-expanded={workshop} onClick={() => setWorkshop((w) => !w)}>
              {workshop ? 'Close' : '+ Workshop'}
            </button>
          )}
        </div>
        {workshop && <AbilityWorkshop character={c} onDone={() => setWorkshop(false)} />}
        {c.spellSlots.some((x) => x.max > 0) && (
          <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="spell-slots">
            <span className="text-muted">{setting?.slotsLabel ?? 'Spell slots'}:</span>
            {c.spellSlots.map((slot, i) =>
              slot.max > 0 ? (
                <span key={i} className="flex items-center gap-1">
                  <span className="text-xs">{ORD[i]}</span>
                  <Pips current={slot.current} max={slot.max} label={`${ORD[i]} level`} />
                </span>
              ) : null,
            )}
          </div>
        )}
        {c.abilities.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul className="space-y-2" data-testid="abilities">
            {c.abilities.map((a) => (
              <li key={a.id} className="rounded-[var(--t-radius)] border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{a.name}</span>
                  {a.uses && <Pips current={a.uses.current} max={a.uses.max} label={`${a.name} uses`} />}
                  <span className="text-xs text-muted">{RECHARGE[a.recharge]}</span>
                </div>
                <p className="text-xs text-muted">{a.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                  {item.effects && <p className="text-xs font-semibold text-accent">{effectText(item, setting)}</p>}
                  {item.rarity && item.rarity !== 'mundane' && <span className="ml-1 text-xs capitalize text-accent-2">{item.rarity.replace('_', ' ')}</span>}
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
