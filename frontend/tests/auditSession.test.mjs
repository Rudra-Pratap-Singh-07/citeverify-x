import test from "node:test";
import assert from "node:assert/strict";
import {
  pendingAudit,
  savePendingAudit,
  clearPendingAudit,
  lastAudit,
  rememberAudit,
} from "../lib/auditSession.ts";

test("refresh can recover a pending audit, and clearing another job preserves it", () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const pending = { id: "a".repeat(32), filename: "Manuscript.pdf" };
  savePendingAudit(pending);
  assert.deepEqual(pendingAudit(), pending);
  clearPendingAudit("b".repeat(32));
  assert.deepEqual(pendingAudit(), pending);
  clearPendingAudit(pending.id);
  assert.equal(pendingAudit(), null);
  rememberAudit(pending.id);
  assert.equal(lastAudit(), pending.id);
});
test("bad persisted values and unavailable browser storage never block the UI", () => {
  globalThis.localStorage = {
    getItem: () => "{broken",
    setItem: () => {
      throw Error("QuotaExceeded");
    },
    removeItem: () => {
      throw Error("blocked");
    },
  };
  assert.equal(pendingAudit(), null);
  assert.equal(lastAudit(), "");
  assert.doesNotThrow(() =>
    savePendingAudit({ id: "a".repeat(32), filename: "test.pdf" }),
  );
  assert.doesNotThrow(() => rememberAudit("a".repeat(32)));
  assert.doesNotThrow(() => clearPendingAudit());
});
