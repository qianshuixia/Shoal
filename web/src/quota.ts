import { AGENT_LABEL } from '../../shared/protocol.ts';
import type { AgentKind, QuotaInfo, QuotaWindow } from '../../shared/protocol.ts';

// Agents in header order.
export const QUOTA_AGENTS: AgentKind[] = ['claude', 'codex', 'agy', 'fake'];
export const QUOTA_WARN = 80;

const hm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

// Windows whose reset is still ahead; an expired one says nothing about the current usage.
export const liveWindows = (q: QuotaInfo | undefined, now: number): QuotaWindow[] => (q?.windows ?? []).filter(w => w.resetsAt > now);

function windowName(label: string): string {
  const m = /^(?:(.+)\s+)?(\d+)([hdm])$/.exec(label);
  if (!m) return `${label} 窗口`;
  return `${m[1] ? `${m[1]} ` : ''}${m[2]} ${{ h: '小时', d: '天', m: '分钟' }[m[3] as 'h' | 'd' | 'm']}窗口`;
}

function resetClock(t: number, now: number): string {
  const d = new Date(t);
  return new Date(now).toDateString() === d.toDateString() ? hm(t) : `${d.getMonth() + 1}月${d.getDate()}日 ${hm(t)}`;
}

function remaining(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins} 分钟后`;
  if (mins < 24 * 60) return mins % 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分后` : `${mins / 60} 小时后`;
  return `${Math.floor(mins / (24 * 60))} 天后`;
}

// Multi-line tooltip of one agent's quota.
export function quotaTitle(agent: AgentKind, q: QuotaInfo, windows: QuotaWindow[], now: number): string {
  const head = agent === 'agy' ? 'Antigravity (Gemini) 订阅额度' : `${AGENT_LABEL[agent]} 订阅额度`;
  return [
    head,
    ...windows.map(w => `${windowName(w.label)}：已用 ${Math.round(w.usedPercent)}%，${resetClock(w.resetsAt, now)} 重置（${remaining(w.resetsAt - now)}）`),
    `更新于 ${hm(q.at)}`,
  ].join('\n');
}
