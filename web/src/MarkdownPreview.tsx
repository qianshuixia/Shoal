import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { ImageLightbox } from './ImageViewer.tsx';
import { usePrivacy } from './privacy.ts';

export interface MarkdownPreviewProps {
  projectId: string;
  filePath: string; // POSIX relative path of the markdown file (e.g. "docs/inspector-spec.md")
  content: string;
  onOpenRelPath?: (relPath: string, line?: number) => void;
}

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Resolves a relative POSIX href against the current markdown file's directory inside the project.
// Returns null if it escapes above the project root.
function resolveRelativePosix(baseFilePosix: string, relHref: string): string | null {
  const dirParts = baseFilePosix.includes('/') ? baseFilePosix.split('/').slice(0, -1) : [];
  const rawParts = relHref.replace(/\\/g, '/').split('/');
  const stack = [...dirParts];
  for (const part of rawParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null; // escaped project root
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack.join('/') : null;
}

function isSafeExternalUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

// External images are not requested until the user clicks, so previewing a file never silently pings third parties.
function ExternalImage({ src, alt, privacy, onZoom }: { src: string; alt: string; privacy: boolean; onZoom?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="md-muted">[图片加载失败：{alt || src}]</span>;
  if (!loaded) {
    return (
      <button
        type="button"
        className="md-img-placeholder"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setLoaded(true);
        }}
        title="将向外部服务器请求该图片"
      >
        点击加载外部图片{alt ? `（${alt}）` : ''}
      </button>
    );
  }
  const imgNode = (
    <img
      className="md-img"
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
  if (!onZoom) return imgNode;
  return (
    <button type="button" className="md-img-zoom-btn" onClick={onZoom} title={privacy ? '点击放大' : (alt ? `点击放大：${alt}` : '点击放大')}>
      {imgNode}
    </button>
  );
}

export function MarkdownPreview({ projectId, filePath, content, onOpenRelPath }: MarkdownPreviewProps) {
  const tokens = useMemo(() => marked.lexer(content, { gfm: true }), [content]);
  const [zoomImg, setZoomImg] = useState<{ src: string; alt: string; title: string; external?: boolean } | null>(null);
  const privacy = usePrivacy();

  const renderInline = (list: Token[] | undefined, keyPrefix: string, insideLink = false): ReactNode => {
    if (!list || list.length === 0) return null;
    return list.map((tok, idx) => {
      const k = `${keyPrefix}-${idx}`;
      switch (tok.type) {
        case 'text': {
          const t = tok as Tokens.Text;
          if (t.tokens && t.tokens.length > 0) return <span key={k}>{renderInline(t.tokens, k, insideLink)}</span>;
          return t.text;
        }
        case 'escape':
          return (tok as Tokens.Escape).text;
        case 'strong':
          return <strong key={k}>{renderInline((tok as Tokens.Strong).tokens, k, insideLink)}</strong>;
        case 'em':
          return <em key={k}>{renderInline((tok as Tokens.Em).tokens, k, insideLink)}</em>;
        case 'del':
          return <del key={k}>{renderInline((tok as Tokens.Del).tokens, k, insideLink)}</del>;
        case 'codespan':
          return <code key={k} className="md-inline-code">{(tok as Tokens.Codespan).text}</code>;
        case 'br':
          return <br key={k} />;
        case 'link': {
          const l = tok as Tokens.Link;
          const href = (l.href ?? '').trim();
          const children = renderInline(l.tokens, k, true) || l.text;
          if (href.startsWith('#')) {
            return <span key={k} className="md-anchor-link">{children}</span>;
          }
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
            if (!isSafeExternalUrl(href)) {
              // Unsafe scheme (e.g. javascript:, data:, vbscript:) -> render inert plain text!
              return <span key={k}>{children}</span>;
            }
            return (
              <a key={k} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          }
          // Project-relative file link (optional #L12 suffix)
          const hashIdx = href.indexOf('#');
          const cleanPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
          const frag = hashIdx === -1 ? '' : href.slice(hashIdx);
          const lineMatch = /^#L(\d+)/i.exec(frag);
          const targetRel = resolveRelativePosix(filePath, safeDecodeURIComponent(cleanPart));
          if (!targetRel || !onOpenRelPath) return <span key={k}>{children}</span>;
          return (
            <a
              key={k}
              href={`#${targetRel}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenRelPath(targetRel, lineMatch ? Number(lineMatch[1]) : undefined);
              }}
            >
              {children}
            </a>
          );
        }
        case 'image': {
          const img = tok as Tokens.Image;
          const href = (img.href ?? '').trim();
          const alt = img.text || '';
          let src: string | null = null;
          let title = alt;
          if (/^https?:\/\//i.test(href)) {
            return (
              <ExternalImage
                key={k}
                src={href}
                alt={alt}
                privacy={privacy}
                onZoom={insideLink ? undefined : () => setZoomImg({ src: href, alt, title: alt || href, external: true })}
              />
            );
          } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
            const rel = resolveRelativePosix(filePath, safeDecodeURIComponent(href.split('#')[0].split('?')[0]));
            if (rel) {
              src = `/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(rel)}`;
              title = alt || rel;
            }
          }
          if (!src) return <span key={k} className="md-muted">[图片：{alt || href}]</span>;
          const imgSrc = src;
          const imgTitle = title;
          const imgNode = <img className="md-img" src={imgSrc} alt={alt} loading="lazy" />;
          if (insideLink) return <span key={k}>{imgNode}</span>;
          return (
            <button
              key={k}
              type="button"
              className="md-img-zoom-btn"
              title={privacy ? '点击放大' : (alt ? `点击放大：${alt}` : '点击放大')}
              onClick={() => setZoomImg({ src: imgSrc, alt, title: imgTitle })}
            >
              {imgNode}
            </button>
          );
        }
        case 'html':
          // Never execute raw HTML tags inside Markdown: render literal text safely.
          return <code key={k} className="md-raw-html">{(tok as Tokens.HTML).raw}</code>;
        default:
          return 'raw' in tok ? String(tok.raw ?? '') : null;
      }
    });
  };

  const renderBlocks = (list: Token[], keyPrefix: string): ReactNode =>
    list.map((tok, idx) => {
      const k = `${keyPrefix}-${idx}`;
      switch (tok.type) {
        case 'space':
          return null;
        case 'hr':
          return <hr key={k} />;
        case 'heading': {
          const h = tok as Tokens.Heading;
          const children = renderInline(h.tokens, k);
          if (h.depth === 1) return <h1 key={k}>{children}</h1>;
          if (h.depth === 2) return <h2 key={k}>{children}</h2>;
          if (h.depth === 3) return <h3 key={k}>{children}</h3>;
          if (h.depth === 4) return <h4 key={k}>{children}</h4>;
          return <h5 key={k}>{children}</h5>;
        }
        case 'paragraph':
          return <p key={k}>{renderInline((tok as Tokens.Paragraph).tokens, k)}</p>;
        case 'text': {
          const t = tok as Tokens.Text;
          return <p key={k}>{t.tokens ? renderInline(t.tokens, k) : t.text}</p>;
        }
        case 'code': {
          const c = tok as Tokens.Code;
          return (
            <pre key={k} className="md-pre" data-lang={c.lang || undefined}>
              <code>{c.text}</code>
            </pre>
          );
        }
        case 'blockquote':
          return <blockquote key={k}>{renderBlocks((tok as Tokens.Blockquote).tokens, k)}</blockquote>;
        case 'list': {
          const l = tok as Tokens.List;
          const items = l.items.map((item, ii) => {
            const ik = `${k}-li-${ii}`;
            return (
              <li key={ik} className={item.task ? 'md-task-item' : undefined}>
                {item.task && <input type="checkbox" checked={!!item.checked} readOnly tabIndex={-1} />}
                <div className="md-li-body">{renderBlocks(item.tokens, ik)}</div>
              </li>
            );
          });
          return l.ordered ? <ol key={k} start={l.start || 1}>{items}</ol> : <ul key={k}>{items}</ul>;
        }
        case 'table': {
          const tb = tok as Tokens.Table;
          return (
            <div key={k} className="md-table-wrap">
              <table>
                <thead>
                  <tr>
                    {tb.header.map((cell, ci) => (
                      <th key={ci} style={{ textAlign: tb.align[ci] ?? undefined }}>
                        {renderInline(cell.tokens, `${k}-th-${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{ textAlign: tb.align[ci] ?? undefined }}>
                          {renderInline(cell.tokens, `${k}-td-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        case 'html':
          // Block-level raw HTML (comments or tags): hide HTML comments, render other raw HTML as escaped literal block.
          if (/^\s*<!--[\s\S]*-->\s*$/.test((tok as Tokens.HTML).raw)) return null;
          return <pre key={k} className="md-raw-block">{(tok as Tokens.HTML).raw}</pre>;
        default:
          return null;
      }
    });

  return (
    <article className="md-preview" data-testid="markdown-preview">
      {renderBlocks(tokens, 'md')}
      {zoomImg && (
        <ImageLightbox
          src={zoomImg.src}
          alt={zoomImg.alt}
          title={zoomImg.title}
          referrerPolicy={zoomImg.external ? 'no-referrer' : undefined}
          onClose={() => setZoomImg(null)}
        />
      )}
    </article>
  );
}
