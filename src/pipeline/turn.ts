import { defaultAugment } from './augment.js';
import type { AudioQualityMeta } from './audioQuality.js';
import type { ChatMessage } from './providers/llm.js';
import { buildLlmMessages, streamCompletion } from './providers/llm.js';
import { synthesizeSpeech } from './providers/tts.js';
import { transcribeWav } from './providers/stt.js';
import { classifyTranscript } from './transcriptQuality.js';
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
  skipped?: boolean;
  skipReason?: string;
  usedRetry?: boolean;
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

export type TurnOptions = {
  audioMeta: AudioQualityMeta;
  canRetry: boolean;
};

const RETRY_PROMPT = 'Sorry, I missed that — what were you saying?';

export async function runVoiceTurn(
  wav: Uint8Array,
  history: ChatMessage[],
  callbacks: TurnCallbacks = {},
  options: TurnOptions,
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

  const classification = classifyTranscript(transcript, options.audioMeta);

  if (classification === 'noise') {
    return finishSkipped(phase, timings, t0, 'noise');
  }

  if (classification === 'failed_attempt') {
    if (!options.canRetry) {
      return finishSkipped(phase, timings, t0, 'failed_attempt');
    }
    phase('synthesizing');
    callbacks.onReply?.(RETRY_PROMPT);
    await streamTtsToClient(RETRY_PROMPT, callbacks, timings);
    timings.totalMs = Math.round(performance.now() - t0);
    phase('done');
    return {
      transcript: '',
      replyText: RETRY_PROMPT,
      timings,
      usedRetry: true,
    };
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

function finishSkipped(
  phase: (p: TurnPhase) => void,
  timings: TurnTimings,
  t0: number,
  skipReason: string,
): TurnResult {
  timings.totalMs = Math.round(performance.now() - t0);
  phase('done');
  return {
    transcript: '',
    replyText: '',
    timings,
    skipped: true,
    skipReason,
  };
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

export function emptyTurnTimings(): TurnTimings {
  return {
    sttMs: 0,
    augmentMs: 0,
    llmFirstTokenMs: 0,
    ttsFirstByteMs: 0,
    totalMs: 0,
  };
}
