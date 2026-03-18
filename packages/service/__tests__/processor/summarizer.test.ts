import { describe, it, expect, vi, beforeEach } from 'vitest';
import { summarize } from '../../src/processor/summarizer.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('summarize', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('produces summary from Ollama', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: 'This is a concise summary of the long content.',
          },
        }),
    });

    const result = await summarize('A very long piece of text that needs summarizing...', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.3:70b',
    });

    expect(result).toBe('This is a concise summary of the long content.');
  });

  it('sends correct prompt to Ollama', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: 'Summary' },
        }),
    });

    await summarize('Input text', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.3:70b',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.model).toBe('llama3.3:70b');
    expect(callBody.stream).toBe(false);
    // System message should ask for a summary
    const systemMsg = callBody.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg).toBeDefined();
  });

  it('uses detailed system prompt with knowledge management context', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: 'Summary' },
        }),
    });

    await summarize('Input text', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.3:70b',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = callBody.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg.content).toContain('knowledge management');
    expect(systemMsg.content).toContain('2-3 sentences');
    expect(systemMsg.content).toContain('Name specific people');
  });

  it('includes timeout signal in fetch call', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: 'Summary' },
        }),
    });

    await summarize('Input text', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.3:70b',
    });

    expect(mockFetch.mock.calls[0][1].signal).toBeDefined();
  });

  it('throws on Ollama error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Error'),
    });

    await expect(
      summarize('Text', {
        ollamaBaseUrl: 'http://localhost:11434',
        extractionModel: 'llama3.3:70b',
      })
    ).rejects.toThrow();
  });
});
