import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectIntentFast, detectIntentLLM, detectIntent } from '../../src/processor/intent-detector.js';

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  extractionModel: 'llama3.3:70b',
};

describe('detectIntentFast', () => {
  // --- Temporal ---
  it('detects "last N days"', () => {
    const result = detectIntentFast('what happened in the last 3 days');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('temporal');
    expect(result!.adjustments.days_back).toBe(3);
  });

  it('detects "last N weeks"', () => {
    const result = detectIntentFast('meetings from the last 2 weeks');
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('temporal');
    expect(result!.adjustments.days_back).toBe(14);
  });

  it('detects "past N months"', () => {
    const result = detectIntentFast('deals closed in the past 3 months');
    expect(result).not.toBeNull();
    expect(result!.adjustments.days_back).toBe(90);
  });

  it('detects "yesterday"', () => {
    const result = detectIntentFast('what did I miss yesterday');
    expect(result!.intent).toBe('temporal');
    expect(result!.adjustments.days_back).toBe(2);
  });

  it('detects "this week"', () => {
    const result = detectIntentFast('meetings this week');
    expect(result!.intent).toBe('temporal');
    expect(result!.adjustments.days_back).toBe(7);
  });

  it('detects "recently"', () => {
    const result = detectIntentFast('any recent updates on the project');
    expect(result!.intent).toBe('temporal');
    expect(result!.adjustments.days_back).toBe(14);
  });

  it('detects "when did"', () => {
    const result = detectIntentFast('when did we last talk to Stride');
    expect(result!.intent).toBe('temporal');
  });

  it('sets lower threshold for temporal', () => {
    const result = detectIntentFast('what happened last week');
    expect(result!.adjustments.threshold).toBe(0.15);
  });

  // --- Action/Task ---
  it('detects "action items"', () => {
    const result = detectIntentFast('what are the action items');
    expect(result!.intent).toBe('action_task');
  });

  it('detects "todos"', () => {
    const result = detectIntentFast('show me my todos');
    expect(result!.intent).toBe('action_task');
  });

  it('detects "follow ups"', () => {
    const result = detectIntentFast('any follow-ups from the meeting');
    expect(result!.intent).toBe('action_task');
  });

  it('detects "what should I"', () => {
    const result = detectIntentFast('what should I prepare for tomorrow');
    expect(result!.intent).toBe('action_task');
  });

  it('sets days_back for action_task', () => {
    const result = detectIntentFast('pending action items');
    expect(result!.adjustments.days_back).toBe(30);
  });

  // --- CRM/Sales queries fall through to LLM (not fast-path) ---
  it('delegates CRM queries to LLM', () => {
    expect(detectIntentFast('who are the top prospects right now')).toBeNull();
    expect(detectIntentFast('what deals are in the pipeline')).toBeNull();
    expect(detectIntentFast('show me the current pipeline')).toBeNull();
  });

  // --- No match → null ---
  it('returns null for ambiguous queries', () => {
    expect(detectIntentFast('tell me about Chris Psiaki')).toBeNull();
  });

  it('returns null for general queries', () => {
    expect(detectIntentFast('blue sky thinking about the future')).toBeNull();
  });

  it('returns null for relational queries', () => {
    expect(detectIntentFast('how do Topia and Stride work together')).toBeNull();
  });

  it('returns null for exploratory queries', () => {
    expect(detectIntentFast('give me an overview of the K12 project')).toBeNull();
  });

  // --- Priority: temporal beats action ---
  it('prioritizes temporal over action when both present', () => {
    const result = detectIntentFast('action items from last week');
    expect(result!.intent).toBe('temporal');
    expect(result!.adjustments.days_back).toBe(7);
  });

  // --- was_fast_path ---
  it('sets was_fast_path true on fast-path results', () => {
    expect(detectIntentFast('what happened last week')?.was_fast_path).toBe(true);
    expect(detectIntentFast('show me action items')?.was_fast_path).toBe(true);
  });

  // --- Case insensitivity ---
  it('is case insensitive', () => {
    expect(detectIntentFast('LAST WEEK meetings')?.intent).toBe('temporal');
    expect(detectIntentFast('Action Items')?.intent).toBe('action_task');
  });

  // --- Edge cases ---
  it('handles empty query', () => {
    expect(detectIntentFast('')).toBeNull();
  });
});

describe('detectIntentLLM', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(response: Record<string, unknown>) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: JSON.stringify(response) } }),
    });
  }

  it('classifies entity_profile query', async () => {
    mockFetch({
      intent: 'entity_profile',
      days_back: null,
      reasoning: 'Entity profile for Chris',
      reformulated_query: 'Chris Psiaki role background',
    });

    const result = await detectIntentLLM(
      'tell me about Chris Psiaki',
      [{ name: 'Chris Psiaki', entity_type: 'person' }],
      mockConfig,
    );

    expect(result.intent).toBe('entity_profile');
    expect(result.reformulated_query).toBe('Chris Psiaki role background');
    expect(result.reasoning).toContain('Chris');
  });

  it('classifies relational query', async () => {
    mockFetch({
      intent: 'relational',
      days_back: null,
      reasoning: 'Relationship between entities',
      reformulated_query: null,
    });

    const result = await detectIntentLLM(
      'how do Topia and Stride relate',
      [{ name: 'Topia', entity_type: 'company' }, { name: 'Stride', entity_type: 'company' }],
      mockConfig,
    );

    expect(result.intent).toBe('relational');
    expect(result.adjustments.limit).toBe(20);
    expect(result.adjustments.threshold).toBe(0.15);
  });

  it('classifies exploratory query', async () => {
    mockFetch({
      intent: 'exploratory',
      days_back: null,
      reasoning: 'Broad status question',
      reformulated_query: null,
    });

    const result = await detectIntentLLM('what is the team working on', [], mockConfig);
    expect(result.intent).toBe('exploratory');
    expect(result.adjustments.limit).toBe(20);
  });

  it('sets days_back from LLM response', async () => {
    mockFetch({ intent: 'temporal', days_back: 14, reasoning: 'Recent', reformulated_query: null });

    const result = await detectIntentLLM('any updates since the offsite', [], mockConfig);
    expect(result.adjustments.days_back).toBe(14);
  });

  it('falls back to general for unknown intents', async () => {
    mockFetch({ intent: 'unknown_type', days_back: null, reasoning: 'Unknown', reformulated_query: null });

    const result = await detectIntentLLM('blah blah', [], mockConfig);
    expect(result.intent).toBe('general');
  });

  it('passes entity names to LLM', async () => {
    mockFetch({ intent: 'entity_profile', days_back: null, reasoning: 'Profile', reformulated_query: null });

    await detectIntentLLM('about Stride', [{ name: 'Stride', entity_type: 'company' }], mockConfig);

    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const userMessage = body.messages[1].content;
    expect(userMessage).toContain('Stride (company)');
  });

  it('sets was_fast_path false on LLM results', async () => {
    mockFetch({ intent: 'exploratory', days_back: null, reasoning: 'Test', reformulated_query: null });
    const result = await detectIntentLLM('some query', [], mockConfig);
    expect(result.was_fast_path).toBe(false);
  });

  it('throws on non-OK response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(detectIntentLLM('test', [], mockConfig)).rejects.toThrow('500');
  });
});

describe('detectIntent (orchestrator)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses fast-path for temporal queries (no LLM call)', async () => {
    global.fetch = vi.fn();

    const result = await detectIntent('what happened last week', [], mockConfig);
    expect(result.intent).toBe('temporal');
    expect(result.adjustments.days_back).toBe(7);
    expect(global.fetch).not.toHaveBeenCalled(); // no LLM needed
  });

  it('uses fast-path for action queries (no LLM call)', async () => {
    global.fetch = vi.fn();

    const result = await detectIntent('show me action items', [], mockConfig);
    expect(result.intent).toBe('action_task');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls through to LLM for ambiguous queries', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: JSON.stringify({ intent: 'entity_profile', days_back: null, reasoning: 'Profile', reformulated_query: null }) },
      }),
    });

    const result = await detectIntent(
      'tell me about Chris',
      [{ name: 'Chris Psiaki', entity_type: 'person' }],
      mockConfig,
    );

    expect(result.intent).toBe('entity_profile');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns general on LLM failure (graceful degradation)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

    const result = await detectIntent('some ambiguous query', [], mockConfig);
    expect(result.intent).toBe('general');
    expect(result.confidence).toBe(0.0);
  });
});
