import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Card,
  ClientMsg,
  Snapshot,
  Task,
  TaskConversationResponse,
} from '../../../shared/protocol.ts';
import { AGENT_LABEL, canResume } from '../../../shared/protocol.ts';
import { AgentIcon } from '../agentIcons.tsx';
import { MarkdownPreview } from '../MarkdownPreview.tsx';
import { STATUS_LABEL } from '../util.ts';
import { mobileGet, mobilePost, mobileUploadImage, newClientMsgId } from './api.ts';
import { ConfirmSheet } from './ConfirmSheet.tsx';
import { ConnBar } from './ConnBar.tsx';
import { clearDraft, clearSendId, loadDraft, resolveSendId, saveDraft } from './drafts.ts';
import { EmergencyTerminalDrawer } from './EmergencyTerminalDrawer.tsx';
import type { TermStreamEvent } from './EmergencyTerminalDrawer.tsx';
import { ForwardSheet, NewSessionSheet, RenameSheet, SwitchAgentSheet } from './MobileSheets.tsx';
import { ReadOnlyDiffDrawer } from './ReadOnlyDiffDrawer.tsx';
import { useBackLayer } from './useBackLayer.ts';

const BOTTOM_THRESHOLD_PX = 80;
const DRAFT_SAVE_MS = 400;
const SEND_STATUS_MS = 3000;
const PROMPT_POLL_MS = 2000;

// Shape returned by GET /api/mobile/tasks/:id/prompt (server/prompt.ts PromptView).
interface MobilePrompt {
  kind: 'yn' | 'menu' | 'confirm' | 'unknown';
  lines: string[];
  keys: { label: string; data: string }[];
  fingerprint: string;
  waitSeq: number;
}

const CARD_LABEL: Record<Card['kind'], string> = {
  result: '结果卡片',
  feedback: '追问',
  handoff: '跨智能体交接',
  forward: '来自其他任务的转发',
};

class MarkdownBubbleBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prevProps: { content: string }) {
    if (prevProps.content !== this.props.content && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <div style={{ whiteSpace: 'pre-wrap' }}>{this.props.content}</div>;
    }
    return this.props.children;
  }
}

export function MobileTaskView({
  task,
  state,
  wsConnected,
  lastSyncAt,
  subscribeTerm,
  sendMsg,
  onBack,
  onOpenTask,
}: {
  task: Task;
  state: Snapshot;
  now: number;
  wsConnected: boolean;
  lastSyncAt: number | null;
  subscribeTerm(fn: (ev: TermStreamEvent) => void): () => void;
  sendMsg(msg: ClientMsg): void;
  onBack(): void;
  onOpenTask(taskId: string): void;
}) {
  const session = useMemo(
    () => (task.sessionId ? state.sessions.find((s) => s.id === task.sessionId) : undefined),
    [state.sessions, task.sessionId],
  );
  const project = useMemo(() => state.projects.find((p) => p.id === task.projectId), [state.projects, task.projectId]);
  const git = state.git[task.projectId];
  const taskCards = useMemo(
    () => state.cards.filter((c) => c.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt),
    [state.cards, task.id],
  );
  const lastResultCard = useMemo(
    () => [...taskCards].reverse().find((c) => c.kind === 'result'),
    [taskCards],
  );
  const liveActivity = session ? state.activity?.[session.id] ?? null : null;

  const [conv, setConv] = useState<TaskConversationResponse | null>(null);
  const [loadingConv, setLoadingConv] = useState(true);
  const [convError, setConvError] = useState('');

  // Component is keyed by task id, so the initial draft never leaks between tasks.
  const [initialDraft] = useState(() => loadDraft(task.id));
  const [input, setInput] = useState(initialDraft?.text ?? '');
  const [attachments, setAttachments] = useState<string[]>(initialDraft?.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [sendStatus, setSendStatus] = useState<'' | 'sending' | 'queued' | 'delivered'>('');
  const [confirmArchive, setConfirmArchive] = useState(false);

  const [prompt, setPrompt] = useState<MobilePrompt | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptSentFp, setPromptSentFp] = useState<string | null>(null);
  const [promptNote, setPromptNote] = useState('');

  const [drawer, setDrawer] = useState<'none' | 'diff' | 'term'>('none');
  const [sheet, setSheet] = useState<'none' | 'more' | 'switch' | 'forward' | 'new-session' | 'rename'>('none');

  const [showLatest, setShowLatest] = useState(false);

  // All drawers/sheets share one history entry so system back closes only the top layer.
  const layerOpen = drawer !== 'none' || sheet !== 'none';
  const layer = useBackLayer(layerOpen, () => {
    setDrawer('none');
    setSheet('none');
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The banner shows the whole terminal screen; the options are at its bottom, what they are about may be above. A
  // new wait opens at the bottom; a redraw of the same wait keeps a user who scrolled up to read where they are.
  const promptLinesRef = useRef<HTMLPreElement>(null);
  const promptAtBottomRef = useRef(true);
  const promptWaitRef = useRef<number | null>(null);
  useEffect(() => {
    const el = promptLinesRef.current;
    const wait = prompt?.waitSeq ?? null;
    const newWait = wait !== promptWaitRef.current;
    promptWaitRef.current = wait;
    if (el && (newWait || promptAtBottomRef.current)) {
      el.scrollTop = el.scrollHeight;
      promptAtBottomRef.current = true;
    }
  }, [prompt?.fingerprint, prompt?.waitSeq]);
  const stickBottomRef = useRef(true);
  const sendingRef = useRef(false);
  const sendStatusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const promptSeqRef = useRef(0);
  const draftRef = useRef({ text: input, attachments });
  draftRef.current = { text: input, attachments };

  const loadSeqRef = useRef(0);
  const prevTaskIdRef = useRef<string | null>(null);

  const loadConversation = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setConvError('');
    try {
      const data = await mobileGet<TaskConversationResponse>(`/api/mobile/tasks/${encodeURIComponent(task.id)}/conversation`);
      if (seq !== loadSeqRef.current) return;
      setConv(data);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setConvError((e as Error).message);
    } finally {
      if (seq === loadSeqRef.current) setLoadingConv(false);
    }
  }, [task.id]);

  // Auto-refresh structured conversation whenever task, session id/status, or cards change.
  const latestCardId = taskCards.at(-1)?.id ?? '';
  useEffect(() => {
    if (prevTaskIdRef.current !== task.id) {
      prevTaskIdRef.current = task.id;
      setConv(null);
      setLoadingConv(true);
    }
    void loadConversation();
  }, [task.id, session?.id, session?.status, taskCards.length, latestCardId, wsConnected, loadConversation]);

  // Interactive prompt of a blocked session (R3). Re-read whenever the block or the session status changes, on
  // reconnect, and by polling while blocked (the hook can arrive before the CLI has drawn the prompt).
  const blocked = session?.blocked;
  const loadPrompt = useCallback(async () => {
    const seq = ++promptSeqRef.current;
    try {
      const res = await mobileGet<{ prompt: MobilePrompt | null }>(`/api/mobile/tasks/${encodeURIComponent(task.id)}/prompt`);
      if (seq !== promptSeqRef.current) return;
      setPrompt(res.prompt);
    } catch {
      /* keep the last prompt; the next poll retries */
    }
  }, [task.id]);
  useEffect(() => {
    if (!blocked) {
      promptSeqRef.current++;
      setPrompt(null);
      setPromptSentFp(null);
      setPromptNote('');
      return;
    }
    void loadPrompt();
    const timer = setInterval(() => void loadPrompt(), PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [blocked, session?.id, session?.status, wsConnected, loadPrompt]);

  const answerPrompt = async (data: string) => {
    if (!prompt || promptBusy || !wsConnected) return;
    setPromptBusy(true);
    setPromptNote('');
    try {
      await mobilePost(`/api/mobile/tasks/${encodeURIComponent(task.id)}/prompt-answer`, { fingerprint: prompt.fingerprint, waitSeq: prompt.waitSeq, data });
      setPromptSentFp(prompt.fingerprint);
    } catch (e) {
      if ((e as { code?: string }).code === 'stale') setPromptNote('已在别处处理');
      else setPromptNote((e as Error).message);
      await loadPrompt();
    } finally {
      setPromptBusy(false);
    }
  };

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Markdown may lay out after this commit; pin again on the next frame.
    requestAnimationFrame(() => {
      if (stickBottomRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  const convLoaded = conv !== null;
  useEffect(() => {
    if (!convLoaded) return;
    if (stickBottomRef.current) scrollToBottom();
    else setShowLatest(true);
  }, [convLoaded, conv?.items.length, liveActivity?.stepCount, scrollToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
    stickBottomRef.current = atBottom;
    if (atBottom) setShowLatest(false);
  };

  const jumpToLatest = () => {
    stickBottomRef.current = true;
    setShowLatest(false);
    scrollToBottom();
  };

  // Reply box grows with its content (JS, not field-sizing: Safari lacks it); CSS max-height caps it at ~6 lines.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
  }, [input]);

  // Throttled draft persistence; flushed when the page is hidden or the view unmounts.
  const flushDraft = useCallback(() => {
    const d = draftRef.current;
    // While a send is in flight keep the stored draft until it is confirmed.
    if (sendingRef.current && !d.text && d.attachments.length === 0) return;
    saveDraft(task.id, d);
  }, [task.id]);
  useEffect(() => {
    const timer = setTimeout(flushDraft, DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [input, attachments, flushDraft]);
  useEffect(() => {
    const onHide = () => flushDraft();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flushDraft();
    };
  }, [flushDraft]);

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setActionError('');
    try {
      for (const file of Array.from(files)) {
        const name = await mobileUploadImage(file);
        setAttachments((prev) => [...prev, name]);
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const showSendStatus = (st: 'sending' | 'queued' | 'delivered', autoClearMs?: number) => {
    clearTimeout(sendStatusTimerRef.current);
    setSendStatus(st);
    if (autoClearMs) sendStatusTimerRef.current = setTimeout(() => setSendStatus(''), autoClearMs);
  };
  useEffect(() => () => clearTimeout(sendStatusTimerRef.current), []);

  const sendFeedback = async () => {
    if (sending || uploading || !wsConnected) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const sentRaw = input;
    const sentAttachments = attachments;
    // Same payload as an earlier attempt (persisted per task, 10 min): same id, so the server dedupes a retry even
    // when the first response was lost and the user left the task in between.
    const body = {
      text,
      mode: 'same',
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    };
    const clientMsgId = resolveSendId(task.id, JSON.stringify(body), newClientMsgId);
    // Optimistic: clear right away; restore (merged with anything typed meanwhile) if the request fails.
    setInput('');
    setAttachments([]);
    sendingRef.current = true;
    setSending(true);
    setActionError('');
    showSendStatus('sending');
    try {
      const res = await mobilePost<{ session?: { queued?: number } }>(`/api/tasks/${encodeURIComponent(task.id)}/feedback`, {
        ...body,
        clientMsgId,
      });
      clearSendId(task.id, clientMsgId);
      showSendStatus((res.session?.queued ?? 0) > 0 ? 'queued' : 'delivered', SEND_STATUS_MS);
      sendingRef.current = false;
      const d = draftRef.current;
      if (!d.text && d.attachments.length === 0) clearDraft(task.id);
      stickBottomRef.current = true;
      setShowLatest(false);
      await loadConversation();
      scrollToBottom();
    } catch (e) {
      clearTimeout(sendStatusTimerRef.current);
      setSendStatus('');
      setInput((cur) => (cur ? `${sentRaw}\n${cur}` : sentRaw));
      setAttachments((cur) => [...sentAttachments, ...cur]);
      setActionError((e as Error).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const runTaskAction = async (path: string, body: unknown = {}) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError('');
    try {
      await mobilePost(path, body);
      setSheet('none');
      await loadConversation();
    } catch (e) {
      // A 409 (stale review round, ...) carries the server's wording; the task itself is refreshed by the WS push.
      setActionError((e as Error).message);
      if ((e as { status?: number }).status === 409) void loadConversation();
    } finally {
      setActionBusy(false);
    }
  };

  const canSendSameSession = Boolean(
    session && (session.status !== 'exited' || canResume(session)),
  );
  const statusText = session ? STATUS_LABEL[session.status] : '未启动';

  return (
    <div className="mob-root" data-testid="mobile-task-view">
      <header className="mob-header">
        <button type="button" className="mob-btn compact ghost" data-testid="mobile-back-btn" onClick={onBack}>
          ←
        </button>
        <AgentIcon agent={session?.agent ?? task.agent} className="agent-icon" />
        <div className="mob-title-wrap">
          <span className="mob-title" data-private="">{task.title}</span>
          <span className="mob-sub">
            <span data-private="">{project?.name ?? '项目'}</span> · {AGENT_LABEL[session?.agent ?? task.agent]} · {statusText}
            {task.phase === 'review' ? ' · 待验收' : task.phase === 'approved' ? ' · 已通过' : task.phase === 'archived' ? ' · 已归档' : ''}
          </span>
        </div>
        <button type="button" className="mob-btn compact" data-testid="mobile-open-diff-btn" onClick={() => setDrawer('diff')}>
          变更{git && git.dirty > 0 ? `(${git.dirty})` : ''}
        </button>
        {session && (
          <button type="button" className="mob-btn compact" data-testid="mobile-open-term-btn" onClick={() => setDrawer('term')} title="应急只读终端">
            &gt;_
          </button>
        )}
        <button type="button" className="mob-btn compact ghost" data-testid="mobile-task-more-btn" onClick={() => setSheet('more')} aria-label="更多操作">
          ⋯
        </button>
      </header>

      <ConnBar wsConnected={wsConnected} lastSyncAt={lastSyncAt} />

      {session?.blocked && (
        <div className="mob-prompt-banner" data-testid="mobile-blocked-banner">
          <div data-testid="mobile-prompt-banner">
            {session.blocked === 'permission'
              ? '智能体在终端等待授权按键'
              : '会话在终端启动界面等待信任确认'}
          </div>
          {prompt && prompt.lines.length > 0 && (
            <pre
              className="mob-prompt-lines"
              data-private=""
              ref={promptLinesRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                promptAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
              }}
            >
              {prompt.lines.map((line, i) => (
                <div key={i} className="mob-prompt-line" data-testid="mobile-prompt-line">{line}</div>
              ))}
            </pre>
          )}
          {promptSentFp !== null && prompt?.fingerprint === promptSentFp ? (
            <div data-testid="mobile-prompt-sent">已发送，等待 agent 继续</div>
          ) : (
            <div className="mob-prompt-keys">
              {prompt?.keys.map((k) => (
                <button
                  key={k.data}
                  type="button"
                  className="mob-btn compact warn"
                  data-testid="mobile-prompt-key"
                  data-key={k.data}
                  disabled={promptBusy || !wsConnected}
                  onClick={() => void answerPrompt(k.data)}
                >{k.label}</button>
              ))}
            </div>
          )}
          {promptNote && <div data-testid="mobile-prompt-note">{promptNote}</div>}
          {!wsConnected && <div>连接中断，暂时不能发送按键</div>}
          <div className="mob-prompt-keys">
            <button
              type="button"
              className="mob-btn compact"
              data-testid="mobile-prompt-open-term"
              onClick={() => setDrawer('term')}
            >打开终端</button>
          </div>
        </div>
      )}

      {session?.limit && (
        <div className="mob-banner is-blocked">
          <span>额度已达上限：{session.limit.message}</span>
          <button type="button" className="mob-btn compact warn" onClick={() => setSheet('switch')}>
            换 Agent
          </button>
        </div>
      )}

      {task.phase === 'review' && (
        <div className="mob-banner is-review">
          <span>本轮已产出结果，请验收</span>
          <div style={{ display: 'flex', gap: '0.375rem', flex: 'none' }}>
            <button type="button" className="mob-btn compact" onClick={() => setDrawer('diff')}>Diff</button>
            {lastResultCard && (
              <button type="button" className="mob-btn compact" onClick={() => setSheet('forward')}>转发</button>
            )}
            <button
              type="button"
              className="mob-btn compact primary"
              data-testid="mobile-approve-btn"
              disabled={actionBusy}
              onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/approve`, { phaseSince: task.phaseSince })}
            >✓ 通过</button>
          </div>
        </div>
      )}

      <div className="mob-scroll-wrap">
      <div className="mob-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loadingConv && !conv && <div className="mob-sub">正在整理对话记录…</div>}
        {convError && <div className="form-error">{convError}</div>}

        {conv && conv.items.length === 0 && !liveActivity && (
          <div className="mob-sub">暂无对话内容，发送第一句指令即可开始。</div>
        )}

        {conv?.items.map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.id} className="mob-turn-user" data-testid="mobile-turn-user" data-private="">
                {item.text}
              </div>
            );
          }
          if (item.kind === 'assistant') {
            return (
              <div key={item.id} className="mob-turn-assistant" data-testid="mobile-turn-assistant" data-private="">
                <MarkdownBubbleBoundary content={item.text}>
                  <MarkdownPreview projectId={task.projectId} filePath="" content={item.text} />
                </MarkdownBubbleBoundary>
              </div>
            );
          }
          if (item.kind === 'tools') {
            return (
              <details key={item.id} className="mob-tools-group" data-testid="mobile-tool-group">
                <summary>已执行 {item.count} 步工具调用</summary>
                <ul className="mob-tools-list" data-private="">
                  {item.tools.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              </details>
            );
          }
          return (
            <div key={item.id} className="mob-card-event">
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{CARD_LABEL[item.card.kind]}</div>
              <div style={{ whiteSpace: 'pre-wrap' }} data-private="">{item.card.body}</div>
            </div>
          );
        })}

        {liveActivity && (
          <div className="mob-pair-card" data-testid="mobile-live-activity">
            <div className="mob-task-top" style={{ justifyContent: 'space-between' }}>
              <strong style={{ fontSize: '0.8125rem', color: 'var(--work)' }} data-private="">{liveActivity.summary}</strong>
              <span className="mob-sub">{liveActivity.stepCount} 步</span>
            </div>
            {liveActivity.thinkingSnippet && (
              <div className="mob-sub" style={{ whiteSpace: 'normal' }} data-private="">{liveActivity.thinkingSnippet}</div>
            )}
            {liveActivity.recentSteps.length > 0 && (
              <div className="mob-sub" style={{ whiteSpace: 'normal' }} data-private="">
                最近：{liveActivity.recentSteps.slice(-3).map((s) => s.summary).join(' → ')}
              </div>
            )}
            {(liveActivity.filesRead.length > 0 || liveActivity.filesWritten.length > 0) && (
              <div className="mob-sub" style={{ whiteSpace: 'normal' }} data-private="">
                {liveActivity.filesWritten.length > 0 ? `改动：${liveActivity.filesWritten.join(', ')}` : `读取：${liveActivity.filesRead.join(', ')}`}
              </div>
            )}
          </div>
        )}
      </div>
      {showLatest && (
        <button type="button" className="mob-scroll-latest" data-testid="mobile-scroll-latest" onClick={jumpToLatest}>
          ↓ 新消息
        </button>
      )}
      </div>

      <div className="mob-composer">
        {sendStatus && (
          <div className="mob-send-status" data-testid="mobile-send-status" data-status={sendStatus}>
            {sendStatus === 'sending' ? '发送中（未确认）' : sendStatus === 'queued' ? '已排队' : '已送达'}
          </div>
        )}
        {!wsConnected && (
          <div className="mob-send-status" data-testid="mobile-send-offline">连接中断，重连后才能发送</div>
        )}
        {session?.queued ? (
          <div className="mob-sub" data-testid="mobile-queued-badge">
            队列中有 {session.queued} 条指令等待当前轮次完成后发送
          </div>
        ) : null}

        {attachments.length > 0 && (
          <div className="mob-attach-chips">
            {attachments.map((name, idx) => (
              <span key={`${name}-${idx}`} className="mob-attach-chip">
                {name}
                <button type="button" className="ghost" onClick={() => setAttachments((p) => p.filter((_, i) => i !== idx))}>×</button>
              </span>
            ))}
          </div>
        )}

        {actionError && <div className="form-error">{actionError}</div>}

        {session?.status === 'exited' && !canResume(session) ? (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="mob-btn primary" style={{ flex: 1 }} onClick={() => setSheet('new-session')}>
              新会话继续
            </button>
            <button type="button" className="mob-btn" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { fresh: true })}>
              重启空白会话
            </button>
          </div>
        ) : (
          <div className="mob-composer-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              data-testid="mobile-image-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                void handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="mob-btn compact"
              data-testid="mobile-attach-btn"
              disabled={uploading || !canSendSameSession}
              onClick={() => fileInputRef.current?.click()}
              title="拍照或从相册附截图"
            >{uploading ? '…' : '📷'}</button>
            <textarea
              className="mob-composer-box"
              data-testid="mobile-composer-input"
              data-private=""
              ref={composerRef}
              rows={1}
              value={input}
              disabled={!canSendSameSession}
              placeholder={
                session?.status === 'working'
                  ? '正在运行中，发送会进入排队…'
                  : session?.status === 'exited'
                    ? '会话已退出，发送将自动恢复并继续…'
                    : '继续追问或下达修改指令…'
              }
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="button"
              className="mob-btn compact primary"
              data-testid="mobile-composer-send"
              disabled={sending || uploading || !wsConnected || !canSendSameSession || (!input.trim() && attachments.length === 0)}
              onClick={() => void sendFeedback()}
            >{sending ? '…' : '发送'}</button>
          </div>
        )}
      </div>

      {drawer === 'term' && session && (
        <EmergencyTerminalDrawer
          session={session}
          wsConnected={wsConnected}
          subscribeTerm={subscribeTerm}
          sendMsg={sendMsg}
          onClose={layer.close}
        />
      )}

      {drawer === 'diff' && (
        <ReadOnlyDiffDrawer
          projectId={task.projectId}
          projectName={project?.name ?? '项目'}
          gitKey={git ? `${git.branch}:${git.dirty}` : ''}
          onClose={layer.close}
        />
      )}

      {sheet === 'more' && (
        <div className="mob-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && layer.close()}>
          <div className="mob-sheet" data-testid="mobile-task-more-sheet">
            <h3>任务操作</h3>
            <button type="button" className="mob-btn" onClick={() => setSheet('switch')}>切换 Agent 接力</button>
            <button type="button" className="mob-btn" onClick={() => setSheet('new-session')}>开新会话继续</button>
            {lastResultCard && (
              <button type="button" className="mob-btn" onClick={() => setSheet('forward')}>转发最后结果给其他任务</button>
            )}
            <button type="button" className="mob-btn" onClick={() => setSheet('rename')}>重命名任务</button>
            {session?.status === 'exited' && canResume(session) && (
              <button type="button" className="mob-btn" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { fresh: false })}>
                重新恢复原对话
              </button>
            )}
            {task.phase !== 'archived' ? (
              <button type="button" className="mob-btn danger" data-testid="mobile-archive-btn" disabled={actionBusy} onClick={() => setConfirmArchive(true)}>
                归档并结束会话
              </button>
            ) : (
              <button type="button" className="mob-btn" disabled={actionBusy} onClick={() => void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/unarchive`)}>
                恢复为活跃任务
              </button>
            )}
            <button type="button" className="mob-btn ghost" onClick={layer.close}>取消</button>
          </div>
        </div>
      )}

      {sheet === 'switch' && (
        <SwitchAgentSheet
          task={task}
          agents={state.agents}
          onDone={() => {
            setSheet('none');
            void loadConversation();
          }}
          onClose={layer.close}
        />
      )}

      {sheet === 'forward' && lastResultCard && (
        <ForwardSheet
          sourceTask={task}
          card={lastResultCard}
          tasks={state.tasks}
          agents={state.agents}
          onForwarded={(targetId) => {
            setSheet('none');
            // Pop the layer entry first, then replace the current task entry with the target task.
            layer.popThen(() => onOpenTask(targetId));
          }}
          onClose={layer.close}
        />
      )}

      {sheet === 'new-session' && (
        <NewSessionSheet
          task={task}
          onDone={() => {
            setSheet('none');
            void loadConversation();
          }}
          onClose={layer.close}
        />
      )}

      {sheet === 'rename' && (
        <RenameSheet
          task={task}
          onDone={() => setSheet('none')}
          onClose={layer.close}
        />
      )}

      {confirmArchive && (
        <ConfirmSheet
          title="归档这个任务？"
          message={
            session && session.status !== 'exited'
              ? '会结束正在运行的会话，归档后恢复也不能续上这次进程。'
              : '归档后任务移到「已归档」，可随时恢复为活跃任务。'
          }
          confirmLabel={session && session.status !== 'exited' ? '归档并结束会话' : '归档'}
          danger
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            void runTaskAction(`/api/tasks/${encodeURIComponent(task.id)}/archive`);
          }}
        />
      )}
    </div>
  );
}
