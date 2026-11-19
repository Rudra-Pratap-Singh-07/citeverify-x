"""Local, asynchronous ingestion of English, text-layer academic PDFs.

Coordinates are PDF points measured from the top left of the displayed media box.
Pages are one-based. The async boundary keeps PDF decoding and NLP off the event loop.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import unicodedata
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path
from statistics import median
from typing import Literal

import pdfplumber
import spacy
from pdfminer.pdfexceptions import PDFException
from pdfplumber.utils.exceptions import PdfminerException
from pydantic import BaseModel, Field
from spacy.language import Language
from typing_extensions import TypedDict


class IngestionError(ValueError):
    """The document could not be read or contained no extractable text."""


class BoundingBox(TypedDict):
    x0: float
    y0: float
    x1: float
    y1: float


class Word(BaseModel):
    text: str
    page_number: int
    bounding_box: BoundingBox


class PageText(BaseModel):
    page_number: int
    width: float
    height: float
    raw_text: str
    words: list[Word]


class ReferenceItem(BaseModel):
    raw_text: str
    anchor_id: str
    parsed_authors: list[str]
    parsed_title: str | None
    parsed_year: int | None
    parsed_doi: str | None


class Highlight(BaseModel):
    page_number: int
    bounding_box: BoundingBox


class ClaimLocation(BaseModel):
    claim_id: str
    sentence_text: str
    page_number: int
    bounding_box: BoundingBox
    citation_markers: list[str]
    highlights: list[Highlight]


class CitationMap(ClaimLocation):
    matched_reference: ReferenceItem


class UnresolvedCitation(ClaimLocation):
    target: str
    reason: Literal["missing_reference", "ambiguous_reference", "invalid_range"]


class IngestionResult(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    pages: list[PageText]
    references: list[ReferenceItem]
    citation_maps: list[CitationMap]
    unresolved: list[UnresolvedCitation]
    warnings: list[str] = Field(default_factory=list)


@dataclass
class _Line:
    words: list[Word]

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)


def _lines_on_page(words: list[Word], width: float) -> list[_Line]:
    """Detect a recurring central gutter, preserving spanning titles and headings."""

    def mid_y(word: Word) -> float:
        box = word.bounding_box
        return (box["y0"] + box["y1"]) / 2

    # The top of a subscript may be below all the other word tops on its line.
    # Its vertical midpoint is still closer to its own baseline than the next row.
    rows: list[list[Word]] = []
    for word in sorted(words, key=mid_y):
        if not rows or mid_y(word) - mid_y(rows[-1][0]) > 3:
            rows.append([])
        rows[-1].append(word)
    center = width / 2
    splits: list[int | None] = []
    for row in rows:
        row.sort(key=lambda w: w.bounding_box["x0"])
        splits.append(
            next(
                (
                    i
                    for i in range(1, len(row))
                    if row[i - 1].bounding_box["x1"] < center < row[i].bounding_box["x0"]
                    and row[i].bounding_box["x0"] - row[i - 1].bounding_box["x1"] > width * 0.02
                ),
                None,
            )
        )
    if sum(i is not None for i in splits) < 2:
        return [_Line(row) for row in rows]
    result: list[_Line] = []
    right: list[_Line] = []
    for row, split in zip(rows, splits, strict=True):
        if split is not None:
            result.append(_Line(row[:split]))
            right.append(_Line(row[split:]))
        elif row[0].bounding_box["x0"] > center:
            right.append(_Line(row))
        else:
            if row[-1].bounding_box["x1"] > center or _HEADING.fullmatch(_Line(row).text):
                result.extend(right)
                right.clear()
            result.append(_Line(row))
    return result + right


def _extract(path: Path) -> tuple[list[PageText], list[_Line]]:
    pages: list[PageText] = []
    lines: list[_Line] = []
    try:
        with pdfplumber.open(path) as document:
            for number, page in enumerate(document.pages, start=1):
                try:
                    left, top = page.bbox[:2]
                    words = [
                        Word(
                            text=w["text"],
                            page_number=number,
                            bounding_box={
                                "x0": w["x0"] - left,
                                "y0": w["top"] - top,
                                "x1": w["x1"] - left,
                                "y1": w["bottom"] - top,
                            },
                        )
                        for w in page.extract_words(x_tolerance_ratio=0.12)
                    ]
                    ordered = _lines_on_page(words, page.width)
                    for line in ordered:
                        y = line.words[0].bounding_box["y0"]
                        if line.text.isdecimal() and (
                            y < 0.08 * page.height or y > 0.9 * page.height
                        ):
                            continue  # Keep page numbers in the page payload, outside the prose stream.
                        lines.append(line)
                    pages.append(
                        PageText(
                            page_number=number,
                            width=page.width,
                            height=page.height,
                            raw_text=page.extract_text(x_tolerance_ratio=0.12) or "",
                            words=[w for line in ordered for w in line.words],
                        )
                    )
                finally:
                    page.close()
    except (PDFException, PdfminerException, OSError) as exc:
        raise IngestionError(f"Could not read {path.name}: {exc}") from exc
    if not lines:
        raise IngestionError("No extractable text. Image-only PDFs require OCR.")
    return pages, lines


_HEADING = re.compile(
    r"(?:(?:\d+(?:\.\d+)*[.)]?|[IVX]+\.)\s+)?(?:references|bibliography)\s*:?", re.IGNORECASE
)
_AFTER_REFS = re.compile(
    r"(?:appendi(?:x|ces)(?:\s+[A-Z0-9])?(?:[:.]\s+.*|\s+(?:for|to)\s+.+)?|"
    r"supplementary (?:material|information)|acknowledg[e]?ments)",
    re.IGNORECASE,
)
_NUMBERED = re.compile(r"^(?:\[(\d{1,6})\]\s*|(\d{1,6})[.)](?=\s|[^\W\d_]|$)\s*)")
_YEAR = re.compile(r"\b((?:18|19|20)\d{2})([a-z]?)\b")
_DOI = re.compile(r"\b10\.\d{4,9}/[^\s<>\"“”]+", re.IGNORECASE)
_FAMILY = r"[^\W\d_]+(?:[-'’][^\W\d_]+)*"
_AUTHOR_START = re.compile(rf"^{_FAMILY},\s*(?:[A-Z]\b|[A-Z][a-z]+)")
_VANCOUVER_START = re.compile(rf"^{_FAMILY}\s+[A-Z]{{1,4}}[.,]\s")
_INITIALS = re.compile(rf"({_FAMILY}(?:\s+{_FAMILY})*),\s*((?:[A-Z]\.\s*)+)")
_NUMPART = r"\d{1,6}(?:\s*[-–—]\s*\d{1,6})?"
_NUMERIC = re.compile(rf"\[\s*{_NUMPART}(?:\s*,\s*{_NUMPART})*\s*\]")
_AUTHOR = rf"(?:{_FAMILY}\s+){{0,3}}{_FAMILY}"
_AUTHYEAR = rf"{_AUTHOR}(?:(?:\s+et\s+al\.?)|(?:\s+&\s+{_AUTHOR}))?,\s*(?:18|19|20)\d{{2}}[a-z]?"
_PAREN = re.compile(rf"\(\s*{_AUTHYEAR}(?:\s*;\s*{_AUTHYEAR})*\s*\)")
_NARR_NAME = r"(?:(?:van|von|de|der|den|da|del)\s+){0,3}[A-ZÀ-ÖØ-Þ][^\W\d_]*(?:[-'’][^\W\d_]+)*"
_NARRATIVE = re.compile(
    rf"(?<![\w'’-])(?P<names>{_NARR_NAME}(?:\s+et al\.?|\s+(?:and|&)\s+{_NARR_NAME})?)"
    r"\s+\((?P<year>(?:18|19|20)\d{2}[a-z]?)\)"
)
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z“\"‘]|arXiv\b|bioRxiv\b)")


def _hanging_starts(lines: Sequence[_Line]) -> dict[int, bool]:
    """Identify first lines using the two recurring left margins within a column."""
    starts: dict[int, bool] = {}
    begin = 0
    while begin < len(lines):
        end = begin + 1
        first = lines[begin].words[0]
        while end < len(lines):
            word = lines[end].words[0]
            if (
                word.page_number != first.page_number
                or abs(word.bounding_box["x0"] - first.bounding_box["x0"]) > 60
            ):
                break
            end += 1
        offsets = [round(line.words[0].bounding_box["x0"]) for line in lines[begin:end]]
        frequent = Counter(offsets).most_common(2)
        if len(frequent) == 2 and min(n for _, n in frequent) >= 2:
            (margin, count), (indent, hanging) = sorted(frequent)
            if 4 <= indent - margin <= 30 and count + hanging >= 0.8 * len(offsets):
                for i, x in enumerate(offsets, begin):
                    if abs(x - margin) <= 1 or abs(x - indent) <= 1:
                        starts[i] = abs(x - margin) <= 1
        begin = end
    return starts


def _entries(lines: Sequence[_Line]) -> Iterator[str]:
    content: list[_Line] = []
    for line in lines:
        value = line.text.strip()
        if _AFTER_REFS.fullmatch(value):
            break
        if not (_HEADING.fullmatch(value) or value.isdecimal()):
            content.append(line)
    if not content:
        return
    # A wrapped entry may start a line with "2021. Title" or end one with "1925."
    # Only interpret bare dotted numbers as labels in a numbered bibliography.
    first_label = _NUMBERED.match(content[0].text)
    margins = {} if first_label else _hanging_starts(content)
    current: list[str] = []
    last_number = 0
    for i, line in enumerate(content):
        value = line.text.strip()
        if first_label:
            label = _NUMBERED.match(value)
            starts = False
            if label and bool(label[1]) == bool(first_label[1]):
                number = int(label[1] or label[2])
                starts = bool(label[1]) or not 1800 <= number <= 2099 or number == last_number + 1
                if starts:
                    last_number = number
        elif i in margins:
            starts = margins[i]
        else:
            starts = bool(
                _AUTHOR_START.match(value)
                or _VANCOUVER_START.match(value)
                or re.match(rf"^{_FAMILY}\s+(?:et al\.\s*)?\((?:19|20)\d\d[a-z]?\)", value)
                or re.match(rf"^{_FAMILY}\s+{_FAMILY}[^;]*?\.\s+(?:19|20)\d\d[a-z]?\.", value)
            )
        if current and starts:
            yield " ".join(current)
            current.clear()
        current.append(value)
    if current:
        yield " ".join(current)


def _authors(value: str) -> list[str]:
    value = value.strip(" ,.;(")
    if not value:
        return []
    # In natural-order lists, commas separate whole names ("Ada Ray, Ken Wu").
    # An inverted name such as "Ray, K." uses its first comma inside the name.
    first, comma, rest = value.partition(",")
    if (
        comma
        and len(first.split()) > 1
        and not re.match(r"\s*(?:[A-Z]\.\s*)+(?:,|$|&|\band\b)", rest)
    ):
        names = re.split(r",\s*(?:(?:and|&)\s+)?|\s+(?:and|&)\s+", value)
        return [name.strip() for name in names if name.strip() and not name.startswith("et al")]
    # Preserve surname/initial pairs, including the conjunction before the last author.
    pieces = re.split(r"\s+(?:and|&)\s+", value)
    result: list[str] = []
    for piece in pieces:
        piece = re.sub(r"\bet al\.?$", "", piece).strip(" ,")
        matches = list(_INITIALS.finditer(piece + "."))
        if matches:
            result.extend(m.group().strip() for m in matches)
        else:
            result.extend(
                part.strip()
                for part in re.split(r",\s*(?=[^,]+\s+[A-Z]{1,4}\b)", piece)
                if part.strip()
            )
    return result


def _parse_reference(raw: str, index: int) -> ReferenceItem:
    label = _NUMBERED.match(raw)
    text = raw[label.end() :] if label else raw
    doi_match = _DOI.search(text)
    doi = doi_match.group().rstrip(".,;:") if doi_match else None
    if doi:
        while doi.endswith(")") and doi.count(")") > doi.count("("):
            doi = doi[:-1]
    if doi_match:
        text = text[: doi_match.start()] + text[doi_match.end() :]
    text = re.sub(
        r"(?:https?://(?:dx\.)?doi\.org/|doi:\s*)\s*$", "", text, flags=re.IGNORECASE
    ).strip()
    year = _YEAR.search(text)
    prefix = text[: year.start()].strip() if year else ""
    # Author-date styles place the year before the title. Numbered styles often
    # put the date in the venue, sometimes directly after a comma-ending title.
    # A middle initial in a natural-order author list is part of the name.
    # The trailing initial in "Rao K. Title" terminates the author field.
    delimiter = (
        r"\.\s+" if _VANCOUVER_START.match(text) or _INITIALS.match(text) else r"(?<!\b[A-Z])\.\s+"
    )
    boundary = re.search(delimiter, text)
    author_date = year is not None and (
        prefix.endswith("(") or (boundary is not None and boundary.end() == year.start())
    )
    if year and author_date:
        authors = _authors(prefix)
        tail = text[year.end() :].lstrip(" \t).,;:-")
    else:
        if boundary and (not year or boundary.start() < year.start()):
            authors = _authors(text[: boundary.start()])
            tail = text[boundary.end() :]
            dates = list(_YEAR.finditer(text, boundary.end()))
            if dates:
                year = dates[-1]
                tail = text[boundary.end() : year.start()].rstrip(" ,;(")
        elif year:
            authors = _authors(prefix)
            tail = text[year.end() :].lstrip(" \t).,;:-")
        else:
            authors, tail = [], ""
    title = _SENTENCE_END.split(tail, maxsplit=1)[0].strip(' ."“”')
    anchor = next(g for g in label.groups() if g) if label else f"ref-{index}"
    return ReferenceItem(
        raw_text=raw,
        anchor_id=anchor,
        parsed_authors=authors,
        parsed_title=title or None,
        parsed_year=int(year[1]) if year else None,
        parsed_doi=doi,
    )


def _bibliography(lines: Sequence[_Line]) -> tuple[Sequence[_Line], list[ReferenceItem]]:
    headings = [i for i, line in enumerate(lines) if _HEADING.fullmatch(line.text.strip())]
    if not headings:
        return lines, []
    # A contents-page mention can precede a second, genuine bibliography heading.
    start = headings[-1]
    for earlier in reversed(headings[:-1]):
        following = [line.text for line in lines[earlier + 1 : start] if not line.text.isdecimal()]
        if following and (_NUMBERED.match(following[0]) or _AUTHOR_START.match(following[0])):
            start = earlier
        else:
            break
    return lines[:start], [
        _parse_reference(raw, i) for i, raw in enumerate(_entries(lines[start + 1 :]), 1)
    ]


def _key(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if c.isalnum())


def _surname(author: str) -> str:
    if "," in author:
        return author.split(",")[0]
    # Vancouver uses "Smith AB". Natural-order names end in the family name.
    value = re.sub(r"\s+(?:[A-Z]\.?){1,4}$", "", author).strip()
    return value.split()[-1] if value else author


class _ReferenceIndex:
    def __init__(self, references: Sequence[ReferenceItem]) -> None:
        self.numeric: dict[str, list[ReferenceItem]] = defaultdict(list)
        self.by_author: dict[tuple[str, str], list[ReferenceItem]] = defaultdict(list)
        for ref in references:
            if ref.anchor_id.isdecimal():
                self.numeric[str(int(ref.anchor_id))].append(ref)
            if ref.parsed_authors and ref.parsed_year:
                year = next(
                    (
                        match
                        for match in _YEAR.finditer(_DOI.sub("", ref.raw_text))
                        if int(match[1]) == ref.parsed_year
                    ),
                    None,
                )
                if year:
                    self.by_author[_key(_surname(ref.parsed_authors[0])), year[0]].append(ref)

    def lookup(self, target: str) -> list[ReferenceItem]:
        if target.isdecimal():
            return self.numeric.get(target, [])
        authors, _, year = target.rpartition(",")
        authors = re.sub(r"\s+et\s+al\.?$", "", authors.strip())
        names = re.split(r"\s+(?:and|&)\s+", authors)
        candidates = self.by_author.get((_key(names[0]), year.strip()), [])
        if len(names) == 1:
            return candidates
        return [
            ref
            for ref in candidates
            if len(ref.parsed_authors) == len(names)
            and all(
                _key(_surname(author)) == _key(name)
                for author, name in zip(ref.parsed_authors, names)
            )
        ]


def _markers(text: str) -> list[re.Match[str]]:
    return sorted(
        [*_NUMERIC.finditer(text), *_PAREN.finditer(text), *_NARRATIVE.finditer(text)],
        key=lambda m: m.start(),
    )


def citation_free_text(text: str) -> str:
    """Remove recognized citation anchors for downstream semantic comparisons."""
    clean = text
    for match in reversed(_markers(text)):
        clean = clean[: match.start()] + " " + clean[match.end() :]
    clean = re.sub(r"\s+([.,;:!?])", r"\1", clean)
    return re.sub(r"\s+", " ", clean).strip()


def _targets(marker: str) -> Iterator[tuple[str, bool]]:
    narrative = _NARRATIVE.fullmatch(marker)
    if narrative:
        yield f"{narrative['names']}, {narrative['year']}", True
        return
    if marker.startswith("("):
        for part in marker[1:-1].split(";"):
            yield part.strip(), True
        return
    for part in marker[1:-1].split(","):
        bounds = [int(n) for n in re.split("[-–—]", part)]
        if bounds[-1] < bounds[0] or bounds[-1] - bounds[0] >= 1000:
            yield part.strip(), False
        else:
            for number in range(bounds[0], bounds[-1] + 1):
                yield str(number), True


_OUTCOME = re.compile(
    r"\b(?:increas(?:e[ds]?|ing)|decreas(?:e[ds]?|ing)|reduc(?:e[ds]?|tion)|"
    r"improv(?:e[ds]?|ement)|outperform(?:ed|s)?|correlat(?:ed|ion|es)|associated|"
    r"(?:observed|found|reported|demonstrated|showed|revealed|achieved)|"
    r"higher|lower|faster|slower|differed|predicted|unchanged)\b",
    re.IGNORECASE,
)
_QUANTITY = re.compile(
    r"(?:\b\d+(?:\.\d+)?\s*(?:%|percent\b|fold\b|(?:participants?|subjects?|samples?|patients?|"
    r"students?|cases?|trials?|times?|seconds?|ms|kg|mg|mm|cm|hours?|days?)\b))"
    r"|\b(?:n|p|accuracy|sensitivity|specificity|OR|RR)\s*[=<>≤≥]\s*\.?\d",
    re.IGNORECASE,
)
_MEASUREMENT = re.compile(
    r"\b(?:mean|median|rate|score|accuracy|precision|recall|odds ratio|sample size|"
    r"sensitivity|specificity|concentration|temperature|yield)\b"
    r"(?:\s+[\w-]+){0,4}?\s*(?:=|was|were|of|reached|at|:)\s*[+-]?\d",
    re.IGNORECASE,
)
_BACKGROUND = re.compile(
    r"^(?:for (?:more |further )?(?:details|background|discussion)|see (?:also|e\.g\.)|"
    r"(?:an? |for an? )?(?:overview|review) of|"
    r"(?:we |the authors? )(?:hypothesize|aim|propose|plan|speculate)|"
    r"(?:the|our) (?:aim|hypothesis|objective) (?:is|was))\b",
    re.IGNORECASE,
)


def _empirical(text: str) -> bool:
    content = _NARRATIVE.sub("", _PAREN.sub("", _NUMERIC.sub("", text))).strip()
    return not _BACKGROUND.match(content) and bool(
        _OUTCOME.search(content) or _QUANTITY.search(content) or _MEASUREMENT.search(content)
    )


def _union(words: Iterable[Word]) -> BoundingBox:
    boxes = [word.bounding_box for word in words]
    return {
        "x0": min(b["x0"] for b in boxes),
        "y0": min(b["y0"] for b in boxes),
        "x1": max(b["x1"] for b in boxes),
        "y1": max(b["y1"] for b in boxes),
    }


def _paragraphs(lines: Sequence[_Line]) -> Iterator[list[_Line]]:
    paragraph: list[_Line] = []
    for line in lines:
        if (
            re.fullmatch(
                r"(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|methods?|materials and methods|"
                r"results?|discussion|conclusions?|contents|references|bibliography|appendix(?: [A-Z])?)",
                line.text,
                re.IGNORECASE,
            )
            or line.text.isdecimal()
        ):
            if paragraph:
                yield paragraph
                paragraph = []
            continue
        if paragraph:
            prev = paragraph[-1].words[0]
            current = line.words[0]
            gap = current.bounding_box["y0"] - prev.bounding_box["y1"]
            height = prev.bounding_box["y1"] - prev.bounding_box["y0"]
            footnote = (
                gap > 0.6 * height
                and re.match(r"^(?:\d{1,3}\b|\d{1,3}(?=[A-Z])|[*†‡])", line.text)
                and median(w.bounding_box["y1"] - w.bounding_box["y0"] for w in line.words)
                < 0.9 * height
            )
            if prev.page_number == current.page_number and (gap > 1.4 * height or footnote):
                yield paragraph
                paragraph = []
        paragraph.append(line)
    if paragraph:
        yield paragraph


def _clause_spans(
    masked: str, start: int, end: int, positions: list[int]
) -> Iterator[tuple[int, int]]:
    """Separate independently cited clauses while preserving a shared end citation."""
    left = start
    for sep in re.finditer(r";\s+", masked[start:end]):
        boundary, right = start + sep.start(), start + sep.end()
        has_left = bisect_left(positions, left) < bisect_left(positions, boundary)
        has_right = bisect_left(positions, right) < bisect_left(positions, end)
        if has_left and has_right:
            yield left, boundary
            left = right
    yield left, end


def _claims(lines: Sequence[_Line], nlp: Language, document_id: str) -> Iterator[ClaimLocation]:
    # Offsets belong to this exact reconstructed string, even for duplicated sentences.
    indexed = [(line_id, w) for line_id, line in enumerate(lines) for w in line.words]
    text = " ".join(w.text for _, w in indexed)
    markers = _markers(text)
    if not markers:
        return
    starts, ends = [], []
    pos = 0
    for _, word in indexed:
        starts.append(pos)
        ends.append(pos + len(word.text))
        pos = ends[-1] + 1
    # Mask marker punctuation (especially "et al.") without changing any offsets.
    masked = list(text)
    # spaCy treats a single letter and period as an initial. After a lowercase
    # variable, a capitalized next word commonly starts a new scientific sentence.
    for variable in re.finditer(r"(?<!\S)[a-z]\.(?=\s+[A-Z][a-z])", text):
        masked[variable.end() - 1] = "!"
    for match in markers:
        masked[match.start() : match.end()] = "X" * len(match[0])
        # Some journals place the marker after the sentence-ending period.
        before = match.start() - 1
        while before >= 0 and text[before].isspace():
            before -= 1
        after = match.end()
        while after < len(text) and text[after].isspace():
            after += 1
        if (
            match[0].startswith(("[", "("))
            and before >= 0
            and text[before] == "."
            and (after == len(text) or text[after].isupper())
        ):
            masked[before] = " "
            masked[match.end() - 1] = "."
    nlp.max_length = max(nlp.max_length, len(text) + 1)
    marker_positions = [m.start() for m in markers]
    protected = "".join(masked)
    spans = (
        span
        for sentence in nlp(protected).sents
        for span in _clause_spans(
            protected, sentence.start_char, sentence.end_char, marker_positions
        )
    )
    for start, end in spans:
        first = bisect_left(marker_positions, start)
        last = bisect_left(marker_positions, end)
        if first == last:
            continue
        value = text[start:end]
        if not _empirical(value):
            continue
        selection = indexed[bisect_right(ends, start) : bisect_left(starts, end)]
        if not selection:
            continue
        highlights = []
        for _, group in groupby(selection, key=lambda item: item[0]):
            words = [w for _, w in group]
            highlights.append(
                Highlight(page_number=words[0].page_number, bounding_box=_union(words))
            )
        page = highlights[0].page_number
        first_word = selection[0][1]
        identity = f"{document_id}/{page}/{first_word.bounding_box}/{start}/{value}"
        yield ClaimLocation(
            claim_id=hashlib.sha256(identity.encode()).hexdigest()[:24],
            sentence_text=value,
            page_number=page,
            bounding_box=_union(w for _, w in selection if w.page_number == page),
            highlights=highlights,
            citation_markers=list(dict.fromkeys(m[0] for m in markers[first:last])),
        )


def _ingest(path: Path) -> IngestionResult:
    pages, lines = _extract(path)
    body, references = _bibliography(lines)
    index = _ReferenceIndex(references)
    result = IngestionResult(pages=pages, references=references, citation_maps=[], unresolved=[])
    if not references:
        result.warnings.append(
            "No reference entries found under a terminal References or Bibliography heading."
        )
    for page in pages:
        if not page.words:
            result.warnings.append(f"Page {page.page_number} has no extractable text.")
    document_id = hashlib.sha256("\f".join(p.raw_text for p in pages).encode()).hexdigest()
    nlp = spacy.blank("en")
    nlp.add_pipe("sentencizer")
    for paragraph in _paragraphs(body):
        for claim in _claims(paragraph, nlp, document_id):
            grouped: dict[tuple[str, bool], list[str]] = defaultdict(list)
            for marker in claim.citation_markers:
                for key in _targets(marker):
                    if marker not in grouped[key]:
                        grouped[key].append(marker)
            linked: dict[tuple[str, str], CitationMap] = {}
            fields = claim.model_dump(exclude={"citation_markers"})
            for (target, valid), markers in grouped.items():
                matches = index.lookup(target) if valid else []
                if len(matches) == 1:
                    ref = matches[0]
                    reference_key = (ref.anchor_id, ref.raw_text)
                    if reference_key in linked:
                        row = linked[reference_key]
                        row.citation_markers.extend(
                            m for m in markers if m not in row.citation_markers
                        )
                    else:
                        linked[reference_key] = CitationMap(
                            **fields, citation_markers=markers, matched_reference=ref
                        )
                else:
                    result.unresolved.append(
                        UnresolvedCitation(
                            **fields,
                            citation_markers=markers,
                            target=target,
                            reason="invalid_range"
                            if not valid
                            else "ambiguous_reference"
                            if matches
                            else "missing_reference",
                        )
                    )
            result.citation_maps.extend(linked.values())
    return result


async def ingest_document(path: str | Path) -> IngestionResult:
    """Read a text-layer PDF and map empirical candidate sentences to local references."""
    return await asyncio.to_thread(_ingest, Path(path))
