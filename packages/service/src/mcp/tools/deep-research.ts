import type pg from 'pg';
import { handleSemanticSearch } from './semantic-search.js';
import { handleGlobalSearch } from './global-search.js';
import { acquireOllama, releaseOllama } from '../../ollama-mutex.js';
import {
  DEEP_RESEARCH_RESULTS_PER_QUERY,
  DEEP_RESEARCH_SIMILARITY_THRESHOLD,
  OLLAMA_LLM_TIMEOUT_MS,
} from '@danielbrain/shared';

interface DeepResearchInput {
  question: string;
  max_iterations: number;
  include_community_context: boolean;
  synthesize: boolean;
}

interface DeepResearchConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

interface SubQuestionResult {
  question: string;
  thoughts: Array<{
    id: string;
    content: string;
    summary: string | null;
    source: string;
    similarity: number;
    created_at: Date;
  }>;
  communities?: Array<{
    title: string;
    summary: string;
    similarity: number;
  }>;
}

export async function handleDeepResearch(
  input: DeepResearchInput,
  pool: pg.Pool,
  config: DeepResearchConfig,
) {
  const startTime = Date.now();

  // Acquire Ollama mutex at chat priority (user-initiated)
  if (!acquireOllama('chat')) {
    return { error: 'LLM is busy processing another request. Please try again shortly.' };
  }

  try {
    // Step 1: Planning — decompose question into sub-questions
    const subQuestions = await planSubQuestions(input.question, input.max_iterations, config);

    // Release mutex between planning and synthesis (searches don't need LLM)
    releaseOllama('chat');

    // Step 2: Execute searches for each sub-question in parallel
    const subResults = await executeSubQuestions(
      subQuestions,
      input.include_community_context,
      pool,
      config,
    );

    // Step 3: Synthesize (if requested)
    if (input.synthesize) {
      if (!acquireOllama('chat')) {
        return {
          error: 'LLM became busy during research. Returning raw findings.',
          question: input.question,
          sub_questions: subResults,
          execution_time_ms: Date.now() - startTime,
        };
      }
      try {
        const synthesis = await synthesizeFindings(input.question, subResults, config);
        return {
          question: input.question,
          answer: synthesis.answer,
          confidence: synthesis.confidence,
          gaps: synthesis.gaps,
          sub_questions: subQuestions,
          sources: collectSources(subResults),
          execution_time_ms: Date.now() - startTime,
        };
      } finally {
        releaseOllama('chat');
      }
    }

    // Return raw findings for smart clients
    return {
      question: input.question,
      sub_questions: subResults,
      execution_time_ms: Date.now() - startTime,
    };
  } catch (err) {
    releaseOllama('chat');
    throw err;
  }
}

async function planSubQuestions(
  question: string,
  maxQuestions: number,
  config: DeepResearchConfig,
): Promise<string[]> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      messages: [
        {
          role: 'system',
          content: `You are a research planner for a personal knowledge system called DanielBrain. It stores thoughts, meeting notes, entity profiles, and community clusters.

Your job: decompose a complex question into simpler sub-questions that can each be answered by searching the knowledge base.

RULES:
- Return 2-${maxQuestions} sub-questions, no more
- Each sub-question should be searchable (good keywords for semantic search)
- DO NOT ask questions about external data — only what might be in the knowledge base
- DO NOT repeat the original question as a sub-question
- Keep sub-questions specific and focused

EXAMPLE:
Question: "What is the relationship between Topia and Stride, and how has it evolved?"
Sub-questions:
1. "Topia and Stride partnership discussions"
2. "Stride product integration plans"
3. "K12 Zone collaboration between Topia and Stride"

Return ONLY a JSON array of strings. No explanation.`,
        },
        {
          role: 'user',
          content: question,
        },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama planning call failed: ${response.status}`);
  }

  const data = await response.json() as { message: { content: string } };
  const parsed = JSON.parse(data.message.content);

  // Handle both array and object-with-array formats
  const questions: string[] = Array.isArray(parsed)
    ? parsed
    : parsed.sub_questions || parsed.questions || [];

  return questions.slice(0, maxQuestions);
}

async function executeSubQuestions(
  subQuestions: string[],
  includeCommunities: boolean,
  pool: pg.Pool,
  config: DeepResearchConfig,
): Promise<SubQuestionResult[]> {
  const results = await Promise.all(
    subQuestions.map(async (question) => {
      const searchPromises: [
        ReturnType<typeof handleSemanticSearch>,
        ReturnType<typeof handleGlobalSearch> | Promise<null>,
      ] = [
        handleSemanticSearch(
          { query: question, limit: DEEP_RESEARCH_RESULTS_PER_QUERY, threshold: DEEP_RESEARCH_SIMILARITY_THRESHOLD },
          pool,
          config,
        ),
        includeCommunities
          ? handleGlobalSearch({ query: question, level: 0, limit: 3 }, pool, config)
          : Promise.resolve(null),
      ];

      const [thoughts, globalResult] = await Promise.all(searchPromises);

      const result: SubQuestionResult = {
        question,
        thoughts: thoughts.map((t) => ({
          id: t.id,
          content: t.summary || (t.content.length > 500 ? t.content.slice(0, 500) + '...' : t.content),
          summary: t.summary,
          source: t.source,
          similarity: t.similarity,
          created_at: t.created_at,
        })),
      };

      if (globalResult && globalResult.results.length > 0) {
        result.communities = globalResult.results.map((c) => ({
          title: c.title,
          summary: c.summary,
          similarity: c.similarity,
        }));
      }

      return result;
    })
  );

  return results;
}

async function synthesizeFindings(
  question: string,
  subResults: SubQuestionResult[],
  config: DeepResearchConfig,
): Promise<{ answer: string; confidence: 'high' | 'medium' | 'low'; gaps: string[] }> {
  // Build findings text
  const findingsText = subResults.map((sr) => {
    const thoughts = sr.thoughts
      .map((t) => `  - [${t.source}, sim=${t.similarity.toFixed(2)}] ${t.content}`)
      .join('\n');
    const communities = sr.communities
      ? sr.communities.map((c) => `  - [community: ${c.title}] ${c.summary}`).join('\n')
      : '';
    return `Sub-question: "${sr.question}"\nThoughts:\n${thoughts}${communities ? '\nCommunities:\n' + communities : ''}`;
  }).join('\n\n');

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      messages: [
        {
          role: 'system',
          content: `You are a research synthesizer for DanielBrain, a personal knowledge system. You receive findings from searching the knowledge base and must synthesize them into a clear answer.

CRITICAL RULES:
- ONLY state facts that appear in the findings below. Do NOT fabricate information.
- If the findings don't contain enough information, say so explicitly.
- Cite sources by mentioning the source type (slack, fathom, mcp, etc.) when relevant.
- Flag any inferences or uncertainties clearly.

BAD EXAMPLE (hallucination):
"The project launched in Q3 2025 and has 50 active users." ← Fabricated numbers not in findings.

GOOD EXAMPLE:
"Based on Slack discussions, the team is exploring a partnership. A Fathom meeting transcript mentions initial terms were discussed, but no final agreement is recorded."

Return JSON with this exact format:
{
  "answer": "Your synthesized answer here",
  "confidence": "high" or "medium" or "low",
  "gaps": ["List of information gaps or things you couldn't answer"]
}`,
        },
        {
          role: 'user',
          content: `Question: "${question}"\n\nFindings:\n${findingsText}`,
        },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama synthesis call failed: ${response.status}`);
  }

  const data = await response.json() as { message: { content: string } };
  const parsed = JSON.parse(data.message.content);

  return {
    answer: parsed.answer || 'Unable to synthesize an answer from the findings.',
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
  };
}

function collectSources(subResults: SubQuestionResult[]) {
  const seen = new Set<string>();
  const sources: Array<{ id: string; summary: string | null; source: string }> = [];

  for (const sr of subResults) {
    for (const t of sr.thoughts) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        sources.push({ id: t.id, summary: t.summary, source: t.source });
      }
    }
  }

  return sources;
}
