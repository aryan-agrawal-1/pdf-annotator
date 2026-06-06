export type HighlightRect = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Highlight = {
  id: string;
  text: string;
  createdAt: string;
  rects: HighlightRect[];
};

export type StoredDocument = {
  id: string;
  title: string;
  fileName: string;
  pdfData: ArrayBuffer;
  contentFingerprint?: string;
  highlights: Highlight[];
  createdAt: string;
  updatedAt: string;
};

export type StoredDocumentSummary = {
  id: string;
  title: string;
  fileName: string;
  contentFingerprint?: string;
  pdfByteLength: number;
  highlightCount: number;
  createdAt: string;
  updatedAt: string;
};
