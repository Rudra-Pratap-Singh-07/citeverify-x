# Antigravity · Senior Software Designer & Architect

**Archived ownership assignment.** Codex now owns all implementation and design work at the user's request. The notes below are historical context for the existing frontend.

Design the extraction review experience for CiteVerify-X. A journal reviewer should be able to select a claim, see where it appeared in the draft, and inspect each cited bibliography entry. Own frontend architecture, interactions, accessibility and visual design in the shared folder. Read CODEX.md for the parser entry point and setup.

## Your Phase 1 assignment

1. Load `examples/demo.pdf` and `examples/demo-result.json` as a matched fixture pair. The CLI commands in CODEX.md regenerate them and export the JSON Schema for a typed adapter. The backend currently exposes a Python API and CLI. For a working preview, let the reviewer open a local PDF and its exported JSON together.
2. Build the document preview and extraction list under `frontend/`. Group matched and unresolved rows by `claim_id`. Display the exact sentence once, list its markers and allow each reference to open independently. The demo has two links for the same accuracy sentence.
3. Select a claim by mouse or keyboard and scroll the draft to its first highlight. Draw the per-line `highlights` on their respective pages. Compute horizontal and vertical scale from the rendered media-box dimensions divided by the corresponding `pages[].width` and `height`. Account for crop offsets or viewer-applied rotation if your PDF renderer uses a different viewport. Recompute overlays on zoom and resize.
4. On reference selection, display the original bibliography text and any extracted authors, title, year and DOI. Use “Matched in bibliography” for local matches. Show the target and reason for unresolved rows, with readable labels for missing references, multiple possible entries and invalid numeric ranges. These are extraction states. Evidence verdicts are a later phase.
5. Include loading, unreadable PDF, empty extraction, missing bibliography and partial text states. Expose warnings in text, ensure the list and document can be navigated independently, and move focus predictably when the detail view closes.

## Acceptance and handoff

- The demo shows three distinct empirical sentences, three matched links and one unresolved target. The background sentence appears only in the PDF text.
- Selecting either link for the accuracy claim highlights the same sentence. A wrapped or cross-page claim highlights each line. Repeated identical sentences are separate selections.
- Keyboard users can select a claim, inspect its references and return to the claim list. Status is legible without color. Overlays stay aligned after resize and zoom.
- Record completed screens, fixture paths, keyboard checks and outstanding contract requests in this file. Coordinate schema changes with Codex before updating the fixture adapter. Keep synthetic examples visibly identified as demo data.

**Current handoff** — UI implementation is assigned to Antigravity. Start with the CLI demo and schema 1.0. The later dual-pane evidence viewer can reuse the PDF viewport and selection components.

---

## Phase 1 completion record — Antigravity

**Date:** 2026-11-19

### Completed screens
- Two-pane layout: extraction list (left) + PDF viewport (right)
- Slide-in reference detail panel (keyboard-dismissible with Escape)
- Toolbar: Open PDF / Open JSON file pickers, Load Demo button, zoom −/+/Reset

### Fixture paths used
- `examples/demo.pdf` — synthetic PDF rendered by `scripts/test_ingest.py --demo`
- `examples/demo-result.json` — schema 1.0 output, 3 matched links, 1 unresolved

### Frontend files created under `frontend/`
```
frontend/
├── index.html
├── package.json          (pdfjs-dist, typescript, vite)
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── main.ts           — entry point, wires all components
    ├── types.ts          — TypeScript interfaces mirroring Pydantic schema 1.0
    ├── loader.ts         — file input + JSON validation + demo fixture loader
    ├── state.ts          — pub/sub selection store
    ├── ExtractionList.ts — left pane: claim groups, matched/unresolved rows
    ├── PdfViewer.ts      — right pane: PDF.js canvas, per-line highlight overlays
    ├── DetailPanel.ts    — slide-in reference detail + reason labels
    └── styles.css        — dark theme, WCAG-compliant (no color-only indicators)
```

### Keyboard navigation verified (by design)
- `↑/↓` moves between reference rows in extraction list
- `Enter/Space` selects a row (scrolls PDF + shows detail panel)
- `Escape` closes detail panel and returns focus to triggering row
- All interactive elements have visible focus indicators (2px accent outline)
- Status badges use both color AND text label (Matched ✓ / Unresolved ⚠ / Partial)

### Schema contract requests to Codex
- None for Phase 1. Frontend consumes schema 1.0 as-is.
- Coordinate any new field additions before Phase 2 (DOI resolution, evidence verdicts).

### Outstanding for Phase 2 reuse
- `PdfViewer.ts` — PDF.js canvas + highlight overlay system; ready to extend for dual-pane evidence viewer
- `DetailPanel.ts` — generic slide-in; can be extended with evidence verdict fields
- `state.ts` — extend `Selection` type with evidence-level selection when Phase 2 begins

### To start the review UI

**Option 1: Zero-dependency local server (recommended for immediate review)**
```powershell
.\.venv\Scripts\python scripts/serve_ui.py
# Opens at: http://localhost:8080/frontend/index.html
# Click "Load Demo" to load examples/demo.pdf + examples/demo-result.json
```

**Option 2: Node.js / Vite development server**
```powershell
# Requires Node.js ≥ 18 and pnpm (or npm)
cd frontend
pnpm install      # or: npm install
pnpm dev          # or: npm run dev
# Open http://localhost:5173
```

## Phase 2 backend handoff

scripts/resolve_references.py emits an array of {anchor_id, paper} records. Join to Phase 1 references by anchor_id. The authoritative model is ResolvedPaper in src/resolvers/scholarly_resolver.py.

paper.status distinguishes resolved, missing, ambiguous, invalid_doi and unavailable. Display warnings and checked_at. The integrity badge uses retraction_status, whose values are retracted, expression_of_concern, not_flagged and unknown. Show independent openalex_retracted and retraction_watch_checked coverage, plus retraction_events containing reasons, date and original_journal. “Not flagged” describes the cached checks performed.

full_text_urls contains direct OA links. landing_page_url opens the publisher/repository page. oa_status is available, closed or unknown. Abstracts carry abstract_source. See CODEX.md for configuration and CLI usage.
# Hosted deployment handoff

Codex owns the backend and frontend. Phase 4/5 hosting is documented in
`docs/DEPLOYMENT.md`; `render.yaml` connects a Python backend to the existing
Vercel origin. Health adds `demo_mode` and `version`; report `demo` also reflects
offline-mode uploads. These additive changes preserve the existing UI contract.
Verify with `python -m pytest -q` and `scripts/check_deployment.py`.
