import type {
  CitationMap,
  UnresolvedCitation,
  ResolvedPaper,
  VerificationVerdict,
  Selection,
} from './types';
import type { Store } from './state';

const REASON_LABELS: Record<UnresolvedCitation['reason'], string> = {
  missing_reference: 'Reference not found in bibliography',
  ambiguous_reference: 'Multiple bibliography entries match this citation',
  invalid_range: 'Citation marker contains an invalid numeric range',
};

export class DetailPanel {
  private el: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private contentEl: HTMLElement;
  private store: Store;
  private returnFocusEl: HTMLElement | null = null;

  constructor(container: HTMLElement, store: Store) {
    this.el = container;
    this.store = store;

    this.el.setAttribute('role', 'complementary');
    this.el.setAttribute('aria-label', 'Reference detail');
    this.el.innerHTML = `
      <div class="detail-header">
        <h2 class="detail-title" id="detail-title">Citation Review Inspector</h2>
        <button class="detail-close" type="button" aria-label="Close detail panel">✕</button>
      </div>
      <div class="detail-content" aria-labelledby="detail-title"></div>`;

    this.closeBtn = this.el.querySelector('.detail-close') as HTMLButtonElement;
    this.contentEl = this.el.querySelector('.detail-content') as HTMLElement;

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
        this.returnFocusEl = document.activeElement as HTMLElement;
        this.showSelection(sel);
      }
    });

    this.hide();
  }

  private showSelection(sel: Selection): void {
    this.el.hidden = false;
    this.el.classList.add('detail--visible');

    if ('matched_reference' in sel.row!) {
      this.renderMatched(sel.row as CitationMap, sel.resolved, sel.verdict);
    } else {
      this.renderUnresolved(sel.row as UnresolvedCitation);
    }
  }

  private renderMatched(
    cm: CitationMap,
    resolved: ResolvedPaper | null,
    verdict: VerificationVerdict | null
  ): void {
    const ref = cm.matched_reference;
    const authors = ref.parsed_authors.length ? ref.parsed_authors.join('; ') : '—';
    const doi = ref.parsed_doi
      ? `<a href="https://doi.org/${ref.parsed_doi}" target="_blank" rel="noopener noreferrer" class="doi-link">${ref.parsed_doi}</a>`
      : '—';

    let html = '';

    // ── Phase 3: Verification Verdict Section ────────────────────────────────
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

      // Evidence passages & NLI score breakdown
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

              <!-- Retrieval Metrics -->
              <div class="retrieval-scores">
                <span>BM25: <strong>${pass.bm25_score.toFixed(2)}</strong></span>
                <span>Cosine: <strong>${pass.cosine_score.toFixed(3)}</strong></span>
                <span>RRF Fusion: <strong>${pass.fusion_score.toFixed(4)}</strong></span>
              </div>

              <!-- NLI Breakdown -->
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

          // Numerical audit findings
          if (ev.audit) {
            const hasEntities = ev.audit.claim_entities.length > 0 || ev.audit.evidence_entities.length > 0;
            if (hasEntities) {
              html += `
                <div class="audit-section">
                  <h5>Numerical Alignment Audit</h5>
                  <div class="audit-entities">
                    ${ev.audit.claim_entities.map(e => `
                      <span class="entity-tag entity-tag--claim">Claim: ${escHtml(e.text)} (${e.metric || 'metric'})</span>
                    `).join('')}
                    ${ev.audit.evidence_entities.map(e => `
                      <span class="entity-tag entity-tag--evidence">Evidence: ${escHtml(e.text)} (${e.metric || 'metric'})</span>
                    `).join('')}
                  </div>
                  ${ev.audit.findings.length > 0 ? `
                    <ul class="audit-findings">
                      ${ev.audit.findings.map(f => `
                        <li class="finding finding--${f.kind}">⚠ ${escHtml(f.explanation)}</li>
                      `).join('')}
                    </ul>
                  ` : '<p class="audit-clean">✓ Numbers and units match accurately.</p>'}
                </div>`;
            }
          }

          html += `</div>`;
        }
      }

      if (verdict.warnings && verdict.warnings.length > 0) {
        html += `
          <div class="verdict-warnings">
            ${verdict.warnings.map(w => `<p class="warning-item">⚠ ${escHtml(w)}</p>`).join('')}
          </div>`;
      }
    }

    // ── Phase 2: Scholarly Integrity & Open Access ───────────────────────────
    if (resolved) {
      let integrityBadge = '';
      if (resolved.retraction_status === 'retracted' || resolved.openalex_retracted === true) {
        integrityBadge = `<div class="integrity-alert integrity-alert--retracted">🚨 <strong>RETRACTED PAPER</strong> — High Risk</div>`;
      } else if (resolved.retraction_status === 'expression_of_concern') {
        integrityBadge = `<div class="integrity-alert integrity-alert--concern">⚠️ <strong>Expression of Concern</strong> flagged on this source</div>`;
      } else if (resolved.retraction_status === 'not_flagged') {
        integrityBadge = `<div class="integrity-alert integrity-alert--safe">🛡️ <strong>Not Flagged</strong> in Crossref / Retraction Watch snapshot</div>`;
      }

      const oaLink = resolved.full_text_urls.length > 0
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

      <!-- Citing Sentence Context -->
      <section class="detail-claim">
        <h3>Citing sentence in draft</h3>
        <blockquote class="claim-quote">${escHtml(cm.sentence_text)}</blockquote>
        <p class="claim-meta">Page ${cm.page_number} · Markers: <code>${escHtml(cm.citation_markers.join(', '))}</code></p>
      </section>`;

    this.contentEl.innerHTML = html;
  }

  private renderUnresolved(ur: UnresolvedCitation): void {
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

  private hide(): void {
    this.el.hidden = true;
    this.el.classList.remove('detail--visible');
    this.contentEl.innerHTML = '';
  }
}

function escHtml(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
