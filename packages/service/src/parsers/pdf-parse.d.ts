declare module 'pdf-parse' {
  interface PdfInfo {
    Title?: string;
    Author?: string;
    CreationDate?: string;
    Keywords?: string;
    [key: string]: unknown;
  }

  interface PdfResult {
    numpages: number;
    numrender: number;
    info: PdfInfo;
    metadata: unknown;
    version: string;
    text: string;
  }

  function pdfParse(dataBuffer: Buffer): Promise<PdfResult>;
  export = pdfParse;
}
