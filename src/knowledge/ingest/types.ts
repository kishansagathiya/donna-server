export type AssetKind = 'document' | 'link' | 'image' | 'audio' | 'text';

export type ExtractedAsset = {
  content: string;
  assetKind: AssetKind;
  mimeType: string;
  extractor: string;
  title?: string;
};

export type ExtractContext = {
  buffer: Buffer;
  mime: string;
  filename?: string;
};

export type AssetExtractor = {
  name: string;
  priority: number;
  canHandle: (mime: string, filename?: string) => boolean;
  extract: (ctx: ExtractContext) => Promise<ExtractedAsset>;
};
