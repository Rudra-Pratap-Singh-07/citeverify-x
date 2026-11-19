"""Resolve Phase 1 references and retain independently sourced integrity signals."""

from __future__ import annotations

import asyncio
import csv
import json
import os
import re
import tempfile
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal, Self
from urllib.parse import quote, unquote

import aiosqlite
import httpx
from pydantic import BaseModel, Field

from parser.document_ingest import ReferenceItem

from .transport import SourceError, Transport

RW_URL = (
    "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv"
)


def demo_fixture_path() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "demo_fixtures.json"


def normalize_doi(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("Malformed DOI")
    value = re.sub(
        r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    )
    value = unquote(value).strip().lower()
    if not re.fullmatch(r"10\.\d{4,9}/[^\s<>\"?#]+", value):
        raise ValueError("Malformed DOI")
    return value


class ResolvedPaper(BaseModel):
    status: Literal["resolved", "missing", "ambiguous", "invalid_doi", "unavailable"]
    doi: str | None = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    journal: str | None = None
    match_score: float | None = None
    openalex_retracted: bool | None = None
    retraction_status: Literal[
        "retracted", "expression_of_concern", "not_flagged", "unknown"
    ] = "unknown"
    retraction_watch_checked: bool = False
    retraction_events: list[dict[str, Any]] = Field(default_factory=list)
    oa_status: Literal["available", "closed", "unknown"] = "unknown"
    full_text_urls: list[str] = Field(default_factory=list)
    landing_page_url: str | None = None
    abstract: str | None = None
    abstract_source: str | None = None
    raw_text: str | None = None
    checked_at: float = Field(default_factory=time.time)
    warnings: list[str] = Field(default_factory=list)


def decode_abstract(index: Any) -> str | None:
    if not isinstance(index, dict):
        return None
    words: dict[int, str] = {}
    for word, positions in index.items():
        if not isinstance(word, str) or not isinstance(positions, list):
            return None
        for pos in positions:
            if type(pos) is not int or pos < 0 or pos > 100000 or pos in words:
                return None
            words[pos] = word
    if not words or sorted(words) != list(range(len(words))):
        return None
    return " ".join(words[i] for i in range(len(words)))


def _title(value: Any) -> str:
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return value if isinstance(value, str) else ""


class ScholarlyResolver:
    """Use as an async context manager. One instance shares its HTTP pool and cache."""

    def __init__(
        self,
        cache_path: str | Path | None = None,
        *,
        email: str | None = None,
        openalex_api_key: str | None = None,
        client: httpx.AsyncClient | None = None,
        interval: float = 1,
    ) -> None:
        self.cache_path = Path(
            cache_path if cache_path is not None
            else os.getenv("CITEVERIFY_CACHE_PATH", "data/paper_cache.db")
        )
        self.email = email or os.getenv("UNPAYWALL_EMAIL")
        self.key = openalex_api_key or os.getenv("OPENALEX_API_KEY")
        self.client = client
        self.owns_client = client is None
        self.interval = interval
        self.transport: Transport
        self.sync_lock = asyncio.Lock()

    async def __aenter__(self) -> Self:
        if self.client is None:
            self.client = httpx.AsyncClient(
                timeout=30,
                follow_redirects=True,
                headers={"User-Agent": "CiteVerify-X/0.1"},
            )
        self.transport = await Transport.open(
            self.client, self.cache_path, interval=self.interval
        )
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.transport.db.close()
        if self.owns_client and self.client:
            await self.client.aclose()

    async def sync_retraction_watch(self) -> None:
        """Refresh the official dataset atomically, at most once per day."""
        async with self.sync_lock:
            async with self.transport.db.execute(
                "SELECT checked FROM sync_state WHERE name='rw'"
            ) as cur:
                row = await cur.fetchone()
            if row and row[0] > time.time() - 86400:
                return
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "retractions.csv"
                for attempt in range(4):
                    await self.transport.pace(RW_URL)
                    try:
                        assert self.client is not None
                        async with self.client.stream("GET", RW_URL) as response:
                            response.raise_for_status()
                            size = 0
                            with path.open("wb") as stream:
                                async for chunk in response.aiter_bytes():
                                    size += len(chunk)
                                    if size > 250_000_000:
                                        raise SourceError(
                                            "Retraction Watch feed exceeds size limit"
                                        )
                                    await asyncio.to_thread(stream.write, chunk)
                        break
                    except httpx.HTTPError:
                        if attempt == 3:
                            raise SourceError(
                                "Retraction Watch feed unavailable"
                            ) from None
                        await asyncio.sleep(2**attempt)
                rows = await asyncio.to_thread(self._read_feed, path)
                # Serialize the replacement so readers see either complete snapshot.
                async with aiosqlite.connect(self.cache_path, timeout=30) as db:
                    await db.execute("BEGIN IMMEDIATE")
                    await db.execute("DELETE FROM retractions")
                    await db.executemany("INSERT INTO retractions VALUES (?,?)", rows)
                    await db.execute(
                        "INSERT OR REPLACE INTO sync_state VALUES ('rw',?)",
                        (time.time(),),
                    )
                    await db.commit()

    @staticmethod
    def _read_feed(path: Path) -> list[tuple[str, str]]:
        rows = []
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            required = {
                "OriginalPaperDOI",
                "RetractionNature",
                "Reason",
                "RetractionDate",
                "Journal",
            }
            if not required.issubset(reader.fieldnames or []):
                raise SourceError("Malformed Retraction Watch feed")
            for row in reader:
                for doi in row["OriginalPaperDOI"].split(";"):
                    try:
                        doi = normalize_doi(doi)
                    except ValueError:
                        continue
                    rows.append(
                        (
                            doi,
                            json.dumps(
                                {
                                    "source": "retraction-watch",
                                    "nature": row["RetractionNature"],
                                    "reasons": row["Reason"],
                                    "date": row["RetractionDate"],
                                    "original_journal": row["Journal"],
                                }
                            ),
                        )
                    )
        if not rows:
            raise SourceError("Empty Retraction Watch feed")
        return rows

    async def _get(
        self, result: ResolvedPaper, url: str, params: dict[str, str] | None = None
    ) -> dict[str, Any]:
        try:
            return await self.transport.get(url, params)
        except SourceError as exc:
            result.warnings.append(str(exc))
            return {}

    async def resolve(self, reference: ReferenceItem) -> ResolvedPaper:
        if os.getenv("DEMO_MODE", "false").lower() == "true":
            fixtures = json.loads(demo_fixture_path().read_text(encoding="utf-8"))
            doi = (reference.parsed_doi or "").lower()
            if doi in fixtures.get("papers_by_doi", {}):
                return ResolvedPaper.model_validate(fixtures["papers_by_doi"][doi])
            if reference.anchor_id in fixtures.get("papers_by_anchor", {}):
                return ResolvedPaper.model_validate(
                    fixtures["papers_by_anchor"][reference.anchor_id]
                )
            return ResolvedPaper(
                status="missing", warnings=["No matching offline demo fixture."]
            )
        result = ResolvedPaper(status="missing")
        if reference.parsed_doi:
            try:
                result.doi = normalize_doi(reference.parsed_doi)
            except (ValueError, TypeError):
                result.status = "invalid_doi"
                return result
        else:
            data = await self._get(
                result,
                "https://api.crossref.org/works",
                {"query.bibliographic": reference.raw_text, "rows": "5"},
            )
            message = data.get("message", {})
            items = message.get("items", []) if isinstance(message, dict) else []
            ranked = []
            title = reference.parsed_title
            if not title:
                result.warnings.append(
                    "A parsed title is required for reliable fuzzy matching."
                )
                return result
            clean = lambda s: " ".join(re.findall(r"\w+", s.casefold()))
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, dict):
                    continue
                score = SequenceMatcher(
                    None, clean(title), clean(_title(item.get("title")))
                ).ratio()
                try:
                    doi = normalize_doi(item.get("DOI", ""))
                except (ValueError, TypeError):
                    continue
                ranked.append((score, doi))
            ranked = sorted(set(ranked), reverse=True)
            if not ranked or ranked[0][0] < 0.85:
                result.status = "unavailable" if result.warnings else "missing"
                return result
            if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.05:
                result.status = "ambiguous"
                return result
            result.match_score, result.doi = ranked[0]
        doi_path = quote(result.doi, safe="")
        oa = await self._get(
            result,
            f"https://api.openalex.org/works/doi:{doi_path}",
            {"api_key": self.key} if self.key else None,
        )
        cr = await self._get(result, f"https://api.crossref.org/works/{doi_path}")
        metadata = cr.get("message", {})
        metadata = metadata if isinstance(metadata, dict) else {}
        result.title = _title(oa.get("title")) or _title(metadata.get("title")) or None
        result.status = (
            "resolved"
            if result.title
            else "unavailable"
            if result.warnings
            else "missing"
        )
        result.year = (
            oa.get("publication_year")
            if isinstance(oa.get("publication_year"), int)
            else None
        )
        if result.year is None:
            published = metadata.get("published", {})
            dates = (
                published.get("date-parts", []) if isinstance(published, dict) else []
            )
            if (
                dates
                and isinstance(dates, list)
                and isinstance(dates[0], list)
                and dates[0]
            ):
                result.year = dates[0][0] if type(dates[0][0]) is int else None
        result.journal = _title(metadata.get("container-title")) or None
        authors = metadata.get("author", [])
        for author in authors if isinstance(authors, list) else []:
            if isinstance(author, dict):
                result.authors.append(
                    " ".join(
                        str(author.get(k, "")) for k in ("given", "family")
                    ).strip()
                )
        if not result.authors:
            authorships = oa.get("authorships", [])
            for item in authorships if isinstance(authorships, list) else []:
                author = item.get("author", {}) if isinstance(item, dict) else {}
                if isinstance(author, dict) and isinstance(
                    author.get("display_name"), str
                ):
                    result.authors.append(author["display_name"])
        result.openalex_retracted = (
            oa.get("is_retracted") if type(oa.get("is_retracted")) is bool else None
        )
        try:
            await self.sync_retraction_watch()
            result.retraction_watch_checked = True
            async with self.transport.db.execute(
                "SELECT payload FROM retractions WHERE doi=?", (result.doi,)
            ) as cursor:
                result.retraction_events = [
                    json.loads(row[0]) for row in await cursor.fetchall()
                ]
        except (SourceError, OSError, UnicodeError, csv.Error) as exc:
            result.warnings.append(str(exc))
        natures = [
            str(e.get("nature", "")).casefold() for e in result.retraction_events
        ]
        if result.openalex_retracted is True or "retraction" in natures:
            result.retraction_status = "retracted"
        elif "expression of concern" in natures:
            result.retraction_status = "expression_of_concern"
        elif result.retraction_watch_checked and result.openalex_retracted is False:
            result.retraction_status = "not_flagged"
        if self.email:
            up = await self._get(
                result,
                f"https://api.unpaywall.org/v2/{doi_path}",
                {"email": self.email},
            )
            result.oa_status = "closed" if up.get("is_oa") is False else "unknown"
            locations = up.get("oa_locations", [])
            if isinstance(up.get("best_oa_location"), dict):
                locations = [
                    up["best_oa_location"],
                    *(locations if isinstance(locations, list) else []),
                ]
            if isinstance(locations, list):
                for location in locations:
                    if isinstance(location, dict):
                        url = location.get("url_for_pdf")
                        if not url and up.get("is_oa") is True:
                            candidate = location.get("url")
                            if isinstance(candidate, str) and httpx.URL(
                                candidate
                            ).path.lower().endswith((".xml", ".pdf")):
                                url = candidate
                        if isinstance(url, str) and url.startswith(
                            ("https://", "http://")
                        ):
                            result.full_text_urls.append(url)
                        landing = location.get("url_for_landing_page")
                        if isinstance(landing, str):
                            result.landing_page_url = landing
            if result.full_text_urls:
                result.full_text_urls = list(dict.fromkeys(result.full_text_urls))
                result.oa_status = "available"
        else:
            result.warnings.append("UNPAYWALL_EMAIL is required for OA lookup.")
        result.abstract = decode_abstract(oa.get("abstract_inverted_index"))
        if result.abstract:
            result.abstract_source = "openalex"
        else:
            semantic = await self._get(
                result,
                f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi_path}",
                {"fields": "abstract"},
            )
            if isinstance(semantic.get("abstract"), str):
                result.abstract, result.abstract_source = (
                    semantic["abstract"],
                    "semantic-scholar",
                )
        await self.transport.db.execute(
            "INSERT OR REPLACE INTO papers VALUES (?,?,?)",
            (result.doi, result.checked_at, result.model_dump_json()),
        )
        await self.transport.db.commit()
        return result
