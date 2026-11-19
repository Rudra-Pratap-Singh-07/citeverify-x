"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import EvidencePanel from "./EvidencePanel";
import { API, request } from "../lib/api";
import { Progress, Report, labelText, tone } from "../lib/types";
const ManuscriptViewer = dynamic(() => import("./ManuscriptViewer"), {
  ssr: false,
  loading: () => <p className="notice">Loading document viewer…</p>,
});
export default function Workbench() {
  const [task, setTask] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState("");
  const [event, setEvent] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const saved = localStorage.getItem("citeverify-task");
    if (saved) setTask(saved);
  }, []);
  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    let terminal = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const accept = async (e: Progress) => {
      if (cancelled) return;
      setEvent(e);
      if (e.stage === "Failed") {
        terminal = true;
        setError(e.message);
      }
      if (e.stage === "Complete" && !loading) {
        loading = true;
        try {
          const r = await request<Report>(`/api/v1/verify/report/${task}`);
          if (!cancelled) {
            setReport(r);
            setSelected(r.claims[0]?.claim_id || "");
            terminal = true;
          }
        } catch (e) {
          if (!cancelled) setError(String(e));
          loading = false;
        }
      }
    };
    const poll = async () => {
      try {
        const state = await request<{ events: Progress[] }>(
          `/api/v1/verify/status/${task}`,
        );
        await accept(state.events[state.events.length - 1]);
      } catch (e) {
        if (!cancelled) setError(`Could not retrieve audit: ${String(e)}`);
      }
      if (!cancelled && !terminal) timer = setTimeout(poll, 2500);
    };
    void poll();
    socket = new WebSocket(
      `${API.replace(/^http/, "ws")}/api/v1/verify/stream/${task}`,
    );
    socket.onmessage = (e) => {
      try {
        void accept(JSON.parse(e.data));
      } catch {
        setError("Invalid progress event received. Polling for status.");
      }
    };
    socket.onerror = () => {};
    return () => {
      cancelled = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [task]);
  async function start(pdf?: File) {
    setError("");
    if (
      pdf &&
      (pdf.size > 25 * 1024 * 1024 || !pdf.name.toLowerCase().endsWith(".pdf"))
    ) {
      setError("Choose a PDF of 25 MB or less.");
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      if (pdf) body.append("file", pdf);
      const r = await request<{ task_id: string }>(
        pdf ? "/api/v1/verify" : "/api/v1/verify/demo",
        { method: "POST", ...(pdf ? { body } : {}) },
      );
      setReport(null);
      setEvent(null);
      setTask(r.task_id);
      localStorage.setItem("citeverify-task", r.task_id);
    } catch (e) {
      setError(`Could not start audit: ${String(e)}`);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  }
  async function download() {
    if (!report) return;
    setExporting(true);
    try {
      const r = await fetch(
        `${API}/api/v1/verify/certificate/${report.task_id}`,
      );
      if (!r.ok) throw Error("Certificate generation failed");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `CiteVerify-${report.task_id.slice(0, 8)}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }
  const busy = uploading || (!!task && !report && event?.stage !== "Failed");
  const s = report?.summary;
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/">
          CV
          <span>
            CiteVerify<span className="brand-x">-X</span>
          </span>
        </a>
        <span className="workspace-label">EVIDENCE WORKBENCH</span>
        <div className="header-actions">
          <button
            className="subtle"
            onClick={() => file.current?.click()}
            disabled={busy}
          >
            New audit
          </button>
          <button
            className="primary"
            onClick={download}
            disabled={!report || exporting}
          >
            {exporting ? "Preparing…" : "Export certificate"}
          </button>
        </div>
      </header>
      <input
        ref={file}
        className="sr-only"
        type="file"
        accept=".pdf,application/pdf"
        aria-label="Upload manuscript PDF"
        onChange={(e) => {
          if (e.target.files?.[0]) void start(e.target.files[0]);
        }}
      />
      <section className="overview">
        <div>
          <div className="eyebrow">Manuscript integrity review</div>
          <h1>
            {report ? report.filename : "Follow the claim. Find the evidence."}
          </h1>
          <p>
            {report
              ? report.demo
                ? "Synthetic demo · illustrative sources, real inference"
                : "Evidence assessment for expert review"
              : "A transparent, claim-by-claim view of what your citations actually support."}
          </p>
        </div>
        <div className="metrics">
          <div title={s?.score_method}>
            <strong>
              {s?.veracity_score != null ? `${s.veracity_score}%` : "—"}
            </strong>
            <span>Manuscript veracity</span>
            <small>
              {s
                ? `${s.coverage_percent}% claim coverage`
                : "Evidence support score"}
            </small>
          </div>
          <div>
            <strong>
              {s ? `${s.citations_audited}/${s.total_citations}` : "—"}
            </strong>
            <span>Citations audited</span>
            <small>
              {s
                ? `${s.total_claims} extracted claims`
                : "Citation links checked"}
            </small>
          </div>
          <div>
            <strong className={s?.retraction_alerts ? "alert-text" : ""}>
              {s?.retraction_alerts ?? "—"}
            </strong>
            <span>Retraction alerts</span>
            <small>
              {s
                ? `${s.concern_alerts} expressions of concern`
                : "Source pedigree"}
            </small>
          </div>
        </div>
      </section>
      {error && (
        <div role="alert" className="error">
          {error}
          <button
            onClick={() => {
              setTask("");
              setEvent(null);
              setError("");
              localStorage.removeItem("citeverify-task");
            }}
          >
            Dismiss / reset
          </button>
        </div>
      )}
      {task && !report && (
        <section className="progress-panel" aria-live="polite">
          <div className="section-row">
            <h2>{event?.stage || "Connecting to audit"}</h2>
            <span>{event?.progress || 0}%</span>
          </div>
          <progress max={100} value={event?.progress || 0} />
          <p>{event?.message || "Retrieving the latest audit status…"}</p>
          <div className="stages">
            Parsing <span>·</span> Resolving citations <span>·</span> NLI
            checking <span>·</span> Complete
          </div>
        </section>
      )}
      {!task && !report && (
        <section className="welcome">
          <div className="upload-card">
            <div className="file-symbol">PDF</div>
            <h2>Bring your manuscript.</h2>
            <p>
              Upload a research paper to trace empirical claims back to their
              cited sources.
            </p>
            <button
              className="primary"
              disabled={uploading}
              onClick={() => file.current?.click()}
            >
              Choose manuscript PDF
            </button>
            <small>Text-layer PDF · up to 25 MB</small>
            <div className="demo-line">
              Explore the workflow first.
              <button
                className="text-button"
                disabled={uploading}
                onClick={() => start()}
              >
                Open synthetic demo
              </button>
            </div>
          </div>
          <div className="review-guide">
            <div className="eyebrow">Built for careful review</div>
            <h2>Evidence, with the context intact.</h2>
            <ol>
              <li>
                <strong>Locate the claim</strong>
                <p>See cited statements in their original manuscript layout.</p>
              </li>
              <li>
                <strong>Inspect the source</strong>
                <p>
                  Compare evidence passages, numerical discrepancies and source
                  integrity.
                </p>
              </li>
              <li>
                <strong>Share your findings</strong>
                <p>
                  Export a certificate that includes checked claims and
                  unresolved gaps.
                </p>
              </li>
            </ol>
            <p className="muted">
              Automated scores assist review. Missing evidence remains visible
              and is excluded from the support score.
            </p>
          </div>
        </section>
      )}
      {report && (
        <>
          <div className="workbench">
            <section className="pane manuscript">
              <div className="pane-header">
                <h2>
                  01 <span>Manuscript</span>
                </h2>
                <span className="muted">Select a highlight or claim</span>
              </div>
              <ManuscriptViewer
                key={report.task_id}
                report={report}
                selected={selected}
                onSelect={setSelected}
              />
              <div className="claim-list" aria-label="Extracted claims">
                {report.claims.length === 0 ? (
                  <p>
                    No cited empirical claims were extracted. No positive
                    verification has been assigned.
                  </p>
                ) : (
                  report.claims.map((c, i) => (
                    <button
                      key={c.claim_id}
                      className={`claim-row ${selected === c.claim_id ? "active" : ""}`}
                      onClick={() => setSelected(c.claim_id)}
                      aria-pressed={selected === c.claim_id}
                    >
                      <span className="claim-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span>
                        <span className={`badge ${tone(c.label)}`}>
                          {labelText(c.label)}
                        </span>
                        <span className="claim-sentence">
                          {c.sentence_text}
                        </span>
                        <small>
                          Page {c.page_number} · {c.checks.length} citation
                          {c.checks.length === 1 ? "" : "s"}
                        </small>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
            <section className="pane evidence">
              <div className="pane-header">
                <h2>
                  02 <span>Source evidence</span>
                </h2>
                <span className="live-dot">Linked review</span>
              </div>
              <EvidencePanel
                claim={report.claims.find((c) => c.claim_id === selected)}
                demo={report.demo}
              />
            </section>
          </div>
          <details className="audit-notes">
            <summary>Audit notes & methodology</summary>
            <p>{report.summary.score_method}</p>
            {report.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </details>
        </>
      )}
      <footer>
        CiteVerify-X{" "}
        <span>
          Evidence provenance · Numerical verification · Human judgment
        </span>
      </footer>
    </main>
  );
}
