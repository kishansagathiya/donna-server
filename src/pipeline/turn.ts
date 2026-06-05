import { defaultAugment } from './augment.js';
import type { ChatMessage } from './providers/llm.js';
import { buildLlmMessages, streamCompletion } from './providers/llm.js';
import { synthesizeSpeech } from './providers/tts.js';
import { transcribeWav } from './providers/stt.js';
import { config } from '../config.js';
import type { TurnPhase } from '../protocol.js';

export type TurnTimings = {
  sttMs: number;
  augmentMs: number;
  llmFirstTokenMs: number;
  ttsFirstByteMs: number;
  totalMs: number;
};

export type TurnResult = {
  transcript: string;
  replyText: string;
  timings: TurnTimings;
};

export type TurnCallbacks = {
  onPhase?: (phase: TurnPhase) => void;
  onTranscript?: (text: string) => void;
  onReply?: (text: string) => void;
  onAudioChunk?: (chunk: {
    seq: number;
    format: 'mp3' | 'wav';
    data: Uint8Array;
  }) => void;
};

export async function runVoiceTurn(
  wav: Uint8Array,
  history: ChatMessage[],
  callbacks: TurnCallbacks = {},
): Promise<TurnResult> {
  const t0 = performance.now();
  const timings: TurnTimings = {
    sttMs: 0,
    augmentMs: 0,
    llmFirstTokenMs: 0,
    ttsFirstByteMs: 0,
    totalMs: 0,
  };

  const phase = (p: TurnPhase) => callbacks.onPhase?.(p);

  phase('transcribing');
  const { transcript, ms: sttMs } = await transcribeWav(wav);
  timings.sttMs = sttMs;

  if (!transcript.trim()) {
    const apology = "I didn't catch that. Could you say it again?";
    phase('synthesizing');
    callbacks.onReply?.(apology);
    await streamTtsToClient(apology, callbacks, timings);
    timings.totalMs = Math.round(performance.now() - t0);
    phase('done');
    return { transcript: '', replyText: apology, timings };
  }

  callbacks.onTranscript?.(transcript);

  phase('generating');
  const augStart = performance.now();
  const augmented = await defaultAugment({
    transcript,
    userId: 'user',
    sessionId: 'session',
  });
  timings.augmentMs = Math.round(performance.now() - augStart);

  const messages = buildLlmMessages(
    config.systemPrompt,
    history,
    augmented.text,
  );

  const llmStart = performance.now();
  let replyText = '';
  let firstToken = true;
  for await (const chunk of streamCompletion(messages)) {
    if (firstToken) {
      timings.llmFirstTokenMs = Math.round(performance.now() - llmStart);
      firstToken = false;
    }
    replyText += chunk;
  }

  callbacks.onReply?.(replyText);

  phase('synthesizing');
  await streamTtsToClient(replyText, callbacks, timings);

  timings.totalMs = Math.round(performance.now() - t0);
  phase('done');

  return { transcript, replyText, timings };
}

async function streamTtsToClient(
  text: string,
  callbacks: TurnCallbacks,
  timings: TurnTimings,
): Promise<void> {
  const ttsStart = performance.now();
  let firstByte = true;
  let seq = 0;

  for await (const chunk of synthesizeSpeech(text)) {
    if (firstByte) {
      timings.ttsFirstByteMs = Math.round(performance.now() - ttsStart);
      firstByte = false;
    }
    callbacks.onAudioChunk?.({
      seq: seq++,
      format: chunk.format,
      data: chunk.data,
    });
  }
}
