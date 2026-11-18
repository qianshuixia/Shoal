import { useEffect, useRef, useState } from 'react';
import type { DelegationState, SessionActivity, SessionInfo, Task } from '../../shared/protocol.ts';
import { DELEGATION_LABEL, delegationDisplayTitle } from '../../shared/protocol.ts';
import { AgentIcon } from './agentIcons.tsx';
import { usePrivacy } from './privacy.ts';
import { fmtClock } from './util.ts';

export interface DelegateView {
  task: Task;
  session?: SessionInfo;
  activity?: SessionActivity;
  state: DelegationState;
}

// Count order in the pill, most attention first. working and rework share one count.
const COUNT_ORDER: { label: string; states: DelegationState[] }[] = [
  { label: DELEGATION_LABEL.needs_you, states: ['needs_you'] },
  { label: DELEGATION_LABEL.failed, states: ['failed'] },
  { label: DELEGATION_LABEL.review, states: ['review'] },
  { label: DELEGATION_LABEL.working, states: ['working', 'rework'] },
  { label: DELEGATION_LABEL.accepted, states: ['accepted'] },
  { label: DELEGATION_LABEL.canceled, states: ['canceled'] },
];

type Level = 'needs_you' | 'failed' | 'review' | 'working' | 'closed';
const levelOf = (s: DelegationState): Level =>
  s === 'working' || s === 'rework' ? 'working' : s === 'accepted' || s === 'canceled' ? 'closed' : s;
const LEVELS: Level[] = ['needs_you', 'failed', 'review', 'working', 'closed'];

// Floating HUD for a main task's delegated children, overlaid inside .pane-stage: position:absolute so .pane-body never
// resizes (a height change makes xterm + ConPTY resize the PTY and redraw the screen).
export function DelegationHud({ delegates, now, onOpen, onRestoreFocus }: {
  delegates: DelegateView[];
  now: number;
  onOpen(sessionId: string): void;
  onRestoreFocus?(): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const privacy = usePrivacy();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        onRestoreFocus?.();
      }
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onRestoreFocus]);

  const level = LEVELS.find((l) => delegates.some((d) => levelOf(d.state) === l)) ?? 'closed';
  const only = delegates.length === 1 ? delegates[0] : null;
  const counts = COUNT_ORDER
    .map((c) => ({ label: c.label, state: c.states[0], n:delegates.filter((d) => c.states.includes(d.state)).length }))
    .filter((c) => c.n > 0);

  return (
    <div className={`delegation-hud level-${level}`} data-testid="delegation-hud" ref={ref}>
      <button
        type="button"
        className="delegation-pill"
        data-testid="delegation-toggle"
        aria-expanded={open}
        title="委派给其他 CLI 的子任务（点击查看）"
        // Clicking must not take focus from the terminal: a focused pill keeps a ring that reads as a second outline.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="delegation-dot" aria-hidden="true" />
        <span className="delegation-kind">委派</span>
        {only ? (
          <>
            <AgentIcon agent={only.task.agent ?? only.session?.agent ?? 'fake'} />
            <span className="delegation-text" data-private="">{delegationDisplayTitle(only.task.title)}</span>
            <span className={`delegation-chip st-${only.state}`}>
              {DELEGATION_LABEL[only.state]}{(only.task.delegation?.round ?? 1) > 1 ? ` · 第 ${only.task.delegation!.round} 轮` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="delegation-total">{delegates.length} 个</span>
            {counts.map((c) => (
              <span key={c.label} className={`delegation-chip st-${c.state}`}>{c.n} {c.label}</span>
            ))}
          </>
        )}
        <svg className={`activity-chev ${open ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 6l3.5 4 3.5-4" />
        </svg>
      </button>
      {open && (
        <div className="delegation-popover" data-testid="delegation-popover">
          {delegates.map(({ task, session, activity, state }) => {
            const working = state === 'working' || state === 'rework';
            const live = working && activity ? activity : undefined;
            const steps = live ? live.recentSteps.slice(-3).reverse() : [];
            const round = task.delegation?.round ?? 1;
            return (
              <button
                type="button"
                key={task.id}
                className={`delegation-item is-${state}`}
                data-testid="delegation-item"
                data-task-id={task.id}
                data-state={state}
                disabled={!task.sessionId}
                onClick={() => {
                  setOpen(false);
                  if (task.sessionId) onOpen(task.sessionId);
                }}
              >
                <span className="delegation-item-head">
                  <AgentIcon agent={task.agent ?? session?.agent ?? 'fake'} />
                  <span className="delegation-item-title" data-private="">{delegationDisplayTitle(task.title)}</span>
                  {task.delegation?.mode === 'review' && <span className="delegation-mode" data-testid="delegation-mode">评审</span>}
                  <span className={`delegation-chip st-${state}`}>{DELEGATION_LABEL[state]}</span>
                  {round > 1 && <span className="delegation-item-round">第 {round} 轮</span>}
                </span>
                <span className="delegation-item-sub">
                  {live ? (
                    <>
                      <span className="delegation-item-line" data-private="">{live.summary}</span>
                      <span className="delegation-item-elapsed">{fmtClock((now - live.turnStartedAt) / 1000)}</span>
                    </>
                  ) : (
                    <span className="delegation-item-line" data-private="" title={privacy ? undefined : task.delegation?.brief}>
                      {task.delegation?.brief}
                    </span>
                  )}
                </span>
                {steps.length > 0 && (
                  <span className="delegation-item-steps">
                    {steps.map((st, idx) => (
                      <span key={`${st.at}-${idx}`} className={`activity-step is-${st.status ?? 'done'}`}>
                        <span className="activity-step-dot" aria-hidden="true" />
                        <span className="activity-step-label" data-private="">{st.summary}</span>
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
