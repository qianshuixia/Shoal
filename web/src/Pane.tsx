import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, RefObject } from 'react';
import type { Card, Project, QuotaInfo, SessionInfo, Task } from '../../shared/protocol.ts';
import { AGENT_LABEL, canResume } from '../../shared/protocol.ts';
import { attach, fitEntry, focusOnly } from './terms.ts';
import { EditableTitle, PencilIcon, StatusTag } from './bits.tsx';
import { AgentIcon } from './agentIcons.tsx';
import { usePrivacy } from './privacy.ts';
import { liveWindows, QUOTA_WARN, quotaTitle } from './quota.ts';

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
}

export const SESSION_DRAG_TYPE = 'application/x-wb-session';

// Floating popover anchored below the header's 待验收 split pill: never alters .pane-body height or triggers PTY resize.
function ReviewPopover({ card, toggleRef, onClose, onEscape, onFeedback, onForward }: {
  card: Card;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onEscape(): void;
  onFeedback(): void;
  onForward(): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const privacy = usePrivacy();
  const summary = card.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('.review-item')?.focus();
    const away = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && !ref.current?.contains(t) && !toggleRef.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, onEscape, toggleRef]);

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
        {open && <div className="review-body" data-testid="review-body" data-private="">{card.body}</div>}
      </div>
    </div>
  );
}

// What the session's limit looks like in the pane banner: the CLI's own message, plus the reset time when known.
const limitText = (l: NonNullable<SessionInfo['limit']>) =>
  `额度用完：${l.message}${l.resetsAt ? `，${new Date(l.resetsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 重置` : ''}`;

// Shown on the session that took over from another agent: one line; its expanded body floats over the terminal so expanding never resizes the PTY.
function HandoffBar({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const from = card.meta?.from;

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

export function Pane({ index, sessionId, session, task, project, focused, dual, now, quota, onFocus, onRename, onResume, card, onApprove, onFeedback, onSwitch, onForward, handoff, onDropSession }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const reviewToggleRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  // Secondary review actions live in a floating popover anchored to the header; Approve sits directly in the header.
  const [openCard, setOpenCard] = useState<string | null>(null);
  const reviewing = task?.phase === 'review' && !!card;
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
    };
  }, [sessionId]);

  const privacy = usePrivacy();
  const [dropOver, setDropOver] = useState(false);
  const style = { '--c': task?.color ?? 'var(--text-3)' } as CSSProperties;
  const wantsSession = (e: DragEvent) => !!onDropSession && e.dataTransfer.types.includes(SESSION_DRAG_TYPE);
  return (
    <div
      className={`pane ${focused ? 'focused' : ''} ${dual ? 'dual' : ''} ${dropOver ? 'drop-over' : ''}`}
      style={style}
      data-testid="pane"
      data-pane-index={index}
      data-session-id={sessionId ?? ''}
      data-focused={focused ? 'true' : 'false'}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
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
          <span className="pane-agent">{paneAgent ?? '?'}</span>
          {paneAgent && quota && paneWindows.length > 0 && (
            <span className="quota pane-quota" data-testid="pane-quota" data-agent={paneAgent} title={quotaTitle(paneAgent, quota, paneWindows, now)}>
              {paneWindows.map((w) => (
                <span key={w.label} className={`quota-win ${w.usedPercent >= QUOTA_WARN ? 'warn' : ''} ${w.usedPercent >= 100 ? 'full' : ''}`} data-testid="pane-quota-window" data-label={w.label}>
                  {w.label} {Math.round(w.usedPercent)}%
                </span>
              ))}
            </span>
          )}
          {session && !(task?.phase === 'approved' && session.status === 'needs_you') && <StatusTag status={session.status} since={session.statusSince} now={now} />}
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
        />
      )}
      {session?.limit && (
        <div className="limit-bar" data-testid="pane-limit">
          <span className="limit-text" title={session.limit.message}>{limitText(session.limit)}</span>
          <button className="btn primary" data-testid="pane-limit-switch" onClick={onSwitch}>换 agent</button>
        </div>
      )}
      {handoff && handoff.sessionId === sessionId && <HandoffBar key={handoff.id} card={handoff} />}
      <div className="pane-stage">
        <div className="pane-body" ref={bodyRef} />
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
