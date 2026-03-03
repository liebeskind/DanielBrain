import { SEARCH_DOCUMENT_PREFIX, SEARCH_QUERY_PREFIX } from '@danielbrain/shared';

interface EmbedConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

async function callOllamaEmbed(text: string, config: EmbedConfig): Promise<number[]> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
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
