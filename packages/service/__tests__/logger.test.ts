import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pino before importing logger
vi.mock('pino', () => {
  const child = vi.fn(() => mockLogger);
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child,
  };
  return { default: vi.fn(() => mockLogger) };
});

import { logger, createChildLogger } from '../src/logger.js';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a logger instance', () => {
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.warn).toBeDefined();
  });

  it('createChildLogger returns a child logger with subsystem', () => {
    const child = createChildLogger('queue-poller');
    expect(logger.child).toHaveBeenCalledWith({ subsystem: 'queue-poller' });
    expect(child).toBeDefined();
  });

  it('can log structured data', () => {
    logger.info({ count: 5 }, 'processed items');
    expect(logger.info).toHaveBeenCalledWith({ count: 5 }, 'processed items');
  });

  it('can log errors', () => {
    const err = new Error('test error');
    logger.error({ err }, 'something failed');
    expect(logger.error).toHaveBeenCalledWith({ err }, 'something failed');
  });
});
