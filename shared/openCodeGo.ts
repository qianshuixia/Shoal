import type { QuotaWindow } from './protocol.ts';

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';
export const PI_QUOTA_RESULT = 'SHOAL_PI_QUOTA ';

const METERS = [
  { key: 'rolling', label: '5h', minutes: 300 },
  { key: 'weekly', label: '7d', minutes: 10080 },
  { key: 'monthly', label: '月度' },
] as const;

export function isOfficialOpenCodeGoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://opencode.ai' && !url.username && !url.password
      && /^\/(?:inference|zen)\/go(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export function parseOpenCodeGoUsage(payload: unknown): QuotaWindow[] {
  const usage = obj(obj(payload)?.usage);
  if (!usage) return [];
  return METERS.flatMap(meter => {
    const value = obj(usage[meter.key]);
    if (!value || (value.status !== 'ok' && value.status !== 'rate-limited')) return [];
    const { percent, resetsAt } = value;
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100 || typeof resetsAt !== 'string') return [];
    const reset = Date.parse(resetsAt);
    if (!Number.isFinite(reset) || reset <= 0) return [];
    return [{
      label: meter.label, usedPercent: percent, resetsAt: reset, pool: 'opencode-go', poolLabel: 'OpenCode Go',
      ...('minutes' in meter ? { windowMinutes: meter.minutes } : {}),
    }];
  });
}
