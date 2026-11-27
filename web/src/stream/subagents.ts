import type { StreamSubagent } from '../../../shared/protocol.ts';
import type { PtyLiveSubagent } from '../../../shared/ptyLive.ts';

export interface MergedSubagent extends StreamSubagent {
  elapsedText?: string;
}

export function mergeSubagents(
  serverSubs: StreamSubagent[] | undefined,
  ptySubs: PtyLiveSubagent[] | undefined,
  working: boolean,
): MergedSubagent[] {
  const list: MergedSubagent[] = (serverSubs ?? []).map((s) => ({ ...s }));
  if (!ptySubs || ptySubs.length === 0) return list;

  const matchedIdx = new Set<number>();
  ptySubs.forEach((ps, pIdx) => {
    const pName = ps.name.toLowerCase();
    const pRoleClean = ps.role?.replace(/\.{3}|…$/, '').trim().toLowerCase() ?? '';
    let hit = list.findIndex((s, i) => {
      if (matchedIdx.has(i)) return false;
      if (s.name.toLowerCase() !== pName) return false;
      if (!pRoleClean || !s.role) return true;
      const sRole = s.role.toLowerCase();
      return sRole.includes(pRoleClean) || pRoleClean.includes(sRole);
    });
    if (hit < 0 && ps.status === 'running' && ptySubs.length === 1) {
      const running = list.map((s, i) => ({ s, i })).filter(({ s, i }) => !matchedIdx.has(i) && s.status === 'running');
      if (running.length === 1) hit = running[0].i;
    }
    if (hit >= 0) {
      matchedIdx.add(hit);
      const target = list[hit];
      if (target.name === 'subagent' && ps.name) target.name = ps.name;
      if (!target.role && ps.role) target.role = ps.role;
      if (!target.model && ps.model) target.model = ps.model;
      if (ps.elapsedText) target.elapsedText = ps.elapsedText;
      if (working && ps.status === 'running') {
        target.status = 'running';
        if (ps.summary) target.summary = ps.summary;
      } else if (!target.summary && ps.summary) {
        target.summary = ps.summary;
      }
    } else {
      list.push({
        id: `pty-sub-${pIdx}-${ps.name}`,
        kind: ps.kind,
        name: ps.name,
        ...(ps.role ? { role: ps.role } : {}),
        ...(ps.model ? { model: ps.model } : {}),
        status: working ? ps.status : ps.status === 'error' ? 'error' : 'done',
        ...(ps.summary ? { summary: ps.summary } : {}),
        ...(ps.elapsedText ? { elapsedText: ps.elapsedText } : {}),
      });
    }
  });
  return list;
}
