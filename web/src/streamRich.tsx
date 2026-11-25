import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Tokens } from 'marked';

// ---- Synchronous Fallback Highlighter (instant paint while Shiki grammar loads) ----

type HlKind = 'cm' | 'str' | 'kw' | 'num' | 'fn' | 'flag' | 'add' | 'del' | 'hunk';

interface HlSpan {
  kind?: HlKind;
  text: string;
}

const CODE_KW = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'defer',
  'def', 'del', 'do', 'elif', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for', 'from',
  'func', 'function', 'go', 'if', 'impl', 'import', 'in', 'interface', 'is', 'lambda', 'let', 'loop', 'match',
  'mod', 'mut', 'new', 'nil', 'None', 'not', 'null', 'or', 'package', 'pass', 'private', 'protected', 'pub',
  'public', 'raise', 'range', 'readonly', 'return', 'select', 'self', 'Self', 'static', 'struct', 'super',
  'switch', 'this', 'throw', 'trait', 'true', 'True', 'False', 'try', 'type', 'typeof', 'undefined', 'unsafe',
  'use', 'var', 'void', 'where', 'while', 'with', 'yield',
]);

const SHELL_KW = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'in', 'function',
  'export', 'local', 'return', 'sudo', 'grep', 'rg', 'ioreg', 'git', 'npm', 'node', 'python', 'curl', 'cd',
  'ls', 'cat', 'echo', 'find', 'sed', 'awk', 'xargs', 'pwsh', 'powershell',
]);

const SQL_KW = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
  'INDEX', 'ALTER', 'DROP', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON', 'GROUP', 'BY', 'ORDER', 'LIMIT',
  'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IN', 'IS', 'DISTINCT', 'UNION', 'ALL', 'EXPLAIN', 'QUERY', 'PLAN',
]);

function highlightLineDiff(code: string): HlSpan[] {
  const spans: HlSpan[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nl = i < lines.length - 1 ? '\n' : '';
    if (line.startsWith('@@')) spans.push({ kind: 'hunk', text: line + nl });
    else if (line.startsWith('+') && !line.startsWith('+++')) spans.push({ kind: 'add', text: line + nl });
    else if (line.startsWith('-') && !line.startsWith('---')) spans.push({ kind: 'del', text: line + nl });
    else spans.push({ text: line + nl });
  }
  return spans;
}

function highlightCodeFallback(code: string, rawLang?: string): HlSpan[] {
  const lang = (rawLang ?? '').trim().toLowerCase();
  if (lang === 'diff' || lang === 'patch') return highlightLineDiff(code);

  const isShell = lang === 'sh' || lang === 'bash' || lang === 'zsh' || lang === 'shell' || lang === 'pwsh' || lang === 'powershell' || lang === 'cmd';
  const isPython = lang === 'py' || lang === 'python';
  const isJson = lang === 'json' || lang === 'jsonc';
  const isSql = lang === 'sql';
  const isHashComment = isShell || isPython || lang === 'yaml' || lang === 'yml' || lang === 'toml';

  const tokenRe = isHashComment
    ? /(#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?:^|(?<=\s))--?[a-zA-Z0-9_-]+|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gm
    : isSql
      ? /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
      : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;

  const spans: HlSpan[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(code)) !== null) {
    if (m.index > last) spans.push({ text: code.slice(last, m.index) });
    const tok = m[0];
    let kind: HlKind | undefined;

    if (tok.startsWith('//') || tok.startsWith('/*') || (isHashComment && tok.startsWith('#')) || (isSql && tok.startsWith('--'))) {
      kind = 'cm';
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      if (isJson) {
        let j = m.index + tok.length;
        while (j < code.length && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
        kind = code[j] === ':' ? 'flag' : 'str';
      } else {
        kind = 'str';
      }
    } else if (isShell && tok.startsWith('-')) {
      kind = 'flag';
    } else if (/^(?:0x[0-9a-fA-F]+|\d)/.test(tok)) {
      kind = 'num';
    } else if (isSql && SQL_KW.has(tok.toUpperCase())) {
      kind = 'kw';
    } else if (isShell && SHELL_KW.has(tok)) {
      kind = 'kw';
    } else if (!isShell && !isSql && CODE_KW.has(tok)) {
      kind = 'kw';
    } else if (/^[A-Z][A-Za-z0-9_]+$/.test(tok)) {
      kind = 'fn';
    } else if (code[m.index + tok.length] === '(') {
      kind = 'fn';
    }

    spans.push(kind ? { kind, text: tok } : { text: tok });
    last = m.index + tok.length;
  }
  if (last < code.length) spans.push({ text: code.slice(last) });
  return spans;
}

// ---- Lazy Shiki TextMate Highlighter (Zero-WASM JS Engine, Per-Language Dynamic Import) ----

type ShikiTokenLine = Array<{ content: string; color?: string; fontStyle?: number }>;

const SHIKI_LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  bash: () => import('@shikijs/langs/bash'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  sql: () => import('@shikijs/langs/sql'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  diff: () => import('@shikijs/langs/diff'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  java: () => import('@shikijs/langs/java'),
  xml: () => import('@shikijs/langs/xml'),
  dockerfile: () => import('@shikijs/langs/docker'),
  graphql: () => import('@shikijs/langs/graphql'),
};

const SHIKI_LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  shellscript: 'bash',
  pwsh: 'powershell',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  docker: 'dockerfile',
  gql: 'graphql',
  svg: 'xml',
  echarts: 'json',
  chart: 'json',
};

function resolveShikiLang(raw?: string): string | null {
  const clean = (raw ?? '').trim().toLowerCase().split(/[\s{]/)[0] ?? '';
  if (!clean) return null;
  const mapped = SHIKI_LANG_ALIASES[clean] ?? clean;
  return mapped in SHIKI_LANG_LOADERS ? mapped : null;
}

let shikiPromise: Promise<import('shiki/core').HighlighterCore> | null = null;
const loadedShikiLangs = new Set<string>();
const loadingShikiLangs = new Map<string, Promise<void>>();

async function getShikiHighlighter(): Promise<import('shiki/core').HighlighterCore> {
  if (!shikiPromise) {
    shikiPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, themeMod] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('@shikijs/themes/github-dark-default'),
      ]);
      return createHighlighterCore({
        themes: [themeMod.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return shikiPromise;
}

async function highlightWithShiki(code: string, lang: string): Promise<ShikiTokenLine[] | null> {
  const loader = SHIKI_LANG_LOADERS[lang];
  if (!loader) return null;
  const hl = await getShikiHighlighter();
  if (!loadedShikiLangs.has(lang)) {
    let p = loadingShikiLangs.get(lang);
    if (!p) {
      p = (async () => {
        const mod = (await loader()) as { default: Parameters<typeof hl.loadLanguage>[0] };
        await hl.loadLanguage(mod.default);
        loadedShikiLangs.add(lang);
      })().finally(() => loadingShikiLangs.delete(lang));
      loadingShikiLangs.set(lang, p);
    }
    await p;
  }
  const lines = hl.codeToTokensBase(code, { lang, theme: 'github-dark-default' });
  return lines.map((line) => line.map((tok) => ({
    content: tok.content,
    color: tok.color,
    fontStyle: tok.fontStyle,
  })));
}

export const CodeBlockCard = memo(function CodeBlockCard({
  lang,
  text,
  notice,
}: {
  lang?: string;
  text: string;
  notice?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [shikiLines, setShikiLines] = useState<ShikiTokenLine[] | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const normalizedLang = useMemo(() => resolveShikiLang(lang), [lang]);
  const isDiff = normalizedLang === 'diff';
  const fallbackSpans = useMemo(() => highlightCodeFallback(text, lang), [text, lang]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!normalizedLang || isDiff || text.length > 48_000) {
      setShikiLines(null);
      return;
    }
    let cancelled = false;
    void highlightWithShiki(text, normalizedLang)
      .then((lines) => {
        if (!cancelled) setShikiLines(lines);
      })
      .catch(() => {
        if (!cancelled) setShikiLines(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text, normalizedLang, isDiff]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore clipboard denial */
    }
  };

  return (
    <div className="sv-code-card" data-testid="sv-code-card" data-lang={lang || undefined}>
      <div className="sv-code-head">
        <span className="sv-code-lang">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3.5l-2 9" />
          </svg>
          <span>{lang || 'text'}</span>
          {notice && <span className="sv-code-notice">{notice}</span>}
        </span>
        <div className="sv-card-actions">
          <button
            type="button"
            className={`sv-card-btn ${wrapped ? 'is-on' : ''}`}
            onClick={() => setWrapped((v) => !v)}
            title="切换代码自动换行"
          >
            {wrapped ? '取消换行' : '换行'}
          </button>
          <button
            type="button"
            className={`sv-code-copy sv-card-btn ${copied ? 'is-ok' : ''}`}
            data-testid="sv-code-copy"
            onClick={() => void copy()}
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre className={`sv-code-pre ${wrapped ? 'is-wrap' : ''}`} data-shiki={shikiLines ? '1' : undefined}>
        <code>
          {shikiLines
            ? shikiLines.map((line, li) => (
                <span key={li} className="sv-code-line">
                  {line.map((tok, ti) => (
                    <span
                      key={ti}
                      style={{
                        color: tok.color,
                        fontStyle: tok.fontStyle && (tok.fontStyle & 1) ? 'italic' : undefined,
                        fontWeight: tok.fontStyle && (tok.fontStyle & 2) ? 600 : undefined,
                      }}
                    >
                      {tok.content}
                    </span>
                  ))}
                  {li < shikiLines.length - 1 ? '\n' : ''}
                </span>
              ))
            : fallbackSpans.map((s, i) => (s.kind ? <span key={i} className={`hl-${s.kind}`}>{s.text}</span> : s.text))}
        </code>
      </pre>
    </div>
  );
});

// ---- Lightbox Modal (Fullscreen Zoom / Pan for Diagrams & Charts) ----

function DiagramLightbox({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="sv-lightbox"
      data-testid="sv-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="sv-lightbox-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sv-lightbox-head">
          <span className="sv-lightbox-title">{title}</span>
          <button type="button" className="sv-card-btn" onClick={onClose}>
            关闭 (Esc)
          </button>
        </div>
        <div className="sv-lightbox-body">{children}</div>
      </div>
    </div>
  );
}

// ---- Mermaid Diagram Renderer (beautiful-mermaid primary + official mermaid v11 fallback) ----

const SHOAL_MERMAID_COLORS = {
  bg: '#13161d',
  fg: '#dce2ec',
  line: '#6b778e',
  accent: '#4cc4b6',
  muted: '#94a0b8',
  surface: '#1b202b',
  border: '#303a4c',
  font: '"Inter Variable", "Inter", "PingFang SC", "Noto Sans SC", sans-serif',
  transparent: true,
};

let officialMermaidInit = false;
let officialMermaidSeq = 0;

function sanitizeSvgMarkup(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function detectMermaidLabel(code: string): string {
  const first = code.trim().split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim().toLowerCase() ?? '';
  if (first.startsWith('sequencediagram')) return '时序图';
  if (first.startsWith('statediagram')) return '状态图';
  if (first.startsWith('classdiagram')) return '类图';
  if (first.startsWith('erdiagram')) return 'ER 图';
  if (first.startsWith('xychart')) return 'XY 图表';
  if (first.startsWith('gantt')) return '甘特图';
  if (first.startsWith('mindmap')) return '思维导图';
  if (first.startsWith('pie')) return '饼图';
  if (first.startsWith('timeline')) return '时间线';
  if (first.startsWith('quadrantchart')) return '象限图';
  if (first.startsWith('gitgraph')) return 'Git 分支图';
  if (first.startsWith('sankey')) return '桑基图';
  if (first.startsWith('flowchart') || first.startsWith('graph')) return '流程图';
  return 'Mermaid 图表';
}

async function renderMermaidDualEngine(code: string): Promise<{ svg: string; engine: 'beautiful' | 'mermaid' }> {
  try {
    const bm = await import('beautiful-mermaid');
    const rawSvg = await bm.renderMermaidSVGAsync(code, SHOAL_MERMAID_COLORS);
    if (rawSvg && rawSvg.includes('<svg')) {
      return { svg: sanitizeSvgMarkup(rawSvg), engine: 'beautiful' };
    }
  } catch {
    // Fall back to official mermaid v11 for diagram types not yet covered by beautiful-mermaid (gantt, mindmap, pie, etc.)
  }

  const mod = await import('mermaid');
  const mermaid = mod.default;
  if (!officialMermaidInit) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: '"Inter Variable", "Inter", "PingFang SC", "Noto Sans SC", sans-serif',
      themeVariables: {
        darkMode: true,
        background: '#13161d',
        primaryColor: '#1d2431',
        primaryTextColor: '#e4e9f2',
        primaryBorderColor: '#4cc4b6',
        secondaryColor: '#1b202b',
        secondaryTextColor: '#dce2ec',
        secondaryBorderColor: '#364156',
        tertiaryColor: '#232836',
        tertiaryTextColor: '#dce2ec',
        lineColor: '#727f98',
        textColor: '#dce2ec',
        mainBkg: '#1b202b',
        nodeBorder: '#364156',
        clusterBkg: '#161a23',
        clusterBorder: '#2c3445',
        pie1: '#4cc4b6',
        pie2: '#7aa2f7',
        pie3: '#eab963',
        pie4: '#bca4ec',
        pie5: '#ee7872',
        pie6: '#67c986',
      },
    });
    officialMermaidInit = true;
  }
  const id = `sv-mmd-${++officialMermaidSeq}`;
  const res = await mermaid.render(id, code);
  return { svg: sanitizeSvgMarkup(res.svg), engine: 'mermaid' };
}

function downloadDataUrl(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

export const MermaidDiagramCard = memo(function MermaidDiagramCard({
  code,
  streaming = false,
}: {
  code: string;
  streaming?: boolean;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [engine, setEngine] = useState<'beautiful' | 'mermaid' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [scale, setScale] = useState(1);
  const [copiedSvg, setCopiedSvg] = useState(false);

  const label = useMemo(() => detectMermaidLabel(code), [code]);

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg(null);
      setErr(null);
      return;
    }
    if (streaming) return;
    let cancelled = false;
    setErr(null);
    void renderMermaidDualEngine(trimmed)
      .then((res) => {
        if (!cancelled) {
          setSvg(res.svg);
          setEngine(res.engine);
          setErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setSvg(null);
          setErr((e as Error)?.message || '图表语法无法解析');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, streaming]);

  const copySvg = async () => {
    if (!svg) return;
    try {
      await navigator.clipboard.writeText(svg);
      setCopiedSvg(true);
      window.setTimeout(() => setCopiedSvg(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const exportPng = () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const w = Math.max(img.naturalWidth || 800, 320);
      const h = Math.max(img.naturalHeight || 480, 200);
      const canvas = document.createElement('canvas');
      canvas.width = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(2, 2);
        ctx.fillStyle = '#13161d';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        downloadDataUrl(canvas.toDataURL('image/png'), 'shoal-diagram.png');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  if (err && !streaming) {
    return <CodeBlockCard lang="mermaid" text={code} notice="图表语法无法解析，已显示源码" />;
  }

  return (
    <div className="sv-viz-card" data-testid="sv-mermaid-card" data-engine={engine ?? undefined}>
      <div className="sv-viz-head">
        <span className="sv-viz-title">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2.5" width="4.5" height="3.5" rx="1" />
            <rect x="9.5" y="10" width="4.5" height="3.5" rx="1" />
            <rect x="9.5" y="2.5" width="4.5" height="3.5" rx="1" />
            <path d="M6.5 4.25h3M4.25 6v5.75h5.25" />
          </svg>
          <span>{label}</span>
          <span className="sv-viz-tag">Mermaid</span>
        </span>
        <div className="sv-card-actions">
          <button
            type="button"
            className={`sv-card-btn ${showSource ? 'is-on' : ''}`}
            data-testid="sv-viz-toggle-source"
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? '预览图表' : '源码'}
          </button>
          {svg && !showSource && (
            <>
              <button
                type="button"
                className="sv-card-btn"
                data-testid="sv-viz-zoom"
                onClick={() => {
                  setScale(1);
                  setZoomed(true);
                }}
              >
                放大
              </button>
              <button type="button" className="sv-card-btn" onClick={() => void copySvg()}>
                {copiedSvg ? '✓ 已复制' : '复制 SVG'}
              </button>
              <button type="button" className="sv-card-btn" onClick={exportPng}>
                PNG
              </button>
            </>
          )}
        </div>
      </div>

      {showSource ? (
        <pre className="sv-code-pre">
          <code>{code}</code>
        </pre>
      ) : svg ? (
        <div
          className="sv-mermaid-canvas"
          data-testid="sv-mermaid-svg"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="sv-viz-loading">
          <span className="sv-pulse-dot" aria-hidden="true" />
          <span>{streaming ? '正在接收图表定义…' : '正在渲染矢量图表…'}</span>
        </div>
      )}

      {zoomed && svg && (
        <DiagramLightbox title={`${label} · Mermaid`} onClose={() => setZoomed(false)}>
          <div className="sv-lightbox-toolbar">
            <button type="button" className="sv-card-btn" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))}>
              缩小 −
            </button>
            <span className="sv-lightbox-zoom-pct">{Math.round(scale * 100)}%</span>
            <button type="button" className="sv-card-btn" onClick={() => setScale((s) => Math.min(2.6, +(s + 0.2).toFixed(2)))}>
              放大 +
            </button>
            <button type="button" className="sv-card-btn" onClick={() => setScale(1)}>
              重置
            </button>
          </div>
          <div className="sv-lightbox-stage">
            <div
              className="sv-mermaid-canvas is-zoomed"
              style={{ transform: `scale(${scale})`, transformOrigin: 'center top' }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </DiagramLightbox>
      )}
    </div>
  );
});

// ---- ECharts Data Visualization Card (Lazy Loaded, Shoal Dark Theme Auto-Merged) ----

const SHOAL_CHART_PALETTE = [
  '#4cc4b6',
  '#7aa2f7',
  '#eab963',
  '#bca4ec',
  '#ee7872',
  '#67c986',
  '#7dcfff',
  '#f5a97f',
];

function parseChartJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    // Strip JS-style line comments outside strings? Be conservative: strip full-line // comments and trailing commas.
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  if (!cleaned.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function styleAxis(axis: unknown): unknown {
  if (Array.isArray(axis)) return axis.map(styleAxis);
  if (!axis || typeof axis !== 'object') return axis;
  const a = axis as Record<string, unknown>;
  return {
    ...a,
    axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.14)' }, ...(a.axisLine as object | undefined) },
    axisTick: { lineStyle: { color: 'rgba(255, 255, 255, 0.14)' }, ...(a.axisTick as object | undefined) },
    axisLabel: { color: '#9aa4b8', fontSize: 12, ...(a.axisLabel as object | undefined) },
    splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.06)', type: 'dashed' }, ...(a.splitLine as object | undefined) },
    nameTextStyle: { color: '#9aa4b8', ...(a.nameTextStyle as object | undefined) },
  };
}

function applyShoalEChartsTheme(raw: Record<string, unknown>): Record<string, unknown> {
  const opt: Record<string, unknown> = {
    backgroundColor: 'transparent',
    color: SHOAL_CHART_PALETTE,
    animationDuration: 360,
    textStyle: {
      color: '#cfd6e3',
      fontFamily: '"Inter Variable", "Inter", "PingFang SC", "Noto Sans SC", sans-serif',
      fontSize: 12,
      ...(typeof raw.textStyle === 'object' && raw.textStyle ? (raw.textStyle as object) : {}),
    },
    ...raw,
  };

  if (raw.title && typeof raw.title === 'object' && !Array.isArray(raw.title)) {
    const t = raw.title as Record<string, unknown>;
    opt.title = {
      ...t,
      textStyle: { color: '#eef2f8', fontSize: 14, fontWeight: 600, ...(t.textStyle as object | undefined) },
      subtextStyle: { color: '#94a0b8', fontSize: 12, ...(t.subtextStyle as object | undefined) },
    };
  }

  if (raw.legend && typeof raw.legend === 'object' && !Array.isArray(raw.legend)) {
    const l = raw.legend as Record<string, unknown>;
    opt.legend = {
      ...l,
      textStyle: { color: '#b4bccd', fontSize: 12, ...(l.textStyle as object | undefined) },
      pageTextStyle: { color: '#94a0b8', ...(l.pageTextStyle as object | undefined) },
    };
  }

  if (raw.tooltip === undefined || (typeof raw.tooltip === 'object' && raw.tooltip !== null)) {
    const tt = (raw.tooltip && typeof raw.tooltip === 'object' ? raw.tooltip : {}) as Record<string, unknown>;
    opt.tooltip = {
      trigger: raw.xAxis || raw.yAxis ? 'axis' : 'item',
      backgroundColor: '#191d26',
      borderColor: 'rgba(255, 255, 255, 0.14)',
      borderWidth: 1,
      textStyle: { color: '#eef2f8', fontSize: 12 },
      ...tt,
    };
  }

  if (raw.xAxis !== undefined) opt.xAxis = styleAxis(raw.xAxis);
  if (raw.yAxis !== undefined) opt.yAxis = styleAxis(raw.yAxis);

  if (raw.grid === undefined && (raw.xAxis !== undefined || raw.yAxis !== undefined)) {
    const hasTitle = !!raw.title;
    const legendObj = raw.legend && typeof raw.legend === 'object' && !Array.isArray(raw.legend)
      ? (raw.legend as Record<string, unknown>)
      : null;
    const hasBottomLegend = !!legendObj && legendObj.bottom !== undefined;
    opt.grid = { left: 16, right: 20, top: hasTitle ? 54 : 36, bottom: hasBottomLegend ? 44 : 20, containLabel: true };
  }

  return opt;
}

function EChartsCanvas({
  option,
  height,
  onChartReady,
}: {
  option: Record<string, unknown>;
  height: number;
  onChartReady?: (inst: import('echarts').ECharts | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    let chart: import('echarts').ECharts | null = null;
    let ro: ResizeObserver | null = null;

    void import('echarts').then((echarts) => {
      if (disposed || !hostRef.current) return;
      chart = echarts.init(hostRef.current, undefined, { renderer: 'canvas' });
      chart.setOption(option, true);
      onChartReady?.(chart);
      ro = new ResizeObserver(() => {
        if (!disposed && chart) chart.resize();
      });
      ro.observe(hostRef.current);
    });

    return () => {
      disposed = true;
      ro?.disconnect();
      onChartReady?.(null);
      chart?.dispose();
    };
  }, [option, onChartReady]);

  return <div ref={hostRef} className="sv-echarts-canvas" style={{ height: `${height}px` }} data-testid="sv-echarts-canvas" />;
}

export const EChartsDiagramCard = memo(function EChartsDiagramCard({
  code,
  streaming = false,
}: {
  code: string;
  streaming?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const chartRef = useRef<import('echarts').ECharts | null>(null);

  const parsed = useMemo(() => parseChartJson(code), [code]);
  const themedOption = useMemo(() => (parsed ? applyShoalEChartsTheme(parsed) : null), [parsed]);
  const chartTitle = useMemo(() => {
    const t = parsed?.title;
    if (t && typeof t === 'object' && !Array.isArray(t) && typeof (t as Record<string, unknown>).text === 'string') {
      return ((t as Record<string, unknown>).text as string).trim();
    }
    return '';
  }, [parsed]);

  const handleReady = useCallback((inst: import('echarts').ECharts | null) => {
    chartRef.current = inst;
  }, []);

  const exportPng = () => {
    const inst = chartRef.current;
    if (!inst) return;
    try {
      const url = inst.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#13161d' });
      downloadDataUrl(url, 'shoal-chart.png');
    } catch {
      /* ignore */
    }
  };

  if (!themedOption && !streaming) {
    return <CodeBlockCard lang="echarts" text={code} notice="图表 JSON 无法解析，已显示源码" />;
  }

  return (
    <div className="sv-viz-card" data-testid="sv-echarts-card">
      <div className="sv-viz-head">
        <span className="sv-viz-title">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V6" />
          </svg>
          <span>{chartTitle || '数据图表'}</span>
          <span className="sv-viz-tag">ECharts</span>
        </span>
        <div className="sv-card-actions">
          <button
            type="button"
            className={`sv-card-btn ${showSource ? 'is-on' : ''}`}
            data-testid="sv-viz-toggle-source"
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? '预览图表' : '源码'}
          </button>
          {themedOption && !showSource && (
            <>
              <button type="button" className="sv-card-btn" data-testid="sv-viz-zoom" onClick={() => setZoomed(true)}>
                放大
              </button>
              <button type="button" className="sv-card-btn" onClick={exportPng}>
                PNG
              </button>
            </>
          )}
        </div>
      </div>

      {showSource ? (
        <pre className="sv-code-pre">
          <code>{code}</code>
        </pre>
      ) : themedOption ? (
        <EChartsCanvas option={themedOption} height={310} onChartReady={handleReady} />
      ) : (
        <div className="sv-viz-loading">
          <span className="sv-pulse-dot" aria-hidden="true" />
          <span>正在接收图表配置…</span>
        </div>
      )}

      {zoomed && themedOption && (
        <DiagramLightbox title={chartTitle ? `${chartTitle} · ECharts` : '数据图表 · ECharts'} onClose={() => setZoomed(false)}>
          <div className="sv-lightbox-chart">
            <EChartsCanvas option={themedOption} height={520} />
          </div>
        </DiagramLightbox>
      )}
    </div>
  );
});

// ---- Lazy KaTeX Math Renderer ----

let katexLoader: Promise<typeof import('katex').default> | null = null;

function loadKatex(): Promise<typeof import('katex').default> {
  if (!katexLoader) {
    katexLoader = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => mod.default);
  }
  return katexLoader;
}

export const KatexMath = memo(function KatexMath({ expr, display }: { expr: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadKatex()
      .then((katex) => {
        if (cancelled) return;
        const rendered = katex.renderToString(expr.trim(), {
          displayMode: display,
          throwOnError: false,
          strict: false,
          trust: false,
        });
        setHtml(rendered);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [expr, display]);

  if (!html) {
    return display
      ? <pre className="sv-math-fallback" data-testid="sv-math-block"><code>{expr}</code></pre>
      : <code className="sv-inline-code">{expr}</code>;
  }

  return display ? (
    <div className="sv-math-block" data-testid="sv-math-block" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="sv-math-inline" data-testid="sv-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
});

// ---- Smart Table Card (Prevents Vertical Single-Char Column Squishing + Semantic Status Pills + Copy) ----

const STATUS_OK_RE = /^(?:通过|已通过|成功|已完成|正常|开启|支持|PASS|PASSED|OK|SUCCESS|DONE|YES|✓|✅)$/i;
const STATUS_DANGER_RE = /^(?:失败|未通过|错误|异常|阻塞|已拒绝|FAIL|FAILED|ERROR|BLOCKING|REJECTED|✗|❌)$/i;
const STATUS_WARN_RE = /^(?:警告|待确认|进行中|部分通过|跳过|待办|未验证|WARN|WARNING|PENDING|SKIPPED|PARTIAL|WIP|⚠)$/i;

type StatusTone = 'ok' | 'danger' | 'warn';

export function detectCellStatusTone(rawText: string): StatusTone | null {
  const clean = rawText.trim();
  if (!clean || clean.length > 14) return null;
  if (STATUS_OK_RE.test(clean)) return 'ok';
  if (STATUS_DANGER_RE.test(clean)) return 'danger';
  if (STATUS_WARN_RE.test(clean)) return 'warn';
  return null;
}

function cellPlainText(cell: Tokens.TableCell): string {
  return (cell.text ?? '').replace(/[`*_~]/g, '').trim();
}

export const RichTableCard = memo(function RichTableCard({
  table,
  keyPrefix,
  renderInline,
}: {
  table: Tokens.Table;
  keyPrefix: string;
  renderInline: (tokens: Tokens.TableCell['tokens'], key: string) => ReactNode;
}) {
  const [copiedMode, setCopiedMode] = useState<'md' | 'tsv' | null>(null);

  // Detect short/label columns (like "结果", "状态", "通过") so long descriptions in sibling columns never squish them vertically.
  const colCompact = useMemo(() => {
    const colCount = table.header.length;
    const flags: boolean[] = [];
    for (let ci = 0; ci < colCount; ci++) {
      const hLen = [...cellPlainText(table.header[ci])].length;
      let maxLen = hLen;
      for (const row of table.rows) {
        const c = row[ci];
        if (!c) continue;
        const len = [...cellPlainText(c)].length;
        if (len > maxLen) maxLen = len;
      }
      flags.push(maxLen > 0 && maxLen <= 10);
    }
    return flags;
  }, [table]);

  const copyTable = async (mode: 'md' | 'tsv') => {
    const headers = table.header.map((c) => cellPlainText(c));
    const rows = table.rows.map((r) => r.map((c) => cellPlainText(c)));
    const text = mode === 'tsv'
      ? [headers.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n')
      : [
          `| ${headers.join(' | ')} |`,
          `| ${headers.map(() => '---').join(' | ')} |`,
          ...rows.map((r) => `| ${r.join(' | ')} |`),
        ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMode(mode);
      window.setTimeout(() => setCopiedMode(null), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="sv-table-card" data-testid="sv-table-card">
      <div className="sv-table-bar">
        <span className="sv-table-meta">{table.rows.length} 行 × {table.header.length} 列</span>
        <div className="sv-card-actions">
          <button type="button" className="sv-card-btn" onClick={() => void copyTable('md')}>
            {copiedMode === 'md' ? '✓ 已复制 MD' : '复制 MD'}
          </button>
          <button type="button" className="sv-card-btn" onClick={() => void copyTable('tsv')}>
            {copiedMode === 'tsv' ? '✓ 已复制表格' : '复制表格'}
          </button>
        </div>
      </div>
      <div className="sv-table-wrap">
        <table>
          <thead>
            <tr>
              {table.header.map((cell, ci) => (
                <th
                  key={ci}
                  className={colCompact[ci] ? 'is-compact' : undefined}
                  style={{ textAlign: table.align[ci] ?? undefined }}
                >
                  {renderInline(cell.tokens, `${keyPrefix}-th-${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const plain = cellPlainText(cell);
                  const tone = detectCellStatusTone(plain);
                  return (
                    <td
                      key={ci}
                      className={colCompact[ci] ? 'is-compact' : undefined}
                      style={{ textAlign: table.align[ci] ?? undefined }}
                    >
                      {tone ? (
                        <span className={`sv-status-pill is-${tone}`} data-testid="sv-status-pill">
                          <span className="sv-status-dot" aria-hidden="true" />
                          {plain}
                        </span>
                      ) : (
                        renderInline(cell.tokens, `${keyPrefix}-td-${ri}-${ci}`)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
