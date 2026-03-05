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

async function callOllamaEmbed(text: string, config: EmbedConfig): Promise<number[]> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: truncateForEmbed(text),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embed failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

export async function embed(text: string, config: EmbedConfig): Promise<number[]> {
  return callOllamaEmbed(`${SEARCH_DOCUMENT_PREFIX}${text}`, config);
}

export async function embedQuery(text: string, config: EmbedConfig): Promise<number[]> {
  return callOllamaEmbed(`${SEARCH_QUERY_PREFIX}${text}`, config);
}
