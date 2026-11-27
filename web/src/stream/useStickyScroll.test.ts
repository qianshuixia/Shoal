import { describe, expect, it } from 'vitest';
import {
  computeNextSmoothTop,
  evaluateScrollEvent,
  hasReplyProgressed,
  type ReplySignal,
  type ScrollEvalInput,
} from './useStickyScroll.ts';

function baseInput(over: Partial<ScrollEvalInput> = {}): ScrollEvalInput {
  return {
    stick: true,
    prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
    curr: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
    inProgrammaticWindow: false,
    programmaticTop: null,
    rafRunning: false,
    scrollbarInteracting: false,
    inUserUpCooldown: false,
    ...over,
  };
}

describe('evaluateScrollEvent', () => {
  it('NEVER detaches when StepGroup collapse / LiveTail swap shrinks scrollHeight and then a new reply grows past BOTTOM_EPS', () => {
    // Reproduces the exact screenshot bug:
    // 1. Was at bottom (top=1400, scrollHeight=2000, clientHeight=600).
    // 2. Steps collapse + LiveTail unmounts -> browser clamps scrollTop to 1050.
    // 3. New assistant reply starts revealing -> scrollHeight grows back to 1900 (dist=250 > 28).
    // 4. Queued clamp scroll event fires with top=1050 < prev.scrollTop(1400).
    const res = evaluateScrollEvent(
      baseInput({
        stick: true,
        prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 1050, scrollHeight: 1900, clientHeight: 600 },
      }),
    );
    expect(res).toEqual({ action: 'keep', showJump: false, nudgeToBottom: true });
  });

  it('NEVER detaches when DockTray expands (clientHeight shrinks) and leaves content below the viewport', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: true,
        prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 1380, scrollHeight: 2000, clientHeight: 460 },
      }),
    );
    expect(res).toEqual({ action: 'keep', showJump: false, nudgeToBottom: true });
  });

  it('ignores hidden-tab scroll events (display: none -> clientHeight 0)', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: true,
        prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
      }),
    );
    expect(res).toEqual({ action: 'ignore-hidden' });
  });

  it('detaches immediately when dragging the scrollbar upward even while content is actively growing', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: true,
        prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 1200, scrollHeight: 2200, clientHeight: 600 },
        scrollbarInteracting: true,
      }),
    );
    expect(res).toEqual({ action: 'detach', showJump: true });
  });

  it('detaches when scrollTop jumps upward on unchanged layout geometry (e.g. el.scrollTop = 0 or track click)', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: true,
        prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 },
      }),
    );
    expect(res).toEqual({ action: 'detach', showJump: true });
  });

  it('treats matching programmatic scroll writes as programmatic and clears jump once at bottom', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: true,
        prev: { scrollTop: 1100, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        inProgrammaticWindow: true,
        programmaticTop: 1400,
      }),
    );
    expect(res).toEqual({ action: 'programmatic', atBottom: true });
  });

  it('reattaches once the user scrolls back within REATTACH_EPS of the bottom', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: false,
        prev: { scrollTop: 1000, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 1390, scrollHeight: 2000, clientHeight: 600 },
      }),
    );
    expect(res).toEqual({ action: 'reattach' });
  });

  it('does NOT bounce back to sticky during the brief upward-wheel cooldown when just barely scrolled off bottom', () => {
    const res = evaluateScrollEvent(
      baseInput({
        stick: false,
        prev: { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
        curr: { scrollTop: 1390, scrollHeight: 2000, clientHeight: 600 },
        inUserUpCooldown: true,
      }),
    );
    expect(res).toEqual({ action: 'keep', showJump: false, nudgeToBottom: false });
  });
});

describe('computeNextSmoothTop', () => {
  it('snaps directly to maxScroll when within 1.5px', () => {
    expect(computeNextSmoothTop(998.8, 1000)).toEqual({ next: 1000, done: true });
    expect(computeNextSmoothTop(1000, 1000)).toEqual({ next: 1000, done: true });
  });

  it('advances smoothly toward maxScroll and never overshoots', () => {
    const step = computeNextSmoothTop(500, 1000);
    expect(step.done).toBe(false);
    expect(step.next).toBeGreaterThan(500);
    expect(step.next).toBeLessThanOrEqual(1000);
  });
});

describe('hasReplyProgressed', () => {
  const base: ReplySignal = { blockCount: 4, lastAssistantId: 'a1', lastAssistantLen: 100, liveAnswerLen: 0 };

  it('returns false when nothing grew (e.g. step collapse or thinking-only updates)', () => {
    expect(hasReplyProgressed(base, { ...base })).toBe(false);
    expect(hasReplyProgressed(base, { ...base, blockCount: 3 })).toBe(false);
  });

  it('returns true when block count grows, assistant text grows, or live answer grows', () => {
    expect(hasReplyProgressed(base, { ...base, blockCount: 5 })).toBe(true);
    expect(hasReplyProgressed(base, { ...base, lastAssistantId: 'a2', lastAssistantLen: 10 })).toBe(true);
    expect(hasReplyProgressed(base, { ...base, lastAssistantLen: 140 })).toBe(true);
    expect(hasReplyProgressed(base, { ...base, liveAnswerLen: 24 })).toBe(true);
  });
});
