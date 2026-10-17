import { randomId } from '../lib/id.ts';
import { type Character, type HostOverride, type SettingPreset, CONDITIONS, LIMITS, STAT_KEYS } from '@tavern/shared';
import { useState } from 'react';
import { useRoom } from '../lib/store.ts';

/** Host-only adjustments. Each one is a host_override command, logged as an event for everyone. */
export function HostControls({ character: c, setting }: { character: Character; setting: SettingPreset | null }) {
  const send = useRoom((s) => s.send);
  const [amount, setAmount] = useState(5);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [item, setItem] = useState({ name: '', qty: 1, notes: '' });
  const currency = setting?.currencyName ?? 'gold';

  async function override(o: HostOverride, label: string) {
    const res = await send({ type: 'host_override', override: o, ...(reason.trim() ? { reason: reason.trim() } : {}) });
    setStatus(res.ok ? { ok: true, text: `${label} ✓` } : { ok: false, text: res.error });
  }
  const patch = (p: Extract<HostOverride, { kind: 'character' }>['patch'], label: string) =>
    override({ kind: 'character', characterId: c.id, patch: p }, label);

  const clampHp = (v: number) => Math.max(0, Math.min(c.hp.max, v));

  return (
    <section className="space-y-3 rounded-[var(--t-radius)] border-2 border-dashed border-accent p-3" aria-label={`Host controls for ${c.name}`} data-testid="host-controls">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-20">
          <label className="label" htmlFor={`amt-${c.id}`}>
            Amount
          </label>
          <input
            id={`amt-${c.id}`}
            type="number"
            min={1}
            max={9999}
            className="field"
            value={amount}
            onChange={(e) => setAmount(Math.max(1, Math.min(9999, Number(e.target.value) || 1)))}
          />
        </div>
        <div className="min-w-32 flex-1">
          <label className="label" htmlFor={`why-${c.id}`}>
            Reason (shown to all)
          </label>
          <input id={`why-${c.id}`} className="field" maxLength={300} placeholder="optional" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <button type="button" className="btn" onClick={() => patch({ hp: { current: clampHp(c.hp.current - amount) } }, `−${amount} HP`)}>
          Damage −{amount}
        </button>
        <button type="button" className="btn" onClick={() => patch({ hp: { current: clampHp(c.hp.current + amount) } }, `+${amount} HP`)}>
          Heal +{amount}
        </button>
        <button type="button" className="btn" onClick={() => patch({ gold: Math.max(0, c.gold - amount) }, `−${amount} ${currency}`)}>
          {currency} −{amount}
        </button>
        <button type="button" className="btn" onClick={() => patch({ gold: c.gold + amount }, `+${amount} ${currency}`)}>
          {currency} +{amount}
        </button>
        <button type="button" className="btn" onClick={() => patch({ xp: c.xp + amount }, `+${amount} XP`)}>
          XP +{amount}
        </button>
        <button type="button" className="btn" onClick={() => patch({ hp: { current: c.hp.max } }, 'Full heal')}>
          Full heal
        </button>
      </div>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">Set values directly</summary>
        <form
          key={[c.hp.current, c.hp.max, c.ac, c.level, c.gold, c.xp, ...STAT_KEYS.map((k) => c.stats[k])].join()}
          className="mt-2 grid grid-cols-3 gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const num = (k: string) => Number(f.get(k));
            void patch(
              {
                hp: { current: num('hpc'), max: num('hpm') },
                ac: num('ac'),
                level: num('level'),
                gold: num('gold'),
                xp: num('xp'),
                stats: Object.fromEntries(STAT_KEYS.map((k) => [k, num(k)])),
              },
              'Values set',
            );
          }}
        >
          {(
            [
              ['hpc', 'HP now', c.hp.current, 0, 999],
              ['hpm', 'HP max', c.hp.max, 1, 999],
              ['ac', 'Base AC', c.ac, 1, 40],
              ['level', 'Level', c.level, 1, 20],
              ['gold', currency, c.gold, 0, 1e7],
              ['xp', 'XP', c.xp, 0, 1e7],
              ...STAT_KEYS.map((k) => [k, setting?.statLabels[k] ?? k, c.stats[k], 1, 20] as const),
            ] as const
          ).map(([name, label, value, min, max]) => (
            <label key={name} className="text-xs">
              <span className="block truncate text-muted">{label}</span>
              <input name={name} type="number" className="field py-1" defaultValue={value} min={min} max={max} required />
            </label>
          ))}
          <button type="submit" className="btn btn-primary col-span-3">
            Apply values
          </button>
        </form>
      </details>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">Conditions</summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CONDITIONS.map((cond) => {
            const on = c.conditions.includes(cond);
            return (
              <button
                key={cond}
                type="button"
                aria-pressed={on}
                className={`rounded-full border px-2 py-0.5 text-xs capitalize ${on ? 'border-bad bg-bad text-accent-ink' : 'border-line'}`}
                onClick={() =>
                  patch({ conditions: on ? c.conditions.filter((x) => x !== cond) : [...c.conditions, cond] }, `${cond} ${on ? 'off' : 'on'}`)
                }
              >
                {cond}
              </button>
            );
          })}
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">Items</summary>
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!item.name.trim()) return;
            void override(
              {
                kind: 'add_item',
                characterId: c.id,
                item: {
                  instanceId: randomId().slice(0, 16),
                  name: item.name.trim(),
                  qty: item.qty,
                  equipped: false,
                  tags: [],
                  ...(item.notes.trim() ? { notes: item.notes.trim() } : {}),
                },
              },
              `Gave ${item.name.trim()}`,
            ).then(() => setItem({ name: '', qty: 1, notes: '' }));
          }}
        >
          <div className="flex gap-2">
            <input aria-label="New item name" className="field" placeholder="Item name" maxLength={LIMITS.itemName} value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
            <input
              aria-label="Quantity"
              type="number"
              min={1}
              max={999}
              className="field w-20"
              value={item.qty}
              onChange={(e) => setItem({ ...item, qty: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })}
            />
          </div>
          <input aria-label="Item notes" className="field" placeholder="Notes (optional)" maxLength={LIMITS.itemNotes} value={item.notes} onChange={(e) => setItem({ ...item, notes: e.target.value })} />
          <button type="submit" className="btn w-full" disabled={!item.name.trim()}>
            Give item
          </button>
        </form>
        {c.inventory.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {c.inventory.map((i) => (
              <li key={i.instanceId} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {i.name}
                  {i.qty > 1 ? ` ×${i.qty}` : ''}
                </span>
                <button
                  type="button"
                  className="btn px-2 py-0.5 text-xs"
                  onClick={() => override({ kind: 'remove_item', characterId: c.id, instanceId: i.instanceId, qty: 1 }, `Removed ${i.name}`)}
                >
                  Remove 1
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">Abilities, {setting?.slotsLabel?.toLowerCase() ?? 'spell slots'}{c.meters.spirit || c.meters.supply ? ' and meters' : ''}</summary>
        <div className="mt-2 space-y-3 text-sm">
          {c.abilities.length > 0 && (
            <ul className="space-y-1">
              {c.abilities.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {a.name}
                    {a.uses ? ` (${a.uses.current}/${a.uses.max})` : ''}
                  </span>
                  <span className="flex gap-1">
                    {a.uses && (
                      <button
                        type="button"
                        className="btn px-2 py-0.5 text-xs"
                        onClick={() => override({ kind: 'update_ability', characterId: c.id, abilityId: a.id, patch: { uses: { current: a.uses!.max, max: a.uses!.max } } }, `${a.name} restored`)}
                      >
                        Restore
                      </button>
                    )}
                    <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => override({ kind: 'remove_ability', characterId: c.id, abilityId: a.id }, `Removed ${a.name}`)}>
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form
            key={c.spellSlots.map((x) => x.max).join()}
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const max = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => Number(f.get(`slot${l}`)) || 0);
              const last = max.reduce((n, v, i) => (v > 0 ? i + 1 : n), 0);
              void override(
                { kind: 'spell_slots', characterId: c.id, slots: max.slice(0, last).map((m, i) => ({ max: m, current: Math.min(m, c.spellSlots[i]?.current ?? m) })) },
                'Slots set',
              );
            }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => (
              <label key={l} className="w-11 text-center text-xs">
                <span className="block text-muted">{l}</span>
                <input name={`slot${l}`} type="number" min={0} max={9} className="field px-1 py-0.5 text-center" defaultValue={c.spellSlots[l - 1]?.max ?? 0} />
              </label>
            ))}
            <button type="submit" className="btn px-2 py-1 text-xs">
              Set max
            </button>
          </form>
          {(['spirit', 'supply'] as const).map((m) =>
            c.meters[m] ? (
              <div key={m} className="flex items-center gap-2">
                <span className="w-14 capitalize">{m}</span>
                {[0, 1, 2, 3, 4, 5].map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`btn px-2 py-0.5 text-xs ${c.meters[m]!.current === v ? 'btn-primary' : ''}`}
                    onClick={() => override({ kind: 'meter', characterId: c.id, meter: m, current: v }, `${m} ${v}`)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </div>
      </details>

      {status && (
        <p className={`text-sm ${status.ok ? 'text-good' : 'text-bad'}`} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}
