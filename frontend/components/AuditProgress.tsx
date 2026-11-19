"use client";
import { motion } from "framer-motion";
import { useReducedMotion } from "../lib/useReducedMotion";
import {
  Check,
  LoaderCircle,
  ScanLine,
  Network,
  BrainCircuit,
  TriangleAlert,
} from "lucide-react";
import { Progress } from "../lib/types";
const steps = [
  { stage: "Parsing", text: "Deconstructing layout", icon: ScanLine },
  {
    stage: "Resolving Citations",
    text: "Resolving citation DOIs",
    icon: Network,
  },
  {
    stage: "NLI Checking",
    text: "Cross-examining entailment",
    icon: BrainCircuit,
  },
];
export default function AuditProgress({ event }: { event: Progress | null }) {
  const reduced = useReducedMotion();
  const failed = event?.stage === "Failed";
  const rank =
    event?.stage === "Complete"
      ? 3
      : Math.max(
          0,
          steps.findIndex((s) => s.stage === event?.stage),
        );
  return (
    <div
      className={`audit-progress ${failed ? "failed" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="progress-heading">
        <span>
          {failed
            ? "Audit stopped"
            : event?.stage === "Complete"
              ? "Audit complete"
              : "Audit in progress"}
        </span>
        <span className="mono">{event?.progress ?? 0}%</span>
      </div>
      <div className="progress-track">
        <motion.div
          initial={false}
          animate={{ scaleX: (event?.progress ?? 2) / 100 }}
          transition={{ duration: reduced ? 0 : 0.35 }}
        />
      </div>
      <div className="progress-steps">
        {steps.map((s, i) => {
          const Icon = failed ? TriangleAlert : i < rank ? Check : s.icon;
          return (
            <div
              className={
                failed
                  ? ""
                  : i === rank
                    ? "current"
                    : i < rank
                      ? "finished"
                      : ""
              }
              key={s.stage}
            >
              <Icon size={16} />
              <span>{s.text}</span>
              {!failed && i === rank && (
                <LoaderCircle size={12} className="spin" />
              )}
            </div>
          );
        })}
      </div>
      <p>{event?.message || "Preparing your document for inspection."}</p>
    </div>
  );
}
