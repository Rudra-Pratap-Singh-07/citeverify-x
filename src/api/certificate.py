"""Printable executive audit summary, including gaps and all checked claims."""

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

from .models import AuditReport


def certificate_pdf(report: AuditReport) -> bytes:
    buffer = BytesIO()
    styles = getSampleStyleSheet()
    font_path = Path("C:/Windows/Fonts/arial.ttf")
    font = "Helvetica"
    if font_path.exists():
        if "AuditArial" not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont("AuditArial", str(font_path)))
        font = "AuditArial"
    for name in ("Normal", "Title", "Heading2", "Heading3"):
        styles[name].fontName = font
    styles["Normal"].fontSize, styles["Normal"].leading = 10, 15
    styles["Title"].textColor = colors.HexColor("#1c3151")
    content = []

    def paragraph(text: str, style: str = "Normal") -> None:
        content.append(Paragraph(escape(text), styles[style]))
        content.append(Spacer(1, 8))

    paragraph("CiteVerify-X", "Heading2")
    paragraph("Executive Verification Certificate", "Title")
    paragraph(
        "Automated evidence audit | "
        + ("SYNTHETIC DEMO" if report.demo else "Reviewer copy")
    )
    paragraph(f"Manuscript: {report.filename}")
    paragraph(f"Audit ID: {report.task_id} | Completed: {report.completed_at}")
    paragraph(
        "SHA-256 report fingerprint: "
        + hashlib.sha256(report.model_dump_json().encode()).hexdigest()
    )
    s = report.summary
    score = (
        f"{s.veracity_score:.0f}%" if s.veracity_score is not None else "Not assessed"
    )
    paragraph(f"Manuscript veracity score (evidence support): {score}", "Heading2")
    paragraph(
        f"Claims assessed: {s.claims_assessed}/{s.total_claims} | Citation links audited: "
        f"{s.citations_audited}/{s.total_citations} | Retractions: {s.retraction_alerts} | "
        f"Expressions of concern: {s.concern_alerts}"
    )
    paragraph(s.score_method)
    for warning in report.warnings:
        paragraph(warning)
    for i, claim in enumerate(report.claims, 1):
        paragraph(f"Claim {i} - page {claim.page_number}", "Heading2")
        paragraph(claim.sentence_text)
        for check in claim.checks:
            label = (
                check.verdict.label.value
                if check.verdict and check.state == "checked"
                else check.state
            )
            paragraph(
                f"Citation {check.anchor_id}: {label.replace('_', ' ')}", "Heading3"
            )
            if check.paper:
                p = check.paper
                paragraph(f"{p.title or 'Unresolved title'} | {', '.join(p.authors)}")
                paragraph(
                    f"DOI: {p.doi or 'Unavailable'} | Integrity: {p.retraction_status}"
                )
                for event in p.retraction_events:
                    paragraph(
                        f"Notice: {event.get('nature', '')}; {event.get('date', '')}; "
                        f"{event.get('reasons', '')}"
                    )
            paragraph(check.message or "No evidence available")
            if check.verdict:
                v = check.verdict
                paragraph(
                    f"Evidence basis: {v.source_kind} | Uncalibrated model score: {v.confidence:.3f}"
                )
                selected = next(
                    (
                        e
                        for e in v.evidence
                        if e.passage.passage_id == v.selected_passage_id
                    ),
                    None,
                )
                if selected:
                    paragraph(selected.passage.text)
                    for finding in selected.audit.findings:
                        paragraph(finding.explanation)
                for warning in v.warnings:
                    paragraph(warning)
    if not report.claims:
        paragraph(
            "No cited empirical claims were extracted. The document has not received a positive verification."
        )

    def footer(canvas, document) -> None:
        canvas.setFont("Helvetica", 8)
        canvas.drawString(0.7 * inch, 0.4 * inch, f"CiteVerify-X | {report.task_id}")
        canvas.drawRightString(7.6 * inch, 0.4 * inch, f"Page {document.page}")

    SimpleDocTemplate(
        buffer,
        pagesize=(8.3 * inch, 11.7 * inch),
        rightMargin=0.7 * inch,
        leftMargin=0.7 * inch,
        topMargin=0.65 * inch,
        bottomMargin=0.7 * inch,
        title="Executive Verification Certificate",
    ).build(content, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
