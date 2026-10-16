import { type SettingPreset, type StartChoice, startTable } from '@tavern/shared';

/**
 * Where the story opens: roll on the setting's table (default), pick one, or describe your own
 * for the GM to build the opening scene from. Rolls happen on the server.
 */
export function StartPicker({ setting, value, onChange, idPrefix = 'start' }: { setting: SettingPreset | null; value: StartChoice; onChange: (v: StartChoice) => void; idPrefix?: string }) {
  const table = startTable(setting);
  const pickIndex = value.kind === 'pick' ? value.index : 0;
  const options = [
    ['random', 'Surprise me', table.length ? `Rolled from ${table.length} starting locations.` : 'The GM opens with a scene from the setting.'],
    ['pick', 'Choose one', 'Pick from the list.'],
    ['custom', 'Write your own', 'Describe a place; the GM builds the opening scene from it.'],
  ] as const;
  return (
    <fieldset className="space-y-2" data-testid="start-picker">
      <legend className="label">Where does the story begin?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map(([kind, title, text]) => (
          <label key={kind} className={`flex cursor-pointer gap-2 rounded-[var(--t-radius)] border p-2.5 text-sm ${value.kind === kind ? 'border-accent bg-raised' : 'border-line'}`}>
            <input
              type="radio"
              name={`${idPrefix}-kind`}
              checked={value.kind === kind}
              disabled={kind === 'pick' && !table.length}
              onChange={() => onChange(kind === 'random' ? { kind } : kind === 'pick' ? { kind, index: 0 } : { kind, text: value.kind === 'custom' ? value.text : '' })}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold">{title}</span>
              <span className="block text-xs text-muted">{text}</span>
            </span>
          </label>
        ))}
      </div>
      {value.kind === 'pick' && table.length > 0 && (
        <div className="space-y-1">
          <label className="sr-only" htmlFor={`${idPrefix}-pick`}>
            Starting location
          </label>
          <select id={`${idPrefix}-pick`} className="field" value={pickIndex} onChange={(e) => onChange({ kind: 'pick', index: Number(e.target.value) })}>
            {table.map((s, i) => (
              <option key={s.title} value={i}>
                {s.title}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted">{table[pickIndex]?.description}</p>
        </div>
      )}
      {value.kind === 'custom' && (
        <div className="space-y-2">
          <div>
            <label className="label" htmlFor={`${idPrefix}-title`}>
              Name of the place (optional)
            </label>
            <input
              id={`${idPrefix}-title`}
              className="field"
              maxLength={120}
              placeholder="The Lucky Void"
              value={value.title ?? ''}
              onChange={(e) => onChange({ ...value, title: e.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${idPrefix}-text`}>
              Describe the starting location
            </label>
            <textarea
              id={`${idPrefix}-text`}
              className="field min-h-20"
              maxLength={600}
              placeholder="A derelict casino orbiting a dead star. The lights are still on and the tables are still dealing…"
              value={value.text}
              onChange={(e) => onChange({ ...value, text: e.target.value })}
            />
            <p className="text-xs text-muted">{600 - value.text.length} characters left. Add who is there and what is happening if you like.</p>
          </div>
        </div>
      )}
    </fieldset>
  );
}

export const startChoiceReady = (v: StartChoice) => v.kind !== 'custom' || v.text.trim().length > 0;
