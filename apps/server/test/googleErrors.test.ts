import { describe, expect, it } from 'vitest';
import { explainGoogleError } from '../src/llm/googleErrors.ts';

describe('explainGoogleError', () => {
  it('turns Google failures into plain instructions, never echoing a key', () => {
    expect(explainGoogleError({ status: 401, message: '401 API error occurred: {"httpMeta":{}}' })).toMatch(/rejected the Gemini API key[\s\S]*pnpm check:keys/);
    expect(explainGoogleError({ status: 400, message: 'API key not valid. Please pass a valid API key.' })).toMatch(/rejected the Gemini API key/);
    expect(explainGoogleError({ status: 403, message: 'PERMISSION_DENIED' })).toMatch(/Generative Language API/);
    expect(explainGoogleError({ status: 404, message: 'model not found' })).toMatch(/model name/);
    expect(explainGoogleError({ status: 429 })).toMatch(/quota/);
    expect(explainGoogleError({ status: 500, message: 'boom' })).toBeNull();
  });
});
