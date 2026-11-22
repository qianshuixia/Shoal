import { useEffect, useRef, useState } from 'react';
import type { RawPreviewKind } from '../../shared/protocol.ts';

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

export interface RawPreviewProps {
  kind: RawPreviewKind;
  src: string;
  path: string;
  size: number;
  onOpenExternal: () => void;
}

// Chromium's PDF viewer accepts a header anywhere in the first 1 KB, so probe the same window.
const PDF_PROBE_BYTES = 1024;

// Inline preview of image / video / audio / pdf served by /raw. Callers pass key={src} so a new file remounts with fresh state.
export function RawPreview({ kind, src, path, size, onOpenExternal }: RawPreviewProps) {
  const [failure, setFailure] = useState<string | null>(null);
  // An iframe gives no load-error signal for a broken PDF (the viewer just shows its own blank page), so check the header first.
  const [pdfChecked, setPdfChecked] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const sizeText = formatBytes(size);

  useEffect(() => {
    if (kind !== 'pdf') return;
    if (navigator.pdfViewerEnabled === false) {
      setFailure(`当前环境没有内置 PDF 查看器，无法在面板内预览（${sizeText}）。`);
      return;
    }
    const ctrl = new AbortController();
    fetch(src, { headers: { Range: `bytes=0-${PDF_PROBE_BYTES - 1}` }, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const head = new Uint8Array(await r.arrayBuffer()).subarray(0, PDF_PROBE_BYTES);
        if (ctrl.signal.aborted) return;
        if (!String.fromCharCode(...head).includes('%PDF-')) throw new Error('missing %PDF- header');
        setPdfChecked(true);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailure(`无法预览此 PDF（${sizeText}），文件可能已损坏或不是有效的 PDF。`);
      });
    return () => ctrl.abort();
  }, [kind, src, sizeText]);

  // Removing a <video>/<audio> node does not reliably cancel its download in every engine; detach the source on unmount.
  // The isConnected guard skips StrictMode's simulated unmount, where the element is still in the document.
  useEffect(() => {
    const el = mediaRef.current;
    return () => {
      if (!el || el.isConnected) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, []);

  if (failure !== null) {
    return (
      <div className="insp-placeholder" data-testid="media-unsupported">
        <div>{failure}</div>
        <button type="button" onClick={onOpenExternal}>在外部打开</button>
      </div>
    );
  }

  if (kind === 'pdf') {
    if (!pdfChecked) {
      return (
        <div className="insp-pdf-wrap" data-testid="pdf-preview">
          <div className="insp-placeholder">正在加载…</div>
        </div>
      );
    }
    // The header probe cannot catch a PDF that is damaged further in, and the viewer gives the page no error signal,
    // so the external-open action stays visible under it.
    return (
      <div className="insp-pdf-wrap" data-testid="pdf-preview">
        {/* No sandbox attribute: sandboxing disables the built-in PDF viewer. */}
        <iframe src={src} title={path} />
        <div className="insp-pdf-bar">
          <span>{sizeText}</span>
          <button type="button" data-testid="pdf-open-external" onClick={onOpenExternal}>在外部打开</button>
        </div>
      </div>
    );
  }

  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toUpperCase() ?? '未知';
  const onMediaError = () => setFailure(`内置播放器无法播放此文件（${ext}，${sizeText}），可能是编码格式不受支持。`);
  return (
    <div className="insp-image-wrap" data-testid={`${kind}-preview`}>
      {kind === 'image' ? (
        <img src={src} alt={path} onError={() => setFailure(`无法预览此图片（${sizeText}）。`)} />
      ) : kind === 'video' ? (
        <video ref={(el) => { mediaRef.current = el; }} className="insp-video" controls preload="metadata" src={src} onError={onMediaError} />
      ) : (
        <audio ref={(el) => { mediaRef.current = el; }} className="insp-audio" controls preload="metadata" src={src} onError={onMediaError} />
      )}
      <div className="insp-image-meta">{sizeText}</div>
    </div>
  );
}
