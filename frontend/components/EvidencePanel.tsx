"use client";
import { useEffect, useRef, useState } from "react";
import { Claim, labelText, tone } from "../lib/types";
export default function EvidencePanel({
  claim,
  demo,
}: {
  claim: Claim | undefined;
  demo: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [passage, setPassage] = useState(0);
  const proof = useRef<HTMLDivElement>(null);
  const previousClaim = useRef<string>();
  useEffect(() => {
    setIndex(0);
    setPassage(0);
    if (previousClaim.current && previousClaim.current !== claim?.claim_id) {
      proof.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
    previousClaim.current = claim?.claim_id;
  }, [claim?.claim_id]);
  const check = claim?.checks[index] || claim?.checks[0];
  const v = check?.verdict;
  const p = check?.paper;
  useEffect(() => {
    setPassage(
      Math.max(
        0,
        v?.evidence.findIndex(
          (e) => e.passage.passage_id === v.selected_passage_id,
        ) ?? 0,
      ),
    );
  }, [v]);
  if (!claim || !check)
    return (
      <div className="empty">
        <span className="eyebrow">Evidence inspector</span>
        <h2>Every claim has a source story.</h2>
        <p>
          Select a highlighted claim to inspect its citation and supporting
          passage.
        </p>
      </div>
    );
  const evidence = v?.evidence[passage];
  return (
    <div className="evidence-body">
      <div className="eyebrow">Selected claim · page {claim.page_number}</div>
      <h2 className="claim-heading">{claim.sentence_text}</h2>
      <div className="tabs">
        {claim.checks.map((c, i) => (
          <button
            key={i}
            aria-pressed={index === i}
            onClick={() => {
              setIndex(i);
              setPassage(0);
            }}
          >
            Citation {c.anchor_id}
          </button>
        ))}
      </div>
      <article className="source-card">
        <div className="eyebrow">
          Original source {demo ? "· synthetic fixture" : ""}
        </div>
        <h3>{p?.title || "Source not resolved"}</h3>
        <p>
          {p?.authors.join(", ") || "Author information unavailable"}
          {p?.year ? ` · ${p.year}` : ""}
        </p>
        {p?.doi &&
          (demo ? (
            <span className="muted">DOI: {p.doi} (demo)</span>
          ) : (
            <a
              href={`https://doi.org/${encodeURI(p.doi)}`}
              target="_blank"
              rel="noreferrer"
            >
              DOI: {p.doi}
            </a>
          ))}
        <div
          className={`integrity ${p?.retraction_status === "retracted" ? "red" : p?.retraction_status === "not_flagged" ? "green" : "amber"}`}
        >
          Integrity status:{" "}
          {(p?.retraction_status || "unknown").replaceAll("_", " ")}
        </div>
        {p?.warnings.map((w, i) => (
          <p className="muted" key={i}>
            {w}
          </p>
        ))}
      </article>
      <div className="proof" ref={proof}>
        <div className="section-row">
          <h3>Evidence passage</h3>
          <span className={`badge ${tone(claim.label)}`}>
            {check.state === "checked" && v
              ? labelText(v.label)
              : "Needs review"}
          </span>
        </div>
        <p className="muted">
          {v
            ? `Evidence basis: ${v.source_kind.replace("_", " ")}`
            : "No evidence available"}
        </p>
        {evidence ? (
          <blockquote>
            <mark>{evidence.passage.text}</mark>
          </blockquote>
        ) : (
          <p className="notice">
            {check.message ||
              "No retrievable evidence was found for this citation."}
          </p>
        )}
        {(v?.evidence.length || 0) > 1 && (
          <div className="tabs">
            {v?.evidence.map((e, i) => (
              <button
                key={e.passage.passage_id}
                onClick={() => setPassage(i)}
                aria-pressed={passage === i}
              >
                Passage {i + 1}
              </button>
            ))}
          </div>
        )}
        <p>{v?.explanation}</p>
        {evidence?.audit.findings.map((f, i) => (
          <p className="finding" key={i}>
            {f.explanation}
          </p>
        ))}
        {v && check.state === "checked" && (
          <div className="confidence">
            <div>
              Model confidence{" "}
              <strong>{(v.confidence * 100).toFixed(1)}%</strong>
            </div>
            <progress max={1} value={v.confidence} />
            <small>
              Uncalibrated model score; not a probability of factual
              correctness.
            </small>
          </div>
        )}
        {v?.warnings.map((w, i) => (
          <p className="muted" key={i}>
            {w}
          </p>
        ))}
      </div>
      {check.reference && (
        <details>
          <summary>Original bibliography entry</summary>
          <p>{check.reference.raw_text}</p>
        </details>
      )}
    </div>
  );
}
