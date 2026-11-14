import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpReleaseVersion } from './bump-release-version.mjs';
import { buildReleaseBody, extractChangelogSection, INSTALLER_NOTES } from './release-notes.mjs';

const fixture = version => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-release-'));
  const dir = path.join(root, 'desktop', 'src-tauri');
  fs.mkdirSync(dir, { recursive: true });
  const contents = {
    'tauri.conf.json': JSON.stringify({ productName: 'Shoal', version }, null, 2) + '\n',
    'Cargo.toml': '[package]\nname = "shoal"\nversion = "' + version + '"\n\n[dependencies]\nserde_json = "1"\n',
    'Cargo.lock': 'version = 4\n\n[[package]]\nname = "dependency"\nversion = "9.0.0"\n\n[[package]]\nname = "shoal"\nversion = "' + version + '"\ndependencies = ["dependency"]\n',
  };
  for (const [name, content] of Object.entries(contents)) fs.writeFileSync(path.join(dir, name), content);
  // Keep the tiny fixture as reproducible evidence; never delete an unrelated temp directory.
  return { root, dir, contents };
};

test('successive main pushes advance all three files and preserve dependency versions', () => {
  const { root, dir } = fixture('0.1.1');
  assert.deepEqual(bumpReleaseVersion(root, 'v0.1.0\nv0.1.1\n'), { current: '0.1.1', next: '0.1.2' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tauri.conf.json'), 'utf8')).version, '0.1.2');
  assert.match(fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'), /version = "0\.1\.2"/);
  const lock = fs.readFileSync(path.join(dir, 'Cargo.lock'), 'utf8');
  assert.match(lock, /name = "shoal"\nversion = "0\.1\.2"/);
  assert.match(lock, /name = "dependency"\nversion = "9\.0\.0"/);
  assert.deepEqual(bumpReleaseVersion(root, 'v0.1.2\n'), { current: '0.1.2', next: '0.1.3' });
});

test('newer remote tags win using numeric semver order', () => {
  const { root } = fixture('0.1.1');
  assert.equal(bumpReleaseVersion(root, 'v0.9.20\nv0.10.1\nv0.2.99\nnightly\nv0.11.0-rc.1\n').next, '0.10.2');
});

test('mismatched version files fail before changing any file', () => {
  const { root, dir } = fixture('0.1.1');
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "shoal"\nversion = "0.2.0"\n');
  const before = ['tauri.conf.json', 'Cargo.toml', 'Cargo.lock'].map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.throws(() => bumpReleaseVersion(root, 'v0.1.1'), /disagree/);
  assert.deepEqual(['tauri.conf.json', 'Cargo.toml', 'Cargo.lock'].map(file => fs.readFileSync(path.join(dir, file), 'utf8')), before);
});

test('missing or malformed versions fail before writing', () => {
  const { root, dir, contents } = fixture('invalid');
  assert.throws(() => bumpReleaseVersion(root, ''), /Invalid desktop version/);
  for (const [file, content] of Object.entries(contents)) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), content);
  const valid = fixture('0.1.1');
  fs.writeFileSync(path.join(valid.dir, 'Cargo.lock'), 'version = 4\n');
  assert.throws(() => bumpReleaseVersion(valid.root, ''), /Missing desktop version/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(valid.dir, 'tauri.conf.json'), 'utf8')).version, '0.1.1');
});

test('release notes extract matching CHANGELOG section (including v0.1.10) or fall back cleanly', () => {
  const realChangelog = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  const v0110 = extractChangelogSection(realChangelog, '0.1.10');
  assert.match(v0110, /项目内会话按最新活跃置顶/);
  assert.match(v0110, /桌面端服务崩溃自愈重连与一键原位续接/);
  assert.doesNotMatch(v0110, /0\.1\.9/);

  const full = buildReleaseBody({ version: '0.1.10', changelogText: realChangelog });
  assert.match(full, /^## 更新日志 \(v0\.1\.10\)/);
  assert.ok(full.endsWith(INSTALLER_NOTES));

  const fallback = buildReleaseBody({ version: '9.9.9', changelogText: realChangelog, fallbackCommits: '- 修复某问题\n' });
  assert.match(fallback, /## 更新日志 \(v9\.9\.9\)\n\n- 修复某问题/);

  assert.equal(buildReleaseBody({ version: '9.9.9' }), INSTALLER_NOTES);
});
