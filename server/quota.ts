import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, QuotaInfo, QuotaWindow, SessionContext } from '../shared/protocol.ts';

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

export function inferWindowMinutes(label: string): number | undefined {
  const m = /(?:^|\s)(\d+)([hdm])$/i.exec(label.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  if (unit === 'm') return n;
  if (unit === 'h') return n * 60;
  return n * 1440;
}

// Known context window sizes when a CLI transcript does not report model_context_window explicitly.
export function inferContextWindowSize(model: string | undefined, agent: AgentKind): number {
  const m = (model ?? '').toLowerCase();
  if (agent === 'agy' || /gemini/.test(m)) return 1_048_576;
  if (/\b1m\b|1000k|\[1m\]/.test(m)) return 1_000_000;
  if (agent === 'claude' || /claude|opus|sonnet|haiku/.test(m)) {
    if (/(?:opus|sonnet)-4[-.]6|4\.6/.test(m)) return 1_000_000;
    return 200_000;
  }
  if (agent === 'codex' || /codex|gpt-5/.test(m)) return 400_000;
  return 200_000;
}

// Claude's status line `rate_limits` ({ five_hour?, seven_day?, seven_day_sonnet?, seven_day_opus?, ... }, resets_at in unix seconds).
export function parseClaudeRateLimits(rl: unknown): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return out;
  const obj = rl as Record<string, unknown>;
  const known: [string, string, number, string, string, boolean][] = [
    ['five_hour', '5h', 300, 'claude', 'Claude', true],
    ['seven_day', '7d', 10080, 'claude', 'Claude', true],
    ['seven_day_sonnet', '7d', 10080, 'sonnet', 'Sonnet', false],
    ['seven_day_opus', '7d', 10080, 'opus', 'Opus', false],
    ['five_hour_sonnet', '5h', 300, 'sonnet', 'Sonnet', false],
    ['five_hour_opus', '5h', 300, 'opus', 'Opus', false],
  ];
  for (const [key, label, windowMinutes, pool, poolLabel, primary] of known) {
    const w = obj[key] as Record<string, unknown> | null | undefined;
    if (w && isNum(w.used_percentage) && isNum(w.resets_at)) {
      out.push({ label, usedPercent: pct(w.used_percentage), resetsAt: w.resets_at * 1000, windowMinutes, pool, poolLabel, primary });
    }
  }
  return out;
}

interface AgyBucketMeta {
  label: string;
  windowMinutes: number;
  pool: string;
  poolLabel: string;
  primary: boolean;
  rank: number;
}

function parseWindowUnit(raw: string): { label: string; minutes: number; subRank: number } | null {
  if (raw === '5h' || raw === '5hr' || raw === 'five_hour') return { label: '5h', minutes: 300, subRank: 0 };
  if (raw === 'daily' || raw === '1d' || raw === '24h') return { label: '1d', minutes: 1440, subRank: 1 };
  if (raw === 'weekly' || raw === '7d' || raw === 'seven_day') return { label: '7d', minutes: 10080, subRank: 2 };
  return null;
}

function agyPoolInfo(prefix: string): { pool: string; poolLabel: string; primary: boolean; baseRank: number } {
  const p = prefix.toLowerCase();
  if (p === 'gemini' || !p) return { pool: 'gemini', poolLabel: 'Gemini', primary: true, baseRank: 0 };
  if (p === '3p' || p === 'shared' || p === 'third_party' || p === 'thirdparty') {
    return { pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false, baseRank: 10 };
  }
  if (p === 'claude') return { pool: 'claude', poolLabel: 'Claude', primary: false, baseRank: 20 };
  if (p === 'gpt' || p === 'openai') return { pool: 'gpt', poolLabel: 'GPT', primary: false, baseRank: 30 };
  return { pool: p, poolLabel: p.toUpperCase(), primary: false, baseRank: 40 };
}

function agyBucketMeta(key: string): AgyBucketMeta | null {
  const raw = key.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'gemini') {
    return { label: '配额', windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true, rank: 2.5 };
  }
  const direct = parseWindowUnit(raw);
  if (direct) {
    return {
      label: direct.label,
      windowMinutes: direct.minutes,
      pool: 'gemini',
      poolLabel: 'Gemini',
      primary: true,
      rank: direct.subRank,
    };
  }
  const m = /^([a-z0-9]+)[-_]+(.+)$/.exec(raw);
  if (m) {
    const [, prefix, rest] = m;
    const poolInfo = agyPoolInfo(prefix);
    const unit = parseWindowUnit(rest);
    if (unit) {
      return {
        label: unit.label,
        windowMinutes: unit.minutes,
        pool: poolInfo.pool,
        poolLabel: poolInfo.poolLabel,
        primary: poolInfo.primary,
        rank: poolInfo.baseRank + unit.subRank,
      };
    }
    // Nested sub-pool like gemini-pro-5h
    const sub = /^([a-z0-9]+)[-_]+(5h|5hr|five_hour|daily|1d|24h|weekly|7d|seven_day)$/.exec(rest);
    if (sub) {
      const inner = parseWindowUnit(sub[2])!;
      return {
        label: `${sub[1]} ${inner.label}`,
        windowMinutes: inner.minutes,
        pool: `${poolInfo.pool}-${sub[1]}`,
        poolLabel: `${poolInfo.poolLabel} ${sub[1]}`,
        primary: poolInfo.primary,
        rank: poolInfo.baseRank + inner.subRank + 0.5,
      };
    }
    return {
      label: rest.replace(/[-_]+/g, ' '),
      windowMinutes: 300,
      pool: poolInfo.pool,
      poolLabel: poolInfo.poolLabel,
      primary: poolInfo.primary,
      rank: poolInfo.baseRank + 3,
    };
  }
  return {
    label: raw.replace(/[-_]+/g, ' '),
    windowMinutes: 300,
    pool: 'other',
    poolLabel: '其他',
    primary: false,
    rank: 50,
  };
}

// Antigravity's status line `quota` ({ 'gemini-5h'?, 'gemini-weekly'?, '3p-5h'?, '3p-weekly'?, ... }) as windows.
// Keeps both the primary Gemini pool and secondary shared/3p pools so Popover / Dashboard / Inspector can show every pool.
// Note: StatusLineQuotaBucket in agy's Go struct marks `remaining_fraction`, `reset_time` and `reset_in_seconds` as
// `omitempty`: 0.0 remaining is omitted when depleted (reset still present -> 100% used), while an untouched bucket
// (`remaining_fraction: 1`) either omits reset fields or sets `reset_time` to Unix epoch ("1970-01-01T00:00:00Z").
export function parseAgyQuota(quota: unknown, now = Date.now()): QuotaWindow[] {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return [];
  const entries = Object.entries(quota as Record<string, unknown>).filter(
    ([, v]) => !!v && typeof v === 'object' && !Array.isArray(v),
  ) as [string, Record<string, unknown>][];
  if (!entries.length) return [];
  const hasGemini = entries.some(([k]) => /^gemini(?:[-_]|$)/i.test(k.trim()));
  const ranked: { window: QuotaWindow; rank: number }[] = [];
  for (const [key, b] of entries) {
    const meta = agyBucketMeta(key);
    if (!meta) continue;
    let resetsAt: number | null = null;
    let epochReset = false;
    const rawResetTime = typeof b.reset_time === 'string' ? b.reset_time.trim() : '';
    if (rawResetTime) {
      const t = Date.parse(rawResetTime);
      if (Number.isFinite(t)) {
        if (t > 0) resetsAt = t;
        else if (t === 0) epochReset = true;
      }
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
    const missingReset = (b.reset_time === undefined || rawResetTime === '') &&
      (b.reset_in_seconds === undefined || b.reset_in_seconds === 0);
    const unstarted = resetsAt === null && usedPercent === 0 && (epochReset || missingReset);
    if (!unstarted && resetsAt === null) continue;
    ranked.push({
      window: {
        label: meta.label,
        usedPercent,
        resetsAt: unstarted ? 0 : resetsAt!,
        ...(unstarted ? { unstarted: true } : {}),
        windowMinutes: meta.windowMinutes,
        pool: meta.pool,
        poolLabel: meta.poolLabel,
        primary: hasGemini ? meta.primary : true,
      },
      rank: meta.rank,
    });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map(r => r.window);
}

// Window length in minutes as a short label: codex's 300 / 10080 are the 5-hour and weekly windows.
export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  return minutes > 0 && minutes % 1440 === 0 ? `${minutes / 1440}d` : `${minutes}m`;
}

export interface ParsedCodexQuota {
  windows: QuotaWindow[];
  plan?: string;
}

// The last rate_limits with a non-null primary or secondary in codex rollout text (event_msg token_count lines).
export function parseCodexQuotaInfo(text: string): ParsedCodexQuota | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let rl: Record<string, unknown> | null | undefined;
    try {
      const o = JSON.parse(lines[i]);
      rl = (o?.payload?.rate_limits ?? o?.rate_limits) as Record<string, unknown> | null | undefined;
    } catch { continue; /* cut first line of the tail */ }
    if (!rl || typeof rl !== 'object') continue;
    const pool = typeof rl.limit_id === 'string' && rl.limit_id.trim() ? rl.limit_id.trim() : 'codex';
    const poolLabel = typeof rl.limit_name === 'string' && rl.limit_name.trim() ? rl.limit_name.trim() : 'Codex';
    const plan = typeof rl.plan_type === 'string' && rl.plan_type.trim() ? rl.plan_type.trim() : undefined;
    const windows: QuotaWindow[] = [];
    for (const key of ['primary', 'secondary']) {
      const w = rl[key] as Record<string, unknown> | null | undefined;
      if (w && isNum(w.used_percent) && isNum(w.window_minutes) && isNum(w.resets_at)) {
        windows.push({
          label: windowLabel(w.window_minutes),
          usedPercent: pct(w.used_percent),
          resetsAt: w.resets_at * 1000,
          windowMinutes: w.window_minutes,
          pool,
          poolLabel,
          primary: true,
        });
      }
    }
    if (windows.length) return { windows, ...(plan ? { plan } : {}) };
  }
  return null;
}

export function parseCodexRateLimits(text: string): QuotaWindow[] | null {
  return parseCodexQuotaInfo(text)?.windows ?? null;
}

// Quota windows + plan from the tail of a codex rollout file; null when missing, unreadable or without data. Never throws.
export function readCodexQuotaInfo(transcriptPath: string): ParsedCodexQuota | null {
  try {
    return parseCodexQuotaInfo(readTail(transcriptPath));
  } catch {
    return null;
  }
}

export function readCodexQuota(transcriptPath: string): QuotaWindow[] | null {
  return readCodexQuotaInfo(transcriptPath)?.windows ?? null;
}

const DISK_QUOTA_CACHE_MAX = 64;
const diskQuotaCache = new Map<string, ParsedCodexQuota | null>();

function readCodexQuotaInfoCached(file: string, st: fs.Stats): ParsedCodexQuota | null {
  const key = `${file}|${st.ino}|${st.mtimeMs}|${st.ctimeMs}|${st.size}`;
  if (diskQuotaCache.has(key)) return diskQuotaCache.get(key) ?? null;
  let text: string;
  try {
    text = readTail(file);
  } catch {
    return null; // do not cache transient read failures
  }
  const parsed = parseCodexQuotaInfo(text);
  if (diskQuotaCache.size >= DISK_QUOTA_CACHE_MAX) {
    const oldest = diskQuotaCache.keys().next().value;
    if (oldest !== undefined) diskQuotaCache.delete(oldest);
  }
  diskQuotaCache.set(key, parsed);
  return parsed;
}

export interface DiskCodexQuotaResult {
  quota: ParsedCodexQuota;
  mtimeMs: number;
}

const DATE_DIR_RE = /^\d{2,4}$/;

function sortDirEntriesNewestFirst(dirs: fs.Dirent[]): fs.Dirent[] {
  return dirs.sort((a, b) => {
    const aDate = DATE_DIR_RE.test(a.name);
    const bDate = DATE_DIR_RE.test(b.name);
    if (aDate !== bDate) return aDate ? -1 : 1;
    if (aDate && bDate) {
      const diff = Number(b.name) - Number(a.name);
      if (diff !== 0) return diff;
    }
    return b.name.localeCompare(a.name);
  });
}

// Lightweight scan of the most recent Codex rollout files on disk so Codex quota can be warmed/refreshed without waiting for a Stop hook.
// Prioritizes date-partitioned subdirectories (YYYY/MM/DD) newest-first, checks recent day buckets jointly by mtimeMs
// (so a resumed session in a prior day still wins), and continues scanning older days if recent rollouts have no live quota.
export function readLatestCodexQuotaFromDiskWithMeta(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): DiskCodexQuotaResult | null {
  try {
    const sessionsRoot = path.join(codexHome, 'sessions');
    if (!fs.existsSync(sessionsRoot)) return null;

    // Collect leaf directories containing rollouts in newest-date-first order (capped at 36 directories for safety).
    const leafDirs: string[] = [];
    const MAX_LEAF_DIRS = 36;
    const walkDirs = (dir: string, depth: number) => {
      if (depth > 4 || leafDirs.length >= MAX_LEAF_DIRS) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const hasRollout = entries.some(e => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'));
      if (hasRollout) leafDirs.push(dir);
      const subdirs = sortDirEntriesNewestFirst(entries.filter(e => e.isDirectory()));
      for (const d of subdirs) {
        if (leafDirs.length >= MAX_LEAF_DIRS) break;
        walkDirs(path.join(dir, d.name), depth + 1);
      }
    };
    walkDirs(sessionsRoot, 0);
    if (!leafDirs.length) return null;

    const collectFromDirs = (dirs: string[]) => {
      const out: { file: string; st: fs.Stats }[] = [];
      for (const dir of dirs) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
          const full = path.join(dir, e.name);
          try {
            out.push({ file: full, st: fs.statSync(full) });
          } catch { /* vanished */ }
        }
      }
      out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      return out;
    };

    const now = Date.now();
    const MAX_FILES_CHECKED = 128;
    // Collect rollout files across all newest date-prioritized leaf directories and sort globally by mtimeMs,
    // so a recently resumed session in an older day directory (e.g. day 8+) always beats older mtimes.
    const candidates = collectFromDirs(leafDirs);
    let checked = 0;
    for (const c of candidates) {
      if (checked >= MAX_FILES_CHECKED) break;
      checked++;
      const parsed = readCodexQuotaInfoCached(c.file, c.st);
      if (parsed && parsed.windows.some(w => w.resetsAt > now)) {
        return { quota: parsed, mtimeMs: c.st.mtimeMs };
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function readLatestCodexQuotaFromDisk(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): ParsedCodexQuota | null {
  return readLatestCodexQuotaFromDiskWithMeta(codexHome)?.quota ?? null;
}

// Extracts live session context occupancy from Claude Code or Antigravity statusLine payloads.
export function parseStatusLineContext(agent: AgentKind, payload: Record<string, unknown> | null | undefined, now = Date.now()): SessionContext | null {
  if (!payload || typeof payload !== 'object') return null;
  const cw = payload.context_window as Record<string, unknown> | null | undefined;
  if (!cw || typeof cw !== 'object' || Array.isArray(cw)) return null;
  const modelRaw = payload.model;
  const model = typeof modelRaw === 'string'
    ? modelRaw
    : modelRaw && typeof modelRaw === 'object'
      ? (typeof (modelRaw as Record<string, unknown>).id === 'string'
        ? String((modelRaw as Record<string, unknown>).id)
        : typeof (modelRaw as Record<string, unknown>).display_name === 'string'
          ? String((modelRaw as Record<string, unknown>).display_name)
          : undefined)
      : undefined;
  const maxSize = isNum(cw.context_window_size) && cw.context_window_size > 0
    ? cw.context_window_size
    : inferContextWindowSize(model, agent);
  const cu = cw.current_usage && typeof cw.current_usage === 'object' ? (cw.current_usage as Record<string, unknown>) : null;
  const uncached = cu && isNum(cu.input_tokens) && cu.input_tokens >= 0 ? cu.input_tokens : 0;
  const cacheRead = cu && isNum(cu.cache_read_input_tokens) && cu.cache_read_input_tokens >= 0 ? cu.cache_read_input_tokens : 0;
  const cacheCreate = cu && isNum(cu.cache_creation_input_tokens) && cu.cache_creation_input_tokens >= 0 ? cu.cache_creation_input_tokens : 0;
  const cached = cacheRead + cacheCreate;
  let usedTokens = uncached + cached;
  let usedPercent: number | null = isNum(cw.used_percentage) ? pct(cw.used_percentage) : null;
  if (usedTokens === 0 && usedPercent !== null && maxSize > 0) {
    usedTokens = Math.round((usedPercent / 100) * maxSize);
  }
  if (usedPercent === null && usedTokens > 0 && maxSize > 0) {
    usedPercent = pct(Math.round((usedTokens / maxSize) * 1000) / 10);
  }
  if (usedPercent === null) return null;
  const totalIn = uncached + cached;
  const cacheHitRate = totalIn > 0 ? cacheRead / totalIn : null;
  return {
    contextWindowSize: maxSize,
    usedTokens,
    cachedTokens: cached,
    uncachedTokens: uncached || Math.max(0, usedTokens - cached),
    usedPercent,
    cacheHitRate,
    ...(model ? { model } : {}),
    updatedAt: now,
  };
}

const sameQuotaPayload = (a: QuotaInfo, b: QuotaWindow[], plan?: string, source?: QuotaInfo['source']) =>
  JSON.stringify(a.windows) === JSON.stringify(b) && (plan === undefined || a.plan === plan) && (source === undefined || a.source === source);

// Latest quota per agent kind, kept in memory and in a JSON file so it survives a restart.
export interface QuotaStore {
  all(): Partial<Record<AgentKind, QuotaInfo>>;
  // The new entry, or null (nothing changes) when the windows are the same as before or empty.
  set(agent: AgentKind, windows: QuotaWindow[], at?: number, meta?: { plan?: string; source?: QuotaInfo['source'] }): QuotaInfo | null;
  // Removes an entry (e.g. a deleted/disabled/re-targeted custom CLI bucket); returns true if one existed.
  delete(agent: AgentKind): boolean;
}

export function createQuotaStore(file: string): QuotaStore {
  let data: Partial<Record<AgentKind, QuotaInfo>> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [agent, q] of Object.entries(raw as Record<string, QuotaInfo>)) {
        const windows = Array.isArray(q?.windows)
          ? q.windows
            .filter(w => w && typeof w.label === 'string' && isNum(w.usedPercent) && isNum(w.resetsAt))
            .map(w => ({
              ...w,
              ...(w.unstarted !== true && w.resetsAt === 0 && w.usedPercent === 0 ? { unstarted: true } : {}),
              ...(w.windowMinutes === undefined && inferWindowMinutes(w.label) !== undefined
                ? { windowMinutes: inferWindowMinutes(w.label) }
                : {}),
            }))
          : [];
        if (windows.length && isNum(q.at)) {
          data[agent as AgentKind] = {
            windows,
            at: q.at,
            ...(typeof q.plan === 'string' && q.plan ? { plan: q.plan } : {}),
            ...(q.source ? { source: q.source } : {}),
          };
        }
      }
    }
  } catch { /* missing or corrupt: start empty */ }
  return {
    all: () => data,
    set(agent, windows, at = Date.now(), meta) {
      if (!windows.length) return null;
      const prev = data[agent];
      const nextPlan = meta?.plan ?? prev?.plan;
      const nextSource = meta?.source ?? prev?.source;
      if (prev && sameQuotaPayload(prev, windows, nextPlan, nextSource) && (nextSource !== 'provider' || at <= prev.at)) return null;
      const info: QuotaInfo = {
        windows,
        at,
        ...(nextPlan ? { plan: nextPlan } : {}),
        ...(nextSource ? { source: nextSource } : {}),
      };
      data = { ...data, [agent]: info };
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (e) {
        console.warn('[quota.json]', (e as Error).message);
      }
      return info;
    },
    delete(agent) {
      if (!(agent in data)) return false;
      const next = { ...data };
      delete next[agent];
      data = next;
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (e) {
        console.warn('[quota.json]', (e as Error).message);
      }
      return true;
    },
  };
}
