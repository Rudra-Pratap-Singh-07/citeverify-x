"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "../lib/useReducedMotion";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import {
  ArrowUpRight,
  ArrowRight,
  FileUp,
  FileText,
  ShieldCheck,
  Check,
  Activity,
  GitBranch,
  ScanLine,
  TriangleAlert,
  FlaskConical,
  X,
  LockKeyhole,
} from "lucide-react";
import Brand from "../components/Brand";
import AuditProgress from "../components/AuditProgress";
import { request } from "../lib/api";
import {
  clearPendingAudit,
  lastAudit,
  pendingAudit,
  rememberAudit,
  savePendingAudit,
} from "../lib/auditSession";
import { useAudit } from "../lib/useAudit";
const presets = [
  {
    id: "clean_study",
    title: "Clean study",
    file: "clean_study.pdf",
    detail: "3 citations. Every claim supported.",
    icon: ShieldCheck,
    tone: "green",
  },
  {
    id: "exaggerated_claims",
    title: "Numerical inflation",
    file: "exaggerated_claims.pdf",
    detail: "30% claimed. 12% in the source.",
    icon: Activity,
    tone: "amber",
  },
  {
    id: "retracted_and_hallucinated",
    title: "Retracted & fabricated",
    file: "retracted_and_hallucinated.pdf",
    detail: "Lancet retraction. One fictional DOI.",
    icon: TriangleAlert,
    tone: "pink",
  },
];
export default function Home() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [last, setLast] = useState("");
  const { report, event, error: auditError, fatal, retry } = useAudit(task);
  const reduced = useReducedMotion();
  const x = useMotionValue(0),
    y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 60, damping: 22 }),
    sy = useSpring(y, { stiffness: 60, damping: 22 });
  const px = useTransform(sx, (v) => v * 0.025),
    py = useTransform(sy, (v) => v * 0.025);
  useEffect(() => {
    setLast(lastAudit());
    const pending = pendingAudit();
    if (pending) {
      setTask(pending.id);
      setName(pending.filename);
      setBusy(true);
    }
    setRestoring(false);
  }, []);
  useEffect(() => {
    if (report && task) {
      rememberAudit(task);
      router.push(`/audit/${task}`);
    }
  }, [report, task, router]);
  async function start(file?: File, scenario?: string) {
    if (busy || restoring) return;
    setError("");
    if (
      file &&
      (!file.name.toLowerCase().endsWith(".pdf") ||
        file.size > 25 * 1024 * 1024)
    ) {
      setError("Choose a PDF no larger than 25 MB.");
      return;
    }
    setBusy(true);
    setTask("");
    setName(file?.name || presets.find((p) => p.id === scenario)?.file || "");
    try {
      const body = new FormData();
      if (file) body.append("file", file);
      const r = await request<{ task_id: string }>(
        scenario ? `/api/v1/verify/benchmark/${scenario}` : "/api/v1/verify",
        { method: "POST", ...(file ? { body } : {}) },
      );
      savePendingAudit({
        id: r.task_id,
        filename:
          file?.name ||
          presets.find((p) => p.id === scenario)?.file ||
          "Manuscript.pdf",
      });
      setTask(r.task_id);
    } catch (e) {
      setError(`Could not start the audit. ${String(e)}`);
      setBusy(false);
    } finally {
      if (input.current) input.current.value = "";
    }
  }
  return (
    <main
      className="launchpad"
      onPointerMove={(e) => {
        if (!reduced) {
          x.set(e.clientX - window.innerWidth / 2);
          y.set(e.clientY - window.innerHeight / 2);
        }
      }}
    >
      <div className="coordinate-grid" aria-hidden="true" />
      <motion.div
        className="ambient-light"
        aria-hidden="true"
        style={reduced ? {} : { x: sx, y: sy }}
      />
      <nav className="launch-nav">
        <Brand />
        <div className="nav-center">
          <a href="#how-it-works">The methodology</a>
          <a href="#benchmarks">Benchmarks</a>
        </div>
        <span className="watch-badge">
          <span className="status-dot" />
          Retraction watchdog
        </span>
      </nav>
      <section className="hero">
        <motion.div
          className="hero-copy"
          initial={reduced ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="release-label">
            <span className="status-dot" /> EVIDENCE INTELLIGENCE{" "}
            <span className="label-separator" /> Built for scientific scrutiny
          </div>
          <h1>
            Every claim.
            <br />
            <span className="hero-emphasis">Accounted for.</span>
          </h1>
          <p className="hero-description">
            The provenance engine for scientific truth.
            <br className="desktop-break" /> Trace every claim, catch inflated
            numbers, and surface retracted sources.
          </p>
          <div className="hero-caption">
            <span>
              <Check size={13} /> Claim-level verification
            </span>
            <span>
              <Check size={13} /> Traceable evidence
            </span>
            <span>
              <Check size={13} /> Open scholarly data
            </span>
          </div>
        </motion.div>
        <motion.div
          className="provenance-sculpture"
          aria-hidden="true"
          style={reduced ? {} : { x: px, y: py }}
        >
          <div className="orbit orbit-outer" />
          <div className="orbit orbit-inner" />
          <svg className="graph-lines" viewBox="0 0 480 330">
            <path d="M70 80 C220 80 170 165 245 165 S320 75 420 75 M80 260 C170 260 170 165 245 165 S330 255 420 255" />
            <path
              className="graph-active"
              d="M70 80 C220 80 170 165 245 165 S320 75 420 75"
            />
          </svg>
          <div className="graph-label node-claim">
            <ScanLine size={16} />
            <span>
              MANUSCRIPT CLAIM
              <br />
              <b>30% improvement</b>
            </span>
          </div>
          <div className="graph-core">
            <GitBranch size={32} strokeWidth={1} />
            <span>VERIFY</span>
          </div>
          <div className="graph-label node-source">
            <FileText size={16} />
            <span>
              ORIGINAL EVIDENCE
              <br />
              <b>12% observed</b>
            </span>
          </div>
          <div className="graph-label node-doi">
            <span className="status-dot" />
            DOI RESOLVED
          </div>
          <div className="graph-label node-alert">
            <Activity size={13} /> Numerical discrepancy
          </div>
          <span className="diagram-caption">
            ILLUSTRATIVE CLAIM → EVIDENCE TRACE
          </span>
        </motion.div>
      </section>
      <section className="launch-surface" aria-label="Start a manuscript audit">
        <div className="surface-topline">
          <span>
            <ScanLine size={15} /> New investigation
          </span>
          <span className="mono">PDF / 25 MB MAX</span>
        </div>
        <div
          className={`dropzone ${drag ? "dragging" : ""} ${busy ? "is-busy" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current++;
            setDrag(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault();
            dragDepth.current--;
            if (dragDepth.current === 0) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDrag(false);
            if (e.dataTransfer.files[0]) void start(e.dataTransfer.files[0]);
          }}
        >
          {busy ? (
            <div className="launch-loading">
              <div className="processing-file">
                <FileText size={22} />
                <span>{name}</span>
                {event?.stage === "Failed" ? (
                  <TriangleAlert size={14} />
                ) : (
                  <span className="status-dot" />
                )}
              </div>
              <AuditProgress event={event} />
            </div>
          ) : (
            <>
              <span className="upload-icon">
                <FileUp size={26} strokeWidth={1.3} />
              </span>
              <div>
                <h2>
                  {drag
                    ? "Release to begin the investigation"
                    : "Your manuscript. Under the microscope."}
                </h2>
                <p>Drop a PDF here, or choose a file to follow the evidence.</p>
              </div>
              <button
                className="primary"
                disabled={restoring}
                onClick={() => input.current?.click()}
              >
                Start audit <ArrowUpRight size={16} />
              </button>
              <span className="dropzone-note">
                <LockKeyhole size={11} /> Original layout preserved. Every
                finding linked to its source.
              </span>
            </>
          )}
        </div>
        <input
          className="sr-only"
          ref={input}
          type="file"
          disabled={busy || restoring}
          accept=".pdf,application/pdf"
          aria-label="Choose manuscript PDF"
          onChange={(e) => {
            if (e.target.files?.[0]) void start(e.target.files[0]);
          }}
        />
        {(error || auditError) && (
          <div className="error" role="alert">
            {error || auditError}
            {auditError && !fatal && (
              <button className="text-link" onClick={retry}>
                Reconnect now
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Reset audit"
              onClick={() => {
                clearPendingAudit(task);
                setBusy(false);
                setTask("");
                setError("");
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="benchmark-section" id="benchmarks">
          <div className="benchmark-heading">
            <span>
              <FlaskConical size={14} /> Try a benchmark
            </span>
            <span>Curated fixtures · deterministic offline results</span>
          </div>
          <div className="preset-rail">
            {presets.map((p, i) => (
              <motion.button
                key={p.id}
                className={`preset ${p.tone}`}
                disabled={busy || restoring}
                onClick={() => start(undefined, p.id)}
                whileHover={reduced ? {} : { y: -3 }}
                whileTap={{ scale: 0.98 }}
              >
                <div className="preset-top">
                  <span className="preset-icon">
                    <p.icon size={18} />
                  </span>
                  <span className="mono">0{i + 1}</span>
                  <ArrowUpRight size={14} />
                </div>
                <strong>
                  {p.title}
                  <span>.pdf</span>
                </strong>
                <p>{p.detail}</p>
              </motion.button>
            ))}
          </div>
        </div>
      </section>
      <section className="methodology" id="how-it-works">
        <div className="method-title">
          <h2>
            From assertion
            <br />
            to evidence.
          </h2>
          <p>One traceable chain. Three layers of scrutiny.</p>
          {last && (
            <Link href={`/audit/${last}`} className="resume-link">
              Resume last investigation <ArrowRight size={14} />
            </Link>
          )}
        </div>
        <div className="method-steps">
          {[
            {
              title: "Read the claim in context.",
              text: "Layout-aware extraction maps empirical statements to the exact place they appear in your manuscript.",
            },
            {
              title: "Interrogate the citation.",
              text: "Resolve scholarly records, inspect source integrity, and compare each claim with available evidence.",
            },
            {
              title: "Make a defensible judgment.",
              text: "Review entailment and numerical discrepancies together. Export the evidence, including anything left unresolved.",
            },
          ].map((s, i) => (
            <motion.div
              className="method-row"
              key={s.title}
              initial={reduced ? false : { opacity: 0, y: 15 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
            >
              <span className="method-number">{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>
      <footer className="launch-footer">
        <Brand />
        <span>Built for evidence. Designed for judgment.</span>
        <span className="mono">CITEVERIFY-X / RESEARCH PREVIEW</span>
      </footer>
    </main>
  );
}
