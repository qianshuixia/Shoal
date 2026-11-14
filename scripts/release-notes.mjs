// Builds the GitHub Release markdown body by prepending the matching version section from CHANGELOG.md
// (or non-release commit subjects since the previous v* tag if CHANGELOG.md has no entry for that version).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLER_NOTES = `Windows x64 installer for the Shoal desktop app, a local workbench that runs Claude Code, Codex CLI and Antigravity CLI (\`agy\`) sessions side by side.

The installer is self-contained. It brings its own Node runtime, the Shoal server and the web UI, so running Shoal needs no clone of this repo and no pre-installed Node or npm. The agent CLIs are separate: you install them yourself.

Before you start:
1. Install the agent CLIs you want and sign in to them. Shoal looks for Claude Code and Codex CLI installed globally with npm (\`npm install -g @anthropic-ai/claude-code\`, \`npm install -g @openai/codex\`; these two need Node.js and npm on your system) and for agy in its default location (\`%LOCALAPPDATA%\\agy\\bin\\agy.exe\`).
2. Run the installer and start Shoal from the Start menu.

Notes:
- The installer is not code-signed, so Windows SmartScreen may warn: choose More info -> Run anyway.
- Shoal listens only on 127.0.0.1:47800. State and server logs are stored under LOCALAPPDATA: Shoal by default, or agent-workbench for older installs until Shoal has its own state.json. Your code stays in your own folders.
- Closing the window or choosing Quit in the tray asks for confirmation if agents are running, then stops the server and its agent sessions; you can resume them from the panel later.
- Shoal is an independent open-source project and is not affiliated with or endorsed by Anthropic, OpenAI or Google.`;

export function extractChangelogSection(changelogText, version) {
  const lines = changelogText.split(/\r?\n/);
  const targetA = `## [${version}]`;
  const targetB = `## [v${version}]`;
  const targetC = `## ${version}`;
  const targetD = `## v${version}`;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (start === -1) {
      if (
        trimmed === targetA || trimmed.startsWith(`${targetA} `) ||
        trimmed === targetB || trimmed.startsWith(`${targetB} `) ||
        trimmed === targetC || trimmed.startsWith(`${targetC} `) ||
        trimmed === targetD || trimmed.startsWith(`${targetD} `)
      ) {
        start = i + 1;
      }
    } else if (/^##\s+\[?v?\d+\.\d+\.\d+/.test(trimmed)) {
      end = i;
      break;
    }
  }
  if (start === -1) return '';
  return lines
    .slice(start, end)
    .join('\n')
    .replace(/\n---\s*$/, '')
    .trim();
}

export function buildReleaseBody({ version, changelogText = '', fallbackCommits = '' }) {
  const fromChangelog = changelogText ? extractChangelogSection(changelogText, version) : '';
  const summary = fromChangelog || fallbackCommits.trim();
  if (!summary) return INSTALLER_NOTES;
  return `## 更新日志 (v${version})\n\n${summary}\n\n---\n\n${INSTALLER_NOTES}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const outPath = process.argv[2];
  const version = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const changelogFile = path.join(root, 'CHANGELOG.md');
  const changelogText = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : '';
  let fallbackCommits = '';
  if (!extractChangelogSection(changelogText, version)) {
    try {
      const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && t !== `v${version}`);
      const range = tags[0] ? `${tags[0]}..HEAD` : 'HEAD';
      fallbackCommits = execFileSync(
        'git',
        ['log', range, '--grep=^chore(release):', '--invert-grep', '--pretty=format:- %s'],
        { cwd: root, encoding: 'utf8' },
      );
    } catch {
      fallbackCommits = '';
    }
  }
  const body = buildReleaseBody({ version, changelogText, fallbackCommits });
  if (outPath) fs.writeFileSync(outPath, body, 'utf8');
  else process.stdout.write(body);
}
