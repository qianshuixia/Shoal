import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImgHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePrivacy } from './privacy.ts';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const STAGE_PAD = 24;
const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface ImageZoomViewerProps {
  src: string;
  alt: string;
  sizeText?: string;
  referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  onError?: () => void;
  onOpenFullscreen?: () => void;
  /** Test-id prefix: `'img'` for Inspector inline viewer, `'lightbox-img'` for fullscreen modal. */
  testIdPrefix?: string;
  /** Bind +/-/0/1 shortcuts on window while mounted (used inside modal lightbox). */
  listenWindowKeys?: boolean;
}

export function ImageZoomViewer({
  src,
  alt,
  sizeText,
  referrerPolicy,
  onError,
  onOpenFullscreen,
  testIdPrefix = 'img',
  listenWindowKeys = false,
}: ImageZoomViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [mode, setMode] = useState<'fit' | 'custom'>('fit');
  const [customZoom, setCustomZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Reset zoom/pan cleanly if src ever changes without a key remount.
  useEffect(() => {
    setDims(null);
    setMode('fit');
    setCustomZoom(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    dragRef.current = null;
  }, [src]);

  // Measure the available stage area so Fit scale & pan bounds stay exact across panel resizes.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setStageSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pick up natural dimensions immediately if the image was already cached in memory.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
      setDims({ w: el.naturalWidth, h: el.naturalHeight });
    }
  }, [src]);

  const availW = Math.max(48, stageSize.w - STAGE_PAD * 2);
  const availH = Math.max(48, stageSize.h - STAGE_PAD * 2);
  const fitScale =
    dims && stageSize.w > 0 && stageSize.h > 0
      ? clamp(Math.min(1, availW / dims.w, availH / dims.h), MIN_ZOOM, 1)
      : 1;
  const effectiveScale = mode === 'fit' ? fitScale : customZoom;

  const clampPan = useCallback(
    (px: number, py: number, scale: number): { x: number; y: number } => {
      if (!dims || stageSize.w <= 0 || stageSize.h <= 0) return { x: 0, y: 0 };
      const maxX = Math.max(0, (dims.w * scale - stageSize.w) / 2 + STAGE_PAD);
      const maxY = Math.max(0, (dims.h * scale - stageSize.h) / 2 + STAGE_PAD);
      return { x: clamp(px, -maxX, maxX), y: clamp(py, -maxY, maxY) };
    },
    [dims, stageSize.w, stageSize.h],
  );

  const clampedPan = mode === 'fit' ? { x: 0, y: 0 } : clampPan(pan.x, pan.y, effectiveScale);
  const displayW = dims ? dims.w * effectiveScale : 0;
  const displayH = dims ? dims.h * effectiveScale : 0;
  const canPan =
    mode === 'custom' &&
    !!dims &&
    stageSize.w > 0 &&
    stageSize.h > 0 &&
    (displayW > stageSize.w - 4 || displayH > stageSize.h - 4);

  const liveRef = useRef({ effectiveScale, clampedPan, fitScale, mode, dims, clampPan });
  liveRef.current = { effectiveScale, clampedPan, fitScale, mode, dims, clampPan };

  const zoomTo = useCallback((rawNext: number, anchor?: { clientX: number; clientY: number }) => {
    const s = liveRef.current;
    const nextScale = clamp(rawNext, MIN_ZOOM, MAX_ZOOM);
    const oldScale = Math.max(0.01, s.effectiveScale);
    let nextX = 0;
    let nextY = 0;
    const stageEl = stageRef.current;
    if (anchor && stageEl) {
      const rect = stageEl.getBoundingClientRect();
      const mx = anchor.clientX - (rect.left + rect.width / 2);
      const my = anchor.clientY - (rect.top + rect.height / 2);
      const ix = (mx - s.clampedPan.x) / oldScale;
      const iy = (my - s.clampedPan.y) / oldScale;
      nextX = mx - ix * nextScale;
      nextY = my - iy * nextScale;
    } else if (s.mode === 'custom') {
      const ratio = nextScale / oldScale;
      nextX = s.clampedPan.x * ratio;
      nextY = s.clampedPan.y * ratio;
    }
    setMode('custom');
    setCustomZoom(nextScale);
    setPan(s.clampPan(nextX, nextY, nextScale));
  }, []);

  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      const cur = liveRef.current.effectiveScale;
      if (dir > 0) {
        const next = ZOOM_STEPS.find((z) => z >= cur * 1.12) ?? MAX_ZOOM;
        zoomTo(next);
      } else {
        let next = MIN_ZOOM;
        for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
          if (ZOOM_STEPS[i] <= cur / 1.12) {
            next = ZOOM_STEPS[i];
            break;
          }
        }
        zoomTo(next);
      }
    },
    [zoomTo],
  );

  const resetFit = useCallback(() => {
    setMode('fit');
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomActual = useCallback(() => {
    setMode('custom');
    setCustomZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Plain wheel zooms smoothly around the pointer; Ctrl/Cmd+wheel is left untouched for global UI zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.deltaY === 0) return;
      e.preventDefault();
      const delta = clamp(e.deltaY, -240, 240);
      const factor = Math.pow(1.0018, -delta);
      zoomTo(liveRef.current.effectiveScale * factor, { clientX: e.clientX, clientY: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canPan) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: clampedPan.x,
      origY: clampedPan.y,
    };
    setDragging(true);
  };

  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setPan(clampPan(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY), effectiveScale));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onStageDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode === 'fit') {
      const target = fitScale < 0.85 ? 1 : 2;
      zoomTo(target, { clientX: e.clientX, clientY: e.clientY });
    } else {
      resetFit();
    }
  };

  const handleZoomKey = useCallback(
    (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault(): void }) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomStep(1);
        return true;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomStep(-1);
        return true;
      }
      if (e.key === '0') {
        e.preventDefault();
        resetFit();
        return true;
      }
      if (e.key === '1') {
        e.preventDefault();
        zoomActual();
        return true;
      }
      return false;
    },
    [zoomStep, resetFit, zoomActual],
  );

  useEffect(() => {
    if (!listenWindowKeys) return;
    const onWinKey = (e: KeyboardEvent) => {
      handleZoomKey(e);
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  }, [listenWindowKeys, handleZoomKey]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (listenWindowKeys) return;
    handleZoomKey(e);
  };

  const pct = Math.max(1, Math.round(effectiveScale * 100));
  const isActual = mode === 'custom' && Math.abs(effectiveScale - 1) < 0.015;
  const useExplicitSize = !!dims && stageSize.w > 0 && stageSize.h > 0;
  const imgStyle = useExplicitSize
    ? {
        width: `${Math.max(1, Math.round(displayW))}px`,
        height: `${Math.max(1, Math.round(displayH))}px`,
        transform: `translate3d(${Math.round(clampedPan.x)}px, ${Math.round(clampedPan.y)}px, 0)`,
        imageRendering: effectiveScale >= 4 ? ('pixelated' as const) : undefined,
      }
    : undefined;

  const metaParts: string[] = [];
  if (dims) metaParts.push(`${dims.w} × ${dims.h}`);
  if (sizeText) metaParts.push(sizeText);

  return (
    <div
      className="insp-img-viewer"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-zoom-mode={mode}
      data-zoom-pct={pct}
    >
      <div
        ref={stageRef}
        className={`insp-img-stage ${canPan ? 'is-pannable' : ''} ${dragging ? 'is-dragging' : ''}`}
        data-testid={`${testIdPrefix}-stage`}
        title={canPan ? '拖动平移 · 滚轮缩放 · 双击恢复适应' : '滚轮缩放 · 双击放大'}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onStageDoubleClick}
      >
        <img
          ref={imgRef}
          className={`insp-img-el ${useExplicitSize ? 'is-sized' : 'is-fitting'}`}
          src={src}
          alt={alt}
          draggable={false}
          referrerPolicy={referrerPolicy}
          style={imgStyle}
          onLoad={(e) => {
            const el = e.currentTarget;
            const w = el.naturalWidth || el.clientWidth;
            const h = el.naturalHeight || el.clientHeight;
            if (w > 0 && h > 0) setDims({ w, h });
          }}
          onError={onError}
        />
      </div>

      <div className="insp-img-bar" data-testid={`${testIdPrefix}-toolbar`}>
        <span className="insp-image-meta">{metaParts.join(' · ')}</span>
        <div className="insp-img-controls">
          <button
            type="button"
            className="ghost insp-img-btn"
            data-testid={`${testIdPrefix}-zoom-out`}
            title="缩小 (−)"
            disabled={effectiveScale <= MIN_ZOOM + 0.001}
            onClick={() => zoomStep(-1)}
          >
            −
          </button>
          <span className="insp-img-pct" data-testid={`${testIdPrefix}-zoom-pct`}>{pct}%</span>
          <button
            type="button"
            className="ghost insp-img-btn"
            data-testid={`${testIdPrefix}-zoom-in`}
            title="放大 (+)"
            disabled={effectiveScale >= MAX_ZOOM - 0.001}
            onClick={() => zoomStep(1)}
          >
            +
          </button>
          <button
            type="button"
            className={`ghost insp-img-btn ${mode === 'fit' ? 'on' : ''}`}
            data-testid={`${testIdPrefix}-zoom-fit`}
            title="适应面板 (0)"
            onClick={resetFit}
          >
            适应
          </button>
          <button
            type="button"
            className={`ghost insp-img-btn ${isActual ? 'on' : ''}`}
            data-testid={`${testIdPrefix}-zoom-actual`}
            title="原始像素 1:1 (1)"
            onClick={zoomActual}
          >
            1:1
          </button>
          {onOpenFullscreen && (
            <button
              type="button"
              className="ghost insp-img-btn"
              data-testid={`${testIdPrefix}-zoom-fullscreen`}
              title="全屏放大查看"
              onClick={onOpenFullscreen}
            >
              全屏
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export interface ImageLightboxProps {
  src: string;
  alt: string;
  title?: string;
  sizeText?: string;
  referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  onClose: () => void;
}

export function ImageLightbox({
  src,
  alt,
  title,
  sizeText,
  referrerPolicy,
  onClose,
}: ImageLightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, []);

  const privacy = usePrivacy();
  const heading = title || alt || '图片预览';

  return createPortal(
    <div
      className={`sv-lightbox img-lightbox ${privacy ? 'is-privacy' : ''}`}
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={privacy ? '图片预览' : heading}
      onClick={onClose}
    >
      <div ref={panelRef} className="sv-lightbox-panel img-lightbox-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sv-lightbox-head">
          <span className="sv-lightbox-title" data-private="" title={privacy ? undefined : heading}>{heading}</span>
          <button ref={closeRef} type="button" className="sv-card-btn" data-testid="image-lightbox-close" onClick={onClose}>
            关闭 (Esc)
          </button>
        </div>
        <div className="sv-lightbox-body img-lightbox-body">
          <ImageZoomViewer
            key={src}
            src={src}
            alt={alt}
            sizeText={sizeText}
            referrerPolicy={referrerPolicy}
            testIdPrefix="lightbox-img"
            listenWindowKeys
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
