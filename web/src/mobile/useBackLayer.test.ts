import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for React (one component instance at a time: hook slots, effects run on commit, cleanups on unmount) and
// for the browser history (back/go are queued until the test lets them land), enough to drive useBackLayer.
interface Instance { slots: unknown[]; idx: number; pending: (() => void)[] }
let inst: Instance;
vi.mock('react', () => ({
  useRef: (v: unknown) => {
    const i = inst.idx++;
    if (!(i in inst.slots)) inst.slots[i] = { current: v };
    return inst.slots[i];
  },
  useCallback: (fn: unknown) => {
    const i = inst.idx++;
    if (!(i in inst.slots)) inst.slots[i] = fn;
    return inst.slots[i];
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = inst.idx++;
    const prev = inst.slots[i] as { deps?: unknown[]; cleanup?: void | (() => void) } | undefined;
    if (prev && deps && prev.deps && deps.every((d, k) => d === prev.deps![k])) return;
    const target = inst;
    inst.pending.push(() => {
      if (typeof prev?.cleanup === 'function') prev.cleanup();
      target.slots[i] = { deps, cleanup: fn() };
    });
  },
}));

let stack: unknown[];
let index: number;
let queued: number[];
let listeners: (() => void)[];

function installHistory() {
  stack = [null];
  index = 0;
  queued = [];
  listeners = [];
  const history = {
    get state() { return stack[index]; },
    pushState(state: unknown) { stack = stack.slice(0, index + 1); stack.push(state); index++; },
    replaceState(state: unknown) { stack[index] = state; },
    back() { queued.push(-1); },
    go(n: number) { queued.push(n); },
  };
  vi.stubGlobal('history', history);
  vi.stubGlobal('location', { href: 'http://phone/' });
  vi.stubGlobal('window', { addEventListener: (_: string, fn: () => void) => listeners.push(fn) });
}

// Lets the browser finish every queued back/go, one popstate each.
function land() {
  while (queued.length) {
    index = Math.max(0, index + queued.shift()!);
    for (const fn of listeners) fn();
  }
}

const microtasks = () => new Promise<void>(r => setTimeout(r, 0));

async function mount(open: boolean, onPop: () => void) {
  const { useBackLayer } = await import('./useBackLayer.ts');
  const self: Instance = { slots: [], idx: 0, pending: [] };
  let api!: ReturnType<typeof useBackLayer>;
  const render = (o: boolean) => {
    inst = self;
    self.idx = 0;
    api = useBackLayer(o, onPop);
    const run = self.pending.splice(0);
    for (const fn of run) fn();
  };
  render(open);
  return {
    get api() { return api; },
    render,
    unmount() {
      for (const s of self.slots) {
        const c = (s as { cleanup?: unknown } | undefined)?.cleanup;
        if (typeof c === 'function') c();
      }
    },
  };
}

describe('useBackLayer', () => {
  beforeEach(() => {
    vi.resetModules();
    installHistory();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('runs a popThen callback once the entry is gone, but not after its component unmounted', async () => {
    const kept = await mount(true, () => {});
    expect(index).toBe(1);
    const confirmed = vi.fn();
    kept.api.popThen(confirmed);
    await microtasks();
    expect(confirmed).not.toHaveBeenCalled();
    land();
    expect(index).toBe(0);
    expect(confirmed).toHaveBeenCalledTimes(1);

    // Confirmed, then the user left the screen before the back landed: the archive / sign-out must not fire.
    const left = await mount(true, () => {});
    const late = vi.fn();
    left.api.popThen(late);
    await microtasks();
    left.unmount();
    land();
    expect(index).toBe(0);
    expect(late).not.toHaveBeenCalled();
  });

  it('asks the browser to go back once for a double-tapped close', async () => {
    const onPop = vi.fn();
    const layer = await mount(true, onPop);
    layer.api.close();
    layer.api.close();
    expect(queued).toEqual([-1]);
    land();
    expect(index).toBe(0);
    expect(onPop).toHaveBeenCalledTimes(1);
  });

  it('a popThen after close() rides on the same back and leaves the layer underneath open', async () => {
    const menuPop = vi.fn();
    const menu = await mount(true, menuPop);
    const confirmPop = vi.fn();
    const confirm = await mount(true, confirmPop);
    expect(index).toBe(2);
    const confirmed = vi.fn();
    confirm.api.close(); // cancel tapped
    confirm.api.popThen(confirmed); // confirm tapped before the back landed
    await microtasks();
    expect(queued).toEqual([-1]);
    land();
    expect(index).toBe(1);
    expect(confirmPop).toHaveBeenCalledTimes(1);
    expect(menuPop).not.toHaveBeenCalled();
    expect(confirmed).toHaveBeenCalledTimes(1);
    menu.unmount();
  });
});
