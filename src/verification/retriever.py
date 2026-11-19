"""BM25 plus dense reciprocal-rank fusion, with reusable per-paper indexes."""

from __future__ import annotations

import hashlib
import math
import re
import threading
from collections import Counter, OrderedDict
from collections.abc import Sequence
from typing import Any, Protocol

import numpy as np
from numpy.typing import NDArray

from .models import Passage, RankedPassage

Vectors = NDArray[np.float32]


class Encoder(Protocol):
    model_name: str

    def encode(self, texts: Sequence[str]) -> Vectors: ...


class SentenceTransformerEncoder:
    def __init__(
        self,
        model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
        device: str = "cpu",
        batch_size: int = 32,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        self.model_name, self.device, self.batch_size = model_name, device, batch_size
        self._model: Any = None
        self._lock = threading.Lock()

    def encode(self, texts: Sequence[str]) -> Vectors:
        with self._lock:
            if self._model is None:
                from sentence_transformers import SentenceTransformer

                self._model = SentenceTransformer(self.model_name, device=self.device)
            # Encode every token, including the tail of a 150-word scientific passage.
            # MiniLM's usual 256-token limit can otherwise silently discard evidence.
            tokenizer = self._model.tokenizer
            budget = self._model.max_seq_length - tokenizer.num_special_tokens_to_add(False)
            pieces, owners, weights = [], [], []
            for i, text in enumerate(texts):
                tokens = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
                offsets = tokens["offset_mapping"]
                for start in range(0, len(offsets), budget):
                    end = min(start + budget, len(offsets))
                    pieces.append(text[offsets[start][0] : offsets[end - 1][1]])
                    owners.append(i)
                    weights.append(end - start)
            if not pieces:
                raise ValueError("Cannot encode empty texts")
            vectors = self._model.encode(
                pieces,
                batch_size=self.batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            pooled = np.zeros((len(texts), vectors.shape[1]), dtype=np.float32)
            for owner, weight, vector in zip(owners, weights, vectors, strict=True):
                pooled[owner] += weight * vector
            return _normalize(pooled)


def _normalize(vectors: Vectors) -> Vectors:
    values = np.asarray(vectors, dtype=np.float32)
    if values.ndim != 2 or not np.isfinite(values).all():
        raise ValueError("Encoder returned malformed vectors")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if (norms == 0).any():
        raise ValueError("Encoder returned a zero vector")
    return values / norms


def chunk_text(text: str, window: int = 150, overlap: int = 50) -> list[Passage]:
    if not 0 <= overlap < window:
        raise ValueError("Require 0 <= overlap < window")
    words = list(re.finditer(r"\S+", text))
    digest = hashlib.sha256(text.encode()).hexdigest()[:16]
    result = []
    for start in range(0, len(words), window - overlap):
        end = min(start + window, len(words))
        left, right = words[start].start(), words[end - 1].end()
        result.append(
            Passage(
                passage_id=f"{digest}:{left}:{right}",
                text=text[left:right],
                start_char=left,
                end_char=right,
                start_word=start,
                end_word=end,
            )
        )
        if end == len(words):
            break
    return result


def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.casefold())


class PaperIndex:
    def __init__(self, passages: list[Passage], vectors: Vectors) -> None:
        self.passages, self.vectors = passages, _normalize(vectors)
        if len(passages) != len(vectors):
            raise ValueError("Passage and embedding counts differ")
        self.counts = [Counter(_tokens(p.text)) for p in passages]
        self.lengths = np.asarray([sum(c.values()) for c in self.counts])
        self.average_length = max(float(self.lengths.mean()), 1)
        self.frequency = Counter(token for counts in self.counts for token in counts)

    def rank(self, claim: str, vector: Vectors, top_k: int) -> list[RankedPassage]:
        scores = np.zeros(len(self.passages))
        for term in set(_tokens(claim)):
            frequency = np.asarray([counts[term] for counts in self.counts])
            df = self.frequency[term]
            idf = math.log(1 + (len(scores) - df + 0.5) / (df + 0.5))
            scores += (
                idf
                * frequency
                * 2.5
                / (frequency + 1.5 * (0.25 + 0.75 * self.lengths / self.average_length))
            )
        cosine = self.vectors @ _normalize(vector)[0]
        fusion = np.zeros(len(scores))
        for values in (scores, cosine):
            for rank, i in enumerate(np.argsort(-values, kind="stable"), 1):
                # Zero lexical matches must not arbitrarily favor the first passage.
                if values is cosine or values[i] > 0:
                    fusion[i] += 1 / (60 + rank)
        order = np.argsort(-fusion, kind="stable")[:top_k]
        return [
            RankedPassage(
                **self.passages[i].model_dump(),
                bm25_score=float(scores[i]),
                cosine_score=float(cosine[i]),
                fusion_score=float(fusion[i]),
            )
            for i in order
        ]


class HybridRetriever:
    def __init__(self, encoder: Encoder | None = None, cache_size: int = 8) -> None:
        if cache_size < 1:
            raise ValueError("cache_size must be positive")
        self.encoder = encoder or SentenceTransformerEncoder()
        self.cache_size = cache_size
        self._cache: OrderedDict[str, PaperIndex] = OrderedDict()
        self._lock = threading.Lock()

    def retrieve(self, claim: str, text: str, top_k: int = 3) -> list[RankedPassage]:
        if not claim.strip() or top_k < 1:
            raise ValueError("A nonempty claim and positive top_k are required")
        passages = chunk_text(text)
        if not passages:
            return []
        key = hashlib.sha256(text.encode()).hexdigest()
        with self._lock:
            index = self._cache.get(key)
            if index is None:
                index = PaperIndex(passages, self.encoder.encode([p.text for p in passages]))
                self._cache[key] = index
                if len(self._cache) > self.cache_size:
                    self._cache.popitem(last=False)
            self._cache.move_to_end(key)
            query = self.encoder.encode([claim])
        return index.rank(claim, query, top_k)
