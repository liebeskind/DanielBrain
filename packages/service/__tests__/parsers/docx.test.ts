import { describe, it, expect, vi } from 'vitest';

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(),
  },
}));

import { parseDocx } from '../../src/parsers/docx.js';
import mammoth from 'mammoth';

const mockMammoth = vi.mocked(mammoth);

describe('parseDocx', () => {
  it('extracts text from a valid DOCX', async () => {
    mockMammoth.extractRawText.mockResolvedValueOnce({
      value: 'Hello from a Word document.',
      messages: [],
    });

    const result = await parseDocx(Buffer.from('fake-docx'));

    expect(result.text).toBe('Hello from a Word document.');
  });

  it('returns empty text for empty DOCX (not an error)', async () => {
    mockMammoth.extractRawText.mockResolvedValueOnce({
      value: '',
      messages: [],
    });

    const result = await parseDocx(Buffer.from('fake'));
    expect(result.text).toBe('');
  });

  it('propagates mammoth errors (corrupted file)', async () => {
    mockMammoth.extractRawText.mockRejectedValueOnce(new Error('Could not find central directory'));

    await expect(parseDocx(Buffer.from('garbage'))).rejects.toThrow('central directory');
  });
});
