import { mockCharacterDraft } from './characterDraft.ts';
import { MockLLMProvider } from './mock.ts';
import { mockSettingDraft } from './settingDraft.ts';

const strip = (prompt: string) => prompt.replace(/<\/?[a-z_]+>/g, '');

/** Mock provider that answers every purpose plausibly; used when no API key is set and in tests. */
export function devMockProvider(): MockLLMProvider {
  return new MockLLMProvider((req) => {
    switch (req.purpose) {
      case 'setting_draft':
        return mockSettingDraft(strip(req.prompt));
      case 'character_draft':
        return mockCharacterDraft(strip(req.prompt));
    }
  });
}
