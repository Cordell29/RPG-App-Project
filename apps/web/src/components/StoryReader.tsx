import { type CanonEntry, deriveCanon } from '@tavern/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type StoryEntry, buildChronicle, downloadText, storyMarkdown, storyText } from '../lib/story.ts';
import { useRoom } from '../lib/store.ts';
import { CopyButton } from './CopyButton.tsx';
import { SpeakButton } from './StoryPanel.tsx';

/** "Story so far": every narrated turn in order, grouped by session. */
const KIND_LABEL: Record<CanonEntry['kind'], string> = { npc: 'People', location: 'Places', faction: 'Factions', lore: 'Lore' };
const pretty = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function Chronicle() {
  const events = useRoom((s) => s.events);
  const chronicle = useMemo(() => buildChronicle(events), [events]);
  if (!chronicle.length) return <p className="text-muted">Chapters are written every 10 turns.</p>;
  return (
    <div className="space-y-4">
      {chronicle.map((c) => (
        <article key={c.seq}>
          <h3 className="heading text-base">{c.level === 1 ? `Arc ${c.number}` : `Chapter ${c.number}`}</h3>
          <p className="whitespace-pre-wrap leading-relaxed">{c.summary}</p>
        </article>
      ))}
    </div>
  );
}

function WorldNotes() {
  const events = useRoom((s) => s.events);
  const canon = useMemo(() => deriveCanon(events), [events]);
  if (!canon.length) return <p className="text-muted">The GM records people, places and factions here as you meet them.</p>;
  return (
    <div className="space-y-5" data-testid="world-notes">
      {(Object.keys(KIND_LABEL) as CanonEntry['kind'][]).map((kind) => {
        const list = canon.filter((c) => c.kind === kind).sort((a, b) => a.key.localeCompare(b.key));
        if (!list.length) return null;
        return (
          <section key={kind}>
            <h3 className="heading mb-2 text-base">{KIND_LABEL[kind]}</h3>
            <ul className="space-y-2">
              {list.map((c) => (
                <li key={c.key} className="rounded-[var(--t-radius)] border border-line p-2">
                  <strong>{pretty(c.key)}</strong>
                  {c.aliases.length > 0 && <span className="text-sm text-muted"> · {c.aliases.join(', ')}</span>}
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {c.facts.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function StoryReader({ entries, onClose }: { entries: StoryEntry[]; onClose: () => void }) {
  const roomName = useRoom((s) => s.state.roomName);
  const download = () => {
    const { events, state } = useRoom.getState();
    const slug = roomName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tavern';
    downloadText(`${slug}-story.md`, storyMarkdown(roomName, events, state));
  };
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'story' | 'chronicle' | 'world'>('story');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="panel m-auto h-[90vh] w-[min(48rem,calc(100vw-1rem))] max-w-none p-0 text-ink backdrop:bg-black/60"
      aria-labelledby="reader-h"
      data-testid="story-reader"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <h2 id="reader-h" className="heading flex-1 text-xl">
            {roomName}: the story so far
          </h2>
          <CopyButton text={storyText(entries)} label="Copy text" />
          <button type="button" className="btn py-1 text-sm" onClick={download} title="Recaps, chapters, world notes and the full story as a Markdown file">
            Download
          </button>
          <button type="button" className="btn py-1 text-sm" onClick={() => ref.current?.close()}>
            Close
          </button>
        </header>
        <div className="flex gap-1 border-b border-line px-4 py-2" role="tablist">
          {(
            [
              ['story', 'Full story'],
              ['chronicle', 'Chapters'],
              ['world', 'World notes'],
            ] as const
          ).map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`btn py-1 text-sm ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {tab === 'chronicle' && <Chronicle />}
          {tab === 'world' && <WorldNotes />}
          {tab === 'story' && entries.map((en) =>
            en.kind === 'recap' ? (
              <aside key={`r${en.seq}`} className="rounded-[var(--t-radius)] border border-accent bg-raised p-3 text-sm italic">
                <strong className="not-italic">Recap of session {en.number}:</strong> {en.text}
              </aside>
            ) : en.kind === 'session' ? (
              <h3 key={`s${en.seq}`} className="heading border-b border-line pb-1 text-lg">
                Session {en.number} {en.started ? '' : '(end)'}
              </h3>
            ) : (
              <article key={en.turn.turnId} className="space-y-2">
                {en.turn.actions.map((a, i) => (
                  <p key={i} className="border-l-2 border-line pl-3 text-sm italic text-muted">
                    {a.who}: {a.text}
                  </p>
                ))}
                {en.turn.narration && (
                  <div className="flex items-start gap-2">
                    <p className="flex-1 whitespace-pre-wrap leading-relaxed">{en.turn.narration.text}</p>
                    <SpeakButton text={en.turn.narration.text} seq={en.turn.narration.seq} />
                  </div>
                )}
              </article>
            ),
          )}
        </div>
      </div>
    </dialog>
  );
}
