import type { SessionStatus, UsageCounts } from '../../shared/protocol.ts';
import { usageCacheHitRate } from '../../shared/protocol.ts';

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

export function waitText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `等 ${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `等 ${m}分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `等 ${h}时${rest}分` : `等 ${h}时`;
}
