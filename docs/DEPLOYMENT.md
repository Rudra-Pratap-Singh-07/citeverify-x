# Hosted backend + existing Vercel frontend

The frontend is https://citeverify-x.vercel.app. The Phase 4 FastAPI service and
Phase 5 fixtures are in this repository. GitHub stores the code; a running web
service hosts Python, background audits, SQLite, and WebSocket progress.

## 1. Deploy the backend

[Deploy this repository on Render](https://render.com/deploy?repo=https://github.com/Rudra-Pratap-Singh-07/citeverify-x)

Connect the GitHub repository, select `main`, and use the root `render.yaml`.
The Blueprint creates **one backend service**; keep the frontend on Vercel.
It starts with **DEMO_MODE=true** and the Free instance type. This is a hosted
demonstration with synthetic fixtures, not live scholarly verification.
No scholarly keys or downloaded inference models are needed for this mode.

The service settings are:

| Setting | Value |
| --- | --- |
| Root directory | Repository root (leave blank) |
| Build | `python scripts/cloud_build.py` |
| Start | `python -m uvicorn api.server:app --app-dir src --host 0.0.0.0 --port $PORT --workers 1` |
| Health check | `/api/v1/health` |
| Frontend allowlist | `CITEVERIFY_ORIGINS=https://citeverify-x.vercel.app` |

Copy the **actual public HTTPS URL assigned by Render**. Do not assume that the
service name will be the exact public hostname. Open `/api/v1/health` on that URL:
it should return `status: "ok"` and `demo_mode: true`.

## 2. Connect Vercel

In the existing Vercel project's Settings -> Environment Variables, set:

```text
NEXT_PUBLIC_API_BASE_URL=https://YOUR-ASSIGNED-BACKEND.onrender.com
```

Select the **Production** environment. Use the backend origin only, without
`/api/v1`. Then **redeploy the frontend**: Next.js embeds `NEXT_PUBLIC_*` values
at build time. An existing deployment does not pick up changed values.

The existing frontend already converts HTTPS to WSS for progress and falls back
to status polling if the socket drops. CORS and WebSocket origin checks both use
the backend's `CITEVERIFY_ORIGINS` setting. Add custom domains or specific Vercel
preview origins as comma-separated origins when needed; production is already
configured. A localhost API URL in a deployed browser points at the visitor's PC.

## 3. Check the complete online demo

From an environment with the project's API dependencies installed:

```sh
python scripts/check_deployment.py https://YOUR-ASSIGNED-BACKEND.onrender.com
```

This creates three synthetic audits and verifies CORS, expected claim labels,
reports, manuscript PDFs, and certificate downloads. It intentionally allows
network/cold-start latency; the separate offline test suite enforces the
under-three-second benchmark requirement. A missing source remains unassessed
in the API (`label: null`, `state: insufficient_evidence`), while its internal
verification result is UNSUPPORTED.

Open the Vercel site and run each preset. Click a claim, inspect its linked
evidence, refresh the audit, and download the certificate. These actions now
depend on the hosted API, not a locally running Python process.

## 4. Enable live uploaded-paper verification

For genuine provider lookups and learned inference, choose a host instance with
enough memory for the embedding/NLI models and configure:

```text
DEMO_MODE=false
UNPAYWALL_EMAIL=your-contact-email
OPENALEX_API_KEY=your-provider-key
CITEVERIFY_NLI_BACKEND=groq
GROQ_API_KEY=your-groq-key
```

Enter credentials only in the backend host's secret environment settings.
Alternatively use `CITEVERIFY_NLI_BACKEND=local` for local DeBERTa inference;
Groq avoids the local NLI model but still uses a local embedding model.
**Rebuild** the backend after changing DEMO_MODE: `cloud_build.py` installs
CPU PyTorch and verification extras only for live mode. Model weights download
on first use. Confirm `demo_mode: false` in health, then check a real paper.
The three benchmark presets remain deterministic in either mode.

Update the Blueprint's DEMO_MODE value too if continuing to sync it, so a later
sync does not restore demo mode. The default Free demo is not a capacity promise
for live model inference. Provider access and unavailable abstracts can limit
verification coverage even with valid credentials.

## Storage and operating limits

Run exactly **one Uvicorn worker and one backend instance**: progress and queues
are process-local. The cloud entrypoint enforces one worker. Scale-out needs an
external queue and shared job store.

Free Render services sleep while idle and discard local files on restart,
redeploy, or spin-down. Old audits can therefore disappear. For retained reports,
attach a persistent disk to a supported paid service, and configure:

```text
CITEVERIFY_TASK_DIR=/var/data/audits
CITEVERIFY_CACHE_PATH=/var/data/paper_cache.db
HF_HOME=/var/data/models
```

This repository is an unauthenticated research demo, with no per-user access
control or retention service. Use synthetic/public documents on that deployment;
private manuscript hosting requires authentication and isolation first.

References: [Render FastAPI hosting](https://render.com/docs/deploy-fastapi),
[Render free-instance limits](https://render.com/docs/free),
[Render WebSockets](https://render.com/docs/websocket), and
[Next.js build-time environment variables](https://nextjs.org/docs/14/app/building-your-application/configuring/environment-variables).
