// pnpm check:keys: tests the API keys in .env with tiny, nearly free calls and explains
// any problem in plain English. Never prints the keys.
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { loadConfig } from '../src/config.ts';
import { explainGoogleError } from '../src/llm/googleErrors.ts';

const ok = (s: string) => console.log(`  ✅ ${s}`);
const bad = (s: string) => console.log(`  ❌ ${s}`);
const note = (s: string) => console.log(`  ·  ${s}`);

/** Spot common paste mistakes without revealing the key. */
function shape(name: string, raw: string | undefined, prefixes: string[]) {
  if (!raw) return bad(`${name} is empty or missing in .env`);
  if (/^\s|\s$/.test(raw)) bad(`${name} has spaces before or after it; remove them`);
  if (/^["']|["']$/.test(raw.trim())) bad(`${name} is wrapped in quote marks; remove them`);
  const key = raw.trim().replace(/^["']|["']$/g, '');
  if (!prefixes.some((p) => key.startsWith(p))) bad(`${name} should start with ${prefixes.map((p) => `"${p}"`).join(' or ')}; check you copied the right thing`);
  note(`${name}: ${raw.trim().length} characters, starts with "${raw.trim().slice(0, 4)}…"`);
}

const config = loadConfig();
console.log('\nTavern key check\n');

console.log('Gemini (GEMINI_API_KEY)');
// Google now issues "AQ." keys from AI Studio; older keys start with "AIza".
shape('GEMINI_API_KEY', process.env.GEMINI_API_KEY, ['AQ.', 'AIza']);
if (config.gemini) {
  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  try {
    const names = new Set<string>();
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const m of pager) if (m.name) names.add(m.name);
    ok(`Google accepted the key (${names.size} models available)`);
    for (const [label, model] of [
      ['GM text', config.gemini.textModel],
      ['images', config.gemini.imageModel],
      ['voice', config.gemini.ttsModel],
    ] as const) {
      const full = model.startsWith('models/') ? model : `models/${model}`;
      if (names.has(full)) ok(`${label} model "${model}" is available`);
      else bad(`${label} model "${model}" is NOT in your key's model list; pick one of the models below and set it in .env`);
    }
    if (!/flash/i.test(config.gemini.textModel)) {
      note(`"${config.gemini.textModel}" is not a Flash model. On a FREE key only Flash models work: set GEMINI_TEXT_MODEL=models/gemini-flash-latest`);
    }
    if (config.images) note('IMAGES is on. Pictures need a paid (billing-enabled) Gemini key; set IMAGES=off on a free key.');
    const textish = [...names].filter((n) => /gemini/.test(n) && !/embedding|image|tts|audio|live/.test(n)).slice(0, 12);
    note(`text models your key can use: ${textish.join(', ') || 'none'}`);
    try {
      const r = (await ai.interactions.create({ model: config.gemini.textModel, input: 'Reply with the single word OK.', store: false } as never)) as { status?: string };
      if (r.status === 'completed') ok(`the GM model answered (Interactions API)`);
      else bad(`the GM model replied with status "${r.status}"`);
    } catch (err) {
      bad(`GM test call failed: ${explainGoogleError(err) ?? String((err as Error).message).slice(0, 300)}`);
    }
  } catch (err) {
    bad(explainGoogleError(err) ?? String((err as Error).message).slice(0, 300));
    const raw = String((err as Error).message ?? '');
    const reason = /"reason"\s*:\s*"([A-Z_]+)"/.exec(raw)?.[1];
    if (reason) note(`Google's reason code: ${reason}`);
  }
  for (const v of ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_ACCESS_TOKEN', 'GOOGLE_CLOUD_PROJECT']) {
    if (process.env[v]) bad(`${v} is set in your environment; it can make Google treat the key as a different kind of login. Remove it.`);
  }
}

console.log('\nClaude (ANTHROPIC_API_KEY)');
if (!process.env.ANTHROPIC_API_KEY?.trim()) note('not set (fine if you only use Gemini)');
else {
  shape('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY, ['sk-ant-']);
  try {
    await new Anthropic({ apiKey: config.anthropic!.apiKey }).models.list({ limit: 1 });
    ok('Anthropic accepted the key');
  } catch (err) {
    const status = (err as { status?: number }).status;
    bad(status === 401 ? 'Anthropic rejected the key. Make a new one at console.anthropic.com and paste it into .env.' : `Anthropic error: ${String((err as Error).message).slice(0, 300)}`);
  }
}
console.log(`\nThe GM will use: ${config.llmProvider === 'auto' ? (config.anthropic ? 'Claude' : config.gemini ? 'Gemini' : 'the offline stand-in') : config.llmProvider}\n`);
