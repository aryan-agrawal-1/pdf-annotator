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
  highlights: Highlight[];
  createdAt: string;
  updatedAt: string;
};
