#!/usr/bin/env node
/**
 * End-to-end voice session test without the iOS app.
 *
 * Usage:
 *   npm run dev:server   # in another terminal
 *   npm run test:voice
 *
 * Optional:
 *   DONNA_WS_URL=ws://localhost:8787/voice
 *   DONNA_SAMPLE_WAV=business-tech-thoughts/voice/samples/utterance-1.wav
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const wsUrl = process.env.DONNA_WS_URL ?? 'ws://localhost:8787/voice';
const samplePath =
  process.env.DONNA_SAMPLE_WAV ??
  path.join(repoRoot, 'business-tech-thoughts/voice/samples/utterance-1.wav');
const outPath = path.join(repoRoot, 'business-tech-thoughts/voice/ws-test-reply.bin');

function parseWavPcm16(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit PCM, got ${bitsPerSample}`);
  }

  let dataOffset = 12;
  while (dataOffset < buffer.length - 8) {
    const chunkId = String.fromCharCode(
      buffer[dataOffset],
      buffer[dataOffset + 1],
      buffer[dataOffset + 2],
      buffer[dataOffset + 3],
    );
    const chunkSize = view.getUint32(dataOffset + 4, true);
    if (chunkId === 'data') {
      const pcm = buffer.subarray(dataOffset + 8, dataOffset + 8 + chunkSize);
      return { pcm, sampleRate, channels };
    }
    dataOffset += 8 + chunkSize;
  }
  throw new Error('WAV data chunk not found');
}

function send(ws, message) {
  ws.send(JSON.stringify(message));
}

function waitFor(ws, predicate, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for server message`));
    }, timeoutMs);

    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };

    ws.on('message', onMessage);
  });
}

async function main() {
  const wavBuffer = await fs.readFile(samplePath);
  const { pcm, sampleRate, channels } = parseWavPcm16(wavBuffer);
  const chunkSize = 3200;
  const audioChunks = [];

  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    audioChunks.push(pcm.subarray(offset, offset + chunkSize));
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'turn.phase') {
      console.log(`phase: ${message.phase}`);
    } else if (message.type === 'turn.transcript') {
      console.log(`transcript: ${message.text}`);
    } else if (message.type === 'turn.reply') {
      console.log(`reply: ${message.text}`);
    } else if (message.type === 'error') {
      console.error(`error [${message.code}]: ${message.message}`);
    }
  });

  send(ws, { type: 'session.start' });
  await waitFor(ws, (m) => m.type === 'session.ready');
  console.log('session ready');

  for (let seq = 0; seq < audioChunks.length; seq++) {
    send(ws, {
      type: 'audio.chunk',
      seq,
      format: 'pcm16',
      sampleRate,
      channels,
      data: Buffer.from(audioChunks[seq]).toString('base64'),
    });
  }

  send(ws, { type: 'turn.end' });

  const audioOut = [];
  let format = 'mp3';

  while (true) {
    const message = await waitFor(
      ws,
      (m) => m.type === 'audio.out' || m.type === 'turn.done' || m.type === 'error',
    );
    if (message.type === 'error') {
      throw new Error(`${message.code}: ${message.message}`);
    }
    if (message.type === 'audio.out') {
      format = message.format;
      audioOut.push(Buffer.from(message.data, 'base64'));
    }
    if (message.type === 'turn.done') {
      console.log('timings:', message.timings);
      break;
    }
  }

  const output = Buffer.concat(audioOut);
  await fs.writeFile(outPath, output);
  console.log(`wrote ${output.length} bytes (${format}) to ${outPath}`);

  send(ws, { type: 'session.end' });
  ws.close();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
