import { describe, it, expect, beforeEach } from 'vitest';
import { acquireOllama, releaseOllama, isOllamaBusyFor, _resetForTest } from '../src/ollama-mutex.js';

describe('ollama-mutex', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('allows acquire when idle', () => {
    expect(acquireOllama('background')).toBe(true);
  });

  it('blocks same priority from acquiring twice', () => {
    acquireOllama('background');
    expect(acquireOllama('background')).toBe(false);
  });

  it('allows release and re-acquire', () => {
    acquireOllama('background');
    releaseOllama('background');
    expect(acquireOllama('background')).toBe(true);
  });

  it('chat is not blocked by background', () => {
    acquireOllama('background');
    expect(acquireOllama('chat')).toBe(true);
  });

  it('chat is not blocked by ingestion', () => {
    acquireOllama('ingestion');
    expect(acquireOllama('chat')).toBe(true);
  });

  it('ingestion is not blocked by background', () => {
    acquireOllama('background');
    expect(acquireOllama('ingestion')).toBe(true);
  });

  it('background is blocked by ingestion', () => {
    acquireOllama('ingestion');
    expect(acquireOllama('background')).toBe(false);
  });

  it('background is blocked by chat', () => {
    acquireOllama('chat');
    expect(acquireOllama('background')).toBe(false);
  });

  it('ingestion is blocked by chat', () => {
    acquireOllama('chat');
    expect(acquireOllama('ingestion')).toBe(false);
  });

  it('isOllamaBusyFor reports correctly', () => {
    expect(isOllamaBusyFor('background')).toBe(false);
    acquireOllama('ingestion');
    expect(isOllamaBusyFor('background')).toBe(true);
    expect(isOllamaBusyFor('ingestion')).toBe(true);
    expect(isOllamaBusyFor('chat')).toBe(false);
  });
});
