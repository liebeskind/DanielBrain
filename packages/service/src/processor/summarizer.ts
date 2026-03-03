interface SummarizeConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
}

export async function summarize(text: string, config: SummarizeConfig): Promise<string> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are a summarization assistant. Produce a concise 2-3 sentence summary of the given text. Focus on the key points, decisions, and action items.',
        },
        {
          role: 'user',
          content: text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama summarization failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  return data.message.content;
}
