const pendingKey = "citeverify-pending-task";
export type PendingAudit = { id: string; filename: string };
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

/** Storage is optional: private browsing and full quotas must not block an audit. */
export function pendingAudit(): PendingAudit | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey) || "null");
    return value && validId(value.id) && typeof value.filename === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function savePendingAudit(value: PendingAudit) {
  try {
    localStorage.setItem(pendingKey, JSON.stringify(value));
  } catch {}
}
export function clearPendingAudit(id?: string) {
  try {
    if (!id || pendingAudit()?.id === id) localStorage.removeItem(pendingKey);
  } catch {}
}
export function lastAudit(): string {
  try {
    const value = localStorage.getItem("citeverify-task");
    return validId(value) ? value : "";
  } catch {
    return "";
  }
}
export function rememberAudit(id: string) {
  try {
    localStorage.setItem("citeverify-task", id);
  } catch {}
}
