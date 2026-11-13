#!/usr/bin/env node
// Status line relay for Claude Code and Antigravity (agy): reports subscription quota windows (the status line input is
// where claude puts `rate_limits` and agy puts `quota`) to the workbench server, and prints the user's own status line
// when one was configured.
// Usage: node statusline.mjs [agent]   (agent defaults to claude)
// Environment: WORKBENCH_SESSION_ID / PORT / HOOK_TOKEN (as for notify.mjs; without them nothing is posted),
// WORKBENCH_USER_STATUSLINE (the user's own command, run through the shell with the same stdin).
// Runs on every message update, so it only posts when the rate limits differ from the last post of this session.
// Never throws, and never holds up the printed output for more than the user command's own 3 s.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const agent = process.argv[2] || 'claude';
const { WORKBENCH_SESSION_ID: sessionId, WORKBENCH_PORT: port, WORKBENCH_HOOK_TOKEN: token, WORKBENCH_USER_STATUSLINE: userCmd } = process.env;

const readStdin = () =>
  new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });

// The user's status line command: its stdout, or '' when it fails or takes over 3 s.
function runUser(raw) {
  if (!userCmd) return Promise.resolve('');
  return new Promise(resolve => {
    let out = '';
    let done = false;
    let child;
    const end = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(() => {
      // shell: true leaves the real command as a grandchild on Windows; take the whole tree down.
      if (child?.pid && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child?.kill();
      out = '';
      end();
    }, 3000);
    try {
      child = spawn(userCmd, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', c => { out += c; });
      child.on('error', () => { out = ''; end(); });
      child.on('close', end);
      child.stdin.on('error', () => {});
      child.stdin.end(raw);
    } catch {
      out = '';
      end();
    }
  });
}

// Normalizes the quota payload so ticking countdown fields (agy's `reset_in_seconds`) do not trigger a post every second
// while `remaining_fraction` and `reset_time` are unchanged.
function extractPayload(status) {
  const rl = status?.rate_limits;
  if (rl && typeof rl === 'object' && !Array.isArray(rl) && Object.keys(rl).length) return { rate_limits: rl };
  const q = status?.quota;
  if (q && typeof q === 'object' && !Array.isArray(q) && Object.keys(q).length) {
    const clean = {};
    for (const [k, v] of Object.entries(q)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (typeof v.reset_time === 'string' && v.reset_time) {
        const { reset_in_seconds: _, ...rest } = v;
        clean[k] = rest;
      } else {
        clean[k] = v;
      }
    }
    if (Object.keys(clean).length) return { quota: clean };
  }
  return null;
}

async function post(status) {
  const payload = extractPayload(status);
  if (!sessionId || !port || !token || !payload) return;
  const sig = JSON.stringify(payload);
  const cache = path.join(os.tmpdir(), `shoal-statusline-${sessionId.replace(/[^\w-]/g, '_')}.json`);
  try { if (fs.readFileSync(cache, 'utf8') === sig) return; } catch { /* first post */ }
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, agent, event: 'RateLimits', at: Date.now(), payload }),
    signal: AbortSignal.timeout(2000),
  });
  if (res.ok) fs.writeFileSync(cache, sig);
}

let printed = '';
try {
  const raw = await readStdin();
  let status = null;
  try { status = raw ? JSON.parse(raw) : null; } catch { /* not JSON: nothing to report */ }
  const [out] = await Promise.all([runUser(raw), post(status).catch(err => process.stderr.write(`[workbench-statusline] ${err?.message ?? err}\n`))]);
  printed = out;
} catch (err) {
  process.stderr.write(`[workbench-statusline] ${err?.message ?? err}\n`);
}
process.stdout.write(printed, () => process.exit(0));
