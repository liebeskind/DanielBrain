/**
 * Post-processing for text extracted from PDFs and DOCXs.
 * Fixes hyphenation artifacts, whitespace issues, and other extraction noise.
 */
export function cleanupText(text: string): string {
  return text
    // Dehyphenation: merge "informa-\ntion" → "information"
    .replace(/(\w)-\n(\w)/g, '$1$2')
    // Collapse 3+ consecutive newlines → 2
    .replace(/\n{3,}/g, '\n\n')
    // Collapse runs of spaces/tabs → single space (per line)
    .replace(/[ \t]{2,}/g, ' ')
    // Trim trailing whitespace per line
    .replace(/[ \t]+$/gm, '')
    // Trim leading/trailing whitespace from entire text
    .trim();
}
