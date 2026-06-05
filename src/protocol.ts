export type TurnPhase =
  | 'idle'
  | 'busy'
  | 'transcribing'
  | 'generating'
  | 'synthesizing'
  | 'done'
  | 'error';

export type ClientMessage =
  | { type: 'session.start'; userId?: string; sessionId?: string }
  | {
      type: 'audio.chunk';
      seq: number;
      format: 'pcm16';
      sampleRate: number;
      channels: number;
      data: string;
    }
  | { type: 'turn.end' }
  | { type: 'session.end' };

export type ServerMessage =
  | { type: 'session.ready'; sessionId: string; userId: string }
  | { type: 'turn.phase'; phase: TurnPhase }
  | { type: 'turn.transcript'; text: string }
  | { type: 'turn.reply'; text: string }
  | {
      type: 'audio.out';
      seq: number;
      format: 'mp3' | 'wav';
      data: string;
    }
  | {
      type: 'turn.done';
      timings: {
        sttMs: number;
        augmentMs: number;
        llmFirstTokenMs: number;
        ttsFirstByteMs: number;
        totalMs: number;
      };
    }
  | { type: 'error'; code: string; message: string };

export function parseClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as { type?: string };
  if (!parsed?.type) {
    throw new Error('Message missing type');
  }
  return parsed as ClientMessage;
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
