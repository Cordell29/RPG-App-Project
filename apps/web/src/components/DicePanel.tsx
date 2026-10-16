import { type EventOf, type RollMode, DiceError, formatDice, parseDice } from '@tavern/shared';
import { useMemo, useState } from 'react';
import { playerName, useRoom } from '../lib/store.ts';
import { Die } from './Die.tsx';

const QUICK = [4, 6, 8, 10, 12, 20, 100] as const;

function Stepper(props: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; signed?: boolean }) {
  const { label, value, min, max, onChange, signed } = props;
  const text = signed && value > 0 ? `+${value}` : String(value);
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center gap-1">
        <button type="button" className="btn px-2.5 py-1" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          −
        </button>
        <span className="w-10 text-center font-semibold tabular-nums" aria-live="polite">
          {text}
        </span>
        <button type="button" className="btn px-2.5 py-1" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  );
}

export function DicePanel() {
  const send = useRoom((s) => s.send);
  const events = useRoom((s) => s.events);
  const state = useRoom((s) => s.state);
  const liveRoll = useRoom((s) => s.liveRoll);
  const [count, setCount] = useState(1);
  const [modifier, setModifier] = useState(0);
  const [mode, setMode] = useState<RollMode>('normal');
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rolls = useMemo(
    () => events.filter((e): e is EventOf<'dice_rolled'> => e.type === 'dice_rolled').slice(-30).reverse(),
    [events],
  );
  const latest = rolls[0] ?? null;
  const featured = latest?.payload.dice.find((d) => !d.dropped) ?? latest?.payload.dice[0];

  const customError = useMemo(() => {
    if (!custom.trim()) return null;
    try {
      parseDice(custom);
      return null;
    } catch (e) {
      return e instanceof DiceError ? e.message : 'Invalid notation.';
    }
  }, [custom]);

  async function roll(notation: string) {
    setError(null);
    setBusy(true);
    const res = await send({ type: 'roll_dice', notation, ...(reason.trim() ? { reason: reason.trim() } : {}) });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else setReason('');
  }

  function quickNotation(sides: number) {
    const advOk = sides === 20 && count === 1;
    return formatDice({ groups: [{ count, sides }], modifier, mode: advOk ? mode : 'normal' });
  }

  return (
    <section className="panel p-4" aria-labelledby="dice-heading">
      <div className="flex items-start gap-4">
        <div className="shrink-0" aria-live="polite">
          <Die
            sides={featured?.sides ?? 20}
            value={featured?.value ?? null}
            rollKey={liveRoll && liveRoll.seq === latest?.seq ? liveRoll.seq : null}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="dice-heading" className="heading text-lg">
            Dice
          </h2>
          {latest ? (
            <p className="text-sm text-muted" data-testid="latest-roll">
              <strong className="text-ink">{playerName(state, latest.actorId)}</strong> rolled {latest.payload.notation} →{' '}
              <strong className="text-2xl text-ink tabular-nums">{latest.payload.total}</strong>
            </p>
          ) : (
            <p className="text-sm text-muted">No rolls yet. Every roll happens on the server and everyone sees it.</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <Stepper label="Dice" value={count} min={1} max={20} onChange={setCount} />
        <Stepper label="Modifier" value={modifier} min={-20} max={20} onChange={setModifier} signed />
        <div>
          <span className="label">d20 mode</span>
          <div className="flex overflow-hidden rounded-[var(--t-radius)] border border-line" role="radiogroup" aria-label="d20 mode">
            {(['disadvantage', 'normal', 'advantage'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={count !== 1}
                title={count !== 1 ? 'Advantage needs a single d20' : undefined}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 text-sm font-semibold disabled:opacity-40 ${mode === m ? 'bg-accent text-accent-ink' : 'bg-raised'}`}
              >
                {m === 'normal' ? 'Normal' : m === 'advantage' ? 'Adv' : 'Dis'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-7">
        {QUICK.map((sides) => (
          <button key={sides} type="button" className="btn flex-col gap-0 py-2" disabled={busy} onClick={() => void roll(quickNotation(sides))}>
            <span className="heading text-base">d{sides}</span>
            <span className="text-xs text-muted">{quickNotation(sides)}</span>
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!customError && custom.trim()) void roll(custom.trim()).then(() => setCustom(''));
        }}
      >
        <div className="min-w-40 flex-[2]">
          <label className="label" htmlFor="custom-dice">
            Custom roll
          </label>
          <input
            id="custom-dice"
            className="field"
            placeholder="e.g. 3d6+2, 2d8+1d4-1, 1d20+5 adv"
            value={custom}
            maxLength={40}
            onChange={(e) => setCustom(e.target.value)}
            aria-invalid={!!customError}
            aria-describedby="dice-error"
          />
        </div>
        <div className="min-w-32 flex-1">
          <label className="label" htmlFor="dice-reason">
            For (optional)
          </label>
          <input id="dice-reason" className="field" placeholder="stealth check" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex items-end">
          <button type="submit" className="btn btn-primary" disabled={busy || !custom.trim() || !!customError}>
            Roll
          </button>
        </div>
      </form>
      <p id="dice-error" className="mt-1 min-h-5 text-sm text-bad" role="alert">
        {customError ?? error ?? ''}
      </p>

      {rolls.length > 0 && (
        <ol className="mt-2 max-h-56 space-y-1 overflow-y-auto border-t border-line pt-2 text-sm" aria-label="Roll history" data-testid="roll-history">
          {rolls.map((r) => (
            <li key={r.seq} className="flex flex-wrap items-baseline gap-x-2" data-testid="roll-entry">
              <span className="font-semibold">{playerName(state, r.actorId)}</span>
              <span className="text-muted">{r.payload.notation}</span>
              <span className="tabular-nums text-muted">
                [
                {r.payload.dice.map((d, i) => (
                  <span key={i} className={d.dropped ? 'line-through opacity-50' : ''}>
                    {i > 0 ? ', ' : ''}
                    {d.value}
                  </span>
                ))}
                {r.payload.modifier ? ` ${r.payload.modifier > 0 ? '+' : '−'} ${Math.abs(r.payload.modifier)}` : ''}]
              </span>
              <span className="ml-auto font-bold tabular-nums">= {r.payload.total}</span>
              {r.payload.reason && <span className="w-full text-xs italic text-muted">for {r.payload.reason}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
