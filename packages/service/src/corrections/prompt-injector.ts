import type pg from 'pg';
import type { CorrectionCategory } from '@danielbrain/shared';
import { MAX_PROMPT_INJECTION_EXAMPLES } from '@danielbrain/shared';
import { getExamplesByCategory } from './store.js';

export async function getPromptExamples(
  category: CorrectionCategory,
  pool: pg.Pool,
  limit: number = MAX_PROMPT_INJECTION_EXAMPLES,
): Promise<string> {
  const examples = await getExamplesByCategory(category, pool, limit);

  if (examples.length === 0) return '';

  const formatted = examples.map((ex, i) => {
    const parts = [`CORRECTION EXAMPLE ${i + 1}:`];
    parts.push(`Input: ${summarizeJson(ex.input_context)}`);
    if (ex.actual_output) {
      parts.push(`System produced: ${summarizeJson(ex.actual_output)}`);
    }
    parts.push(`Correct answer: ${summarizeJson(ex.expected_output)}`);
    if (ex.explanation) {
      parts.push(`Why: ${ex.explanation}`);
    }
    return parts.join('\n');
  });

  return '\n\nPAST CORRECTIONS (learn from these):\n' + formatted.join('\n\n');
}

function summarizeJson(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}
