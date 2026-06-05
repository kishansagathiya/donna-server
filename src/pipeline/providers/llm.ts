import { config } from '../../config.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

function openRouterHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.openRouterApiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function* streamCompletion(
  messages: ChatMessage[],
): AsyncIterable<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(
      `OpenRouter LLM ${res.status}: ${await res.text()}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // skip malformed SSE frames
      }
    }
  }
}

export function buildLlmMessages(
  systemPrompt: string,
  history: ChatMessage[],
  userMessage: string,
): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
}
