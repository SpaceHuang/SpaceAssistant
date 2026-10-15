# 移除 run_shell 任务转后台机制 — 需求文档

> 状态：已完成
> 日期：2026-05-31
> 关联需求：[[shell-command-tool-requirement]]

## 1. 背景

`run_shell` 工具当前实现了两种任务转后台的路径：

1. **手动后台**：Agent 传入 `run_in_background: true`，命令立即在后台 spawn 并返回 `backgroundTaskId`
2. **自动转后台**：前台命令运行超过 `autoBackgroundSec`（默认 15s）后自动注册到后台注册表，不阻塞 Agent 循环

后台任务由 `backgroundShellRegistry` 单例管理，提供 `register`、`get`、`list`、`kill` 能力，并通过 IPC 通道 `shell:background-list` / `shell:background-get` 暴露给渲染进程。

### 1.1 现状问题

| # | 问题 | 细节 |
|---|------|------|
| 1 | **前端 UI 缺失** | `backgroundShellRegistry` 后端能力完整，但渲染进程无任何后台任务展示/管理界面，用户无法感知或操作后台任务 |
| 2 | **自动转后台逻辑复杂** | `runForeground()` 中维护 `autoBgTimer`，与超时 `killTimer`、`onAbort`、`on('close')` 交织，状态机不清晰 |
| 3 | **后台任务生命周期不可控** | 进程一旦注册到 `backgroundShellRegistry`，即使 Agent 循环结束也继续运行；无自动清理机制 |
| 4 | **语义模糊** | 自动转后台时 Agent 收到的 `ToolResult` 仍然是前台完成的结果（exitCode/stdout），后台注册仅起"通知"作用，并未真正解耦 Agent 循环 |
| 5 | **测试负担** | `runShellExecutor.test.ts` 需要管理 `backgroundIds` 并在 `afterEach` 中逐项 kill；`backgroundShellRegistry.test.ts` 是独立测试文件 |
| 6 | **配置项冗余** | `ShellConfig.autoBackgroundSec` 在设置页有独立表单项，但功能实际不可用（无 UI 展示后台任务） |
| 7 | **IPC 通道多余** | `shell:background-list` / `shell:background-get` / `shellBackgroundList` / `shellBackgroundGet` 四个 API 面无实际消费者 |
| 8 | **文档债务** | `shell-command-tool-requirement.md` 中标记为 "Phase 2" 的功能描述需要同步清理 |

### 1.2 决策

**整体移除任务转后台机制。** 理由：

- 该功能从 Phase 2 以来从未完整交付（无前端 UI）
- 当前实现增加了 `runShellExecutor` 约 30% 的代码复杂度
- 自动转后台并未真正解耦 Agent 循环（Agent 仍需等待进程结束才拿到结果）
- 实际使用场景中，用户更倾向于调大 `timeout` 而非依赖后台机制
- 移除后代码更简洁，未来如需重新实现可从清晰的基线开始

## 2. 移除范围

### 2.1 删除文件

| 文件 | 说明 |
|------|------|
| `electron/shell/backgroundShellRegistry.ts` | 后台任务注册表单例 |
| `electron/shell/backgroundShellRegistry.test.ts` | 对应测试 |

### 2.2 修改文件

#### `electron/tools/runShellExecutor.ts`

- 删除 `import { backgroundShellRegistry }` 
- 删除 `runBackground()` 函数（L110–146）
- `execute()` 中：删除 `runInBackground` 变量（L67），删除 `if (runInBackground) { return runBackground(...) }` 分支（L91–93），直接进入 `runForeground()`
- `runForeground()` 中：
  - 删除 `autoBackgroundSec` 参数（L156）
  - 删除 `backgroundTaskId` 局部变量（L168）
  - 删除 `autoBgTimer` 逻辑块（L211–224）
  - 删除 `close` 回调中对 `backgroundTaskId` 的引用（L291, L306）
  - 简化 `data` 返回结构，移除 `backgroundTaskId` 字段
- `baseLog` 中删除 `runInBackground`、`autoBackgroundSec` 字段（L84–85）
- 删除 `backgroundTaskId` 字段的日志输出

#### `src/shared/builtinToolDefinitions.ts`

- `run_shell` 的 `input_schema.properties` 中删除 `run_in_background` 字段（L108–111）
- `run_shell` 的 `description` 中移除 "长时间任务请设置 timeout 或 run_in_background（若已启用）" 表述

#### `src/shared/domainTypes.ts`

- `ShellConfig` 接口中删除 `autoBackgroundSec?: number` 字段（L122）
- `DEFAULT_SHELL_CONFIG` 中删除 `autoBackgroundSec: 15`（L131）

#### `electron/appIpc.ts`

- 删除 `shell:background-list` handler（L237–240）
- 删除 `shell:background-get` handler（L242–245）

#### `electron/preload.ts`

- 删除 `shellBackgroundList` 方法（L123）
- 删除 `shellBackgroundGet` 方法（L124）

#### `src/shared/api.ts`

- 删除 `shellBackgroundList` 类型定义（L210–221）
- 删除 `shellBackgroundGet` 类型定义（L222–231）

#### `src/renderer/components/Config/ShellSettingsTab.tsx`

- 删除 "自动转后台（秒，0=禁用）" 表单项（L55–63）

### 2.3 修改测试文件

#### `electron/tools/runShellExecutor.test.ts`

- 删除 `import { backgroundShellRegistry }`（L5）
- 删除 `backgroundIds` 数组及 `afterEach` 中的 kill 循环（L37, L47–49）
- `baseCtx()` 中移除 `autoBackgroundSec: 0`（L29）
- 删除 `'run_in_background returns task id immediately'` 测试用例（L108–120）
- 其他用例中的 `autoBackgroundSec: 0` 改为不传（依赖默认值不再有此字段）

#### `electron/toolChatLoop.shell.test.ts`

- 两处 `autoBackgroundSec: 15`（L46, L66）移除

### 2.4 修改文档

#### `docs/requirement/shell-command-tool-requirement.md`

- 工具 Schema 中删除 `run_in_background` 参数定义
- 输入参数表中删除 `run_in_background` 行
- 输出结构表中删除 `backgroundTaskId` 行，`persistedOutputPath` 改为非 Phase 2 描述
- `ShellConfig` 接口示例中删除 `autoBackgroundSec` 字段
- 模块划分表中删除 `backgroundShellRegistry` 行
- 移除所有 "Phase 2" 标记中与后台任务相关的部分

## 3. 不变范围

以下功能**不受影响**，保持现状：

| 功能 | 说明 |
|------|------|
| `timeout` 超时机制 | `killTimer` + `killProcessTree` 不变 |
| 用户取消（AbortSignal） | `onAbort` → `killProcessTree` 不变 |
| 大输出截断 + 持久化 | `truncateIo` + `persistLargeOutput` 不变 |
| `sendProgress` 实时输出 | 前端 toolCallCard 进度展示不变 |
| `shell:open-output-path` IPC | 打开持久化的输出日志文件不变 |
| Shell 安全分析 | `shellSecurity`、`shellPathAnalysis` 等不变 |
| Shell 配置（executable、rules、timeout 等） | 除 `autoBackgroundSec` 外的所有配置项不变 |

## 4. 影响评估

### 4.1 对用户的影响

- **无感知**。后台任务机制从未有前端 UI，用户无法交互，移除不影响任何现有使用流程
- 设置页少一个表单项（"自动转后台"），界面更简洁

### 4.2 对 Agent 行为的影响

- Agent 调用 `run_shell` 时不再能传 `run_in_background: true`。如果模型传了该参数，会被忽略（`input_schema` 中已移除，模型不会生成该参数）
- 所有 shell 命令都是同步等待完成或超时
- 建议 Agent 对长时间任务设置合理的 `timeout`

### 4.3 代码行数变化（估计）

| 类别 | 变化 |
|------|------|
| 删除文件 | 2 个（~110 行） |
| 删除代码行 | ~80 行（runShellExecutor、appIpc、preload、api、domainTypes、ShellSettingsTab） |
| 简化测试 | ~25 行 |
| 文档更新 | ~15 处修改 |
| **净减少** | **~230 行** |

## 5. 验收标准

- [x] `backgroundShellRegistry.ts` 及测试文件已删除
- [x] `runShellExecutor` 不再导入或引用 `backgroundShellRegistry`
- [x] `runShellExecutor.execute()` 无 `run_in_background` 分支
- [x] `runForeground()` 无 `autoBackgroundSec` 参数和相关逻辑
- [x] `builtinToolDefinitions.ts` 中 `run_shell` 无 `run_in_background` 参数
- [x] `ShellConfig` 无 `autoBackgroundSec` 字段
- [x] `DEFAULT_SHELL_CONFIG` 无 `autoBackgroundSec`
- [x] `appIpc.ts` 无 `shell:background-*` handler
- [x] `preload.ts` 无 `shellBackgroundList` / `shellBackgroundGet`
- [x] `api.ts` 无对应类型定义
- [x] `ShellSettingsTab.tsx` 无 "自动转后台" 表单项
- [x] 所有现有测试通过（`npm test`）
- [x] `shell-command-tool-requirement.md` 中后台任务相关描述已清理
- [x] 项目中 `grep -r "backgroundShellRegistry\|run_in_background\|autoBackgroundSec\|backgroundTaskId\|shellBackgroundList\|shellBackgroundGet"` 仅剩本文档中的引用（如有）
