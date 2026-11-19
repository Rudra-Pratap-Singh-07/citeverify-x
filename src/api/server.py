"""Unified local gateway. Start with python -m uvicorn api.server:app."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from config import DEMO_MODE
from resolvers.scholarly_resolver import ScholarlyResolver
from verification.models import NLIScores
from verification.nli_engine import GroqNLI, HuggingFaceNLI
from verification.pipeline import VerificationPipeline
from verification.retriever import HybridRetriever

from .certificate import certificate_pdf
from .jobs import ROOT, JobManager
from .models import AuditReport, TaskState

MAX_UPLOAD = 25 * 1024 * 1024


class OfflineDemoNLI:
    """Deterministic demo scorer; numeric checks still downgrade inflated claims."""

    model_name = "citeverify-offline-demo-fixture"

    async def predict(self, pairs):
        return [
            NLIScores(entailment=0.99, neutral=0.005, contradiction=0.005)
            for _ in pairs
        ]


class OfflineDemoEncoder:
    """Small deterministic token vectors remove model downloads from judging mode."""

    model_name = "citeverify-offline-token-hash"

    def encode(self, texts):
        import hashlib

        import numpy as np

        vectors = np.zeros((len(texts), 256), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in re.findall(r"\w+", text.casefold()):
                digest = hashlib.sha256(token.encode()).digest()
                index = int.from_bytes(digest[:2], "little") % 256
                vectors[row, index] += 1 if digest[2] & 1 else -1
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        return vectors / np.maximum(norms, 1e-8)


def create_app(
    directory: Path | None = None,
    pipeline: Any = None,
    resolver_factory: Any = ScholarlyResolver,
) -> FastAPI:
    storage = directory or Path(
        os.getenv("CITEVERIFY_TASK_DIR", str(ROOT / "data/audits"))
    )
    origins = [
        origin.strip().rstrip("/")
        for origin in os.getenv(
            "CITEVERIFY_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
        ).split(",")
        if origin.strip()
    ]
    if pipeline is None:
        backend = os.getenv("CITEVERIFY_NLI_BACKEND", "local")
        if backend not in ("local", "groq"):
            raise ValueError("CITEVERIFY_NLI_BACKEND must be local or groq")
        nli = (
            OfflineDemoNLI()
            if DEMO_MODE
            else (
                GroqNLI()
                if backend == "groq"
                else HuggingFaceNLI(
                    model_name=os.getenv(
                        "CITEVERIFY_NLI_MODEL",
                        "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli",
                    ),
                    device=os.getenv("CITEVERIFY_DEVICE", "cpu"),
                )
            )
        )
        pipeline = VerificationPipeline(
            nli=nli,
            retriever=HybridRetriever(OfflineDemoEncoder()) if DEMO_MODE else None,
        )
    manager = JobManager(storage, pipeline, resolver_factory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await manager.start()
        yield
        await manager.stop()

    app = FastAPI(title="CiteVerify-X", version="0.4.0", lifespan=lifespan)
    app.state.jobs = manager
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    def task(task_id: str) -> TaskState:
        state = manager.states.get(task_id)
        if state is None:
            raise HTTPException(404, "Audit not found")
        return state

    def capacity() -> None:
        if len(manager.running) >= 8:
            raise HTTPException(
                503,
                "Audit queue is full. Try again shortly.",
                headers={"Retry-After": "10"},
            )

    async def ready_report(task_id: str) -> AuditReport:
        state = task(task_id)
        stage = state.events[-1].stage
        if stage == "Failed":
            raise HTTPException(409, state.events[-1].message)
        if stage != "Complete":
            raise HTTPException(409, "Audit is still running")
        return AuditReport.model_validate_json(
            await asyncio.to_thread(manager.report_path(task_id).read_bytes)
        )

    @app.get("/api/v1/health")
    async def health():
        return {"status": "ok", "demo_mode": DEMO_MODE, "version": app.version}

    @app.post("/api/v1/verify", status_code=202)
    async def verify(file: Annotated[UploadFile, File()]):
        capacity()
        filename = re.sub(
            r"[\x00-\x1f]",
            "",
            (file.filename or "manuscript.pdf").replace("\\", "/").split("/")[-1],
        )[:180]
        if not filename.lower().endswith(".pdf"):
            await file.close()
            raise HTTPException(
                415, "Upload a text-layer PDF. DOCX conversion is not supported yet."
            )
        state = await manager.create(filename, False)
        path = storage / state.task_id / "manuscript.pdf"
        size = 0
        try:
            with path.open("wb") as stream:
                while chunk := await file.read(1024 * 1024):
                    if size == 0 and not chunk.startswith(b"%PDF-"):
                        raise HTTPException(415, "The file does not have a PDF header.")
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "PDF must be 25 MB or smaller.")
                    await asyncio.to_thread(stream.write, chunk)
            if not size:
                raise HTTPException(400, "The uploaded PDF is empty.")
        except BaseException:
            path.unlink(missing_ok=True)
            path.parent.rmdir()
            raise
        finally:
            await file.close()
        await manager.launch(state)
        return {"task_id": state.task_id}

    @app.post("/api/v1/verify/demo", status_code=202)
    async def demo():
        capacity()
        state = await manager.create("CiteVerify-X demonstration.pdf", True)
        await asyncio.to_thread(
            shutil.copyfile,
            ROOT / "examples/demo.pdf",
            storage / state.task_id / "manuscript.pdf",
        )
        await manager.launch(state)
        return {"task_id": state.task_id}

    @app.post("/api/v1/verify/benchmark/{scenario}", status_code=202)
    async def benchmark(scenario: str):
        if scenario not in {
            "clean_study",
            "exaggerated_claims",
            "retracted_and_hallucinated",
        }:
            raise HTTPException(404, "Unknown benchmark scenario")
        capacity()
        state = await manager.create(f"{scenario}.pdf", True)
        state.benchmark = scenario
        await asyncio.to_thread(
            shutil.copyfile,
            ROOT / "tests/benchmarks" / f"{scenario}.pdf",
            storage / state.task_id / "manuscript.pdf",
        )
        # Presets always run offline, even while uploaded documents use live providers.
        await manager.launch(
            state,
            VerificationPipeline(
                nli=OfflineDemoNLI(), retriever=HybridRetriever(OfflineDemoEncoder())
            ),
        )
        return {"task_id": state.task_id}

    @app.get("/api/v1/verify/status/{task_id}")
    async def status(task_id: str):
        return task(task_id)

    @app.get("/api/v1/verify/report/{task_id}")
    async def report(task_id: str):
        state = task(task_id)
        if state.events[-1].stage not in ("Complete", "Failed"):
            return JSONResponse(
                state.events[-1].model_dump(mode="json"), status_code=202
            )
        return await ready_report(task_id)

    @app.get("/api/v1/verify/document/{task_id}")
    async def document(task_id: str):
        task(task_id)
        return FileResponse(
            storage / task_id / "manuscript.pdf", media_type="application/pdf"
        )

    @app.get("/api/v1/verify/certificate/{task_id}")
    async def certificate(task_id: str):
        data = await asyncio.to_thread(certificate_pdf, await ready_report(task_id))
        return Response(
            data,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="CiteVerify-{task_id[:8]}.pdf"'
            },
        )

    @app.get("/api/v1/verify/fingerprint/{task_id}")
    async def fingerprint(task_id: str):
        await ready_report(task_id)
        payload = await asyncio.to_thread(manager.report_path(task_id).read_bytes)
        return {"algorithm": "SHA-256", "sha256": hashlib.sha256(payload).hexdigest()}

    @app.get("/api/v1/verify/stream/{task_id}")
    async def stream_http(task_id: str):
        task(task_id)
        raise HTTPException(
            426, "Connect to this URL with WebSocket (ws:// or wss://)."
        )

    @app.websocket("/api/v1/verify/stream/{task_id}")
    async def stream(
        websocket: WebSocket, task_id: str, after: Annotated[int, Query(ge=0)] = 0
    ):
        if (
            websocket.headers.get("origin")
            and websocket.headers["origin"] not in origins
        ):
            await websocket.close(code=4403)
            return
        if task_id not in manager.states:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        state = task(task_id)
        cursor = min(after, len(state.events))
        try:
            while True:
                for event in state.events[cursor:]:
                    await websocket.send_json(event.model_dump(mode="json"))
                    cursor = event.sequence
                if state.events[-1].stage in ("Complete", "Failed"):
                    await websocket.close()
                    return
                # Poll persisted-in-memory progress independently of the worker.
                try:
                    await asyncio.wait_for(websocket.receive_text(), timeout=0.3)
                except TimeoutError:
                    pass
        except WebSocketDisconnect:
            return

    return app


app = create_app()
