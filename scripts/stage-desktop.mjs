// Stages everything the desktop installer ships in desktop/bundle (tauri.conf.json bundles it as resources/app):
// a pinned Node runtime, the server, the built web UI and the production node_modules. The installed app runs
// only from this copy, so it needs no checkout, no system Node and no npm on the user's machine.
// Run by `tauri build` (beforeBuildCommand), which passes the target in TAURI_ENV_TARGET_TRIPLE; safe to run by hand:
//   node scripts/stage-desktop.mjs [--target <triple>]     default: this machine
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NODE_VERSION = 'v24.22.2';
// From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt; bump the version and every hash together.
// `file` is the download under https://nodejs.org/dist/<version>/, `member` the runtime inside it (for archives).
const TARGETS = {
  'win32-x64': {
    file: 'win-x64/node.exe',
    sha256: '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9',
    bin: 'node.exe',
  },
  'darwin-arm64': {
    file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
    member: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
    bin: 'node',
  },
  'darwin-x64': {
    file: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
    member: `node-${NODE_VERSION}-darwin-x64/bin/node`,
    bin: 'node',
  },
};
const TRIPLES = { 'x86_64-pc-windows-msvc': 'win32-x64', 'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64' };

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'desktop', 'bundle');
const CACHE = path.join(ROOT, '.tmp', 'node-runtime');

const run = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: 'inherit' });
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const argIdx = process.argv.indexOf('--target');
if (argIdx > 0 && !process.argv[argIdx + 1]) throw new Error(`--target needs a triple: ${Object.keys(TRIPLES).join(', ')}`);
const triple = argIdx > 0 ? process.argv[argIdx + 1] : process.env.TAURI_ENV_TARGET_TRIPLE;
const key = triple ? TRIPLES[triple] : `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) throw new Error(`no pinned Node runtime for ${triple ?? key}; supported: ${Object.keys(TRIPLES).join(', ')}`);
const [targetPlatform] = key.split('-');
console.log(`[stage] target ${key}`);

async function download() {
  const name = path.basename(target.file);
  const file = path.join(CACHE, `${NODE_VERSION}-${key}-${name}`);
  if (fs.existsSync(file) && sha256(file) === target.sha256) return file;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${target.file}`;
  console.log(`[stage] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const tmp = `${file}.download`;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const got = sha256(tmp);
  if (got !== target.sha256) {
    fs.rmSync(tmp);
    throw new Error(`${name} checksum mismatch: expected ${target.sha256}, got ${got}`);
  }
  fs.renameSync(tmp, file);
  return file;
}

// The runtime itself: the downloaded file, or the one member of the archive. Extracted afresh from the checked archive
// on every run, so a copy cut short by an earlier interrupted run is never bundled.
async function nodeRuntime() {
  const file = await download();
  if (!target.member) return file;
  const dir = `${file}.d`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Relative paths only: GNU tar (Git for Windows) reads `C:` in an archive path as a remote host.
  execFileSync('tar', ['-xzf', path.relative(dir, file).replaceAll('\\', '/'), target.member], { cwd: dir, stdio: 'inherit' });
  return path.join(dir, target.member);
}

const node = await nodeRuntime();

console.log('[stage] building web/dist');
run('npm run build');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const copy = (rel, filter) => fs.cpSync(path.join(ROOT, rel), path.join(OUT, rel), { recursive: true, filter });
copy('server', src => !src.endsWith('.test.ts'));
copy('shared');
copy('hooks');
copy('web/dist');
copy('package.json');
copy('package-lock.json');
const bundledNode = path.join(OUT, target.bin);
fs.copyFileSync(node, bundledNode);
fs.chmodSync(bundledNode, 0o755);

// No install scripts: node-pty loads its N-API prebuild, and nothing gets compiled against the build machine.
console.log('[stage] installing production dependencies');
run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', OUT);
// node-pty ships sources and every platform's prebuilds with debug symbols; keep the target's binaries only.
const pty = path.join(OUT, 'node_modules', 'node-pty');
const prebuilds = path.join(pty, 'prebuilds');
for (const d of ['src', 'deps', 'third_party']) fs.rmSync(path.join(pty, d), { recursive: true, force: true });
if (!fs.existsSync(path.join(prebuilds, key))) throw new Error(`node-pty has no prebuild for ${key}`);
for (const d of fs.readdirSync(prebuilds)) if (d !== key) fs.rmSync(path.join(prebuilds, d), { recursive: true });
for (const f of fs.readdirSync(path.join(prebuilds, key))) if (f.endsWith('.pdb')) fs.rmSync(path.join(prebuilds, key, f));
// node-pty execs spawn-helper for every PTY on macOS; npm only sets its mode in an install script, which is skipped.
if (targetPlatform === 'darwin') fs.chmodSync(path.join(prebuilds, key, 'spawn-helper'), 0o755);

// Smoke check: the runtime dependencies, native node-pty included, load under the bundled Node, and on macOS a PTY
// starts (that runs spawn-helper). Only possible when this machine can run the target.
if (key === `${process.platform}-${process.arch}`) {
  const posixPty = "const p=require('node-pty').spawn('/bin/echo',['pty-ok'],{});let o='';p.onData(d=>o+=d);"
    + "p.onExit(e=>{if(e.exitCode!==0||!o.includes('pty-ok')){console.error('pty smoke failed',e,JSON.stringify(o));process.exit(1)}})";
  const script = "require('node-pty'); require('ws'); require('@xterm/headless');" + (targetPlatform === 'win32' ? '' : posixPty);
  execFileSync(bundledNode, ['-e', script], { cwd: OUT, stdio: 'inherit' });
} else {
  console.log(`[stage] skipped the smoke check: this machine (${process.platform}-${process.arch}) cannot run ${key}`);
}
console.log(`[stage] done: ${OUT}`);
