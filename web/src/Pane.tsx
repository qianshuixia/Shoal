import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, DragEvent, RefObject } from 'react';
import type { ActivityPhase, Card, Project, QuotaInfo, SessionActivity, SessionInfo, Task, TaskMetrics } from '../../shared/protocol.ts';
import { AGENT_LABEL, DELEGATION_LABEL, canResume, delegationState } from '../../shared/protocol.ts';
import { attach, detach, fitEntry, focusOnly, isReplayEmpty, refreshTerminalCanvas, requestReplay, subscribeReplayEmpty } from './terms.ts';
import { EditableTitle, PencilIcon, QuotaPill, StatusTag, TelemetryPill } from './bits.tsx';
import { AgentIcon } from './agentIcons.tsx';
import { usePrivacy } from './privacy.ts';
import { liveWindows } from './quota.ts';
import { fmtClock } from './util.ts';
import { DelegationHud, type DelegateView } from './DelegationHud.tsx';

interface Props {
  index: number;
  sessionId: string | null;
  session?: SessionInfo;
  task?: Task;
  project?: Project;
  focused: boolean;
  dual: boolean;
  now: number;
  quota?: QuotaInfo;
  metrics?: TaskMetrics;
  activity?: SessionActivity;
  onInterrupt?(): void;
  onInspectFile?(filePath: string): void;
  onFocus(): void;
  onRename(title: string): void;
  onResume(fresh: boolean): void;
  card?: Card; // latest result card of the task
  onApprove(): void;
  onFeedback(): void; // open the new-session feedback dialog
  onSwitch(): void; // open the switch-agent dialog
  onForward(): void; // open the forward dialog for the result card
  handoff?: Card; // latest handoff card of the task
  onDropSession?(sessionId: string): void; // a sidebar task row was dropped on this pane (dual layout only)
  delegates?: DelegateView[]; // tasks this task delegated to other CLIs (open ones, plus recently closed ones)
  onOpenDelegate?(sessionId: string): void;
  parentTask?: Task; // set on a delegated task: the main task that dispatched it (when it still exists)
  onOpenParent?(): void;
  onOpenPath?(path: string): void; // open a file outside the project (the CLI's transcript) with the system handler
}

export const SESSION_DRAG_TYPE = 'application/x-wb-session';

// Shown over an exited session's empty terminal (no output was saved, e.g. it ran before Shoal kept scrollback):
// the task's last reply and a way to the CLI's own conversation file.
function ExitedSummary({ card, transcriptPath, onOpenPath }: { card?: Card; transcriptPath?: string; onOpenPath?(path: string): void }) {
  const privacy = usePrivacy();
  return (
    <div className="pane-exited-summary" data-testid="pane-exited-summary">
      <div className="pane-exited-summary-head">
        <span>终端内容没有保存下来{card ? `，下面是最后一轮回复（${new Date(card.createdAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}</span>
        {transcriptPath && onOpenPath && (
          <button className="btn" data-testid="pane-open-transcript" title={privacy ? undefined : transcriptPath} onClick={() => onOpenPath(transcriptPath)}>打开对话记录</button>
        )}
      </div>
      {card
        ? <div className="pane-exited-summary-body" data-testid="pane-exited-reply" data-private="">{card.body}</div>
        : <div className="pane-exited-summary-none">这个会话没有留下回复记录。</div>}
    </div>
  );
}
export const ACTIVITY_STALL_MS = 60_000;

const PHASE_LABEL: Record<ActivityPhase, string> = {
  thinking: '思考规划',
  tool: '执行工具',
  subagent: '等待子代理',
  compacting: '压缩上下文',
  error: '步骤异常',
};

function fmtNoProgress(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 120) return `已 ${s} 秒无新进展`;
  return `已 ${Math.floor(s / 60)}分${s % 60}秒无新进展`;
}

function fileBase(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

// Floating live activity HUD overlaid inside .pane-stage: position:absolute so .pane-body never resizes or clears ConPTY.
function ActivityHud({ activity, now, onInterrupt, onInspectFile, onRestoreFocus, onVacate }: {
  activity: SessionActivity;
  now: number;
  onInterrupt?(): void;
  onInspectFile?(filePath: string): void;
  onRestoreFocus?(): void;
  onVacate?(): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const prevBoxRef = useRef({ w: 0, h: 0, top: 0 });
  const vacateRafRef = useRef(0);
  const onVacateRef = useRef(onVacate);
  onVacateRef.current = onVacate;
  const privacy = usePrivacy();

  const turnSec = Math.max(0, Math.floor((now - activity.turnStartedAt) / 1000));
  const idleMs = Math.max(0, now - activity.lastProgressAt);
  const idleSec = Math.floor(idleMs / 1000);
  const stalled = idleMs >= ACTIVITY_STALL_MS;
  const writtenSet = new Set(activity.filesWritten);
  const touchedFiles = [
    ...activity.filesWritten,
    ...activity.filesRead.filter((f) => !writtenSet.has(f)),
  ].slice(0, 12);
  const hasInterrupt = !!onInterrupt;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const top = el.offsetTop;
    const prev = prevBoxRef.current;
    prevBoxRef.current = { w, h, top };
    if (prev.w > 0 && (w < prev.w || h < prev.h || top !== prev.top)) {
      cancelAnimationFrame(vacateRafRef.current);
      vacateRafRef.current = requestAnimationFrame(() => {
        vacateRafRef.current = 0;
        onVacateRef.current?.();
      });
    }
  }, [
    activity.summary,
    activity.stepCount,
    stalled,
    stalled ? idleSec : 0,
    hasInterrupt,
    open,
    open ? activity.thinkingSnippet : '',
    open ? activity.recentSteps.length : 0,
    open ? touchedFiles.length : 0,
    turnSec,
  ]);

  useEffect(() => () => {
    cancelAnimationFrame(vacateRafRef.current);
    const fn = onVacateRef.current;
    if (fn) requestAnimationFrame(fn);
  }, []);

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

  const steps = activity.recentSteps.slice().reverse();

  return (
    <div
      className={`activity-hud phase-${activity.phase} ${stalled ? 'stalled' : ''}`}
      data-testid="activity-hud"
      data-phase={activity.phase}
      data-stalled={stalled ? 'true' : 'false'}
      ref={ref}
    >
      <div className="activity-bar">
        <button
          type="button"
          className="activity-pill"
          data-testid="activity-toggle"
          aria-expanded={open}
          title={privacy ? undefined : `${activity.summary}（点击查看步骤与文件详情）`}
          // Clicking must not take focus from the terminal: a focused pill keeps a ring that reads as a second outline.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="activity-dot" aria-hidden="true" />
          <span className="activity-summary" data-testid="activity-summary" data-private="">
            {activity.summary}
          </span>
          {activity.stepCount > 0 && (
            <span className="activity-steps-count" data-testid="activity-step-count">
              #{activity.stepCount}
            </span>
          )}
          <span className="activity-elapsed" data-testid="activity-elapsed" title="本轮已耗时">
            {fmtClock(turnSec)}
          </span>
          {stalled && (
            <span className="activity-stall-badge" data-testid="activity-stall-badge">
              {fmtNoProgress(idleSec)}
            </span>
          )}
          <svg className={`activity-chev ${open ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6l3.5 4 3.5-4" />
          </svg>
        </button>
        {stalled && onInterrupt && (
          <button
            type="button"
            className="activity-interrupt"
            data-testid="activity-interrupt"
            title="向终端发送 Esc 中断当前卡住的步骤（不关闭会话）"
            onClick={(e) => {
              e.stopPropagation();
              onInterrupt();
            }}
          >
            发送 Esc 中断
          </button>
        )}
      </div>
      {open && (
        <div className="activity-popover" data-testid="activity-popover">
          <div className="activity-popover-head">
            <span className="activity-phase-tag">{PHASE_LABEL[activity.phase]}</span>
            {activity.model && <span className="activity-model-tag">{activity.model}</span>}
            <span className="activity-meta-stats">
              本轮 {fmtClock(turnSec)} · 距上次进展 {idleSec}s
            </span>
            {onInterrupt && (
              <button
                type="button"
                className="ghost activity-popover-esc"
                data-testid="activity-popover-interrupt"
                title="向当前终端发送 Esc 键"
                onClick={() => onInterrupt()}
              >
                发送 Esc
              </button>
            )}
          </div>
          {activity.thinkingSnippet && (
            <div className="activity-thinking" data-testid="activity-thinking" data-private="">
              {activity.thinkingSnippet}
            </div>
          )}
          {steps.length > 0 && (
            <div className="activity-steps" data-testid="activity-steps">
              {steps.map((st, idx) => (
                <div key={`${st.at}-${idx}`} className={`activity-step is-${st.status ?? 'done'}`} data-testid="activity-step">
                  <span className="activity-step-dot" aria-hidden="true" />
                  <span className="activity-step-label" data-private="" title={privacy ? undefined : st.detail ?? st.summary}>
                    {st.summary}
                  </span>
                  {st.detail && <span className="activity-step-tool">{st.detail}</span>}
                </div>
              ))}
            </div>
          )}
          {touchedFiles.length > 0 && (
            <div className="activity-files" data-testid="activity-files">
              {touchedFiles.map((fp) => {
                const isWrite = writtenSet.has(fp);
                return (
                  <button
                    type="button"
                    key={fp}
                    className={`activity-file ${isWrite ? 'is-write' : 'is-read'}`}
                    data-testid="activity-file"
                    data-file-path={fp}
                    data-private=""
                    title={privacy ? undefined : `${isWrite ? '已修改' : '已读取'}：${fp}`}
                    onClick={() => {
                      onInspectFile?.(fp);
                      setOpen(false);
                    }}
                  >
                    <span className="activity-file-kind">{isWrite ? '改' : '读'}</span>
                    <span className="activity-file-name">{fileBase(fp)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Floating popover anchored below the header's 待验收 split pill: never alters .pane-body height or triggers PTY resize.
function ReviewPopover({ card, toggleRef, onClose, onEscape, onFeedback, onForward, onVacate }: {
  card: Card;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onEscape(): void;
  onFeedback(): void;
  onForward(): void;
  onVacate?(): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const prevOpenRef = useRef(false);
  const handlersRef = useRef({ onClose, onEscape, onVacate });
  handlersRef.current = { onClose, onEscape, onVacate };
  const privacy = usePrivacy();
  const bodyText = typeof card.body === 'string' ? card.body : '';
  const summary = bodyText.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (wasOpen && !open) {
      const raf = requestAnimationFrame(() => handlersRef.current.onVacate?.());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('.review-item')?.focus();
    const away = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && !ref.current?.contains(t) && !toggleRef.current?.contains(t)) handlersRef.current.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handlersRef.current.onEscape();
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [toggleRef]);

  const move = (dir: number) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.review-item') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + dir + items.length) % items.length]?.focus();
  };

  return (
    <div
      className="review-popover"
      data-testid="review-popover"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      }}
    >
      <div className="review-menu">
        <button
          type="button"
          className="review-item"
          data-testid="review-feedback"
          onClick={() => {
            onClose();
            onFeedback();
          }}
        >
          <span className="review-item-title">新会话继续…</span>
          <span className="review-item-desc">带上任务需求、本轮结果和新要求重开会话</span>
        </button>
        <button
          type="button"
          className="review-item"
          data-testid="review-forward"
          onClick={() => {
            onClose();
            onForward();
          }}
        >
          <span className="review-item-title">转发结果…</span>
          <span className="review-item-desc">把本轮回复发给其他任务或新建任务</span>
        </button>
      </div>
      <div className="review-card-foot">
        <div className="review-card-head">
          <span className="review-summary" data-testid="review-summary" data-private="" title={privacy ? undefined : summary}>
            {summary || '（空回复）'}
          </span>
          <button
            type="button"
            className="ghost review-expand-btn"
            data-testid="review-expand"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '收起原文' : '查看原文'}
          </button>
        </div>
        {open && <div className="review-body" data-testid="review-body" data-private="">{bodyText}</div>}
      </div>
    </div>
  );
}

// What the session's limit looks like in the pane banner: the CLI's own message, plus the reset time when known.
const limitText = (l: NonNullable<SessionInfo['limit']>) =>
  `额度用完：${l.message}${l.resetsAt ? `，${new Date(l.resetsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 重置` : ''}`;

// Shown on the session that took over from another agent: one line; its expanded body floats over the terminal so expanding never resizes the PTY.
function HandoffBar({ card, onVacate }: { card: Card; onVacate?(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const onVacateRef = useRef(onVacate);
  onVacateRef.current = onVacate;
  const from = card.meta?.from;

  useEffect(() => {
    const wasOpen = openRef.current;
    openRef.current = open;
    if (wasOpen && !open) {
      const raf = requestAnimationFrame(() => onVacateRef.current?.());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  useEffect(() => () => {
    if (openRef.current) {
      const fn = onVacateRef.current;
      if (fn) requestAnimationFrame(fn);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="handoff-bar" data-testid="pane-handoff" ref={ref}>
      <div className="handoff-line">
        <span>由 {from ? AGENT_LABEL[from] : '另一个 agent'} 交接（{card.meta?.generated === false ? '按记录摘录' : '自动整理'}）</span>
        <button type="button" className="btn" data-testid="pane-handoff-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '收起' : '展开'}</button>
      </div>
      {open && <div className="handoff-body" data-testid="pane-handoff-body" data-private="">{card.body}</div>}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg style={{ width: '0.8125rem', height: '0.8125rem', flex: 'none' }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function Pane({ index, sessionId, session, task, project, focused, dual, now, quota, metrics, activity, onInterrupt, onInspectFile, onFocus, onRename, onResume, card, onApprove, onFeedback, onSwitch, onForward, handoff, onDropSession, delegates, onOpenDelegate, parentTask, onOpenParent, onOpenPath }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const reviewToggleRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  // Secondary review actions live in a floating popover anchored to the header; Approve sits directly in the header.
  const [openCard, setOpenCard] = useState<string | null>(null);
  const delegState = task ? delegationState(task, session) : null;
  // A delegated task's result is accepted by its main task, not from here.
  const reviewing = task?.phase === 'review' && !!card && !task.delegation;
  const reviewOpen = reviewing && openCard === card.id;
  const paneAgent = task?.agent ?? session?.agent;
  const paneWindows = paneAgent ? liveWindows(quota, now) : [];

  // Show this session's terminal in the pane and keep it fitted to the pane size.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!sessionId) {
      body.replaceChildren();
      return;
    }
    attach(sessionId, body);
    // A short fade so a switched terminal reads as a change instead of a jump; ends at the pane's own (maybe dimmed) opacity.
    body.animate([{ opacity: 0 }, { opacity: getComputedStyle(body).opacity }], { duration: 160, easing: 'ease-out' });
    const ro = new ResizeObserver(() => fitEntry(sessionId));
    ro.observe(body);
    const raf = requestAnimationFrame(() => fitEntry(sessionId));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      detach(sessionId, body);
    };
  }, [sessionId]);

  // An exited session's terminal starts empty after a reload or a Shoal restart: fetch its saved output.
  const exited = session?.status === 'exited';
  useEffect(() => {
    if (sessionId && exited) requestReplay(sessionId);
  }, [sessionId, exited]);
  const noReplay = useSyncExternalStore(subscribeReplayEmpty, () => !!sessionId && isReplayEmpty(sessionId));

  // Repaint the WebGL2 canvas when floating notices/popovers vanish or shift vertically so WebView2 clears vacated pixels.
  const hasActivity = session?.status === 'working' && !!activity;
  const hasDelegation = !!delegates?.length && !!onOpenDelegate;
  const queued = !!session?.queued;
  const prevFloatingRef = useRef({ sid: sessionId, queued, reviewOpen, hasActivity, hasDelegation });
  useEffect(() => {
    const prev = prevFloatingRef.current;
    prevFloatingRef.current = { sid: sessionId, queued, reviewOpen, hasActivity, hasDelegation };
    const queuedShifted = prev.queued && queued && (prev.hasActivity !== hasActivity || prev.hasDelegation !== hasDelegation);
    if (sessionId && prev.sid === sessionId && ((prev.queued && !queued) || queuedShifted || (prev.reviewOpen && !reviewOpen))) {
      const raf = requestAnimationFrame(() => refreshTerminalCanvas(sessionId));
      return () => cancelAnimationFrame(raf);
    }
  }, [sessionId, queued, reviewOpen, hasActivity, hasDelegation]);

  const privacy = usePrivacy();
  const [dropOver, setDropOver] = useState(false);
  const style = { '--c': task?.color ?? 'var(--text-3)' } as CSSProperties;
  const wantsSession = (e: DragEvent) => !!onDropSession && e.dataTransfer.types.includes(SESSION_DRAG_TYPE);
  const onPaneFocusCapture = (e: { target: EventTarget | null }) => {
    if ((e.target as Element | null)?.closest?.('.activity-hud, .delegation-hud')) return;
    onFocus();
  };
  return (
    <div
      className={`pane ${focused ? 'focused' : ''} ${dual ? 'dual' : ''} ${dropOver ? 'drop-over' : ''}`}
      style={style}
      data-testid="pane"
      data-pane-index={index}
      data-session-id={sessionId ?? ''}
      data-focused={focused ? 'true' : 'false'}
      onMouseDownCapture={onPaneFocusCapture}
      onFocusCapture={onPaneFocusCapture}
      onDragOver={(e) => {
        if (!wantsSession(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        if (!wantsSession(e)) return;
        e.preventDefault();
        setDropOver(false);
        const id = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (id) onDropSession?.(id);
      }}
    >
      {sessionId && (
        <div className="pane-header" data-testid="pane-header" key={sessionId}>
          <span className="task-swatch" />
          <AgentIcon agent={task?.agent ?? session?.agent ?? 'fake'} />
          <span className="pane-project" data-testid="pane-project" data-private="" title={privacy ? undefined : project?.path}>
            <FolderIcon />
            <span className="pane-project-name">{project?.name ?? '?'}</span>
          </span>
          {task ? <EditableTitle className="pane-title" testId="pane-title" title={task.title} onSave={onRename} editing={editing} onEditingChange={setEditing} /> : <span className="pane-title">?</span>}
          {task && !editing && (
            <button className="icon-btn pane-rename" data-testid="pane-rename" title="改名（也可以双击标题）" onClick={() => setEditing(true)}>
              <PencilIcon />
            </button>
          )}
          {delegState && (
            <span className={`pane-delegation st-deleg-${delegState}`} data-testid="pane-delegation" data-state={delegState}>
              {task?.delegation?.mode === 'review' ? '评审' : '委派'} · {DELEGATION_LABEL[delegState]}
            </span>
          )}
          {parentTask?.sessionId && onOpenParent && (
            <button
              type="button"
              className="btn pane-parent"
              data-testid="pane-delegation-parent"
              title={privacy ? undefined : `打开主任务「${parentTask.title}」`}
              onClick={onOpenParent}
            >
              ↩ 主任务
            </button>
          )}
          <span className="pane-spacer" aria-hidden="true" />
          {metrics && <TelemetryPill counts={metrics} tps={metrics.tps} label="本任务累计用量" compact testId="pane-metrics" />}
          {paneAgent && quota && paneWindows.length > 0 && (
            <QuotaPill agent={paneAgent} quota={quota} windows={paneWindows} now={now} compact />
          )}
          {session && !((task?.phase === 'approved' || task?.phase === 'review') && session.status === 'needs_you') && <StatusTag status={session.status} since={session.statusSince} now={now} />}
          {reviewing && (
            <span className="review-split">
              <button
                type="button"
                className="review-pass"
                data-testid="review-approve"
                title="验收通过（移出待验收队列，会话保留）"
                onClick={() => {
                  setOpenCard(null);
                  onApprove();
                }}
              >
                <svg className="pass-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
                通过
              </button>
              <button
                type="button"
                ref={reviewToggleRef}
                className={`review-more ${reviewOpen ? 'on' : ''}`}
                data-testid="review-toggle"
                aria-label="更多待验收操作"
                aria-haspopup="true"
                aria-expanded={reviewOpen}
                title="新会话继续、转发结果或查看本轮卡片原文"
                onClick={() => setOpenCard(reviewOpen ? null : card.id)}
              >
                <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
              </button>
            </span>
          )}
          {task && <button className="btn pane-switch" data-testid="pane-switch" title="让另一个 agent 接手这个任务" onClick={onSwitch}>换 agent</button>}
        </div>
      )}
      {reviewOpen && (
        <ReviewPopover
          key={card.id}
          card={card}
          toggleRef={reviewToggleRef}
          onClose={() => setOpenCard(null)}
          onEscape={() => {
            setOpenCard(null);
            if (!dual || focused) focusOnly(sessionId);
          }}
          onFeedback={onFeedback}
          onForward={onForward}
          onVacate={() => refreshTerminalCanvas(sessionId)}
        />
      )}
      {session?.limit && (
        <div className="limit-bar" data-testid="pane-limit">
          <span className="limit-text" title={session.limit.message}>{limitText(session.limit)}</span>
          <button className="btn primary" data-testid="pane-limit-switch" onClick={onSwitch}>换 agent</button>
        </div>
      )}
      {handoff && handoff.sessionId === sessionId && <HandoffBar key={handoff.id} card={handoff} onVacate={() => refreshTerminalCanvas(sessionId)} />}
      <div className="pane-stage">
        <div
          className="pane-body"
          ref={bodyRef}
          onMouseDown={(e) => {
            if (sessionId && e.target === e.currentTarget) focusOnly(sessionId);
          }}
        />
        {hasActivity && activity && (
          <ActivityHud
            key={sessionId ?? 'none'}
            activity={activity}
            now={now}
            onInterrupt={onInterrupt}
            onInspectFile={onInspectFile}
            onRestoreFocus={() => {
              if (!dual || focused) focusOnly(sessionId);
            }}
            onVacate={() => refreshTerminalCanvas(sessionId)}
          />
        )}
        {hasDelegation && delegates && onOpenDelegate && (
          <DelegationHud
            key={sessionId ?? 'none'}
            delegates={delegates}
            now={now}
            hasActivity={hasActivity}
            onOpen={onOpenDelegate}
            onRestoreFocus={() => {
              if (!dual || focused) focusOnly(sessionId);
            }}
            onVacate={() => refreshTerminalCanvas(sessionId)}
          />
        )}
        {exited && noReplay && (
          <ExitedSummary card={card} transcriptPath={session?.transcriptPath} onOpenPath={onOpenPath} />
        )}
        {!!session?.queued && (
          <div className="pane-queued" data-testid="pane-queued">消息排队中，agent 空闲后自动发送</div>
        )}
      </div>
      {session?.status === 'exited' && task && (
        <div className="pane-exited" data-testid="pane-exited">
          <span>会话已退出{session.exitCode ? `（退出码 ${session.exitCode}）` : ''}</span>
          {canResume(session) && (
            <button className="btn primary" data-testid="pane-resume" onClick={() => onResume(false)}>续接上次会话</button>
          )}
          <button className="btn" data-testid="pane-fresh" onClick={() => onResume(true)}>新开会话</button>
        </div>
      )}
      {!sessionId && (
        <div className="pane-empty">
          <span>从左侧选一个任务</span>
          <span className="pane-empty-hint">或按 <kbd>Alt</kbd><kbd>N</kbd> 在当前项目新建</span>
        </div>
      )}
    </div>
  );
}
