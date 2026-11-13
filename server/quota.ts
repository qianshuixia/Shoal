import fs from 'node:fs';
import type { AgentKind, QuotaInfo, QuotaWindow } from '../shared/protocol.ts';

export interface LimitHit { message: string; resetsAt: number | null }

const TAIL_BYTES = 256 * 1024;
const LIMIT_TEXT = /hit your .*limit/i;

// Whether a hook means the session ran out of quota.
// Only claude (and the fake agent that imitates it) has a verified sample: StopFailure with error rate_limit / billing_error,
// or a Stop whose last message says "You've hit your ... limit". codex and agy have no real sample yet, so for them
// switching agent stays manual.
export function detectLimit(agent: AgentKind, event: string, payload: Record<string, unknown>): LimitHit | null {
  if (agent !== 'claude' && agent !== 'fake') return null;
  const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
  if (event === 'StopFailure') {
    const err = payload.error;
    if (err !== 'rate_limit' && err !== 'billing_error') return null;
    return { message: last || `API 返回 ${err}`, resetsAt: null };
  }
  if (event === 'Stop' && LIMIT_TEXT.test(last)) return { message: last, resetsAt: null };
  return null;
}

// Last TAIL_BYTES of a file as text; throws when it cannot be read.
function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Reset time (ms epoch) from the last API error line of a claude transcript; null when not found. Never throws.
export function readResetsAt(transcriptPath: string): number | null {
  try {
    const lines = readTail(transcriptPath).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"apiErrorParams"')) continue;
      try {
        const secs = JSON.parse(lines[i])?.apiErrorParams?.rate_limit_info?.resetsAt;
        if (typeof secs === 'number' && Number.isFinite(secs)) return secs * 1000;
      } catch { /* cut first line of the tail */ }
    }
  } catch { /* missing or unreadable */ }
  return null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (n: number) => Math.min(100, Math.max(0, n));

// Claude's status line `rate_limits` ({ five_hour?, seven_day? }, resets_at in unix seconds) as windows; empty when absent.
export function parseClaudeRateLimits(rl: unknown): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  if (!rl || typeof rl !== 'object') return out;
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const w = (rl as Record<string, unknown>)[key] as Record<string, unknown> | null | undefined;
    if (w && isNum(w.used_percentage) && isNum(w.resets_at)) out.push({ label, usedPercent: pct(w.used_percentage), resetsAt: w.resets_at * 1000 });
  }
  return out;
}

function agyBucketMeta(key: string): { label: string; rank: number; fallbackMs: number } | null {
  const raw = key.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'gemini') return { label: '配额', rank: 2.5, fallbackMs: 5 * 3_600_000 };
  const bare = raw.replace(/^gemini[-_]+/, '');
  if (!bare) return null;
  if (bare === '5h' || bare === '5hr' || bare === 'five_hour') return { label: '5h', rank: 0, fallbackMs: 5 * 3_600_000 };
  if (bare === 'daily' || bare === '1d' || bare === '24h') return { label: '1d', rank: 1, fallbackMs: 24 * 3_600_000 };
  if (bare === 'weekly' || bare === '7d' || bare === 'seven_day') return { label: '7d', rank: 2, fallbackMs: 7 * 86_400_000 };
  const sub = /^([a-z0-9]+)[-_]+(5h|5hr|five_hour|daily|1d|24h|weekly|7d|seven_day)$/.exec(bare);
  if (sub) {
    const inner = agyBucketMeta(sub[2])!;
    return { label: `${sub[1]} ${inner.label}`, rank: inner.rank + 0.5, fallbackMs: inner.fallbackMs };
  }
  return { label: bare.replace(/[-_]+/g, ' '), rank: 3, fallbackMs: 5 * 3_600_000 };
}

// Antigravity's status line `quota` ({ 'gemini-5h'?, 'gemini-weekly'?, ... }) as windows; empty when absent.
// Note: StatusLineQuotaBucket in agy's Go struct marks `remaining_fraction`, `reset_time` and `reset_in_seconds` as
// `omitempty`: 0.0 remaining is omitted when depleted (reset still present -> 100% used), while an untouched bucket
// (`remaining_fraction: 1`) may omit both reset fields before the rolling window starts ticking.
export function parseAgyQuota(quota: unknown, now = Date.now()): QuotaWindow[] {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return [];
  const entries = Object.entries(quota as Record<string, unknown>).filter(
    ([, v]) => !!v && typeof v === 'object' && !Array.isArray(v),
  ) as [string, Record<string, unknown>][];
  if (!entries.length) return [];
  const geminiOnly = entries.filter(([k]) => /^gemini(?:[-_]|$)/i.test(k.trim()));
  const picked = geminiOnly.length ? geminiOnly : entries;
  const ranked: { window: QuotaWindow; rank: number }[] = [];
  for (const [key, b] of picked) {
    const meta = agyBucketMeta(key);
    if (!meta) continue;
    let resetsAt: number | null = null;
    if (typeof b.reset_time === 'string' && b.reset_time) {
      const t = Date.parse(b.reset_time);
      if (Number.isFinite(t)) resetsAt = t;
    }
    if (resetsAt === null && isNum(b.reset_in_seconds) && b.reset_in_seconds > 0) {
      resetsAt = now + b.reset_in_seconds * 1000;
    }
    let usedPercent: number | null = null;
    if (isNum(b.remaining_fraction)) {
      usedPercent = pct(Math.round((1 - b.remaining_fraction) * 10_000) / 100);
    } else if (isNum(b.used_percentage)) {
      usedPercent = pct(b.used_percentage);
    } else if (resetsAt !== null && b.remaining_fraction === undefined && b.used_percentage === undefined) {
      usedPercent = 100;
    }
    if (usedPercent === null) continue;
    if (resetsAt === null && b.reset_time === undefined && b.reset_in_seconds === undefined) {
      resetsAt = now + meta.fallbackMs;
    }
    if (resetsAt === null) continue;
    ranked.push({ window: { label: meta.label, usedPercent, resetsAt }, rank: meta.rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map(r => r.window);
}

// Window length in minutes as a short label: codex's 300 / 10080 are the 5-hour and weekly windows.
export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  return minutes > 0 && minutes % 1440 === 0 ? `${minutes / 1440}d` : `${minutes}m`;
}

// The last rate_limits with a non-null primary or secondary in codex rollout text (event_msg token_count lines); null
// when there is none (API-key and third-party providers report nulls).
export function parseCodexRateLimits(text: string): QuotaWindow[] | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let rl: unknown;
    try {
      const o = JSON.parse(lines[i]);
      rl = o?.payload?.rate_limits ?? o?.rate_limits;
    } catch { continue; /* cut first line of the tail */ }
    const windows: QuotaWindow[] = [];
    for (const key of ['primary', 'secondary']) {
      const w = (rl as Record<string, Record<string, unknown> | null> | null | undefined)?.[key];
      if (w && isNum(w.used_percent) && isNum(w.window_minutes) && isNum(w.resets_at)) {
        windows.push({ label: windowLabel(w.window_minutes), usedPercent: pct(w.used_percent), resetsAt: w.resets_at * 1000 });
      }
    }
    if (windows.length) return windows;
  }
  return null;
}

// Quota windows from the tail of a codex rollout file; null when missing, unreadable or without data. Never throws.
export function readCodexQuota(transcriptPath: string): QuotaWindow[] | null {
  try {
    return parseCodexRateLimits(readTail(transcriptPath));
  } catch {
    return null;
  }
}

const sameWindows = (a: QuotaWindow[], b: QuotaWindow[]) => JSON.stringify(a) === JSON.stringify(b);

// Latest quota per agent kind, kept in memory and in a JSON file so it survives a restart.
export interface QuotaStore {
  all(): Partial<Record<AgentKind, QuotaInfo>>;
  // The new entry, or null (nothing changes) when the windows are the same as before or empty.
  set(agent: AgentKind, windows: QuotaWindow[], at?: number): QuotaInfo | null;
}

export function createQuotaStore(file: string): QuotaStore {
  let data: Partial<Record<AgentKind, QuotaInfo>> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [agent, q] of Object.entries(raw as Record<string, QuotaInfo>)) {
        const windows = Array.isArray(q?.windows)
          ? q.windows.filter(w => w && typeof w.label === 'string' && isNum(w.usedPercent) && isNum(w.resetsAt)) : [];
        if (windows.length && isNum(q.at)) data[agent as AgentKind] = { windows, at: q.at };
      }
    }
  } catch { /* missing or corrupt: start empty */ }
  return {
    all: () => data,
    set(agent, windows, at = Date.now()) {
      if (!windows.length || (data[agent] && sameWindows(data[agent]!.windows, windows))) return null;
      const info: QuotaInfo = { windows, at };
      data = { ...data, [agent]: info };
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (e) {
        console.warn('[quota.json]', (e as Error).message);
      }
      return info;
    },
  };
}
