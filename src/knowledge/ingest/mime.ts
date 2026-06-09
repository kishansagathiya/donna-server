const EXTENSION_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.gif': 'image/gif',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.swift': 'text/plain',
  '.rb': 'text/plain',
  '.sql': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.xml': 'text/xml',
};

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.java', '.swift', '.rb', '.sql', '.yaml', '.yml', '.xml',
]);

function mimeFromExtension(filename?: string): string | null {
  if (!filename) return null;
  const lower = filename.toLowerCase();
  for (const [ext, mime] of Object.entries(EXTENSION_MIME)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

function sniffFromMagic(buffer: Buffer, filename?: string): string | null {
  if (buffer.length < 4) return null;

  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
    return 'application/pdf';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }

  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.length >= 12) {
    const form = buffer.subarray(8, 12).toString('ascii');
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'WEBP') return 'image/webp';
  }

  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    return 'audio/mpeg';
  }

  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }

  if (buffer.subarray(0, 4).toString('ascii') === 'ftyp') {
    return 'audio/mp4';
  }

  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const extMime = mimeFromExtension(filename);
    if (extMime) return extMime;
  }

  return null;
}

function isValidUtf8Text(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  if (sample.includes('\uFFFD')) return false;
  const controlChars = sample.replace(/[\n\r\t]/g, '').split('').filter((c) => {
    const code = c.charCodeAt(0);
    return code < 32;
  });
  return controlChars.length < sample.length * 0.05;
}

export function resolveMime(
  buffer: Buffer,
  contentType?: string,
  filename?: string,
): string {
  const magic = sniffFromMagic(buffer, filename);
  if (magic) return magic;

  const headerMime =
    contentType && contentType !== 'application/octet-stream'
      ? contentType.split(';')[0]?.trim()
      : null;

  const extMime = mimeFromExtension(filename);

  if (headerMime && headerMime !== 'application/octet-stream') {
    return headerMime;
  }

  if (extMime) return extMime;

  if (filename) {
    const ext = '.' + (filename.split('.').pop()?.toLowerCase() ?? '');
    if (CODE_EXTENSIONS.has(ext) && isValidUtf8Text(buffer)) {
      return 'text/plain';
    }
  }

  if (isValidUtf8Text(buffer)) return 'text/plain';

  return 'application/octet-stream';
}

export function assetKindFromMime(mime: string): import('./types.js').AssetKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'text/plain' || mime === 'text/markdown') return 'text';
  return 'document';
}

export function listSupportedMimeTypes(): string[] {
  return [...new Set(Object.values(EXTENSION_MIME))].sort();
}
