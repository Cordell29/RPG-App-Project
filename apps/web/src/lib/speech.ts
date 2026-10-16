import { create } from 'zustand';
import { loadPref, savePref } from './storage.ts';

/**
 * Read-aloud with the browser's built-in speech (free, offline, voices vary by device).
 * Each player controls it for themselves.
 */
export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

interface SpeechPrefs {
  autoRead: boolean;
  voiceURI: string | null;
  rate: number;
  speakingSeq: number | null;
  set: (p: Partial<Pick<SpeechPrefs, 'autoRead' | 'voiceURI' | 'rate'>>) => void;
  speak: (text: string, seq: number) => void;
  stop: () => void;
}

export const useSpeech = create<SpeechPrefs>((set, get) => ({
  autoRead: loadPref('autoRead', false),
  voiceURI: loadPref<string | null>('voiceURI', null),
  rate: loadPref('rate', 1),
  speakingSeq: null,
  set(p) {
    for (const [k, v] of Object.entries(p)) savePref(k, v);
    set(p);
  },
  speak(text, seq) {
    if (!speechSupported) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === get().voiceURI);
    if (voice) u.voice = voice;
    u.rate = get().rate;
    u.onend = u.onerror = () => {
      if (get().speakingSeq === seq) set({ speakingSeq: null });
    };
    set({ speakingSeq: seq });
    speechSynthesis.speak(u);
  },
  stop() {
    if (speechSupported) speechSynthesis.cancel();
    set({ speakingSeq: null });
  },
}));

export function listVoices(): SpeechSynthesisVoice[] {
  return speechSupported ? speechSynthesis.getVoices() : [];
}
