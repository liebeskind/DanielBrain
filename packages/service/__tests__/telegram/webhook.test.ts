import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTelegramUpdate } from '../../src/telegram/webhook.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleTelegramUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [{ id: 'queue-uuid-1' }] });
  });

  it('queues text messages with source_id, originated_at, content_hash', async () => {
    const result = await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890, username: 'daniel', first_name: 'Daniel', last_name: 'L' },
          text: 'My thought from Telegram',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true });
    const callArgs = mockPool.query.mock.calls[0];
    expect(callArgs[0]).toContain('INSERT INTO queue');
    // content
    expect(callArgs[1][0]).toBe('My thought from Telegram');
    // source
    expect(callArgs[1][1]).toBe('telegram');
    // source_id
    expect(callArgs[1][2]).toBe('telegram-12345-42');
    // originated_at
    expect(callArgs[1][4]).toEqual(new Date(1700000000 * 1000));
    // content_hash
    expect(callArgs[1][5]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extracts source_meta with channel_type and structured participant', async () => {
    await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, username: 'daniel', first_name: 'Daniel', last_name: 'L' },
          text: 'Important thought',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    const callArgs = mockPool.query.mock.calls[0][1];
    const sourceMeta = JSON.parse(callArgs[3]);
    expect(sourceMeta.chat_id).toBe(12345);
    expect(sourceMeta.message_id).toBe(42);
    expect(sourceMeta.from_id).toBe(67890);
    expect(sourceMeta.from_username).toBe('daniel');
    expect(sourceMeta.channel_type).toBe('dm');
    expect(sourceMeta.structured.participants).toEqual([
      { name: 'Daniel L', platform_id: '67890', role: 'author' },
    ]);
  });

  it('ignores messages without text', async () => {
    const result = await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890 },
          date: 1700000000,
          // no text — photo, sticker, etc.
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('ignores bot commands (messages starting with /)', async () => {
    const result = await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890 },
          text: '/start',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('ignores updates without message (edited_message, channel_post, etc.)', async () => {
    const result = await handleTelegramUpdate(
      {
        update_id: 1,
        edited_message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890 },
          text: 'Edited text',
          date: 1700000000,
        },
      } as any,
      mockPool as any
    );

    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('handles missing from field gracefully', async () => {
    await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          text: 'Thought without from',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    const callArgs = mockPool.query.mock.calls[0][1];
    const sourceMeta = JSON.parse(callArgs[3]);
    expect(sourceMeta.from_id).toBeUndefined();
    expect(sourceMeta.from_username).toBeUndefined();
    // No structured participants when from is missing
    expect(sourceMeta.structured.participants).toEqual([]);
  });

  it('infers group_dm channel_type from group chat', async () => {
    await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: -12345, type: 'supergroup' },
          from: { id: 67890, first_name: 'Daniel' },
          text: 'Group thought',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    const sourceMeta = JSON.parse(mockPool.query.mock.calls[0][1][3]);
    expect(sourceMeta.channel_type).toBe('group_dm');
  });

  it('uses ON CONFLICT with source_id for dedup', async () => {
    await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890 },
          text: 'Test',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('ON CONFLICT (source_id)');
  });
});
