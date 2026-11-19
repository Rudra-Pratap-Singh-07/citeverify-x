"use client";
import { useEffect, useState } from "react";
import { API, ApiError, request } from "./api";
import { clearPendingAudit } from "./auditSession";
import { Progress, Report } from "./types";
export function useAudit(id: string) {
  const [report, setReport] = useState<Report | null>(null);
  const [event, setEvent] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [fatal, setFatal] = useState(false);
  useEffect(() => {
    setFatal(false);
    if (!id) {
      setReport(null);
      setEvent(null);
      setError("");
      return;
    }
    let alive = true,
      done = false,
      fetching = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    let socket: WebSocket | undefined;
    const controller = new AbortController();
    setReport(null);
    setError("");
    setEvent(null);
    async function accept(e: Progress) {
      if (!alive || done || !e) return;
      if (e.sequence >= cursor) {
        cursor = e.sequence;
        setEvent(e);
        setError("");
      }
      if (e.stage === "Failed") {
        done = true;
        setFatal(true);
        clearPendingAudit(id);
        setError(e.message);
      }
      if (e.stage === "Complete" && !fetching) {
        fetching = true;
        try {
          const r = await request<Report>(`/api/v1/verify/report/${id}`, {
            signal: controller.signal,
          });
          if (alive) {
            setReport(r);
            done = true;
            setError("");
            clearPendingAudit(id);
          }
        } catch (e) {
          if (alive)
            setError("The completed report could not be loaded. Reconnecting…");
        } finally {
          fetching = false;
        }
      }
    }
    async function poll() {
      try {
        const s = await request<{ events: Progress[] }>(
          `/api/v1/verify/status/${id}`,
          { signal: controller.signal },
        );
        if (alive) await accept(s.events.at(-1)!);
      } catch (e) {
        if (alive) {
          if (e instanceof ApiError && e.status === 404) {
            done = true;
            setFatal(true);
            clearPendingAudit(id);
            setError(
              "This audit is no longer available on the server. Start a new investigation.",
            );
            socket?.close();
          } else
            setError(
              "Connection interrupted. Reconnecting to your saved audit…",
            );
        }
      }
      if (alive && !done) timer = setTimeout(poll, 2000);
    }
    void poll();
    try {
      socket = new WebSocket(
        `${API.replace(/^http/, "ws")}/api/v1/verify/stream/${id}`,
      );
      socket.onmessage = (e) => {
        try {
          void accept(JSON.parse(e.data));
        } catch {}
      };
      socket.onerror = () => {};
    } catch {}
    return () => {
      alive = false;
      clearTimeout(timer);
      socket?.close();
      controller.abort();
    };
  }, [id, attempt]);
  return {
    report,
    event,
    error,
    fatal,
    retry: () => setAttempt((value) => value + 1),
  };
}
