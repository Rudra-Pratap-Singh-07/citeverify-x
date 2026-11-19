import asyncio
from pathlib import Path

import httpx

from parser.document_ingest import ReferenceItem
from resolvers.scholarly_resolver import ScholarlyResolver, decode_abstract


def reference(doi="10.1234/test"):
    return ReferenceItem(
        raw_text="Ray. A controlled trial. 2020.",
        anchor_id="1",
        parsed_authors=["Ray"],
        parsed_title="A controlled trial",
        parsed_year=2020,
        parsed_doi=doi,
    )


def test_resolution_retraction_and_cached_sources(tmp_path: Path):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        host = request.url.host
        if host == "gitlab.com":
            return httpx.Response(
                200,
                text="OriginalPaperDOI,RetractionNature,Reason,RetractionDate,Journal\n"
                "10.1234/test,Retraction,Fabrication,2025-02-01,Journal of Trials\n",
            )
        if host == "api.openalex.org":
            return httpx.Response(
                200,
                json={
                    "title": "A controlled trial",
                    "publication_year": 2020,
                    "is_retracted": False,
                    "abstract_inverted_index": {"A": [0], "trial": [1]},
                },
            )
        if host == "api.crossref.org":
            return httpx.Response(
                200,
                json={
                    "message": {
                        "title": ["A controlled trial"],
                        "container-title": ["Journal of Trials"],
                        "author": [{"family": "Ray"}],
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "is_oa": True,
                "oa_locations": [{"url_for_pdf": "https://example.org/paper.pdf"}],
            },
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async with ScholarlyResolver(
                tmp_path / "cache.db",
                client=client,
                interval=0,
                email="reader@example.org",
            ) as resolver:
                result = await resolver.resolve(reference())
                assert result.status == "resolved"
                assert result.retraction_status == "retracted"
                assert result.retraction_events[0]["reasons"] == "Fabrication"
                assert result.abstract == "A trial"
                assert result.full_text_urls == ["https://example.org/paper.pdf"]
                count = len(calls)
                await resolver.resolve(reference())
                assert len(calls) == count

    asyncio.run(run())


def test_invalid_and_ambiguous(tmp_path: Path):
    def handler(request):
        return httpx.Response(
            200,
            json={
                "message": {
                    "items": [
                        {"DOI": "10.1234/a", "title": ["A controlled trial"]},
                        {"DOI": "10.1234/b", "title": ["A controlled trial"]},
                    ]
                }
            },
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async with ScholarlyResolver(
                tmp_path / "cache.db", client=client, interval=0
            ) as resolver:
                assert (
                    await resolver.resolve(reference("bad doi"))
                ).status == "invalid_doi"
                assert (await resolver.resolve(reference(None))).status == "ambiguous"

    asyncio.run(run())


def test_malformed_abstract():
    assert decode_abstract({"bad": [0, 0]}) is None
    assert decode_abstract({"bad": [2]}) is None
    assert decode_abstract({"second": [1], "first": [0]}) == "first second"


def test_retry_and_unavailable_retraction_is_unknown(tmp_path: Path, monkeypatch):
    from resolvers import transport

    calls = 0

    async def sleep(delay):
        return None

    monkeypatch.setattr(transport.asyncio, "sleep", sleep)

    def handler(request):
        nonlocal calls
        if request.url.host == "api.openalex.org":
            calls += 1
            if calls == 1:
                return httpx.Response(429, headers={"Retry-After": "1"})
            return httpx.Response(200, json={"title": "A trial", "is_retracted": False})
        if request.url.host == "gitlab.com":
            return httpx.Response(200, text="unexpected,data\n")
        if request.url.host == "api.unpaywall.org":
            return httpx.Response(200, json={"is_oa": False})
        if request.url.host == "api.semanticscholar.org":
            return httpx.Response(200, json={"abstract": "A fallback abstract."})
        return httpx.Response(404)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async with ScholarlyResolver(
                tmp_path / "cache.db",
                client=client,
                interval=0,
                email="reader@example.org",
            ) as resolver:
                result = await resolver.resolve(reference())
                assert result.status == "resolved" and calls == 2
                assert result.retraction_status == "unknown"
                assert not result.retraction_watch_checked
                assert result.oa_status == "closed"
                assert result.abstract_source == "semantic-scholar"
                assert result.warnings == ["Malformed Retraction Watch feed"]

    asyncio.run(run())
