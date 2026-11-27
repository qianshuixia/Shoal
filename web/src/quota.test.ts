import { describe, expect, it } from 'vitest';
import type { QuotaInfo } from '../../shared/protocol.ts';
import { isUnstartedWindow, liveWindows, quotaTitle, windowMetrics } from './quota.ts';

describe('web quota unstarted windows', () => {
  const now = Date.parse('2026-11-26T07:15:00Z');
  const future5h = Date.parse('2026-11-26T12:15:00Z');
  const future7d = Date.parse('2026-12-03T07:15:00Z');
  const past = Date.parse('2026-11-25T11:25:55Z');

  it('keeps active and unstarted windows, and keeps all-unstarted snapshots', () => {
    const activeAndUnstarted: QuotaInfo = {
      at: now,
      plan: 'Google',
      windows: [
        { label: '5h', usedPercent: 2, resetsAt: future5h, windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
        { label: '7d', usedPercent: 1, resetsAt: future7d, windowMinutes: 10080, pool: 'gemini', poolLabel: 'Gemini', primary: true },
        { label: '5h', usedPercent: 0, resetsAt: 0, unstarted: true, windowMinutes: 300, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
        { label: '7d', usedPercent: 0, resetsAt: 0, windowMinutes: 10080, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
      ],
    };
    expect(liveWindows(activeAndUnstarted, now)).toHaveLength(4);
    expect(isUnstartedWindow(activeAndUnstarted.windows[2])).toBe(true);
    expect(isUnstartedWindow(activeAndUnstarted.windows[3])).toBe(true);

    const allUnstarted: QuotaInfo = {
      at: now,
      windows: [
        { label: '5h', usedPercent: 0, resetsAt: 0, unstarted: true, pool: 'gemini', primary: true },
        { label: '7d', usedPercent: 0, resetsAt: 0, unstarted: true, pool: 'gemini', primary: true },
      ],
    };
    expect(liveWindows(allUnstarted, now)).toHaveLength(2);
  });

  it('drops stale snapshots when every timed window has expired', () => {
    const stale: QuotaInfo = {
      at: past,
      windows: [
        { label: '5h', usedPercent: 2, resetsAt: past, pool: 'gemini', primary: true },
        { label: '5h', usedPercent: 0, resetsAt: 0, unstarted: true, pool: '3p', primary: false },
      ],
    };
    expect(liveWindows(stale, now)).toEqual([]);
  });

  it('renders unstarted metrics and tooltips without fake countdowns', () => {
    const w = { label: '5h', usedPercent: 0, resetsAt: 0, unstarted: true, windowMinutes: 300, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false };
    const m = windowMetrics(w, now);
    expect(m).toMatchObject({
      usedPercent: 0,
      leftPercent: 100,
      unstarted: true,
      timeElapsedPct: null,
      idealLeftPct: null,
      paceDelta: null,
      pace: 'idle',
      tone: 'ok',
      resetRelative: '未开始计时',
      resetClock: '首次调用后开始计时',
    });
    const title = quotaTitle('agy', { at: now, plan: 'Google', windows: [w] }, [w], now, 'remaining');
    expect(title).toContain('[Claude & GPT 共享] 5 小时窗口：剩余 100%，未使用（首次调用后开始计时）');
    expect(title).not.toContain('1970');
  });
});
