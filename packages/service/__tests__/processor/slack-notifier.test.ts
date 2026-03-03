import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifySlack } from '../../src/processor/slack-notifier.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('notifySlack', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts thread reply with metadata summary', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await notifySlack({
      channel: 'C12345',
      threadTs: '1234567890.123456',
      metadata: {
        thought_type: 'idea',
        people: ['Alice'],
        topics: ['AI'],
        action_items: ['Research'],
        dates_mentioned: [],
        sentiment: 'positive',
        summary: 'An idea about AI',
      },
      slackBotToken: 'xoxb-test',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-test',
        }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe('C12345');
    expect(body.thread_ts).toBe('1234567890.123456');
    expect(body.text).toContain('idea');
  });

  it('handles Slack API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    // Should not throw — notification is best-effort
    await expect(
      notifySlack({
        channel: 'C12345',
        threadTs: '1234567890.123456',
        metadata: {
          thought_type: null,
          people: [],
          topics: [],
          action_items: [],
          dates_mentioned: [],
          sentiment: null,
          summary: null,
        },
        slackBotToken: 'xoxb-test',
      })
    ).resolves.not.toThrow();
  });
});
