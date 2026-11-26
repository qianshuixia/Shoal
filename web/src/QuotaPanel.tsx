import { useEffect, useRef } from 'react';
import type { AgentKind, CliToolInfo, GitInfo, Project, QuotaInfo, QuotaWindow, SessionContext, SessionInfo, Task, TaskMetrics } from '../../shared/protocol.ts';
import { agentLabel } from '../../shared/protocol.ts';
import { AgentIcon } from './agentIcons.tsx';
import { RingGauge } from './bits.tsx';
import {
  QUOTA_AGENTS, QUOTA_WARN, bestSwitchCandidate, displayPercent, fmtRelativeAge,
  liveWindows, primaryWindows, quotaTitle, quotaTone, secondaryWindows, shortWindowTitle, vendorPlanBadge,
  windowMetrics, type QuotaDisplayMode, type QuotaPace,
} from './quota.ts';
import { fmtPct, fmtTokens, hitRate } from './util.ts';

export function PaceGlyph({ pace, delta }: { pace: QuotaPace; delta: number | null }) {
  const tip = pace === 'idle'
    ? '未使用，首次调用后开始计时'
    : pace === 'depleted'
      ? '当前窗口额度已耗尽'
      : pace === 'fast'
        ? `消耗快于时间进度${delta !== null ? `（${Math.round(delta)}%）` : ''}`
        : pace === 'ahead'
          ? `额度充裕，慢于时间消耗${delta !== null ? `（+${Math.round(delta)}%）` : ''}`
          : '消耗与时间进度基本同步';
  return (
    <span className={`pace-glyph pace-${pace}`} title={tip} aria-label={tip}>
      {pace === 'idle' ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>
      ) : pace === 'ahead' ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5l4 4 2.5-2.5 4.5 4.5M10.5 11.5h3v-3" /></svg>
      ) : pace === 'fast' ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 11.5l4-4 2.5 2.5 4.5-4.5M10.5 5.5h3v3" /></svg>
      ) : pace === 'depleted' ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v3.3M8 10.8h.01" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5a5 5 0 0 1 10 0M8 10.5l2.2-3" /></svg>
      )}
    </span>
  );
}

// Wide progress bar with hatched remainder track and a crisp vertical Time Pace marker (T3 Code signature pattern).
export function PaceBar({
  window: w, now, mode, size = 'md', accent = 'default',
}: {
  window: QuotaWindow;
  now: number;
  mode: QuotaDisplayMode;
  size?: 'sm' | 'md' | 'lg';
  accent?: 'default' | 'claude' | 'codex' | 'agy';
}) {
  const m = windowMetrics(w, now);
  const fillPct = mode === 'remaining' ? m.leftPercent : m.usedPercent;
  const markerPct = mode === 'remaining' ? m.idealLeftPct : m.timeElapsedPct;
  const fillTone = m.tone === 'full' ? 'full' : m.tone === 'warn' ? 'warn' : accent;
  return (
    <div
      className={`pace-bar pace-bar-${size} tone-${fillTone}`}
      role="progressbar"
      aria-valuenow={Math.round(fillPct)}
      aria-valuemin={0}
      aria-valuemax={100}
      title={
        markerPct !== null
          ? `白线为时间基准线（窗口已走 ${Math.round(m.timeElapsedPct ?? 0)}%）`
          : undefined
      }
    >
      <div className="pace-bar-fill" style={{ width: `${Math.min(100, Math.max(0, fillPct))}%` }} />
      {markerPct !== null && markerPct > 1 && markerPct < 99 && (
        <span className="pace-bar-marker" style={{ left: `${markerPct}%` }} aria-hidden="true" />
      )}
    </div>
  );
}

// 20-cell discrete LED progress bar with a thin time-pace rail underneath (for Inspector Overview cards).
export function SegmentedBar({
  window: w, now, mode, variant = 'green',
}: {
  window: QuotaWindow;
  now: number;
  mode: QuotaDisplayMode;
  variant?: 'green' | 'neutral';
}) {
  const m = windowMetrics(w, now);
  const fillPct = mode === 'remaining' ? m.leftPercent : m.usedPercent;
  const markerPct = mode === 'remaining' ? m.idealLeftPct : m.timeElapsedPct;
  const filledCells = Math.round((fillPct / 100) * 20);
  const toneClass = m.tone === 'full' ? 'is-full' : m.tone === 'warn' ? 'is-warn' : variant === 'green' ? 'is-ok' : 'is-neutral';
  return (
    <div className={`seg-led ${toneClass}`}>
      <div className="seg-led-cells" aria-hidden="true">
        {Array.from({ length: 20 }, (_, idx) => (
          <span key={idx} className={`seg-led-cell ${idx < filledCells ? 'on' : ''}`} />
        ))}
      </div>
      {markerPct !== null && (
        <div className="seg-led-rail" title={`时间基准：当前窗口已过 ${Math.round(m.timeElapsedPct ?? 0)}%`}>
          <span className="seg-led-tick" style={{ left: `${Math.min(98, Math.max(2, markerPct))}%` }} />
        </div>
      )}
    </div>
  );
}

const agentAccent = (agent: AgentKind): 'claude' | 'codex' | 'agy' | 'default' =>
  agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : agent === 'agy' ? 'agy' : 'default';

// L1 Topbar aggregated quota pill: keeps each agent compact & clickable to open the L2 floating QuotaPopover.
export function TopQuotaBar({
  quota, now, mode, open, onToggle,
}: {
  quota: Partial<Record<AgentKind, QuotaInfo>>;
  now: number;
  mode: QuotaDisplayMode;
  open: boolean;
  onToggle(): void;
}) {
  const items = QUOTA_AGENTS
    .map((a) => {
      const q = quota[a];
      const all = liveWindows(q, now);
      const prim = primaryWindows(all);
      return q && prim.length ? { agent: a, quota: q, all, prim } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  if (!items.length) return null;

  return (
    <div className={`quota-dock ${open ? 'open' : ''}`} data-testid="quota-dock">
      {items.map(({ agent, quota: q, all, prim }) => {
        const extraCount = all.length - prim.length;
        return (
          <button
            type="button"
            key={agent}
            className={`quota quota-trigger ${open ? 'on' : ''}`}
            data-testid="quota"
            data-agent={agent}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={quotaTitle(agent, q, all, now, mode)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggle}
          >
            <AgentIcon agent={agent} />
            {prim.map((w) => {
              const pctVal = displayPercent(w, mode);
              const ringPct = mode === 'remaining' ? 100 - w.usedPercent : w.usedPercent;
              return (
                <span
                  key={w.label}
                  className={`quota-win ${w.usedPercent >= QUOTA_WARN ? 'warn' : ''} ${w.usedPercent >= 100 ? 'full' : ''}`}
                  data-testid="quota-window"
                  data-label={w.label}
                >
                  <RingGauge percent={ringPct} tone={quotaTone(w.usedPercent)} size={13} />
                  {w.label} {pctVal}%
                </span>
              );
            })}
            {extraCount > 0 && <span className="quota-more-badge" title={`另有 ${extraCount} 个共享/次级配额窗口`}>+{extraCount}</span>}
          </button>
        );
      })}
    </div>
  );
}

// L2 Floating multi-provider quota popover (anchored below topbar, never touches terminal height).
export function QuotaPopover({
  quota, agents, cliTools, currentAgent, now, mode, refreshing, onModeChange, onRefresh, onSwitchAgent, onOpenStats, onClose,
}: {
  quota: Partial<Record<AgentKind, QuotaInfo>>;
  agents: AgentKind[];
  cliTools?: CliToolInfo[];
  currentAgent?: AgentKind;
  now: number;
  mode: QuotaDisplayMode;
  refreshing: boolean;
  onModeChange(mode: QuotaDisplayMode): void;
  onRefresh(): void;
  onSwitchAgent?(target: AgentKind): void;
  onOpenStats(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target.closest('[data-testid="quota"], [data-testid="pane-quota"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const sections = QUOTA_AGENTS
    .map((a) => {
      const q = quota[a];
      const ws = liveWindows(q, now);
      return q && ws.length ? { agent: a, quota: q, windows: ws } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const switchTip = bestSwitchCandidate(quota, agents, currentAgent, now);

  return (
    <div className="quota-popover" ref={ref} data-testid="quota-popover" role="dialog" aria-label="订阅配额详情">
      <div className="qp-head">
        <div className="qp-head-left">
          <svg className="qp-head-ico" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.6-3.4" />
          </svg>
          <span className="qp-title">配额限制</span>
          <span className="qp-sub">{sections.length} 家厂商</span>
        </div>
        <div className="qp-head-right">
          <span className="seg qp-mode-seg" role="radiogroup" aria-label="配额显示口径">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'remaining'}
              className={`ghost seg-btn ${mode === 'remaining' ? 'on' : ''}`}
              data-testid="quota-mode-remaining"
              onClick={() => onModeChange('remaining')}
            >
              剩余
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'used'}
              className={`ghost seg-btn ${mode === 'used' ? 'on' : ''}`}
              data-testid="quota-mode-used"
              onClick={() => onModeChange('used')}
            >
              已用
            </button>
          </span>
          <button
            type="button"
            className={`icon-btn ${refreshing ? 'is-spin' : ''}`}
            data-testid="quota-refresh-btn"
            title="刷新配额与上下文"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.4-3.5M13 3v2.8h-2.8" /></svg>
          </button>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="qp-empty">暂无实时订阅配额记录。启动 Claude Code、Codex 或 Antigravity 会话后会自动上报。</div>
      ) : (
        <div className="qp-body">
          {sections.map(({ agent, quota: q, windows }) => (
            <div key={agent} className="qp-section" data-testid="qp-section" data-agent={agent}>
              <div className="qp-sec-head">
                <AgentIcon agent={agent} />
                <span className="qp-sec-name">{agentLabel(agent, cliTools)}</span>
                <span className="qp-sec-plan">{vendorPlanBadge(agent, q)}</span>
                <span className="qp-sec-age" title={`更新于 ${new Date(q.at).toLocaleTimeString('zh-CN', { hour12: false })}`}>
                  {fmtRelativeAge(q.at, now)}
                </span>
              </div>
              <div className="qp-rows">
                {windows.map((w, idx) => {
                  const m = windowMetrics(w, now);
                  const val = displayPercent(w, mode);
                  return (
                    <div
                      key={`${w.pool ?? 'p'}-${w.label}-${idx}`}
                      className={`qp-row ${w.primary === false ? 'is-secondary' : ''}`}
                      data-testid="qp-window-row"
                      data-pool={w.pool ?? 'primary'}
                      data-label={w.label}
                    >
                      <span className="qp-row-label" title={shortWindowTitle(w)}>{shortWindowTitle(w)}</span>
                      <span className={`qp-row-pct tone-${m.tone}`}>
                        <strong>{val}%</strong>
                        <span className="qp-row-unit">{mode === 'remaining' ? '剩' : '用'}</span>
                      </span>
                      <PaceBar window={w} now={now} mode={mode} size="sm" accent={agentAccent(agent)} />
                      <PaceGlyph pace={m.pace} delta={m.paceDelta} />
                      <span className="qp-row-reset" title={m.unstarted ? '未使用，首次调用后开始计时' : `${m.resetClock} 重置`}>{m.resetRelative}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {switchTip && onSwitchAgent && (
        <div className="qp-switch-hint" data-testid="qp-switch-hint">
          <span>
            当前 {agentLabel(currentAgent!, cliTools)} 额度偏紧，<strong>{agentLabel(switchTip.agent, cliTools)}</strong> 仍有 {switchTip.minLeftPercent}% 剩余
          </span>
          <button
            type="button"
            className="primary qp-switch-btn"
            onClick={() => {
              onClose();
              onSwitchAgent(switchTip.agent);
            }}
          >
            换到 {agentLabel(switchTip.agent, cliTools)}
          </button>
        </div>
      )}

      <div className="qp-foot">
        <span className="qp-foot-note">白线为当前时间进度基准</span>
        <button
          type="button"
          className="link qp-foot-link"
          data-testid="qp-open-stats"
          onClick={() => {
            onClose();
            onOpenStats();
          }}
        >
          打开完整用量与配额 →
        </button>
      </div>
    </div>
  );
}

// L3 Full multi-provider subscription quota card grid inside StatsView (T3 Code screenshots 3 & 4 style).
export function QuotaDashboard({
  quota, agents, cliTools, now, mode, providerFilter, compact = false, onModeChange, onRefresh, refreshing = false,
}: {
  quota: Partial<Record<AgentKind, QuotaInfo>>;
  agents: AgentKind[];
  cliTools?: CliToolInfo[];
  now: number;
  mode: QuotaDisplayMode;
  providerFilter: string; // 'all' | AgentKind
  compact?: boolean;
  onModeChange(mode: QuotaDisplayMode): void;
  onRefresh(): void;
  refreshing?: boolean;
}) {
  const listedAgents = QUOTA_AGENTS.filter((a) => {
    if (providerFilter !== 'all' && a !== providerFilter) return false;
    const hasData = liveWindows(quota[a], now).length > 0;
    if (a === 'fake') return hasData;
    return hasData || (!compact && agents.includes(a));
  });

  const activeCount = listedAgents.filter((a) => liveWindows(quota[a], now).length > 0).length;

  if (compact && activeCount === 0) return null;

  return (
    <section className="quota-dash" data-testid="quota-dashboard">
      <div className="qd-head">
        <div className="qd-head-title">
          <span className="card-title">订阅配额</span>
          <span className="qd-head-sub">白线标示时间基准：进度条在白线右侧代表富余，左侧代表消耗偏快</span>
        </div>
        <div className="qd-head-ctrl">
          <span className="seg" role="radiogroup" aria-label="配额口径">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'remaining'}
              className={`ghost seg-btn ${mode === 'remaining' ? 'on' : ''}`}
              onClick={() => onModeChange('remaining')}
            >
              按剩余 %
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'used'}
              className={`ghost seg-btn ${mode === 'used' ? 'on' : ''}`}
              onClick={() => onModeChange('used')}
            >
              按已用 %
            </button>
          </span>
          <button type="button" className="ghost qd-refresh" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? '刷新中…' : '刷新配额'}
          </button>
        </div>
      </div>

      {listedAgents.length === 0 ? (
        <div className="card qd-empty">
          当前还没有实时订阅配额数据。启动 Claude Code、Codex 或 Antigravity 会话后会自动上报。
        </div>
      ) : (
        <div className="qd-providers">
          {listedAgents.map((agent) => {
            const q = quota[agent];
            const ws = liveWindows(q, now);
            return (
              <div key={agent} className="qd-provider" data-testid="qd-provider" data-agent={agent}>
                <div className="qd-provider-head">
                  <AgentIcon agent={agent} />
                  <span className="qd-provider-name">{agentLabel(agent, cliTools)}</span>
                  <span className="qd-provider-plan">{vendorPlanBadge(agent, q)}</span>
                  {q && <span className="qd-provider-age">更新于 {fmtRelativeAge(q.at, now)}</span>}
                </div>
                {ws.length === 0 ? (
                  <div className="qd-card qd-card-empty">
                    尚未收到实时配额上报（使用 API Key 模式或本机尚未运行该 CLI 会话时无订阅窗口）。
                  </div>
                ) : (
                  <div className="qd-grid">
                    {ws.map((w, idx) => {
                      const m = windowMetrics(w, now);
                      const val = displayPercent(w, mode);
                      const deltaText = m.paceDelta === null
                        ? null
                        : m.paceDelta >= 1
                          ? `+${Math.round(m.paceDelta)}% 富余`
                          : m.paceDelta <= -1
                            ? `${Math.round(m.paceDelta)}% 偏快`
                            : '与时间同步';
                      return (
                        <div
                          key={`${w.pool ?? 'p'}-${w.label}-${idx}`}
                          className={`qd-card ${w.primary === false ? 'is-secondary' : ''} tone-${m.tone}`}
                          data-testid="qd-card"
                          data-pool={w.pool ?? 'primary'}
                          data-label={w.label}
                        >
                          <div className="qd-card-top">
                            <span className="qd-card-title">{shortWindowTitle(w)}</span>
                            <PaceGlyph pace={m.pace} delta={m.paceDelta} />
                          </div>
                          <div className="qd-card-metric">
                            <strong className={`qd-card-num tone-${m.tone}`}>{val}%</strong>
                            <span className="qd-card-unit">{mode === 'remaining' ? '剩余' : '已用'}</span>
                            {deltaText && (
                              <span className={`qd-card-delta pace-${m.pace}`}>{deltaText}</span>
                            )}
                          </div>
                          <PaceBar window={w} now={now} mode={mode} size="lg" accent={agentAccent(agent)} />
                          <div className="qd-card-foot">
                            <span className="qd-card-account">
                              <span className="qd-slot-badge">1</span>
                              {w.poolLabel ?? agentLabel(agent, cliTools)} {val}%
                            </span>
                            <span className="qd-card-reset" title={m.unstarted ? '未使用，首次调用后开始计时' : `将于 ${m.resetClock} 重置`}>
                              {m.unstarted ? '未使用 · 首次调用后开始计时' : `↻ ${m.resetRelative} · ${m.resetClock}`}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Compact context occupancy bar shown in Pane Header (clickable -> opens Inspector Overview tab).
export function ContextMiniBar({
  context, onClick,
}: {
  context: SessionContext;
  onClick?(): void;
}) {
  const total = Math.max(1, context.contextWindowSize);
  const cachedPct = Math.min(100, (context.cachedTokens / total) * 100);
  const uncachedPct = Math.min(100 - cachedPct, (context.uncachedTokens / total) * 100);
  const usedPct = Math.min(100, Math.round(context.usedPercent));
  const warn = usedPct >= 75;
  const tip = [
    `当前上下文：已用 ${usedPct}%（${fmtTokens(context.usedTokens)} / ${fmtTokens(context.contextWindowSize)}）`,
    `已缓存 ${fmtTokens(context.cachedTokens)} · 未缓存 ${fmtTokens(context.uncachedTokens)}`,
    context.cacheHitRate !== null ? `本轮提示词缓存命中率：${fmtPct(context.cacheHitRate)}` : '',
    '点击打开右侧会话概览面板',
  ].filter(Boolean).join('\n');

  return (
    <button
      type="button"
      className={`ctx-mini ${warn ? 'is-warn' : ''}`}
      data-testid="pane-context"
      title={tip}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="ctx-mini-track" aria-hidden="true">
        <span className="ctx-seg-cached" style={{ width: `${cachedPct}%` }} />
        <span className="ctx-seg-uncached" style={{ width: `${uncachedPct}%` }} />
      </span>
      <span className="ctx-mini-nums">
        {fmtTokens(context.usedTokens)}/{fmtTokens(context.contextWindowSize)}
      </span>
      <span className="ctx-mini-pct">{usedPct}%</span>
    </button>
  );
}

// Full Context Window Breakdown Card inside Inspector Overview tab (T3 Code right-rail highlight).
export function ContextCard({
  context, metrics, canCompact, onCompact,
}: {
  context?: SessionContext;
  metrics?: TaskMetrics;
  canCompact: boolean;
  onCompact?(): void;
}) {
  const total = context ? Math.max(1, context.contextWindowSize) : 0;
  const cachedPct = context ? (context.cachedTokens / total) * 100 : 0;
  const uncachedPct = context ? (context.uncachedTokens / total) * 100 : 0;
  const remTokens = context ? Math.max(0, context.contextWindowSize - context.usedTokens) : 0;
  const remPct = context ? Math.max(0, 100 - context.usedPercent) : 100;
  const avgCache = metrics ? hitRate(metrics) : null;

  return (
    <div className="insp-card ctx-card" data-testid="insp-context-card">
      <div className="insp-card-head">
        <span className="insp-card-title">上下文</span>
        {context?.model && <span className="insp-card-badge" title={context.model}>{context.model}</span>}
      </div>
      {!context ? (
        <div className="insp-card-empty">
          本会话尚未采集到上下文窗口数据（完成一轮对话后自动显示）。
        </div>
      ) : (
        <>
          <div className="ctx-headline">
            <strong>已用 {Math.round(context.usedPercent)}%</strong>
            <span className="ctx-headline-cap">
              {fmtTokens(context.usedTokens)} / {fmtTokens(context.contextWindowSize)}
            </span>
          </div>
          <div className="ctx-bar" aria-hidden="true">
            <span className="ctx-seg-cached" style={{ width: `${Math.min(100, cachedPct)}%` }} />
            <span className="ctx-seg-uncached" style={{ width: `${Math.min(100 - Math.min(100, cachedPct), uncachedPct)}%` }} />
          </div>
          <div className="ctx-breakdown">
            <div className="ctx-row">
              <span className="ctx-dot is-cached" />
              <span className="ctx-row-name">已缓存上下文</span>
              <span className="ctx-row-val">{fmtTokens(context.cachedTokens)}</span>
              <span className="ctx-row-pct">{cachedPct < 1 && cachedPct > 0 ? `${cachedPct.toFixed(1)}%` : `${Math.round(cachedPct)}%`}</span>
            </div>
            <div className="ctx-row">
              <span className="ctx-dot is-uncached" />
              <span className="ctx-row-name">未缓存上下文</span>
              <span className="ctx-row-val">{fmtTokens(context.uncachedTokens)}</span>
              <span className="ctx-row-pct">{uncachedPct < 1 && uncachedPct > 0 ? `${uncachedPct.toFixed(1)}%` : `${Math.round(uncachedPct)}%`}</span>
            </div>
            <div className="ctx-row is-dim">
              <span className="ctx-dot is-rem" />
              <span className="ctx-row-name">剩余空间</span>
              <span className="ctx-row-val">{fmtTokens(remTokens)}</span>
              <span className="ctx-row-pct">{Math.round(remPct)}%</span>
            </div>
          </div>
          <div className="ctx-cache-row">
            <span>提示词缓存</span>
            <span className="ctx-cache-vals">
              {context.cacheHitRate !== null && <strong className="is-cached-num">{fmtPct(context.cacheHitRate)}</strong>}
              {avgCache !== null && <span className="muted">· 平均 {fmtPct(avgCache)}</span>}
            </span>
          </div>
        </>
      )}
      <div className="ctx-foot">
        <span className="ctx-foot-meta">
          {metrics
            ? `${metrics.requests} 次请求${metrics.tps !== null ? ` · ${metrics.tps >= 100 ? Math.round(metrics.tps) : metrics.tps.toFixed(1)} tok/s` : ''}`
            : context?.turns ? `${context.turns} 轮对话` : '暂无请求统计'}
        </span>
        {canCompact && onCompact && (
          <button
            type="button"
            className="ghost ctx-compact-btn"
            data-testid="insp-compact-btn"
            title="向当前活跃终端发送 /compact 指令压缩长上下文"
            onClick={onCompact}
          >
            压缩
          </button>
        )}
      </div>
    </div>
  );
}

// Right-hand Inspector "概览" tab: Workspace quick actions + Context Card + 20-cell Segmented Quota Cards.
export function InspectorOverview({
  project, git, dirtyCount, task, session, context, metrics, allQuota, agents, cliTools, now, mode, refreshing,
  onOpenChanges, onOpenExternal, onReveal, onCompact, onRefreshQuota, onSwitchAgent, onOpenStats,
}: {
  project: Project;
  git: GitInfo | null;
  dirtyCount: number;
  task?: Task;
  session?: SessionInfo;
  context?: SessionContext;
  metrics?: TaskMetrics;
  allQuota: Partial<Record<AgentKind, QuotaInfo>>;
  agents: AgentKind[];
  cliTools?: CliToolInfo[];
  now: number;
  mode: QuotaDisplayMode;
  refreshing: boolean;
  onOpenChanges(): void;
  onOpenExternal(): void;
  onReveal(): void;
  onCompact?(): void;
  onRefreshQuota(): void;
  onSwitchAgent?(): void;
  onOpenStats(): void;
}) {
  const activeAgent = task?.agent ?? session?.agent;
  const activeQuota = activeAgent ? allQuota[activeAgent] : undefined;
  const activeWindows = liveWindows(activeQuota, now);
  const primActive = primaryWindows(activeWindows);
  const secActive = secondaryWindows(activeWindows);

  const otherAgents = QUOTA_AGENTS.filter(a => a !== activeAgent && liveWindows(allQuota[a], now).length > 0);
  const canCompact = !!session && session.status !== 'exited' && (activeAgent === 'claude' || activeAgent === 'agy' || activeAgent === 'codex');

  return (
    <div className="insp-overview" data-testid="insp-overview">
      {/* Workspace & Git quick actions */}
      <div className="insp-card insp-quick-card">
        <div className="insp-quick-actions">
          <button type="button" className="insp-action-row" onClick={onOpenExternal}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg>
            <span>在外部编辑器打开</span>
          </button>
          <button type="button" className="insp-action-row" onClick={onReveal}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></svg>
            <span>打开项目目录</span>
          </button>
        </div>
        {git && (
          <div className="insp-git-summary">
            <div className="insp-git-row">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 3.5" /></svg>
              <span className="insp-git-branch" data-private="">{git.branch}</span>
            </div>
            <button type="button" className="insp-git-changes-btn" onClick={onOpenChanges}>
              <span>未提交变更</span>
              <span className={`insp-git-dirty ${dirtyCount > 0 ? 'has-dirty' : ''}`}>
                {dirtyCount > 0 ? `${dirtyCount} 个文件` : '工作区干净'}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Context Window Card */}
      <ContextCard context={context} metrics={metrics} canCompact={canCompact} onCompact={onCompact} />

      {/* Active Provider Quota Card (20-cell segmented bars like T3 Code right rail) */}
      <div className="insp-card insp-quota-card" data-testid="insp-quota-card">
        <div className="insp-card-head">
          {activeAgent && <AgentIcon agent={activeAgent} />}
          <span className="insp-card-title">
            {activeAgent ? agentLabel(activeAgent, cliTools) : '订阅配额'}
          </span>
          {activeAgent && <span className="insp-card-plan">{vendorPlanBadge(activeAgent, activeQuota)}</span>}
          <button
            type="button"
            className={`icon-btn insp-quota-refresh ${refreshing ? 'is-spin' : ''}`}
            title="刷新配额"
            disabled={refreshing}
            onClick={onRefreshQuota}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.4-3.5M13 3v2.8h-2.8" /></svg>
          </button>
        </div>

        {primActive.length === 0 ? (
          <div className="insp-card-empty">
            {activeAgent
              ? `尚未采集到 ${agentLabel(activeAgent, cliTools)} 的实时配额窗口。`
              : '选中一个任务后显示当前厂商实时配额。'}
          </div>
        ) : (
          <div className="insp-led-stack">
            {primActive.map((w, idx) => {
              const m = windowMetrics(w, now);
              const val = displayPercent(w, mode);
              return (
                <div key={`${w.pool ?? 'p'}-${w.label}-${idx}`} className="insp-led-box">
                  <div className="insp-led-top">
                    <span className="insp-led-label">
                      <RingGauge percent={mode === 'remaining' ? 100 - w.usedPercent : w.usedPercent} tone={m.tone} size={13} />
                      {shortWindowTitle(w)}
                    </span>
                    <strong className={`insp-led-pct tone-${m.tone}`}>{val}%</strong>
                  </div>
                  <SegmentedBar window={w} now={now} mode={mode} variant={idx === 0 ? 'green' : 'neutral'} />
                  <div className="insp-led-foot">
                    <span>{m.resetRelative}</span>
                    <span className="muted">{m.resetClock}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {secActive.length > 0 && (
          <div className="insp-other-pools">
            <div className="insp-sub-title">其他模型配额池</div>
            {secActive.map((w, idx) => {
              const val = displayPercent(w, mode);
              return (
                <div key={`${w.pool ?? 's'}-${w.label}-${idx}`} className="insp-mini-pool-row">
                  <span className="insp-mini-pool-name" title={shortWindowTitle(w)}>{shortWindowTitle(w)}</span>
                  <PaceBar window={w} now={now} mode={mode} size="sm" accent={agentAccent(activeAgent ?? '')} />
                  <span className="insp-mini-pool-pct">{val}%</span>
                </div>
              );
            })}
          </div>
        )}

        {otherAgents.length > 0 && (
          <div className="insp-other-pools">
            <div className="insp-sub-head">
              <span className="insp-sub-title">其他厂商可用额度</span>
              {task && onSwitchAgent && agents.length > 1 && (
                <button type="button" className="link insp-sub-link" onClick={onSwitchAgent}>换 agent</button>
              )}
            </div>
            {otherAgents.map((a) => {
              const w = primaryWindows(liveWindows(allQuota[a], now))[0];
              if (!w) return null;
              const val = displayPercent(w, mode);
              return (
                <div key={a} className="insp-mini-pool-row">
                  <span className="insp-mini-pool-agent">
                    <AgentIcon agent={a} />
                    <span>{agentLabel(a, cliTools)} · {w.label}</span>
                  </span>
                  <PaceBar window={w} now={now} mode={mode} size="sm" accent={agentAccent(a)} />
                  <span className="insp-mini-pool-pct">{val}%</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="insp-quota-foot">
          <button type="button" className="link" onClick={onOpenStats}>查看全部用量与配额 →</button>
        </div>
      </div>

      <div className="insp-overview-meta" data-private="" title={project.path}>
        {project.path}
      </div>
    </div>
  );
}
