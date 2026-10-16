import { LIMITS, type SettingPreset, type StartChoice } from '@tavern/shared';
import { useEffect, useState } from 'react';
import { CopyButton } from '../components/CopyButton.tsx';
import { SettingEditor, validateSetting } from '../components/SettingEditor.tsx';
import { StartPicker, startChoiceReady } from '../components/StartPicker.tsx';
import { api } from '../lib/api.ts';
import { navigate, setTheme } from '../lib/router.ts';
import { saveCreds } from '../lib/storage.ts';

type Step = 'world' | 'review' | 'details' | 'saved';

const PRESET_BLURBS: Record<string, string> = {
  fantasy: 'Heroic high fantasy. Swords, spells and ancient ruins.',
  scifi: 'Gritty space frontier. Worn ships, thin margins, hard choices.',
};

export function CreateRoom() {
  const [step, setStep] = useState<Step>('world');
  const [presets, setPresets] = useState<SettingPreset[]>([]);
  const [setting, setSetting] = useState<SettingPreset | null>(null);
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [hostName, setHostName] = useState('');
  const [mode, setMode] = useState<'solo' | 'group'>('group');
  const [start, setStart] = useState<StartChoice>({ kind: 'random' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ roomId: string; hostToken: string; inviteCode: string } | null>(null);
  const [savedAck, setSavedAck] = useState(false);

  useEffect(() => {
    setTheme('neutral');
    api.presets().then(setPresets, (e: Error) => setError(e.message));
  }, []);

  function choose(p: SettingPreset, next: Step) {
    setSetting(structuredClone(p));
    setStart({ kind: 'random' });
    setTheme(p.theme);
    if (!roomName) setRoomName(`${p.name} campaign`);
    setError(null);
    setStep(next);
  }

  async function draft() {
    setDrafting(true);
    setError(null);
    try {
      const p = await api.draftSetting(description);
      setSetting(p);
      setTheme(p.theme);
      setRoomName(p.name.replace(/ \(draft\)$/, ''));
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function create() {
    if (!setting) return;
    const invalid = validateSetting(setting);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      const res = await api.createRoom({ roomName: roomName.trim(), hostName: hostName.trim(), setting, mode, start });
      saveCreds({ roomId: res.roomId, playerId: res.playerId, token: res.token });
      setCreated({ roomId: res.roomId, hostToken: res.hostToken, inviteCode: res.inviteCode });
      setStep('saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hostLink = created ? `${location.origin}/r/${created.roomId}?host=${created.hostToken}` : '';
  const inviteLink = created ? `${location.origin}/join/${created.inviteCode}` : '';

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <button type="button" className="text-sm text-muted hover:underline" onClick={() => navigate('/')}>
        ← Back
      </button>
      <h1 className="heading mt-2 text-3xl font-bold">New campaign</h1>

      {step === 'world' && (
        <section className="mt-6 space-y-4" aria-labelledby="world-h">
          <h2 id="world-h" className="heading text-xl">
            1 · Choose a world
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {presets.map((p) => (
              <div key={p.key} data-theme={p.theme} className="panel flex flex-col gap-2 p-5" style={{ background: 'var(--t-surface)', color: 'var(--t-ink)' }}>
                <h3 className="heading text-2xl">{p.name}</h3>
                <p className="flex-1 text-sm" style={{ color: 'var(--t-muted)' }}>
                  {PRESET_BLURBS[p.key] ?? p.tone}
                </p>
                <p className="text-xs" style={{ color: 'var(--t-muted)' }}>
                  {p.roles.map((r) => r.name).join(' · ')}
                </p>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-primary flex-1" onClick={() => choose(p, 'details')}>
                    Play {p.name}
                  </button>
                  <button type="button" className="btn" onClick={() => choose(p, 'review')}>
                    Customise
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="panel p-5">
            <h3 className="heading text-xl">Describe your own</h3>
            <p className="text-sm text-muted">
              Describe a world in your own words. The AI drafts a setting (roles, stat names, currency, hooks) and you edit it before
              playing. The rules stay the same; only the flavour changes.
            </p>
            <label className="label mt-3" htmlFor="world-desc">
              Your world
            </label>
            <textarea
              id="world-desc"
              className="field"
              rows={5}
              maxLength={LIMITS.customSettingDescription}
              placeholder="A drowned city of canals and lanterns, where rival glassblower guilds fight over the last sources of living light…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted">
                {description.length}/{LIMITS.customSettingDescription}
              </span>
              <button type="button" className="btn btn-primary" disabled={drafting || description.trim().length < 10} onClick={draft}>
                {drafting ? 'Drafting…' : 'Draft my world'}
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 'review' && setting && (
        <section className="mt-6 space-y-4" aria-labelledby="review-h">
          <h2 id="review-h" className="heading text-xl">
            1 · Review your world
          </h2>
          <div className="panel p-5">
            <SettingEditor value={setting} onChange={setSetting} />
          </div>
          <div className="flex justify-between gap-2">
            <button type="button" className="btn" onClick={() => setStep('world')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const invalid = validateSetting(setting);
                if (invalid) setError(invalid);
                else {
                  setError(null);
                  setStep('details');
                }
              }}
            >
              Looks good
            </button>
          </div>
        </section>
      )}

      {step === 'details' && setting && (
        <section className="mt-6 space-y-4" aria-labelledby="details-h">
          <h2 id="details-h" className="heading text-xl">
            2 · Your table
          </h2>
          <form
            className="panel space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <p className="text-sm text-muted">
              World: <strong className="text-ink">{setting.name}</strong>{' '}
              <button type="button" className="underline" onClick={() => setStep('review')}>
                edit
              </button>
            </p>
            <div>
              <label className="label" htmlFor="room-name">
                Campaign name
              </label>
              <input id="room-name" className="field" required maxLength={60} value={roomName} onChange={(e) => setRoomName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="host-name">
                Your name
              </label>
              <input
                id="host-name"
                className="field"
                required
                maxLength={40}
                placeholder="What should the table call you?"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
              />
            </div>
            <fieldset>
              <legend className="label">How will you play?</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ['solo', 'Solo', 'Just you and the GM. Every action resolves immediately. You can invite friends later.'],
                    ['group', 'With friends', 'Share an invite code. Up to 6 players, everyone writes their own actions.'],
                  ] as const
                ).map(([value, title, text]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer gap-3 rounded-[var(--t-radius)] border p-3 ${mode === value ? 'border-accent bg-raised' : 'border-line'}`}
                  >
                    <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1" />
                    <span>
                      <span className="font-semibold">{title}</span>
                      <span className="block text-sm text-muted">{text}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <StartPicker setting={setting} value={start} onChange={setStart} />
            <div className="flex justify-between gap-2">
              <button type="button" className="btn" onClick={() => setStep('world')}>
                Change world
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !roomName.trim() || !hostName.trim() || !startChoiceReady(start)}>
                {busy ? 'Creating…' : 'Create campaign'}
              </button>
            </div>
          </form>
        </section>
      )}

      {step === 'saved' && created && (
        <section className="panel mt-6 space-y-4 p-6" aria-labelledby="saved-h">
          <h2 id="saved-h" className="heading text-xl">
            Save your host link
          </h2>
          <p className="text-sm">
            This link gives host controls on any device. <strong>It's shown only once.</strong> Keep it somewhere safe (a note, a
            password manager or a private message to yourself).
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[var(--t-radius)] bg-raised px-3 py-2 text-xs" data-testid="host-link">
              {hostLink}
            </code>
            <CopyButton text={hostLink} label="Copy host link" />
          </div>
          {mode === 'group' && (
            <div>
              <p className="label">Invite your friends</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="heading text-2xl tracking-widest" data-testid="invite-code">
                  {created.inviteCode}
                </span>
                <CopyButton text={inviteLink} label="Copy invite link" />
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
            I've saved my host link
          </label>
          <button type="button" className="btn btn-primary" disabled={!savedAck} onClick={() => navigate(`/r/${created.roomId}`)}>
            Enter the tavern
          </button>
        </section>
      )}

      {error && (
        <p className="mt-4 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
