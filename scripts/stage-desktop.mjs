// Stages everything the desktop installer ships in desktop/bundle (tauri.conf.json bundles it as resources\app):
// a pinned Node runtime, the server, the built web UI and the production node_modules. The installed app runs
// only from this copy, so it needs no checkout, no system Node and no npm on the user's machine.
// Run by `tauri build` (beforeBuildCommand); safe to run by hand: node scripts/stage-desktop.mjs
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NODE_VERSION = 'v24.22.2';
// From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt (win-x64/node.exe); bump both together.
const NODE_SHA256 = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'desktop', 'bundle');
const CACHE = path.join(ROOT, '.tmp', 'node-runtime');

const run = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: 'inherit' });
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function nodeExe() {
  const file = path.join(CACHE, `node-${NODE_VERSION}-win-x64.exe`);
  if (fs.existsSync(file) && sha256(file) === NODE_SHA256) return file;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
  console.log(`[stage] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const tmp = `${file}.download`;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const got = sha256(tmp);
  if (got !== NODE_SHA256) {
    fs.rmSync(tmp);
    throw new Error(`node.exe checksum mismatch: expected ${NODE_SHA256}, got ${got}`);
  }
  fs.renameSync(tmp, file);
  return file;
}

const node = await nodeExe();

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
fs.copyFileSync(node, path.join(OUT, 'node.exe'));

// No install scripts: node-pty loads its N-API prebuild, and nothing gets compiled against the build machine.
console.log('[stage] installing production dependencies');
run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', OUT);
// node-pty ships sources and every platform's prebuilds with debug symbols; keep the win32-x64 binaries only.
const pty = path.join(OUT, 'node_modules', 'node-pty');
for (const d of ['src', 'deps', 'third_party']) fs.rmSync(path.join(pty, d), { recursive: true, force: true });
for (const d of fs.readdirSync(path.join(pty, 'prebuilds'))) if (d !== 'win32-x64') fs.rmSync(path.join(pty, 'prebuilds', d), { recursive: true });
for (const f of fs.readdirSync(path.join(pty, 'prebuilds', 'win32-x64'))) if (f.endsWith('.pdb')) fs.rmSync(path.join(pty, 'prebuilds', 'win32-x64', f));

// Smoke check: the runtime dependencies, native node-pty included, load under the bundled Node.
execSync(`"${path.join(OUT, 'node.exe')}" -e "require('node-pty'); require('ws'); require('@xterm/headless')"`, { cwd: OUT, stdio: 'inherit' });
console.log(`[stage] done: ${OUT}`);
