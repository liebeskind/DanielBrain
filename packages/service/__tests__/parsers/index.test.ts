import { describe, it, expect, vi } from 'vitest';

// Mock dependencies
vi.mock('../../src/parsers/pdf.js', () => ({
  parsePdf: vi.fn(),
}));
vi.mock('../../src/parsers/docx.js', () => ({
  parseDocx: vi.fn(),
}));
vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

import { parseFile } from '../../src/parsers/index.js';
import { parsePdf } from '../../src/parsers/pdf.js';
import { parseDocx } from '../../src/parsers/docx.js';
import { fileTypeFromBuffer } from 'file-type';

const mockParsePdf = vi.mocked(parsePdf);
const mockParseDocx = vi.mocked(parseDocx);
const mockFileType = vi.mocked(fileTypeFromBuffer);

describe('parseFile', () => {
  describe('PDF files', () => {
    it('accepts PDF with matching magic bytes', async () => {
      mockFileType.mockResolvedValueOnce({ ext: 'pdf', mime: 'application/pdf' } as any);
      mockParsePdf.mockResolvedValueOnce({
        text: 'Hello   world\n\n\n\ntest',
        title: 'My Doc',
        pageCount: 2,
      });

      const result = await parseFile(Buffer.from('fake'), 'report.pdf');

      expect(result.title).toBe('My Doc');
      expect(result.text).toBe('Hello world\n\ntest'); // cleaned up
      expect(result.pageCount).toBe(2);
    });

    it('rejects PDF with mismatched magic bytes', async () => {
      mockFileType.mockResolvedValueOnce({ ext: 'exe', mime: 'application/x-msdownload' } as any);

      await expect(parseFile(Buffer.from('MZ'), 'fake.pdf')).rejects.toThrow('magic byte mismatch');
    });

    it('rejects PDF with no detected type', async () => {
      mockFileType.mockResolvedValueOnce(undefined as any);

      await expect(parseFile(Buffer.from('random'), 'mystery.pdf')).rejects.toThrow('magic byte mismatch');
    });
  });

  describe('DOCX files', () => {
    it('accepts DOCX with ZIP magic bytes', async () => {
      mockFileType.mockResolvedValueOnce({ ext: 'zip', mime: 'application/zip' } as any);
      mockParseDocx.mockResolvedValueOnce({ text: 'Document  content' });

      const result = await parseFile(Buffer.from('fake'), 'notes.docx');

      expect(result.text).toBe('Document content'); // cleaned up
    });

    it('accepts DOCX with docx-specific detection', async () => {
      mockFileType.mockResolvedValueOnce({ ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as any);
      mockParseDocx.mockResolvedValueOnce({ text: 'Content' });

      const result = await parseFile(Buffer.from('fake'), 'doc.docx');
      expect(result.text).toBe('Content');
    });

    it('rejects DOCX with mismatched magic bytes', async () => {
      mockFileType.mockResolvedValueOnce({ ext: 'png', mime: 'image/png' } as any);

      await expect(parseFile(Buffer.from('PNG'), 'fake.docx')).rejects.toThrow('magic byte mismatch');
    });
  });

  describe('Text files', () => {
    it('decodes UTF-8 text files', async () => {
      const buf = Buffer.from('Hello\n\n\n\nworld');
      const result = await parseFile(buf, 'notes.txt');

      expect(result.text).toBe('Hello\n\nworld'); // cleaned up
    });

    it('handles .md files', async () => {
      const result = await parseFile(Buffer.from('# Title'), 'readme.md');
      expect(result.text).toBe('# Title');
    });

    it('handles .csv files', async () => {
      const result = await parseFile(Buffer.from('a,b,c'), 'data.csv');
      expect(result.text).toBe('a,b,c');
    });
  });

  describe('Unsupported types', () => {
    it('throws for unknown extensions', async () => {
      await expect(parseFile(Buffer.from('data'), 'file.xyz')).rejects.toThrow('Unsupported file type: .xyz');
    });

    it('throws for image files', async () => {
      await expect(parseFile(Buffer.from('data'), 'photo.png')).rejects.toThrow('Unsupported file type: .png');
    });
  });
});
