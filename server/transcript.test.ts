import { describe, it, expect } from 'vitest';
import { excerpt, parseTranscript } from './transcript.ts';
import type { Turn } from './transcript.ts';

const jl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n');

describe('parseTranscript', () => {
  it('claude: keeps user text, assistant text and tool calls; skips tool results, reminders, sidechains and API error lines', () => {
    const turns = parseTranscript('claude', jl(
      { type: 'user', message: { content: '修一下登录' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: '<system-reminder>hi</system-reminder>' }] } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', isMeta: true, message: { content: 'meta' } },
      { type: 'user', isSidechain: true, message: { content: 'side' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } },
      { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: "You've hit your limit" }] } },
      { type: 'system', content: 'x' },
    ) + '\nnot json');
    expect(turns).toEqual([
      { role: 'user', text: '修一下登录' },
      { role: 'assistant', text: '好的' },
      { role: 'tool', text: 'Read {"file_path":"a.ts"}' },
    ]);
  });

  it('codex: reads response_item messages and tool calls; skips developer, AGENTS.md and tag-prefixed user text', () => {
    const msg = (role: string, type: string, text: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } });
    const turns = parseTranscript('codex', jl(
      msg('developer', 'input_text', 'rules'),
      msg('user', 'input_text', '# AGENTS.md instructions for x'),
      msg('user', 'input_text', '<environment_context>..</environment_context>'),
      msg('user', 'input_text', '加个按钮'),
      msg('assistant', 'output_text', '加好了'),
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** patch' } },
      { type: 'event_msg', payload: {} },
    ));
    expect(turns).toEqual([
      { role: 'user', text: '加个按钮' },
      { role: 'assistant', text: '加好了' },
      { role: 'tool', text: 'shell {"cmd":"ls"}' },
      { role: 'tool', text: 'apply_patch *** patch' },
    ]);
  });

  it('agy: explicit user input without the wrapper or injected metadata, planner text and tool calls; GENERIC and implicit input are skipped', () => {
    const turns = parseTranscript('agy', jl(
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '<USER_REQUEST>\n做首页\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-25T12:17:25+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel changed\n</USER_SETTINGS_CHANGE>',
      },
      { type: 'USER_INPUT', source: 'SYSTEM', content: 'ctx' },
      { type: 'PLANNER_RESPONSE', content: '', thinking: 'hmm', tool_calls: [{ name: 'view_file', args: { path: 'a' } }] },
      { type: 'PLANNER_RESPONSE', content: '完成', tool_calls: [] },
      { type: 'GENERIC', content: 'x' },
    ));
    expect(turns).toEqual([
      { role: 'user', text: '做首页' },
      { role: 'tool', text: 'view_file {"path":"a"}' },
      { role: 'assistant', text: '完成' },
    ]);
  });

  it('fake: one {role,text} per line', () => {
    expect(parseTranscript('fake', jl({ role: 'user', text: 'a' }, { role: 'assistant', text: 'reply: a' }))).toHaveLength(2);
  });
});

describe('excerpt', () => {
  const turns: Turn[] = [
    { role: 'user', text: 'FIRST ' + 'a'.repeat(3000) },
    ...Array.from({ length: 30 }, (_, i): Turn => ({ role: i % 2 ? 'tool' : 'assistant', text: `step ${i} ` + 'x'.repeat(1000) })),
    { role: 'user', text: 'LAST' },
    { role: 'assistant', text: 'end' },
  ];

  it('keeps the first and last user turn, marks the omitted range and stays near the budget', () => {
    const out = excerpt(turns, 5000);
    expect(out).toContain('【用户】FIRST');
    expect(out).toContain('【用户】LAST');
    expect(out).toContain('【agent】end');
    expect(out).toMatch(/（中间省略了 \d+ 条记录）/);
    expect(out).not.toContain('step 0 ');
    expect(out.length).toBeLessThanOrEqual(5000 + 2000 + 2000 + 1500);
    expect(out.indexOf('FIRST')).toBeLessThan(out.indexOf('LAST'));
  });

  it('shows everything when the budget allows, and an empty list gives an empty string', () => {
    const small: Turn[] = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }, { role: 'tool', text: 'Bash ls\nmore' }];
    expect(excerpt(small, 1000)).toBe('【用户】hi\n【agent】yo\n【工具】Bash ls');
    expect(excerpt([], 1000)).toBe('');
  });
});
