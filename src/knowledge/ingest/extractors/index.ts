import { completeOnceVision } from '../../../pipeline/providers/llm.js';
import { transcribeAudio } from '../../../pipeline/providers/stt.js';
import { assetKindFromMime } from '../mime.js';
import type { AssetExtractor, ExtractedAsset, ExtractContext } from '../types.js';
import { clampText, htmlToText } from './shared.js';

const textExtractor: AssetExtractor = {
  name: 'plain_text',
  priority: 10,
  canHandle: (mime) =>
    (mime.startsWith('text/') &&
      mime !== 'text/html' &&
      mime !== 'text/csv') ||
    mime === 'application/xml' ||
    mime === 'text/xml',
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    return {
      content: clampText(buffer.toString('utf8')),
      assetKind: assetKindFromMime(mime),
      mimeType: mime,
      extractor: 'plain_text',
      title: filename,
    };
  },
};

const htmlExtractor: AssetExtractor = {
  name: 'html_strip',
  priority: 20,
  canHandle: (mime) => mime === 'text/html',
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    return {
      content: clampText(htmlToText(buffer.toString('utf8'))),
      assetKind: 'document',
      mimeType: mime,
      extractor: 'html_strip',
      title: filename,
    };
  },
};

const structuredExtractor: AssetExtractor = {
  name: 'structured_data',
  priority: 25,
  canHandle: (mime) => mime === 'application/json' || mime === 'text/csv',
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    let content: string;
    if (mime === 'application/json') {
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      content = `JSON document (${filename ?? 'data.json'}):\n${JSON.stringify(parsed, null, 2)}`;
    } else {
      content = `CSV document (${filename ?? 'data.csv'}):\n${buffer.toString('utf8')}`;
    }
    return {
      content: clampText(content),
      assetKind: 'document',
      mimeType: mime,
      extractor: 'structured_data',
      title: filename,
    };
  },
};

const pdfExtractor: AssetExtractor = {
  name: 'pdf_parse',
  priority: 30,
  canHandle: (mime) => mime === 'application/pdf',
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.text?.trim() ?? '';
      if (!text) throw new Error('No text extracted from PDF');
      return {
        content: clampText(text),
        assetKind: 'document',
        mimeType: mime,
        extractor: 'pdf_parse',
        title: filename,
      };
    } finally {
      await parser.destroy();
    }
  },
};

const docxExtractor: AssetExtractor = {
  name: 'mammoth_docx',
  priority: 35,
  canHandle: (mime) =>
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value?.trim() ?? '';
    if (!text) throw new Error('No text extracted from DOCX');
    return {
      content: clampText(text),
      assetKind: 'document',
      mimeType: mime,
      extractor: 'mammoth_docx',
      title: filename,
    };
  },
};

const imageExtractor: AssetExtractor = {
  name: 'vision_llm',
  priority: 40,
  canHandle: (mime) => mime.startsWith('image/'),
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    const description = await completeOnceVision(
      'Describe this image in detail for a personal knowledge base. Include all visible text (OCR), people, objects, diagrams, and key information. Be factual and thorough.',
      dataUrl,
    );
    return {
      content: clampText(
        [`Image: ${filename ?? 'upload'}`, '', description].join('\n'),
      ),
      assetKind: 'image',
      mimeType: mime,
      extractor: 'vision_llm',
      title: filename,
    };
  },
};

const AUDIO_FORMAT: Record<string, 'wav' | 'mp3' | 'm4a'> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
};

const audioExtractor: AssetExtractor = {
  name: 'stt_transcribe',
  priority: 50,
  canHandle: (mime) => mime.startsWith('audio/'),
  async extract({ buffer, mime, filename }): Promise<ExtractedAsset> {
    const format = AUDIO_FORMAT[mime] ?? 'mp3';
    const { transcript } = await transcribeAudio(buffer, format);
    const text = transcript.trim();
    if (!text) throw new Error('No speech detected in audio file');
    return {
      content: clampText(
        [`Audio note: ${filename ?? 'recording'}`, '', text].join('\n'),
      ),
      assetKind: 'audio',
      mimeType: mime,
      extractor: 'stt_transcribe',
      title: filename,
    };
  },
};

export const FILE_EXTRACTORS: AssetExtractor[] = [
  textExtractor,
  htmlExtractor,
  structuredExtractor,
  pdfExtractor,
  docxExtractor,
  imageExtractor,
  audioExtractor,
].sort((a, b) => a.priority - b.priority);

export async function extractTextBody(
  text: string,
  title?: string,
): Promise<ExtractedAsset> {
  return {
    content: clampText(text.trim()),
    assetKind: 'text',
    mimeType: 'text/plain',
    extractor: 'plain_text',
    title,
  };
}

export async function extractUrl(url: string): Promise<ExtractedAsset> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are supported');
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'DonnaKnowledgeBot/1.0' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch URL (${res.status})`);
  }

  const contentType = res.headers.get('content-type') ?? 'text/html';
  const body = await res.text();

  if (body.length > 2_000_000) {
    throw new Error('URL content too large');
  }

  const isHtml = contentType.includes('html') || body.trimStart().startsWith('<');
  const content = clampText(isHtml ? htmlToText(body) : body);

  if (!content) {
    throw new Error('No text content extracted from URL');
  }

  return {
    content: `# ${parsed.hostname}\nURL: ${url}\n\n${content}`,
    assetKind: 'link',
    mimeType: 'text/html',
    extractor: 'url_fetch',
    title: parsed.hostname,
  };
}
