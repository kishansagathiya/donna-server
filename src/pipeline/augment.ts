import {
  isKnowledgeEnabled,
  retrieveFacts,
} from '../storage/knowledge.js';

export type TranscriptAugmentation = {
  transcript: string;
  text: string;
  retrieved?: string[];
  sessionNotes?: string;
};

export function formatAugmentedUserMessage(
  augmented: TranscriptAugmentation,
): string {
  const parts: string[] = [];
  if (augmented.retrieved?.length) {
    parts.push(`[Retrieved: ${augmented.retrieved.join(' | ')}]`);
  }
  if (augmented.sessionNotes) {
    parts.push(`[Session: ${augmented.sessionNotes}]`);
  }
  parts.push(`User said: "${augmented.transcript}"`);
  return parts.join('\n');
}

export async function defaultAugment(input: {
  transcript: string;
  userId: string;
  sessionId: string;
}): Promise<TranscriptAugmentation> {
  const base: TranscriptAugmentation = {
    transcript: input.transcript,
    text: '',
  };

  if (isKnowledgeEnabled()) {
    try {
      base.retrieved = await retrieveFacts(input.userId, input.transcript);
    } catch {
      // Retrieval failure should not block the voice turn.
    }
  }

  base.text = formatAugmentedUserMessage(base);
  return base;
}
