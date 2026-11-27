import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Resize a `<textarea>` to fit its content (capped by CSS `max-height` or `fallbackMaxHeightPx`)
 * WITHOUT transiently shrinking its parent container in-flow.
 *
 * Why: naive `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'` forces a
 * synchronous layout while the textarea is collapsed to 1 row. Inside a flex column where a
 * sibling message list (`.sv-scroll` / `.mob-scroll`) has `flex: 1`, that intermediate layout
 * briefly expands the scroller and causes the browser to clamp `scrollTop` downward; restoring
 * `el.style.height` does NOT un-clamp `scrollTop`, so the conversation jumps down on every
 * keystroke and sticky auto-scroll pulls it back up (and for 3+ lines, can even falsely detach).
 *
 * Returns the height delta in CSS pixels (`> 0` when grown, `< 0` when shrunk, `0` unchanged).
 */
export function autoResizeTextarea(el: HTMLTextAreaElement, fallbackMaxHeightPx?: number): number {
  if (el.clientWidth <= 0) return 0; // Hidden (`display: none` tab): never collapse to 0px.

  const prevHeight = el.offsetHeight;
  const cs = getComputedStyle(el);
  const cssMax = Number.parseFloat(cs.maxHeight);
  const cap = Number.isFinite(cssMax) && cssMax > 0 ? cssMax : fallbackMaxHeightPx;
  const border = Math.max(0, el.offsetHeight - el.clientHeight);

  // Fast path 1: already capped at maxHeight and content still overflows -> zero geometry writes,
  // preserving internal `el.scrollTop` and caret stability while typing past the cap.
  if (cap !== undefined && el.scrollHeight + border > cap + 1 && Math.abs(prevHeight - cap) <= 1) {
    if (el.style.overflowY !== 'auto') el.style.overflowY = 'auto';
    return 0;
  }

  // Fast path 2: no scrollbar distorting inner width and content strictly grew past current height ->
  // expand directly without ever collapsing to `auto`.
  if (el.style.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1) {
    const natural = el.scrollHeight + border;
    const capped = cap !== undefined && natural > cap;
    const target = capped ? cap : natural;
    el.style.height = `${Math.ceil(target)}px`;
    el.style.overflowY = capped ? 'auto' : 'hidden';
    return target - prevHeight;
  }

  // General path (initial sizing, same-line typing, or possible shrink):
  // Lock the parent's `min-height` to at least its current rendered height (`Math.ceil`) while
  // measuring `height: auto`. That guarantees the flex dock never shrinks during the forced
  // layout read, so the sibling scroller's `maxScroll` never decreases and `scrollTop` never clamps.
  const parent = el.parentElement;
  const prevParentMinH = parent ? parent.style.minHeight : '';
  const prevScrollTop = el.scrollTop;

  if (parent) {
    const parentRect = parent.getBoundingClientRect();
    if (parentRect.height > 0) {
      const pcs = getComputedStyle(parent);
      let lockH = Math.ceil(parentRect.height);
      if (pcs.boxSizing !== 'border-box') {
        const padBorder =
          (Number.parseFloat(pcs.paddingTop) || 0) +
          (Number.parseFloat(pcs.paddingBottom) || 0) +
          (Number.parseFloat(pcs.borderTopWidth) || 0) +
          (Number.parseFloat(pcs.borderBottomWidth) || 0);
        lockH = Math.max(0, Math.ceil(parentRect.height - padBorder));
      }
      parent.style.minHeight = `${lockH}px`;
    }
  }

  try {
    // Hide vertical scrollbar while measuring so a transient scrollbar during `height: auto`
    // never narrows the text column and triggers a phantom extra wrapped line.
    el.style.overflowY = 'hidden';
    el.style.height = 'auto';
    const natural = el.scrollHeight + border;
    const capped = cap !== undefined && natural > cap;
    const target = capped ? cap : natural;
    el.style.height = `${Math.ceil(target)}px`;
    el.style.overflowY = capped ? 'auto' : 'hidden';
    return target - prevHeight;
  } finally {
    if (parent) parent.style.minHeight = prevParentMinH;
    if (el.scrollTop !== prevScrollTop) el.scrollTop = prevScrollTop;
  }
}

export interface AutoResizeTextareaOptions {
  fallbackMaxHeightPx?: number;
  /** Re-bind when a conditionally rendered textarea mounts/unmounts. */
  mounted?: boolean;
  /** Called synchronously before paint when the textarea grew taller. */
  onGrow?: () => void;
}

/**
 * Synchronously auto-size a textarea before paint on value changes AND whenever its border-box
 * width changes (e.g. toggling Inspector, window resize, or returning from a hidden tab).
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  opts?: AutoResizeTextareaOptions,
): void {
  const fallbackMax = opts?.fallbackMaxHeightPx;
  const mounted = opts?.mounted ?? true;
  const onGrowRef = useRef(opts?.onGrow);
  useLayoutEffect(() => {
    onGrowRef.current = opts?.onGrow;
  });

  useLayoutEffect(() => {
    if (!mounted) return;
    const el = ref.current;
    if (!el) return;
    const delta = autoResizeTextarea(el, fallbackMax);
    if (delta > 0.5) onGrowRef.current?.();
  }, [ref, value, mounted, fallbackMax]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      const box = ref.current;
      if (!box) return;
      const w = box.offsetWidth;
      if (Math.abs(w - lastWidth) <= 0.5) return;
      lastWidth = w;
      if (w > 0) {
        const delta = autoResizeTextarea(box, fallbackMax);
        if (delta > 0.5) onGrowRef.current?.();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, mounted, fallbackMax]);
}
