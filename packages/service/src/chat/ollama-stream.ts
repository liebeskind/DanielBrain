import type { Response } from 'express';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function streamChat(
  messages: ChatMessage[],
  model: string,
  ollamaBaseUrl: string,
  res: Response,
): Promise<void> {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    res.write(`data: ${JSON.stringify({ error: `Ollama error: ${response.status} ${errorText}` })}\n\n`);
    res.end();
    return;
  }

  if (!response.body) {
    res.write(`data: ${JSON.stringify({ error: 'No response body from Ollama' })}\n\n`);
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Ollama sends newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            res.write(`data: ${JSON.stringify({ token: chunk.message.content })}\n\n`);
          }
          if (chunk.done) {
            res.write('data: [DONE]\n\n');
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer);
        if (chunk.message?.content) {
          res.write(`data: ${JSON.stringify({ token: chunk.message.content })}\n\n`);
        }
        if (chunk.done) {
          res.write('data: [DONE]\n\n');
        }
      } catch {
        // Skip
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: `Stream error: ${String(err)}` })}\n\n`);
  }

  res.end();
}
