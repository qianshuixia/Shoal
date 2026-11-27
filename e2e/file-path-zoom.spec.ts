// Explicit file paths in StreamView (UserBubble + StreamMarkdown) -> auto-open Inspector,
// auto-expand & scroll file tree to the located file (including hidden `.studio` dirs & freshly created files),
// and interactive in-panel image zoom/pan + fullscreen lightbox (+ Markdown preview image zoom).
//
// Known failure modes -> pass criteria:
// 1. Bare Windows paths embedded in Chinese bullet lists stay plain text or lose `\.` in Markdown
//    -> Both UserBubble and AssistantMessage render clickable `[data-testid="sv-path-link"]` preserving `\.studio` and `_`.
// 2. Clicking a file link opens Inspector without scrolling the tree or re-opening a collapsed sidebar
//    -> `insp-side` opens, ancestor dirs expand, target `tree-entry` has `.on` and sits inside `.tree-scroll`'s viewport.
// 3. Images in Inspector stay stuck at `max-width: 100%` with no zoom/pan/lightbox
//    -> `+` / `1:1` / wheel / drag-pan resize & pan the image cleanly; `全屏` opens `[data-testid="image-lightbox"]` with Esc close.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, token } from './helpers.ts';

const OUT = path.resolve('.tmp/file-path-zoom');
fs.mkdirSync(OUT, { recursive: true });

// Minimal valid RGB PNG encoder (checkerboard + accent border) so zoom & 1:1 inspection are visually unmistakable.
function makeTestPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const kind = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])), 0);
    return Buffer.concat([len, kind, data, crc]);
  };

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const p = rowOff + 1 + x * 3;
      const border = x < 16 || y < 16 || x >= width - 16 || y >= height - 16;
      const grid = ((x >> 5) + (y >> 5)) & 1;
      raw[p] = border ? 235 : grid ? rgb[0] : Math.max(0, rgb[0] - 42);
      raw[p + 1] = border ? 90 : grid ? rgb[1] : Math.max(0, rgb[1] - 42);
      raw[p + 2] = border ? 90 : grid ? rgb[2] : Math.max(0, rgb[2] - 42);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.beforeEach(async ({ request }) => removeAllTasks(request));

test('clickable explicit file paths in chat open Inspector, locate in scrolled tree, and zoom/pan images inline & fullscreen', async ({ page, request }) => {
  await page.setViewportSize({ width: 1380, height: 880 });
  const projName = token('pathzoom');
  const project = await createProject(request, projName);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project.path });

  // Create >150 sibling directories (crossing TREE_VIRTUAL_THRESHOLD = 150) so the Inspector tree runs in virtualized
  // mode and must genuinely scroll to locate `zz_generated/final_shot.png`.
  for (let i = 1; i <= 160; i++) {
    fs.mkdirSync(path.join(project.path, `pad-dir-${String(i).padStart(3, '0')}`));
  }

  const masterImg = path.join(project.path, 'assets', 'concepts', 'sop_stage1_sword_aligned', 'kfA_aligned_2K.png');
  const previewImg = path.join(project.path, '.studio', 'inpaint', 'inp_mwxgjvfg_727825', 'box_preview.png');
  const docFile = path.join(project.path, 'docs', 'guide.md');
  fs.mkdirSync(path.dirname(masterImg), { recursive: true });
  fs.mkdirSync(path.dirname(previewImg), { recursive: true });
  fs.mkdirSync(path.dirname(docFile), { recursive: true });
  fs.writeFileSync(masterImg, makeTestPng(1400, 900, [76, 188, 174]));
  fs.writeFileSync(previewImg, makeTestPng(1200, 800, [110, 148, 224]));
  fs.writeFileSync(docFile, '# 预览说明\n\n![剑光母版](../assets/concepts/sop_stage1_sword_aligned/kfA_aligned_2K.png)\n', 'utf8');

  await page.goto('/');
  const { session } = await createFakeTask(request, project.id, '路径点击与图片放大验收', 'hello');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await expectStatus(page, sid, 'needs_you');

  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();

  // Send a multi-line message mirroring the exact Chinese bullet list with Windows absolute paths & `.studio`.
  const msg = [
    '系统已自动为你切好以下文件（请直接读取）：',
    `- 原图（2K 母版）：${masterImg}`,
    `- 带红框标注预览图（一眼看清要改哪里）：${previewImg}`,
    `- 说明文档：\`${docFile}\``,
  ].join('\n');
  await sv.getByTestId('sv-input').fill(msg);
  await sv.getByTestId('sv-input').press('Enter');
  await expectStatus(page, sid, 'needs_you');

  // 1. UserBubble turns all 3 explicit paths into clickable inline links.
  const userBubble = sv.getByTestId('sv-user').last();
  const userLinks = userBubble.getByTestId('sv-path-link');
  await expect(userLinks).toHaveCount(3, { timeout: 10_000 });
  await expect(userLinks.nth(0)).toHaveAttribute('data-file-path', masterImg);
  await expect(userLinks.nth(1)).toHaveAttribute('data-file-path', previewImg);
  await expect(userLinks.nth(2)).toHaveAttribute('data-file-path', docFile);

  // 2. AssistantMessage (StreamMarkdown) ALSO preserves `.studio` backslash & underscores and makes all 3 paths clickable.
  const asstMsg = sv.getByTestId('sv-assistant').last();
  const asstLinks = asstMsg.getByTestId('sv-path-link');
  await expect(asstLinks).toHaveCount(3, { timeout: 10_000 });
  await expect(asstLinks.nth(1)).toContainText('.studio');
  await expect(asstLinks.nth(1)).toHaveAttribute('data-file-path', previewImg);

  // 3. Click the `.studio/.../box_preview.png` link in UserBubble -> opens Inspector, expands & locates in tree, previews image.
  await userLinks.nth(1).click();
  await expect(page.locator('main.main')).toHaveClass(/layout-inspect/);
  const insp = page.getByTestId('inspector');
  await expect(insp.getByTestId('insp-filepath')).toHaveText('.studio/inpaint/inp_mwxgjvfg_727825/box_preview.png');

  const locatedEntry = insp.locator('[data-testid="tree-entry"][data-path=".studio/inpaint/inp_mwxgjvfg_727825/box_preview.png"]');
  await expect(locatedEntry).toBeVisible({ timeout: 5_000 });
  await expect(locatedEntry).toHaveClass(/\bon\b/);

  // Wait for image load and verify dimensions + Fit zoom state.
  const imgPreview = insp.getByTestId('image-preview');
  const imgEl = imgPreview.locator('img');
  await expect.poll(() => imgEl.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1200);
  await expect(imgPreview).toContainText('1200 × 800');
  const fitWidth = (await imgEl.boundingBox())!.width;
  const stageBox = (await imgPreview.getByTestId('img-stage').boundingBox())!;
  expect(fitWidth).toBeLessThanOrEqual(stageBox.width);
  await page.screenshot({ path: path.join(OUT, '01-located-and-fit.png') });

  // 4. In-panel image zoom: `+` enlarges, `1:1` reaches native 1200px width, wheel zooms further, drag pans, `适应` resets.
  await expect(imgPreview.getByTestId('img-zoom-fit')).toHaveClass(/\bon\b/);
  await imgPreview.getByTestId('img-zoom-in').click();
  const afterPlusWidth = (await imgEl.boundingBox())!.width;
  expect(afterPlusWidth).toBeGreaterThan(fitWidth + 10);

  await imgPreview.getByTestId('img-zoom-actual').click();
  await expect(imgPreview.getByTestId('img-zoom-pct')).toHaveText('100%');
  await expect(imgPreview.getByTestId('img-zoom-actual')).toHaveClass(/\bon\b/);
  await expect.poll(async () => (await imgEl.boundingBox())!.width).toBeCloseTo(1200, 0);

  // Drag-pan the 1:1 zoomed image inside the stage and verify transform updates.
  const beforeTransform = await imgEl.evaluate((el) => getComputedStyle(el).transform);
  const cx = stageBox.x + stageBox.width / 2;
  const cy = stageBox.y + stageBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 80, cy - 50, { steps: 6 });
  await page.mouse.up();
  const afterDragTransform = await imgEl.evaluate((el) => getComputedStyle(el).transform);
  expect(afterDragTransform).not.toBe(beforeTransform);

  // Mouse wheel zooms smoothly without Ctrl.
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -160);
  const pctAfterWheel = parseInt((await imgPreview.getByTestId('img-zoom-pct').textContent()) ?? '0', 10);
  expect(pctAfterWheel).toBeGreaterThan(100);
  await expect(imgPreview.getByTestId('img-zoom-actual')).not.toHaveClass(/\bon\b/);
  await page.waitForTimeout(160);
  await page.screenshot({ path: path.join(OUT, '02-zoomed-in-panel.png') });

  await imgPreview.getByTestId('img-zoom-fit').click();
  await expect.poll(async () => (await imgEl.boundingBox())!.width).toBeLessThanOrEqual(stageBox.width);

  // 5. Fullscreen lightbox zoom + Esc close.
  await imgPreview.getByTestId('img-zoom-fullscreen').click();
  const lightbox = page.getByTestId('image-lightbox');
  await expect(lightbox).toBeVisible();
  const lbPctBefore = parseInt((await lightbox.getByTestId('lightbox-img-zoom-pct').textContent()) ?? '0', 10);
  await page.keyboard.press('=');
  const lbPctAfter = parseInt((await lightbox.getByTestId('lightbox-img-zoom-pct').textContent()) ?? '0', 10);
  expect(lbPctAfter).toBeGreaterThan(lbPctBefore);
  await page.waitForTimeout(160);
  await page.screenshot({ path: path.join(OUT, '03-fullscreen-lightbox.png') });
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // 6. Collapse sidebar, then click `kfA_aligned_2K.png` from AssistantMessage -> sidebar auto-reopens & tree locates row!
  await insp.getByTestId('insp-toggle-side').click();
  await expect(insp.getByTestId('insp-side')).toHaveCount(0);
  await asstLinks.nth(0).click();
  await expect(insp.getByTestId('insp-side')).toBeVisible();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('assets/concepts/sop_stage1_sword_aligned/kfA_aligned_2K.png');
  const masterEntry = insp.locator('[data-testid="tree-entry"][data-path="assets/concepts/sop_stage1_sword_aligned/kfA_aligned_2K.png"]');
  await expect(masterEntry).toBeVisible({ timeout: 5_000 });
  await expect(masterEntry).toHaveClass(/\bon\b/);
  const treeInView = await masterEntry.evaluate((el) => {
    const scroller = el.closest('.tree-scroll');
    if (!scroller) return false;
    const er = el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return er.top >= sr.top - 2 && er.bottom <= sr.bottom + 2;
  });
  expect(treeInView).toBe(true);

  // 6b. Drag-selecting text across a file path link must NOT trigger navigation in Inspector.
  const dragBox = (await asstLinks.nth(1).boundingBox())!;
  await page.mouse.move(dragBox.x + 4, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + Math.min(80, dragBox.width - 4), dragBox.y + dragBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(insp.getByTestId('insp-filepath')).toHaveText('assets/concepts/sop_stage1_sword_aligned/kfA_aligned_2K.png');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  // 7. Click inline-code Markdown doc link -> opens Markdown preview, and clicking embedded image opens zoomable lightbox.
  await asstLinks.nth(2).click();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('docs/guide.md');
  const mdImg = insp.getByTestId('markdown-preview').locator('img.md-img');
  await expect(mdImg).toBeVisible({ timeout: 5_000 });
  await mdImg.click();
  await expect(page.getByTestId('image-lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('image-lightbox')).toHaveCount(0);

  // 8. Freshly generated file in a brand-new folder below 35 sibling dirs (and with different Windows casing)
  //    is refreshed into the tree, scrolled into view (`scrollTop > 0`), highlighted, and previewed.
  const freshImg = path.join(project.path, 'zz_generated', 'final_shot.png');
  fs.mkdirSync(path.dirname(freshImg), { recursive: true });
  fs.writeFileSync(freshImg, makeTestPng(960, 540, [215, 165, 86]));
  const linkPath = process.platform === 'win32'
    ? path.join(project.path, 'ZZ_GENERATED', 'FINAL_SHOT.PNG')
    : freshImg;
  await sv.getByTestId('sv-input').fill(`新生成图片：${linkPath}`);
  await sv.getByTestId('sv-input').press('Enter');
  await expect(sv.getByTestId('sv-assistant').last()).toContainText('FINAL_SHOT.PNG', { timeout: 10_000 }).catch(async () => {
    await expect(sv.getByTestId('sv-assistant').last()).toContainText('final_shot.png', { timeout: 10_000 });
  });
  await expectStatus(page, sid, 'needs_you');
  const freshLink = sv.getByTestId('sv-user').last().getByTestId('sv-path-link').first();
  await expect(freshLink).toBeVisible();
  await freshLink.click();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('zz_generated/final_shot.png');
  const freshEntry = insp.locator('[data-testid="tree-entry"][data-path="zz_generated/final_shot.png"]');
  await expect(freshEntry).toBeVisible({ timeout: 5_000 });
  await expect(freshEntry).toHaveClass(/\bon\b/);
  const freshTreeCheck = await freshEntry.evaluate((el) => {
    const scroller = el.closest('.tree-scroll');
    if (!scroller) return { scrollTop: 0, inView: false };
    const er = el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      inView: er.top >= sr.top - 2 && er.bottom <= sr.bottom + 2,
    };
  });
  expect(freshTreeCheck.scrollTop).toBeGreaterThan(0);
  expect(freshTreeCheck.inView).toBe(true);
  await page.screenshot({ path: path.join(OUT, '04-scrolled-fresh-dir.png') });

  // 8b. Repeat locate in virtualized tree after collapsing sidebar & scrolling back to top -> re-opens & scrolls back into view.
  await insp.locator('.tree-scroll').evaluate((el) => { el.scrollTop = 0; });
  await insp.getByTestId('insp-toggle-side').click();
  await expect(insp.getByTestId('insp-side')).toHaveCount(0);
  await freshLink.click();
  await expect(insp.getByTestId('insp-side')).toBeVisible();
  await expect(freshEntry).toBeVisible({ timeout: 5_000 });
  const repeatCheck = await freshEntry.evaluate((el) => {
    const scroller = el.closest('.tree-scroll');
    if (!scroller) return { scrollTop: 0, inView: false };
    const er = el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      inView: er.top >= sr.top - 2 && er.bottom <= sr.bottom + 2,
    };
  });
  expect(repeatCheck.scrollTop).toBeGreaterThan(0);
  expect(repeatCheck.inView).toBe(true);

  // 9. Unsaved draft guard:
  //    (a) Editing `docs/guide.md` in the Files tab -> clicking another file path and dismissing confirm preserves draft.
  const docLink = sv.getByTestId('sv-path-link').filter({ hasText: 'guide.md' }).first();
  await docLink.click();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('docs/guide.md');
  await insp.getByTestId('md-mode-source').click();
  const cmContent = insp.locator('.cm-content');
  await expect(cmContent).toBeVisible();
  await cmContent.click();
  await page.keyboard.type('UNSAVED_DRAFT_GUARD ');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  page.once('dialog', (d) => void d.dismiss());
  await freshLink.click();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('docs/guide.md');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  await expect(cmContent).toContainText('UNSAVED_DRAFT_GUARD');
  page.once('dialog', (d) => void d.accept());
  await freshLink.click();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('zz_generated/final_shot.png');

  //    (b) Editing `docs/guide.md` in the Changes tab -> clicking the SAME file's path link and dismissing confirm
  //        stays on Changes tab and keeps the unsaved edit intact.
  await insp.getByTestId('insp-tab-changes').click();
  const guideChange = insp.locator('[data-testid="change-entry"][data-path="docs/guide.md"]');
  await expect(guideChange).toBeVisible({ timeout: 5_000 });
  await guideChange.click();
  await insp.getByTestId('mode-edit').click();
  await expect(cmContent).toBeVisible();
  await cmContent.click();
  await page.keyboard.type('CHANGES_DRAFT_KEEP ');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  page.once('dialog', (d) => void d.dismiss());
  await docLink.click();
  await expect(insp.getByTestId('insp-tab-changes')).toHaveAttribute('aria-selected', 'true');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  await expect(cmContent).toContainText('CHANGES_DRAFT_KEEP');
  page.once('dialog', (d) => void d.accept());
  await freshLink.click();
  await expect(insp.getByTestId('insp-tab-files')).toHaveAttribute('aria-selected', 'true');
  await expect(insp.getByTestId('insp-filepath')).toHaveText('zz_generated/final_shot.png');

  // 10. Privacy mode blurs ImageLightbox title inside the document.body portal and omits leaking native tooltip.
  await page.getByTestId('privacy-toggle').click();
  await insp.getByTestId('image-preview').getByTestId('img-zoom-fullscreen').click();
  const privLightbox = page.getByTestId('image-lightbox');
  await expect(privLightbox).toBeVisible();
  const lbTitle = privLightbox.locator('.sv-lightbox-title');
  expect(await lbTitle.getAttribute('title')).toBeNull();
  expect(await lbTitle.evaluate((el) => getComputedStyle(el).filter)).toContain('blur(');
  await page.keyboard.press('Escape');
  await expect(privLightbox).toHaveCount(0);
  await page.getByTestId('privacy-toggle').click();

  await request.delete(`/api/projects/${project.id}`);
});
