"""Service-ready async aggregation of retrieval, inference, and deterministic audits."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Sequence
from typing import Literal

from parser.document_ingest import CitationMap, citation_free_text
from resolvers.scholarly_resolver import ResolvedPaper

from .models import EvidenceAssessment, Label, VerificationVerdict
from .nli_engine import HuggingFaceNLI, InferenceError, NLIBackend, classify
from .numerical_audit import audit_numbers
from .retriever import HybridRetriever


class VerificationPipeline:
    """Instantiate once per service worker and reuse model/index caches."""

    def __init__(
        self,
        retriever: HybridRetriever | None = None,
        nli: NLIBackend | None = None,
        max_concurrency: int = 2,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        self.retriever = retriever or HybridRetriever()
        self.nli = nli or HuggingFaceNLI()
        self._slots = asyncio.Semaphore(max_concurrency)

    async def verify(self, claim: CitationMap, paper: ResolvedPaper) -> VerificationVerdict:
        async with self._slots:
            text = (
                paper.raw_text
                if paper.raw_text and paper.raw_text.strip()
                else paper.abstract or ""
            )
            kind: Literal["full_text", "abstract", "none"] = (
                "full_text"
                if paper.raw_text and paper.raw_text.strip()
                else "abstract"
                if text.strip()
                else "none"
            )
            result = VerificationVerdict(
                claim_id=claim.claim_id,
                claim_text=claim.sentence_text,
                anchor_id=claim.matched_reference.anchor_id,
                source_doi=paper.doi,
                source_kind=kind,
                source_text_sha256=hashlib.sha256(text.encode()).hexdigest() if text else None,
                status="insufficient_evidence",
                label=Label.UNSUPPORTED,
                confidence=0,
                confidence_kind="no_evidence",
                nli_model=self.nli.model_name,
                embedding_model=self.retriever.encoder.model_name,
                explanation="No resolved source text or abstract is available.",
                warnings=list(paper.warnings),
            )
            if paper.status != "resolved" or not text.strip():
                return result
            hypothesis = citation_free_text(claim.sentence_text)
            passages = await asyncio.to_thread(self.retriever.retrieve, hypothesis, text)
            scores = await self.nli.predict([(p.text, hypothesis) for p in passages])
            if len(scores) != len(passages):
                raise InferenceError("NLI returned the wrong number of scores")
            for passage, score in zip(passages, scores, strict=True):
                label, confidence = classify(score)
                audit = audit_numbers(claim.sentence_text, passage.text)
                final = (
                    Label.PARTIALLY_SUPPORTED
                    if label == Label.SUPPORTED and audit.requires_downgrade
                    else label
                )
                result.evidence.append(
                    EvidenceAssessment(
                        passage=passage,
                        nli_scores=score,
                        nli_label=label,
                        label=final,
                        confidence=confidence,
                        audit=audit,
                    )
                )
            support = [
                e
                for e in result.evidence
                if e.label in (Label.SUPPORTED, Label.PARTIALLY_SUPPORTED)
            ]
            contradiction = [e for e in result.evidence if e.label == Label.CONTRADICTED]
            # Any high-confidence contradiction is surfaced, even if another window supports the claim.
            pool = support or contradiction or result.evidence
            selected = max(pool, key=lambda e: (e.label == Label.SUPPORTED, e.confidence))
            result.status, result.confidence_kind = "completed", "uncalibrated_model_score"
            result.label, result.confidence = selected.label, selected.confidence
            result.selected_passage_id = selected.passage.passage_id
            result.explanation = (
                f"Selected passage classified as {result.label.value.lower().replace('_', ' ')}."
            )
            if support and contradiction:
                result.label = Label.PARTIALLY_SUPPORTED
                result.confidence = min(
                    selected.confidence, max(e.confidence for e in contradiction)
                )
                result.explanation = (
                    "Retrieved passages contain conflicting support and contradiction."
                )
            if selected.audit.requires_downgrade:
                result.explanation += " " + " ".join(
                    f.explanation
                    for f in selected.audit.findings
                    if f.kind in ("numeric_mismatch", "scope_mismatch")
                )
            if kind == "abstract":
                result.warnings.append(
                    "Assessment uses the abstract only; full-text qualifiers may be missing."
                )
            if paper.retraction_status in ("retracted", "expression_of_concern"):
                result.warnings.append(f"Source integrity status: {paper.retraction_status}.")
            result.warnings.append(
                "Confidence is uncalibrated and is not a probability that the claim is true."
            )
            return result

    async def verify_many(
        self, items: Sequence[tuple[CitationMap, ResolvedPaper]]
    ) -> list[VerificationVerdict]:
        # Process bounded groups to avoid creating unbounded pending tasks on large manuscripts.
        output = []
        for start in range(0, len(items), 16):
            output.extend(
                await asyncio.gather(*(self.verify(c, p) for c, p in items[start : start + 16]))
            )
        return output
