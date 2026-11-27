// Sanitizers for model-authored rich content (ECharts options and Mermaid/SVG markup).
// Everything here is pure and DOM-free except the optional DOMParser fast path in sanitizeSvgMarkup.

// ---- ECharts option sanitizer ----

const ECHARTS_DROP_KEYS = new Set([
  'formatter', 'valueFormatter', 'extraCssText', 'appendTo', 'appendToBody', 'className',
  'link', 'sublink', 'target', 'subtarget', 'toolbox', 'graphic', 'aria', 'image',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// `image://<url>` is ECharts' symbol syntax for loading a remote picture: drop it like a script URL (no silent third-party requests).
const UNSAFE_STRING_RE = /^[\s\u0000-\u001f]*(?:(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|image\s*:\/\/)/i;
const MAX_SERIES_POINTS = 5000;
const MAX_DEPTH = 24;

export interface SanitizedEChartsOption {
  option: Record<string, unknown>;
  truncated: boolean;
}

function isUnsafeString(s: string): boolean {
  return UNSAFE_STRING_RE.test(s);
}

export function sanitizeEChartsOption(raw: Record<string, unknown>): SanitizedEChartsOption {
  let truncated = false;
  const ancestors = new WeakSet<object>();

  const clean = (value: unknown, depth: number, parentKey: string): unknown => {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
    if (typeof value === 'string') return isUnsafeString(value) ? undefined : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth > MAX_DEPTH || ancestors.has(value)) return undefined;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        let list: unknown[] = value;
        if (parentKey === 'data' && list.length > MAX_SERIES_POINTS) {
          list = list.slice(0, MAX_SERIES_POINTS);
          truncated = true;
        }
        // Keep array positions stable: unsafe entries become null rather than shifting data.
        return list.map((item) => {
          // `tooltip: [{...}, {...}]` items are tooltips too, so they keep the key (and get richText below).
          const c = clean(item, depth + 1, parentKey === 'tooltip' ? 'tooltip' : '');
          return c === undefined ? null : c;
        });
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (UNSAFE_KEYS.has(key) || ECHARTS_DROP_KEYS.has(key)) continue;
        const c = clean((value as Record<string, unknown>)[key], depth + 1, key);
        if (c !== undefined) out[key] = c;
      }
      // Every tooltip (top level, series[], axes, axisPointer...) renders on canvas, never via innerHTML.
      if (parentKey === 'tooltip') out.renderMode = 'richText';
      return out;
    } finally {
      ancestors.delete(value);
    }
  };

  const cleaned = (clean(raw, 0, '') as Record<string, unknown> | undefined) ?? {};
  const ensureRichTextTooltip = (target: Record<string, unknown>) => {
    if (target.tooltip === null || typeof target.tooltip !== 'object') {
      target.tooltip = { renderMode: 'richText' };
    }
  };
  // Tooltip arrays are handled per item above; a missing or primitive (`tooltip: true`) tooltip becomes explicit richText,
  // both at root and inside ECharts timeline `baseOption` / `options[]` layers.
  ensureRichTextTooltip(cleaned);
  if (cleaned.baseOption && typeof cleaned.baseOption === 'object' && !Array.isArray(cleaned.baseOption)) {
    ensureRichTextTooltip(cleaned.baseOption as Record<string, unknown>);
  }
  if (Array.isArray(cleaned.options)) {
    for (const item of cleaned.options) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        ensureRichTextTooltip(item as Record<string, unknown>);
      }
    }
  }
  return { option: cleaned, truncated };
}

// ---- SVG sanitizer ----
// Two paths share the same attribute / CSS filters:
//   1. DOMParser path: runs in the browser (and any DOM-capable env). Parses as XML and walks a tag whitelist.
//   2. Tokenizer path: runs in Node (vitest has no DOM) and as a fallback when the XML parse fails in the browser
//      (e.g. Mermaid output with unclosed <br>). It is a strict whitelist tokenizer, not a regex blacklist.

const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'a', 'switch', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'title', 'desc', 'style', 'marker', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'pattern', 'filter', 'fegaussianblur', 'feoffset', 'fecolormatrix', 'femerge', 'femergenode',
  'feflood', 'fecomposite', 'feblend', 'fedropshadow', 'femorphology', 'fecomponenttransfer', 'fefunca', 'fefuncr',
  'fefuncg', 'fefuncb',
]);
const XMLNS_ALLOWED = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex, dec, name) => {
    if (hex || dec) {
      const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    const v = NAMED_ENTITIES[String(name).toLowerCase()];
    return v ?? m;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizePrefix(uidPrefix: string): string {
  const p = uidPrefix.replace(/[^A-Za-z0-9_-]/g, '-');
  return p || 'svg';
}

function collectIds(raw: string): Set<string> {
  const ids = new Set<string>();
  const re = /[\s"'/]id\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const v = decodeEntities(m[1] ?? m[2] ?? '').trim();
    if (v) ids.add(v);
  }
  return ids;
}

interface SvgCtx {
  prefix: string;
  ids: Set<string>;
}

function prefixId(ctx: SvgCtx, id: string): string {
  return ctx.ids.has(id) ? `${ctx.prefix}-${id}` : id;
}

// Strips @import / external url() and rewrites `#id` selectors + url(#id) to the instance-prefixed ids.
function sanitizeCss(css: string, ctx: SvgCtx): string {
  let s = css
    .replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_m, hex, ch) => {
      if (hex) {
        const cp = parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
      return ch === '\n' ? '' : ch;
    })
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--|-->/g, '')
    .replace(/@import\b[^;]*(?:;|$)/gi, '')
    .replace(/url\(\s*(["']?)(?!#)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(|behavior\s*:|-moz-binding\s*:|javascript\s*:/gi, '')
    .replace(/</g, '');
  s = s.replace(/#([\w-]+)/g, (m, name: string) => (ctx.ids.has(name) ? `#${ctx.prefix}-${name}` : m));
  return s;
}

function rewriteUrlRefs(value: string, ctx: SvgCtx): string | null {
  if (!/url\(/i.test(value)) return value;
  // Any url() that is not an in-document #fragment is dropped with its attribute.
  if (/url\(\s*(["']?)(?!#)/i.test(value)) return null;
  return value.replace(/url\(\s*(["']?)#([^)"'\s]+)\1\s*\)/gi, (_m, q: string, id: string) => `url(${q}#${prefixId(ctx, id)}${q})`);
}

// Returns the cleaned attribute value, or null when the attribute must be dropped.
function cleanSvgAttr(rawName: string, rawValue: string, ctx: SvgCtx, isRoot: boolean): string | null {
  const name = rawName.toLowerCase();
  if (!/^[a-z_:][-a-z0-9_:.]*$/.test(name)) return null;
  if (name.startsWith('on')) return null;
  const value = rawValue;
  const probe = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  if (name === 'xmlns' || name.startsWith('xmlns:')) {
    return isRoot && XMLNS_ALLOWED.has(value.trim()) ? value.trim() : null;
  }
  if (name === 'href' || name === 'xlink:href') {
    const v = value.trim();
    if (!v.startsWith('#') || v.length < 2) return null;
    return `#${prefixId(ctx, v.slice(1))}`;
  }
  if (name === 'src' || name === 'srcdoc' || name === 'data' || name === 'action' || name === 'formaction') return null;
  if (probe.includes('javascript:') || probe.includes('vbscript:') || probe.includes('data:text/html')) return null;
  if (name === 'id') return value.trim() ? `${ctx.prefix}-${value.trim()}` : null;
  if (name === 'aria-labelledby' || name === 'aria-describedby' || name === 'aria-owns' || name === 'aria-controls') {
    return value.split(/\s+/).filter(Boolean).map((id) => prefixId(ctx, id)).join(' ');
  }
  if (name === 'style') return sanitizeCss(value, ctx);
  return rewriteUrlRefs(value, ctx);
}

function sanitizeSvgViaDom(rawSvg: string, ctx: SvgCtx): string | null {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) return null;

  const walk = (el: Element, isRoot: boolean): void => {
    for (const attr of Array.from(el.attributes)) {
      const next = cleanSvgAttr(attr.name, attr.value, ctx, isRoot);
      if (next === null) el.removeAttributeNode(attr);
      else if (next !== attr.value) attr.value = next;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) {
        const c = child as Element;
        if (!SVG_ALLOWED_TAGS.has(c.localName.toLowerCase())) {
          el.removeChild(c);
        } else if (c.localName.toLowerCase() === 'style') {
          c.textContent = sanitizeCss(c.textContent ?? '', ctx);
          for (const attr of Array.from(c.attributes)) {
            const next = cleanSvgAttr(attr.name, attr.value, ctx, false);
            if (next === null) c.removeAttributeNode(attr);
            else if (next !== attr.value) attr.value = next;
          }
        } else {
          walk(c, false);
        }
      } else if (child.nodeType !== 3 && child.nodeType !== 4) {
        el.removeChild(child);
      }
    }
  };
  walk(root, true);
  return new XMLSerializer().serializeToString(root);
}

function sanitizeSvgViaTokenizer(rawSvg: string, ctx: SvgCtx): string {
  const out: string[] = [];
  const src = rawSvg;
  const n = src.length;
  let i = 0;
  let sawRoot = false;
  // When >0 we are skipping the subtree of a disallowed element; skipName is its lowercase tag name.
  let skipDepth = 0;
  let skipName = '';

  const readTag = (start: number) => {
    // start points at '<'. Returns null when the tag is not terminated or malformed.
    let p = start + 1;
    let closing = false;
    if (src[p] === '/') { closing = true; p++; }
    const nameStart = p;
    while (p < n && /[^\s/>]/.test(src[p])) p++;
    const name = src.slice(nameStart, p);
    if (!/^[A-Za-z][-A-Za-z0-9_:.]*$/.test(name)) return null;
    const attrs: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      while (p < n && /\s/.test(src[p])) p++;
      if (p >= n) return null;
      if (src[p] === '>') { p++; break; }
      if (src[p] === '/') {
        if (src[p + 1] === '>') { selfClosing = true; p += 2; break; }
        p++;
        continue;
      }
      const aStart = p;
      while (p < n && /[^\s=/>]/.test(src[p])) p++;
      const aName = src.slice(aStart, p);
      if (!aName) { p++; continue; }
      while (p < n && /\s/.test(src[p])) p++;
      let aVal = '';
      if (src[p] === '=') {
        p++;
        while (p < n && /\s/.test(src[p])) p++;
        const q = src[p];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, p + 1);
          if (end < 0) return null;
          aVal = src.slice(p + 1, end);
          p = end + 1;
        } else {
          const vs = p;
          while (p < n && /[^\s>]/.test(src[p])) p++;
          aVal = src.slice(vs, p);
        }
      }
      attrs.push([aName, decodeEntities(aVal)]);
    }
    return { name, closing, attrs, selfClosing, end: p };
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (skipDepth === 0 && sawRoot) out.push(src.slice(i).replace(/</g, '&lt;'));
      break;
    }
    if (lt > i && skipDepth === 0 && sawRoot) out.push(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const body = src.slice(i + 9, end < 0 ? n : end);
      if (skipDepth === 0 && sawRoot) out.push(body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[i + 1] === '?' || src[i + 1] === '!') {
      const end = src.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const tag = readTag(i);
    if (!tag) {
      // Stray or unterminated '<': escape it and move on (unterminated tags swallow nothing else).
      if (skipDepth === 0 && sawRoot) out.push('&lt;');
      i += 1;
      continue;
    }
    i = tag.end;
    const lname = tag.name.toLowerCase();

    if (skipDepth > 0) {
      if (lname === skipName) {
        if (tag.closing) skipDepth--;
        else if (!tag.selfClosing) skipDepth++;
      }
      continue;
    }

    if (tag.closing) {
      if (sawRoot && SVG_ALLOWED_TAGS.has(lname) && lname !== 'style') out.push(`</${tag.name}>`);
      continue;
    }

    if (!SVG_ALLOWED_TAGS.has(lname) || (!sawRoot && lname !== 'svg')) {
      if (!tag.selfClosing) {
        skipDepth = 1;
        skipName = lname;
      }
      continue;
    }

    if (lname === 'style') {
      const attrParts = tag.attrs
        .map(([an, av]) => [an, cleanSvgAttr(an, av, ctx, false)] as const)
        .filter((x): x is readonly [string, string] => x[1] !== null)
        .map(([an, av]) => ` ${an}="${escapeAttr(av)}"`)
        .join('');
      if (tag.selfClosing) {
        out.push(`<style${attrParts}></style>`);
        continue;
      }
      // Raw text element: consume up to </style>.
      const m = /<\/style\s*>/i.exec(src.slice(i));
      const cssEnd = m ? i + m.index : n;
      let css = src.slice(i, cssEnd);
      const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(css);
      if (cdata) css = cdata[1];
      out.push(`<style${attrParts}>${sanitizeCss(css, ctx)}</style>`);
      i = m ? cssEnd + m[0].length : n;
      continue;
    }

    const isRoot = !sawRoot;
    sawRoot = true;
    const attrParts: string[] = [];
    for (const [an, av] of tag.attrs) {
      const cv = cleanSvgAttr(an, av, ctx, isRoot);
      if (cv !== null) attrParts.push(` ${an}="${escapeAttr(cv)}"`);
    }
    out.push(`<${tag.name}${attrParts.join('')}${tag.selfClosing ? '/>' : '>'}`);
  }
  return out.join('');
}

export function sanitizeSvgMarkup(rawSvg: string, uidPrefix: string): string {
  if (!rawSvg || !/<svg[\s>/]/i.test(rawSvg)) return '';
  const ctx: SvgCtx = { prefix: normalizePrefix(uidPrefix), ids: collectIds(rawSvg) };
  const viaDom = sanitizeSvgViaDom(rawSvg, ctx);
  const result = viaDom ?? sanitizeSvgViaTokenizer(rawSvg, ctx);
  return /<svg[\s>/]/i.test(result) ? result : '';
}

// Exposed for tests: always runs the DOM-free tokenizer path regardless of environment.
export function sanitizeSvgMarkupTokenizer(rawSvg: string, uidPrefix: string): string {
  if (!rawSvg || !/<svg[\s>/]/i.test(rawSvg)) return '';
  const ctx: SvgCtx = { prefix: normalizePrefix(uidPrefix), ids: collectIds(rawSvg) };
  return sanitizeSvgViaTokenizer(rawSvg, ctx);
}
