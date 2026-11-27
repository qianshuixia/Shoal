import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Marked, type Token, type Tokens } from 'marked';
import remend from 'remend';
import { ImageLightbox } from './ImageViewer.tsx';
import {
  findNextExplicitFilePathStart,
  isSingleExplicitFilePath,
  matchExplicitFilePathAtStart,
  splitExplicitFilePaths,
} from './linkParse.ts';
import {
  CodeBlockCard,
  EChartsDiagramCard,
  KatexMath,
  MermaidDiagramCard,
  RichTableCard,
} from './streamRich.tsx';

// ---- Dedicated Marked Instance with Display & Inline Math Extensions ----

interface MathBlockToken {
  type: 'mathBlock';
  raw: string;
  text: string;
}

interface MathInlineToken {
  type: 'mathInline';
  raw: string;
  text: string;
}

interface LocalFilePathToken {
  type: 'localFilePath';
  raw: string;
  path: string;
}

const streamMarked = new Marked({
  gfm: true,
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start(src: string) {
        return src.indexOf('$$');
      },
      tokenizer(src: string): MathBlockToken | undefined {
        const m = /^\$\$([ \t]*\n)?([\s\S]+?)(?:\n[ \t]*)?\$\$(?=\s*(?:\n|$))/.exec(src);
        if (!m) return undefined;
        return { type: 'mathBlock', raw: m[0], text: m[2].trim() };
      },
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src: string) {
        return src.indexOf('$');
      },
      tokenizer(src: string): MathInlineToken | undefined {
        // Avoid currency values like "$5", "$199.99": forbid leading/trailing space, forbid `$$`, and require non-digit after closing `$`.
        const m = /^\$(?!\$|\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
        if (!m) return undefined;
        const expr = m[1];
        // Ignore pure numeric ranges/currency-like expressions without math operators/letters.
        if (/^[\d.,\s]+$/.test(expr)) return undefined;
        return { type: 'mathInline', raw: m[0], text: expr };
      },
    },
    {
      // Runs before CommonMark's `escape` and `em` rules so Windows paths like `G:\proj\.studio\a_b_c.jpg`
      // never lose their `\.` backslash or get split into italics.
      name: 'localFilePath',
      level: 'inline',
      start(src: string) {
        return findNextExplicitFilePathStart(src);
      },
      tokenizer(src: string, tokens: Token[]): LocalFilePathToken | undefined {
        const prev = tokens[tokens.length - 1];
        const prevRaw = prev && 'raw' in prev ? String(prev.raw ?? '') : '';
        const prevChar = prevRaw ? prevRaw[prevRaw.length - 1] : undefined;
        const hit = matchExplicitFilePathAtStart(src, prevChar);
        if (!hit) return undefined;
        return { type: 'localFilePath', raw: hit.raw, path: hit.path };
      },
    },
  ],
});

// ---- GitHub Alerts / Callouts Detection (> [!NOTE] / TIP / IMPORTANT / WARNING / CAUTION) ----

type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const CALLOUT_META: Record<CalloutKind, { label: string; iconPath: string }> = {
  note: {
    label: '说明',
    iconPath: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm-.75 3h1.5v4h-1.5v-4Z',
  },
  tip: {
    label: '提示',
    iconPath: 'M8 1.5a4.5 4.5 0 0 0-2.5 8.24V11.5h5V9.74A4.5 4.5 0 0 0 8 1.5ZM6 12.75h4v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1Z',
  },
  important: {
    label: '重点',
    iconPath: 'M8 1.75 14.5 8 8 14.25 1.5 8 8 1.75Zm-.75 3.5v3.75h1.5V5.25h-1.5Zm0 5v1.5h1.5v-1.5h-1.5Z',
  },
  warning: {
    label: '注意',
    iconPath: 'M8 1.75 14.75 13.5H1.25L8 1.75Zm-.75 4.5v3.5h1.5v-3.5h-1.5Zm0 4.75v1.4h1.5V11h-1.5Z',
  },
  caution: {
    label: '警示',
    iconPath: 'M5.2 1.75h5.6l3.45 3.45v5.6l-3.45 3.45H5.2L1.75 10.8V5.2L5.2 1.75Zm2.05 3.25v4h1.5V5h-1.5Zm0 5.25v1.5h1.5v-1.5h-1.5Z',
  },
};

function parseCalloutBlockquote(tokens: Token[]): { kind: CalloutKind; bodyTokens: Token[] } | null {
  const first = tokens[0];
  if (!first || first.type !== 'paragraph') return null;
  const p = first as Tokens.Paragraph;
  const markerRe = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n)?/i;
  const m = markerRe.exec(p.text ?? '');
  if (!m) return null;

  const kind = m[1].toLowerCase() as CalloutKind;
  const restText = (p.text ?? '').slice(m[0].length).trimStart();
  const nextTokens: Token[] = [];
  if (restText) {
    const reparsed = streamMarked.lexer(restText);
    nextTokens.push(...reparsed);
  }
  nextTokens.push(...tokens.slice(1));
  return { kind, bodyTokens: nextTokens };
}

// ---- Smooth Adaptive Token Reveal (ink-on-paper opacity fade-in) ----

interface RevealSegment {
  key: number;
  text: string;
  at: number;
}

const TOKEN_SETTLE_MS = 280;
const REVEAL_FRAME_MS = 40;

export function SmoothText({
  text,
  active = true,
  className,
  testId,
}: {
  text: string;
  active?: boolean;
  className?: string;
  testId?: string;
}) {
  const targetRef = useRef(text);
  targetRef.current = text;

  const [shown, setShown] = useState(() => (active ? '' : text));
  const [, setSettleTick] = useState(0);
  const shownRef = useRef(shown);
  const segsRef = useRef<RevealSegment[]>([]);
  const settledLenRef = useRef(active ? 0 : text.length);
  const segKeyRef = useRef(0);
  const rafRef = useRef<number>(0);
  const settleTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    clearTimeout(settleTimerRef.current);
    if (!active) {
      cancelAnimationFrame(rafRef.current);
      segsRef.current = [];
      settledLenRef.current = text.length;
      shownRef.current = text;
      setShown(text);
      return;
    }

    const cur = shownRef.current;
    if (cur.length > text.length || !text.startsWith(cur)) {
      let keepLen = Math.min(cur.length, text.length);
      if (keepLen > 0 && keepLen < text.length) {
        const prevCode = text.charCodeAt(keepLen - 1);
        if (prevCode >= 0xd800 && prevCode <= 0xdbff) keepLen--;
      }
      segsRef.current = [];
      settledLenRef.current = keepLen;
      shownRef.current = text.slice(0, keepLen);
      setShown(shownRef.current);
    }

    const step = () => {
      const target = targetRef.current;
      const now = performance.now();
      while (segsRef.current.length > 0 && now - segsRef.current[0].at >= TOKEN_SETTLE_MS) {
        settledLenRef.current += segsRef.current.shift()!.text.length;
      }

      const curText = shownRef.current;
      if (curText.length < target.length) {
        const remain = target.length - curText.length;
        const take = remain <= 8 ? Math.min(remain, 2) : Math.max(3, Math.ceil(remain * 0.25));
        let end = Math.min(target.length, curText.length + take);
        if (end < target.length) {
          const code = target.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) end++;
        }
        const slice = target.slice(curText.length, end);
        segsRef.current.push({ key: segKeyRef.current++, text: slice, at: now });
        shownRef.current = target.slice(0, end);
        setShown(shownRef.current);
        rafRef.current = requestAnimationFrame(step);
      } else if (segsRef.current.length > 0) {
        const newestAt = segsRef.current[segsRef.current.length - 1].at;
        const waitMs = Math.max(16, TOKEN_SETTLE_MS - (now - newestAt) + 16);
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = window.setTimeout(() => {
          settledLenRef.current = shownRef.current.length;
          segsRef.current = [];
          setSettleTick((n) => n + 1);
        }, waitMs);
      }
    };

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(settleTimerRef.current);
    };
  }, [text, active]);

  if (!active || segsRef.current.length === 0) {
    return <span className={className} data-testid={testId}>{shown}</span>;
  }

  const prefix = shown.slice(0, settledLenRef.current);
  return (
    <span className={className} data-testid={testId}>
      {prefix}
      {segsRef.current.map((s) => (
        <span key={s.key} className="sv-token">{s.text}</span>
      ))}
    </span>
  );
}

// ---- Lossless Markdown Renderer with Charts, Shiki, KaTeX, Alerts & Clickable File Links ----

function isSafeExternalUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function decodeFileHref(href: string): string | null {
  try {
    const u = new URL(href);
    if (u.protocol !== 'file:') return null;
    if (u.host && u.host.toLowerCase() !== 'localhost') return null;
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    const lineMatch = /^#L(\d+)/i.exec(u.hash);
    return lineMatch ? `${p}:${lineMatch[1]}` : p;
  } catch {
    return null;
  }
}

function shortFileLabel(label: string, filePath: string): string {
  if (label && !/^file:/i.test(label) && !/^[A-Za-z]:[\\/]/.test(label)) return label;
  const clean = filePath.replace(/:\d+$/, '').replaceAll('\\', '/').replace(/\/+$/, '');
  return clean.split('/').pop() || label || filePath;
}

function joinProjectPath(projectPath: string | undefined, rel: string): string | null {
  const hashIdx = rel.indexOf('#');
  const frag = hashIdx >= 0 ? rel.slice(hashIdx) : '';
  const lineMatch = /^#L(\d+)/i.exec(frag);
  const clean = (hashIdx >= 0 ? rel.slice(0, hashIdx) : rel).split('?')[0].trim();
  if (!clean || clean.startsWith('//') || clean.startsWith('\\\\')) return null;
  const segs = clean.replaceAll('\\', '/').split('/');
  if (segs.includes('..')) return null;
  const suffix = lineMatch ? `:${lineMatch[1]}` : '';
  if (/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('/')) return `${clean}${suffix}`;
  if (!projectPath) return null;
  const base = projectPath.replaceAll('\\', '/').replace(/\/+$/, '');
  return `${base}/${clean.replace(/^\.\//, '')}${suffix}`;
}

// ---- Inline renderer (module-level and pure so table cells can reuse it with a stable callback) ----

interface InlineCtx {
  projectPath?: string;
  onInspectFile?: (filePath: string) => void;
  privacy?: boolean;
  insideLink?: boolean;
}

function isAllowedImageSrc(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^\/api\//.test(href);
}

function fileTitle(filePath: string, privacy?: boolean): string {
  if (!privacy) return `在右侧面板查看：${filePath}`;
  const clean = filePath.replace(/(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?)$/i, '').replaceAll('\\', '/').replace(/\/+$/, '');
  return `在右侧面板查看 ${clean.split('/').pop() || '文件'}`;
}

function renderClickablePath(text: string, filePath: string, key: string, ctx: InlineCtx, isCode = false): ReactNode {
  const inspect = ctx.onInspectFile;
  if (!inspect || ctx.insideLink) {
    return isCode ? <code key={key} className="sv-inline-code">{text}</code> : text;
  }
  return (
    <span
      key={key}
      role="button"
      tabIndex={0}
      className={isCode ? 'sv-inline-code sv-path-link is-code' : 'sv-path-link'}
      data-testid="sv-path-link"
      data-file-path={filePath}
      title={fileTitle(filePath, ctx.privacy)}
      onClick={() => {
        if (window.getSelection()?.toString()) return;
        inspect(filePath);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inspect(filePath);
        }
      }}
    >
      {text}
    </span>
  );
}

function MarkdownImage({
  src,
  alt,
  insideLink = false,
  privacy = false,
}: {
  src: string;
  alt: string;
  insideLink?: boolean;
  privacy?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const external = /^https?:\/\//i.test(src);
  if (failed) return <span className="sv-md-img-fallback">{alt ? `[图片：${alt}]` : '[图片加载失败]'}</span>;
  const imgNode = (
    <img
      className="sv-md-img"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy={external ? 'no-referrer' : undefined}
      onError={() => setFailed(true)}
    />
  );
  if (insideLink) return imgNode;
  return (
    <>
      <button type="button" className="sv-md-img-btn" onClick={() => setZoomed(true)} title={privacy ? '点击放大' : (alt || '点击放大')}>
        {imgNode}
      </button>
      {zoomed && (
        <ImageLightbox
          src={src}
          alt={alt}
          title={alt || '图片预览'}
          referrerPolicy={external ? 'no-referrer' : undefined}
          onClose={() => setZoomed(false)}
        />
      )}
    </>
  );
}

function renderInlineTokens(list: Token[] | undefined, keyPrefix: string, ctx: InlineCtx): ReactNode {
  if (!list || list.length === 0) return null;
  return list.map((tok, idx) => {
    const k = `${keyPrefix}-${idx}`;
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) return <span key={k}>{renderInlineTokens(t.tokens, k, ctx)}</span>;
        if (!ctx.insideLink && ctx.onInspectFile && ctx.projectPath?.startsWith('/') && t.text.includes(ctx.projectPath)) {
          const segs = splitExplicitFilePaths(t.text, ctx.projectPath);
          if (segs.some((s) => s.kind === 'file')) {
            return (
              <span key={k}>
                {segs.map((seg, si) => (seg.kind === 'file' ? renderClickablePath(seg.text, seg.path, `${k}-p-${si}`, ctx) : seg.text))}
              </span>
            );
          }
        }
        return t.text;
      }
      case 'localFilePath': {
        const fp = tok as unknown as LocalFilePathToken;
        return renderClickablePath(fp.raw, fp.path, k, ctx);
      }
      case 'escape':
        return (tok as Tokens.Escape).text;
      case 'strong':
        return <strong key={k}>{renderInlineTokens((tok as Tokens.Strong).tokens, k, ctx)}</strong>;
      case 'em':
        return <em key={k}>{renderInlineTokens((tok as Tokens.Em).tokens, k, ctx)}</em>;
      case 'del':
        return <del key={k}>{renderInlineTokens((tok as Tokens.Del).tokens, k, ctx)}</del>;
      case 'codespan': {
        const text = (tok as Tokens.Codespan).text;
        const explicit = !ctx.insideLink && ctx.onInspectFile ? isSingleExplicitFilePath(text, ctx.projectPath) : null;
        if (explicit) return renderClickablePath(text, explicit, k, ctx, true);
        return <code key={k} className="sv-inline-code">{text}</code>;
      }
      case 'mathInline':
        return <KatexMath key={k} expr={(tok as unknown as MathInlineToken).text} display={false} />;
      case 'br':
        return <br key={k} />;
      case 'checkbox':
        return null;
      case 'link': {
        const l = tok as Tokens.Link;
        const href = (l.href ?? '').trim();
        const linkCtx = ctx.insideLink ? ctx : { ...ctx, insideLink: true };
        const children = renderInlineTokens(l.tokens, k, linkCtx) || l.text;
        if (/^file:/i.test(href)) {
          const fp = decodeFileHref(href);
          const inspect = ctx.onInspectFile;
          if (!fp || !inspect) return <span key={k} className="sv-file-ref">{shortFileLabel(l.text, fp ?? href)}</span>;
          return (
            <button
              type="button"
              key={k}
              className="sv-file-link"
              title={fileTitle(fp, ctx.privacy)}
              onClick={() => inspect(fp)}
            >
              {shortFileLabel(l.text, fp)}
            </button>
          );
        }
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
          if (!isSafeExternalUrl(href)) return <span key={k}>{children}</span>;
          return (
            <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="sv-ext-link">
              {children}
            </a>
          );
        }
        if (href.startsWith('#')) return <span key={k}>{children}</span>;
        const abs = joinProjectPath(ctx.projectPath, href);
        const inspectRel = ctx.onInspectFile;
        if (abs && inspectRel) {
          return (
            <button type="button" key={k} className="sv-file-link" title={fileTitle(abs, ctx.privacy)} onClick={() => inspectRel(abs)}>
              {children}
            </button>
          );
        }
        return <span key={k}>{children}</span>;
      }
      case 'image': {
        const img = tok as Tokens.Image;
        const href = (img.href ?? '').trim();
        const alt = img.text || '';
        if (!isAllowedImageSrc(href)) return <span key={k} className="sv-md-img-fallback">{alt ? `[图片：${alt}]` : '[图片]'}</span>;
        return <MarkdownImage key={k} src={href} alt={alt} insideLink={ctx.insideLink} privacy={ctx.privacy} />;
      }
      case 'html':
        return <code key={k} className="sv-inline-code">{(tok as Tokens.HTML).raw}</code>;
      default:
        return 'raw' in tok ? String(tok.raw ?? '') : null;
    }
  });
}

export interface StreamMarkdownProps {
  content: string;
  projectPath?: string;
  onInspectFile?: (filePath: string) => void;
  animateEntrance?: boolean;
  initialRevealedChars?: number;
  // Live (still growing) text: skip Shiki / chart rendering until settled, show light skeletons for unclosed viz fences.
  streaming?: boolean;
  // Privacy mode: never expose full local absolute paths in link/file-chip titles.
  privacy?: boolean;
}

// Self-heals incomplete streaming Markdown (unclosed fences, bold/italic, links, math blocks) via `remend`.
function stabilizePartialMarkdown(slice: string): string {
  let healed = remend(slice, { linkMode: 'text-only', singleTilde: true });
  const fences = healed.match(/^```/gm);
  if (fences && fences.length % 2 === 1) healed = `${healed}\n\`\`\``;
  return healed;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const StreamMarkdown = memo(function StreamMarkdown({
  content,
  projectPath,
  onInspectFile,
  animateEntrance = false,
  initialRevealedChars = 0,
  streaming = false,
  privacy = false,
}: StreamMarkdownProps) {
  // Live text is already arriving incrementally: never layer the per-character reveal on top of it.
  const shouldReveal = animateEntrance && !streaming && !prefersReducedMotion() && content.length > 0;
  const [revealLen, setRevealLen] = useState<number>(() => {
    if (!shouldReveal) return content.length;
    return Math.min(content.length, Math.max(0, initialRevealedChars));
  });
  const revealRef = useRef(revealLen);
  revealRef.current = revealLen;

  useEffect(() => {
    if (!shouldReveal) {
      setRevealLen(content.length);
      return;
    }
    if (revealRef.current >= content.length) {
      setRevealLen(content.length);
      return;
    }
    let raf = 0;
    let lastTs = performance.now();
    const totalRemain = content.length - revealRef.current;
    const targetDurationMs = Math.min(1150, Math.max(280, totalRemain * 3.2));
    const charsPerMs = Math.max(0.08, totalRemain / targetDurationMs);

    const tick = (now: number) => {
      // Commit at most every REVEAL_FRAME_MS: each commit re-runs remend + lexer over the whole visible prefix.
      if (now - lastTs < REVEAL_FRAME_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(120, now - lastTs);
      lastTs = now;
      const cur = revealRef.current;
      if (cur >= content.length) return;
      const remain = content.length - cur;
      const step = Math.max(2, Math.ceil(charsPerMs * dt));
      let next = Math.min(content.length, cur + Math.min(remain, step));
      if (next < content.length) {
        const code = content.charCodeAt(next - 1);
        if (code >= 0xd800 && code <= 0xdbff) next++;
      }
      revealRef.current = next;
      setRevealLen(next);
      if (next < content.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [content, shouldReveal]);

  const revealing = shouldReveal && revealLen < content.length;
  const visibleContent = useMemo(() => {
    if (revealing) return stabilizePartialMarkdown(content.slice(0, revealLen));
    return streaming ? stabilizePartialMarkdown(content) : content;
  }, [content, revealing, revealLen, streaming]);
  const tokens = useMemo(() => streamMarked.lexer(visibleContent), [visibleContent]);
  // True while the last fence is still open: only that tail block is "growing" (settled blocks above render normally).
  const unclosedFence = useMemo(
    () => streaming && ((content.match(/^```/gm)?.length ?? 0) % 2 === 1),
    [content, streaming],
  );

  const inlineCtx = useMemo<InlineCtx>(
    () => ({ projectPath, onInspectFile, privacy }),
    [projectPath, onInspectFile, privacy],
  );
  // Stable identity (only changes with the ctx) so memoized children such as RichTableCard are not rebuilt per frame.
  const renderInline = useCallback(
    (list: Token[] | undefined, keyPrefix: string): ReactNode => renderInlineTokens(list, keyPrefix, inlineCtx),
    [inlineCtx],
  );

  const renderBlocks = (list: Token[], keyPrefix: string, stagger = false): ReactNode =>
    list.map((tok, idx) => {
      const k = `${keyPrefix}-${idx}`;
      const cls = stagger ? 'sv-block-enter' : undefined;
      const delayStyle = stagger ? { animationDelay: `${Math.min(idx * 28, 180)}ms` } : undefined;
      switch (tok.type) {
        case 'space':
          return null;
        case 'hr':
          return <hr key={k} className={cls} style={delayStyle} />;
        case 'heading': {
          const h = tok as Tokens.Heading;
          const children = renderInline(h.tokens, k);
          if (h.depth === 1) return <h1 key={k} className={cls} style={delayStyle}>{children}</h1>;
          if (h.depth === 2) return <h2 key={k} className={cls} style={delayStyle}>{children}</h2>;
          if (h.depth === 3) return <h3 key={k} className={cls} style={delayStyle}>{children}</h3>;
          if (h.depth === 4) return <h4 key={k} className={cls} style={delayStyle}>{children}</h4>;
          return <h5 key={k} className={cls} style={delayStyle}>{children}</h5>;
        }
        case 'paragraph':
          return <p key={k} className={cls} style={delayStyle}>{renderInline((tok as Tokens.Paragraph).tokens, k)}</p>;
        case 'text': {
          const t = tok as Tokens.Text;
          return <p key={k} className={cls} style={delayStyle}>{t.tokens ? renderInline(t.tokens, k) : t.text}</p>;
        }
        case 'mathBlock':
          return (
            <div key={k} className={cls} style={delayStyle}>
              <KatexMath expr={(tok as unknown as MathBlockToken).text} display />
            </div>
          );
        case 'code': {
          const c = tok as Tokens.Code;
          const lang = (c.lang ?? '').trim().toLowerCase().split(/[\s{]/)[0] ?? '';
          const isTailBlock = (revealing || unclosedFence) && idx === list.length - 1 && list === tokens;
          if (lang === 'mermaid') {
            return (
              <div key={k} className={cls} style={delayStyle}>
                <MermaidDiagramCard code={c.text} streaming={isTailBlock} />
              </div>
            );
          }
          if (lang === 'echarts' || lang === 'chart') {
            return (
              <div key={k} className={cls} style={delayStyle}>
                <EChartsDiagramCard code={c.text} streaming={isTailBlock} />
              </div>
            );
          }
          if (lang === 'math' || lang === 'latex' || lang === 'katex') {
            return (
              <div key={k} className={cls} style={delayStyle}>
                <KatexMath expr={c.text} display />
              </div>
            );
          }
          return (
            <div key={k} className={cls} style={delayStyle}>
              <CodeBlockCard lang={c.lang} text={c.text} streaming={isTailBlock} />
            </div>
          );
        }
        case 'blockquote': {
          const bq = tok as Tokens.Blockquote;
          const callout = parseCalloutBlockquote(bq.tokens);
          if (callout) {
            const meta = CALLOUT_META[callout.kind];
            return (
              <aside
                key={k}
                className={`sv-callout is-${callout.kind} ${cls ?? ''}`}
                data-testid="sv-callout"
                data-kind={callout.kind}
                style={delayStyle}
              >
                <div className="sv-callout-head">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d={meta.iconPath} />
                  </svg>
                  <span>{meta.label}</span>
                </div>
                <div className="sv-callout-body">{renderBlocks(callout.bodyTokens, `${k}-co`)}</div>
              </aside>
            );
          }
          return <blockquote key={k} className={cls} style={delayStyle}>{renderBlocks(bq.tokens, k)}</blockquote>;
        }
        case 'list': {
          const l = tok as Tokens.List;
          const items = l.items.map((item, ii) => {
            const ik = `${k}-li-${ii}`;
            return (
              <li key={ik} className={item.task ? 'sv-task-item' : undefined}>
                {item.task && <input type="checkbox" checked={!!item.checked} readOnly tabIndex={-1} />}
                <div className="sv-li-body">{renderBlocks(item.tokens, ik)}</div>
              </li>
            );
          });
          return l.ordered
            ? <ol key={k} start={l.start || 1} className={cls} style={delayStyle}>{items}</ol>
            : <ul key={k} className={cls} style={delayStyle}>{items}</ul>;
        }
        case 'table': {
          const tb = tok as Tokens.Table;
          return (
            <div key={k} className={cls} style={delayStyle}>
              <RichTableCard table={tb} keyPrefix={k} renderInline={renderInline} />
            </div>
          );
        }
        case 'html': {
          const rawHtml = (tok as Tokens.HTML).raw;
          if (/^\s*<!--[\s\S]*-->\s*$/.test(rawHtml)) return null;
          return <pre key={k} className={`sv-raw-html ${cls ?? ''}`} style={delayStyle}>{rawHtml}</pre>;
        }
        default:
          return null;
      }
    });

  return (
    <div className={`sv-md ${revealing ? 'is-revealing' : ''}`} data-testid="sv-markdown">
      {renderBlocks(tokens, 'sv', animateEntrance && !shouldReveal)}
    </div>
  );
});
