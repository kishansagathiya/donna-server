import type { Context } from 'hono';
import { extractTextBody, extractUrl } from './extractors/index.js';
import { dispatchFileExtraction, getSupportedFormats } from './registry.js';
import type { ExtractedAsset } from './types.js';
import {
  insertAssetSource,
  isKnowledgeEnabled,
  logKnowledge,
  uploadAssetFile,
} from '../../storage/knowledge.js';
import { enqueueAssetCompile } from '../queue.js';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

async function persistAndQueue(input: {
  userId: string;
  extracted: ExtractedAsset;
  originalFilename?: string;
  storagePath?: string;
  sourceUrl?: string | null;
}): Promise<{ source_id: string; asset_kind: string; title: string | null }> {
  const sourceId = await insertAssetSource({
    userId: input.userId,
    content: input.extracted.content,
    metadata: {
      asset_kind: input.extracted.assetKind,
      mime_type: input.extracted.mimeType,
      original_filename:
        input.originalFilename ?? input.extracted.title ?? null,
      storage_path: input.storagePath ?? null,
      url: input.sourceUrl ?? null,
      extractor: input.extracted.extractor,
      title: input.extracted.title ?? null,
      extracted_at: new Date().toISOString(),
    },
  });

  enqueueAssetCompile(input.userId, sourceId);

  logKnowledge('asset ingested', {
    userId: input.userId.slice(0, 8),
    sourceId,
    assetKind: input.extracted.assetKind,
    extractor: input.extracted.extractor,
  });

  return {
    source_id: sourceId,
    asset_kind: input.extracted.assetKind,
    title: input.extracted.title ?? input.originalFilename ?? null,
  };
}

export function handleKnowledgeFormats(c: Context): Response {
  return c.json(getSupportedFormats());
}

export async function handleKnowledgeIngest(c: Context): Promise<Response> {
  if (!isKnowledgeEnabled()) {
    return c.json({ error: 'knowledge_disabled' }, 503);
  }

  const userId = c.get('userId') as string;
  const contentType = c.req.header('content-type') ?? '';

  try {
    let extracted: ExtractedAsset;
    let storagePath: string | undefined;
    let originalFilename: string | undefined;
    let sourceUrl: string | null = null;

    if (contentType.includes('application/json')) {
      const body = await c.req.json<{
        url?: string;
        text?: string;
        title?: string;
      }>();

      if (body.url?.trim()) {
        sourceUrl = body.url.trim();
        extracted = await extractUrl(sourceUrl);
        originalFilename = sourceUrl;
      } else if (body.text?.trim()) {
        extracted = await extractTextBody(body.text, body.title);
        originalFilename = body.title ?? 'note.txt';
      } else {
        return c.json(
          { error: 'invalid_body', message: 'Provide url or text' },
          422,
        );
      }
    } else if (contentType.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form.file;

      if (!file || typeof file === 'string') {
        return c.json({ error: 'missing_file' }, 422);
      }

      const blob = file as File;
      if (blob.size > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'file_too_large' }, 413);
      }

      const buffer = Buffer.from(await blob.arrayBuffer());
      originalFilename = blob.name;
      extracted = await dispatchFileExtraction({
        buffer,
        contentType: blob.type,
        filename: blob.name,
      });

      storagePath = await uploadAssetFile({
        userId,
        filename: blob.name,
        buffer,
        mimeType: extracted.mimeType,
      });
    } else {
      return c.json({ error: 'unsupported_content_type' }, 415);
    }

    const result = await persistAndQueue({
      userId,
      extracted,
      originalFilename,
      storagePath,
      sourceUrl,
    });

    return c.json({
      ...result,
      status: 'queued',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ingest failed';
    const status = message.startsWith('Unsupported')
      ? 415
      : message.includes('too large')
        ? 413
        : 422;
    return c.json({ error: 'ingest_failed', message }, status);
  }
}
