"""Deterministic golden-corpus checks with no provider or model downloads."""

import asyncio
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pytest

from parser.document_ingest import ingest_document
from resolvers.scholarly_resolver import ScholarlyResolver
from verification.models import Label, NLIScores
from verification.pipeline import VerificationPipeline
from verification.retriever import HybridRetriever

ROOT = Path(__file__).parent / "benchmarks"


class FixtureEncoder:
    model_name = "fixture-token-overlap"

    def encode(self, texts):
        matrix = np.zeros((len(texts), 256), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in text.casefold().split():
                i = (
                    int.from_bytes(
                        hashlib.sha256(token.encode()).digest()[:2], "little"
                    )
                    % 256
                )
                matrix[row, i] += 1
        return matrix / np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-8)


class FixtureNLI:
    model_name = "fixture-entailment"

    async def predict(self, pairs):
        return [
            NLIScores(entailment=0.99, neutral=0.005, contradiction=0.005)
            for _ in pairs
        ]


async def audit(path: Path):
    document = await ingest_document(path)
    resolver = ScholarlyResolver()
    papers = {}
    for ref in document.references:
        papers[ref.anchor_id] = await resolver.resolve(ref)
    pipeline = VerificationPipeline(HybridRetriever(FixtureEncoder()), FixtureNLI())
    verdicts = []
    for row in document.citation_maps:
        paper = papers[row.matched_reference.anchor_id]
        verdict = await pipeline.verify(row, paper)
        if paper.retraction_status == "retracted" and verdict.status == "completed":
            verdict.label = Label.RETRACTED
        verdicts.append((verdict, paper))
    return verdicts


@pytest.mark.parametrize(
    "name,expected",
    [
        ("clean_study", ["SUPPORTED"] * 3),
        ("exaggerated_claims", ["PARTIALLY_SUPPORTED"]),
        ("retracted_and_hallucinated", ["RETRACTED", "UNSUPPORTED"]),
    ],
)
def test_golden_scenarios_are_offline_deterministic_and_fast(
    monkeypatch, name, expected
):
    monkeypatch.setenv("DEMO_MODE", "true")
    data = json.loads(
        (Path(__file__).parents[1] / "data/demo_fixtures.json").read_text()
    )
    monkeypatch.setattr(
        "resolvers.scholarly_resolver.demo_fixture_path",
        lambda: Path(__file__).parents[1] / "data/demo_fixtures.json",
    )
    start = time.perf_counter()
    results = asyncio.run(audit(ROOT / f"{name}.pdf"))
    elapsed = time.perf_counter() - start
    labels = [
        "UNSUPPORTED" if v.status == "insufficient_evidence" else v.label.value
        for v, _ in results
    ]
    assert labels == data["expected"][name]["labels"] == expected
    assert elapsed < 3, f"{name} took {elapsed:.3f}s"
    if name == "exaggerated_claims":
        assert any(
            "30%" in f.explanation and "12%" in f.explanation
            for v, _ in results
            for e in v.evidence
            for f in e.audit.findings
        )
    if name == "retracted_and_hallucinated":
        assert sum(p.retraction_status == "retracted" for _, p in results) == 1
        assert sum(v.status == "insufficient_evidence" for v, _ in results) == 1
