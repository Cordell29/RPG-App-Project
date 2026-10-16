import { mkdirSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/connection.ts';
import { AnthropicProvider } from './llm/anthropic.ts';
import { devMockProvider } from './llm/devMock.ts';
import type { LLMProvider } from './llm/provider.ts';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
// openDb runs migrations and throws on failure, so a bad migration stops startup here.
const db = openDb(config.dbFile);

const llm: LLMProvider = config.anthropic ? new AnthropicProvider(config.anthropic) : devMockProvider();

const { app, commands } = await buildApp({ db, llm, webDist: config.webDist, logger: true, rulesLookup: config.rulesLookup });
commands.pruneLog();
setInterval(() => commands.pruneLog(), 60 * 60 * 1000).unref();

await app.listen({ port: config.port, host: config.host });
app.log.info(`Tavern listening on ${config.port} (LLM: ${llm.name})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      db.$client.close();
      process.exit(0);
    });
  });
}
