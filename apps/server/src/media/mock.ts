import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { type ImageProvider, type TtsProvider, pcmToWav } from './provider.ts';

/** Offline art: a soft two-tone gradient whose colours come from the prompt. */
export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';
  readonly prompts: string[] = [];
  delayMs = 0;
  /** Fail this many upcoming calls (tests). */
  failNext = 0;
  /** Never resolve (tests: simulate a crash mid-generation). */
  hang = false;

  async generate(prompt: string, signal?: AbortSignal): Promise<Buffer> {
    this.prompts.push(prompt);
    if (this.hang) await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('mock image failure');
    }
    const h = createHash('sha256').update(prompt).digest();
    const c = (o: number) => `rgb(${h[o]},${h[o + 1]},${h[o + 2]})`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c(0)}"/><stop offset="1" stop-color="${c(3)}"/></linearGradient></defs><rect width="768" height="768" fill="url(#g)"/><circle cx="384" cy="330" r="150" fill="rgba(255,255,255,0.18)"/><rect x="214" y="500" width="340" height="200" rx="120" fill="rgba(255,255,255,0.14)"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}

/** Offline voice: a short silence. */
export class MockTtsProvider implements TtsProvider {
  readonly name = 'mock';
  readonly texts: string[] = [];
  failNext = 0;

  async synthesize(text: string): Promise<Buffer> {
    this.texts.push(text);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('mock tts failure');
    }
    return pcmToWav(Buffer.alloc(24000 * 2 * 0.2));
  }
}
