import { randomUUID } from 'node:crypto';
import type { WSContext } from 'hono/ws';
import type { ChatMessage } from './pipeline/providers/llm.js';
import { analyzePcm16 } from './pipeline/audioQuality.js';
import { emptyTurnTimings, runVoiceTurn } from './pipeline/turn.js';
import {
  parseClientMessage,
  serializeServerMessage,
  type ServerMessage,
  type TurnPhase,
} from './protocol.js';
import { pcm16ToWav } from './wav.js';
import { config } from './config.js';
import { log, logWarn, shortId } from './log.js';
import { enqueueSessionCompile } from './knowledge/queue.js';
import {
  createConversation,
  endConversationAsync,
  isConversationPersistenceEnabled,
  persistTurnAsync,
} from './storage/conversations.js';

type AudioChunkMeta = {
  format: 'pcm16';
  sampleRate: number;
  channels: number;
};

export class VoiceSession {
  sessionId: string;
  userId: string;
  private readonly send: (message: ServerMessage) => void;
  private readonly history: ChatMessage[] = [];
  private audioChunks: Uint8Array[] = [];
  private audioMeta: AudioChunkMeta | null = null;
  private busy = false;
  private started = false;
  private chunkCount = 0;
  private totalPcmBytes = 0;
  private hasRetriedThisSession = false;
  private conversationId: string | null = null;
  private turnIndex = 0;
  private ended = false;

  constructor(
    ws: WSContext,
    initial?: { userId?: string; sessionId?: string },
  ) {
    this.sessionId = initial?.sessionId ?? randomUUID();
    this.userId = initial?.userId ?? randomUUID();
    this.send = (message) => {
      ws.send(serializeServerMessage(message));
    };
  }

  async handleMessage(raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') {
      this.sendError('invalid_message', 'Expected JSON text frame');
      return;
    }

    let message;
    try {
      message = parseClientMessage(raw);
    } catch {
      this.sendError('invalid_message', 'Malformed JSON message');
      return;
    }

    switch (message.type) {
      case 'session.start':
        log('← session.start', { session: shortId(this.sessionId) });
        await this.handleSessionStart(message);
        break;
      case 'audio.chunk':
        this.handleAudioChunk(message);
        break;
      case 'turn.end':
        log('← turn.end', {
          session: shortId(this.sessionId),
          chunks: this.chunkCount,
          pcmBytes: this.totalPcmBytes,
        });
        await this.handleTurnEnd();
        break;
      case 'session.end':
        log('← session.end', { session: shortId(this.sessionId) });
        this.resetTurnBuffer();
        this.sendPhase('idle');
        this.end();
        break;
      default:
        this.sendError('unknown_type', 'Unknown message type');
    }
  }

  private async handleSessionStart(message: {
    userId?: string;
    sessionId?: string;
  }): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.hasRetriedThisSession = false;
    if (message.userId) this.userId = message.userId;
    if (message.sessionId) this.sessionId = message.sessionId;
    this.send({
      type: 'session.ready',
      sessionId: this.sessionId,
      userId: this.userId,
    });
    this.sendPhase('idle');
    log('→ session.ready', {
      session: shortId(this.sessionId),
      user: shortId(this.userId),
    });

    if (isConversationPersistenceEnabled() && config.requireAuth) {
      try {
        this.conversationId = await createConversation(
          this.userId,
          this.sessionId,
        );
      } catch (err) {
        logWarn('failed to create conversation', {
          session: shortId(this.sessionId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.conversationId) {
      const conversationId = this.conversationId;
      endConversationAsync(conversationId);
      enqueueSessionCompile(this.userId, conversationId);
    }
  }

  private handleAudioChunk(message: {
    seq: number;
    format: 'pcm16';
    sampleRate: number;
    channels: number;
    data: string;
  }): void {
    if (!this.started) {
      logWarn('audio.chunk rejected — session not started', {
        session: shortId(this.sessionId),
        seq: message.seq,
      });
      this.sendError('not_started', 'Send session.start before audio.chunk');
      return;
    }
    if (this.busy) {
      logWarn('audio.chunk ignored — turn in progress', {
        session: shortId(this.sessionId),
        seq: message.seq,
      });
      this.sendPhase('busy');
      return;
    }

    if (!this.audioMeta) {
      this.audioMeta = {
        format: message.format,
        sampleRate: message.sampleRate,
        channels: message.channels,
      };
    }

    const pcm = Buffer.from(message.data, 'base64');
    this.audioChunks.push(pcm);
    this.chunkCount += 1;
    this.totalPcmBytes += pcm.length;

    if (this.chunkCount === 1) {
      log('← audio.chunk (first)', {
        session: shortId(this.sessionId),
        seq: message.seq,
        bytes: pcm.length,
        sampleRate: message.sampleRate,
        channels: message.channels,
      });
    } else if (this.chunkCount % 10 === 0) {
      const seconds = estimatePcmSeconds(
        this.totalPcmBytes,
        this.audioMeta.sampleRate,
        this.audioMeta.channels,
      );
      log('← audio.chunk (buffering)', {
        session: shortId(this.sessionId),
        chunks: this.chunkCount,
        pcmBytes: this.totalPcmBytes,
        approxSeconds: seconds,
        lastSeq: message.seq,
      });
    }
  }

  private async handleTurnEnd(): Promise<void> {
    if (!this.started) {
      this.sendError('not_started', 'Send session.start before turn.end');
      return;
    }
    if (this.busy) {
      this.sendPhase('busy');
      return;
    }

    if (!this.audioMeta || this.audioChunks.length === 0) {
      logWarn('turn.end with no audio buffered', {
        session: shortId(this.sessionId),
        chunks: this.chunkCount,
      });
      this.sendError('empty_audio', 'No audio buffered for this turn');
      return;
    }

    const pcm = concatChunks(this.audioChunks);
    const audioMeta = this.audioMeta;
    const quality = analyzePcm16(
      pcm,
      audioMeta.sampleRate,
      audioMeta.channels,
    );
    const approxSeconds = estimatePcmSeconds(
      pcm.length,
      audioMeta.sampleRate,
      audioMeta.channels,
    );
    const committedChunks = this.chunkCount;
    const committedPcmBytes = pcm.length;
    this.resetTurnBuffer();
    this.busy = true;

    if (!quality.shouldProcess) {
      try {
        log('turn skipped — audio quality gate', {
          session: shortId(this.sessionId),
          reason: quality.reason,
          approxSeconds,
          avgRms: quality.avgRms,
          peakRms: quality.peakRms,
        });
        this.send({
          type: 'turn.done',
          timings: emptyTurnTimings(),
          skipped: true,
        });
        this.sendPhase('idle');
      } finally {
        this.busy = false;
      }
      return;
    }

    const wav = pcm16ToWav(pcm, audioMeta);
    log('turn commit — running pipeline', {
      session: shortId(this.sessionId),
      chunks: committedChunks,
      pcmBytes: committedPcmBytes,
      wavBytes: wav.length,
      approxSeconds,
    });

    try {
      const result = await runVoiceTurn(
        wav,
        this.history.slice(),
        {
          onPhase: (phase) => this.sendPhase(phase),
          onTranscript: (text) =>
            this.send({ type: 'turn.transcript', text }),
          onReply: (text) => this.send({ type: 'turn.reply', text }),
          onAudioChunk: ({ seq, format, data }) =>
            this.send({
              type: 'audio.out',
              seq,
              format,
              data: Buffer.from(data).toString('base64'),
            }),
        },
        {
          audioMeta: quality,
          canRetry: !this.hasRetriedThisSession,
          userId: this.userId,
          sessionId: this.sessionId,
        },
      );

      if (result.usedRetry) {
        this.hasRetriedThisSession = true;
      }

      if (result.transcript.trim() && !result.skipped && !result.usedRetry) {
        this.appendHistory(result.transcript, result.replyText);
      }

      log('turn complete', {
        session: shortId(this.sessionId),
        transcript: result.transcript,
        replyPreview: result.replyText.slice(0, 80),
        skipped: result.skipped,
        skipReason: result.skipReason,
        timings: result.timings,
      });
      this.send({
        type: 'turn.done',
        timings: result.timings,
        skipped: result.skipped,
      });
      this.sendPhase('idle');

      if (
        this.conversationId &&
        result.transcript.trim() &&
        !result.skipped &&
        !result.usedRetry &&
        result.assistantAudio
      ) {
        const conversationId = this.conversationId;
        const turnIndex = this.turnIndex;
        this.turnIndex += 1;
        persistTurnAsync({
          conversationId,
          userId: this.userId,
          turnIndex,
          userTranscript: result.transcript,
          assistantTranscript: result.replyText,
          userWav: wav,
          assistantAudio: result.assistantAudio.data,
          assistantFormat: result.assistantAudio.format,
          timings: result.timings,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Turn processing failed';
      logWarn('turn failed', {
        session: shortId(this.sessionId),
        error: message,
      });
      this.sendPhase('error');
      this.sendError('turn_failed', message);
      this.sendPhase('idle');
    } finally {
      this.busy = false;
    }
  }

  private appendHistory(transcript: string, replyText: string): void {
    this.history.push({ role: 'user', content: transcript });
    this.history.push({ role: 'assistant', content: replyText });
    while (this.history.length > config.maxHistoryMessages) {
      this.history.shift();
    }
  }

  private resetTurnBuffer(): void {
    this.audioChunks = [];
    this.audioMeta = null;
    this.chunkCount = 0;
    this.totalPcmBytes = 0;
  }

  private sendPhase(phase: TurnPhase): void {
    if (
      phase === 'transcribing' ||
      phase === 'generating' ||
      phase === 'synthesizing' ||
      phase === 'error'
    ) {
      log(`→ turn.phase ${phase}`, { session: shortId(this.sessionId) });
    }
    this.send({ type: 'turn.phase', phase });
  }

  private sendError(code: string, message: string): void {
    logWarn('→ error', {
      session: shortId(this.sessionId),
      code,
      message,
    });
    this.send({ type: 'error', code, message });
  }
}

function estimatePcmSeconds(
  pcmBytes: number,
  sampleRate: number,
  channels: number,
): number {
  const bytesPerSecond = sampleRate * channels * 2;
  return Math.round((pcmBytes / bytesPerSecond) * 10) / 10;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
