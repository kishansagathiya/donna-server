import type { NewFactInput } from '../storage/knowledge.js';

type SourceSlice = {
  id?: string;
  content: string;
  turn_index: number | null;
};

const NAME_PATTERNS = [
  /\b(?:my name is|i'm|i am|call me|name's)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i,
];

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export function extractObviousFacts(sources: SourceSlice[]): NewFactInput[] {
  const facts: NewFactInput[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const pattern of NAME_PATTERNS) {
      const match = source.content.match(pattern);
      if (!match) continue;

      const name = match[1].trim();
      const fact = `User's name is ${name}`;
      const key = fact.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      facts.push({
        fact,
        entity_name: name,
        topic: 'identity',
        source_id: source.id ?? null,
      });
    }

    const urls = source.content.match(URL_PATTERN) ?? [];
    for (const rawUrl of urls) {
      const url = rawUrl.replace(/[.,;:!?)]+$/, '');
      const fact = `User shared link: ${url}`;
      const key = fact.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      facts.push({
        fact,
        topic: 'links',
        source_id: source.id ?? null,
      });
    }
  }

  return facts;
}
