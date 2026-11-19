from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from reportlab.pdfgen.canvas import Canvas

from parser.document_ingest import IngestionError, IngestionResult, ingest_document


def make_pdf(path: Path, *pages: list[str]) -> Path:
    pdf = Canvas(str(path), pagesize=(612, 792), invariant=1)
    for lines in pages:
        for i, line in enumerate(lines):
            pdf.drawString(48, 740 - i * 16, line)
        pdf.showPage()
    pdf.save()
    return path


def parse(path: Path) -> IngestionResult:
    return asyncio.run(ingest_document(path))


def test_numeric_groups_and_exact_word_geometry(tmp_path: Path) -> None:
    path = make_pdf(
        tmp_path / "range.pdf",
        [
            "For further details, see [1]. Measurements showed",
            "a 12% decrease [1, 3-4, 9]. The baseline is described in [2].",
            "References",
            "[1] Allen AB. Trial results. Journal. 2020;2:3.",
            "[3] Park, J. (2021). Response time. Journal.",
            "[4] Diaz, M. (2022). Updated estimates. Journal.",
            "https://doi.org/10.1234/demo(7).",
        ],
    )
    result = parse(path)
    assert [m.matched_reference.anchor_id for m in result.citation_maps] == ["1", "3", "4"]
    assert [u.target for u in result.unresolved] == ["9"]
    row = result.citation_maps[0]
    assert row.sentence_text == "Measurements showed a 12% decrease [1, 3-4, 9]."
    assert row.citation_markers == ["[1, 3-4, 9]"]
    assert len({m.claim_id for m in [*result.citation_maps, *result.unresolved]}) == 1
    assert row.matched_reference.parsed_authors == ["Allen AB"]
    assert row.matched_reference.parsed_title == "Trial results"
    assert result.references[-1].parsed_doi == "10.1234/demo(7)"
    assert result.pages[0].width == 612 and "References" in result.pages[0].raw_text
    assert len(row.highlights) == 2
    word = next(w for w in result.pages[0].words if w.text == "Measurements")
    assert row.highlights[0].bounding_box["x0"] == word.bounding_box["x0"] > 48
    assert row.highlights[1].bounding_box["x0"] == 48
    assert row.bounding_box["y0"] == pytest.approx(42.484)
    assert IngestionResult.model_validate_json(result.model_dump_json()) == result


def test_author_year_bibliography_and_disambiguation(tmp_path: Path) -> None:
    result = parse(
        make_pdf(
            tmp_path / "authors.pdf",
            [
                "Error decreased (Smith et al., 2020a; Singh & Li, 2022).",
                "Costs fell by 3% (Smith, 2020b).",
                "For background see (Singh & Li, 2022).",
                "Bibliography",
                "Smith, J., & Chen, P. (2020a). First report. Journal.",
                "Smith, J. (2020b). Later report. Journal.",
                "Singh, K., & Li, H. (2022). Cost comparison.",
                "Journal of Examples.",
            ],
        )
    )
    assert [m.matched_reference.parsed_title for m in result.citation_maps] == [
        "First report",
        "Cost comparison",
        "Later report",
    ]
    assert result.references[-1].parsed_authors == ["Singh, K.", "Li, H."]
    assert not result.unresolved
    assert result.references[-1].raw_text.endswith("Journal of Examples.")


def test_cross_page_and_repeated_text(tmp_path: Path) -> None:
    path = make_pdf(
        tmp_path / "split.pdf",
        ["Accuracy increased by 12% [1].", "We observed"],
        [
            "a decrease of 7% [1].",
            "Accuracy increased by 12% [1].",
            "References",
            "1. Lee T. Evaluation. Journal. 2021.",
        ],
    )
    result = parse(path)
    first, across, repeated = result.citation_maps
    assert across.sentence_text == "We observed a decrease of 7% [1]."
    assert across.page_number == 1
    assert [h.page_number for h in across.highlights] == [1, 2]
    assert across.bounding_box == across.highlights[0].bounding_box
    assert first.sentence_text == repeated.sentence_text and first.claim_id != repeated.claim_id
    assert [r.claim_id for r in result.citation_maps] == [
        r.claim_id for r in parse(path).citation_maps
    ]


def test_ambiguous_missing_and_invalid_ranges(tmp_path: Path) -> None:
    path = make_pdf(
        tmp_path / "ambiguity.pdf",
        [
            "Scores increased [3-1] (Smith, 2020). Scores decreased [2].",
            "References",
            "[1] Smith, A. (2020). A trial.",
            "[3] Smith, B. (2020). Another trial.",
        ],
    )
    result = parse(path)
    assert not result.citation_maps
    assert [(u.target, u.reason) for u in result.unresolved] == [
        ("3-1", "invalid_range"),
        ("Smith, 2020", "ambiguous_reference"),
        ("2", "missing_reference"),
    ]
    assert len(result.references) == 2


def test_contents_and_end_of_bibliography(tmp_path: Path) -> None:
    result = parse(
        make_pdf(
            tmp_path / "sections.pdf",
            ["Contents", "Methods", "References", "Appendix"],
            [
                "Accuracy increased [1].",
                "5. REFERENCES",
                "[1] Lee T. Evaluation. Journal. 2021.",
                "Appendix A",
                "Accuracy increased [2].",
            ],
        )
    )
    assert len(result.citation_maps) == 1 and not result.unresolved
    assert "Appendix" not in result.references[0].raw_text


def test_two_columns_keep_citation_in_its_column(tmp_path: Path) -> None:
    path = tmp_path / "columns.pdf"
    pdf = Canvas(str(path), pagesize=(612, 792))
    for x, y, text in [
        (48, 720, "Accuracy increased"),
        (332, 720, "Latency decreased"),
        (48, 705, "by 4% [1]."),
        (332, 705, "by 2% [2]."),
        (48, 620, "References"),
        (48, 600, "[1] Ali A. Test. 2024."),
        (48, 580, "[2] Li B. Test. 2023."),
    ]:
        pdf.drawString(x, y, text)
    pdf.save()
    result = parse(path)
    assert {m.sentence_text for m in result.citation_maps} == {
        "Accuracy increased by 4% [1].",
        "Latency decreased by 2% [2].",
    }


def test_no_bibliography_and_empty_pages(tmp_path: Path) -> None:
    result = parse(make_pdf(tmp_path / "no-refs.pdf", [], ["The model achieved 94% accuracy [7]."]))
    assert len(result.warnings) == 2
    assert result.unresolved[0].target == "7" and result.unresolved[0].page_number == 2
    assert not result.references


def test_clause_ownership_and_post_sentence_marker(tmp_path: Path) -> None:
    result = parse(
        make_pdf(
            tmp_path / "clauses.pdf",
            [
                "Accuracy increased [1]; latency decreased [2]. Costs increased. [1]",
                "Tables are available elsewhere [2].",
                "References",
                "[1] Ray K. Evaluation. Journal. 2022.",
                "[2] Li B. Metrics. Journal. 2023.",
            ],
        )
    )
    assert [(m.sentence_text, m.matched_reference.anchor_id) for m in result.citation_maps] == [
        ("Accuracy increased [1]", "1"),
        ("latency decreased [2].", "2"),
        ("Costs increased. [1]", "1"),
    ]


def test_unreadable_documents(tmp_path: Path) -> None:
    with pytest.raises(IngestionError, match="No extractable text"):
        parse(make_pdf(tmp_path / "empty.pdf", []))
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"invalid")
    with pytest.raises(IngestionError, match="Could not read"):
        parse(bad)
    with pytest.raises(IngestionError, match="Could not read"):
        parse(tmp_path / "missing.pdf")


def test_concurrent_documents_and_numeric_filter(tmp_path: Path) -> None:
    paper = make_pdf(
        tmp_path / "trial.pdf",
        [
            "The mean score was 7.2 [1]. Sources from 2021 discuss this topic [1].",
            "References",
            "1. Ray K. Evaluation. 2022.",
        ],
    )
    other = make_pdf(
        tmp_path / "survey.pdf",
        [
            "The survey included 50 participants [1].",
            "References",
            "1. Lee T. Survey. 2022.",
        ],
    )

    async def run_both() -> tuple[IngestionResult, IngestionResult]:
        a, b = await asyncio.gather(ingest_document(paper), ingest_document(other))
        return a, b

    trial, survey = asyncio.run(run_both())
    assert [m.sentence_text for m in trial.citation_maps] == ["The mean score was 7.2 [1]."]
    assert survey.citation_maps[0].matched_reference.raw_text == "1. Lee T. Survey. 2022."


def test_hanging_bibliography_and_narrative_markers(tmp_path: Path) -> None:
    path = tmp_path / "hanging.pdf"
    pdf = Canvas(str(path), pagesize=(612, 792))
    for x, y, text in [
        (48, 742, "Ray et al. (2020a) reported higher scores (Ray et al., 2020b)."),
        (48, 708, "References"),
        (48, 685, "Lena Ray, Kim Vu, and Sid Ames."),
        (60, 670, "2020a. Response time. Journal."),
        (48, 640, "Lena Ray and Tom Chen. 2020b. Accuracy estimates."),
        (60, 625, "Journal of Measurements, pages 20-25."),
        (48, 590, "Appendix for the study"),
        (48, 565, "Additional experimental settings."),
    ]:
        pdf.drawString(x, y, text)
    pdf.save()
    result = parse(path)
    assert [r.anchor_id for r in result.references] == ["ref-1", "ref-2"]
    assert result.references[0].parsed_authors == ["Lena Ray", "Kim Vu", "Sid Ames"]
    assert result.references[1].raw_text.endswith("20-25.")
    assert not result.unresolved
    assert [
        (m.citation_markers, m.matched_reference.parsed_title) for m in result.citation_maps
    ] == [
        (["Ray et al. (2020a)"], "Response time"),
        (["(Ray et al., 2020b)"], "Accuracy estimates"),
    ]
    assert all(
        m.sentence_text.startswith("Ray et al. (2020a) reported") for m in result.citation_maps
    )


@pytest.mark.parametrize(("one", "two"), [("[1]", "[2]"), ("1.", "2.")])
def test_numbered_entries_with_middle_initial_and_wrapped_year(
    tmp_path: Path, one: str, two: str
) -> None:
    result = parse(
        make_pdf(
            tmp_path / "year.pdf",
            [
                "Costs decreased [1, 2].",
                "References",
                f"{one} Al Nair and Sam J. West. Cost of the 2014 survey. Journal,",
                "2017.",
                f"{two} Ada Wen and Mo Li. Measured costs, 2019.",
            ],
        )
    )
    assert [(r.anchor_id, r.parsed_title, r.parsed_year) for r in result.references] == [
        ("1", "Cost of the 2014 survey", 2017),
        ("2", "Measured costs", 2019),
    ]
    assert result.references[0].parsed_authors == ["Al Nair", "Sam J. West"]
    assert result.references[0].raw_text.endswith("Journal, 2017.")


def test_typeset_word_gaps_and_narrow_column_gutter(tmp_path: Path) -> None:
    path = tmp_path / "typeset.pdf"
    pdf = Canvas(str(path), pagesize=(612, 792))
    # Independent positioned glyph runs with no literal whitespace in the PDF stream.
    last_word_x = 298 - pdf.stringWidth("increased")
    pdf.drawString(last_word_x - pdf.stringWidth("Scores") - 2, 720, "Scores")
    pdf.drawString(last_word_x, 720, "increased")
    pdf.drawRightString(298, 706, "by 4% [1].")
    pdf.drawString(314, 720, "Errors decreased")
    pdf.drawString(314, 706, "by 6% [2].")
    pdf.drawString(48, 635, "References")
    pdf.drawString(48, 600, "[1] Ray K. Scores. Journal. 2021.")
    pdf.drawString(48, 582, "[2] Wu L. Errors. Journal. 2022.")
    pdf.save()
    result = parse(path)
    left, right = result.citation_maps
    assert [left.sentence_text, right.sentence_text] == [
        "Scores increased by 4% [1].",
        "Errors decreased by 6% [2].",
    ]
    assert left.bounding_box["x1"] == pytest.approx(298, abs=0.01)
    assert right.bounding_box["x0"] == pytest.approx(314)


def test_small_print_note_and_cross_page_prose(tmp_path: Path) -> None:
    path = tmp_path / "notes.pdf"
    pdf = Canvas(str(path), pagesize=(612, 792))
    pdf.drawString(48, 108, "Discussion of the results continues")
    pdf.setFont("Helvetica", 9)
    pdf.drawString(50, 88, "1 Measurements improved [1].")
    pdf.showPage()
    pdf.drawString(48, 80, "Participants reported")
    pdf.drawString(295, 28, "2")
    pdf.showPage()
    pdf.drawString(48, 740, "higher scores [1].")
    pdf.drawString(48, 695, "References")
    pdf.drawString(48, 675, "[1] Ray K. Survey. Journal. 2021.")
    pdf.save()
    result = parse(path)
    note, cross_page = result.citation_maps
    assert note.sentence_text == "1 Measurements improved [1]."
    assert note.page_number == 1
    assert cross_page.sentence_text == "Participants reported higher scores [1]."
    assert [h.page_number for h in cross_page.highlights] == [2, 3]
    assert "2" in [word.text for word in result.pages[1].words]


def test_subscript_stays_beside_its_variable(tmp_path: Path) -> None:
    path = tmp_path / "subscript.pdf"
    pdf = Canvas(str(path), pagesize=(612, 792))
    pdf.setFont("Helvetica", 10)
    pdf.drawString(48, 710, "Let the baseline be k. When d")
    x = 48 + pdf.stringWidth("Let the baseline be k. When d")
    pdf.setFont("Helvetica", 7)
    pdf.drawString(x, 708.3, "k")
    x += pdf.stringWidth("k") + 3
    pdf.setFont("Helvetica", 10)
    pdf.drawString(x, 710, "increased,")
    pdf.drawString(48, 698, "scores decreased [1].")
    pdf.drawString(48, 650, "References")
    pdf.drawString(48, 634, "[1] Wu L. Scores. Journal. 2021.")
    pdf.save()
    claim = parse(path).citation_maps[0]
    # Flattened math may have a space between the base glyph and the subscript.
    assert claim.sentence_text.replace("d k", "dk") == "When dk increased, scores decreased [1]."
    assert len(claim.highlights) == 2
