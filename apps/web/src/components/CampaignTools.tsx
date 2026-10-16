import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { usePublicOrigin } from '../lib/origin.ts';
import { useMedia } from '../lib/media.ts';
import { downloadBlob } from '../lib/story.ts';
import { useRoom } from '../lib/store.ts';
import { CopyButton } from './CopyButton.tsx';

/** Rejoin links the host has minted this visit (a link works once). */
function SeatRow({ playerId, name, isHost, here }: { playerId: string; name: string; isHost: boolean; here: boolean }) {
  const creds = useRoom((s) => s.creds);
  const origin = usePublicOrigin();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="space-y-1 rounded-[var(--t-radius)] border border-line p-2" data-testid="seat">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${here ? 'bg-good' : 'bg-muted opacity-50'}`} aria-hidden="true" />
        <strong className="flex-1">{name}</strong>
        {isHost ? (
          <span className="text-xs text-muted">you (use your host link)</span>
        ) : (
          <button
            type="button"
            className="btn px-2 py-0.5 text-xs"
            onClick={async () => {
              if (!creds) return;
              if (!link && !confirm(`Make a new rejoin link for ${name}? Their current device will be signed out until they use it.`)) return;
              setError(null);
              try {
                const { token } = await api.seatLink(creds, playerId);
                setLink(`${origin}/r/${creds.roomId}?seat=${playerId}.${token}`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {link ? 'New link' : 'Rejoin link'}
          </button>
        )}
      </div>
      {link && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-raised px-2 py-1 text-xs" data-testid="seat-link">
            {link}
          </code>
          <CopyButton text={link} label="Copy" />
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

/** Today's estimated AI spend and this room's daily cap. */
function Budget() {
  const { creds, send, turnStatus } = useRoom();
  const [spend, setSpend] = useState<Awaited<ReturnType<typeof api.spend>> | null>(null);
  const [cap, setCap] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const load = () => {
    if (creds) api.spend(creds).then((s) => {
      setSpend(s);
      setCap(s.roomCapUsd.toFixed(2));
    }, () => {});
  };
  useEffect(load, [creds]);
  if (!spend) return null;
  const pct = Math.min(100, (spend.roomTodayUsd / Math.max(0.01, spend.roomCapUsd)) * 100);
  return (
    <section className="space-y-2" data-testid="budget">
      <h3 className="heading text-base">AI budget today</h3>
      <p className="text-sm">
        <strong>${spend.roomTodayUsd.toFixed(2)}</strong> of ${spend.roomCapUsd.toFixed(2)} for this room
        <span className="text-muted"> · server total ${spend.globalTodayUsd.toFixed(2)} of ${spend.globalCapUsd.toFixed(2)}</span>
      </p>
      <div className="h-2 overflow-hidden rounded bg-raised" role="meter" aria-label="Room budget used" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${pct >= 100 ? 'bg-bad' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      {turnStatus.status === 'paused' && <p className="text-sm text-bad">{turnStatus.error}</p>}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const usd = Number(cap);
          if (!Number.isFinite(usd) || usd < 0 || usd > 100) return setNote('Enter an amount between $0 and $100.');
          const res = await send({ type: 'set_spend_cap', usd });
          setNote(res.ok ? `Daily cap set to $${usd.toFixed(2)}.` : res.error);
          load();
        }}
      >
        <label className="block">
          <span className="label">Daily cap (US$)</span>
          <input className="field w-28" type="number" min={0} max={100} step={0.5} value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <button type="submit" className="btn">
          Set cap
        </button>
      </form>
      <p className="text-xs text-muted">Estimates from token counts and list prices; resets at midnight UTC. Your Anthropic/Google billing limits are the real backstop.</p>
      {note && <p className="text-xs">{note}</p>}
    </section>
  );
}

/**
 * Host-only: download the campaign file, repaint images missing after an import, rebuild
 * state after a desync, and hand out rejoin links for seats.
 */
export function CampaignTools({ onClose }: { onClose: () => void }) {
  const { creds, state, online, send, events } = useRoom();
  const restored = useMemo(() => events.some((e) => e.type === 'campaign_imported'), [events]);
  const media = useMedia();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const failed = useMemo(() => [...media.status.values()].filter((s) => s === 'failed').length, [media]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const exportFile = (images: boolean) =>
    run(images ? 'export-images' : 'export', async () => {
      if (!creds) throw new Error('Not signed in.');
      const { blob, filename } = await api.exportCampaign(creds, images);
      downloadBlob(filename, blob);
      return `Saved ${filename} (${(blob.size / 1024).toFixed(0)} KB). Keep it somewhere safe; Restore a campaign on the home page brings it back.`;
    });

  const command = (label: string, body: Parameters<typeof send>[0], done: string) =>
    run(label, async () => {
      const res = await send(body);
      if (!res.ok) throw new Error(res.error);
      return done;
    });

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="panel m-auto max-h-[90vh] w-[min(36rem,calc(100vw-1rem))] max-w-none overflow-y-auto p-0 text-ink backdrop:bg-black/60"
      aria-labelledby="tools-h"
      data-testid="campaign-tools"
    >
      <header className="flex items-center gap-2 border-b border-line p-4">
        <h2 id="tools-h" className="heading flex-1 text-xl">
          Backup &amp; seats
        </h2>
        <button type="button" className="btn py-1 text-sm" onClick={() => ref.current?.close()}>
          Close
        </button>
      </header>
      <div className="space-y-6 p-4">
        <Budget />
        <section className="space-y-2">
          <h3 className="heading text-base">Download the campaign</h3>
          <p className="text-sm text-muted">
            One file with the whole story, every character, chapters, world notes and settings. The server also keeps a backup every night
            for 14 days.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => exportFile(false)}>
              {busy === 'export' ? 'Preparing…' : 'Download campaign file'}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => exportFile(true)}>
              {busy === 'export-images' ? 'Preparing…' : 'Include images'}
            </button>
          </div>
          <p className="text-xs text-muted">Without images the file is small; pictures can be repainted after restoring.</p>
        </section>

        {(failed > 0 || restored) && (
          <section className="space-y-2">
            <h3 className="heading text-base">Missing images</h3>
            <p className="text-sm text-muted">
              {failed > 0 ? `${failed} picture${failed === 1 ? '' : 's'} failed to paint. ` : ''}Pictures restored from a file without images,
              or that failed, can be repainted from the same descriptions (this counts toward image costs).
            </p>
            <button type="button" className="btn" disabled={!!busy} onClick={() => command('repaint', { type: 'repaint_missing' }, 'Repainting; pictures appear as they finish.')}>
              Repaint missing images
            </button>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="heading text-base">Seats</h3>
          <p className="text-sm text-muted">
            If someone lost their seat (new phone, cleared browser) or you restored this campaign from a file, send them a rejoin link. Each
            link works once.
          </p>
          <ul className="space-y-1.5">
            {state.players
              .filter((p) => p.active)
              .map((p) => (
                <SeatRow
                  key={p.id}
                  playerId={p.id}
                  name={`${state.party.find((c) => c.playerId === p.id)?.name ?? p.displayName} (${p.displayName})`}
                  isHost={p.isHost}
                  here={online.includes(p.id)}
                />
              ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="heading text-base">Something looks wrong?</h3>
          <p className="text-sm text-muted">
            Rebuild replays every event from the start and refreshes everyone's screen. Nothing is lost. Use it if players see different
            things.
          </p>
          <button type="button" className="btn" disabled={!!busy} onClick={() => command('rebuild', { type: 'rebuild_state' }, 'State rebuilt from the full history. Everyone has been refreshed.')}>
            {busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild state'}
          </button>
        </section>

        {note && (
          <p className={`text-sm ${note.ok ? 'text-good' : 'text-bad'}`} role={note.ok ? 'status' : 'alert'} data-testid="tools-note">
            {note.text}
          </p>
        )}
      </div>
    </dialog>
  );
}
