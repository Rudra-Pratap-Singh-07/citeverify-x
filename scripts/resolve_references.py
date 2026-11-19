"""Resolve a Phase 1 JSON export and write DOI metadata with integrity checks."""

import argparse
import asyncio
import json
from pathlib import Path

from parser.document_ingest import IngestionResult
from resolvers.scholarly_resolver import ScholarlyResolver


async def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("input", type=Path)
    cli.add_argument("--output", type=Path, required=True)
    args = cli.parse_args()
    if args.input.resolve() == args.output.resolve():
        cli.error("Input and output must have different paths")
    document = IngestionResult.model_validate_json(args.input.read_bytes())
    async with ScholarlyResolver() as resolver:
        results = []
        for reference in document.references:
            result = await resolver.resolve(reference)
            results.append(
                {"anchor_id": reference.anchor_id, "paper": result.model_dump()}
            )
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
