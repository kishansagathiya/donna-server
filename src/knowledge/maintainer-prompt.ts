export const KB_COMPILER_SYSTEM_PROMPT = `You are Donna's knowledge compiler. You maintain a personal memory for a voice assistant user.

Given new raw conversation sources and existing compiled memory, extract durable facts the assistant should remember across sessions.

Rules:
- Extract only stable, useful facts: names, relationships, preferences, deadlines, projects, locations, habits.
- Skip ephemeral small talk, greetings, and one-off questions unless they reveal durable preferences.
- Each fact must be a single clear sentence an assistant can cite verbatim.
- entity_name: the primary person/place/project the fact is about (optional).
- topic: a short category like family, work, health, travel, preferences (optional).
- profile_summary: a 2-4 sentence stable overview of who this user is and what matters to them. Update incrementally; do not wipe prior context unless contradicted.
- supersede: when new information replaces old facts, list the old fact text (substring match) and the replacement fact.
- Do not duplicate facts already in existing_facts unless you are superseding them.
- Return valid JSON only, no markdown fences.

Output schema:
{
  "profile_summary": "string",
  "new_facts": [
    { "fact": "string", "entity_name": "string or null", "topic": "string or null", "source_turn_index": number or null }
  ],
  "supersede": [
    { "old_fact": "string", "new_fact": "string", "entity_name": "string or null", "topic": "string or null" }
  ]
}`;

export function buildCompilerUserMessage(input: {
  existingProfile: string;
  existingFacts: Array<{ id: string; fact: string; entity_name: string | null }>;
  sources: Array<{
    id?: string;
    turn_index: number | null;
    label?: string;
    content: string;
  }>;
}): string {
  const factsBlock =
    input.existingFacts.length > 0
      ? input.existingFacts.map((f) => `- [${f.id}] ${f.entity_name ? `${f.entity_name}: ` : ''}${f.fact}`).join('\n')
      : '(none)';

  const sourcesBlock = input.sources
    .map((s) => {
      const heading =
        s.label ??
        (s.turn_index != null ? `Turn ${s.turn_index}` : `Source ${s.id ?? '?'}`);
      return `### ${heading}\n${s.content}`;
    })
    .join('\n\n');

  return [
    '## Existing profile',
    input.existingProfile || '(empty)',
    '',
    '## Existing facts',
    factsBlock,
    '',
    '## New sources to compile',
    sourcesBlock,
    '',
    'Compile the new sources into the memory. Return JSON only.',
  ].join('\n');
}
