# run_shell 命令输出实时展示 — 产品需求

**版本：** 1.0
**日期：** 2026-05-31
**状态：** 已实现

**后续增强：** [shell-output-terminal-enhancement-requirement.md](./shell-output-terminal-enhancement-requirement.md)（Phase 2：ANSI 颜色、`\r` 进度条、xterm scrollback；**pipe 执行，不做 PTY**）

**关联文档：**
- [shell-command-tool-requirement.md](./shell-command-tool-requirement.md)（run_shell 工具定义、执行流程、安全机制）
- [chat-message-ui-requirement.md](./chat-message-ui-requirement.md)（工具卡片与确认 UI）
- [tools-requirement.md](./tools-requirement.md)（内置工具框架、确认机制）

---

## 目录

1. [概述](#1-概述)
2. [现状与差距](#2-现状与差距)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [数据流设计](#5-数据流设计)
6. [UI 设计](#6-ui-设计)
7. [实现要点](#7-实现要点)
8. [验收标准](#8-验收标准)

---

## 1. 概述

### 1.1 背景

`run_shell` 工具在执行过程中会通过 `ctx.sendProgress()` 实时推送 stdout/stderr 输出（最近 4000 字符尾部）。然而，当前渲染进程的 `chatToolSessionService.ts` 收到 `tool:progress` 事件后**丢弃了 `message` 字段**（仅用于将状态置为 `executing`），导致用户**看不到命令的实时输出**。

同时，命令执行完成后，展开卡片中显示的是 `JSON.stringify(result.data)` 的完整 JSON 对象，而非格式化的 stdout/stderr 输出，可读性差。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 执行过程透明 | 用户可实时观察命令输出，了解执行进度（如 `npm install` 的下载进度） |
| 排障效率提升 | 命令失败时，stderr 可直接在卡片中查看，无需打开外部日志文件 |
| 减少焦虑 | 长时间命令（如构建）有输出反馈，用户不会误以为卡死 |
| 与终端体验一致 | 在聊天界面内提供接近终端的使用体验 |

---

## 2. 现状与差距

### 2.1 现有数据流

```
runShellExecutor.ts                    toolChatLoop.ts                   chatToolSessionService.ts        ToolCallCard.tsx
─────────────────                    ──────────────                   ──────────────────────────        ────────────────
spawn 进程                           收到 sendProgress 回调            收到 tool:progress IPC 事件        渲染卡片
  ↓                                     ↓                                ↓                                  ↓
stdout/stderr 实时累积                  sender.send(                      onProgress():                     显示逻辑：
  ↓                                    'tool:progress',                   ✅ 设置 status='executing'        • executing: 2s 后显示
ctx.sendProgress('shell',              { status, message })               ❌ void d.message                  "仍在运行…"
  stdout+stderr 尾部 4000 字符)                                            ❌ void d.status                 • completed: 显示
  ↓                                                                                                        resultStr（JSON）
proc.on('close') →                                                                                        • 仅输出被截断时显示
  resolve({ data: { stdout,                                                                                 "打开完整日志" 按钮
  stderr, exitCode, ... } })
```

### 2.2 具体差距

| # | 差距 | 影响 |
|---|------|------|
| G1 | `chatToolSessionService` 丢弃 `tool:progress` 的 `message` 字段 | 执行中的实时输出无法到达 UI |
| G2 | `ToolCallRecord` 缺少存储进度输出的字段 | 即使 progress 数据到达，也无处存储 |
| G3 | `ToolCallCard` 在执行中仅显示「仍在运行…」 | 用户看不到 `npm install` 等命令的实时日志 |
| G4 | 完成后展开卡片显示 `JSON.stringify(result.data)` 原始 JSON | stdout/stderr 混在 JSON 中，可读性差 |
| G5 | 完成后，只读命令（`git status` 等）默认折叠 | 用户需要手动展开才能看到输出，且展开后看到的仍是 JSON |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| O-01 | 命令执行期间，展开卡片中**实时展示** stdout/stderr 输出（滚动跟随最新内容） |
| O-02 | 命令执行完成后，展开卡片中**格式化展示** stdout/stderr（区分 stdout 和 stderr） |
| O-03 | 退出码非零时，stderr 内容醒目展示（红色或警告样式） |
| O-04 | 输出被截断时，提供「打开完整日志」入口（复用现有 `persistedOutputPath` 机制） |
| O-05 | 只读命令（`git status` 等）完成后，**自动展开**显示输出（而非默认折叠） |
| O-06 | 输出区域支持滚动，最大高度受限（避免撑爆聊天界面） |

### 3.2 非目标

| 项 | 说明 |
|----|------|
| ANSI 颜色转义 | MVP 不做终端颜色渲染，原始文本展示；Phase 2 可考虑 |
| 终端级交互 | 不支持 stdin 交互，仅展示只读输出 |
| 输出搜索/过滤 | 不在卡片内提供搜索功能 |
| 流式进度条解析 | 不做 `\r` 覆盖行的进度条渲染（如 `[====>] 50%`） |

---

## 4. 用户故事

### US-01：实时查看命令执行进度

**作为开发者**，当 Agent 执行 `npm install` 时，我展开工具卡片，希望能看到实时的安装日志滚动输出，而不是只显示「仍在运行…」——这样我才能判断进度和是否有异常。

### US-02：查看已完成命令的完整输出

**作为开发者**，当 `git status` 执行完成后，我希望卡片自动展开并显示 `git status` 的实际输出，而不是一行「git status」标题就完了。

### US-03：快速定位命令失败原因

**作为开发者**，当 `npm run build` 失败（退出码非零）时，我希望展开卡片能清晰看到 stderr 中的编译错误，而不是去解析一个 JSON 字符串。

### US-04：大输出查看完整日志

**作为开发者**，当命令输出超过 100KB 被截断时，我希望能通过卡片内的入口打开完整日志文件。

---

## 5. 数据流设计

### 5.1 新增字段：`ToolCallRecord.progressOutput`

```typescript
// src/shared/domainTypes.ts — ToolCallRecord 扩展

export interface ToolCallRecord {
  // ... 现有字段保持不变 ...

  /** run_shell 执行过程中的实时输出（最近 N 字符），仅会话内使用，不持久化 */
  progressOutput?: string
}
```

**设计决策：**
- `progressOutput` 仅存于**内存中**的 `ToolCallRecord`，不写入数据库（避免频繁序列化大文本）
- 每次 `tool:progress` 事件到达时，**覆盖**为最新尾部内容（与主进程推送的最近 4000 字符一致）
- 完成后，`progressOutput` 可保留作为展示用；最终结果仍以 `result.data.stdout` / `result.data.stderr` 为准

### 5.2 IPC 数据流更新

```
runShellExecutor.ts                    toolChatLoop.ts                   chatToolSessionService.ts        ToolCallCard.tsx
─────────────────                    ──────────────                   ──────────────────────────        ────────────────
ctx.sendProgress('shell',             sender.send(                       onProgress():                     展开卡片：
  stdout+stderr 尾部 4000)             'tool:progress',                   ✅ 设置 status='executing'        • 实时渲染 progressOutput
                                       { status, message })              ✅ 写入 progressOutput            • 自动滚动到底部
                                                                         ✅ flush() 到 Redux               • 等宽字体 <pre>

proc.on('close') →                   sender.send(                       onResult():                       展开卡片：
  resolve({ data: {                   'tool:result',                      ✅ 设置 status / result           • 格式化展示 stdout
    stdout, stderr, ... } })          { result })                         ✅ progressOutput 不动              • stderr 红色（exitCode≠0）
                                                                                                            • 截断提示 + 打开日志按钮
```

### 5.3 `chatToolSessionService.ts` 改动

```typescript
const onProgress = (d: { requestId: string; toolUseId: string; status: string; message?: string }) => {
  if (d.requestId !== getRequestId()) return
  const i = records.findIndex((t) => t.id === d.toolUseId)
  if (i >= 0) {
    records[i] = {
      ...records[i]!,
      status: 'executing',
      progressOutput: d.message ?? records[i]!.progressOutput  // 新增
    }
    flush()
  }
}
```

---

## 6. UI 设计

### 6.1 执行中（executing 状态）

展开卡片，在 `tool-row-detail` 区域展示实时滚动输出：

```
┌─────────────────────────────────────────────────┐
│ 🔄 npm install                      ⏳ executing │
│ ─────────────────────────────────────────────── │
│ ┌─────────────────────────────────────────────┐ │
│ │ npm notice Changelog: <https://...>         │ │
│ │ npm notice Run `npm fund` for details       │ │
│ │                                              │ │
│ │ added 47 packages in 3s                     │ │
│ │                                              │ │
│ │ █  ← 自动滚动到最新内容                      │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**实现规格：**

| 属性 | 值 |
|------|-----|
| 容器 | `<pre>` + 等宽字体（`var(--sa-font-mono)`，11px） |
| 最大高度 | `240px`，超出 `overflow-y: auto` |
| 滚动行为 | 自动滚动到底部（最新输出可见） |
| 背景 | `var(--sa-bg-subtle)`，圆角 `var(--sa-radius-sm)` |
| 内边距 | `8px 10px` |
| 加载指示 | 内容底部可选闪烁光标 `▊`（或保留现有的「仍在运行…」文字） |

### 6.2 执行完成（completed 状态）

> **默认行为：** 命令执行完成后，卡片**默认收起**为单行摘要（与现有行为一致）。用户点击展开后，才显示以下格式化输出。例外：只读命令（见 §6.3）完成后自动展开。

展开卡片，区分 stdout 和 stderr：

**成功（exitCode=0，有输出）：**

```
┌─────────────────────────────────────────────────┐
│ ✅ npm install                       ✓ completed │
│ ─────────────────────────────────────────────── │
│ ┌─ stdout ────────────────────────────────────┐ │
│ │ npm notice Changelog: <https://...>         │ │
│ │ added 47 packages in 3s                     │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**失败（exitCode≠0）：**

```
┌─────────────────────────────────────────────────┐
│ ❌ npm run build                     ✗ failed    │
│ ─────────────────────────────────────────────── │
│ 退出码: 1                                       │
│ ┌─ stderr ────────────────────────────────────┐ │
│ │ src/App.tsx:15:7 - error TS2322: ...        │ │
│ │  Type 'string' is not assignable to ...     │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**静默成功（exitCode=0，无输出）：**

保持现有行为：折叠行显示「已完成（无输出）」。

**实现规格：**

| 属性 | 值 |
|------|-----|
| 退出码展示 | 非零时在 stderr 上方显示 `退出码: N`（12px，`var(--sa-text-secondary)`） |
| stdout 区域 | 仅 stdout 非空时展示；无标签 header（简洁优先），或可选小标签 `stdout` |
| stderr 区域 | 仅 stderr 非空时展示；`color: var(--sa-accent)`（红色调） |
| 容器 | 同执行中：`<pre>` + 等宽 11px + 最大高度 240px |
| 截断提示 | 输出被截断时，在输出区域底部显示「输出已截断，打开完整日志 →」按钮 |

### 6.3 只读命令自动展开

当 `shouldCollapseShellToolRow()` 返回 `true`（`git status`、`ls`、`node -v` 等）且命令**执行完成**时：

| 当前行为 | 新行为 |
|---------|--------|
| 默认折叠，需手动点击展开 | **自动展开**显示输出 |

**理由：** 只读命令的核心价值就是**查看输出**。用户执行 `git status` 就是为了看状态，折叠后还要多点一下，没有意义。

### 6.4 与现有确认卡片的关系

本需求**不改变**确认阶段（`ShellConfirmCard`）的任何 UI。确认卡片仅在 `status === 'confirming'` 时渲染，与本需求涉及的 `executing` / `completed` 状态互斥。

---

## 7. 实现要点

### 7.1 改动清单

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| `src/shared/domainTypes.ts` | `ToolCallRecord` 新增 `progressOutput?: string` | 低 |
| `src/renderer/services/chatToolSessionService.ts` | `onProgress` 写入 `progressOutput` | 低 |
| `src/renderer/components/Chat/ToolCallCard.tsx` | 展开卡片渲染实时输出 / 格式化结果 | 中 |
| `src/renderer/components/Chat/toolCallDisplay.ts` | 调整只读命令展开逻辑 | 低 |
| `src/renderer/theme/layout.css` | 新增输出区域样式 | 低 |

### 7.2 ToolCallCard 渲染逻辑

```typescript
// 伪代码：展开详情区域渲染

if (record.status === 'executing' && record.toolName === 'run_shell') {
  // 实时输出
  return (
    <ShellOutputView
      content={record.progressOutput ?? ''}
      isLive={true}
    />
  )
}

if (record.status === 'completed' && record.toolName === 'run_shell') {
  const data = record.result?.data as ShellResultData | undefined
  if (data && (data.stdout || data.stderr)) {
    return (
      <ShellOutputView
        stdout={data.stdout}
        stderr={data.stderr}
        exitCode={data.exitCode}
        truncated={data.truncated}
        persistedOutputPath={data.persistedOutputPath}
      />
    )
  }
}
```

### 7.3 ShellOutputView 组件（可选）

考虑到逻辑复杂度，可将输出展示抽取为独立组件 `ShellOutputView`：

```typescript
// src/renderer/components/Chat/ShellOutputView.tsx

type Props = {
  // 实时模式
  content?: string
  isLive?: boolean
  // 完成模式
  stdout?: string
  stderr?: string
  exitCode?: number | null
  truncated?: boolean
  persistedOutputPath?: string
}
```

### 7.4 自动滚动实现

```typescript
// 在 ShellOutputView 中使用 useEffect + ref
const preRef = useRef<HTMLPreElement>(null)

useEffect(() => {
  if (isLive && preRef.current) {
    preRef.current.scrollTop = preRef.current.scrollHeight
  }
}, [content, isLive])
```

### 7.5 只读命令自动展开

修改 `defaultExpanded()` 和状态更新 `useEffect`：

```typescript
// 当前：只读 shell 命令默认折叠
function isShellListRowCollapsed(record: ToolCallRecord): boolean {
  return shouldCollapseShellToolRow(record) && record.status === 'completed'
}

// 改为：只读 shell 命令完成后默认展开
// 方案：移除 isShellListRowCollapsed 的默认折叠逻辑，
// 或将其改为：只读命令完成后自动展开
```

**建议方案：** 修改 `defaultExpanded()` 逻辑，当 `shouldCollapseShellToolRow(record) && record.status === 'completed'` 时返回 `true`（展开），而非 `false`（折叠）。

### 7.6 样式新增

```css
/* layout.css 新增 */

.shell-output {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--sa-radius-sm);
  font-family: var(--sa-font-mono);
  font-size: 11px;
  line-height: 1.5;
  max-height: 240px;
  overflow-y: auto;
  background: var(--sa-bg-subtle);
  color: var(--sa-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.shell-output--live {
  /* 实时模式底部闪烁指示 */
  border-bottom: 2px solid var(--sa-accent);
}

.shell-output__stderr {
  color: var(--sa-accent);
}

.shell-output__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--sa-text-tertiary);
  margin-bottom: 4px;
}

.shell-output__truncated-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--sa-text-tertiary);
}
```

### 7.7 单元测试

| 测试文件 | 覆盖 |
|---------|------|
| `ToolCallCard.test.tsx` | executing 态渲染 progressOutput；completed 态渲染 stdout/stderr；退出码非零时 stderr 样式 |
| `chatToolSessionService.test.ts` | progress 事件正确写入 `progressOutput` |
| `toolCallDisplay.test.ts` | 只读命令展开逻辑调整 |

---

## 8. 验收标准

- [ ] 执行 `run_shell` 时，展开卡片能看到实时滚动的 stdout/stderr 输出
- [ ] 命令执行完成后，展开卡片显示格式化的 stdout 和 stderr（不再显示原始 JSON）
- [ ] 退出码非零时，stderr 以醒目颜色（红色）展示，并显示退出码
- [ ] `git status` 等只读命令完成后，卡片**自动展开**显示输出
- [ ] 静默命令（exit 0 且无输出）保持现有「已完成（无输出）」行为，不展开
- [ ] 输出超过 240px 高度时可滚动
- [ ] 输出被截断时，显示截断提示和「打开完整日志」按钮
- [ ] 实时模式下输出区域自动滚动到最新内容
- [ ] 现有确认卡片（ShellConfirmCard）行为不受影响
- [ ] 现有类型定义向后兼容（新增 `progressOutput` 为可选字段）

---

**文档版本：** v1.0
**适用范围：** SpaceAssistant run_shell 工具执行输出实时展示
**维护者：** 与 [shell-command-tool-requirement.md](./shell-command-tool-requirement.md) 同步演进
