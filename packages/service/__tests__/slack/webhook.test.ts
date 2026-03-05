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

  it('queues message events with source_id, originated_at, content_hash', async () => {
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
    const callArgs = mockPool.query.mock.calls[0];
    expect(callArgs[0]).toContain('INSERT INTO queue');
    expect(callArgs[0]).toContain('source_id');
    expect(callArgs[0]).toContain('originated_at');
    expect(callArgs[0]).toContain('content_hash');
    // content
    expect(callArgs[1][0]).toBe('My thought from Slack');
    // source
    expect(callArgs[1][1]).toBe('slack');
    // source_id
    expect(callArgs[1][2]).toBe('slack-C12345-1234567890.123456');
    // originated_at (parsed from ts)
    expect(callArgs[1][4]).toEqual(new Date(1234567890.123456 * 1000));
    // content_hash (sha256 hex string)
    expect(callArgs[1][5]).toMatch(/^[a-f0-9]{64}$/);
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

  it('stores source_meta with channel_type and structured participant', async () => {
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
    const sourceMeta = JSON.parse(callArgs[3]);
    expect(sourceMeta.channel).toBe('C12345');
    expect(sourceMeta.user).toBe('U12345');
    expect(sourceMeta.thread_ts).toBe('1234567890.000000');
    expect(sourceMeta.channel_type).toBe('public');
    expect(sourceMeta.structured.participants).toEqual([
      { name: 'U12345', platform_id: 'U12345', role: 'author' },
    ]);
  });

  it('infers dm channel_type from channel_type field', async () => {
    await handleSlackEvent(
      {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'DM thought',
          user: 'U12345',
          channel: 'D12345',
          channel_type: 'im',
          ts: '1234567890.123456',
        },
      },
      mockPool as any
    );

    const sourceMeta = JSON.parse(mockPool.query.mock.calls[0][1][3]);
    expect(sourceMeta.channel_type).toBe('dm');
  });

  it('uses ON CONFLICT with source_id for dedup', async () => {
    await handleSlackEvent(
      {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'Test',
          user: 'U12345',
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      },
      mockPool as any
    );

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('ON CONFLICT (source_id)');
  });
});
