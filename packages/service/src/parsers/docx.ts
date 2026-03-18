import mammoth from 'mammoth';

export interface DocxResult {
  text: string;
}

export async function parseDocx(buffer: Buffer): Promise<DocxResult> {
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value };
}
