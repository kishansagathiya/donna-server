import { config } from '../../config.js';

export type AudioChunk = {
  data: Uint8Array;
  format: 'mp3' | 'wav';
};

async function* streamOpenAiTts(text: string): AsyncIterable<AudioChunk> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      yield { data: value, format: 'mp3' };
    }
  }
}

async function* streamCartesiaTts(text: string): AsyncIterable<AudioChunk> {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.cartesiaApiKey}`,
      'Cartesia-Version': '2026-03-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3.5',
      transcript: text,
      voice: { mode: 'id', id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02' },
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 44100,
      },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Cartesia TTS ${res.status}: ${await res.text()}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const chunkSize = 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    yield {
      data: bytes.subarray(offset, offset + chunkSize),
      format: 'wav',
    };
  }
}

async function* streamElevenLabsTts(text: string): AsyncIterable<AudioChunk> {
  const voiceId = 'JBFqnCBsd6RMkjVDRZzb';
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenLabsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
      }),
    },
  );

  if (!res.ok || !res.body) {
    throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      yield { data: value, format: 'mp3' };
    }
  }
}

export async function* synthesizeSpeech(
  text: string,
): AsyncIterable<AudioChunk> {
  if (config.openAiApiKey) {
    yield* streamOpenAiTts(text);
    return;
  }
  if (config.cartesiaApiKey) {
    yield* streamCartesiaTts(text);
    return;
  }
  if (config.elevenLabsApiKey) {
    yield* streamElevenLabsTts(text);
    return;
  }
  throw new Error(
    'No TTS provider configured. Set OPENAI_API_KEY, CARTESIA_API_KEY, or ELEVENLABS_API_KEY.',
  );
}
