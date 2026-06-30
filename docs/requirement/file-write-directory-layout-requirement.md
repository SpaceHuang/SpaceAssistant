# 文件写入目录规范 — 产品需求文档

**版本：** 1.0
**日期：** 2026-06-30
**状态：** 待评审
**关联文档：**
- [tools-requirement.md](./tools-requirement.md)（工具安全基线与 write_file/edit_file 执行器）
- [multi-workdir-requirement.md](./multi-workdir-requirement.md)（工作目录 / workDir profile 机制）
- [pathSecurity](../../electron/pathSecurity.ts)（路径遍历防护，本需求复用其沙箱校验）

---

## 目录

1. [概述](#1-概述)
2. [现状评估](#2-现状评估)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [总体架构](#5-总体架构)
6. [数据模型与配置](#6-数据模型与配置)
7. [安全模型：信任边界与防穿越铁律](#7-安全模型信任边界与防穿越铁律)
8. [写入目录确认流](#8-写入目录确认流)
9. [重定向 Hook](#9-重定向-hook)
10. [设置 UI](#10-设置-ui)
11. [边界、回退与兼容](#11-边界回退与兼容)
12. [测试计划](#12-测试计划)
13. [验收标准](#13-验收标准)
14. [实现顺序建议](#14-实现顺序建议)
15. [相关文件](#15-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 的 Agent 在执行过程中会通过 `write_file` 工具生成新文件。当前新文件的落盘路径完全由 LLM 在工具参数 `input.path` 中决定，存在两类问题：

1. **目录混乱**：LLM 可能将不同类型的文件（脚本、文档、配置）散落写入工作目录各处，缺乏组织。
2. **不可控**：用户无法约束"某一类文件应当写入哪个子目录"，也无法在会话级别指定一个统一的写入基准目录。

本需求新增一个**可选**的目录规范设置：开启后，按用户配置的"扩展名 → 子目录"映射关系，把 Agent 新建的文件自动归入约定子目录；并在每个会话首次写入前，让用户确认本次会话的"写入目录"（base）。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 目录整洁 | 新文件按类型自动归入约定子目录，工作目录不再散乱 |
| 用户可控 | 用户在设置中自由配置文件类型与子目录的映射；会话级选定写入基准目录 |
| 安全可期 | LLM 给出的目录部分被代码丢弃，实际落点 100% 由用户配置决定，无法被 `..\..\` 等穿越绕过 |
| 向后兼容 | 总开关默认关闭，关闭时行为与现状完全一致 |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **代码即规则** | 路径重定向的信任源仅为用户配置，LLM 输入只取文件名，不参与路径拼接 |
| **最小作用域** | 仅对 `write_file` 新建文件生效；`edit_file`、覆盖已存在文件不重定向 |
| **双层沙箱** | 写入目录与最终路径均经 `pathSecurity` 校验，不绕过既有防护 |
| **可观测** | 重定向发生时在 `tool_result` 注明，并在系统提示中强化规范，让 Agent 后续行为正确 |
| **向后兼容** | 默认关闭；开启后默认映射可改可删可清空 |

---

## 2. 现状评估

### 2.1 write_file / edit_file 执行路径

- **执行器**：`electron/tools/builtinExecutors.ts`
  - `writeFileExecutor`（`:539`）：从 `input.path` 取相对路径，`:555` 调 `resolveSafePathReal(workDir, rel)` 解析为绝对路径并做沙箱校验；`:559` 判断 `existed`，已存在则要求 `hasBeenRead`。
  - `editFileExecutor`（`:447`）：同构路径解析。
- **路径参数语义**：`input.path` 是相对 `workDir` 的相对路径（也接受绝对路径，由 `resolveSafePath` 归一）。
- **沙箱**：`electron/pathSecurity.ts` 的 `resolveSafePath` / `resolveSafePathReal` 用 `path.relative` 判定 `..` 与绝对路径，阻挡穿越。

### 2.2 工具确认流程

- 主进程 `electron/toolChatLoop.ts` 在执行 executor 前，对需确认的工具发送 IPC `tool:confirm-request`，renderer 弹工具确认卡，用户批准后回传结果再执行。
- **关键约束：确认卡片不可修改工具 `input`。** 因此路径重定向必须在 executor 内部或之前完成，不能依赖确认卡改写参数。

### 2.3 上下文注入机制

- 系统提示注入已存在：`buildFinalSystemPrompt` 可在调用 API 前注入上下文；`recoverySkillSystemSuffix` 等动态后缀机制可参考。本需求复用此通道强化目录规范。

### 2.4 会话文件状态

- `electron/fileStateCache.ts` 的 `getFileStateCacheForSession(sessionId)` 记录本会话已读取文件的绝对路径与内容缓存。本需求从中提取"已读文件所在目录"作为候选目录来源之一。

### 2.5 workDir 机制

- `AppConfig.workDir`（全局）、`AppConfig.workDirProfiles` / `activeWorkDirProfileId`（多 profile）。会话对应的 workDir 在工具循环入口以 `args.workDir` 形式传入。

---

## 3. 目标与非目标

### 3.1 目标

1. 新增设置项 `WorkspaceLayoutConfig`：总开关 `enabled`、首次确认开关 `writeDirConfirmEnabled`、扩展名→子目录映射表 `extensionSubdirMap`。
2. 每会话首次 `write_file`（新建文件）前，向用户确认"写入目录"（base）：给出 A-Z 候选目录 + 一个自定义输入选项，用户选定后锁定到会话。
3. 用户可用自然语言在聊天区重新指定写入目录，触发重新确认。
4. 重定向 Hook：对新建文件，按"用户选定的写入目录 + 扩展名映射"计算规范路径；与 LLM 给出路径不一致时改写 `input.path`，并在 `tool_result` 注明；系统提示强化规范。
5. 设置 UI：独立 Tab「目录规范」，含开关、确认开关、可编辑映射表。
6. 防穿越铁律：LLM 的目录输入被丢弃，实际落点由用户配置决定。

### 3.2 非目标（明确排除）

- **不**做多级子目录（如 `Script/python`）；子目录恒为单层。
- **不**对 `edit_file` 重定向；**不**对覆盖已存在文件重定向。
- **不**拦截 `run_script` / `browser` 截图 / `sessionBackupManager` 备份等非 `write_file` 链路。
- **不**做跨会话的写入目录记忆（每会话独立确认）。
- **不**支持 glob 模式映射（仅扩展名匹配）。
- **不**在工具确认卡中合并承载"选写入目录"（语义不同，独立流）。

---

## 4. 用户故事

| # | 角色 | 故事 |
|---|------|------|
| US1 | 用户 | 我想在设置里开启"目录规范"，让 Agent 生成的 `.py` 文件自动写入 `Script` 子目录，`.md` 写入 `Docs`，保持工作目录整洁。 |
| US2 | 用户 | 开启后，每个会话第一次让 Agent 写文件前，应用弹出一个面板，列出几个候选目录（我最近读过的文件所在目录、对话里提到过的目录、当前工作目录），让我用字母 A/B/C 选一个，或自己输入一个。 |
| US3 | 用户 | 我在聊天里说"把写入目录换成 Docs"，应用让我重新选一次写入目录，之后新文件都写到新目录。 |
| US4 | 用户 | 即使 Agent 在工具参数里写了 `..\..\evil.py`，文件也不会逃出我选定的写入目录与子目录，只会以 `evil.py` 的名字落到正确子目录。 |
| US5 | 用户 | 开关关闭时，Agent 写文件的行为和以前完全一样。 |
| US6 | 用户 | 我能在设置里自由增删改"扩展名→子目录"映射，没配置映射的扩展名直接写到写入目录根。 |

---

## 5. 总体架构

### 5.1 三条主线

1. **设置主线**：`AppConfig.workspaceLayout`（类型 `WorkspaceLayoutConfig`），设置 Tab 编辑。
2. **确认主线**（会话级，首次触发）：新 IPC `file-write-dir:confirm-request` / `file-write-dir:confirm-response`，renderer 独立面板 `WriteDirConfirmPanel`，会话状态存 `Session.metadata.writeDirChoice`。
3. **重定向主线**（每次新建文件）：`toolChatLoop` 在 write_file 执行前调用 `applyWorkspaceLayoutRedirect()`，按"写入目录 + 扩展名映射"计算规范路径，必要时改写 `input.path` 并在 `tool_result` 注明；系统提示注入规范。

### 5.2 模块划分（设计为可独立测试的小单元）

| 单元 | 文件 | 职责 | 依赖 |
|------|------|------|------|
| 配置类型与合并 | `src/shared/domainTypes.ts` | `WorkspaceLayoutConfig`、`DEFAULT_WORKSPACE_LAYOUT_CONFIG`、`mergeWorkspaceLayoutConfig` | 无 |
| 重定向核心 | `electron/workspaceLayout/redirect.ts` | 给定 input / workDir / writeDirChoice / 映射，计算规范路径与改写结果 | `pathSecurity` |
| 候选目录收集 | `electron/workspaceLayout/writeDirCandidates.ts` | 三源合并去重、字母分配、上限截断 | `pathSecurity`、`fileStateCache` |
| 确认流 IPC | `electron/appIpc.ts` + `electron/preload.ts` | 收发确认请求/响应、持久化 `writeDirChoice` | DB、`writeDirCandidates` |
| 重定向接入 | `electron/toolChatLoop.ts` | 在 executor 调用前调重定向、衔接冲突检测、注入 tool_result、强化系统提示 | `redirect.ts` |
| 设置 Tab | `src/renderer/components/Config/WorkspaceLayoutTab.tsx` | 开关 + 映射表编辑 | Config 表单组件 |
| 确认面板 | `src/renderer/components/Chat/WriteDirConfirmPanel.tsx` | A-Z 单选 + 自定义输入 | Ant Design |

每个单元职责单一、接口明确，可独立单测。

### 5.3 作用域边界

- **生效**：`write_file` 且目标文件不存在（新建）。
- **不生效**：`edit_file`、覆盖已存在文件、`read_file` / `list_directory` / `grep` / `run_script` / `browser` / 备份等所有其他链路。

---

## 6. 数据模型与配置

### 6.1 新增配置类型

加到 `src/shared/domainTypes.ts`，与 `ToolsConfig` 平级：

```ts
export interface ExtensionSubdirMapEntry {
  /** 不含点，小写，如 "py"、"md" */
  extension: string
  /** 单层名，如 "Script"、"Docs"；不含路径分隔符 */
  subdir: string
}

export interface WorkspaceLayoutConfig {
  /** 总开关，默认 false */
  enabled: boolean
  /** 首次写入前确认写入目录（仅 enabled 为 true 时生效），默认 true */
  writeDirConfirmEnabled: boolean
  /** 扩展名 → 子目录映射 */
  extensionSubdirMap: ExtensionSubdirMapEntry[]
}

export const DEFAULT_WORKSPACE_LAYOUT_CONFIG: WorkspaceLayoutConfig = {
  enabled: false,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [
    { extension: 'py', subdir: 'Script' },
    { extension: 'js', subdir: 'Script' },
    { extension: 'ts', subdir: 'Script' },
    { extension: 'tsx', subdir: 'Script' },
    { extension: 'jsx', subdir: 'Script' },
    { extension: 'sh', subdir: 'Script' },
    { extension: 'md', subdir: 'Docs' },
    { extension: 'json', subdir: 'Config' }
  ]
}

export function mergeWorkspaceLayoutConfig(
  partial?: Partial<WorkspaceLayoutConfig> | null
): WorkspaceLayoutConfig {
  if (!partial || typeof partial !== 'object') {
    return { ...DEFAULT_WORKSPACE_LAYOUT_CONFIG, extensionSubdirMap: [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap] }
  }
  return {
    ...DEFAULT_WORKSPACE_LAYOUT_CONFIG,
    ...partial,
    extensionSubdirMap: Array.isArray(partial.extensionSubdirMap)
      ? partial.extensionSubdirMap.map((e) => ({ ...e }))
      : [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap]
  }
}
```

`AppConfig` 增字段：`workspaceLayout: WorkspaceLayoutConfig`。读取旧 DB（无该字段）时由 `mergeWorkspaceLayoutConfig` 兜底，向后兼容。

### 6.2 会话级状态

存 `Session.metadata`：

```ts
// Session.metadata.writeDirChoice?: { dir: string; confirmedAt: number } | null
```

- `dir`：用户选定的写入目录**绝对路径**，必须是 workDir 内的目录或 workDir 本身。
- `null` / `undefined`：本会话尚未确认。首次 write_file 前检测到此状态即触发确认流。

### 6.3 匹配规则（扩展名 → 子目录）

1. 从 `input.path` 取 `path.extname()` → 去前导点 → `.toLowerCase()`。
2. 查 `extensionSubdirMap`（大小写归一比较）。
3. **命中**：`subdir = entry.subdir`，规范路径 = `resolveSafePath(writeDirChoice.dir, path.join(subdir, basename))`。
4. **未命中**：`subdir = ''`，规范路径 = `resolveSafePath(writeDirChoice.dir, basename)`（落写入目录根，保留文件名，**丢弃 LLM 给的中间目录**）。
5. **取最后一个扩展名**：遵循 `path.extname` 语义（如 `a.py.bak` → `bak`），确定无歧义。
6. **已合规**：若规范路径与 LLM 给的路径（归一后）一致，则不改写，不附加提示（减少噪声）。

### 6.4 与 pathSecurity 沙箱的兼容

- 用户选定的 `writeDirChoice.dir` 先经 `resolveSafePathReal(workDir, 用户输入)` 校验落在 workDir 内，否则确认流拒绝该选项。
- 重定向后的规范路径再走 executor 内原有的 `resolveSafePathReal(workDir, ...)`（`builtinExecutors.ts:555`）。
- 双层校验，不绕过沙箱。

---

## 7. 安全模型：信任边界与防穿越铁律

重定向逻辑的信任源严格限定为两处，**LLM 的 `input.path` 只用于提取文件名，不参与路径拼接**。

### 7.1 信任源

| 信任源（参与拼接） | 不信任源（只读取） |
|---|---|
| 用户设置里 `extensionSubdirMap`（决定 subdir） | LLM 给的 `input.path` |
| 用户确认流选定的 `writeDirChoice.dir`（决定 base） | — |

### 7.2 防穿越措施（全部走代码逻辑，不靠提示词）

1. **从 `input.path` 只取两样东西**：`path.extname()`（决定扩展名）与 `path.basename()`（文件名）。**丢弃 LLM 给的一切目录部分** —— 这是防穿越的核心。
2. **basename 净化**：校验 `basename` 不为 `.`、`..`、空，且不含路径分隔符（`/`、`\`）与空字节；否则拒绝写入并返回错误（走 `tool_result`，让 LLM 重试）。Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM*`/`LPT*`）一并拒绝。
3. **规范路径完全由代码决定**：`canonical = resolveSafePath(writeDirChoice.dir, path.join(subdir, sanitizedBasename))`。`subdir` 来自用户映射表（保存时校验为单层名、不含 `/`、`\`、`..`）；`basename` 已净化。LLM 无法影响拼接。
4. **双层沙箱**：
   - 用户选定的 `writeDirChoice.dir` 先经 `resolveSafePathReal(workDir, 用户输入)` 校验落在 workDir 内，否则确认流直接拒绝该选项；
   - 重定向后的 `canonical` 再走 executor 内原有的 `resolveSafePathReal(workDir, ...)`（`builtinExecutors.ts:555`）；
   - 两层都用 `path.relative` 判 `..`/绝对路径，`..\..\` 这类必被挡。
5. **扩展名比较大小写归一**：`path.extname` 结果去前导点后 `.toLowerCase()` 再查映射表；映射表自身的 `extension` 字段在保存时统一小写。
6. **LLM 即使给 `..\..\evil.py`**：`basename = evil.py`，`subdir = Script`（由扩展名 `py` 决定），最终 `canonical = {writeDirChoice}\Script\evil.py`，穿越片段被彻底丢弃，且二次沙箱校验兜底。

> **结论**：只要开关开启且会话已锁定写入目录，新建文件的实际落点 100% 由用户配置 + 用户选中目录决定，LLM 写什么路径都改不了落点，只能改文件名。

---

## 8. 写入目录确认流

### 8.1 触发时机

`toolChatLoop` 在 write_file 执行前、重定向逻辑判定为"新建文件"（目标不存在）后，检测到 `workspaceLayout.enabled && writeDirConfirmEnabled && Session.metadata.writeDirChoice == null` 时，在执行 executor 前插入确认（挂起本次 write_file，等待用户响应）。

> 说明：确认流仅在"新建文件"时触发；若本次 write_file 是覆盖已存在文件（不重定向），则不触发确认，按原路径执行。整个会话若只覆盖文件不新建文件，确认流不触发。

### 8.2 候选目录收集

新模块 `electron/workspaceLayout/writeDirCandidates.ts`：

1. **已读文件所在目录**：从 `getFileStateCacheForSession(sessionId)` 取所有已缓存文件绝对路径，取其 `dirname`，去重。
2. **用户消息中出现的有效路径**：扫描本会话历史 `user` 消息文本，正则提取形似路径的片段（如 `E:\...`、`./foo/bar`、`foo/bar`）；对每个，`resolveSafePathReal(workDir, 片段)` 校验 —— 若解析后是 workDir 内**已存在的目录**，纳入候选。
3. **当前 workDir 本身**：作为兜底候选。

**合并与编号**：
- 三源合并去重（按规范化绝对路径）。
- 候选目录按字母 A、B、C… 编号，**上限 25**（保留一个位置给自定义选项）；超出截断并在面板提示"仅显示前 25 个候选目录"。
- **自定义选项不分配字母**，固定显示在列表末尾，标签为「自定义输入目录」；用户手输路径，提交时同样经 `resolveSafePathReal(workDir, 输入)` 校验，不合法则面板内报错、不关闭。

### 8.3 IPC（新增）

定义在 `electron/preload.ts` 与 `electron/appIpc.ts`：

- 主→渲：`file-write-dir:confirm-request`，载荷 `{ requestId, sessionId, candidates: [{ key: 'A', dir, label }, ...], customOption: true }`。
- 招→主：`file-write-dir:confirm-response`，载荷 `{ requestId, sessionId, choice: { type: 'candidate', key: 'A' } | { type: 'custom', dir: '...' } }`。
- 主进程收到后写 `Session.metadata.writeDirChoice = { dir, confirmedAt }` 并持久化（走现有 DB `save()`），随后继续被挂起的 write_file 执行。

### 8.4 确认面板

新增 `src/renderer/components/Chat/WriteDirConfirmPanel.tsx`（不复用工具确认卡）：
- 单选 A-Z 候选 + 自定义输入框 + 确认/取消。
- 自定义输入提交时前端做形似校验，最终以主进程 `resolveSafePathReal` 为准；不合法则面板内报错、不关闭。
- 取消：该次 write_file 返回错误"未选择写入目录，已取消"，不落盘。

### 8.5 重新指定（自然语言触发）

用户在聊天区用自然语言（如"把写入目录换成 Docs"）触发：
- 由系统提示引导 LLM 识别该意图，LLM 发起一次重新确认（清空 `Session.metadata.writeDirChoice` 后重新走 §8 确认流）。
- **不额外加 UI 按钮**，重选仅靠自然语言触发。

---

## 9. 重定向 Hook

### 9.1 落点

`toolChatLoop.ts` 在 write_file executor 调用前（`exec.execute(inputObj, ctx)` 之前，约 `builtinExecutors.ts:555` 路径解析之前），插入 `applyWorkspaceLayoutRedirect()`。新模块 `electron/workspaceLayout/redirect.ts`：

```ts
export interface RedirectOutcome {
  redirected: boolean
  newPath?: string                 // 改写后的 input.path（相对 workDir）
  originalPath?: string
  reason?: string                  // 进 tool_result 的提示
  reject?: boolean                 // basename 净化失败时拒绝执行
  rejectReason?: string
}

export async function applyWorkspaceLayoutRedirect(args: {
  toolName: string
  input: Record<string, unknown>
  workDir: string
  sessionId: string
  workspaceLayout: WorkspaceLayoutConfig
  writeDirChoice: { dir: string } | null
}): Promise<RedirectOutcome>
```

### 9.2 执行逻辑（按顺序）

1. **前置门**：`!workspaceLayout.enabled` → `{ redirected: false }`（功能关）。`edit_file` 直接返回。非 write_file 返回。
2. **目标已存在则跳过**：`pathExists(resolveSafePathReal(workDir, input.path))` 为 true → `{ redirected: false }`（覆盖已存在文件不重定向；同时保证只在新建文件时重定向）。
3. **写入目录未锁定的处理**（确认流衔接）：
   - 若 `writeDirConfirmEnabled && writeDirChoice == null` → 触发 §8 确认流，拿到 `writeDirChoice.dir` 后继续；
   - 若 `writeDirConfirmEnabled == false`（开关开但不要求确认）→ `writeDirChoice.dir = workDir`（默认用当前工作目录），直接用。
4. **取扩展名**：`path.extname(input.path)` → 去点 → `.toLowerCase()`。未命中映射 → `subdir = ''`（落根）；命中 → `subdir = entry.subdir`。
5. **取并净化 basename**（§7 铁律）：`basename = path.basename(input.path)`；校验非 `.`/`..`/空、无分隔符、无空字节、非 Windows 保留名；否则返回 `{ redirected: false, reject: true, rejectReason: '...' }`。
6. **拼规范路径**：`canonical = path.join(writeDirChoice.dir, subdir, basename)`，再 `relToWorkDir = path.relative(workDir, canonical)`。
7. **与原路径比较**：`relToWorkDir === normalizeRelPathInput(input.path)` → 已合规，`{ redirected: false }`（不附带提示）。否则 `{ redirected: true, newPath: relToWorkDir, originalPath: input.path, reason: '已按目录规范重定向: <原> → <新>' }`。
8. **改写 input**：把 `inputObj.path = newPath` 写回 `toolChatLoop` 里的 `inputObj`（在调用 `exec.execute(inputObj, ctx)` 之前）。

### 9.3 拒绝路径

basename 净化失败（第 5 步）：**不执行 write_file**，直接 `toolResults.push(buildToolErrorResult(toolUseId, rejectReason))` 并 `send('tool:result', ...)`，跳过本次 executor 调用（等价 Hook 拦截）。

### 9.4 tool_result 反馈

重定向发生时，executor 正常返回后，在原有 tool_result 文本后追加：

```
[目录规范] 路径已从 {originalPath} 重定向到 {newPath}（依据扩展名→子目录映射）。
后续请按规范直接写入 {writeDirChoice.dir}\{subdir}（或 {writeDirChoice.dir} 根，未映射扩展名）。
```

对应决策"改写 + 明确提示"。

### 9.5 系统提示强化

`buildFinalSystemPrompt` 注入（开关开且已锁定时）：

```
当前会话已启用目录规范。新建文件写入目录为：{writeDirChoice.dir}。
文件按扩展名归入子目录：
- *.py → Script
- *.md → Docs
- ...（从 extensionSubdirMap 动态生成）
未映射的扩展名直接写入 {writeDirChoice.dir} 根。
请直接按规范路径写入，不要使用 .. 或绝对路径绕过；目录部分将由系统按规范重定向。
```

### 9.6 与现有机制的衔接

- **`checkWritePathConflict` / `claimWritePath`**（`toolChatLoop.ts:1210`）：重定向改写 `input.path` 后，**必须用 `newPath` 调用**，否则冲突检测对的是 LLM 给的旧路径，会漏判。顺序：① 应用重定向得到 `newPath` → ② 用 `newPath` 做冲突检测与 claim → ③ 执行 executor。
- **`fileStateCache`**：重定向只影响新建文件；新建文件 `existed=false`，不触发"未读先写"错误，兼容。
- **`writeFileAutoApproval`**：auto 模式下 write_file 仍走自动批准；auto-approve 的 diff 预览应基于**重定向后的 `newPath`**，否则用户看到的 diff 路径与实际落点不一致。需在 auto-approve 流程中传入 `newPath`。
- **工具确认卡（`tool:confirm-request`）**：确认卡展示的路径需为 `newPath`（重定向后）。顺序：重定向 → 再生成确认卡 diff。用户批准的就是真实落点。
- **文件树刷新**（`toolChatLoop.ts:1421`）：文件树变更通知用 `newPath`，文件树正确高亮新位置。

---

## 10. 设置 UI

### 10.1 位置

设置弹窗归入 `toolsSettingsNav`，新增 nav 项「目录规范」（key `workspaceLayout`），与 `file` / `script` / `shell` / `browser` 平级，作为「工具」设置区下的子 Tab。理由：该功能是工具写入行为的扩展，归属工具设置语义最贴近，同时保持独立 Tab 避免与现有 Tools Tab 混杂。

### 10.2 Tab 组件

`src/renderer/components/Config/WorkspaceLayoutTab.tsx`，沿用 `ConfigField.tsx` 现有表单组件与 Ant Design。

### 10.3 界面结构

1. **总开关** `enabled`（Switch）：关闭时整个 Tab 其余项禁用置灰。关闭即完全旁路，行为与现状一致。
2. **首次写入前确认写入目录** `writeDirConfirmEnabled`（Switch，默认开）：仅 `enabled` 为 true 时可编辑。副文案说明"每会话首次新建文件前弹出候选目录选择"。
3. **扩展名 → 子目录映射表**（可编辑表格，Ant Design `Table` + 行内编辑/增删）：
   - 列：`扩展名`（如 `py`，输入时自动去点、转小写）、`子目录`（如 `Script`，单层名）、操作（删除）。
   - 底部「+ 新增映射」按钮追加空行。
   - 前端校验：扩展名非空、仅字母数字；子目录非空、不含 `/`、`\`、`..`、空字节；重复扩展名高亮提示（保存时去重保留最后一条）。
   - 预置默认映射（§6.1），用户可改可删可清空（清空 = 所有文件落根）。
4. **说明区**：简短文字解释匹配规则与安全说明：
   - "取文件最后一个扩展名；未命中映射的文件直接写入所选目录根；仅对新建文件生效，编辑已有文件不重定向。"
   - "LLM 给的目录会被丢弃，实际落点由你选定的目录与映射决定。"

### 10.4 数据流

- Tab 内部维护本地编辑态，「保存」时走 `configModalSnapshot.ts` 同款模式：把 `workspaceLayout` 整体并入 snapshot，提交时 `window.api.config:set({ workspaceLayout })`。
- 经 `mergeWorkspaceLayoutConfig` 合并；数组字段单独浅拷贝，避免引用污染。

### 10.5 会话级写入目录显示（只读 chip）

聊天区顶部或工具栏显示当前会话锁定的写入目录（如"写入目录：E:\proj\Script"），仅展示不可点击编辑（重选走自然语言，§8.5）。纳入本期，作为只读 chip，让用户可见锁定状态。

### 10.6 i18n

遵循 CLAUDE.md 的 i18n 规范：
- 新增 key 命名空间 `settings.workspaceLayout.*`（开关、映射表列名、说明文案、确认面板文案等）。
- `zh-CN` 为真实来源；保存后运行 `npm run i18n:generate-types` 更新类型，`npm run i18n:check` 校验。
- 确认面板文案归入 `chat.writeDirConfirm.*` 命名空间。

---

## 11. 边界、回退与兼容

### 11.1 作用域与边界

- **生效**：`write_file` 且目标不存在（新建）。
- **不在作用域**：`run_script` 写出的临时脚本、`browser` 截图落盘、`sessionBackupManager` 备份等非 write_file 工具链路（它们走各自独立路径，不经过 `applyWorkspaceLayoutRedirect`）。

### 11.2 回退与失败行为

| 场景 | 行为 |
|---|---|
| `enabled=false` | 全程旁路，行为同现状 |
| `enabled=true` 但映射表为空 | 所有新建文件落 `writeDirChoice.dir` 根（等价"只规范写入目录，不分子目录"） |
| `writeDirConfirmEnabled=true` 且用户取消确认面板 | 该次 write_file 返回错误"未选择写入目录，已取消"，不落盘；LLM 可重试或等用户重选 |
| basename 净化失败（`..`/分隔符/保留名） | 拒绝执行，tool_result 报错，不落盘 |
| 重定向后路径二次沙箱校验失败（理论不应发生） | 兜底拒绝，tool_result 报错"路径规范校验失败" |
| 确认流 IPC 超时（用户长时间不响应） | 沿用现有 `waitForToolConfirm` 的超时/取消机制；超时按"取消"处理 |
| 会话已有 `writeDirChoice` 但目录已被删除/不可写 | executor 原有写入失败逻辑接管（`fs.writeFile` 抛错 → tool_result 错误） |

### 11.3 workDir 切换兼容

会话级 `writeDirChoice.dir` 是绝对路径。若用户中途切换 workDir profile，原 `writeDirChoice.dir` 可能落在新 workDir 外。处理：**profile 切换或会话 workDir 变更时，清空 `Session.metadata.writeDirChoice`**（下次写入重新确认），并在系统提示中移除规范段。

### 11.4 与现有机制兼容

- `checkWritePathConflict` / `claimWritePath`：用重定向后的 `newPath` 调用，不破坏并发冲突检测。
- `fileStateCache`：重定向只针对新建文件，`existed=false` 分支不要求 `hasBeenRead`，兼容。
- `writeFileAutoApproval`：auto-approve 的 diff 预览基于 `newPath`。
- 工具确认卡：展示 `newPath`，重定向先于确认卡生成。
- 文件树刷新：用 `newPath` 触发变更通知。

---

## 12. 测试计划

### 12.1 单元测试（node 环境）

- `electron/workspaceLayout/redirect.test.ts`：
  - **防穿越**：`..\..\x.py`、绝对路径 `/etc/x.py`、`a/../b.py` → basename 净化 + 落点正确。
  - **扩展名匹配**：`py→Script`、大小写归一（`.PY`）、未命中落根、`a.py.bak`→`bak`。
  - **作用域**：edit_file 不重定向、覆盖已存在文件不重定向。
  - **开关关闭**：全程旁路。
  - **已合规**：LLM 给的路径已符合规范时不改写、不附加提示。
  - **拒绝路径**：basename 为 `..`、含分隔符、Windows 保留名 → 拒绝执行。
- `electron/workspaceLayout/writeDirCandidates.test.ts`：三源合并去重、字母分配、上限 26 截断、自定义选项。

### 12.2 集成测试（node 环境）

- `electron/toolChatLoop.workspaceLayout.test.ts`：
  - 重定向与 `checkWritePathConflict` / `claimWritePath` 用 `newPath`。
  - tool_result 提示注入正确。
  - 确认流衔接（writeDirChoice 为空时触发确认、确认后续执行）。
  - 系统提示强化段在开关开启且锁定时注入、关闭时不注入。

### 12.3 渲染进程测试（jsdom）

- `WriteDirConfirmPanel.test.tsx`：候选单选、自定义输入校验、取消返回错误。
- `WorkspaceLayoutTab.test.tsx`：映射表增删改、前端校验（重复扩展名、非法子目录）、总开关关闭置灰。
- 只读 chip：会话锁定写入目录时正确显示。

### 12.4 安全专项测试

- 穿越路径全集回归（`..\..\`、`/etc/`、`a/../b`、绝对路径、UNC 路径 `\\host\share` 等），纳入安全测试套件，确保不逃出 `writeDirChoice.dir\{subdir}`。

---

## 13. 验收标准

| # | 验收项 | 验证方式 |
|---|--------|----------|
| AC1 | 开关关闭时，write_file 行为与现状完全一致 | 关闭开关，执行 write_file，路径不被改写、无 tool_result 提示 |
| AC2 | 开关开启、已配置 `py→Script`，会话已锁定写入目录 `D:\proj`：Agent write_file `foo.py` 实际落 `D:\proj\Script\foo.py` | 检查文件树与磁盘 |
| AC3 | Agent write_file `..\..\evil.py`，实际落 `D:\proj\Script\evil.py`，不逃出 | 安全专项测试 |
| AC4 | 每会话首次 write_file 前弹出确认面板，候选含已读文件目录、用户消息中路径、workDir，外加自定义 | 手动 + 单测 |
| AC5 | 用户在聊天区说"把写入目录换成 Docs"，触发重新确认 | 手动 |
| AC6 | edit_file 与覆盖已存在文件不被重定向 | 单测 |
| AC7 | 未命中映射的扩展名（如 `.log`）直接落写入目录根 | 单测 |
| AC8 | 设置 Tab 可增删改映射，保存后生效；前端校验非法输入 | 渲染进程测试 |
| AC9 | workDir profile 切换后 `writeDirChoice` 被清空，下次写入重新确认 | 集成测试 |
| AC10 | tool_result 注明重定向信息；系统提示在锁定后包含规范段 | 集成测试 |
| AC11 | i18n：所有新增文案经 `t()`，`npm run i18n:check` 通过 | CI |

---

## 14. 实现顺序建议

供 writing-plans 阶段拆分：

1. 配置类型 + `mergeWorkspaceLayoutConfig` + 默认映射 + DB 迁移兼容。
2. `redirect.ts` + 单测（纯函数，最易测）。
3. `writeDirCandidates.ts` + 单测。
4. `toolChatLoop` 接入（重定向 + 冲突检测衔接 + tool_result 注入 + 系统提示）。
5. 确认流 IPC + `WriteDirConfirmPanel` + 会话状态持久化。
6. 设置 Tab + i18n + 只读 chip。
7. 集成测试 + 安全回归。

---

## 15. 相关文件

### 15.1 现有文件（修改）

| 文件 | 改动 |
|------|------|
| `src/shared/domainTypes.ts` | 新增 `WorkspaceLayoutConfig` 等类型与 `mergeWorkspaceLayoutConfig`；`AppConfig` 增 `workspaceLayout` 字段 |
| `electron/pathSecurity.ts` | 复用（不改）；重定向双层沙箱依赖之 |
| `electron/tools/builtinExecutors.ts` | 无需改（重定向在 toolChatLoop 层完成）；保留 `:555` 沙箱校验 |
| `electron/toolChatLoop.ts` | 在 write_file executor 调用前接入 `applyWorkspaceLayoutRedirect`；衔接冲突检测/claim/文件树刷新；注入 tool_result；强化系统提示 |
| `electron/appIpc.ts` + `electron/preload.ts` | 新增 `file-write-dir:confirm-request` / `confirm-response` IPC 通道与处理器 |
| `src/shared/api.ts` | 新增确认响应 API 类型 |
| `src/renderer/components/Config/ConfigModal.tsx` | 新增「目录规范」Tab 入口 |
| `src/renderer/components/Config/toolsSettingsNav.ts` | 新增 nav 项（或顶层 nav） |
| `src/renderer/components/Config/configModalSnapshot.ts` | snapshot 纳入 `workspaceLayout` |
| `src/renderer/i18n/resources/zh-CN/` | 新增 `settings.workspaceLayout.*` 与 `chat.writeDirConfirm.*` key |

### 15.2 新增文件

| 文件 | 职责 |
|------|------|
| `electron/workspaceLayout/redirect.ts` | 重定向核心 |
| `electron/workspaceLayout/redirect.test.ts` | 单测 |
| `electron/workspaceLayout/writeDirCandidates.ts` | 候选目录收集 |
| `electron/workspaceLayout/writeDirCandidates.test.ts` | 单测 |
| `electron/toolChatLoop.workspaceLayout.test.ts` | 集成测试 |
| `src/renderer/components/Config/WorkspaceLayoutTab.tsx` | 设置 Tab |
| `src/renderer/components/Config/WorkspaceLayoutTab.test.tsx` | 渲染进程测试 |
| `src/renderer/components/Chat/WriteDirConfirmPanel.tsx` | 确认面板 |
| `src/renderer/components/Chat/WriteDirConfirmPanel.test.tsx` | 渲染进程测试 |
