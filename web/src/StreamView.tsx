import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ClipboardEvent, DragEvent } from 'react';
import type { InteractiveKey, Project, SessionActivity, SessionContext, SessionInfo, SessionStreamState, StreamBlock, Task } from '../../shared/protocol.ts';
import { MAX_INTERACTIVE_TEXT } from '../../shared/protocol.ts';
import {
  composeLiveTail, extractPtyInteractivePrompt, extractPtyLiveFromLines, extractPtyPromptState,
  type PtyInteractivePrompt, type PtyLiveExtract, type PtyPromptState,
} from '../../shared/ptyLive.ts';
import type { DelegateView } from './DelegationHud.tsx';
import {
  clearStreamDraft, clearStreamSendId, getStreamDraft, MAX_STREAM_ATTACHMENTS, mergeStreamAttachments,
  resolveStreamSendId, setStreamDraft, subscribeStreamDrafts,
  type StreamAttachment,
} from './streamDrafts.ts';
import { useAutoResizeTextarea } from './autoResizeTextarea.ts';
import { readTermLiveSnapshot, subscribeTermOutput } from './terms.ts';
import { send } from './ws.ts';
import { AssistantMessage } from './stream/AssistantMessage.tsx';
import { CardBlock } from './stream/CardBlock.tsx';
import { DockTray } from './stream/DockTray.tsx';
import { LiveTail } from './stream/LiveTail.tsx';
import { PromptBanner } from './stream/PromptBanner.tsx';
import { QuestionCard } from './stream/QuestionCard.tsx';
import { StepBlockView, StepGroup } from './stream/StepGroup.tsx';
import { StreamComposer } from './stream/StreamComposer.tsx';
import { TermDraftBar, type TermGuard } from './stream/TermDraftBar.tsx';
import { UserBubble, type UserBlock } from './stream/UserBubble.tsx';
import { fileBase, redactLocalPaths } from './stream/format.ts';
import { clearTerminalInputAndVerify, sendTerminalDraft } from './stream/draftGuard.ts';
import {
  clearPendingInteractiveRequest, clearQuestionError, clearQuestionWriteInDraft,
  clearSessionInteractiveCache, describeInteractiveRejection, getQuestionError,
  getQuestionWriteInDraft, registerPendingInteractiveRequest, setQuestionError,
  setQuestionWriteInDraft, subscribeInteractiveInputResult, waitInteractiveInputResult,
  type InteractiveActionWait,
} from './stream/interactiveActions.ts';
import { mergeSubagents } from './stream/subagents.ts';
import { buildFlow, WINDOW_SIZE, windowFlow } from './stream/steps.ts';
import { parseUserMessage } from './stream/attachments.ts';
import type { StreamSendOpts } from './stream/types.ts';
import { useAttachmentThumbs } from './stream/useAttachmentThumbs.ts';
import { useFreshBlocks } from './stream/useFreshBlocks.ts';
import { useStickyScroll } from './stream/useStickyScroll.ts';

export type { StreamSendOpts } from './stream/types.ts';

export interface StreamViewProps {
  task?: Task;
  project?: Project;
  session?: SessionInfo;
  streamState: SessionStreamState | null;
  activity?: SessionActivity | null;
  context?: SessionContext | null;
  delegates?: DelegateView[];
  onOpenDelegate?(sessionId: string): void;
  /** @deprecated Ignored: timers live in the leaf components that need them (useTick). Kept so old callers compile. */
  now?: number;
  privacy: boolean;
  onSwitchToTerminal(): void;
  onInterrupt?(): void;
  onInspectFile?(filePath: string): void;
  onSendMessage(text: string, attachments?: string[], opts?: StreamSendOpts): Promise<void>;
  onAnswerPrompt(fingerprint: string, waitSeq: number, data: string): Promise<void>;
}

const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const EMPTY_DELEGATES: DelegateView[] = [];
const TERM_GUARD_MSG = '先发送或清空终端里的内容';
const EMPTY_CONFIRM_STABLE_MS = 350;

function newClientMsgId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Identifies the visible question state excluding cursor index (`selectedIndex`) and in-place Write-in echo
// (`writeInText`), so neither intermediate arrow-key redraws nor pasted Write-in echoes look "settled" before
// the terminal genuinely leaves the current prompt (next question, checkbox toggle, mode change, or card closed).
function questionSettleKey(q: PtyInteractivePrompt | null): string {
  if (!q) return 'none';
  return JSON.stringify([
    q.mode,
    q.progress?.current ?? 0,
    q.progress?.total ?? 0,
    q.title,
    q.subtitle ?? '',
    q.options.map((o) => [o.number ?? '', o.label, o.checked ?? null]),
    q.rawHint,
  ]);
}

// Identifies the logical question across mode switches / transient PermissionRequest unmounts.
function questionIdentityKey(q: PtyInteractivePrompt | null): string {
  if (!q) return '';
  return JSON.stringify([q.progress?.current ?? 0, q.progress?.total ?? 0, q.title]);
}

function StreamViewImpl({
  task,
  project,
  session,
  streamState,
  activity,
  context,
  delegates = EMPTY_DELEGATES,
  onOpenDelegate,
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

  const mountedRef = useRef(true);
  const [visibleLimit, setVisibleLimit] = useState(WINDOW_SIZE);
  const expandAnchorRef = useRef<{ height: number; top: number } | null>(null);

  const sessionId = session?.id ?? null;
  const [initialDraft] = useState(() => getStreamDraft(sessionId));
  const [input, setInput] = useState(initialDraft.text);
  const [attachments, setAttachments] = useState<StreamAttachment[]>(initialDraft.attachments);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [sendErrGoto, setSendErrGoto] = useState(false); // offer a 「查看终端」 shortcut next to terminal-related errors
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptNote, setPromptNote] = useState('');
  const [questionBusy, setQuestionBusy] = useState(false);
  const [questionStale, setQuestionStale] = useState(false);
  const [questionErr, setQuestionErr] = useState('');
  const [questionWriteInDraft, setQuestionWriteInDraftState] = useState('');
  const [termBusy, setTermBusy] = useState(false);
  const [termFlash, setTermFlash] = useState(false);
  // Binds 「终端是空的」 dismissal strictly to the exact terminalDraftSeq observed when clicked;
  // any newer terminal keystroke bumps terminalDraftSeq and automatically re-arms the guard.
  const [dismissedDraftSeq, setDismissedDraftSeq] = useState<number | null>(null);
  const [focusSubagentTick, setFocusSubagentTick] = useState(0);

  const flashTimerRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const questionBusyRef = useRef(false);
  const questionWaitRef = useRef<InteractiveActionWait | null>(null);
  const questionSettleRef = useRef<{
    beforeKey: string;
    beforeIdentityKey: string;
    clearWriteInKey?: string;
    timer: number;
  } | null>(null);
  const inputRef = useRef(input);
  const attachmentsRef = useRef(attachments);
  // Latest-value refs are refreshed after commit (never written during render).
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId;
    inputRef.current = input;
    attachmentsRef.current = attachments;
  }, [sessionId, input, attachments]);
  const thumbs = useAttachmentThumbs(attachments);

  const setError = useCallback((msg: string, offerTerminal = false) => {
    setSendErr(msg);
    setSendErrGoto(offerTerminal && !!msg);
  }, []);

  // Persist per-session Chat composer draft across 终端 <-> 对话 toggles and task switches.
  useEffect(() => {
    setStreamDraft(sessionId, { text: input, attachments });
  }, [sessionId, input, attachments]);

  // Keep mounted composer synchronized if an async upload / pull / failed-send recovery finishes across remounts.
  useEffect(() => {
    if (!sessionId) return;
    return subscribeStreamDrafts(() => {
      if (!mountedRef.current) return;
      const latest = getStreamDraft(sessionId);
      if (latest.text !== inputRef.current) setInput(latest.text);
      const curAtts = attachmentsRef.current;
      const sameAtts =
        latest.attachments.length === curAtts.length &&
        latest.attachments.every(
          (a, i) => a.kind === curAtts[i].kind && a.value === curAtts[i].value && a.label === curAtts[i].label,
        );
      if (!sameAtts) setAttachments(latest.attachments);
    });
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = 0;
      questionWaitRef.current?.cancel();
      questionWaitRef.current = null;
      if (questionSettleRef.current) {
        window.clearTimeout(questionSettleRef.current.timer);
        questionSettleRef.current = null;
      }
      questionBusyRef.current = false;
    };
  }, []);

  const blocks = streamState?.blocks ?? [];
  const todos = streamState?.todos ?? [];
  const prompt = streamState?.prompt ?? null;
  const working = session?.status === 'working';
  const exited = session?.status === 'exited';
  const agent = session?.agent ?? task?.agent ?? 'fake';

  // Live snapshot observer over the uncorrupted browser xterm.js viewport:
  // - While working: extracts live streaming thinking/answer/subagent bars with 220ms transient-blank hold.
  // - At all times (non-exited): extracts the active CLI terminal input draft and interactive question pickers.
  const [ptyExtract, setPtyExtract] = useState<PtyLiveExtract | null>(null);
  const [ptyPrompt, setPtyPrompt] = useState<PtyPromptState>(() => {
    if (!sessionId) return { found: false, draft: null };
    const snap = readTermLiveSnapshot(sessionId);
    return snap ? extractPtyPromptState(agent, snap.lines, snap.isAlternate) : { found: false, draft: null };
  });
  const [ptyQuestion, setPtyQuestion] = useState<PtyInteractivePrompt | null>(() => {
    if (!sessionId) return null;
    const snap = readTermLiveSnapshot(sessionId);
    return snap ? extractPtyInteractivePrompt(agent, snap.lines, snap.isAlternate) : null;
  });
  const lastLiveAnswerLenRef = useRef(0);
  const liveExtRef = useRef<PtyLiveExtract | null>(null); // newest raw sample, read by the 220ms hold timer
  const lastUserPrompt = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'user' && !b.pending) return b.text;
    }
    return undefined;
  }, [blocks]);
  const lastUserRef = useRef(lastUserPrompt);
  useLayoutEffect(() => {
    lastUserRef.current = lastUserPrompt;
  }, [lastUserPrompt]);

  const fresh = useFreshBlocks(sessionId, streamState, blocks, lastLiveAnswerLenRef);

  const fallbackDismissed =
    dismissedDraftSeq !== null &&
    session?.terminalDraftSeq !== undefined &&
    dismissedDraftSeq === session.terminalDraftSeq;

  useEffect(() => {
    if (!sessionId || exited) {
      setPtyExtract(null);
      setPtyPrompt({ found: false, draft: null });
      setPtyQuestion(null);
      liveExtRef.current = null;
      return;
    }
    if (!working) setPtyExtract(null);
    let throttleTimer: number | undefined;
    let holdTimer: number | undefined;
    let lastValid: PtyLiveExtract | null = null;

    const sameExtract = (a: PtyLiveExtract | null, b: PtyLiveExtract | null): boolean =>
      a?.answerText === b?.answerText &&
      a?.thinkingText === b?.thinkingText &&
      a?.spinnerText === b?.spinnerText &&
      JSON.stringify(a?.subagents ?? null) === JSON.stringify(b?.subagents ?? null);

    const sample = () => {
      throttleTimer = undefined;
      const snap = readTermLiveSnapshot(sessionId);
      if (!snap) return;

      const nextPrompt = extractPtyPromptState(agent, snap.lines, snap.isAlternate);
      setPtyPrompt((prev) =>
        prev.found === nextPrompt.found &&
        prev.draft?.text === nextPrompt.draft?.text &&
        prev.draft?.multiline === nextPrompt.draft?.multiline &&
        prev.draft?.hasOpaqueToken === nextPrompt.draft?.hasOpaqueToken
          ? prev
          : nextPrompt,
      );

      const nextInteractive = extractPtyInteractivePrompt(agent, snap.lines, snap.isAlternate);
      setPtyQuestion((prev) => (prev?.fingerprint === nextInteractive?.fingerprint ? prev : nextInteractive));

      if (!working) return;
      const ext = extractPtyLiveFromLines(agent, snap.lines, lastUserRef.current, snap.isAlternate);
      liveExtRef.current = ext;
      const hasText = !!(ext.answerText || ext.thinkingText);

      if (hasText) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
        lastValid = ext;
        if (ext.answerText) lastLiveAnswerLenRef.current = ext.answerText.length;
        setPtyExtract((prev) => (sameExtract(prev, ext) ? prev : ext));
      } else if (lastValid) {
        if (!holdTimer) {
          holdTimer = window.setTimeout(() => {
            holdTimer = undefined;
            // Decide from the NEWEST sample, not the one captured when the timer was armed: a later sample may have
            // brought text back, and an older closure must never rewind it.
            const latest = liveExtRef.current;
            if (latest && (latest.answerText || latest.thinkingText)) {
              lastValid = latest;
              setPtyExtract((prev) => (sameExtract(prev, latest) ? prev : latest));
              return;
            }
            lastValid = null;
            const settled = latest && (latest.spinnerText || latest.subagents?.length)
              ? {
                  ...(latest.spinnerText ? { spinnerText: latest.spinnerText } : {}),
                  ...(latest.subagents?.length ? { subagents: latest.subagents } : {}),
                }
              : null;
            setPtyExtract((prev) => (sameExtract(prev, settled) ? prev : settled));
          }, 220);
        } else if (ext.subagents?.length) {
          setPtyExtract((prev) => {
            const next = prev ? { ...prev, subagents: ext.subagents } : { subagents: ext.subagents };
            return sameExtract(prev, next) ? prev : next;
          });
        }
      } else {
        const next = ext.spinnerText || ext.subagents?.length ? ext : null;
        setPtyExtract((prev) => (sameExtract(prev, next) ? prev : next));
      }
    };

    const schedule = () => {
      if (throttleTimer !== undefined) return;
      throttleTimer = window.setTimeout(sample, working ? 50 : 80);
    };

    sample();
    const unsub = subscribeTermOutput(sessionId, schedule);
    return () => {
      unsub();
      clearTimeout(throttleTimer);
      clearTimeout(holdTimer);
    };
  }, [working, exited, sessionId, agent, session?.blocked, session?.hasTerminalDraft]);

  const activeQuestion = !exited && !prompt && !session?.blocked ? ptyQuestion : null;
  const hiddenByBlock = (!!prompt || !!session?.blocked) && activeQuestion === null;
  const activeQuestionSettleKey = useMemo(() => questionSettleKey(activeQuestion), [activeQuestion]);
  const activeQuestionIdentityKey = useMemo(() => questionIdentityKey(activeQuestion), [activeQuestion]);
  const activeQuestionSettleKeyRef = useRef(activeQuestionSettleKey);
  const activeQuestionIdentityKeyRef = useRef(activeQuestionIdentityKey);
  const activeQuestionModeRef = useRef<PtyInteractivePrompt['mode'] | null>(activeQuestion?.mode ?? null);
  const hiddenByBlockRef = useRef(hiddenByBlock);
  const lastQuestionIdentityRef = useRef('');
  useLayoutEffect(() => {
    activeQuestionSettleKeyRef.current = activeQuestionSettleKey;
    activeQuestionIdentityKeyRef.current = activeQuestionIdentityKey;
    activeQuestionModeRef.current = activeQuestion?.mode ?? null;
    hiddenByBlockRef.current = hiddenByBlock;
  }, [activeQuestionSettleKey, activeQuestionIdentityKey, activeQuestion?.mode, hiddenByBlock]);

  const mergedSubagents = useMemo(
    () => mergeSubagents(streamState?.subagents, ptyExtract?.subagents, working),
    [streamState?.subagents, ptyExtract?.subagents, working],
  );
  const runningSubagentIds = useMemo(
    () => new Set(mergedSubagents.filter((s) => s.status === 'running').map((s) => s.id)),
    [mergedSubagents],
  );
  const runningSubagentCount = useMemo(() => {
    const internalRunning = mergedSubagents.filter((s) => s.status === 'running').length;
    const delegRunning = delegates.filter((d) => d.state === 'working' || d.state === 'rework').length;
    return internalRunning + delegRunning;
  }, [mergedSubagents, delegates]);

  const live = useMemo(() => {
    if (!session || session.status !== 'working') return null;
    return composeLiveTail({
      session,
      blocks,
      activity: activity ?? null,
      ptyExtract,
      subagents: mergedSubagents,
      now: Date.now(),
    });
  }, [session, blocks, activity, ptyExtract, mergedSubagents]);

  // Unified terminal-draft collision guard:
  // - If xterm sees a non-empty CLI prompt box -> show exact preview & lock send.
  // - If xterm sees a definitely empty prompt box -> no false alarm even if server hasDraft was stale after Backspace.
  // - If xterm prompt box is obscured/unreadable AND server recorded uncommitted typing -> show safe fallback guard.
  const termGuard = useMemo<TermGuard | null>(() => {
    if (exited || session?.blocked || activeQuestion) return null;
    // While working, a visible `> ...` line at the bottom can be the already-submitted prompt unless the server
    // recorded fresh uncommitted terminal typing (`hasTerminalDraft === true`).
    if (working && !session?.hasTerminalDraft) return null;
    if (ptyPrompt.found) {
      return ptyPrompt.draft ? { mode: 'draft', draft: ptyPrompt.draft } : null;
    }
    if (session?.hasTerminalDraft && !fallbackDismissed) {
      return { mode: 'unreadable' };
    }
    return null;
  }, [exited, working, session?.blocked, session?.hasTerminalDraft, ptyPrompt, fallbackDismissed, activeQuestion]);

  useEffect(() => {
    if (!termGuard && sendErr === TERM_GUARD_MSG) setError('');
  }, [termGuard, sendErr, setError]);

  // Desktop xterm shows an EMPTY prompt while the server still holds a stale draft lock (e.g. Backspace emptied it):
  // once that has been stable for a moment, tell the server so mobile / queued sends are released. Bound to the seq.
  const confirmedEmptySeqRef = useRef<number | null>(null);
  const emptyPromptSeen = ptyPrompt.found && !ptyPrompt.draft;
  const serverDraftSeq = session?.terminalDraftSeq;
  const serverHasDraft = !!session?.hasTerminalDraft;
  useEffect(() => {
    if (!sessionId || exited || !emptyPromptSeen || !serverHasDraft || serverDraftSeq === undefined) return;
    if (confirmedEmptySeqRef.current === serverDraftSeq) return;
    const seq = serverDraftSeq;
    const timer = window.setTimeout(() => {
      confirmedEmptySeqRef.current = seq;
      send({ t: 'confirm-empty-draft', id: sessionId, draftSeq: seq });
    }, EMPTY_CONFIRM_STABLE_MS);
    return () => window.clearTimeout(timer);
  }, [sessionId, exited, emptyPromptSeen, serverHasDraft, serverDraftSeq]);

  const flashTermGuard = useCallback(() => {
    window.clearTimeout(flashTimerRef.current);
    setTermFlash(false);
    requestAnimationFrame(() => {
      if (mountedRef.current) setTermFlash(true);
    });
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = 0;
      if (mountedRef.current) setTermFlash(false);
    }, 650);
  }, []);

  const lastAssistant = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'assistant') return { id: b.id, len: b.text.length };
    }
    return { id: null as string | null, len: 0 };
  }, [blocks]);
  const lastAssistantId = lastAssistant.id;
  const tailBlock = blocks.at(-1);
  const tailContentLen = !tailBlock
    ? 0
    : tailBlock.kind === 'step'
      ? (tailBlock.thinking?.length ?? 0) + tailBlock.tools.length * 32 + (tailBlock.active ? 1 : 0)
      : tailBlock.kind === 'card'
        ? tailBlock.card.body.length
        : tailBlock.text.length;
  const contentKey = `${blocks.length}:${tailBlock?.id ?? ''}:${tailContentLen}:${live?.phase ?? ''}:${live?.answerText?.length ?? 0}:${live?.thinkingText?.length ?? 0}:${prompt?.fingerprint ?? ''}:${activeQuestion?.fingerprint ?? ''}`;
  const replySignal = useMemo(
    () => ({
      blockCount: blocks.length,
      lastAssistantId: lastAssistant.id,
      lastAssistantLen: lastAssistant.len,
      liveAnswerLen: live?.answerText?.length ?? 0,
    }),
    [blocks.length, lastAssistant.id, lastAssistant.len, live?.answerText?.length],
  );

  const scroll = useStickyScroll({
    scrollRef,
    flowRef,
    sessionId,
    hasContent: blocks.length > 0 || !!live,
    contentKey,
    replySignal,
  });

  // Keep the reading position when 「展开更早的记录」 prepends content above the viewport.
  useLayoutEffect(() => {
    const anchor = expandAnchorRef.current;
    const el = scrollRef.current;
    expandAnchorRef.current = null;
    if (!anchor || !el) return;
    scroll.setProgrammaticScrollTop(anchor.top + (el.scrollHeight - anchor.height));
  }, [visibleLimit, scroll.setProgrammaticScrollTop]);

  const expandEarlier = () => {
    const el = scrollRef.current;
    if (el && !scroll.isSticking()) expandAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisibleLimit((n) => n + WINDOW_SIZE);
  };

  // Auto-grow composer height up to ~6 lines without transiently collapsing `.sv-dock` (which would
  // clamp `.sv-scroll.scrollTop` and cause the message list to jump up/down on every keystroke).
  useAutoResizeTextarea(composerRef, input, { fallbackMaxHeightPx: 156, mounted: !exited });

  // Reset transient prompt note when session or prompt changes.
  useEffect(() => {
    setPromptNote('');
    setPromptBusy(false);
  }, [sessionId, prompt?.fingerprint]);

  const releaseQuestionLock = useCallback(() => {
    questionWaitRef.current?.cancel();
    questionWaitRef.current = null;
    if (questionSettleRef.current) {
      window.clearTimeout(questionSettleRef.current.timer);
      questionSettleRef.current = null;
    }
    questionBusyRef.current = false;
    if (mountedRef.current) {
      setQuestionBusy(false);
      setQuestionStale(false);
    }
  }, []);

  // Reset local interactive lock when switching sessions (draft & error caches stay persisted per sessionId).
  useEffect(() => {
    releaseQuestionLock();
    lastQuestionIdentityRef.current = '';
    setQuestionWriteInDraftState(getQuestionWriteInDraft(sessionId, activeQuestionIdentityKeyRef.current));
    setQuestionErr(getQuestionError(sessionId, activeQuestionIdentityKeyRef.current));
  }, [sessionId, releaseQuestionLock]);

  // Clear cached Write-in draft & errors once the session exits.
  useEffect(() => {
    if (!exited) return;
    clearSessionInteractiveCache(sessionId);
    setQuestionWriteInDraftState('');
    setQuestionErr('');
  }, [exited, sessionId]);

  // Hydrate Write-in draft & persisted error when mounting or returning to the same question (including across
  // transient PermissionRequest unmounts or full StreamView Terminal <-> Dialog toggles).
  useEffect(() => {
    if (!activeQuestionIdentityKey) return;
    if (lastQuestionIdentityRef.current && lastQuestionIdentityRef.current !== activeQuestionIdentityKey) {
      clearQuestionError(sessionId, lastQuestionIdentityRef.current);
    }
    lastQuestionIdentityRef.current = activeQuestionIdentityKey;
    setQuestionWriteInDraftState(getQuestionWriteInDraft(sessionId, activeQuestionIdentityKey));
    setQuestionErr(getQuestionError(sessionId, activeQuestionIdentityKey));
  }, [sessionId, activeQuestionIdentityKey]);

  // Surface late server rejections immediately even if the user switched Terminal -> Dialog while a request was in flight.
  useEffect(() => {
    if (!sessionId) return;
    return subscribeInteractiveInputResult((msg) => {
      if (msg.id !== sessionId || msg.ok || !mountedRef.current) return;
      const persisted = getQuestionError(sessionId, activeQuestionIdentityKeyRef.current);
      if (persisted) setQuestionErr(persisted);
    });
  }, [sessionId]);

  // Release the post-ack settle lock ONLY once xterm visibly advances past the previous question/checkbox/write-in
  // state AND is NOT obscured by `prompt` or `session.blocked`. Never auto-unlocks a stale card!
  useEffect(() => {
    const pendingSettle = questionSettleRef.current;
    if (!pendingSettle || hiddenByBlock || activeQuestionSettleKey === pendingSettle.beforeKey) return;
    const leftWriteIn =
      !pendingSettle.clearWriteInKey ||
      activeQuestion?.mode !== 'write-in' ||
      activeQuestionIdentityKey !== pendingSettle.clearWriteInKey;
    if (!leftWriteIn) return;
    window.clearTimeout(pendingSettle.timer);
    questionSettleRef.current = null;
    if (pendingSettle.clearWriteInKey) {
      clearQuestionWriteInDraft(sessionId, pendingSettle.clearWriteInKey);
      if (activeQuestionIdentityKeyRef.current === pendingSettle.clearWriteInKey || !activeQuestionIdentityKeyRef.current) {
        setQuestionWriteInDraftState('');
      }
    }
    clearQuestionError(sessionId, pendingSettle.beforeIdentityKey);
    questionBusyRef.current = false;
    setQuestionBusy(false);
    setQuestionStale(false);
    setQuestionErr('');
  }, [sessionId, hiddenByBlock, activeQuestion?.mode, activeQuestionIdentityKey, activeQuestionSettleKey]);

  const appendAttachments = (targetSid: string | null, incoming: StreamAttachment[]): boolean => {
    if (!incoming.length) return false;
    if (mountedRef.current && targetSid === sessionId) {
      const before = attachmentsRef.current;
      const merged = mergeStreamAttachments(before, incoming);
      const uniqueIncoming = new Set(incoming.map((a) => `${a.kind}:${a.value}`)).size;
      const truncated = before.length + uniqueIncoming > MAX_STREAM_ATTACHMENTS && merged.length >= MAX_STREAM_ATTACHMENTS;
      setAttachments(merged);
      setStreamDraft(targetSid, { text: inputRef.current, attachments: merged });
      return truncated;
    }
    const cur = getStreamDraft(targetSid);
    const merged = mergeStreamAttachments(cur.attachments, incoming);
    setStreamDraft(targetSid, { text: cur.text, attachments: merged });
    return false;
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    const targetSid = sessionId;
    setError('');
    if (mountedRef.current) setUploadingCount((n) => n + files.length);
    const errors: string[] = [];
    for (const f of files) {
      try {
        if (f.size === 0) {
          errors.push(`空文件已跳过：${f.name || '未命名文件'}`);
          continue;
        }
        const isWebImage = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
        if (isWebImage) {
          if (f.size > MAX_IMAGE_UPLOAD_BYTES) {
            errors.push(`图片过大（上限 20 MB）：${f.name}；请改用 Ctrl+C / Ctrl+V 粘贴本地路径`);
            continue;
          }
          const res = await fetch('/api/attachments', { method: 'POST', headers: { 'content-type': f.type }, body: f });
          const json = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
          if (!res.ok || !json.name) throw new Error(json.error ?? `HTTP ${res.status}`);
          if (mountedRef.current && targetSid === sessionId) thumbs.register({ kind: 'uploaded', value: json.name }, f);
          appendAttachments(targetSid, [{ kind: 'uploaded', value: json.name, label: f.name || json.name, size: f.size }]);
        } else {
          if (f.size > MAX_FILE_UPLOAD_BYTES) {
            errors.push(`文件过大（上限 100 MB）：${f.name}；大文件请直接在资源管理器 Ctrl+C 复制后在此 Ctrl+V 粘贴（不限大小）`);
            continue;
          }
          const res = await fetch('/api/attachments/file', {
            method: 'POST',
            headers: {
              'content-type': f.type || 'application/octet-stream',
              'x-file-name': encodeURIComponent(f.name || 'file'),
            },
            body: f,
          });
          const json = (await res.json().catch(() => ({}))) as { name?: string; originalName?: string; size?: number; error?: string };
          if (!res.ok || !json.name) throw new Error(json.error ?? `HTTP ${res.status}`);
          appendAttachments(targetSid, [
            { kind: 'uploaded', value: json.name, label: json.originalName || f.name || json.name, size: json.size ?? f.size },
          ]);
        }
      } catch (e) {
        errors.push(`添加附件失败（${f.name || '文件'}）：${(e as Error).message}`);
      } finally {
        if (mountedRef.current) setUploadingCount((n) => Math.max(0, n - 1));
      }
    }
    if (errors.length && mountedRef.current) {
      setError(errors[0]);
    }
  };

  const pasteNonText = async (clipFiles: File[]) => {
    const targetSid = sessionId;
    setError('');
    if (mountedRef.current) setUploadingCount((n) => n + 1);
    let clipErr = '';
    try {
      // 1. Prefer native OS clipboard file drop list (Explorer/Finder/Inspector Ctrl+C):
      //    works for .md, videos of any size, audio, docs, archives, images, folders with zero upload overhead!
      try {
        const res = await fetch('/api/clipboard/files');
        const json = (await res.json().catch(() => ({}))) as { paths?: string[]; error?: string };
        if (res.ok && Array.isArray(json.paths) && json.paths.length > 0) {
          const items: StreamAttachment[] = json.paths.map((p) => ({
            kind: 'local',
            value: p,
            label: fileBase(p) || p,
          }));
          const truncated = appendAttachments(targetSid, items);
          if (mountedRef.current && truncated) {
            setError(`最多附带 ${MAX_STREAM_ATTACHMENTS} 个附件`);
          }
          return;
        }
        if (!res.ok && json.error) clipErr = json.error;
      } catch (e) {
        clipErr = (e as Error).message;
      }

      // 2. Fallback to browser clipboardData.files (screenshots from Win+Shift+S / QQ / browser "Copy Image", or sandboxed files).
      if (clipFiles.length > 0) {
        await uploadFiles(clipFiles);
        return;
      }

      // 3. Final desktop fallback: read raw bitmap image directly from OS clipboard when Chrome omits image bytes.
      try {
        const res = await fetch('/api/clipboard/image', { method: 'POST' });
        const json = (await res.json().catch(() => ({}))) as { name?: string | null; error?: string };
        if (res.ok && json.name) {
          appendAttachments(targetSid, [{ kind: 'uploaded', value: json.name, label: json.name }]);
          return;
        }
        if (!res.ok && json.error && !clipErr) clipErr = json.error;
      } catch (e) {
        if (!clipErr) clipErr = (e as Error).message;
      }

      if (clipErr && mountedRef.current) {
        setError(`读取剪贴板失败：${clipErr}`);
      }
    } finally {
      if (mountedRef.current) setUploadingCount((n) => Math.max(0, n - 1));
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Plain text (including spreadsheet cells carrying both text + image) always pastes natively as text.
    if (e.clipboardData?.getData('text/plain')) return;
    // Snapshot clipboardData.files synchronously before awaiting; Chromium clears DataTransfer after the event returns.
    const clipFiles = [...(e.clipboardData?.files ?? [])];
    e.preventDefault();
    void pasteNonText(clipFiles);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      void uploadFiles(files);
    }
  };

  // 发送终端草稿: an atomic server action bound to the observed draftSeq. Never a blind Enter into the PTY.
  const handleTermSend = async () => {
    if (!sessionId || termBusy || working || session?.blocked) return;
    setTermBusy(true);
    setError('');
    scroll.stickToBottom(false);
    try {
      const out = await sendTerminalDraft(sessionId, session?.terminalDraftSeq);
      if (!mountedRef.current) return;
      if (!out.ok) {
        setError(out.message, true);
        return;
      }
      scroll.stickToBottom(false);
    } finally {
      if (mountedRef.current) setTermBusy(false);
    }
  };

  const handleTermClear = async () => {
    if (!sessionId || termBusy) return;
    setTermBusy(true);
    setError('');
    try {
      const out = await clearTerminalInputAndVerify(
        sessionId,
        agent,
        termGuard?.mode === 'draft' ? termGuard.draft : null,
        session?.terminalDraftSeq,
        !!session?.hasTerminalDraft,
      );
      if (!mountedRef.current) return;
      if (out.ok) {
        setPtyPrompt({ found: true, draft: null });
        composerRef.current?.focus();
      } else {
        setError(out.message, true);
      }
    } finally {
      if (mountedRef.current) setTermBusy(false);
    }
  };

  const handleTermPull = async () => {
    if (!sessionId || termBusy || termGuard?.mode !== 'draft') return;
    if (termGuard.draft.hasOpaqueToken || input.trim()) return;
    const pulled = termGuard.draft.text;
    const targetSid = sessionId;
    setTermBusy(true);
    setError('');
    try {
      const out = await clearTerminalInputAndVerify(targetSid, agent, termGuard.draft, session?.terminalDraftSeq, !!session?.hasTerminalDraft);
      // Merge & persist unconditionally before checking mountedRef so toggling Alt+M or typing across remounts
      // never drops either the pulled terminal text or newer Chat edits!
      if (out.ok) {
        const cur = getStreamDraft(targetSid);
        const nextText = cur.text.trim() ? `${pulled}\n${cur.text}` : pulled;
        setStreamDraft(targetSid, { text: nextText, attachments: cur.attachments });
        if (mountedRef.current) {
          setPtyPrompt({ found: true, draft: null });
          setInput(nextText);
          requestAnimationFrame(() => composerRef.current?.focus());
        }
      } else if (mountedRef.current) {
        setError(out.message, true);
      }
    } finally {
      if (mountedRef.current) setTermBusy(false);
    }
  };

  const submit = async () => {
    // Re-sample the live xterm buffer synchronously right before sending so stale cached state can never slip past.
    let livePrompt = ptyPrompt;
    if (sessionId && !exited && !session?.blocked) {
      const snap = readTermLiveSnapshot(sessionId);
      if (snap) {
        livePrompt = extractPtyPromptState(agent, snap.lines, snap.isAlternate);
        if (
          livePrompt.found !== ptyPrompt.found ||
          livePrompt.draft?.text !== ptyPrompt.draft?.text ||
          livePrompt.draft?.multiline !== ptyPrompt.draft?.multiline ||
          livePrompt.draft?.hasOpaqueToken !== ptyPrompt.draft?.hasOpaqueToken
        ) {
          setPtyPrompt(livePrompt);
        }
      }
    }
    const blockedByLiveDraft = !exited && !session?.blocked && !(working && !session?.hasTerminalDraft) && (
      (livePrompt.found && !!livePrompt.draft) ||
      (!livePrompt.found && !!session?.hasTerminalDraft && !fallbackDismissed)
    );
    if (blockedByLiveDraft) {
      setError(TERM_GUARD_MSG, true);
      flashTermGuard();
      return;
    }
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending || uploadingCount > 0) return;
    const sentText = input;
    const sentFiles = attachments;
    const targetSid = sessionId;
    const uploadedNames = sentFiles.filter((a) => a.kind === 'uploaded').map((a) => a.value);
    const localPaths = sentFiles.filter((a) => a.kind === 'local').map((a) => a.value);
    // Default to server-side `'guard'`. Pass `'ignore'` + exact `draftSeq` ONLY when server flagged a draft AND
    // either live xterm proved empty (e.g. Backspace) or user explicitly dismissed this exact `terminalDraftSeq`.
    const observedDraftSeq = session?.terminalDraftSeq;
    const shouldIgnoreStaleServerDraft = Boolean(
      session?.hasTerminalDraft &&
        observedDraftSeq !== undefined &&
        ((livePrompt.found && !livePrompt.draft) || dismissedDraftSeq === observedDraftSeq),
    );
    // Clear persistent draft BEFORE awaiting so remounting mid-request never resurrects already-submitted text
    // for double-send, and a slow success never wipes a newer draft typed after remount!
    clearStreamDraft(targetSid);
    setSending(true);
    setError('');
    setInput('');
    setAttachments([]);
    scroll.stickToBottom(false);
    const sendKey = JSON.stringify([targetSid, text, uploadedNames, localPaths]);
    const clientMsgId = resolveStreamSendId(targetSid, sendKey, newClientMsgId);
    try {
      await onSendMessage(text, uploadedNames.length ? uploadedNames : undefined, {
        draftAction: shouldIgnoreStaleServerDraft ? 'ignore' : 'guard',
        ...(shouldIgnoreStaleServerDraft ? { draftSeq: observedDraftSeq } : {}),
        ...(localPaths.length ? { filePaths: localPaths } : {}),
        ...(targetSid ? { expectedSessionId: targetSid } : {}),
        clientMsgId,
      });
      clearStreamSendId(targetSid, clientMsgId);
      if (mountedRef.current) scroll.stickToBottom(false);
    } catch (e) {
      // Restore/merge failed draft unconditionally even if component unmounted or remounted while in flight.
      const cur = getStreamDraft(targetSid);
      const nextText = cur.text ? `${sentText}\n${cur.text}` : sentText;
      const nextAtts = mergeStreamAttachments(sentFiles, cur.attachments);
      setStreamDraft(targetSid, { text: nextText, attachments: nextAtts });
      if (mountedRef.current) {
        setInput(nextText);
        setAttachments(nextAtts);
        setError((e as Error).message);
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

  const handleQuestionWriteInChange = useCallback((text: string) => {
    setQuestionWriteInDraftState(text);
    setQuestionWriteInDraft(sessionId, activeQuestionIdentityKeyRef.current, text);
  }, [sessionId]);

  const handleQuestionUnlock = useCallback(() => {
    if (questionSettleRef.current) {
      window.clearTimeout(questionSettleRef.current.timer);
      questionSettleRef.current = null;
    }
    clearQuestionError(sessionId, activeQuestionIdentityKeyRef.current);
    questionBusyRef.current = false;
    setQuestionBusy(false);
    setQuestionStale(false);
    setQuestionErr('');
  }, [sessionId]);

  const dispatchInteractiveInput = useCallback(async (payload: {
    keys?: InteractiveKey[];
    text?: string;
    submit?: boolean;
  }): Promise<boolean> => {
    if (!sessionId || questionBusyRef.current) return false;
    const beforeKey = activeQuestionSettleKeyRef.current;
    const beforeIdentityKey = activeQuestionIdentityKeyRef.current;
    if (payload.text !== undefined && payload.text.length > MAX_INTERACTIVE_TEXT) {
      const msg = describeInteractiveRejection('too-large');
      setQuestionError(sessionId, beforeIdentityKey, msg);
      setQuestionErr(msg);
      return false;
    }
    const reqId = newClientMsgId();
    // Write-in paste waits for server enterReady() (up to 12s cap on large Windows Codex pastes).
    const expectedMs =
      (payload.keys?.length ?? 0) * 40 +
      (payload.text ? 13_000 : 0) +
      (payload.submit ? 100 : 0) +
      3500;
    questionBusyRef.current = true;
    setQuestionBusy(true);
    setQuestionStale(false);
    clearQuestionError(sessionId, beforeIdentityKey);
    setQuestionErr('');

    registerPendingInteractiveRequest(reqId, sessionId, beforeIdentityKey, expectedMs);
    const wait = waitInteractiveInputResult(sessionId, reqId, expectedMs);
    questionWaitRef.current = wait;
    const sent = send({ t: 'interactive-input', id: sessionId, reqId, ...payload });
    if (!sent) {
      clearPendingInteractiveRequest(reqId);
      wait.cancel();
      if (questionWaitRef.current === wait) questionWaitRef.current = null;
      questionBusyRef.current = false;
      if (mountedRef.current) {
        const msg = describeInteractiveRejection('disconnected');
        setQuestionError(sessionId, beforeIdentityKey, msg);
        setQuestionBusy(false);
        setQuestionErr(msg);
      }
      return false;
    }

    const res = await wait.promise;
    if (questionWaitRef.current === wait) questionWaitRef.current = null;
    if (!mountedRef.current || sessionIdRef.current !== sessionId) return false;

    if (!res) {
      clearPendingInteractiveRequest(reqId);
      const msg = describeInteractiveRejection('timeout');
      setQuestionError(sessionId, beforeIdentityKey, msg);
      questionBusyRef.current = false;
      setQuestionBusy(false);
      setQuestionErr(msg);
      return false;
    }
    if (!res.ok) {
      const msg = describeInteractiveRejection(res.reason);
      setQuestionError(sessionId, beforeIdentityKey, msg);
      questionBusyRef.current = false;
      setQuestionBusy(false);
      setQuestionErr(msg);
      return false;
    }

    // Server finished writing every step. Only clear Write-in draft and unlock once xterm visibly leaves
    // `beforeKey` while NOT hidden by `prompt`/`session.blocked` (ignoring in-place Write-in text echo!).
    const clearWriteInKey = payload.text ? beforeIdentityKey : undefined;
    const leftWriteIn =
      !clearWriteInKey ||
      activeQuestionModeRef.current !== 'write-in' ||
      activeQuestionIdentityKeyRef.current !== clearWriteInKey;
    if (!hiddenByBlockRef.current && activeQuestionSettleKeyRef.current !== beforeKey && leftWriteIn) {
      if (clearWriteInKey) {
        clearQuestionWriteInDraft(sessionId, clearWriteInKey);
        setQuestionWriteInDraftState('');
      }
      clearQuestionError(sessionId, beforeIdentityKey);
      questionBusyRef.current = false;
      setQuestionBusy(false);
      setQuestionStale(false);
    } else {
      const timer = window.setTimeout(() => {
        if (!mountedRef.current || questionSettleRef.current?.timer !== timer) return;
        // Keep buttons disabled instead of silently auto-unlocking; persist alert across unmount too.
        const msg = payload.text
          ? '已发送提交，但终端界面尚未刷新；原内容已保留，请确认终端状态后再试或切到终端处理'
          : '已发送操作，但终端界面尚未刷新；请确认终端状态后再试或切到终端处理';
        setQuestionError(sessionId, beforeIdentityKey, msg);
        setQuestionStale(true);
        setQuestionErr(msg);
      }, 1500);
      questionSettleRef.current = { beforeKey, beforeIdentityKey, clearWriteInKey, timer };
    }
    return true;
  }, [sessionId]);

  const handleQuestionKeys = useCallback((keys: InteractiveKey[]) => {
    if (!keys.length) return;
    void dispatchInteractiveInput({ keys });
  }, [dispatchInteractiveInput]);

  const handleQuestionText = useCallback((text: string): Promise<boolean> => {
    if (!text.trim()) return Promise.resolve(false);
    return dispatchInteractiveInput({ text, submit: true });
  }, [dispatchInteractiveInput]);

  // Stable per-bubble callbacks (UserBubble is memoized).
  const reuseText = useCallback((text: string) => {
    setInput((cur) => (cur.trim() ? `${cur}\n${text}` : text));
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);
  const cancelPending = useCallback((pendingId: string) => {
    if (sessionId) send({ t: 'cancel-pending-input', id: sessionId, pendingId });
  }, [sessionId]);
  const retryPending = useCallback((block: UserBlock) => {
    // Prefer atomic server-side lossless retry: re-enqueues the exact untruncated original text + all attachment
    // paths and clears the failed/uncertain entry ONLY after enqueue succeeds.
    if (sessionId && block.pendingId) {
      send({ t: 'retry-pending-input', id: sessionId, pendingId: block.pendingId });
      return;
    }
    const { body, files } = parseUserMessage(block.text);
    if (body) reuseText(body);
    if (files.length > 0) {
      setAttachments((prev) => mergeStreamAttachments(
        prev,
        files.map((f) => ({ kind: 'local' as const, value: f.path, label: f.name })),
      ));
    }
  }, [sessionId, reuseText]);
  const focusSubagents = useCallback(() => setFocusSubagentTick((t) => t + 1), []);
  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const blockModel = [...blocks]
    .reverse()
    .find((b): b is Extract<StreamBlock, { kind: 'assistant' | 'step' }> => (b.kind === 'assistant' || b.kind === 'step') && !!b.model)?.model;
  const modelLabel = activity?.model || context?.model || blockModel || task?.model || '';
  const hasDraftBlock = termGuard !== null;
  const canPullTermDraft = termGuard?.mode === 'draft' && !termGuard.draft.hasOpaqueToken && !input.trim();

  const flow = useMemo(() => buildFlow(blocks), [blocks]);
  const windowed = windowFlow(flow, visibleLimit);
  const shownErr = privacy ? redactLocalPaths(sendErr) : sendErr;

  return (
    <div
      className={`stream-view ${dragOver ? 'is-drag-over' : ''}`}
      data-testid="stream-view"
      data-session-id={sessionId ?? ''}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (dragOver && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={handleDrop}
    >
      <div
        className="sv-scroll"
        ref={scrollRef}
        onScroll={scroll.onScroll}
        onWheel={scroll.onWheel}
        onPointerDown={scroll.onPointerDown}
        onTouchStart={scroll.onTouchStart}
        onTouchMove={scroll.onTouchMove}
        onKeyDown={scroll.onKeyDown}
      >
        <div className="sv-flow" ref={flowRef}>
          {streamState?.truncated && (
            <div className="sv-truncated-hint" data-testid="sv-truncated-hint" role="note">
              较早的部分历史因日志超过 4 MB 已省略，可切到终端或原记录查看完整过程
            </div>
          )}
          {windowed.hidden > 0 && (
            <button type="button" className="sv-expand-earlier" data-testid="sv-expand-earlier" onClick={expandEarlier}>
              展开更早的 {windowed.hidden} 条记录
            </button>
          )}

          {blocks.length === 0 && !live && (
            <div className="sv-empty" data-testid="sv-empty">
              <div className="sv-empty-title">原生 CLI 流式对话视图</div>
              <div className="sv-empty-sub">
                底层仍运行官方交互式 CLI，消息将自动结构化排版并以平滑流式呈现。随时可点右上角「终端」或按 Alt+M 切回原始终端。
              </div>
            </div>
          )}

          {windowed.items.map((item) => {
            if (item.type === 'steps') {
              const hasSub = item.blocks.some((b) => b.tools.some((t) => t.subagentId));
              return (
                <StepGroup
                  key={item.id}
                  blocks={item.blocks}
                  privacy={privacy}
                  fresh={fresh.isFresh(item.blocks[item.blocks.length - 1].id)}
                  runningSubagentIds={hasSub ? runningSubagentIds : undefined}
                  onInspectFile={onInspectFile}
                />
              );
            }
            const block = item.block;
            if (block.kind === 'user') {
              return (
                <UserBubble
                  key={block.id}
                  block={block}
                  fresh={fresh.isFresh(block.id)}
                  privacy={privacy}
                  projectPath={project?.path}
                  onInspectFile={onInspectFile}
                  onReuse={reuseText}
                  onCancelPending={cancelPending}
                  onRetryPending={retryPending}
                />
              );
            }
            if (block.kind === 'step') {
              return (
                <StepBlockView
                  key={block.id}
                  block={block}
                  privacy={privacy}
                  fresh={fresh.isFresh(block.id)}
                  runningSubagentIds={block.tools.some((t) => t.subagentId) ? runningSubagentIds : undefined}
                  onInspectFile={onInspectFile}
                />
              );
            }
            if (block.kind === 'assistant') {
              return (
                <AssistantMessage
                  key={block.id}
                  block={block}
                  fresh={fresh.isFresh(block.id)}
                  initialChars={fresh.initialChars(block.id)}
                  isLatest={block.id === lastAssistantId}
                  privacy={privacy}
                  projectPath={project?.path}
                  onInspectFile={onInspectFile}
                />
              );
            }
            return (
              <CardBlock
                key={block.id}
                block={block}
                privacy={privacy}
                projectPath={project?.path}
                onInspectFile={onInspectFile}
              />
            );
          })}

          {live && (!activeQuestion || live.phase === 'subagent') && (
            <LiveTail
              live={live}
              hasActiveStepTail={tailBlock?.kind === 'step' && tailBlock.active === true}
              runningSubagentCount={runningSubagentCount}
              privacy={privacy}
              projectPath={project?.path}
              onInspectFile={onInspectFile}
              onFocusSubagents={mergedSubagents.length > 0 || delegates.length > 0 ? focusSubagents : undefined}
            />
          )}
        </div>
      </div>

      <div className="sv-dock">
        {scroll.showJump && (
          <button
            type="button"
            className={`sv-jump-btn ${scroll.hasNew ? 'has-new' : ''}`}
            data-testid="sv-jump-bottom"
            onClick={scroll.jumpBottom}
          >
            {scroll.hasNew ? '↓ 有新回复' : '↓ 回到底部'}
          </button>
        )}

        <DockTray
          sessionId={sessionId}
          todos={todos}
          subagents={mergedSubagents}
          delegates={delegates}
          livePhase={live?.phase}
          hasPrompt={!!prompt || !!activeQuestion}
          privacy={privacy}
          focusSubagentTick={focusSubagentTick}
          onOpenDelegate={onOpenDelegate}
          onInspectFile={onInspectFile}
        />

        {prompt && (
          <PromptBanner
            prompt={prompt}
            busy={promptBusy}
            note={promptNote}
            onAnswer={(data) => void handlePromptClick(data)}
            onOpenTerminal={onSwitchToTerminal}
          />
        )}

        {activeQuestion && (
          <QuestionCard
            prompt={activeQuestion}
            busy={questionBusy}
            stale={questionStale}
            error={questionErr}
            writeInDraft={questionWriteInDraft}
            privacy={privacy}
            onWriteInChange={handleQuestionWriteInChange}
            onSendKeys={handleQuestionKeys}
            onSubmitText={handleQuestionText}
            onUnlock={handleQuestionUnlock}
            onOpenTerminal={onSwitchToTerminal}
          />
        )}

        {!!session?.queued && (
          <div className="sv-queued-hint" data-testid="sv-queued">
            {hasDraftBlock || session.hasTerminalDraft
              ? `有 ${session.queued} 条消息排队中 · 处理完终端里的未发送内容后再发`
              : `有 ${session.queued} 条消息排队中，当前回合结束后自动发送`}
          </div>
        )}

        {sendErr && (
          <div className="sv-send-err" data-testid="sv-send-err" role="alert">
            <span className="sv-send-err-text">{shownErr}</span>
            {sendErrGoto && (
              <button type="button" className="sv-send-err-btn" data-testid="sv-send-err-goto" onClick={onSwitchToTerminal}>
                查看终端
              </button>
            )}
          </div>
        )}

        {!exited && (
          <StreamComposer
            termBar={
              termGuard && (
                <TermDraftBar
                  guard={termGuard}
                  flash={termFlash}
                  busy={termBusy}
                  working={!!working}
                  privacy={privacy}
                  canPull={canPullTermDraft}
                  onSend={() => void handleTermSend()}
                  onPull={() => void handleTermPull()}
                  onClear={() => void handleTermClear()}
                  onDismiss={() => {
                    setDismissedDraftSeq(session?.terminalDraftSeq ?? null);
                    setError('');
                    composerRef.current?.focus();
                  }}
                  onGoto={onSwitchToTerminal}
                />
              )
            }
            hasTermDraft={hasDraftBlock}
            attachments={attachments}
            uploadingCount={uploadingCount}
            privacy={privacy}
            thumbFor={thumbs.thumbFor}
            onRemoveAttachment={removeAttachment}
            onPickFiles={(files) => void uploadFiles(files)}
            textareaRef={composerRef}
            input={input}
            onInputChange={setInput}
            onKeyDown={onComposerKeyDown}
            onPaste={handlePaste}
            disabled={sending || termBusy}
            placeholder={
              hasDraftBlock
                ? '先处理上方终端里的未发送内容…'
                : activeQuestion
                  ? '请先完成上方问题选择，或继续补充说明（本轮结束后发送）…'
                  : working
                    ? '继续补充要求（本轮结束后自动发送）…'
                    : '在此输入消息，或粘贴/拖入文件…（Enter 发送，Shift+Enter 换行）'
            }
            working={!!working}
            onInterrupt={onInterrupt}
            sendDisabled={sending || termBusy || uploadingCount > 0 || (!input.trim() && attachments.length === 0)}
            sendTitle={
              hasDraftBlock
                ? TERM_GUARD_MSG
                : working
                  ? '加入排队发送'
                  : '发送消息 (Enter)'
            }
            onSend={() => void submit()}
            modelLabel={modelLabel || session?.agent || task?.agent || ''}
            onSwitchToTerminal={onSwitchToTerminal}
          />
        )}
      </div>
    </div>
  );
}

// Memoized: Pane no longer feeds it a per-second `now`, and every callback it receives is reference-stable.
export const StreamView = memo(StreamViewImpl);
