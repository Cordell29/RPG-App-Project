import { useEffect, useState } from 'react';
import { type RoomSummary, api } from '../lib/api.ts';
import { navigate, setTheme } from '../lib/router.ts';
import { loadCreds, saveCreds } from '../lib/storage.ts';

/** /join/:code (invite code) or /join?room=:id (opened a room link without a seat). */
export function Join({ code, roomId }: { code: string | null; roomId: string | null }) {
  const [summary, setSummary] = useState<RoomSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [codeInput, setCodeInput] = useState(code ?? '');

  useEffect(() => {
    setError(null);
    setSummary(null);
    const lookup = code ? api.invite(code) : roomId ? api.room(roomId) : null;
    if (!lookup) return;
    lookup.then(
      (s) => {
        if (loadCreds(s.roomId)) return navigate(`/r/${s.roomId}`, true);
        setSummary(s);
        setTheme(s.theme);
      },
      (e: Error) => setError(e.message),
    );
  }, [code, roomId]);

  async function join() {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      const creds = await api.join(summary.roomId, name.trim());
      saveCreds(creds);
      navigate(`/r/${creds.roomId}`, true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-10">
      <button type="button" className="self-start text-sm text-muted hover:underline" onClick={() => navigate('/')}>
        ← Tavern
      </button>
      {!summary && !code && !roomId && (
        <form
          className="panel space-y-3 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/join/${codeInput.trim()}`);
          }}
        >
          <h1 className="heading text-2xl">Join a table</h1>
          <label className="label" htmlFor="join-code">
            Invite code
          </label>
          <input id="join-code" className="field text-center font-mono uppercase tracking-widest" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} />
          <button type="submit" className="btn btn-primary w-full" disabled={!codeInput.trim()}>
            Find table
          </button>
        </form>
      )}
      {summary && (
        <form
          className="panel space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <div>
            <p className="label">You're invited to</p>
            <h1 className="heading text-3xl" data-testid="join-room-name">
              {summary.name}
            </h1>
            <p className="text-sm text-muted">
              {summary.settingName} · {summary.playerCount}/{summary.maxPlayers} players
            </p>
          </div>
          {summary.mode === 'solo' ? (
            <p className="text-sm">This is a solo game right now. Ask the host to switch it to group play.</p>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="display-name">
                  Your name
                </label>
                <input
                  id="display-name"
                  className="field"
                  required
                  maxLength={40}
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="What should the table call you?"
                />
              </div>
              <button type="submit" className="btn btn-primary w-full" disabled={busy || !name.trim()}>
                {busy ? 'Joining…' : 'Take a seat'}
              </button>
            </>
          )}
        </form>
      )}
      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
