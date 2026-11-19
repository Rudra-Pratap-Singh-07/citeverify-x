"use client";
import { useEffect, useState } from "react";
import { useReducedMotion as useSystemReducedMotion } from "framer-motion";

/** OS preference plus a shareable, local preview override for motion QA. */
export function useReducedMotion() {
  const system = useSystemReducedMotion();
  const [override, setOverride] = useState(false);
  useEffect(() => {
    const value =
      new URLSearchParams(window.location.search).get("motion") === "reduce";
    setOverride(value);
    document.documentElement.toggleAttribute("data-reduced-motion", value);
  }, []);
  return !!system || override;
}
