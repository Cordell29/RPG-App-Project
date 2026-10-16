import { type SettingPreset, STAT_KEYS, SettingPresetSchema, THEMES } from '@tavern/shared';
import { setTheme } from '../lib/router.ts';

const STAT_HINTS: Record<(typeof STAT_KEYS)[number], string> = {
  str: 'physical power',
  dex: 'agility',
  con: 'toughness',
  int: 'reasoning',
  wis: 'perception',
  cha: 'personality',
};

const THEME_LABELS = { parchment: 'Parchment', neon: 'Neon', neutral: 'Neutral' } as const;

export function validateSetting(s: SettingPreset): string | null {
  const r = SettingPresetSchema.safeParse(s);
  if (r.success) return null;
  const issue = r.error.issues[0]!;
  return `${issue.path.join(' › ') || 'Setting'}: ${issue.message}`;
}

/** Editable form for a SettingPreset (the campaign bible). Rules stay fixed; only words change. */
export function SettingEditor({ value, onChange }: { value: SettingPreset; onChange: (s: SettingPreset) => void }) {
  const set = <K extends keyof SettingPreset>(key: K, v: SettingPreset[K]) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="s-name">
            Setting name
          </label>
          <input id="s-name" className="field" value={value.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="s-currency">
            Currency
          </label>
          <input id="s-currency" className="field" value={value.currencyName} maxLength={20} onChange={(e) => set('currencyName', e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="s-tone">
          Tone
        </label>
        <input id="s-tone" className="field" value={value.tone} maxLength={300} onChange={(e) => set('tone', e.target.value)} />
      </div>

      <fieldset>
        <legend className="label">Look</legend>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={value.theme === t}
              className={`btn ${value.theme === t ? 'btn-primary' : ''}`}
              onClick={() => {
                set('theme', t);
                setTheme(t);
              }}
            >
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="label">Stat names</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {STAT_KEYS.map((k) => (
            <div key={k}>
              <label className="text-xs text-muted" htmlFor={`s-stat-${k}`}>
                {STAT_HINTS[k]}
              </label>
              <input
                id={`s-stat-${k}`}
                className="field"
                value={value.statLabels[k]}
                maxLength={30}
                onChange={(e) => set('statLabels', { ...value.statLabels, [k]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="label">Roles (4–8)</legend>
        <div className="space-y-3">
          {value.roles.map((role, i) => (
            <div key={i} className="rounded-[var(--t-radius)] border border-line bg-raised p-3">
              <div className="flex gap-2">
                <input
                  aria-label={`Role ${i + 1} name`}
                  className="field font-semibold"
                  value={role.name}
                  maxLength={40}
                  onChange={(e) => set('roles', value.roles.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                />
                <button
                  type="button"
                  className="btn"
                  aria-label={`Remove role ${role.name || i + 1}`}
                  disabled={value.roles.length <= 4}
                  onClick={() => set('roles', value.roles.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
              <textarea
                aria-label={`Role ${i + 1} summary`}
                className="field mt-2"
                rows={2}
                value={role.summary}
                maxLength={300}
                onChange={(e) => set('roles', value.roles.map((r, j) => (j === i ? { ...r, summary: e.target.value } : r)))}
              />
              <input
                aria-label={`Role ${i + 1} starting kit, comma separated`}
                className="field mt-2 text-sm"
                placeholder="Starting kit, comma separated"
                value={role.startingKit.join(', ')}
                onChange={(e) =>
                  set(
                    'roles',
                    value.roles.map((r, j) =>
                      j === i ? { ...r, startingKit: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12) } : r,
                    ),
                  )
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="btn"
            disabled={value.roles.length >= 8}
            onClick={() =>
              set('roles', [
                ...value.roles,
                { name: 'New role', summary: 'Describe this role.', startingKit: [], skillChoices: [], skillCount: 2, saves: [], abilities: [], spellSlots: [] },
              ])
            }
          >
            + Add role
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend className="label">Opening hooks (3)</legend>
        <div className="space-y-2">
          {value.openingHooks.map((hook, i) => (
            <textarea
              key={i}
              aria-label={`Opening hook ${i + 1}`}
              className="field"
              rows={2}
              value={hook}
              maxLength={500}
              onChange={(e) => set('openingHooks', value.openingHooks.map((h, j) => (j === i ? e.target.value : h)))}
            />
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor="s-art">
          Art style
        </label>
        <textarea id="s-art" className="field" rows={3} value={value.artStyle} maxLength={1000} onChange={(e) => set('artStyle', e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="s-notes">
          Topics to avoid or soften (optional)
        </label>
        <textarea
          id="s-notes"
          className="field"
          rows={2}
          value={value.contentNotes ?? ''}
          maxLength={1000}
          onChange={(e) => {
            const { contentNotes: _drop, ...rest } = value;
            onChange(e.target.value ? { ...rest, contentNotes: e.target.value } : rest);
          }}
        />
      </div>
    </div>
  );
}
