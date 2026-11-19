# Phase 5: offline judging and golden benchmarks

The same fixtures can run on the hosted backend. See
[cloud deployment](docs/DEPLOYMENT.md). After deploying, run
`python scripts/check_deployment.py https://YOUR-BACKEND-HOST` to check all three
scenarios, reports, PDFs, and frontend CORS over HTTP.

Run the complete local demo with one command from the repository root:

```powershell
python run_demo.py
```

It builds the Next.js app, sets `DEMO_MODE=true`, starts FastAPI and Next.js, waits for both health checks and prints the judging URLs. Press Ctrl+C to stop. Prerequisites are the project Python environment, installed API/verification dependencies, Node.js and pnpm. The offline NLI and token encoder are deterministic and do not download weights or call providers. Fixture answers are in `data/demo_fixtures.json`.

The three generated PDFs in `tests/benchmarks/` cover clean support, a 30% claim against 12% evidence, and the retracted Wakefield DOI alongside a deliberately fictional DOI. The historical Wakefield citation is labeled RETRACTED in this benchmark because the fixture contains the retraction status; verify current provider records in live mode for production review.

Run the smoke and regression suites with `python -m pytest -q`. `tests/test_end_to_end.py` exercises the real parser, fixture-backed resolver, hybrid passage selection and deterministic NLI adapter; each complete paper audit is required to finish under three seconds. The numeric audit remains active, so the exaggerated claim is downgraded and its exact discrepancy is checked. The hallucinated reference has no evidence and is reported UNSUPPORTED. The retracted-source label is an explicit integrity override after content inference.

Demo fixture resolution is the first branch in `ScholarlyResolver.resolve`, before cache or transport work. The API also selects deterministic offline inference and hashing-based embeddings in demo mode. In normal mode scholarly API and configured Groq behavior are unchanged. Set `DEMO_MODE=false` (or unset it) for live service mode. A configured `CITEVERIFY_NLI_BACKEND=groq` is ignored in demo mode.

The three launchpad presets use an independent benchmark slot, so they can finish while a normal audit waits for scholarly providers. The API regression suite verifies a benchmark finishes within three seconds while the normal audit slot is occupied. Refreshing the launchpad restores a pending task from optional browser storage. Missing tasks stop polling with a clear error; interrupted connections offer a reconnect action.
