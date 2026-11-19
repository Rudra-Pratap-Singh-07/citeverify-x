"""Verify a Phase 1 export against Phase 2 metadata containing abstracts/full text."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from parser.document_ingest import IngestionResult
from resolvers.scholarly_resolver import ResolvedPaper
from verification.models import VerificationVerdict
from verification.nli_engine import (
    DEFAULT_MODEL,
    GroqNLI,
    HuggingFaceNLI,
    InferenceError,
)
from verification.pipeline import VerificationPipeline


async def run(args: argparse.Namespace) -> list[VerificationVerdict]:
    document = IngestionResult.model_validate_json(args.input.read_bytes())
    records = json.loads(args.sources.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise TypeError("Sources must be an array of {anchor_id, paper} objects")
    sources = {}
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("anchor_id"), str):
            raise TypeError("Every source needs a string anchor_id")
        if record["anchor_id"] in sources:
            raise ValueError(f"Duplicate source anchor {record['anchor_id']}")
        sources[record["anchor_id"]] = ResolvedPaper.model_validate(record.get("paper"))
    nli = (
        GroqNLI(model_name=args.model or "llama-3.3-70b-versatile")
        if args.backend == "groq"
        else HuggingFaceNLI(model_name=args.model or DEFAULT_MODEL, device=args.device)
    )
    pipeline = VerificationPipeline(nli=nli)
    jobs = [
        (claim, sources.get(claim.matched_reference.anchor_id, ResolvedPaper(status="missing")))
        for claim in document.citation_maps
    ]
    return await pipeline.verify_many(jobs)


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("input", type=Path, help="Phase 1 ingestion JSON")
    cli.add_argument("sources", type=Path, help="Phase 2 resolved references JSON")
    cli.add_argument("--output", type=Path, required=True)
    cli.add_argument("--backend", choices=["local", "groq"], default="local")
    cli.add_argument("--model", help="Override the NLI model identifier")
    cli.add_argument("--device", default="cpu", help="Local NLI device, e.g. cpu or cuda")
    args = cli.parse_args()
    if args.output.resolve() in (args.input.resolve(), args.sources.resolve()):
        cli.error("Output must differ from both inputs")
    try:
        verdicts = asyncio.run(run(args))
        payload = json.dumps([v.model_dump(mode="json") for v in verdicts], indent=2)
        args.output.write_text(payload + "\n", encoding="utf-8")
    except (InferenceError, ValidationError, OSError, ValueError, TypeError, ImportError) as exc:
        print(f"Verification failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
