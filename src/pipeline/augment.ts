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
  base.text = formatAugmentedUserMessage(base);
  return base;
}
