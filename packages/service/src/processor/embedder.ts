import { SEARCH_DOCUMENT_PREFIX, SEARCH_QUERY_PREFIX } from '@danielbrain/shared';

interface EmbedConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

// nomic-embed-text actual context is 2048 tokens (nomic-bert.context_length), not 8192
// Use conservative limits: ~1500 tokens leaves margin for prefix + tokenizer variance
const MAX_EMBED_WORDS = 1000;
const MAX_EMBED_CHARS = 6000; // ~4 chars/token * 1500 tokens

function truncateForEmbed(text: string): string {
  let result = text;
  if (result.length > MAX_EMBED_CHARS) {
    result = result.slice(0, MAX_EMBED_CHARS);
  }
  const words = result.split(/\s+/);
  if (words.length > MAX_EMBED_WORDS) {
    result = words.slice(0, MAX_EMBED_WORDS).join(' ');
  }
  return result;
}

async function callOllamaEmbed(input: string | string[], config: EmbedConfig): Promise<number[][]> {
  const truncated = Array.isArray(input)
    ? input.map(truncateForEmbed)
    : truncateForEmbed(input);

  const response = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: truncated,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embed failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings;
}

export async function embed(text: string, config: EmbedConfig): Promise<number[]> {
  const embeddings = await callOllamaEmbed(`${SEARCH_DOCUMENT_PREFIX}${text}`, config);
  return embeddings[0];
}

export async function embedBatch(texts: string[], config: EmbedConfig): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Process individually to avoid combined context length issues with Ollama batch API
  const results: number[][] = [];
  for (const text of texts) {
    const embeddings = await callOllamaEmbed(`${SEARCH_DOCUMENT_PREFIX}${text}`, config);
    results.push(embeddings[0]);
  }
  return results;
}

export async function embedQuery(text: string, config: EmbedConfig): Promise<number[]> {
  const embeddings = await callOllamaEmbed(`${SEARCH_QUERY_PREFIX}${text}`, config);
  return embeddings[0];
}
