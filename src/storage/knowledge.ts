import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { log, logWarn } from '../log.js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

export function isKnowledgeEnabled(): boolean {
  return config.persistKnowledge;
}

export type KbSource = {
  id: string;
  user_id: string;
  source_type: 'voice_turn' | 'document' | 'integration';
  content: string;
  conversation_id: string | null;
  turn_index: number | null;
};

export type KbFact = {
  id: string;
  user_id: string;
  fact: string;
  entity_name: string | null;
  topic: string | null;
  source_id: string | null;
  active: boolean;
};

export type ConversationTurn = {
  turn_index: number;
  user_transcript: string;
  assistant_transcript: string;
};

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'don', 'now', 'and', 'but', 'or', 'if', 'because', 'until', 'while',
  'about', 'against', 'what', 'which', 'who', 'whom', 'this', 'that',
  'these', 'those', 'am', 'i', 'me', 'my', 'myself', 'we', 'our', 'you',
  'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them',
  'their', 'tell', 'said', 'say', 'know', 'think', 'like', 'get', 'got',
]);

export function extractSearchTerms(transcript: string): string[] {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  return [...new Set(words)].slice(0, 12);
}

export async function getUserProfileSummary(userId: string): Promise<string> {
  const { data, error } = await getClient()
    .from('kb_user_profiles')
    .select('summary')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logWarn('failed to load user profile', {
      userId: userId.slice(0, 8),
      error: error.message,
    });
    return '';
  }

  return data?.summary?.trim() ?? '';
}

export async function upsertUserProfileSummary(
  userId: string,
  summary: string,
): Promise<void> {
  const { error } = await getClient()
    .from('kb_user_profiles')
    .upsert(
      { user_id: userId, summary, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );

  if (error) {
    throw new Error(`Failed to upsert user profile: ${error.message}`);
  }
}

type FactRow = {
  fact: string;
  entity_name: string | null;
  topic: string | null;
};

function formatFactRows(rows: FactRow[]): string[] {
  return rows.map((row) => {
    const parts = [row.fact];
    if (row.entity_name) parts.unshift(`${row.entity_name}:`);
    return parts.join(' ');
  });
}

async function fetchRecentFacts(
  userId: string,
  limit: number,
): Promise<FactRow[]> {
  const { data, error } = await getClient()
    .from('kb_facts')
    .select('fact, entity_name, topic')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logWarn('recent fact fetch failed', {
      userId: userId.slice(0, 8),
      error: error.message,
    });
    return [];
  }

  return (data ?? []) as FactRow[];
}

export async function retrieveFacts(
  userId: string,
  transcript: string,
  limit = 10,
): Promise<string[]> {
  const terms = extractSearchTerms(transcript);
  const isMemoryQuery = /\b(remember|recall|what|who|when|where|my|name|tell me)\b/i.test(
    transcript,
  );

  let ftsRows: FactRow[] = [];

  if (terms.length > 0) {
    const tsQuery = terms.map((t) => t.replace(/'/g, "''")).join(' | ');
    const { data, error } = await getClient()
      .from('kb_facts')
      .select('fact, entity_name, topic')
      .eq('user_id', userId)
      .eq('active', true)
      .textSearch('search_vector', tsQuery, {
        type: 'websearch',
        config: 'english',
      })
      .order('created_at', { ascending: false })
      .limit(limit * 2);

    if (error) {
      logWarn('fact retrieval failed', {
        userId: userId.slice(0, 8),
        error: error.message,
      });
    } else if (data?.length) {
      ftsRows = data as FactRow[];
    }
  }

  if (!isMemoryQuery && ftsRows.length > 0) {
    return formatFactRows(ftsRows).slice(0, limit);
  }

  const recentRows = await fetchRecentFacts(userId, limit * 2);
  const seen = new Set<string>();
  const merged: FactRow[] = [];

  for (const row of [...ftsRows, ...recentRows]) {
    const key = row.fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
    if (merged.length >= limit) break;
  }

  return formatFactRows(merged);
}

export async function waitForConversationTurns(
  conversationId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ConversationTurn[]> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollMs = options.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const turns = await getConversationTurns(conversationId);
    if (turns.length > 0) return turns;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return getConversationTurns(conversationId);
}

export async function getConversationTurns(
  conversationId: string,
): Promise<ConversationTurn[]> {
  const { data, error } = await getClient()
    .from('conversation_turns')
    .select('turn_index, user_transcript, assistant_transcript')
    .eq('conversation_id', conversationId)
    .order('turn_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load conversation turns: ${error.message}`);
  }

  return data ?? [];
}

export async function upsertVoiceSource(input: {
  userId: string;
  conversationId: string;
  turnIndex: number;
  userTranscript: string;
  assistantTranscript: string;
}): Promise<string> {
  const content = [
    `User: ${input.userTranscript}`,
    `Assistant: ${input.assistantTranscript}`,
  ].join('\n');

  const { data, error } = await getClient()
    .from('kb_sources')
    .upsert(
      {
        user_id: input.userId,
        source_type: 'voice_turn',
        content,
        conversation_id: input.conversationId,
        turn_index: input.turnIndex,
      },
      { onConflict: 'conversation_id,turn_index' },
    )
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to upsert kb_source');
  }

  return data.id;
}

export async function getSourcesForConversation(
  conversationId: string,
): Promise<KbSource[]> {
  const { data, error } = await getClient()
    .from('kb_sources')
    .select('id, user_id, source_type, content, conversation_id, turn_index')
    .eq('conversation_id', conversationId)
    .order('turn_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load kb_sources: ${error.message}`);
  }

  return (data ?? []) as KbSource[];
}

export async function getActiveFacts(userId: string): Promise<KbFact[]> {
  const { data, error } = await getClient()
    .from('kb_facts')
    .select('id, user_id, fact, entity_name, topic, source_id, active')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load facts: ${error.message}`);
  }

  return (data ?? []) as KbFact[];
}

export type NewFactInput = {
  fact: string;
  entity_name?: string | null;
  topic?: string | null;
  source_id?: string | null;
  supersedes_id?: string | null;
};

export async function insertFacts(
  userId: string,
  facts: NewFactInput[],
): Promise<number> {
  if (facts.length === 0) return 0;

  const rows = facts.map((f) => ({
    user_id: userId,
    fact: f.fact,
    entity_name: f.entity_name ?? null,
    topic: f.topic ?? null,
    source_id: f.source_id ?? null,
    supersedes_id: f.supersedes_id ?? null,
    active: true,
  }));

  const { error } = await getClient().from('kb_facts').insert(rows);

  if (error) {
    throw new Error(`Failed to insert facts: ${error.message}`);
  }

  return rows.length;
}

export async function deactivateFact(factId: string): Promise<void> {
  const { error } = await getClient()
    .from('kb_facts')
    .update({ active: false })
    .eq('id', factId);

  if (error) {
    throw new Error(`Failed to deactivate fact: ${error.message}`);
  }
}

export async function isConversationCompiled(
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from('kb_compile_log')
    .select('id, turns_count')
    .eq('conversation_id', conversationId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logWarn('failed to check compile status', { error: error.message });
    return false;
  }

  return !!data && (data.turns_count ?? 0) > 0;
}

export async function createCompileLog(input: {
  userId: string;
  conversationId: string;
}): Promise<string> {
  const { data, error } = await getClient()
    .from('kb_compile_log')
    .insert({
      user_id: input.userId,
      conversation_id: input.conversationId,
      status: 'running',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create compile log');
  }

  return data.id;
}

export async function completeCompileLog(input: {
  logId: string;
  status: 'completed' | 'failed';
  turnsCount: number;
  factsAdded: number;
  error?: string;
}): Promise<void> {
  const { error } = await getClient()
    .from('kb_compile_log')
    .update({
      status: input.status,
      turns_count: input.turnsCount,
      facts_added: input.factsAdded,
      error: input.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', input.logId);

  if (error) {
    logWarn('failed to update compile log', { error: error.message });
  }
}

export async function syncConversationSources(
  userId: string,
  conversationId: string,
): Promise<KbSource[]> {
  const turns = await getConversationTurns(conversationId);

  for (const turn of turns) {
    await upsertVoiceSource({
      userId,
      conversationId,
      turnIndex: turn.turn_index,
      userTranscript: turn.user_transcript,
      assistantTranscript: turn.assistant_transcript,
    });
  }

  return getSourcesForConversation(conversationId);
}

export function enqueueKnowledgeWork(work: () => Promise<void>): void {
  void work().catch((err) => {
    logWarn('knowledge background work failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function logKnowledge(message: string, data?: Record<string, unknown>): void {
  log(message, data);
}

const KNOWLEDGE_BUCKET = 'knowledge-assets';

export async function insertAssetSource(input: {
  userId: string;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const { data, error } = await getClient()
    .from('kb_sources')
    .insert({
      user_id: input.userId,
      source_type: 'document',
      content: input.content,
      metadata: input.metadata,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to insert asset source');
  }

  return data.id;
}

export async function getSourceById(sourceId: string): Promise<KbSource & { metadata?: Record<string, unknown> }> {
  const { data, error } = await getClient()
    .from('kb_sources')
    .select('id, user_id, source_type, content, conversation_id, turn_index, metadata')
    .eq('id', sourceId)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Source not found');
  }

  return data as KbSource & { metadata?: Record<string, unknown> };
}

export async function isSourceCompiled(sourceId: string): Promise<boolean> {
  const { count, error } = await getClient()
    .from('kb_facts')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', sourceId)
    .eq('active', true);

  if (error) {
    logWarn('failed to check source facts', { sourceId, error: error.message });
    return false;
  }

  return (count ?? 0) > 0;
}

export async function markSourceCompiled(sourceId: string): Promise<void> {
  const source = await getSourceById(sourceId);
  const metadata = {
    ...(source.metadata ?? {}),
    compiled_at: new Date().toISOString(),
  };

  const { error } = await getClient()
    .from('kb_sources')
    .update({ metadata })
    .eq('id', sourceId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function uploadAssetFile(input: {
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${input.userId}/${Date.now()}-${safeName}`;

  const { error } = await getClient()
    .storage
    .from(KNOWLEDGE_BUCKET)
    .upload(path, input.buffer, {
      contentType: input.mimeType,
      upsert: false,
    });

  if (error) {
    throw new Error(`Asset upload failed: ${error.message}`);
  }

  return path;
}
