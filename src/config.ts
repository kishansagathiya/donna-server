import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '') ?? '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const config = {
  host: process.env.DONNA_HOST ?? '0.0.0.0',
  port: Number(process.env.DONNA_PORT ?? 8787),
  supabaseUrl,
  supabaseServiceRoleKey,
  jwtAudience: process.env.JWT_AUDIENCE ?? 'authenticated',
  requireAuth: !!supabaseUrl,
  persistConversations: !!supabaseUrl && !!supabaseServiceRoleKey,
  persistKnowledge: !!supabaseUrl && !!supabaseServiceRoleKey,
  openRouterApiKey: required('OPENROUTER_API_KEY'),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  cartesiaApiKey: process.env.CARTESIA_API_KEY ?? '',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
  llmModel:
    process.env.DONNA_LLM_MODEL ?? 'deepseek/deepseek-v4-flash',
  sttModel:
    process.env.DONNA_STT_MODEL ?? 'mistralai/voxtral-mini-transcribe',
  systemPrompt:
    process.env.DONNA_SYSTEM_PROMPT ??
    'You are Donna, a warm and concise voice assistant. Keep replies short and conversational — one or two sentences unless the user asks for detail. Never ask the user to repeat themselves. If input is unclear, give your best short guess or a brief helpful reply.',
  maxHistoryMessages: 20,
};
