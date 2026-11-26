import { spawn } from 'node:child_process';
import path from 'node:path';
import type { QuotaWindow } from '../shared/protocol.ts';
import { PI_QUOTA_RESULT } from '../shared/openCodeGo.ts';
import { ROOT } from './agents.ts';
import { buildSafeProcessLaunch, isCmdBatchPath } from './cliRegistry.ts';

export async function readPiOpenCodeGoQuota(executable: string, cwd: string): Promise<QuotaWindow[]> {
  try {
    if (isCmdBatchPath(executable)) return [];
    const { file, args } = buildSafeProcessLaunch(executable, [
      '--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
      '--extension', path.join(ROOT, 'hooks', 'pi-quota.ts'),
    ]);
    if (typeof args === 'string') return [];
    return await new Promise<QuotaWindow[]>(resolve => {
      const child = spawn(file, args, {
        cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
      });
      let stderr = '';
      let windows: QuotaWindow[] = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(windows);
      };
      const timer = setTimeout(() => { child.kill(); finish(); }, 9000);
      child.stdout.resume();
      child.stdin.on('error', () => {});
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr += chunk;
        let newline: number;
        while ((newline = stderr.indexOf('\n')) >= 0) {
          const line = stderr.slice(0, newline);
          stderr = stderr.slice(newline + 1);
          if (!line.startsWith(PI_QUOTA_RESULT)) continue;
          try {
            const value: unknown = JSON.parse(line.slice(PI_QUOTA_RESULT.length));
            if (Array.isArray(value)) windows = value;
          } catch { /* skip malformed probe output */ }
          child.stdin.end();
        }
        if (stderr.length > 4096) stderr = '';
      });
      child.once('error', finish);
      child.once('close', finish);
    });
  } catch {
    return [];
  }
}
