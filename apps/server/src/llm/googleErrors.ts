/**
 * Plain-English explanations for Google API failures, so the host sees what to fix
 * instead of raw JSON. Never includes the key itself.
 */
export function explainGoogleError(err: unknown): string | null {
  const e = err as { status?: number; message?: string };
  const msg = String(e?.message ?? '');
  const status = typeof e?.status === 'number' ? e.status : Number(/\b(4\d\d|5\d\d)\b/.exec(msg)?.[1] ?? NaN);
  if (/ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(msg)) {
    return 'Google did not accept this Gemini key (ACCESS_TOKEN_TYPE_UNSUPPORTED). Check the whole key was copied into GEMINI_API_KEY in .env, with nothing missing. If it is complete, create a new key in a new project at aistudio.google.com/apikey, then run "pnpm check:keys".';
  }
  if (/API key not valid|API_KEY_INVALID/i.test(msg) || status === 401) {
    return 'Google rejected the Gemini API key. Check GEMINI_API_KEY in your .env file: paste the whole key from aistudio.google.com/apikey right after the = (no quotes or spaces), then restart Tavern. Run "pnpm check:keys" to test it.';
  }
  if (status === 403) {
    return 'Google refused access with this key (403). Make the key in aistudio.google.com/apikey, or enable the "Generative Language API" for its Google Cloud project, then restart Tavern.';
  }
  if (status === 404) return 'Google does not recognise the model name. Check GEMINI_TEXT_MODEL / GEMINI_IMAGE_MODEL in .env ("pnpm check:keys" lists the models your key can use).';
  if (status === 429) return 'Google says the quota for this key is used up or rate-limited. Wait a minute, or check billing and limits in Google AI Studio.';
  return null;
}
