interface SummarizeConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
}

export const SUMMARIZER_SYSTEM_PROMPT = `You are summarizing content for a personal knowledge management system. Your summaries help AI agents quickly understand what happened.

Write exactly 2-3 sentences. No bullet points, no headers, no lists.

Structure:
- Sentence 1: What this is about — the main topic or event.
- Sentence 2: Key decisions, facts, or insights discussed.
- Sentence 3: Action items or next steps, if any. Omit this sentence if there are none.

RULES:
- Name specific people, companies, and projects. Say "Daniel and Rob discussed Topia's API" not "they discussed the API".
- Keep names exactly as they appear in the text. Do not add parenthetical annotations like "(Founder of X)".
- Be factual and specific. Avoid vague phrases like "various topics were discussed".
- Do not start with "This is a summary of" or "The text describes".`;

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
          content: SUMMARIZER_SYSTEM_PROMPT,
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
