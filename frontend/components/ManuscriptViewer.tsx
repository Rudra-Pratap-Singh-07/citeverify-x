"use client";
import { useEffect, useState } from "react";
import { Viewer, Worker } from "@react-pdf-viewer/core";
import { highlightPlugin, Trigger } from "@react-pdf-viewer/highlight";
import { zoomPlugin } from "@react-pdf-viewer/zoom";
import { API } from "../lib/api";
import { Report, tone, labelText } from "../lib/types";
export default function ManuscriptViewer({
  report,
  selected,
  onSelect,
}: {
  report: Report;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const areas = report.claims.flatMap((c) =>
    c.highlights.flatMap((h) => {
      const p = report.pages.find((p) => p.page_number === h.page_number);
      return p
        ? [
            {
              id: c.claim_id,
              label: c.label,
              text: c.sentence_text,
              pageIndex: h.page_number - 1,
              left: (100 * h.bounding_box.x0) / p.width,
              top: (100 * h.bounding_box.y0) / p.height,
              width: (100 * (h.bounding_box.x1 - h.bounding_box.x0)) / p.width,
              height:
                (100 * (h.bounding_box.y1 - h.bounding_box.y0)) / p.height,
            },
          ]
        : [];
    }),
  );
  const highlights = highlightPlugin({
    trigger: Trigger.None,
    renderHighlights: (props) => (
      <>
        {areas
          .filter((a) => a.pageIndex === props.pageIndex)
          .map((a, i) => (
            <button
              key={i}
              title={a.text}
              aria-label={`${labelText(a.label)}: ${a.text}`}
              className={`pdf-highlight ${tone(a.label)} ${a.id === selected ? "selected" : ""}`}
              style={props.getCssProperties(a, props.rotation)}
              onClick={() => onSelect(a.id)}
            />
          ))}
      </>
    ),
  });
  const zoom = zoomPlugin();
  const { ZoomInButton, ZoomOutButton, CurrentScale } = zoom;
  useEffect(() => {
    const a = areas.find((a) => a.id === selected);
    if (a && loaded) highlights.jumpToHighlightArea(a);
  }, [selected, loaded]);
  return (
    <>
      <div className="pdf-tools">
        <span>
          {report.pages.length} page{report.pages.length === 1 ? "" : "s"}
        </span>
        <div>
          <ZoomOutButton />
          <CurrentScale />
          <ZoomInButton />
        </div>
      </div>
      <div className="pdf-canvas">
        <Worker workerUrl="/pdf.worker.min.js">
          <Viewer
            fileUrl={`${API}/api/v1/verify/document/${report.task_id}`}
            plugins={[highlights, zoom]}
            onDocumentLoad={() => setLoaded(true)}
            renderError={() => (
              <p className="notice">
                PDF preview unavailable. Select a claim below to review its
                evidence.
              </p>
            )}
          />
        </Worker>
      </div>
    </>
  );
}
