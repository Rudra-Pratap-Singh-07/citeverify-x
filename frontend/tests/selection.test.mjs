import test from "node:test";
import assert from "node:assert/strict";
import {
  adjacentClaim,
  primaryCheckIndex,
  selectedPassageIndex,
} from "../lib/selection.ts";

const checks = [
  {
    state: "checked",
    verdict: {
      label: "SUPPORTED",
      selected_passage_id: "support",
      evidence: [{ passage: { passage_id: "support" } }],
    },
  },
  {
    state: "checked",
    verdict: {
      label: "CONTRADICTED",
      selected_passage_id: "proof",
      evidence: [
        { passage: { passage_id: "other" } },
        { passage: { passage_id: "proof" } },
      ],
    },
  },
];
test("a conflicting second citation opens on the verdict-causing source and selected proof", () => {
  const claim = { label: "CONTRADICTED", checks };
  const index = primaryCheckIndex(claim);
  assert.equal(index, 1);
  assert.equal(selectedPassageIndex(claim, index), 1);
});
test("an unresolved claim or missing selected passage still opens a safe first item", () => {
  assert.equal(
    primaryCheckIndex({
      label: null,
      checks: [{ state: "unresolved", verdict: null }],
    }),
    0,
  );
  assert.equal(
    selectedPassageIndex(
      {
        checks: [{ verdict: { selected_passage_id: "missing", evidence: [] } }],
      },
      0,
    ),
    0,
  );
  assert.equal(selectedPassageIndex({ checks: [] }, 0), 0);
});
test("K enters at the final discrepancy when current claim is outside the flagged list", () => {
  const claims = [
    { claim_id: "flag1" },
    { claim_id: "flag2" },
    { claim_id: "flag3" },
  ];
  assert.equal(adjacentClaim(claims, "supported", -1), claims[2]);
  assert.equal(adjacentClaim(claims, "supported", 1), claims[0]);
  assert.equal(adjacentClaim(claims, "flag1", -1), claims[2]);
  assert.equal(adjacentClaim(claims, "flag3", 1), claims[0]);
  assert.equal(adjacentClaim([], "anything", 1), undefined);
});
