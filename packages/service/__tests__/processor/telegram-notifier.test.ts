import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyTelegram } from '../../src/processor/telegram-notifier.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('notifyTelegram', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls Telegram sendMessage API with correct chat_id and reply_to_message_id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyTelegram({
      chatId: 12345,
      replyToMessageId: 42,
      metadata: {
        thought_type: 'idea',
        people: ['Alice'],
        topics: ['AI'],
        action_items: ['Research'],
        dates_mentioned: [],
        sentiment: 'positive',
        summary: 'An idea about AI',
      },
      botToken: '123456:ABC-DEF',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:ABC-DEF/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe(12345);
    expect(body.reply_to_message_id).toBe(42);
    expect(body.text).toContain('idea');
  });

  it('formats metadata summary', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifyTelegram({
      chatId: 12345,
      replyToMessageId: 42,
      metadata: {
        thought_type: 'task',
        people: ['Bob', 'Carol'],
        topics: ['Backend', 'API'],
        action_items: ['Deploy', 'Test'],
        dates_mentioned: [],
        sentiment: 'neutral',
        summary: 'Backend deployment plan',
      },
      botToken: '123456:ABC-DEF',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toContain('Captured and processed.');
    expect(body.text).toContain('People: Bob, Carol');
    expect(body.text).toContain('Topics: Backend, API');
    expect(body.text).toContain('Action items: 2');
    expect(body.text).toContain('Summary: Backend deployment plan');
  });

  it('does not throw on API error (best-effort)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      notifyTelegram({
        chatId: 12345,
        replyToMessageId: 42,
        metadata: {
          thought_type: null,
          people: [],
          topics: [],
          action_items: [],
          dates_mentioned: [],
          sentiment: null,
          summary: null,
        },
        botToken: '123456:ABC-DEF',
      })
    ).resolves.not.toThrow();
  });
});
