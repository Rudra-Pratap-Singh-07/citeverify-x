export type Label =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "CONTRADICTED"
  | "UNSUPPORTED"
  | "RETRACTED";
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Claim = {
  claim_id: string;
  sentence_text: string;
  page_number: number;
  label: Label | null;
  highlights: { page_number: number; bounding_box: Box }[];
  bounding_box: Box;
  checks: Check[];
};
export type Check = {
  anchor_id: string;
  state: string;
  message: string | null;
  reference: { raw_text: string } | null;
  paper: {
    title: string | null;
    authors: string[];
    doi: string | null;
    year: number | null;
    retraction_status: string;
    warnings: string[];
    journal: string | null;
    retraction_events: { nature?: string; date?: string; reasons?: string }[];
    oa_pdf_url?: string | null;
  } | null;
  verdict: {
    label: Label;
    confidence: number;
    nli_model: string;
    explanation: string;
    source_kind: string;
    selected_passage_id: string | null;
    warnings: string[];
    evidence: {
      passage: { passage_id: string; text: string };
      audit: {
        findings: {
          kind: string;
          explanation: string;
          claim_entity?: { text: string } | null;
          evidence_entity?: { text: string } | null;
          relative_difference?: number | null;
        }[];
      };
    }[];
  } | null;
};
export type Report = {
  task_id: string;
  filename: string;
  demo: boolean;
  claims: Claim[];
  pages: { page_number: number; width: number; height: number; raw_text: string }[];
  warnings: string[];
  summary: {
    veracity_score: number | null;
    total_claims: number;
    claims_assessed: number;
    citations_audited: number;
    total_citations: number;
    retraction_alerts: number;
    concern_alerts: number;
    coverage_percent: number;
    score_method: string;
  };
};
export type Progress = {
  sequence: number;
  stage: string;
  progress: number;
  message: string;
};
export const labelText = (label: Label | null) =>
  label
    ? {
        SUPPORTED: "Supported",
        PARTIALLY_SUPPORTED: "Partially supported",
        CONTRADICTED: "Contradicted",
        UNSUPPORTED: "Unsupported",
        RETRACTED: "Retracted source",
      }[label]
    : "Needs review";
export const tone = (label: Label | null) =>
  label === "SUPPORTED"
    ? "green"
    : label === "CONTRADICTED" ||
        label === "UNSUPPORTED" ||
        label === "RETRACTED"
      ? "red"
      : "amber";
