# Shoal

English | [简体中文](README.zh-CN.md)

A local workbench for running Claude Code, Codex CLI and Antigravity CLI (`agy`) side by side on Windows. One web page (or the Tauri desktop app) hosts their native interactive sessions (node-pty + ConPTY), color-codes tasks, and uses hooks to tell whether each session is working or waiting for you. Requirements and design: [docs/v1-spec.en.md](docs/v1-spec.en.md) ([简体中文](docs/v1-spec.md)).

> [!WARNING]
> All three CLIs start with full permissions (approval prompts skipped; Codex with its sandbox off), so agents can edit files and run commands without asking. Only use Shoal in project directories you trust; see "Permissions" below.

> [!NOTE]
> The UI is Chinese-only for now. UI labels below are given in English with the original Chinese in brackets, e.g. Awaiting review (「待验收」), so you can find them on screen.

Progress: M3 (switching agents and forwarding). When an agent finishes a turn, its last reply becomes a result card and the task moves to Awaiting review (「待验收」); you can write feedback to keep it going, or approve it. When a CLI runs out of quota, or you want someone else on the task, you can hand it to another CLI, which receives an automatically compiled handoff card; result cards can be forwarded to other tasks. Projects, tasks, sessions and cards persist in `<stateDir>/state.json`; after a server restart, old tasks show as Exited (「已退出」) and can be resumed by hand.

## Running

Requirements: Windows, Node 24 (runs `.ts` directly), and the CLIs you want to use, installed and signed in. The workbench path must not contain spaces (agy's hook command cannot be quoted).

```sh
npm install
npm run build
npm start            # opens http://127.0.0.1:47800
```

One-click start / stop: double-click `start.cmd` or `stop.cmd` in the repo root, or run in PowerShell:

```powershell
scripts\workbench.ps1 start|stop|restart|status [-Port <n>] [-Force] [-NoBrowser]
```

- `start`: runs `npm install` if `node_modules` is missing, rebuilds the frontend if its sources are newer than `web/dist`, then starts the server in the background in a separate hidden console and opens the browser once it is ready (`-NoBrowser` skips that). If the server is already running it only reports that and does not restart. Closing the window you started it from does not affect the server.
- `stop`: ends the server together with the agent processes it started. If agent sessions are still running it asks first (`-Force` skips the prompt); you can resume them from the panel later.
- `status`: shows the PID, start time and number of running sessions; exits with code 3 when not running.
- Logs: `<stateDir>\server.log` and `server.err.log`; the previous run's are kept as `server.prev.log` and `server.err.prev.log`, so the reason for a crash survives a restart. If the port is taken by another program, the error names it.

Desktop app (Tauri 2 shell in `desktop/`): opens the workbench in a WebView2 window. The installer is self-contained: it carries its own Node runtime (pinned in `scripts/stage-desktop.mjs`), the server, the built web UI and the production `node_modules`, so the machine needs no clone, Node or npm. Only the agent CLIs you want (Claude Code, Codex CLI, agy) have to be installed and signed in.

```sh
npm run desktop:build   # needs Rust; produces desktop\src-tauri\target\release\bundle\nsis\Shoal_<version>_x64-setup.exe
build-desktop.cmd       # the same build with a version bump first: patch by default, or minor / major / x.y.z / keep
```

`build-desktop.cmd` (or `node scripts/build-desktop.mjs`) writes the new version to `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, builds, and opens the installer folder; if the build fails it puts the old version back. It does not commit or tag.

The build first runs `scripts/stage-desktop.mjs`, which downloads the pinned `node.exe` (checked against its SHA-256), builds `web/dist` and stages everything in `desktop/bundle` (installed as `resources\app`). Run it once by hand before `npm run desktop:dev` or `cargo check`.

Prebuilt installers are on the [Releases](https://github.com/qianshuixia/Shoal/releases) page. The installer is not code-signed, so SmartScreen may warn (More info -> Run anyway).

- On launch, if the server is not running the shell starts the bundled `node.exe server/main.ts` in the background (on failure the window shows the reason and a Retry button); if it is already running it connects directly. The port is also read from `WORKBENCH_PORT`, and the state directory follows the same rules as the server (below). Inherited `NODE_OPTIONS` and `NODE_PATH` are dropped.
- Closing the window or choosing Quit in the tray stops the server too (whether the shell or `start` launched it). If agents are still running it asks first; Quit all (「全部退出」) follows the same path as `Ctrl+C` on the server, and you can resume the sessions from the panel later. If the shell crashes or is killed, the server and agents keep running. The tray menu also has Show, Open in browser and Reload. Launching again brings the existing window forward.
- `Ctrl+W`, `Ctrl+F`, `Ctrl+R`, `F5`, `Ctrl+P` and similar keys go to the page and the terminal instead of being caught by the browser; use Reload in the tray to refresh. Web links in the terminal open in the default browser.
- Hooks of sessions started by the desktop app run on the bundled `node.exe`, so they work without Node on `PATH`. agy needs a hook path without spaces: if the install path has one (e.g. a user name with a space) and the drive has no 8.3 short names, agy is disabled. Settings stored in browser local storage, such as zoom, collapsed projects and privacy mode, are not shared with Chrome.

- `--port <n>` or `WORKBENCH_PORT` changes the port; `WORKBENCH_STATE_DIR` changes the state directory (default `%LOCALAPPDATA%\Shoal`; while that has no `state.json` but `%LOCALAPPDATA%\agent-workbench` from before the rename exists, the old one keeps being used; it holds the hook config and `events.jsonl`, which moves to `events.1.jsonl` once it passes 10 MB).
- The server only listens on `127.0.0.1` and checks Host and Origin; hook callbacks use a token generated randomly at each start.
- Frontend development: run the server with `npm start` (not `node --watch`, since a restart kills every running agent); with `WORKBENCH_DEV=1`, `npm run dev:web` (Vite, port 5173) is allowed.
- Project, task and session metadata is written to `<stateDir>/state.json`; after a server restart old tasks show as Exited and are not resumed automatically (to avoid burning quota all at once). A corrupt file is renamed to `state.json.corrupt-<timestamp>` and the server starts from an empty state.

Every push to `main`, including documentation changes, queues a Windows desktop release. CI advances the patch version past the source version and existing release tags, writes it to `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, and commits it back to `main`. It then builds the installer and publishes the Release from that commit. The automatic version commit does not trigger another build.

## Usage

- New project (「新建项目」): enter a name and an existing directory (or click Browse… (「浏览…」) to pick one on this machine).
- Removing a project: hover the project name and click the trash icon to the left of `+`. After you confirm, the project and all its tasks (archived ones included) are removed from the workbench and running sessions are ended; the project directory, CLI conversation logs and token stats are kept (marked Deleted (「已删除」) in the stats). Tasks and result cards in the workbench cannot be restored; you can add the same directory again with New project.
- Three ways to create a task:
  - `+` to the right of a project: pick an agent and it starts right away, no dialog; the agent you last used in that project is listed first.
  - `Alt+N`: creates a task right away in the project of the focused session, with the agent you used last.
  - New task (「新建任务」) at the top of the sidebar: the full dialog, where you choose the project and agent and can write the initial request.
- Titles: if left empty, a task with a request takes its first line; a task without one starts as "New task N" (「新任务 N」), and the first thing you send in the terminal (except commands starting with `/`) becomes its title. Rename with the pencil button on the task row (shown on hover) or next to the panel title, or double-click the title (Enter saves, Esc cancels); a title you changed by hand is never replaced automatically.
- Settings: the sliders icon at the far right of the top bar. It has one option for now, 「用 AI 自动起任务标题」 (AI task titles; off by default, stored by the workbench server, so it applies to every window); hover the `?` next to it for the details. When it is on, the first request still gives the task its first-line title at once, and in the background the task's own CLI runs one short headless call (Claude on Haiku; Codex and Antigravity on their default model at the lowest reasoning effort) that writes a shorter, more descriptive title. This uses a little of that agent's quota and is not counted in the token statistics. A title you typed or changed is never replaced, and a failed call or one over 60 seconds keeps the first-line title.
- Pasting images: `Ctrl+V` or `Alt+V` pastes an image from the clipboard (the CLI reads the system clipboard itself). Files copied in Explorer (videos, documents and so on) paste as their full paths with `Ctrl+V`, quoted if they contain spaces and separated by spaces (same as Windows Terminal). Dropping an image file saves it to `<stateDir>\attachments\` and pastes the path (claude and codex treat it as an image attachment; agy only gets the path text). Claude Code's image paste key is `chat:imagePaste` (default `alt+v`); if you changed that binding, pasting images stops working.
- Links in the terminal: file links open in VS Code (with a line number, at that line; images, PDFs and web pages open in the default program; programs and shortcuts are only selected in Explorer, never run). Web links open in a new tab. Set the `WORKBENCH_EDITOR` environment variable to use another editor exe.
- Copy on select: drag to select, double-click a word or triple-click a line in the terminal, and the text is copied to the system clipboard when you release the mouse (like Windows Terminal's copyOnSelect); a single click copies nothing. When the CLI has mouse mode on, hold `Shift` while dragging; without `Shift` the CLI does its own selection, and text it sends back via OSC 52 is written to the clipboard as well.
- Clicking with the mouse: Claude Code's fullscreen mode (`/tui fullscreen`, or `"tui": "fullscreen"` in settings) turns on mouse mode, so option menus can be clicked and the wheel goes to Claude. Claude counts "the process went away within 10 seconds of a fullscreen start" as a crash, and after two of those that version turns fullscreen off by itself (`fullscreenAutoDisabled` appears in `~/.claude.json`), after which clicks stop working; run `/tui fullscreen` in Claude once to get it back. When the workbench deletes or archives a Claude task that just started, or stops normally, it waits until the process is 10 seconds old before ending it; `stop`/`restart` kill it outright, though, so a freshly started Claude still gets one count.
- Click a project name to collapse or expand it; the state is saved in this browser. A collapsed project shows how many tasks need you and how many await review (「N 个在等你」「N 待验收」) next to its name, and jumping there with ``Alt+` `` expands it.
- Active / All (「活跃 / 全部」) at the top of the sidebar: Active hides exited tasks (those awaiting review stay) and ends each project with "N more exited" (「另有 N 个已退出」), which switches back to All. The choice is saved in this browser; All is the default.
- Search: `Alt+K` or the magnifier button at the top of the sidebar filters tasks by title or project name; `↑`/`↓` to move, `Enter` to open, `Esc` to close. Running tasks come first; picking an archived task restores it and opens it.
- Auto-archive: an approved task whose session has exited moves to 「已归档」 after 7 days without change (checked when the server starts, then hourly). Set `WORKBENCH_AUTO_ARCHIVE_DAYS` to change the number of days, `0` to turn it off.
- Drag a project name (the whole row) to reorder projects in the sidebar: drop on the top half of a row to go before it, the bottom half to go after. The order is saved in this browser; new projects go last.
- Privacy mode: the Privacy (「隐私」) button in the top bar blurs project names, task titles, paths and review summaries (not the terminal), and hides tooltips that would show them, so screenshots are safe to share; the setting is saved in this browser.
- With two panes, the folder tag in each pane title shows that pane's project, and tasks currently on screen are marked Left (「左」) or Right (「右」) in the sidebar. Drag a task row onto a pane to open it there (dropping a task that is showing in the other pane swaps the two).
- The left edge of a task row is a state mark: solid amber dot = needs you, breathing blue dot = working, hollow ring = awaiting review (light) / ready (dim), check = approved, small gray dot = exited or archived. A task shown in a pane also has a thin bar in its task color next to the mark. The row ends with its CLI's icon in its brand colors (Claude Code / Codex / Antigravity). Icons come from [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons) (MIT).
- Zoom scales the whole UI and the terminal font (80%–150%, 5% per step): `Ctrl+wheel` anywhere, `Ctrl+=` / `Ctrl+-`, and `Ctrl+0` to reset to 100%; or the `−` / `+` at the right of the top bar (scroll over them, click the percentage to reset). With a terminal focused, `Ctrl+-` goes to the CLI instead (it is `^_`, Claude Code's undo). The setting is saved in this browser.
- Token stats: the Token stats (「Token 统计」) tab in the top bar (the Workbench (「工作台」) tab switches back; terminals stay connected). Data comes from the three CLIs' own conversation logs and only covers sessions started by the workbench; it is summarized hourly into `<stateDir>/usage.json` and kept after tasks are deleted.
  - Range: today / last 7 days (default) / last 30 days / all / custom dates (local time, end date included).
  - Total, input, output (reasoning included), cache reads, cache writes, cache hit rate and request count; the trend chart stacks by hour (ranges up to 2 days) or by day, and hovering shows exact numbers.
  - Breakdowns by task, model, vendor, agent and project; deleted tasks are marked Deleted.
  - Hit rate = cache reads ÷ (input + cache reads + cache writes). A Claude message is counted only once.
  - Refreshes every 10 seconds while the tab is open. Not counted: the headless handoff calls made when switching agents, Claude's internal helper-model calls, and Codex sessions from before its hooks were trusted.
- Keyboard input only goes to the session in the focused panel; click a task in the sidebar to switch.
- Archiving: hover a task row and click `×` to end its session process and move it to Archived (「已归档」) under the project (click to expand); if the agent is still working it asks first. Restore (「恢复」) next to an archived task moves it back to the list, then Resume (「续接」) opens the original conversation. `×` on an archived task deletes it for good (the task and its cards, after confirming).
- Resuming: an exited task shows Resume in the sidebar, and the panel bottom has Resume last session (「续接上次会话」) and New session (「新开会话」). Resume opens the last conversation with the CLI's own resume command (claude `--resume`, codex `resume`, agy `--conversation`), keeping the session ID, in the same panel; if you switched conversations with `/resume` inside the CLI, resume opens the one you switched to. If the last session has no conversation log (no message was sent), the panel can only start a new session, and Resume in the sidebar asks whether to start one (a new session replaces the old session's terminal content); cancelling leaves things as they were. The old session's terminal content is replaced by the new session.
- The 「单屏 | 双屏」 segmented control in the top bar switches between one and two panes and highlights the current one. With two panes, clicking in the sidebar replaces the focused pane; the focused pane has a thin task-color line on top of its header, and the other one dims slightly but stays readable. `Alt+1` / `Alt+2` focus the left / right pane.
- ``Alt+` `` jumps to the session that has been waiting for you longest (Chrome does not pass `Ctrl+Tab` to web pages).
- Permissions: all three CLIs always start with full permissions (both new and resumed sessions) and never ask for approval: claude `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox` (which also turns off the sandbox), agy `--dangerously-skip-permissions`. Agents can edit files and run commands directly, so only use Shoal in project directories you trust.
- Status: Starting / Ready / Working / Needs you (amber, with how long it has waited) / Awaiting review / Approved / Exited (「启动中 / 就绪 / 工作中 / 需要你 / 待验收 / 已通过 / 已退出」). Ready means a new session sits at an empty prompt and has not started work; it is not amber and does not count as needing you. An exited task that has not been reviewed still shows 「待验收」 on its row. If Codex says "Hooks need review" on first start, follow the prompt in the terminal to trust them once.
- The page title shows how many things wait for you, e.g. `(3) Shoal` (needs you + awaiting review); the desktop app's taskbar title follows it, and the taskbar button flashes when the number grows while the window is in the background.
- Awaiting review: when an agent finishes a turn (Stop hook), its last reply becomes a result card, the task moves to Awaiting review, and the Awaiting review counter in the top bar goes up by one; click it to jump to the task that has waited longest. The pane header shows a split pill with Approve (「通过」) and a chevron; the chevron opens a floating popover at the top right of the pane (Continue in a new session 「新会话继续…」, Forward result 「转发结果…」, and View full text 「查看原文」 for the card body) that closes on `Esc` or an outside click without resizing the terminal. If you keep talking in the terminal the task goes back to in progress, and a new card is made when the next turn ends.
  - Approve (「通过」): one click in the pane header takes the task out of Awaiting review and leaves it in the list as Approved, not counted under Needs you; talking in the terminal puts it back in progress. Approving does not archive.
  - Continue in a new session (「新会话继续…」): write what should happen next in the dialog and click 「开新会话」 (`Ctrl+Enter`). A new session opens in the same panel whose initial request contains the original task request, the last result and what you wrote. Use it when the context has grown long and you want to restart from the conclusions; to keep talking to the same session, type in the terminal.
- Live subscription quota: the top bar and each panel's header (next to the agent name) show used percentages for active subscription windows (e.g. `5h 48% · 7d 6%`), with exact reset times in the tooltip; windows turn amber from 80%, bold at 100%, and drop out automatically once reset, persisted in `<stateDir>/quota.json`. Claude Code and agy (Antigravity / Gemini subscription) stream updates via their `statusLine` command (preserving any user `statusLine` and agy's built-in status line); Codex is read from its rollout transcript at the end of each turn.
- Out of quota: when claude reports it is out of quota (rate limit / billing, or a reply like "You've hit your … limit"), that turn makes no result card, a quota banner appears at the top of the panel, and the sidebar shows Out of quota (「额度用完」). There are no out-of-quota samples for codex and agy yet, so they are not detected automatically; switch agents by hand when needed.
- Switching agents: Switch agent (「换 agent」) in the panel title bar, or the button on the quota banner. Choose the CLI to take over and optionally add notes; on submit (`Ctrl+Enter`) the workbench makes one short headless call with that CLI (a few seconds to about twenty, using a little quota) that reads the task request, result and feedback cards and the old session's conversation log, and writes a handoff card. It then opens a new session with the new CLI in the same panel, whose first message is the handoff card, your notes and the path to the old conversation log. If generation fails it falls back to a card excerpted from the logs and marks it Excerpted from the logs (「已按记录摘录」). Clicking Expand (「展开」) on the Handoff (「交接」) strip floats the card over the terminal without changing its height.
- Forwarding: Forward result (「转发结果…」), in the popover next to Approve in the pane header, sends that result card to another task or a new one. The dialog lets you add a note (a default one is used if you leave it empty) and previews the full message. Sending to an existing task is queued: while the target is working, has a permission prompt, you typed in that session in the last 5 seconds, or its turn ended less than 1.5 seconds ago, a floating Message queued badge appears at the top right of the terminal and the sidebar marks it Queued (「排队」) until it is sent; if the target session has exited it is resumed first, and if that is not possible you are offered to forward to a new task instead. Forwarding does not change the source task's status.

## Testing

```sh
npm run typecheck
npm test                                                    # vitest unit tests
npm run e2e                                                 # e2e with a fake CLI; artifacts in .tmp/m1/, .tmp/m2/, .tmp/m3/, .tmp/ui-redesign/ and .tmp/token-stats/
npx vite build; if ($?) { npx playwright test -c e2e-real/playwright.real.config.ts }   # smoke test with the real CLIs, uses a little quota; artifacts in .tmp/m2/real/
npx vite build; if ($?) { npx playwright test -c e2e-real/playwright.handoff.config.ts }   # real-CLI agent switching (claude→codex→agy→claude); artifacts in .tmp/m3/real/
```

The e2e tests use `test/fixtures/fake-agent.mjs` to simulate an interactive CLI (needs `WORKBENCH_FAKE_AGENT=1`, already set in the Playwright config), and Playwright uses the local Chrome (`channel: 'chrome'`).

## License

[MIT](LICENSE). Claude Code, Codex and Antigravity are products of Anthropic, OpenAI and Google respectively; this project is not affiliated with them.
