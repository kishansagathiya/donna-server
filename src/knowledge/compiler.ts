import {
  completeOnce,
  type ChatMessage,
} from '../pipeline/providers/llm.js';
import {
  completeCompileLog,
  createCompileLog,
  deactivateFact,
  getActiveFacts,
  getSourceById,
  getUserProfileSummary,
  insertFacts,
  isConversationCompiled,
  isSourceCompiled,
  logKnowledge,
  markSourceCompiled,
  syncConversationSources,
  upsertUserProfileSummary,
  waitForConversationTurns,
  type KbSource,
} from '../storage/knowledge.js';
import {
  buildCompilerUserMessage,
  KB_COMPILER_SYSTEM_PROMPT,
} from './maintainer-prompt.js';
import { extractObviousFacts } from './obvious-facts.js';
import { logWarn } from '../log.js';

type CompilerOutput = {
  profile_summary?: string;
  new_facts?: Array<{
    fact: string;
    entity_name?: string | null;
    topic?: string | null;
    source_turn_index?: number | null;
  }>;
  supersede?: Array<{
    old_fact: string;
    new_fact: string;
    entity_name?: string | null;
    topic?: string | null;
  }>;
};

export async function compileSource(
  userId: string,
  sourceId: string,
): Promise<void> {
  if (await isSourceCompiled(sourceId)) {
    logKnowledge('asset compile skipped — already completed', { sourceId });
    return;
  }

  try {
    const source = await getSourceById(sourceId);
    if (source.user_id !== userId) {
      throw new Error('Source does not belong to user');
    }

    const [existingProfile, existingFacts] = await Promise.all([
      getUserProfileSummary(userId),
      getActiveFacts(userId),
    ]);

    const metadata = source.metadata as { title?: string; asset_kind?: string } | undefined;
    const label = metadata?.title ?? metadata?.asset_kind ?? 'Asset';

    const output = await runCompilerLlm({
      existingProfile,
      existingFacts,
      sources: [
        {
          id: source.id,
          turn_index: null,
          label,
          content: source.content,
        },
      ],
    });

    let factsAdded = 0;
    let profileUpdated = false;

    if (output.profile_summary?.trim()) {
      await upsertUserProfileSummary(userId, output.profile_summary.trim());
      profileUpdated = true;
    }

    for (const item of output.supersede ?? []) {
      const match = existingFacts.find((f) =>
        f.fact.toLowerCase().includes(item.old_fact.toLowerCase()),
      );
      if (!match) continue;

      await deactivateFact(match.id);
      await insertFacts(userId, [
        {
          fact: item.new_fact,
          entity_name: item.entity_name ?? match.entity_name,
          topic: item.topic ?? match.topic,
          supersedes_id: match.id,
          source_id: sourceId,
        },
      ]);
      factsAdded += 1;
    }

    const llmFacts = (output.new_facts ?? [])
      .filter((f) => f.fact?.trim())
      .map((f) => ({
        fact: f.fact.trim(),
        entity_name: f.entity_name ?? null,
        topic: f.topic ?? null,
        source_id: sourceId,
      }));

    const obviousFacts = extractObviousFacts([
      { id: sourceId, content: source.content, turn_index: null },
    ]);
    const existingFactKeys = new Set(
      existingFacts.map((f) => f.fact.toLowerCase()),
    );
    const mergedFacts = [
      ...llmFacts,
      ...obviousFacts.filter((f) => !existingFactKeys.has(f.fact.toLowerCase())),
    ];

    factsAdded += await insertFacts(userId, mergedFacts);

    if (factsAdded > 0 || profileUpdated) {
      await markSourceCompiled(sourceId);
    }

    logKnowledge('asset compiled', {
      userId: userId.slice(0, 8),
      sourceId,
      factsAdded,
    });
  } catch (err) {
    throw err;
  }
}

export async function compileConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  if (await isConversationCompiled(conversationId)) {
    logKnowledge('compile skipped — already completed', { conversationId });
    return;
  }

  const logId = await createCompileLog({ userId, conversationId });

  try {
    await waitForConversationTurns(conversationId);
    const sources = await syncConversationSources(userId, conversationId);
    if (sources.length === 0) {
      await completeCompileLog({
        logId,
        status: 'failed',
        turnsCount: 0,
        factsAdded: 0,
        error: 'no conversation turns to compile',
      });
      logKnowledge('compile skipped — no turns found', { conversationId });
      return;
    }

    const [existingProfile, existingFacts] = await Promise.all([
      getUserProfileSummary(userId),
      getActiveFacts(userId),
    ]);

    const output = await runCompilerLlm({
      existingProfile,
      existingFacts,
      sources,
    });

    let factsAdded = 0;

    if (output.profile_summary?.trim()) {
      await upsertUserProfileSummary(userId, output.profile_summary.trim());
    }

    const sourceByTurn = new Map<number, string>();
    for (const source of sources) {
      if (source.turn_index != null) {
        sourceByTurn.set(source.turn_index, source.id);
      }
    }

    for (const item of output.supersede ?? []) {
      const match = existingFacts.find((f) =>
        f.fact.toLowerCase().includes(item.old_fact.toLowerCase()),
      );
      if (!match) continue;

      await deactivateFact(match.id);
      await insertFacts(userId, [
        {
          fact: item.new_fact,
          entity_name: item.entity_name ?? match.entity_name,
          topic: item.topic ?? match.topic,
          supersedes_id: match.id,
        },
      ]);
      factsAdded += 1;
    }

    const llmFacts = (output.new_facts ?? [])
      .filter((f) => f.fact?.trim())
      .map((f) => ({
        fact: f.fact.trim(),
        entity_name: f.entity_name ?? null,
        topic: f.topic ?? null,
        source_id:
          f.source_turn_index != null
            ? sourceByTurn.get(f.source_turn_index) ?? null
            : null,
      }));

    const obviousFacts = extractObviousFacts(
      sources.map((s) => ({
        id: s.id,
        content: s.content,
        turn_index: s.turn_index,
      })),
    );

    const existingFactKeys = new Set(
      existingFacts.map((f) => f.fact.toLowerCase()),
    );
    const mergedFacts = [
      ...llmFacts,
      ...obviousFacts.filter((f) => !existingFactKeys.has(f.fact.toLowerCase())),
    ];

    factsAdded += await insertFacts(userId, mergedFacts);

    await completeCompileLog({
      logId,
      status: 'completed',
      turnsCount: sources.length,
      factsAdded,
    });

    logKnowledge('knowledge compiled', {
      userId: userId.slice(0, 8),
      conversationId,
      turns: sources.length,
      factsAdded,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeCompileLog({
      logId,
      status: 'failed',
      turnsCount: 0,
      factsAdded: 0,
      error: message,
    });
    throw err;
  }
}

async function runCompilerLlm(input: {
  existingProfile: string;
  existingFacts: Array<{
    id: string;
    fact: string;
    entity_name: string | null;
  }>;
  sources: Array<{
    id?: string;
    turn_index: number | null;
    label?: string;
    content: string;
  }>;
}): Promise<CompilerOutput> {
  const messages: ChatMessage[] = [
    { role: 'system', content: KB_COMPILER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildCompilerUserMessage({
        existingProfile: input.existingProfile,
        existingFacts: input.existingFacts,
        sources: input.sources.map((s) => ({
          id: s.id,
          turn_index: s.turn_index,
          label: s.label,
          content: s.content,
        })),
      }),
    },
  ];

  const raw = await completeOnce(messages);
  return parseCompilerOutput(raw);
}

function parseCompilerOutput(raw: string): CompilerOutput {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1) {
    logWarn('compiler returned non-JSON', { preview: trimmed.slice(0, 200) });
    return {};
  }

  try {
    return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as CompilerOutput;
  } catch (err) {
    logWarn('failed to parse compiler JSON', {
      error: err instanceof Error ? err.message : String(err),
      preview: trimmed.slice(0, 200),
    });
    return {};
  }
}
