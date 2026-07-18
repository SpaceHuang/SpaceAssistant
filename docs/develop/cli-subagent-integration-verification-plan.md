# CLI Subagent 集成 - 验证计划

> 版本：v1.0
> 编制日期：2026-07-12
> 状态：待执行
> 关联设计：[cli-subagent-integration-design.md](./cli-subagent-integration-design.md) v1.0
> 需求来源：[cli-subagent-integration-requirement.md](../requirement/cli-subagent-integration-requirement.md) v1.7
> 参考实现：[claude-codex-integration.md](../references/claude-codex-integration.md)（Multica，Go 实现）

---

## 0. 概述

### 0.1 验证目标

设计方案中存在三类不确定，须在编码前/中通过实测核实：

1. **Claude Code / Codex CLI 实际实现猜想**：设计基于 Multica（Go, 2026 年初）的协议描述与 CLI 行为。CLI 版本演进、SpaceAssistant 的运行上下文（Electron/Node + 有 UI vs Multica daemon 无 UI）差异，使若干假设需重新验证。尤其 **Multica 因「无 UI」而禁用/自动应答的能力（如 Claude `AskUserQuestion`、Codex approval），我们要「转交用户」--这是超出 Multica 的增量，最不可靠**。
2. **SpaceAssistant 代码集成假设**：复用 `toolConfirmRegistry` / `toolChatLoop` / 持久化等既有机制时的兼容性假设。
3. **跨平台进程管理**：`spawnUtil` 现状不足（无进程组），需增强并验证不破坏既有调用方。

### 0.2 方法论

- **Probe 脚本优先**：仿现有 `scripts/probe-wechat-*.cjs` 模式，为每个协议假设编写独立 `.cjs` 探测脚本，最小化复现、可重复、可归档。脚本仅做「spawn CLI + 抓取/回写协议帧 + 打印」，不接业务逻辑。
- **版本锚定**：所有协议结论标注实测 CLI 版本；结论随版本可能失效，需在升级时回归。
- **失败回退预设**：每项给出「不通过」的回退方案，避免阻塞。
- **门禁制**：里程碑 A/B 启动前，对应阻断项须 ✅；TVQ 项须有明确结论。

### 0.3 环境与分阶段执行（最高优先）

验证工作按**两个环境**拆分、**分阶段**执行。本机当前状态（2026-07-12 实测）：`claude` **已就绪**（v2.1.207，经 `cmd /c claude --version` 验证可用，满足最低 ≥2.0.0）；`codex` 未安装，需在另一台机器上编译与验证。

> **Windows 探测陷阱（重要）**：npm 全局装的 `claude` 在 `npm/` 目录下有三个 shim--`claude`（bash）、`claude.cmd`（cmd）、`claude.ps1`（PowerShell）。其中 **bash shim 引用的 `claude.exe` 不存在**，在 Git Bash 直接跑 `claude` 会报 `No such file or directory`。但 SpaceAssistant 在 Windows 上 spawn 走 `cmd.exe /d /s /c claude` -> 命中 `claude.cmd`（`spawnUtil.ts:98-103`），**这条路正常**。故：probe 脚本与 `subagentCliDetect` 在 Windows 必须经 `claude.cmd` 或 `cmd /c claude` 调用，**不可**在 Git Bash 直接跑 `claude`。早先「claude 安装损坏」的结论系误测 bash shim 所致，已纠正。

| 环境 | 机器 | 职责 | 前置准备 |
|------|------|------|----------|
| **环境 A** | 本机（Windows，持有代码库） | Claude Code 协议 + 代码集成（V-SA-*）+ Windows 跨平台 + 安全（Claude 侧） | claude 已就绪（v2.1.207），仅需冒烟确认鉴权 |
| **环境 B** | 另一台机器（Codex + Unix/macOS） | Codex 协议 + Unix 跨平台（进程组 / macOS Desktop）+ 安全（Codex 侧） | 安装 `codex` + 鉴权 + 同步代码库 |

**A-0（环境 A 准备）**：
1. Claude Code **已就绪**（2026-07-12 实测 v2.1.207，经 `cmd /c claude --version` 验证；满足最低 ≥2.0.0）。无需修复/重装。
2. 鉴权冒烟：`cmd /c claude -p "say ok"` 可跑通即已登录（用户确认 claude code 可运行，鉴权应已就位）。
3. 实测版本号 2.1.207 填入 V-CC-* 各项「实测版本」栏。

**B-0（环境 B 准备，可与 A 并行）**：
1. 在另一台机器同步代码库（`git clone` / `pull`），`npm install` + `npm run build` 通过（probe 脚本与集成测试需编译运行）。
2. 安装 Codex，验证 `codex --version` 与 `codex app-server --help` 可执行；完成 Codex 鉴权。
3. 记录实测版本号，填入 V-CX-* 各项「实测版本」栏。

> 代码集成项（V-SA-*）不依赖任何 CLI，可在环境 A **立即启动**，是阶段 1 的首批工作。协议项各自被本环境准备阻断：V-CC-* 阻断于 A-0，V-CX-* 阻断于 B-0。完整阶段编排见 §8。

---

## 1. 验证项总览

| 编号 | 类别 | 项 | 风险 | 阻断 | 优先级 |
|------|------|----|----|------|--------|
| V-CC-02 | Claude | `--permission-mode` 触发 control_request | 🔴 假设不成立·须重设 | A / DD-1 / DD-3 | P0 |
| V-CC-13 | Claude | AskUserQuestion stream-json 触发与回写（TVQ-1） | 🟢 已核查·不通过(Claude禁用问询) | C / D12 | P0 |
| V-CC-03 | Claude | control_request/response 事件结构 | 🟠 moot(-p不触发) | A | P0 |
| V-CC-10 | Claude | stream-json stdout 事件类型全集 | 🟠 部分实测 | A | P0 |
| V-CC-04 | Claude | `--effort` flag + 级别集合 | 🟢 已实测 | A | P1 |
| V-CC-06 | Claude | `--model` 接受的 id | 🟢 部分实测 | A | P1 |
| V-CC-05/07/08 | Claude | max-turns / disallowedTools / strict-mcp flag | 🟢 已实测(max-turns缺) | A | P1 |
| V-CC-11/12 | Claude | thinking 输出 / usage 字段口径 | 🟢 已实测 | A | P1 |
| V-CC-01/17 | Claude | 版本解析 / 最低版本 2.0.0 | 🟢 部分实测 | A | P1 |
| V-CC-14/15/16 | Claude | async_launched / root-sudo / stdin 关闭 | 🟡 低 | A | P2 |
| V-CX-02 | Codex | `app-server --listen stdio://` 存在（≥0.100.0） | 🔴 高 | B | P0 |
| V-CX-03/04/05 | Codex | initialize / thread/start / turn/start 方法与参数 | 🔴 高 | B | P0 |
| V-CX-06 | Codex | notification/item 事件类型全集 | 🔴 高 | B | P0 |
| V-CX-07 | Codex | 工具授权 server request method 全集 | 🔴 高 | B / DD-4 | P0 |
| V-CX-09 | Codex | elicitation 触发与响应（TVQ-1 Codex 侧） | 🟠 中 | B | P0 |
| V-CX-10/11 | Codex | `debug models --bundled` + 思考级别（≥0.122.0） | 🟠 中 | B | P1 |
| V-CX-08/12/13 | Codex | 授权响应结构 / permissions / usage 口径 | 🟠 中 | B | P1 |
| V-CX-17 | Codex | JSON-RPC 在 Node stream 下的分帧 | 🟠 中 | B | P1 |
| V-CX-14/15/16/18 | Codex | 优雅关闭 / Desktop 路径 / auth / 最低版本 | 🟡 低 | B | P2 |
| V-SA-02 | 集成 | 问询回答文本无法经 toolConfirmRegistry 传递（设计缺口） | 🟢 已定方案A | A / DD-3 | P0 |
| V-SA-07 | 集成 | toolChatLoop 并行批可行性（共享状态交错） | 🟠 已核查·方案D | B / DD-2 | P0 |
| V-SA-05/06 | 集成 | ToolUseData.subagent 持久化往返 + 列大小 | 🟠 已核查·须改反序列化 | A / DD-6 | P0 |
| V-SA-03 | 集成 | tool:confirm-response handler 扩展不破坏 builtin | 🟢 已核查·扩展可行 | A | P0 |
| V-SA-01 | 集成 | 合成 toolUseId 在 pendingConfirmStore 可行 | 🟢 已确认 | A | P1 |
| V-SA-04/08/09/10/11/12 | 集成 | progress payload / sendProgress / signal / filter / config 往返 / 备份 | 🟢 已核查·2 处需适配 | A/B | P1 |
| V-Xplat-01 | 跨平台 | Unix 进程组杀孙进程方案验证（独立 probe，不改 spawnUtil）（TVQ-3） | 🔴 高 | B | P0 |
| V-Xplat-02/03 | 跨平台 | Windows 无黑窗 + taskkill /T /F 杀孙进程 | 🟠 中 | A | P1 |
| V-Xplat-04/05 | 跨平台 | macOS Desktop 路径 / nvm/fnm/volta 解析 | 🟡 低 | B | P2 |
| V-Sec-01 | 安全 | 环境变量过滤不影响 CLI 运行 | 🟠 中 | A | P1 |
| V-Sec-02/03/04/05/06 | 安全 | cwd / 风险映射 / auto 拦截 / 鉴权隔离 / 日志脱敏 | 🟡 低 | A/B | P1 |

> 风险图例：🔴 阻断设计核心 / 🟠 需适配 / 🟡 低风险验证 / 🟢 已确认
>
> 环境归属：V-CC-* / V-SA-* / V-Xplat-02·03 / V-Sec（Claude 侧）-> **环境 A**（本机 Windows）；V-CX-* / V-Xplat-01（Unix 侧）·04·05 / V-Sec（Codex 侧）-> **环境 B**（另一台机器）。其中 V-Xplat-01（spawnUtil 进程组增强）代码在 A 编写、Windows 回归在 A、Unix 孙进程实测在 B。详见 §8。

---

## 2. Claude Code 协议验证（stream-json）

> 前置：E-0 完成，`claude --version` 可执行。所有结论标注实测版本。

### V-CC-01　版本解析（P1，部分实测）
- **部分实测（2026-07-12）**：`cmd /c claude --version` 输出 `2.1.207 (Claude Code)`，**无噪声行**，正则可直接命中；满足最低 ≥2.0.0（V-CC-17）。
- **假设**：`claude --version` 输出含 semver 行；Windows npm shim 可能先输出 `Active code page: 65001` 等噪声行，需取首个 semver 行。
- **方法**：`node scripts/probe-subagent-claude-version.cjs`（Windows 下经 `cmd /c claude.cmd --version`，**不可**用 bash shim；打印原始输出 + `extractVersionLine` 结果）。
- **期望**：提取到 `v?(\d+)\.(\d+)\.(\d+)` 形状版本。
- **不通过回退**：扩展 `extractVersionLine` 正则；极端情况让用户手填版本。

### V-CC-02　`--permission-mode` 是否触发 control_request（P0，核心，❌ 假设不成立）
- **假设（已证伪）**：confirm 策略下用 `--permission-mode default`，CLI 调用工具前发 `control_request`，回写 `control_response` 后工具才执行。
- **实测（2026-07-12，v2.1.207，本机 glm-5.2 代理）**：
  - `--permission-mode default` + `-p` stream-json：Read 与 PowerShell **均被自动执行**，全程**无 `control_request` 事件**，`permission_denials:[]`。事件流：`init` -> `assistant(thinking)` -> `assistant(tool_use)` -> `user(tool_result，已执行)` -> `assistant(text)` -> `result`。
  - `--permission-mode manual`：init 仍报 `permissionMode:"default"`（旗标疑似在 `-p` 下未生效），Read 照旧自动执行。
  - 模式全集（`claude --help`）：`acceptEdits`/`auto`/`bypassPermissions`/`manual`/`dontAsk`/`plan`；**无 `--permission-prompt-tool` 旗标**。
  - 用户 `~/.claude/settings.json` 未设权限模式（仅 env 代理：`ANTHROPIC_BASE_URL`=火山 ARK coding 代理、`ANTHROPIC_MODEL`=glm-5.2）。
- **结论**：`-p`（print/SDK）非交互模式下，claude-code **自行执行工具并上报结果**，stream-json 协议**无「执行前拦截」插入点**，`--permission-mode` 不产生 control_request。**confirm 策略（DD-3/§8.1）对 Claude Code 不成立**。Multica「`bypassPermissions`+自动批准 control_request」的旧路径在 v2.1.207 已不适用。
- **待确认**：是否为 `-p` 模式固有（vs 本机 glm-5.2 代理特有）--后续在标准 Anthropic API 环境回归一次。但行为高度可能是 `-p` 模式固有。
- **影响与回退（须重新设计授权路径，影响 DD-1/DD-3/§8.1）**：
  - **方案 A（推荐）**：Claude Code subagent 仅支持 observe-only（等价 `auto`）。`toolApproval='confirm'` 对 Claude 降级为「observe + 醒目提示无逐次拦截」，或用 `--disallowedTools` 粗粒度禁用高危工具（PowerShell/Write/Edit）使 claude 无法执行（但无法逐次批准）。**真正的逐次确认仅 Codex（server-request approval）支持**。
  - **方案 B**：注入 MCP 权限工具拦截--v2.1.207 无 `--permission-prompt-tool`，且违背 N3（不注入 MCP），不采纳。
  - **方案 C**：改用交互式（非 `-p`）+ pty--复杂、违背 stream-json 设计，不采纳。
- **决策**：须与产品确认 Claude Code confirm 模式的可接受降级（方案 A）。此项阻塞里程碑 A 的 `ClaudeCodeBackend.respondToolApproval` 设计。

### V-CC-03　control_request / control_response 结构（P0，🟠 moot--`-p` 模式不触发）
- **状态**：V-CC-02 实测 `-p` 模式下 claude 不发 control_request，故本项（其事件结构）**当前无实测样本、且对运行无影响**。Multica 描述的结构（`control_request` 含 `request_id`；`control_response` 为 `{type:'control_response', response:{subtype:'success', request_id, response:{behavior:'allow'|'deny', updatedInput}}}`）保留作未来版本兼容参考。
- **方法**：若未来版本恢复 control_request，用 probe 抓取事件原文核对字段。
- **不通过回退**：按实测字段调整 `ClaudeCodeBackend.respondToolApproval`（当前 Claude 走 observe-only，本方法未用，§4.3）。

### V-CC-04　`--effort` flag 与级别集合（P1，✅ 已实测）
- **已实测（2026-07-12，v2.1.207）**：`claude --help` 确认 `--effort <level>`，描述「Effort level for the current session (low, medium, high, xhigh, max)」。**级别集合与设计一致**。
- **待补**：按模型过滤（opus 全档、sonnet 部分、haiku 少）--需用 `--effort <level>` 实跑各模型验证接受性（耗 API，P2 顺带做）。
- **不通过回退**：`--effort` 不存在（旧版）-> 禁用思考级别下拉；解析失败 -> 用静态超集。

### V-CC-05/07/08　max-turns / disallowedTools / strict-mcp-config（P1，✅ 已实测）
- **已实测（2026-07-12，v2.1.207）**：
  - `--max-turns`：❌ **不存在**（`claude --help` 无此旗标）。设计 §6.2 的 `maxTurns` 参数对 Claude 无 CLI 对应。
  - `--disallowedTools` / `--disallowed-tools <tools...>`：✅ 存在，接受工具名/模式（如 `Bash(git *)`、`PowerShell`、`Write`、`Edit`）。`buildArgs` 的 `--disallowedTools PowerShell Write Edit` 有效。
  - `--strict-mcp-config`：✅ 存在，"Only use MCP servers from --mcp-config, ignoring all other MCP configurations"。
- **回退（maxTurns）**：Claude buildArgs 移除 `--max-turns`；执行轮次上限靠**绝对超时（timeoutMinutes）+ 无活动超时**兜底。`maxTurns` 参数对 Claude 为 no-op（Codex 侧 V-CX 另查）。
- **额外发现（可选增强）**：`--include-partial-messages`（更细粒度流式分块，仅 `--print` + `stream-json`）、`--allowedTools`（工具白名单，与 `--disallowedTools` 对偶）均存在，留作后续优化。

### V-CC-06　`--model` 接受的 id（P1，✅ 部分实测）
- **已实测（2026-07-12，v2.1.207）**：`--model <model>` 存在，描述「Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')」。即接受 **alias**（fable/opus/sonnet）或**全名**（claude-fable-5）。
- **待补**：静态列表全名（`claude-sonnet-5`/`claude-opus-4-8`/`claude-fable-5`/`claude-haiku-4-5-20251001`）逐 id 实跑确认接受性（耗 API，P2）。
- **不通过回退**：按实测可用 id 修订静态列表；亦可改用 alias 简化。

### V-CC-09　stream-json stdin 输入格式（P0，✅ 已实测）
- **已实测（2026-07-12，v2.1.207）**：stdin 写一行 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":task}]}}` + `claude -p --input-format stream-json --output-format stream-json --verbose`，CLI 正常接收处理（多轮 probe 均用此方式成功触发 assistant/result 事件）。
- **Windows 要点**：经 `cmd /c` 管道传入（非 `-p "prompt"` arg，避 cmd 引号截断，见 §0.3 探测陷阱）。
- **不通过回退**：按实测调整 `buildStdinPrompt`（当前格式有效，无需回退）。

### V-CC-10　stream-json stdout 事件类型全集（P0，部分实测）
- **部分实测（2026-07-12，v2.1.207，文本 task）**：已观察到--
  - `system/hook_started` + `system/hook_response`：钩子生命周期（用户的 SessionStart 插件 PowerShell 报错，与我们无关，解析器忽略）。
  - `system/init`：含 `session_id`/`tools`/`model`/`permissionMode`/`claude_code_version`/`slash_commands`/`plugins`/`capabilities`。**session_id 取自此**。
  - `system/thinking_tokens`：`{estimated_tokens, estimated_tokens_delta}`，**每 token 一条碎事件**--🆕 Multica 参考未提及，v2.1.207 新增，解析器须容忍（忽略或作进度）。
  - `assistant`（thinking）：`message.content:[{type:"thinking",thinking:"...",signature:""}]`。
  - `assistant`（text）：`message.content:[{type:"text",text:"..."}]`。**thinking 与 text 是两条独立 assistant 消息**（各一个 content block），解析器须跨 assistant 消息累积。
  - `result`：`{subtype:"success",is_error,result,stop_reason,usage,total_cost_usd,num_turns,duration_ms,permission_denials,terminal_reason,session_id,modelUsage}`。
- **待补**：`user`(tool_result) / `tool_use` content block / `control_request` / `log`--需触发工具调用的 task（V-CC-02 probe）。
- **方法**：`probe-subagent-claude-stream.cjs` dump 全部 stdout 行逐行分类；额外发一个会触发 thinking + tool_use + tool_result 的 task。
- **不通过回退**：按实测事件类型调整 `ClaudeCodeBackend` 解析映射。
- **Windows 调用陷阱**：`cmd /c 'claude -p "..."'` 的内层双引号会被 cmd 截断（实测 prompt 被截成 `"Reply`）；后续 probe 改用 stdin 方式（`--input-format stream-json` + 管道，即 SpaceAssistant 实际调用方式，同时验证 V-CC-09）。

### V-CC-11　thinking 块输出（P1，✅ 已实测）
- **已实测（2026-07-12，v2.1.207）**：`assistant` 消息 `message.content` 含 `{type:"thinking",thinking:"<文本>",signature:""}` 块。thinking 与 text 分两条 assistant 消息发出。本机模型 `glm-5.2` 亦输出 thinking。
- **待补**：`signature` 字段语义（是否需回传校验）；高 effort 下 thinking 体量。
- **不通过回退**：无 thinking -> 该维度隐藏（需求 §7.2 允许）。

### V-CC-12　result 事件 usage 字段口径（P1，✅ 已实测）
- **已实测（2026-07-12，v2.1.207）**：`result.usage` = `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, server_tool_use, service_tier, cache_creation:{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}}`；另有 `total_cost_usd`、`modelUsage`（按模型分拆）。
- **归一化映射**（设计 §9.3）：`input`<-`input_tokens`、`output`<-`output_tokens`、`cacheRead`<-`cache_read_input_tokens`。✅ 成立。
- **关键**：usage 取自 `result` 事件；流式中 `assistant.message.usage` 全为 0，不可用。
- **不通过回退**：无 usage -> 隐藏 token 展示。

### V-CC-13　AskUserQuestion stream-json 触发与回写（P0，TVQ-1，❌ 不通过·Claude 禁用问询）
- **假设（已证伪）**：Claude 调 `AskUserQuestion` 时，stream-json 输出可识别问询事件，可结构化回写答案。
- **实测（2026-07-12，v2.1.207，本机 glm-5.2）**：
  - init 事件 `tools` 列表（`§V-CC-10` 实测）：`Task/CronCreate/.../PowerShell/Read/.../Write`，**不含 `AskUserQuestion`**。
  - 发 task 明确要求调 `AskUserQuestion`：claude **未产生 tool_use 事件**，直接文字回复「我当前可用的工具列表中没有 AskUserQuestion」-> `result(success, stop_reason:end_turn)`。
- **结论**：`-p`（print/SDK）模式下 claude code **不把 AskUserQuestion 注入工具集**，模型无法调用。**Claude Code 问询在 stream-json `-p` 下不可实现**。落入设计预设回退（D12）。
- **回退（已定）**：Claude 侧禁用问询--`buildArgs` 中 `inquiryEnabled=false` 时 `--disallowedTools AskUserQuestion`（虽工具本就不可用，保留作防御）；Claude 问询卡片不实现。**不影响其他能力**；Codex 问询（elicitation，V-CX-09）不受影响。
- **影响**：里程碑 C 的 Claude 问询**不实现**；Claude Code subagent 既无逐次确认（DD-8）也无问询，纯 observe-only + 结果回收。需求 §8.5.4 已预见此回退。

### V-CC-14/15/16　async_launched / root-sudo / stdin 关闭（P2）
- **假设**：tool_result 含 `status:'async_launched'` 标记异步任务；root 下 bypassPermissions 被拒；关 stdin 结束会话。
- **方法**：专项小脚本；root 行为在 Linux 容器内验证。
- **不通过回退**：async 检测失效 -> 移除该检查；root 拒绝行为变化 -> 调整预检。

### V-CC-17　最低版本 2.0.0（P1，✅ 已实测）
- **已实测（2026-07-12）**：本机 `claude --version` = 2.1.207，满足最低 ≥2.0.0。
- **注**：原假设「stream-json + control_request 自 2.0.0 稳定」中，control_request 在 v2.1.207 `-p` 模式已不触发（V-CC-02），该子项 moot；stream-json 事件流稳定可用（V-CC-10）。
- **不通过回退**：若未来发现更低版本不支持 stream-json，提高最低版本要求。

---

## 3. Codex 协议验证（JSON-RPC app-server）

> 前置：E-0 完成，`codex --version` 与 `codex app-server --help` 可执行。**协议字段多为基于 Multica 的猜想，须实测**。

### V-CX-01　版本解析（P1）
- **方法**：`probe-subagent-codex-version.cjs`（spawn `codex --version`）。
- **期望**：提取 semver。

### V-CX-02　`app-server --listen stdio://` 存在（P0）
- **假设**：`codex app-server --listen stdio://` 启动 JSON-RPC over stdio（≥0.100.0）。
- **方法**：`codex app-server --help` 核对子命令与 `--listen` 参数；`probe-subagent-codex-appserver.cjs` 启动并发 initialize，观察握手响应。
- **不通过回退**：若子命令名/参数变化 -> 按实测调整 `buildArgs`；若无 stdio 模式 -> Codex 后端不可行，需评估替代（如 `codex exec` 一次性模式），可能影响 D2。

### V-CX-03/04/05　initialize / thread/start / turn/start（P0）
- **假设**（Multica）：`initialize{clientInfo,capabilities}` -> `initialized` notify -> `thread/start{model,cwd,developerInstructions,config:{reasoning:{effort}}}` -> `turn/start{threadId,input:[{type:'text',text}],effort}`。
- **方法**：`probe-subagent-codex-appserver.cjs` 逐步发请求，dump 响应；核对方法名与参数字段。
- **不通过回退**：按实测方法名/字段调整 `CodexBackend.start`。

### V-CX-06　notification/item 事件类型全集（P0，猜想最多）
- **假设**：item type 含 `message`/`reasoning`/`tool`/`function_call`/`tool_result`/`function_call_output`/`fileChange`；另 `turn/completed`。
- **方法**：V-CX-03 脚本发一个会触发思考+工具+文件改动的 task，dump 全部 notification，逐项分类。
- **不通过回退**：按实测 item 类型重写 `CodexBackend` 事件映射；**此项猜想密度最高，预期会有偏差**。

### V-CX-07　工具授权 server request method 全集（P0，DD-4 依赖）
- **假设**（Multica 列多个）：`item/commandExecution/requestApproval` / `execCommandApproval` / `item/fileChange/requestApproval` / `applyPatchApproval` / `item/permissions/requestApproval`。**不确定当前版本用哪套命名**。
- **方法**：V-CX-06 脚本触发命令执行 + 文件改动，dump server request method；核对。
- **不通过回退**：按实测 method 调整 `handleServerRequest` 路由；风险映射（DD-4）按实测工具名重定。
- **关联**：直接决定 `subagentSecurity.ts` 的 CLI 工具名->风险等级表。

### V-CX-08　授权响应结构（P1）
- **假设**：`{decision:'accept'|'deny'}`。
- **方法**：V-CX-07 中回写 accept/deny，观察 CLI 行为。
- **不通过回退**：按实测调整 `respondToolApproval`。

### V-CX-09　elicitation 触发与响应（P0，TVQ-1 Codex 侧）
- **假设**（Multica）：`mcpServer/elicitation/request` -> 回写 `{action:'accept', content, _meta}` 或 `{action:'reject'}`。
- **方法**：`probe-subagent-codex-elicitation.cjs`：发 task 让 Codex 主动问询（如「有两个配置，问我用哪个」），dump request；回写 accept+content 观察 CLI 继续。
- **不通过回退**：method/字段变化 -> 按实测调整；Codex 不支持 elicitation -> Codex 问询禁用。

### V-CX-10/11　`debug models --bundled` + 思考级别（P1）
- **假设**：`codex debug models --bundled`（≥0.122.0）输出可解析的模型目录，含每模型思考级别。
- **方法**：`probe-subagent-codex-models.cjs`：跑 `codex debug models --bundled`，dump 原始输出，试解析。
- **不通过回退**：版本不够/解析失败 -> 回退静态模型列表（需求 §5.3）。

### V-CX-12/13　permissions 响应 / usage 口径（P1）
- **方法**：V-CX-07 中 permissions request 回写 `{permissions:{network,fileSystem}, scope:'turn'}`；V-CX-06 的 `turn/completed` dump usage 字段。
- **不通过回退**：按实测调整。

### V-CX-14/15/16/18　优雅关闭 / Desktop 路径 / auth / 最低版本（P2）
- **方法**：关 stdin 观察 reader 退出时机；macOS 探测 `Codex.app/Contents/...` 路径；查 Codex auth 文档；核对 0.100.0/0.122.0 最低版本。
- **不通过回退**：按实测调整 `shutdown` / 探测路径 / 最低版本。

### V-CX-17　JSON-RPC 在 Node stream 下的分帧（P1，实现风险）
- **假设**：Codex JSON-RPC 按 `\n` 分隔 JSON 行（或 Content-Length 头）。Multica 用 Go bufio.Scanner；Node stream 可能一次 `data` 事件含多行或半行。
- **方法**：V-CX-03 脚本中观察 `stdout.on('data')` 的分块边界，验证需不需要行缓冲重组；大响应是否分多次到达。
- **不通过回退**：实现行缓冲 `LineDecoder`（类 Claude stream-json 的逐行处理）；若是 Content-Length 分帧则实现对应解析器。**此项影响协议解析正确性，须在 CodexBackend 编码前确认**。

---

## 4. SpaceAssistant 代码集成验证

### V-SA-01　合成 toolUseId 可行性（P1，✅ 已确认）
- **结论**：`toolConfirmRegistry.ts:12-14` `confirmKey = ${requestId}\0${toolUseId}`，纯字符串拼接，无格式校验。渲染端 `pendingConfirmStore.ts:37,79-81,113-115` 按 `requestId + toolUseId` 纯字符串匹配/去重/移除，**无正则或格式假设**。合成 id `${dispatchToolUseId}#sub:${callId}` 全链路可行。
- **🔴 涌现的适配点（须编码时落实，归入 V-SA-03/§8.1 payload 扩展工作）**：`pendingConfirmStore` 的 `PendingConfirmItem`（`pendingConfirmStore.ts:5-19`）是**固定字段**，`init` 的 `toolOnConfirmRequest` 回调（`:34-54`）只提取现有字段（toolName/input/riskLevel/diff/shellSecurityHints/autoApproveFallback/currentPageUrl/dangerInfo/sessionTrustedHint），**会丢弃 `source`/`subagent` 上下文**。须扩展 `PendingConfirmItem` + 该回调以保留 `{source, subagent:{kind,agent,cliToolName,inquiryId,question,options,allowCustom}}`；`respond()`（`:88-97`）与 `ToolConfirmOptions`（`src/shared/toolConfirm.ts`）须加 `inquiryAnswer`/`inquiryChoice` 字段以回传问询回答。

### V-SA-02　问询回答文本无法经 toolConfirmRegistry 传递（P0，✅ 已定方案 A）
- **问题**：`toolConfirmRegistry.ts:1,27-36` `submitToolConfirmResponse` 只 resolve `'approved'|'rejected'|'timeout'`，**不携带 trustCommand 或问询回答文本**。现有 builtin 工具的 trust 写入在 `appIpc.ts` handler 内完成，executor 只拿布尔。但 Subagent 问询需把**用户输入的自由文本**回传 runtime -> 回写 CLI。布尔通道不够。
- **已确认**：`waitForToolConfirm` 返回类型确为布尔语义（已读 `toolConfirmRegistry.ts:1`）。
- **决策：方案 A（已定，已回写设计 DD-3 / §8.1-8.2）**--复用 `tool:confirm-request/response` 通道，新建 `subagentInteractionRegistry`（Map，key=合成 toolUseId）中转完整载荷。handler 识别 `source='subagent'` 时先 `storeInteractionPayload(...)`（含 approved/trustCommand/inquiryAnswer/inquiryChoice）再调 `submitToolConfirmResponse` 解除布尔等待；runtime `waitSubagentInquiry` 醒来后从 registry 取走载荷。布尔负责唤醒、registry 负责传话，**不新增 IPC 通道**。
- **落地验证（编码时）**：
  1. `appIpc.ts:289-331` handler 加 `source='subagent'` 分支，不破坏现有 builtin 确认流程（V-SA-03 关联）。
  2. 合成 toolUseId `${dispatchToolUseId}#sub:${callId|inquiryId}` 在 `pendingConfirmStore` 透传无校验（V-SA-01 关联）。
  3. 单测：模拟问询响应 -> `waitSubagentInquiry` 拿到 `inquiryAnswer` 文本；超时 -> `action:'reject'`。
  4. 工具确认的信任写入（CLI 命令类工具）复用 `addTrustedCommand`，验证跨会话生效。

### V-SA-03　tool:confirm-response handler 扩展不破坏 builtin（P0，✅ 已核查·扩展可行）
- **核查结论**：`appIpc.ts:289-331` handler 收 `{requestId, toolUseId, approved, trustCommand?, trustDomain?, trustActDomain?}`，三段 trust 写入均以 `payload.approved && payload.xxx?.trim()` 为条件（命令/域名/act 域名），末尾 `submitToolConfirmResponse(...)`。扩展路径干净：
  - payload 类型加 `source?`/`subagent?`/`inquiryAnswer?`/`inquiryChoice?`（handler 内联类型 `:293-300` + 共享 `ToolConfirmResponsePayload` `api.ts:27-34`）。
  - 在现有 trust 写入**之前**加分支：`if (payload.source === 'subagent') storeInteractionPayload(syntheticToolUseId, {approved, trustCommand, inquiryAnswer, inquiryChoice})`（方案 A，V-SA-02）。
  - 现有 trust 写入**无需改动即可复用**：subagent 命令类工具确认若携带 `trustCommand`，`addTrustedCommand` 通用写入自动生效；问询不携带 trust 字段，trust 写入不触发。
  - builtin 流程（`source` 缺省）完全不进新分支，行为不变。
- **回归要求**：编码后回归 `run_shell`/`edit_file`/`browser`/`wechat_send` 确认用例，确保 builtin 路径无回归。
- **关联**：与 V-SA-01 涌现的 `PendingConfirmItem`/`respond()`/`ToolConfirmOptions` 扩展同属一次「确认 payload 全链路扩展」改动。

### V-SA-04　ToolProgressPayload 加 subagent 字段不破坏消费者（P1，✅ 已核查·可行）
- **核查结论**：主进程 `ToolProgressPayload`（`electron/tools/types.ts:36`）= `{message?, raw?, rawDelta?, seq?}`，`sendProgress(status, payload?: string | ToolProgressPayload)`（`:44`）。新增可选字段 `subagent?: SubagentProgressPayload` 是**结构性向后兼容**（TS 可选字段，现有消费者不读该字段即忽略）。
- **消费者侧**：渲染端 `chatToolSessionService.ts` `onProgress` 按 `status`/字段分派；新增 `payload.subagent` 分支识别即可，不影响现有 `shell`/`script`/`plain` 分支。`ToolCallCard.tsx` 不直接消费 progress payload（消费 `ToolCallRecord`），无影响。
- **落地**：编码时在 `types.ts:36` 加字段、`chatToolSessionService` `onProgress` 加 subagent 分支把 `event` 追加到 `ToolCallRecord.events`。无需回退方案。

### V-SA-05/06　ToolUseData.subagent 持久化往返 + 列大小（P0，✅ 已核查，须改造反序列化）
- **核查结论**：无独立工具调用表，工具调用存于 `messages` 表 `tool_use` / `tool_calls` 两个 TEXT 列（`electron/database/schema.ts:34-50`）。
  - **序列化安全**：`serializeToolUseForDb`（`electron/messageCodec.ts:6-20`）用 `...tool` spread，新增 `subagent` 字段会自动写入 DB。
  - **反序列化丢字段（🔴 必须改造）**：`deserializeToolUseFromDb`（`messageCodec.ts:22-58`）为**字段白名单**式逐一重建，未列 `subagent` -> 加载时被丢弃。必须在返回对象显式加 `subagent: o.subagent`。`deserializeToolCallsFromDb`（`messageCodec.ts:108-140`）同为白名单（且已故意排除若干运行期字段）。
  - **其他 normalize 安全**：`cloneMessages` / `mergeDbAndLive`（`chatRunnerService.ts:33-60`）用 spread 保留字段；`toolUseInputMerge` / `toolResultPairing` 不重建对象。
  - **列大小**：TEXT 无硬限制（~1GB），无截断逻辑；数 KB 安全，数十 KB 可接受，上百 KB（`filesChanged` 很长）有加载性能风险（每条消息加载都反序列化整个 `tool_use` JSON）。
  - **备份**：`sessionBackupManager` 从 DB 加载后整体 `JSON.stringify`，无字段过滤 -> 修复反序列化后备份自动包含 `subagent`。
- **改造动作（须在里程碑 A 编码前落实，更新 DD-6）**：
  1. `deserializeToolUseFromDb` 返回对象加 `subagent: o.subagent`。
  2. `subagent` 内若含 `Record<string, unknown>` 类字段，评估是否需像 `parameters` 一样双层 JSON.stringify（整体 stringify 亦可，但往返测试须验证嵌套结构完整）。
  3. `filesChanged` / `toolSummaries` 设上限 + 超出截断/落盘引用，控制 `tool_use` JSON 体量。
  4. 往返测试：含 `subagent` 的 ToolUseData -> serialize -> deserialize -> 验证字段完整；备份/恢复往返；大 `filesChanged` 加载性能压测。

### V-SA-07　toolChatLoop 并行批可行性（P0，✅ 已核查，方案 D 可行，需定向改造）
- **核查结论**：`toolChatLoop.ts:692-1581` 的 `for (const tu of toolUses)` 严格顺序。并发下共享状态核查：
  - ✅ **确认注册表 / cancel 信号 / 进度推送**：按 `(requestId, toolUseId)` 寻址（`toolConfirmRegistry.ts:12-47`），天然支持并发，无需改造。
  - ✅ `pendingToolUseByIndex`（`:503`）：仅流式解析阶段用，执行循环前已完成，不涉及。
  - 🟠 `toolResults[]`（`:688`）：`.push()` 顺序非确定，但 API 按 `tool_use_id` 匹配 -> 实际无害；建议改按 index 填充或 allSettled 后统一收集。
  - 🔴 `toolErrorRepeat`（`:432`，定义 `:208-228`）：闭包状态追踪器（连续 3 次同工具同错误 break），并发交错破坏连续性检测 -> **dispatch_subagent 不参与该追踪**。
  - 🔴 `abortRepeatedToolError`（`:690`）：可变变量触发 break，并发下无法中断其他 dispatch -> **dispatch 阶段不触发 break**。
  - 🟠 `recoverySkillSystemSuffix`（`:433`）：只设一次的条件检查，并发下可能同时通过 -> dispatch 阶段隔离或加锁。
  - 🟡 写路径冲突（`electron/toolWriteConflict.ts`）：check-then-act 非原子，但 dispatch_subagent 不直接写文件 -> 低风险。
- **推荐方案 D（低风险改造，更新 DD-2）**：
  1. 第一阶段：扫描 tool_uses，对 `dispatch_subagent` 立即启动（不 await），收集 Promise。
  2. 第二阶段：顺序执行内置工具（现有 `for` 循环逻辑完全不变）。
  3. `await Promise.allSettled(dispatchPromises)`，结果按 `tool_use_id` 填充 `toolResults`。
  4. dispatch 不参与 `toolErrorRepeat`、不触发 `abortRepeatedToolError`；确认流程无需改。
- **改造点**：`toolErrorRepeat` 豁免 dispatch、`abortRepeatedToolError` 仅内置阶段生效、`toolResults` 按 id 填充、`recoverySkillSystemSuffix` 隔离。
- **回退**：若改造仍不稳，降级为顺序执行（并行延后，须产品确认 §16.2）。
- **双引擎并发测试**：涉及 Claude+Codex 同时并发的正确性测试须在环境 B 就绪后补测（§8.4）。

### V-SA-08/09/10/11/12　其他集成项（P1，✅ 已核查，2 处需适配）
- **V-SA-08 ✅**：`ctx.sendProgress(status, payload?: string | ToolProgressPayload)`（`types.ts:44`）接受扩展 payload，加 `subagent?` 字段可行（见 V-SA-04）。
- **V-SA-09 ✅**：`ToolExecutionContext.signal: AbortSignal`（`types.ts:47`）已存在；`registerToolCancel(requestId, toolUseId)`（`toolConfirmRegistry.ts:40-47`）返回 signal 透传至 `ctx.signal`。runtime 监听 `ctx.signal.addEventListener('abort', ...)` -> `killProcessTree` 即可。编码时验证 abort 真正触发 kill。
- **V-SA-10 ✅ 需适配**：`filterBuiltinToolsForApi(cfg, feishu, browserConfig, remoteContext, shellConfig, wechat)`（`toolsConfigRuntime.ts:23-51`）**当前无 subagent 参数**，且 `isToolEnabledByConfig` 会让 `dispatch_subagent`（一旦加入 `BUILTIN_TOOL_DEFINITIONS`）默认随 `tools.enabled` 注入--但需求是「仅当某 Subagent 启用+安装达标时才注入」。**适配**：给 `filterBuiltinToolsForApi` 加参数（如 `subagentAvailable?: boolean` 或 `subagents?: SubagentProfile[]`），仿 wechat/feishu 分支加 `if (!subagentAvailable) list = list.filter(t => t.name !== 'dispatch_subagent')`；调用方（`toolChatLoop`）传入。属低风险签名扩展。
- **V-SA-11 ✅**：`config:get/set` 扩展 `subagents` 往返--`CONFIG_KEYS` 加 `subagents`、`readSubagentsConfig`/`mergeSubagentsConfig` 仿 `readToolsConfig`（`appIpc.ts:200-218`），模式已确认（agent 核查），无风险，编码时写往返测试。
- **V-SA-12 ✅**：`sessionBackupManager` 从 DB `getMessages` 加载后整体 `JSON.stringify`，无字段过滤--**依赖 V-SA-05/06 的反序列化白名单修复**：修复后 `subagent` 字段经 deserialize 进入内存 -> 备份自动包含；不修复则备份也不含。已并入 V-SA-05/06 改造动作。

---

## 5. 跨平台与进程管理验证

### V-Xplat-01　Unix 进程组杀孙进程方案验证（P0，TVQ-3，🔴 已确认缺陷）
- **现状**：`spawnUtil.ts:71-82` Unix 分支仅 `proc.kill('SIGTERM')` + 等 close，**无 `Setpgid`、无 `kill(-pid)`**。Subagent 派生的孙进程（bash/cmd）杀不干净。
- **验证（本阶段，不改主程序代码）**：写独立 probe 脚本 `scripts/probe-subagent-procgroup.cjs`（环境 B / Unix），在脚本内 spawn 一个会派生子 shell 的进程，设 `detached:true`（进程组 leader），用 `process.kill(-pid, 'SIGTERM')` -> 超时 `process.kill(-pid, 'SIGKILL')` 终止，`ps` 确认孙进程无残留。**仅验证方案可行，不改动 `spawnUtil.ts`**。
- **编码（里程碑 B，才改 spawnUtil）**：probe 通过后，在编码阶段落实--`spawnCommand` 增加 opt-in `detached` 选项；`killProcessTree` Unix 分支先 `kill(-pid, 'SIGTERM')` -> 超时 `kill(-pid, 'SIGKILL')` -> 兜底 `proc.kill`。`detached` 仅 Subagent 开启，回归 `runShellExecutor`/`larkCliRunner` 等既有调用方。
- **不通过回退**：若 `detached` 影响既有调用，则为 Subagent 新建 `spawnSubagentProcess` 独立函数，不动 `spawnUtil` 共享路径。

### V-Xplat-02/03　Windows 无黑窗 + taskkill 杀孙进程（P1）
- **方法**：Windows 下 spawn `claude`/`codex`（.cmd shim 经 `cmd.exe /d /s /c` 包装，`windowsHide:true`），观察无控制台弹窗；kill 后用 `tasklist` 确认 `taskkill /T /F` 清理孙进程。
- **不通过回退**：黑窗 -> 检查 `windowsHide` 透传到 cmd.exe 子进程；孙进程残留 -> 评估 Windows Job Object 兜底。

### V-Xplat-04/05　macOS Desktop 路径 / nvm/fnm/volta 解析（P2）
- **方法**：macOS 探测 Codex Desktop `Codex.app/Contents/MacOS/...` 内 CLI；`runWhich` + 登录 shell 解析 nvm/fnm/volta 路径。
- **不通过回退**：引导用户手填绝对路径。

---

## 6. 安全验证

### V-Sec-01　环境变量过滤不影响 CLI 运行（P1）
- **假设**：剔除 `CLAUDECODE`/`CLAUDE_CODE_*`/`CLAUDECODE_*` 后 CLI 仍正常运行；保留代理 / `CODEX_HOME` 等。
- **方法**：probe 脚本打印传给子进程的 env diff；分别「全保留」「过滤后」跑同一 task，对比是否均成功。
- **不通过回退**：若 CLI 依赖某被过滤变量 -> 加入白名单。

### V-Sec-02　cwd 越界拒绝（P1）
- **方法**：`resolveSafePathReal(workDir, '../../etc')` 应抛错；symlink 逃逸场景构造测试。
- **不通过回退**：已复用成熟 `pathSecurity`，低风险。

### V-Sec-03/04　CLI 风险映射 + auto 模式高危拦截（P1）
- **方法**：`subagentSecurity.ts` 风险表单元测试；auto 模式下构造高危命令（越界路径/注入），验证 `runShellSecurityValidators` 仍拦截。
- **关联**：依赖 V-CX-07 / V-CC-03 的实测工具名。

### V-Sec-05/06　鉴权隔离 / 日志脱敏（P1）
- **方法**：断言子进程 env 不含主 Agent API Key；`subagentLogger` 输出经 `sanitizeForLog`，`sk-ant-*`/`Bearer`/长 base64 被脱敏，task 仅摘要。

---

## 7. Probe 脚本计划

仿 `scripts/probe-wechat-state.cjs`（`app.whenReady` + spawn/IO + 打印 + quit）模式，新增：

| 脚本 | 环境 | 验证项 | 作用 |
|------|------|--------|------|
| `scripts/probe-subagent-claude-version.cjs` | A | V-CC-01 | spawn `claude --version`，打印原始 + 解析结果 |
| `scripts/probe-subagent-claude-stream.cjs` | A | V-CC-09/10/11/12 | spawn `claude -p --output-format stream-json ...`，发 task，dump 全部 stdout 事件行 |
| `scripts/probe-subagent-claude-control.cjs` | A | V-CC-02/03 | `--permission-mode default`，触发工具调用，观察 control_request，回写 control_response |
| `scripts/probe-subagent-claude-inquiry.cjs` | A | V-CC-13 | 触发 AskUserQuestion，dump 事件，试回写 |
| `scripts/probe-subagent-codex-version.cjs` | B | V-CX-01 | `codex --version` |
| `scripts/probe-subagent-codex-appserver.cjs` | B | V-CX-02/03/04/05/06/07/17 | 启 app-server，握手 + thread/start + turn/start，dump 全部 notification/server-request，验证分帧 |
| `scripts/probe-subagent-codex-elicitation.cjs` | B | V-CX-09 | 触发 elicitation，dump + 回写 |
| `scripts/probe-subagent-codex-models.cjs` | B | V-CX-10/11 | `codex debug models --bundled`，dump + 解析 |
| `scripts/probe-subagent-procgroup.cjs` | B | V-Xplat-01 | Unix 下 `detached + kill(-pid)` 杀孙进程 probe，`ps` 确认无残留（**不改 spawnUtil**，仅验证方案） |

脚本规范：
- 每个 probe 脚本聚焦一个协议点，输出「原始协议帧 + 解析结论」。
- 顶部注释标注：验证的 V 编号、所属环境（A/B）、实测 CLI 版本、运行方式、预期输出。
- 不依赖 SpaceAssistant 业务代码，仅用 Node 内置 `child_process` + 可选 `electron`（需读 userData 时）。
- 归档至 `scripts/probe-subagent-*.cjs`，统一提交到代码库（A 为权威）；环境 B 脚本由 B 机器 `git pull` 后运行，作为版本升级时的回归基线。

---

## 8. 分阶段执行计划（环境 A / B 拆分）

验证按两个环境分阶段推进。**环境 A（本机 Windows）先行且可独立交付里程碑 A**；**环境 B（另一台机器）就绪后推进，交付里程碑 B**。两环境在 B 机器就绪后可并行。

### 8.1 阶段总览

| 阶段 | 环境 | 产出 | 阻断 / 门禁 |
|------|------|------|-------------|
| 1A.0 | A | claude 已就绪（v2.1.207），冒烟确认鉴权（A-0） | 阻断 1A.3 |
| 1A.1 | A | 代码集成验证 V-SA-*（不依赖 CLI，**立即可启**） | 🔴 V-SA-02 / V-SA-07 须定论并修订设计 |
| 1A.2 | A | Windows 进程验证 V-Xplat-02 / 03（纯验证现有行为，**不改代码**） | 验证 .cmd shim 无黑窗 + taskkill 杀孙进程 |
| 1A.3 | A | Claude 协议 V-CC-*（依赖 1A.0） | 🔴 V-CC-02 / V-CC-03 阻断里程碑 A |
| 1A.4 | A | Claude 侧安全 V-Sec-01(Claude) / 02..06 | — |
| **门禁 A** | A | **里程碑 A（Claude Code 后端）编码** | 1A.1 / 1A.3 的 P0 项 ✅ |
| 2B.0 | B | 安装 codex + 鉴权 + 同步代码库 + build（B-0） | 阻断 2B.1 |
| 2B.1 | B | Codex 协议 V-CX-*（依赖 2B.0） | 🔴 V-CX-06 / V-CX-07 / V-CX-17 阻断里程碑 B |
| 2B.2 | B | Unix 进程组方案验证 V-Xplat-01（独立 probe，**不改 spawnUtil**）/ 04 / 05 | probe 结论阻断里程碑 B 的 spawnUtil 增强编码 |
| 2B.3 | B | Codex 侧安全 V-Sec-01(Codex) | — |
| **门禁 B** | B | **里程碑 B（Codex 后端 + 并行批）编码** | 2B.1 / 2B.2 的 P0 项 ✅ |
| 3C | A | Claude 问询 V-CC-13 + 增强（依赖门禁 A） | 决定 Claude 问询是否实现 |

### 8.2 阶段 1 · 环境 A（本机 Windows）

```
1A.0  claude 已就绪（v2.1.207）+ 鉴权冒烟 ─────────────┐
                                                       │(不依赖 CLI，与 1A.0 并行)
1A.1  代码集成验证 V-SA-01..12 ◀────────────────────────┤
        🔴 V-SA-02 问询通道方案定稿（修订 DD-3）
        🔴 V-SA-07 并行批可行性结论（修订 DD-2）
1A.2  Windows 进程验证（纯验证，不改 spawnUtil）
        V-Xplat-02 / V-Xplat-03（.cmd shim 无黑窗 + taskkill 杀孙进程）
1A.3  Claude 协议 probe ◀── 1A.0 就绪
        V-CC-01..17（重点 V-CC-02 授权路径、V-CC-03 事件结构、V-CC-13 问询）
1A.4  Claude 侧安全 V-Sec-01(Claude) / 02..06
        │
        ▼
   【门禁 A】-> 里程碑 A 编码（Claude Code 后端 + 执行器 + 卡片 + 配置）
```

**1A.1 是阶段 1 的首批工作**：纯代码阅读 + 单测，不依赖任何 CLI，A-0 完成前即可推进。其两个 🔴 产出（V-SA-02 问询通道方案、V-SA-07 并行批可行性）是后续编码的前置设计决策。

### 8.3 阶段 2 · 环境 B（另一台机器，Codex + Unix）

可与 1A.1 / 1A.3 并行（B 机器就绪后）。需先同步代码库以编译运行 probe 与集成测试。

```
2B.0  安装 codex + 鉴权 + 同步代码库 + npm build
        │
2B.1  Codex 协议 probe ◀── 2B.0 就绪
        V-CX-01..18
        🔴 V-CX-06 事件类型全集、V-CX-07 授权 method 全集、V-CX-17 Node 分帧、V-CX-09 elicitation
2B.2  Unix 跨平台（独立 probe，不改 spawnUtil）
        V-Xplat-01(进程组 probe) / V-Xplat-04(macOS Desktop) / V-Xplat-05(nvm/fnm/volta)
2B.3  Codex 侧安全 V-Sec-01(Codex)
        │
        ▼
   【门禁 B】-> 里程碑 B 编码（Codex 后端 + 并行批 + Unix 进程组）
```

### 8.4 跨环境合并与依赖

- **合并点**：V-CC-03（Claude 工具名）+ V-CX-07（Codex 工具名）-> 合并写入 `subagentSecurity.ts` 风险表（DD-4）。须两环境均完成后合并。
- **共享设计**：V-SA-02 问询通道方案同时影响 Claude（3C）与 Codex（2B.1）的问询实现，须在 1A.1 定稿，B 侧编码沿用。
- **并行批**（V-SA-07）：代码在环境 A 实现；涉及双引擎并发的正确性测试须在 B 就绪后于 B 补测。
- **里程碑 A 不依赖 B**：Claude Code 后端可先独立交付；里程碑 B 依赖 B 环境结论。
- **代码同步**：A 为权威代码库，B 通过 git 同步。**spawnUtil 增强属里程碑 B 编码（非验证阶段产物）**，由 2B.2 的进程组 probe 结论指导，编码后 pull 到 B 回归。
- **验证零侵入原则**：验证阶段全程不修改 `electron/`、`src/` 主程序代码；所有验证产出仅为 `docs/develop/` 文档 + `scripts/probe-subagent-*.cjs` 诊断脚本 + 协议结论。主程序代码改动（含 `deserializeToolUseFromDb` 白名单、`filterBuiltinToolsForApi` 签名、`subagentInteractionRegistry`、`spawnUtil` 增强、`toolChatLoop` 并行批等）一律在里程碑 A/B **编码**阶段落地。

### 8.5 门禁规则

- P0 项必须 ✅ 或有明确回退结论，方可进入对应里程碑编码。
- 🔴 高风险项（V-CC-02、V-CC-13、V-CX-06、V-CX-07、V-SA-02、V-SA-07、V-Xplat-01）结论须写入 §9 验证记录并更新设计文档 DD/TVQ。
- **环境切换 / 代码同步时**，须回归本环境已 ✅ 的 P0 项（CLI 版本与 OS 差异可能导致结论失效）。
- B 环境实测结论须回传 A 环境（填入本文件 §9），统一在 A 维护验证记录。

---

## 9. 验证记录模板

每项验证完成后填入：

```
### V-XX-NN　<项名>
- 实测 CLI 版本：claude x.y.z / codex a.b.c
- 验证脚本：scripts/probe-subagent-xxx.cjs
- 实测结果：<原始关键输出摘录 + 结论>
- 结论：✅ 通过 / ⚠️ 需适配 / ❌ 不通过
- 适配/回退动作：<对设计/代码的具体修订>
- 影响的 DD/TVQ：<编号>
```

---

## 10. 风险与回退总览

| 风险 | 环境 | 触发条件 | 回退 |
|------|------|----------|------|
| Claude 交互授权路径不成立（V-CC-02） | A | 实测 `-p` 模式无 control_request，工具自动执行 | ✅ 已核查·假设证伪：方案 A--Claude 降级为 observe-only（`auto`），逐次确认仅 Codex 支持；`confirm` 用 `--disallowedTools` 粗粒度禁高危；修订 DD-1/DD-3 |
| Claude 问询不可转交（V-CC-13） | A | 实测 `-p` 模式 tools 列表无 `AskUserQuestion`，模型无法调用 | ✅ 已核查·不通过：Claude 禁用问询（`--disallowedTools` 防御性保留），里程碑 C 不实现；不影响其他能力（D12） |
| Codex app-server 模式不可用（V-CX-02） | B | 无 stdio JSON-RPC 模式 | 评估 `codex exec` 一次性模式；可能影响 D2，须上报 |
| Codex 事件/方法命名大偏差（V-CX-06/07） | B | 猜想与实测不符 | 按实测重写 CodexBackend 映射；风险表（DD-4）重定 |
| 问询回传通道缺口（V-SA-02） | A | toolConfirmRegistry 布尔限制 | ✅ 已定方案 A：`subagentInteractionRegistry` 中转完整载荷，不新增 IPC 通道 |
| 并行批破坏循环状态（V-SA-07） | A（双引擎测试待 B） | 共享变量交错不安全 | ✅ 已核查：方案 D（先并发 dispatch 再顺序内置 + allSettled 收集）；dispatch 豁免 toolErrorRepeat/break；确认已安全 |
| Unix 孙进程杀不净（V-Xplat-01） | A 代码 / B 实测 | 已确认缺陷 | opt-in `detached` + `kill(-pid)`；或独立 spawn 函数 |
| 持久化字段丢失/超限（V-SA-05/06） | A | 序列化白名单或列限制 | ✅ 已核查：序列化 spread 安全；反序列化 `deserializeToolUseFromDb` 白名单须加 `subagent`；大列表设上限 |

---

*文档结束*

**备注：** 本计划聚焦「验证什么、怎么验证、不通过怎么办」，按环境 A（本机 Windows / Claude + 代码集成）与环境 B（另一台机器 / Codex + Unix）拆分、分阶段执行（§8）。协议结论须锚定实测 CLI 版本；CLI 升级或环境切换时 P0 项须回归。A-0 与 B-0 分别是各自环境协议验证的前置；V-SA-* 代码集成项不依赖 CLI，可在 A 立即启动。
