import { join } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  backupDir: string;
  backupKeepDays: number;
  webDist: string | null;
  rulesLookup: boolean;
  anthropic: { apiKey: string; turnModel: string; summaryModel: string } | null;
  gemini: { apiKey: string; imageModel: string; ttsModel: string; ttsVoice: string; textModel: string; textSummaryModel: string } | null;
  /** Which AI runs the GM: 'anthropic', 'gemini', or 'auto' (Claude if its key is set, else Gemini, else offline mock). */
  llmProvider: 'anthropic' | 'gemini' | 'auto';
  spendCaps: { roomUsd: number; globalUsd: number };
  /** Per-IP and per-player rate limits (turn off only for local testing). */
  rateLimits: boolean;
  tunnel: { publicUrl: string | null; metricsUrl: string | null; webhookUrl: string | null };
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

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
    backupDir: env.BACKUP_DIR ?? join(dataDir, 'backups'),
    backupKeepDays: Math.max(1, Number(env.BACKUP_KEEP_DAYS ?? 14) || 14),
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
          textModel: env.GEMINI_TEXT_MODEL || 'models/gemini-4-argon',
          textSummaryModel: env.GEMINI_SUMMARY_MODEL || env.GEMINI_TEXT_MODEL || 'models/gemini-4-argon',
        }
      : null,
    llmProvider: (['anthropic', 'gemini'] as const).find((p) => p === env.LLM_PROVIDER?.trim().toLowerCase()) ?? 'auto',
    spendCaps: { roomUsd: num(env.SPEND_CAP_ROOM_USD, 5), globalUsd: num(env.SPEND_CAP_GLOBAL_USD, 20) },
    rateLimits: (env.RATE_LIMITS ?? 'on').toLowerCase() !== 'off',
    tunnel: {
      publicUrl: env.PUBLIC_URL?.trim() || null,
      metricsUrl: env.TUNNEL_METRICS_URL?.trim() || null,
      webhookUrl: env.SHARE_WEBHOOK_URL?.trim() || null,
    },
  };
}
