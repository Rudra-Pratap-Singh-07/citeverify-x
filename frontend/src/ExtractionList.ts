import type {
  CitationMap,
  ClaimGroup,
  IngestionResult,
  UnresolvedCitation,
  VerificationVerdict,
  ResolvedPaper,
} from './types';
import type { Store } from './state';

const REASON_LABELS: Record<UnresolvedCitation['reason'], string> = {
  missing_reference: 'Reference not found in bibliography',
  ambiguous_reference: 'Multiple bibliography entries match this citation',
  invalid_range: 'Citation marker contains an invalid numeric range',
};

export function buildClaimGroups(result: IngestionResult): ClaimGroup[] {
  const map = new Map<string, ClaimGroup>();

  const ensureGroup = (row: CitationMap | UnresolvedCitation): ClaimGroup => {
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
    return map.get(row.claim_id)!;
  };

  for (const cm of result.citation_maps) ensureGroup(cm).matched.push(cm);
  for (const ur of result.unresolved) ensureGroup(ur).unresolved.push(ur);

  return [...map.values()].sort((a, b) => {
    if (a.page_number !== b.page_number) return a.page_number - b.page_number;
    return a.bounding_box.y0 - b.bounding_box.y0;
  });
}

export class ExtractionList {
  private el: HTMLElement;
  private store: Store;
  private groups: ClaimGroup[] = [];
  private rowEls: HTMLElement[] = [];
  private focusIndex = 0;

  constructor(container: HTMLElement, store: Store) {
    this.el = container;
    this.store = store;
    this.el.setAttribute('role', 'list');
    this.el.setAttribute('aria-label', 'Empirical claims');
    this.el.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.store.subscribe((sel) => this.syncHighlight(sel?.claim_id ?? null, sel?.ref_anchor ?? null));
  }

  render(result: IngestionResult): void {
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

  private renderGroup(group: ClaimGroup): HTMLElement {
    const groupEl = document.createElement('div');
    groupEl.className = 'claim-group';
    groupEl.setAttribute('role', 'listitem');
    groupEl.dataset['claimId'] = group.claim_id;

    // ── Sentence header ──────────────────────────────────────────────────────
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

    // ── Matched reference rows ───────────────────────────────────────────────
    for (const cm of group.matched) {
      const row = this.makeRefRow(group, cm);
      groupEl.appendChild(row);
      this.rowEls.push(row);
    }

    // ── Unresolved rows ──────────────────────────────────────────────────────
    for (const ur of group.unresolved) {
      const row = this.makeUnresolvedRow(group, ur);
      groupEl.appendChild(row);
      this.rowEls.push(row);
    }

    return groupEl;
  }

  private makeRefRow(group: ClaimGroup, cm: CitationMap): HTMLElement {
    const row = document.createElement('button');
    row.className = 'ref-row ref-row--matched';
    row.setAttribute('type', 'button');
    row.setAttribute('tabindex', this.rowEls.length === 0 ? '0' : '-1');
    row.dataset['claimId'] = group.claim_id;
    row.dataset['refAnchor'] = cm.matched_reference.anchor_id;

    const anchorId = cm.matched_reference.anchor_id;
    const resolved: ResolvedPaper | null = this.store.getResolved(anchorId);
    const verdict: VerificationVerdict | null = this.store.getVerdict(group.claim_id, anchorId);

    // Main status icon
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

    // Label
    const label = document.createElement('span');
    label.className = 'ref-label';
    const authors = cm.matched_reference.parsed_authors.slice(0, 2).join(', ');
    const year = cm.matched_reference.parsed_year ?? '—';
    const title = cm.matched_reference.parsed_title ?? cm.matched_reference.raw_text.slice(0, 50);
    label.textContent = `${authors} (${year}) — ${title}`;

    // Badges container (Verdicts + Retraction + OA)
    const badges = document.createElement('div');
    badges.className = 'ref-badges';

    // Phase 3: Verdict badge
    if (verdict) {
      const vBadge = document.createElement('span');
      const pct = Math.round(verdict.confidence * 100);
      vBadge.className = `badge badge--verdict badge--${verdict.label.toLowerCase()}`;
      vBadge.textContent = `${verdict.label.replace('_', ' ')} (${pct}%)`;
      vBadge.setAttribute('aria-label', `Verdict: ${verdict.label} with ${pct}% confidence`);
      badges.appendChild(vBadge);
    }

    // Phase 2: Integrity & OA badges
    if (resolved) {
      if (resolved.retraction_status === 'retracted' || resolved.openalex_retracted === true) {
        const retBadge = document.createElement('span');
        retBadge.className = 'badge badge--retracted';
        retBadge.textContent = '🚨 Retracted';
        retBadge.setAttribute('aria-label', 'Retraction Warning');
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

  private makeUnresolvedRow(group: ClaimGroup, ur: UnresolvedCitation): HTMLElement {
    const row = document.createElement('button');
    row.className = 'ref-row ref-row--unresolved';
    row.setAttribute('type', 'button');
    row.setAttribute('tabindex', this.rowEls.length === 0 ? '0' : '-1');
    row.dataset['claimId'] = group.claim_id;
    row.dataset['refAnchor'] = '';

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

  private select(row: HTMLElement): void {
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

  private syncHighlight(claimId: string | null, refAnchor: string | null): void {
    for (const r of this.rowEls) {
      const match =
        r.dataset['claimId'] === claimId &&
        (refAnchor === null || r.dataset['refAnchor'] === refAnchor);
      r.classList.toggle('ref-row--selected', match);
      r.setAttribute('aria-pressed', match ? 'true' : 'false');
    }
  }

  private handleKeydown(e: KeyboardEvent): void {
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

  private moveFocus(): void {
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].setAttribute('tabindex', i === this.focusIndex ? '0' : '-1');
    }
    this.rowEls[this.focusIndex]?.focus();
  }
}
