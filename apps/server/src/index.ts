import { mkdirSync } from 'node:fs';
import { buildApp } from './app.ts';
import { NightlyBackups } from './backup/nightly.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/connection.ts';
import { AnthropicProvider } from './llm/anthropic.ts';
import { GeminiTextProvider } from './llm/geminiText.ts';
import { HTTP_LIMITS } from './limits.ts';
import { devMockProvider } from './llm/devMock.ts';
import { GeminiImageProvider, GeminiTtsProvider } from './media/gemini.ts';
import { MockImageProvider, MockTtsProvider } from './media/mock.ts';
import type { LLMProvider } from './llm/provider.ts';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
// openDb runs migrations and throws on failure, so a bad migration stops startup here.
const db = openDb(config.dbFile);

const g = config.gemini;
function pickLlm(): LLMProvider {
  const gemini = () => new GeminiTextProvider({ apiKey: g!.apiKey, turnModel: g!.textModel, summaryModel: g!.textSummaryModel });
  if (config.llmProvider === 'anthropic' && !config.anthropic) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
  if (config.llmProvider === 'gemini' && !g) throw new Error('LLM_PROVIDER=gemini but GEMINI_API_KEY is not set.');
  if (config.llmProvider === 'gemini') return gemini();
  if (config.anthropic) return new AnthropicProvider(config.anthropic);
  if (g) return gemini();
  return devMockProvider();
}
const llm = pickLlm();

const images = g ? new GeminiImageProvider({ apiKey: g.apiKey, model: g.imageModel }) : new MockImageProvider();
const tts = g ? new GeminiTtsProvider({ apiKey: g.apiKey, model: g.ttsModel, voice: g.ttsVoice }) : new MockTtsProvider();

const { app, commands } = await buildApp({
  db,
  llm,
  images,
  tts,
  dataDir: config.dataDir,
  webDist: config.webDist,
  logger: true,
  rulesLookup: config.rulesLookup,
  spendCaps: config.spendCaps,
  tunnel: { ...config.tunnel, log: (msg, err) => (err ? console.error(msg, err) : console.log(`[tavern] ${msg}`)) },
  ...(config.rateLimits ? { httpLimits: HTTP_LIMITS } : { commandsPerMinute: 100_000, turnsPerMinute: 100_000 }),
});
commands.pruneLog();
setInterval(() => commands.pruneLog(), 60 * 60 * 1000).unref();

const backups = new NightlyBackups({
  db,
  dir: config.backupDir,
  keepDays: config.backupKeepDays,
  log: (msg, err) => (err ? app.log.error(err, msg) : app.log.info(msg)),
});
backups.start();

await app.listen({ port: config.port, host: config.host });
app.log.info(`Tavern listening on ${config.port} (LLM: ${llm.name}, images: ${images.name})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    backups.stop();
    void app.close().then(() => {
      db.$client.close();
      process.exit(0);
    });
  });
}
