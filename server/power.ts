import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001): prevents system sleep without forcing the display on.
const PS_SCRIPT = [
  "Add-Type -Namespace Shoal -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  '[void][Shoal.Power]::SetThreadExecutionState(([uint32]2147483649))',
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  '[void][Console]::In.ReadLine()',
].join('; ');

export interface PowerBlocker {
  isActive(): boolean;
  sync(want: boolean): void;
  dispose(): void;
}

export interface PowerBlockerOptions {
  enabledByPlatform?: boolean;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  onChange?: (active: boolean) => void;
}

export function createPowerBlocker(opts: PowerBlockerOptions = {}): PowerBlocker {
  const platform = opts.platform ?? process.platform;
  const supported = opts.enabledByPlatform ?? ((platform === 'win32' || platform === 'darwin') && process.env.WORKBENCH_FAKE_AGENT !== '1');
  const runSpawn = opts.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  let wanted = false;
  let disposed = false;

  const emit = () => opts.onChange?.(child !== null);

  const stop = () => {
    const c = child;
    if (!c) return;
    child = null;
    try { c.stdin?.end(); } catch { /* ignore */ }
    try { c.kill(); } catch { /* ignore */ }
    emit();
  };

  const start = () => {
    if (child || disposed || !supported) return;
    try {
      // macOS: caffeinate -i blocks idle sleep; -w ties it to this process so it ends with us even if stop() never runs.
      const proc = platform === 'darwin'
        ? runSpawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: ['ignore', 'ignore', 'ignore'] })
        : runSpawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_SCRIPT],
          { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
        );
      proc.unref?.();
      child = proc;
      proc.once('error', () => {
        if (child === proc) {
          child = null;
          emit();
        }
      });
      proc.once('exit', () => {
        if (child === proc) {
          child = null;
          emit();
        }
      });
      emit();
    } catch (e) {
      console.warn(`[power] 防休眠锁启动失败：${(e as Error).message}`);
      child = null;
    }
  };

  return {
    isActive: () => (supported ? child !== null : wanted),
    sync(want: boolean) {
      wanted = want && !disposed;
      if (!supported) {
        opts.onChange?.(wanted);
        return;
      }
      if (wanted) start();
      else stop();
    },
    dispose() {
      disposed = true;
      wanted = false;
      stop();
    },
  };
}
