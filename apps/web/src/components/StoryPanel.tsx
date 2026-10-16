import { type EventOf, LIMITS } from '@tavern/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { listVoices, speechSupported, useSpeech } from '../lib/speech.ts';
import { type StoryTurn, buildStory } from '../lib/story.ts';
import { playerName, useRoom } from '../lib/store.ts';
import { ApprovalQueue } from './ApprovalQueue.tsx';
import { StoryReader } from './StoryReader.tsx';

type Roll = EventOf<'dice_rolled'>['payload'];

function RollChip({ roll }: { roll: Roll }) {
  const kept = roll.dice.find((d) => !d.dropped)?.value;
  const verdict = roll.success === undefined ? '' : roll.success ? '✓' : '✗';
  const tone = roll.success === undefined ? 'border-line' : roll.success ? 'border-good text-good' : 'border-bad text-bad';
  return (
    <li className={`rounded-full border px-2 py-0.5 text-xs ${tone}`} title={`${roll.notation}: [${roll.dice.map((d) => d.value).join(', ')}]`}>
      {roll.reason ? `${roll.reason}: ` : ''}
      <strong className="tabular-nums">{roll.total}</strong>
      {roll.dc !== undefined && <span className="text-muted"> vs {roll.dc}</span>} {verdict}
      {kept === 20 && roll.dice.length <= 2 && roll.notation.startsWith('1d20') ? ' (nat 20!)' : ''}
    </li>
  );
}

export function SpeakButton({ text, seq }: { text: string; seq: number }) {
  const { speak, stop, speakingSeq } = useSpeech();
  if (!speechSupported) return null;
  const on = speakingSeq === seq;
  return (
    <button
      type="button"
      className="btn shrink-0 px-2 py-0.5 text-xs"
      aria-label={on ? 'Stop reading' : 'Read aloud'}
      title={on ? 'Stop reading' : 'Read aloud'}
      onClick={() => (on ? stop() : speak(text, seq))}
    >
      {on ? '■' : '▶'}
    </button>
  );
}

function Turn({ turn }: { turn: StoryTurn }) {
  return (
    <li className="space-y-2" data-testid="story-turn">
      {turn.actions.length > 0 && (
        <ul className="space-y-0.5 border-l-2 border-line pl-3 text-sm text-muted">
          {turn.actions.map((a, i) => (
            <li key={i}>
              <strong className="text-ink">{a.who}:</strong> {a.text}
            </li>
          ))}
        </ul>
      )}
      {turn.rolls.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Rolls this turn">
          {turn.rolls.map((r, i) => (
            <RollChip key={i} roll={r} />
          ))}
        </ul>
      )}
      {turn.narration && (
        <div className="flex items-start gap-2">
          <p className="flex-1 whitespace-pre-wrap leading-relaxed" data-testid="narration">
            {turn.narration.text}
          </p>
          <SpeakButton text={turn.narration.text} seq={turn.narration.seq} />
        </div>
      )}
    </li>
  );
}

function ReadAloudSettings() {
  const { autoRead, voiceURI, rate, set, stop } = useSpeech();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(listVoices);
  useEffect(() => {
    if (!speechSupported) return;
    const update = () => setVoices(listVoices());
    speechSynthesis.addEventListener('voiceschanged', update);
    return () => speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  if (!speechSupported) return <p className="text-xs text-muted">This browser can't read aloud.</p>;
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={autoRead}
          onChange={(e) => {
            set({ autoRead: e.target.checked });
            if (!e.target.checked) stop();
          }}
        />
        Read new narration aloud automatically
      </label>
      <label className="block">
        <span className="label">Voice</span>
        <select className="field py-1" value={voiceURI ?? ''} onChange={(e) => set({ voiceURI: e.target.value || null })}>
          <option value="">Browser default</option>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">Speed {rate.toFixed(1)}×</span>
        <input type="range" min={0.6} max={1.6} step={0.1} value={rate} onChange={(e) => set({ rate: Number(e.target.value) })} className="w-full" />
      </label>
    </div>
  );
}

function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums">{Math.max(0, Math.ceil((deadline - now) / 1000))}s</span>;
}

function HostTurnControls() {
  const { send, state, settings, turnStatus } = useRoom();
  const [error, setError] = useState<string | null>(null);
  const run = async (body: Parameters<typeof send>[0]) => {
    setError(null);
    const res = await send(body);
    if (!res.ok) setError(res.error);
  };
  const hasTurns = state.turn.number > 0;
  return (
    <div className="space-y-2 rounded-[var(--t-radius)] border border-dashed border-line p-2" data-testid="host-turn-controls">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="label mb-0">Host</span>
        <button type="button" className="btn py-1 text-sm" disabled={!state.turn.pending.length || state.turn.phase === 'resolving'} onClick={() => run({ type: 'resolve_now' })}>
          Resolve now
        </button>
        {turnStatus.status === 'failed' && (
          <button type="button" className="btn btn-primary py-1 text-sm" onClick={() => run({ type: 'retry_turn' })}>
            Retry
          </button>
        )}
        <button type="button" className="btn py-1 text-sm" disabled={!hasTurns || state.turn.phase === 'resolving'} onClick={() => run({ type: 'void_last_turn' })}>
          Rewind last turn
        </button>
        <button type="button" className="btn py-1 text-sm" onClick={() => run({ type: state.session.active ? 'end_session' : 'start_session' })}>
          {state.session.active ? `End session ${state.session.number}` : `Start session ${state.session.number + 1}`}
        </button>
        {settings?.mode === 'group' && (
          <label className="flex items-center gap-1">
            <span className="sr-only">Turn mode</span>
            <select
              className="field py-1 text-sm"
              aria-label="Turn mode"
              value={settings.turnMode}
              onChange={(e) => run({ type: 'set_turn_mode', turnMode: e.target.value as 'round' | 'spotlight' })}
            >
              <option value="round">Round: everyone acts</option>
              <option value="spotlight">Spotlight: one at a time</option>
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ActionComposer({ prefill, onPrefillUsed }: { prefill: string | null; onPrefillUsed: () => void }) {
  const { send, state, settings, creds, turnStatus } = useRoom();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = creds?.playerId;
  const myChar = state.party.find((c) => c.playerId === me);
  const mine = state.turn.pending.find((a) => a.playerId === me);
  const spotlight = settings?.mode === 'group' && settings.turnMode === 'spotlight' ? state.spotlight : null;
  const blockedBySpotlight = !!spotlight && spotlight !== me;
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill !== null) {
      setText(prefill);
      onPrefillUsed();
      ref.current?.focus();
    }
  }, [prefill, onPrefillUsed]);

  async function submit() {
    const t = text.trim();
    if (!t) return;
    setError(null);
    const res = editing !== null ? await send({ type: 'edit_action', actionSeq: editing, text: t }) : await send({ type: 'submit_action', text: t });
    if (res.ok) {
      setText('');
      setEditing(null);
    } else setError(res.error);
  }

  const others = state.turn.pending.filter((a) => a.playerId !== me);
  const status =
    turnStatus.status === 'adjudicating'
      ? 'The GM is deciding what happens…'
      : turnStatus.status === 'narrating'
        ? 'The GM is telling the story…'
        : turnStatus.status === 'failed'
          ? `The GM stumbled: ${turnStatus.error ?? 'unknown error'}. The host can retry.`
          : spotlight
            ? `Spotlight: ${playerName(state, spotlight)}${spotlight === me ? ' (you)' : ''}`
            : turnStatus.status === 'collecting'
              ? null
              : settings?.mode === 'solo'
                ? 'Your move.'
                : 'Everyone writes an action; the GM resolves them together.';

  if (!myChar) return <p className="text-sm text-muted">Create a character to take part.</p>;

  return (
    <div className="space-y-2 border-t border-line pt-3" data-testid="action-composer">
      <p className={`text-sm ${turnStatus.status === 'failed' ? 'text-bad' : 'text-muted'}`} role="status" data-testid="turn-status">
        {status}
        {turnStatus.status === 'collecting' && (
          <>
            Waiting for {state.players.filter((p) => p.active && p.characterId && !state.turn.pending.some((a) => a.playerId === p.id)).map((p) => p.displayName).join(', ') || 'the GM'}
            {turnStatus.deadline ? (
              <>
                {' '}
                · resolves in <Countdown deadline={turnStatus.deadline} />
              </>
            ) : null}
          </>
        )}
      </p>
      {others.length > 0 && (
        <ul className="space-y-0.5 text-sm" aria-label="Other players' actions">
          {others.map((a) => (
            <li key={a.seq} className="text-muted">
              <strong className="text-ink">{state.party.find((c) => c.id === a.characterId)?.name ?? playerName(state, a.playerId)}:</strong> {a.text}
            </li>
          ))}
        </ul>
      )}
      {mine && editing === null ? (
        <div className="flex items-start gap-2 rounded-[var(--t-radius)] bg-raised p-2 text-sm" data-testid="my-pending-action">
          <p className="flex-1">
            <strong>{myChar.name}:</strong> {mine.text}
          </p>
          {state.turn.phase !== 'resolving' && (
            <>
              <button
                type="button"
                className="btn px-2 py-0.5 text-xs"
                onClick={() => {
                  setEditing(mine.seq);
                  setText(mine.text);
                }}
              >
                Edit
              </button>
              <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => send({ type: 'withdraw_action', actionSeq: mine.seq })}>
                Withdraw
              </button>
            </>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="action-input" className="sr-only">
            What does {myChar.name} do?
          </label>
          <textarea
            id="action-input"
            ref={ref}
            className="field min-h-16 flex-1"
            rows={2}
            maxLength={LIMITS.actionLength}
            placeholder={blockedBySpotlight ? `Waiting for ${playerName(state, spotlight)}…` : `What does ${myChar.name} do or say?`}
            disabled={blockedBySpotlight}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex gap-2 sm:flex-col">
            <button type="submit" className="btn btn-primary flex-1" disabled={!text.trim() || blockedBySpotlight}>
              {editing !== null ? 'Save' : 'Act'}
            </button>
            {editing !== null && (
              <button
                type="button"
                className="btn flex-1"
                onClick={() => {
                  setEditing(null);
                  setText('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
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

/** The story: turns, rolls, narration (streamed live), suggestions and the action box. */
export function StoryPanel() {
  const { state, events, streaming, turnStatus, isHost, liveNarrationSeq } = useRoom();
  const autoRead = useSpeech((s) => s.autoRead);
  const speak = useSpeech((s) => s.speak);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [showReader, setShowReader] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const entries = useMemo(() => buildStory(events, state), [events, state]);
  const turns = entries.filter((e) => e.kind === 'turn');
  const recent = entries.slice(-12);
  const lastNarration = [...turns].reverse().find((t) => t.kind === 'turn' && t.turn.narration);
  const suggestions = lastNarration?.kind === 'turn' && state.turn.phase !== 'resolving' ? (lastNarration.turn.narration?.suggestions ?? []) : [];
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [entries.length, streaming?.text.length]);

  // Auto read-aloud: only narration that arrived live, never history on load.
  useEffect(() => {
    if (!autoRead || liveNarrationSeq === null) return;
    const e = events.find((x) => x.seq === liveNarrationSeq);
    if (e?.type === 'narration') speak(e.payload.text, e.seq);
  }, [liveNarrationSeq, autoRead, events, speak]);

  return (
    <section className="panel flex flex-col gap-3 p-5" aria-labelledby="story-h">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="story-h" className="heading flex-1 text-xl">
          The story
        </h2>
        <button type="button" className="btn py-1 text-sm" onClick={() => setShowReader(true)} disabled={turns.length === 0}>
          Story so far
        </button>
        <button type="button" className={`btn py-1 text-sm ${autoRead ? 'btn-primary' : ''}`} aria-expanded={showVoice} onClick={() => setShowVoice((v) => !v)}>
          🔊 Read aloud
        </button>
      </div>
      {showVoice && (
        <div className="rounded-[var(--t-radius)] border border-line p-3">
          <ReadAloudSettings />
        </div>
      )}
      {isHost && <HostTurnControls />}
      {isHost && <ApprovalQueue />}

      {turns.length === 0 && !streaming && (
        <div className="space-y-2">
          <p className="text-muted">{state.setting?.tone}</p>
          <p className="text-sm text-muted">Describe what your character does to begin, or start from one of these:</p>
          <ul className="space-y-1.5">
            {state.setting?.openingHooks.map((h) => (
              <li key={h}>
                <button type="button" className="w-full rounded-[var(--t-radius)] border border-line p-2 text-left text-sm hover:border-accent" onClick={() => setPrefill(`Let's begin: ${h}`)}>
                  {h}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {turns.length > 0 && (
        <ol className="max-h-[60vh] space-y-5 overflow-y-auto pr-1 lg:max-h-[55vh]" aria-live="polite" data-testid="story-feed">
          {recent.map((en) =>
            en.kind === 'session' ? (
              <li key={`s${en.seq}`} className="heading text-center text-sm text-muted">
                — Session {en.number} {en.started ? 'begins' : 'ends'} —
              </li>
            ) : (
              <Turn key={en.turn.turnId} turn={en.turn} />
            ),
          )}
          {streaming && turnStatus.status === 'narrating' && (
            <li>
              <p className="whitespace-pre-wrap leading-relaxed" data-testid="narration-streaming">
                {streaming.text}
                <span className="animate-pulse">▍</span>
              </p>
            </li>
          )}
          <div ref={endRef} />
        </ol>
      )}

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested actions">
          {suggestions.map((s) => (
            <button key={s} type="button" className="rounded-full border border-accent px-3 py-1 text-sm hover:bg-raised" onClick={() => setPrefill(s)} data-testid="suggestion">
              {s}
            </button>
          ))}
        </div>
      )}

      <ActionComposer prefill={prefill} onPrefillUsed={() => setPrefill(null)} />
      {showReader && <StoryReader entries={entries} onClose={() => setShowReader(false)} />}
    </section>
  );
}
