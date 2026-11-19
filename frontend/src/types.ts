// TypeScript interfaces mirroring Codex's Pydantic schema v1.0, v2.0 (Resolvers), and v3.0 (Verification)
// Sources of truth:
//   - src/parser/document_ingest.py
//   - src/resolvers/scholarly_resolver.py
//   - src/verification/models.py

// ─── Phase 1: Ingestion Models ───────────────────────────────────────────────

export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Word {
  text: string;
  page_number: number;
  bounding_box: BoundingBox;
}

export interface PageText {
  page_number: number;
  width: number;
  height: number;
  raw_text: string;
  words: Word[];
}

export interface ReferenceItem {
  raw_text: string;
  anchor_id: string;
  parsed_authors: string[];
  parsed_title: string | null;
  parsed_year: number | null;
  parsed_doi: string | null;
}

export interface Highlight {
  page_number: number;
  bounding_box: BoundingBox;
}

export interface ClaimLocation {
  claim_id: string;
  sentence_text: string;
  page_number: number;
  bounding_box: BoundingBox;
  citation_markers: string[];
  highlights: Highlight[];
}

export interface CitationMap extends ClaimLocation {
  matched_reference: ReferenceItem;
}

export interface UnresolvedCitation extends ClaimLocation {
  target: string;
  reason: 'missing_reference' | 'ambiguous_reference' | 'invalid_range';
}

export interface IngestionResult {
  schema_version: '1.0';
  pages: PageText[];
  references: ReferenceItem[];
  citation_maps: CitationMap[];
  unresolved: UnresolvedCitation[];
  warnings: string[];
}

// ─── Phase 2: Scholarly Resolver Models ───────────────────────────────────────

export type PaperStatus = 'resolved' | 'missing' | 'ambiguous' | 'invalid_doi' | 'unavailable';
export type RetractionStatus = 'retracted' | 'expression_of_concern' | 'not_flagged' | 'unknown';
export type OAStatus = 'available' | 'closed' | 'unknown';

export interface RetractionEvent {
  reasons?: string[];
  date?: string;
  original_journal?: string;
  [key: string]: unknown;
}

export interface ResolvedPaper {
  status: PaperStatus;
  doi: string | null;
  title: string | null;
  authors: string[];
  year: number | null;
  journal: string | null;
  match_score: number | null;
  openalex_retracted: boolean | null;
  retraction_status: RetractionStatus;
  retraction_watch_checked: boolean;
  retraction_events: RetractionEvent[];
  oa_status: OAStatus;
  full_text_urls: string[];
  landing_page_url: string | null;
  abstract: string | null;
  abstract_source: string | null;
  raw_text: string | null;
  checked_at: number | null;
  warnings: string[];
}

export interface ResolvedRecord {
  anchor_id: string;
  paper: ResolvedPaper;
}

// ─── Phase 3: Verification & NLI Models ───────────────────────────────────────

export type VerificationLabel = 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'CONTRADICTED' | 'UNSUPPORTED';

export interface Passage {
  passage_id: string;
  text: string;
  start_char: number;
  end_char: number;
  start_word: number;
  end_word: number;
}

export interface RankedPassage extends Passage {
  bm25_score: number;
  cosine_score: number;
  fusion_score: number;
}

export interface NLIScores {
  entailment: number;
  neutral: number;
  contradiction: number;
}

export interface NumericEntity {
  text: string;
  value: number;
  unit: string;
  metric: string;
  comparator: string;
  start: number;
  end: number;
  context: string;
}

export interface AuditFinding {
  kind: 'numeric_mismatch' | 'scope_mismatch' | 'unmatched' | 'ambiguous';
  explanation: string;
  claim_entity: NumericEntity | null;
  evidence_entity: NumericEntity | null;
  relative_difference: number | null;
}

export interface NumericalAudit {
  claim_entities: NumericEntity[];
  evidence_entities: NumericEntity[];
  findings: AuditFinding[];
}

export interface EvidenceAssessment {
  passage: RankedPassage;
  nli_scores: NLIScores;
  nli_label: VerificationLabel;
  label: VerificationLabel;
  confidence: number;
  audit: NumericalAudit;
}

export interface VerificationVerdict {
  claim_id: string;
  claim_text: string;
  anchor_id: string;
  source_doi: string | null;
  source_kind: 'full_text' | 'abstract' | 'none';
  source_text_sha256: string | null;
  status: 'completed' | 'insufficient_evidence';
  label: VerificationLabel;
  confidence: number;
  confidence_kind: 'uncalibrated_model_score' | 'no_evidence';
  nli_model: string;
  embedding_model: string;
  selected_passage_id: string | null;
  explanation: string;
  evidence: EvidenceAssessment[];
  warnings: string[];
}

// ─── UI-level Aggregated Types ────────────────────────────────────────────────

export interface ClaimGroup {
  claim_id: string;
  sentence_text: string;
  page_number: number;
  bounding_box: BoundingBox;
  highlights: Highlight[];
  citation_markers: string[];
  matched: CitationMap[];
  unresolved: UnresolvedCitation[];
}

export interface Selection {
  claim_id: string;
  ref_anchor: string | null;
  row: CitationMap | UnresolvedCitation | null;
  resolved: ResolvedPaper | null;
  verdict: VerificationVerdict | null;
}
