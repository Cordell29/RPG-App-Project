import { GoogleGenAI, Modality } from '@google/genai';
import { type ImageProvider, MediaError, type TtsProvider, pcmToWav } from './provider.ts';

/** Gemini image generation ("Nano Banana"). Model id from GEMINI_IMAGE_MODEL. */
export class GeminiImageProvider implements ImageProvider {
  readonly name = 'gemini';
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async generate(prompt: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { responseModalities: [Modality.IMAGE], ...(signal ? { abortSignal: signal } : {}) },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) {
      const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'no image returned';
      throw new MediaError(`Image generation failed: ${reason}`);
    }
    return Buffer.from(part.inlineData.data, 'base64');
  }
}

/** Gemini text-to-speech. Returns 24 kHz PCM, wrapped as WAV. */
export class GeminiTtsProvider implements TtsProvider {
  readonly name = 'gemini';
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly voice: string;

  constructor(opts: { apiKey: string; model: string; voice: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.voice = opts.voice;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: `Read this like a storyteller at a tabletop game, warm and paced: ${text}`,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new MediaError('Speech generation returned no audio.');
    return pcmToWav(Buffer.from(data, 'base64'));
  }
}
