import { describe, expect, it } from 'vitest';
import { parseAgyUsageOutput } from './agyQuota.ts';

describe('parseAgyUsageOutput', () => {
  it('parses official agy --print=/usage JSON with active Gemini pools and unstarted 3p pools', () => {
    const raw = JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.995, reset_time: '2026-12-03T07:15:38Z' },
                { id: 'gemini-5h', window: '5h', remaining_fraction: 0.98, reset_time: '2026-11-26T12:15:38Z' },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
                { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
              ],
            },
          ],
        },
      },
    });
    expect(parseAgyUsageOutput(raw)).toEqual([
      { label: '5h', usedPercent: 2, resetsAt: Date.parse('2026-11-26T12:15:38Z'), windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
      { label: '7d', usedPercent: 0.5, resetsAt: Date.parse('2026-12-03T07:15:38Z'), windowMinutes: 10080, pool: 'gemini', poolLabel: 'Gemini', primary: true },
      { label: '5h', usedPercent: 0, resetsAt: 0, unstarted: true, windowMinutes: 300, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
      { label: '7d', usedPercent: 0, resetsAt: 0, unstarted: true, windowMinutes: 10080, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
    ]);
  });

  it('infers pool keys when bucket.id is absent and skips disabled buckets', () => {
    const raw = JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { window: '5h', remaining_fraction: 0.75, reset_time: '2026-11-26T12:15:38Z' },
                { window: 'weekly', disabled: true, remaining_fraction: 0.5, reset_time: '2026-12-03T07:15:38Z' },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                { window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
              ],
            },
          ],
        },
      },
    });
    expect(parseAgyUsageOutput(raw)).toEqual([
      { label: '5h', usedPercent: 25, resetsAt: Date.parse('2026-11-26T12:15:38Z'), windowMinutes: 300, pool: 'gemini', poolLabel: 'Gemini', primary: true },
      { label: '5h', usedPercent: 0, resetsAt: 0, unstarted: true, windowMinutes: 300, pool: '3p', poolLabel: 'Claude & GPT 共享', primary: false },
    ]);
  });

  it('rejects failed, non-usage, multi-turn or malformed payloads', () => {
    expect(parseAgyUsageOutput('')).toEqual([]);
    expect(parseAgyUsageOutput('{bad')).toEqual([]);
    expect(parseAgyUsageOutput(JSON.stringify({ status: 'ERROR', command: { name: 'usage', data: { groups: [] } } }))).toEqual([]);
    expect(parseAgyUsageOutput(JSON.stringify({ status: 'SUCCESS', num_turns: 1, command: { name: 'usage', data: { groups: [] } } }))).toEqual([]);
    expect(parseAgyUsageOutput(JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'help', data: { groups: [] } } }))).toEqual([]);
  });
});
