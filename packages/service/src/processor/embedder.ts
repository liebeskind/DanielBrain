import { SEARCH_DOCUMENT_PREFIX, SEARCH_QUERY_PREFIX } from '@danielbrain/shared';

interface EmbedConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

// nomic-embed-text supports 8192 tokens; truncate to ~5000 words as safety margin
const MAX_EMBED_WORDS = 5000;

function truncateForEmbed(text: string): string {
  const words = text.split(/\s+/);
  if (words.length <= MAX_EMBED_WORDS) return text;
  return words.slice(0, MAX_EMBED_WORDS).join(' ');
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
  const prefixed = texts.map(t => `${SEARCH_DOCUMENT_PREFIX}${t}`);
  return callOllamaEmbed(prefixed, config);
}

export async function embedQuery(text: string, config: EmbedConfig): Promise<number[]> {
  const embeddings = await callOllamaEmbed(`${SEARCH_QUERY_PREFIX}${text}`, config);
  return embeddings[0];
}
