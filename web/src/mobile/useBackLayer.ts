import { useCallback, useEffect, useRef } from 'react';

/**
 * One history entry per "layer" (drawer / sheet group / confirm dialog), so the Android system back key (= browser
 * back) closes only the topmost layer. While `open` is true exactly one entry is pushed; the entry is popped
 * again when the layer closes by other means (state change, UI button).
 *
 * Every pushed entry carries a unique `history.state.shoalLayer` id and has a matching record in a module-level list
 * (same order as the pushes). A popstate reads the id of the entry it landed on: every record above it is popped
 * (top to bottom: live layers get `onPop`, then the record's callbacks run). An entry without a known id (base page,
 * or an entry a caller took over with `release()`) counts as below all records. This binds pops to entries instead
 * of counting "whose popstate is next", so a user back press racing a programmatic history.go() is still attributed
 * correctly.
 *
 * Programmatic closes (state change, `close()` of a non-top layer, `popThen`) mark the record dead. Dead records on
 * top of the list are rolled back with one history.go(-k) per microtask; dead records below a live layer wait until
 * everything above them is popped.
 *
 * - `close()`   : UI close. Top layer goes through history.back() so the popstate handler closes it; a repeated
 *                 close before that back landed asks for nothing more.
 * - `release()` : the caller takes over the pushed entry (e.g. replaceState it); no back() is issued.
 *                 Returns whether an entry was pushed.
 * - `popThen(fn)`: pops the entry (if any) and runs `fn` after the browser finished going back. A repeated call while
 *                 a pop is already pending is ignored; after a `close()` whose back has not landed yet, `fn` waits
 *                 for that same back (never a second one). `fn` is dropped if the component unmounted before the
 *                 pop landed (the user already left the screen it confirmed for).
 *
 * Refs survive React StrictMode's double effect run, so a layer is never pushed twice.
 */
interface LayerEntry {
  mounted: boolean;
  onPop(): void;
}

interface LayerRecord {
  id: number;
  layer: LayerEntry | null; // null = dead (closed programmatically, waiting for its history entry to go)
  callbacks: (() => void)[];
  backPending: boolean; // close() already asked the browser to go back for this entry
}

const records: LayerRecord[] = [];
let nextId = 1;
// Number of records that should remain once the requested history.go() landed; null = no request in flight.
let pendingTarget: number | null = null;
let flushScheduled = false;
let listening = false;

function onPopState() {
  const id = (history.state as { shoalLayer?: unknown } | null)?.shoalLayer;
  const idx = typeof id === 'number' ? records.findIndex((r) => r.id === id) : -1;
  const popped = records.splice(idx + 1);
  if (pendingTarget !== null && records.length <= pendingTarget) pendingTarget = null;
  for (let i = popped.length - 1; i >= 0; i--) {
    const r = popped[i];
    if (r.layer?.mounted) r.layer.onPop();
    for (const fn of r.callbacks) fn();
  }
  scheduleFlush();
}

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener('popstate', onPopState);
}

function flush() {
  flushScheduled = false;
  if (pendingTarget !== null) return; // wait for the in-flight go() to land; popstate re-checks
  let k = 0;
  while (k < records.length && records[records.length - 1 - k].layer === null) k++;
  if (k === 0) return;
  pendingTarget = records.length - k;
  history.go(-k);
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function markDead(rec: LayerRecord, callback?: () => void) {
  rec.layer = null;
  if (callback) rec.callbacks.push(callback);
  scheduleFlush();
}

export function useBackLayer(open: boolean, onPop: () => void) {
  const recRef = useRef<LayerRecord | null>(null);
  const entry = useRef<LayerEntry>({ mounted: true, onPop: () => {} });

  // The record while its history entry still exists; null once it was popped or released.
  const current = () => (recRef.current && records.includes(recRef.current) ? recRef.current : null);
  const alive = () => current()?.layer === entry.current;

  useEffect(() => {
    const e = entry.current;
    e.mounted = true;
    ensureListener();
    return () => { e.mounted = false; };
  }, []);

  useEffect(() => {
    const e = entry.current;
    if (open && !alive()) {
      const rec: LayerRecord = { id: nextId++, layer: e, callbacks: [], backPending: false };
      history.pushState({ ...(history.state ?? {}), shoalLayer: rec.id }, '', location.href);
      records.push(rec);
      recRef.current = rec;
    } else if (!open) {
      const rec = current();
      if (rec && rec.layer === e) markDead(rec);
    }
  }, [open]);

  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;
  entry.current.onPop = () => onPopRef.current();

  const close = useCallback(() => {
    const e = entry.current;
    const rec = current();
    if (!rec || rec.layer !== e) {
      e.onPop();
      return;
    }
    if (records[records.length - 1] === rec) {
      if (rec.backPending) return; // a second tap before the first back landed
      rec.backPending = true;
      history.back();
    } else {
      // Not the top layer: its entry goes later, in a batched pop once the layers above it are gone.
      markDead(rec);
      e.onPop();
    }
  }, []);

  const release = useCallback(() => {
    const rec = current();
    if (!rec || rec.layer !== entry.current) return false;
    records.splice(records.indexOf(rec), 1);
    recRef.current = null;
    return true;
  }, []);

  const popThen = useCallback((fn: () => void) => {
    // The callback belongs to this layer's component: once it unmounted (the user went elsewhere), it must not run.
    const e = entry.current;
    const guarded = () => {
      if (e.mounted) fn();
    };
    const rec = current();
    if (!rec) {
      fn();
      return;
    }
    if (rec.layer === null) return; // a pop is already pending for this layer
    if (rec.backPending) {
      // close() already asked for this entry's back: ride on it instead of going back a second time (which would
      // close the layer underneath too).
      if (rec.callbacks.length === 0) rec.callbacks.push(guarded);
      return;
    }
    if (records[records.length - 1] === rec) {
      markDead(rec, guarded);
    } else {
      markDead(rec);
      fn();
    }
  }, []);

  return { close, release, popThen };
}
