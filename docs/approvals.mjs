// Pure helpers for the Approvals panel (shared by the page and tests). No DOM, no globals.

export const GRACE_MS = 30e3; // an expired approval stays visible (disabled) this long, then drops
export const RECENT_MAX = 10;

const gated = (j) => j?.mode === 'ops' || j?.mode === 'full';
const isOpen = (j, now) => Number.isFinite(j.approvalExpiresAt) && now < j.approvalExpiresAt;

// Jobs awaiting approval, newest first. Expired ones linger for GRACE_MS so the state change is visible.
export function pendingApprovals(jobs, now) {
  return (jobs || [])
    .filter((j) => j?.status === 'awaiting-approval' && (!Number.isFinite(j.approvalExpiresAt) || now < j.approvalExpiresAt + GRACE_MS))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export const openApprovals = (jobs, now) => pendingApprovals(jobs, now).filter((j) => isOpen(j, now));

// Soonest expiry among approvals that can still be approved, or null.
export function soonestExpiry(jobs, now) {
  const ts = openApprovals(jobs, now).map((j) => j.approvalExpiresAt);
  return ts.length ? Math.min(...ts) : null;
}

const settledAt = (j) => j.endedAt || j.startedAt || j.createdAt || 0;

// Last n resolved ops/full jobs, newest first.
export function recentResolved(jobs, now, n = RECENT_MAX) {
  return (jobs || [])
    .filter((j) => gated(j) && j.status !== 'awaiting-approval')
    .sort((a, b) => settledAt(b) - settledAt(a))
    .slice(0, n);
}

// Resolved jobs in two groups: ones that ran (done, failed, killed...) and ones that never did (expired, denied), each capped.
export function resolvedGroups(jobs, now, n = RECENT_MAX) {
  const all = recentResolved(jobs, now, Infinity);
  return { ran: all.filter((j) => j.status !== 'expired' && j.status !== 'denied').slice(0, n), lapsed: all.filter((j) => j.status === 'expired' || j.status === 'denied').slice(0, n) };
}

const OUTCOME = { done: 'Approved · done', failed: 'Failed', denied: 'Denied', expired: 'Expired', cancelled: 'Cancelled', running: 'Approved · running', queued: 'Approved · queued', killing: 'Killing' };
export function outcomeLabel(j) {
  if (j.status === 'failed' && /^killed/i.test(j.result || '')) return 'Killed';
  return OUTCOME[j.status] || j.status;
}

// "4:32" for under an hour, "1h 05m" beyond; "0:00" once past.
export function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Open approvals whose id is not in `seen`. Mutates `seen` so a job is only ever reported once.
// The first snapshot (seen === null) only seeds: approvals already pending at page load are not "new".
export function newApprovals(jobs, seen, now) {
  const open = openApprovals(jobs, now);
  if (!seen) return { fresh: [], seen: new Set(open.map((j) => j.id)) };
  const fresh = open.filter((j) => !seen.has(j.id));
  for (const j of fresh) seen.add(j.id);
  return { fresh, seen };
}
