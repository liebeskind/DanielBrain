import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSlackEvent } from '../../src/slack/webhook.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleSlackEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [{ id: 'queue-uuid-1' }] });
  });

  it('responds to URL verification challenge', async () => {
    const result = await handleSlackEvent(
      {
        type: 'url_verification',
        challenge: 'test-challenge-token',
      },
      mockPool as any
    );

    expect(result).toEqual({ challenge: 'test-challenge-token' });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('queues message events', async () => {
    const result = await handleSlackEvent(
      {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'My thought from Slack',
          user: 'U12345',
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true });
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO queue'),
      expect.arrayContaining(['My thought from Slack'])
    );
  });

  it('ignores bot messages', async () => {
    const result = await handleSlackEvent(
      {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'Bot reply',
          bot_id: 'B12345',
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('ignores message subtypes (edits, deletes, etc)', async () => {
    const result = await handleSlackEvent(
      {
        type: 'event_callback',
        event: {
          type: 'message',
          subtype: 'message_changed',
          text: 'Edited text',
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('stores source_meta with channel and user info', async () => {
    await handleSlackEvent(
      {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'Important thought',
          user: 'U12345',
          channel: 'C12345',
          ts: '1234567890.123456',
          thread_ts: '1234567890.000000',
        },
      },
      mockPool as any
    );

    const callArgs = mockPool.query.mock.calls[0][1];
    const sourceMeta = JSON.parse(callArgs[2]);
    expect(sourceMeta.channel).toBe('C12345');
    expect(sourceMeta.user).toBe('U12345');
    expect(sourceMeta.thread_ts).toBe('1234567890.000000');
  });
});
