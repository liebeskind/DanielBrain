import path from 'path';
import { parsePdf } from './pdf.js';
import { parseDocx } from './docx.js';
import { cleanupText } from './text-cleanup.js';

export interface ParseResult {
  text: string;
  title?: string;
  author?: string;
  pageCount?: number;
  creationDate?: string;
  keywords?: string[];
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'json', 'log', 'html', 'xml', 'rtf',
  'tsv', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
]);

const BINARY_FORMAT_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function parseFile(
  buffer: Buffer,
  filename: string,
  _mimetype?: string,
): Promise<ParseResult> {
  const ext = path.extname(filename).slice(1).toLowerCase();

  // Binary formats: validate magic bytes then parse
  if (ext in BINARY_FORMAT_MAP) {
    // Dynamic import for ESM-only file-type
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(buffer);

    if (ext === 'pdf') {
      if (!detected || detected.mime !== 'application/pdf') {
        throw new Error('File does not appear to be a valid PDF (magic byte mismatch).');
      }
      const result = await parsePdf(buffer);
      return { ...result, text: cleanupText(result.text) };
    }

    if (ext === 'docx') {
      // DOCX is a ZIP, file-type detects as application/zip or the OOXML mime
      if (!detected || (detected.mime !== 'application/zip' && detected.ext !== 'docx')) {
        throw new Error('File does not appear to be a valid DOCX (magic byte mismatch).');
      }
      const result = await parseDocx(buffer);
      return { text: cleanupText(result.text) };
    }
  }

  // Text formats: UTF-8 decode, no magic byte check
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = buffer.toString('utf-8');
    return { text: cleanupText(text) };
  }

  throw new Error(`Unsupported file type: .${ext}`);
}
