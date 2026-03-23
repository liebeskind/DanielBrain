import {
  CHUNK_THRESHOLD_TOKENS,
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
} from '@danielbrain/shared';

const TOKENS_PER_WORD = 1.33;
// Minimum tokens for a standalone segment (0 = disabled; sliding window handles grouping)
const MIN_SEGMENT_TOKENS = 0;
const CODE_BLOCK_PLACEHOLDER = '__CODE_BLOCK_';

export type SourceHint = 'meeting' | 'general';

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
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  sourceHint: SourceHint = 'general',
): string[] {
  if (!needsChunking(text)) {
    return [text];
  }

  const segments = splitIntoSegments(text, sourceHint, chunkSizeTokens);
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const segment of segments) {
    const segmentTokens = estimateTokens(segment);

    if (currentTokens + segmentTokens > chunkSizeTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));

      // Calculate overlap: keep trailing segments up to overlapTokens
      const overlapSegments: string[] = [];
      let overlapCount = 0;
      for (let i = currentChunk.length - 1; i >= 0; i--) {
        const t = estimateTokens(currentChunk[i]);
        if (overlapCount + t > overlapTokens) break;
        overlapSegments.unshift(currentChunk[i]);
        overlapCount += t;
      }
      currentChunk = overlapSegments;
      currentTokens = overlapCount;
    }

    currentChunk.push(segment);
    currentTokens += segmentTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

// --- Code block extraction ---

/** Extract ``` fenced code blocks as atomic segments, replace with placeholders */
export function extractCodeBlocks(text: string): { codeBlocks: string[]; stripped: string } {
  const codeBlocks: string[] = [];
  const stripped = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER}${idx}__`;
  });
  return { codeBlocks, stripped };
}

/** Replace code block placeholders with original content */
function restoreCodeBlocks(segments: string[], codeBlocks: string[]): string[] {
  if (codeBlocks.length === 0) return segments;
  return segments.map((seg) => {
    let result = seg;
    for (let i = 0; i < codeBlocks.length; i++) {
      result = result.replace(`${CODE_BLOCK_PLACEHOLDER}${i}__`, codeBlocks[i]);
    }
    return result;
  });
}

// --- Structural splitters ---

/** Split on speaker turn patterns (meeting transcripts) */
export function splitOnSpeakerTurns(text: string): string[] {
  // Fathom format: "SpeakerName: text" at line start, optionally with [HH:MM:SS] prefix
  // Use [ ] instead of \s in name class to avoid matching across newlines
  const parts = text.split(/(?=^(?:\[\d{2}:\d{2}(?::\d{2})?\][ ]?)?[A-Z][a-zA-Z .'-]{1,40}:[ ])/m);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Split on markdown heading boundaries */
export function splitOnHeadings(text: string): string[] {
  const parts = text.split(/(?=^#{1,6}\s)/m);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Split on paragraph boundaries (double newline) */
export function splitOnParagraphs(text: string): string[] {
  return text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Group consecutive list items into blocks, split non-list text separately */
export function splitOnListBlocks(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length <= 1) return [text];

  const segments: string[] = [];
  let currentBlock: string[] = [];
  let inList = false;

  for (const line of lines) {
    const isList = /^\s*[-*]\s|^\s*\d+\.\s/.test(line);

    if (isList !== inList && currentBlock.length > 0) {
      const block = currentBlock.join('\n').trim();
      if (block) segments.push(block);
      currentBlock = [];
    }
    inList = isList;
    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    const block = currentBlock.join('\n').trim();
    if (block) segments.push(block);
  }

  return segments;
}

/** Split on sentence boundaries (final fallback) */
export function splitOnSentences(text: string): string[] {
  const lines = text.split(/\n+/).filter(Boolean);
  const parts: string[] = [];
  for (const line of lines) {
    const sentences = line.split(/(?<=[.!?])\s+/).filter(Boolean);
    parts.push(...sentences);
  }
  return parts.length > 0 ? parts : [text];
}

// --- Segment assembly ---

/** Merge tiny segments (< minTokens) into neighbors */
function mergeSmallSegments(segments: string[]): string[] {
  if (segments.length <= 1) return segments;

  const result: string[] = [];
  let buffer = '';

  for (const seg of segments) {
    if (buffer) {
      buffer += '\n\n' + seg;
      if (estimateTokens(buffer) >= MIN_SEGMENT_TOKENS) {
        result.push(buffer);
        buffer = '';
      }
    } else if (estimateTokens(seg) < MIN_SEGMENT_TOKENS) {
      buffer = seg;
    } else {
      result.push(seg);
    }
  }

  if (buffer) {
    if (result.length > 0) {
      result[result.length - 1] += '\n\n' + buffer;
    } else {
      result.push(buffer);
    }
  }

  return result;
}

/** Main segment splitter — structural hierarchy with recursive fallback */
export function splitIntoSegments(
  text: string,
  sourceHint: SourceHint = 'general',
  maxTokens: number = CHUNK_SIZE_TOKENS,
): string[] {
  // Step 1: Extract code blocks as atomic units
  const { codeBlocks, stripped } = extractCodeBlocks(text);

  // Step 2: Source-aware structural splitting
  let segments: string[];
  if (sourceHint === 'meeting') {
    segments = splitOnSpeakerTurns(stripped);
    // Oversized speaker turns → split on paragraphs
    segments = segments.flatMap((seg) =>
      estimateTokens(seg) > maxTokens ? splitOnParagraphs(seg) : [seg],
    );
  } else {
    segments = splitOnHeadings(stripped);
    // Oversized heading sections → split on paragraphs
    segments = segments.flatMap((seg) =>
      estimateTokens(seg) > maxTokens ? splitOnParagraphs(seg) : [seg],
    );
  }

  // Step 3: Group list items within segments
  segments = segments.flatMap((seg) => splitOnListBlocks(seg));

  // Step 4: Oversized segments → split on sentence boundaries
  segments = segments.flatMap((seg) =>
    estimateTokens(seg) > maxTokens ? splitOnSentences(seg) : [seg],
  );

  // Step 5: Merge tiny fragments
  segments = mergeSmallSegments(segments);

  // Step 6: Restore code blocks at placeholder positions
  segments = restoreCodeBlocks(segments, codeBlocks);

  return segments;
}
