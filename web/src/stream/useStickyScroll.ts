import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject, TouchEvent, WheelEvent } from 'react';

export const BOTTOM_EPS = 28;
export const REATTACH_EPS = 16;

const PROGRAMMATIC_WINDOW_MS = 180;
const SCROLLBAR_TRAIL_MS = 180;
const USER_UP_COOLDOWN_MS = 250;

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ReplySignal {
  blockCount: number;
  lastAssistantId: string | null;
  lastAssistantLen: number;
  liveAnswerLen: number;
}

export interface ScrollEvalInput {
  stick: boolean;
  prev: ScrollGeometry;
  curr: ScrollGeometry;
  inProgrammaticWindow: boolean;
  programmaticTop: number | null;
  rafRunning: boolean;
  scrollbarInteracting: boolean;
  inUserUpCooldown: boolean;
}

export type ScrollEvalOutcome =
  | { action: 'ignore-hidden' }
  | { action: 'programmatic'; atBottom: boolean }
  | { action: 'detach'; showJump: true }
  | { action: 'reattach' }
  | { action: 'keep'; showJump: boolean; nudgeToBottom: boolean };

/**
 * Pure decision function for `.sv-scroll` `onScroll` events.
 * Key invariant: layout-induced scrollTop clamps (step collapsing, LiveTail swap,
 * typewriter restart, DockTray height changes, window resize) NEVER detach sticky follow.
 * Only explicit user upward interaction or an upward scroll on unchanged layout geometry detaches.
 */
export function evaluateScrollEvent(input: ScrollEvalInput): ScrollEvalOutcome {
  const { stick, prev, curr, inProgrammaticWindow, programmaticTop, rafRunning, scrollbarInteracting, inUserUpCooldown } = input;
  if (curr.clientHeight <= 0 || curr.scrollHeight <= 0) {
    return { action: 'ignore-hidden' };
  }

  const maxScroll = Math.max(0, curr.scrollHeight - curr.clientHeight);
  const dist = maxScroll - curr.scrollTop;

  if (!scrollbarInteracting) {
    if (inProgrammaticWindow && programmaticTop !== null && Math.abs(curr.scrollTop - programmaticTop) <= 2) {
      return { action: 'programmatic', atBottom: dist <= REATTACH_EPS };
    }
    if (stick && rafRunning && curr.scrollTop >= prev.scrollTop - 1) {
      return { action: 'programmatic', atBottom: dist <= REATTACH_EPS };
    }
  }

  if (scrollbarInteracting && curr.scrollTop < prev.scrollTop - 1 && dist > BOTTOM_EPS) {
    return { action: 'detach', showJump: true };
  }

  const movingDown = curr.scrollTop > prev.scrollTop + 0.5;
  if (dist <= REATTACH_EPS && (!inUserUpCooldown || movingDown || maxScroll <= BOTTOM_EPS)) {
    return { action: 'reattach' };
  }

  const layoutUnchanged =
    prev.clientHeight > 0 &&
    Math.abs(curr.scrollHeight - prev.scrollHeight) <= 1 &&
    Math.abs(curr.clientHeight - prev.clientHeight) <= 1;

  if (layoutUnchanged && curr.scrollTop < prev.scrollTop - 2 && dist > BOTTOM_EPS) {
    return { action: 'detach', showJump: true };
  }

  if (stick) {
    return { action: 'keep', showJump: false, nudgeToBottom: dist > 1.5 };
  }
  return { action: 'keep', showJump: dist > BOTTOM_EPS, nudgeToBottom: false };
}

export function computeNextSmoothTop(scrollTop: number, maxScroll: number): { next: number; done: boolean } {
  const diff = maxScroll - scrollTop;
  if (diff <= 1.5) return { next: maxScroll, done: true };
  const step = Math.max(1.5, diff * 0.28);
  return { next: Math.min(maxScroll, scrollTop + step), done: false };
}

export function hasReplyProgressed(prev: ReplySignal, curr: ReplySignal): boolean {
  return (
    curr.blockCount > prev.blockCount ||
    (curr.lastAssistantId !== null && curr.lastAssistantId !== prev.lastAssistantId) ||
    curr.lastAssistantLen > prev.lastAssistantLen ||
    curr.liveAnswerLen > prev.liveAnswerLen
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readGeometry(el: HTMLElement): ScrollGeometry {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

export interface StickyScrollOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  flowRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  hasContent: boolean;
  contentKey: string;
  replySignal: ReplySignal;
}

export interface StickyScrollApi {
  showJump: boolean;
  hasNew: boolean;
  isSticking(): boolean;
  stickToBottom(instant?: boolean): void;
  jumpBottom(): void;
  setProgrammaticScrollTop(nextTop: number): void;
  onScroll(): void;
  onWheel(e: WheelEvent<HTMLDivElement>): void;
  onPointerDown(e: PointerEvent<HTMLDivElement>): void;
  onTouchStart(e: TouchEvent<HTMLDivElement>): void;
  onTouchMove(e: TouchEvent<HTMLDivElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
}

export function useStickyScroll({
  scrollRef,
  flowRef,
  sessionId,
  hasContent,
  contentKey,
  replySignal,
}: StickyScrollOptions): StickyScrollApi {
  const stickRef = useRef(true);
  const rafRef = useRef(0);
  const hydrateRafRef = useRef(0);
  const hydratedRef = useRef(false);
  const wasHiddenRef = useRef(false);
  const savedHiddenTopRef = useRef<number | null>(null);
  const geoRef = useRef<ScrollGeometry>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const programmaticTopRef = useRef<number | null>(null);
  const programmaticUntilRef = useRef(0);
  const userUpAtRef = useRef(0);
  const pointerDownRef = useRef(false);
  const scrollbarActiveRef = useRef(false);
  const scrollbarUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);

  const [showJump, setShowJump] = useState(false);
  const [hasNew, setHasNew] = useState(false);

  const cancelRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const syncGeo = useCallback((el: HTMLElement) => {
    geoRef.current = readGeometry(el);
  }, []);

  const writeScrollTop = useCallback((el: HTMLElement, next: number): boolean => {
    const before = el.scrollTop;
    el.scrollTop = next;
    const after = el.scrollTop;
    const moved = Math.abs(after - before) >= 0.05;
    if (moved) {
      programmaticTopRef.current = after;
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_WINDOW_MS;
    }
    geoRef.current = {
      scrollTop: after,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    return moved;
  }, []);

  const setProgrammaticScrollTop = useCallback((nextTop: number) => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(nextTop - el.scrollTop) >= 0.5) {
      writeScrollTop(el, nextTop);
    } else {
      syncGeo(el);
    }
  }, [scrollRef, syncGeo, writeScrollTop]);

  const kickScroll = useCallback((instant = false) => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    if (el.clientHeight <= 0 || el.scrollHeight <= 0) {
      wasHiddenRef.current = true;
      cancelRaf();
      return;
    }

    const immediate = instant || document.hidden || prefersReducedMotion();
    if (immediate) {
      cancelRaf();
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(maxScroll - el.scrollTop) >= 0.5) {
        writeScrollTop(el, maxScroll);
      } else {
        syncGeo(el);
      }
      return;
    }

    const tick = () => {
      const box = scrollRef.current;
      if (!box || !stickRef.current || box.clientHeight <= 0 || box.scrollHeight <= 0) {
        rafRef.current = 0;
        return;
      }
      const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
      const { next, done } = computeNextSmoothTop(box.scrollTop, maxScroll);
      if (done) {
        if (Math.abs(maxScroll - box.scrollTop) >= 0.25) {
          writeScrollTop(box, maxScroll);
        } else {
          syncGeo(box);
        }
        rafRef.current = 0;
        return;
      }
      const moved = writeScrollTop(box, next);
      if (!moved) {
        // Reached physical scroll ceiling (e.g. fractional Windows DPI scaling).
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [cancelRaf, scrollRef, syncGeo, writeScrollTop]);

  const detachByUser = useCallback((el: HTMLElement) => {
    // Do not detach if there is nothing above the viewport to scroll up into.
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScroll <= BOTTOM_EPS && el.scrollTop <= 1) return;
    if (el.scrollTop <= 1) return;

    stickRef.current = false;
    programmaticUntilRef.current = 0;
    userUpAtRef.current = performance.now();
    cancelRaf();
    if (maxScroll - el.scrollTop > BOTTOM_EPS) {
      setShowJump(true);
    }
  }, [cancelRaf]);

  const stickToBottom = useCallback((instant = false) => {
    stickRef.current = true;
    scrollbarActiveRef.current = false;
    scrollbarUntilRef.current = 0;
    userUpAtRef.current = 0;
    setShowJump(false);
    setHasNew(false);
    kickScroll(instant);
  }, [kickScroll]);

  const jumpBottom = useCallback(() => {
    stickToBottom(false);
  }, [stickToBottom]);

  // Cleanup animation frames & window listeners on unmount.
  useEffect(() => {
    const onPointerUp = () => {
      if (scrollbarActiveRef.current) {
        scrollbarActiveRef.current = false;
        scrollbarUntilRef.current = performance.now() + SCROLLBAR_TRAIL_MS;
      }
      pointerDownRef.current = false;
    };
    const onPointerMove = (e: globalThis.PointerEvent) => {
      if (!pointerDownRef.current || scrollbarActiveRef.current) return;
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Drag-selecting text upward near/past the top edge of the scroller should also release sticky follow.
      if (e.clientY < rect.top + 28 && el.scrollTop > 1) {
        scrollbarActiveRef.current = true;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && stickRef.current) {
        kickScroll(true);
      }
    };

    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelRaf();
      if (hydrateRafRef.current) {
        cancelAnimationFrame(hydrateRafRef.current);
        hydrateRafRef.current = 0;
      }
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [cancelRaf, kickScroll, scrollRef]);

  // Observe BOTH `.sv-flow` (content growth/collapse) and `.sv-scroll` (dock height changes, window resize, tab hide/show).
  useLayoutEffect(() => {
    const flow = flowRef.current;
    const scroller = scrollRef.current;
    if (!flow || !scroller) return;

    syncGeo(scroller);

    const handleResize = () => {
      const el = scrollRef.current;
      if (!el) return;

      if (el.clientHeight <= 0 || el.scrollHeight <= 0) {
        if (!wasHiddenRef.current) {
          wasHiddenRef.current = true;
          if (!stickRef.current && geoRef.current.clientHeight > 0) {
            savedHiddenTopRef.current = geoRef.current.scrollTop;
          }
        }
        geoRef.current = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
        cancelRaf();
        return;
      }

      if (wasHiddenRef.current) {
        wasHiddenRef.current = false;
        if (stickRef.current) {
          kickScroll(true);
          cancelAnimationFrame(hydrateRafRef.current);
          hydrateRafRef.current = requestAnimationFrame(() => {
            hydrateRafRef.current = 0;
            if (stickRef.current) kickScroll(true);
          });
        } else if (savedHiddenTopRef.current !== null) {
          const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
          const restored = Math.min(maxScroll, savedHiddenTopRef.current);
          savedHiddenTopRef.current = null;
          writeScrollTop(el, restored);
          const dist = maxScroll - el.scrollTop;
          if (dist <= BOTTOM_EPS) {
            stickRef.current = true;
            setShowJump(false);
            setHasNew(false);
          } else {
            setShowJump(true);
          }
        } else {
          syncGeo(el);
        }
        return;
      }

      const prev = geoRef.current;
      const viewportShrank = prev.clientHeight > 0 && el.clientHeight < prev.clientHeight - 0.5;
      const viewportGrew = prev.clientHeight > 0 && el.clientHeight > prev.clientHeight + 0.5;
      const contentShrank = prev.scrollHeight > 0 && el.scrollHeight < prev.scrollHeight - 0.5;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const dist = maxScroll - el.scrollTop;

      if (stickRef.current) {
        if (viewportShrank) {
          // Bottom dock expanded (e.g. DockTray / PromptBanner / multi-line composer) or window shrank:
          // snap immediately so the latest reply is pushed up cleanly instead of clipped behind the dock.
          kickScroll(true);
        } else if (dist > 1.5) {
          kickScroll(!hydratedRef.current);
        } else if (viewportGrew || contentShrank) {
          syncGeo(el);
          setShowJump(false);
          setHasNew(false);
        } else {
          syncGeo(el);
        }
      } else {
        if (dist <= BOTTOM_EPS) {
          stickRef.current = true;
          setShowJump(false);
          setHasNew(false);
        }
        syncGeo(el);
      }
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(flow);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [cancelRaf, flowRef, kickScroll, scrollRef, syncGeo, writeScrollTop]);

  // Track session switches, first hydration, and incoming content/reply updates.
  const prevSidRef = useRef<string | null>(null);
  const { blockCount, lastAssistantId, lastAssistantLen, liveAnswerLen } = replySignal;
  const prevReplyRef = useRef<ReplySignal>({ blockCount, lastAssistantId, lastAssistantLen, liveAnswerLen });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const nextReply: ReplySignal = { blockCount, lastAssistantId, lastAssistantLen, liveAnswerLen };
    const switched = prevSidRef.current !== sessionId;
    prevSidRef.current = sessionId;

    if (switched) {
      stickRef.current = true;
      hydratedRef.current = false;
      wasHiddenRef.current = false;
      savedHiddenTopRef.current = null;
      prevReplyRef.current = nextReply;
      setShowJump(false);
      setHasNew(false);
      if (hasContent && el && el.clientHeight > 0) {
        hydratedRef.current = true;
        kickScroll(true);
        cancelAnimationFrame(hydrateRafRef.current);
        hydrateRafRef.current = requestAnimationFrame(() => {
          hydrateRafRef.current = 0;
          if (stickRef.current) kickScroll(true);
        });
      }
      return;
    }

    if (!hydratedRef.current && hasContent) {
      prevReplyRef.current = nextReply;
      if (el && el.clientHeight > 0) {
        hydratedRef.current = true;
        if (stickRef.current) {
          kickScroll(true);
          cancelAnimationFrame(hydrateRafRef.current);
          hydrateRafRef.current = requestAnimationFrame(() => {
            hydrateRafRef.current = 0;
            if (stickRef.current) kickScroll(true);
          });
        }
      } else {
        wasHiddenRef.current = true;
      }
      return;
    }

    const progressed = hasReplyProgressed(prevReplyRef.current, nextReply);
    prevReplyRef.current = nextReply;

    if (stickRef.current) {
      if (el && el.clientHeight > 0) {
        const dist = Math.max(0, el.scrollHeight - el.clientHeight) - el.scrollTop;
        if (dist > 1.5) kickScroll(false);
        else syncGeo(el);
      }
      return;
    }

    if (!el || el.clientHeight <= 0) {
      if (progressed) {
        setShowJump(true);
        setHasNew(true);
      }
      return;
    }

    const dist = Math.max(0, el.scrollHeight - el.clientHeight) - el.scrollTop;
    if (dist <= BOTTOM_EPS) {
      stickRef.current = true;
      setShowJump(false);
      setHasNew(false);
      return;
    }

    setShowJump(true);
    if (progressed) setHasNew(true);
  }, [sessionId, hasContent, contentKey, blockCount, lastAssistantId, lastAssistantLen, liveAnswerLen, kickScroll, scrollRef, syncGeo]);

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      const el = scrollRef.current;
      if (el) detachByUser(el);
    }
  }, [detachByUser, scrollRef]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    pointerDownRef.current = true;
    const rect = el.getBoundingClientRect();
    const sbWidth = el.offsetWidth - el.clientWidth;
    const hitWidth = Math.max(sbWidth, 16);
    if (e.clientX >= rect.right - hitWidth && e.clientX <= rect.right) {
      scrollbarActiveRef.current = true;
      programmaticUntilRef.current = 0;
      cancelRaf();
    }
  }, [cancelRaf, scrollRef]);

  const onTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    touchYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    const y = e.touches[0]?.clientY;
    const prevY = touchYRef.current;
    if (y !== undefined) touchYRef.current = y;
    if (y !== undefined && prevY !== null && y > prevY + 2) {
      const el = scrollRef.current;
      if (el) detachByUser(el);
    }
  }, [detachByUser, scrollRef]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    const upwardKey = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey);
    if (upwardKey) {
      const el = scrollRef.current;
      if (el) detachByUser(el);
    }
  }, [detachByUser, scrollRef]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = performance.now();
    const curr = readGeometry(el);
    if (curr.clientHeight <= 0 || curr.scrollHeight <= 0) {
      wasHiddenRef.current = true;
      geoRef.current = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      return;
    }
    if (wasHiddenRef.current) {
      // Returning from display:none (e.g. switching top tabs): restore position instead of misclassifying scrollTop=0.
      wasHiddenRef.current = false;
      if (stickRef.current) {
        kickScroll(true);
      } else if (savedHiddenTopRef.current !== null) {
        const maxScroll = Math.max(0, curr.scrollHeight - curr.clientHeight);
        const restored = Math.min(maxScroll, savedHiddenTopRef.current);
        savedHiddenTopRef.current = null;
        writeScrollTop(el, restored);
      } else {
        geoRef.current = curr;
      }
      return;
    }
    const outcome = evaluateScrollEvent({
      stick: stickRef.current,
      prev: geoRef.current,
      curr,
      inProgrammaticWindow: now <= programmaticUntilRef.current,
      programmaticTop: programmaticTopRef.current,
      rafRunning: rafRef.current !== 0,
      scrollbarInteracting: scrollbarActiveRef.current || now <= scrollbarUntilRef.current,
      inUserUpCooldown: now - userUpAtRef.current <= USER_UP_COOLDOWN_MS,
    });

    if (outcome.action === 'ignore-hidden') {
      wasHiddenRef.current = true;
      return;
    }

    geoRef.current = curr;

    if (outcome.action === 'programmatic') {
      if (outcome.atBottom) {
        setShowJump(false);
        setHasNew(false);
      }
      return;
    }

    if (outcome.action === 'detach') {
      stickRef.current = false;
      programmaticUntilRef.current = 0;
      cancelRaf();
      setShowJump(true);
      return;
    }

    if (outcome.action === 'reattach') {
      stickRef.current = true;
      setShowJump(false);
      setHasNew(false);
      return;
    }

    // outcome.action === 'keep'
    if (outcome.showJump) setShowJump(true);
    if (outcome.nudgeToBottom && stickRef.current) {
      kickScroll(false);
    }
  }, [cancelRaf, kickScroll, scrollRef, writeScrollTop]);

  return {
    showJump,
    hasNew,
    isSticking: () => stickRef.current,
    stickToBottom,
    jumpBottom,
    setProgrammaticScrollTop,
    onScroll,
    onWheel,
    onPointerDown,
    onTouchStart,
    onTouchMove,
    onKeyDown,
  };
}
