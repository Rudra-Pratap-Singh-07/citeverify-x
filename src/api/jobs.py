"""Persistent local job state. Run one gateway process per storage directory."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from parser.document_ingest import IngestionResult, ingest_document
from resolvers.scholarly_resolver import ResolvedPaper, ScholarlyResolver
from verification.models import Label
from verification.pipeline import VerificationPipeline

from .models import (
    AuditReport,
    CitationCheck,
    ClaimReport,
    ProgressEvent,
    ReportSummary,
    Stage,
    TaskState,
)

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]


def now() -> str:
    return datetime.now(UTC).isoformat()


def atomic_json(path: Path, payload: str) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def summarize(
    claims: list[ClaimReport], papers: dict[str, ResolvedPaper]
) -> ReportSummary:
    priority = {
        Label.RETRACTED: 4,
        Label.SUPPORTED: 0,
        Label.PARTIALLY_SUPPORTED: 1,
        Label.UNSUPPORTED: 2,
        Label.CONTRADICTED: 3,
    }
    weights = {
        Label.RETRACTED: 0,
        Label.SUPPORTED: 100,
        Label.PARTIALLY_SUPPORTED: 50,
        Label.UNSUPPORTED: 0,
        Label.CONTRADICTED: 0,
    }
    values = []
    for claim in claims:
        completed = [
            c.verdict.label for c in claim.checks if c.state == "checked" and c.verdict
        ]
        if completed:
            claim.label = max(completed, key=priority.__getitem__)
            values.append(weights[claim.label])
    unique = {p.doi or anchor: p for anchor, p in papers.items()}
    checks = [c for claim in claims for c in claim.checks]
    return ReportSummary(
        veracity_score=round(sum(values) / len(values), 1) if values else None,
        total_claims=len(claims),
        claims_assessed=len(values),
        total_citations=len(checks),
        citations_audited=sum(c.state == "checked" for c in checks),
        retraction_alerts=sum(
            p.retraction_status == "retracted" for p in unique.values()
        ),
        concern_alerts=sum(
            p.retraction_status == "expression_of_concern" for p in unique.values()
        ),
        coverage_percent=round(100 * len(values) / len(claims), 1) if claims else 0,
    )


class JobManager:
    def __init__(
        self,
        directory: Path,
        pipeline: VerificationPipeline,
        resolver_factory: Callable[[], Any] = ScholarlyResolver,
    ) -> None:
        self.directory, self.pipeline, self.resolver_factory = (
            directory,
            pipeline,
            resolver_factory,
        )
        self.states: dict[str, TaskState] = {}
        self.running: set[asyncio.Task[None]] = set()
        self.slots = asyncio.Semaphore(1)
        # Tiny fixture audits must remain usable during slow scholarly lookups.
        self.benchmark_slots = asyncio.Semaphore(1)

    async def start(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        for path in self.directory.glob("*/state.json"):
            try:
                state = TaskState.model_validate_json(
                    await asyncio.to_thread(path.read_bytes)
                )
                if state.task_id != path.parent.name:
                    continue
                self.states[state.task_id] = state
                if not state.events or state.events[-1].stage not in (
                    "Complete",
                    "Failed",
                ):
                    await self.emit(
                        state,
                        "Failed",
                        0,
                        "Server restarted during the audit. Please upload again.",
                    )
                elif (
                    state.events[-1].stage == "Complete"
                    and not self.report_path(state.task_id).exists()
                ):
                    await self.emit(
                        state,
                        "Failed",
                        0,
                        "The saved report is unavailable. Please upload again.",
                    )
            except (ValueError, OSError):
                logger.exception("Could not restore task state")

    async def stop(self) -> None:
        tasks = list(self.running)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def report_path(self, task_id: str) -> Path:
        return self.directory / task_id / "report.json"

    async def create(self, filename: str, demo: bool) -> TaskState:
        state = TaskState(
            task_id=uuid4().hex, filename=filename, demo=demo, created_at=now()
        )
        (self.directory / state.task_id).mkdir()
        return state

    async def launch(
        self, state: TaskState, pipeline: VerificationPipeline | None = None
    ) -> None:
        self.states[state.task_id] = state
        await self.emit(state, "Queued", 0, "Audit queued")
        task = asyncio.create_task(self.run(state, pipeline))
        self.running.add(task)
        task.add_done_callback(self.running.discard)

    async def emit(
        self, state: TaskState, stage: Stage, progress: int, message: str
    ) -> None:
        event = ProgressEvent(
            sequence=len(state.events) + 1,
            task_id=state.task_id,
            stage=stage,
            progress=progress,
            message=message,
            created_at=now(),
        )
        # Publish in memory only after the snapshot is durably written.
        snapshot = state.model_copy(update={"events": [*state.events, event]})
        await asyncio.to_thread(
            atomic_json,
            self.directory / state.task_id / "state.json",
            snapshot.model_dump_json(),
        )
        state.events.append(event)

    async def run(
        self, state: TaskState, pipeline: VerificationPipeline | None = None
    ) -> None:
        try:
            slots = self.benchmark_slots if state.benchmark else self.slots
            async with slots:
                await self.emit(
                    state,
                    "Parsing",
                    5,
                    "Extracting claims, references and page coordinates",
                )
                document = await ingest_document(
                    self.directory / state.task_id / "manuscript.pdf"
                )
                await self.emit(
                    state,
                    "Resolving Citations",
                    20,
                    f"Resolving {len(document.references)} references",
                )
                papers: dict[str, ResolvedPaper] = {}
                if state.benchmark:
                    records = json.loads(
                        (ROOT / "data/demo_fixtures.json").read_bytes()
                    )["papers_by_doi"]
                    papers = {
                        ref.anchor_id: ResolvedPaper.model_validate(
                            records.get(
                                (ref.parsed_doi or "").lower(), {"status": "missing"}
                            )
                        )
                        for ref in document.references
                    }
                elif state.demo:
                    records = json.loads(
                        (ROOT / "examples/demo-resolved.json").read_bytes()
                    )
                    papers = {
                        r["anchor_id"]: ResolvedPaper.model_validate(r["paper"])
                        for r in records
                    }
                else:
                    async with self.resolver_factory() as resolver:
                        for i, ref in enumerate(document.references):
                            try:
                                papers[ref.anchor_id] = await resolver.resolve(ref)
                            except Exception:
                                logger.exception("Reference resolution failed")
                                papers[ref.anchor_id] = ResolvedPaper(
                                    status="unavailable",
                                    warnings=["Resolution failed for this reference."],
                                )
                            await self.emit(
                                state,
                                "Resolving Citations",
                                20
                                + int(35 * (i + 1) / max(1, len(document.references))),
                                f"Resolved {i + 1} of {len(document.references)} reference records",
                            )
                await self.emit(
                    state, "NLI Checking", 55, "Aligning claims with available evidence"
                )
                report = await self.build_report(state, document, papers, pipeline)
                await asyncio.to_thread(
                    atomic_json,
                    self.report_path(state.task_id),
                    report.model_dump_json(),
                )
                await self.emit(state, "Complete", 100, "Audit complete")
        except asyncio.CancelledError:
            await self.emit(
                state,
                "Failed",
                0,
                "Audit interrupted by server shutdown. Please upload again.",
            )
            raise
        except Exception:
            logger.exception("Audit failed for %s", state.task_id)
            await self.emit(
                state,
                "Failed",
                0,
                "The document could not be audited. Use a readable text-layer PDF and retry.",
            )

    async def build_report(
        self,
        state: TaskState,
        document: IngestionResult,
        papers: dict[str, ResolvedPaper],
        pipeline: VerificationPipeline | None = None,
    ) -> AuditReport:
        claims: dict[str, ClaimReport] = {}
        for row in [*document.citation_maps, *document.unresolved]:
            if row.claim_id not in claims:
                claims[row.claim_id] = ClaimReport.model_validate(row.model_dump())
        for i, row in enumerate(document.citation_maps):
            paper = papers.get(
                row.matched_reference.anchor_id, ResolvedPaper(status="missing")
            )
            check = CitationCheck(
                anchor_id=row.matched_reference.anchor_id,
                reference=row.matched_reference,
                paper=paper,
                state="error",
            )
            try:
                check.verdict = await (pipeline or self.pipeline).verify(row, paper)
                if (
                    paper.retraction_status == "retracted"
                    and check.verdict.status == "completed"
                ):
                    check.verdict.label = Label.RETRACTED
                    check.verdict.explanation = (
                        "The cited source is retracted. " + check.verdict.explanation
                    )
                check.state = (
                    "checked"
                    if check.verdict.status == "completed"
                    else "insufficient_evidence"
                )
                check.message = check.verdict.explanation
            except Exception:
                logger.exception("Verification failed for %s", row.claim_id)
                check.message = "Inference unavailable for this citation. Check the configured model and retry."
            claims[row.claim_id].checks.append(check)
            await self.emit(
                state,
                "NLI Checking",
                55 + int(40 * (i + 1) / max(1, len(document.citation_maps))),
                f"Checked {i + 1} of {len(document.citation_maps)} citation links",
            )
        for row in document.unresolved:
            claims[row.claim_id].checks.append(
                CitationCheck(
                    anchor_id=row.target,
                    state="unresolved",
                    message=row.reason.replace("_", " "),
                )
            )
        ordered = sorted(
            claims.values(),
            key=lambda c: (c.page_number, c.bounding_box["y0"], c.bounding_box["x0"]),
        )
        warnings = list(document.warnings)
        if state.demo:
            warnings.insert(
                0,
                "Synthetic demonstration sources. This audit does not validate real published papers.",
            )
        warnings.append(
            "Automated evidence assessment. Model confidence is uncalibrated; expert review is required."
        )
        return AuditReport(
            task_id=state.task_id,
            filename=state.filename,
            demo=state.demo,
            created_at=state.created_at,
            completed_at=now(),
            pages=document.pages,
            claims=ordered,
            references=document.references,
            summary=summarize(ordered, papers),
            warnings=warnings,
        )
