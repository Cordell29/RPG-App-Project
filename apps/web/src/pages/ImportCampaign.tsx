import { useEffect, useState } from 'react';
import { CopyButton } from '../components/CopyButton.tsx';
import { type ImportResult, api } from '../lib/api.ts';
import { navigate, setTheme } from '../lib/router.ts';
import { saveCreds } from '../lib/storage.ts';

/** Restore a downloaded campaign file into a brand-new room. The person importing becomes the host. */
export function ImportCampaign() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  useEffect(() => setTheme('neutral'), []);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importCampaign(await file.text());
      saveCreds({ roomId: res.roomId, playerId: res.playerId, token: res.token });
      setDone(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hostLink = done ? `${location.origin}/r/${done.roomId}?host=${done.hostToken}` : '';
  const inviteLink = done ? `${location.origin}/join/${done.inviteCode}` : '';

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <button type="button" className="text-sm text-muted hover:underline" onClick={() => navigate('/')}>
        ← Back
      </button>
      <h1 className="heading mt-2 text-3xl font-bold">Restore a campaign</h1>

      {!done ? (
        <form
          className="panel mt-6 space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void upload();
          }}
        >
          <p className="text-sm text-muted">
            Choose a campaign file (<code>.tavern.json</code>) downloaded from Backup &amp; seats. It becomes a new room; nothing existing is
            changed. You'll be the host, playing the original host's character.
          </p>
          <div>
            <label className="label" htmlFor="campaign-file">
              Campaign file
            </label>
            <input
              id="campaign-file"
              type="file"
              accept=".json,application/json"
              className="field"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setError(null);
              }}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={!file || busy}>
            {busy ? 'Restoring…' : 'Restore campaign'}
          </button>
          {error && (
            <p className="text-sm text-bad" role="alert" data-testid="import-error">
              {error}
            </p>
          )}
        </form>
      ) : (
        <section className="panel mt-6 space-y-4 p-6" aria-labelledby="restored-h">
          <h2 id="restored-h" className="heading text-xl">
            Restored. Save your new host link
          </h2>
          <p className="text-sm">
            This is a new room with its own links. <strong>The host link is shown only once.</strong>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[var(--t-radius)] bg-raised px-3 py-2 text-xs" data-testid="host-link">
              {hostLink}
            </code>
            <CopyButton text={hostLink} label="Copy host link" />
          </div>
          <div>
            <p className="label">New invite code</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="heading text-2xl tracking-widest" data-testid="invite-code">
                {done.inviteCode}
              </span>
              <CopyButton text={inviteLink} label="Copy invite link" />
            </div>
          </div>
          <p className="text-sm text-muted">
            Returning players: open <strong>Backup &amp; seats</strong> in the room and send each of them their rejoin link, so they get their
            own character back.
            {done.missingImages > 0 && ` ${done.missingImages} picture${done.missingImages === 1 ? ' was' : 's were'} not in the file; you can repaint them there too.`}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} />
            I've saved my host link
          </label>
          <button type="button" className="btn btn-primary" disabled={!savedAck} onClick={() => navigate(`/r/${done.roomId}`)}>
            Enter the tavern
          </button>
        </section>
      )}
    </main>
  );
}
