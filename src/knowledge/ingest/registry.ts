import { FILE_EXTRACTORS } from './extractors/index.js';
import { resolveMime, listSupportedMimeTypes } from './mime.js';
import type { ExtractedAsset, ExtractContext } from './types.js';

export async function dispatchFileExtraction(input: {
  buffer: Buffer;
  contentType?: string;
  filename?: string;
}): Promise<ExtractedAsset> {
  const mime = resolveMime(input.buffer, input.contentType, input.filename);
  const ctx: ExtractContext = {
    buffer: input.buffer,
    mime,
    filename: input.filename,
  };

  const matches = FILE_EXTRACTORS.filter((e) =>
    e.canHandle(mime, input.filename),
  );
  const match = matches.sort((a, b) => b.priority - a.priority)[0];
  if (!match) {
    throw new Error(`Unsupported file type: ${mime}`);
  }

  return match.extract(ctx);
}

export function getSupportedFormats(): {
  mime_types: string[];
  extractors: Array<{ name: string; priority: number }>;
} {
  return {
    mime_types: listSupportedMimeTypes(),
    extractors: FILE_EXTRACTORS.map((e) => ({
      name: e.name,
      priority: e.priority,
    })),
  };
}
