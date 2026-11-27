import { afterEach, describe, expect, it } from 'vitest';
import { autoResizeTextarea } from './autoResizeTextarea.ts';

interface MockTextareaEnv {
  el: HTMLTextAreaElement;
  parent: HTMLElement;
  events: string[];
  setMetrics: (next: Partial<MockMetrics>) => void;
}

interface MockMetrics {
  clientWidth: number;
  offsetHeight: number;
  clientHeight: number;
  naturalScrollHeight: number;
  overflowScrollHeight?: number;
  parentRectHeight: number;
  maxHeight: string;
  parentBoxSizing: string;
  scrollTop: number;
}

const origGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
  globalThis.getComputedStyle = origGetComputedStyle;
});

function createMockEnv(initial: Partial<MockMetrics> = {}): MockTextareaEnv {
  const m: MockMetrics = {
    clientWidth: 640,
    offsetHeight: 50,
    clientHeight: 50,
    naturalScrollHeight: 50,
    parentRectHeight: 124.25,
    maxHeight: '156px',
    parentBoxSizing: 'border-box',
    scrollTop: 0,
    ...initial,
  };

  const events: string[] = [];
  const parentStyle: Record<string, string> = { minHeight: '' };
  const parent = {
    style: new Proxy(parentStyle, {
      set(target, prop: string, val: string) {
        events.push(`parent.${prop}=${val}`);
        target[prop] = val;
        return true;
      },
    }),
    getBoundingClientRect: () => ({ height: m.parentRectHeight }),
  } as unknown as HTMLElement;

  const elStyle: Record<string, string> = { height: `${m.offsetHeight}px`, overflowY: 'hidden' };
  const el = {
    parentElement: parent,
    style: new Proxy(elStyle, {
      set(target, prop: string, val: string) {
        events.push(`el.${prop}=${val}`);
        target[prop] = val;
        if (prop === 'height' && val !== 'auto') {
          const px = Number.parseFloat(val);
          if (Number.isFinite(px)) {
            const border = Math.max(0, m.offsetHeight - m.clientHeight);
            m.offsetHeight = px;
            m.clientHeight = Math.max(0, px - border);
          }
        }
        return true;
      },
    }),
    get clientWidth() { return m.clientWidth; },
    get offsetHeight() { return m.offsetHeight; },
    get clientHeight() { return m.clientHeight; },
    get scrollTop() { return m.scrollTop; },
    set scrollTop(v: number) {
      events.push(`el.scrollTop=${v}`);
      m.scrollTop = v;
    },
    get scrollHeight() {
      events.push(`read.scrollHeight(height=${elStyle.height},parentMinH=${parentStyle.minHeight},overflowY=${elStyle.overflowY})`);
      if (elStyle.height === 'auto') return m.naturalScrollHeight;
      if (m.overflowScrollHeight !== undefined) return m.overflowScrollHeight;
      return Math.max(m.clientHeight, m.naturalScrollHeight);
    },
  } as unknown as HTMLTextAreaElement;

  globalThis.getComputedStyle = ((node: Element) => {
    if (node === (el as unknown as Element)) {
      return { maxHeight: m.maxHeight } as CSSStyleDeclaration;
    }
    return {
      boxSizing: m.parentBoxSizing,
      paddingTop: '10px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
    } as CSSStyleDeclaration;
  }) as typeof getComputedStyle;

  return {
    el,
    parent,
    events,
    setMetrics: (next) => Object.assign(m, next),
  };
}

describe('autoResizeTextarea', () => {
  it('locks parent min-height (ceil) BEFORE setting height=auto and restores it after, preventing sibling scroll clamp', () => {
    const { el, events } = createMockEnv({
      offsetHeight: 50,
      clientHeight: 50,
      naturalScrollHeight: 50,
      parentRectHeight: 124.25,
    });

    const delta = autoResizeTextarea(el, 156);
    expect(delta).toBe(0);
    expect(el.style.height).toBe('50px');
    expect(el.parentElement!.style.minHeight).toBe('');

    const lockIdx = events.indexOf('parent.minHeight=125px');
    const autoIdx = events.indexOf('el.height=auto');
    const readIdx = events.findIndex((e) => e.startsWith('read.scrollHeight(height=auto,parentMinH=125px,overflowY=hidden)'));
    const restoreHIdx = events.indexOf('el.height=50px');
    const unlockIdx = events.lastIndexOf('parent.minHeight=');

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(autoIdx).toBeGreaterThan(lockIdx);
    expect(readIdx).toBeGreaterThan(autoIdx);
    expect(restoreHIdx).toBeGreaterThan(readIdx);
    expect(unlockIdx).toBeGreaterThan(restoreHIdx);
  });

  it('fast-paths pure growth without collapsing to height=auto at all', () => {
    const { el, events } = createMockEnv({
      offsetHeight: 28,
      clientHeight: 28,
      naturalScrollHeight: 50,
    });

    const delta = autoResizeTextarea(el, 156);
    expect(delta).toBe(22);
    expect(el.style.height).toBe('50px');
    expect(el.style.overflowY).toBe('hidden');
    expect(events).not.toContain('el.height=auto');
  });

  it('fast-paths typing when already capped at max-height with overflowing content, preserving scrollTop with zero reflows', () => {
    const { el, events } = createMockEnv({
      offsetHeight: 156,
      clientHeight: 156,
      naturalScrollHeight: 220,
      overflowScrollHeight: 220,
      scrollTop: 64,
    });
    el.style.overflowY = 'auto';
    events.length = 0;

    const delta = autoResizeTextarea(el, 156);
    expect(delta).toBe(0);
    expect(el.style.height).toBe('156px');
    expect(el.scrollTop).toBe(64);
    expect(events.filter((e) => e.startsWith('el.height=') || e.startsWith('parent.minHeight='))).toEqual([]);
  });

  it('shrinks cleanly back below cap and switches overflowY from auto back to hidden', () => {
    const { el } = createMockEnv({
      offsetHeight: 156,
      clientHeight: 156,
      naturalScrollHeight: 72,
      overflowScrollHeight: 156,
    });
    el.style.overflowY = 'auto';

    const delta = autoResizeTextarea(el, 156);
    expect(delta).toBe(-84);
    expect(el.style.height).toBe('72px');
    expect(el.style.overflowY).toBe('hidden');
    expect(el.parentElement!.style.minHeight).toBe('');
  });

  it('accounts for textarea border (e.g. mobile 1px border) and preserves non-border-box parent height', () => {
    const { el, events } = createMockEnv({
      offsetHeight: 88,
      clientHeight: 86, // 2px vertical border
      naturalScrollHeight: 64,
      parentRectHeight: 108,
      parentBoxSizing: 'content-box',
    });

    const delta = autoResizeTextarea(el, 156);
    expect(delta).toBe(-22);
    expect(el.style.height).toBe('66px'); // 64 + 2 border
    expect(events).toContain('parent.minHeight=88px'); // 108 - (10+8+1+1)
    expect(el.parentElement!.style.minHeight).toBe('');
  });

  it('does nothing when the textarea is hidden (clientWidth === 0)', () => {
    const { el, events } = createMockEnv({ clientWidth: 0, offsetHeight: 50, clientHeight: 50 });
    events.length = 0;
    expect(autoResizeTextarea(el, 156)).toBe(0);
    expect(events).toEqual([]);
  });
});
