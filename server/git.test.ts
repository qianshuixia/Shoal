import { describe, expect, it } from 'vitest';
import { parseGitStatus } from './git.ts';

const head = (b: string) => `# branch.oid 1234567890abcdef\n# branch.head ${b}\n# branch.upstream origin/main\n# branch.ab +0 -0\n`;

describe('parseGitStatus', () => {
  it('reads a normal branch', () => {
    expect(parseGitStatus(head('main') + '1 .M N... 100644 100644 100644 a b src/x.ts\n')).toEqual({ branch: 'main', detached: false, dirty: 1 });
  });
  it('uses the short oid when detached', () => {
    expect(parseGitStatus(head('(detached)'))).toEqual({ branch: '1234567', detached: true, dirty: 0 });
  });
  it('clean tree has no dirty entries', () => {
    expect(parseGitStatus(head('feat/a'))).toEqual({ branch: 'feat/a', detached: false, dirty: 0 });
  });
  it('counts modified, renamed and untracked entries', () => {
    const out = head('main') + '1 M. N... 100644 100644 100644 a b a.ts\n2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts\nu UU N... 1 2 3 4 a b c conflict.ts\n? new.txt\n? dir/other.txt\n';
    expect(parseGitStatus(out)?.dirty).toBe(5);
  });
  it('handles CRLF', () => {
    expect(parseGitStatus('# branch.oid abc\r\n# branch.head main\r\n? a\r\n')).toEqual({ branch: 'main', detached: false, dirty: 1 });
  });
  it('returns null for empty or garbage output', () => {
    expect(parseGitStatus('')).toBeNull();
    expect(parseGitStatus('fatal: not a git repository\n')).toBeNull();
  });
});
