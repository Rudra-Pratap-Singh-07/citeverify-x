import type * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Highlight, IngestionResult } from './types';
import type { Store } from './state';

// PDF.js types — loaded dynamically to avoid Vite chunking issues with the worker
type PdfjsLib = typeof pdfjs;

interface PageCache {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  container: HTMLElement;
  pdfWidth: number;
  pdfHeight: number;
}

export class PdfViewer {
  private el: HTMLElement;
  private store: Store;
  private lib!: PdfjsLib;
  private pdf: PDFDocumentProxy | null = null;
  private pageCache: Map<number, PageCache> = new Map();
  private result: IngestionResult | null = null;
  private currentScale = 1.5;
  private resizeObserver: ResizeObserver;
  private activeHighlights: Highlight[] = [];

  constructor(container: HTMLElement, store: Store) {
    this.el = container;
    this.store = store;

    // Recompute overlays on container resize
    this.resizeObserver = new ResizeObserver(() => {
      void this.redrawAllOverlays();
    });
    this.resizeObserver.observe(this.el);

    // Subscribe to selection changes
    this.store.subscribe((sel) => {
      if (!this.result || !sel) {
        this.clearOverlays();
        return;
      }
      // Find highlights for the selected claim
      const allRows = [...this.result.citation_maps, ...this.result.unresolved];
      const matchingRows = allRows.filter((r) => r.claim_id === sel.claim_id);
      if (matchingRows.length === 0) return;
      const claim = matchingRows[0];
      this.activeHighlights = claim.highlights;
      void this.drawHighlightsAndScroll(claim.highlights, claim.page_number);
    });
  }

  async init(): Promise<void> {
    // Dynamic import keeps pdfjs out of main bundle until needed
    this.lib = await import('pdfjs-dist');
    // Use the bundled worker via Vite
    this.lib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString();
  }

  async load(pdfBytes: ArrayBuffer): Promise<void> {
    this.el.innerHTML = '';
    this.pageCache.clear();
    this.activeHighlights = [];

    this.showStatus('loading', 'Loading PDF…');

    if (!this.lib) await this.init();

    try {
      this.pdf = await this.lib.getDocument({ data: pdfBytes }).promise;
    } catch (err) {
      this.showStatus('error', `Could not read PDF: ${(err as Error).message}`);
      return;
    }

    this.el.innerHTML = '';
    const pageCount = this.pdf.numPages;
    for (let i = 1; i <= pageCount; i++) {
      await this.renderPage(i);
    }
  }

  setResult(result: IngestionResult): void {
    this.result = result;
  }

  private async renderPage(pageNum: number): Promise<void> {
    const page = await this.pdf!.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.currentScale });

    const container = document.createElement('div');
    container.className = 'pdf-page';
    container.dataset['page'] = String(pageNum);
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.setAttribute('aria-label', `Page ${pageNum}`);

    // Main render canvas
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.display = 'block';

    // Overlay canvas for highlights (sits on top via CSS position:absolute)
    const overlay = document.createElement('canvas');
    overlay.width = Math.floor(viewport.width);
    overlay.height = Math.floor(viewport.height);
    overlay.className = 'highlight-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    container.appendChild(canvas);
    container.appendChild(overlay);
    this.el.appendChild(container);

    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;

    const baseVP = page.getViewport({ scale: 1 });
    this.pageCache.set(pageNum, {
      page,
      canvas,
      overlay,
      container,
      pdfWidth: baseVP.width,
      pdfHeight: baseVP.height,
    });
  }

  private async drawHighlightsAndScroll(highlights: Highlight[], firstPage: number): Promise<void> {
    this.clearOverlays();

    for (const hl of highlights) {
      const cache = this.pageCache.get(hl.page_number);
      if (!cache) continue;

      const { overlay, pdfWidth, pdfHeight } = cache;
      const scaleX = overlay.width / pdfWidth;
      const scaleY = overlay.height / pdfHeight;

      const ctx = overlay.getContext('2d')!;
      const x = hl.bounding_box.x0 * scaleX;
      const y = hl.bounding_box.y0 * scaleY;
      const w = (hl.bounding_box.x1 - hl.bounding_box.x0) * scaleX;
      const h = (hl.bounding_box.y1 - hl.bounding_box.y0) * scaleY;

      // Draw highlight rectangle
      ctx.save();
      ctx.fillStyle = 'rgba(255, 213, 0, 0.35)';
      ctx.strokeStyle = 'rgba(200, 150, 0, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    // Scroll the first page of the highlighted claim into view
    const firstCache = this.pageCache.get(firstPage);
    if (firstCache) {
      firstCache.container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  private clearOverlays(): void {
    for (const { overlay } of this.pageCache.values()) {
      const ctx = overlay.getContext('2d')!;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  private async redrawAllOverlays(): Promise<void> {
    if (this.activeHighlights.length === 0) return;

    // Re-render pages at new container width if zoom changed
    // For now, just redraw the highlights at current scale
    this.clearOverlays();
    if (this.activeHighlights.length > 0) {
      const firstPage = this.activeHighlights[0].page_number;
      await this.drawHighlightsAndScroll(this.activeHighlights, firstPage);
    }
  }

  setZoom(scale: number): void {
    this.currentScale = scale;
    // Re-render all pages at new scale
    const pdfRef = this.pdf;
    if (!pdfRef) return;
    this.el.innerHTML = '';
    this.pageCache.clear();
    const render = async () => {
      for (let i = 1; i <= pdfRef.numPages; i++) {
        await this.renderPage(i);
      }
      if (this.activeHighlights.length > 0) {
        await this.drawHighlightsAndScroll(
          this.activeHighlights,
          this.activeHighlights[0].page_number
        );
      }
    };
    void render();
  }

  private showStatus(type: 'loading' | 'error', message: string): void {
    this.el.innerHTML = `
      <div class="pdf-status pdf-status--${type}" role="status" aria-live="polite">
        <span class="pdf-status__icon" aria-hidden="true">${type === 'loading' ? '⟳' : '✕'}</span>
        <p>${message}</p>
      </div>`;
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.pdf?.destroy();
  }
}
