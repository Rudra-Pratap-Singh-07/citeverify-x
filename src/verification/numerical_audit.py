"""Conservative comparisons of locally labeled metrics, units, and scope."""

from __future__ import annotations

import math
import re

from .models import AuditFinding, NumericalAudit, NumericEntity

_NUMBER = re.compile(
    r"(?<![\w.])(?:(?P<p>p)\s*)?(?P<op><=|>=|[=<>≤≥])?\s*"
    r"(?P<number>[+-]?(?:\d{1,3}(?:,\d{3})+|\d+|\.\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)"
    r"\s*(?P<unit>%|percent\b|percentage points?\b|milliseconds?\b|ms\b|seconds?\b|"
    r"minutes?\b|hours?\b|days?\b|kg\b|mg\b|g\b|patients?\b|participants?\b|"
    r"subjects?\b|samples?\b)?",
    re.IGNORECASE,
)
_METRIC = re.compile(
    r"\b(accuracy|precision|recall|sensitivity|specificity|mortality|survival|"
    r"dropout|response|risk|latency|duration|temperature|concentration|"
    r"sample size|n\s*=|effect size|odds ratio|reduction|increase|improvement)\b",
    re.IGNORECASE,
)
_IGNORE = re.compile(r"\[\s*\d+(?:\s*[-,–]\s*\d+)*\s*\]|\([^()]*,\s*(?:19|20)\d\d[a-z]?\)")


def extract_numbers(text: str) -> list[NumericEntity]:
    ignored = [m.span() for m in _IGNORE.finditer(text)]
    entities = []
    for match in _NUMBER.finditer(text):
        if any(left <= match.start() < right for left, right in ignored):
            continue
        value = float(match["number"].replace(",", ""))
        if not math.isfinite(value):
            continue
        start, end = match.start("number"), match.end("number")
        left = max(0, start - 65)
        before = text[left:start]
        after = text[end : min(len(text), end + 45)]
        # Do not inherit a metric label from a different sentence.
        before = re.split(r"[.!?;]\s+(?=[A-Z])", before)[-1]
        after = re.split(r"[.!?;]\s+", after)[0]
        labels = list(_METRIC.finditer(before))
        following = _METRIC.search(after)
        metric = labels[-1][0].lower() if labels else following[0].lower() if following else ""
        unit = (match["unit"] or "").lower()
        factor = 1.0
        if match["p"]:
            metric, unit = "p-value", "probability"
        elif unit in ("%", "percent"):
            unit = "%"
        elif unit.startswith("percentage point"):
            unit = "percentage_points"
        elif unit in ("ms", "millisecond", "milliseconds"):
            unit, factor = "seconds", 0.001
        elif unit.startswith("second"):
            unit = "seconds"
        elif unit.startswith("minute"):
            unit, factor = "seconds", 60
        elif unit.startswith("hour"):
            unit, factor = "seconds", 3600
        elif unit.startswith("day"):
            unit = "days"
        elif unit in ("mg", "kg", "g"):
            unit, factor = "grams", {"mg": 0.001, "kg": 1000, "g": 1}[unit]
        elif (
            unit
            or metric in ("sample size", "n=")
            or re.search(r"\bn\s*=\s*$", before, re.IGNORECASE)
        ):
            unit, metric = "count", "sample size"
        # Bare publication years and unlabeled numbers are retained as diagnostics.
        if 1800 <= value <= 2100 and not metric and not unit:
            continue
        if not math.isfinite(value * factor):
            continue
        entities.append(
            NumericEntity(
                text=text[match.start() : match.end()].strip(),
                value=value * factor,
                unit=unit or "number",
                metric=metric,
                comparator=(match["op"] or "=").replace("≤", "<=").replace("≥", ">="),
                start=match.start(),
                end=match.end(),
                context=text[max(0, start - 65) : min(len(text), end + 65)],
            )
        )
    return entities


def _interval(entity: NumericEntity) -> tuple[float, float, bool, bool]:
    value, op = entity.value, entity.comparator
    if op in ("<", "<="):
        return -math.inf, value, False, op == "<="
    if op in (">", ">="):
        return value, math.inf, op == ">=", False
    return value, value, True, True


def _disjoint(a: NumericEntity, b: NumericEntity) -> bool:
    al, ar, alc, arc = _interval(a)
    bl, br, blc, brc = _interval(b)
    return (
        ar < bl or br < al or (ar == bl and not (arc and blc)) or (br == al and not (brc and alc))
    )


def audit_numbers(claim: str, evidence: str, threshold: float = 0.05) -> NumericalAudit:
    if not 0 <= threshold < 1:
        raise ValueError("threshold must be between zero and one")
    claims, sources = extract_numbers(claim), extract_numbers(evidence)
    findings = []
    for entity in claims:
        candidates = [
            s
            for s in sources
            if entity.metric and (s.metric, s.unit) == (entity.metric, entity.unit)
        ]
        if not candidates:
            findings.append(
                AuditFinding(
                    kind="unmatched",
                    claim_entity=entity,
                    explanation=f"No comparable {entity.metric or 'labeled metric'} for {entity.text!r} in this passage.",
                )
            )
            continue
        unique = {(s.value, s.comparator) for s in candidates}
        if len(unique) > 1:
            findings.append(
                AuditFinding(
                    kind="ambiguous",
                    claim_entity=entity,
                    explanation=f"Multiple {entity.metric} measurements occur in the passage; population or time needs review.",
                )
            )
            continue
        source = candidates[0]
        relative = None
        if entity.comparator == source.comparator == "=":
            relative = (
                abs(entity.value - source.value) / abs(source.value) if source.value else None
            )
            mismatch = (
                entity.value != 0
                if source.value == 0
                else bool(relative is not None and relative > threshold + 1e-12)
            )
        else:
            mismatch = _disjoint(entity, source)
        if relative is not None and not math.isfinite(relative):
            relative = None
        if mismatch:
            findings.append(
                AuditFinding(
                    kind="numeric_mismatch",
                    claim_entity=entity,
                    evidence_entity=source,
                    relative_difference=relative,
                    explanation=f"Claim states {entity.text} for {entity.metric}, but cited passage reports {source.text}.",
                )
            )
    human = re.compile(r"\b(humans?|patients?|people)\b", re.IGNORECASE)
    animal = re.compile(r"\b(mice|rats|murine|animals?)\b", re.IGNORECASE)
    if human.search(claim) and animal.search(evidence) and not human.search(evidence):
        findings.append(
            AuditFinding(
                kind="scope_mismatch",
                explanation="The claim concerns humans, while this passage describes an animal population.",
            )
        )
    if re.search(
        r"\b(?:all|every)\s+(?:patients?|participants?|subjects?)\b", claim, re.IGNORECASE
    ) and re.search(
        r"\b(?:some|subset of)\s+(?:patients?|participants?|subjects?)\b", evidence, re.IGNORECASE
    ):
        findings.append(
            AuditFinding(
                kind="scope_mismatch",
                explanation="The claim generalizes to all participants, but the passage describes a subset.",
            )
        )
    return NumericalAudit(claim_entities=claims, evidence_entities=sources, findings=findings)
