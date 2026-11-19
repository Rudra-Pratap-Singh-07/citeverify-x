from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest

from parser.document_ingest import IngestionResult, citation_free_text
from resolvers.scholarly_resolver import ResolvedPaper
from verification.models import Label, NLIScores, VerificationVerdict
from verification.nli_engine import (
    GroqNLI,
    HuggingFaceNLI,
    InferenceError,
    classify,
    scores_from_logits,
)
from verification.numerical_audit import audit_numbers, extract_numbers
from verification.pipeline import VerificationPipeline
from verification.retriever import HybridRetriever, chunk_text


class TestEncoder:
    __test__ = False
    model_name = "test-vectors"

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def encode(self, texts: Any) -> Any:
        self.calls.append(list(texts))
        return np.asarray(
            [
                [1 + text.lower().count("accuracy"), 1 + text.lower().count("latency")]
                for text in texts
            ],
            dtype=np.float32,
        )


class TestNLI:
    __test__ = False
    model_name = "test-scores"

    def __init__(self, scores: list[NLIScores]) -> None:
        self.scores = scores
        self.pairs: list[tuple[str, str]] = []

    async def predict(self, pairs: Any) -> list[NLIScores]:
        self.pairs = list(pairs)
        return self.scores


def test_windows_offsets_overlap_and_tail() -> None:
    text = " \n".join(f"word{i}" for i in range(321))
    windows = chunk_text(text)
    assert [(p.start_word, p.end_word) for p in windows] == [(0, 150), (100, 250), (200, 321)]
    assert all(text[p.start_char : p.end_char] == p.text for p in windows)
    assert chunk_text(" \t\n") == []
    assert len(chunk_text("x " * 150)) == 1
    with pytest.raises(ValueError):
        chunk_text(text, overlap=150)


def test_hybrid_rank_and_cache() -> None:
    encoder = TestEncoder()
    retriever = HybridRetriever(encoder)
    text = ("latency " * 200) + ("accuracy " * 180)
    result = retriever.retrieve("accuracy", text)
    assert len(result) == 3 and "accuracy" in result[0].text
    assert result[0].bm25_score > 0
    assert -1.00001 <= result[0].cosine_score <= 1.00001
    retriever.retrieve("latency", text)
    assert len(encoder.calls) == 3  # one document batch, two queries


@pytest.mark.parametrize(
    ("claim", "evidence", "mismatch"),
    [
        ("Accuracy was 30%.", "Accuracy was 12%.", True),
        ("Accuracy was 21%.", "Accuracy was 20%.", False),
        ("Accuracy was 21.01%.", "Accuracy was 20%.", True),
        ("Latency was 1000 ms.", "Latency was 1 second.", False),
        ("Risk was 2%.", "Risk was 0%.", True),
        ("p = 0.06", "p < 0.05", True),
        ("p < 0.05", "p = 0.01", False),
        ("Accuracy was 30%.", "Dropout was 12%.", False),
        ("Accuracy was 30%.", "Accuracy was 12% initially and accuracy was 30% later.", False),
        ("n = 120", "The trial included 100 participants.", True),
        ("Concentration was 1e-3 mg.", "Concentration was 0.001 mg.", False),
    ],
)
def test_metrics(claim: str, evidence: str, mismatch: bool) -> None:
    assert audit_numbers(claim, evidence).requires_downgrade is mismatch


def test_audit_provenance_and_scope() -> None:
    audit = audit_numbers("Accuracy was 30% [1].", "Accuracy was 12%.")
    entity = audit.claim_entities[0]
    assert "Accuracy was 30% [1]."[entity.start : entity.end].strip() == entity.text
    assert audit.findings[0].relative_difference == pytest.approx(1.5)
    assert len(audit.claim_entities) == 1
    assert audit_numbers("Patients improved.", "Mice improved.").requires_downgrade
    assert audit_numbers("All patients improved.", "Some patients improved.").requires_downgrade
    assert audit_numbers("Accuracy was 30%.", "Recall was 12%.").findings[0].kind == "unmatched"
    assert [e.value for e in extract_numbers("Sample size was 1,200.")] == [1200]


def test_logit_order_and_policy() -> None:
    scores = scores_from_logits([9, -1, -1], {0: "contradiction", 1: "neutral", 2: "entailment"})
    assert classify(scores)[0] == Label.CONTRADICTED
    assert (
        classify(NLIScores(entailment=0.6, neutral=0.3, contradiction=0.1))[0]
        == Label.PARTIALLY_SUPPORTED
    )
    assert (
        classify(NLIScores(entailment=0.1, neutral=0.8, contradiction=0.1))[0] == Label.UNSUPPORTED
    )
    with pytest.raises(InferenceError):
        scores_from_logits([1, 2, 3], {0: "LABEL_0", 1: "LABEL_1", 2: "LABEL_2"})
    with pytest.raises(InferenceError):
        scores_from_logits(
            [float("nan"), 1, 2], {0: "entailment", 1: "neutral", 2: "contradiction"}
        )


def test_citation_anchors_do_not_enter_semantic_hypothesis() -> None:
    assert citation_free_text("Accuracy was 30% [1, 2].") == "Accuracy was 30%."
    assert citation_free_text("Latency decreased (Chen et al., 2021).") == "Latency decreased."
    assert citation_free_text("Accuracy was 30% (n = 100).") == "Accuracy was 30% (n = 100)."
    nli = TestNLI([NLIScores(entailment=0.95, neutral=0.04, contradiction=0.01)])
    pipeline = VerificationPipeline(HybridRetriever(TestEncoder()), nli)
    original = claim().model_copy(update={"sentence_text": "Accuracy was 30% [1, 2]."})
    verdict = asyncio.run(
        pipeline.verify(original, ResolvedPaper(status="resolved", abstract="Accuracy was 30%."))
    )
    assert nli.pairs == [("Accuracy was 30%.", "Accuracy was 30%.")]
    assert verdict.claim_text == original.sentence_text


def claim():
    data = IngestionResult.model_validate_json(Path("examples/demo-result.json").read_bytes())
    return data.citation_maps[0].model_copy(update={"sentence_text": "Accuracy was 30%."})


def test_pipeline_downgrade_missing_source_and_failure() -> None:
    nli = TestNLI([NLIScores(entailment=0.95, contradiction=0.02, neutral=0.03)])
    pipeline = VerificationPipeline(HybridRetriever(TestEncoder()), nli)
    paper = ResolvedPaper(status="resolved", doi="10.1234/example", abstract="Accuracy was 12%.")
    verdict = asyncio.run(pipeline.verify(claim(), paper))
    assert verdict.label == Label.PARTIALLY_SUPPORTED
    assert verdict.evidence[0].nli_label == Label.SUPPORTED
    assert "30%" in verdict.explanation and "12%" in verdict.explanation
    assert nli.pairs == [("Accuracy was 12%.", "Accuracy was 30%.")]
    assert verdict.source_kind == "abstract"
    assert VerificationVerdict.model_validate_json(verdict.model_dump_json()) == verdict
    missing = asyncio.run(pipeline.verify(claim(), paper.model_copy(update={"abstract": None})))
    assert missing.status == "insufficient_evidence" and missing.confidence == 0
    nli.scores = []
    with pytest.raises(InferenceError):
        asyncio.run(pipeline.verify(claim(), paper))


def test_conflicting_passages_surface_conflict() -> None:
    nli = TestNLI(
        [
            NLIScores(entailment=0.95, contradiction=0.02, neutral=0.03),
            NLIScores(entailment=0.02, contradiction=0.95, neutral=0.03),
            NLIScores(entailment=0.1, contradiction=0.1, neutral=0.8),
        ]
    )
    pipeline = VerificationPipeline(HybridRetriever(TestEncoder()), nli)
    paper = ResolvedPaper(status="resolved", raw_text="Accuracy was 30%. " + "word " * 320)
    verdict = asyncio.run(pipeline.verify(claim(), paper))
    assert verdict.label == Label.PARTIALLY_SUPPORTED
    assert "conflicting" in verdict.explanation
    assert len(verdict.evidence) == 3


def test_groq_adapter_validates_response() -> None:
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"entailment": 0.9, "neutral": 0.08, "contradiction": 0.02}'
                        }
                    }
                ]
            },
        )

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            nli = GroqNLI("test-key", client=client)
            assert (await nli.predict([("Quoted evidence", "Claim")]))[0].entailment == 0.9
            assert requests[0]["messages"][1]["content"] == json.dumps(
                {"premise": "Quoted evidence", "hypothesis": "Claim"}
            )

    asyncio.run(run())


def test_hf_backend_batches_and_never_truncates() -> None:
    torch = pytest.importorskip("torch")

    class Tokens(dict):
        def to(self, device):
            return self

    class Tokenizer:
        def __call__(self, premises, hypotheses, **kwargs):
            assert kwargs["truncation"] is False
            return Tokens(input_ids=torch.zeros((len(premises), 10), dtype=torch.long))

    class Model:
        config = type(
            "Config", (), {"id2label": {0: "neutral", 1: "contradiction", 2: "entailment"}}
        )()

        def __call__(self, input_ids):
            return type(
                "Output", (), {"logits": torch.tensor([[0.0, 0.0, 4.0]] * len(input_ids))}
            )()

    engine = HuggingFaceNLI(batch_size=2)
    engine._model, engine._tokenizer = Model(), Tokenizer()
    assert len(asyncio.run(engine.predict([("evidence", "claim")] * 5))) == 5
    engine.max_length = 5
    with pytest.raises(InferenceError, match="token limit"):
        asyncio.run(engine.predict([("evidence", "claim")]))


def test_missing_sources_cli_produces_reviewable_verdicts(tmp_path: Path) -> None:
    import subprocess
    import sys

    sources, output = tmp_path / "sources.json", tmp_path / "verdicts.json"
    sources.write_text("[]", encoding="utf-8")
    process = subprocess.run(
        [
            sys.executable,
            "scripts/verify_claims.py",
            "examples/demo-result.json",
            str(sources),
            "--output",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 0, process.stderr
    results = [VerificationVerdict.model_validate(item) for item in json.loads(output.read_text())]
    assert len(results) == 3
    assert all(r.status == "insufficient_evidence" and r.confidence == 0 for r in results)


def test_groq_malformed_scores_fail_explicitly() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": '{"entailment": 1, "neutral": 1, "contradiction": 1}'}}
                ]
            },
        )

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(InferenceError, match="invalid response"):
                await GroqNLI("test-key", client=client).predict([("Evidence", "Claim")])

    asyncio.run(run())


def test_embedding_pool_includes_tail_tokens() -> None:
    from verification.retriever import SentenceTransformerEncoder

    class Tokenizer:
        def num_special_tokens_to_add(self, pair):
            return 2

        def __call__(self, text, **kwargs):
            import re

            return {"offset_mapping": [m.span() for m in re.finditer(r"\S+", text)]}

    class Model:
        tokenizer = Tokenizer()
        max_seq_length = 5
        seen = []

        def encode(self, pieces, **kwargs):
            self.seen.extend(pieces)
            return np.asarray([[1.0, 1.0] for _ in pieces])

    encoder = SentenceTransformerEncoder()
    encoder._model = Model()
    vectors = encoder.encode(["one two three four tail"])
    assert encoder._model.seen == ["one two three", "four tail"]
    assert np.linalg.norm(vectors[0]) == pytest.approx(1)
