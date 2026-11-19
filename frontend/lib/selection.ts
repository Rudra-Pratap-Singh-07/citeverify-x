import type { Claim } from "./types";

/** Start on the citation responsible for a claim's combined verdict. */
export function primaryCheckIndex(claim: Claim): number {
  const match = claim.checks.findIndex(
    (c) => c.state === "checked" && c.verdict?.label === claim.label,
  );
  return match < 0 ? 0 : match;
}
export function selectedPassageIndex(claim: Claim, index: number): number {
  const verdict = claim.checks[index]?.verdict;
  return Math.max(
    0,
    verdict?.evidence.findIndex(
      (e) => e.passage.passage_id === verdict.selected_passage_id,
    ) ?? 0,
  );
}
export function adjacentClaim(
  claims: Claim[],
  selected: string,
  direction: 1 | -1,
): Claim | undefined {
  if (!claims.length) return undefined;
  const index = claims.findIndex((c) => c.claim_id === selected);
  return claims[
    index < 0
      ? direction === 1
        ? 0
        : claims.length - 1
      : (index + direction + claims.length) % claims.length
  ];
}
