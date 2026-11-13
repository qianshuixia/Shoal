const MAX_TITLE = 24;

// Pasted-image placeholders and absolute file paths say nothing about the task.
const NOISE = /\[Image #\d+\]|"(?:[A-Za-z]:[\\/]|\/)[^"]*"|(?<=^|\s)(?:[A-Za-z]:[\\/]|\/(?=[^\s/]+\/))\S*/g;

// First line with real words (noise removed, whitespace collapsed), cut to 24 code points (+ '…'). '' if nothing usable.
export function titleFromPrompt(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const s = line.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const cps = [...s];
    return cps.length > MAX_TITLE ? cps.slice(0, MAX_TITLE).join('') + '…' : s;
  }
  return '';
}

const MAX_PREVIEW = 120;

// Whole prompt on one line (noise removed, whitespace collapsed), cut to 120 code points (+ '…'). '' if nothing usable.
export function promptPreview(text: string): string {
  const s = text.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...s];
  return cps.length > MAX_PREVIEW ? cps.slice(0, MAX_PREVIEW).join('') + '…' : s;
}

// A title saved before the noise filter existed, cleaned the same way; unchanged if cleaning leaves nothing.
// A placeholder cut off by the 24-character limit ("[Ima…") goes too.
export function cleanTitle(title: string): string {
  const s = title.replace(NOISE, ' ').replace(/\[[^\]]*…$/, '').replace(/\s+/g, ' ').trim();
  return s && s !== '…' ? s : title;
}

export const TITLE_PROMPT_HEAD = '给下面这个编程任务起一个标题。';

// Prompt for the headless title call; the requirement is capped at 2000 characters.
export function titlePrompt(text: string): string {
  const capped = text.trim().slice(0, 2000);
  return `${TITLE_PROMPT_HEAD}只输出标题本身：一行，不超过 16 个汉字（英文不超过 8 个词），用需求所用的语言，不加引号、句号、前缀和任何解释，不要使用工具。

任务需求：
${capped}`;
}

const WRAPS: [string, string][] = [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」'], ['《', '》'], ['`', '`'], ['**', '**'], ['(', ')'], ['[', ']'], ['（', '）'], ['【', '】']];

// The title out of a model's reply; '' if nothing usable.
export function titleFromReply(out: string): string {
  let s = out.split(/\r\n|\r|\n/).map(l => l.trim()).find(l => l) ?? '';
  s = s.replace(/^(?:#+|[-*])\s+/, '').replace(/^(?:标题\s*[：:]|title\s*:)\s*/i, '').trim();
  for (let again = true; again;) {
    again = false;
    s = s.replace(/[。.]$/, '');
    for (const [a, b] of WRAPS) {
      if (s.length >= a.length + b.length && s.startsWith(a) && s.endsWith(b)) { s = s.slice(a.length, s.length - b.length).trim(); again = true; }
    }
  }
  s = s.replace(/[。.]$/, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cps = [...s];
  return cps.length > MAX_TITLE ? cps.slice(0, MAX_TITLE).join('') + '…' : s;
}
