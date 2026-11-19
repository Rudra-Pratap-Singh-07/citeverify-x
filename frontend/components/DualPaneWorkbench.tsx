"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "../lib/useReducedMotion";
import {
  ArrowLeft,
  Download,
  FileText,
  ScanLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  GitBranch,
  Link2,
  ExternalLink,
  Keyboard,
  X,
  Fingerprint,
  Activity,
  TriangleAlert,
  BookOpen,
  LoaderCircle,
} from "lucide-react";
import { API, request } from "../lib/api";
import { useAudit } from "../lib/useAudit";
import { rememberAudit } from "../lib/auditSession";
import {
  adjacentClaim,
  primaryCheckIndex,
  selectedPassageIndex,
} from "../lib/selection";
import { Claim, labelText, tone } from "../lib/types";
import Brand from "./Brand";
import AuditProgress from "./AuditProgress";
const Pdf = dynamic(() => import("./ManuscriptViewer"), {
  ssr: false,
  loading: () => <div className="skeleton pdf-skeleton" />,
});
type Filter = "all" | "flagged" | "retracted";
const isFlagged = (c: Claim) => c.label !== "SUPPORTED";
const isRetracted = (c: Claim) =>
  c.checks.some((x) => x.paper?.retraction_status === "retracted");
function Gauge({ score }: { score: number | null }) {
  const reduced = useReducedMotion();
  const r = 20,
    len = 2 * Math.PI * r;
  return (
    <div
      className="score-gauge"
      title="Evidence support score. Unassessed claims excluded."
    >
      <svg viewBox="0 0 50 50" aria-hidden="true">
        <circle cx="25" cy="25" r={r} />
        <motion.circle
          initial={{ strokeDashoffset: len }}
          animate={{ strokeDashoffset: len * (1 - (score ?? 0) / 100) }}
          transition={{ duration: reduced ? 0 : 1 }}
          cx="25"
          cy="25"
          r={r}
          strokeDasharray={len}
        />
      </svg>
      <div>
        <strong>
          {score ?? "N/A"}
          {score !== null && <small>%</small>}
        </strong>
        <span>Evidence support</span>
      </div>
    </div>
  );
}
function MetricText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(
          /(\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|participants|children)\b)/g,
        )
        .map((s, i) =>
          /\d/.test(s) && s.length < 28 ? (
            <strong className="proof-metric" key={i}>
              {s}
            </strong>
          ) : (
            s
          ),
        )}
    </>
  );
}
export default function DualPaneWorkbench({ id }: { id: string }) {
  const { report, event, error, fatal, retry } = useAudit(id);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [checkIndex, setCheckIndex] = useState(0);
  const [passageIndex, setPassageIndex] = useState(0);
  const [view, setView] = useState<"reading" | "pdf">("reading");
  const [digest, setDigest] = useState("");
  const [exportError, setExportError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const evidenceScroll = useRef<HTMLDivElement>(null);
  const claimsScroll = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    setDigest("");
    setExportError("");
    setFilter("all");
    setSelected("");
    setCheckIndex(0);
    setPassageIndex(0);
  }, [id]);
  useEffect(() => {
    if (report) {
      const first = report.claims.find(isFlagged) || report.claims[0];
      if (first) select(first);
      rememberAudit(id);
    }
  }, [report, id]);
  const claims = report?.claims || [];
  const visible = claims.filter(
    (c) =>
      filter === "all" ||
      (filter === "flagged" ? isFlagged(c) : isRetracted(c)),
  );
  const claim = claims.find((c) => c.claim_id === selected);
  const check = claim?.checks[checkIndex] || claim?.checks[0];
  const paper = check?.paper;
  const verdict = check?.verdict;
  const evidence = verdict?.evidence[passageIndex];
  const findings =
    evidence?.audit.findings.filter(
      (f) => f.kind === "numeric_mismatch" || f.kind === "scope_mismatch",
    ) || [];
  function select(c: Claim) {
    setSelected(c.claim_id);
    const index = primaryCheckIndex(c);
    setCheckIndex(index);
    setPassageIndex(selectedPassageIndex(c, index));
  }
  useEffect(() => {
    evidenceScroll.current?.scrollTo({
      top: 0,
      behavior: reduced ? "auto" : "smooth",
    });
    claimsScroll.current
      ?.querySelector(`[data-claim="${selected}"]`)
      ?.scrollIntoView({
        block: "nearest",
        behavior: reduced ? "auto" : "smooth",
      });
  }, [selected, checkIndex, reduced]);
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        el.isContentEditable ||
        /INPUT|TEXTAREA|SELECT/.test(el.tagName) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (e.key.toLowerCase() !== "j" && e.key.toLowerCase() !== "k") return;
      const candidates = visible.filter(isFlagged);
      const list = candidates.length ? candidates : visible;
      if (!list.length) return;
      e.preventDefault();
      const next = adjacentClaim(
        list,
        selected,
        e.key.toLowerCase() === "j" ? 1 : -1,
      );
      if (next) select(next);
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [selected, visible]);
  function changeFilter(f: Filter) {
    setFilter(f);
    const next = claims.find(
      (c) => f === "all" || (f === "flagged" ? isFlagged(c) : isRetracted(c)),
    );
    if (next) select(next);
    else setSelected("");
  }
  async function fingerprint() {
    if (digest) return;
    try {
      const result = await request<{ sha256: string }>(
        `/api/v1/verify/fingerprint/${id}`,
      );
      setDigest(result.sha256);
    } catch (e) {
      setExportError(String(e));
    }
  }
  async function download() {
    setDownloading(true);
    setExportError("");
    try {
      const response = await fetch(`${API}/api/v1/verify/certificate/${id}`);
      if (!response.ok)
        throw new Error("Certificate unavailable. Please retry.");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `CiteVerify-${id.slice(0, 8)}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setDownloading(false);
    }
  }
  if (!report)
    return (
      <main className="audit-loading">
        <header className="workspace-nav">
          <Brand />
          <Link href="/" className="text-link">
            <ArrowLeft size={14} /> Back to launchpad
          </Link>
        </header>
        <div className="loading-layout">
          <h1>
            {error
              ? "Investigation unavailable"
              : "Preparing the evidence workspace."}
          </h1>
          {error ? (
            <div className="error" role="alert">
              {error}
              {!fatal && (
                <button className="text-link" onClick={retry}>
                  Reconnect now
                </button>
              )}
            </div>
          ) : (
            <>
              <AuditProgress event={event} />
              <div className="loading-panes">
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
            </>
          )}
        </div>
      </main>
    );
  const summary = report.summary;
  const checked = check?.state === "checked";
  const activeTone = tone(checked ? (verdict?.label ?? null) : null);
  const currentIndex = visible.findIndex((c) => c.claim_id === selected);
  return (
    <main className="audit-app">
      <header className="workspace-nav">
        <Brand />
        <span className="nav-divider" />
        <Link href="/" className="text-link">
          <ArrowLeft size={14} /> Investigations
        </Link>
        <div className="workspace-nav-end">
          <span className={`environment-tag ${report.demo ? "amber" : ""}`}>
            <span className="status-dot" />
            {report.demo ? "BENCHMARK FIXTURE" : "DOCUMENT AUDIT"}
          </span>
          <span className="mono audit-id">{id.slice(0, 8)}</span>
        </div>
      </header>
      <section className="command-bar">
        <div className="document-identity">
          <span className="doc-icon">
            <FileText size={20} />
          </span>
          <div>
            <h1>{report.filename}</h1>
            <span>
              {summary.citations_audited} / {summary.total_citations} citation
              links audited <span>·</span> {summary.coverage_percent}% coverage
            </span>
          </div>
        </div>
        <Gauge score={summary.veracity_score} />
        <Dialog.Root
          onOpenChange={(open) => {
            if (open) void fingerprint();
          }}
        >
          <Dialog.Trigger asChild>
            <button className="primary export-trigger">
              <Download size={14} /> Export certificate
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="certificate-modal">
              <div className="modal-head">
                <span className="certificate-icon">
                  <Fingerprint size={24} />
                </span>
                <Dialog.Close
                  className="icon-button"
                  aria-label="Close certificate"
                >
                  <X size={18} />
                </Dialog.Close>
              </div>
              <Dialog.Title>Executive verification certificate</Dialog.Title>
              <Dialog.Description>
                A printable record of findings, evidence coverage, and
                unresolved citations.
              </Dialog.Description>
              <div className="certificate-stats">
                <div>
                  <strong>
                    {summary.veracity_score ?? "N/A"}
                    {summary.veracity_score !== null ? "%" : ""}
                  </strong>
                  <span>Evidence support</span>
                </div>
                <div>
                  <strong>
                    {summary.citations_audited}/{summary.total_citations}
                  </strong>
                  <span>Links assessed</span>
                </div>
                <div>
                  <strong>{summary.retraction_alerts}</strong>
                  <span>Retractions</span>
                </div>
              </div>
              <div className="hash-block">
                <span>
                  <Fingerprint size={13} /> SHA-256 REPORT FINGERPRINT
                </span>
                <code>{digest || "Retrieving fingerprint…"}</code>
                <small>
                  Fingerprint of the saved report. This is a content digest, not
                  a signed attestation.
                </small>
              </div>
              <p className="modal-note">
                {report.demo
                  ? "Benchmark fixture. Includes synthetic sources and deterministic inference."
                  : "Automated evidence assessment for expert review."}{" "}
                Model confidence is uncalibrated.
              </p>
              {exportError && (
                <p className="error" role="alert">
                  {exportError}
                </p>
              )}
              <button
                className="primary full-width"
                onClick={download}
                disabled={downloading}
              >
                {downloading ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Download size={15} />
                )}{" "}
                Download PDF certificate
              </button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>
      <div className="workspace-toolbar">
        <div className="filter-tabs" role="group" aria-label="Filter claims">
          {(["all", "flagged", "retracted"] as Filter[]).map((f) => (
            <button
              key={f}
              aria-pressed={filter === f}
              onClick={() => changeFilter(f)}
            >
              {f === "all"
                ? "All claims"
                : f === "flagged"
                  ? "Flagged"
                  : "Retracted"}
              <span>
                {f === "all"
                  ? claims.length
                  : claims.filter(f === "flagged" ? isFlagged : isRetracted)
                      .length}
              </span>
            </button>
          ))}
        </div>
        <div className="keyboard-hint">
          <Keyboard size={13} />
          <kbd>J</kbd>
          <kbd>K</kbd>
          <span>Navigate findings</span>
        </div>
        <span className="toolbar-status">
          <span className="status-dot" /> Audit complete
        </span>
      </div>
      <div className="forensic-grid">
        <section className="investigation-pane manuscript-pane">
          <div className="pane-heading">
            <div>
              <ScanLine size={15} />
              <h2>Uploaded manuscript</h2>
            </div>
            <div className="view-toggle">
              <button
                aria-pressed={view === "reading"}
                onClick={() => setView("reading")}
              >
                Reading
              </button>
              <button
                aria-pressed={view === "pdf"}
                onClick={() => setView("pdf")}
              >
                PDF
              </button>
            </div>
          </div>
          <div className="manuscript-scroll" ref={claimsScroll}>
            {view === "pdf" ? (
              <>
                <Pdf
                  report={report}
                  selected={selected}
                  onSelect={(s) => {
                    const c = claims.find((c) => c.claim_id === s);
                    if (c) select(c);
                  }}
                />
                <div className="pdf-claim-jumps">
                  {visible.map((c) => (
                    <button
                      className={`small-claim ${tone(c.label)}`}
                      onClick={() => select(c)}
                      key={c.claim_id}
                    >
                      {labelText(c.label)}: {c.sentence_text}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="document-page">
                  <div className="paper-running-head">
                    <span>CITED CLAIMS / READING VIEW</span>
                    <span>
                      {report.pages.length} PAGE
                      {report.pages.length !== 1 ? "S" : ""}
                    </span>
                  </div>
                  <h3>
                    {report.pages[0]?.raw_text.split("\n")[0] ||
                      report.filename}
                  </h3>
                  <p className="paper-intro">
                    Extracted statements, with their original citation anchors.
                    <br />
                    Select a claim to trace its evidence.
                  </p>
                  <div className="paper-rule" />
                  {visible.length === 0 ? (
                    <div className="empty-state">
                      <ShieldCheck size={30} />
                      <h3>No claims in this filter.</h3>
                      <p>Choose All claims to return to the manuscript.</p>
                    </div>
                  ) : (
                    visible.map((c, i) => (
                      <motion.button
                        layout={!reduced}
                        key={c.claim_id}
                        data-claim={c.claim_id}
                        onClick={() => select(c)}
                        aria-pressed={selected === c.claim_id}
                        className={`manuscript-claim ${tone(c.label)} ${selected === c.claim_id ? "active" : ""}`}
                      >
                        <div className="claim-annotation">
                          <span className="mono">
                            CLAIM{" "}
                            {String(claims.indexOf(c) + 1).padStart(2, "0")}{" "}
                            <span>/</span> P.{c.page_number}
                          </span>
                          <span className={`badge ${tone(c.label)}`}>
                            {c.label === "SUPPORTED" ? (
                              <Check size={10} />
                            ) : (
                              <TriangleAlert size={10} />
                            )}{" "}
                            {labelText(c.label)}
                          </span>
                        </div>
                        <p>{c.sentence_text}</p>
                        <div className="claim-meta">
                          <span>
                            <Link2 size={11} />
                            {c.checks.length} cited source
                            {c.checks.length === 1 ? "" : "s"}
                          </span>
                          {selected === c.claim_id && (
                            <span className="trace-label">
                              Tracing evidence <GitBranch size={12} />
                            </span>
                          )}
                        </div>
                      </motion.button>
                    ))
                  )}
                  <div className="paper-end">
                    <span className="mono">END OF EXTRACTED CLAIMS</span>
                    <span>Original context available in PDF view.</span>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="pane-bottom">
            <span>
              <FileText size={12} /> {visible.length} / {claims.length} claims
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="Previous claim"
                disabled={!visible.length}
                onClick={() => {
                  const next = adjacentClaim(visible, selected, -1);
                  if (next) select(next);
                }}
              >
                <ChevronLeft size={14} />
              </button>
              <span className="mono">
                {visible.length ? currentIndex + 1 : 0} / {visible.length}
              </span>
              <button
                className="icon-button"
                aria-label="Next claim"
                disabled={!visible.length}
                onClick={() => {
                  const next = adjacentClaim(visible, selected, 1);
                  if (next) select(next);
                }}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>
        <div className={`evidence-bridge ${activeTone}`} aria-hidden="true">
          <span className="bridge-line" />
          <motion.span
            key={selected}
            className="bridge-beacon"
            initial={reduced ? false : { scale: 0.75, opacity: 0.3 }}
            animate={{ scale: 1, opacity: 1 }}
          >
            <GitBranch size={15} />
          </motion.span>
          <svg viewBox="0 0 56 140" preserveAspectRatio="none">
            <path d="M0 10 C45 10 10 130 56 130" />
            <motion.path
              key={selected + "pulse"}
              className="trace-pulse"
              d="M0 10 C45 10 10 130 56 130"
              initial={reduced ? false : { opacity: 0.1 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6 }}
            />
          </svg>
        </div>
        <section className="investigation-pane evidence-pane">
          <div className="pane-heading">
            <div>
              <BookOpen size={15} />
              <h2>Primary source evidence</h2>
            </div>
            <span className="linked-indicator">
              <Link2 size={12} /> Linked
            </span>
          </div>
          <div className="source-scroll" ref={evidenceScroll}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${selected}-${checkIndex}`}
                className="source-content"
                initial={reduced ? false : { opacity: 0, y: 7 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                {!claim ? (
                  <div className="empty-state">
                    <ScanLine size={28} />
                    <h3>Select a manuscript claim.</h3>
                    <p>Its source and evidence will appear here.</p>
                  </div>
                ) : (
                  <>
                    <div className="source-kicker">
                      <span className="mono">SOURCE RECORD</span>
                      <span className={`badge ${activeTone}`}>
                        {checked ? labelText(verdict!.label) : "Needs review"}
                      </span>
                    </div>
                    {claim.checks.length > 1 && (
                      <div className="citation-tabs">
                        {claim.checks.map((c, i) => (
                          <button
                            key={i}
                            aria-pressed={i === checkIndex}
                            onClick={() => {
                              setCheckIndex(i);
                              setPassageIndex(
                                Math.max(
                                  0,
                                  c.verdict?.evidence.findIndex(
                                    (e) =>
                                      e.passage.passage_id ===
                                      c.verdict?.selected_passage_id,
                                  ) ?? 0,
                                ),
                              );
                            }}
                          >
                            Citation [{c.anchor_id}]
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="source-publication">
                      <div className="journal-meta">
                        <span className="journal-icon">
                          <BookOpen size={14} />
                        </span>
                        {paper?.journal || "Publication record"}
                        <span className="mono">
                          {paper?.year || "YEAR N/A"}
                        </span>
                      </div>
                      <h3>
                        {paper?.title || "No matching publication found."}
                      </h3>
                      <p className="source-authors">
                        {paper?.authors.join(" · ") ||
                          "Author metadata unavailable"}
                      </p>
                      {paper?.doi &&
                        (report.demo &&
                        !paper.doi.toLowerCase().startsWith("10.1016/") ? (
                          <span className="doi mono">
                            <Link2 size={12} />
                            {paper.doi}
                            <span>FIXTURE</span>
                          </span>
                        ) : (
                          <a
                            className="doi mono"
                            href={`https://doi.org/${encodeURI(paper.doi)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Link2 size={12} />
                            {paper.doi}
                            <ExternalLink size={11} />
                          </a>
                        ))}
                    </div>
                    <div
                      className={`pedigree-banner ${paper?.retraction_status === "retracted" ? "pink" : paper?.retraction_status === "not_flagged" ? "green" : "amber"}`}
                    >
                      <ShieldAlert size={17} />
                      <div>
                        <strong>
                          {paper?.retraction_status === "retracted"
                            ? "RETRACTED PUBLICATION"
                            : paper?.retraction_status === "not_flagged"
                              ? "No retraction flag found"
                              : "Source integrity unresolved"}
                        </strong>
                        <span>
                          {report.demo
                            ? "Benchmark integrity record"
                            : "Scholarly integrity lookup"}
                          {paper?.retraction_events[0]?.date
                            ? ` · ${paper.retraction_events[0].date}`
                            : ""}
                        </span>
                      </div>
                      <span className="status-dot" />
                    </div>
                    <div className="proof-heading">
                      <h3>What the source says</h3>
                      <span className="mono">
                        {verdict?.source_kind === "abstract"
                          ? "ABSTRACT"
                          : verdict?.source_kind === "full_text"
                            ? "FULL TEXT"
                            : "NO EVIDENCE"}
                      </span>
                    </div>
                    {evidence ? (
                      <div className={`source-proof ${activeTone}`}>
                        <span className="quote-mark">“</span>
                        <blockquote>
                          <MetricText text={evidence.passage.text} />
                        </blockquote>
                        <div className="proof-citation">
                          <FileText size={11} />
                          <span>
                            Citation [{check?.anchor_id}] · Passage{" "}
                            {passageIndex + 1}
                          </span>
                          <span className="mono">EXACT EXTRACT</span>
                        </div>
                      </div>
                    ) : (
                      <div className="evidence-missing">
                        <TriangleAlert size={22} />
                        <h4>No source evidence available.</h4>
                        <p>
                          {check?.message ||
                            "The citation could not be linked to an accessible source."}
                        </p>
                      </div>
                    )}
                    {findings.map((f, i) => (
                      <div className="discrepancy-card" key={i}>
                        <div className="diff-heading">
                          <Activity size={14} />
                          <h4>Numerical discrepancy</h4>
                          {f.relative_difference != null && (
                            <span className="mono">
                              {(f.relative_difference * 100).toFixed(0)}%
                              variance
                            </span>
                          )}
                        </div>
                        <div className="diff-values">
                          <div>
                            <span>MANUSCRIPT CLAIM</span>
                            <strong className="claimed">
                              {f.claim_entity?.text || "Scope differs"}
                            </strong>
                          </div>
                          <div className="diff-equals">≠</div>
                          <div>
                            <span>SOURCE EVIDENCE</span>
                            <strong className="observed">
                              {f.evidence_entity?.text || "See source"}
                            </strong>
                          </div>
                        </div>
                        <p>{f.explanation}</p>
                      </div>
                    ))}
                    {verdict?.evidence.length! > 1 && (
                      <div className="citation-tabs">
                        {verdict?.evidence.map((e, i) => (
                          <button
                            key={i}
                            aria-pressed={i === passageIndex}
                            onClick={() => setPassageIndex(i)}
                          >
                            Passage {i + 1}
                          </button>
                        ))}
                      </div>
                    )}
                    {verdict && checked && (
                      <div className="entailment">
                        <div>
                          <span>Entailment confidence</span>
                          <strong className="mono">
                            {(verdict.confidence * 100).toFixed(1)}
                            <small>%</small>
                          </strong>
                        </div>
                        <div className="confidence-track">
                          <motion.span
                            initial={false}
                            animate={{ scaleX: verdict.confidence }}
                          />
                        </div>
                        <p>
                          <BrainLabel model={verdict.nli_model} /> ·
                          Uncalibrated score
                        </p>
                      </div>
                    )}
                    <div className="reasoning">
                      <h4>Assessment rationale</h4>
                      <p>{verdict?.explanation || check?.message}</p>
                    </div>
                    <details className="source-details">
                      <summary>
                        Provenance & audit notes <ChevronDown size={13} />
                      </summary>
                      <div className="coordinate-record">
                        <span>Manuscript bounding box</span>
                        <code>
                          p{claim.page_number} ·{" "}
                          {Object.values(claim.bounding_box)
                            .map((v) => v.toFixed(1))
                            .join(", ")}
                        </code>
                      </div>
                      {check?.reference && <p>{check.reference.raw_text}</p>}
                      {[
                        ...new Set([
                          ...(verdict?.warnings || []),
                          ...(paper?.warnings || []),
                        ]),
                      ].map((w, i) => (
                        <p key={i}>{w}</p>
                      ))}
                    </details>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="pane-bottom">
            <span>
              <ShieldCheck size={12} /> Traceable to source
            </span>
            <span className="mono">
              {report.demo ? "FIXTURE DATA" : "EXPERT REVIEW ADVISED"}
            </span>
          </div>
        </section>
      </div>
      <footer className="workspace-footer">
        <span>
          <span className="status-dot" />{" "}
          {report.demo
            ? "Deterministic benchmark. Synthetic sources are labeled."
            : "Assessment complete. Review unresolved evidence before drawing conclusions."}
        </span>
        <span className="mono">
          {summary.claims_assessed} / {summary.total_claims} CLAIMS ASSESSED
        </span>
      </footer>
    </main>
  );
}
function BrainLabel({ model }: { model: string }) {
  return (
    <span>
      {model.includes("offline")
        ? "Deterministic fixture"
        : model.includes("DeBERTa")
          ? "DeBERTa-v3"
          : model.split("/").at(-1)}
    </span>
  );
}
