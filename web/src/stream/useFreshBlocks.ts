import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { SessionStreamState, StreamBlock } from '../../../shared/protocol.ts';

const FRESH_TTL_MS = 4000; // longer than the entrance glide and the typewriter reveal

export interface FreshBlocks {
  isFresh(id: string): boolean;
  initialChars(id: string): number;
}

// Tracks which block IDs existed on first load so history never re-animates while newly arrived blocks glide in.
// Render only READS the refs (pure); every mutation happens in the effect after commit, and fresh entries are dropped
// once their animation is over so a window re-expand never replays them.
export function useFreshBlocks(
  sessionId: string | null,
  streamState: SessionStreamState | null,
  blocks: StreamBlock[],
  lastLiveAnswerLenRef: MutableRefObject<number>,
): FreshBlocks {
  const seenRef = useRef<Set<string>>(new Set());
  const freshRef = useRef<Set<string>>(new Set());
  const initialCharsRef = useRef<Map<string, number>>(new Map());
  const timersRef = useRef<Map<string, number>>(new Map());
  const sidRef = useRef<string | null>(sessionId);

  const valid = !!streamState && streamState.sessionId === sessionId;
  const primed = seenRef.current.size > 0 && sidRef.current === sessionId;

  // Pure derivation for THIS render: blocks that arrived after the baseline and are not yet in the committed sets.
  const pendingNew = new Set<string>();
  let firstNewAssistant: string | null = null;
  if (valid && primed) {
    for (const b of blocks) {
      if (seenRef.current.has(b.id)) continue;
      pendingNew.add(b.id);
      if (firstNewAssistant === null && b.kind === 'assistant') firstNewAssistant = b.id;
    }
  }
  const liveLen = lastLiveAnswerLenRef.current;

  useEffect(() => {
    if (sidRef.current !== sessionId) {
      sidRef.current = sessionId;
      seenRef.current = new Set();
      freshRef.current = new Set();
      initialCharsRef.current = new Map();
      for (const t of timersRef.current.values()) window.clearTimeout(t);
      timersRef.current.clear();
      lastLiveAnswerLenRef.current = 0;
    }
    if (!streamState || streamState.sessionId !== sessionId) return;
    const seen = seenRef.current;
    if (seen.size === 0) {
      for (const b of blocks) seen.add(b.id);
      return;
    }
    for (const b of blocks) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      freshRef.current.add(b.id);
      if (b.kind === 'assistant' && lastLiveAnswerLenRef.current > 0) {
        initialCharsRef.current.set(b.id, Math.min(b.text.length, lastLiveAnswerLenRef.current));
        lastLiveAnswerLenRef.current = 0;
      }
      const timer = window.setTimeout(() => {
        timersRef.current.delete(b.id);
        freshRef.current.delete(b.id);
        initialCharsRef.current.delete(b.id);
      }, FRESH_TTL_MS);
      timersRef.current.set(b.id, timer);
    }
  }, [sessionId, streamState, blocks, lastLiveAnswerLenRef]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  return {
    isFresh: (id) => freshRef.current.has(id) || pendingNew.has(id),
    initialChars: (id) => {
      const committed = initialCharsRef.current.get(id);
      if (committed !== undefined) return committed;
      if (id === firstNewAssistant && liveLen > 0) {
        const b = blocks.find((x) => x.id === id);
        return b && b.kind === 'assistant' ? Math.min(b.text.length, liveLen) : 0;
      }
      return 0;
    },
  };
}
