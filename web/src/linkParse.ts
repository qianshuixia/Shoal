import type { Project } from '../../shared/protocol.ts';

export interface ParsedLocalLink {
  localPath: string; // normalized path without line/col suffix: backslash form for Windows drives, /-rooted for POSIX
  line?: number;
  col?: number;
}

const EXTERNAL_ONLY_EXT = new Set([
  'exe', 'com', 'msi', 'msp', 'lnk', 'url', 'scr', 'cpl', 'dll', 'sys', 'appref-ms', 'pif', 'msc', 'hta',
]);
// POSIX only: a .app is a directory there, and these run or install when opened.
const POSIX_EXTERNAL_ONLY_EXT = new Set(['app', 'command', 'dmg', 'pkg']);

// POSIX branch of parseLocalFileLink: p is an absolute /-rooted path, possibly with a #L12C3, #L12-L20, or :12:3 suffix.
function parsePosixPath(p: string, line: number | undefined, col: number | undefined): ParsedLocalLink {
  const hashMatch = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(p);
  const colonMatch = hashMatch ? null : /:(\d+)(?::(\d+))?$/.exec(p);
  const m = hashMatch ?? colonMatch;
  if (m) {
    p = p.slice(0, m.index);
    if (line === undefined) {
      line = Number(m[1]);
      if (m[2]) col = Number(m[2]);
    }
  }
  // Collapse `.` / `..` segments lexically
  const normSegs: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') normSegs.pop();
    else normSegs.push(s);
  }
  return { localPath: `/${normSegs.join('/')}`, ...(line !== undefined && { line }), ...(col !== undefined && { col }) };
}

// Parses a terminal link (`file:///G:/a/b.ts#L12C3`, `G:\a\b.ts:12:3`, or POSIX `file:///Users/a/b.ts#L3C1`,
// `/Users/a/b.ts:3`) into a local path + optional line/col.
// Returns null for remote hosts, UNC paths, or non-local URIs.
export function parseLocalFileLink(rawUri: string): ParsedLocalLink | null {
  const raw = rawUri.trim();
  if (!raw || raw.startsWith('\\\\') || raw.startsWith('//')) return null;

  let p = '';
  let line: number | undefined;
  let col: number | undefined;

  if (/^file:/i.test(raw)) {
    const hash = raw.indexOf('#');
    const base = hash === -1 ? raw : raw.slice(0, hash);
    if (hash !== -1) {
      const m = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(raw.slice(hash));
      if (m) {
        line = Number(m[1]);
        if (m[2]) col = Number(m[2]);
      }
    }
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      return null;
    }
    if (url.protocol.toLowerCase() !== 'file:') return null;
    if (url.host !== '' && url.host.toLowerCase() !== 'localhost') return null;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    // `/G:/foo/bar.ts` -> `G:/foo/bar.ts`
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    else if (pathname.startsWith('/') && !pathname.startsWith('//')) return parsePosixPath(pathname, line, col);
    p = pathname.replace(/\//g, '\\');
  } else if (/^[A-Za-z]:[\\/]/.test(raw)) {
    p = raw.replace(/\//g, '\\');
  } else if (raw.startsWith('/')) {
    return parsePosixPath(raw, undefined, undefined);
  } else {
    return null;
  }

  if (!/^[A-Za-z]:\\/.test(p)) return null;

  // Strip trailing #L12C3, #L12-L20, or :12:3 (after drive colon index 1)
  const rest = p.slice(2);
  const hashMatch = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(rest);
  if (hashMatch) {
    p = p.slice(0, 2 + hashMatch.index);
    if (line === undefined) {
      line = Number(hashMatch[1]);
      if (hashMatch[2]) col = Number(hashMatch[2]);
    }
  } else {
    const colonMatch = /:(\d+)(?::(\d+))?$/.exec(rest);
    if (colonMatch) {
      p = p.slice(0, 2 + colonMatch.index);
      if (line === undefined) {
        line = Number(colonMatch[1]);
        if (colonMatch[2]) col = Number(colonMatch[2]);
      }
    }
  }

  // Collapse `.` / `..` segments lexically on Windows drive path
  const drive = p.slice(0, 2);
  const segs = p.slice(2).split('\\');
  const normSegs: string[] = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') normSegs.pop();
    else normSegs.push(s);
  }
  const localPath = `${drive}\\${normSegs.join('\\')}`;
  return { localPath, ...(line !== undefined && { line }), ...(col !== undefined && { col }) };
}

export interface MatchedProjectFile {
  project: Project;
  relPosix: string;
  line?: number;
  col?: number;
}

// Finds the deepest registered project containing the parsed link path, excluding .git and external-only binaries.
// A project whose path starts with `/` is POSIX: `/`-separated and case-sensitive. Windows projects compare
// case-insensitively with backslashes.
export function matchProjectFileLink(rawUri: string, projects: Project[]): MatchedProjectFile | null {
  const parsed = parseLocalFileLink(rawUri);
  if (!parsed) return null;
  const targetPosix = parsed.localPath.startsWith('/');
  const targetLow = parsed.localPath.toLowerCase();

  // Deepest matching project wins if one project is nested inside another.
  const sorted = [...projects]
    .map((project) => {
      const posix = project.path.startsWith('/');
      return {
        project,
        posix,
        rootNorm: posix ? project.path.replace(/\/+$/, '') : project.path.replace(/\//g, '\\').replace(/\\+$/, ''),
      };
    })
    .sort((a, b) => b.rootNorm.length - a.rootNorm.length);

  for (const { project, posix, rootNorm } of sorted) {
    if (posix !== targetPosix) continue;
    const sep = posix ? '/' : '\\';
    const startsInside = posix ? parsed.localPath.startsWith(rootNorm + sep) : targetLow.startsWith(rootNorm.toLowerCase() + sep);
    if (!startsInside) continue;
    const rel = parsed.localPath.slice(rootNorm.length + 1);
    const relPosix = posix ? rel : rel.replace(/\\/g, '/');
    if (!relPosix || relPosix.toLowerCase().startsWith('.git/') || relPosix.toLowerCase() === '.git') return null;
    const dot = relPosix.lastIndexOf('.');
    const ext = dot === -1 ? '' : relPosix.slice(dot + 1).toLowerCase();
    if (ext && (EXTERNAL_ONLY_EXT.has(ext) || (posix && POSIX_EXTERNAL_ONLY_EXT.has(ext)))) return null;
    return { project, relPosix, line: parsed.line, col: parsed.col };
  }
  return null;
}

// ---- Explicit local file path detection in plain text & Markdown ----

export type ExplicitPathSegment =
  | { kind: 'text'; text: string }
  | { kind: 'file'; text: string; path: string };

export interface ExplicitPathMatch {
  raw: string;
  path: string;
}

const POSIX_KNOWN_ROOTS = [
  '/Users/', '/home/', '/tmp/', '/var/', '/etc/', '/opt/', '/mnt/',
  '/Volumes/', '/private/', '/root/', '/srv/', '/usr/', '/workspace/', '/workspaces/',
];

const EXTENSIONLESS_FILE_NAMES = new Set([
  'makefile', 'dockerfile', 'vagrantfile', 'procfile', 'gemfile', 'rakefile',
  'justfile', 'jenkinsfile', 'brewfile', 'podfile', 'license', 'readme',
  'changelog', 'authors', 'notice', 'copying', 'codeowners', 'cname',
]);

const COMMON_DOTFILE_RE = /^\.(?:env(?:\.[A-Za-z0-9_-]+)?|gitignore|gitattributes|gitmodules|editorconfig|npmrc|nvmrc|yarnrc|prettierrc|eslintrc|stylelintrc|dockerignore|htaccess|bashrc|zshrc|profile|bash_profile|zprofile|tool-versions|python-version|node-version)$/i;

// Extension must contain at least one ASCII letter (e.g. .jpg, .mp4, .3gp, .7z, .tsx) so version folders like `v1.0` are not treated as files.
const FILE_EXT_RE = /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]{0,11}$/;

// Stops unquoted path scans at whitespace, control chars, comma/semicolon list separators, quotes/backticks,
// illegal path chars, and CJK/fullwidth punctuation.
const UNQUOTED_PATH_STOP_RE = /[\s,;\u0000-\u001f"'`<>|*?\u00b7\u2014\u2018-\u201f\u2026\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/;
const QUOTED_PATH_ILLEGAL_RE = /[\r\n\u0000-\u001f<>|*?]/;

const MAX_EXPLICIT_PATH_LEN = 512;
const MAX_UNQUOTED_SCAN_LEN = 560;

const QUOTE_CLOSE: Record<string, string> = {
  '"': '"',
  "'": "'",
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
  '【': '】',
  '《': '》',
};

const PATH_LINE_SUFFIX_RE = /(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?)$/i;
const LEADING_LINE_SUFFIX_RE = /^(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?)/i;

// Single-pass delimiter trimming: O(k) instead of re-counting brackets on every stripped character.
function trimTrailingDelimiters(raw: string): string {
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let openBrace = 0;
  let closeBrace = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') openParen++;
    else if (ch === ')') closeParen++;
    else if (ch === '[') openBracket++;
    else if (ch === ']') closeBracket++;
    else if (ch === '{') openBrace++;
    else if (ch === '}') closeBrace++;
  }
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1];
    if (last === ',' || last === ';' || last === '!' || last === '?' || last === '~' || last === '.') {
      end--;
      continue;
    }
    if (last === ':' && end > 2) {
      end--;
      continue;
    }
    if (last === ')' && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (last === ']' && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (last === '}' && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  return end === raw.length ? raw : raw.slice(0, end);
}

function hasFileLeaf(cleanPath: string, hasLineSuffix: boolean): boolean {
  if (!cleanPath || /[\\/]$/.test(cleanPath)) return false;
  const sepIdx = Math.max(cleanPath.lastIndexOf('/'), cleanPath.lastIndexOf('\\'));
  const leaf = sepIdx >= 0 ? cleanPath.slice(sepIdx + 1) : cleanPath;
  if (!leaf || leaf === '.' || leaf === '..') return false;
  if (hasLineSuffix) return true;
  if (FILE_EXT_RE.test(leaf)) return true;
  if (COMMON_DOTFILE_RE.test(leaf)) return true;
  return EXTENSIONLESS_FILE_NAMES.has(leaf.toLowerCase());
}

function stripLineSuffix(raw: string, startOffset: number): { clean: string; hasLineSuffix: boolean } {
  const tail = raw.slice(startOffset);
  const m = PATH_LINE_SUFFIX_RE.exec(tail);
  if (!m) return { clean: raw, hasLineSuffix: false };
  return { clean: raw.slice(0, startOffset + m.index), hasLineSuffix: true };
}

function isAllowedPosixPrefix(candidate: string, projectPath?: string): boolean {
  if (projectPath?.startsWith('/')) {
    const norm = projectPath.replace(/\/+$/, '');
    if (norm && candidate.startsWith(`${norm}/`)) return true;
  }
  for (const root of POSIX_KNOWN_ROOTS) {
    if (candidate.startsWith(root)) return true;
  }
  return false;
}

function validateExplicitCandidate(candidate: string, kind: 'file-uri' | 'win' | 'posix', projectPath?: string): ExplicitPathMatch | null {
  if (!candidate || candidate.length > MAX_EXPLICIT_PATH_LEN) return null;
  if (kind === 'file-uri') {
    if (/[\\/]$/.test(candidate)) return null;
    const parsed = parseLocalFileLink(candidate);
    if (!parsed) return null;
    if (!hasFileLeaf(parsed.localPath, parsed.line !== undefined)) return null;
    return { raw: candidate, path: candidate };
  }
  if (kind === 'win') {
    if (!/^[A-Za-z]:[\\/]/.test(candidate)) return null;
    const { clean, hasLineSuffix } = stripLineSuffix(candidate, 2);
    if (clean.length <= 3 || !hasFileLeaf(clean, hasLineSuffix)) return null;
    return { raw: candidate, path: candidate };
  }
  // posix
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  if (!isAllowedPosixPrefix(candidate, projectPath)) return null;
  const { clean, hasLineSuffix } = stripLineSuffix(candidate, 1);
  if (clean.indexOf('/', 1) === -1 || !hasFileLeaf(clean, hasLineSuffix)) return null;
  return { raw: candidate, path: candidate };
}

function detectCandidateKind(text: string, index: number, prevChar: string | undefined): 'file-uri' | 'win' | 'posix' | null {
  const ch = text[index];
  if (!ch) return null;
  if ((ch === 'f' || ch === 'F') && /^file:\/\//i.test(text.slice(index, index + 7))) {
    if (prevChar && /[A-Za-z0-9_./\\:]/.test(prevChar)) return null;
    return 'file-uri';
  }
  if (
    ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) &&
    text[index + 1] === ':' &&
    (text[index + 2] === '\\' || text[index + 2] === '/')
  ) {
    if (prevChar && /[A-Za-z0-9_/\\]/.test(prevChar)) return null;
    return 'win';
  }
  if (ch === '/' && text[index + 1] !== '/') {
    if (prevChar && /[A-Za-z0-9_./\\:]/.test(prevChar)) return null;
    return 'posix';
  }
  return null;
}

function matchExplicitFilePathAt(
  text: string,
  index: number,
  projectPath?: string,
  prevOverride?: string,
): ExplicitPathMatch | null {
  const prevChar = index > 0 ? text[index - 1] : prevOverride;
  const kind = detectCandidateKind(text, index, prevChar);
  if (!kind) return null;

  // Quoted paths allow spaces (e.g. "G:\My Folder\shot 1.png" or “C:\My Folder\shot 1.png”) when a matching closing quote
  // exists on the same line, and also preserve an optional `:line:col` / `#Lline` suffix right after the closing quote.
  const closeQuote = prevChar ? QUOTE_CLOSE[prevChar] : undefined;
  if (closeQuote) {
    const closeIdx = text.indexOf(closeQuote, index + 1);
    if (closeIdx > index && closeIdx - index <= MAX_EXPLICIT_PATH_LEN) {
      const inside = text.slice(index, closeIdx);
      if (!QUOTED_PATH_ILLEGAL_RE.test(inside)) {
        const afterQuote = text.slice(closeIdx + 1, closeIdx + 33);
        const suffixMatch = LEADING_LINE_SUFFIX_RE.exec(afterQuote);
        const target = suffixMatch ? `${inside}${suffixMatch[0]}` : inside;
        const quoted = validateExplicitCandidate(target, kind, projectPath);
        if (quoted) return { raw: inside, path: quoted.path };
      }
    }
  }

  const scanLimit = Math.min(text.length, index + MAX_UNQUOTED_SCAN_LEN);
  let end = index;
  while (end < scanLimit && !UNQUOTED_PATH_STOP_RE.test(text[end])) end++;
  const trimmed = trimTrailingDelimiters(text.slice(index, end));
  return validateExplicitCandidate(trimmed, kind, projectPath);
}

// Selective candidate finder: skips URLs intact and only wakes up on `file://`, Windows drive prefixes, or known POSIX roots
// (plus an optional custom POSIX project root when provided), avoiding per-slash scanning on prose like `a/b` or `/api/v1`.
const DEFAULT_CANDIDATE_RE =
  /(?:https?:\/\/|mailto:)\S+|file:\/\/|(?<![A-Za-z0-9_/\\])[A-Za-z]:[\\/]|(?<![A-Za-z0-9_./\\:])\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|srv|usr|workspace|workspaces)\//gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateRegexFor(projectPath?: string): RegExp {
  if (projectPath?.startsWith('/')) {
    const norm = projectPath.replace(/\/+$/, '');
    if (norm && !POSIX_KNOWN_ROOTS.some((r) => `${norm}/`.startsWith(r))) {
      return new RegExp(
        `(?:https?:\\/\\/|mailto:)\\S+|file:\\/\\/|(?<![A-Za-z0-9_/\\\\])[A-Za-z]:[\\\\/]|(?<![A-Za-z0-9_./\\\\:])(?:${escapeRegExp(norm)}\\/|\\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|srv|usr|workspace|workspaces)\\/)`,
        'gi',
      );
    }
  }
  DEFAULT_CANDIDATE_RE.lastIndex = 0;
  return DEFAULT_CANDIDATE_RE;
}

export function splitExplicitFilePaths(text: string, projectPath?: string): ExplicitPathSegment[] {
  if (!text || (!text.includes(':') && !text.includes('/'))) {
    return text ? [{ kind: 'text', text }] : [];
  }
  const out: ExplicitPathSegment[] = [];
  let cursor = 0;
  const re = candidateRegexFor(projectPath);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (/^(?:https?:\/\/|mailto:)/i.test(tok)) continue;
    const hit = matchExplicitFilePathAt(text, m.index, projectPath);
    if (!hit) continue;
    if (m.index > cursor) out.push({ kind: 'text', text: text.slice(cursor, m.index) });
    out.push({ kind: 'file', text: hit.raw, path: hit.path });
    cursor = m.index + hit.raw.length;
    re.lastIndex = cursor;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}

export function findNextExplicitFilePathStart(src: string, projectPath?: string): number {
  if (!src || (!src.includes(':') && !src.includes('/'))) return -1;
  const re = candidateRegexFor(projectPath);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (/^(?:https?:\/\/|mailto:)/i.test(tok)) continue;
    // Return the first non-URL candidate boundary directly (O(1) per invalid token inside marked's inline loop)
    // instead of scanning forward through every remaining candidate on every backslash/underscore boundary.
    return m.index;
  }
  return -1;
}

export function matchExplicitFilePathAtStart(
  src: string,
  prevChar: string | undefined,
  projectPath?: string,
): ExplicitPathMatch | null {
  return matchExplicitFilePathAt(src, 0, projectPath, prevChar);
}

// Returns the file path if an inline code span's entire content is one explicit local file path.
export function isSingleExplicitFilePath(raw: string, projectPath?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let inner = trimmed;
  let quoted = false;
  const openClose = trimmed.length >= 2 ? QUOTE_CLOSE[trimmed[0]] : undefined;
  if (openClose) {
    if (trimmed.endsWith(openClose)) {
      inner = trimmed.slice(1, -1);
      quoted = true;
    } else {
      const closeIdx = trimmed.indexOf(openClose, 1);
      if (closeIdx > 1) {
        const after = trimmed.slice(closeIdx + 1);
        const suffixMatch = LEADING_LINE_SUFFIX_RE.exec(after);
        if (suffixMatch && suffixMatch[0].length === after.length) {
          inner = `${trimmed.slice(1, closeIdx)}${suffixMatch[0]}`;
          quoted = true;
        }
      }
    }
  }
  if (!inner) return null;
  const kind = detectCandidateKind(inner, 0, undefined);
  if (!kind) return null;
  if (QUOTED_PATH_ILLEGAL_RE.test(inner)) return null;
  if (!quoted && UNQUOTED_PATH_STOP_RE.test(inner)) {
    // Allow spaces and commas inside a standalone inline code span like `C:\demo\shot, final.png` if no illegal chars appear.
    if (/[\t\r\n\u0000-\u001f"'`<>|*?\u00b7\u2014\u2018-\u201f\u2026\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/.test(inner)) {
      return null;
    }
  }
  const valid = validateExplicitCandidate(inner, kind, projectPath);
  return valid ? valid.path : null;
}
