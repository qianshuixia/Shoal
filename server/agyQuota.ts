import { spawn } from 'node:child_process';
import type { QuotaWindow } from '../shared/protocol.ts';
import { buildSafeProcessLaunch, isCmdBatchPath } from './cliRegistry.ts';
import { parseAgyQuota } from './quota.ts';

const MAX_STDOUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 25_000;

function inferBucketKey(groupName: string, bucket: Record<string, unknown>): string | null {
  const id = typeof bucket.id === 'string' ? bucket.id.trim() : '';
  if (id) return id;
  const win = typeof bucket.window === 'string' ? bucket.window.trim().toLowerCase() : '';
  if (!win) return null;
  const g = groupName.trim().toLowerCase();
  if (/gemini/.test(g)) return `gemini-${win}`;
  if (/claude|gpt|3p|third|shared/.test(g)) return `3p-${win}`;
  return win;
}

// Parses `agy --output-format json --print=/usage` stdout into ordered QuotaWindow entries.
// Verifies this was a pure /usage command (num_turns === 0) with status SUCCESS.
export function parseAgyUsageOutput(raw: string, now = Date.now()): QuotaWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const root = parsed as Record<string, unknown>;
  if (root.status !== 'SUCCESS') return [];
  if (typeof root.num_turns === 'number' && root.num_turns > 0) return [];
  const command = root.command as Record<string, unknown> | null | undefined;
  if (!command || typeof command !== 'object' || command.name !== 'usage') return [];
  const data = command.data as Record<string, unknown> | null | undefined;
  const groups = data && typeof data === 'object' && Array.isArray(data.groups) ? data.groups : null;
  if (!groups) return [];

  const quotaMap: Record<string, Record<string, unknown>> = {};
  for (const groupEntry of groups) {
    if (!groupEntry || typeof groupEntry !== 'object' || Array.isArray(groupEntry)) continue;
    const group = groupEntry as Record<string, unknown>;
    const groupName = typeof group.name === 'string' ? group.name : '';
    const buckets = Array.isArray(group.buckets) ? group.buckets : null;
    if (!buckets) continue;
    for (const bucketEntry of buckets) {
      if (!bucketEntry || typeof bucketEntry !== 'object' || Array.isArray(bucketEntry)) continue;
      const bucket = bucketEntry as Record<string, unknown>;
      if (bucket.disabled === true) continue;
      const key = inferBucketKey(groupName, bucket);
      if (!key) continue;
      quotaMap[key] = bucket;
    }
  }
  return parseAgyQuota(quotaMap, now);
}

// Queries Antigravity CLI's official `/usage` slash command in non-interactive JSON mode (zero model turns).
export async function readAgyQuota(executable: string, cwd: string): Promise<QuotaWindow[]> {
  try {
    if (isCmdBatchPath(executable)) return [];
    const nullLog = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const { file, args } = buildSafeProcessLaunch(executable, [
      '--log-file', nullLog,
      '--print-timeout', '20s',
      '--output-format', 'json',
      '--print=/usage',
    ]);
    if (typeof args === 'string') return [];
    return await new Promise<QuotaWindow[]>(resolve => {
      const child = spawn(file, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      });
      let stdout = '';
      let overflow = false;
      let done = false;
      const finish = (windows: QuotaWindow[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(windows);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* exited */ }
        finish([]);
      }, TIMEOUT_MS);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (overflow) return;
        if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
          overflow = true;
          try { child.kill(); } catch { /* exited */ }
          finish([]);
          return;
        }
        stdout += chunk;
      });
      child.once('error', () => finish([]));
      child.once('close', code => {
        if (code !== 0 || overflow) return finish([]);
        finish(parseAgyUsageOutput(stdout));
      });
    });
  } catch {
    return [];
  }
}
