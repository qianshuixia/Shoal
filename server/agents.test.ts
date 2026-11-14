import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agyConversationState, agyResumeId, agyTranscriptFile, agyUserStatusLine, buildGenerator, buildLaunch, claudeResumeId, FULL_ACCESS, NODE, NOTIFY, shortPath, userStatusLine, writeHookFiles } from './agents.ts';
import { pickColor } from './store.ts';
import { TASK_COLORS } from '../shared/protocol.ts';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
const build = (agent: 'claude' | 'codex' | 'agy' | 'fake', prompt: string, sessionId = 'sid') =>
  buildLaunch({ agent, sessionId, prompt, stateDir });

describe('buildLaunch', () => {
  it('codex hook args are byte-identical to the M0 probe format and never bypass trust', () => {
    const { args } = build('codex', 'do it');
    const hookToml = (ev: string) => `hooks.${ev}=[{hooks=[{type="command",command='${NODE} "${NOTIFY}" codex ${ev}',timeout=5}]}]`;
    expect(args.slice(1)).toEqual([
      '-c', hookToml('SessionStart'),
      '-c', hookToml('UserPromptSubmit'),
      '-c', hookToml('Stop'),
      '-c', hookToml('PermissionRequest'),
      '-c', 'check_for_update_on_startup=false',
      '--dangerously-bypass-approvals-and-sandbox',
      'do it',
    ]);
    expect(args.join(' ')).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('claude puts the prompt last and knows its native session id', () => {
    const l = build('claude', 'hello');
    expect(l.args.at(-1)).toBe('hello');
    expect(l.args[0]).toBe('--session-id');
    expect(l.args[1]).toBe(l.nativeSessionId);
    expect(build('claude', '').args.slice(-2)).toEqual([expect.stringMatching(/claude-hooks\.json$/), '--dangerously-skip-permissions']);
  });

  it('resume uses each CLI\'s M0-verified command, keeps the native id and the codex hook flags', () => {
    const resume = (agent: 'claude' | 'codex' | 'agy' | 'fake') => buildLaunch({ agent, sessionId: 's', prompt: 'ignored', stateDir, resume: 'n-1' });
    const c = resume('claude');
    expect(c.args.slice(0, 2)).toEqual(['--resume', 'n-1']);
    expect(c.nativeSessionId).toBe('n-1');
    const x = resume('codex');
    expect(x.args.slice(1, 3)).toEqual(['resume', 'n-1']);
    expect(x.args.slice(3)).toEqual(build('codex', '').args.slice(1)); // trust hashes still match
    expect(resume('agy').args.slice(0, 2)).toEqual(['--conversation', 'n-1']);
    for (const a of ['claude', 'codex', 'agy', 'fake'] as const) {
      expect(resume(a).args).not.toContain('ignored');
      expect(resume(a).nativeSessionId).toBe('n-1');
    }
  });

  it('every real CLI starts with full permissions, new and resumed', () => {
    expect(FULL_ACCESS).toEqual({
      claude: '--dangerously-skip-permissions',
      codex: '--dangerously-bypass-approvals-and-sandbox',
      agy: '--dangerously-skip-permissions',
    });
    for (const a of ['claude', 'codex', 'agy'] as const) {
      expect(build(a, 'x').args).toContain(FULL_ACCESS[a]);
      expect(build(a, '').args).toContain(FULL_ACCESS[a]);
      expect(buildLaunch({ agent: a, sessionId: 's', prompt: '', stateDir, resume: 'n-1' }).args).toContain(FULL_ACCESS[a]);
    }
    expect(build('fake', 'x').args.join(' ')).not.toContain('--dangerously');
  });

  it('agy uses -i for the prompt and passes --settings for statusLine', () => {
    const a = build('agy', 'hi');
    expect(a.args.slice(-2)).toEqual(['-i', 'hi']);
    expect(a.args.slice(0, 2)).toEqual(['--settings', expect.stringMatching(/agy-settings\.json$/)]);
    expect(build('agy', '').args).not.toContain('-i');
  });

  it('long prompts go to a file; leading dash gets a space', () => {
    const l = build('fake', 'x'.repeat(8001), 'long-1');
    const file = path.join(stateDir, 'prompts', 'long-1.md');
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(8001);
    expect(l.args.at(-1)).toContain(file);
    expect(build('fake', '-rf').args.at(-1)).toBe(' -rf');
  });
});

describe('agy hook and settings files', () => {
  it('commands contain no quotes and agy-settings.json stacks under the default status line', async () => {
    const { writeHookFiles } = await import('./agents.ts');
    const prev = process.env.AGY_CONFIG_DIR;
    process.env.AGY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agy-cfg-'));
    try {
      writeHookFiles(stateDir);
    } finally {
      if (prev === undefined) delete process.env.AGY_CONFIG_DIR; else process.env.AGY_CONFIG_DIR = prev;
    }
    const file = path.join(stateDir, 'agy-hooks', '.agents', 'hooks.json');
    if (!fs.existsSync(file)) return; // repo path contains a space: agy disabled
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cmds = Object.values(cfg.workbench).flatMap(v => (v as { command: string }[]).map(h => h.command));
    expect(cmds).toHaveLength(4);
    for (const c of cmds) expect(c).not.toMatch(/["']/);
    const settings = JSON.parse(fs.readFileSync(path.join(stateDir, 'agy-settings.json'), 'utf8'));
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: expect.stringMatching(/statusline\.mjs agy$/),
      enabled: true,
      stack_with_default: true,
      padding: 0,
    });
    expect(settings.statusLine.command).not.toMatch(/["']/);
  });

  it.runIf(process.platform === 'win32')('shortPath keeps lowercase .mjs so Node ESM loader accepts paths under spaced dirs', () => {
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), 'wb space dir '));
    const hooksDir = path.join(spaced, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const statusline = path.join(hooksDir, 'statusline.mjs');
    const spacedFile = path.join(hooksDir, 'my statusline.mjs');
    fs.writeFileSync(statusline, 'process.stdout.write("ok");\n');
    fs.writeFileSync(spacedFile, 'process.stdout.write("ok");\n');
    try {
      const s1 = shortPath(statusline);
      if (!s1.includes(' ')) {
        expect(path.basename(s1)).toBe('statusline.mjs');
        expect(execFileSync(process.execPath, [s1], { encoding: 'utf8' })).toBe('ok');
      }
      const s2 = shortPath(spacedFile);
      if (!s2.includes(' ')) {
        expect(path.extname(s2)).toBe('.mjs');
        expect(execFileSync(process.execPath, [s2], { encoding: 'utf8' })).toBe('ok');
      }
    } finally {
      fs.rmSync(spaced, { recursive: true, force: true });
    }
  });

  it('agyUserStatusLine reads ~/.gemini/antigravity-cli/settings.json and expands leading ~', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agy-sl-'));
    const prev = process.env.AGY_CONFIG_DIR;
    process.env.AGY_CONFIG_DIR = dir;
    try {
      expect(agyUserStatusLine()).toEqual({ stackWithDefault: true, padding: 0 });
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { command: '~/my-sl.sh', stack_with_default: false, padding: 1 } }));
      expect(agyUserStatusLine()).toEqual({ command: `${os.homedir()}/my-sl.sh`, stackWithDefault: false, padding: 1 });
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { command: '~/my-sl.sh', enabled: false } }));
      expect(agyUserStatusLine()).toEqual({ stackWithDefault: true, padding: 0 });
    } finally {
      if (prev === undefined) delete process.env.AGY_CONFIG_DIR; else process.env.AGY_CONFIG_DIR = prev;
    }
  });
});

describe('pickColor', () => {
  it('picks the least used color, ties to the first', () => {
    expect(pickColor([])).toBe(TASK_COLORS[0]);
    expect(pickColor([{ color: TASK_COLORS[0] }])).toBe(TASK_COLORS[1]);
    const all = TASK_COLORS.map(color => ({ color }));
    expect(pickColor([...all, { color: TASK_COLORS[0] }, { color: TASK_COLORS[1] }])).toBe(TASK_COLORS[2]);
    expect(pickColor([...all.slice(0, 8)])).toBe(TASK_COLORS[8]);
  });
});

describe('buildGenerator', () => {
  const gen = (agent: 'claude' | 'codex' | 'agy' | 'fake', prompt = 'PROMPT') => buildGenerator(agent, prompt, 'OUT.md');

  it('claude: headless haiku without tools or session, prompt on stdin, no --bare', () => {
    const g = gen('claude')!;
    expect(g.args).toEqual(['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence']);
    expect(g.args).not.toContain('--bare');
    expect(g.stdin).toBe('PROMPT');
    expect(g.outFile).toBeNull();
  });

  it('codex: ephemeral read-only exec, no -m, result in the output file, prompt on stdin', () => {
    const g = gen('codex')!;
    expect(g.args).not.toContain('-m');
    expect(g.args.slice(-3)).toEqual(['-o', 'OUT.md', '-']);
    expect(g.args).toContain('--ephemeral');
    expect(g.stdin).toBe('PROMPT');
    expect(g.outFile).toBe('OUT.md');
  });

  it('agy: headless -p is disabled (returns null) to protect account policy and avoid sidecar sprawl', () => {
    expect(gen('agy')).toBeNull();
    expect(gen('agy', '-x')).toBeNull();
  });

  it('fake: runs the fake generator script with the prompt on stdin', () => {
    const g = gen('fake')!;
    expect(g.args[0]).toMatch(/fake-handoff\.mjs$/);
    expect(g.stdin).toBe('PROMPT');
  });
});

describe('claudeResumeId', () => {
  const OLD = '11111111-1111-4111-8111-111111111111';
  const LIVE = '22222222-2222-4222-8222-222222222222';
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-claude-cfg-'));
  const slug = path.join(cfg, 'projects', 'G--proj');
  fs.mkdirSync(slug, { recursive: true });
  const livePath = path.join(slug, `${LIVE}.jsonl`);
  fs.writeFileSync(livePath, '{}\n');

  const withConfig = <T>(fn: () => T): T => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  };

  it('keeps the recorded id when its conversation exists', () => {
    expect(withConfig(() => claudeResumeId(LIVE, undefined))).toBe(LIVE);
  });

  it('falls back to the transcript uuid when the recorded id has no conversation', () => {
    expect(withConfig(() => claudeResumeId(OLD, livePath))).toBe(LIVE);
    expect(withConfig(() => claudeResumeId(null, livePath))).toBe(LIVE);
  });

  it('accepts a \\\\?\\ prefixed transcript path', () => {
    expect(withConfig(() => claudeResumeId(OLD, `\\\\?\\${livePath}`))).toBe(LIVE);
  });

  it('is undefined when neither exists, or the transcript name is not a uuid', () => {
    expect(withConfig(() => claudeResumeId(OLD, undefined))).toBeUndefined();
    expect(withConfig(() => claudeResumeId(OLD, path.join(slug, `${OLD}.jsonl`)))).toBeUndefined();
    const odd = path.join(slug, 'notes.jsonl');
    fs.writeFileSync(odd, '');
    expect(withConfig(() => claudeResumeId(OLD, odd))).toBeUndefined();
  });
});

describe('agyConversationState and agyResumeId', () => {
  const MAIN = 'ae1cac0a-c6a3-47d3-968f-06ba2f139408';
  const REV3 = '27e3af25-4cf9-449a-abb1-a1a9067c3ee7';
  const BOARD = '4f248e7c-98c1-4d50-94c3-036f8054f7c3';
  const COORD = 'c3672606-125b-4c58-a696-9fa210e37ab0';
  const WORKER = 'e41d8e7e-ff77-42b6-9a3e-19e4e651aadb';
  const ADOPTED = '99999999-9999-4999-8999-999999999999';
  const NESTED = '8d41fe36-576f-43a3-ba8f-23781cf46302';
  const MISSING = 'deadbeef-dead-4eef-8eef-deadbeefdead';

  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agy-resume-'));
  const writeBrain = (id: string, entries: unknown[], fileName = 'transcript.jsonl') => {
    const f = path.join(cfg, 'brain', id, '.system_generated', 'logs', fileName);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return f;
  };

  // Main conversation even with a >20 KB initial prompt (exceeds one 16 KB read chunk).
  const mainTp = writeBrain(MAIN, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>${'x'.repeat(22_000)}</USER_REQUEST>` },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'done' },
  ]);
  // Read-only subagent (`reviewer-3`) spawned by MAIN via invoke_subagent: 0 user turns.
  const rev3Tp = writeBrain(REV3, [
    {
      step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE',
      content: `<SYSTEM_MESSAGE>\n[Message] sender=${MAIN} priority=MESSAGE_PRIORITY_HIGH content=Audit Angle 3\n</SYSTEM_MESSAGE>`,
    },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'VERDICT: REVISE' },
  ]);
  // Swarm worker whose step 0 is a missing/board sender and step 1 carries the coordinator assignment.
  writeBrain(COORD, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>run swarm</USER_REQUEST>' },
  ], 'transcript_full.jsonl');
  const workerTp = writeBrain(WORKER, [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `[Message] sender=${BOARD} content=[swarm] new board message #7` },
    { step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `[Message] sender=${COORD} content=You have just started.` },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'working' },
  ]);
  // Worker where the user already explicitly sent turns after resuming into it.
  const adoptedTp = writeBrain(ADOPTED, [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `[Message] sender=${COORD} content=assignment` },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'initial' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>直接在这里处理吧</USER_REQUEST>' },
  ]);
  // One-shot `agy -p` headless review conversation spawned mid-turn.
  writeBrain(NESTED, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Do not use any tools.</USER_REQUEST>' },
  ]);

  const withAgy = <T>(fn: () => T): T => {
    const prev = process.env.AGY_CONFIG_DIR;
    process.env.AGY_CONFIG_DIR = cfg;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.AGY_CONFIG_DIR;
      else process.env.AGY_CONFIG_DIR = prev;
    }
  };

  it('distinguishes main conversations, background subagents, adopted workers and missing ids', () => {
    withAgy(() => {
      expect(agyConversationState(MAIN)).toEqual({ kind: 'main' });
      expect(agyConversationState(COORD)).toEqual({ kind: 'main' });
      expect(agyConversationState(REV3)).toEqual({ kind: 'subagent', parentIds: [MAIN], hasUserTurn: false });
      expect(agyConversationState(WORKER)).toEqual({ kind: 'subagent', parentIds: [BOARD, COORD], hasUserTurn: false });
      expect(agyConversationState(ADOPTED)).toEqual({ kind: 'subagent', parentIds: [COORD], hasUserTurn: true });
      expect(agyConversationState(MISSING)).toEqual({ kind: 'missing' });
      expect(agyConversationState('not-a-uuid')).toEqual({ kind: 'missing' });
    });
  });

  it('self-heals a subagent-poisoned nativeSessionId/transcriptPath back to the main coordinator', () => {
    withAgy(() => {
      expect(agyResumeId(REV3, rev3Tp)).toBe(MAIN);
      expect(agyResumeId(REV3, undefined)).toBe(MAIN);
      expect(agyResumeId(WORKER, `\\\\?\\${workerTp}`)).toBe(COORD);
      expect(agyTranscriptFile(agyResumeId(REV3, rev3Tp)!)).toBe(mainTp);
    });
  });

  it('recovers the primary TUI conversation when nativeSessionId was overwritten by a nested agy -p', () => {
    withAgy(() => {
      expect(agyResumeId(NESTED, mainTp)).toBe(MAIN);
    });
  });

  it('preserves a worker conversation where the user already explicitly sent turns', () => {
    withAgy(() => {
      expect(agyResumeId(ADOPTED, adoptedTp)).toBe(ADOPTED);
    });
  });

  it('returns undefined when neither native nor transcriptPath resolves on disk', () => {
    withAgy(() => {
      expect(agyResumeId(MISSING, undefined)).toBeUndefined();
      expect(agyResumeId(MISSING, path.join(cfg, 'brain', MISSING, '.system_generated', 'logs', 'transcript_full.jsonl'))).toBeUndefined();
    });
  });
});

describe('claude status line', () => {
  it('claude-hooks.json carries a statusLine command running hooks/statusline.mjs next to the hooks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
    writeHookFiles(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'claude-hooks.json'), 'utf8'));
    expect(cfg.statusLine).toEqual({ type: 'command', command: expect.stringMatching(/statusline\.mjs" claude$/) });
    expect(Object.keys(cfg.hooks)).toContain('Stop');
  });

  it('userStatusLine picks local, then project, then user settings, and ignores non-command lines', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sl-'));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sl-cfg-'));
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    try {
      expect(userStatusLine(cwd)).toBeUndefined();
      const write = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
      write(path.join(cfgDir, 'settings.json'), { statusLine: { type: 'command', command: 'user-sl' } });
      expect(userStatusLine(cwd)).toBe('user-sl');
      write(path.join(cwd, '.claude', 'settings.json'), { statusLine: { type: 'command', command: 'project-sl' } });
      expect(userStatusLine(cwd)).toBe('project-sl');
      write(path.join(cwd, '.claude', 'settings.local.json'), '{broken');
      expect(userStatusLine(cwd)).toBe('project-sl');
      write(path.join(cwd, '.claude', 'settings.local.json'), { statusLine: { type: 'static', command: 'x' } });
      expect(userStatusLine(cwd)).toBe('project-sl');
      write(path.join(cwd, '.claude', 'settings.local.json'), { statusLine: { type: 'command', command: 'local-sl' } });
      expect(userStatusLine(cwd)).toBe('local-sl');
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
    }
  });
});
