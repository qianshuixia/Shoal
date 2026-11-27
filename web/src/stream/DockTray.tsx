import { useEffect, useMemo, useRef, useState } from 'react';
import type { DelegationState, StreamTodoItem } from '../../../shared/protocol.ts';
import { DELEGATION_LABEL, DELEGATION_MODE_LABEL, delegationDisplayTitle } from '../../../shared/protocol.ts';
import { AgentIcon } from '../agentIcons.tsx';
import type { DelegateView } from '../DelegationHud.tsx';
import { fmtClock } from '../util.ts';
import { fileBase, fmtCompactSec } from './format.ts';
import type { MergedSubagent } from './subagents.ts';
import { useTick } from './useTick.ts';

type DockTrayTab = 'todo' | 'subagent';
type TrayChoice = DockTrayTab | 'closed' | null;

const TRAY_KEY_PREFIX = 'shoal.stream.tray.';
const STALE_MS = 90_000;

const DELEGATION_SORT_RANK: Record<DelegationState, number> = {
  needs_you: 0,
  failed: 1,
  review: 2,
  working: 3,
  rework: 3,
  accepted: 4,
  canceled: 4,
};

function loadTrayChoice(sessionId: string | null): TrayChoice {
  if (!sessionId) return null;
  try {
    const v = sessionStorage.getItem(TRAY_KEY_PREFIX + sessionId);
    return v === 'todo' || v === 'subagent' || v === 'closed' ? v : null;
  } catch {
    return null;
  }
}

function saveTrayChoice(sessionId: string | null, choice: TrayChoice): void {
  if (!sessionId) return;
  try {
    if (choice) sessionStorage.setItem(TRAY_KEY_PREFIX + sessionId, choice);
    else sessionStorage.removeItem(TRAY_KEY_PREFIX + sessionId);
  } catch {
    // storage unavailable: component state only
  }
}

// "12s 前有进展", or the gentle stale mark once a running item has been silent for 90s.
function activityNote(lastAt: number | undefined, now: number): { text: string; stale: boolean } | null {
  if (!lastAt || lastAt <= 0) return null;
  const idle = Math.max(0, now - lastAt);
  if (idle > STALE_MS) return { text: '暂无新进展', stale: true };
  if (idle < 5000) return { text: '刚有进展', stale: false };
  return { text: `${fmtCompactSec(idle / 1000)} 前有进展`, stale: false };
}

export function DockTray({
  sessionId,
  todos,
  subagents,
  delegates,
  livePhase,
  hasPrompt,
  privacy,
  focusSubagentTick,
  onOpenDelegate,
  onInspectFile,
}: {
  sessionId: string | null;
  todos: StreamTodoItem[];
  subagents: MergedSubagent[];
  delegates: DelegateView[];
  livePhase?: string;
  hasPrompt: boolean;
  privacy: boolean;
  focusSubagentTick: number;
  onOpenDelegate?(sessionId: string): void;
  onInspectFile?(filePath: string): void;
}) {
  const hasTodos = todos.length > 0;
  const sortedDelegates = useMemo(
    () => [...delegates].sort((a, b) => DELEGATION_SORT_RANK[a.state] - DELEGATION_SORT_RANK[b.state]),
    [delegates],
  );
  const totalSubs = sortedDelegates.length + subagents.length;
  const hasSubs = totalSubs > 0;

  const doneCount = todos.filter((t) => t.status === 'done').length;
  const allTodosDone = hasTodos && todos.every((t) => t.status === 'done' || t.status === 'skipped');
  const activeTodo = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  const todoPct = hasTodos ? Math.round((doneCount / todos.length) * 100) : 0;

  const needsYouCount = sortedDelegates.filter((d) => d.state === 'needs_you').length;
  const reviewCount = sortedDelegates.filter((d) => d.state === 'review').length;
  const failedCount = sortedDelegates.filter((d) => d.state === 'failed').length + subagents.filter((s) => s.status === 'error').length;
  const runningDelegates = sortedDelegates.filter((d) => d.state === 'working' || d.state === 'rework');
  const runningInternals = subagents.filter((s) => s.status === 'running');
  const runningCount = runningDelegates.length + runningInternals.length;
  const needsAttention = needsYouCount > 0 || failedCount > 0 || reviewCount > 0;

  // Per-second clock only while something is actually running; an idle tray owns no timer.
  const now = useTick(runningCount > 0);

  const [userChoice, setUserChoiceState] = useState<TrayChoice>(() => loadTrayChoice(sessionId));
  const setUserChoice = (next: TrayChoice | ((cur: TrayChoice) => TrayChoice)) => {
    setUserChoiceState((cur) => {
      const resolved = typeof next === 'function' ? next(cur) : next;
      saveTrayChoice(sessionId, resolved);
      return resolved;
    });
  };
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const lastFocusTickRef = useRef(focusSubagentTick);
  useEffect(() => {
    if (focusSubagentTick !== lastFocusTickRef.current) {
      lastFocusTickRef.current = focusSubagentTick;
      if (hasSubs) setUserChoiceState('subagent');
    }
  }, [focusSubagentTick, hasSubs]);

  if (!hasTodos && !hasSubs) return null;

  let activeTab: DockTrayTab | null = null;
  if (!hasPrompt) {
    if (userChoice === 'closed') {
      activeTab = null;
    } else if (userChoice === 'todo' && hasTodos) {
      activeTab = 'todo';
    } else if (userChoice === 'subagent' && hasSubs) {
      activeTab = 'subagent';
    } else if (hasSubs && (needsAttention || (runningCount > 0 && (livePhase === 'subagent' || !hasTodos || allTodosDone)))) {
      activeTab = 'subagent';
    } else if (hasTodos && !allTodosDone) {
      activeTab = 'todo';
    }
  }

  const toggleTab = (tab: DockTrayTab) => {
    setUserChoice((cur) => {
      const resolved = cur === 'closed' ? null : cur ?? activeTab;
      return resolved === tab ? 'closed' : tab;
    });
  };

  // Compute concise live subagent pill label + elapsed clock.
  const leadRunning = runningInternals[0];
  let subElapsed = leadRunning?.elapsedText ?? '';
  if (!subElapsed && runningCount > 0) {
    const starts: number[] = [];
    for (const s of runningInternals) if (s.startedAt) starts.push(s.startedAt);
    for (const d of runningDelegates) {
      const st = d.activity?.turnStartedAt ?? d.session?.statusSince;
      if (st) starts.push(st);
    }
    if (starts.length > 0) subElapsed = fmtCompactSec((now - Math.min(...starts)) / 1000);
  }

  let subStatusTone = 'is-done';
  let subLabel = `子代理 ${totalSubs} ✓`;
  if (needsYouCount > 0) {
    subStatusTone = 'is-attention';
    subLabel = `委派待你处理 ${needsYouCount}`;
  } else if (failedCount > 0) {
    subStatusTone = 'is-error';
    subLabel = `子代理 ${failedCount} 失败`;
  } else if (runningCount > 0) {
    subStatusTone = 'is-running';
    subLabel = runningCount === 1 && leadRunning && !hasTodos
      ? `子代理 · ${leadRunning.name}`
      : `子代理 ${runningCount} 运行中`;
  } else if (reviewCount > 0) {
    subStatusTone = 'is-attention';
    subLabel = `委派待验收 ${reviewCount}`;
  }

  return (
    <div
      className={`sv-todo-card sv-dock-tray ${activeTab ? 'is-open' : 'is-collapsed'} ${!activeTab && allTodosDone && runningCount === 0 && !needsAttention ? 'is-all-done' : ''}`}
      data-testid={hasTodos ? 'sv-todo-card' : 'sv-subagents-card'}
      data-has-subagents={hasSubs ? 'true' : 'false'}
    >
      <div className="sv-tray-bar">
        {hasTodos && (
          <button
            type="button"
            className={`sv-tray-seg ${activeTab === 'todo' ? 'is-active' : ''}`}
            data-testid="sv-todo-toggle"
            aria-expanded={activeTab === 'todo'}
            onClick={() => toggleTab('todo')}
          >
            <span className="sv-todo-count" data-testid="sv-todo-count">
              任务清单 {doneCount}/{todos.length}
            </span>
            <span className="sv-todo-bar" aria-hidden="true">
              <span className="sv-todo-bar-fill" style={{ width: `${todoPct}%` }} />
            </span>
            {!hasSubs && activeTab !== 'todo' && activeTodo && (
              <span className="sv-todo-current" data-private="">{activeTodo.title}</span>
            )}
            <svg className={`sv-chev ${activeTab === 'todo' ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 6.5l3 3 3-3" />
            </svg>
          </button>
        )}

        {hasTodos && hasSubs && <span className="sv-tray-sep" aria-hidden="true" />}

        {hasSubs && (
          <button
            type="button"
            className={`sv-tray-seg sv-tray-sub ${subStatusTone} ${activeTab === 'subagent' ? 'is-active' : ''}`}
            data-testid="sv-subagents-toggle"
            aria-expanded={activeTab === 'subagent'}
            onClick={() => toggleTab('subagent')}
          >
            <span className={`sv-sub-dot ${subStatusTone}`} aria-hidden="true" />
            <span className="sv-sub-seg-label">{subLabel}</span>
            {subElapsed && runningCount > 0 && <span className="sv-sub-elapsed">{subElapsed}</span>}
            {!hasTodos && activeTab !== 'subagent' && leadRunning?.summary && (
              <span className="sv-todo-current" data-private="">{leadRunning.summary}</span>
            )}
            <svg className={`sv-chev ${activeTab === 'subagent' ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 6.5l3 3 3-3" />
            </svg>
          </button>
        )}
      </div>

      {activeTab === 'todo' && hasTodos && (
        <ul className="sv-todo-list" data-testid="sv-todo-list">
          {todos.map((item, idx) => (
            <li key={`${idx}-${item.title}`} className={`sv-todo-item is-${item.status}`} data-testid="sv-todo-item">
              <span className={`sv-todo-mark is-${item.status}`} aria-hidden="true">
                {item.status === 'done' ? '✓' : item.status === 'failed' ? '!' : item.status === 'skipped' ? '–' : item.status === 'in_progress' ? '' : '○'}
              </span>
              <span className="sv-todo-title" data-private="">{item.title}</span>
            </li>
          ))}
        </ul>
      )}

      {activeTab === 'subagent' && hasSubs && (
        <div className="sv-subagents-list" data-testid="sv-subagents-list">
          {sortedDelegates.map((d) => {
            const key = `deleg:${d.task.id}`;
            const isWorking = d.state === 'working' || d.state === 'rework';
            const isOpen = expandedItemId === key;
            const liveAct = isWorking && d.activity ? d.activity : undefined;
            const steps = liveAct?.recentSteps.slice(-4).reverse() ?? [];
            const modeLabel = d.task.delegation?.mode ? `委派·${DELEGATION_MODE_LABEL[d.task.delegation.mode]}` : '委派';
            const summaryLine = liveAct?.summary || d.task.delegation?.brief || '';
            const elapsed = liveAct ? fmtClock((now - liveAct.turnStartedAt) / 1000) : '';
            const note = liveAct ? activityNote(liveAct.lastProgressAt, now) : null;
            const hasDetail = steps.length > 0 || !!d.task.delegation?.brief;
            return (
              <div
                key={key}
                className={`sv-sub-item is-deleg st-${d.state}`}
                data-testid="sv-subagent-item"
                data-kind="delegation"
                data-status={d.state}
              >
                <div
                  className={`sv-sub-row ${hasDetail ? 'is-clickable' : ''}`}
                  onClick={() => hasDetail && setExpandedItemId((cur) => (cur === key ? null : key))}
                >
                  <span className={`sv-sub-mark st-${d.state}`} aria-hidden="true">
                    {isWorking ? '' : d.state === 'failed' ? '!' : d.state === 'accepted' ? '✓' : '•'}
                  </span>
                  <AgentIcon agent={d.task.agent ?? d.session?.agent ?? 'fake'} />
                  <span className="sv-sub-name" data-private="">{delegationDisplayTitle(d.task.title)}</span>
                  <span className="sv-sub-tag">{modeLabel}</span>
                  <span className={`sv-sub-chip st-${d.state}`}>{DELEGATION_LABEL[d.state]}</span>
                  {elapsed && <span className="sv-sub-time">{elapsed}</span>}
                  {note && <span className={`sv-sub-note ${note.stale ? 'is-stale' : ''}`}>{note.text}</span>}
                  {d.task.sessionId && onOpenDelegate && (
                    <button
                      type="button"
                      className="sv-sub-open-btn"
                      data-testid="sv-subagent-open"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenDelegate(d.task.sessionId!);
                      }}
                    >
                      打开
                    </button>
                  )}
                </div>
                {summaryLine && (
                  <div className="sv-sub-summary" data-private="" title={privacy ? undefined : summaryLine}>
                    {summaryLine}
                  </div>
                )}
                {isOpen && hasDetail && (
                  <div className="sv-sub-detail">
                    {steps.length > 0 ? (
                      <div className="sv-sub-detail-group">
                        <div className="sv-sub-detail-label">最近步骤</div>
                        {steps.map((st, idx) => (
                          <div key={`${st.at}-${idx}`} className={`sv-sub-step is-${st.status ?? 'done'}`}>
                            <span className="sv-sub-step-dot" aria-hidden="true" />
                            <span data-private="">{st.summary}</span>
                          </div>
                        ))}
                      </div>
                    ) : d.task.delegation?.brief ? (
                      <div className="sv-sub-brief" data-private="">{d.task.delegation.brief}</div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {subagents.map((sub) => {
            const key = `int:${sub.id}`;
            const isOpen = expandedItemId === key;
            const steps = sub.recentSteps ? [...sub.recentSteps].reverse() : [];
            const files = sub.files ?? [];
            const hasDetail = steps.length > 0 || files.length > 0;
            const elapsed = sub.status === 'running'
              ? (sub.elapsedText || (sub.startedAt ? fmtCompactSec((now - sub.startedAt) / 1000) : ''))
              : (sub.startedAt && sub.updatedAt && sub.updatedAt > sub.startedAt
                ? fmtCompactSec((sub.updatedAt - sub.startedAt) / 1000)
                : sub.elapsedText ?? '');
            const note = sub.status === 'running' ? activityNote(sub.updatedAt, now) : null;
            return (
              <div
                key={key}
                className={`sv-sub-item is-${sub.status}`}
                data-testid="sv-subagent-item"
                data-kind={sub.kind}
                data-status={sub.status}
              >
                <div
                  className={`sv-sub-row ${hasDetail ? 'is-clickable' : ''}`}
                  onClick={() => hasDetail && setExpandedItemId((cur) => (cur === key ? null : key))}
                >
                  <span className={`sv-sub-mark is-${sub.status}`} aria-hidden="true">
                    {sub.status === 'running' ? '' : sub.status === 'error' ? '!' : '✓'}
                  </span>
                  <span className="sv-sub-name" data-private="">
                    {sub.name}
                    {sub.role ? ` · ${sub.role}` : ''}
                  </span>
                  {sub.kind === 'swarm' && <span className="sv-sub-tag">Swarm</span>}
                  {sub.model && <span className="sv-sub-model" data-private="">{sub.model}</span>}
                  {sub.stepCount && sub.stepCount > 0 ? <span className="sv-sub-steps-n">#{sub.stepCount}</span> : null}
                  {elapsed && <span className="sv-sub-time">{elapsed}</span>}
                  {note && <span className={`sv-sub-note ${note.stale ? 'is-stale' : ''}`}>{note.text}</span>}
                </div>
                {sub.summary && (
                  <div className="sv-sub-summary" data-private="" title={privacy ? undefined : sub.summary}>
                    {sub.summary}
                  </div>
                )}
                {isOpen && hasDetail && (
                  <div className="sv-sub-detail">
                    {steps.length > 0 && (
                      <div className="sv-sub-detail-group">
                        <div className="sv-sub-detail-label">最近步骤</div>
                        {steps.map((st, idx) => (
                          <div key={`${idx}-${st.summary}`} className={`sv-sub-step is-${st.status}`}>
                            <span className="sv-sub-step-dot" aria-hidden="true" />
                            <span data-private="">{st.summary}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {files.length > 0 && onInspectFile && (
                      <div className="sv-sub-detail-group">
                        <div className="sv-sub-detail-label">涉及文件</div>
                        <div className="sv-tool-files">
                          {files.map((fp) => (
                            <button
                              key={fp}
                              type="button"
                              className="sv-file-chip"
                              data-testid="sv-subagent-file"
                              data-file-path={fp}
                              data-private=""
                              title={privacy ? undefined : `在右侧面板打开 ${fp}`}
                              onClick={() => onInspectFile(fp)}
                            >
                              {fileBase(fp)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
