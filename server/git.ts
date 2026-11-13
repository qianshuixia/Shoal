import { execFile } from 'node:child_process';
import type { GitInfo } from '../shared/protocol.ts';

// Output of `git status --porcelain=v2 --branch`. null when there is no branch header (garbage / empty).
export function parseGitStatus(out: string): GitInfo | null {
  let head: string | undefined;
  let oid = '';
  let dirty = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim();
    else if (!line.startsWith('#')) dirty++;
  }
  if (!head) return null;
  if (head === '(detached)') return { branch: oid && oid !== '(initial)' ? oid.slice(0, 7) : 'HEAD', detached: true, dirty };
  return { branch: head, detached: false, dirty };
}

let warnedMissing = false;

// null when dir is not a git repo, git is missing, it times out or fails: never throws.
// --no-optional-locks: agents run git in the same repos, and a status refresh must never take index.lock.
export function gitInfo(dir: string): Promise<GitInfo | null> {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { cwd: dir, windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !warnedMissing) {
            warnedMissing = true;
            console.warn('[git] 找不到 git，侧栏不显示分支');
          }
          return resolve(null);
        }
        resolve(parseGitStatus(stdout));
      });
  });
}
