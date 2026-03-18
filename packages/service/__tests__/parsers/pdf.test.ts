import { describe, it, expect, vi } from 'vitest';

// Mock pdf-parse before importing our module
vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}));

import { parsePdf } from '../../src/parsers/pdf.js';
import pdfParse from 'pdf-parse';

const mockPdfParse = vi.mocked(pdfParse);

describe('parsePdf', () => {
  it('parses a valid PDF and returns text + metadata', async () => {
    mockPdfParse.mockResolvedValueOnce({
      text: 'Hello world. This is a test document with enough text to pass the threshold.',
      numpages: 3,
      numrender: 3,
      info: {
        Title: 'Test Doc',
        Author: 'Alice',
        CreationDate: 'D:20250101120000',
        Keywords: 'test, document, pdf',
      },
      metadata: null,
      version: '1.4',
    });

    const result = await parsePdf(Buffer.from('fake-pdf'));

    expect(result.text).toContain('Hello world');
    expect(result.title).toBe('Test Doc');
    expect(result.author).toBe('Alice');
    expect(result.pageCount).toBe(3);
    expect(result.creationDate).toBe('D:20250101120000');
    expect(result.keywords).toEqual(['test', 'document', 'pdf']);
  });

  it('returns undefined for missing metadata fields', async () => {
    mockPdfParse.mockResolvedValueOnce({
      text: 'Some content that is long enough to not be flagged as scanned.',
      numpages: 1,
      numrender: 1,
      info: {},
      metadata: null,
      version: '1.4',
    });

    const result = await parsePdf(Buffer.from('fake'));

    expect(result.title).toBeUndefined();
    expect(result.author).toBeUndefined();
    expect(result.keywords).toBeUndefined();
  });

  it('throws for scanned/image-only PDF (low text, multiple pages)', async () => {
    mockPdfParse.mockResolvedValueOnce({
      text: '   ',
      numpages: 5,
      numrender: 5,
      info: {},
      metadata: null,
      version: '1.4',
    });

    await expect(parsePdf(Buffer.from('fake'))).rejects.toThrow('scanned/image-only');
  });

  it('propagates pdf-parse errors (corrupted file)', async () => {
    mockPdfParse.mockRejectedValueOnce(new Error('Invalid PDF structure'));

    await expect(parsePdf(Buffer.from('not-a-pdf'))).rejects.toThrow('Invalid PDF structure');
  });
});
