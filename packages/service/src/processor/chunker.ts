import {
  CHUNK_THRESHOLD_TOKENS,
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
} from '@danielbrain/shared';

const TOKENS_PER_WORD = 1.33;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean);
  return Math.ceil(words.length * TOKENS_PER_WORD);
}

export function needsChunking(text: string): boolean {
  return estimateTokens(text) > CHUNK_THRESHOLD_TOKENS;
}

export function chunkText(
  text: string,
  chunkSizeTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS
): string[] {
  if (!needsChunking(text)) {
    return [text];
  }

  const sentences = splitIntoSentences(text);
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    if (currentTokens + sentenceTokens > chunkSizeTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));

      // Calculate overlap: keep trailing sentences up to overlapTokens
      const overlapSentences: string[] = [];
      let overlapCount = 0;
      for (let i = currentChunk.length - 1; i >= 0; i--) {
        const t = estimateTokens(currentChunk[i]);
        if (overlapCount + t > overlapTokens) break;
        overlapSentences.unshift(currentChunk[i]);
        overlapCount += t;
      }
      currentChunk = overlapSentences;
      currentTokens = overlapCount;
    }

    currentChunk.push(sentence);
    currentTokens += sentenceTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }

  return chunks;
}

function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter(Boolean);
}
