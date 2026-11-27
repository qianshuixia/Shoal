import { describe, expect, it } from 'vitest';
import { parseStreamData } from './stream.ts';
import { parseTranscript } from './transcript.ts';

const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: 'message', id, parentId, message: { role, content },
});

describe('Pi conversation branches', () => {
  const raw = [
    message('root', null, 'user', '原始问题'),
    message('reply', 'root', 'assistant', [{ type: 'thinking', thinking: '分析' }, { type: 'text', text: '分支 A' }]),
    message('tool', 'root', 'assistant', [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'src.ts' } }]),
    { ...message('result', 'tool', 'toolResult', []), message: { role: 'toolResult', toolCallId: 'call', isError: false } },
    message('alternate', 'result', 'assistant', [{ type: 'text', text: '分支 B' }]),
  ].map(v => JSON.stringify(v)).join('\n');

  it('uses the selected branch for handoff and rich conversation history', () => {
    expect(parseTranscript('pi', raw, 'reply')).toEqual([
      { role: 'user', text: '原始问题' }, { role: 'assistant', text: '分支 A' },
    ]);
    expect(parseStreamData('pi', raw, 'pi').blocks).toMatchObject([
      { kind: 'user', text: '原始问题' },
      { kind: 'step', active: false, tools: [{ name: 'read', status: 'done' }] },
      { kind: 'assistant', text: '分支 B' },
    ]);
    expect(parseTranscript('pi', raw, null)).toEqual([]);
  });
});
