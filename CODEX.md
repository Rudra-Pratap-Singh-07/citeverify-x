# Codex · Project Owner

## Hosted Phase 4/5 deployment

`render.yaml` runs one FastAPI worker for the existing Vercel frontend at
`https://citeverify-x.vercel.app`. See `docs/DEPLOYMENT.md`. The Blueprint defaults
to synthetic demo mode; live inference needs a rebuild and provider configuration.
Health now includes `demo_mode` and `version`. Demo-mode uploads are labeled
synthetic in reports and certificates. `CITEVERIFY_CACHE_PATH` supports a mounted
cache location. Validate with `python -m pytest -q` and
`python scripts/check_deployment.py https://BACKEND-HOST`.

Codex owns the entire CiteVerify-X project, including ingestion, NLP, scholarly resolution, verification, backend integration, frontend architecture, design, tests and demo preparation. The user's ownership change supersedes earlier Antigravity assignments. ANTIGRAVITY.md records historical implementation context.

## Phase 1 handoff

The public entry point is `await parser.document_ingest.ingest_document(path)`. It runs PDF decoding and spaCy sentence segmentation in a worker thread and returns a validated `IngestionResult`. A caller processing a batch should bound concurrent calls according to available memory. Each call uses its own PDF handle and NLP pipeline.

The shared Windows checkout already has a working Python 3.11 environment. Run these checks from the repository root in PowerShell:

```powershell
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python scripts/test_ingest.py --demo --demo-pdf demo.pdf --output demo-result.json
.\.venv\Scripts\python scripts/test_ingest.py --schema --output ingestion.schema.json
.\.venv\Scripts\python scripts/test_ingest.py "C:\papers\draft.pdf" --output draft-result.json
```

On a new checkout, create the environment with `py -3.11 -m venv .venv` and install with `.\.venv\Scripts\python -m pip install -e ".[test]"`. The demo creates a synthetic PDF locally and verifies its expected links before exporting. Each command returns a nonzero status on failure. An unresolved citation is a successful extraction outcome.

## Contract and ownership

- Keep the Pydantic models in `src/parser/document_ingest.py` authoritative. Regenerate the schema from the CLI when a consumer needs a copy. Preserve deterministic IDs for repeat ingestion of the same document with the same parser version.
- Emit one matched edge per claim and bibliography entry. Keep missing, invalid and ambiguous targets in `unresolved`. Keep original marker spelling on each edge. `anchor_id` is local to the bibliography. Prefixed IDs identify unnumbered entries. Metadata extraction is best effort and the original reference text is available for the resolver.
- Coordinates are one-based by page and top-left PDF points by position. The first-page envelope supports navigation. Per-line highlights support rendering across wraps and pages. Word boxes live in the page payload.
- Validate changes with PDFs covering shared markers, ambiguity, repeated text, multiline references and page geometry. Update these two context files together when an interface changes. Record the changed field, consumer impact, test command and current handoff here.
- Phase 2 begins with the raw bibliography and parsed metadata. DOI resolution, retraction lookup, evidence retrieval and entailment verdicts belong to later phases. Phase 1 accepts English text-layer PDFs. OCR, arbitrary table/column reading order, exhaustive citation grammars and DOCX are outside its current parser coverage. The empirical filter is a deterministic candidate selector and can miss implicit findings.

## Published PDF checks

The parser uses font-relative spacing for positioned words, hanging indents for unnumbered references, and the bibliography's label style for numbered entries. It links narrative markers such as `Ray et al. (2020a)` and preserves their printed form in `citation_markers`. Page numbers remain available in the page payload. The prose parser can follow a sentence across a page number or isolate a small-print footnote.

| Publisher PDF | Bibliography entries | Candidate sentences | Matched links | Independent check |
|---|---:|---:|---:|---|
| [BERT, ACL Anthology](https://aclanthology.org/N19-1423.pdf) | 56 | 5 | 8 | The PDF defines 56 bibliography destinations. Each emitted link highlights a citation pointing to its matched entry. |
| [Attention Is All You Need, NeurIPS proceedings](https://proceedings.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf) | 32 | 6 | 8 | The printed bibliography runs from [1] to [32]. Each emitted link agrees with the number in the PDF's clickable marker at the highlighted location. |

To reproduce the counts, run the PDF-path CLI command above on each publisher file. Count unique `claim_id` values for sentences and rows in `citation_maps` for links. Both files yielded zero unresolved rows. The checks establish where the emitted citations link. Claim-extraction recall still requires independently annotated claims. Flattened text can retain typeset line-break hyphens and spaces inside mathematical notation.

**Current handoff** — All 16 regression tests passed on Python 3.11.9. The CLI still reproduces `examples/demo-result.json` byte for byte. Antigravity can continue against schema 1.0 with the existing fixture pair.

## Phase 2 backend handoff

Use the async context manager ScholarlyResolver from resolvers.scholarly_resolver and await resolver.resolve(reference). Install updated dependencies with .\.venv\Scripts\python -m pip install -e ".[test]".

Configure UNPAYWALL_EMAIL with your contact email and optionally OPENALEX_API_KEY. Run .\.venv\Scripts\python scripts/resolve_references.py examples/demo-result.json --output resolved.json. Synthetic demo DOIs may return missing.

The first integrity check downloads the official Crossref Retraction Watch CSV (approximately 68 MB). Validated feed snapshots replace the old snapshot atomically. Feed and successful JSON responses expire after 24 hours. SQLite data/paper_cache.db stores provider responses, paper metadata, integrity records and abstracts. raw_text remains null until later full-text extraction.

DOI-less matching requires a parsed title, title similarity at least 0.85 and a 0.05 margin over the runner-up. This heuristic requires evaluation on representative references. The resolver locates OA PDF/XML URLs, and uses OpenAlex or Semantic Scholar abstracts.

Validation includes 20 passing tests with HTTP mocks for cache reuse, malformed DOI and abstracts, ambiguity, retries, retraction reasons, closed access and unavailable integrity data. The official CSV header was checked live. Authenticated integration remains to be exercised with the user's email/key.

## Phase 3 verification

Codex owns implementation and design for all phases. Install local model dependencies with .\.venv\Scripts\python -m pip install -e ".[test,verification]". Models download on first use and are reused by each pipeline instance.

Run .\.venv\Scripts\python scripts/verify_claims.py ingestion.json resolved.json --output verdicts.json. Use --model MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli for a smaller local checkpoint. Use --backend groq with GROQ_API_KEY to explicitly send claim/evidence pairs to the remote inference backend.

The local default is MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli. Its config names the three NLI labels. The shorter model identifier in the original brief returned HTTP 401 during setup. The Groq adapter defaults to llama-3.3-70b-versatile, configurable with --model.

Instantiate one VerificationPipeline per FastAPI worker during startup. Call await pipeline.verify(citation_map, resolved_paper) or await pipeline.verify_many(pairs). It selects raw_text first, then abstract. The source must have Phase 2 status resolved. Each verdict covers one claim/reference edge. Unresolved Phase 1 anchors remain in the ingestion response for review.

Retrieval uses 150-word windows with 50-word overlap, BM25 (k1 1.5, b 0.75) and MiniLM cosine similarity, combined with reciprocal-rank fusion (k 60). It returns up to three passages with exact source-text character offsets, a source text hash and word offsets. These offsets refer to plain text. An eight-paper index cache reuses embeddings across claims. Inputs exceeding the embedding token budget are split and pooled. NLI runs off the event loop, batches pairs, reads label order from model config and rejects overlength inputs explicitly.

Entailment at least 0.8 maps to SUPPORTED, contradiction at least 0.8 to CONTRADICTED, and moderate entailment at least 0.5 to PARTIALLY_SUPPORTED. Other scores map to UNSUPPORTED. Conflicting supportive and contradictory passages produce PARTIALLY_SUPPORTED with a conflict explanation. Missing source text returns status insufficient_evidence, UNSUPPORTED and confidence zero. Backend failures raise InferenceError.

Numerical checks align local metric names and units. A difference greater than 5% relative to the evidence value downgrades SUPPORTED to PARTIALLY_SUPPORTED. Unit conversions cover ms/minutes/hours to seconds and mg/kg to grams. P-value inequalities compare compatible intervals. Zero denominators produce no infinite JSON values. Ambiguous/unmatched values remain diagnostics. Scope rules cover human/animal and all/subset populations. These rules do not fully resolve populations, timepoints, causal claims or every scientific notation.

Confidence retains the selected passage's uncalibrated model score, including when a deterministic audit downgrades support. Groq scores are model-reported; local scores come from softmax logits. Calibration requires a held-out labeled dataset. Retraction/concern flags appear as source-integrity warnings. Full-text fetching and source-PDF coordinates remain later integration work.

Pydantic verification models live in src/verification/models.py. Retrieval, inference, audit and aggregation have separate modules. Validation includes 43 passing tests covering PyTorch batching with a test model, mocked Groq responses, numerical boundaries, conflicts, and CLI entry. Real MiniLM weights were exercised locally.

Live Phase 3 check completed with actual MiniLM and DeBERTa base weights. A matching 12% statement yielded entailment 0.9925, while a 30% statement against 12% evidence yielded contradiction 0.9993. The public CLI then processed all three demo edges with real cached models in offline mode. Groq validation uses mocked API responses because GROQ_API_KEY is not configured. The default large checkpoint configuration was verified, but its weights were not loaded in this environment.

The live CLI check revealed that citation anchors were altering NLI judgments. The pipeline now uses the parser's citation_free_text helper before retrieval and inference, retaining original claim text and coordinates in the verdict. Statistical parentheses such as (n = 100) are preserved. After the fix, all three matching demo edges were SUPPORTED (0.9965, 0.9965, 0.9949). All 43 regression tests pass.

## Phase 4: integrated gateway and workbench

Implemented FastAPI in src/api/server.py, persistent local jobs, WebSocket progress replay, report/document endpoints and a reportlab executive certificate. The Next.js 14 application now lives in frontend/app with typed components, Tailwind, a local PDF.js worker, manuscript highlights and linked source cards. Legacy Vite files are retained but inactive.

See PHASE4.md for full run commands, environment configuration, API semantics and operational limits. Use port 3001 for the UI on this machine; port 3000 belongs to another application. API runs on loopback port 8000. Source evidence currently uses abstracts or cached raw text; source PDF fetching and coordinate mapping remain future work. Run a single gateway process per audit storage directory.

Validation: 47 Python tests passed, production Next.js build succeeded, Phase 4 Python lint and mypy checks passed. Browser QA exercised the real local-model demo, direct PDF highlight selection, claim list navigation, unresolved evidence and certificate download. The two-page generated certificate was rendered and visually checked. Demo score 100% covers only two of three claims, with 3/4 citation links checked and coverage displayed as 66.7%.


## Obsidian workbench redesign

Entry now lives in frontend/app/page.tsx, with PDF dropzone and three offline benchmark presets. Reports open at /audit/[id] using components/DualPaneWorkbench.tsx. The UI uses locally served Geist Sans/Mono, Framer Motion, Lucide and Radix Dialog. The requested theme tokens live in frontend/tailwind.config.js.

Benchmark POST /api/v1/verify/benchmark/{scenario} accepts the three known scenario names and always uses isolated fixture metadata and deterministic inference, even when the normal upload gateway runs live. Saved reports carry demo=true. GET /api/v1/verify/fingerprint/{task_id} returns the SHA-256 of persisted report bytes; exported certificates include the same digest.

The launchpad uses actual progress events and navigates on completion. Audit filters, reading/PDF modes, linked claim selection, J/K and previous/next navigation are implemented. Confidence is uncalibrated; no invented live retraction counter is shown. See scrollcraft/builds/citeverify/BRIEF.md and REVIEW.md for design decisions, screenshot evidence and verification limits. Full Python suite: 51 passing tests; production Next.js build passed. Local URL remains http://127.0.0.1:3001/.

## Recovery and source-selection follow-up

Pending jobs now persist immediately after acceptance and recover after a launchpad refresh; launch controls wait for session restoration. Safe browser storage helpers prevent blocked/malformed storage from breaking the UI. useAudit stops on missing tasks, aborts stale requests, and supports reconnecting after transient failures. Failed parsing displays a stopped timeline.

Initial source selection follows the aggregate verdict and selected evidence passage, including a flagged second citation. J/K entry from an unflagged claim is corrected. Lightweight benchmark tasks have their own slot, allowing demos during slow scholarly resolution. Validation: six API checks and five new frontend checks passed; production build passed. Run frontend regression checks with pnpm test (installed Node 24 runtime). Browser checks covered refresh recovery, malformed PDF upload, missing audit and final source display. The user's real manuscript audit was preserved through completion.


## Grayscale and supplied-font refinement
User's new palette supersedes the former emerald/obsidian brand: #000000, #1C1C1C, #3D3D3D, #7D7D7D, #B0B0B0. Active identity is frontend/app/brand.css, loaded after globals.css; Tailwind tokens agree. Local BBH Bogle headings and Fredoka body/UI are declared in layout.tsx, with binaries and licenses in app/fonts. Geist Mono remains only for precise data. Global UI colors were normalized; semantic class names are retained for API compatibility and rendered with labels, icons and varied outlines. No inference or API contract changed.

Validation: production build/TypeScript and five frontend tests passed; desktop, 390px phone, 360px compact and reduced-motion override visually checked. Numerical benchmark and certificate download exercised. Review and screenshots are in scrollcraft/builds/citeverify. Frontend runs at http://127.0.0.1:3001; API remained uninterrupted on port 8000.
