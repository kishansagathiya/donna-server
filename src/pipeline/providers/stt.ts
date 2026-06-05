import { config } from '../../config.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function openRouterHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.openRouterApiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function transcribeWav(
  wav: Uint8Array,
): Promise<{ transcript: string; ms: number }> {
  const start = performance.now();
  const res = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.sttModel,
      input_audio: {
        data: Buffer.from(wav).toString('base64'),
        format: 'wav',
      },
    }),
  });

  if (!res.ok) {
    throw new Error(
      `OpenRouter STT ${res.status}: ${await res.text()}`,
    );
  }

  const data = (await res.json()) as { text?: string };
  return {
    transcript: data.text ?? '',
    ms: Math.round(performance.now() - start),
  };
}
