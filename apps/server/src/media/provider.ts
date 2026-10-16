/** Image and speech generation sit behind these interfaces; tests use the mocks. */
export interface ImageProvider {
  readonly name: string;
  /** Returns encoded image bytes (any format sharp can read). */
  generate(prompt: string, signal?: AbortSignal): Promise<Buffer>;
}

export interface TtsProvider {
  readonly name: string;
  /** Returns a playable WAV file. */
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>;
}

export class MediaError extends Error {
  override name = 'MediaError';
}

/** Wraps raw 16-bit mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
