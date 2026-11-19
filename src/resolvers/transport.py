"""Asynchronous response cache and per-host request pacing."""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import time
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import aiosqlite
import httpx


class SourceError(RuntimeError):
    """A source was unavailable or returned malformed data."""


class Transport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        db: aiosqlite.Connection,
        interval: float = 1,
        attempts: int = 4,
    ) -> None:
        self.client, self.db = client, db
        self.interval, self.attempts = interval, attempts
        self.locks: dict[str, asyncio.Lock] = {}
        self.next_request: dict[str, float] = {}

    @classmethod
    async def open(
        cls, client: httpx.AsyncClient, path: Path, **kwargs: Any
    ) -> Transport:
        path.parent.mkdir(parents=True, exist_ok=True)
        db = await aiosqlite.connect(path)
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA busy_timeout=10000")
        await db.execute(
            "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, expires REAL, payload TEXT)"
        )
        await db.execute(
            "CREATE TABLE IF NOT EXISTS papers (doi TEXT PRIMARY KEY, checked REAL, payload TEXT)"
        )
        await db.execute(
            "CREATE TABLE IF NOT EXISTS retractions (doi TEXT, payload TEXT)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS retractions_doi ON retractions(doi)"
        )
        await db.execute(
            "CREATE TABLE IF NOT EXISTS sync_state (name TEXT PRIMARY KEY, checked REAL)"
        )
        await db.commit()
        return cls(client, db, **kwargs)

    async def pace(self, url: str) -> None:
        host = httpx.URL(url).host
        async with self.locks.setdefault(host, asyncio.Lock()):
            await asyncio.sleep(
                max(0, self.next_request.get(host, 0) - time.monotonic())
            )
            self.next_request[host] = time.monotonic() + self.interval

    async def get(
        self, url: str, params: dict[str, str] | None = None
    ) -> dict[str, Any]:
        key = hashlib.sha256(
            json.dumps([url, params], sort_keys=True).encode()
        ).hexdigest()
        async with self.db.execute(
            "SELECT payload FROM responses WHERE key=? AND expires>?",
            (key, time.time()),
        ) as cursor:
            row = await cursor.fetchone()
        if row:
            return json.loads(row[0])
        for attempt in range(self.attempts):
            await self.pace(url)
            response = None
            try:
                response = await self.client.get(url, params=params)
                if response.status_code == 404:
                    return {}
                if response.status_code != 429 and response.status_code < 500:
                    response.raise_for_status()
                    data = response.json()
                    if not isinstance(data, dict):
                        raise ValueError("Expected an object")
                    await self.db.execute(
                        "INSERT OR REPLACE INTO responses VALUES (?,?,?)",
                        (key, time.time() + 86400, json.dumps(data)),
                    )
                    await self.db.commit()
                    return data
                if attempt == self.attempts - 1:
                    raise SourceError(
                        f"{httpx.URL(url).host}: HTTP {response.status_code}"
                    )
            except (httpx.TimeoutException, httpx.NetworkError):
                if attempt == self.attempts - 1:
                    raise SourceError(
                        f"{httpx.URL(url).host}: network failure"
                    ) from None
            except (httpx.HTTPStatusError, ValueError) as exc:
                raise SourceError(
                    f"{httpx.URL(url).host}: invalid response ({type(exc).__name__})"
                ) from None
            delay = min(30, 2**attempt + random.random())
            retry = (
                response.headers.get("Retry-After") if response is not None else None
            )
            if retry:
                try:
                    delay = max(delay, float(retry))
                except ValueError:
                    try:
                        delay = max(
                            delay,
                            parsedate_to_datetime(retry).timestamp() - time.time(),
                        )
                    except (ValueError, TypeError, OverflowError):
                        pass
            if delay > 120:
                raise SourceError(f"{httpx.URL(url).host}: retry deferred by provider")
            await asyncio.sleep(delay)
        raise SourceError("Request failed")
