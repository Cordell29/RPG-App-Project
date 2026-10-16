import { mockCharacterDraft } from './characterDraft.ts';
import { MockLLMProvider, type MockRequest } from './mock.ts';
import type { ChatRequest } from './provider.ts';
import { mockSettingDraft } from './settingDraft.ts';

const strip = (prompt: string) => prompt.replace(/<\/?[a-z_]+>/g, '');

const SKILL_WORDS: [RegExp, string, string][] = [
  [/sneak|hide|stealth|creep/i, 'stealth', 'dex'],
  [/search|investigat|examine|inspect/i, 'investigation', 'int'],
  [/look|listen|watch|spot|scan/i, 'perception', 'wis'],
  [/persuad|convince|talk|charm|negotiat/i, 'persuasion', 'cha'],
  [/lie|bluff|deceiv/i, 'deception', 'cha'],
  [/climb|jump|lift|push|force|swim/i, 'athletics', 'str'],
  [/heal|bandage|treat/i, 'medicine', 'wis'],
];

/**
 * A tiny deterministic "GM" for development without an API key: one skill check per
 * action (DC 12), then a templated narration of what the engine accepted.
 */
function devGm(req: ChatRequest) {
  const last = req.messages.at(-1);
  if (req.purpose === 'gm_narrate') {
    const prompt = typeof last?.content === 'string' ? last.content : '';
    const happened = /<what_happened>([\s\S]*?)<\/what_happened>/.exec(prompt)?.[1] ?? '';
    const rolls = happened.split('\n').filter((l) => l.startsWith('- ') && /check|attack|contest/i.test(l));
    const body = rolls.length
      ? rolls.map((r) => r.slice(2).replace(/: rolled .*→ /, ' — ')).join('. ') + '.'
      : 'The moment passes quietly.';
    return `(Offline GM: add an Anthropic API key for real narration.)\n\n${body} The world waits for your next move.\n\nSUGGESTIONS:\n- Look around carefully\n- Talk to whoever is nearby\n- Press on`;
  }
  if (Array.isArray(last?.content)) return { tools: [{ name: 'end_adjudication', input: { summary: 'Resolved.' } }] };
  const prompt = typeof last?.content === 'string' ? last.content : '';
  const tools = [...prompt.matchAll(/<player_action [^>]*characterId="([^"]*)">([^<]*)<\/player_action>/g)]
    .filter(([, id]) => id)
    .map(([, characterId, text]) => {
      const [, skill, stat] = SKILL_WORDS.find(([re]) => re.test(text!)) ?? [null, 'perception', 'wis'];
      return { name: 'request_check', input: { characterId, stat, skill, dc: 12, reason: text!.slice(0, 60) } };
    });
  return { tools: [...tools, { name: 'end_adjudication', input: { summary: 'Checks resolved.' } }] };
}

/** Mock provider that answers every purpose plausibly; used when no API key is set and in tests. */
export function devMockProvider(): MockLLMProvider {
  return new MockLLMProvider((req: MockRequest) => {
    switch (req.purpose) {
      case 'setting_draft':
        return mockSettingDraft(strip((req as { prompt: string }).prompt));
      case 'character_draft':
        return mockCharacterDraft(strip((req as { prompt: string }).prompt));
      case 'ability_draft': {
        const msgs = (req as ChatRequest).messages;
        const idea = strip(String(msgs[0]?.content ?? '')).trim();
        return {
          tools: [
            {
              name: 'submit_ability',
              input: { name: 'Workshopped Ability', description: idea.slice(0, 300), uses: 1, recharge: 'long_rest', basis: 'Offline draft: no rules comparison (add an API key)' },
            },
          ],
        };
      }
      case 'gm_adjudicate':
      case 'gm_narrate':
        return devGm(req as ChatRequest);
    }
  });
}
