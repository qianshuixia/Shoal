import type { Project } from '../../shared/protocol.ts';

export interface ParsedLocalLink {
  winPath: string; // normalized backslash Windows path without line/col suffix
  line?: number;
  col?: number;
}

const EXTERNAL_ONLY_EXT = new Set([
  'exe', 'com', 'msi', 'msp', 'lnk', 'url', 'scr', 'cpl', 'dll', 'sys', 'appref-ms', 'pif', 'msc', 'hta', 'pdf',
]);

// Parses a terminal link (`file:///G:/a/b.ts#L12C3` or `G:\a\b.ts:12:3`) into a local Windows path + optional line/col.
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
    p = pathname.replace(/\//g, '\\');
  } else if (/^[A-Za-z]:[\\/]/.test(raw)) {
    p = raw.replace(/\//g, '\\');
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
  const winPath = `${drive}\\${normSegs.join('\\')}`;
  return { winPath, ...(line !== undefined && { line }), ...(col !== undefined && { col }) };
}

export interface MatchedProjectFile {
  project: Project;
  relPosix: string;
  line?: number;
  col?: number;
}

// Finds the deepest registered project containing the parsed link path, excluding .git and external-only binaries.
export function matchProjectFileLink(rawUri: string, projects: Project[]): MatchedProjectFile | null {
  const parsed = parseLocalFileLink(rawUri);
  if (!parsed) return null;
  const targetLow = parsed.winPath.toLowerCase();

  // Deepest matching project wins if one project is nested inside another.
  const sorted = [...projects]
    .map((project) => ({
      project,
      rootNorm: project.path.replace(/\//g, '\\').replace(/\\+$/, ''),
    }))
    .sort((a, b) => b.rootNorm.length - a.rootNorm.length);

  for (const { project, rootNorm } of sorted) {
    const prefixLow = rootNorm.toLowerCase() + '\\';
    if (!targetLow.startsWith(prefixLow)) continue;
    const relPosix = parsed.winPath.slice(rootNorm.length + 1).replace(/\\/g, '/');
    if (!relPosix || relPosix.toLowerCase().startsWith('.git/') || relPosix.toLowerCase() === '.git') return null;
    const dot = relPosix.lastIndexOf('.');
    const ext = dot === -1 ? '' : relPosix.slice(dot + 1).toLowerCase();
    if (ext && EXTERNAL_ONLY_EXT.has(ext)) return null;
    return { project, relPosix, line: parsed.line, col: parsed.col };
  }
  return null;
}
