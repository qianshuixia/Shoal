import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Default state directory per platform.
// win32: %LOCALAPPDATA%\Shoal; installs from before the rename keep using %LOCALAPPDATA%\agent-workbench until Shoal has
// its own state.json. The folder alone says nothing: the desktop installer puts the app itself in %LOCALAPPDATA%\Shoal.
// Same rule in workbench.ps1 and desktop/src-tauri/src/main.rs (which also passes its choice in WORKBENCH_STATE_DIR).
// darwin: ~/Library/Application Support/Shoal. Other POSIX: $XDG_DATA_HOME/Shoal or ~/.local/share/Shoal.
export function defaultStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? '.';
    const dir = path.join(base, 'Shoal'), old = path.join(base, 'agent-workbench');
    return !fs.existsSync(path.join(dir, 'state.json')) && fs.existsSync(old) ? old : dir;
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Shoal');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'Shoal');
}

// Shell PATH entries first, then entries only the current PATH has, then extras not yet present. Empty entries dropped.
export function mergePath(shellPath: string, currentPath: string, extras: string[], delimiter = ':'): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[]) => {
    for (const e of list) {
      if (!e || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  };
  add(shellPath.split(delimiter));
  add(currentPath.split(delimiter));
  add(extras);
  return out.join(delimiter);
}

const PATH_MARK = /__SHOAL_PATH__(.*?)__SHOAL_PATH__/s;

// A .app launched from Finder/Dock gets only /usr/bin:/bin:/usr/sbin:/sbin, so user-installed CLIs, git and brew tools
// are not found. Ask the login shell for its PATH once at startup. darwin only; never throws, never takes longer than
// `timeoutMs`: a shell that hangs (or ignores SIGTERM) is killed with its whole process group and startup goes on with the
// inherited PATH.
export async function adoptLoginShellEnv(timeoutMs = 5000, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'darwin') return;
  const home = os.homedir();
  const shellPath = process.env.WORKBENCH_SKIP_SHELL_ENV === '1' ? '' : await loginShellPath(process.env.SHELL || '/bin/zsh', timeoutMs);
  const extras = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  process.env.PATH = mergePath(shellPath, process.env.PATH ?? '', extras);
  // A GUI launch has no locale, which garbles non-ASCII text in the CLIs.
  if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) process.env.LANG = 'en_US.UTF-8';
}

const PROBE_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

// PATH printed by `shell -ilc`, or '' on any failure or after `timeoutMs`.
export function loginShellPath(shell: string, timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    // Set once the shell has exited and been reaped. From then on its PID, and with it the group ID, may be reused, so
    // the group is never signalled again; whatever the startup files left running is not ours to end.
    let exited = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (child?.pid && !exited) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    // The shell has its own process group, so nothing else would end it if this process is told to stop mid-probe
    // (the app quit during startup, before the server installs its own handlers): end the group, then stop as asked.
    const onSignal = (sig: NodeJS.Signals) => {
      killGroup();
      finish('', `stopped by ${sig}`);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    const finish = (value: string, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      // A background job may still hold the pipe open; stop reading it.
      child?.stdout?.destroy();
      for (const sig of PROBE_SIGNALS) process.off(sig, onSignal);
      process.off('exit', killGroup);
      if (why) console.warn(`[platform] could not read login shell PATH: ${why}`);
      resolve(value);
    };
    try {
      // Interactive shells may print other things (motd, prompts), hence the markers. Own process group (detached), so
      // the timeout can kill whatever the shell's startup files started too. PATH comes from printenv, not "$PATH": fish
      // expands $PATH as a list joined with spaces, the environment value keeps the colons in every shell.
      child = spawn(shell, ['-ilc', "printf '\\n__SHOAL_PATH__'; /usr/bin/printenv PATH; printf '__SHOAL_PATH__\\n'"],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      finish('', (e as Error).message);
      return;
    }
    for (const sig of PROBE_SIGNALS) process.on(sig, onSignal);
    process.on('exit', killGroup);
    timer = setTimeout(() => {
      killGroup();
      finish('', `${shell} did not answer within ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => { out += d; });
    child.on('error', e => finish('', e.message));
    const settle = (code: number | null) => {
      const found = PATH_MARK.exec(out)?.[1];
      if (found !== undefined) finish(found.trim());
      else finish('', `${shell} exited with ${code} without printing PATH`);
    };
    // 'close' waits for every holder of stdout; a job the startup files put in the background may keep it open long after
    // the shell is gone. Give the pipe a moment to flush after the shell exits, then go with what was read.
    child.on('exit', code => {
      exited = true;
      drain = setTimeout(() => settle(code), 500);
    });
    child.on('close', code => settle(code));
  });
}

// First executable regular file called `name` on PATH (POSIX). Windows resolution lives in agents.ts.
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, delimiter = ':'): string | null {
  if (platform === 'win32') return null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = path.posix.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }
  return null;
}
