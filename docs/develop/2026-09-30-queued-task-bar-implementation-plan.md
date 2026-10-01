# 排队任务横条 实施计划

日期：2026-09-30（v3，按两轮评审修订）
依据：`docs/requirement/queued-task-bar-requirement.md`（D1–D7）
评审：`docs/review/2026-09-30-queued-task-bar-implementation-plan-review.md`（v1 4 项 + v2 3 项，闭环见 §7）
性质：实施方案。任务粒度以「可机械判定完成」为准；本文不含需要人工观察或运行时测量才能判定的验收项。

> **修订摘要**
> v2：①搜索排除下沉到数据库语料与匹配入口；②补 `src/shared/api.ts` 契约与跨层测试；③编辑态改为 ChatView 受控并补齐被执行/取消反馈；④补齐通用错误展示与重试。
> v3：⑤编辑态关闭判据由「`displayEntries` 换代」改为「`sessionId` + `displayGeneration`」，避免正常流式/追加/分页更新误关编辑器；⑥`onBeginEdit` 增加未保存改动阻止切换；⑦补行内编辑焦点管理任务与断言。

## 1. 范围与交付物

覆盖需求文档 D1–D7：横条取代消息列表中的排队卡片、置于输入框上方、序号与顺序、3 行高度上限、取消、行内编辑（仅文本）、搜索排除（含数据库语料）、文案去重。

| 类型 | 文件 |
|------|------|
| 新增 | `src/renderer/components/Chat/QueuedTaskBar.tsx` |
| 新增 | `src/renderer/components/Chat/QueuedTaskBar.test.tsx` |
| 新增 | `src/renderer/components/Chat/ChatView.queuedBar.test.tsx` |
| 新增 | `electron/database/operations.updateQueuedMessage.test.ts`（含搜索语料排除用例） |
| 新增 | `electron/ipc/agentProtocolIpc.updateQueuedMessage.test.ts` |
| 修改 | `src/shared/chatMessageQueue.ts`、`src/shared/chatMessageQueue.test.ts` |
| 修改 | `src/shared/api.ts`（**新增 IPC 契约声明**） |
| 修改 | `src/renderer/components/Chat/MessageInput.tsx`、`ChatView.tsx` |
| 修改 | `src/renderer/services/messageMutationGateway.ts`、`src/renderer/services/chatSearchAdapter.ts` |
| 修改 | `src/renderer/theme/layout.css`、`src/renderer/i18n/resources/{zh-CN,en-US}/chat.json`、`src/renderer/i18n/types.ts`（生成） |
| 修改 | `electron/database/operations.ts`、`electron/ipc/agentProtocolIpc.ts`、`electron/preload.ts` |

**明确不做**（避免引入不可判定任务）：

- 不清理 `ChatBubble.tsx` 的排队分支（`queued` / `showCancelQueued` / `chat-cancel-queue-btn`）——保留为纵深防御；本迭代不动。
- 本计划原不新增编辑附件、排序调整、暂停队列、编辑已发送消息；排序调整由后续用户请求补充，本次按 TDD 增加持久化拖动排序。
- 不改数据库 schema、不改领域类型 `Message` 结构（但新增 `api.ts` 方法声明）、不改排队判定与消费时序。

## 2. 实现约束（已核实）

| 编号 | 事实 | 位置 | 对实现的影响 |
|------|------|------|--------------|
| C1 | `Message` 类型**没有** `sequence` 字段 | `src/shared/domainTypes.ts:723-746` | 「按 sequence 排序」不能靠 `Message` 字段实现，只能依赖数组顺序 |
| C2 | `state.messages = displayEntries.map(e => e.message)` | `src/renderer/store/chatSlice.ts:52-54` | `messages` 数组顺序即 `DisplayOrder` 顺序 |
| C3 | `listQueuedUserMessages` 现按 `timestamp` 重排 | `src/shared/chatMessageQueue.ts:21-25` | 需去掉排序，改为保持传入顺序（D3） |
| C4 | `countQueuedUserMessages` 被主进程使用，但只用 `.length` | `electron/outbound/outboundAcceptor.ts:217` | 去掉排序不影响主进程队列上限判断 |
| C5 | `getNextQueuedUserMessage`（共享版）无生产调用点 | 全仓检索 | 改其排序无外部影响 |
| C6 | `message:patch-non-turn` 不校验消息状态 | `electron/ipc/agentProtocolIpc.ts:805-833` | 编辑不可复用它，须新增受校验入口 |
| C7 | 入队幂等按 `queue_input_requests.fingerprint` | `electron/database/operations.ts:566-587` | 编辑后必须同步重算指纹 |
| C8 | `updateMessageContent` 可 patch `content` | `electron/database/operations.ts:1285+` | 编辑底层可直接复用 |
| C9 | `ChatMessageListSearch` 把 `messages` / `displayEntries` 转发给 `ChatSearchDriver` | `src/renderer/components/Search/ChatMessageListSearch.tsx` | 过滤展示数组**不足以**覆盖搜索 |
| C10 | 搜索面板打开时会加载 DB 语料并合并：`loadSessionSearchCorpus` → `chatGetSearchCorpusPage` → `mergeSearchCorpusWithLive(dbCorpus, liveEntries)` | `chatSearchAdapter.ts:43-78`、`chatSearchCorpus.ts:37-45` | 只过滤 live 数组会漏掉 DB 语料；须在「进入匹配的单一出口」排除 |
| C11 | `getSearchCorpusPage` 的 SQL 无状态过滤 | `electron/database/operations.ts:1196-1219` | 数据库语料会把排队消息带回来，需在 SQL 层排除 |
| C12 | `preload.ts` 的 `api` 标注为 `SpaceAssistantApi`，接口定义在 `src/shared/api.ts` | `electron/preload.ts:3-5`、`src/shared/api.ts:254-288` | 新 IPC 若不在 `api.ts` 声明，preload 与渲染端调用都会类型报错 |
| C13 | 渲染端错误展示既有通道为 antd `message.error(formatUserFacingError(err))` | `ChatView.tsx`（`handleThinkingSelect` 等） | 编辑通用失败须走该通道 |
| C14 | `displayEntries` 在**追加、确认落库（ack）、patch、删除、向前分页**时都会被重新赋值；`displayGeneration` 仅在 `setDisplayPage`（页面/会话加载，`ChatView` 自增）时变化，`prependDisplayPage` 只校验不修改 | `chatSlice.ts:145-196`、`ChatView.tsx:331` | 编辑态关闭**不得**以 `displayEntries` 换代或内容变化为判据（会把正常流式更新当成视图重载、丢弃草稿）；应以 `sessionId` + `displayGeneration` 为判据 |
| C15 | `MessageInput` 经 `forwardRef` 暴露 `MessageInputHandle.focus()`；`ChatView` 已有 `composerRef` | `MessageInput.tsx:10-14,161-172`、`ChatView.tsx:166,947` | 「横条整体卸载后焦点回到输入框」可直接实现 |

可用命令（判定手段）：`npm run test:renderer`、`npm run test:electron`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:generate-types`、`npm run i18n:check`、`npx vitest run --project renderer -t "<用例名>"`。

## 3. 任务分解

### 阶段 1：共享层顺序语义

**T1.1 修正排队列表顺序键**

- 文件：`src/shared/chatMessageQueue.ts`
- 动作：`listQueuedUserMessages` 移除 `.sort((a, b) => a.timestamp - b.timestamp)`，改为按传入数组顺序返回；补注释说明顺序由调用方保证（渲染端传入 `messages`，其顺序即 `displayEntries` 顺序 = sequence 顺序）。
- 判定：该文件不再出现 `timestamp` 参与排序；`src/shared/chatMessageQueue.test.ts` 用例 `保持传入数组顺序（不按 timestamp 重排）` 通过。

**T1.2 新增视图过滤函数**

- 文件：`src/shared/chatMessageQueue.ts`
- 动作：新增 `filterOutQueuedUserMessages(messages: Message[], sessionId: string): Message[]`，剔除该会话 `status === 'queued'` 的用户消息，其余原样保留且顺序不变。
- 判定：函数已导出；用例 `剔除当前会话排队项并保持其余顺序` 通过。

### 阶段 2：横条组件（受控展示 + 焦点）

**T2.1 组件骨架**

- 文件：`src/renderer/components/Chat/QueuedTaskBar.tsx`（新增）
- 动作：导出 `QueuedTaskBar`，**受控 + 无副作用**（不取数、不调接口、不弹提示），props：

```ts
type Props = {
  items: Message[]
  editingId: string | null
  draft: string
  submitting?: boolean
  onBeginEdit: (messageId: string) => void
  onDraftChange: (text: string) => void
  onSubmitEdit: () => void
  onCancelEdit: () => void
  onCancel: (messageId: string) => void
}
```

  - `items.length === 0` 时返回 `null`；否则 `<div className="queued-task-bar">`。
  - 标题行 `.queued-task-bar__heading`，文案 `t('queuedBar.heading', { count: items.length })`，**始终渲染**（D7）。
  - 列表 `.queued-task-bar__list`（`role="list"`，`tabIndex={-1}`，`ref={listRef}`）；每项 `.queued-task-bar__row`（`role="listitem"`）。
  - 摘要态单条：`.queued-task-bar__index`、`.queued-task-bar__dot`（`aria-hidden`）、`.queued-task-bar__summary`（`content` 或 `t('queuedBar.imageOnly')`，`title` 为全文）、附件徽标、`.queued-task-bar__cancel`（`aria-label` 为 `t('queuedBar.cancelAria', { preview })`）。
  - 编辑态单条（`items[i].id === editingId`）：`.queued-task-bar__editor`（textarea，`value = draft`，`minRows 1` / `maxRows 4`，`ref={editorRef}`）、`.queued-task-bar__save`（`disabled` 当 `submitting` 或 `draft.trim() === ''`）、`.queued-task-bar__discard`。
  - 键盘：`Enter` → `onSubmitEdit`（`Shift+Enter` 换行、不提交）；`Esc` → `onCancelEdit`；主体为可聚焦元素（`aria-label` 为 `t('queuedBar.editAria', { preview })`），`onClick` → `onBeginEdit`。
  - **焦点职责（v3 新增）**：

| 事件 | 焦点去向 | 实施点 |
|------|----------|--------|
| `editingId` 变为某条（进入编辑） | 该条 textarea `focus()` 并 `setSelectionRange(len, len)`（光标置末尾） | 组件 `useEffect([editingId])` |
| 提交失败（仍处编辑态） | 保持 textarea 焦点，不迁移 | 组件（不做任何焦点操作） |
| 提交成功 / `Esc` / 放弃（该行仍存在） | 该行主体 | 组件 `useEffect`：`editingId` 由非空转空且行仍存在时 `rowRefs.get(id)?.focus()` |
| 该行消失且横条仍有其他项 | 横条列表容器（`listRef`，`tabIndex={-1}`） | 组件 `useEffect` |
| 该行消失且横条整体卸载 | composer 输入框 | ChatView（见 T7.5） |

  - 行主体与编辑器经 `rowRefs: Map<string, HTMLElement>` 记录，卸载时清理。
- 判定：文件存在并导出 `QueuedTaskBar`；`npm run typecheck:renderer` 退出码 0。

**T2.2 组件测试**

- 文件：`src/renderer/components/Chat/QueuedTaskBar.test.tsx`（新增）
- 用例（17 条）：
  1. `无排队项时不渲染`
  2. `单条显示序号 #1 与正文摘要`
  3. `多条按传入顺序排列且序号连续`
  4. `标题行始终显示共 N 条`
  5. `纯图片消息摘要显示 queuedBar.imageOnly`
  6. `长文本摘要单行截断且 title 为全文`
  7. `点击取消按钮回调 messageId`
  8. `点击主体回调 onBeginEdit`
  9. `editingId 命中时该行渲染 textarea 且值为 draft`
  10. `编辑态 Enter 触发 onSubmitEdit 且 Shift+Enter 不触发`
  11. `编辑态 Esc 触发 onCancelEdit`
  12. `draft 为空或仅空白时保存按钮 disabled`
  13. `submitting 为 true 时保存按钮 disabled`
  14. `进入编辑后 textarea 获得焦点且光标位于末尾`
  15. `退出编辑后焦点回到该行主体`
  16. `编辑行消失且仍有其他项时焦点移至横条列表容器`
  17. `横条列表容器 tabIndex 为 -1（可编程聚焦）`
- 判定：`npx vitest run --project renderer -t "QueuedTaskBar"` 全绿（17 条均出现且通过）。

### 阶段 3：输入区接入

**T3.1 新增 slot**

- 文件：`src/renderer/components/Chat/MessageInput.tsx`
- 动作：props 增加可选 `queuedBarSlot?: ReactNode`；在 `<div className="composer">` 内、`<div className="composer-box">` 之前渲染。
- 判定：`grep -n "queuedBarSlot" src/renderer/components/Chat/MessageInput.tsx` 命中 prop 定义与渲染点。

**T3.2 移除底栏排队计数（D2）**

- 文件：`src/renderer/components/Chat/MessageInput.tsx`
- 动作：删除 `queueCount` prop（定义、默认值、`footerStatusLabel` 拼装、`.composer-status__queue` 渲染块）。
- 判定：`grep -n "queueCount\|queuePending\|composer-status__queue" src/renderer/components/Chat/MessageInput.tsx` 输出为空；`MessageInput.test.tsx` 通过。

### 阶段 4：消息列表与搜索侧

**T4.1 ChatView 取数与过滤**

- 文件：`src/renderer/components/Chat/ChatView.tsx`
- 动作：
  1. `queuedMessages = useMemo(() => sessionId ? listQueuedUserMessages(messages, sessionId) : [], [messages, sessionId])`
  2. `visibleMessages = useMemo(() => sessionId ? filterOutQueuedUserMessages(messages, sessionId) : messages, [messages, sessionId])`
  3. `visibleDisplayEntries` 同法过滤 `displayEntries`。
  4. 删除 `queueCount` 与 `countQueuedUserMessages` 引用。
- 判定：`grep -n "queueCount" src/renderer/components/Chat/ChatView.tsx` 为空；`npm run typecheck:renderer` 退出码 0。

**T4.2 接线**

- 文件：`src/renderer/components/Chat/ChatView.tsx`
- 动作：`ChatMessageViewport` 使用 `visibleMessages`；`ChatMessageListSearch` 传入 `visibleMessages` / `visibleDisplayEntries`；`MessageInput` 传入 `queuedBarSlot` 与 `QueuedTaskBar`（props 见 T7.2）。
- 判定：`grep -n "visibleMessages\|queuedBarSlot" ChatView.tsx` 均命中。

**T4.3 数据库语料排除排队消息**

- 文件：`electron/database/operations.ts` → `getSearchCorpusPage`
- 动作：SQL 增加 `AND NOT (role = 'user' AND status = 'queued')`（与 `ORDER BY sequence ASC`、`LIMIT` 及 `nextSequence` 计算兼容）。
- 判定：`grep -n "status = 'queued'" electron/database/operations.ts` 命中 `getSearchCorpusPage`；`operations.updateQueuedMessage.test.ts` 用例 `搜索语料排除排队用户消息`、`排除后游标仍能推进到下一页` 通过。

**T4.4 搜索匹配入口统一过滤（兜底）**

- 文件：`src/renderer/services/chatSearchAdapter.ts`
- 动作：在传给 `useChatStructuredSearchAdapter` 前构造单一出口 `searchEntries = entries.filter(e => e.message.status !== 'queued')`（覆盖 DB 语料 + live 数组 + 「语料加载期间新入队」竞态），以 `searchEntries` 作为 `entries` 与 `messageCount`。
- 判定：`grep -n "status !== 'queued'" src/renderer/services/chatSearchAdapter.ts` 命中。

**T4.5 列表与搜索行为测试**

- 文件：`src/renderer/components/Chat/ChatView.queuedBar.test.tsx`（新增）
- 用例（8 条）：
  1. `含排队消息时列表不渲染该排队气泡`
  2. `含排队消息时搜索语料不含该排队消息`
  3. `数据库语料已加载时排队消息不进入搜索结果`
  4. `语料加载期间新入队的消息不进入搜索结果`
  5. `排队项转正后可从搜索结果命中`
  6. `排队项转正后出现在列表中且不在横条里`
  7. `横条渲染于输入框上方容器内（DOM 顺序先于 composer-box）`
  8. `切换会话后横条只反映当前会话`
- 判定：`npx vitest run --project renderer -t "queuedBar"` 中该 8 条通过。

### 阶段 5：国际化与样式

**T5.1 文案**

- 文件：`src/renderer/i18n/resources/zh-CN/chat.json`、`src/renderer/i18n/resources/en-US/chat.json`
- 动作：新增顶层 `queuedBar` 分组 **9 个 key**：`heading`、`cancel`、`cancelAria`、`imageOnly`、`editAria`、`save`、`discardEdit`、`alreadyStarted`、`unsavedChanges`（末项为 v3 新增，取值见需求文档 §6）。
- 判定：`npm run i18n:check` 退出码 0。

**T5.2 生成类型**

- 动作：运行 `npm run i18n:generate-types`，提交 `src/renderer/i18n/types.ts` 变更。
- 判定：`grep -n "queuedBar" src/renderer/i18n/types.ts` 命中。

**T5.3 清理失效 key**

- 动作：删除 `input.queuePending`；确认 `streaming.queued` 无引用后删除。
- 判定：`grep -rn "queuePending\|streaming\.queued" src/renderer --include=*.ts --include=*.tsx | grep -v i18n/resources` 输出为空；`npm run i18n:check` 退出码 0。

**T5.4 样式**

- 文件：`src/renderer/theme/layout.css`
- 动作：删除 `.composer-status__queue`；新增 `.queued-task-bar`（`max-height: calc(标题高 + 3 * 行高)`）、`__heading`、`__list`（`overflow-y: auto`）、`__row`、`__index`、`__dot`、`__summary`（单行省略）、`__badge`、`__cancel`、`__editor`、`__save`、`__discard`；新增 `@media (prefers-reduced-motion: reduce)` 关闭入场过渡。
- 判定：`grep -c "queued-task-bar" src/renderer/theme/layout.css` ≥ 12；`grep -n "composer-status__queue" src/renderer/theme/layout.css` 为空。

### 阶段 6：主进程写通道（D5）

**T6.1 数据库函数**

- 文件：`electron/database/operations.ts`
- 动作：新增 `updateQueuedUserMessageContent(db, input: { sessionId; messageId; content }): { ok: true; message: Message; sequence: number } | { ok: false; error: 'message_not_queued' | 'empty_content' }`：
  1. 校验 `session_id` 匹配且 `role = 'user'` 且 `status = 'queued'`，否则 `message_not_queued`；
  2. `content.trim()` 为空返回 `empty_content`；
  3. 复用 `updateMessageContent`（只传 `content`，不传 `status` / `attachments`）；
  4. 同事务重算并写回 `queue_input_requests.fingerprint`；
  5. 若为会话最后一条，更新 `session.preview`；
  6. `bumpScopeVersionInTx(session:${sessionId}:messages)`。
- 判定：函数已导出；`operations.updateQueuedMessage.test.ts` 用例 `拒绝非排队消息`、`拒绝空内容`、`成功后内容与指纹同步更新`、`非最后一条不更新 preview`、`编辑已 claim 的消息返回 message_not_queued 且内容不变` 通过。

**T6.2 共享 API 契约 + IPC + preload**

- 文件：`src/shared/api.ts`、`electron/ipc/agentProtocolIpc.ts`、`electron/preload.ts`
- 动作：
  1. `SpaceAssistantApi` 新增声明（判别联合，风格对齐既有 `chatDeleteQueuedMessage`）：
     ```ts
     chatUpdateQueuedMessage: (payload: { sessionId: string; messageId: string; content: string }) =>
       Promise<{ ok: true; message: Message; sequence: number } | { ok: false; error: string }>
     ```
  2. `agentProtocolIpc.ts` 新增 `ipcMain.handle('chat:update-queued-message', ...)`，转发 T6.1 并映射为上述判别联合。
  3. `preload.ts` 暴露 `chatUpdateQueuedMessage`，返回类型与声明一致。
- 判定：三处 grep（`api.ts`、`preload.ts`、IPC 名）命中；`npm run typecheck:renderer` 退出码 0；`agentProtocolIpc.updateQueuedMessage.test.ts` 用例 `编辑成功后返回 message 与 sequence`、`编辑已 claim 的消息返回 message_not_queued`、`返回结构与 declared API 判别联合一致` 通过。

### 阶段 7：渲染端编辑接线

**T7.1 mutation gateway**

- 文件：`src/renderer/services/messageMutationGateway.ts`
- 动作：新增 `commitQueuedMessageEdit({ sessionId, messageId, content }): Promise<void>`：调 IPC；`ok === false` 时抛出**携带 error 码**的错误；成功时 dispatch `patchMessage` + `patchDisplayMessage`（`order` 保持既有 `DisplayOrder`）；不触碰 API context overlay 与 context summary。
- 判定：函数已导出；单测用例 `成功后派发 patchMessage 与 patchDisplayMessage`、`保持原 DisplayOrder`、`失败抛出含 error 码的错误` 通过。

**T7.2 ChatView 持有编辑态（关闭判据 + 切换规则）**

- 文件：`src/renderer/components/Chat/ChatView.tsx`
- 动作：新增受控状态 `editingMessageId`、`editDraft`、`editSubmitting`，实现下表。**关闭判据仅用 `sessionId` 与 `displayGeneration`（评审 v2-P1-1）**：

| 触发 | 行为 |
|------|------|
| `onBeginEdit(nextId)`，当前无编辑 | 进入编辑：`editingMessageId = nextId`、`editDraft = 该条 content` |
| `onBeginEdit(nextId)`，`nextId === editingMessageId` | **无操作**（不重置草稿） |
| `onBeginEdit(nextId)`，有编辑且 `editDraft !== 当前项原值`（存在未保存改动） | **不切换**，`message.info(t('queuedBar.unsavedChanges'))`（评审 v2-P1-2） |
| `onBeginEdit(nextId)`，有编辑且无未保存改动 | 切换到 `nextId`，草稿重置为该项 content |
| `onSubmitEdit()` | `draft === 原值` → 直接清空编辑态（不调 IPC）；否则调 `commitQueuedMessageEdit` |
| 提交成功 | 清空编辑态 |
| 提交失败且 `err.code === 'message_not_queued'` | `message.info(t('queuedBar.alreadyStarted'))` 并清空编辑态 |
| 提交失败（其他错误） | `message.error(formatUserFacingError(err))`，**保留**编辑态与草稿，允许重试 |
| `onCancelEdit()`（Esc / 放弃） | 清空编辑态，不发请求 |
| 点击取消按钮 | **先清空编辑态**（若正是该条），再调 `cancelQueuedMessage(id)` |
| `sessionId` 变化 | 清空编辑态并放弃草稿 |
| `displayGeneration` 变化 | 清空编辑态并放弃草稿 |
| `displayEntries` / `messages` 的日常更新（追加、ack、patch、删除、向前分页） | **不**关闭编辑态，草稿保留（评审 v2-P1-1） |
| `editingMessageId` 不再出现在 `queuedMessages` 中 | 若 `messages` 中该 id 存在且 `status !== 'queued'` → `message.info(t('queuedBar.alreadyStarted'))`；两种情况均清空编辑态（被取消/删除时静默） |

- 判定：`grep -n "editingMessageId\|displayGeneration" src/renderer/components/Chat/ChatView.tsx` 命中；用例见 T7.4。

**T7.3 ChatView 接线与样式**

- 文件：`src/renderer/components/Chat/ChatView.tsx`、`src/renderer/theme/layout.css`
- 动作：`queuedBarSlot` 传 `<QueuedTaskBar items={queuedMessages} editingId={editingMessageId} draft={editDraft} submitting={editSubmitting} onBeginEdit={handleBeginEdit} onDraftChange={setEditDraft} onSubmitEdit={handleSubmitEdit} onCancelEdit={handleCancelEdit} onCancel={handleCancelQueued} />`；样式补编辑态规则（编辑行自适应高度、`max-height` 放宽为「标题 + 4 行编辑行 + 1 行高」、其余条目在剩余区域滚动、编辑行滚入可视区）。
- 判定：`grep -n "QueuedTaskBar" ChatView.tsx` 命中；`grep -c "queued-task-bar__editor" layout.css` ≥ 1。

**T7.4 编辑态、错误处理与草稿保全测试**

- 文件：`src/renderer/components/Chat/ChatView.queuedBar.test.tsx`（与 T4.5 同文件）
- 用例（18 条）：
  1. `进入编辑后草稿为该条正文`
  2. `点击当前编辑项不重置草稿`
  3. `草稿与原值相同提交时不调用 IPC`
  4. `提交成功退出编辑态`
  5. `提交返回 message_not_queued 时提示 alreadyStarted 并退出编辑态`
  6. `保存失败（其他错误）时展示 formatUserFacingError 文案并保留草稿与编辑态`
  7. `失败后重试成功退出编辑态`
  8. `会话切换时关闭编辑态并放弃草稿`
  9. `displayGeneration 变化时关闭编辑态并放弃草稿`
  10. `流式更新（patchDisplayMessage）时编辑草稿保留`
  11. `消息追加（ackDisplayMessagePersisted）时编辑草稿保留`
  12. `向前分页（prependDisplayPage）时编辑草稿保留`
  13. `无未保存改动时点击另一条切换编辑目标`
  14. `有未保存改动时点击另一条不切换并提示 unsavedChanges`
  15. `编辑目标被执行（status 非 queued）时提示 alreadyStarted 并关闭编辑态`
  16. `编辑目标被取消（从 messages 移除）时静默关闭编辑态且不提示 alreadyStarted`
  17. `编辑态下点击取消按钮不显示 alreadyStarted`
  18. `编辑目标消失且横条整体卸载时焦点回到输入框`
- 判定：`npx vitest run --project renderer -t "queuedBar"` 中该 18 条通过（与 T4.5 合计 26 条）。

**T7.5 焦点闭环**

- 文件：`src/renderer/components/Chat/ChatView.tsx`
- 动作：当编辑态因「目标被执行 / 被取消 / 被切换关闭」清空，且 `queuedMessages.length === 0`（横条整体卸载）时，调用 `composerRef.current?.focus()`；否则交由 T2.1 的组件内焦点规则处理（回到该行主体，或移到横条列表容器）。
- 判定：`grep -n "composerRef.current?.focus" src/renderer/components/Chat/ChatView.tsx` 命中；T7.4 用例 18 通过。

### 阶段 8：全量验证

- 动作：依次运行 1) `npm run typecheck:renderer` 2) `npm run typecheck:shared` 3) `npm run test:renderer` 4) `npm run test:electron` 5) `npm run i18n:check`
- 判定：五条命令退出码均为 0。

## 4. 完成判定清单（可直接勾选）

| 完成 | 任务 | 判定依据（机械可查） |
|------|------|----------------------|
| [ ] | T1.1 | `chatMessageQueue.ts` 无 timestamp 排序；用例「保持传入数组顺序」通过 |
| [ ] | T1.2 | 导出 `filterOutQueuedUserMessages`；用例「剔除当前会话排队项」通过 |
| [ ] | T2.1 | `QueuedTaskBar.tsx` 存在并导出；typecheck 0 |
| [ ] | T2.2 | `QueuedTaskBar` 17 条用例通过（含 4 条焦点用例） |
| [ ] | T3.1 | grep `queuedBarSlot`（MessageInput.tsx）命中 2 处 |
| [ ] | T3.2 | grep `queueCount\|queuePending\|composer-status__queue`（MessageInput.tsx）为空 |
| [ ] | T4.1 | grep `queueCount`（ChatView.tsx）为空；typecheck 0 |
| [ ] | T4.2 | grep `visibleMessages` 与 `queuedBarSlot`（ChatView.tsx）命中 |
| [ ] | T4.3 | `getSearchCorpusPage` SQL 含排队排除；2 条语料用例通过 |
| [ ] | T4.4 | grep `status !== 'queued'`（chatSearchAdapter.ts）命中 |
| [ ] | T4.5 | 列表/搜索 8 条用例通过 |
| [ ] | T5.1 | `npm run i18n:check` 退出码 0（含 `unsavedChanges`） |
| [ ] | T5.2 | grep `queuedBar`（i18n/types.ts）命中 |
| [ ] | T5.3 | grep `queuePending`、`streaming.queued`（renderer 非资源目录）为空 |
| [ ] | T5.4 | grep `queued-task-bar`（layout.css）≥ 12；`composer-status__queue` 为空 |
| [ ] | T6.1 | 导出 `updateQueuedUserMessageContent`；5 条 DB 用例通过 |
| [ ] | T6.2 | 三处 grep 命中；typecheck 0；3 条契约用例通过 |
| [ ] | T7.1 | 导出 `commitQueuedMessageEdit`；3 条 gateway 用例通过 |
| [ ] | T7.2 | grep `editingMessageId` 与 `displayGeneration`（ChatView.tsx）命中 |
| [ ] | T7.3 | grep `QueuedTaskBar`（ChatView.tsx）命中；编辑态样式类存在 |
| [ ] | T7.4 | 编辑态/错误/草稿保全 18 条用例通过 |
| [ ] | T7.5 | grep `composerRef.current?.focus` 命中；用例 18 通过 |
| [ ] | T8 | 5 条命令退出码均为 0 |

## 5. 实施顺序与依赖

1. T1.x 无依赖，先做。
2. T2.x 依赖 i18n key 存在；可与 T5.1 合并为同一 PR。
3. T3.x、T4.x 依赖 T2.1 的组件导出。
4. T4.3 / T4.4 独立于横条，可并行。
5. T6.x 独立于渲染层；T6.2 的 `api.ts` 声明必须先于 T7.1。
6. T7.x 依赖 T2.1（组件）、T6.2（契约与 IPC）；T7.5 依赖 T7.2 的状态机。
7. T8 最后执行。

## 6. 风险与回滚

| 风险 | 表现 | 处置 |
|------|------|------|
| 顺序回归 | 去掉 timestamp 排序后顺序与执行顺序不一致 | T1.1 单测固定契约；主进程只用 `.length`（C4） |
| 搜索漏排 | 仅过滤展示数组时 DB 语料仍命中 | T4.3（SQL）+ T4.4（匹配入口兜底）；T4.5 用例 2–5 覆盖 |
| 契约缺失 | 未在 `api.ts` 声明导致类型报错 | T6.2 列为交付物；T8 typecheck 兜底 |
| **草稿被正常更新清空** | 流式/追加/分页时误关编辑器 | 关闭判据限定为 `sessionId` + `displayGeneration`（C14）；T7.4 用例 10–12 覆盖 |
| **草稿被切走** | 点另一条直接覆盖草稿 | `onBeginEdit` 比较草稿与原值并阻止切换（T7.2）；T7.4 用例 13–14 覆盖 |
| **焦点丢失** | 进入编辑无法直接输入；退出后焦点落 `body` | T2.1 焦点规则表 + T7.5；T2.2 用例 14–17、T7.4 用例 18 覆盖 |
| 编辑竞态 | 提交时该条已被 claim | T6.1 事务内校验返回 `message_not_queued`；T7.4 用例 5 覆盖 |
| 误报已执行 | 主动取消/切换时错弹「已开始执行」 | T7.2 区分消失原因；T7.4 用例 16–17 覆盖 |
| 指纹不一致 | 编辑后重放 enqueue 抛指纹不匹配 | T6.1 第 4 步同事务重算；T6.1 用例 3 覆盖 |
| 回滚 | 需临时恢复「列表内排队卡片」 | 回滚 T3.2 / T4.1 / T4.2 三处接线；`ChatBubble` 分支未删除 |

## 7. 评审阻断项闭环表

### 7.1 第一轮（v1）

| 评审项 | 闭环任务 | 判定 |
|--------|----------|------|
| P1-1 搜索只覆盖展示页，DB 语料仍返回排队消息 | T4.3 + T4.4 + T4.5 用例 2–5 | 两条来源均排除；三个时序用例通过 |
| P1-2 新 IPC 缺共享 API 契约 | T6.2 + 契约用例 | 三处 grep 命中 + typecheck 0 |
| P1-3 编辑态生命周期不全（会话/视图切换、被执行反馈） | T7.2 + T7.4 用例 8、15、16 | 各路径有独立用例（视图重载判据已在 v3 修正） |
| P1-4 编辑失败缺用户可见处理 | T7.2 + T7.4 用例 6–7 | 失败提示、草稿保留、重试成功 |

### 7.2 第二轮（v2 复审）

| 评审项 | 闭环任务 | 判定 |
|--------|----------|------|
| P1-1 以 `displayEntries` 换代判定视图重载，会丢弃草稿 | T7.2 关闭判据改为 `sessionId` + `displayGeneration`（C14）；T7.4 用例 9–12 | 日常更新 3 条用例验证草稿保留，重载 1 条验证关闭 |
| P1-2 `onBeginEdit` 无条件覆盖当前编辑目标 | T7.2 切换规则表 + 新增 `queuedBar.unsavedChanges`（T5.1）；T7.4 用例 13–14 | 有/无未保存改动两条路径各有用例 |
| P1-3 行内编辑焦点管理未进入任务 | T2.1 焦点职责表 + T7.5 + T2.2 用例 14–17 + T7.4 用例 18 | 进入编辑、退出编辑、行消失、横条卸载四种焦点去向各有断言 |

## 8. 本方案不包含的验收方式

以下方式均需人工观察或运行时测量，不作为本迭代的完成判据：

- 目测横条位置、间距、配色、明暗主题观感；
- 真实点击/拖动的手感评估、动画流畅度主观评价；
- 生成过程中的帧率、渲染耗时、长列表性能测量；
- 部署后的线上指标观察与阈值统计。

对应的客观替代已并入任务判定：DOM 结构与 `class` 断言、焦点断言（T2.2、T4.5、T7.4）、类型检查与 i18n 校验（T8）。
