import { describe, expect, it } from 'vitest';
import { isOfficialOpenCodeGoUrl, parseOpenCodeGoUsage } from '../shared/openCodeGo.ts';

describe('OpenCode Go quota', () => {
  const reset = '2026-12-01T00:00:00.000Z';
  const resetsAt = Date.parse(reset);

  it('reads the official rolling, weekly and billing-period windows', () => {
    expect(parseOpenCodeGoUsage({ usage: {
      rolling: { status: 'ok', percent: 0, resetsAt: reset },
      weekly: { status: 'ok', percent: 35, resetsAt: reset },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: reset },
    } })).toMatchObject([
      { label: '5h', usedPercent: 0, resetsAt, windowMinutes: 300 },
      { label: '7d', usedPercent: 35, resetsAt, windowMinutes: 10080 },
      { label: '月度', usedPercent: 100, resetsAt, poolLabel: 'OpenCode Go' },
    ]);
  });

  it('leaves absent, malformed and unauthorized windows unavailable', () => {
    expect(parseOpenCodeGoUsage({ error: { type: 'EntitlementError' } })).toEqual([]);
    expect(parseOpenCodeGoUsage({ usage: {
      rolling: { status: 'ok', percent: -1, resetsAt: reset },
      weekly: { status: 'unknown', percent: 35, resetsAt: reset },
      monthly: { status: 'ok', percent: 90, resetsAt: 'unknown' },
    } })).toEqual([]);
  });

  it('allows Pi’s official Go host and guards against overrides before sending authorization', () => {
    expect(isOfficialOpenCodeGoUrl('https://opencode.ai/inference/go/v1')).toBe(true);
    expect(isOfficialOpenCodeGoUrl('https://opencode.ai/zen/go/v1')).toBe(true);
    expect(isOfficialOpenCodeGoUrl('https://opencode.ai/inference/v1')).toBe(false);
    expect(isOfficialOpenCodeGoUrl('https://opencode.ai.example.test/inference/go/v1')).toBe(false);
    expect(isOfficialOpenCodeGoUrl('http://opencode.ai/inference/go/v1')).toBe(false);
  });
});
