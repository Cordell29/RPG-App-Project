import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './id.ts';

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('works on plain http (no crypto.randomUUID), producing unique v4-shaped ids', () => {
    vi.stubGlobal('isSecureContext', false);
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
