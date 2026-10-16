import {
  type CharacterCreateInput,
  type SettingPreset,
  type StatKey,
  type StatMethod,
  type Stats,
  LIMITS,
  MAX_CUSTOM_KIT,
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  STANDARD_ARRAY,
  STAT_KEYS,
  STAT_ROLL_NOTATION,
  checkStats,
  pointBuyCost,
  statModifier,
} from '@tavern/shared';
import { useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { useRoom } from '../lib/store.ts';

const CUSTOM = '__custom__';
const fmtMod = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
const BLANK: Record<StatKey, number> = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };

/** Assign a fixed pool of values (standard array or rolled) to the six stats with dropdowns. */
function PoolAssigner(props: { pool: readonly number[]; stats: Record<StatKey, number>; labels: SettingPreset['statLabels'] | undefined; onChange: (s: Record<StatKey, number>) => void }) {
  const { pool, stats, labels, onChange } = props;
  // Values still free, counting duplicates.
  const remaining = (except: StatKey) => {
    const left = [...pool];
    for (const k of STAT_KEYS) {
      if (k === except || !stats[k]) continue;
      const i = left.indexOf(stats[k]);
      if (i >= 0) left.splice(i, 1);
    }
    return left;
  };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {STAT_KEYS.map((k) => {
        const options = [...new Set(remaining(k))].sort((a, b) => b - a);
        return (
          <label key={k} className="text-sm">
            <span className="block truncate text-xs font-semibold text-muted">{labels?.[k] ?? k}</span>
            <select
              className="field py-1.5"
              value={stats[k] || ''}
              aria-label={labels?.[k] ?? k}
              onChange={(e) => onChange({ ...stats, [k]: Number(e.target.value) })}
            >
              <option value="">—</option>
              {options.map((v) => (
                <option key={v} value={v}>
                  {v} ({fmtMod(statModifier(v))})
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function PointBuy(props: { stats: Record<StatKey, number>; labels: SettingPreset['statLabels'] | undefined; onChange: (s: Record<StatKey, number>) => void }) {
  const { stats, labels, onChange } = props;
  const spent = pointBuyCost(stats as Stats);
  const left = POINT_BUY_BUDGET - spent;
  const costOf = (v: number) => POINT_BUY_COST[v] ?? Infinity;
  return (
    <div>
      <p className="mb-2 text-sm" aria-live="polite">
        Points left: <strong className={left < 0 ? 'text-bad' : ''}>{left}</strong> / {POINT_BUY_BUDGET}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STAT_KEYS.map((k) => {
          const v = stats[k];
          const upCost = costOf(v + 1) - costOf(v);
          return (
            <div key={k} className="rounded-[var(--t-radius)] border border-line p-2 text-center">
              <div className="truncate text-xs font-semibold text-muted">{labels?.[k] ?? k}</div>
              <div className="flex items-center justify-center gap-2">
                <button type="button" className="btn px-2 py-0" aria-label={`Lower ${labels?.[k] ?? k}`} disabled={v <= 8} onClick={() => onChange({ ...stats, [k]: v - 1 })}>
                  −
                </button>
                <span className="w-7 text-lg font-bold tabular-nums">{v}</span>
                <button
                  type="button"
                  className="btn px-2 py-0"
                  aria-label={`Raise ${labels?.[k] ?? k}`}
                  disabled={v >= 15 || upCost > left}
                  onClick={() => onChange({ ...stats, [k]: v + 1 })}
                >
                  +
                </button>
              </div>
              <div className="text-xs text-muted">{fmtMod(statModifier(v))}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Create your one character: quick (pick a role) or describe your own (AI draft you then edit). */
export function CharacterCreator({ setting }: { setting: SettingPreset | null }) {
  const send = useRoom((s) => s.send);
  const creds = useRoom((s) => s.creds);
  const events = useRoom((s) => s.events);
  const roles = setting?.roles ?? [];

  const [path, setPath] = useState<'quick' | 'describe'>('quick');
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [role, setRole] = useState<string>(roles[0]?.name ?? CUSTOM);
  const [className, setClassName] = useState('');
  const [kitText, setKitText] = useState('');
  const [name, setName] = useState('');
  const [ancestry, setAncestry] = useState('');
  const [look, setLook] = useState('');
  const [notes, setNotes] = useState('');
  const [personal, setPersonal] = useState({ name: '', notes: '' });
  const [method, setMethod] = useState<StatMethod>('standard');
  const [stats, setStats] = useState<Record<StatKey, number>>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const me = creds?.playerId;
  const rolledPool = useMemo(() => {
    const rolls = events.filter((e) => e.type === 'dice_rolled' && e.actorId === me && e.payload.notation === STAT_ROLL_NOTATION);
    return rolls.length >= 6 ? rolls.slice(0, 6).map((e) => (e.type === 'dice_rolled' ? e.payload.total : 0)) : null;
  }, [events, me]);

  function chooseMethod(m: StatMethod) {
    setMethod(m);
    setStats(m === 'pointbuy' ? { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 } : BLANK);
  }

  const selectedRole = roles.find((r) => r.name === role);
  const input: CharacterCreateInput = {
    name: name.trim(),
    ancestry: ancestry.trim(),
    className: selectedRole?.name ?? className.trim(),
    ...(selectedRole
      ? { roleName: selectedRole.name }
      : {
          customKit: kitText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, MAX_CUSTOM_KIT),
        }),
    statMethod: method,
    stats: stats as Stats,
    visualDescriptor: look.trim(),
    notes: notes.trim(),
    ...(personal.name.trim() ? { personalItem: { name: personal.name.trim(), notes: personal.notes.trim() } } : {}),
  };
  const statsProblem = STAT_KEYS.some((k) => !stats[k]) ? 'Assign all six scores.' : checkStats(method, stats as Stats, rolledPool ?? undefined);
  const problem = !input.name ? 'Give your character a name.' : !input.className ? 'Name your class.' : statsProblem;

  async function draft() {
    if (!creds) return;
    setDrafting(true);
    setError(null);
    try {
      const d = await api.draftCharacter(creds, description);
      setName(d.name);
      setAncestry(d.ancestry);
      setRole(d.roleName && roles.some((r) => r.name === d.roleName) ? d.roleName : CUSTOM);
      setClassName(d.className);
      setKitText((d.customKit ?? []).join(', '));
      setLook(d.visualDescriptor ?? '');
      setNotes(d.notes ?? '');
      setPersonal({ name: d.personalItem?.name ?? '', notes: d.personalItem?.notes ?? '' });
      setMethod('standard');
      setStats(d.stats);
      setPath('quick');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function rollScores() {
    setError(null);
    const res = await send({ type: 'roll_stats' });
    if (!res.ok) setError(res.error);
  }

  async function create() {
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const res = await send({ type: 'create_character', character: input });
    setBusy(false);
    if (!res.ok) setError(res.error);
  }

  return (
    <div className="space-y-4" data-testid="character-creator">
      <div>
        <h3 className="heading text-xl">Create your character</h3>
        <p className="text-sm text-muted">Pick a role, or describe who you want to play and let the AI draft it for you to edit.</p>
      </div>

      <div className="flex overflow-hidden rounded-[var(--t-radius)] border border-line" role="tablist" aria-label="Creation path">
        {(
          [
            ['quick', 'Pick a role'],
            ['describe', 'Describe your own'],
          ] as const
        ).map(([p, label]) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={path === p}
            onClick={() => setPath(p)}
            className={`flex-1 px-3 py-2 text-sm font-semibold ${path === p ? 'bg-accent text-accent-ink' : 'bg-raised'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {path === 'describe' ? (
        <div className="space-y-2">
          <label className="label" htmlFor="char-desc">
            Who are they?
          </label>
          <textarea
            id="char-desc"
            className="field"
            rows={6}
            maxLength={1500}
            placeholder="A soft-spoken dwarf smith who left her forge to find her missing brother. Strong, stubborn, terrible at lying…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="text-xs text-muted">
            The AI picks a role, look, backstory, a keepsake and which stats matter most. Numbers always follow the rules, and you can edit everything before
            saving.
          </p>
          <button type="button" className="btn btn-primary w-full" disabled={drafting || description.trim().length < 5} onClick={draft}>
            {drafting ? 'Drafting…' : 'Draft my character'}
          </button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <fieldset>
            <legend className="label">Role</legend>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              {roles.map((r) => (
                <label
                  key={r.name}
                  className={`cursor-pointer rounded-[var(--t-radius)] border p-2 text-sm ${role === r.name ? 'border-accent bg-raised' : 'border-line'}`}
                >
                  <input type="radio" name="role" className="sr-only" checked={role === r.name} onChange={() => setRole(r.name)} />
                  <span className="font-semibold">{r.name}</span>
                  <span className="block text-xs text-muted">{r.summary}</span>
                </label>
              ))}
              <label className={`cursor-pointer rounded-[var(--t-radius)] border p-2 text-sm ${role === CUSTOM ? 'border-accent bg-raised' : 'border-line'}`}>
                <input type="radio" name="role" className="sr-only" checked={role === CUSTOM} onChange={() => setRole(CUSTOM)} />
                <span className="font-semibold">Custom…</span>
                <span className="block text-xs text-muted">Invent your own class and a few ordinary items.</span>
              </label>
            </div>
            {selectedRole ? (
              <p className="mt-2 text-xs text-muted">Starting kit: {selectedRole.startingKit.join(', ')}</p>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input aria-label="Custom class name" className="field" placeholder="Class name, e.g. Lamplighter" maxLength={LIMITS.name} value={className} onChange={(e) => setClassName(e.target.value)} />
                <input aria-label="Custom kit, comma separated" className="field" placeholder={`Up to ${MAX_CUSTOM_KIT} items, comma separated`} value={kitText} onChange={(e) => setKitText(e.target.value)} />
              </div>
            )}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="char-name">
                Name
              </label>
              <input id="char-name" className="field" maxLength={LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="char-ancestry">
                Ancestry or origin
              </label>
              <input id="char-ancestry" className="field" maxLength={LIMITS.name} placeholder="optional" value={ancestry} onChange={(e) => setAncestry(e.target.value)} />
            </div>
          </div>

          <fieldset>
            <legend className="label">Stats</legend>
            <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stat method">
              {(
                [
                  ['standard', 'Standard array'],
                  ['pointbuy', 'Point buy'],
                  ['rolled', 'Roll 4d6'],
                ] as const
              ).map(([m, label]) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn py-1 text-sm ${method === m ? 'btn-primary' : ''}`} onClick={() => chooseMethod(m)}>
                  {label}
                </button>
              ))}
            </div>
            {method === 'standard' && <PoolAssigner pool={STANDARD_ARRAY} stats={stats} labels={setting?.statLabels} onChange={setStats} />}
            {method === 'pointbuy' && <PointBuy stats={stats} labels={setting?.statLabels} onChange={setStats} />}
            {method === 'rolled' &&
              (rolledPool ? (
                <>
                  <p className="mb-2 text-sm">
                    Your rolls: <strong className="tabular-nums">{[...rolledPool].sort((a, b) => b - a).join(', ')}</strong>
                  </p>
                  <PoolAssigner pool={rolledPool} stats={stats} labels={setting?.statLabels} onChange={setStats} />
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted">The server rolls 4d6 six times and drops the lowest die each time. Everyone sees the rolls, and you only get one set.</p>
                  <button type="button" className="btn btn-primary" onClick={rollScores}>
                    Roll my scores
                  </button>
                </div>
              ))}
          </fieldset>

          <div>
            <label className="label" htmlFor="char-look">
              Look (used for portraits)
            </label>
            <textarea
              id="char-look"
              className="field"
              rows={2}
              maxLength={LIMITS.visualDescriptor}
              placeholder="Build, face, hair, clothing, gear…"
              value={look}
              onChange={(e) => setLook(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="char-notes">
              Backstory and notes
            </label>
            <textarea id="char-notes" className="field" rows={3} maxLength={LIMITS.characterNotes} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="label">Personal item (optional, flavour only)</legend>
            <input aria-label="Personal item name" className="field" placeholder="e.g. Mother's locket" maxLength={LIMITS.itemName} value={personal.name} onChange={(e) => setPersonal({ ...personal, name: e.target.value })} />
            <input aria-label="Personal item notes" className="field" placeholder="What it means to them" maxLength={LIMITS.itemNotes} value={personal.notes} onChange={(e) => setPersonal({ ...personal, notes: e.target.value })} />
          </fieldset>

          <button type="submit" className="btn btn-primary w-full" disabled={busy || !!problem}>
            {busy ? 'Creating…' : 'Create character'}
          </button>
          {problem && <p className="text-center text-xs text-muted">{problem}</p>}
        </form>
      )}

      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
