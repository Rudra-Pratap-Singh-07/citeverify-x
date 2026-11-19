from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Label(StrEnum):
    SUPPORTED = "SUPPORTED"
    PARTIALLY_SUPPORTED = "PARTIALLY_SUPPORTED"
    CONTRADICTED = "CONTRADICTED"
    UNSUPPORTED = "UNSUPPORTED"
    RETRACTED = "RETRACTED"


class Passage(BaseModel):
    passage_id: str
    text: str
    start_char: int
    end_char: int
    start_word: int
    end_word: int


class RankedPassage(Passage):
    bm25_score: float
    cosine_score: float
    fusion_score: float


class NLIScores(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    entailment: float = Field(ge=0, le=1)
    neutral: float = Field(ge=0, le=1)
    contradiction: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def normalized(self) -> NLIScores:
        if abs(self.entailment + self.neutral + self.contradiction - 1) > 0.001:
            raise ValueError("NLI scores must sum to one")
        return self


class NumericEntity(BaseModel):
    text: str
    value: float
    unit: str
    metric: str
    comparator: str = "="
    start: int
    end: int
    context: str


class AuditFinding(BaseModel):
    kind: Literal["numeric_mismatch", "scope_mismatch", "unmatched", "ambiguous"]
    explanation: str
    claim_entity: NumericEntity | None = None
    evidence_entity: NumericEntity | None = None
    relative_difference: float | None = None


class NumericalAudit(BaseModel):
    claim_entities: list[NumericEntity]
    evidence_entities: list[NumericEntity]
    findings: list[AuditFinding]

    @property
    def requires_downgrade(self) -> bool:
        return any(f.kind in ("numeric_mismatch", "scope_mismatch") for f in self.findings)


class EvidenceAssessment(BaseModel):
    passage: RankedPassage
    nli_scores: NLIScores
    nli_label: Label
    label: Label
    confidence: float = Field(ge=0, le=1)
    audit: NumericalAudit


class VerificationVerdict(BaseModel):
    claim_id: str
    claim_text: str
    anchor_id: str
    source_doi: str | None
    source_kind: Literal["full_text", "abstract", "none"]
    source_text_sha256: str | None
    status: Literal["completed", "insufficient_evidence"]
    label: Label
    confidence: float = Field(ge=0, le=1)
    confidence_kind: Literal["uncalibrated_model_score", "no_evidence"] = "uncalibrated_model_score"
    nli_model: str
    embedding_model: str
    selected_passage_id: str | None = None
    explanation: str
    evidence: list[EvidenceAssessment] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
