import type { Character } from '@tavern/shared';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useRoom } from '../lib/store.ts';

type Recharge = 'at_will' | 'short_rest' | 'long_rest';

/**
 * Add an ability, spell list or gadget: type it, paste standard rules text, or describe an
 * idea and let the AI draft it. The host's are added at once; players' go to the host.
 */
export function AbilityWorkshop({ character, onDone }: { character: Character; onDone: () => void }) {
  const { send, creds, isHost } = useRoom();
  const [idea, setIdea] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', uses: 0, recharge: 'at_will' as Recharge, basis: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function draft() {
    if (!creds) return;
    setDrafting(true);
    setMsg(null);
    try {
      const d = await api.draftAbility(creds, character.id, idea);
      setForm({ name: d.name, description: d.description, uses: d.uses ?? 0, recharge: d.recharge, basis: d.basis });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setDrafting(false);
    }
  }

  async function submit() {
    const res = await send({
      type: 'propose_ability',
      characterId: character.id,
      ability: {
        name: form.name.trim(),
        description: form.description.trim(),
        recharge: form.uses > 0 ? (form.recharge === 'at_will' ? 'long_rest' : form.recharge) : 'at_will',
        ...(form.uses > 0 ? { uses: form.uses } : {}),
      },
      ...(form.basis.trim() ? { basis: form.basis.trim() } : {}),
    });
    if (!res.ok) return setMsg({ ok: false, text: res.error });
    setMsg({ ok: true, text: isHost ? 'Added.' : 'Sent to the host for approval.' });
    setForm({ name: '', description: '', uses: 0, recharge: 'at_will', basis: '' });
    setIdea('');
    setTimeout(onDone, 1200);
  }

  return (
    <div className="space-y-2 rounded-[var(--t-radius)] border border-line bg-raised p-3 text-sm" data-testid="ability-workshop">
      <label className="label" htmlFor={`idea-${character.id}`}>
        Describe it, or paste the rules text
      </label>
      <textarea
        id={`idea-${character.id}`}
        className="field"
        rows={3}
        maxLength={2000}
        placeholder="e.g. 'I can call lightning from the sky once a day' or paste a 5e feature or spell. The AI scales it to your level."
        value={idea}
        onChange={(e) => setIdea(e.target.value)}
      />
      <button type="button" className="btn w-full" disabled={drafting || idea.trim().length < 3} onClick={draft}>
        {drafting ? 'Drafting…' : 'Draft with AI'}
      </button>
      <form
        className="space-y-2 border-t border-line pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input aria-label="Ability name" className="field" placeholder="Name" maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <textarea
          aria-label="Ability description"
          className="field"
          rows={3}
          maxLength={600}
          placeholder="What it does (the GM reads this)"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <div className="flex gap-2">
          <label className="flex-1 text-xs">
            <span className="text-muted">Uses (0 = at will)</span>
            <input type="number" min={0} max={20} className="field py-1" value={form.uses} onChange={(e) => setForm({ ...form, uses: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
          </label>
          <label className="flex-1 text-xs">
            <span className="text-muted">Recharges on</span>
            <select className="field py-1" value={form.recharge} disabled={form.uses === 0} onChange={(e) => setForm({ ...form, recharge: e.target.value as Recharge })}>
              <option value="short_rest">Short rest</option>
              <option value="long_rest">Long rest</option>
              <option value="at_will">—</option>
            </select>
          </label>
        </div>
        <label className="block text-xs">
          <span className="text-muted">Comparable 5e feature or spell (helps the host judge power)</span>
          <input aria-label="Comparable to" className="field py-1" maxLength={300} placeholder="e.g. Equivalent to Shield (1st-level spell)" value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })} />
        </label>
        <button type="submit" className="btn btn-primary w-full" disabled={!form.name.trim() || !form.description.trim()}>
          {isHost ? 'Add ability' : 'Send to host'}
        </button>
      </form>
      {msg && (
        <p className={msg.ok ? 'text-good' : 'text-bad'} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
