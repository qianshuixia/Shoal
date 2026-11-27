import { fileBase } from './format.ts';

export type AttachmentCategory = 'image' | 'video' | 'audio' | 'markdown' | 'doc' | 'code' | 'archive' | 'file';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|tiff?)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v|ogv|wmv|flv)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|flac|aac|opus|wma)$/i;
const MD_EXT_RE = /\.(md|markdown|mdx)$/i;
const DOC_EXT_RE = /\.(pdf|docx?|rtf|txt|csv|tsv|xlsx?|pptx?|epub|log)$/i;
const CODE_EXT_RE = /\.(json|jsonl|ya?ml|toml|xml|html?|css|scss|less|[cm]?[jt]sx?|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|ps1|sql|graphql|proto|ini|conf|env|diff|patch)$/i;
const ARCHIVE_EXT_RE = /\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i;

export function attachmentCategoryOf(label: string): AttachmentCategory {
  if (IMAGE_EXT_RE.test(label)) return 'image';
  if (VIDEO_EXT_RE.test(label)) return 'video';
  if (AUDIO_EXT_RE.test(label)) return 'audio';
  if (MD_EXT_RE.test(label)) return 'markdown';
  if (DOC_EXT_RE.test(label)) return 'doc';
  if (CODE_EXT_RE.test(label)) return 'code';
  if (ARCHIVE_EXT_RE.test(label)) return 'archive';
  return 'file';
}

export interface ParsedMessageFile {
  path: string; // full absolute path exactly as it was sent
  name: string; // file name only
  dirPrefix: string; // path minus the file name, including the trailing separator
  category: AttachmentCategory;
  managed: boolean; // lives in Shoal's own <stateDir>/attachments (an upload)
}

export interface ParsedUserMessage {
  body: string;
  files: ParsedMessageFile[];
}

// Windows drive / UNC paths, or a POSIX path with at least two segments (so "/compact" stays a command).
function isAbsolutePathToken(t: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(t) || /^\\\\[^\\]/.test(t) || /^\/[^/\s]+\/\S/.test(t);
}

// Splits a line into space-separated tokens where a token may be wrapped in double quotes (paths with spaces).
function tokenizeLine(line: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) return null;
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j++;
    tokens.push(line.slice(i, j));
    i = j;
  }
  return tokens;
}

function toParsedFile(p: string): ParsedMessageFile {
  const name = fileBase(p);
  const trimmed = p.replace(/[\\/]+$/, '');
  const dirPrefix = trimmed.endsWith(name) ? trimmed.slice(0, trimmed.length - name.length) : '';
  return {
    path: p,
    name,
    dirPrefix,
    category: attachmentCategoryOf(name),
    managed: /[\\/]attachments[\\/]$/.test(dirPrefix),
  };
}

// Server `feedback()` appends attachments as `body\n<space-joined paths>` (quoted when a path has spaces).
// Trailing lines made only of absolute paths become chips; everything else stays as the plain body.
export function parseUserMessage(text: string): ParsedUserMessage {
  const lines = text.split('\n');
  const files: ParsedMessageFile[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (!line) {
      // blank line between body and the path line: only skippable once we already collected files
      if (files.length > 0) {
        end--;
        continue;
      }
      break;
    }
    const tokens = tokenizeLine(line);
    if (!tokens || tokens.length === 0 || !tokens.every(isAbsolutePathToken)) break;
    files.unshift(...tokens.map(toParsedFile));
    end--;
  }
  if (files.length === 0) return { body: text, files: [] };
  return { body: lines.slice(0, end).join('\n').replace(/\s+$/, ''), files };
}
