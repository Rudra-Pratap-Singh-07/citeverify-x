import hashlib
import time
from io import BytesIO
from pathlib import Path

import pdfplumber
from fastapi.testclient import TestClient

from api.server import create_app
from resolvers.scholarly_resolver import ResolvedPaper
from verification.models import Label, VerificationVerdict


class Pipeline:
    async def verify(self, row, paper):
        return VerificationVerdict(
            claim_id=row.claim_id,
            claim_text=row.sentence_text,
            anchor_id=row.matched_reference.anchor_id,
            source_doi=paper.doi,
            source_kind="abstract",
            source_text_sha256=None,
            status="completed",
            label=Label.SUPPORTED,
            confidence=0.9,
            nli_model="test",
            embedding_model="test",
            explanation="Test evidence supports claim.",
        )


def finish(client, task_id):
    events = []
    with client.websocket_connect(f"/api/v1/verify/stream/{task_id}") as ws:
        while True:
            event = ws.receive_json()
            events.append(event)
            if event["stage"] in ("Complete", "Failed"):
                break
    return events


def test_demo_lifecycle_certificate_and_restore(tmp_path):
    with TestClient(create_app(tmp_path, Pipeline())) as client:
        response = client.post("/api/v1/verify/demo")
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        events = finish(client, task_id)
        assert events[-1]["stage"] == "Complete"
        assert {"Parsing", "Resolving Citations", "NLI Checking"} <= {
            e["stage"] for e in events
        }
        assert [e["sequence"] for e in events] == list(range(1, len(events) + 1))
        report = client.get(f"/api/v1/verify/report/{task_id}").json()
        assert report["summary"]["total_claims"] == 3
        assert report["summary"]["citations_audited"] == 3
        assert report["summary"]["total_citations"] == 4
        assert report["summary"]["coverage_percent"] == 66.7
        assert report["claims"][-1]["label"] is None
        assert report["claims"][0]["highlights"]
        pdf = client.get(f"/api/v1/verify/certificate/{task_id}")
        assert pdf.headers["content-type"] == "application/pdf"
        with pdfplumber.open(BytesIO(pdf.content)) as document:
            text = " ".join(p.extract_text() or "" for p in document.pages)
        assert "Executive Verification Certificate" in text
        assert "SYNTHETIC DEMO" in text and "missing reference" in text
        assert client.get(f"/api/v1/verify/document/{task_id}").content.startswith(
            b"%PDF"
        )
        assert client.get(f"/api/v1/verify/stream/{task_id}").status_code == 426
    with TestClient(create_app(tmp_path, Pipeline())) as client:
        assert client.get(f"/api/v1/verify/report/{task_id}").json() == report


def test_upload_validation_and_failed_pdf(tmp_path):
    with TestClient(create_app(tmp_path, Pipeline())) as client:
        assert client.get("/api/v1/verify/report/unknown").status_code == 404
        for name, content, code in [
            ("a.docx", b"word", 415),
            ("a.pdf", b"hello", 415),
            ("a.pdf", b"", 400),
        ]:
            assert (
                client.post(
                    "/api/v1/verify", files={"file": (name, content)}
                ).status_code
                == code
            )
        assert not list(tmp_path.iterdir())
        task_id = client.post(
            "/api/v1/verify", files={"file": ("bad.pdf", b"%PDF-broken")}
        ).json()["task_id"]
        assert finish(client, task_id)[-1]["stage"] == "Failed"
        assert client.get(f"/api/v1/verify/report/{task_id}").status_code == 409
        assert client.get(f"/api/v1/verify/certificate/{task_id}").status_code == 409


def test_inference_error_stays_unassessed(tmp_path):
    class BrokenPipeline:
        async def verify(self, row, paper):
            raise RuntimeError("model unavailable")

    with TestClient(create_app(tmp_path, BrokenPipeline())) as client:
        task_id = client.post("/api/v1/verify/demo").json()["task_id"]
        assert finish(client, task_id)[-1]["stage"] == "Complete"
        report = client.get(f"/api/v1/verify/report/{task_id}").json()
        assert report["summary"]["veracity_score"] is None
        assert report["summary"]["citations_audited"] == 0
        assert report["claims"][0]["checks"][0]["state"] == "error"


def test_uploaded_pdf_resolves_each_reference(tmp_path):
    resolved = []

    class Resolver:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def resolve(self, reference):
            resolved.append(reference.anchor_id)
            return ResolvedPaper(
                status="resolved",
                title=reference.parsed_title,
                abstract="Accuracy increased by 12%.",
            )

    document = Path(__file__).resolve().parents[1] / "examples/demo.pdf"
    with TestClient(create_app(tmp_path, Pipeline(), Resolver)) as client:
        response = client.post(
            "/api/v1/verify", files={"file": ("manuscript.pdf", document.read_bytes())}
        )
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        assert finish(client, task_id)[-1]["stage"] == "Complete"
        report = client.get(f"/api/v1/verify/report/{task_id}").json()
        assert not report["demo"] and report["filename"] == "manuscript.pdf"
        assert set(resolved) == {"1", "2"}
        assert report["summary"]["citations_audited"] == 3


def test_benchmark_routes_and_fingerprint(tmp_path, monkeypatch):
    async def no_http(*args, **kwargs):
        raise AssertionError("Benchmark must not access external HTTP")

    monkeypatch.setattr("httpx.AsyncClient.send", no_http)
    with TestClient(create_app(tmp_path, Pipeline())) as client:
        assert client.post("/api/v1/verify/benchmark/unknown").status_code == 404
        for scenario, labels in [
            ("clean_study", ["SUPPORTED"] * 3),
            ("exaggerated_claims", ["PARTIALLY_SUPPORTED"]),
            ("retracted_and_hallucinated", ["RETRACTED", None]),
        ]:
            task_id = client.post(f"/api/v1/verify/benchmark/{scenario}").json()[
                "task_id"
            ]
            assert finish(client, task_id)[-1]["stage"] == "Complete"
            report = client.get(f"/api/v1/verify/report/{task_id}").json()
            assert report["demo"] is True
            assert [c["label"] for c in report["claims"]] == labels
            expected = hashlib.sha256(
                (tmp_path / task_id / "report.json").read_bytes()
            ).hexdigest()
            assert (
                client.get(f"/api/v1/verify/fingerprint/{task_id}").json()["sha256"]
                == expected
            )


def test_benchmark_does_not_wait_for_normal_audit_queue(tmp_path):
    app = create_app(tmp_path, Pipeline())
    with TestClient(app) as client:
        manager = app.state.jobs
        client.portal.call(manager.slots.acquire)
        try:
            start = time.perf_counter()
            task_id = client.post("/api/v1/verify/benchmark/clean_study").json()[
                "task_id"
            ]
            deadline = start + 3
            while time.perf_counter() < deadline:
                response = client.get(f"/api/v1/verify/report/{task_id}")
                if response.status_code == 200:
                    break
                time.sleep(0.01)
            assert response.status_code == 200, (
                "Benchmark was blocked by a normal audit"
            )
            assert response.json()["summary"]["veracity_score"] == 100
            assert time.perf_counter() - start < 3
        finally:
            client.portal.call(manager.slots.release)
