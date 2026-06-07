import type { AudioQualityMeta } from './audioQuality.js';

export type TranscriptClass = 'valid' | 'noise' | 'failed_attempt';

const CLEAR_ATTEMPT_MIN_MS = 1500;

const FILLER_WORDS = new Set([
  'um',
  'uh',
  'uhh',
  'umm',
  'hmm',
  'hm',
  'oh',
  'ah',
  'er',
  'eh',
]);

const HALLUCINATION_PATTERNS = [
  /thank(s| you) for watching/i,
  /\bsubscribe\b/i,
  /\blike and subscribe\b/i,
  /\bplease subscribe\b/i,
  /\bmusic\b/i,
  /\bapplause\b/i,
  /\b\[music\]/i,
  /\b\[applause\]/i,
];

export function classifyTranscript(
  transcript: string,
  audio: AudioQualityMeta,
): TranscriptClass {
  const trimmed = transcript.trim();
  const normalized = trimmed.toLowerCase().replace(/[^\w\s']/g, '').trim();

  if (!normalized) {
    return isClearSpeechAttempt(audio) ? 'failed_attempt' : 'noise';
  }

  if (normalized.length < 3) {
    return isClearSpeechAttempt(audio) ? 'failed_attempt' : 'noise';
  }

  if (FILLER_WORDS.has(normalized)) {
    return isClearSpeechAttempt(audio) ? 'failed_attempt' : 'noise';
  }

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'noise';
    }
  }

  if (
    audio.durationMs >= CLEAR_ATTEMPT_MIN_MS &&
    meaningfulCharCount(normalized) < 3
  ) {
    return isClearSpeechAttempt(audio) ? 'failed_attempt' : 'noise';
  }

  return 'valid';
}

function isClearSpeechAttempt(audio: AudioQualityMeta): boolean {
  return (
    audio.durationMs >= CLEAR_ATTEMPT_MIN_MS &&
    audio.speechMs >= 400 &&
    audio.peakRms >= 0.01
  );
}

function meaningfulCharCount(text: string): number {
  return text.replace(/[\s\W]/g, '').length;
}
