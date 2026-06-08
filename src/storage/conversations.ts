import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { log, logWarn } from '../log.js';
import type { TurnTimings } from '../pipeline/turn.js';

const AUDIO_BUCKET = 'conversation-audio';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

export function isConversationPersistenceEnabled(): boolean {
  return config.persistConversations;
}

export async function createConversation(
  userId: string,
  voiceSessionId: string,
): Promise<string> {
  const { data, error } = await getClient()
    .from('conversations')
    .insert({
      user_id: userId,
      voice_session_id: voiceSessionId,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create conversation');
  }

  log('conversation created', {
    conversationId: data.id,
    voiceSessionId,
    userId: userId.slice(0, 8),
  });

  return data.id;
}

export async function endConversation(conversationId: string): Promise<void> {
  const { error } = await getClient()
    .from('conversations')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', conversationId)
    .is('ended_at', null);

  if (error) {
    throw new Error(error.message);
  }

  log('conversation ended', { conversationId });
}

export type SaveTurnInput = {
  conversationId: string;
  userId: string;
  turnIndex: number;
  userTranscript: string;
  assistantTranscript: string;
  userWav: Uint8Array;
  assistantAudio: Uint8Array;
  assistantFormat: 'mp3' | 'wav';
  timings: TurnTimings;
};

function audioPaths(
  userId: string,
  conversationId: string,
  turnIndex: number,
  assistantFormat: 'mp3' | 'wav',
): { userPath: string; assistantPath: string } {
  const base = `${userId}/${conversationId}/${turnIndex}`;
  return {
    userPath: `${base}/user.wav`,
    assistantPath: `${base}/assistant.${assistantFormat}`,
  };
}

function assistantMime(format: 'mp3' | 'wav'): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

async function uploadAudio(
  path: string,
  data: Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await getClient()
    .storage
    .from(AUDIO_BUCKET)
    .upload(path, data, { contentType, upsert: false });

  if (error) {
    throw new Error(`Storage upload failed (${path}): ${error.message}`);
  }
}

export async function saveTurn(input: SaveTurnInput): Promise<void> {
  const { userPath, assistantPath } = audioPaths(
    input.userId,
    input.conversationId,
    input.turnIndex,
    input.assistantFormat,
  );

  await uploadAudio(userPath, input.userWav, 'audio/wav');
  await uploadAudio(
    assistantPath,
    input.assistantAudio,
    assistantMime(input.assistantFormat),
  );

  const { error } = await getClient().from('conversation_turns').insert({
    conversation_id: input.conversationId,
    turn_index: input.turnIndex,
    user_transcript: input.userTranscript,
    assistant_transcript: input.assistantTranscript,
    user_audio_path: userPath,
    assistant_audio_path: assistantPath,
    user_audio_mime: 'audio/wav',
    assistant_audio_mime: assistantMime(input.assistantFormat),
    timings: input.timings,
  });

  if (error) {
    throw new Error(error.message);
  }

  log('turn saved', {
    conversationId: input.conversationId,
    turnIndex: input.turnIndex,
    userAudioPath: userPath,
    assistantAudioPath: assistantPath,
  });
}

export function persistTurnAsync(input: SaveTurnInput): void {
  void saveTurn(input).catch((err) => {
    logWarn('failed to persist turn', {
      conversationId: input.conversationId,
      turnIndex: input.turnIndex,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function endConversationAsync(conversationId: string): void {
  void endConversation(conversationId).catch((err) => {
    logWarn('failed to end conversation', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
