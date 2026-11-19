// One-step desktop build: bumps the app version, builds the installer, and puts the old version back if the build fails.
//   node scripts/build-desktop.mjs [patch|minor|major|<x.y.z>|keep]     default: patch; keep rebuilds the current version
// The version is written to three files that must agree: tauri.conf.json (the release workflow takes its tag from it),
// Cargo.toml and Cargo.lock. Nothing is committed or tagged here.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TAURI = path.join(ROOT, 'desktop', 'src-tauri');
const SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_FILES = [
  ['tauri.conf.json', /^(\s*"version":\s*")[^"]+(")/m],
  // The first line that starts with `version` is the one under [package].
  ['Cargo.toml', /^(version = ")[^"]+(")/m],
  ['Cargo.lock', /^(name = "shoal"\r?\nversion = ")[^"]+(")/m],
].map(([name, re]) => ({ file: path.join(TAURI, name), re }));

const log = msg => console.log(`[build-desktop] ${msg}`);

const how = process.argv[2] ?? 'patch';
const current = JSON.parse(fs.readFileSync(VERSION_FILES[0].file, 'utf8')).version;
if (!SEMVER.test(current)) throw new Error(`tauri.conf.json version is not x.y.z: ${current}`);
const [major, minor, patch] = current.split('.').map(Number);
const steps = { keep: current, patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` };
const next = Object.hasOwn(steps, how) ? steps[how] : how;
if (!SEMVER.test(next)) {
  console.error(`Usage: build-desktop [patch|minor|major|<x.y.z>|keep]   (current version: ${current})`);
  process.exit(2);
}

const originals = VERSION_FILES.map(({ file }) => fs.readFileSync(file, 'utf8'));
VERSION_FILES.forEach(({ file, re }, i) => {
  if (!re.test(originals[i])) throw new Error(`no version line found in ${file}`);
});
const restore = () => VERSION_FILES.forEach(({ file }, i) => fs.writeFileSync(file, originals[i]));

// Ctrl+C also reaches the build, which then fails; this listener only keeps Node alive long enough to restore the files.
process.on('SIGINT', () => {});

// Tauri's names: the NSIS setup on Windows, the disk image on macOS (built for this machine's architecture).
const BUNDLE = path.join(TAURI, 'target', 'release', 'bundle');
const installer = process.platform === 'darwin'
  ? path.join(BUNDLE, 'dmg', `Shoal_${next}_${process.arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`)
  : path.join(BUNDLE, 'nsis', `Shoal_${next}_x64-setup.exe`);
const started = Date.now();
log(next === current ? `rebuilding Shoal ${current}` : `Shoal ${current} -> ${next}`);
try {
  VERSION_FILES.forEach(({ file, re }, i) => fs.writeFileSync(file, originals[i].replace(re, (_, head, tail) => head + next + tail)));
  execSync('npm run desktop:build', { cwd: ROOT, stdio: 'inherit' });
  // An installer left over from an earlier build of the same version does not count.
  if (!fs.existsSync(installer) || fs.statSync(installer).mtimeMs < started) throw new Error(`the build did not produce ${installer}`);
} catch (err) {
  restore();
  console.error(`[build-desktop] failed: ${err.message}`);
  if (next !== current) console.error(`[build-desktop] version restored to ${current}`);
  process.exit(1);
}

log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${installer} (${(fs.statSync(installer).size / 1024 / 1024).toFixed(1)} MB)`);
if (next !== current) log(`version ${next} written to ${VERSION_FILES.map(({ file }) => path.relative(ROOT, file)).join(', ')} (not committed)`);
