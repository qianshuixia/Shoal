import { describe, it, expect } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'hooks', 'statusline.mjs');
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WORKBENCH_')));

// Runs the relay with the given env and stdin; resolves with stdout, exit code and wall time.
function run(env: Record<string, string>, stdin: string, agentArg?: string) {
  return new Promise<{ out: string; code: number | null; ms: number }>((resolve, reject) => {
    const t0 = Date.now();
    const args = agentArg ? [SCRIPT, agentArg] : [SCRIPT];
    const p = spawn(process.execPath, args, { env: { ...BASE_ENV, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    p.stdout.on('data', c => { out += c; });
    p.on('error', reject);
    p.on('close', code => resolve({ out, code, ms: Date.now() - t0 }));
    p.stdin.on('error', () => {});
    p.stdin.end(stdin);
  });
}

const STATUS = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1793447357 } } });
const echoCmd = (code: string) => `"${process.execPath.replaceAll('\\', '/')}" -e "${code}"`;

describe('hooks/statusline.mjs', () => {
  it('outside the workbench with no user command: exits quickly and prints nothing', async () => {
    const r = await run({}, STATUS);
    expect(r).toMatchObject({ out: '', code: 0 });
    expect(r.ms).toBeLessThan(3000);
  });

  it("prints the user's status line output, which sees the same stdin", async () => {
    const cmd = echoCmd("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('['+JSON.parse(d).model.display_name+']'))");
    const r = await run({ WORKBENCH_USER_STATUSLINE: cmd }, STATUS);
    expect(r).toMatchObject({ out: '[Opus]', code: 0 });
  });

  it('a user command that fails prints nothing; one that hangs cannot hold the script past its 3 s limit', async () => {
    expect(await run({ WORKBENCH_USER_STATUSLINE: echoCmd('process.exit(3)') }, STATUS)).toMatchObject({ out: '', code: 0 });
    const r = await run({ WORKBENCH_USER_STATUSLINE: echoCmd('setTimeout(()=>{},30000)') }, STATUS);
    expect(r).toMatchObject({ out: '', code: 0 });
    expect(r.ms).toBeLessThan(5000);
  }, 15_000);

  it('posts RateLimits once per distinct value, with only rate_limits in the payload, and survives a dead server', async () => {
    const bodies: any[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => { b += c; }).on('end', () => { bodies.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.writeHead(204).end(); });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const env = { WORKBENCH_SESSION_ID: `test-${Date.now()}`, WORKBENCH_PORT: String(port), WORKBENCH_HOOK_TOKEN: 'tok' };
    try {
      await run(env, STATUS);
      await run(env, STATUS); // same value: not posted again
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ auth: 'Bearer tok', sessionId: env.WORKBENCH_SESSION_ID, agent: 'claude', event: 'RateLimits' });
      expect(bodies[0].payload).toEqual({ rate_limits: JSON.parse(STATUS).rate_limits });
      await run(env, STATUS.replace('"used_percentage":12', '"used_percentage":13'));
      expect(bodies).toHaveLength(2);
      await run(env, JSON.stringify({ model: 'x' })); // no rate_limits: nothing to report
      expect(bodies).toHaveLength(2);
    } finally {
      srv.close();
    }
    const dead = await run({ ...env, WORKBENCH_SESSION_ID: 'other' }, STATUS);
    expect(dead).toMatchObject({ out: '', code: 0 });
  }, 20_000);

  it('posts agy quota and ignores ticking reset_in_seconds when remaining_fraction and reset_time are unchanged', async () => {
    const bodies: any[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => { b += c; }).on('end', () => { bodies.push(JSON.parse(b)); res.writeHead(204).end(); });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const env = { WORKBENCH_SESSION_ID: `test-agy-${Date.now()}`, WORKBENCH_PORT: String(port), WORKBENCH_HOOK_TOKEN: 'tok' };
    const agyStatus = (rem: number, secs: number) => JSON.stringify({
      model: { id: 'Gemini 4 Carbon (Medium)' },
      quota: { 'gemini-5h': { remaining_fraction: rem, reset_time: '2026-11-13T22:28:10Z', reset_in_seconds: secs } },
    });
    try {
      await run(env, agyStatus(0.75, 3600), 'agy');
      await run(env, agyStatus(0.75, 3599), 'agy'); // countdown tick only: skipped
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        sessionId: env.WORKBENCH_SESSION_ID,
        agent: 'agy',
        event: 'RateLimits',
        payload: { quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_time: '2026-11-13T22:28:10Z' } } },
      });
      await run(env, agyStatus(0.74, 3598), 'agy'); // real quota change: posted
      expect(bodies).toHaveLength(2);
    } finally {
      srv.close();
    }
  }, 20_000);
});
