"""Exercise the public async API on a real PDF or a deterministic local demo."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from parser.document_ingest import IngestionError, IngestionResult, ingest_document


def create_demo(path: Path) -> None:
    from reportlab.pdfgen.canvas import Canvas

    pdf = Canvas(str(path), pagesize=(612, 792), invariant=1)
    for y, text in [
        (740, "CiteVerify-X extraction fixture"),
        (700, "Accuracy increased by 12% [1, 2]."),
        (676, "For background, see [1]."),
        (652, "Latency decreased by 8 ms (Chen et al., 2021)."),
        (628, "Throughput improved by 5% [9]."),
        (570, "References"),
        (546, "[1] Rao, K. (2020). Synthetic accuracy study. Demo Journal."),
        (522, "[2] Chen, M., & Ali, S. (2021). Synthetic latency study."),
        (506, "Demo Journal. doi:10.5555/demo.2021"),
    ]:
        pdf.drawString(54, y, text)
    pdf.save()


async def _run(args: argparse.Namespace) -> IngestionResult:
    if args.demo:
        with TemporaryDirectory() as folder:
            path = args.demo_pdf or Path(folder) / "demo.pdf"
            create_demo(path)
            result = await ingest_document(path)
        expected = [
            ("Accuracy increased by 12% [1, 2].", "1"),
            ("Accuracy increased by 12% [1, 2].", "2"),
            ("Latency decreased by 8 ms (Chen et al., 2021).", "2"),
        ]
        if [
            (m.sentence_text, m.matched_reference.anchor_id) for m in result.citation_maps
        ] != expected or [u.target for u in result.unresolved] != ["9"]:
            raise IngestionError(
                "Demo result differs from the expected three links and one missing reference."
            )
        return result
    return await ingest_document(args.pdf)


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    source = cli.add_mutually_exclusive_group(required=True)
    source.add_argument("pdf", type=Path, nargs="?", help="path to a text-layer PDF")
    source.add_argument(
        "--demo", action="store_true", help="run the self-check (install the test extra)"
    )
    source.add_argument("--schema", action="store_true", help="print the JSON Schema and exit")
    cli.add_argument(
        "--demo-pdf", type=Path, help="with --demo, save the matching synthetic PDF here"
    )
    cli.add_argument("--output", type=Path, help="write UTF-8 JSON to a file instead of stdout")
    args = cli.parse_args()
    if args.demo_pdf and not args.demo:
        cli.error("--demo-pdf requires --demo")
    pdf_path = args.pdf or args.demo_pdf
    if pdf_path and args.output and args.output.resolve() == pdf_path.resolve():
        cli.error("choose different paths for the PDF and output JSON")
    try:
        if args.schema:
            payload = json.dumps(IngestionResult.model_json_schema(), indent=2)
        else:
            payload = asyncio.run(_run(args)).model_dump_json(indent=2)
        if args.output:
            args.output.write_text(payload + "\n", encoding="utf-8")
        else:
            sys.stdout.buffer.write((payload + "\n").encode("utf-8"))
    except (IngestionError, OSError, ImportError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
