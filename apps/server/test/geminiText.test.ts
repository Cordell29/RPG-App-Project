import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiTextProvider, toSteps } from '../src/llm/geminiText.ts';

/** A fake Interactions client that records requests and replays scripted interactions. */
function fake(replies: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    interactions: {
      create: async (params: Record<string, unknown>) => {
        requests.push(structuredClone(params));
        const r = replies.shift();
        if (params.stream) {
          return (async function* () {
            yield* r as unknown[];
          })();
        }
        return r;
      },
    },
  };
  return { client: client as never, requests };
}

const config = { apiKey: 'test', turnModel: 'models/gemini-4-argon', summaryModel: 'models/gemini-4-argon' };

describe('Gemini (Interactions API) provider', () => {
  it('runs a tool loop: function calls out, function results back, its own steps echoed verbatim', async () => {
    const thought = { type: 'thought', signature: 'sig-123' };
    const call = { type: 'function_call', id: 'call-1', name: 'roll_check', arguments: { stat: 'dex', dc: 12 } };
    const { client, requests } = fake([
      { id: 'i1', status: 'completed', steps: [{ type: 'user_input', content: [{ type: 'text', text: 'go' }] }, thought, call], usage: { total_input_tokens: 1000, total_cached_tokens: 200, total_output_tokens: 50, total_thought_tokens: 30 } },
      { id: 'i2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Done.' }] }], usage: { total_input_tokens: 1200, total_output_tokens: 10 } },
    ]);
    const gm = new GeminiTextProvider(config, client);
    const tools = [{ name: 'roll_check', description: 'Roll', input_schema: { $schema: 'x', type: 'object', properties: {} } }];
    const base = { purpose: 'gm_adjudicate' as const, tier: 'turn' as const, system: [{ text: 'RULES', cache: true }, { text: 'BIBLE', cache: true }], tools, webSearch: { allowedDomains: ['open5e.com'], maxUses: 2 } };

    const r1 = await gm.chat({ ...base, messages: [{ role: 'user', content: 'go' }] });
    expect(r1.toolUses).toEqual([{ id: 'call-1', name: 'roll_check', input: { stat: 'dex', dc: 12 } }]);
    expect(r1.stopReason).toBe('tool_use');
    expect(r1.usage).toMatchObject({ inputTokens: 800, cacheReadTokens: 200, outputTokens: 80, model: 'models/gemini-4-argon' });
    const req1 = requests[0]!;
    expect(req1).toMatchObject({ model: 'models/gemini-4-argon', store: false, system_instruction: expect.stringMatching(/^RULES\n\nBIBLE[\s\S]*open5e\.com/) });
    expect(req1.tools).toEqual([{ type: 'function', name: 'roll_check', description: 'Roll', parameters: { type: 'object', properties: {} } }, { type: 'google_search' }]);
    expect(req1.generation_config).toMatchObject({ tool_choice: 'auto', thinking_level: 'medium' });

    const r2 = await gm.chat({
      ...base,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: r1.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'rolled 15: success' }] },
      ],
    });
    expect(r2.text).toBe('Done.');
    expect(requests[1]!.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'go' }] },
      thought,
      call,
      { type: 'function_result', call_id: 'call-1', result: 'rolled 15: success' },
    ]);
  });

  it('streams narration text deltas', async () => {
    const { client } = fake([
      [
        { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'The door ' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'creaks.' } },
        { event_type: 'interaction.completed', interaction: { id: 'x', status: 'completed', usage: { total_input_tokens: 10, total_output_tokens: 4 } } },
      ],
    ]);
    const chunks: string[] = [];
    const res = await new GeminiTextProvider(config, client).streamText({ purpose: 'gm_narrate', tier: 'turn', system: [{ text: 's', cache: true }], messages: [{ role: 'user', content: 'narrate' }], effort: 'low' }, (d) => chunks.push(d));
    expect(chunks).toEqual(['The door ', 'creaks.']);
    expect(res.text).toBe('The door creaks.');
    expect(res.usage.outputTokens).toBe(4);
  });

  it('structured output comes back through one required function call and is validated', async () => {
    const { client, requests } = fake([
      { id: 'a', status: 'completed', steps: [{ type: 'function_call', id: 'c', name: 'submit_result', arguments: { name: 'Ayla', level: 3 } }] },
      { id: 'b', status: 'completed', steps: [{ type: 'function_call', id: 'c', name: 'submit_result', arguments: { name: 7 } }] },
    ]);
    const gm = new GeminiTextProvider(config, client);
    const schema = z.object({ name: z.string(), level: z.number() });
    const { data } = await gm.structured({ purpose: 'character_draft', tier: 'summary', system: 'Draft.', prompt: 'a fighter', schema });
    expect(data).toEqual({ name: 'Ayla', level: 3 });
    expect(requests[0]!.generation_config).toMatchObject({ tool_choice: 'any' });
    await expect(gm.structured({ purpose: 'character_draft', tier: 'summary', system: 'Draft.', prompt: 'x', schema })).rejects.toThrow(/did not match the schema/);
  });

  it('a failed interaction becomes a readable error', async () => {
    const { client } = fake([{ id: 'f', status: 'failed', steps: [] }]);
    await expect(new GeminiTextProvider(config, client).chat({ purpose: 'gm_adjudicate', tier: 'turn', system: [], messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/could not finish \(failed\)/);
  });

  it('converts plain assistant text and error results', () => {
    expect(toSteps([{ role: 'assistant', content: 'hi' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'nope', is_error: true }] }])).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: 'hi' }] },
      { type: 'function_result', call_id: 'z', result: 'nope', is_error: true },
    ]);
  });
});
