import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createQuotaStore, detectLimit, inferWindowMinutes, parseAgyQuota, parseClaudeRateLimits,
  parseCodexQuotaInfo, parseCodexRateLimits, parseStatusLineContext, readCodexQuota, readLatestCodexQuotaFromDisk, readResetsAt, windowLabel,
} from './quota.ts';
import type { CliToolInfo, QuotaInfo } from '../shared/protocol.ts';
import { bestSwitchCandidate, quotaDisplayAgents, quotaTitle, resolveQuotaForAgent, vendorPlanBadge } from '../web/src/quota.ts';

const MSG = "You've hit your session limit · resets 1:20am (Asia/Shanghai)";

describe('detectLimit', () => {
  it('StopFailure rate_limit / billing_error is a quota hit and keeps the message', () => {
    expect(detectLimit('claude', 'StopFailure', { error: 'rate_limit', last_assistant_message: ` ${MSG} ` })).toEqual({ message: MSG, resetsAt: null });
    expect(detectLimit('claude', 'StopFailure', { error: 'billing_error' })).toEqual({ message: 'API 返回 billing_error', resetsAt: null });
  });

  it('other API errors are not a quota hit', () => {
    expect(detectLimit('claude', 'StopFailure', { error: 'overloaded' })).toBeNull();
    expect(detectLimit('claude', 'StopFailure', { error: 'server_error' })).toBeNull();
  });

  it('a Stop whose last message says the limit was hit counts, a normal Stop does not', () => {
    expect(detectLimit('claude', 'Stop', { last_assistant_message: MSG })).toEqual({ message: MSG, resetsAt: null });
    expect(detectLimit('claude', 'Stop', { last_assistant_message: 'done' })).toBeNull();
  });

  it('codex and agy are never detected', () => {
    expect(detectLimit('codex', 'StopFailure', { error: 'rate_limit' })).toBeNull();
    expect(detectLimit('agy', 'Stop', { last_assistant_message: MSG })).toBeNull();
  });
});

describe('readResetsAt', () => {
  const line = '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"' + MSG + '"}]},"apiError":"usage_limit_reached","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"apiErrorParams":{"rate_limit_info":{"status":"rejected","resetsAt":1791652800,"rateLimitType":"five_hour"}}}';

  it('reads resetsAt (seconds) of the last API error line as ms', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-')), 't.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n' + line + '\n{"type":"system"}\n');
    expect(readResetsAt(file)).toBe(1791652800000);
  });

  it('returns null for a missing file or a transcript without an API error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-'));
    expect(readResetsAt(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'plain.jsonl'), '{"type":"user"}\n');
    expect(readResetsAt(path.join(dir, 'plain.jsonl'))).toBeNull();
  });
});

describe('parseClaudeRateLimits', () => {
  it('reads both primary windows and secondary model-specific pools with windowMinutes', () => {
    const rl = {
      five_hour: { used_percentage: 3.5, resets_at: 1791652800 },
      seven_day: { used_percentage: 40, resets_at: 1792000000 },
      seven_day_sonnet: { used_percentage: 12, resets_at: 1792000000 },
    };
    expect(parseClaudeRateLimits(rl)).toEqual([
      { label: '5h', usedPercent: 3.5, resetsAt: 1791652800000, windowMinutes: 300, pool: 'claude', poolLabel: 'Claude', primary: true },
      { label: '7d', usedPercent: 40, resetsAt: 1792000000000, windowMinutes: 10080, pool: 'claude', poolLabel: 'Claude', primary: true },
      { label: '7d', usedPercent: 12, resetsAt: 1792000000000, windowMinutes: 10080, pool: 'sonnet', poolLabel: 'Sonnet', primary: false },
    ]);
  });

  it('a missing window is skipped; malformed or absent input gives nothing', () => {
    expect(parseClaudeRateLimits({ seven_day: { used_percentage: 4, resets_at: 1792000000 } })).toEqual([
      { label: '7d', usedPercent: 4, resetsAt: 1792000000000, windowMinutes: 10080, pool: 'claude', poolLabel: 'Claude', primary: true },
    ]);
    expect(parseClaudeRateLimits({ five_hour: { used_percentage: 'x', resets_at: 1 } })).toEqual([]);
    expect(parseClaudeRateLimits({ five_hour: null })).toEqual([]);
    expect(parseClaudeRateLimits(undefined)).toEqual([]);
    expect(parseClaudeRateLimits('nope')).toEqual([]);
  });

  it('clamps the percentage to 0-100', () => {
    expect(parseClaudeRateLimits({ five_hour: { used_percentage: 130, resets_at: 1 } })[0].usedPercent).toBe(100);
  });
});

describe('parseAgyQuota', () => {
  it('converts gemini-5h, gemini-weekly and 3p-* buckets into ordered primary + shared pools', () => {
    const q = {
      '3p-weekly': { remaining_fraction: 0.85, reset_time: '2026-11-29T15:04:54Z' },
      'gemini-weekly': { remaining_fraction: 0.9378, reset_time: '2026-11-20T07:50:32Z', reset_in_seconds: 560580 },
      '3p-5h': { remaining_fraction: 0.94, reset_time: '2026-11-22T20:04:54Z' },
      'gemini-5h': { remaining_fraction: 0.5225, reset_time: '2026-11-13T22:28:10.000Z', reset_in_seconds: 7887 },
    };
    expect(parseAgyQuota(q)).toEqual([
      { label: '5h', usedPercent: 47.75, resetsAt: Date.parse('2026-11-13T22:28:10.000Z'), windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
      { label: '7d', usedPercent: 6.22, resetsAt: Date.parse('2026-11-20T07:50:32Z'), windowMinutes: 10080, pool: 'gemini', poolLabel: 'Gemini', primary: true },
      { label: '5h', usedPercent: 6, resetsAt: Date.parse('2026-11-22T20:04:54Z'), windowMinutes: 300, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
      { label: '7d', usedPercent: 15, resetsAt: Date.parse('2026-11-29T15:04:54Z'), windowMinutes: 10080, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
    ]);
  });

  it('treats omitted remaining_fraction (Go omitempty at 0.0) as 100% used when reset_time is present', () => {
    const q = { 'gemini-5h': { reset_time: '2026-11-13T22:28:10Z', reset_in_seconds: 1200 } };
    expect(parseAgyQuota(q)).toEqual([
      { label: '5h', usedPercent: 100, resetsAt: Date.parse('2026-11-13T22:28:10Z'), windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
    ]);
  });

  it('marks gemini-* as primary and keeps third-party pools as secondary', () => {
    const now = 1_794_570_000_000;
    const q = {
      'claude-5h': { remaining_fraction: 0.1, reset_in_seconds: 600 },
      'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 },
    };
    expect(parseAgyQuota(q, now)).toEqual([
      { label: '5h', usedPercent: 20, resetsAt: now + 3_600_000, windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
      { label: '5h', usedPercent: 90, resetsAt: now + 600_000, windowMinutes: 300, pool: 'claude', poolLabel: 'Claude', primary: false },
    ]);
  });

  it('handles bare "gemini" bucket key and untouched buckets that omit reset fields', () => {
    const now = 1_794_570_000_000;
    expect(parseAgyQuota({ 'gemini-5h': { remaining_fraction: 1 } }, now)).toEqual([
      { label: '5h', usedPercent: 0, resetsAt: now + 5 * 3_600_000, windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
    ]);
    expect(parseAgyQuota({ gemini: { remaining_fraction: 0.75, reset_in_seconds: 1800 } }, now)).toEqual([
      { label: '配额', usedPercent: 25, resetsAt: now + 1_800_000, windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
    ]);
  });

  it('ignores malformed or empty inputs', () => {
    expect(parseAgyQuota(undefined)).toEqual([]);
    expect(parseAgyQuota('nope')).toEqual([]);
    expect(parseAgyQuota([])).toEqual([]);
    expect(parseAgyQuota({ 'gemini-5h': {} })).toEqual([]);
    expect(parseAgyQuota({ 'gemini-5h': { remaining_fraction: 'bad', reset_time: '2026-11-13T22:28:10Z' } })).toEqual([]);
    expect(parseAgyQuota({ 'gemini-5h': { remaining_fraction: 0.5, reset_time: 'not-a-date' } })).toEqual([]);
  });
});

describe('windowLabel & inferWindowMinutes', () => {
  it('names the 5-hour and weekly windows, formats others generically, and parses back', () => {
    expect(windowLabel(300)).toBe('5h');
    expect(windowLabel(10080)).toBe('7d');
    expect(windowLabel(60)).toBe('60m');
    expect(windowLabel(2880)).toBe('2d');
    expect(inferWindowMinutes('5h')).toBe(300);
    expect(inferWindowMinutes('7d')).toBe(10080);
    expect(inferWindowMinutes('2d')).toBe(2880);
    expect(inferWindowMinutes('60m')).toBe(60);
  });
});

const tc = (rl: unknown) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });
const RL = '{"limit_id":"codex","limit_name":null,"primary":{"used_percent":9.0,"window_minutes":300,"resets_at":1793447357},"secondary":{"used_percent":3.0,"window_minutes":10080,"resets_at":1793800001},"credits":null,"plan_type":"plus"}';

describe('parseCodexRateLimits', () => {
  it('takes the last rate_limits that has data, skipping later null ones, and extracts plan_type', () => {
    const older = tc({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1793000000 }, secondary: null });
    const text = `{"type":"session_meta"}\n${older}\n${tc(JSON.parse(RL))}\n${tc({ limit_id: 'x', primary: null, secondary: null })}\n`;
    expect(parseCodexQuotaInfo(text)).toEqual({
      plan: 'plus',
      windows: [
        { label: '5h', usedPercent: 9, resetsAt: 1793447357000, windowMinutes: 300, pool: 'codex', poolLabel: 'Codex', primary: true },
        { label: '7d', usedPercent: 3, resetsAt: 1793800001000, windowMinutes: 10080, pool: 'codex', poolLabel: 'Codex', primary: true },
      ],
    });
    expect(parseCodexRateLimits(text)?.map(w => w.usedPercent)).toEqual([9, 3]);
  });

  it('API-key / third-party sessions (all null) and cut or garbage lines give null', () => {
    expect(parseCodexRateLimits(tc({ primary: null, secondary: null }) + '\n')).toBeNull();
    expect(parseCodexRateLimits('"rate_limits":{"primary":{"used_per\n{"type":"x"}\n')).toBeNull();
    expect(parseCodexRateLimits('')).toBeNull();
  });

  it('formats unusual window lengths generically and keeps a lone secondary', () => {
    const text = tc({ primary: null, secondary: { used_percent: 20, window_minutes: 2880, resets_at: 1793000000 } });
    expect(parseCodexRateLimits(text)).toEqual([
      { label: '2d', usedPercent: 20, resetsAt: 1793000000000, windowMinutes: 2880, pool: 'codex', poolLabel: 'Codex', primary: true },
    ]);
  });

  it('readCodexQuota reads the file tail and never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-'));
    fs.writeFileSync(path.join(dir, 'r.jsonl'), tc(JSON.parse(RL)) + '\n');
    expect(readCodexQuota(path.join(dir, 'r.jsonl'))?.map(w => w.label)).toEqual(['5h', '7d']);
    expect(readCodexQuota(path.join(dir, 'nope.jsonl'))).toBeNull();
  });
});

describe('parseStatusLineContext', () => {
  it('parses Claude statusLine context_window with cached vs uncached breakdown', () => {
    const ctx = parseStatusLineContext('claude', {
      model: { id: 'claude-opus-4-6' },
      context_window: {
        context_window_size: 1_000_000,
        used_percentage: 16.5,
        current_usage: { input_tokens: 2700, cache_read_input_tokens: 160_000, cache_creation_input_tokens: 2000 },
      },
    }, 1000);
    expect(ctx).toEqual({
      contextWindowSize: 1_000_000,
      usedTokens: 164_700,
      cachedTokens: 162_000,
      uncachedTokens: 2700,
      usedPercent: 16.5,
      cacheHitRate: 160_000 / 164_700,
      model: 'claude-opus-4-6',
      updatedAt: 1000,
    });
  });

  it('returns null when context_window is absent', () => {
    expect(parseStatusLineContext('claude', { rate_limits: {} })).toBeNull();
  });
});

describe('createQuotaStore', () => {
  const win = (p: number) => [{ label: '5h', usedPercent: p, resetsAt: 1793447357000, windowMinutes: 300 }];

  it('reports a change once, ignores identical windows and empty input, and reloads from disk', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-')), 'quota.json');
    const store = createQuotaStore(file);
    expect(store.set('claude', win(5), 100)).toEqual({ windows: win(5), at: 100 });
    expect(store.set('claude', win(5), 200)).toBeNull();
    expect(store.set('claude', [], 200)).toBeNull();
    expect(store.set('claude', win(6), 300, { plan: 'max', source: 'statusline' })).toEqual({
      windows: win(6), at: 300, plan: 'max', source: 'statusline',
    });
    expect(createQuotaStore(file).all()).toEqual({
      claude: { windows: win(6), at: 300, plan: 'max', source: 'statusline' },
    });
  });

  it('starts empty on a missing or corrupt file, drops malformed entries, and backfills windowMinutes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-'));
    expect(createQuotaStore(path.join(dir, 'none.json')).all()).toEqual({});
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(createQuotaStore(path.join(dir, 'bad.json')).all()).toEqual({});
    fs.writeFileSync(path.join(dir, 'mixed.json'), JSON.stringify({
      claude: { windows: [{ label: '5h', usedPercent: 1, resetsAt: 1793447357000 }], at: 5 },
      codex: { windows: 'x', at: 1 },
      agy: null,
    }));
    expect(createQuotaStore(path.join(dir, 'mixed.json')).all()).toEqual({
      claude: { windows: [{ label: '5h', usedPercent: 1, resetsAt: 1793447357000, windowMinutes: 300 }], at: 5 },
    });
  });
});

describe('readLatestCodexQuotaFromDisk & custom Codex quota helpers', () => {
  it('picks the newest live rollout even past 24 empty rollouts and non-date directories, and invalidates cache on same-size overwrite', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codex-disk-'));
    // 8 non-date empty directories sorting alphabetically ahead of 2026 must not starve date dirs.
    for (let i = 1; i <= 8; i++) fs.mkdirSync(path.join(home, 'sessions', `zzz-${i}`), { recursive: true });
    const prevDay = path.join(home, 'sessions', '2026', '11', '24');
    const todayDir = path.join(home, 'sessions', '2026', '11', '25');
    fs.mkdirSync(prevDay, { recursive: true });
    fs.mkdirSync(todayDir, { recursive: true });

    const pastSec = Math.floor((Date.now() - 3_600_000) / 1000);
    const futureSec = Math.floor((Date.now() + 3_600_000) / 1000);

    // 25 rollouts today with null/expired rate_limits must not prevent falling back to yesterday's live rollout.
    for (let i = 0; i < 24; i++) {
      fs.writeFileSync(
        path.join(todayDir, `rollout-2026-11-25T16-${String(i).padStart(2, '0')}-00-empty.jsonl`),
        tc({ primary: null, secondary: null }) + '\n',
      );
    }
    fs.writeFileSync(
      path.join(todayDir, 'rollout-2026-11-25T16-59-00-expired.jsonl'),
      tc({ primary: { used_percent: 99, window_minutes: 300, resets_at: pastSec }, secondary: null, plan_type: 'plus' }) + '\n',
    );
    const liveFile = path.join(prevDay, 'rollout-2026-11-24T23-00-00-live.jsonl');
    fs.writeFileSync(
      liveFile,
      tc({ primary: { used_percent: 30, window_minutes: 300, resets_at: futureSec }, secondary: null, plan_type: 'pro' }) + '\n',
    );

    const first = readLatestCodexQuotaFromDisk(home);
    expect(first?.plan).toBe('pro');
    expect(first?.windows[0].usedPercent).toBe(30);

    // Same-size overwrite (30 -> 40) updates ctime/mtime and must invalidate the cache.
    const prevStat = fs.statSync(liveFile);
    fs.writeFileSync(
      liveFile,
      tc({ primary: { used_percent: 40, window_minutes: 300, resets_at: futureSec }, secondary: null, plan_type: 'pro' }) + '\n',
    );
    // Even if mtime is held equal, Windows/POSIX overwrite updates ctime (or if same tick, bump mtime by 1ms).
    const nextStat = fs.statSync(liveFile);
    if (nextStat.ctimeMs === prevStat.ctimeMs && nextStat.mtimeMs === prevStat.mtimeMs) {
      const bumped = new Date(prevStat.mtimeMs + 1000);
      fs.utimesSync(liveFile, bumped, bumped);
    }
    const second = readLatestCodexQuotaFromDisk(home);
    expect(second?.windows[0].usedPercent).toBe(40);

    // Resumed session in an older day directory (day 8+) with the newest mtimeMs must win globally over newer date folders.
    const day8Dir = path.join(home, 'sessions', '2026', '11', '10');
    fs.mkdirSync(day8Dir, { recursive: true });
    for (let d = 17; d <= 23; d++) {
      const dd = path.join(home, 'sessions', '2026', '11', String(d));
      fs.mkdirSync(dd, { recursive: true });
      fs.writeFileSync(
        path.join(dd, `rollout-2026-11-${d}T10-00-00.jsonl`),
        tc({ primary: { used_percent: 20, window_minutes: 300, resets_at: futureSec }, secondary: null, plan_type: 'plus' }) + '\n',
      );
    }
    const resumedOld = path.join(day8Dir, 'rollout-2026-11-10T09-00-00-resumed.jsonl');
    fs.writeFileSync(
      resumedOld,
      tc({ primary: { used_percent: 95, window_minutes: 300, resets_at: futureSec }, secondary: null, plan_type: 'pro' }) + '\n',
    );
    const newest = new Date(Date.now() + 10_000);
    fs.utimesSync(resumedOld, newest, newest);
    const third = readLatestCodexQuotaFromDisk(home);
    expect(third?.windows[0].usedPercent).toBe(95);
  });

  it('ranks rollouts by rate_limits event timestamp so a touched older rollout does not overwrite a newer 5h window', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codex-ts-'));
    const dayDir = path.join(home, 'sessions', '2026', '11', '27');
    fs.mkdirSync(dayDir, { recursive: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const expired5hSec = nowSec - 600;
    const live5hSec = nowSec + 18_000;
    const live7dSec = nowSec + 500_000;

    // Newer active session: rate_limits written at T-10s with a live 5h window (6% used)
    const activeFile = path.join(dayDir, 'rollout-2026-11-27T15-49-46-active.jsonl');
    const activeEventTs = new Date(Date.now() - 10_000).toISOString();
    fs.writeFileSync(
      activeFile,
      JSON.stringify({
        timestamp: activeEventTs,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 6, window_minutes: 300, resets_at: live5hSec },
            secondary: { used_percent: 29, window_minutes: 10080, resets_at: live7dSec },
            plan_type: 'plus',
          },
        },
      }) + '\n',
    );
    const activeMtime = new Date(Date.now() - 10_000);
    fs.utimesSync(activeFile, activeMtime, activeMtime);

    // Older session whose file mtime was touched AFTER activeFile (T-2s), but its last rate_limits was 2h ago (expired 5h, live 7d)
    const touchedOldFile = path.join(dayDir, 'rollout-2026-11-27T12-36-37-touched.jsonl');
    const staleEventTs = new Date(Date.now() - 2 * 3_600_000).toISOString();
    fs.writeFileSync(
      touchedOldFile,
      JSON.stringify({
        timestamp: staleEventTs,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 65, window_minutes: 300, resets_at: expired5hSec },
            secondary: { used_percent: 27, window_minutes: 10080, resets_at: live7dSec },
            plan_type: 'plus',
          },
        },
      }) + '\n{"timestamp":"' + new Date(Date.now() - 2_000).toISOString() + '","type":"event_msg","payload":{"type":"idle"}}\n',
    );
    const newerMtime = new Date(Date.now() - 2_000);
    fs.utimesSync(touchedOldFile, newerMtime, newerMtime);

    const latest = readLatestCodexQuotaFromDisk(home);
    expect(latest?.windows).toHaveLength(2);
    expect(latest?.windows[0].usedPercent).toBe(6);
    expect(latest?.windows[0].resetsAt).toBe(live5hSec * 1000);
    expect(latest?.windows[1].usedPercent).toBe(29);
  });

  it('uses authoritative quotaKey strictly: no cross-account fallback, no stale bucket hijack, and disabled CLIs are excluded', () => {
    const now = 1_000_000;
    const mkTool = (id: string, label: string, quotaKey: string, enabled = true): CliToolInfo => ({
      id, label, tier: 'generic', source: 'custom', installed: true, usable: true, path: null, command: 'codex',
      enabled, permissionMode: 'full', fullAccessArgs: [], normalArgs: [], supportsFullAccessFlag: false,
      capabilities: [], promptArg: 'positional', quotaAgent: 'codex', quotaKey,
    });
    const tools = [
      mkTool('my-codex', '自定义 Codex', 'codex', true),
      mkTool('codex-work', 'Codex 工作号', 'codex-work', true),
      mkTool('codex-disabled', '已禁用 Codex', 'codex-disabled', false),
    ];
    const mkQuota = (usedPercent: number, resetsAt = now + 3_600_000): QuotaInfo => ({
      windows: [{ label: '5h', usedPercent, resetsAt, windowMinutes: 300, primary: true }],
      at: now,
    });

    const quota = {
      codex: mkQuota(85),
      claude: mkQuota(20),
      'codex-work': mkQuota(30),
      'codex-disabled': mkQuota(10),
    };

    // Shared custom Codex resolves to 'codex'; isolated custom Codex resolves strictly to 'codex-work'.
    expect(resolveQuotaForAgent('my-codex', quota, now, tools).key).toBe('codex');
    expect(resolveQuotaForAgent('my-codex', quota, now, tools).windows[0].usedPercent).toBe(85);
    expect(resolveQuotaForAgent('codex-work', quota, now, tools).key).toBe('codex-work');
    expect(resolveQuotaForAgent('codex-work', quota, now, tools).windows[0].usedPercent).toBe(30);

    // Isolated custom Codex with NO data yet must NOT leak default 'codex' quota!
    expect(resolveQuotaForAgent('codex-work', { codex: mkQuota(85) }, now, tools)).toEqual({
      key: 'codex-work',
      quota: undefined,
      windows: [],
    });

    // Topbar/popover list includes enabled isolated 'codex-work', NOT shared 'my-codex', NOT disabled 'codex-disabled'.
    const displayed = quotaDisplayAgents(quota, tools);
    expect(displayed).toContain('codex');
    expect(displayed).toContain('codex-work');
    expect(displayed).not.toContain('my-codex');
    expect(displayed).not.toContain('codex-disabled');

    // Never suggests switching from my-codex -> codex (same shared bucket), suggests claude (80% left) instead.
    expect(bestSwitchCandidate(quota, ['codex', 'my-codex', 'claude'], 'my-codex', now, tools)).toEqual({
      agent: 'claude',
      minLeftPercent: 80,
    });
    expect(bestSwitchCandidate({ codex: mkQuota(85) }, ['codex', 'my-codex'], 'my-codex', now, tools)).toBeNull();

    // Badge & tooltip reflect custom CLI label and Codex subscription fallback.
    expect(vendorPlanBadge('my-codex', undefined, tools)).toBe('Codex 订阅');
    expect(quotaTitle('codex-work', quota['codex-work'], quota['codex-work'].windows, now, 'remaining', tools)).toContain('Codex 工作号 订阅额度');
  });
});
