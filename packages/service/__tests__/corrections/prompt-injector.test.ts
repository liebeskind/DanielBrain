import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPromptExamples } from '../../src/corrections/prompt-injector.js';

vi.mock('../../src/corrections/store.js', () => ({
  getExamplesByCategory: vi.fn(),
}));

import { getExamplesByCategory } from '../../src/corrections/store.js';

const mockPool = { query: vi.fn() };

describe('prompt-injector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when no examples exist', async () => {
    (getExamplesByCategory as any).mockResolvedValueOnce([]);

    const result = await getPromptExamples('linkedin_search', mockPool as any);
    expect(result).toBe('');
  });

  it('formats examples with all fields', async () => {
    (getExamplesByCategory as any).mockResolvedValueOnce([
      {
        id: 'ce-1',
        category: 'linkedin_search',
        input_context: { entity_name: 'Jamie', search_query: 'test' },
        actual_output: { linkedin_url: 'https://linkedin.com/in/wrong' },
        expected_output: { linkedin_url: 'https://linkedin.com/in/correct' },
        explanation: 'Pearson was a customer, not employer',
      },
    ]);

    const result = await getPromptExamples('linkedin_search', mockPool as any);

    expect(result).toContain('PAST CORRECTIONS');
    expect(result).toContain('CORRECTION EXAMPLE 1');
    expect(result).toContain('Input:');
    expect(result).toContain('Jamie');
    expect(result).toContain('System produced:');
    expect(result).toContain('wrong');
    expect(result).toContain('Correct answer:');
    expect(result).toContain('correct');
    expect(result).toContain('Why: Pearson was a customer, not employer');
  });

  it('formats examples without actual_output', async () => {
    (getExamplesByCategory as any).mockResolvedValueOnce([
      {
        id: 'ce-2',
        category: 'entity_extraction',
        input_context: { text: 'some content' },
        actual_output: null,
        expected_output: { people: ['Alice'] },
        explanation: null,
      },
    ]);

    const result = await getPromptExamples('entity_extraction', mockPool as any);

    expect(result).toContain('Input:');
    expect(result).not.toContain('System produced:');
    expect(result).toContain('Correct answer:');
    expect(result).not.toContain('Why:');
  });

  it('respects limit parameter', async () => {
    (getExamplesByCategory as any).mockResolvedValueOnce([]);

    await getPromptExamples('linkedin_search', mockPool as any, 5);

    expect(getExamplesByCategory).toHaveBeenCalledWith('linkedin_search', mockPool, 5);
  });

  it('defaults to MAX_PROMPT_INJECTION_EXAMPLES', async () => {
    (getExamplesByCategory as any).mockResolvedValueOnce([]);

    await getPromptExamples('linkedin_search', mockPool as any);

    expect(getExamplesByCategory).toHaveBeenCalledWith('linkedin_search', mockPool, 3);
  });
});
