// Minimal typing for the pdf.js entry point we lazy-import. pdfjs-dist ships
// full types elsewhere, but not for this specific build path; we only use a
// small surface, declared here.
declare module 'pdfjs-dist/build/pdf.mjs' {
  export const GlobalWorkerOptions: { workerSrc: string };

  interface TextContentItem {
    str?: string;
    transform?: number[];
  }
  interface TextContent {
    items: TextContentItem[];
  }
  interface PDFPageProxy {
    getTextContent(): Promise<TextContent>;
  }
  interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
  }
  interface GetDocumentParams {
    data?: Uint8Array;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
  }
  export function getDocument(params: GetDocumentParams): { promise: Promise<PDFDocumentProxy> };
}
