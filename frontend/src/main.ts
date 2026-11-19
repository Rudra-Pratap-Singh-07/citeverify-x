import './styles.css';
import { ExtractionList } from './ExtractionList';
import { PdfViewer } from './PdfViewer';
import { DetailPanel } from './DetailPanel';
import { createStore } from './state';
import { loadDemoFixture, loadIngestionResult, readAsArrayBuffer, LoadError } from './loader';
import type { IngestionResult } from './types';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const demoBanner = document.getElementById('demo-banner')!;
const warningBanner = document.getElementById('warning-banner')!;
const errorBanner = document.getElementById('error-banner')!;
const pdfInput = document.getElementById('pdf-input') as HTMLInputElement;
const jsonInput = document.getElementById('json-input') as HTMLInputElement;
const loadDemoBtn = document.getElementById('load-demo-btn') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('zoom-reset') as HTMLButtonElement;
const zoomLabel = document.getElementById('zoom-label')!;

const listContainer = document.getElementById('extraction-list')!;
const pdfContainer = document.getElementById('pdf-viewport')!;
const detailContainer = document.getElementById('detail-panel')!;

// ─── State ────────────────────────────────────────────────────────────────────
const store = createStore();
const extractionList = new ExtractionList(listContainer, store);
const pdfViewer = new PdfViewer(pdfContainer, store);
const detailPanel = new DetailPanel(detailContainer, store);

// suppress unused warning
void detailPanel;

let currentScale = 1.5;
const SCALE_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;

// ─── File pair tracking ───────────────────────────────────────────────────────
let pendingPdfBytes: ArrayBuffer | null = null;
let pendingResult: IngestionResult | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showError(msg: string): void {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  errorBanner.setAttribute('role', 'alert');
}

function clearError(): void {
  errorBanner.textContent = '';
  errorBanner.hidden = true;
}

function showWarnings(warnings: string[]): void {
  if (warnings.length === 0) {
    warningBanner.hidden = true;
    return;
  }
  warningBanner.innerHTML = warnings.map((w) => `<p>⚠ ${w}</p>`).join('');
  warningBanner.hidden = false;
}

async function loadPair(pdfBytes: ArrayBuffer, result: IngestionResult, isDemo: boolean): Promise<void> {
  clearError();
  store.set(null);
  demoBanner.hidden = !isDemo;
  showWarnings(result.warnings);
  extractionList.render(result);
  pdfViewer.setResult(result);
  await pdfViewer.load(pdfBytes);
}

async function tryLoadIfPairReady(): Promise<void> {
  if (pendingPdfBytes && pendingResult) {
    await loadPair(pendingPdfBytes, pendingResult, false);
    pendingPdfBytes = null;
    pendingResult = null;
  }
}

// ─── File inputs ──────────────────────────────────────────────────────────────
pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files?.[0];
  if (!file) return;
  clearError();
  try {
    pendingPdfBytes = await readAsArrayBuffer(file);
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  await tryLoadIfPairReady();
});

jsonInput.addEventListener('change', async () => {
  const file = jsonInput.files?.[0];
  if (!file) return;
  clearError();
  try {
    pendingResult = await loadIngestionResult(file);
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  await tryLoadIfPairReady();
});

// ─── Demo loader ──────────────────────────────────────────────────────────────
loadDemoBtn.addEventListener('click', async () => {
  clearError();
  loadDemoBtn.disabled = true;
  loadDemoBtn.textContent = 'Loading…';
  try {
    const { pdfBytes, result } = await loadDemoFixture();
    await loadPair(pdfBytes, result, true);
  } catch (err) {
    if (err instanceof LoadError) {
      showError(err.message);
    } else {
      // Fallback: fetch may be blocked when opened as file://
      showError(
        'Could not fetch demo files. ' +
        'Open the app via "pnpm dev" or drop examples/demo.pdf and examples/demo-result.json manually.'
      );
    }
  } finally {
    loadDemoBtn.disabled = false;
    loadDemoBtn.textContent = 'Load Demo';
  }
});

// ─── Zoom controls ────────────────────────────────────────────────────────────
function applyZoom(scale: number): void {
  currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  zoomLabel.textContent = `${Math.round(currentScale * 100)}%`;
  zoomInBtn.disabled = currentScale >= MAX_SCALE;
  zoomOutBtn.disabled = currentScale <= MIN_SCALE;
  pdfViewer.setZoom(currentScale);
}

zoomInBtn.addEventListener('click', () => applyZoom(currentScale + SCALE_STEP));
zoomOutBtn.addEventListener('click', () => applyZoom(currentScale - SCALE_STEP));
zoomResetBtn.addEventListener('click', () => applyZoom(1.5));

// Initial zoom label
zoomLabel.textContent = `${Math.round(currentScale * 100)}%`;

// ─── Init PDF.js worker ───────────────────────────────────────────────────────
void pdfViewer.init();
