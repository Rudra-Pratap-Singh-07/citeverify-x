# Phase 4: local evidence workbench

Codex owns backend and frontend implementation. Antigravity handoffs are retired.

## Start

From `E:\CITEVERIFY`, install Python extras with `python -m pip install -e ".[api,verification,test]"` in the project environment. The existing environment already has these dependencies.

Terminal 1:

```powershell
.\.venv\Scripts\python -m uvicorn api.server:app --host 127.0.0.1 --port 8000
```

Terminal 2:

```powershell
cd frontend
pnpm install
pnpm build
pnpm start --port 3001
```

Open http://127.0.0.1:3001. Port 3000 is occupied by another application on this machine. For development use `pnpm dev --port 3001`. The legacy Vite files and `scripts/serve_ui.py` are retained but are not used by the Next.js workbench.

## API contract

- `POST /api/v1/verify`: multipart `file`, text-layer PDF, maximum 25 MB; returns HTTP 202 and `task_id`.
- `POST /api/v1/verify/demo`: synthetic local sources with real parsing and configured NLI inference.
- WebSocket `/api/v1/verify/stream/{task_id}?after=0`: ordered progress events with sequence, stage, progress, message. Replays events after the cursor, then closes on Complete/Failed. A plain HTTP GET receives 426.
- `GET /api/v1/verify/status/{task_id}`: task and event history; used for polling fallback and browser refresh.
- `GET /api/v1/verify/report/{task_id}`: complete report; 202 while processing, 409 on failure, 404 for unknown task.
- `GET /api/v1/verify/document/{task_id}`: original manuscript PDF.
- `GET /api/v1/verify/certificate/{task_id}`: downloadable PDF certificate; 409 until complete.
- `GET /api/v1/health`: service health. Interactive API docs at `/docs`.

## Runtime configuration

Set `UNPAYWALL_EMAIL` and optionally `OPENALEX_API_KEY` for scholarly provider access. The default local gateway model is `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` for CPU use. Override with `CITEVERIFY_NLI_MODEL` and `CITEVERIFY_DEVICE`. Set `CITEVERIFY_NLI_BACKEND=groq` plus `GROQ_API_KEY` only when remote inference is intended. Local model weights download on first use; the synthetic demo is offline only after weights are cached.

`CITEVERIFY_TASK_DIR` defaults to `data/audits`. `CITEVERIFY_ORIGINS` is a comma-separated allowlist; localhost and 127.0.0.1 ports 3000/3001 are enabled by default. Frontend API origin can be changed with `NEXT_PUBLIC_API_BASE_URL` in `frontend/.env.local` before building. Environment files are templates; Python does not automatically load `.env`.

## Score and evidence semantics

The veracity display is an evidence-support heuristic: supported=100, partial=50, contradicted/unsupported=0. A claim with multiple assessed citations receives the worst assessed verdict. Unassessed claims are excluded; coverage and audited/total citation links are shown alongside the score. This is not a calibrated factual-accuracy probability or a misconduct determination.

Each claim retains its manuscript coordinates and all citation checks. Missing references, unavailable evidence and inference errors remain distinct. The right pane presents the selected evidence passage, source metadata, DOI, integrity status and numerical findings. Scores are explicitly uncalibrated. Certificates include unresolved gaps and a synthetic-demo label.

## Operational boundaries

This is a local, single-process gateway with one normal audit at a time and a queue limit of eight. Lightweight benchmark presets have a separate single-job slot so slow scholarly lookups cannot block a demo. Run one Uvicorn worker per task directory. Task snapshots and reports are persisted atomically; interrupted tasks become Failed after restart. There is no authentication, tenant isolation or automatic retention policy. Keep the service bound to loopback for this workflow; shared deployment requires those controls and an external worker queue.

Input is PDF only; scanned PDFs need OCR upstream. Source PDF downloading and source-PDF paragraph coordinates are not implemented: verification uses available cached raw text or provider abstracts, and the right pane is an evidence card. Manuscript highlights use media-box coordinates; unusual crop-box PDFs need additional coordinate normalization. Real provider behavior still depends on credentials, network access and metadata availability.

## Validation

Run `.\.venv\Scripts\python -m pytest -q`, `pnpm build` and `pnpm typecheck`. API tests exercise WebSocket event ordering, report restoration, malformed uploads, inference failures, unresolved citation coverage and certificate text. Live synthetic demo runs real local MiniLM/DeBERTa inference. Existing test-only lint findings in earlier phases are separate from Phase 4.
