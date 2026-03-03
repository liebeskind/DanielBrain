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

  it('queues text messages', async () => {
    const result = await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890, username: 'daniel' },
          text: 'My thought from Telegram',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    expect(result).toEqual({ ok: true });
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO queue'),
      ['My thought from Telegram', 'telegram', expect.any(String)]
    );
  });

  it('extracts source_meta with chat_id, message_id, from_id, from_username', async () => {
    await handleTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 12345 },
          from: { id: 67890, username: 'daniel' },
          text: 'Important thought',
          date: 1700000000,
        },
      },
      mockPool as any
    );

    const callArgs = mockPool.query.mock.calls[0][1];
    const sourceMeta = JSON.parse(callArgs[2]);
    expect(sourceMeta.chat_id).toBe(12345);
    expect(sourceMeta.message_id).toBe(42);
    expect(sourceMeta.from_id).toBe(67890);
    expect(sourceMeta.from_username).toBe('daniel');
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
    const sourceMeta = JSON.parse(callArgs[2]);
    expect(sourceMeta.from_id).toBeUndefined();
    expect(sourceMeta.from_username).toBeUndefined();
  });
});
