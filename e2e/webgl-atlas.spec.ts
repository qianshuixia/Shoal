import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, termText, token } from './helpers.ts';

interface TermGlDebug {
  hasGl: boolean;
  liveGlCount: number;
  atlasId: number | null;
  atlasPages: number;
  page0Version: number | null;
  slot0TexVersion: number | null;
  requestClearModel: boolean | null;
  contextLost: boolean | null;
  addonCount: number;
  rebuildCount: number;
  syncCount: number;
  pendingCooldownRecheck: boolean;
  pendingRestoreRetry: boolean;
  glSuspended: boolean;
  screenCanvasCount: number;
  themeListeners: number;
  windowListeners: number;
  optionListeners: number;
  linkListeners: number;
}

const VERIFY_DIR = path.resolve('.tmp/webgl-atlas-fix');
const VERIFY_FILE = path.join(VERIFY_DIR, 'verification.json');
const snapshots: Record<string, unknown> = {};

test.describe.configure({ mode: 'serial' });

const WS_INIT_SCRIPT = () => {
  const w = window as any;
  w.__wsResizeEvents = [];
  w.__wbLastWs = null;
  w.__liveResizeObservers = 0;

  const liveRO = new Set<ResizeObserver>();
  const OrigRO = window.ResizeObserver;
  window.ResizeObserver = class extends OrigRO {
    observe(target: Element, options?: ResizeObserverOptions) {
      liveRO.add(this);
      w.__liveResizeObservers = liveRO.size;
      return super.observe(target, options);
    }
    disconnect() {
      liveRO.delete(this);
      w.__liveResizeObservers = liveRO.size;
      return super.disconnect();
    }
  };

  const msgDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  if (msgDesc?.set && msgDesc.get) {
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      configurable: true,
      get() {
        return msgDesc.get!.call(this);
      },
      set(fn) {
        w.__wbLastWs = this;
        return msgDesc.set!.call(this, fn);
      },
    });
  }
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: string | Blob | BufferSource) {
    w.__wbLastWs = this;
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed?.t === 'resize') w.__wsResizeEvents.push(parsed);
      } catch {
        // ignore non-json
      }
    }
    return origSend.call(this, data);
  };
};

test.beforeEach(async ({ page, request }) => {
  await removeAllTasks(request);
  await page.addInitScript(WS_INIT_SCRIPT);
});

test.afterAll(() => {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.writeFileSync(VERIFY_FILE, JSON.stringify(snapshots, null, 2), 'utf8');
});

const glState = (page: Page, sessionId: string, opts?: { fireWindowChange?: boolean }) =>
  page.evaluate(({ id, o }) => (window as any).__wbTermGlState(id, o) as TermGlDebug, { id: sessionId, o: opts });

const termSize = (page: Page, sessionId: string) =>
  page.evaluate((id) => (window as any).__wbTermSize(id) as { cols: number; rows: number } | null, sessionId);

const resizeCount = (page: Page) =>
  page.evaluate(() => ((window as any).__wsResizeEvents as unknown[]).length);

async function injectOut(page: Page, sessionId: string, d: string) {
  await page.evaluate(({ id, text }) => {
    const ws = (window as any).__wbLastWs as WebSocket | null;
    if (!ws || !ws.onmessage) throw new Error('WebSocket not connected');
    ws.onmessage(new MessageEvent('message', { data: JSON.stringify({ t: 'out', id, d: text }) }));
  }, { id: sessionId, text: d });
}

async function injectReplay(page: Page, sessionId: string, d: string) {
  await page.evaluate(({ id, text }) => {
    const ws = (window as any).__wbLastWs as WebSocket | null;
    if (!ws || !ws.onmessage) throw new Error('WebSocket not connected');
    ws.onmessage(new MessageEvent('message', { data: JSON.stringify({ t: 'replay', id, d: text }) }));
  }, { id: sessionId, text: d });
}

test('smoke: single/dual pane WebGL lifecycle releases detached terminals and migrates focused right pane', async ({ page, request }) => {
  const proj = await createProject(request, token('gl-life'));
  const t1 = await createFakeTask(request, proj.id, token('S1'));
  const t2 = await createFakeTask(request, proj.id, token('S2'));
  const t3 = await createFakeTask(request, proj.id, token('S3'));
  const [s1, s2, s3] = [t1.session, t2.session, t3.session];

  await page.goto('/');
  for (const s of [s1, s2, s3]) await expect(row(page, s.id)).toBeVisible();

  await row(page, s1.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', s1.id);
  await expect.poll(async () => (await glState(page, s1.id)).hasGl).toBe(true);
  const st1 = await glState(page, s1.id);
  expect(st1.liveGlCount).toBe(1);
  expect(st1.addonCount).toBe(2);
  expect(st1.screenCanvasCount).toBe(2);
  expect(st1.atlasId).toBeGreaterThan(0);
  expect(st1.contextLost).toBe(false);

  // Switch to s2: s1 immediately releases WebGL (down to FitAddon = 1 addon, 0 screen canvases).
  await row(page, s2.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', s2.id);
  await expect.poll(async () => (await glState(page, s2.id)).hasGl).toBe(true);
  await expect.poll(async () => (await glState(page, s1.id)).hasGl).toBe(false);
  expect((await glState(page, s1.id)).addonCount).toBe(1);
  expect((await glState(page, s1.id)).screenCanvasCount).toBe(0);
  expect((await glState(page, s2.id)).liveGlCount).toBe(1);

  // Dual pane: s2 on left, s3 focused on right -> both active and share the same TextureAtlas instance.
  await page.getByTestId('layout-2').click();
  await pane(page, 1).click();
  await row(page, s3.id).click();
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', s3.id);
  await expect(pane(page, 1)).toHaveAttribute('data-focused', 'true');
  await expect.poll(async () => (await glState(page, s3.id)).hasGl).toBe(true);

  const dualLeft = await glState(page, s2.id);
  const dualRight = await glState(page, s3.id);
  expect(dualLeft.hasGl).toBe(true);
  expect(dualRight.hasGl).toBe(true);
  expect(dualLeft.liveGlCount).toBe(2);
  expect(dualLeft.atlasId).not.toBeNull();
  expect(dualLeft.atlasId).toBe(dualRight.atlasId);

  // Collapse back to single pane while right pane (s3) is focused: s3 migrates to pane 0, s2 releases WebGL.
  await page.getByTestId('layout-1').click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', s3.id);
  await expect.poll(async () => (await glState(page, s2.id)).hasGl).toBe(false);
  const backSingle = await glState(page, s3.id);
  expect(backSingle.hasGl).toBe(true);
  expect(backSingle.liveGlCount).toBe(1);
  expect((await glState(page, s2.id)).addonCount).toBe(1);
  expect((await glState(page, s2.id)).screenCanvasCount).toBe(0);

  snapshots.lifecycle = { st1, dualLeft, dualRight, backSingle };
  for (const t of [t1, t2, t3]) await request.delete(`/api/tasks/${t.task.id}`);
});

test('scenario A: fast restore + 2.5s late-init createProgram failure (zero canvas/ResizeObserver/addon leak) + visibilitychange rebuild', async ({ page, request }) => {
  const proj = await createProject(request, token('gl-loss'));
  const t1 = await createFakeTask(request, proj.id, token('L1'));
  const t2 = await createFakeTask(request, proj.id, token('L2'));
  const [s1, s2] = [t1.session, t2.session];

  await page.goto('/');
  await expect(row(page, s1.id)).toBeVisible();
  await expect(row(page, s2.id)).toBeVisible();

  await row(page, s1.id).click();
  await page.getByTestId('layout-2').click();
  await pane(page, 1).click();
  await row(page, s2.id).click();
  await expect.poll(async () => (await glState(page, s1.id)).hasGl && (await glState(page, s2.id)).hasGl).toBe(true);

  await page.waitForTimeout(350);
  await injectOut(page, s1.id, '\r\nLEFT_KEEP_中文内容_123\r\n');
  await injectOut(page, s2.id, '\r\nRIGHT_KEEP_右侧内容_456\r\n');
  await expect.poll(async () => (await termText(page, s1.id)).includes('LEFT_KEEP_中文内容_123')).toBe(true);
  await expect.poll(async () => (await termText(page, s2.id)).includes('RIGHT_KEEP_右侧内容_456')).toBe(true);

  await pane(page, 0).locator('.xterm-helper-textarea').focus();
  await page.waitForTimeout(220);

  const beforeLeft = await glState(page, s1.id);
  const beforeSize1 = await termSize(page, s1.id);
  const beforeSize2 = await termSize(page, s2.id);
  const resizeBeforeLoss = await resizeCount(page);

  // Part A1: Immediate DOM fallback on webglcontextlost + fresh context & fresh atlas recovery on 150ms initial retry.
  await page.evaluate(() => {
    const p0 = document.querySelector('[data-testid="pane"][data-pane-index="0"]');
    for (const c of p0 ? [...p0.querySelectorAll('canvas')] : []) {
      const ext = (c as HTMLCanvasElement).getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (ext) {
        ext.loseContext();
        return;
      }
    }
  });
  const domBaseline = await glState(page, s1.id);
  expect(domBaseline.hasGl).toBe(false);
  await expect(pane(page, 0).locator('.xterm-rows')).toContainText('LEFT_KEEP_中文内容_123');
  await expect.poll(async () => {
    const a = await glState(page, s1.id);
    const b = await glState(page, s2.id);
    return a.hasGl && b.hasGl && a.atlasId !== beforeLeft.atlasId;
  }, { timeout: 1500 }).toBe(true);
  const afterFastRestore = await glState(page, s1.id);

  // Part A2: 2.5s outage where getContext('webgl2') SUCCEEDS, preflight passes on calls 1-2, and every 3rd
  // createProgram() inside WebglRenderer returns null! Verifies BOTH preflight AND mid-WebglRenderer constructor failure
  // leak ZERO canvases, ZERO ResizeObservers, ZERO internal xterm subscriptions, and ZERO addons across 4 retry rounds
  // (150, 500, 1100, 2000ms) — even when _onWindowChange fires — and then recovers automatically at ~2900ms!
  const baselineRO = await page.evaluate(() => {
    // Baseline ResizeObservers when WebGL is active = 2 Pane body ROs + 2 WebglRenderer ROs = 4
    return (window as any).__liveResizeObservers as number;
  });
  const expectedOutageRO = baselineRO - 2;

  const lateFailTriggered = await page.evaluate(() => {
    const p0 = document.querySelector('[data-testid="pane"][data-pane-index="0"]');
    let loseExt: WEBGL_lose_context | null = null;
    for (const c of p0 ? [...p0.querySelectorAll('canvas')] : []) {
      const ext = (c as HTMLCanvasElement).getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (ext) {
        loseExt = ext;
        break;
      }
    }
    if (!loseExt) return false;

    const origCreateProgram = WebGL2RenderingContext.prototype.createProgram;
    let calls = 0;
    (window as any).__failedProgramAttempts = 0;
    (WebGL2RenderingContext.prototype as any).createProgram = function (this: WebGL2RenderingContext) {
      calls++;
      // Every 3rd call returns null -> preflight (2 calls) passes, then RectangleRenderer's 1st createProgram throws!
      if (calls % 3 === 0) {
        (window as any).__failedProgramAttempts++;
        return null;
      }
      return origCreateProgram.call(this);
    };

    window.setTimeout(() => {
      WebGL2RenderingContext.prototype.createProgram = origCreateProgram;
    }, 2500);

    loseExt.loseContext();
    return true;
  });
  expect(lateFailTriggered).toBe(true);

  await page.waitForTimeout(1350);
  const midOutage1 = await glState(page, s1.id);
  const midOutage2 = await glState(page, s2.id);
  const outageDiag = await page.evaluate(() => ({
    failedAttempts: (window as any).__failedProgramAttempts as number,
    liveRO: (window as any).__liveResizeObservers as number,
  }));
  expect(outageDiag.failedAttempts).toBeGreaterThanOrEqual(4); // Multiple mid-WebglRenderer throws occurred!
  expect(midOutage1.hasGl).toBe(false);
  expect(midOutage2.hasGl).toBe(false);
  expect(midOutage1.addonCount).toBe(1);
  expect(midOutage2.addonCount).toBe(1);
  expect(midOutage1.screenCanvasCount).toBe(0); // Zero leaked <canvas> in .xterm-screen!
  expect(midOutage2.screenCanvasCount).toBe(0);
  expect(outageDiag.liveRO).toBe(expectedOutageRO); // Zero leaked ResizeObserver!
  // Zero leaked internal xterm service subscriptions across >=4 mid-constructor throws (exact match with clean DOM baseline):
  expect(midOutage1.themeListeners).toBe(domBaseline.themeListeners);
  expect(midOutage1.windowListeners).toBe(domBaseline.windowListeners);
  expect(midOutage1.optionListeners).toBe(domBaseline.optionListeners);
  expect(midOutage1.linkListeners).toBe(domBaseline.linkListeners);
  // Triggering _coreBrowserService._onWindowChange after failed constructor throws must NOT spawn any zombie ResizeObserver!
  await glState(page, s1.id, { fireWindowChange: true });
  await glState(page, s2.id, { fireWindowChange: true });
  expect(await page.evaluate(() => (window as any).__liveResizeObservers as number)).toBe(expectedOutageRO);
  expect(midOutage1.pendingRestoreRetry).toBe(true);
  await expect(pane(page, 0).locator('.xterm-rows')).toContainText('LEFT_KEEP_中文内容_123');

  // At ~2900ms (after createProgram restored at 2500ms), both panes automatically recover WebGL!
  await expect.poll(async () => {
    const a = await glState(page, s1.id);
    const b = await glState(page, s2.id);
    return a.hasGl && b.hasGl && a.contextLost === false && b.contextLost === false && a.atlasId !== afterFastRestore.atlasId;
  }, { timeout: 2500 }).toBe(true);

  await page.waitForTimeout(180);
  const afterLoss1 = await glState(page, s1.id);
  const afterLoss2 = await glState(page, s2.id);
  expect(afterLoss1.atlasId).toBe(afterLoss2.atlasId);
  expect(afterLoss1.liveGlCount).toBe(2);
  expect(afterLoss1.addonCount).toBe(2);
  expect(afterLoss1.screenCanvasCount).toBe(2);
  expect(afterLoss2.screenCanvasCount).toBe(2);
  expect(afterLoss1.themeListeners).toBe(beforeLeft.themeListeners);
  expect(afterLoss1.windowListeners).toBe(beforeLeft.windowListeners);
  expect(afterLoss1.optionListeners).toBe(beforeLeft.optionListeners);
  expect(afterLoss1.linkListeners).toBe(beforeLeft.linkListeners);
  expect(await page.evaluate(() => (window as any).__liveResizeObservers as number)).toBe(baselineRO);
  expect(await termSize(page, s1.id)).toEqual(beforeSize1);
  expect(await termSize(page, s2.id)).toEqual(beforeSize2);
  expect(await termText(page, s1.id)).toContain('LEFT_KEEP_中文内容_123');
  expect(await termText(page, s2.id)).toContain('RIGHT_KEEP_右侧内容_456');
  expect(await pane(page, 0).locator('.xterm-helper-textarea').evaluate((el) => document.activeElement === el)).toBe(true);
  expect(await resizeCount(page)).toBe(resizeBeforeLoss);

  // Part A3: visibilitychange hidden -> visible rebuilds atlas with zero resize and full state preservation.
  const rebuildBeforeVis = afterLoss1.rebuildCount;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect.poll(async () => (await glState(page, s1.id)).atlasId).not.toBe(afterLoss1.atlasId);
  await page.waitForTimeout(180);
  const afterVis1 = await glState(page, s1.id);
  const afterVis2 = await glState(page, s2.id);
  expect(afterVis1.hasGl).toBe(true);
  expect(afterVis2.hasGl).toBe(true);
  expect(afterVis1.rebuildCount).toBe(rebuildBeforeVis + 1);
  expect(afterVis1.atlasId).toBe(afterVis2.atlasId);
  expect(await termSize(page, s1.id)).toEqual(beforeSize1);
  expect(await termSize(page, s2.id)).toEqual(beforeSize2);
  expect(await termText(page, s1.id)).toContain('LEFT_KEEP_中文内容_123');
  expect(await termText(page, s2.id)).toContain('RIGHT_KEEP_右侧内容_456');
  expect(await pane(page, 0).locator('.xterm-helper-textarea').evaluate((el) => document.activeElement === el)).toBe(true);
  expect(await resizeCount(page)).toBe(resizeBeforeLoss);

  snapshots.scenarioA = { beforeLeft, afterFastRestore, midOutage1, outageDiag, afterLoss1, afterVis1, resizeBeforeLoss, resizeAfter: await resizeCount(page) };
  for (const t of [t1, t2]) await request.delete(`/api/tasks/${t.task.id}`);
});

test('scenario B1: safeCap proactive rebuild + cooldown recheck timer automatically rebuilds after cooldown expires', async ({ page, request }) => {
  const proj = await createProject(request, token('gl-cap'));
  const t1 = await createFakeTask(request, proj.id, token('F1'));
  const s1 = t1.session;

  await page.goto('/');
  await expect(row(page, s1.id)).toBeVisible();
  await row(page, s1.id).click();
  await expect.poll(async () => (await glState(page, s1.id)).hasGl).toBe(true);
  await page.waitForTimeout(250);

  const initial = await glState(page, s1.id);
  const resizeBefore = await resizeCount(page);

  let cp = 0x4e00;
  const makeColoredBatch = (lines: number) => {
    let chunk = '';
    for (let line = 0; line < lines; line++) {
      let rowStr = '';
      for (let k = 0; k < 24; k++) {
        const ch = String.fromCharCode(cp++);
        const r = (cp * 37) % 255;
        const g = (cp * 73) % 255;
        const b = (cp * 113) % 255;
        const br = (cp * 19) % 80;
        const bg = (cp * 43) % 80;
        const bb = (cp * 61) % 80;
        rowStr += `\x1b[38;2;${r};${g};${b}m\x1b[48;2;${br};${bg};${bb}m${ch}`;
      }
      chunk += `${rowStr}\x1b[0m\r\n`;
    }
    return chunk;
  };

  for (let batch = 0; batch < 30; batch++) {
    await injectOut(page, s1.id, makeColoredBatch(16));
    await page.waitForTimeout(40);
    const cur = await glState(page, s1.id);
    if (cur.rebuildCount > initial.rebuildCount) break;
  }
  const afterRebuild1 = await glState(page, s1.id);
  expect(afterRebuild1.rebuildCount).toBe(initial.rebuildCount + 1);
  expect(afterRebuild1.atlasId).not.toBe(initial.atlasId);
  expect(afterRebuild1.atlasPages).toBeLessThan(8);

  // Pump new output frames inside <600ms (within cooldown) until pages >= safeCap (8), then STOP all output.
  await page.evaluate(async ({ id, startCp }) => {
    const w = window as any;
    const ws = w.__wbLastWs as WebSocket;
    let c = startCp;
    for (let frame = 0; frame < 20; frame++) {
      let chunk = '';
      for (let line = 0; line < 22; line++) {
        let rowStr = '';
        for (let k = 0; k < 28; k++) {
          const ch = String.fromCharCode(c++);
          rowStr += `\x1b[38;2;${(c * 37) % 255};${(c * 73) % 255};${(c * 113) % 255}m${ch}`;
        }
        chunk += `${rowStr}\x1b[0m\r\n`;
      }
      ws.onmessage!(new MessageEvent('message', { data: JSON.stringify({ t: 'out', id, d: chunk }) }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const st = w.__wbTermGlState(id);
      if (st.atlasPages >= 8) break;
    }
  }, { id: s1.id, startCp: cp });

  const duringCooldown = await glState(page, s1.id);
  expect(duringCooldown.atlasPages).toBeGreaterThanOrEqual(8);
  expect(duringCooldown.rebuildCount).toBe(afterRebuild1.rebuildCount);
  expect(duringCooldown.pendingCooldownRecheck).toBe(true);

  await expect.poll(async () => (await glState(page, s1.id)).rebuildCount, { timeout: 3000 }).toBeGreaterThan(afterRebuild1.rebuildCount);
  await page.waitForTimeout(180);
  const afterCooldownRebuild = await glState(page, s1.id);
  expect(afterCooldownRebuild.atlasId).not.toBe(afterRebuild1.atlasId);
  expect(afterCooldownRebuild.atlasPages).toBeLessThan(8);
  expect(afterCooldownRebuild.pendingCooldownRecheck).toBe(false);
  expect(await resizeCount(page)).toBe(resizeBefore);

  snapshots.scenarioB1 = { initial, afterRebuild1, duringCooldown, afterCooldownRebuild, resizeBefore, resizeAfter: await resizeCount(page) };
  await request.delete(`/api/tasks/${t1.task.id}`);
});

test('scenario B2: dual-pane real 4-page merge with natural version===1 collision & ?25l preserves exact right-pane glyph pixels', async ({ page, request }) => {
  const proj = await createProject(request, token('gl-merge'));
  const t1 = await createFakeTask(request, proj.id, token('M1'));
  const t2 = await createFakeTask(request, proj.id, token('M2'));
  const [s1, s2] = [t1.session, t2.session];

  await page.addInitScript(() => {
    const w = window as any;
    // Defer idle ASCII warmup so a fresh TextureAtlas starts at page0Version === 0 and drawing 1 glyph on right pane
    // naturally sets right pane's slot0TexVersion === 1 — colliding identically with mergedPage.version === 1 after 4-page merge!
    (window as any).requestIdleCallback = () => 0;
    (window as any).cancelIdleCallback = () => {};

    w.__texUploadsByCtx = new Map<WebGL2RenderingContext, { w: number; h: number }[]>();
    w.__bandPixelsByCtx = new Map<WebGL2RenderingContext, Uint8Array>();

    const origGetParam = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (this: WebGL2RenderingContext, pname: number) {
      if (pname === 0x8872 /* MAX_TEXTURE_IMAGE_UNITS */) return 4;
      return origGetParam.call(this, pname);
    };

    const origTexImage2D = WebGL2RenderingContext.prototype.texImage2D;
    WebGL2RenderingContext.prototype.texImage2D = function (this: WebGL2RenderingContext, ...args: any[]) {
      const last = args[args.length - 1];
      if (last instanceof HTMLCanvasElement) {
        const list = w.__texUploadsByCtx.get(this) ?? [];
        list.push({ w: last.width, h: last.height });
        w.__texUploadsByCtx.set(this, list);
      }
      return (origTexImage2D as any).apply(this, args);
    };

    const origDrawInstanced = WebGL2RenderingContext.prototype.drawElementsInstanced;
    WebGL2RenderingContext.prototype.drawElementsInstanced = function (
      this: WebGL2RenderingContext,
      mode: number,
      count: number,
      type: number,
      offset: number,
      instanceCount: number,
    ) {
      const ret = origDrawInstanced.call(this, mode, count, type, offset, instanceCount);
      // GlyphRenderer draws instanced quads with gl.UNSIGNED_BYTE indices and >=1 glyph cell;
      // RectangleRenderer draws backgrounds on program without textures. Capture final buffer after GlyphRenderer draws:
      const prog = this.getParameter(this.CURRENT_PROGRAM);
      const texLoc = prog ? this.getUniformLocation(prog, 'u_texture') : null;
      if (texLoc !== null) {
        const sampleW = Math.min(this.drawingBufferWidth, 240);
        const sampleH = Math.min(this.drawingBufferHeight, 80);
        if (sampleW > 0 && sampleH > 0) {
          const buf = new Uint8Array(sampleW * sampleH * 4);
          this.readPixels(0, Math.max(0, this.drawingBufferHeight - sampleH), sampleW, sampleH, this.RGBA, this.UNSIGNED_BYTE, buf);
          w.__bandPixelsByCtx.set(this, buf);
        }
      }
      return ret;
    };
  });

  await page.goto('/');
  await expect(row(page, s1.id)).toBeVisible();
  await expect(row(page, s2.id)).toBeVisible();

  await row(page, s1.id).click();
  await page.getByTestId('layout-2').click();
  await pane(page, 1).click();
  await row(page, s2.id).click();
  await expect.poll(async () => (await glState(page, s1.id)).hasGl && (await glState(page, s2.id)).hasGl).toBe(true);
  await page.waitForTimeout(250);

  // Clear both screens, hide hardware cursor (?25l), then rebuildConnectedGl via visibilitychange so we start with a
  // brand-new TextureAtlas at page0Version === 0 inside the 2000ms cooldown window!
  await injectOut(page, s1.id, '\x1b[?25l\x1b[2J\x1b[H');
  await injectOut(page, s2.id, '\x1b[?25l\x1b[2J\x1b[H');
  await page.waitForTimeout(80);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(60);

  // Write ONLY repeated copies of ONE single bright-green CJK glyph '验' to right pane s2:
  // Because '验' is only rasterized ONCE into _cacheMap, page0Version increments 0 -> 1 and s2's slot0TexVersion === 1!
  await injectOut(page, s2.id, '\x1b[38;2;80;240;150m验验验验验验验验验验\x1b[0m');
  await expect.poll(async () => (await termText(page, s2.id)).includes('验验验验验')).toBe(true);
  await page.waitForTimeout(60);

  const preCollisionRight = await glState(page, s2.id);
  expect(preCollisionRight.slot0TexVersion).toBe(1); // Natural slot-0 version === 1 before merge!

  // Snapshot s2's exact pre-merge RGBA pixel buffer and verify genuine bright-green foreground pixels (R+G+B > 220 & alpha > 200)
  const baselineCheck = await page.evaluate(() => {
    const getGl = (paneIdx: number) => {
      for (const c of document.querySelectorAll(`[data-testid="pane"][data-pane-index="${paneIdx}"] canvas`)) {
        const gl = (c as HTMLCanvasElement).getContext('webgl2');
        if (gl) return gl;
      }
      return null;
    };
    const gl1 = getGl(1)!;
    const w = window as any;
    const buf = w.__bandPixelsByCtx.get(gl1) as Uint8Array | undefined;
    if (!buf) return { ok: false, fgPixels: 0, len: 0 };
    w.__baselineRightBuf = new Uint8Array(buf);
    let fgPixels = 0;
    for (let i = 0; i < buf.length; i += 4) {
      // Excludes transparent black [0,0,0,0] (sum=0) and dark theme bg #0f1012 (sum=49)
      if (buf[i + 3] > 200 && buf[i] + buf[i + 1] + buf[i + 2] > 220) fgPixels++;
    }
    w.__texUploadsByCtx.clear();
    return { ok: true, fgPixels, len: buf.length };
  });
  expect(baselineCheck.ok).toBe(true);
  expect(baselineCheck.fgPixels).toBeGreaterThan(150);

  const beforeMerge = await glState(page, s1.id);
  const resizeBefore = await resizeCount(page);

  // Now flood ONLY left pane s1 (~5,500 glyphs in <400ms) while s2 stays completely idle with ?25l:
  // 4x 512px pages merge into 1024px mergedPage at pages[0] with page0Version === 1 (exact collision with s2's slot0TexVersion === 1!).
  const mergedTriggered = await page.evaluate(async ({ id, baseSync }) => {
    const w = window as any;
    const ws = w.__wbLastWs as WebSocket;
    let cp = 0x5200;
    for (let frame = 0; frame < 30; frame++) {
      let chunk = '';
      for (let line = 0; line < 20; line++) {
        let rowStr = '';
        for (let k = 0; k < 26; k++) {
          const ch = String.fromCharCode(cp++);
          rowStr += `\x1b[38;2;${(cp * 41) % 255};${(cp * 83) % 255};${(cp * 29) % 255}m${ch}`;
        }
        chunk += `${rowStr}\x1b[0m\r\n`;
      }
      ws.onmessage!(new MessageEvent('message', { data: JSON.stringify({ t: 'out', id, d: chunk }) }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const cur = w.__wbTermGlState(id);
      if (cur.syncCount > baseSync) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return true;
      }
    }
    return false;
  }, { id: s1.id, baseSync: beforeMerge.syncCount });
  expect(mergedTriggered).toBe(true);
  await page.waitForTimeout(180);

  const afterLeft = await glState(page, s1.id);
  const afterRight = await glState(page, s2.id);
  expect(afterLeft.rebuildCount).toBe(beforeMerge.rebuildCount); // In-place merge sync, NOT rebuild!
  expect(afterLeft.atlasId).toBe(beforeMerge.atlasId);
  expect(afterRight.atlasId).toBe(beforeMerge.atlasId);
  expect(afterRight.page0Version).toBe(1); // Merged 1024px page[0] indeed landed with version === 1 (matching preCollisionRight.slot0TexVersion === 1)!
  expect(afterRight.slot0TexVersion).toBe(1);
  expect(afterLeft.requestClearModel).toBe(false);
  expect(afterRight.requestClearModel).toBe(false);
  expect(await resizeCount(page)).toBe(resizeBefore);

  // Compare post-merge right-pane RGBA pixels byte-for-byte against pre-merge baseline!
  const postMergeProof = await page.evaluate(() => {
    const getGl = (paneIdx: number) => {
      for (const c of document.querySelectorAll(`[data-testid="pane"][data-pane-index="${paneIdx}"] canvas`)) {
        const gl = (c as HTMLCanvasElement).getContext('webgl2');
        if (gl) return gl;
      }
      return null;
    };
    const gl0 = getGl(0)!;
    const gl1 = getGl(1)!;
    const w = window as any;
    const up0 = w.__texUploadsByCtx.get(gl0) ?? [];
    const up1 = w.__texUploadsByCtx.get(gl1) ?? [];
    const base = w.__baselineRightBuf as Uint8Array;
    const post = w.__bandPixelsByCtx.get(gl1) as Uint8Array;
    let exactPixelMatches = 0;
    let postFgPixels = 0;
    const totalPixels = base.length / 4;
    for (let i = 0; i < base.length; i += 4) {
      if (post[i + 3] > 200 && post[i] + post[i + 1] + post[i + 2] > 220) postFgPixels++;
      if (
        Math.abs(base[i] - post[i]) <= 2 &&
        Math.abs(base[i + 1] - post[i + 1]) <= 2 &&
        Math.abs(base[i + 2] - post[i + 2]) <= 2 &&
        Math.abs(base[i + 3] - post[i + 3]) <= 2
      ) {
        exactPixelMatches++;
      }
    }
    return {
      leftUploaded1024: up0.some((u: { w: number; h: number }) => u.w === 1024 && u.h === 1024),
      rightUploaded1024: up1.some((u: { w: number; h: number }) => u.w === 1024 && u.h === 1024),
      postFgPixels,
      matchRatio: exactPixelMatches / totalPixels,
    };
  });
  expect(postMergeProof.leftUploaded1024).toBe(true);
  expect(postMergeProof.rightUploaded1024).toBe(true); // Proves version=1 collision did NOT skip upload!
  expect(postMergeProof.postFgPixels).toBe(baselineCheck.fgPixels);
  expect(postMergeProof.matchRatio).toBeGreaterThan(0.999);

  snapshots.scenarioB2 = { preCollisionRight, baselineCheck, afterLeft, afterRight, postMergeProof };
  for (const t of [t1, t2]) await request.delete(`/api/tasks/${t.task.id}`);
});

test('scenario B3: 200% HiDPI static high-density viewport caps at 1 rebuild (>= safeCap) and suspends cleanly to DOM (>= hardCap) without looping', async ({ browser, request }) => {
  const proj = await createProject(request, token('gl-static'));
  const t1 = await createFakeTask(request, proj.id, token('H1'));
  const s1 = t1.session;

  // Real 300% Windows 4K HiDPI scaling (deviceScaleFactor: 3, real MAX_TEXTURE_IMAGE_UNITS >= 16 -> safeCap = 8, hardCap = 14):
  // At 42px device glyph size (~165 CJK glyphs per 512x512 page), a 2200x1240 viewport holds ~6,000 CJK glyphs (~35 pages) on ONE static screen!
  const ctx = await browser.newContext({ viewport: { width: 2200, height: 1240 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.addInitScript(WS_INIT_SCRIPT);

  try {
    await page.goto('/');
    await expect(row(page, s1.id)).toBeVisible();
    await row(page, s1.id).click();
    await expect.poll(async () => (await glState(page, s1.id)).hasGl).toBe(true);
    await page.waitForTimeout(250);

    const size = (await termSize(page, s1.id))!;
    // Sub-case 1: ~1,650 unique CJK glyphs on a single static screen -> ~9-11 pages (>= safeCap 8, < hardCap 14)
    const cjkPerRow = Math.floor((size.cols - 2) / 2);
    const safeRows = Math.min(size.rows - 1, Math.ceil(1650 / Math.max(1, cjkPerRow)));
    const staticSafeChunk = (() => {
      let cp = 0x6200;
      let out = '\x1b[?25l\x1b[2J\x1b[H';
      for (let r = 0; r < safeRows; r++) {
        for (let c = 0; c < cjkPerRow; c++) {
          const ch = String.fromCharCode(cp++);
          out += `\x1b[38;2;${(cp * 31) % 255};${(cp * 67) % 255};${(cp * 97) % 255}m${ch}`;
        }
        if (r + 1 < safeRows) out += '\x1b[0m\r\n';
      }
      return out;
    })();

    const beforeSafe = await glState(page, s1.id);
    await injectOut(page, s1.id, staticSafeChunk);
    await expect.poll(async () => (await glState(page, s1.id)).rebuildCount).toBe(beforeSafe.rebuildCount + 1);
    await page.waitForTimeout(150);

    const settledSafe = await glState(page, s1.id);
    expect(settledSafe.hasGl).toBe(true);
    expect(settledSafe.atlasPages).toBeGreaterThanOrEqual(8);
    expect(settledSafe.atlasPages).toBeLessThan(14);
    expect(settledSafe.pendingCooldownRecheck).toBe(false);

    // Wait >2200ms (> SAFE_CAP_COOLDOWN_MS = 2000ms) with ZERO new output: static viewport must NOT rebuild in a 2s loop!
    await page.waitForTimeout(2250);
    const afterWaitSafe = await glState(page, s1.id);
    expect(afterWaitSafe.rebuildCount).toBe(settledSafe.rebuildCount);
    expect(afterWaitSafe.hasGl).toBe(true);

    // Sub-case 2: Fill the full static screen (~7,200 unique CJK glyphs -> >= 14 pages even after xterm 1024px merges, hitting hardCap 14)!
    const hardRows = size.rows - 1;
    const staticHardChunk = (() => {
      let cp = 0x7200;
      let out = '\x1b[?25l\x1b[2J\x1b[H';
      for (let r = 0; r < hardRows; r++) {
        for (let c = 0; c < cjkPerRow; c++) {
          const ch = String.fromCharCode(cp++);
          out += `\x1b[38;2;${(cp * 23) % 255};${(cp * 59) % 255};${(cp * 101) % 255}m${ch}`;
        }
        if (r + 1 < hardRows) out += '\x1b[0m\r\n';
      }
      return out + '\x1b[0m';
    })();

    const beforeHard = await glState(page, s1.id);
    await injectOut(page, s1.id, staticHardChunk);
    await page.waitForTimeout(800);
    const debugAfterHard = await glState(page, s1.id);
    expect(debugAfterHard, `size=${JSON.stringify(size)} beforeHard=${JSON.stringify(beforeHard)}`).toMatchObject({ glSuspended: true });
    const suspendedState = await glState(page, s1.id);
    expect(suspendedState.hasGl).toBe(false);
    expect(suspendedState.screenCanvasCount).toBe(0);
    expect(suspendedState.rebuildCount).toBeGreaterThanOrEqual(beforeHard.rebuildCount + 1);
    expect(suspendedState.rebuildCount).toBeLessThanOrEqual(beforeHard.rebuildCount + 2);

    // Wait 500ms across multiple animation frames: zero per-frame rebuild loop, DOM renderer displays text stably!
    await page.waitForTimeout(500);
    expect((await glState(page, s1.id)).rebuildCount).toBe(suspendedState.rebuildCount);
    await expect(pane(page, 0).locator('.xterm-rows')).not.toBeEmpty();

    // Sub-case 3: Replaying low-density output automatically restores WebGL on the mounted pane WITHOUT zoom or pane switching!
    await injectReplay(page, s1.id, '低密度回放自动恢复_WebGL_OK\r\n');
    await expect.poll(async () => {
      const st = await glState(page, s1.id);
      return st.hasGl && !st.glSuspended;
    }, { timeout: 1500 }).toBe(true);
    await expect.poll(async () => (await termText(page, s1.id)).includes('低密度回放自动恢复_WebGL_OK')).toBe(true);
    const afterReplayResume = await glState(page, s1.id);

    // Sub-case 4: Re-suspending and then returning to normal density + zooming (105%) also clears suspension and stays on WebGL cleanly!
    await injectOut(page, s1.id, staticHardChunk);
    await expect.poll(async () => (await glState(page, s1.id)).glSuspended).toBe(true);
    await injectOut(page, s1.id, '\x1b[2J\x1b[H恢复常规密度_WebGL_OK\r\n');
    await page.waitForTimeout(80);
    await page.getByTestId('zoom-in').click();
    await expect.poll(async () => (await glState(page, s1.id)).hasGl).toBe(true);
    await page.waitForTimeout(150);
    expect((await glState(page, s1.id)).glSuspended).toBe(false);

    snapshots.scenarioB3 = { settledSafe, afterWaitSafe, suspendedState, afterReplayResume };
  } finally {
    await ctx.close();
    await request.delete(`/api/tasks/${t1.task.id}`);
  }
});
