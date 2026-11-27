import { describe, expect, it } from 'vitest';
import { Marked, type Token } from 'marked';
import {
  findNextExplicitFilePathStart,
  isSingleExplicitFilePath,
  matchExplicitFilePathAtStart,
  matchProjectFileLink,
  parseLocalFileLink,
  splitExplicitFilePaths,
} from './linkParse.ts';
import type { Project } from '../../shared/protocol.ts';

const proj = (id: string, path: string): Project => ({ id, name: id, path, createdAt: 1 });

describe('parseLocalFileLink', () => {
  it('parses Windows paths, file: URIs, and line ranges (#L10-L20 / :12:3)', () => {
    expect(parseLocalFileLink('G:\\Workspace\\a\\b.ts:12:3')).toEqual({
      localPath: 'G:\\Workspace\\a\\b.ts',
      line: 12,
      col: 3,
    });
    expect(parseLocalFileLink('file:///G:/Workspace/a/b.ts#L10-L20')).toEqual({
      localPath: 'G:\\Workspace\\a\\b.ts',
      line: 10,
    });
    expect(parseLocalFileLink('/Users/alice/app/main.ts#L5C2-L8C9')).toEqual({
      localPath: '/Users/alice/app/main.ts',
      line: 5,
      col: 2,
    });
    expect(parseLocalFileLink('\\\\server\\share\\a.png')).toBeNull();
  });

  it('matches nested dot-directories inside a registered project', () => {
    const p = proj('p1', 'G:\\Workspace\\video-tool\\xiuxian-video');
    const m = matchProjectFileLink(
      'G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\box_preview.jpg',
      [p],
    );
    expect(m).toEqual({
      project: p,
      relPosix: '.studio/inpaint/inp_mwxgjvfg_727825/box_preview.jpg',
      line: undefined,
      col: undefined,
    });
  });
});

describe('splitExplicitFilePaths', () => {
  it('extracts all four Windows paths from Chinese bullet list including .studio hidden dirs', () => {
    const msg = [
      '系统已自动为你切好以下文件（请直接读取）：',
      '- 原图（2K 母版）：G:\\Workspace\\video-tool\\xiuxian-video\\assets\\concepts\\sop_stage1_sword_aligned\\kfA_aligned_2K.jpg',
      '- 带红框标注预览图（一眼看清要改哪里）：G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\box_preview.jpg',
      '- 带上下文留白的局部放大图：G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\roi_context.png',
      '- 羽化遮罩（白=修改区，黑=锁死区）：G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\mask.png',
    ].join('\n');

    const segs = splitExplicitFilePaths(msg);
    const files = segs.filter((s) => s.kind === 'file').map((s) => s.path);
    expect(files).toEqual([
      'G:\\Workspace\\video-tool\\xiuxian-video\\assets\\concepts\\sop_stage1_sword_aligned\\kfA_aligned_2K.jpg',
      'G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\box_preview.jpg',
      'G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\roi_context.png',
      'G:\\Workspace\\video-tool\\xiuxian-video\\.studio\\inpaint\\inp_mwxgjvfg_727825\\mask.png',
    ]);
    // Reassembling every segment reproduces the exact original string losslessly.
    expect(segs.map((s) => s.text).join('')).toBe(msg);
  });

  it('stops cleanly before Chinese/ASCII punctuation while preserving balanced parens and Chinese filenames', () => {
    const msg = '见图（D:\\资料\\修仙_2K.png）、(G:\\a\\shot(1).jpg) 和 G:\\a\\App.tsx:42:5。另见「file:///G:/a/b.ts#L10-L20」！';
    const segs = splitExplicitFilePaths(msg);
    expect(segs.filter((s) => s.kind === 'file').map((s) => s.path)).toEqual([
      'D:\\资料\\修仙_2K.png',
      'G:\\a\\shot(1).jpg',
      'G:\\a\\App.tsx:42:5',
      'file:///G:/a/b.ts#L10-L20',
    ]);
    expect(segs.map((s) => s.text).join('')).toBe(msg);
  });

  it('matches quoted paths containing spaces and leaves quotes outside the clickable link', () => {
    const msg = '打开 "G:\\My Files\\shot 1.png" 查看效果';
    const segs = splitExplicitFilePaths(msg);
    expect(segs).toEqual([
      { kind: 'text', text: '打开 "' },
      { kind: 'file', text: 'G:\\My Files\\shot 1.png', path: 'G:\\My Files\\shot 1.png' },
      { kind: 'text', text: '" 查看效果' },
    ]);
  });

  it('handles POSIX absolute paths and current POSIX projectPath without matching URLs or API routes', () => {
    const msg = '访问 https://example.com/Users/bob/img.png 或 GET /api/v1/users.json，本地在 /Users/bob/proj/shot.png 与 /data/work/out.webp，命令 /compact';
    const segs = splitExplicitFilePaths(msg, '/data/work');
    expect(segs.filter((s) => s.kind === 'file').map((s) => s.path)).toEqual([
      '/Users/bob/proj/shot.png',
      '/data/work/out.webp',
    ]);
  });

  it('ignores bare folders, UNC paths, drive roots, and versioned directories', () => {
    const msg = '目录 G:\\Workspace\\xiuxian-video、G:\\Workspace\\app-v1.0、C:\\ 与 \\\\server\\share\\a.png，文件 G:\\proj\\.env 和 G:\\proj\\Makefile';
    const segs = splitExplicitFilePaths(msg);
    expect(segs.filter((s) => s.kind === 'file').map((s) => s.path)).toEqual([
      'G:\\proj\\.env',
      'G:\\proj\\Makefile',
    ]);
  });
});

describe('marked helper integration', () => {
  it('finds start and matches at start including quoted paths', () => {
    const s = '请看 "G:\\My Files\\box_preview.jpg" 确认';
    const idx = findNextExplicitFilePathStart(s);
    expect(idx).toBe(4);
    expect(matchExplicitFilePathAtStart(s.slice(idx), '"')).toEqual({
      raw: 'G:\\My Files\\box_preview.jpg',
      path: 'G:\\My Files\\box_preview.jpg',
    });
  });

  it('recognizes standalone inline-code file paths including spaces', () => {
    expect(isSingleExplicitFilePath('G:\\Workspace\\xiuxian-video\\.studio\\inpaint\\mask.png')).toBe(
      'G:\\Workspace\\xiuxian-video\\.studio\\inpaint\\mask.png',
    );
    expect(isSingleExplicitFilePath('G:\\My Folder\\shot 1.png')).toBe('G:\\My Folder\\shot 1.png');
    expect(isSingleExplicitFilePath('C:\\demo\\shot, final.png')).toBe('C:\\demo\\shot, final.png');
    expect(isSingleExplicitFilePath('G:\\a\\b.png extra words')).toBeNull();
    expect(isSingleExplicitFilePath('src/App.tsx')).toBeNull();
  });

  it('handles comma/semicolon-separated Windows paths, Chinese quotes with spaces, and quoted paths with :line:col', () => {
    const msg = 'C:\\demo\\one.png,C:\\demo\\two.png;C:\\demo\\three.jpg 与 “C:\\My Folder\\shot 1.png” 及 「C:\\My Folder\\mask 2.png」 还有 "C:\\My Folder\\main.ts":12:3';
    const segs = splitExplicitFilePaths(msg);
    expect(segs.filter((s) => s.kind === 'file').map((s) => ({ text: s.text, path: s.path }))).toEqual([
      { text: 'C:\\demo\\one.png', path: 'C:\\demo\\one.png' },
      { text: 'C:\\demo\\two.png', path: 'C:\\demo\\two.png' },
      { text: 'C:\\demo\\three.jpg', path: 'C:\\demo\\three.jpg' },
      { text: 'C:\\My Folder\\shot 1.png', path: 'C:\\My Folder\\shot 1.png' },
      { text: 'C:\\My Folder\\mask 2.png', path: 'C:\\My Folder\\mask 2.png' },
      { text: 'C:\\My Folder\\main.ts', path: 'C:\\My Folder\\main.ts:12:3' },
    ]);
    expect(segs.map((s) => s.text).join('')).toBe(msg);
    expect(isSingleExplicitFilePath('"C:\\My Folder\\main.ts":12:3')).toBe('C:\\My Folder\\main.ts:12:3');
    expect(isSingleExplicitFilePath('“C:\\My Folder\\shot 1.png”')).toBe('C:\\My Folder\\shot 1.png');
  });

  it('stays fast (linear time) on adversarial 64KB messages in both plain scanner and marked lexer', () => {
    const md = new Marked({
      gfm: true,
      extensions: [
        {
          name: 'localFilePath',
          level: 'inline',
          start(src: string) {
            return findNextExplicitFilePathStart(src);
          },
          tokenizer(src: string, tokens: Token[]) {
            const prev = tokens[tokens.length - 1];
            const prevRaw = prev && 'raw' in prev ? String(prev.raw ?? '') : '';
            const prevChar = prevRaw ? prevRaw[prevRaw.length - 1] : undefined;
            const hit = matchExplicitFilePathAtStart(src, prevChar);
            return hit ? { type: 'localFilePath', raw: hit.raw, path: hit.path } : undefined;
          },
        },
      ],
    });
    const parens = `prefix C:\\demo\\a${')'.repeat(32_000)} suffix`;
    const manyBareDirs = `${'C:\\demo\\dir '.repeat(2_500)}C:\\demo\\ok.png`;
    const slashes = `${'a/b_c '.repeat(5_000)}G:\\proj\\.studio\\box_preview.jpg`;
    const t0 = performance.now();
    const s1 = splitExplicitFilePaths(parens);
    const s2 = splitExplicitFilePaths(manyBareDirs);
    const s3 = splitExplicitFilePaths(slashes);
    md.lexer(parens);
    md.lexer(manyBareDirs);
    md.lexer(slashes);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(250);
    expect(s1.filter((s) => s.kind === 'file')).toEqual([]);
    expect(s2.filter((s) => s.kind === 'file').map((s) => s.path)).toEqual(['C:\\demo\\ok.png']);
    expect(s3.filter((s) => s.kind === 'file').map((s) => s.path)).toEqual(['G:\\proj\\.studio\\box_preview.jpg']);
  });
});
