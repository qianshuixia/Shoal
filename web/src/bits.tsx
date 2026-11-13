import { useRef, useState } from 'react';
import type { AgentKind, QuotaInfo, QuotaWindow, SessionStatus, UsageCounts } from '../../shared/protocol.ts';
import { usageTotal } from '../../shared/protocol.ts';
import { AgentIcon } from './agentIcons.tsx';
import { QUOTA_WARN, quotaTitle } from './quota.ts';
import { fmtPct, fmtTokens, hitRate, STATUS_LABEL, waitText } from './util.ts';
import { usePrivacy } from './privacy.ts';

// Double-click (or the parent's rename button, via editing/onEditingChange) to rename; Enter or blur saves, Esc cancels.
export function EditableTitle({ title, className, testId = 'task-title-text', onSave, editing: outer, onEditingChange }: {
  title: string;
  className?: string;
  testId?: string;
  onSave(title: string): void;
  editing?: boolean;
  onEditingChange?(editing: boolean): void;
}) {
  const [own, setOwn] = useState(false);
  const editing = outer ?? own;
  const setEditing = onEditingChange ?? setOwn;
  const done = useRef(false);
  const privacy = usePrivacy();

  if (!editing) {
    done.current = false;
    return (
      <span
        className={className}
        data-testid={testId}
        title={privacy ? undefined : `${title}（双击改名）`}
        data-private=""
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >{title}</span>
    );
  }

  const finish = (value: string | null) => {
    if (done.current) return; // Enter followed by the blur it causes
    done.current = true;
    setEditing(false);
    const next = value?.trim();
    if (next && next !== title) onSave(next);
  };
  return (
    <input
      className={`title-input ${className ?? ''}`}
      data-testid="title-input"
      defaultValue={title}
      maxLength={80}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export function PencilIcon() {
  return (
    <svg style={{ width: '0.8125rem', height: '0.8125rem' }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </svg>
  );
}

export function StatusTag({ status, since, now }: { status: SessionStatus; since?: number; now: number }) {
  return (
    <span className={`status st-${status}`} data-testid="status">
      {status === 'needs_you' && since ? waitText(now - since) : STATUS_LABEL[status]}
    </span>
  );
}

type RingTone = 'ok' | 'mid' | 'warn' | 'full';

export function RingGauge({ percent, tone, size = 14 }: { percent: number; tone: RingTone; size?: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, percent));
  // Keep tiny non-zero usage visible as a crisp sliver at 12 o'clock without changing 0%.
  const vis = clamped === 0 ? 0 : Math.max(clamped, 3.5);
  return (
    <svg className={`ring-gauge tone-${tone}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="ring-track" cx="8" cy="8" r={r} />
      {clamped > 0 && (
        <circle className="ring-fill" cx="8" cy="8" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - vis / 100)} />
      )}
    </svg>
  );
}

const quotaTone = (p: number): RingTone => (p >= 100 ? 'full' : p >= QUOTA_WARN ? 'warn' : p >= 50 ? 'mid' : 'ok');
const cacheTone = (r: number): RingTone => (r >= 0.7 ? 'ok' : r >= 0.4 ? 'mid' : 'warn');

export function QuotaPill({
  agent, quota, windows, now, compact = false,
}: {
  agent: AgentKind;
  quota: QuotaInfo;
  windows: QuotaWindow[];
  now: number;
  compact?: boolean;
}) {
  const prefix = compact ? 'pane-quota' : 'quota';
  return (
    <span
      className={`quota ${compact ? 'pane-quota' : ''}`}
      data-testid={prefix}
      data-agent={agent}
      title={quotaTitle(agent, quota, windows, now)}
    >
      {!compact && <AgentIcon agent={agent} />}
      {windows.map((w) => (
        <span
          key={w.label}
          className={`quota-win ${w.usedPercent >= QUOTA_WARN ? 'warn' : ''} ${w.usedPercent >= 100 ? 'full' : ''}`}
          data-testid={`${prefix}-window`}
          data-label={w.label}
        >
          <RingGauge percent={w.usedPercent} tone={quotaTone(w.usedPercent)} size={compact ? 13 : 14} />
          {w.label} {Math.round(w.usedPercent)}%
        </span>
      ))}
    </span>
  );
}

function telemetryTitle(head: string, c: UsageCounts, tps: number | null, rate: number | null): string {
  const total = usageTotal(c);
  const full = (n: number) => n.toLocaleString('en-US');
  const lines = [
    head,
    `总 Token：${full(total)}（输入 ${fmtTokens(c.input)} · 输出 ${fmtTokens(c.output)} · 缓存读 ${fmtTokens(c.cacheRead)}${c.cacheWrite ? ` · 缓存写 ${fmtTokens(c.cacheWrite)}` : ''}）`,
    `缓存命中率：${rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}（${full(c.requests)} 次模型响应）`,
  ];
  if (tps !== null) lines.push(`生成速率：${tps.toFixed(1)} tok/s（近几次响应平均）`);
  return lines.join('\n');
}

export function TelemetryPill({
  counts, tps, label, compact = false, onClick, testId,
}: {
  counts: UsageCounts;
  tps: number | null;
  label: string;
  compact?: boolean;
  onClick?(): void;
  testId?: string;
}) {
  const total = usageTotal(counts);
  if (total <= 0) return null;
  const rate = hitRate(counts);
  const tip = telemetryTitle(label, counts, tps, rate);
  const body = (
    <>
      <span className="tel-item">
        <svg className="tel-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.2 13.2 5v6L8 13.8 2.8 11V5z" />
          <path d="M2.8 5 8 7.8 13.2 5M8 7.8v6" />
        </svg>
        {!compact && <span className="tel-k">今日</span>}
        <span className="tel-v">{fmtTokens(total)}</span>
      </span>
      {rate !== null && (
        <span className="tel-item">
          <RingGauge percent={rate * 100} tone={cacheTone(rate)} size={compact ? 13 : 14} />
          <span className="tel-k">缓存</span>
          <span className="tel-v">{fmtPct(rate)}</span>
        </span>
      )}
      {tps !== null && (
        <span className="tel-item tel-speed">
          <svg className="tel-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9 1.8 3.8 9h4.1L7 14.2 12.2 7H8.1z" />
          </svg>
          <span className="tel-v">{tps >= 100 ? Math.round(tps) : tps.toFixed(1)}</span>
          <span className="tel-u">tok/s</span>
        </span>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="telemetry-pill clickable" data-testid={testId} title={tip} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <span className="telemetry-pill compact" data-testid={testId} title={tip}>
      {body}
    </span>
  );
}
