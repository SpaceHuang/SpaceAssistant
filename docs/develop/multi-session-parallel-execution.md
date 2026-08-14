# 多会话并行执行 — 改造技术方案

> **文档状态：** 阶段 1-3 已落地（代码超前于本文档，2026-07-15 已核实并更新）  
> **代码基线：** `src/renderer/services/chatRunnerService.ts`、`src/renderer/store/chatSlice.ts`、`src/renderer/services/pendingConfirmStore.ts`、`src/renderer/services/runRequestIndex.ts`、`src/renderer/components/SessionList/PendingConfirmBanner.tsx` 等  
> **剩余工作：** 阶段 4（性能优化，按需）、文件冲突检测验证

## 1. 背景与目标

### 1.1 问题

当前聊天模块按「单会话视图 + 全局执行状态」设计：用户在会话 A 执行任务时，切换到会话 B 会出现列表选中态与聊天内容不一致、无法在新会话发消息、流式更新丢失等问题。

根因是 **UI 状态（messages / chatStatus / streamingRequestId）全局唯一**，而主进程已具备按 `requestId` 隔离取消与工具确认的能力，两边模型不匹配。

### 1.2 目标

- 用户可在多个会话中**并行**发起 LLM 请求（含工具循环）。
- 切换会话仅改变「正在查看」的会话，**不中断**后台任务。
- 会话列表能直观看到哪些会话正在执行（交互层已完成第一步）。
- 工具确认、中止、持久化在并行场景下行为正确。
- 方案**可渐进落地**，避免一次性大重构。

### 1.3 非目标（本阶段不做）

- 多窗口 / 多 workDir 隔离。
- 分布式任务队列、独立 Worker 进程。
- 完整的文件级 CRDT / 三方合并。
- 将 JSON 存储一次性迁移 SQLite（仅记录后续优化方向）。

---

## 2. 已完成：会话列表 Loading 状态（交互基础）

> 状态：**已完成**（阶段 0），后续已升级为多会话 Running 状态。

### 2.1 行为

| 状态 | 列表表现 |
|------|---------|
| 空闲 | CSS 默认样式 |
| 执行中 | `session-item--running` CSS class（方案演进：最初使用 `SessionListIcon` + `Loader2` 图标，后改为 CSS class 控制，`SessionListIcon.tsx` 组件保留但 `SessionListPane` 通过 `runningSessions[item.id]` 直接计算） |
| 选中 | 浅灰背景 + 会话名高亮（已移除左侧蓝色竖条，视觉更简洁） |

### 2.2 实现要点（已演进）

| 模块 | 初始改动（阶段 0） | 当前状态 |
|------|-------------------|---------|
| `chatSlice` | 新增 `runningSessionId` 单字段 | 已升级为 `runningSessions: Record<string, RunningSessionMeta>`（多会话 Map），含 `requestId` / `status` / `updatedAt` |
| `SessionListIcon` | `<SessionListIcon loading={item.id === runningSessionId} />` | 组件保留可用，但 `SessionListPane` 改用 CSS class `session-item--running` |
| `SessionListPane` | — | 直接从 `runningSessions[item.id]` 计算 `running` 布尔值 |

### 2.3 演进说明

阶段 0 设计使用 `runningSessionId` 单字段 + `SessionListIcon` 组件。在阶段 1 的 `chatRunnerService` 落地后，状态模型升级为 `runningSessions` Map（多会话），展示方案随之切换为 CSS class 方式，更简洁且无需额外组件。~~已知局限已消除。~~

---

## 3. 现状与差距分析

### 3.1 已具备、可复用（均已就绪）

| 能力 | 位置 | 说明 |
|------|------|------|
| 请求级取消 | `electron/chatCancelRegistry.ts` | `Map<requestId, AbortController>` |
| 工具确认隔离 | `electron/toolConfirmRegistry.ts` | key = `requestId + toolUseId` |
| 会话级文件读缓存 | `getFileStateCacheForSession(sessionId)` | 各会话独立 cache |
| IPC 并发 | `ipcMain.handle` | 多路 `claude-chat-create-with-tools` 可并行 await |
| 事件过滤 | 渲染层 callback | 已按 `requestId` 过滤 delta / tool 事件 |

### 3.2 主要阻碍 → 已解决

| 原优先级 | 问题 | 现状 |
|--------|------|------|
| ~~P0~~ | ~~全局 `messages` / `chatStatus` / `streamingRequestId`~~ | ✅ 已解决。`runningSessions` Map 替代单字段；`streamingRequestId` 从 per-session 计算；全局锁已移除。`chatStatus` 字段保留（兼容）但不再用于发送锁 |
| ~~P0~~ | ~~工具确认 UI 只绑当前可见会话~~ | ✅ 已解决。`PendingConfirmBanner` + `pendingConfirmStore` + `pendingWriteDirConfirmStore` + `pendingArtifactDecisionStore` 三个跨会话队列，侧栏上方展示待办，可跳转 |
| ~~P0~~ | ~~`ChatView.send()` 单编排器 + 闭包~~ | ✅ 已解决。`chatRunnerService`（~280 行）已接管所有编排；`ChatView` 变薄 |
| ~~P1~~ | ~~IPC 事件无 `sessionId`~~ | ✅ 已解决。`runRequestIndex.ts`（`requestId → sessionId`，双路径：主进程直接传 `sessionId` + fallback 查表） |
| ~~P1~~ | ~~流式进度仅写 Redux、不落库~~ | ✅ 已解决。`routeStreamPatchMessage` → 2s 节流 `chatPatchMessage` DB 落库 + `flushStreamPersist` 完成前确保不丢失 |
| ~~P1~~ | ~~切换/删除/unmount 不清理 runner~~ | ✅ 已解决。`abortSessionRun` + `clearLiveSession` 完整清理 timer/rAF/pending patch/stores |
| ~~P1~~ | ~~`finishCancelled` 等回调用 viewing `sessionId`~~ | ✅ 已解决。所有回调使用启动时捕获的 `sessionId` 参数 |

### 3.3 剩余工作（低优先级）

| 优先级 | 问题 | 影响 | 状态 |
|--------|------|------|------|
| P2 | 共享 `workDir` 无写冲突协调 | 并行改同一文件可能 lost update | 未验证（`toolWriteConflict.ts` 可能存在部分防护） |
| P2 | JSON 全量 `db.save()` | 多会话同时完成时 I/O 放大 | 未动（阶段 4 按需） |
| P3 | API 速率 / 主进程 CPU | 软瓶颈，产品层可设并发上限 | `DEFAULT_MAX_PARALLEL_CHAT_SESSIONS` 常量已定义 + 可配置 |

---

## 4. 设计原则

1. **分离「查看」与「运行」**：`currentSessionId` 只表示 UI 焦点；任务生命周期由独立结构管理。
2. **最小新增抽象**：引入一个 `SessionChatRunner`（或 `chatRunnerService`）即可，不拆更多层级。
3. **主进程少改**：优先在渲染层补路由与状态；IPC 事件仅在必要时追加 `sessionId` 字段。
4. **渐进替换**：先让 runner 接管 `send` 流程，`ChatView` 仍负责展示；避免同时改 DB 与 UI。
5. **显式并发上限**：默认允许 N 路并行（建议 N=3），超出给出提示，防止 API 打满。

---

## 5. 架构（已落地）

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer                                                    │
│  ┌──────────────┐   ┌─────────────────────────────────┐   │
│  │ LeftSessions │   │ ChatView（纯展示 + 输入）          │   │
│  │ running 图标  │   │ 订阅 currentSessionId 的消息快照   │   │
│  └──────┬───────┘   └───────────────┬─────────────────┘   │
│         │                           │                       │
│         │         ┌─────────────────▼─────────────────┐     │
│         └────────►│ chatRunnerService（单例）          │     │
│                   │  Map<sessionId, Message[]> (live)  │     │
│                   │  Map<requestId, sessionId> (index) │     │
│                   │  pendingConfirmStore + 2 aux       │     │
│                   └─────────────────┬─────────────────┘     │
│                                     │ IPC                   │
└─────────────────────────────────────┼───────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Main Process（现有能力为主）                                 │
│  chatCancelRegistry / toolConfirmRegistry / toolChatLoop    │
└─────────────────────────────────────────────────────────────┘
```

### 5.1 状态模型（已落地）

**Redux（`chatSlice`）**

```typescript
interface ChatState {
  currentSessionId: string | null
  messages: Message[]                          // 当前查看会话
  chatStatus: ChatStatus                       // 保留（兼容），不再用于全局锁
  runningSessions: Record<string, RunningSessionMeta>  // 多会话运行状态
}

type RunningSessionMeta = {
  requestId: string
  status: 'streaming' | 'error'
  updatedAt: number
}
```

- ~~单值 `runningSessionId`~~ → `runningSessions` Map（已完成）
- `chatStatus` 字段保留但不再用于阻止并行发送（发送锁基于 per-session `runningSessions[sessionId]`）
- `streamingRequestId` 在 `ChatView` 中从 `runningSessions[sessionId]?.requestId` 计算（per-session）

**`chatRunnerService`（渲染层单例）**

| 结构 | 职责 |
|------|------|
| `liveBySession: Map<sessionId, Message[]>` | 每活跃会话的内存消息快照 |
| `toolControllersByRequestId` | 按 requestId 持有 ToolChatController |
| `persistTimers` + `persistPendingPatch` | 2s 节流 DB 落库 |
| `pendingUiPatches` + `uiFlushRafIds` | rAF 合并 UI 更新 |
| `runRequestIndex.ts` | `requestId → sessionId` 独立路由表 |

**跨会话确认队列（3 个 stores）**

| Store | 职责 |
|------|------|
| `pendingConfirmStore` | 工具确认（write/edit/shell 等） |
| `pendingWriteDirConfirmStore` | 文件写入目录确认 |
| `pendingArtifactDecisionStore` | 产物归属决策 |
| `PendingConfirmBanner` | 侧栏上方"待确认"入口，可跳转 |

---

## 6. 关键场景设计（已落地）

### 6.1 切换会话

1. `dispatch(setSession(newId))`。
2. `ChatView` 从 `chatRunnerService` + DB merge 加载消息历史；若该会话有活跃 run，合并 live 增量（`mergeDbAndLive`）。
3. **不** cancel 旧会话 request。
4. 输入区 `sessionRunning` 从 `runningSessions[currentSessionId]` 计算 —— 仅当前会话显示「执行中」。

**代码实现：**
- `chatRunnerService.routeAddMessage` / `routeStreamPatchMessage` 仅在 `currentSessionId === sessionId` 时同步 Redux
- `mergeDbAndLive` 合并 DB + Redux + live 三层数据
- `resolveSessionMessagesForApi` 构建完整上下文供 LLM 请求使用

### 6.2 并行发送

- 发送前检查：`runningSessions[sessionId]` 存在则拒绝（单会话单任务）。
- 全局活跃数 ≥ `maxParallelSessions`（默认 3，可通过配置项调整）则 toast 提示。
- ~~移除全局锁 `chatStatus === 'streaming'`~~ ✅ 已移除。

**代码实现：**
- `getMaxParallelChatSessions()` 从配置读取，`clampMaxParallelChatSessions` 边界校验
- `countRunningSessions()` / `isSessionRunning()` 读取 `runningSessions` map

### 6.3 工具确认（跨会话）

**方案（已实现）**：

1. **`pendingConfirmStore`（渲染层单例）**  
   收到 `tool:confirm-request` 时，经 payload 中的 `sessionId`（主进程已附带）或 `resolveSessionIdForRequest` 解析，写入队列 `{ sessionId, requestId, toolUseId, toolName, ... }`。

2. **侧栏待办条（`PendingConfirmBanner`）**  
   会话列表上方展示跨会话待确认项（"N 项待确认"），点击可跳转到对应会话并聚焦确认卡片。`useActionablePendingConfirms` hook 过滤仅当前 running session 的可操作项。

3. **确认回调** 使用队列项内的 `requestId`，不依赖全局 `streamingRequestId`。

4. 会话被删除时：对该 session 下所有 pending confirm 自动 `reject`（`rejectAllForSession`），并 cancel requestId。

**额外实现（超出原始设计）：**
- `pendingWriteDirConfirmStore`（文件写入目录确认跨会话队列）
- `pendingArtifactDecisionStore`（产物归属决策跨会话队列）
- `confirmStoresInit.ts`（eager-init 三个 stores 的 IPC 监听）

### 6.4 中止

- 输入区中止按钮：仅 abort **当前查看会话** 的 run（`abortSessionRun`）。
- 主进程已有 `claude-chat-cancel`，无需改动。

### 6.5 持久化策略

**已实现（超越原始设计）：**

- `routeStreamPatchMessage`：live 立即更新 + Redux rAF 合并（`scheduleUiFlush`）+ DB 2s 节流（`scheduleThrottledPersist`）。
- `flushStreamPersist`：完成前确保最后一批 DB patch 不丢失。
- `flushUiPatch`：完成前确保最后一批 UI patch flush 到 Redux。

### 6.6 文件并发（P2，轻量防护）

~~首阶段不做复杂锁~~ → 未验证。`toolWriteConflict.ts` 可能存在部分防护，需进一步确认。

### 6.7 会话删除

`sessionDelete` 流程（已扩展）：

1. `chatRunnerService.finishSessionRun` / `abortSessionRun` + 清理 `liveBySession` / pending confirms。
2. `pendingConfirmStore.rejectAllForSession` + 三个 stores 的 `removeAllForRequest`。
3. `clearLiveSession`（清理 timer + rAF + pending patch）。
4. dispatch `removeRunningSession`。
5. 现有 DB 删除逻辑不变。

---

## 7. IPC 与 API 变更

### 7.1 原则（已落地）

主进程已按 `requestId` 隔离；渲染层 `runRequestIndex` 提供 `requestId → sessionId` 路由。主进程部分事件 payload 已附带 `sessionId`（优先使用，`pendingConfirmStore.init` 中使用 `d.sessionId ?? resolveSessionIdForRequest(d.requestId)` 双路径）。

### 7.2 已实现

在 `tool:confirm-request` 等事件 payload 中主进程已附带 `sessionId`，渲染层优先使用，减少查表。

### 7.3 不改动的部分

- `chatCancelRegistry` / `toolConfirmRegistry` 结构。
- `claude-chat-create-with-tools` 同步 invoke 语义（每会话一个 pending promise，由 chatRunnerService 各自 await）。

---

## 8. 实施阶段

### 阶段 0 — 已完成 ✅

- [x] 会话列表 Loading 图标（`SessionListIcon` + `runningSessionId` 初始方案）
- [x] 选中态简化（移除左侧蓝色竖条）
- [x] 后续演进为 `runningSessions` map + CSS class 方案

### 阶段 1 — 已完成 ✅（运行层抽离）

| 任务 | 说明 | 实现文件 |
|------|------|---------|
| 新增 `chatRunnerService` | 从 `ChatView.send()` 迁出 orchestration | `src/renderer/services/chatRunnerService.ts`（~280 行） |
| Redux 改为 `runningSessions` map | 列表支持多会话 running 状态 | `chatSlice.ts`（`Record<string, RunningSessionMeta>`） |
| 切换会话正确加载 | 合并 live / DB / Redux 三层 | `mergeDbAndLive` + `resolveSessionMessagesForApi` |
| 移除全局 send 锁 | 按 `runningSessions[sessionId]` 判断 | `isSessionRunning` + `countRunningSessions` |
| 流式节流 DB 落库 | 2s 节流 + flush 保证不丢失 | `routeStreamPatchMessage` → `scheduleThrottledPersist` |
| 跨会话 `ToolChatController` 隔离 | 按 requestId 持有，防止覆盖 | `toolControllersByRequestId` Map |
| 单元测试 | runner 路由、并发上限、切换不 cancel | `chatRunnerService.test.ts` |

**验收**：A 执行中长任务时可切到 B 发消息；A 列表仍显示 running；A 完成后 DB 正确。✅

### 阶段 2 — 已完成 ✅（工具确认队列）

| 任务 | 说明 | 实现文件 |
|------|------|---------|
| `PendingConfirmStore` + 侧栏待办入口 | 后台 confirm 可处理 | `pendingConfirmStore.ts`（~145 行）+ `PendingConfirmBanner.tsx` |
| 确认 / 拒绝 / 超时 UI 闭环 | 不再 5min 盲等 | `useActionablePendingConfirms` hook |
| 删 session 自动 reject | 防悬挂 | `rejectAllForSession` |
| 文件写入目录确认队列 | 跨会话 → `pendingWriteDirConfirmStore` | `pendingWriteDirConfirmStore.ts` |
| 产物归属决策队列 | 跨会话 → `pendingArtifactDecisionStore` | `pendingArtifactDecisionStore.ts` |
| 三个 stores eager-init | 在任何 chat run 前注册 IPC 监听 | `confirmStoresInit.ts` |

**验收**：A 后台等待 write 确认，用户在 B 界面看到侧栏待办并可跳转确认。✅

### 阶段 3 — 基本完成 ✅（生命周期与体验）

| 任务 | 说明 | 状态 |
|------|------|------|
| unmount / 切换 cleanup 规范 | 仅 unsubscribe viewing 相关，不杀 runner | ✅ `abortSessionRun` + `clearLiveSession` 完整清理 |
| `finishSessionRun` sessionId 正确 | 使用启动时捕获的参数，非 viewing state | ✅ |
| 流式节流落库 | 2s DB patch | ✅ 已实现（超出阶段 3 预期，阶段 1 已完成） |
| 文件冲突检测 | 轻量检测 | ⚠️ 未验证（`toolWriteConflict.ts` 可能已有部分防护） |

### 阶段 4 — 按需（性能）

- DB 写入合并 / 迁移 SQLite。
- ~~并发上限配置化~~ → ✅ 已实现（`maxParallelChatSessions` 配置项 + `clampMaxParallelChatSessions` + `DEFAULT_MAX_PARALLEL_CHAT_SESSIONS` 常量）。

---

## 9. 测试要点

| 场景 | 预期 |
|------|------|
| 双会话并行 streaming | 两路 delta 各写各 session，互不覆盖 |
| 切换后再切回 | 看到最新 live 内容 |
| 全局锁移除 | B 可发送 while A running |
| 后台 tool confirm | 待办出现，确认后 A 继续 |
| 中止当前会话 | 仅停当前，不影响其他 |
| 删除 running 会话 | run cancel，无孤儿监听 |
| 超并发上限 | 友好提示，不 silent fail |
| 快速 A→B→A 切换 | 无 stale fetch 覆盖（fetch 带 sessionId 校验） |

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| API rate limit | 默认 maxParallel=3，可配置 |
| JSON DB 写放大 | 阶段 1 不增加 patch 频率；阶段 4 再优化 |
| 同文件并行写 | 阶段 3 冲突检测 + 错误回传模型 |
| 重构范围过大 | 严格分阶段；runner 先行，Confirm 次之 |
| IPC 监听泄漏 | runner 统一 subscribe/cleanup；测试覆盖 |

---

## 11. 涉及文件

| 阶段 | 文件 | 状态 |
|------|------|------|
| 0 | `SessionListIcon.tsx`、`SessionListPane.tsx`、`chatSlice.ts`、`layout.css`、`ChatView.tsx` | ✅ |
| 1 | `src/renderer/services/chatRunnerService.ts`（新增） | ✅ |
| 1 | `src/renderer/services/runRequestIndex.ts`（新增） | ✅ |
| 1 | `src/shared/chatParallelConfig.ts`（并发上限配置） | ✅ |
| 2 | `src/renderer/services/pendingConfirmStore.ts`（新增） | ✅ |
| 2 | `src/renderer/services/pendingWriteDirConfirmStore.ts`（新增） | ✅ |
| 2 | `src/renderer/services/pendingArtifactDecisionStore.ts`（新增） | ✅ |
| 2 | `src/renderer/services/confirmStoresInit.ts`（新增） | ✅ |
| 2 | `src/renderer/components/SessionList/PendingConfirmBanner.tsx`（新增） | ✅ |
| 2 | `src/renderer/hooks/useActionablePendingConfirms.ts`（新增） | ✅ |
| 3 | `src/renderer/services/chatToolSessionService.ts` | ✅ |
| 3 | `src/renderer/services/workDirSessionSync.ts` | ✅ |
| — | 相关测试文件（`chatRunnerService.test.ts`、`pendingConfirmStore.test.ts` 等） | ✅ |

---

## 12. 实际实现与原始设计的偏差

以下偏差已在落地过程中自然发生，记录供后续维护者参考：

| 偏差 | 原始设计 | 实际实现 | 原因 |
|------|---------|---------|------|
| Loading 展示 | `SessionListIcon` 组件 | CSS class `session-item--running` | 简化，无需额外组件 |
| `chatStatus` 删除 | 设计目标：删除全局字段 | 保留（兼容），仅不再用于锁 | 最小改动原则 |
| `PendingConfirmStore` 命名 | 单数 | 实际有 3 个 stores | 职责分离（confirm / writeDir / artifact） |
| `toolControllersByRequestId` | 未在设计中出现 | 实际实现的核心结构 | 多会话并行中防止后启动会话覆盖 ToolChatController |
| `confirmStoresInit` | 未在设计中出现 | eager-init 模式 | 确保 IPC 监听在首次 confirm-request 到达前注册 |
| 并发上限配置 | 阶段 4 | 阶段 1 同步实现 | `chatParallelConfig.ts` + `maxParallelChatSessions` 配置项 |
| 流式 DB 节流落库 | 阶段 2 可选 | 阶段 1 已实现 | 2s 节流（`STREAM_PERSIST_MS = 2000`） |

---

## 13. 小结

多会话并行的本质是 **把「正在看」和「正在跑」解耦**。主进程已具备 request 级隔离；渲染层已补全 `chatRunnerService`（运行层）、`runningSessions` map（per-session 状态）、`runRequestIndex`（路由表）、确认队列（3 个跨会话 stores + `PendingConfirmBanner`）四块。

**代码已处于阶段 3 基本完成的状态**，核心 P0/P1 阻碍全部解除。剩余 P2 项（文件冲突检测、SQLite 迁移）为按需优化，不阻塞基于多会话并行能力的上层功能开发。

与原始设计方案相比，代码落地质量较高——`toolControllersByRequestId`、节流持久化、eager-init stores、并发上限可配置等细节超出设计预期，体现了良好的工程判断。
