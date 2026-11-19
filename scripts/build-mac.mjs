// macOS disk images from any machine: a .dmg can only be built on a Mac, so this has GitHub's macOS runners build it
// (.github/workflows/mac-build.yml) and downloads the result.
//   node scripts/build-mac.mjs [arm64|x64|all]     default: arm64 (Apple silicon)
// Builds the commit at HEAD, which must already be on GitHub; uncommitted changes are not in the build. A run of the
// workflow for that commit that is still going, or finished with the images still downloadable, is reused; otherwise a new
// one is started. Needs the GitHub CLI (gh) signed in with an account that may run workflows here: the repo owner's if gh
// knows it, else gh's active account, or GH_TOKEN. Nothing is committed, pushed, tagged or published. The version is the
// one in tauri.conf.json at that commit.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'mac-ci');
const WORKFLOW = 'mac-build.yml';
const TARGETS = {
  arm64: ['aarch64-apple-darwin'],
  x64: ['x86_64-apple-darwin'],
  all: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
};

const log = msg => console.log(`[build-mac] ${msg}`);
const fail = msg => {
  console.error(`[build-mac] ${msg}`);
  process.exit(1);
};

const which = process.argv[2] ?? 'arm64';
if (!Object.hasOwn(TARGETS, which)) {
  console.error('Usage: build-mac [arm64|x64|all]   (arm64: Apple silicon, x64: Intel)');
  process.exit(2);
}
const artifacts = TARGETS[which].map(t => `shoal-${t}`);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch === 'HEAD') fail('HEAD is detached: check out a branch first');
const sha = git('rev-parse', 'HEAD');
const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
if (remote !== sha) {
  fail(remote
    ? `origin/${branch} is at ${remote.slice(0, 7)} but HEAD is ${sha.slice(0, 7)}: push (or pull) first, the runners build what is on GitHub`
    : `${branch} is not on GitHub: push it first, the runners build what is on GitHub`);
}
const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length;
if (dirty) log(`warning: ${dirty} uncommitted change(s) are not in this build, it is ${sha.slice(0, 7)} as pushed`);

const repo = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'));
if (!repo) fail('origin is not a GitHub repository');
const REPO = `${repo[1]}/${repo[2]}`;

const env = { ...process.env };
const gh = (...args) => {
  try {
    return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') fail('GitHub CLI not found: install gh (https://cli.github.com) and run gh auth login');
    throw new Error(`gh ${args.join(' ')}: ${(err.stderr || err.message).trim()}`);
  }
};
// Prefer the repo owner's account when gh is signed in to several, without switching gh's active account.
if (!env.GH_TOKEN) {
  try { env.GH_TOKEN = gh('auth', 'token', '--user', repo[1]).trim(); } catch { delete env.GH_TOKEN; }
}

// Matched by the workflow's name: filtering with --workflow fails while the file is not on the default branch yet.
const WORKFLOW_NAME = /^name:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(ROOT, '.github', 'workflows', WORKFLOW), 'utf8'))[1];
const runs = () => JSON.parse(gh('run', 'list', '-R', REPO, '--commit', sha, '--limit', '50',
  '--json', 'databaseId,status,conclusion,event,url,workflowName')).filter(r => r.workflowName === WORKFLOW_NAME);
// Names of the run's artifacts that can still be downloaded (they expire).
const artifactsOf = id => new Set(JSON.parse(gh('api', `repos/${REPO}/actions/runs/${id}/artifacts?per_page=100`))
  .artifacts.filter(a => !a.expired).map(a => a.name));

try {
  const all = runs();
  let run = all.find(r => r.status !== 'completed');
  if (run) log(`following the run already going for ${sha.slice(0, 7)}: ${run.url}`);
  else {
    run = all.find(r => { const have = artifactsOf(r.databaseId); return artifacts.every(a => have.has(a)); });
    if (run) log(`${sha.slice(0, 7)} was already built: ${run.url}`);
  }
  if (!run) {
    const before = new Set(all.map(r => r.databaseId));
    log(`starting ${WORKFLOW} on ${branch} (${sha.slice(0, 7)})`);
    // GitHub starts a workflow by hand only once its file is on the default branch. Until then the run comes from the
    // push to a branch other than main, which may take a moment to show up.
    let byHand = true;
    try {
      gh('workflow', 'run', WORKFLOW, '-R', REPO, '--ref', branch);
    } catch (err) {
      if (!/not found on the default branch|HTTP 404/.test(err.message)) throw err;
      byHand = false;
      log(`${WORKFLOW} is not on the default branch yet, so it cannot be started by hand: looking for the run the push started`);
    }
    for (let i = 0; i < (byHand ? 40 : 20) && !run; i++) {
      await new Promise(r => setTimeout(r, 3000));
      run = runs().find(r => !before.has(r.databaseId) && (!byHand || r.event === 'workflow_dispatch'));
    }
    if (!run && !byHand) {
      fail(`no ${WORKFLOW} run for ${sha.slice(0, 7)} with the images in it: push a new commit to a branch other than main, or get ${WORKFLOW} onto main so it can be started by hand`);
    }
    if (!run) fail(`the run did not show up within two minutes: look in the Actions tab of https://github.com/${REPO}`);
    log(`${byHand ? 'started' : 'found'}: ${run.url}`);
  }

  if (run.status !== 'completed') {
    log('waiting for the macOS runners (tests and both builds usually take 15-30 minutes; Ctrl+C stops waiting, not the run)');
    spawnSync('gh', ['run', 'watch', String(run.databaseId), '-R', REPO, '--interval', '20'], { cwd: ROOT, env, stdio: 'inherit' });
  }
  const done = JSON.parse(gh('run', 'view', String(run.databaseId), '-R', REPO, '--json', 'status,conclusion,jobs'));
  if (done.status !== 'completed') fail(`the run is still ${done.status}: run this again to pick it up, ${run.url}`);
  if (done.conclusion !== 'success') {
    const failed = done.jobs.filter(j => j.conclusion !== 'success').map(j => `${j.name}: ${j.conclusion}`);
    log(`warning: the run ended ${done.conclusion} (${failed.join('; ')}), see ${run.url}`);
  }
  const have = artifactsOf(run.databaseId);
  const missing = artifacts.filter(a => !have.has(a));
  if (missing.length) fail(`no ${missing.join(', ')} from this run: that build failed, see ${run.url}`);

  // Into a fresh folder first, so an image from an earlier download is never mistaken for this one.
  const tmp = path.join(OUT, `.download-${run.databaseId}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const a of artifacts) gh('run', 'download', String(run.databaseId), '-R', REPO, '-n', a, '-D', tmp);
  const images = fs.readdirSync(tmp).filter(f => f.endsWith('.dmg'));
  if (!images.length) fail(`the download had no .dmg in it: ${tmp}`);
  for (const f of images) fs.renameSync(path.join(tmp, f), path.join(OUT, f));
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of images) log(`${path.join(OUT, f)} (${(fs.statSync(path.join(OUT, f)).size / 1024 / 1024).toFixed(1)} MB)`);
  log('on the Mac: open the .dmg and drag Shoal into Applications. It is not notarized, so before the first launch run');
  log('  xattr -cr /Applications/Shoal.app');
  log('or open it once, then click Open Anyway in System Settings > Privacy & Security.');
} catch (err) {
  fail(err.message);
}
