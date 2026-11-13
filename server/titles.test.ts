import { describe, expect, it } from 'vitest';
import { cleanTitle, promptPreview, titleFromPrompt, titleFromReply, titlePrompt, TITLE_PROMPT_HEAD } from './titles.ts';

describe('titleFromPrompt', () => {
  it('uses the first non-empty line with whitespace collapsed', () => {
    expect(titleFromPrompt('\n  \n  fix   the\tbug  \nsecond line')).toBe('fix the bug');
  });
  it('keeps exactly 24 code points, truncates 25 with an ellipsis', () => {
    expect(titleFromPrompt('中'.repeat(24))).toBe('中'.repeat(24));
    expect(titleFromPrompt('中'.repeat(25))).toBe('中'.repeat(24) + '…');
  });
  it('counts astral characters as one', () => {
    expect(titleFromPrompt('😀'.repeat(30))).toBe('😀'.repeat(24) + '…');
  });
  it('drops pasted-image placeholders and absolute paths', () => {
    expect(titleFromPrompt('[Image #1] [Image #2] 按截图修一下布局')).toBe('按截图修一下布局');
    expect(titleFromPrompt('C:\\Users\\me\\Desktop\\shot.png\n看看这个报错')).toBe('看看这个报错');
    expect(titleFromPrompt('"C:\\Program Files\\a b.png" 和 /home/me/x.log 对比')).toBe('和 对比');
    expect(titleFromPrompt('改 a/b 和 1/2 的比例')).toBe('改 a/b 和 1/2 的比例');
  });
  it('returns empty when nothing usable', () => {
    expect(titleFromPrompt('')).toBe('');
    expect(titleFromPrompt(' \n\t\n ')).toBe('');
  });
});

describe('cleanTitle', () => {
  it('cleans saved titles that start with placeholders or paths', () => {
    expect(cleanTitle('[Image #1] agy 在使用…')).toBe('agy 在使用…');
    expect(cleanTitle('[Image #1] [Image #2] 修布局')).toBe('修布局');
  });
  it('keeps the title when nothing usable is left, and leaves normal titles alone', () => {
    expect(cleanTitle('[Image #1] [Image #2] [I…')).toBe('[Image #1] [Image #2] [I…');
    expect(cleanTitle('C:\Users\Administrat…')).toBe('C:\Users\Administrat…');
    expect(cleanTitle('改 a/b 的比例')).toBe('改 a/b 的比例');
  });
});

describe('titlePrompt', () => {
  it('starts with the head and caps the requirement at 2000 characters', () => {
    const p = titlePrompt('a'.repeat(3000));
    expect(p.startsWith(TITLE_PROMPT_HEAD)).toBe(true);
    expect(p.split('任务需求：\n')[1]).toBe('a'.repeat(2000));
  });
});

describe('titleFromReply', () => {
  it('takes a plain line', () => {
    expect(titleFromReply('修复登录页崩溃')).toBe('修复登录页崩溃');
  });
  it('strips quotes, brackets and trailing full stops', () => {
    expect(titleFromReply('"Fix login crash."')).toBe('Fix login crash');
    expect(titleFromReply('「修复登录页」')).toBe('修复登录页');
    expect(titleFromReply('**《重构路由》**。')).toBe('重构路由');
    expect(titleFromReply('`add tests`')).toBe('add tests');
  });
  it('strips title prefixes and heading or list markers', () => {
    expect(titleFromReply('标题：修复登录')).toBe('修复登录');
    expect(titleFromReply('标题: 修复登录')).toBe('修复登录');
    expect(titleFromReply('TITLE: Fix login')).toBe('Fix login');
    expect(titleFromReply('# 修复登录')).toBe('修复登录');
    expect(titleFromReply('- 修复登录')).toBe('修复登录');
  });
  it('uses the first non-empty line only', () => {
    expect(titleFromReply('\n\n  修复登录  \n\n这是解释')).toBe('修复登录');
  });
  it('cuts over-long replies like titleFromPrompt', () => {
    expect(titleFromReply('中'.repeat(30))).toBe('中'.repeat(24) + '…');
  });
  it('returns an empty string when nothing is left', () => {
    expect(titleFromReply('')).toBe('');
    expect(titleFromReply('  \n \t ')).toBe('');
    expect(titleFromReply('""')).toBe('');
  });
});

describe('promptPreview', () => {
  it('joins all lines into one with whitespace collapsed', () => {
    expect(promptPreview('  修复登录\n\n  再加测试\r\nok ')).toBe('修复登录 再加测试 ok');
  });
  it('drops image placeholders and absolute paths', () => {
    expect(promptPreview('看 [Image #1] 和 "C:\\a b\\c.png" 以及 D:\\x\\y 的问题')).toBe('看 和 以及 的问题');
  });
  it('cuts at 120 code points', () => {
    expect(promptPreview('字'.repeat(130))).toBe('字'.repeat(120) + '…');
    expect(promptPreview('字'.repeat(120))).toBe('字'.repeat(120));
  });
  it('returns an empty string when nothing is left', () => {
    expect(promptPreview('')).toBe('');
    expect(promptPreview(' \n [Image #2] \n')).toBe('');
  });
});
