import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamChat } from '../../src/chat/ollama-stream.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockRes() {
  const chunks: string[] = [];
  return {
    write: vi.fn((data: string) => chunks.push(data)),
    end: vi.fn(),
    _chunks: chunks,
  } as unknown as import('express').Response & { _chunks: string[] };
}

function makeStream(lines: string[]) {
  const encoder = new TextEncoder();
  const data = lines.join('\n') + '\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

describe('streamChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams tokens from Ollama response', async () => {
    const body = makeStream([
      JSON.stringify({ message: { content: 'Hello' }, done: false }),
      JSON.stringify({ message: { content: ' world' }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true }),
    ]);

    mockFetch.mockResolvedValue({ ok: true, body });
    const res = mockRes();

    await streamChat(
      [{ role: 'user', content: 'hi' }],
      'llama3.3:70b',
      'http://localhost:11434',
      res,
    );

    expect(res.write).toHaveBeenCalledWith('data: {"token":"Hello"}\n\n');
    expect(res.write).toHaveBeenCalledWith('data: {"token":" world"}\n\n');
    expect(res.write).toHaveBeenCalledWith('data: [DONE]\n\n');
    expect(res.end).toHaveBeenCalled();
  });

  it('returns accumulated full response', async () => {
    const body = makeStream([
      JSON.stringify({ message: { content: 'Hello' }, done: false }),
      JSON.stringify({ message: { content: ' world' }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true }),
    ]);

    mockFetch.mockResolvedValue({ ok: true, body });
    const res = mockRes();

    const result = await streamChat(
      [{ role: 'user', content: 'hi' }],
      'llama3.3:70b',
      'http://localhost:11434',
      res,
    );

    expect(result.fullResponse).toBe('Hello world');
  });

  it('sends error on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'model not found',
    });
    const res = mockRes();

    await streamChat(
      [{ role: 'user', content: 'hi' }],
      'bad-model',
      'http://localhost:11434',
      res,
    );

    expect(res._chunks[0]).toContain('error');
    expect(res._chunks[0]).toContain('500');
    expect(res.end).toHaveBeenCalled();
  });

  it('sends correct request to Ollama', async () => {
    const body = makeStream([JSON.stringify({ message: { content: '' }, done: true })]);
    mockFetch.mockResolvedValue({ ok: true, body });
    const res = mockRes();

    const messages = [
      { role: 'system' as const, content: 'You are helpful' },
      { role: 'user' as const, content: 'hello' },
    ];

    await streamChat(messages, 'llama3.3:70b', 'http://localhost:11434', res);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.3:70b', messages, stream: true }),
      signal: expect.any(AbortSignal),
    });
  });
});
