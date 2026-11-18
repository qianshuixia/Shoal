# Shoal 跨厂商原生 CLI 轻量协作机制规范

本文档定义 Shoal（`agent-workbench`）中面向 Claude Code、Codex CLI 与 Antigravity CLI（`agy`）的三层轻量协作机制、建立在它们之上的委派编排（第 4 节），以及支撑安全投递的底层 PTY 护栏。

## 1. 设计原则与硬边界

1. **普通窗口零膨胀**：不在终端面板增加常驻审阅状态条、不弹窗打断对话、不改动标题栏「通过」按钮的现有语义、不引入强制送审工作流。
2. **绝不触碰终端容器高度**：保持 ConPTY 不因动态横幅改尺寸（避免历史重绘闪烁问题），任何界面增量仅放在已有模态框或浮层内。
3. **严格遵守 `agy -p` 禁用规则**：交互式 `agy` 会话只通过标准启动参数（`--add-dir`）与工作台终端排队投递参与协作，绝不调用无头 `agy -p`。
4. **同项目强隔离**：协作索引、快照与 `shoal` CLI 互调一律严格限定在发起方任务所属的 `projectId` 内部；跨项目会话不可相互列举、读取或投递。
5. **不污染用户指标**：后台自动投递与自动回传不改写任务自动标题（`titleAuto`）、`lastPrompt` 预览及侧边栏 `lastActiveAt` 活跃排序。

## 2. 底层基础：4 道 PTY 安全投递护栏（`server/sessions.ts`）

向交互式 CLI 终端排队粘贴提示词前，`deliverable()` 与 `deliver()` 必须同时满足以下条件：

1. **首轮启动完成护栏（`!initialPromptPending`）**：带初始提示词新建会话时，等待首轮 hook 启动（或在静默 CLI 无首轮提示/到达 4 秒 `quiet` 超时/`Stop` 后自动解除，避免 Codex 未提交首句前不发 `SessionStart` 造成死锁）。
2. **启动弹窗阻塞护栏（`!startupBlocked`）**：首轮尚未完成前，若 PTY 输出出现 Codex/Claude 目录与 hook 信任确认弹窗（如 `Hooks need review`、`Do you trust the files in this folder`、`No, exit`），冻结队列直到用户在终端回车或触发首个会话 hook。
3. **投递在途锁（`now >= deliveringUntil`）**：`deliver()` 弹出队列写终端到 CLI 触发 `UserPromptSubmit` / `PreInvocation` 存在 0.5–2 秒延迟，锁定 `8000 ms` 防止连发两条。
4. **草稿/Ctrl+C 中断保护与输入序号取消**：
   - 使用 `isTerminalReportSequence()` 过滤 xterm 焦点（`\x1b[I`/`\x1b[O`）、SGR 鼠标、CPR 光标与 DA 设备属性自动回报，避免误判用户正在打字；
   - 用户出现可见未提交字符（`hasDraft`）或刚按 `Ctrl+C` 清空中断队列（`interruptedByUser`）时冻结自动排队，直到用户在终端主动回车提交或从 UI 显式发起非系统排队操作；
   - `deliver()` 写入粘贴帧并延迟 `300 ms` 发送 `\r` 前，捕获 `inputSeq`；若期间发生真实用户输入或 `Ctrl+C`，立即取消本次 `\r` 并回退系统计数。

## 3. 三层轻量协作架构

### Layer 1：同项目静默 Markdown 快照黑板（零打扰被动共享）

- 每次主会话非限流 `Stop` hook 到来时，工作台原子写入该任务最新回复摘要：
  - `<stateDir>/collab/<projectId>/turns/<taskId>-latest.md`
- 同时原子刷新项目同伴索引：
  - `<stateDir>/collab/<projectId>/PEERS.md`
- 索引包含同项目所有非归档任务的 `#序号`、`taskId`、标题、CLI 类型、实时状态、最近需求摘要、最新回复文件绝对路径及首行摘要。
- 会话启动环境变量自动注入：
  - `WORKBENCH_COLLAB_DIR=<stateDir>/collab/<projectId>`
  - `WORKBENCH_PEERS_FILE=<stateDir>/collab/<projectId>/PEERS.md`
- 对 `agy` 会话，通过 `--add-dir <stateDir>/collab/<projectId>` 只挂载所属项目黑板目录（传递原始路径、不做 8.3 短名转换），确保 `agy` 仅能读取当前项目黑板；同时不影响主会话工作区归属判定。
- 任务或项目被删除时，对应快照或整个 `<stateDir>/collab/<projectId>` 同步清理。

### Layer 2：转发结果可选「单次自动回传」（`ForwardDialog`）

- 现有「转发结果…」弹窗（`ForwardDialog`）增加 1 个可选复选框（默认**不勾选**）：
  - `对方本轮完成后，自动把结果传回「<源任务>」`（`ForwardBody.replyBack?: boolean`）
- 状态机规则：
  - **新建目标任务**：直接带 `armed = true` 注册一次性的 `ReplyObligation`。
  - **转发至已有任务**：初始 `armed = false`，仅当目标会话后续真正启动由本次注入触发的回合（`systemInjected === true`）时才武装为 `armed = true`。用户在目标终端自己手工输入的轮次绝不会误触发回传。
  - 若目标回合因用户按 `Esc` 取消或命中 `rate_limit` / `error: 'canceled'` 结束，自动作废该回传义务而不回传错误碎片。
  - 目标正常完成 `Stop` 后，消耗本次义务，将 `forwardText`（带 `isAutoReply: true` 与 `peerHop`）投递回源任务并生成一张 `forward` 卡片；**严格 1 跳即止**。

### Layer 3：无感预注入 `shoal` CLI

- `writeHookFiles(stateDir)` 在启动阶段幂等生成：
  - `<stateDir>/bin/shoal-cli.mjs`（零外部依赖 ESM 脚本）
  - `<stateDir>/bin/shoal.cmd`（Windows 包装器，优先使用 `WORKBENCH_NODE` 指向的桌面内置 `node.exe`）
  - `<stateDir>/bin/shoal`（POSIX shell 包装器，严格使用 `\n` LF 换行以兼容 Git Bash）
- `SessionManager.spawn()` 对 `process.env` 执行大小写去重后的 `prependEnvPath(env, <stateDir>/bin)`（解决 Windows 下 `Path` 与 `PATH` 大小写并存导致失效问题），并注入会话级随机 256-bit `WORKBENCH_PEER_TOKEN`（进程退出或移除时立即吊销）。
- CLI 命令：
  - `shoal peers [--json]`：查看同项目所有活跃任务与状态（对应 `GET /api/peer/peers`）。
  - `shoal send <target> [-m "<说明>"] [--file <路径>] [--stdin] [--new]`：单向发消息给同项目另一个任务（`target` 自动剥离前导 `@`，避开 PowerShell Splatting 参数吞噬；多行正文通过 `--file` 或 `--stdin` 避开 `.cmd` 换行截断）。
  - `shoal ask <target> [-m "<说明>"] [--file <路径>] [--stdin] [--new]`：发送并在对方本轮完成后自动回传 1 次结果；提示发起方立即结束本轮等待，禁止写轮询死循环。
- 安全与防循环：
  - **鉴权与子代理屏蔽**：仅接受本地无 `Origin` 的 CLI 请求，`Authorization: Bearer <WORKBENCH_PEER_TOKEN>` 通过时间安全比较验证；当 `agy` 会话处于等待内部子代理的 `intermediate-stop`（`subagentWait === true`）时，返回 `403` 拒绝其衍生进程代发外部同伴消息。
  - **文件包含边界**：`--file` 经 `realpathSync` 解析后必须位于所属 `project.path` 或 `WORKBENCH_COLLAB_DIR` 目录内，且体积上限 `512 KB`。
  - **跳数与连发熔断**：自动接力链最大跳数 `MAX_AUTO_HOPS = 4`（超限返回 `429`）；同一会话同一轮次向同一目标连发上限 `2` 次（超限返回 `409`）。
- 命令说明：`shoal help` 列出全部子命令和 shell 注意事项；会话启动时得到的说明见 4.5 节。早期版本同步给 `agy` 的 `shoal-collab` skill 已移除，启动时会清掉旧的同步副本。

## 4. Layer 4：委派编排（`shoal delegate`）

主任务把一件完整的事派给另一个厂商的原生 CLI，自己不被锁定，结果回来后验收、打回或关闭。全程只驱动交互式终端，不使用任何无头调用。

### 4.1 模型

- **主次挂在任务上**。子任务的 `Task.delegation.parentTaskId` 指向主任务，而不是主任务的某个会话或 agent，所以主任务「换 agent」之后子任务仍然归它。
- **只有一层**。委派任务不能再委派（`403`）。
- **状态是推导出来的，不落盘**。`delegationState(task, session)`（`shared/protocol.ts`）给出：

| 状态 | 含义 | 判定 |
|---|---|---|
| `working` 执行中 | 第 1 轮在跑 | 会话存活，`round === 1` |
| `rework` 返工中 | 第 2 轮及以后在跑 | 会话存活，`round > 1` |
| `needs_you` 等你处理 | 停在只有用户能处理的地方 | 权限或启动确认弹窗、`Ctrl+C`、额度用完 |
| `review` 待验收 | 一轮结束，结果已送回主任务 | `phase` 为 `review` |
| `failed` 已中断 | 进程没了，也没有结果 | 会话已退出且 `phase` 为 `active` |
| `accepted` 已通过 / `canceled` 已取消 | 已关闭 | `phase` 为 `archived`，读 `delegation.outcome` |

- 落盘的只有 `delegation`：`parentTaskId`、`brief`（任务说明首行）、`round`、`createdAt`，以及关闭时写入的 `outcome` 与 `settledAt`。

### 4.2 命令

| 命令 | 作用 |
|---|---|
| `shoal delegate <claude\|codex\|agy> [--review] [--title] [-m\|--file\|--stdin]` | 新建子任务并启动对应 CLI，首条提示词是 `delegationPrompt`（只含任务说明，不带主对话历史）。立即返回，输出里写明「不要等待或轮询」。`--review` 派出只读评审者（`delegation.mode = 'review'`）：提示词要求不改文件，第一行给「结论：PASS/FAIL」，再列 BLOCKING / NON-BLOCKING；结果按评审结论送回主任务，界面标为「评审」 |
| `shoal status [--json]` | 列出自己派出的子任务：句柄、状态、轮次 |
| `shoal rework <句柄> [-m\|--file\|--stdin]` | 把验收意见发回同一个子会话，`round + 1` |
| `shoal done <句柄>` | 验收通过：结束子 CLI 进程并归档，`outcome = accepted`。只在 `review` 状态可用 |
| `shoal cancel <句柄>` | 放弃：结束子 CLI 进程并归档，`outcome = canceled` |

句柄是任务 id 的前 8 位。`#序号` 也能用，但序号会随归档变化，所以回传消息和命令输出里一律给句柄。

### 4.3 流转

- **结果回传**：子任务每一轮正常结束（`Stop`），`delegationResultText` 就排队投递给主任务当前的会话，带句柄和三条后续命令。不区分这一轮是系统注入的还是用户在子终端里手动输入的。被 `Esc` 取消或额度用完的一轮不回传。
- **主任务不锁定**：投递走第 2 节的排队护栏，主任务在忙就等它空闲，用户正在输入草稿就不打断。
- **提问**：子任务需求不清楚时直接在回复里提问并结束本轮，问题随结果回到主任务，主任务用 `shoal rework` 补充。
- **卡住**：子会话出现权限或启动确认弹窗时，界面显示「等你处理」，并给主任务投递一次 `delegationBlockedText`（每个子任务每轮一次）。主任务无法代为确认，只负责告知用户。
- **级联**：归档或删除主任务时，它名下未关闭的子任务全部按 `canceled` 关闭并结束进程。用户直接归档子任务等同于 `cancel`。在主终端里按 `Esc` / `Ctrl+C` 只中断主任务自己的这一轮，不影响子任务。
- **通知**：子任务进入 `review` 不推送手机通知，也不计入顶栏「待验收」，因为验收人是主任务；它进入「等你处理」时照常计入「需要你」。

### 4.4 防失控

- `MAX_DELEGATION_HOPS = 12`：从最近一次用户输入算起，主任务与子任务之间自动往返的跳数上限，超过后 `delegate` / `rework` 返回 `429`，结果回传停止，等用户介入。`send` / `ask` 仍然用 `MAX_AUTO_HOPS = 4`。
- `MAX_DELEGATION_ROUNDS = 4`：单个子任务最多 4 轮，再 `rework` 返回 `409`，提示主任务自己接手或请用户决定。
- `MAX_OPEN_DELEGATIONS = 6`：一个主任务同时未关闭的子任务上限。
- 鉴权沿用 Layer 3 的会话级 `WORKBENCH_PEER_TOKEN`；`rework` / `done` / `cancel` 只能作用于调用方自己派出的子任务。

### 4.5 主 agent 怎么知道可以委派

设置项「允许主 agent 主动委派」（`Settings.autoDelegate`，默认开）打开时，非委派任务的会话在启动时得到 `DELEGATION_INSTRUCTIONS`（约 9 行）：

- Claude Code：`--append-system-prompt`。
- Codex：`-c developer_instructions=...`。用户自己的 `config.toml` 已经定义 `developer_instructions` 时不注入，避免覆盖。
- Antigravity：`agy` 没有系统提示参数。说明写成 `<stateDir>/agy-instructions/AGENTS.md`，启动时用 `--add-dir` 把这个目录加入工作区；按官方文档，工作区目录里的 `AGENTS.md` 是常驻规则（[Rules](https://antigravity.google/docs/rules/)、[Customization discovery](https://antigravity.google/docs/customization-discovery/)）。委派子任务和关闭开关时不加这个目录。

三家都实测过（2026-11-17，claude 2.1.326、codex 0.169.0、agy 1.5.10）：新会话被问到“指令里有哪些 shoal 命令”时，都能列出说明里的命令。agy 的全局规则里没有这些命令，所以 agy 的答案只可能来自注入的 `AGENTS.md`。复测脚本是 `.tmp/delegation-real/smoke.mjs`（本地临时脚本，不入库）。

Antigravity 子任务和其他 agy 会话一样，用交互模式 `agy --dangerously-skip-permissions -i <prompt>` 启动，不走 `agy -p` 无头模式：Google 封禁的是无头模式。所以生成交接卡片、AI 标题这类一次性无头调用仍不支持 agy（`buildGenerator` 返回 `null`）。

关闭后 `shoal` 命令照常可用，只是 agent 不会主动想到它。

实际注入的是 `composeDelegationInstructions()` 的结果：`DELEGATION_INSTRUCTIONS`，加一行“本会话是哪个 CLI、本机装了哪些 CLI（只能委派给这些）”，再加设置项「分工与评审规则」（`Settings.delegationRules`）。规则字段没有设置时用内置的 `DEFAULT_DELEGATION_RULES`；设为 `''` 时不注入规则；上限 `DELEGATION_RULES_MAX`（4000 字）；改动只对之后新启动的会话生效。默认规则按三家官方资料写明各 CLI 的长处与弱项、什么时候委派、什么时候主动发起评审和三方评审的步骤；只写能力，不写模型版本号，避免很快过时。资料来源（2026-11 查阅）：

- Claude：[Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)、[Claude Code model config](https://code.claude.com/docs/en/model-config)
- Codex：[Codex models](https://learn.chatgpt.com/docs/models)、[Code review](https://learn.chatgpt.com/docs/code-review)、[Approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)、[Pricing](https://learn.chatgpt.com/docs/pricing)
- Antigravity：[Models](https://antigravity.google/docs/models)、[FAQ](https://antigravity.google/docs/faq)

### 4.6 界面

- 侧栏：子任务缩进显示在主任务下面，状态列显示委派状态和轮次。
- 主任务面板：右上角「委派」浮层（绝对定位在 `.pane-stage` 内，不改变终端高度），列出每个子任务的状态和正在做的事；点击某个子任务切到双屏并把它放在主任务旁边。关闭后的子任务在浮层里保留 5 分钟。
- 子任务面板标题栏显示它由谁委派和当前委派状态，不显示「通过」按钮。

### 4.7 当前边界

- 主任务和子任务共用同一个工作目录，没有隔离。独立 git worktree 是下一步。
- 委派状态里的往返跳数和「已通知卡住」记录在内存里，服务重启后清零；`delegation` 本身落盘。
