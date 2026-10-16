import { create } from 'zustand';
import { loadPref, savePref } from './storage.ts';

/**
 * Read-aloud. When the host has AI voice on, the server's recorded clip is played;
 * otherwise the browser's built-in speech (free, offline, voices vary by device).
 * Each player controls it for themselves.
 */
export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

interface SpeechPrefs {
  autoRead: boolean;
  voiceURI: string | null;
  rate: number;
  speakingSeq: number | null;
  set: (p: Partial<Pick<SpeechPrefs, 'autoRead' | 'voiceURI' | 'rate'>>) => void;
  speak: (text: string, seq: number, clipUrl?: string) => void;
  stop: () => void;
}

let audio: HTMLAudioElement | null = null;

export const useSpeech = create<SpeechPrefs>((set, get) => ({
  autoRead: loadPref('autoRead', false),
  voiceURI: loadPref<string | null>('voiceURI', null),
  rate: loadPref('rate', 1),
  speakingSeq: null,
  set(p) {
    for (const [k, v] of Object.entries(p)) savePref(k, v);
    set(p);
  },
  speak(text, seq, clipUrl) {
    get().stop();
    if (clipUrl && typeof Audio !== 'undefined') {
      const a = new Audio(clipUrl);
      a.playbackRate = get().rate;
      audio = a;
      a.onended = a.onerror = () => {
        if (get().speakingSeq === seq) set({ speakingSeq: null });
      };
      set({ speakingSeq: seq });
      a.play().catch(() => {
        // Autoplay blocked or clip missing: fall back to the browser voice.
        if (audio === a) get().speak(text, seq);
      });
      return;
    }
    if (!speechSupported) return;
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
    if (audio) {
      audio.pause();
      audio = null;
    }
    if (speechSupported) speechSynthesis.cancel();
    set({ speakingSeq: null });
  },
}));

export function listVoices(): SpeechSynthesisVoice[] {
  return speechSupported ? speechSynthesis.getVoices() : [];
}
