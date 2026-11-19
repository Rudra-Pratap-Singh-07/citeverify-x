// CiteVerify-X — Comprehensive Reviewer UI (Native ES Module)
// Supports Phase 1 (Ingestion & Highlights), Phase 2 (Scholarly Resolvers & Integrity),
// and Phase 3 (Verification Verdicts, NLI Confidence & Numerical Audit).

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).toString();

// ─── State Management ─────────────────────────────────────────────────────────
export function createStore() {
  let current = null;
  let resolvedMap = new Map();
  let verdictsMap = new Map();
  const listeners = new Set();

  return {
    get() {
      return current;
    },
    set(sel) {
      current = sel;
      for (const fn of listeners) fn(sel);
    },
    setResolvedMap(map) {
      resolvedMap = map;
    },
    getResolved(anchorId) {
      return resolvedMap.get(anchorId) || null;
    },
    setVerdictsMap(map) {
      verdictsMap = map;
    },
    getVerdict(claimId, anchorId) {
      return verdictsMap.get(`${claimId}:${anchorId}`) || null;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ─── Loaders ──────────────────────────────────────────────────────────────────
export class LoadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoadError';
  }
}

export function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new LoadError(`Could not read file: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

export function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new LoadError(`Could not read file: ${file.name}`));
    reader.readAsText(file, 'utf-8');
  });
}

export async function loadIngestionResult(file) {
  const text = await readAsText(file);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError(`${file.name} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new LoadError(`${file.name}: expected a JSON object.`);
  }

  if (parsed.schema_version !== '1.0') {
    throw new LoadError(`Unsupported schema version "${parsed.schema_version}". Expected "1.0".`);
  }
  if (!Array.isArray(parsed.pages)) throw new LoadError('Missing "pages" array.');
  if (!Array.isArray(parsed.references)) throw new LoadError('Missing "references" array.');
  if (!Array.isArray(parsed.citation_maps)) throw new LoadError('Missing "citation_maps" array.');
  if (!Array.isArray(parsed.unresolved)) throw new LoadError('Missing "unresolved" array.');

  return parsed;
}

export async function loadResolvedReferences(file) {
  const text = await readAsText(file);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError(`${file.name} is not valid JSON.`);
  }

  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      if (r.anchor_id && r.paper) map.set(r.anchor_id, r.paper);
    }
  }
  return map;
}

export async function loadVerificationVerdicts(file) {
  const text = await readAsText(file);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError(`${file.name} is not valid JSON.`);
  }

  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const v of parsed) {
      if (v.claim_id && v.anchor_id) map.set(`${v.claim_id}:${v.anchor_id}`, v);
    }
  }
  return map;
}

export async function loadDemoFixture() {
  const [pdfResp, jsonResp, resolvedResp, verdictsResp] = await Promise.all([
    fetch('/examples/demo.pdf'),
    fetch('/examples/demo-result.json'),
    fetch('/examples/demo-resolved.json'),
    fetch('/examples/demo-verdicts.json'),
  ]);

  if (!pdfResp.ok) throw new LoadError('Could not load demo PDF from examples/demo.pdf');
  if (!jsonResp.ok) throw new LoadError('Could not load demo JSON from examples/demo-result.json');

  const [pdfBytes, resultText] = await Promise.all([pdfResp.arrayBuffer(), jsonResp.text()]);
  const result = JSON.parse(resultText);

  const resolvedMap = new Map();
  if (resolvedResp.ok) {
    try {
      const records = await resolvedResp.json();
      for (const r of records) resolvedMap.set(r.anchor_id, r.paper);
    } catch {}
  }

  const verdictsMap = new Map();
  if (verdictsResp.ok) {
    try {
      const vList = await verdictsResp.json();
      for (const v of vList) verdictsMap.set(`${v.claim_id}:${v.anchor_id}`, v);
    } catch {}
  }

  return { pdfBytes, result, resolvedMap, verdictsMap };
}

// ─── Extraction List ──────────────────────────────────────────────────────────
const REASON_LABELS = {
  missing_reference: 'Reference not found in bibliography',
  ambiguous_reference: 'Multiple bibliography entries match this citation',
  invalid_range: 'Citation marker contains an invalid numeric range',
};

export function buildClaimGroups(result) {
  const map = new Map();

  const ensureGroup = (row) => {
    if (!map.has(row.claim_id)) {
      map.set(row.claim_id, {
        claim_id: row.claim_id,
        sentence_text: row.sentence_text,
        page_number: row.page_number,
        bounding_box: row.bounding_box,
        highlights: row.highlights,
        citation_markers: row.citation_markers,
        matched: [],
        unresolved: [],
      });
    }
    return map.get(row.claim_id);
  };

  for (const cm of result.citation_maps) ensureGroup(cm).matched.push(cm);
  for (const ur of result.unresolved) ensureGroup(ur).unresolved.push(ur);

  return [...map.values()].sort((a, b) => {
    if (a.page_number !== b.page_number) return a.page_number - b.page_number;
    return a.bounding_box.y0 - b.bounding_box.y0;
  });
}

export class ExtractionList {
  constructor(container, store) {
    this.el = container;
    this.store = store;
    this.groups = [];
    this.rowEls = [];
    this.focusIndex = 0;
    this.el.setAttribute('role', 'list');
    this.el.setAttribute('aria-label', 'Empirical claims');

    this.el.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.store.subscribe((sel) => this.syncHighlight(sel?.claim_id ?? null, sel?.ref_anchor ?? null));
  }

  render(result) {
    this.groups = buildClaimGroups(result);
    this.rowEls = [];
    this.el.innerHTML = '';

    if (this.groups.length === 0) {
      this.el.innerHTML = `
        <div class="empty-state" role="status" aria-live="polite">
          <span class="empty-icon" aria-hidden="true">📄</span>
          <p>No empirical claims found in this document.</p>
        </div>`;
      return;
    }

    for (const group of this.groups) {
      this.el.appendChild(this.renderGroup(group));
    }
  }

  renderGroup(group) {
    const groupEl = document.createElement('div');
    groupEl.className = 'claim-group';
    groupEl.setAttribute('role', 'listitem');
    groupEl.dataset.claimId = group.claim_id;

    const header = document.createElement('div');
    header.className = 'claim-header';

    const statusBadge = document.createElement('span');
    const hasUnresolved = group.unresolved.length > 0;
    const hasMatched = group.matched.length > 0;

    if (hasUnresolved && !hasMatched) {
      statusBadge.className = 'badge badge--unresolved';
      statusBadge.textContent = 'Unresolved';
      statusBadge.setAttribute('aria-label', 'Unresolved citation');
    } else if (hasUnresolved) {
      statusBadge.className = 'badge badge--partial';
      statusBadge.textContent = 'Partial';
      statusBadge.setAttribute('aria-label', 'Partially resolved citation');
    } else {
      statusBadge.className = 'badge badge--matched';
      statusBadge.textContent = 'Matched';
      statusBadge.setAttribute('aria-label', 'Matched citation');
    }

    const sentence = document.createElement('p');
    sentence.className = 'claim-sentence';
    sentence.textContent = group.sentence_text;

    const markers = document.createElement('span');
    markers.className = 'claim-markers';
    markers.textContent = group.citation_markers.join(', ');
    markers.setAttribute('aria-label', `Markers: ${group.citation_markers.join(', ')}`);

    header.appendChild(statusBadge);
    header.appendChild(sentence);
    header.appendChild(markers);
    groupEl.appendChild(header);

    for (const cm of group.matched) {
      const row = this.makeRefRow(group, cm);
      groupEl.appendChild(row);
      this.rowEls.push(row);
    }

    for (const ur of group.unresolved) {
      const row = this.makeUnresolvedRow(group, ur);
      groupEl.appendChild(row);
      this.rowEls.push(row);
    }

    return groupEl;
  }

  makeRefRow(group, cm) {
    const row = document.createElement('button');
    row.className = 'ref-row ref-row--matched';
    row.setAttribute('type', 'button');
    row.setAttribute('tabindex', this.rowEls.length === 0 ? '0' : '-1');
    row.dataset.claimId = group.claim_id;
    row.dataset.refAnchor = cm.matched_reference.anchor_id;

    const anchorId = cm.matched_reference.anchor_id;
    const resolved = this.store.getResolved(anchorId);
    const verdict = this.store.getVerdict(group.claim_id, anchorId);

    const icon = document.createElement('span');
    icon.className = 'ref-icon';
    if (verdict?.label === 'SUPPORTED') {
      icon.textContent = '✓';
      icon.className = 'ref-icon ref-icon--supported';
    } else if (verdict?.label === 'CONTRADICTED') {
      icon.textContent = '✕';
      icon.className = 'ref-icon ref-icon--contradicted';
    } else if (verdict?.label === 'PARTIALLY_SUPPORTED') {
      icon.textContent = '≈';
      icon.className = 'ref-icon ref-icon--partial';
    } else {
      icon.textContent = '✓';
      icon.className = 'ref-icon ref-icon--matched';
    }
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'ref-label';
    const authors = cm.matched_reference.parsed_authors.slice(0, 2).join(', ');
    const year = cm.matched_reference.parsed_year ?? '—';
    const title = cm.matched_reference.parsed_title ?? cm.matched_reference.raw_text.slice(0, 50);
    label.textContent = `${authors} (${year}) — ${title}`;

    const badges = document.createElement('div');
    badges.className = 'ref-badges';

    // Phase 3: Verdict badge
    if (verdict) {
      const vBadge = document.createElement('span');
      const pct = Math.round(verdict.confidence * 100);
      vBadge.className = `badge badge--verdict badge--${verdict.label.toLowerCase()}`;
      vBadge.textContent = `${verdict.label.replace('_', ' ')} (${pct}%)`;
      badges.appendChild(vBadge);
    }

    // Phase 2: Integrity & OA badges
    if (resolved) {
      if (resolved.retraction_status === 'retracted' || resolved.openalex_retracted === true) {
        const retBadge = document.createElement('span');
        retBadge.className = 'badge badge--retracted';
        retBadge.textContent = '🚨 Retracted';
        badges.appendChild(retBadge);
      } else if (resolved.retraction_status === 'expression_of_concern') {
        const concernBadge = document.createElement('span');
        concernBadge.className = 'badge badge--concern';
        concernBadge.textContent = '⚠️ Concern';
        badges.appendChild(concernBadge);
      } else if (resolved.retraction_status === 'not_flagged') {
        const safeBadge = document.createElement('span');
        safeBadge.className = 'badge badge--safe';
        safeBadge.textContent = '🛡️ Not Flagged';
        badges.appendChild(safeBadge);
      }

      if (resolved.oa_status === 'available') {
        const oaBadge = document.createElement('span');
        oaBadge.className = 'badge badge--oa';
        oaBadge.textContent = '🔓 OA';
        badges.appendChild(oaBadge);
      }
    }

    row.appendChild(icon);
    row.appendChild(label);
    if (badges.childNodes.length > 0) row.appendChild(badges);

    row.addEventListener('click', () => {
      this.select(row);
      this.store.set({
        claim_id: group.claim_id,
        ref_anchor: anchorId,
        row: cm,
        resolved: this.store.getResolved(anchorId),
        verdict: this.store.getVerdict(group.claim_id, anchorId),
      });
    });

    return row;
  }

  makeUnresolvedRow(group, ur) {
    const row = document.createElement('button');
    row.className = 'ref-row ref-row--unresolved';
    row.setAttribute('type', 'button');
    row.setAttribute('tabindex', this.rowEls.length === 0 ? '0' : '-1');
    row.dataset.claimId = group.claim_id;
    row.dataset.refAnchor = '';

    const icon = document.createElement('span');
    icon.className = 'ref-icon ref-icon--unresolved';
    icon.textContent = '⚠';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'ref-label';
    label.textContent = `[${ur.target}] — ${REASON_LABELS[ur.reason] || ur.reason}`;

    row.appendChild(icon);
    row.appendChild(label);

    row.addEventListener('click', () => {
      this.select(row);
      this.store.set({
        claim_id: group.claim_id,
        ref_anchor: null,
        row: ur,
        resolved: null,
        verdict: null,
      });
    });

    return row;
  }

  select(row) {
    for (const r of this.rowEls) {
      r.setAttribute('aria-pressed', 'false');
      r.classList.remove('ref-row--selected');
      r.setAttribute('tabindex', '-1');
    }
    row.setAttribute('aria-pressed', 'true');
    row.classList.add('ref-row--selected');
    row.setAttribute('tabindex', '0');
    row.focus();
    this.focusIndex = this.rowEls.indexOf(row);
  }

  syncHighlight(claimId, refAnchor) {
    for (const r of this.rowEls) {
      const match =
        r.dataset.claimId === claimId &&
        (refAnchor === null || r.dataset.refAnchor === refAnchor);
      r.classList.toggle('ref-row--selected', match);
      r.setAttribute('aria-pressed', match ? 'true' : 'false');
    }
  }

  handleKeydown(e) {
    if (this.rowEls.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusIndex = Math.min(this.focusIndex + 1, this.rowEls.length - 1);
      this.moveFocus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusIndex = Math.max(this.focusIndex - 1, 0);
      this.moveFocus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.rowEls[this.focusIndex]?.click();
    }
  }

  moveFocus() {
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].setAttribute('tabindex', i === this.focusIndex ? '0' : '-1');
    }
    this.rowEls[this.focusIndex]?.focus();
  }
}

// ─── PDF Viewer ───────────────────────────────────────────────────────────────
export class PdfViewer {
  constructor(container, store) {
    this.el = container;
    this.store = store;
    this.pdf = null;
    this.pageCache = new Map();
    this.result = null;
    this.currentScale = 1.5;
    this.activeHighlights = [];

    this.resizeObserver = new ResizeObserver(() => {
      this.redrawAllOverlays();
    });
    this.resizeObserver.observe(this.el);

    this.store.subscribe((sel) => {
      if (!this.result || !sel) {
        this.clearOverlays();
        return;
      }
      const allRows = [...this.result.citation_maps, ...this.result.unresolved];
      const matchingRows = allRows.filter((r) => r.claim_id === sel.claim_id);
      if (matchingRows.length === 0) return;
      const claim = matchingRows[0];
      this.activeHighlights = claim.highlights;
      this.drawHighlightsAndScroll(claim.highlights, claim.page_number);
    });
  }

  async load(pdfBytes) {
    this.el.innerHTML = '';
    this.pageCache.clear();
    this.activeHighlights = [];

    this.showStatus('loading', 'Loading PDF…');

    try {
      this.pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    } catch (err) {
      this.showStatus('error', `Could not read PDF: ${err.message}`);
      return;
    }

    this.el.innerHTML = '';
    const pageCount = this.pdf.numPages;
    for (let i = 1; i <= pageCount; i++) {
      await this.renderPage(i);
    }
  }

  setResult(result) {
    this.result = result;
  }

  async renderPage(pageNum) {
    const page = await this.pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.currentScale });

    const container = document.createElement('div');
    container.className = 'pdf-page';
    container.dataset.page = String(pageNum);
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.setAttribute('aria-label', `Page ${pageNum}`);

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.display = 'block';

    const overlay = document.createElement('canvas');
    overlay.width = Math.floor(viewport.width);
    overlay.height = Math.floor(viewport.height);
    overlay.className = 'highlight-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    container.appendChild(canvas);
    container.appendChild(overlay);
    this.el.appendChild(container);

    const ctx = canvas.getContext('2d');
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

  drawHighlightsAndScroll(highlights, firstPage) {
    this.clearOverlays();

    for (const hl of highlights) {
      const cache = this.pageCache.get(hl.page_number);
      if (!cache) continue;

      const { overlay, pdfWidth, pdfHeight } = cache;
      const scaleX = overlay.width / pdfWidth;
      const scaleY = overlay.height / pdfHeight;

      const ctx = overlay.getContext('2d');
      const x = hl.bounding_box.x0 * scaleX;
      const y = hl.bounding_box.y0 * scaleY;
      const w = (hl.bounding_box.x1 - hl.bounding_box.x0) * scaleX;
      const h = (hl.bounding_box.y1 - hl.bounding_box.y0) * scaleY;

      ctx.save();
      ctx.fillStyle = 'rgba(255, 213, 0, 0.35)';
      ctx.strokeStyle = 'rgba(200, 150, 0, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    const firstCache = this.pageCache.get(firstPage);
    if (firstCache) {
      firstCache.container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  clearOverlays() {
    for (const { overlay } of this.pageCache.values()) {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  redrawAllOverlays() {
    if (this.activeHighlights.length === 0) return;
    const firstPage = this.activeHighlights[0].page_number;
    this.drawHighlightsAndScroll(this.activeHighlights, firstPage);
  }

  setZoom(scale) {
    this.currentScale = scale;
    if (!this.pdf) return;
    this.el.innerHTML = '';
    this.pageCache.clear();
    const render = async () => {
      for (let i = 1; i <= this.pdf.numPages; i++) {
        await this.renderPage(i);
      }
      if (this.activeHighlights.length > 0) {
        this.drawHighlightsAndScroll(this.activeHighlights, this.activeHighlights[0].page_number);
      }
    };
    render();
  }

  showStatus(type, message) {
    this.el.innerHTML = `
      <div class="pdf-status pdf-status--${type}" role="status" aria-live="polite">
        <span class="pdf-status__icon" aria-hidden="true">${type === 'loading' ? '⟳' : '✕'}</span>
        <p>${message}</p>
      </div>`;
  }
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────
export class DetailPanel {
  constructor(container, store) {
    this.el = container;
    this.store = store;
    this.returnFocusEl = null;

    this.el.setAttribute('role', 'complementary');
    this.el.setAttribute('aria-label', 'Reference detail');
    this.el.innerHTML = `
      <div class="detail-header">
        <h2 class="detail-title" id="detail-title">Citation Review Inspector</h2>
        <button class="detail-close" type="button" aria-label="Close detail panel">✕</button>
      </div>
      <div class="detail-content" aria-labelledby="detail-title"></div>`;

    this.closeBtn = this.el.querySelector('.detail-close');
    this.contentEl = this.el.querySelector('.detail-content');

    this.closeBtn.addEventListener('click', () => {
      this.store.set(null);
      this.hide();
      this.returnFocusEl?.focus();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) {
        this.store.set(null);
        this.hide();
        this.returnFocusEl?.focus();
      }
    });

    this.store.subscribe((sel) => {
      if (!sel || !sel.row) {
        this.hide();
      } else {
        this.returnFocusEl = document.activeElement;
        this.showSelection(sel);
      }
    });

    this.hide();
  }

  showSelection(sel) {
    this.el.hidden = false;
    this.el.classList.add('detail--visible');

    if ('matched_reference' in sel.row) {
      this.renderMatched(sel.row, sel.resolved, sel.verdict);
    } else {
      this.renderUnresolved(sel.row);
    }
  }

  renderMatched(cm, resolved, verdict) {
    const ref = cm.matched_reference;
    const authors = ref.parsed_authors?.length ? ref.parsed_authors.join('; ') : '—';
    const doi = ref.parsed_doi
      ? `<a href="https://doi.org/${ref.parsed_doi}" target="_blank" rel="noopener noreferrer" class="doi-link">${ref.parsed_doi}</a>`
      : '—';

    let html = '';

    // ── Phase 3: Verification Verdict ────────────────────────────────────────
    if (verdict) {
      const pct = Math.round(verdict.confidence * 100);
      const labelClass = verdict.label.toLowerCase();
      html += `
        <div class="detail-card detail-card--verdict detail-card--${labelClass}">
          <div class="verdict-header">
            <span class="badge badge--verdict badge--${labelClass}">${verdict.label.replace('_', ' ')}</span>
            <span class="verdict-confidence">${pct}% Confidence</span>
          </div>
          <p class="verdict-explanation">${escHtml(verdict.explanation)}</p>
          <div class="verdict-models">
            <small>NLI: <code>${escHtml(verdict.nli_model)}</code></small>
            <small>Embedding: <code>${escHtml(verdict.embedding_model)}</code></small>
          </div>
        </div>`;

      if (verdict.evidence && verdict.evidence.length > 0) {
        for (const ev of verdict.evidence) {
          const pass = ev.passage;
          const entailPct = Math.round(ev.nli_scores.entailment * 100);
          const neutPct = Math.round(ev.nli_scores.neutral * 100);
          const contraPct = Math.round(ev.nli_scores.contradiction * 100);

          html += `
            <div class="evidence-block">
              <div class="evidence-header">
                <h4>Evidence Passage (${escHtml(verdict.source_kind)})</h4>
                <span class="passage-offsets">Words ${pass.start_word}–${pass.end_word} (chars ${pass.start_char}–${pass.end_char})</span>
              </div>
              <blockquote class="evidence-text">“${escHtml(pass.text)}”</blockquote>

              <div class="retrieval-scores">
                <span>BM25: <strong>${pass.bm25_score.toFixed(2)}</strong></span>
                <span>Cosine: <strong>${pass.cosine_score.toFixed(3)}</strong></span>
                <span>RRF: <strong>${pass.fusion_score.toFixed(4)}</strong></span>
              </div>

              <div class="nli-breakdown">
                <div class="nli-bar-row">
                  <span>Entailment</span>
                  <div class="nli-bar-track"><div class="nli-bar nli-bar--entail" style="width: ${entailPct}%;"></div></div>
                  <span>${entailPct}%</span>
                </div>
                <div class="nli-bar-row">
                  <span>Neutral</span>
                  <div class="nli-bar-track"><div class="nli-bar nli-bar--neutral" style="width: ${neutPct}%;"></div></div>
                  <span>${neutPct}%</span>
                </div>
                <div class="nli-bar-row">
                  <span>Contradiction</span>
                  <div class="nli-bar-track"><div class="nli-bar nli-bar--contra" style="width: ${contraPct}%;"></div></div>
                  <span>${contraPct}%</span>
                </div>
              </div>`;

          if (ev.audit) {
            const hasEntities = ev.audit.claim_entities?.length > 0 || ev.audit.evidence_entities?.length > 0;
            if (hasEntities) {
              html += `
                <div class="audit-section">
                  <h5>Numerical Alignment Audit</h5>
                  <div class="audit-entities">
                    ${(ev.audit.claim_entities || []).map(e => `
                      <span class="entity-tag entity-tag--claim">Claim: ${escHtml(e.text)} (${e.metric || 'metric'})</span>
                    `).join('')}
                    ${(ev.audit.evidence_entities || []).map(e => `
                      <span class="entity-tag entity-tag--evidence">Evidence: ${escHtml(e.text)} (${e.metric || 'metric'})</span>
                    `).join('')}
                  </div>
                  ${ev.audit.findings?.length > 0 ? `
                    <ul class="audit-findings">
                      ${ev.audit.findings.map(f => `
                        <li class="finding">⚠ ${escHtml(f.explanation)}</li>
                      `).join('')}
                    </ul>
                  ` : '<p class="audit-clean">✓ Numbers and units match accurately.</p>'}
                </div>`;
            }
          }

          html += `</div>`;
        }
      }

      if (verdict.warnings?.length > 0) {
        html += `
          <div class="verdict-warnings">
            ${verdict.warnings.map(w => `<p class="warning-item">⚠ ${escHtml(w)}</p>`).join('')}
          </div>`;
      }
    }

    // ── Phase 2: Scholarly Integrity & Access ────────────────────────────────
    if (resolved) {
      let integrityBadge = '';
      if (resolved.retraction_status === 'retracted' || resolved.openalex_retracted === true) {
        integrityBadge = `<div class="integrity-alert integrity-alert--retracted">🚨 <strong>RETRACTED PAPER</strong> — High Risk</div>`;
      } else if (resolved.retraction_status === 'expression_of_concern') {
        integrityBadge = `<div class="integrity-alert integrity-alert--concern">⚠️ <strong>Expression of Concern</strong> flagged on this source</div>`;
      } else if (resolved.retraction_status === 'not_flagged') {
        integrityBadge = `<div class="integrity-alert integrity-alert--safe">🛡️ <strong>Not Flagged</strong> in Crossref / Retraction Watch snapshot</div>`;
      }

      const oaLink = resolved.full_text_urls?.length > 0
        ? `<a href="${resolved.full_text_urls[0]}" target="_blank" rel="noopener noreferrer" class="oa-link">Open Access PDF ↗</a>`
        : resolved.landing_page_url
        ? `<a href="${resolved.landing_page_url}" target="_blank" rel="noopener noreferrer" class="oa-link">Publisher Page ↗</a>`
        : 'Closed / Unknown';

      html += `
        <div class="detail-card detail-card--integrity">
          <div class="card-header">
            <h3>Scholarly Integrity & Access</h3>
            <span class="badge badge--${resolved.oa_status}">OA: ${resolved.oa_status}</span>
          </div>
          ${integrityBadge}
          <dl class="detail-fields">
            <dt>Retraction Watch</dt>
            <dd>${resolved.retraction_watch_checked ? 'Checked' : 'Not verified'}</dd>
            <dt>OpenAlex</dt>
            <dd>${resolved.openalex_retracted === false ? 'Active (not retracted)' : resolved.openalex_retracted ? 'Retracted' : 'Not indexed'}</dd>
            <dt>Full Text Access</dt>
            <dd>${oaLink}</dd>
            ${resolved.journal ? `<dt>Journal</dt><dd>${escHtml(resolved.journal)}</dd>` : ''}
          </dl>
          ${resolved.abstract ? `
            <details class="detail-abstract">
              <summary>Source Abstract (${escHtml(resolved.abstract_source || 'Scholarly database')})</summary>
              <p class="abstract-text">${escHtml(resolved.abstract)}</p>
            </details>
          ` : ''}
        </div>`;
    }

    // ── Phase 1: Reference Details ───────────────────────────────────────────
    html += `
      <div class="detail-card">
        <div class="card-header">
          <h3>Bibliography Reference</h3>
          <span class="badge badge--matched">✓ Local Match</span>
        </div>
        <dl class="detail-fields">
          <dt>Authors</dt>
          <dd>${escHtml(authors)}</dd>
          <dt>Title</dt>
          <dd>${ref.parsed_title ? escHtml(ref.parsed_title) : '<em>Not extracted</em>'}</dd>
          <dt>Year</dt>
          <dd>${ref.parsed_year ?? '—'}</dd>
          <dt>DOI</dt>
          <dd>${doi}</dd>
        </dl>
        <details class="detail-raw">
          <summary>Original bibliography text</summary>
          <pre class="raw-text">${escHtml(ref.raw_text)}</pre>
        </details>
      </div>

      <section class="detail-claim">
        <h3>Citing sentence in draft</h3>
        <blockquote class="claim-quote">${escHtml(cm.sentence_text)}</blockquote>
        <p class="claim-meta">Page ${cm.page_number} · Markers: <code>${escHtml(cm.citation_markers.join(', '))}</code></p>
      </section>`;

    this.contentEl.innerHTML = html;
  }

  renderUnresolved(ur) {
    this.contentEl.innerHTML = `
      <div class="detail-card detail-card--unresolved">
        <div class="detail-status detail-status--unresolved">
          <span aria-hidden="true">⚠</span> ${escHtml(REASON_LABELS[ur.reason] || ur.reason)}
        </div>
        <dl class="detail-fields">
          <dt>Citation target</dt>
          <dd><code>${escHtml(ur.target)}</code></dd>
          <dt>Markers in text</dt>
          <dd><code>${escHtml(ur.citation_markers.join(', '))}</code></dd>
          <dt>Extraction state</dt>
          <dd>Unresolved reference</dd>
        </dl>
      </div>
      <section class="detail-claim">
        <h3>Citing sentence</h3>
        <blockquote class="claim-quote">${escHtml(ur.sentence_text)}</blockquote>
        <p class="claim-meta">Page ${ur.page_number}</p>
      </section>`;
  }

  hide() {
    this.el.hidden = true;
    this.el.classList.remove('detail--visible');
    this.contentEl.innerHTML = '';
  }
}

function escHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Main Application Initialization ──────────────────────────────────────────
const demoBanner = document.getElementById('demo-banner');
const warningBanner = document.getElementById('warning-banner');
const errorBanner = document.getElementById('error-banner');
const pdfInput = document.getElementById('pdf-input');
const jsonInput = document.getElementById('json-input');
const resolvedInput = document.getElementById('resolved-input');
const verdictsInput = document.getElementById('verdicts-input');
const loadDemoBtn = document.getElementById('load-demo-btn');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomResetBtn = document.getElementById('zoom-reset');
const zoomLabel = document.getElementById('zoom-label');

const listContainer = document.getElementById('extraction-list');
const pdfContainer = document.getElementById('pdf-viewport');
const detailContainer = document.getElementById('detail-panel');

const store = createStore();
const extractionList = new ExtractionList(listContainer, store);
const pdfViewer = new PdfViewer(pdfContainer, store);
const detailPanel = new DetailPanel(detailContainer, store);

let currentScale = 1.5;
const SCALE_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;

let pendingPdfBytes = null;
let pendingResult = null;

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  errorBanner.setAttribute('role', 'alert');
}

function clearError() {
  errorBanner.textContent = '';
  errorBanner.hidden = true;
}

function showWarnings(warnings) {
  if (!warnings || warnings.length === 0) {
    warningBanner.hidden = true;
    return;
  }
  warningBanner.innerHTML = warnings.map((w) => `<p>⚠ ${escHtml(w)}</p>`).join('');
  warningBanner.hidden = false;
}

async function loadPair(pdfBytes, result, isDemo) {
  clearError();
  store.set(null);
  demoBanner.hidden = !isDemo;
  showWarnings(result.warnings);
  extractionList.render(result);
  pdfViewer.setResult(result);
  await pdfViewer.load(pdfBytes);
}

async function tryLoadIfPairReady() {
  if (pendingPdfBytes && pendingResult) {
    await loadPair(pendingPdfBytes, pendingResult, false);
    pendingPdfBytes = null;
    pendingResult = null;
  }
}

pdfInput?.addEventListener('change', async () => {
  const file = pdfInput.files?.[0];
  if (!file) return;
  clearError();
  try {
    pendingPdfBytes = await readAsArrayBuffer(file);
  } catch (err) {
    showError(err.message);
    return;
  }
  await tryLoadIfPairReady();
});

jsonInput?.addEventListener('change', async () => {
  const file = jsonInput.files?.[0];
  if (!file) return;
  clearError();
  try {
    pendingResult = await loadIngestionResult(file);
  } catch (err) {
    showError(err.message);
    return;
  }
  await tryLoadIfPairReady();
});

resolvedInput?.addEventListener('change', async () => {
  const file = resolvedInput.files?.[0];
  if (!file) return;
  clearError();
  try {
    const map = await loadResolvedReferences(file);
    store.setResolvedMap(map);
    if (pdfViewer.result) extractionList.render(pdfViewer.result);
  } catch (err) {
    showError(`Resolved JSON error: ${err.message}`);
  }
});

verdictsInput?.addEventListener('change', async () => {
  const file = verdictsInput.files?.[0];
  if (!file) return;
  clearError();
  try {
    const map = await loadVerificationVerdicts(file);
    store.setVerdictsMap(map);
    if (pdfViewer.result) extractionList.render(pdfViewer.result);
  } catch (err) {
    showError(`Verdicts JSON error: ${err.message}`);
  }
});

loadDemoBtn?.addEventListener('click', async () => {
  clearError();
  loadDemoBtn.disabled = true;
  loadDemoBtn.textContent = 'Loading…';
  try {
    const { pdfBytes, result, resolvedMap, verdictsMap } = await loadDemoFixture();
    store.setResolvedMap(resolvedMap);
    store.setVerdictsMap(verdictsMap);
    await loadPair(pdfBytes, result, true);
  } catch (err) {
    showError(`Could not load demo files: ${err.message}. Ensure the local server is running.`);
  } finally {
    loadDemoBtn.disabled = false;
    loadDemoBtn.textContent = 'Load Demo';
  }
});

function applyZoom(scale) {
  currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  zoomLabel.textContent = `${Math.round(currentScale * 100)}%`;
  zoomInBtn.disabled = currentScale >= MAX_SCALE;
  zoomOutBtn.disabled = currentScale <= MIN_SCALE;
  pdfViewer.setZoom(currentScale);
}

zoomInBtn?.addEventListener('click', () => applyZoom(currentScale + SCALE_STEP));
zoomOutBtn?.addEventListener('click', () => applyZoom(currentScale - SCALE_STEP));
zoomResetBtn?.addEventListener('click', () => applyZoom(1.5));

if (zoomLabel) zoomLabel.textContent = `${Math.round(currentScale * 100)}%`;
