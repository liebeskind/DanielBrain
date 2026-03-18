import pdfParse from 'pdf-parse';

export interface PdfResult {
  text: string;
  title?: string;
  author?: string;
  pageCount?: number;
  creationDate?: string;
  keywords?: string[];
}

export async function parsePdf(buffer: Buffer): Promise<PdfResult> {
  const result = await pdfParse(buffer);

  const text = result.text || '';
  const pageCount = result.numpages || 0;

  // Scanned/image-only PDF detection
  if (text.trim().length < 50 && pageCount > 0) {
    throw new Error(
      'This PDF appears to be scanned/image-only. Please use a born-digital PDF or export as text.'
    );
  }

  const info = result.info || {};

  return {
    text,
    title: info.Title || undefined,
    author: info.Author || undefined,
    pageCount,
    creationDate: info.CreationDate || undefined,
    keywords: info.Keywords
      ? info.Keywords.split(/[,;]/).map((k: string) => k.trim()).filter(Boolean)
      : undefined,
  };
}
