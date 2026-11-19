from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from parser.document_ingest import ClaimLocation, PageText, ReferenceItem
from resolvers.scholarly_resolver import ResolvedPaper
from verification.models import Label, VerificationVerdict

Stage = Literal[
    "Queued", "Parsing", "Resolving Citations", "NLI Checking", "Complete", "Failed"
]


class ProgressEvent(BaseModel):
    sequence: int
    task_id: str
    stage: Stage
    progress: int = Field(ge=0, le=100)
    message: str
    created_at: str


class TaskState(BaseModel):
    task_id: str
    filename: str
    demo: bool = False
    benchmark: str | None = None
    created_at: str
    events: list[ProgressEvent] = Field(default_factory=list)


class CitationCheck(BaseModel):
    anchor_id: str
    reference: ReferenceItem | None = None
    paper: ResolvedPaper | None = None
    verdict: VerificationVerdict | None = None
    state: Literal["checked", "insufficient_evidence", "unresolved", "error"]
    message: str | None = None


class ClaimReport(ClaimLocation):
    label: Label | None = None
    checks: list[CitationCheck] = Field(default_factory=list)


class ReportSummary(BaseModel):
    veracity_score: float | None
    total_claims: int
    claims_assessed: int
    total_citations: int
    citations_audited: int
    retraction_alerts: int
    concern_alerts: int
    coverage_percent: float
    score_method: str = "Mean claim support: supported=100, partial=50, contradicted/unsupported=0. Unassessed claims excluded."


class AuditReport(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    task_id: str
    filename: str
    demo: bool
    created_at: str
    completed_at: str
    summary: ReportSummary
    pages: list[PageText]
    claims: list[ClaimReport]
    references: list[ReferenceItem]
    warnings: list[str]
