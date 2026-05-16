# 多会话并行执行 — 改造技术方案

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

> 状态：**已完成**，作为多会话并行交互改造的第一步。

### 2.1 行为

| 状态 | 列表前方图标 |
|------|-------------|
| 空闲 | 6px 灰色圆点 |
| 执行中 | 主题色 `Loader2` 旋转图标（复用 `tool-row-spin` 动画） |
| 选中 | 浅灰背景 + 会话名高亮（已移除左侧蓝色竖条，视觉更简洁） |

### 2.2 实现要点

| 模块 | 改动 |
|------|------|
| `chatSlice` | 新增 `runningSessionId`，在 `setChatStatus({ status: 'streaming', sessionId })` 时写入，完成/出错/取消时清除 |
| `SessionListIcon` | `src/renderer/components/SessionList/SessionListIcon.tsx` |
| `App.tsx` / `LeftSessions` | 每项渲染 `<SessionListIcon loading={item.id === runningSessionId} />` |
| `layout.css` | `.session-item-icon*` 样式 |

### 2.3 已知局限（待本方案后续阶段解决）

- `runningSessionId` 目前为**单个**字段，尚不支持多会话同时 running 的列表展示（下一阶段改为 `runningSessionIds: string[]` 或 `Record<sessionId, RunMeta>`）。
- 切换会话时 `chatStatus` 仍为全局 `streaming`，输入区与发送逻辑尚未按会话隔离。

---

## 3. 现状与差距分析

### 3.1 已具备、可复用

| 能力 | 位置 | 说明 |
|------|------|------|
| 请求级取消 | `electron/chatCancelRegistry.ts` | `Map<requestId, AbortController>` |
| 工具确认隔离 | `electron/toolConfirmRegistry.ts` | key = `requestId + toolUseId` |
| 会话级文件读缓存 | `getFileStateCacheForSession(sessionId)` | 各会话独立 cache |
| IPC 并发 | `ipcMain.handle` | 多路 `claude-chat-create-with-tools` 可并行 await |
| 事件过滤 | 渲染层 callback | 已按 `requestId` 过滤 delta / tool 事件 |

### 3.2 主要阻碍（按优先级）

| 优先级 | 问题 | 影响 |
|--------|------|------|
| P0 | 全局 `messages` / `chatStatus` / `streamingRequestId` | 切换即脱节；全局锁阻止并行发送 |
| P0 | 工具确认 UI 只绑当前可见会话 | 后台会话 write/edit 确认不可见，主进程阻塞至超时 |
| P0 | `ChatView.send()` 单编排器 + 闭包 | 无法并存多路 IPC 监听与状态机 |
| P1 | IPC 事件无 `sessionId` | 渲染层需维护 `requestId → sessionId` 路由表 |
| P1 | 流式进度仅写 Redux、不落库 | 切走再切回丢失增量；崩溃丢进度 |
| P1 | 切换/删除/unmount 不清理 runner | 孤儿监听、错绑 patch |
| P1 | `finishCancelled` 等回调用 viewing `sessionId` | 切换后中止可能写错会话 |
| P2 | 共享 `workDir` 无写冲突协调 | 并行改同一文件可能 lost update |
| P2 | JSON 全量 `db.save()` | 多会话同时完成时 I/O 放大 |
| P3 | API 速率 / 主进程 CPU | 软瓶颈，产品层可设并发上限 |

---

## 4. 设计原则

1. **分离「查看」与「运行」**：`currentSessionId` 只表示 UI 焦点；任务生命周期由独立结构管理。
2. **最小新增抽象**：引入一个 `SessionChatRunner`（或 `chatRunnerService`）即可，不拆更多层级。
3. **主进程少改**：优先在渲染层补路由与状态；IPC 事件仅在必要时追加 `sessionId` 字段。
4. **渐进替换**：先让 runner 接管 `send` 流程，`ChatView` 仍负责展示；避免同时改 DB 与 UI。
5. **显式并发上限**：默认允许 N 路并行（建议 N=3），超出给出提示，防止 API 打满。

---

## 5. 目标架构

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer                                                    │
│  ┌──────────────┐   ┌─────────────────────────────────┐   │
│  │ LeftSessions │   │ ChatView（纯展示 + 输入）          │   │
│  │ loading 图标  │   │ 订阅 currentSessionId 的消息快照   │   │
│  └──────┬───────┘   └───────────────┬─────────────────┘   │
│         │                           │                       │
│         │         ┌─────────────────▼─────────────────┐     │
│         └────────►│ chatRunnerService（单例）          │     │
│                   │  Map<sessionId, SessionRunState>   │     │
│                   │  Map<requestId, sessionId>         │     │
│                   │  pendingConfirms[]               │     │
│                   └─────────────────┬─────────────────┘     │
│                                     │ IPC                   │
└─────────────────────────────────────┼───────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Main Process（现有能力为主）                                 │
│  chatCancelRegistry / toolConfirmRegistry / toolChatLoop    │
└─────────────────────────────────────────────────────────────┘
```

### 5.1 状态拆分

**保留（UI 层）**

| 字段 | 职责 |
|------|------|
| `currentSessionId` | 当前查看的会话 |
| `messages` | **仅**当前查看会话的消息快照（从 runner 或 DB 同步） |

**迁移到 `chatRunnerService`（运行层）**

| 字段 | 职责 |
|------|------|
| `runs[sessionId]` | `{ requestId, assistantMessageId, status, ... }` |
| `requestIndex[requestId]` | → `sessionId`，供 IPC 回调路由 |
| `liveMessages[sessionId]` | 进行中会话的内存消息（含 streaming 增量） |

**Redux 调整（轻量）**

```typescript
// chatSlice 演进方向（示意）
interface ChatState {
  currentSessionId: string | null
  messages: Message[]              // 当前查看会话
  runningSessions: Record<string, {
    requestId: string
    status: 'streaming' | 'error'
    updatedAt: number
  }>
}
```

- 删除全局 `chatStatus` / `streamingRequestId` / 单值 `runningSessionId`。
- 列表 Loading 改为 `sessionId in runningSessions`。

### 5.2 SessionChatRunner 职责

每个会话最多一个活跃 runner；runner 封装现有 `ChatView.send()` 内逻辑：

- 创建 user / assistant 消息，写 DB（append）。
- 注册 IPC 监听（delta / thinking / tool*），在 **cleanup** 中统一 unsubscribe。
- 增量更新 `liveMessages[sessionId]`；若 `sessionId === currentSessionId` 则同步到 Redux `messages`。
- 完成 / 失败 / 取消时 `chatPatchMessage` 落库，从 `runningSessions` 移除。
- **始终使用启动时捕获的 `sessionId`**，禁止依赖 React 组件内的 viewing sessionId。

对外 API（示意）：

```typescript
chatRunner.start(sessionId, userText): Promise<void>
chatRunner.abort(sessionId): void
chatRunner.abortAll(): void
chatRunner.getLiveMessages(sessionId): Message[]
chatRunner.onChange(cb): unsubscribe
```

`ChatView` 变薄：挂载时 `syncMessages(currentSessionId)`，订阅 runner 变更刷新当前视图。

---

## 6. 关键场景设计

### 6.1 切换会话

1. `dispatch(setSession(newId))`。
2. `ChatView` 从 `runner.getLiveMessages(newId)` 或 `chatGetMessages` 加载历史；若该会话有活跃 run，合并 live 增量。
3. **不** cancel 旧会话 request。
4. 输入区 `running` 改为 `Boolean(runningSessions[currentSessionId])` — 仅当前会话显示「执行中」。

### 6.2 并行发送

- `start()` 前检查：`runningSessions[sessionId]` 存在则拒绝（单会话单任务）。
- 全局活跃数 ≥ `maxParallelSessions`（默认 3）则 toast 提示。
- 移除现有 `store.getState().chat.chatStatus === 'streaming'` 全局锁。

### 6.3 工具确认（P0）

**问题**：主进程 `await waitForToolConfirm(requestId, toolUseId)` 阻塞该会话 loop；UI 必须能响应任意 session 的 confirm。

**方案（简单可维护）**：

1. **`PendingConfirmStore`（渲染层单例）**  
   收到 `tool:confirm-request` 时，经 `requestIndex` 解析 `sessionId`，写入队列 `{ sessionId, requestId, toolUseId, toolName, diff, ... }`。

2. **全局确认入口**（二选一，推荐 A）  
   - **A. 侧栏待办条**：会话列表上方「2 项待确认」→ 点击跳到对应会话并展开 WriteConfirmCard。  
   - B. 浮动通知 + Modal（交互更重，暂不采用）。

3. **确认回调** 使用队列项内的 `requestId`，不再依赖全局 `streamingRequestId`。

4. 会话被删除时：对该 session 下所有 pending confirm 自动 `reject`，并 `claudeChatCancel` 其 requestId。

### 6.4 中止

- 输入区中止按钮：仅 abort **当前查看会话** 的 run（若存在）。
- 会话列表：running 图标 hover 显示停止按钮（可选，阶段 2）。
- 主进程已有 `claude-chat-cancel`，无需改动。

### 6.5 持久化策略

**阶段 1（最小改动）**

- 保持「完成时一次性 `chatPatchMessage`」。
- `liveMessages[sessionId]` 作为切换期间的唯一增量来源。
- 切回正在执行的会话时，从 `liveMessages` 恢复，而非仅读 DB。

**阶段 2（可选）**

- 流式节流落库（如每 2s 或每 512 字符 patch 一次），降低切走丢失风险。
- 不在首阶段引入，避免 DB 写入风暴恶化。

### 6.6 文件并发（P2，轻量防护）

首阶段不做复杂锁，仅增加 **冲突检测**：

- 工具执行前检查 path 是否出现在其他活跃 session 的「最近写入集合」中。
- 若冲突，工具返回可读错误，由模型重试或用户切换会话。
- `FileStateCache` 仍 per-session；后续可考虑 workDir 级 `mtime` 校验。

### 6.7 会话删除

`sessionDelete` 流程扩展：

1. `chatRunner.abort(sessionId)` + 清理 `liveMessages` / pending confirms。
2. 现有 DB 删除逻辑不变。
3. 主进程 `fileCaches.delete(sessionId)`（补充清理）。

---

## 7. IPC 与 API 变更

### 7.1 原则

主进程已按 `requestId` 隔离，**不强制**所有事件加 `sessionId`；渲染层 `requestIndex` 足够。

### 7.2 可选增强（低成本）

在 `tool:confirm-request`、`claude-chat-error` 等少量事件 payload 中追加 `sessionId`（主进程 payload 里已有），减少渲染层查表。属于便利优化，非阻塞项。

### 7.3 不改动的部分

- `chatCancelRegistry` / `toolConfirmRegistry` 结构。
- `claude-chat-create-with-tools` 同步 invoke 语义（每会话一个 pending promise，由 runner 各自 await）。

---

## 8. 实施阶段

### 阶段 0 — 已完成 ✅

- [x] 会话列表 Loading 图标（`SessionListIcon` + `runningSessionId`）
- [x] 选中态简化（移除左侧蓝色竖条）

### 阶段 1 — 运行层抽离（核心）

| 任务 | 说明 |
|------|------|
| 新增 `chatRunnerService` | 从 `ChatView.send()` 迁出 orchestration |
| Redux 改为 `runningSessions`  map | 列表 Loading 支持多会话 |
| 切换会话正确加载 | 合并 live / DB；修复 `finishCancelled` sessionId 错绑 |
| 移除全局 send 锁 | 按 sessionId 判断是否可发 |
| 单元测试 | runner 路由、并发上限、切换不 cancel |

**验收**：A 执行中长任务时可切到 B 发消息；A 列表仍显示 loading；A 完成后 DB 正确。

### 阶段 2 — 工具确认队列

| 任务 | 说明 |
|------|------|
| `PendingConfirmStore` + 侧栏待办入口 | 后台 confirm 可处理 |
| 确认 / 拒绝 / 超时 UI 闭环 | 不再 5min 盲等 |
| 删 session 自动 reject | 防悬挂 |

**验收**：A 后台等待 write 确认，用户在 B 界面收到待办并可跳转确认。

### 阶段 3 — 生命周期与体验

| 任务 | 说明 |
|------|------|
| unmount / 切换 cleanup 规范 | 仅 unsubscribe viewing 相关，不杀 runner |
| 列表项 abort 快捷操作 | 可选 |
| 流式节流落库 | 可选 |
| 文件冲突检测 | 轻量 |

### 阶段 4 — 性能（按需）

- DB 写入合并 / 迁移 SQLite。
- 并发上限配置化（设置页）。

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

## 11. 涉及文件（预估）

| 阶段 | 文件 |
|------|------|
| 0 ✅ | `SessionListIcon.tsx`, `App.tsx`, `chatSlice.ts`, `layout.css`, `ChatView.tsx` |
| 1 | 新增 `src/renderer/services/chatRunnerService.ts`；重构 `ChatView.tsx`；调整 `chatSlice.ts` |
| 2 | 新增 `PendingConfirmBanner.tsx` 或侧栏组件；`App.tsx` |
| 3 | `electron/toolChatLoop.ts`（冲突检测）；`appIpc.ts`（删 session 联动） |

---

## 12. 小结

多会话并行的本质是 **把「正在看」和「正在跑」解耦**。主进程已具备 request 级隔离；渲染层需补 runner、per-session 运行表、确认队列三块。

交互上，**会话列表 Loading 状态已落地**，后续只需将 `runningSessionId` 扩展为多会话 map，并与 runner 对齐。

整体遵循「runner 单抽象 + Redux 轻量化 + 确认队列单入口」，避免引入独立任务系统或过早优化存储层，保证可维护与可渐进交付。
