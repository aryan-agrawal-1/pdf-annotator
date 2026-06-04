import * as pdfjs from "pdfjs-dist";

type PdfTextContent = Awaited<ReturnType<pdfjs.PDFPageProxy["getTextContent"]>>;

export async function renderTextLayer(
  textContent: PdfTextContent,
  viewport: pdfjs.PageViewport,
  container: HTMLDivElement,
) {
  container.innerHTML = "";
  const textLayer = new pdfjs.TextLayer({
    container,
    textContentSource: textContent,
    viewport,
  });

  await textLayer.render();
}
