import { join } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  webDist: string | null;
  rulesLookup: boolean;
  anthropic: { apiKey: string; turnModel: string; summaryModel: string } | null;
  gemini: { apiKey: string; imageModel: string; ttsModel: string; ttsVoice: string } | null;
}

/** Server-only configuration. Secrets are read here and never sent to clients. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? './data';
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const geminiKey = env.GEMINI_API_KEY?.trim();
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbFile: env.DB_FILE ?? join(dataDir, 'tavern.db'),
    webDist: env.WEB_DIST ?? new URL('../../web/dist/', import.meta.url).pathname,
    rulesLookup: (env.GM_RULES_LOOKUP ?? 'on').toLowerCase() !== 'off',
    anthropic: apiKey
      ? {
          apiKey,
          turnModel: env.GM_TURN_MODEL || 'claude-sonnet-5-5',
          summaryModel: env.GM_SUMMARY_MODEL || 'claude-haiku-5-5',
        }
      : null,
    gemini: geminiKey
      ? {
          apiKey: geminiKey,
          imageModel: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
          ttsModel: env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
          ttsVoice: env.GEMINI_TTS_VOICE || 'Charon',
        }
      : null,
  };
}
