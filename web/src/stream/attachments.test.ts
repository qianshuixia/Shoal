import { describe, expect, it } from 'vitest';
import { attachmentCategoryOf, parseUserMessage } from './attachments.ts';

describe('parseUserMessage', () => {
  it('splits the body from the trailing path line the server appends, unquoting paths with spaces', () => {
    const text = '请帮我看\n"G:\\p\\需求 说明.md" G:\\p\\demo-clip.mp4 C:\\Users\\a\\AppData\\attachments\\1732-screen.mp4';
    const r = parseUserMessage(text);
    expect(r.body).toBe('请帮我看');
    expect(r.files.map((f) => f.name)).toEqual(['需求 说明.md', 'demo-clip.mp4', '1732-screen.mp4']);
    expect(r.files[0].path).toBe('G:\\p\\需求 说明.md');
    expect(r.files[0].category).toBe('markdown');
    expect(r.files[1].category).toBe('video');
  });

  it('keeps dirPrefix + name equal to the full path so the original path stays recoverable from the chip', () => {
    const p = 'G:\\proj\\demo-clip.mp4';
    const [f] = parseUserMessage(`hi\n${p}`).files;
    expect(f.dirPrefix + f.name).toBe(p);
    expect(f.dirPrefix).toBe('G:\\proj\\');
  });

  it('marks files inside the managed attachments dir as uploads', () => {
    const r = parseUserMessage('x\nC:\\state\\attachments\\17-a.png /home/u/notes/todo.md');
    expect(r.files[0].managed).toBe(true);
    expect(r.files[1].managed).toBe(false);
    expect(r.files[1].dirPrefix).toBe('/home/u/notes/');
  });

  it('handles an attachments-only message (empty body) and Chinese file names', () => {
    const r = parseUserMessage('D:\\资料\\季度报告.pdf');
    expect(r.body).toBe('');
    expect(r.files).toHaveLength(1);
    expect(r.files[0].name).toBe('季度报告.pdf');
    expect(r.files[0].category).toBe('doc');
  });

  it('does not turn ordinary text, slash commands or mixed lines into chips', () => {
    for (const t of ['just words', '/compact', '/help me', 'see C:\\a\\b.txt for details', '看看\n/compact']) {
      const r = parseUserMessage(t);
      expect(r.files, t).toEqual([]);
      expect(r.body, t).toBe(t);
    }
  });

  it('keeps multi-line bodies intact and only strips trailing path lines', () => {
    const r = parseUserMessage('line1\nline2\n\n"C:\\a b\\c.txt"');
    expect(r.body).toBe('line1\nline2');
    expect(r.files.map((f) => f.path)).toEqual(['C:\\a b\\c.txt']);
  });

  it('rejects a line with an unterminated quote instead of guessing', () => {
    const r = parseUserMessage('x\n"C:\\a b\\c.txt');
    expect(r.files).toEqual([]);
  });
});

describe('attachmentCategoryOf', () => {
  it('classifies by extension', () => {
    expect(attachmentCategoryOf('a.PNG')).toBe('image');
    expect(attachmentCategoryOf('a.mkv')).toBe('video');
    expect(attachmentCategoryOf('a.ts')).toBe('code');
    expect(attachmentCategoryOf('a.zip')).toBe('archive');
    expect(attachmentCategoryOf('Makefile')).toBe('file');
  });
});
