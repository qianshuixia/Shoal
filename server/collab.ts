import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentKind, Card, DelegationMode, DelegationSummary, PeerDelegateBody, PeerDelegateResult, PeerDelegationActionBody, PeerDelegationActionResult,
  PeerDelegationList, PeerListResult, PeerSendBody, PeerSendResult, PeerTaskSummary, PermissionMode, Project, SessionInfo, Task, TaskDelegation,
} from '../shared/protocol.ts';
import {
  agentLabel, DELEGATION_LABEL, delegationBlockedText, delegationHandle, delegationPrompt, delegationReworkText,
  delegationResultText, delegationState, forwardText, isDeepAgent, MAX_DELEGATION_ROUNDS,
} from '../shared/protocol.ts';
import { capBody } from './cards.ts';
import { delegationTitle } from './titles.ts';
import type { EnqueueOptions, SessionManager } from './sessions.ts';
import type { Store } from './store.ts';

export const MAX_AUTO_HOPS = 4;
export const MAX_SENDS_PER_TURN = 2;
// Delegation has its own limits: a result/rework round trip is not a runaway agent-to-agent chat.
export const MAX_DELEGATION_HOPS = 12;
export { MAX_DELEGATION_ROUNDS }; // defined in shared/protocol.ts so the relayed next steps can tell the last round
export const MAX_OPEN_DELEGATIONS = 6;
const MAX_PEER_FILE_BYTES = 512 * 1024;

export class CollabError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ReplyObligation {
  id: string;
  targetTaskId: string;
  targetSessionId: string;
  sourceTaskId: string;
  hop: number;
  stage: 'queued' | 'delivered' | 'armed';
  createdAt: number;
}

export interface CollabDeps {
  stateDir: string;
  store: Store;
  sessions: SessionManager;
  availableAgents: () => AgentKind[];
  delegatableAgents?: () => AgentKind[];
  // retitleFrom: the title was made up from this text, so an AI title (when enabled) may replace it.
  createPeerTask: (opts: { projectId: string; agent: AgentKind; title: string; prompt: string; delegation?: TaskDelegation; retitleFrom?: string; permissionMode?: PermissionMode }) => { task: Task; session: SessionInfo };
  // Ends the child's process and archives it with the outcome written into its delegation.
  closeDelegation: (task: Task, outcome: 'accepted' | 'canceled') => Task;
  deliverToTask: (opts: {
    targetTask: Task;
    project: Project;
    text: string;
    system: boolean;
    onDelivered?: () => void;
    cardMeta: NonNullable<Card['meta']>;
  }) => { task: Task; session: SessionInfo; card: Card };
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      // Windows AV/indexer can briefly hold a handle on rename; fall back to direct write and clean tmp.
      fs.writeFileSync(file, content, 'utf8');
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      return;
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function normCompare(p: string): string {
  const clean = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function isContainedIn(target: string, root: string): boolean {
  const t = normCompare(target);
  const r = normCompare(root);
  return t === r || t.startsWith(r + path.sep);
}

function firstLinePreview(text: string | undefined, max = 100): string {
  if (!text) return '';
  const line = text.trim().split(/\r?\n/).find(l => l.trim())?.trim() ?? '';
  const cleaned = line.replaceAll('|', '/').replaceAll('`', "'");
  return [...cleaned].length > max ? [...cleaned].slice(0, max).join('') + '…' : cleaned;
}

export function createCollabManager(deps: CollabDeps) {
  const { stateDir, store, sessions } = deps;
  const obligations = new Map<string, ReplyObligation>(); // id -> obligation
  const deliveredHops = new Map<string, number>(); // targetSessionId -> hop of just-delivered injected prompt
  const sessionHops = new Map<string, number>(); // sessionId -> active turn's hop depth (0 = human turn)
  const turnSentCounts = new Map<string, Map<string, number>>(); // sessionId -> (targetKey -> send count in current turn)
  const latestPreviews = new Map<string, string>(); // taskId -> one-line reply summary
  const blockNotified = new Map<string, number>(); // delegated task id -> round whose blocked notice was already sent

  const collabDirOf = (projectId: string) => path.join(stateDir, 'collab', projectId);
  const peersFileOf = (projectId: string) => path.join(collabDirOf(projectId), 'PEERS.md');
  const turnsDirOf = (projectId: string) => path.join(collabDirOf(projectId), 'turns');
  const turnFileOf = (projectId: string, taskId: string) => path.join(turnsDirOf(projectId), `${taskId}-latest.md`);

  function activeProjectTasks(projectId: string): Task[] {
    return store.tasks()
      .filter(t => t.projectId === projectId && t.phase !== 'archived')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function syncProjectPeers(projectId: string): void {
    const project = store.getProject(projectId);
    if (!project) return;
    const tasks = activeProjectTasks(projectId);
    const byId = new Map(sessions.list().map(s => [s.id, s]));
    const cards = store.cards();

    const rows: string[] = [];
    const details: string[] = [];
    tasks.forEach((t, idx) => {
      const n = idx + 1;
      const sess = t.sessionId ? byId.get(t.sessionId) : undefined;
      const status = sess?.status ?? 'none';
      const replyPath = turnFileOf(projectId, t.id);
      const hasFile = fs.existsSync(replyPath);
      const safeTitle = firstLinePreview(t.title, 60) || t.id.slice(0, 8);
      rows.push(`| #${n} | ${safeTitle} (\`${t.id.slice(0, 8)}\`) | ${t.agent} | ${t.phase} | ${status} | ${hasFile ? `\`${replyPath}\`` : '—'} |`);

      let preview = latestPreviews.get(t.id);
      if (preview === undefined) {
        const lastResult = cards.filter(c => c.taskId === t.id && c.kind === 'result').at(-1);
        preview = firstLinePreview(lastResult?.body, 140);
      }
      const promptLine = t.lastPrompt ? firstLinePreview(t.lastPrompt, 120) : '';
      const infoParts = [
        `### #${n} ${t.title} (\`${t.id}\`)`,
        `- Agent: ${agentLabel(t.agent)} (\`${t.agent}\`) · Phase: \`${t.phase}\` · Session: \`${status}\``,
      ];
      if (t.delegation) {
        const parentTitle = store.getTask(t.delegation.parentTaskId)?.title ?? '（已删除）';
        infoParts.push(`- Delegated by: ${firstLinePreview(parentTitle, 60)} · State: ${DELEGATION_LABEL[delegationState(t, sess)!]} · Round: ${t.delegation.round}`);
      }
      if (promptLine) infoParts.push(`- Last prompt: ${promptLine}`);
      if (hasFile) infoParts.push(`- Latest reply snapshot: \`${replyPath}\``);
      if (preview) infoParts.push(`- Latest reply preview: ${preview}`);
      details.push(infoParts.join('\n'));
    });

    const md = [
      `# Shoal Project Peers — ${project.name}`,
      '',
      `- Project ID: \`${project.id}\``,
      `- Directory: \`${project.path}\``,
      `- Updated: ${new Date().toISOString()}`,
      '',
      'Passive index of non-archived tasks in this project. Read any listed `*-latest.md` file directly for zero-disturbance context, or use `shoal` CLI (`shoal peers`, `shoal send <target> -m "..."`, `shoal ask <target> -m "..."`). Never prefix `<target>` with unquoted `@` in PowerShell.',
      '',
      ...(rows.length
        ? [
            '| # | Task | Agent | Phase | Status | Latest Reply File |',
            '|---|---|---|---|---|---|',
            ...rows,
            '',
            ...details,
          ]
        : ['（当前项目暂无活跃任务）']),
      '',
    ].join('\n');

    atomicWrite(peersFileOf(projectId), md);
  }

  function recordTurnReply(task: Task, agent: AgentKind, replyText: string, at = Date.now()): void {
    const clean = capBody(replyText).trim();
    latestPreviews.set(task.id, firstLinePreview(clean, 140));
    const doc = [
      `# ${task.title}`,
      '',
      `- Task ID: \`${task.id}\``,
      `- Project ID: \`${task.projectId}\``,
      `- Agent: ${agentLabel(agent)} (\`${agent}\`)`,
      `- Updated: ${new Date(at).toISOString()}`,
      '',
      '---',
      '',
      clean,
      '',
    ].join('\n');
    atomicWrite(turnFileOf(task.projectId, task.id), doc);
    syncProjectPeers(task.projectId);
  }

  function clearSessionState(sessionId: string): void {
    deliveredHops.delete(sessionId);
    sessionHops.delete(sessionId);
    turnSentCounts.delete(sessionId);
    for (const [id, o] of obligations) {
      if (o.targetSessionId === sessionId) obligations.delete(id);
    }
  }

  function removeTaskSnapshot(projectId: string, taskId: string): void {
    latestPreviews.delete(taskId);
    blockNotified.delete(taskId);
    for (const [id, o] of obligations) {
      if (o.targetTaskId === taskId || o.sourceTaskId === taskId) obligations.delete(id);
    }
    try { fs.rmSync(turnFileOf(projectId, taskId), { force: true }); } catch { /* ignore */ }
    syncProjectPeers(projectId);
  }

  function removeProjectCollab(projectId: string): void {
    const gone = new Set(store.tasks().filter(t => t.projectId === projectId).map(t => t.id));
    for (const tid of gone) latestPreviews.delete(tid);
    for (const [id, o] of obligations) {
      if (gone.has(o.targetTaskId) || gone.has(o.sourceTaskId)) obligations.delete(id);
    }
    try { fs.rmSync(collabDirOf(projectId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  function registerReplyBack(opts: {
    targetTaskId: string;
    targetSessionId: string;
    sourceTaskId: string;
    hop: number;
    immediateArm: boolean;
  }): string {
    const id = crypto.randomUUID();
    obligations.set(id, {
      id,
      targetTaskId: opts.targetTaskId,
      targetSessionId: opts.targetSessionId,
      sourceTaskId: opts.sourceTaskId,
      hop: opts.hop,
      stage: opts.immediateArm ? 'armed' : 'queued',
      createdAt: Date.now(),
    });
    return id;
  }

  function seedSessionHop(sessionId: string, hop: number): void {
    sessionHops.set(sessionId, hop);
  }

  function onSystemDelivered(targetSessionId: string, hop: number, obligationId?: string): void {
    deliveredHops.set(targetSessionId, hop);
    if (obligationId) {
      const o = obligations.get(obligationId);
      if (o && o.targetSessionId === targetSessionId && o.stage === 'queued') {
        o.stage = 'delivered';
      }
    }
  }

  function onPromptStart(sessionId: string, systemInjected: boolean): void {
    turnSentCounts.delete(sessionId);
    if (systemInjected) {
      const hop = deliveredHops.get(sessionId) ?? 1;
      deliveredHops.delete(sessionId);
      sessionHops.set(sessionId, hop);
      // Promote delivered reply-back obligations for this session so ONLY the injected turn arms them.
      for (const o of obligations.values()) {
        if (o.targetSessionId === sessionId && o.stage === 'delivered') {
          o.stage = 'armed';
        }
      }
    } else {
      sessionHops.set(sessionId, 0);
    }
  }

  function disarmOnFailureOrCancel(sessionId: string): void {
    for (const [id, o] of obligations) {
      if (o.targetSessionId === sessionId && o.stage === 'armed') {
        obligations.delete(id);
      }
    }
  }

  // Pastes a delegated task's result or blocked notice into its main task. Skipped when the main task is gone or archived.
  function relayToParent(
    child: Task, session: SessionInfo, kind: 'result' | 'blocked', makeText: () => string, resultCardId?: string,
  ): void {
    const d = child.delegation;
    if (!d) return;
    const parent = store.getTask(d.parentTaskId);
    if (!parent || parent.phase === 'archived' || parent.id === child.id) return;
    const parentProject = store.getProject(parent.projectId);
    if (!parentProject) return;
    const hop = sessionHops.get(session.id) ?? 1;
    if (hop >= MAX_DELEGATION_HOPS) {
      console.warn(`[collab] 委派链过长 (hop ${hop})，不再自动送回主任务`);
      return;
    }
    const nextHop = hop + 1;
    try {
      let deliveredSessionId = '';
      const delivered = deps.deliverToTask({
        targetTask: parent,
        project: parentProject,
        text: makeText(),
        system: true,
        onDelivered: () => {
          if (deliveredSessionId) onSystemDelivered(deliveredSessionId, nextHop);
        },
        cardMeta: {
          sourceTaskId: child.id,
          ...(resultCardId ? { sourceCardId: resultCardId } : {}),
          isAutoReply: true,
          peerHop: nextHop,
          delegation: kind,
        },
      });
      deliveredSessionId = delivered.session.id;
      syncProjectPeers(parentProject.id);
    } catch (e) {
      console.warn('[collab] 委派自动回传失败:', (e as Error).message);
    }
  }

  function onChildBlocked(task: Task, session: SessionInfo): void {
    const d = task.delegation;
    if (!d || task.phase === 'archived' || !session.blocked) return;
    if (blockNotified.get(task.id) === d.round) return;
    blockNotified.set(task.id, d.round);
    const blocked = session.blocked;
    relayToParent(task, session, 'blocked', () => delegationBlockedText({ title: task.title, agent: session.agent }, blocked));
  }

  function onPrimaryStop(opts: {
    task: Task;
    session: SessionInfo;
    replyText: string;
    resultCardId?: string;
    canceledOrLimit?: boolean;
  }): void {
    const { task, session, replyText, resultCardId, canceledOrLimit } = opts;
    if (canceledOrLimit) {
      disarmOnFailureOrCancel(session.id);
      return;
    }

    recordTurnReply(task, session.agent, replyText);

    // A delegated task's result goes back to its main task whoever started the turn, so it does not use obligations.
    const fresh = store.getTask(task.id);
    if (fresh?.delegation && fresh.phase !== 'archived') {
      const { round, mode } = fresh.delegation;
      relayToParent(fresh, session, 'result', () => delegationResultText(
        { id: fresh.id, title: fresh.title, agent: session.agent, round, mode }, replyText,
      ), resultCardId);
    }

    const ready: ReplyObligation[] = [];
    for (const [id, o] of obligations) {
      if (o.targetTaskId === task.id && o.targetSessionId === session.id && o.stage === 'armed') {
        ready.push(o);
        obligations.delete(id);
      }
    }
    if (!ready.length) return;

    for (const o of ready) {
      if (o.hop >= MAX_AUTO_HOPS) continue;
      if (fresh?.delegation && o.sourceTaskId === fresh.delegation.parentTaskId) continue; // the delegation result already went there
      const source = store.getTask(o.sourceTaskId);
      if (!source || source.id === task.id || source.phase === 'archived') continue;
      const sourceProject = store.getProject(source.projectId);
      if (!sourceProject) continue;
      const nextHop = o.hop + 1;
      const note = `这是「${task.title}」对你上一轮请求的自动回传结果：`;
      const text = forwardText({ title: task.title, agent: session.agent }, replyText, note, { replyBack: false });
      try {
      let deliveredSessionId = '';
      const delivered = deps.deliverToTask({
        targetTask: source,
        project: sourceProject,
        text,
        system: true,
        onDelivered: () => {
          if (deliveredSessionId) onSystemDelivered(deliveredSessionId, nextHop);
        },
        cardMeta: {
          sourceTaskId: task.id,
          ...(resultCardId ? { sourceCardId: resultCardId } : {}),
          isAutoReply: true,
          peerHop: nextHop,
        },
      });
      deliveredSessionId = delivered.session.id;
      if (sourceProject.id !== task.projectId) syncProjectPeers(sourceProject.id);
      } catch (e) {
        console.warn('[collab] 自动回传失败:', (e as Error).message);
      }
    }
  }

  function verifyCaller(callerSessionId: string): { task: Task; project: Project } {
    const sess = sessions.list().find(s => s.id === callerSessionId);
    const task = sess ? store.getTask(sess.taskId) : undefined;
    if (!sess || !task || task.sessionId !== sess.id || task.phase === 'archived') {
      throw new CollabError(403, '当前会话已不再归属于活跃任务');
    }
    const project = store.getProject(task.projectId);
    if (!project) throw new CollabError(404, '所属项目不存在');
    return { task, project };
  }

  function toPeerSummaries(projectId: string, selfTaskId: string): PeerTaskSummary[] {
    const byId = new Map(sessions.list().map(s => [s.id, s]));
    return activeProjectTasks(projectId).map((t, i) => {
      const s = t.sessionId ? byId.get(t.sessionId) : undefined;
      const snapshot = turnFileOf(projectId, t.id);
      return {
        index: i + 1,
        id: t.id,
        title: t.title,
        agent: t.agent,
        phase: t.phase,
        status: s?.status ?? 'none',
        isSelf: t.id === selfTaskId,
        ...(t.lastPrompt ? { lastPrompt: t.lastPrompt } : {}),
        ...(fs.existsSync(snapshot) ? { latestReplyFile: snapshot } : {}),
        ...(t.delegation ? { delegation: { parentTaskId: t.delegation.parentTaskId, state: delegationState(t, s)!, round: t.delegation.round } } : {}),
      };
    });
  }

  function listPeers(callerSessionId: string): PeerListResult {
    const { task, project } = verifyCaller(callerSessionId);
    const file = peersFileOf(project.id);
    if (!fs.existsSync(file)) syncProjectPeers(project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      selfTaskId: task.id,
      peersFile: file,
      tasks: toPeerSummaries(project.id, task.id),
    };
  }

  function readSafePeerFile(project: Project, rawPath: string): string {
    const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(project.path, rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new CollabError(400, `文件不存在：${abs}`);
    }
    if (!stat.isFile()) throw new CollabError(400, `目标不是普通文件：${abs}`);
    if (stat.size > MAX_PEER_FILE_BYTES) {
      throw new CollabError(400, `文件过大（上限 ${MAX_PEER_FILE_BYTES / 1024} KB）：${abs}`);
    }
    const realFile = fs.realpathSync(abs);
    const roots = [fs.realpathSync(project.path)];
    const cDir = collabDirOf(project.id);
    if (fs.existsSync(cDir)) roots.push(fs.realpathSync(cDir));
    if (!roots.some(r => isContainedIn(realFile, r))) {
      throw new CollabError(403, '安全拦截：--file 仅允许读取当前项目目录或项目协作黑板内的文件');
    }
    return fs.readFileSync(realFile, 'utf8');
  }

  function resolveTarget(
    project: Project,
    caller: Task,
    rawInput: string,
    createIfAgent: boolean,
  ): { kind: 'existing'; task: Task; summary: PeerTaskSummary } | { kind: 'spawn'; agent: AgentKind } {
    const q = rawInput.trim().replace(/^@+/, '');
    if (!q) throw new CollabError(400, '请指定目标任务（如 #2、标题关键词或 claude/codex/agy）');

    const summaries = toPeerSummaries(project.id, caller.id);
    const taskMap = new Map(activeProjectTasks(project.id).map(t => [t.id, t]));
    const others = summaries.filter(s => s.id !== caller.id);

    const numMatch = /^#?(\d+)$/.exec(q);
    if (numMatch) {
      const idx = Number(numMatch[1]);
      const hit = summaries.find(s => s.index === idx);
      if (!hit) throw new CollabError(404, `当前项目没有编号为 #${idx} 的任务`);
      if (hit.id === caller.id) throw new CollabError(400, '不能向当前任务自己发送协作消息');
      return { kind: 'existing', task: taskMap.get(hit.id)!, summary: hit };
    }

    const lower = q.toLowerCase();
    const isAgentName = isDeepAgent(lower);

    if (createIfAgent && isAgentName) {
      return { kind: 'spawn', agent: lower as AgentKind };
    }

    const exactId = summaries.find(s => s.id.toLowerCase() === lower);
    if (exactId) {
      if (exactId.id === caller.id) throw new CollabError(400, '不能向当前任务自己发送协作消息');
      return { kind: 'existing', task: taskMap.get(exactId.id)!, summary: exactId };
    }

    if (q.length >= 6) {
      const idMatches = others.filter(s => s.id.toLowerCase().startsWith(lower));
      if (idMatches.length === 1) {
        return { kind: 'existing', task: taskMap.get(idMatches[0].id)!, summary: idMatches[0] };
      }
      if (idMatches.length > 1) {
        throw new CollabError(400, `任务 ID 前缀「${q}」命中多个任务，请使用 #序号：${idMatches.map(m => `#${m.index}`).join(' ')}`);
      }
    }

    if (isAgentName) {
      const agent = lower as AgentKind;
      const matches = others.filter(s => s.agent === agent);
      if (matches.length === 1) {
        return { kind: 'existing', task: taskMap.get(matches[0].id)!, summary: matches[0] };
      }
      if (matches.length === 0) {
        return { kind: 'spawn', agent };
      }
      throw new CollabError(
        400,
        `当前项目存在 ${matches.length} 个 ${agent} 任务，请改用 #序号指定：${matches.map(m => `#${m.index}「${m.title}」`).join(' / ')}`,
      );
    }

    const exactTitle = others.filter(s => s.title.toLowerCase() === lower);
    if (exactTitle.length === 1) {
      return { kind: 'existing', task: taskMap.get(exactTitle[0].id)!, summary: exactTitle[0] };
    }
    const subTitle = others.filter(s => s.title.toLowerCase().includes(lower));
    if (subTitle.length === 1) {
      return { kind: 'existing', task: taskMap.get(subTitle[0].id)!, summary: subTitle[0] };
    }
    if (subTitle.length > 1) {
      throw new CollabError(
        400,
        `目标标题「${q}」不唯一，请改用 #序号：${subTitle.map(m => `#${m.index}「${m.title}」`).join(' / ')}`,
      );
    }

    throw new CollabError(404, `在当前项目中未找到目标任务：${q}（可先运行 shoal peers 查看 #序号）`);
  }

  function sendPeer(callerSessionId: string, body: PeerSendBody): PeerSendResult {
    const { task: caller, project } = verifyCaller(callerSessionId);
    const currentHop = sessionHops.get(callerSessionId) ?? 0;
    const hop = currentHop + 1;
    if (hop > MAX_AUTO_HOPS) {
      throw new CollabError(429, `已达到自动协作最大跳数上限 (${MAX_AUTO_HOPS})，已熔断以防死循环`);
    }

    const rawTarget = typeof body.target === 'string' ? body.target : '';
    const replyBack = body.replyBack === true;
    const createIfAgent = body.createIfAgent === true;
    const resolved = resolveTarget(project, caller, rawTarget, createIfAgent);

    const targetKey = resolved.kind === 'existing' ? resolved.task.id : `spawn:${resolved.agent}`;
    let sentMap = turnSentCounts.get(callerSessionId);
    if (!sentMap) {
      sentMap = new Map<string, number>();
      turnSentCounts.set(callerSessionId, sentMap);
    }
    const priorSends = sentMap.get(targetKey) ?? 0;
    if (priorSends >= MAX_SENDS_PER_TURN) {
      throw new CollabError(409, `本轮向同一目标发送次数已达上限 (${MAX_SENDS_PER_TURN})，请先结束本轮等待对方回应`);
    }

    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const stdinText = typeof body.stdinText === 'string' ? body.stdinText.trim() : '';
    const fileContent = typeof body.filePath === 'string' && body.filePath.trim()
      ? readSafePeerFile(project, body.filePath.trim()).trim()
      : '';

    const parts = [stdinText, fileContent].filter(Boolean);
    const combinedBody = parts.join('\n\n') || note;
    if (!combinedBody.trim()) {
      throw new CollabError(400, '发送内容不能为空，请提供 -m、--file 或 --stdin');
    }
    const headerNote = parts.length ? (note || (replyBack ? '请协助处理以下协作请求并回复结果：' : '下面是来自同项目协作任务的信息：'))
      : (replyBack ? '请协助处理以下请求，完成后把结论发回给我：' : '下面是来自同项目协作任务的简讯：');
    const fullText = forwardText({ title: caller.title, agent: caller.agent }, combinedBody, headerNote, { replyBack });

    if (resolved.kind === 'spawn') {
      if (!isDeepAgent(resolved.agent)) {
        throw new CollabError(400, `「${resolved.agent}」目前为通用终端模式，暂不支持跨 CLI 自动协作与结果回传（仅深度适配 CLI 支持）`);
      }
      const avail = deps.delegatableAgents ? deps.delegatableAgents() : deps.availableAgents().filter(isDeepAgent);
      if (!avail.includes(resolved.agent)) {
        throw new CollabError(400, `智能体不可用：${resolved.agent}`);
      }
      sentMap.set(targetKey, priorSends + 1);
      const title = [...`协作：${caller.title}`].slice(0, 80).join('');
      const parentMode = sessionOf(caller)?.permissionMode ?? caller.permissionMode;
      const { task: createdTask, session: createdSession } = deps.createPeerTask({
        projectId: project.id,
        agent: resolved.agent,
        title,
        prompt: fullText,
        ...(parentMode ? { permissionMode: parentMode } : {}),
      });
      seedSessionHop(createdSession.id, hop);
      if (replyBack) {
        registerReplyBack({
          targetTaskId: createdTask.id,
          targetSessionId: createdSession.id,
          sourceTaskId: caller.id,
          hop,
          immediateArm: true,
        });
      }
      syncProjectPeers(project.id);
      return {
        targetTaskId: createdTask.id,
        targetTitle: createdTask.title,
        targetAgent: createdTask.agent,
        created: true,
        queued: false,
        replyBack,
        hop,
      };
    }

    const target = resolved.task;
    if (replyBack && !isDeepAgent(target.agent)) {
      throw new CollabError(400, `目标任务「${target.title}」使用通用终端 CLI，暂不支持自动回传结果`);
    }
    if (!deps.availableAgents().includes(target.agent)) {
      throw new CollabError(400, `目标智能体不可用：${target.agent}`);
    }
    sentMap.set(targetKey, priorSends + 1);

    let obligationId: string | undefined;
    let boundSessionId = target.sessionId ?? '';
    const { task: deliveredTask, session: deliveredSession } = deps.deliverToTask({
      targetTask: target,
      project,
      text: fullText,
      system: true,
      onDelivered: () => {
        const sid = store.getTask(target.id)?.sessionId ?? boundSessionId;
        if (sid) onSystemDelivered(sid, hop, obligationId);
      },
      cardMeta: {
        sourceTaskId: caller.id,
        peerHop: hop,
        ...(replyBack ? { replyBack: true } : {}),
      },
    });
    boundSessionId = deliveredSession.id;
    if (replyBack) {
      obligationId = registerReplyBack({
        targetTaskId: deliveredTask.id,
        targetSessionId: deliveredSession.id,
        sourceTaskId: caller.id,
        hop,
        immediateArm: false,
      });
    }
    syncProjectPeers(project.id);
    return {
      targetTaskId: deliveredTask.id,
      targetTitle: deliveredTask.title,
      targetAgent: deliveredTask.agent,
      created: false,
      queued: (deliveredSession.queued ?? 0) > 0,
      replyBack,
      hop,
    };
  }

  function sessionOf(task: Task): SessionInfo | undefined {
    return task.sessionId ? sessions.list().find(s => s.id === task.sessionId) : undefined;
  }

  function summarize(task: Task): DelegationSummary {
    const d = task.delegation!;
    const s = sessionOf(task);
    const replyFile = turnFileOf(task.projectId, task.id);
    return {
      id: task.id,
      handle: delegationHandle(task.id),
      title: task.title,
      agent: task.agent,
      state: delegationState(task, s)!,
      round: d.round,
      brief: d.brief,
      status: s?.status ?? 'none',
      createdAt: d.createdAt,
      ...(d.mode ? { mode: d.mode } : {}),
      ...(fs.existsSync(replyFile) ? { latestReplyFile: replyFile } : {}),
    };
  }

  // Brief or feedback text: -m, --stdin and --file joined in that order.
  function composeText(project: Project, body: { note?: string; stdinText?: string; filePath?: string }): string {
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const stdinText = typeof body.stdinText === 'string' ? body.stdinText.trim() : '';
    const fileContent = typeof body.filePath === 'string' && body.filePath.trim()
      ? readSafePeerFile(project, body.filePath.trim()).trim()
      : '';
    const text = [note, stdinText, fileContent].filter(Boolean).join('\n\n');
    if (!text) throw new CollabError(400, '内容不能为空，请提供 -m、--file 或 --stdin');
    return text;
  }

  function checkDelegationHop(callerSessionId: string): number {
    const hop = (sessionHops.get(callerSessionId) ?? 0) + 1;
    if (hop > MAX_DELEGATION_HOPS) {
      throw new CollabError(429, `自动委派链过长（已达 ${MAX_DELEGATION_HOPS} 跳），已停止；需要用户介入后再继续`);
    }
    return hop;
  }

  function delegate(callerSessionId: string, body: PeerDelegateBody): PeerDelegateResult {
    const { task: caller, project } = verifyCaller(callerSessionId);
    if (caller.delegation) throw new CollabError(403, '委派任务不能再向下委派');
    const agent = (typeof body.agent === 'string' ? body.agent.trim().toLowerCase() : '') as AgentKind;
    const delegatable = deps.delegatableAgents ? deps.delegatableAgents() : deps.availableAgents().filter(isDeepAgent);
    if (agent && !isDeepAgent(agent) && deps.availableAgents().includes(agent)) {
      throw new CollabError(400, `「${agent}」目前为通用终端模式，暂不支持跨 CLI 自动委派与结果回传（仅深度适配 CLI 支持）`);
    }
    if (!isDeepAgent(agent) || !delegatable.includes(agent)) {
      throw new CollabError(400, `智能体不可用：${String(body.agent)}（可用：${delegatable.join(' / ') || '无'}）`);
    }
    const hop = checkDelegationHop(callerSessionId);
    const open = store.tasks().filter(t => t.delegation?.parentTaskId === caller.id && t.phase !== 'archived').length;
    if (open >= MAX_OPEN_DELEGATIONS) {
      throw new CollabError(409, `未关闭的委派任务已有 ${open} 个（上限 ${MAX_OPEN_DELEGATIONS}），请先用 shoal done / shoal cancel 处理已有的`);
    }
    const brief = composeText(project, body);
    if (body.review === true && body.plan === true) throw new CollabError(400, '--review 和 --plan 只能选一个');
    const mode: DelegationMode | undefined = body.review === true ? 'review' : body.plan === true ? 'plan' : undefined;
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const title = [...(rawTitle || delegationTitle(brief) || firstLinePreview(brief, 40))].slice(0, 80).join('');
    const parentMode = sessionOf(caller)?.permissionMode ?? caller.permissionMode;
    const { task, session } = deps.createPeerTask({
      projectId: project.id,
      agent,
      title,
      prompt: delegationPrompt({ title: caller.title, agent: caller.agent }, brief, { mode }),
      delegation: { parentTaskId: caller.id, brief: firstLinePreview(brief, 140), round: 1, createdAt: Date.now(), ...(mode ? { mode } : {}) },
      ...(parentMode ? { permissionMode: parentMode } : {}),
    });
    seedSessionHop(session.id, hop);
    syncProjectPeers(project.id);
    return { task: summarize(store.getTask(task.id) ?? task), hop };
  }

  // Candidates are the caller's delegated tasks, archived ones included.
  function resolveDelegated(caller: Task, raw: string, opts: { includeArchived: boolean }): Task {
    const q = raw.trim().replace(/^@+/, '');
    if (!q) throw new CollabError(400, '请指定委派任务（句柄、#序号或标题片段，shoal status 可查看）');
    const candidates = store.tasks().filter(t => t.delegation?.parentTaskId === caller.id);
    const found = (t: Task): Task => {
      if (t.phase === 'archived' && !opts.includeArchived) {
        throw new CollabError(409, `委派任务「${t.title}」已关闭（${DELEGATION_LABEL[delegationState(t, undefined)!]}），不能再操作`);
      }
      return t;
    };
    const handles = (list: Task[]) => list.map(t => `${delegationHandle(t.id)}「${t.title}」`).join(' / ');

    const num = /^#?(\d+)$/.exec(q);
    if (num) {
      const byIndex = activeProjectTasks(caller.projectId)[Number(num[1]) - 1];
      if (byIndex) {
        if (!candidates.some(c => c.id === byIndex.id)) throw new CollabError(400, `#${num[1]} 不是你委派的任务`);
        return found(byIndex);
      }
    }
    const lower = q.toLowerCase();
    const exact = candidates.find(t => t.id.toLowerCase() === lower);
    if (exact) return found(exact);
    if (q.length >= 4) {
      const byPrefix = candidates.filter(t => t.id.toLowerCase().startsWith(lower));
      if (byPrefix.length === 1) return found(byPrefix[0]);
      if (byPrefix.length > 1) throw new CollabError(400, `句柄「${q}」命中多个委派任务：${handles(byPrefix)}`);
    }
    const byTitle = candidates.filter(t => t.phase !== 'archived' && t.title.toLowerCase().includes(lower));
    if (byTitle.length === 1) return found(byTitle[0]);
    if (byTitle.length > 1) throw new CollabError(400, `标题片段「${q}」命中多个委派任务：${handles(byTitle)}`);
    throw new CollabError(404, `没有找到你委派的任务：${q}（运行 shoal status 查看句柄）`);
  }

  function rework(callerSessionId: string, body: PeerDelegationActionBody): PeerDelegationActionResult {
    const { task: caller, project } = verifyCaller(callerSessionId);
    const child = resolveDelegated(caller, typeof body.target === 'string' ? body.target : '', { includeArchived: false });
    const feedback = composeText(project, body);
    const d = child.delegation!;
    const nextRound = d.round + 1;
    if (nextRound > MAX_DELEGATION_ROUNDS) {
      const next = d.mode === 'review' ? '仍有 BLOCKING 的交给用户决定'
        : d.mode === 'plan' ? '还有疑问的自己核实或问用户'
          : '请自己接手修改，或请用户决定下一步';
      throw new CollabError(409, `这个委派任务已经到第 ${d.round} 轮（上限 ${MAX_DELEGATION_ROUNDS} 轮），不能再返工；${next}`);
    }
    const hop = checkDelegationHop(callerSessionId);
    if (!deps.availableAgents().includes(child.agent)) {
      throw new CollabError(400, `目标智能体不可用：${child.agent}`);
    }
    let sentMap = turnSentCounts.get(callerSessionId);
    if (!sentMap) {
      sentMap = new Map<string, number>();
      turnSentCounts.set(callerSessionId, sentMap);
    }
    const prior = sentMap.get(child.id) ?? 0;
    if (prior >= MAX_SENDS_PER_TURN) {
      throw new CollabError(409, `本轮向同一目标发送次数已达上限 (${MAX_SENDS_PER_TURN})，请先结束本轮等待对方回应`);
    }
    sentMap.set(child.id, prior + 1);

    // pasteIntoTask writes this task object (round included) back to the store.
    const updated: Task = { ...child, delegation: { ...d, round: nextRound } };
    let boundSessionId = child.sessionId ?? '';
    // Queueing the note re-emits the child's session synchronously. A dialog still open from the previous round was
    // already reported, so that emit must not count as the new round's notice: hold the slot while delivering.
    blockNotified.set(child.id, nextRound);
    let result: ReturnType<CollabDeps['deliverToTask']>;
    try {
      result = deps.deliverToTask({
        targetTask: updated,
        project,
        text: delegationReworkText({ title: caller.title }, nextRound, feedback, d.mode),
        system: true,
        onDelivered: () => {
          const sid = store.getTask(child.id)?.sessionId ?? boundSessionId;
          if (sid) onSystemDelivered(sid, hop);
        },
        cardMeta: { sourceTaskId: caller.id, peerHop: hop, delegation: 'rework' },
      });
    } finally {
      blockNotified.delete(child.id);
    }
    const { task: delivered, session } = result;
    boundSessionId = session.id;
    syncProjectPeers(project.id);
    return { task: summarize(store.getTask(child.id) ?? delivered), queued: (session.queued ?? 0) > 0 };
  }

  function settle(
    callerSessionId: string, body: PeerDelegationActionBody, outcome: 'accepted' | 'canceled',
  ): PeerDelegationActionResult {
    const { task: caller } = verifyCaller(callerSessionId);
    const child = resolveDelegated(caller, typeof body.target === 'string' ? body.target : '', { includeArchived: true });
    if (child.phase === 'archived') return { task: summarize(child) };
    if (outcome === 'accepted') {
      const state = delegationState(child, sessionOf(child))!;
      if (state !== 'review') {
        throw new CollabError(409, `委派任务「${child.title}」还没有交付结果（当前：${DELEGATION_LABEL[state]}），不能验收通过；要放弃请用 shoal cancel`);
      }
    }
    return { task: summarize(deps.closeDelegation(child, outcome)) };
  }

  function listDelegations(callerSessionId: string): PeerDelegationList {
    const { task: caller, project } = verifyCaller(callerSessionId);
    const children = store.tasks()
      .filter(t => t.delegation?.parentTaskId === caller.id)
      .sort((a, b) => a.delegation!.createdAt - b.delegation!.createdAt)
      .slice(-20);
    const parent = caller.delegation ? store.getTask(caller.delegation.parentTaskId) : undefined;
    return {
      projectName: project.name,
      selfTaskId: caller.id,
      ...(parent && parent.phase !== 'archived' ? { parent: { id: parent.id, title: parent.title } } : {}),
      tasks: children.map(summarize),
    };
  }

  return {
    collabDirOf,
    peersFileOf,
    turnFileOf,
    syncProjectPeers,
    recordTurnReply,
    clearSessionState,
    removeTaskSnapshot,
    removeProjectCollab,
    registerReplyBack,
    seedSessionHop,
    onSystemDelivered,
    onPromptStart,
    onPrimaryStop,
    listPeers,
    sendPeer,
    delegate,
    rework,
    settle,
    listDelegations,
    onChildBlocked,
  };
}

export type { EnqueueOptions };
