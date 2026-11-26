import { agentLabel } from '../../shared/protocol.ts';
import type { AgentKind, QuotaInfo, QuotaWindow } from '../../shared/protocol.ts';

// Agents in header order.
export const QUOTA_AGENTS: AgentKind[] = ['claude', 'codex', 'agy', 'pi', 'fake'];
export const QUOTA_WARN = 80; // usedPercent >= 80 (i.e. remaining <= 20) triggers warning styling

export type QuotaDisplayMode = 'remaining' | 'used';
const MODE_KEY = 'wb.quotaMode';

export function loadQuotaMode(): QuotaDisplayMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'used' ? 'used' : 'remaining';
  } catch {
    return 'remaining';
  }
}

export function saveQuotaMode(mode: QuotaDisplayMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch { /* ignore storage restrictions */ }
}

const hm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

// Windows whose reset is still ahead; an expired one says nothing about the current usage.
export const liveWindows = (q: QuotaInfo | undefined, now: number): QuotaWindow[] =>
  (q?.windows ?? []).filter(w => w.resetsAt > now);

// Primary pool windows for compact topbar / pane pills (falls back to all when none is explicitly primary).
export function primaryWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const prim = windows.filter(w => w.primary !== false);
  return prim.length ? prim : windows;
}

export function secondaryWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const prim = primaryWindows(windows);
  const primSet = new Set(prim);
  return windows.filter(w => !primSet.has(w));
}

export interface WindowPoolGroup {
  pool: string;
  poolLabel: string;
  primary: boolean;
  windows: QuotaWindow[];
}

export function groupWindowsByPool(windows: QuotaWindow[], fallbackLabel: string): WindowPoolGroup[] {
  const map = new Map<string, WindowPoolGroup>();
  for (const w of windows) {
    const key = w.pool ?? (w.primary === false ? 'secondary' : 'primary');
    let g = map.get(key);
    if (!g) {
      g = {
        pool: key,
        poolLabel: w.poolLabel ?? fallbackLabel,
        primary: w.primary !== false,
        windows: [],
      };
      map.set(key, g);
    }
    g.windows.push(w);
  }
  return [...map.values()];
}

export function inferWindowMs(w: QuotaWindow): number | null {
  if (typeof w.windowMinutes === 'number' && Number.isFinite(w.windowMinutes) && w.windowMinutes > 0) {
    return w.windowMinutes * 60_000;
  }
  const m = /(?:^|\s)(\d+)([hdm])$/i.exec(w.label.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  return n * 86_400_000;
}

export type QuotaPace = 'ahead' | 'steady' | 'fast' | 'depleted';
export type QuotaTone = 'ok' | 'mid' | 'warn' | 'full';

export interface WindowMetrics {
  usedPercent: number;
  leftPercent: number;
  /** 0-100: how much of the rolling window duration has elapsed; null if duration unknown */
  timeElapsedPct: number | null;
  /** 0-100: ideal remaining percent if consumed linearly across the window */
  idealLeftPct: number | null;
  /** leftPercent - idealLeftPct: positive means surplus (ahead), negative means burning faster than time */
  paceDelta: number | null;
  pace: QuotaPace;
  tone: QuotaTone;
  resetRelative: string;
  resetClock: string;
}

export function windowName(label: string): string {
  const m = /^(?:(.+)\s+)?(\d+)([hdm])$/.exec(label);
  if (!m) return `${label} 窗口`;
  return `${m[1] ? `${m[1]} ` : ''}${m[2]} ${{ h: '小时', d: '天', m: '分钟' }[m[3] as 'h' | 'd' | 'm']}窗口`;
}

export function shortWindowTitle(w: QuotaWindow): string {
  const span = w.label === '5h' ? '5-hour' : w.label === '7d' ? 'Weekly' : w.label === '1d' ? 'Daily' : w.label;
  return w.poolLabel ? `${w.poolLabel} · ${span}` : span;
}

export function resetClock(t: number, now: number): string {
  const d = new Date(t);
  return new Date(now).toDateString() === d.toDateString() ? hm(t) : `${d.getMonth() + 1}月${d.getDate()}日 ${hm(t)}`;
}

export function remainingCompact(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(mins / (24 * 60));
  const h = Math.floor((mins % (24 * 60)) / 60);
  return `${d}d ${h}h`;
}

export function remainingLong(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins} 分钟后`;
  if (mins < 24 * 60) return mins % 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分后` : `${mins / 60} 小时后`;
  return `${Math.floor(mins / (24 * 60))} 天后`;
}

export function fmtRelativeAge(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function quotaTone(usedPercent: number): QuotaTone {
  if (usedPercent >= 100) return 'full';
  if (usedPercent >= QUOTA_WARN) return 'warn';
  if (usedPercent >= 50) return 'mid';
  return 'ok';
}

export function windowMetrics(w: QuotaWindow, now: number): WindowMetrics {
  const usedPercent = Math.min(100, Math.max(0, w.usedPercent));
  const leftPercent = Math.max(0, 100 - usedPercent);
  const remMs = Math.max(0, w.resetsAt - now);
  const winMs = inferWindowMs(w);
  let timeElapsedPct: number | null = null;
  let idealLeftPct: number | null = null;
  let paceDelta: number | null = null;
  if (winMs && winMs > 0) {
    const elapsed = Math.min(1, Math.max(0, 1 - remMs / winMs));
    timeElapsedPct = Math.round(elapsed * 1000) / 10;
    idealLeftPct = Math.round((1 - elapsed) * 1000) / 10;
    paceDelta = Math.round((leftPercent - idealLeftPct) * 10) / 10;
  }
  let pace: QuotaPace;
  if (usedPercent >= 100) pace = 'depleted';
  else if (usedPercent >= QUOTA_WARN || (paceDelta !== null && paceDelta <= -10)) pace = 'fast';
  else if (paceDelta !== null && paceDelta >= 8) pace = 'ahead';
  else pace = 'steady';

  return {
    usedPercent,
    leftPercent,
    timeElapsedPct,
    idealLeftPct,
    paceDelta,
    pace,
    tone: quotaTone(usedPercent),
    resetRelative: `${remainingCompact(remMs)} 后重置`,
    resetClock: resetClock(w.resetsAt, now),
  };
}

export function displayPercent(w: QuotaWindow, mode: QuotaDisplayMode): number {
  const used = Math.min(100, Math.max(0, w.usedPercent));
  return Math.round(mode === 'remaining' ? 100 - used : used);
}

// Multi-line tooltip of one agent's quota (reflects the selected remaining/used display mode).
export function quotaTitle(agent: AgentKind, q: QuotaInfo, windows: QuotaWindow[], now: number, mode: QuotaDisplayMode = 'remaining'): string {
  const head = `${agentLabel(agent)} 订阅额度${q.plan ? ` · ${q.plan}` : ''}`;
  const fmtWin = (w: QuotaWindow) => {
    const val = displayPercent(w, mode);
    const word = mode === 'remaining' ? '剩余' : '已用';
    const prefix = w.primary === false && w.poolLabel ? `[${w.poolLabel}] ` : '';
    return `${prefix}${windowName(w.label)}：${word} ${val}%，${resetClock(w.resetsAt, now)} 重置（${remainingLong(w.resetsAt - now)}）`;
  };
  return [head, ...windows.map(fmtWin), `更新于 ${hm(q.at)}（点击查看详情）`].join('\n');
}

export interface SwitchCandidate {
  agent: AgentKind;
  minLeftPercent: number;
}

// Suggests the most spacious alternative CLI when the current agent's primary quota is tight (<= 20% left).
export function bestSwitchCandidate(
  quota: Partial<Record<AgentKind, QuotaInfo>>,
  availableAgents: readonly AgentKind[],
  currentAgent: AgentKind | undefined,
  now: number,
): SwitchCandidate | null {
  if (!currentAgent) return null;
  const curLive = primaryWindows(liveWindows(quota[currentAgent], now));
  const curMinLeft = curLive.length ? Math.min(...curLive.map(w => 100 - w.usedPercent)) : 100;
  if (curMinLeft > 20) return null;
  let best: SwitchCandidate | null = null;
  for (const a of availableAgents) {
    if (a === currentAgent) continue;
    const ws = primaryWindows(liveWindows(quota[a], now));
    if (!ws.length) continue;
    const minLeft = Math.round(Math.min(...ws.map(w => 100 - w.usedPercent)));
    if (minLeft > curMinLeft + 15 && (!best || minLeft > best.minLeftPercent)) {
      best = { agent: a, minLeftPercent: minLeft };
    }
  }
  return best;
}

export function vendorPlanBadge(agent: AgentKind, q?: QuotaInfo): string {
  if (q?.plan) {
    const p = q.plan.trim();
    if (p.toLowerCase() === 'plus') return 'Plus';
    if (p.toLowerCase() === 'pro') return 'Pro';
    if (p.toLowerCase() === 'team') return 'Team';
    if (p.toLowerCase() === 'max') return 'Max';
    if (p.toLowerCase() === 'ultra') return 'Ultra';
    return p;
  }
  if (agent === 'agy') return 'Google account';
  if (agent === 'claude') return 'Claude 订阅';
  if (agent === 'codex') return 'Codex 订阅';
  return '订阅';
}
