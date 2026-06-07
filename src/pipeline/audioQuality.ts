const MIN_AUDIO_MS = 300;
const MIN_SPEECH_RMS = 0.01;
const SPEECH_RMS_THRESHOLD = 0.01;
const FRAME_SAMPLES = 320;

export type AudioQualityMeta = {
  durationMs: number;
  speechMs: number;
  avgRms: number;
  peakRms: number;
};

export type AudioQualityVerdict = AudioQualityMeta & {
  shouldProcess: boolean;
  reason?: string;
};

function pcm16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / (samples[i] < 0 ? 0x80_00 : 0x7f_ff);
  }
  return out;
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

export function analyzePcm16(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
): AudioQualityVerdict {
  const sampleCount = Math.floor(pcm.length / 2 / channels);
  const durationMs = (sampleCount / sampleRate) * 1000;

  if (durationMs < MIN_AUDIO_MS) {
    return {
      durationMs,
      speechMs: 0,
      avgRms: 0,
      peakRms: 0,
      shouldProcess: false,
      reason: 'audio_too_short',
    };
  }

  const int16 = new Int16Array(
    pcm.buffer,
    pcm.byteOffset,
    pcm.byteLength / 2,
  );
  const mono = pcm16ToFloat(int16);

  let speechMs = 0;
  let rmsSum = 0;
  let peakRms = 0;
  let frameCount = 0;
  const frameMs = (FRAME_SAMPLES / sampleRate) * 1000;

  for (let offset = 0; offset < mono.length; offset += FRAME_SAMPLES) {
    const frame = mono.subarray(offset, offset + FRAME_SAMPLES);
    if (frame.length === 0) continue;

    const rms = computeRms(frame);
    rmsSum += rms;
    frameCount += 1;
    if (rms > peakRms) peakRms = rms;
    if (rms >= SPEECH_RMS_THRESHOLD) {
      speechMs += frameMs;
    }
  }

  const avgRms = frameCount > 0 ? rmsSum / frameCount : 0;
  const meta: AudioQualityMeta = {
    durationMs,
    speechMs,
    avgRms,
    peakRms,
  };

  if (peakRms < MIN_SPEECH_RMS) {
    return {
      ...meta,
      shouldProcess: false,
      reason: 'low_energy',
    };
  }

  return { ...meta, shouldProcess: true };
}
