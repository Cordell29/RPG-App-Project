import { normalizeInviteCode } from '@tavern/shared';
import { useEffect, useState } from 'react';
import { navigate, setTheme } from '../lib/router.ts';

export function Home() {
  const [code, setCode] = useState('');
  useEffect(() => setTheme('neutral'), []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-4 py-12">
      <header className="text-center">
        <h1 className="heading text-4xl font-bold sm:text-5xl">Tavern</h1>
        <p className="mt-2 text-muted">Tabletop adventures with an AI Game Master. Play solo or with up to five friends.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="panel flex flex-col gap-3 p-6">
          <h2 className="heading text-xl">Start a campaign</h2>
          <p className="flex-1 text-sm text-muted">Pick a fantasy or sci-fi world, or describe your own. You'll be the host.</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/new')}>
            New campaign
          </button>
          <button type="button" className="text-sm text-muted underline" onClick={() => navigate('/import')}>
            Restore a campaign from a backup file
          </button>
        </section>
        <section className="panel flex flex-col gap-3 p-6">
          <h2 className="heading text-xl">Join a table</h2>
          <form
            className="flex flex-1 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) navigate(`/join/${normalizeInviteCode(code)}`);
            }}
          >
            <label className="label" htmlFor="invite-code">
              Invite code
            </label>
            <input
              id="invite-code"
              className="field text-center font-mono text-lg tracking-widest uppercase"
              placeholder="ABCD-EFGH"
              value={code}
              maxLength={12}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="btn" disabled={!code.trim()}>
              Join
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
