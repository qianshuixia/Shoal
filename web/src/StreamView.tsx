import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ClipboardEvent, DragEvent } from 'react';
import type {
  Project, PromptView, SessionActivity, SessionContext, SessionInfo, SessionStreamState, StreamBlock, StreamTodoItem, Task,
} from '../../shared/protocol.ts';
import { composeLiveTail, extractPtyLiveFromLines, type PtyLiveExtract } from '../../shared/ptyLive.ts';
import { readTermLiveSnapshot, subscribeTermOutput } from './terms.ts';
import { SmoothText, StreamMarkdown } from './StreamMarkdown.tsx';

export interface StreamViewProps {
  task?: Task;
  project?: Project;
  session?: SessionInfo;
  streamState: SessionStreamState | null;
  activity?: SessionActivity | null;
  context?: SessionContext | null;
  now: number;
  privacy: boolean;
  onSwitchToTerminal(): void;
  onInterrupt?(): void;
  onInspectFile?(filePath: string): void;
  onSendMessage(text: string, attachments?: string[]): Promise<void>;
  onAnswerPrompt(fingerprint: string, waitSeq: number, data: string): Promise<void>;
}

const BOTTOM_EPS = 28;

function fmtSec(sec: number): string {
  const s = Math.max(1, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`;
}

function fileBase(p: string): string {
  const clean = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

const StepBlockView = memo(function StepBlockView({
  block,
  privacy,
  animateThinking = false,
  onInspectFile,
}: {
  block: Extract<StreamBlock, { kind: 'step' }>;
  privacy: boolean;
  animateThinking?: boolean;
  onInspectFile?: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openToolId, setOpenToolId] = useState<string | null>(null);
  const hasThinking = !!block.thinking?.trim();
  const toolCount = block.tools.length;
  const isActive = !!block.active;

  let heading = '';
  if (isActive) {
    heading = toolCount > 0 ? `正在调用 ${toolCount} 个工具` : '正在思考…';
  } else if (hasThinking && toolCount > 0) {
    heading = block.thinkingSec
      ? `思考了 ${fmtSec(block.thinkingSec)}，调用了 ${toolCount} 次工具`
      : `已完成思考，调用了 ${toolCount} 次工具`;
  } else if (hasThinking) {
    heading = block.thinkingSec ? `思考了 ${fmtSec(block.thinkingSec)}` : '思考过程';
  } else {
    heading = `调用了 ${toolCount} 次工具`;
  }

  // Show a generous 5-line reasoning preview by default; expand smoothly on click when longer.
  const thinkingLines = block.thinking ? block.thinking.split(/\r?\n/) : [];
  const isLongThinking = (block.thinking?.length ?? 0) > 420 || thinkingLines.length > 6;

  return (
    <section
      className={`sv-step ${isActive ? 'is-active' : 'is-done'}`}
      data-testid="sv-step"
      data-active={isActive ? 'true' : 'false'}
    >
      <button
        type="button"
        className="sv-step-head"
        data-testid="sv-step-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {isActive && <span className="sv-pulse-dot" aria-hidden="true" />}
        <span className="sv-step-title">{heading}</span>
        {(hasThinking || toolCount > 0) && (
          <svg className={`sv-chev ${expanded ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 6.5l3 3 3-3" />
          </svg>
        )}
      </button>

      {(hasThinking || toolCount > 0) && (
        <div className="sv-step-rail">
          {hasThinking && (
            <div
              className={`sv-thought-text ${!expanded && isLongThinking ? 'is-clamped' : ''}`}
              data-testid="sv-step-thinking"
              data-private=""
              onClick={() => isLongThinking && setExpanded((v) => !v)}
              title={!expanded && isLongThinking ? '点击展开完整思考过程' : undefined}
            >
              {animateThinking ? <SmoothText text={block.thinking!} active /> : block.thinking}
            </div>
          )}

          {toolCount > 0 && (
            <div className="sv-tool-list" data-testid="sv-tool-list">
              {block.tools.map((tool) => {
                const detailOpen = expanded || openToolId === tool.id;
                return (
                  <div key={tool.id} className={`sv-tool-item is-${tool.status}`} data-testid="sv-tool-item">
                    <div
                      className="sv-tool-row"
                      onClick={() => tool.detail && setOpenToolId((cur) => (cur === tool.id ? null : tool.id))}
                    >
                      <span className={`sv-tool-mark is-${tool.status}`} aria-hidden="true">
                        {tool.status === 'running' ? '' : tool.status === 'error' ? '!' : '✓'}
                      </span>
                      <span className="sv-tool-summary" data-private="">{tool.summary}</span>
                      {tool.files && tool.files.length > 0 && onInspectFile && (
                        <span className="sv-tool-files" onClick={(e) => e.stopPropagation()}>
                          {tool.files.slice(0, 3).map((fp) => (
                            <button
                              key={fp}
                              type="button"
                              className="sv-file-chip"
                              data-testid="sv-file-chip"
                              data-file-path={fp}
                              data-private=""
                              title={privacy ? undefined : `在右侧面板打开 ${fp}`}
                              onClick={() => onInspectFile(fp)}
                            >
                              {fileBase(fp)}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                    {detailOpen && tool.detail && (
                      <div className="sv-tool-detail" data-private="">{tool.detail}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
});

function LiveTailView({
  live,
  now,
  hasActiveStepTail,
}: {
  live: NonNullable<SessionStreamState['live']>;
  now: number;
  hasActiveStepTail: boolean;
}) {
  if (live.phase === 'tool' && hasActiveStepTail && !live.thinkingText) return null;
  const elapsedSec = Math.max(0, Math.floor((now - live.startedAt) / 1000));
  const title = live.phase === 'preparing'
    ? '正在准备模型上下文…'
    : live.phase === 'tool'
      ? `正在调用工具${elapsedSec > 0 ? ` (${elapsedSec}s)` : ''}`
      : live.phase === 'answering'
        ? `正在生成回复…${elapsedSec > 0 ? ` (${elapsedSec}s)` : ''}`
        : `正在思考…${elapsedSec > 0 ? ` (${elapsedSec}s)` : ''}`;

  const showStepHeader = live.phase !== 'preparing' && (live.phase !== 'answering' || !!live.thinkingText);
  const showRail = (live.phase === 'tool' && !!live.toolSummary) || !!live.thinkingText;

  return (
    <section className={`sv-live phase-${live.phase}`} data-testid="sv-live" data-phase={live.phase}>
      {live.phase === 'preparing' && (
        <div className="sv-preparing" data-testid="sv-preparing">
          <span className="sv-pulse-dot" aria-hidden="true" />
          <span className="sv-shimmer-text">{title}</span>
        </div>
      )}

      {showStepHeader && (
        <div className="sv-step is-active">
          <div className="sv-step-head is-static">
            <span className="sv-pulse-dot" aria-hidden="true" />
            <span className="sv-step-title">{title}</span>
          </div>
          {showRail && (
            <div className="sv-step-rail">
              {live.phase === 'tool' && live.toolSummary && (
                <div className="sv-tool-item is-running">
                  <div className="sv-tool-row">
                    <span className="sv-tool-mark is-running" aria-hidden="true" />
                    <span className="sv-tool-summary" data-testid="sv-live-tool" data-private="">{live.toolSummary}</span>
                  </div>
                </div>
              )}
              {live.thinkingText && (
                <div className="sv-thought-text is-live" data-testid="sv-live-thinking" data-private="">
                  <SmoothText text={live.thinkingText} active />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {live.phase === 'answering' && live.answerText && (
        <div className="sv-assistant is-streaming" data-testid="sv-live-answer" data-private="">
          <SmoothText text={live.answerText} active className="sv-live-plain" />
          <span className="sv-caret" aria-hidden="true" />
        </div>
      )}
    </section>
  );
}

function TodoChecklistCard({ todos }: { todos: StreamTodoItem[] }) {
  const doneCount = todos.filter((t) => t.status === 'done').length;
  const allDone = todos.length > 0 && todos.every((t) => t.status === 'done' || t.status === 'skipped');
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const open = userExpanded !== null ? userExpanded : !allDone;
  const activeItem = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  const pct = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0;

  return (
    <div className={`sv-todo-card ${allDone ? 'is-all-done' : ''}`} data-testid="sv-todo-card">
      <button
        type="button"
        className="sv-todo-head"
        data-testid="sv-todo-toggle"
        aria-expanded={open}
        onClick={() => setUserExpanded(!open)}
      >
        <span className="sv-todo-count" data-testid="sv-todo-count">
          任务清单 {doneCount}/{todos.length}
        </span>
        <span className="sv-todo-bar" aria-hidden="true">
          <span className="sv-todo-bar-fill" style={{ width: `${pct}%` }} />
        </span>
        {!open && activeItem && (
          <span className="sv-todo-current" data-private="">{activeItem.title}</span>
        )}
        <svg className={`sv-chev ${open ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 6.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
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
    </div>
  );
}

function PromptBanner({
  prompt,
  busy,
  note,
  onAnswer,
  onOpenTerminal,
}: {
  prompt: PromptView;
  busy: boolean;
  note: string;
  onAnswer: (data: string) => void;
  onOpenTerminal: () => void;
}) {
  const linesRef = useRef<HTMLPreElement>(null);
  // Keep the bottom of the terminal prompt screen (where options live) in view whenever the prompt updates.
  useEffect(() => {
    const el = linesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [prompt.fingerprint, prompt.lines.length]);

  return (
    <div className="sv-prompt-card" data-testid="sv-prompt-card" data-kind={prompt.kind}>
      <div className="sv-prompt-head">
        <span className="sv-prompt-dot" aria-hidden="true" />
        <span className="sv-prompt-title">CLI 正在等待你的确认</span>
        <button type="button" className="ghost sv-prompt-term" onClick={onOpenTerminal}>
          切到终端处理
        </button>
      </div>
      {prompt.lines.length > 0 && (
        <pre className="sv-prompt-lines" ref={linesRef} data-private="">{prompt.lines.slice(-12).join('\n')}</pre>
      )}
      {prompt.keys.length > 0 ? (
        <div className="sv-prompt-actions">
          {prompt.keys.map((k, idx) => (
            <button
              key={`${k.data}-${idx}`}
              type="button"
              className={`btn ${idx === 0 ? 'primary' : ''}`}
              data-testid="sv-prompt-key"
              disabled={busy}
              onClick={() => onAnswer(k.data)}
            >
              {k.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="sv-prompt-fallback">
          该交互界面需要按键操作，请点击右上角「切到终端处理」。
        </div>
      )}
      {note && <div className="sv-prompt-note">{note}</div>}
    </div>
  );
}

export function StreamView({
  task,
  project,
  session,
  streamState,
  activity,
  context,
  now,
  privacy,
  onSwitchToTerminal,
  onInterrupt,
  onInspectFile,
  onSendMessage,
  onAnswerPrompt,
}: StreamViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const stickRef = useRef(true);
  const scrollRafRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const mountedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptNote, setPromptNote] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
    };
  }, []);

  // Track which block IDs existed on initial load so history never re-animates, while newly arrived turns glide in.
  const initializedSidRef = useRef<string | null>(null);
  const seenBlocksRef = useRef<Set<string>>(new Set());
  const freshBlocksRef = useRef<Set<string>>(new Set());

  const sessionId = session?.id ?? null;
  const blocks = streamState?.blocks ?? [];
  const todos = streamState?.todos ?? [];
  const prompt = streamState?.prompt ?? null;
  const working = session?.status === 'working';
  const agent = session?.agent ?? task?.agent ?? 'fake';

  // Read live PTY tail directly from the uncorrupted browser xterm.js buffer while working,
  // with a 220ms transient-blank hold so brief ConPTY line-redraw frames never cause blinking.
  const [ptyExtract, setPtyExtract] = useState<PtyLiveExtract | null>(null);
  const lastLiveAnswerLenRef = useRef(0);
  const blockInitialCharsRef = useRef<Map<string, number>>(new Map());
  const lastUserPrompt = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'user') return b.text;
    }
    return undefined;
  }, [blocks]);
  const lastUserRef = useRef(lastUserPrompt);
  lastUserRef.current = lastUserPrompt;

  useEffect(() => {
    if (!working || !sessionId) {
      setPtyExtract(null);
      return;
    }
    let throttleTimer: number | undefined;
    let holdTimer: number | undefined;
    let lastValid: PtyLiveExtract | null = null;

    const sample = () => {
      throttleTimer = undefined;
      const snap = readTermLiveSnapshot(sessionId);
      if (!snap) return;
      const ext = extractPtyLiveFromLines(agent, snap.lines, lastUserRef.current, snap.isAlternate);
      const hasText = !!(ext.answerText || ext.thinkingText);
      if (hasText) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
        lastValid = ext;
        if (ext.answerText) lastLiveAnswerLenRef.current = ext.answerText.length;
        setPtyExtract((prev) =>
          prev?.answerText === ext.answerText && prev?.thinkingText === ext.thinkingText && prev?.spinnerText === ext.spinnerText
            ? prev
            : ext,
        );
      } else if (lastValid) {
        if (!holdTimer) {
          holdTimer = window.setTimeout(() => {
            holdTimer = undefined;
            lastValid = null;
            setPtyExtract(ext.spinnerText ? { spinnerText: ext.spinnerText } : null);
          }, 220);
        }
      } else {
        setPtyExtract((prev) => (prev?.spinnerText === ext.spinnerText && !prev?.answerText && !prev?.thinkingText ? prev : ext));
      }
    };

    const schedule = () => {
      if (throttleTimer !== undefined) return;
      throttleTimer = window.setTimeout(sample, 50);
    };

    sample();
    const unsub = subscribeTermOutput(sessionId, schedule);
    return () => {
      unsub();
      clearTimeout(throttleTimer);
      clearTimeout(holdTimer);
    };
  }, [working, sessionId, agent]);

  const live = useMemo(() => {
    if (!session || session.status !== 'working') return null;
    return composeLiveTail({
      session,
      blocks,
      activity: activity ?? null,
      ptyExtract,
      now: Date.now(),
    });
  }, [session, blocks, activity, ptyExtract]);

  if (initializedSidRef.current !== sessionId) {
    initializedSidRef.current = sessionId;
    seenBlocksRef.current = new Set();
    freshBlocksRef.current = new Set();
    blockInitialCharsRef.current = new Map();
    lastLiveAnswerLenRef.current = 0;
    stickRef.current = true;
  }

  if (streamState && streamState.sessionId === sessionId) {
    if (seenBlocksRef.current.size === 0 && blocks.length > 0) {
      for (const b of blocks) seenBlocksRef.current.add(b.id);
    } else {
      for (const b of blocks) {
        if (!seenBlocksRef.current.has(b.id)) {
          seenBlocksRef.current.add(b.id);
          freshBlocksRef.current.add(b.id);
          if (b.kind === 'assistant' && lastLiveAnswerLenRef.current > 0) {
            blockInitialCharsRef.current.set(b.id, Math.min(b.text.length, lastLiveAnswerLenRef.current));
            lastLiveAnswerLenRef.current = 0;
          }
        }
      }
    }
  }

  // Physics-damped smooth sticky scroll: chases bottom cleanly without self-aborting on large chunks,
  // and releases immediately whenever the user actively scrolls upward.
  const kickSmoothScroll = useCallback((instant = false) => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    if (instant) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(target - el.scrollTop) >= 0.5) {
        programmaticScrollRef.current = true;
        el.scrollTop = target;
      }
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const tick = () => {
      const box = scrollRef.current;
      if (!box || !stickRef.current) {
        scrollRafRef.current = 0;
        return;
      }
      const target = Math.max(0, box.scrollHeight - box.clientHeight);
      const diff = target - box.scrollTop;
      if (diff <= 0.75) {
        if (Math.abs(target - box.scrollTop) >= 0.5) {
          programmaticScrollRef.current = true;
          box.scrollTop = target;
        }
        lastScrollTopRef.current = box.scrollTop;
        scrollRafRef.current = 0;
        return;
      }
      programmaticScrollRef.current = true;
      box.scrollTop += Math.max(1, diff * 0.24);
      lastScrollTopRef.current = box.scrollTop;
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    if (!scrollRafRef.current) {
      scrollRafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  // Re-anchor smoothly whenever the flow height grows (new blocks, smooth token reveal, code cards).
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) kickSmoothScroll(false);
    });
    ro.observe(flow);
    return () => ro.disconnect();
  }, [kickSmoothScroll]);

  // Snap instantly on first load of a session; smooth-glide on subsequent streaming updates.
  const prevSidForScrollRef = useRef<string | null>(null);
  useEffect(() => {
    const switched = prevSidForScrollRef.current !== sessionId;
    prevSidForScrollRef.current = sessionId;
    if (switched) {
      stickRef.current = true;
      setShowJump(false);
      requestAnimationFrame(() => kickSmoothScroll(true));
      return;
    }
    if (stickRef.current) kickSmoothScroll(false);
    else setShowJump(true);
  }, [sessionId, blocks.length, live?.phase, live?.answerText, live?.thinkingText, prompt?.fingerprint, kickSmoothScroll]);

  const onWheel = (e: { deltaY: number }) => {
    if (e.deltaY < 0) {
      stickRef.current = false;
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
      const el = scrollRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight > BOTTOM_EPS) setShowJump(true);
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const dist = el.scrollHeight - top - el.clientHeight;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      lastScrollTopRef.current = top;
      if (dist <= 16) setShowJump(false);
      return;
    }
    const movedUp = top < lastScrollTopRef.current - 2;
    lastScrollTopRef.current = top;
    if (movedUp && dist > BOTTOM_EPS) {
      stickRef.current = false;
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
      setShowJump(true);
    } else if (dist <= 16) {
      stickRef.current = true;
      setShowJump(false);
    } else if (!stickRef.current && dist > BOTTOM_EPS) {
      setShowJump(true);
    }
  };

  const jumpBottom = () => {
    stickRef.current = true;
    setShowJump(false);
    kickSmoothScroll(false);
  };

  // Auto-grow composer height up to ~6 lines.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  }, [input]);

  // Reset transient prompt note when session or prompt changes.
  useEffect(() => {
    setPromptNote('');
    setPromptBusy(false);
  }, [sessionId, prompt?.fingerprint]);

  const uploadImages = async (files: File[]) => {
    const imgs = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!imgs.length) return;
    setSendErr('');
    for (const f of imgs) {
      try {
        const res = await fetch('/api/attachments', { method: 'POST', headers: { 'content-type': f.type }, body: f });
        const json = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
        if (!res.ok || !json.name) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (mountedRef.current) setAttachments((prev) => [...prev, json.name!]);
      } catch (e) {
        if (mountedRef.current) setSendErr(`图片上传失败：${(e as Error).message}`);
      }
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void uploadImages(files);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      e.stopPropagation();
      void uploadImages(files);
    }
  };

  const submit = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;
    const sentText = input;
    const sentFiles = attachments;
    setSending(true);
    setSendErr('');
    setInput('');
    setAttachments([]);
    stickRef.current = true;
    setShowJump(false);
    try {
      await onSendMessage(text, sentFiles.length ? sentFiles : undefined);
      if (mountedRef.current) kickSmoothScroll(false);
    } catch (e) {
      if (mountedRef.current) {
        setInput(sentText);
        setAttachments(sentFiles);
        setSendErr((e as Error).message);
      }
    } finally {
      if (mountedRef.current) {
        setSending(false);
        composerRef.current?.focus();
      }
    }
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const handlePromptClick = async (data: string) => {
    if (!prompt || promptBusy) return;
    setPromptBusy(true);
    setPromptNote('');
    try {
      await onAnswerPrompt(prompt.fingerprint, prompt.waitSeq, data);
    } catch (e) {
      if (mountedRef.current) setPromptNote((e as Error).message);
    } finally {
      if (mountedRef.current) setPromptBusy(false);
    }
  };

  const exited = session?.status === 'exited';
  const blockModel = [...blocks]
    .reverse()
    .find((b): b is Extract<StreamBlock, { kind: 'assistant' | 'step' }> => (b.kind === 'assistant' || b.kind === 'step') && !!b.model)?.model;
  const modelLabel = activity?.model || context?.model || blockModel || task?.model || '';

  return (
    <div
      className="stream-view"
      data-testid="stream-view"
      data-session-id={sessionId ?? ''}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <div className="sv-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
        <div className="sv-flow" ref={flowRef}>
          {blocks.length === 0 && !live && (
            <div className="sv-empty" data-testid="sv-empty">
              <div className="sv-empty-title">原生 CLI 流式对话视图</div>
              <div className="sv-empty-sub">
                底层仍运行官方交互式 CLI，消息将自动结构化排版并以平滑流式呈现。随时可点右上角「终端」或按 Alt+M 切回原始终端。
              </div>
            </div>
          )}

          {blocks.map((block) => {
            const isFresh = freshBlocksRef.current.has(block.id);
            if (block.kind === 'user') {
              return (
                <div key={block.id} className={`sv-user-row ${isFresh ? 'sv-block-enter' : ''}`} data-testid="sv-user">
                  <div className="sv-user-bubble" data-private="">{block.text}</div>
                </div>
              );
            }
            if (block.kind === 'step') {
              return (
                <div key={block.id} className={isFresh ? 'sv-block-enter' : undefined}>
                  <StepBlockView block={block} privacy={privacy} animateThinking={isFresh} onInspectFile={onInspectFile} />
                </div>
              );
            }
            if (block.kind === 'assistant') {
              return (
                <div key={block.id} className="sv-assistant" data-testid="sv-assistant" data-private="">
                  <StreamMarkdown
                    content={block.text}
                    projectPath={project?.path}
                    onInspectFile={onInspectFile}
                    animateEntrance={isFresh}
                    initialRevealedChars={blockInitialCharsRef.current.get(block.id) ?? 0}
                  />
                </div>
              );
            }
            return (
              <div key={block.id} className="sv-card-note" data-testid="sv-card">
                <div className="sv-card-tag">{block.card.kind === 'handoff' ? '交接上下文' : '转发上下文'}</div>
                <div className="sv-card-body" data-private="">{block.card.body}</div>
              </div>
            );
          })}

          {live && (() => {
            const tail = blocks.at(-1);
            return (
              <LiveTailView
                live={live}
                now={now}
                hasActiveStepTail={tail?.kind === 'step' && tail.active === true}
              />
            );
          })()}
        </div>
      </div>

      <div className="sv-dock">
        {showJump && (
          <button type="button" className="sv-jump-btn" data-testid="sv-jump-bottom" onClick={jumpBottom}>
            ↓ 回到底部
          </button>
        )}

        {todos.length > 0 && <TodoChecklistCard todos={todos} />}

        {prompt && (
          <PromptBanner
            prompt={prompt}
            busy={promptBusy}
            note={promptNote}
            onAnswer={(data) => void handlePromptClick(data)}
            onOpenTerminal={onSwitchToTerminal}
          />
        )}

        {!!session?.queued && (
          <div className="sv-queued-hint" data-testid="sv-queued">
            有 {session.queued} 条消息排队中，当前回合结束后自动发送
          </div>
        )}

        {sendErr && <div className="sv-send-err">{sendErr}</div>}

        {!exited && (
          <div className="sv-composer" data-testid="sv-composer">
            {attachments.length > 0 && (
              <div className="sv-attach-list">
                {attachments.map((name, i) => (
                  <span key={`${name}-${i}`} className="sv-attach-chip">
                    <span>{name}</span>
                    <button
                      type="button"
                      aria-label="移除图片"
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="sv-composer-row">
              <textarea
                ref={composerRef}
                className="sv-textarea"
                data-testid="sv-input"
                rows={1}
                placeholder={working ? '继续补充要求（本轮结束后自动发送）…' : '在此输入消息…（Enter 发送，Shift+Enter 换行）'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKeyDown}
                onPaste={handlePaste}
              />
              <div className="sv-composer-btns">
                {working && onInterrupt && (
                  <button
                    type="button"
                    className="sv-stop-btn"
                    data-testid="sv-stop"
                    title="向原生 CLI 发送 Esc 中断当前步骤（不关闭会话）"
                    onClick={onInterrupt}
                  >
                    <span className="sv-stop-sq" aria-hidden="true" />
                    停止
                  </button>
                )}
                <button
                  type="button"
                  className="sv-send-btn"
                  data-testid="sv-send"
                  disabled={sending || (!input.trim() && attachments.length === 0)}
                  title={working ? '加入排队发送' : '发送消息 (Enter)'}
                  onClick={() => void submit()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 12.5V3.5M4 7.5L8 3.5l4 4" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="sv-composer-meta">
              <span className="sv-meta-model" data-private="">
                {modelLabel || session?.agent || task?.agent || ''}
              </span>
              <span className="sv-meta-right">
                <span className="sv-meta-badge">原生 CLI 双源视图</span>
                <button type="button" className="sv-meta-link" onClick={onSwitchToTerminal}>
                  切到终端 (Alt+M)
                </button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
