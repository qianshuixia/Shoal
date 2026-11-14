import { describe, expect, it } from 'vitest';
import type { AgentKind, SessionInfo, SessionStatus, Task, TaskPhase } from '../../shared/protocol.ts';
import { sortProjectTasks, taskActivityAt } from './util.ts';

function mkTask(id: string, o: {
  agent?: AgentKind;
  sessionId?: string | null;
  createdAt: number;
  phase?: TaskPhase;
  phaseSince?: number;
  lastActiveAt?: number;
}): Task {
  return {
    id,
    projectId: 'p1',
    title: id,
    prompt: '',
    titleAuto: false,
    color: '#8baeda',
    agent: o.agent ?? 'claude',
    sessionId: o.sessionId === undefined ? `s-${id}` : o.sessionId,
    createdAt: o.createdAt,
    phase: o.phase ?? 'active',
    phaseSince: o.phaseSince ?? o.createdAt,
    ...(o.lastActiveAt !== undefined && { lastActiveAt: o.lastActiveAt }),
  };
}

function mkSession(id: string, taskId: string, o: {
  agent?: AgentKind;
  status: SessionStatus;
  startedAt: number;
  statusSince?: number;
}): SessionInfo {
  return {
    id,
    taskId,
    agent: o.agent ?? 'claude',
    nativeSessionId: `n-${id}`,
    resumable: true,
    status: o.status,
    statusSince: o.statusSince ?? o.startedAt,
    startedAt: o.startedAt,
    exitCode: o.status === 'exited' ? 0 : null,
    cols: 120,
    rows: 36,
  };
}

describe('sortProjectTasks', () => {
  it('orders exited sessions by most recent activity descending instead of oldest creation or vendor', () => {
    // Exact reproduction of mixed-vendor exited list: two older claude tasks followed by three newer agy tasks.
    const tasks = [
      mkTask('claude-old-1', { agent: 'claude', createdAt: 1000 }),
      mkTask('claude-old-2', { agent: 'claude', createdAt: 2000 }),
      mkTask('agy-mid-1', { agent: 'agy', createdAt: 3000 }),
      mkTask('agy-idle', { agent: 'agy', createdAt: 4000 }),
      mkTask('agy-latest', { agent: 'agy', createdAt: 5000 }),
    ];
    const sessions = new Map<string, SessionInfo>([
      ['s-claude-old-1', mkSession('s-claude-old-1', 'claude-old-1', { agent: 'claude', status: 'exited', startedAt: 1000, statusSince: 1500 })],
      ['s-claude-old-2', mkSession('s-claude-old-2', 'claude-old-2', { agent: 'claude', status: 'exited', startedAt: 2000, statusSince: 2500 })],
      // Both agy-mid-1 and agy-latest were running until server restart at t=9000; startedAt breaks the tie.
      ['s-agy-mid-1', mkSession('s-agy-mid-1', 'agy-mid-1', { agent: 'agy', status: 'exited', startedAt: 6000, statusSince: 9000 })],
      ['s-agy-idle', mkSession('s-agy-idle', 'agy-idle', { agent: 'agy', status: 'exited', startedAt: 4000, statusSince: 4500 })],
      ['s-agy-latest', mkSession('s-agy-latest', 'agy-latest', { agent: 'agy', status: 'exited', startedAt: 6100, statusSince: 9000 })],
    ]);

    expect(sortProjectTasks(tasks, sessions).map((t) => t.id)).toEqual([
      'agy-latest',
      'agy-mid-1',
      'agy-idle',
      'claude-old-2',
      'claude-old-1',
    ]);
  });

  it('places live active above approved open above exited, newest active first, and ignores mid-turn status/phase ticks', () => {
    const tExited = mkTask('exited-recent', { createdAt: 8000, lastActiveAt: 8000 });
    const tApproved = mkTask('approved-open', { createdAt: 7000, phase: 'approved', phaseSince: 7500, lastActiveAt: 7000 });
    const tOlderLive = mkTask('live-older', { agent: 'claude', createdAt: 3000, phase: 'review', phaseSince: 9999, lastActiveAt: 3000 });
    const tNewerLive = mkTask('live-newer', { agent: 'agy', createdAt: 5000, phase: 'active', phaseSince: 5000, lastActiveAt: 5000 });
    const tResumedOld = mkTask('resumed-oldest', { agent: 'codex', createdAt: 1000, phase: 'active', phaseSince: 6000, lastActiveAt: 6000 });

    const sessions = new Map<string, SessionInfo>([
      ['s-exited-recent', mkSession('s-exited-recent', 'exited-recent', { status: 'exited', startedAt: 8000, statusSince: 9500 })],
      ['s-approved-open', mkSession('s-approved-open', 'approved-open', { status: 'needs_you', startedAt: 7000, statusSince: 7500 })],
      // Even though live-older just flipped to review at t=9999, live sessions ignore statusSince/phaseSince so rows never jump mid-click.
      ['s-live-older', mkSession('s-live-older', 'live-older', { status: 'needs_you', startedAt: 3000, statusSince: 9999 })],
      ['s-live-newer', mkSession('s-live-newer', 'live-newer', { status: 'working', startedAt: 5000, statusSince: 5100 })],
      ['s-resumed-oldest', mkSession('s-resumed-oldest', 'resumed-oldest', { status: 'working', startedAt: 6000, statusSince: 6050 })],
    ]);

    expect(taskActivityAt(tOlderLive, sessions.get('s-live-older'))).toBe(3000);
    expect(sortProjectTasks([tExited, tApproved, tOlderLive, tNewerLive, tResumedOld], sessions).map((t) => t.id)).toEqual([
      'resumed-oldest',
      'live-newer',
      'live-older',
      'approved-open',
      'exited-recent',
    ]);
  });
});
