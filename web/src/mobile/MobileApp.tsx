import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, MobileRouteVia, ServerMsg, SessionActivity, Snapshot } from '../../../shared/protocol.ts';
import { usePrivacy } from '../privacy.ts';
import { connect, send } from '../ws.ts';
import { isTransientError, mobileGet, mobilePost, setMobileUnauthorizedHandler } from './api.ts';
import type { TermStreamEvent } from './EmergencyTerminalDrawer.tsx';
import { MobileHome } from './MobileHome.tsx';
import { NewTaskSheet } from './MobileSheets.tsx';
import { MobileTaskView } from './MobileTaskView.tsx';
import { PairScreen } from './PairScreen.tsx';
import { useBackLayer } from './useBackLayer.ts';

function parseHashRoute(): { pairToken: string | null; taskId: string | null } {
  if (typeof location === 'undefined') return { pairToken: null, taskId: null };
  const h = location.hash.replace(/^#/, '');
  if (!h) return { pairToken: null, taskId: null };
  const params = new URLSearchParams(h);
  return {
    pairToken: params.get('pair'),
    taskId: params.get('task'),
  };
}

function applyServerMsg(prev: Snapshot, m: ServerMsg): Snapshot {
  switch (m.t) {
    case 'snapshot':
      return m.state;
    case 'project': {
      const idx = prev.projects.findIndex((p) => p.id === m.project.id);
      const projects = idx >= 0
        ? prev.projects.map((p, i) => (i === idx ? m.project : p))
        : [...prev.projects, m.project];
      return { ...prev, projects };
    }
    case 'project-removed': {
      const git = { ...prev.git };
      delete git[m.id];
      return { ...prev, projects: prev.projects.filter((p) => p.id !== m.id), git };
    }
    case 'task': {
      const idx = prev.tasks.findIndex((t) => t.id === m.task.id);
      const tasks = idx >= 0
        ? prev.tasks.map((t, i) => (i === idx ? m.task : t))
        : [...prev.tasks, m.task];
      return { ...prev, tasks };
    }
    case 'task-removed':
      return {
        ...prev,
        tasks: prev.tasks.filter((t) => t.id !== m.id),
        cards: prev.cards.filter((c) => c.taskId !== m.id),
      };
    case 'card': {
      const cards = prev.cards.some((c) => c.id === m.card.id)
        ? prev.cards.map((c) => (c.id === m.card.id ? m.card : c))
        : [...prev.cards, m.card];
      return { ...prev, cards };
    }
    case 'session': {
      const idx = prev.sessions.findIndex((s) => s.id === m.session.id);
      const sessions = idx >= 0
        ? prev.sessions.map((s, i) => (i === idx ? m.session : s))
        : [...prev.sessions, m.session];
      return { ...prev, sessions };
    }
    case 'settings':
      return { ...prev, settings: m.settings };
    case 'git':
      return { ...prev, git: { ...prev.git, [m.projectId]: m.git } };
    case 'quota':
      return { ...prev, quota: { ...prev.quota, [m.agent]: m.quota } };
    case 'telemetry':
      return { ...prev, telemetry: m.telemetry };
    case 'activity': {
      const activity: Record<string, SessionActivity> = { ...(prev.activity ?? {}) };
      if (m.activity) activity[m.sessionId] = m.activity;
      else delete activity[m.sessionId];
      return { ...prev, activity };
    }
    default:
      return prev;
  }
}

export function MobileApp() {
  const initialRoute = useRef(parseHashRoute());
  const [pairToken, setPairToken] = useState<string | null>(() => initialRoute.current.pairToken);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => initialRoute.current.taskId);
  const [auth, setAuth] = useState<'checking' | 'paired' | 'unpaired'>('checking');
  const [via, setVia] = useState<MobileRouteVia>('lan');
  const [pairNotice, setPairNotice] = useState('');
  const [state, setState] = useState<Snapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [checkFailing, setCheckFailing] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const lastSyncRef = useRef<number | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const termSubsRef = useRef(new Set<(ev: TermStreamEvent) => void>());

  const newTaskLayer = useBackLayer(showNewTask, () => setShowNewTask(false));
  const privacy = usePrivacy();

  // 隐私模式挂在 <html> 上，sheet、抽屉等不在 .mob-root 里的层也一起模糊。
  useEffect(() => {
    document.documentElement.classList.toggle('mob-privacy', privacy);
  }, [privacy]);

  // Strip #pair= from URL bar immediately so referrer/history do not keep ephemeral tokens.
  useEffect(() => {
    if (initialRoute.current.pairToken) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    // Task deep link without our own stack entry (cold start, notification link): make home the entry below it,
    // so system back returns to the home list instead of leaving the app.
    const ensureTaskEntry = () => {
      if (!parseHashRoute().taskId || history.state?.shoalTask) return;
      const url = location.pathname + location.search + location.hash;
      history.replaceState(null, '', location.pathname + location.search);
      history.pushState({ shoalTask: true }, '', url);
    };
    ensureTaskEntry();
    const onRoute = () => {
      const r = parseHashRoute();
      if (r.pairToken) {
        setPairToken(r.pairToken);
        history.replaceState(null, '', location.pathname + location.search);
      }
      ensureTaskEntry();
      setSelectedTaskId(parseHashRoute().taskId);
    };
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('popstate', onRoute);
    return () => {
      window.removeEventListener('hashchange', onRoute);
      window.removeEventListener('popstate', onRoute);
    };
  }, []);

  // iOS keyboard: the layout viewport does not shrink, the visual viewport does. On Android (resizes-content) both
  // match, so the variable equals 100dvh. Multiplying by scale ignores pinch-zoom.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const h = Math.round(vv.height * vv.scale);
      if (h > 0) document.documentElement.style.setProperty('--mob-vvh', `${h}px`);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
      document.documentElement.style.removeProperty('--mob-vvh');
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const dropToPair = useCallback((reason: string) => {
    setAuth('unpaired');
    setState(null);
    setWsConnected(false);
    setRttMs(null);
    if (reason) setPairNotice(reason);
  }, []);

  useEffect(() => {
    setMobileUnauthorizedHandler(() => dropToPair('设备授权已失效，请重新配对。'));
    return () => setMobileUnauthorizedHandler(null);
  }, [dropToPair]);

  // Startup session check. Only HTTP 401 or a 200 with authenticated === false goes to the pairing page; a network
  // error / 5xx / unreadable body retries with backoff, and any other error (e.g. 403 host not allowed) shows the
  // server's message on the check page and keeps retrying slowly.
  useEffect(() => {
    let alive = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const res = await mobileGet<{ authenticated: boolean; via: MobileRouteVia }>('/api/mobile/session');
        if (!alive) return;
        setCheckFailing(false);
        setCheckError('');
        setVia(res.via);
        if (res.authenticated === true) {
          setPairNotice('');
          setAuth('paired');
        } else if (res.authenticated === false) {
          setAuth('unpaired');
        } else {
          // 200 without a verdict: not a conclusion.
          setCheckError('服务端返回了无法识别的授权状态，正在重试…');
          timer = setTimeout(() => void run(), 10_000);
        }
      } catch (e) {
        if (!alive) return;
        const status = (e as { status?: number }).status;
        if (status === 401) {
          setCheckFailing(false);
          setCheckError('');
          setAuth('unpaired');
        } else if (isTransientError(e)) {
          setCheckFailing(true);
          setCheckError('');
          timer = setTimeout(() => void run(), Math.min(8000, 1000 * 2 ** attempt++));
        } else {
          setCheckFailing(false);
          setCheckError((e as Error).message || `请求失败 (${status})`);
          timer = setTimeout(() => void run(), 10_000);
        }
      }
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (auth !== 'paired') return;
    let alive = true;
    // The server pushes a snapshot as soon as the socket is up; it is the source of truth for this connection. The
    // initial HTTP snapshot only fills the gap before the first one and must never overwrite WS state, even after a
    // disconnect (so this flag is never reset; `wsConnected` tracks the current connection).
    let wsSnapshotSeen = false;
    void mobileGet<Snapshot>('/api/state').then(
      (snap) => {
        if (!alive || wsSnapshotSeen) return;
        lastSyncRef.current = Date.now();
        setState(snap);
      },
      () => {},
    );

    const stopWs = connect({
      onOpen: () => {
        if (!alive) return;
        // Not "connected" until this connection's snapshot arrives (a reconnect missed events; task views reload their own data).
        lastSyncRef.current = Date.now();
        send({ t: 'ping', ts: Date.now() });
      },
      onClose: () => {
        if (!alive) return;
        setWsConnected(false);
        setLastSyncAt(lastSyncRef.current);
      },
      onMsg: (m) => {
        if (!alive) return;
        lastSyncRef.current = Date.now();
        if (m.t === 'revoked') {
          dropToPair('当前设备已被桌面端撤销授权。');
          return;
        }
        if (m.t === 'pong') {
          setVia(m.via);
          setRttMs(Math.max(1, Date.now() - m.ts));
          return;
        }
        if (m.t === 'replay' || m.t === 'out') {
          const ev: TermStreamEvent = { kind: m.t, id: m.id, d: m.d };
          for (const fn of termSubsRef.current) fn(ev);
          return;
        }
        if (m.t === 'snapshot') {
          wsSnapshotSeen = true;
          setWsConnected(true);
        }
        setState((prev) => {
          if (m.t === 'snapshot') return m.state;
          return prev ? applyServerMsg(prev, m) : prev;
        });
      },
    });

    const pingTimer = setInterval(() => {
      send({ t: 'ping', ts: Date.now() });
    }, 15_000);

    return () => {
      alive = false;
      clearInterval(pingTimer);
      stopWs();
    };
  }, [auth, dropToPair]);

  const subscribeTerm = useCallback((fn: (ev: TermStreamEvent) => void) => {
    termSubsRef.current.add(fn);
    return () => { termSubsRef.current.delete(fn); };
  }, []);

  const sendMsg = useCallback((m: ClientMsg) => {
    send(m);
  }, []);

  // Open a task: push an entry from home, replace when already inside a task (or when taking over a layer entry).
  const openTask = useCallback((taskId: string, replace = false) => {
    const url = `${location.pathname}${location.search}#task=${encodeURIComponent(taskId)}`;
    if (replace || history.state?.shoalTask) history.replaceState({ shoalTask: true }, '', url);
    else history.pushState({ shoalTask: true }, '', url);
    setSelectedTaskId(taskId);
  }, []);

  const closeTask = useCallback(() => {
    if (history.state?.shoalTask) {
      history.back(); // popstate handler resets selectedTaskId
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      setSelectedTaskId(null);
    }
  }, []);

  // Throws when the server did not confirm: the caller shows the error and the device stays paired.
  const handleLogout = async () => {
    const res = await mobilePost<{ ok?: boolean }>('/api/mobile/logout', {});
    if (res?.ok !== true) throw new Error('服务端没有确认解除配对');
    dropToPair('已解除本机配对。');
  };

  if (auth === 'checking') {
    return (
      <div className="mob-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="mob-sub" data-testid="mobile-checking">
          {checkFailing ? '无法连接到电脑，正在重试…' : '正在检查设备授权…'}
        </div>
        {checkError && (
          <div className="form-error" style={{ marginTop: '0.75rem', textAlign: 'center' }} data-testid="mobile-check-error">{checkError}</div>
        )}
      </div>
    );
  }

  if (auth === 'unpaired') {
    return (
      <PairScreen
        initialPairToken={pairToken}
        notice={pairNotice}
        onClearInitialToken={() => setPairToken(null)}
        onPaired={() => {
          setPairNotice('');
          setAuth('paired');
        }}
      />
    );
  }

  if (!state) {
    return (
      <div className="mob-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="mob-sub">{wsConnected ? '正在同步桌面工作台状态…' : '无法连接到电脑，正在重试…'}</div>
      </div>
    );
  }

  const activeTask = selectedTaskId ? state.tasks.find((t) => t.id === selectedTaskId) : undefined;

  if (activeTask) {
    return (
      <MobileTaskView
        key={activeTask.id}
        task={activeTask}
        state={state}
        now={now}
        wsConnected={wsConnected}
        lastSyncAt={lastSyncAt}
        subscribeTerm={subscribeTerm}
        sendMsg={sendMsg}
        onBack={closeTask}
        onOpenTask={(id) => openTask(id)}
      />
    );
  }

  return (
    <>
      <MobileHome
        state={state}
        via={via}
        rttMs={rttMs}
        wsConnected={wsConnected}
        lastSyncAt={lastSyncAt}
        now={now}
        onSelectTask={(id) => openTask(id)}
        onOpenNewTask={() => setShowNewTask(true)}
        onLogout={handleLogout}
      />
      {showNewTask && (
        <NewTaskSheet
          projects={state.projects}
          agents={state.agents}
          defaultAgyModel={state.settings.agyModel}
          onCreated={(id) => {
            // The sheet's history entry becomes the task entry, so back returns to home.
            const tookOver = newTaskLayer.release();
            setShowNewTask(false);
            openTask(id, tookOver);
          }}
          onClose={newTaskLayer.close}
        />
      )}
    </>
  );
}
