import { describe, it, expect } from 'vitest';
import { autoArchiveInactiveMs, autoArchiveMs, staleApproved, staleTasks } from './autoarchive.ts';
import type { Task } from '../shared/protocol.ts';

const DAY = 24 * 3600 * 1000;
const NOW = 100 * DAY;
const task = (id: string, o: Partial<Task>): Task => ({
  id, projectId: 'p', title: id, prompt: '', titleAuto: false, color: '#fff', agent: 'fake' as Task['agent'],
  sessionId: null, createdAt: 0, phase: 'approved', phaseSince: 0, ...o,
});

describe('staleApproved & staleTasks', () => {
  it('picks approved tasks older than the 1-day limit and respects lastActiveAt', () => {
    const old = task('a', { phaseSince: NOW - DAY - 1 });
    const recentTurn = task('b', { phaseSince: NOW - 5 * DAY, lastActiveAt: NOW - DAY + 1000 });
    expect(staleApproved([old, recentTurn], new Set(), NOW, DAY)).toEqual([old]);
  });

  it('keeps a task that is exactly at the limit', () => {
    expect(staleApproved([task('a', { phaseSince: NOW - DAY })], new Set(), NOW, DAY)).toEqual([]);
  });

  it('keeps a task whose session is still live, archives one whose session ended', () => {
    const live = task('a', { sessionId: 's1', phaseSince: 0 });
    const dead = task('b', { sessionId: 's2', phaseSince: 0 });
    expect(staleTasks([live, dead], new Set(['s1']), NOW, DAY, 14 * DAY)).toEqual([dead]);
  });

  it('archives unapproved active exited tasks only after inactiveMaxAgeMs, and never touches review or archived', () => {
    const recentActive = task('act-new', { phase: 'active', phaseSince: NOW - 5 * DAY });
    const veryOldActive = task('act-old', { phase: 'active', phaseSince: NOW - 14 * DAY - 1 });
    const review = task('rev', { phase: 'review', phaseSince: 0 });
    const archived = task('arch', { phase: 'archived', phaseSince: 0 });
    expect(staleTasks([recentActive, veryOldActive, review, archived], new Set(), NOW, DAY, 14 * DAY)).toEqual([veryOldActive]);
  });
});

describe('autoArchiveMs & autoArchiveInactiveMs', () => {
  it('defaults to 1 day for approved and 14 days for inactive; 0 or junk disables', () => {
    expect(autoArchiveMs(undefined)).toBe(1 * DAY);
    expect(autoArchiveMs('2')).toBe(2 * DAY);
    expect(autoArchiveMs('0')).toBe(0);
    expect(autoArchiveMs('abc')).toBe(0);

    expect(autoArchiveInactiveMs(undefined)).toBe(14 * DAY);
    expect(autoArchiveInactiveMs('30')).toBe(30 * DAY);
    expect(autoArchiveInactiveMs('0')).toBe(0);
  });
});
