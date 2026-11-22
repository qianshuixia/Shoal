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

// POSIX branch of parseLocalFileLink: p is an absolute /-rooted path, possibly with a #L12C3 or :12:3 suffix.
function parsePosixPath(p: string, line: number | undefined, col: number | undefined): ParsedLocalLink {
  const hashMatch = /#L(\d+)(?:C(\d+))?$/i.exec(p);
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
      const m = /^#L(\d+)(?:C(\d+))?$/i.exec(raw.slice(hash));
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

  // Strip trailing #L12C3 or :12:3 (after drive colon index 1)
  const rest = p.slice(2);
  const hashMatch = /#L(\d+)(?:C(\d+))?$/i.exec(rest);
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
