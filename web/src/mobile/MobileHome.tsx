import { useMemo, useState } from 'react';
import type { MobileRouteVia, Snapshot } from '../../../shared/protocol.ts';
import { agentLabel } from '../../../shared/protocol.ts';
import { AgentIcon } from '../agentIcons.tsx';
import { liveWindows, QUOTA_AGENTS, QUOTA_WARN, quotaTitle } from '../quota.ts';
import { needsList, reviewList, sortProjectTasks, STATUS_LABEL, waitText } from '../util.ts';
import { setPrivacy, usePrivacy } from '../privacy.ts';
import { ConfirmSheet } from './ConfirmSheet.tsx';
import { ConnBar } from './ConnBar.tsx';
import { useBackLayer } from './useBackLayer.ts';

const VIA_NAME: Record<MobileRouteVia, string> = {
  lan: '同 Wi-Fi',
  tunnel: 'Cloudflare',
  local: '本机',
};

// 「需要你」「待验收」与桌面同源（util.ts 的 needsList / reviewList）；其余是手机端额外提醒（额度、上次中断）。
function needLabel(need: boolean, review: boolean, blocked?: string, hasLimit?: boolean, interrupted?: boolean): string | null {
  if (need) {
    if (blocked === 'permission') return '待终端授权';
    if (blocked === 'startup') return '待确认启动';
    if (hasLimit) return '额度已用完';
    return '需要你';
  }
  if (review) return '待验收';
  if (hasLimit) return '额度已用完';
  if (interrupted) return '上次中断';
  return null;
}

export function MobileHome({
  state,
  via,
  rttMs,
  wsConnected,
  lastSyncAt,
  now,
  onSelectTask,
  onOpenNewTask,
  onLogout,
}: {
  state: Snapshot;
  via: MobileRouteVia;
  rttMs: number | null;
  wsConnected: boolean;
  lastSyncAt: number | null;
  now: number;
  onSelectTask(taskId: string): void;
  onOpenNewTask(): void;
  onLogout(): Promise<void>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const menuLayer = useBackLayer(menuOpen, () => setMenuOpen(false));
  const privacy = usePrivacy();

  const sessionsById = useMemo(() => new Map(state.sessions.map((s) => [s.id, s])), [state.sessions]);
  const projectsById = useMemo(() => new Map(state.projects.map((p) => [p.id, p])), [state.projects]);

  const needIds = useMemo(() => needsList(state), [state]);
  const reviewIds = useMemo(() => reviewList(state), [state]);
  const attention = useMemo(() => {
    const needRank = new Map(needIds.map((id, i) => [id, i]));
    const reviewRank = new Map(reviewIds.map((id, i) => [id, i]));
    const items = state.tasks
      .filter((t) => t.phase !== 'archived')
      .map((t) => {
        const s = t.sessionId ? sessionsById.get(t.sessionId) : undefined;
        const nr = s ? needRank.get(s.id) : undefined;
        const rr = s ? reviewRank.get(s.id) : undefined;
        const need = needLabel(nr !== undefined, rr !== undefined, s?.blocked, Boolean(s?.limit), Boolean(s?.interrupted));
        if (!need) return null;
        // 置顶顺序同桌面：先需要你（终端按键优先），再待验收，各自按等待时间从久到近。
        const prio = nr !== undefined ? (s?.blocked ? 0 : 1) : rr !== undefined ? 2 : 3;
        const rank = nr ?? rr ?? 0;
        const since = s?.statusSince ?? t.phaseSince;
        return { task: t, session: s, need, prio, rank, waitMs: Math.max(0, now - since) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    items.sort((a, b) => a.prio - b.prio || a.rank - b.rank || b.waitMs - a.waitMs);
    return items;
  }, [state.tasks, sessionsById, needIds, reviewIds, now]);

  const quotaChips = useMemo(() => {
    return QUOTA_AGENTS.flatMap((agent) => {
      const q = state.quota[agent];
      const wins = liveWindows(q, now);
      if (!q || wins.length === 0) return [];
      const peak = Math.max(...wins.map((w) => w.usedPercent));
      return [{ agent, q, wins, peak }];
    });
  }, [state.quota, now]);

  const archivedTasks = useMemo(() => state.tasks.filter((t) => t.phase === 'archived'), [state.tasks]);

  const connLabel = wsConnected
    ? `${VIA_NAME[via] ?? via}${rttMs !== null ? ` · ${rttMs}ms` : ''}`
    : '重连中…';

  return (
    <div className="mob-root" data-testid="mobile-home">
      <header className="mob-header">
        <div className="mob-title-wrap">
          <span className="mob-title">Shoal</span>
          <span className="mob-sub" data-testid="mobile-home-sub">
            {needIds.length > 0 || reviewIds.length > 0
              ? [needIds.length > 0 && `${needIds.length} 需要你`, reviewIds.length > 0 && `${reviewIds.length} 待验收`].filter(Boolean).join(' · ')
              : `${state.projects.length} 个项目 · ${state.tasks.filter((t) => t.phase !== 'archived').length} 个进行中`}
          </span>
        </div>
        <span className={`mob-pill ${wsConnected ? 'is-online' : 'is-warn'}`} data-testid="mobile-conn-pill">
          <span className="dot" />
          {connLabel}
        </span>
        <button type="button" className="mob-btn compact primary" data-testid="mobile-new-task-btn" onClick={onOpenNewTask}>
          + 新建
        </button>
        <button type="button" className="mob-btn compact ghost" data-testid="mobile-home-more-btn" onClick={() => setMenuOpen(true)} aria-label="更多">
          ⋯
        </button>
      </header>
      <ConnBar wsConnected={wsConnected} lastSyncAt={lastSyncAt} />

      <div className="mob-scroll">
        {quotaChips.length > 0 && (
          <div className="mob-quota-row">
            {quotaChips.map(({ agent, q, wins, peak }) => (
              <div
                key={agent}
                className={`mob-quota-chip ${peak >= QUOTA_WARN ? 'is-warn' : ''}`}
                title={quotaTitle(agent, q, wins, now)}
              >
                <AgentIcon agent={agent} className="agent-icon" />
                <span>{agentLabel(agent, state.cliTools)}</span>
                <strong>{Math.round(peak)}%</strong>
              </div>
            ))}
          </div>
        )}

        <section>
          <div className="mob-section-title">
            <span data-testid="mobile-attention-title">需要你 {needIds.length} · 待验收 {reviewIds.length}</span>
          </div>
          <div className="mob-card-list" data-testid="mobile-attention-list" style={{ marginTop: '0.375rem' }}>
            {attention.length === 0 ? (
              <div className="mob-sub" style={{ padding: '0.375rem 0.125rem' }}>暂时没有需要你介入的任务</div>
            ) : (
              attention.map(({ task, session, need, waitMs }) => {
                const proj = projectsById.get(task.projectId);
                const act = session ? state.activity?.[session.id] : undefined;
                return (
                  <button
                    key={task.id}
                    type="button"
                    className="mob-task-card is-attention"
                    data-testid={`mobile-attention-task-${task.id}`}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <div className="mob-task-top">
                      <span className="mob-swatch" style={{ background: task.color }} />
                      <AgentIcon agent={session?.agent ?? task.agent} className="agent-icon" />
                      <span className="mob-task-name" data-private="">{task.title}</span>
                      <span className="mob-pill is-warn">{need}</span>
                    </div>
                    {(act?.summary || task.lastPrompt) && (
                      <div className="mob-task-summary" data-private="">{act?.summary ?? task.lastPrompt}</div>
                    )}
                    <div className="mob-task-meta">
                      <span data-private="">{proj?.name ?? '未知项目'}</span>
                      <span>·</span>
                      <span>{waitText(waitMs)}</span>
                      {session?.blocked && <span>· 需终端按键确认</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {state.projects.length === 0 ? (
          <div className="mob-sub" style={{ whiteSpace: 'normal', padding: '0.5rem 0' }}>
            暂无项目，请先在电脑桌面工作台添加本地代码目录。
          </div>
        ) : (
          state.projects.map((proj) => {
            const git = state.git[proj.id];
            const activeTasks = sortProjectTasks(
              state.tasks.filter((t) => t.projectId === proj.id && t.phase !== 'archived'),
              sessionsById,
            );
            return (
              <section key={proj.id}>
                <div className="mob-section-title">
                  <span data-private="">{proj.name}</span>
                  <span data-private="">
                    {git ? `${git.branch}${git.dirty > 0 ? ` · ${git.dirty} 改动` : ''}` : '非 Git 目录'}
                  </span>
                </div>
                <div className="mob-card-list" style={{ marginTop: '0.375rem' }}>
                  {activeTasks.length === 0 ? (
                    <div className="mob-sub" style={{ padding: '0.25rem 0.125rem' }}>暂无活跃任务</div>
                  ) : (
                    activeTasks.map((task) => {
                      const session = task.sessionId ? sessionsById.get(task.sessionId) : undefined;
                      const act = session ? state.activity?.[session.id] : undefined;
                      const stLabel = session ? STATUS_LABEL[session.status] : '未启动';
                      return (
                        <button
                          key={task.id}
                          type="button"
                          className="mob-task-card"
                          data-testid={`mobile-task-card-${task.id}`}
                          onClick={() => onSelectTask(task.id)}
                        >
                          <div className="mob-task-top">
                            <span className="mob-swatch" style={{ background: task.color }} />
                            <AgentIcon agent={session?.agent ?? task.agent} className="agent-icon" />
                            <span className="mob-task-name" data-private="">{task.title}</span>
                            <span className="mob-pill">
                              {task.phase === 'approved' ? '已通过' : task.phase === 'review' ? '待验收' : stLabel}
                            </span>
                          </div>
                          {(act?.summary || task.lastPrompt) && (
                            <div className="mob-task-summary" data-private="">{act?.summary ?? task.lastPrompt}</div>
                          )}
                          {session?.queued ? (
                            <div className="mob-task-meta">
                              <span>队列中 {session.queued} 条</span>
                            </div>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })
        )}

        {archivedTasks.length > 0 && (
          <section>
            <button
              type="button"
              className="mob-btn compact ghost"
              style={{ paddingLeft: 0 }}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? '收起已归档任务' : `查看已归档任务（${archivedTasks.length}）`}
            </button>
            {showArchived && (
              <div className="mob-card-list" style={{ marginTop: '0.375rem' }}>
                {archivedTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className="mob-task-card"
                    data-testid={`mobile-task-card-${task.id}`}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <div className="mob-task-top">
                      <span className="mob-swatch" style={{ background: task.color }} />
                      <AgentIcon agent={task.agent} className="agent-icon" />
                      <span className="mob-task-name" data-private="">{task.title}</span>
                      <span className="mob-pill">已归档</span>
                    </div>
                    <div className="mob-task-meta">
                      <span data-private="">{projectsById.get(task.projectId)?.name ?? ''}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {menuOpen && (
        <div className="mob-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && menuLayer.close()}>
          <div className="mob-sheet" data-testid="mobile-home-more-sheet">
            <h3>设置</h3>
            <button
              type="button"
              className={`mob-btn ${privacy ? 'primary' : ''}`}
              data-testid="mobile-privacy-toggle"
              aria-pressed={privacy}
              onClick={() => setPrivacy(!privacy)}
            >
              {privacy ? '隐私模式：开（项目名、标题和对话已模糊）' : '隐私模式：关'}
            </button>
            {logoutError && <div className="form-error" data-testid="mobile-logout-error">{logoutError}</div>}
            <button type="button" className="mob-btn danger" data-testid="mobile-logout-btn" onClick={() => setConfirmLogout(true)}>
              退出并解除本机配对
            </button>
            <button type="button" className="mob-btn ghost" onClick={menuLayer.close}>取消</button>
          </div>
        </div>
      )}

      {confirmLogout && (
        <ConfirmSheet
          title="解除本机配对？"
          message="解除后这台手机需要在电脑桌面端重新扫码配对，才能继续遥控。"
          confirmLabel="退出并解除配对"
          danger
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => {
            setConfirmLogout(false);
            setLogoutError('');
            onLogout().catch((e: Error) => setLogoutError(`退出失败：${e.message}。仍保持已配对状态。`));
          }}
        />
      )}
    </div>
  );
}
