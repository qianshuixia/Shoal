import type { Task } from '../shared/protocol.ts';

const DAY_MS = 24 * 3600 * 1000;

function taskLastTouched(t: Task): number {
  return Math.max(t.phaseSince, t.lastActiveAt ?? 0, t.createdAt);
}

// Approved tasks nobody touched for longer than maxAgeMs whose session is gone or ended: they go to 已归档.
// liveSessionIds are the sessions still running; a task with a live session is still in use and stays.
export function staleApproved(tasks: Task[], liveSessionIds: Set<string>, now: number, maxAgeMs: number): Task[] {
  if (maxAgeMs <= 0) return [];
  return tasks.filter(
    t => t.phase === 'approved' && !(t.sessionId && liveSessionIds.has(t.sessionId)) && now - taskLastTouched(t) > maxAgeMs,
  );
}

// Conservative auto-archive sweep:
// - approved + exited: archived after approvedMaxAgeMs (default 1 day; user already clicked 通过)
// - active + exited: archived after inactiveMaxAgeMs (default 14 days of zero activity)
// - review (待验收) or any live session: NEVER auto-archived.
export function staleTasks(
  tasks: Task[],
  liveSessionIds: Set<string>,
  now: number,
  approvedMaxAgeMs: number,
  inactiveMaxAgeMs = 0,
): Task[] {
  return tasks.filter(t => {
    if (t.sessionId && liveSessionIds.has(t.sessionId)) return false;
    const age = now - taskLastTouched(t);
    if (t.phase === 'approved') return approvedMaxAgeMs > 0 && age > approvedMaxAgeMs;
    if (t.phase === 'active') return inactiveMaxAgeMs > 0 && age > inactiveMaxAgeMs;
    return false;
  });
}

function parseDaysMs(env: string | undefined, defaultDays: number): number {
  const days = env === undefined || env.trim() === '' ? defaultDays : Number(env);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
}

// WORKBENCH_AUTO_ARCHIVE_DAYS: days before an approved, stopped task is archived (default 1 = 24h); 0 disables.
export function autoArchiveMs(env: string | undefined): number {
  return parseDaysMs(env, 1);
}

// WORKBENCH_AUTO_ARCHIVE_INACTIVE_DAYS: days before an unapproved active, stopped task is archived (default 14); 0 disables.
export function autoArchiveInactiveMs(env: string | undefined): number {
  return parseDaysMs(env, 14);
}
