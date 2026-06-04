import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { FileText, PanelLeft, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { renderTextLayer } from "./pdfTextLayer";
import { getLastDocument, saveDocument, updateHighlights } from "./storage";
import type { Highlight, HighlightRect, StoredDocument } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MIN_SCALE = 0.7;
const MAX_SCALE = 2.2;
const SCALE_STEP = 0.15;
const PAGE_RENDER_SCALE = 1.4;

type LoadedPdf = {
  pdf: pdfjs.PDFDocumentProxy;
  pages: pdfjs.PDFPageProxy[];
};

type WebKitGestureEvent = Event & {
  clientX?: number;
  clientY?: number;
  scale?: number;
};

type WordBox = HighlightRect & {
  id: string;
  line: number;
  order: number;
  segment: number;
  segmentOrder: number;
  text: string;
};

type WordSelection = {
  start: WordBox;
  current: WordBox;
};

type ZoomAdjustment = {
  pointX: number;
  pointY: number;
  scrollX: number;
  scrollY: number;
  ratio: number;
  clientX?: number;
  clientY?: number;
  anchor?: {
    pageNumber: string;
    x: number;
    y: number;
  };
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
};

type PdfTextContent = Awaited<ReturnType<pdfjs.PDFPageProxy["getTextContent"]>>;

type PdfTextStyle = {
  ascent?: number;
  descent?: number;
};

type VisualSegmentDraft = {
  words: WordBox[];
  line?: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type AsyncIterableReadableStream<T> = ReadableStream<T> & {
  values?: (options?: { preventCancel?: boolean }) => AsyncIterableIterator<T>;
};

type RuntimeDiagnostics = {
  userAgent: string;
  platform: string;
  pdfjsVersion: string;
  workerSrc: string;
  promiseWithResolvers: string;
  uint8ArrayFromBase64: string;
  worker: string;
  readableStream: string;
  readableStreamAsyncIterator: string;
  readableStreamValues: string;
  offscreenCanvas: string;
  indexedDB: string;
};

type PageDiagnostics = {
  page: number;
  canvas: "not-started" | "rendering" | "rendered" | "failed";
  textContent: "not-started" | "loading" | "loaded" | "failed";
  textLayer: "not-started" | "rendering" | "rendered" | "pending-over-5s" | "failed";
  textItems: number;
  nonemptyTextItems: number;
  textChars: number;
  textLayerSpans: number;
  nonemptyTextLayerSpans: number;
  firstSpanText: string | null;
  firstSpanBox: { width: number; height: number; left: number; top: number } | null;
  textLayerWords: number;
  metricFallbackWords: number;
  finalWords: number;
  lastError: string | null;
};

declare global {
  interface Window {
    __PDF_ANNOTATION_DEBUG__?: {
      pages: Record<number, WordBox[]>;
    };
  }
}

function createId(prefix: string) {
  if (crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function truncateText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function getHighlightPage(highlight: Highlight) {
  return Math.min(...highlight.rects.map((rect) => rect.page));
}

function removeLegacyAreaHighlights(document: StoredDocument) {
  return {
    ...document,
    highlights: document.highlights.filter((highlight) => highlight.text !== "Area highlight"),
  };
}

function getRuntimeDiagnostics(): RuntimeDiagnostics {
  const promiseConstructor = Promise as PromiseConstructor & {
    withResolvers?: unknown;
  };
  const typedArrayConstructor = Uint8Array as typeof Uint8Array & {
    fromBase64?: unknown;
  };

  const readableStreamPrototype = globalThis.ReadableStream?.prototype as
    | AsyncIterableReadableStream<unknown>
    | undefined;

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    pdfjsVersion: pdfjs.version,
    workerSrc: workerUrl,
    promiseWithResolvers: typeof promiseConstructor.withResolvers,
    uint8ArrayFromBase64: typeof typedArrayConstructor.fromBase64,
    worker: typeof Worker,
    readableStream: typeof ReadableStream,
    readableStreamAsyncIterator: typeof readableStreamPrototype?.[Symbol.asyncIterator],
    readableStreamValues: typeof readableStreamPrototype?.values,
    offscreenCanvas: typeof OffscreenCanvas,
    indexedDB: typeof indexedDB,
  };
}

function installReadableStreamAsyncIteratorPolyfill() {
  const prototype = globalThis.ReadableStream?.prototype as AsyncIterableReadableStream<unknown> | undefined;

  if (!prototype || typeof prototype[Symbol.asyncIterator] === "function") {
    return;
  }

  const values = function values<T>(
    this: ReadableStream<T>,
    options: { preventCancel?: boolean } = {},
  ): AsyncIterableIterator<T> {
    const reader = this.getReader();
    let done = false;

    const iterator: AsyncIterableIterator<T> = {
      async next() {
        if (done) {
          return { value: undefined, done: true };
        }

        const result = await reader.read();

        if (result.done) {
          done = true;
          reader.releaseLock();
        }

        return result;
      },
      async return() {
        if (!done) {
          done = true;

          if (!options.preventCancel) {
            await reader.cancel();
          }

          reader.releaseLock();
        }

        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return iterator;
  };

  Object.defineProperty(prototype, "values", {
    configurable: true,
    writable: true,
    value: values,
  });
  Object.defineProperty(prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: values,
  });
}

installReadableStreamAsyncIteratorPolyfill();

function createInitialPageDiagnostics(page: number): PageDiagnostics {
  return {
    page,
    canvas: "not-started",
    textContent: "not-started",
    textLayer: "not-started",
    textItems: 0,
    nonemptyTextItems: 0,
    textChars: 0,
    textLayerSpans: 0,
    nonemptyTextLayerSpans: 0,
    firstSpanText: null,
    firstSpanBox: null,
    textLayerWords: 0,
    metricFallbackWords: 0,
    finalWords: 0,
    lastError: null,
  };
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function summarizeTextContent(textContent: PdfTextContent) {
  let textItems = 0;
  let nonemptyTextItems = 0;
  let textChars = 0;

  for (const item of textContent.items) {
    if (!("str" in item)) {
      continue;
    }

    textItems += 1;
    const text = item.str.trim();

    if (text) {
      nonemptyTextItems += 1;
      textChars += text.length;
    }
  }

  return { textItems, nonemptyTextItems, textChars };
}

function summarizeTextLayer(textLayer: HTMLElement) {
  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>("span"));
  const firstSpan = spans[0] ?? null;
  const firstSpanRect = firstSpan?.getBoundingClientRect();

  return {
    textLayerSpans: spans.length,
    nonemptyTextLayerSpans: spans.filter((span) => (span.textContent ?? "").trim()).length,
    firstSpanText: firstSpan?.textContent ?? null,
    firstSpanBox: firstSpanRect
      ? {
          width: firstSpanRect.width,
          height: firstSpanRect.height,
          left: firstSpanRect.left,
          top: firstSpanRect.top,
        }
      : null,
  };
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const wordsByPageRef = useRef(new Map<number, WordBox[]>());
  const wordSelectionRef = useRef<WordSelection | null>(null);
  const lastViewerPointRef = useRef<{ x: number; y: number } | null>(null);
  const wordCursorActiveRef = useRef(false);
  const scaleRef = useRef(1.15);
  const gestureStartScaleRef = useRef(1.15);
  const zoomAdjustmentRef = useRef<ZoomAdjustment | null>(null);
  const pendingDraftSelectionRef = useRef<{ start: WordBox; current: WordBox } | null>(null);
  const draftSelectionFrameRef = useRef<number | null>(null);
  const highlightTimers = useRef<number[]>([]);

  const [document, setDocument] = useState<StoredDocument | null>(null);
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null);
  const [scale, setScale] = useState(1.15);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [draftWordIds, setDraftWordIds] = useState<Set<string>>(() => new Set());
  const [isWordCursorActive, setIsWordCursorActive] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [status, setStatus] = useState("Open a PDF");
  const [selectableWordCount, setSelectableWordCount] = useState(0);
  const [runtimeDiagnostics] = useState(() => getRuntimeDiagnostics());
  const [pageDiagnostics, setPageDiagnostics] = useState<Record<number, PageDiagnostics>>({});
  const [debugGeometry, setDebugGeometry] = useState("");

  useEffect(() => {
    const debugPdf = new URLSearchParams(window.location.search).get("debugPdf");

    if (!debugPdf) {
      return;
    }

    const debugPdfUrl = debugPdf;
    let cancelled = false;

    async function loadDebugPdf() {
      try {
        const response = await fetch(debugPdfUrl);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const pdfData = await response.arrayBuffer();
        const fileName = decodeURIComponent(debugPdfUrl.split("/").pop() ?? "debug.pdf");
        const now = new Date().toISOString();
        const nextDocument: StoredDocument = {
          id: createId("debug-doc"),
          title: fileName.replace(/\.pdf$/i, ""),
          fileName,
          pdfData,
          highlights: [],
          createdAt: now,
          updatedAt: now,
        };

        if (!cancelled) {
          setDocument(nextDocument);
          setActiveHighlightId(null);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(`Could not load debug PDF: ${serializeError(error)}`);
        }
      }
    }

    void loadDebugPdf();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (new URLSearchParams(window.location.search).has("debugPdf")) {
      return () => {
        cancelled = true;
      };
    }

    getLastDocument()
      .then((lastDocument) => {
        if (!cancelled && lastDocument) {
          const cleanedDocument = removeLegacyAreaHighlights(lastDocument);
          setDocument(cleanedDocument);

          if (cleanedDocument.highlights.length !== lastDocument.highlights.length) {
            void saveDocument(cleanedDocument);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("Local storage unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!document) {
      setLoadedPdf(null);
      return;
    }

    let cancelled = false;
    const loadingTask = pdfjs.getDocument({ data: document.pdfData.slice(0) });
    setIsLoadingPdf(true);
    setStatus("Loading PDF");

    async function loadPdf() {
      try {
        const pdf = await loadingTask.promise;
        const pages = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1)),
        );

        if (!cancelled) {
          setLoadedPdf({ pdf, pages });
          setStatus(`${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`);
          setSelectableWordCount(0);
          setPageDiagnostics({});
        }
      } catch {
        if (!cancelled) {
          setLoadedPdf(null);
          setStatus("Could not open PDF");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPdf(false);
        }
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [document?.pdfData]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    const adjustment = zoomAdjustmentRef.current;

    if (!viewer || !adjustment) {
      return;
    }

    zoomAdjustmentRef.current = null;

    if (
      adjustment.anchor &&
      typeof adjustment.clientX === "number" &&
      typeof adjustment.clientY === "number"
    ) {
      const nextPage = viewer.querySelector<HTMLElement>(
        `[data-page-number="${adjustment.anchor.pageNumber}"]`,
      );
      const nextBox = nextPage?.getBoundingClientRect();

      if (nextBox) {
        viewer.scrollLeft += nextBox.left + nextBox.width * adjustment.anchor.x - adjustment.clientX;
        viewer.scrollTop += nextBox.top + nextBox.height * adjustment.anchor.y - adjustment.clientY;
        return;
      }
    }

    viewer.scrollLeft = adjustment.scrollX * adjustment.ratio - adjustment.pointX;
    viewer.scrollTop = adjustment.scrollY * adjustment.ratio - adjustment.pointY;
  }, [scale]);

  const zoomViewer = useCallback((getNextScale: (current: number) => number, clientX?: number, clientY?: number) => {
    const viewer = viewerRef.current;

    if (!viewer) {
      setScale((current) => clamp(getNextScale(current), MIN_SCALE, MAX_SCALE));
      return;
    }

    const viewerBox = viewer.getBoundingClientRect();
    const pointX = typeof clientX === "number" ? clientX - viewerBox.left : viewerBox.width / 2;
    const pointY = typeof clientY === "number" ? clientY - viewerBox.top : viewerBox.height / 2;
    const scrollX = viewer.scrollLeft + pointX;
    const scrollY = viewer.scrollTop + pointY;
    const anchorPage =
      typeof clientX === "number" && typeof clientY === "number"
        ? window.document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-page-number]")
        : null;
    const anchorPageNumber = anchorPage?.dataset.pageNumber;
    const anchorBox = anchorPage?.getBoundingClientRect();
    const anchor =
      anchorPageNumber && anchorBox
        ? {
            pageNumber: anchorPageNumber,
            x: (clientX! - anchorBox.left) / anchorBox.width,
            y: (clientY! - anchorBox.top) / anchorBox.height,
          }
        : null;

    setScale((current) => {
      const next = clamp(getNextScale(current), MIN_SCALE, MAX_SCALE);
      const ratio = next / current;

      zoomAdjustmentRef.current = {
        pointX,
        pointY,
        scrollX,
        scrollY,
        ratio,
        clientX,
        clientY,
        anchor: anchor ?? undefined,
      };

      return next;
    });
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;

    if (!viewer) {
      return;
    }

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartScaleRef.current = scaleRef.current;
    };

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as WebKitGestureEvent;
      const gestureScale = gestureEvent.scale;

      if (typeof gestureScale !== "number") {
        return;
      }

      event.preventDefault();
      zoomViewer(
        () => gestureStartScaleRef.current * gestureScale,
        gestureEvent.clientX ?? lastViewerPointRef.current?.x,
        gestureEvent.clientY ?? lastViewerPointRef.current?.y,
      );
    };

    viewer.addEventListener("gesturestart", handleGestureStart, { passive: false });
    viewer.addEventListener("gesturechange", handleGestureChange, { passive: false });

    return () => {
      viewer.removeEventListener("gesturestart", handleGestureStart);
      viewer.removeEventListener("gesturechange", handleGestureChange);
    };
  }, [zoomViewer]);

  useEffect(() => {
    return () => {
      if (draftSelectionFrameRef.current !== null) {
        window.cancelAnimationFrame(draftSelectionFrameRef.current);
      }

      highlightTimers.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const sortedHighlights = useMemo(() => {
    if (!document) {
      return [];
    }

    return [...document.highlights].sort((a, b) => {
      const pageDelta = getHighlightPage(a) - getHighlightPage(b);
      if (pageDelta !== 0) {
        return pageDelta;
      }

      const firstA = a.rects[0]?.y ?? 0;
      const firstB = b.rects[0]?.y ?? 0;
      return firstA - firstB;
    });
  }, [document]);

  const setPageRef = useCallback((pageNumber: number, element: HTMLElement | null) => {
    if (element) {
      pageRefs.current.set(pageNumber, element);
    } else {
      pageRefs.current.delete(pageNumber);
    }
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    const pdfData = await file.arrayBuffer();
    const now = new Date().toISOString();
    const nextDocument: StoredDocument = {
      id: createId("doc"),
      title: file.name.replace(/\.pdf$/i, ""),
      fileName: file.name,
      pdfData,
      highlights: [],
      createdAt: now,
      updatedAt: now,
    };

    await saveDocument(nextDocument);
    setDocument(nextDocument);
    setActiveHighlightId(null);
  }, []);

  const persistHighlights = useCallback(
    async (nextHighlights: Highlight[]) => {
      if (!document) {
        return;
      }

      const nextDocument = {
        ...document,
        highlights: nextHighlights,
        updatedAt: new Date().toISOString(),
      };

      setDocument(nextDocument);
      await updateHighlights(document.id, nextHighlights);
    },
    [document],
  );

  const commitHighlight = useCallback(
    async (text: string, rects: HighlightRect[]) => {
      if (!document || rects.length === 0) {
        return false;
      }

      const highlight: Highlight = {
        id: createId("hl"),
        text: truncateText(text),
        createdAt: new Date().toISOString(),
        rects,
      };

      await persistHighlights([...document.highlights, highlight]);

      return true;
    },
    [document, persistHighlights],
  );

  const updatePageWords = useCallback((pageNumber: number, words: WordBox[]) => {
    if (words.length > 0) {
      wordsByPageRef.current.set(pageNumber, words);
    } else {
      wordsByPageRef.current.delete(pageNumber);
    }

    setSelectableWordCount(
      Array.from(wordsByPageRef.current.values()).reduce((total, pageWords) => total + pageWords.length, 0),
    );

    window.__PDF_ANNOTATION_DEBUG__ = {
      pages: Array.from(wordsByPageRef.current).reduce<Record<number, WordBox[]>>(
        (pages, [page, pageWords]) => ({
          ...pages,
          [page]: pageWords,
        }),
        {},
      ),
    };
    setDebugGeometry(
      JSON.stringify({
        pages: {
          3: summarizeDebugPageGeometry(wordsByPageRef.current.get(3) ?? []),
          4: summarizeDebugPageGeometry(wordsByPageRef.current.get(4) ?? []),
          6: summarizeDebugPageGeometry(wordsByPageRef.current.get(6) ?? []),
        },
      }),
    );
  }, []);

  const updatePageDiagnostics = useCallback((pageNumber: number, patch: Partial<PageDiagnostics>) => {
    setPageDiagnostics((current) => ({
      ...current,
      [pageNumber]: {
        ...(current[pageNumber] ?? createInitialPageDiagnostics(pageNumber)),
        ...patch,
      },
    }));
  }, []);

  const updateDraftSelection = useCallback((start: WordBox, current: WordBox) => {
    pendingDraftSelectionRef.current = { start, current };

    if (draftSelectionFrameRef.current !== null) {
      return;
    }

    draftSelectionFrameRef.current = window.requestAnimationFrame(() => {
      draftSelectionFrameRef.current = null;
      const selection = pendingDraftSelectionRef.current;

      if (!selection) {
        return;
      }

      pendingDraftSelectionRef.current = null;
      const selectedWords = getWordsInRange(selection.start, selection.current, wordsByPageRef.current);
      setDraftWordIds(new Set(selectedWords.map((word) => word.id)));
    });
  }, []);

  const setWordCursorActive = useCallback((isActive: boolean) => {
    if (wordCursorActiveRef.current === isActive) {
      return;
    }

    wordCursorActiveRef.current = isActive;
    setIsWordCursorActive(isActive);
  }, []);

  const finishWordSelection = useCallback(
    async (word?: WordBox) => {
      const selection = wordSelectionRef.current;

      if (!selection) {
        return;
      }

      if (word) {
        selection.current = word;
      }

      wordSelectionRef.current = null;
      pendingDraftSelectionRef.current = null;

      if (draftSelectionFrameRef.current !== null) {
        window.cancelAnimationFrame(draftSelectionFrameRef.current);
        draftSelectionFrameRef.current = null;
      }

      setDraftWordIds(new Set());

      const selectedWords = getWordsInRange(selection.start, selection.current, wordsByPageRef.current);

      if (selectedWords.length === 0) {
        return;
      }

      await commitHighlight(wordsToText(selectedWords), wordsToHighlightRects(selectedWords));
    },
    [commitHighlight],
  );

  useEffect(() => {
    const finishCurrentSelection = () => {
      void finishWordSelection();
    };

    window.addEventListener("mouseup", finishCurrentSelection);

    return () => {
      window.removeEventListener("mouseup", finishCurrentSelection);
    };
  }, [finishWordSelection]);

  const handleViewerWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) {
      return;
    }

    event.preventDefault();
    lastViewerPointRef.current = { x: event.clientX, y: event.clientY };
    zoomViewer((current) => current * Math.exp(-event.deltaY / 420), event.clientX, event.clientY);
  }, [zoomViewer]);

  const handleViewerMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    lastViewerPointRef.current = { x: event.clientX, y: event.clientY };

    const exactHit = getWordAtClientPoint(
      event.clientX,
      event.clientY,
      pageRefs.current,
      wordsByPageRef.current,
    );
    const selection = wordSelectionRef.current;

    if (!selection) {
      setWordCursorActive(Boolean(exactHit));
      return;
    }

    if (event.buttons !== 1) {
      void finishWordSelection();
      setWordCursorActive(Boolean(exactHit));
      return;
    }

    setWordCursorActive(true);

    const selectionHit =
      exactHit ??
      getWordAtClientPoint(event.clientX, event.clientY, pageRefs.current, wordsByPageRef.current, {
        nearest: true,
      });

    if (!selectionHit) {
      return;
    }

    if (selection.current.id === selectionHit.id) {
      return;
    }

    event.preventDefault();
    selection.current = selectionHit;
    updateDraftSelection(selection.start, selectionHit);
  }, [finishWordSelection, setWordCursorActive, updateDraftSelection]);

  const handleViewerMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      const hit = getWordAtClientPoint(event.clientX, event.clientY, pageRefs.current, wordsByPageRef.current);

      if (!hit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      lastViewerPointRef.current = { x: event.clientX, y: event.clientY };
      wordSelectionRef.current = { start: hit, current: hit };
      setWordCursorActive(true);
      updateDraftSelection(hit, hit);
    },
    [setWordCursorActive, updateDraftSelection],
  );

  const handleViewerMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const selection = wordSelectionRef.current;

      if (!selection) {
        return;
      }

      const hit = getWordAtClientPoint(event.clientX, event.clientY, pageRefs.current, wordsByPageRef.current, {
        nearest: true,
      });

      event.preventDefault();
      void finishWordSelection(hit ?? undefined);
    },
    [finishWordSelection],
  );

  const handleViewerMouseLeave = useCallback(() => {
    if (!wordSelectionRef.current) {
      setWordCursorActive(false);
    }
  }, [setWordCursorActive]);

  const zoomFromLastViewerPoint = useCallback(
    (getNextScale: (current: number) => number) => {
      zoomViewer(getNextScale, lastViewerPointRef.current?.x, lastViewerPointRef.current?.y);
    },
    [zoomViewer],
  );

  const jumpToHighlight = useCallback((highlight: Highlight) => {
    const pageNumber = getHighlightPage(highlight);
    const page = pageRefs.current.get(pageNumber);

    page?.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveHighlightId(highlight.id);

    const timer = window.setTimeout(() => setActiveHighlightId(null), 1200);
    highlightTimers.current.push(timer);
  }, []);

  const deleteHighlight = useCallback(
    async (highlightId: string) => {
      if (!document) {
        return;
      }

      await persistHighlights(document.highlights.filter((highlight) => highlight.id !== highlightId));
    },
    [document, persistHighlights],
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="brand">
            <FileText aria-hidden="true" />
            <div>
              <h1>PDF Annotation</h1>
              <span>{document?.fileName ?? status}</span>
            </div>
          </div>

          <button className="primary-button" type="button" onClick={openFilePicker}>
            <Upload aria-hidden="true" />
            Open PDF
          </button>

          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFileSelected}
          />
        </div>

        <section className="highlight-panel" aria-label="Saved highlights">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Highlights</span>
              <strong>{sortedHighlights.length}</strong>
            </div>
            <PanelLeft aria-hidden="true" />
          </div>

          <div className="highlight-list">
            {sortedHighlights.length === 0 ? (
              <div className="empty-list">No highlights yet</div>
            ) : (
              sortedHighlights.map((highlight) => (
                <button
                  className={`highlight-item ${activeHighlightId === highlight.id ? "is-active" : ""}`}
                  type="button"
                  key={highlight.id}
                  onClick={() => jumpToHighlight(highlight)}
                >
                  <span className="highlight-item__page">Page {getHighlightPage(highlight)}</span>
                  <span className="highlight-item__text">{highlight.text}</span>
                  <span
                    className="icon-button icon-button--inline"
                    role="button"
                    tabIndex={0}
                    aria-label="Delete highlight"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteHighlight(highlight.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        void deleteHighlight(highlight.id);
                      }
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <textarea className="debug-geometry-output" readOnly value={debugGeometry} aria-hidden="true" />
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="document-title">
            <span>{document?.title ?? "No PDF open"}</span>
            <small>
              {isLoadingPdf
                ? "Loading"
                : document && loadedPdf
                  ? `${status} · ${selectableWordCount.toLocaleString()} selectable characters`
                  : status}
            </small>
          </div>

          <div className="toolbar-actions" aria-label="View controls">
            <button
              className="icon-button"
              type="button"
              onClick={() => zoomFromLastViewerPoint((current) => current - SCALE_STEP)}
              aria-label="Zoom out"
            >
              <ZoomOut aria-hidden="true" />
            </button>
            <span className="zoom-value">{Math.round(scale * 100)}%</span>
            <button
              className="icon-button"
              type="button"
              onClick={() => zoomFromLastViewerPoint((current) => current + SCALE_STEP)}
              aria-label="Zoom in"
            >
              <ZoomIn aria-hidden="true" />
            </button>
          </div>
        </header>

        <div
          className={`viewer ${isWordCursorActive ? "is-word-hovered" : ""}`}
          ref={viewerRef}
          onMouseMove={handleViewerMouseMove}
          onMouseDown={handleViewerMouseDown}
          onMouseUp={handleViewerMouseUp}
          onMouseLeave={handleViewerMouseLeave}
          onWheel={handleViewerWheel}
        >
          {!document ? (
            <div className="empty-state">
              <FileText aria-hidden="true" />
              <h2>Open a PDF</h2>
            </div>
          ) : isLoadingPdf || !loadedPdf ? (
            <div className="empty-state">
              <FileText aria-hidden="true" />
              <h2>{status}</h2>
            </div>
          ) : (
            <div className="page-stack">
              {loadedPdf.pages.map((page, index) => (
                <PdfPage
                  key={`${document.id}-${index + 1}`}
                  page={page}
                  pageNumber={index + 1}
                  displayScale={scale}
                  highlights={document.highlights}
                  activeHighlightId={activeHighlightId}
                  draftWordIds={draftWordIds}
                  onPageWordsChange={updatePageWords}
                  onPageDiagnosticsChange={updatePageDiagnostics}
                  setPageRef={setPageRef}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

type DiagnosticsPanelProps = {
  runtimeDiagnostics: RuntimeDiagnostics;
  pageDiagnostics: Record<number, PageDiagnostics>;
  selectableWordCount: number;
};

function DiagnosticsPanel({
  runtimeDiagnostics,
  pageDiagnostics,
  selectableWordCount,
}: DiagnosticsPanelProps) {
  const pages = Object.values(pageDiagnostics).sort((a, b) => a.page - b.page);
  const totals = pages.reduce(
    (current, page) => ({
      textItems: current.textItems + page.textItems,
      nonemptyTextItems: current.nonemptyTextItems + page.nonemptyTextItems,
      textChars: current.textChars + page.textChars,
      textLayerSpans: current.textLayerSpans + page.textLayerSpans,
      nonemptyTextLayerSpans: current.nonemptyTextLayerSpans + page.nonemptyTextLayerSpans,
      textLayerWords: current.textLayerWords + page.textLayerWords,
      metricFallbackWords: current.metricFallbackWords + page.metricFallbackWords,
      finalWords: current.finalWords + page.finalWords,
    }),
    {
      textItems: 0,
      nonemptyTextItems: 0,
      textChars: 0,
      textLayerSpans: 0,
      nonemptyTextLayerSpans: 0,
      textLayerWords: 0,
      metricFallbackWords: 0,
      finalWords: 0,
    },
  );
  const report = {
    capturedAt: new Date().toISOString(),
    selectableWordCount,
    runtime: runtimeDiagnostics,
    totals,
    pages: pages.slice(0, 8),
    pageCountCaptured: pages.length,
    pagesWithErrors: pages.filter((page) => page.lastError),
    pagesPendingTextLayer: pages.filter((page) => page.textLayer === "pending-over-5s").map((page) => page.page),
  };
  const reportText = JSON.stringify(report, null, 2);

  const copyDiagnostics = useCallback(() => {
    void navigator.clipboard?.writeText(reportText);
  }, [reportText]);

  return (
    <section className="diagnostics-panel" aria-label="PDF diagnostics">
      <div className="diagnostics-panel__header">
        <div>
          <span className="eyebrow">Diagnostics</span>
          <strong>{totals.finalWords.toLocaleString()}</strong>
        </div>
        <button className="diagnostics-copy" type="button" onClick={copyDiagnostics}>
          Copy
        </button>
      </div>
      <textarea className="diagnostics-output" readOnly value={reportText} />
    </section>
  );
}

type PdfPageProps = {
  page: pdfjs.PDFPageProxy;
  pageNumber: number;
  displayScale: number;
  highlights: Highlight[];
  activeHighlightId: string | null;
  draftWordIds: Set<string>;
  onPageWordsChange: (pageNumber: number, words: WordBox[]) => void;
  onPageDiagnosticsChange: (pageNumber: number, patch: Partial<PageDiagnostics>) => void;
  setPageRef: (pageNumber: number, element: HTMLElement | null) => void;
};

function PdfPage({
  page,
  pageNumber,
  displayScale,
  highlights,
  activeHighlightId,
  draftWordIds,
  onPageWordsChange,
  onPageDiagnosticsChange,
  setPageRef,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [words, setWords] = useState<WordBox[]>([]);
  const [viewportSize, setViewportSize] = useState({
    baseWidth: 0,
    baseHeight: 0,
    renderWidth: 0,
    renderHeight: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PAGE_RENDER_SCALE });
    const canvas = canvasRef.current;
    const textLayer = textLayerRef.current;

    setViewportSize({
      baseWidth: baseViewport.width,
      baseHeight: baseViewport.height,
      renderWidth: viewport.width,
      renderHeight: viewport.height,
    });

    if (!canvas || !textLayer) {
      return;
    }

    const context = canvas.getContext("2d");
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

    if (!context) {
      return;
    }

    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const currentTextLayer = textLayer;
    const renderTask = page.render({ canvas, canvasContext: context, viewport });
    const textContentPromise = page.getTextContent();

    onPageDiagnosticsChange(pageNumber, {
      canvas: "rendering",
      textContent: "loading",
      textLayer: "not-started",
      lastError: null,
    });

    renderTask.promise.then(
      () => {
        if (!cancelled) {
          onPageDiagnosticsChange(pageNumber, { canvas: "rendered" });
        }
      },
      (error) => {
        if (!cancelled) {
          onPageDiagnosticsChange(pageNumber, {
            canvas: "failed",
            lastError: `Canvas render failed: ${serializeError(error)}`,
          });
          console.warn(`[pdf-annotation] Canvas render failed on page ${pageNumber}.`, error);
        }
      },
    );

    async function renderPage() {
      let textLayerPendingTimer = 0;

      try {
        const textContent = await textContentPromise;
        const textContentSummary = summarizeTextContent(textContent);

        if (!cancelled) {
          onPageDiagnosticsChange(pageNumber, {
            textContent: "loaded",
            ...textContentSummary,
          });

          let nextWords = buildMetricWordBoxes(textContent, viewport, pageNumber);
          onPageDiagnosticsChange(pageNumber, { metricFallbackWords: nextWords.length });

          try {
            onPageDiagnosticsChange(pageNumber, { textLayer: "rendering" });
            textLayerPendingTimer = window.setTimeout(() => {
              if (!cancelled) {
                onPageDiagnosticsChange(pageNumber, { textLayer: "pending-over-5s" });
              }
            }, 5000);
            await renderTextLayer(textContent, viewport, currentTextLayer);
            window.clearTimeout(textLayerPendingTimer);
            onPageDiagnosticsChange(pageNumber, {
              textLayer: "rendered",
              ...summarizeTextLayer(currentTextLayer),
              textLayerWords: currentTextLayer.closest<HTMLElement>(".pdf-page")
                ? buildWordBoxesFromTextLayer(
                    currentTextLayer,
                    currentTextLayer.closest<HTMLElement>(".pdf-page")!,
                    pageNumber,
                  ).length
                : 0,
            });
          } catch (error) {
            window.clearTimeout(textLayerPendingTimer);
            currentTextLayer.innerHTML = "";
            onPageDiagnosticsChange(pageNumber, {
              textLayer: "failed",
              lastError: `Text layer failed: ${serializeError(error)}`,
            });
            console.warn(`[pdf-annotation] Text layer failed on page ${pageNumber}; using metric fallback.`, error);
          }

          if (nextWords.length === 0) {
            console.warn(`[pdf-annotation] No selectable characters found on page ${pageNumber}.`);
          }

          if (!cancelled) {
            onPageDiagnosticsChange(pageNumber, { finalWords: nextWords.length });
            setWords(nextWords);
            onPageWordsChange(pageNumber, nextWords);
          }
        }
      } catch (error) {
        if (!cancelled) {
          currentTextLayer.innerHTML = "";
          onPageDiagnosticsChange(pageNumber, {
            textContent: "failed",
            lastError: `Page render failed: ${serializeError(error)}`,
          });
          setWords([]);
          onPageWordsChange(pageNumber, []);
        }
      } finally {
        window.clearTimeout(textLayerPendingTimer);
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      renderTask.cancel();
      onPageWordsChange(pageNumber, []);
    };
  }, [onPageDiagnosticsChange, onPageWordsChange, page, pageNumber]);

  const pageHighlights = highlights.filter((highlight) =>
    highlight.rects.some((rect) => rect.page === pageNumber),
  );
  const draftRects = wordsToHighlightRects(words.filter((word) => draftWordIds.has(word.id)));
  const displayWidth = viewportSize.baseWidth * displayScale;
  const displayHeight = viewportSize.baseHeight * displayScale;
  const contentScale = displayScale / PAGE_RENDER_SCALE;

  return (
    <article
      className="page-frame"
      style={{ width: displayWidth || undefined }}
      aria-label={`Page ${pageNumber}`}
    >
      <div
        className="pdf-page"
        ref={(element) => setPageRef(pageNumber, element)}
        data-page-number={pageNumber}
        style={{
          width: displayWidth || undefined,
          height: displayHeight || undefined,
        }}
      >
        <div
          className="pdf-page-content"
          style={{
            width: viewportSize.renderWidth || undefined,
            height: viewportSize.renderHeight || undefined,
            transform: `scale(${contentScale})`,
          }}
        >
          <canvas ref={canvasRef} />
          <div className="textLayer text-layer" ref={textLayerRef} />
          <div className="highlight-layer" aria-hidden="true">
            {pageHighlights.flatMap((highlight) =>
              highlight.rects
                .filter((rect) => rect.page === pageNumber)
                .map((rect, index) => (
                  <div
                    key={`${highlight.id}-${index}`}
                    className={`highlight-mark ${activeHighlightId === highlight.id ? "is-active" : ""}`}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                    }}
                  />
                )),
            )}
            {draftRects.map((rect, index) => (
              <div
                key={`draft-${pageNumber}-${index}`}
                className="draft-highlight-mark"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="page-number">Page {pageNumber}</div>
    </article>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildWordBoxesFromTextLayer(
  textLayer: HTMLElement,
  pageElement: HTMLElement,
  pageNumber: number,
) {
  const pageBox = pageElement.getBoundingClientRect();
  const words: WordBox[] = [];
  let order = 0;

  if (pageBox.width <= 0 || pageBox.height <= 0) {
    return words;
  }

  for (const span of textLayer.querySelectorAll<HTMLElement>("span")) {
    const text = span.textContent ?? "";
    const textNode = span.firstChild;

    if (!text) {
      continue;
    }

    const spanBox = span.getBoundingClientRect();

    if (spanBox.width <= 0 || spanBox.height <= 0) {
      continue;
    }

    for (let start = 0; start < text.length; start += 1) {
      const character = text[start];

      if (!character?.trim()) {
        continue;
      }

      const end = start + 1;
      const characterBox =
        textNode?.nodeType === Node.TEXT_NODE
          ? getWordBoxFromTextRange(textNode, start, end, pageBox, spanBox)
          : null;
      const fallbackLeft = spanBox.left + spanBox.width * (start / text.length);
      const fallbackRight = spanBox.left + spanBox.width * (end / text.length);
      const x = characterBox?.x ?? clamp((fallbackLeft - pageBox.left) / pageBox.width, 0, 1);
      const y = characterBox?.y ?? clamp((spanBox.top - pageBox.top) / pageBox.height, 0, 1);
      const width = characterBox?.width ?? clamp((fallbackRight - fallbackLeft) / pageBox.width, 0, 1 - x);
      const height = characterBox?.height ?? clamp(spanBox.height / pageBox.height, 0, 1 - y);

      if (width <= 0 || height <= 0) {
        continue;
      }

      words.push({
        id: `${pageNumber}-${order}`,
        page: pageNumber,
        line: 0,
        order,
        segment: 0,
        segmentOrder: 0,
        text: character,
        x,
        y,
        width,
        height,
      });
      order += 1;
    }
  }

  return assignVisualLines(words);
}

function getWordBoxFromTextRange(
  textNode: ChildNode,
  start: number,
  end: number,
  pageBox: DOMRect,
  lineBox?: DOMRect,
) {
  const range = window.document.createRange();

  try {
    range.setStart(textNode, start);
    range.setEnd(textNode, end);

    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);

    if (rects.length === 0) {
      return null;
    }

    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = lineBox?.top ?? Math.min(...rects.map((rect) => rect.top));
    const bottom = lineBox?.bottom ?? Math.max(...rects.map((rect) => rect.bottom));
    const x = clamp((left - pageBox.left) / pageBox.width, 0, 1);
    const y = clamp((top - pageBox.top) / pageBox.height, 0, 1);

    return {
      x,
      y,
      width: clamp((right - left) / pageBox.width, 0, 1 - x),
      height: clamp((bottom - top) / pageBox.height, 0, 1 - y),
    };
  } finally {
    range.detach();
  }
}

function buildMetricWordBoxes(
  textContent: PdfTextContent,
  viewport: pdfjs.PageViewport,
  pageNumber: number,
): WordBox[] {
  const styles = textContent.styles as Record<string, PdfTextStyle>;
  const words: WordBox[] = [];
  const segments: VisualSegmentDraft[] = [];
  let order = 0;

  for (const item of textContent.items) {
    if (!("str" in item)) {
      continue;
    }

    const textItem = item as PdfTextItem;
    const text = textItem.str;

    if (!text.trim()) {
      continue;
    }

    const transform = pdfjs.Util.transform(viewport.transform, textItem.transform);
    const fontHeight = Math.max(
      Math.hypot(transform[2], transform[3]),
      Math.abs(textItem.height * viewport.scale),
      1,
    );
    const itemWidth = Math.max(Math.abs(textItem.width * viewport.scale), fontHeight * text.length * 0.45);
    const style = textItem.fontName ? styles[textItem.fontName] : undefined;
    const ascent = clamp(style?.ascent ?? 0.8, 0.62, 0.95);
    const lineTop = transform[5] - fontHeight * ascent;
    const hitHeight = fontHeight * 0.92;
    const hitTop = lineTop + fontHeight * 0.04;
    const segmentWords: WordBox[] = [];

    for (let start = 0; start < text.length; start += 1) {
      const character = text[start];

      if (!character?.trim()) {
        continue;
      }

      const end = start + 1;
      const left = transform[4] + itemWidth * (start / text.length);
      const right = transform[4] + itemWidth * (end / text.length);
      const x = clamp(left / viewport.width, 0, 1);
      const y = clamp(hitTop / viewport.height, 0, 1);
      const width = clamp((right - left) / viewport.width, 0, 1 - x);
      const height = clamp(hitHeight / viewport.height, 0, 1 - y);

      if (width <= 0 || height <= 0) {
        continue;
      }

      const word = {
        id: `${pageNumber}-${order}`,
        page: pageNumber,
        line: 0,
        order,
        segment: 0,
        segmentOrder: 0,
        text: character,
        x,
        y,
        width,
        height,
      };
      words.push(word);
      segmentWords.push(word);
      order += 1;
    }

    if (segmentWords.length > 0) {
      segments.push(createVisualSegmentDraft(segmentWords));
    }
  }

  return assignVisualSegments(segments);
}

function createVisualSegmentDraft(words: WordBox[]): VisualSegmentDraft {
  const x = Math.min(...words.map((word) => word.x));
  const y = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.width));
  const bottom = Math.max(...words.map((word) => word.y + word.height));

  return {
    words,
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function getWordAtClientPoint(
  clientX: number,
  clientY: number,
  pageRefs: Map<number, HTMLElement>,
  wordsByPage: Map<number, WordBox[]>,
  options: { nearest?: boolean } = {},
) {
  for (const [pageNumber, pageElement] of pageRefs) {
    const pageBox = pageElement.getBoundingClientRect();

    if (
      pageBox.width <= 0 ||
      pageBox.height <= 0 ||
      clientX < pageBox.left ||
      clientX > pageBox.right ||
      clientY < pageBox.top ||
      clientY > pageBox.bottom
    ) {
      continue;
    }

    const words = wordsByPage.get(pageNumber) ?? [];
    const x = (clientX - pageBox.left) / pageBox.width;
    const y = (clientY - pageBox.top) / pageBox.height;
    const exactWord = findWordAtPoint(words, x, y);

    if (exactWord) {
      return exactWord;
    }

    return options.nearest ? findNearestWordAtPoint(words, x, y) : null;
  }

  return null;
}

function summarizeDebugPageGeometry(words: WordBox[]) {
  return Array.from(new Set(words.map((word) => word.segment))).map((segment) => {
    const segmentWords = words.filter((word) => word.segment === segment).sort(compareWordsVisually);
    const x = Math.min(...segmentWords.map((word) => word.x));
    const y = Math.min(...segmentWords.map((word) => word.y));
    const right = Math.max(...segmentWords.map((word) => word.x + word.width));
    const bottom = Math.max(...segmentWords.map((word) => word.y + word.height));

    return {
      segment,
      line: segmentWords[0]?.line ?? 0,
      text: wordsToText(segmentWords),
      x,
      y,
      right,
      bottom,
      count: segmentWords.length,
    };
  });
}

function assignVisualLines(words: WordBox[]) {
  const sortedWords = [...words].sort(compareWordsVisually);
  const lines: WordBox[][] = [];

  for (const word of sortedWords) {
    const centerY = getRectCenterY(word);
    const line = lines.find((currentLine) => {
      const first = currentLine[0];
      const lineCenterY = currentLine.reduce((total, item) => total + getRectCenterY(item), 0) / currentLine.length;
      const lineHeight = Math.max(...currentLine.map((item) => item.height), word.height, first.height);

      return Math.abs(centerY - lineCenterY) <= lineHeight * 0.58;
    });

    if (line) {
      line.push(word);
    } else {
      lines.push([word]);
    }
  }

  const visualSegments = lines
    .sort((a, b) => getRectCenterY(a[0]) - getRectCenterY(b[0]))
    .flatMap((line, lineIndex) => {
      const lineWords = line.sort((a, b) => a.x - b.x || a.order - b.order);
      const gaps = lineWords
        .slice(1)
        .map((word, index) => ({
          index: index + 1,
          gap: word.x - (lineWords[index].x + lineWords[index].width),
        }))
        .filter(({ gap }) => gap > 0)
        .sort((a, b) => a.gap - b.gap);
      const normalTextGaps = gaps.filter(({ gap }) => gap <= 0.018);
      const normalGap =
        normalTextGaps.length > 0
          ? normalTextGaps[Math.floor(normalTextGaps.length * 0.75)].gap
          : gaps[0]?.gap ?? 0;
      const segments: WordBox[][] = [];
      let currentSegment: WordBox[] = [];
      let previous: WordBox | null = null;

      for (const word of lineWords) {
        const gap = previous ? word.x - (previous.x + previous.width) : 0;
        const splitGap = Math.max(normalGap * 2.75, word.height * 0.85, 0.018);

        if (previous && gap > splitGap && currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }

        currentSegment.push(word);
        previous = word;
      }

      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }

      return segments.map((segment) => ({
        line: lineIndex,
        words: segment,
        x: Math.min(...segment.map((word) => word.x)),
        y: Math.min(...segment.map((word) => word.y)),
        width: Math.max(...segment.map((word) => word.x + word.width)) - Math.min(...segment.map((word) => word.x)),
        height: Math.max(...segment.map((word) => word.y + word.height)) - Math.min(...segment.map((word) => word.y)),
      }));
    });

  return assignVisualSegments(visualSegments);
}

function assignVisualSegments(visualSegments: VisualSegmentDraft[]) {
  const columns: VisualSegmentDraft[][] = [];

  for (const segment of visualSegments) {
    const segmentCenterX = segment.x + segment.width / 2;
    const column = columns.find((candidate) => {
      const columnLeft = Math.min(...candidate.map((item) => item.x));
      const columnRight = Math.max(...candidate.map((item) => item.x + item.width));
      const overlap = Math.min(columnRight, segment.x + segment.width) - Math.max(columnLeft, segment.x);
      const narrowWidth = Math.min(columnRight - columnLeft, segment.width);

      return overlap > narrowWidth * 0.35 || (segmentCenterX >= columnLeft && segmentCenterX <= columnRight);
    });

    if (column) {
      column.push(segment);
    } else {
      columns.push([segment]);
    }
  }

  let segmentIndex = 0;

  return columns
    .sort((a, b) => {
      const topA = Math.min(...a.map((segment) => segment.y));
      const topB = Math.min(...b.map((segment) => segment.y));
      const leftA = Math.min(...a.map((segment) => segment.x));
      const leftB = Math.min(...b.map((segment) => segment.x));

      if (Math.abs(topA - topB) > Math.max(a[0].height, b[0].height) * 2.5) {
        return topA - topB;
      }

      return leftA - leftB;
    })
    .flatMap((column) =>
      column
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .flatMap((segment) => {
          const currentSegmentIndex = segmentIndex;
          segmentIndex += 1;

          return segment.words.map((word, segmentOrder) => ({
            ...word,
            line: segment.line ?? currentSegmentIndex,
            segment: currentSegmentIndex,
            segmentOrder,
          }));
        }),
    );
}

function findWordAtPoint(words: WordBox[], x: number, y: number) {
  let bestWord: WordBox | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const word of words) {
    const horizontalPadding = Math.min(Math.max(word.width * 0.12, 0.0008), 0.004);
    const verticalPadding = Math.min(Math.max(word.height * 0.22, 0.0015), 0.01);

    if (
      x < word.x - horizontalPadding ||
      x > word.x + word.width + horizontalPadding ||
      y < word.y - verticalPadding ||
      y > word.y + word.height + verticalPadding
    ) {
      continue;
    }

    const centerX = word.x + word.width / 2;
    const centerY = word.y + word.height / 2;
    const score = Math.abs(x - centerX) + Math.abs(y - centerY) * 2;

    if (score < bestScore) {
      bestScore = score;
      bestWord = word;
    }
  }

  return bestWord;
}

function findNearestWordAtPoint(words: WordBox[], x: number, y: number) {
  let bestWord: WordBox | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const word of words) {
    const centerX = word.x + word.width / 2;
    const centerY = word.y + word.height / 2;
    const verticalDistance = Math.abs(y - centerY);
    const sameLineLimit = Math.max(word.height * 1.45, 0.012);

    if (verticalDistance > sameLineLimit) {
      continue;
    }

    const horizontalDistance =
      x < word.x ? word.x - x : x > word.x + word.width ? x - (word.x + word.width) : 0;
    const score = verticalDistance * 4 + horizontalDistance;

    if (score < bestScore) {
      bestScore = score;
      bestWord = word;
    }
  }

  return bestWord;
}

function getWordsInRange(start: WordBox, end: WordBox, wordsByPage: Map<number, WordBox[]>) {
  const forward = compareWordsVisually(start, end) <= 0;
  const first = forward ? start : end;
  const last = forward ? end : start;
  const selectedWords: WordBox[] = [];

  for (let page = first.page; page <= last.page; page += 1) {
    const pageWords = wordsByPage.get(page) ?? [];

    if (first.page === last.page && page === first.page) {
      selectedWords.push(...getWordsInVisualPageRange(first, last, pageWords));
      continue;
    }

    if (page === first.page) {
      selectedWords.push(...getWordsAfterVisualPoint(first, pageWords));
      continue;
    }

    if (page === last.page) {
      selectedWords.push(...getWordsBeforeVisualPoint(last, pageWords));
      continue;
    }

    selectedWords.push(...pageWords);
  }

  return selectedWords.sort(compareWordsVisually);
}

function compareWords(a: WordBox, b: WordBox) {
  return a.page === b.page ? a.order - b.order : a.page - b.page;
}

function compareWordsVisually(a: WordBox, b: WordBox) {
  return a.page === b.page
    ? a.segment - b.segment || a.segmentOrder - b.segmentOrder || a.order - b.order
    : a.page - b.page;
}

function getWordsInVisualPageRange(first: WordBox, last: WordBox, pageWords: WordBox[]) {
  if (first.segment === last.segment) {
    const minX = Math.min(getRectCenterX(first), getRectCenterX(last));
    const maxX = Math.max(getRectCenterX(first), getRectCenterX(last));

    return pageWords.filter((word) => {
      const centerX = getRectCenterX(word);
      return word.segment === first.segment && centerX >= minX && centerX <= maxX;
    });
  }

  const start = compareWordsVisually(first, last) <= 0 ? first : last;
  const end = start === first ? last : first;

  return pageWords.filter((word) => {
    if (word.segment < start.segment || word.segment > end.segment) {
      return false;
    }

    if (word.segment === start.segment) {
      return getRectCenterX(word) >= getRectCenterX(start);
    }

    if (word.segment === end.segment) {
      return getRectCenterX(word) <= getRectCenterX(end);
    }

    return true;
  });
}

function getWordsAfterVisualPoint(start: WordBox, pageWords: WordBox[]) {
  return pageWords.filter((word) => {
    if (word.segment > start.segment) {
      return true;
    }

    return word.segment === start.segment && getRectCenterX(word) >= getRectCenterX(start);
  });
}

function getWordsBeforeVisualPoint(end: WordBox, pageWords: WordBox[]) {
  return pageWords.filter((word) => {
    if (word.segment < end.segment) {
      return true;
    }

    return word.segment === end.segment && getRectCenterX(word) <= getRectCenterX(end);
  });
}

function getRectCenterX(rect: HighlightRect) {
  return rect.x + rect.width / 2;
}

function getRectCenterY(rect: HighlightRect) {
  return rect.y + rect.height / 2;
}

function wordsToText(words: WordBox[]) {
  let text = "";
  let previous: WordBox | null = null;

  for (const word of words.sort(compareWordsVisually)) {
    if (previous) {
      const changedLine = previous.page !== word.page || previous.segment !== word.segment;
      const horizontalGap = word.x - (previous.x + previous.width);
      const likelyWordGap = horizontalGap > Math.max(Math.min(previous.height, word.height) * 0.22, 0.0025);

      if ((changedLine || likelyWordGap) && text && !text.endsWith(" ")) {
        text += " ";
      }
    }

    text += word.text;
    previous = word;
  }

  return text.replace(/\s+/g, " ").trim();
}

function wordsToHighlightRects(words: WordBox[]) {
  const rects: HighlightRect[] = [];
  let current: HighlightRect | null = null;
  let currentSegment: number | null = null;

  for (const word of words.sort(compareWordsVisually)) {
    const verticalInset = word.height * 0.02;
    const horizontalInset = Math.min(word.width * 0.015, 0.0005);
    const x = clamp(word.x - horizontalInset, 0, 1);
    const y = clamp(word.y + verticalInset, 0, 1);
    const wordRect: HighlightRect = {
      page: word.page,
      x,
      y,
      width: clamp(word.width + horizontalInset * 2, 0, 1 - x),
      height: clamp(word.height - verticalInset * 2, 0, 1 - y),
    };

    if (!current || current.page !== word.page || currentSegment !== word.segment) {
      if (current) {
        rects.push(current);
      }

      current = wordRect;
      currentSegment = word.segment;
      continue;
    }

    const right = Math.max(current.x + current.width, wordRect.x + wordRect.width);
    const bottom = Math.max(current.y + current.height, wordRect.y + wordRect.height);
    current.x = Math.min(current.x, wordRect.x);
    current.y = Math.min(current.y, wordRect.y);
    current.width = right - current.x;
    current.height = bottom - current.y;
  }

  if (current) {
    rects.push(current);
  }

  return rects;
}

export default App;
