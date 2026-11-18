import type { SessionInfo, SessionStatus, Snapshot, Task, UsageCounts } from '../../shared/protocol.ts';
import { usageCacheHitRate } from '../../shared/protocol.ts';

// 0: live active/review/idle/starting, 1: live approved, 2: exited.
export function taskBand(task: Pick<Task, 'phase'>, session?: Pick<SessionInfo, 'status'>): 0 | 1 | 2 {
  if (!session || session.status === 'exited') return 2;
  return task.phase === 'approved' ? 1 : 0;
}

// Recency key for sorting within a band (descending). Live sessions intentionally ignore statusSince / phaseSince so
// background hook transitions (working <-> needs_you <-> review) never move rows under the pointer.
export function taskActivityAt(
  task: Pick<Task, 'createdAt' | 'phaseSince' | 'lastActiveAt'>,
  session?: Pick<SessionInfo, 'status' | 'startedAt' | 'statusSince'>,
): number {
  const base = Math.max(task.lastActiveAt ?? 0, session?.startedAt ?? 0, task.createdAt);
  if (!session || session.status === 'exited') {
    return Math.max(base, session?.statusSince ?? 0, task.phaseSince ?? 0);
  }
  return base;
}

export function sortProjectTasks(tasks: readonly Task[], sessionsById: ReadonlyMap<string, SessionInfo>): Task[] {
  return [...tasks].sort((a, b) => {
    const sa = a.sessionId ? sessionsById.get(a.sessionId) : undefined;
    const sb = b.sessionId ? sessionsById.get(b.sessionId) : undefined;
    const ba = taskBand(a, sa);
    const bb = taskBand(b, sb);
    if (ba !== bb) return ba - bb;
    return (
      taskActivityAt(b, sb) - taskActivityAt(a, sa)
      || (sb?.startedAt ?? 0) - (sa?.startedAt ?? 0)
      || b.createdAt - a.createdAt
    );
  });
}

// Delegated tasks whose main task is in the same list nest under it (oldest dispatch first); the rest stay top level in
// their given order, including delegated tasks whose main task is gone or lives elsewhere.
export function nestDelegated(tasks: readonly Task[]): { top: Task[]; childrenOf: Map<string, Task[]> } {
  const ids = new Set(tasks.map((t) => t.id));
  const top: Task[] = [];
  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) {
    const parent = t.delegation?.parentTaskId;
    if (parent && parent !== t.id && ids.has(parent)) {
      const list = childrenOf.get(parent);
      if (list) list.push(t);
      else childrenOf.set(parent, [t]);
    } else {
      top.push(t);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.delegation!.createdAt - b.delegation!.createdAt);
  return { top, childrenOf };
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: '启动中',
  idle: '就绪',
  working: '工作中',
  needs_you: '需要你',
  exited: '已退出',
};

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const [d, s] = n < 1e6 ? [1e3, 'K'] : n < 1e9 ? [1e6, 'M'] : [1e9, 'B'];
  const v = n / d;
  return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)) + s;
}

export const hitRate = usageCacheHitRate;
export const fmtPct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}:${String(rem).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function waitText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `等 ${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `等 ${m}分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `等 ${h}时${rest}分` : `等 ${h}时`;
}

// Shared by desktop and phone so both count 需要你 / 待验收 the same way.
// Sessions that want the user, oldest first: asked a question (需要你, task still active) / finished a task (待验收).
// A delegated task's finished round is the main task's to review, so it never counts as 待验收.
export function needsList(d: Pick<Snapshot, 'tasks' | 'sessions'>): string[] {
  const phase = new Map(d.tasks.map((t) => [t.id, t.phase]));
  return d.sessions
    .filter((s) => s.status === 'needs_you' && phase.get(s.taskId) === 'active')
    .sort((a, b) => a.statusSince - b.statusSince)
    .map((s) => s.id);
}

export function reviewList(d: Pick<Snapshot, 'tasks' | 'sessions'>): string[] {
  const ids = new Set(d.sessions.map((s) => s.id));
  return d.tasks
    .filter((t) => t.phase === 'review' && !t.delegation && t.sessionId && ids.has(t.sessionId))
    .sort((a, b) => a.phaseSince - b.phaseSince)
    .map((t) => t.sessionId!);
}
