# 排队任务横条（置于输入框上方）— 需求规格

> 状态：决策已定（D1–D7，见 §10.1）；无待确认项
> 关键词：排队消息、composer、消息列表、行内编辑、固定承载区

---

## 1. 概述

当前「排队中的任务」以**普通用户气泡卡片**的形式插在消息列表末尾（`message.role === 'user' && message.status === 'queued'`），只在卡片上多一个「排队中」状态标签与「取消排队」按钮。

问题：会话运行期间，助手的过程消息（思考、工具调用卡片、批次折叠块等）持续追加到列表末尾，会把排队卡片**不断向上顶**。用户想确认「我排了几条、排的是什么」时，需要向上翻找，且位置随生成进度漂移，找不到。

本需求把排队中的任务从消息列表**移出**，改为在**输入框上方**以**横条（bar / row）列表**固定呈现：位置稳定、不随生成过程漂移、一眼可见、可就地取消，并支持**行内编辑文本**。

目标：让「已提交但尚未开始执行」的输入随时可见、可管理、可修正，消除位置漂移与查找成本；不改变排队判定与执行机制本身。

### 1.1 非目标

- 不改变排队判定的业务规则（何时排队、何时直接发起、何时拒绝）——该决定继续由**主进程受理端口**做出，渲染端只表达意图。
- 不改变队列上限（沿用 `MAX_CHAT_MESSAGE_QUEUE_SIZE = 10`）与主进程落库/消费时序。
- **不提供编辑排队消息的附件**（只允许改文本；既有附件原样保留）。
- 不提供「调整排队顺序（拖拽/置顶）」「暂停队列」等能力。
- 不提供编辑**已发送 / 已进入上下文**的消息（该能力不在本需求范围）。
- 不为排队任务新增未读数角标、通知或独立面板。

> 范围变更说明：早期版本将「编辑排队消息」列为非目标，Q5 决策（D5）后已纳入范围，仅限文本。

### 1.2 术语澄清

代码中存在两套「queue」，本需求只涉及第一套，实现时勿混淆。文中「排队任务」与「排队消息」「排队用户消息」为同一实体的不同称呼：

| 名称 | 载体 | 是否面向用户 | 本需求 |
|------|------|--------------|--------|
| 排队用户消息 | `messages.status === 'queued'`（`role = 'user'`） | 是 | **对象** |
| turn 执行队列 | `session_execution_queue` / `queue_input_requests` 表 | 否（主进程内部并发控制） | 逻辑不变（但编辑需同步其 receipt 指纹，见 §3.7） |

---

## 2. 现状与复用

### 2.1 现状事实（实现依据）

| 关注点 | 位置 | 现状 |
|--------|------|------|
| 排队态判定 | `src/shared/chatMessageQueue.ts` → `isQueuedUserMessage` | `role === 'user' && status === 'queued'` |
| 列出/计数/取队首 | 同文件 → `listQueuedUserMessages` / `countQueuedUserMessages` / `getNextQueuedUserMessage` | 按 `timestamp` 升序；已按 `sessionId` 过滤 |
| 上限 | 同文件 → `MAX_CHAT_MESSAGE_QUEUE_SIZE = 10` | 沿用，不修改 |
| 排队卡片渲染 | `ChatBubble.tsx` | 「排队中」标签（`:210`）、「取消排队」按钮（`:211-213`）、行级 `chat-bubble-row--queued`（`:328`）、`queued` 透传（`:349-351`） |
| 列表侧接线 | `ChatView.tsx` | `canCancelQueuedMessage`（`:795-798`）→ `canCancelQueued`（`:860`） |
| 取消动作 | `ChatView.tsx` → `cancelQueuedMessage`（`:460-472`）→ `messageMutationGateway.commitMessageDelete` | 调 `chat:delete-queued-message`；失败提示 `chatView.warnings.cancelQueueFailed` |
| 输入区计数（现状） | `MessageInput.tsx`（`:118`、`:503-505`） | running 态底栏显示「还有 {{count}} 条排队」（`input.queuePending`） |
| 发送并排队 | `MessageInput.tsx`（`:378`、`:533-537`） | running 且有文本时，发送按钮变为「发送并排入队列」 |
| 输入区容器 | `MessageInput.tsx` → `<div className="composer">` 包 `<div className="composer-box">` | `.composer` 为底栏容器（`theme/layout.css:1388`） |
| 排队消息入库 | `electron/database/operations.ts` → `enqueueQueuedUserMessage`（`:566-587`） | 以 `status: 'queued'` 落库，并写入 `queue_input_requests` receipt（含 `fingerprint`） |
| 入队幂等 | 同函数 | 同 `requestId` 重放而指纹不一致时抛 `QUEUE_REQUEST_FINGERPRINT_MISMATCH` |
| 消息内容更新（底层） | 同文件 → `updateMessageContent`（`:1285+`） | 可 patch `content` / `status` / `attachments` 等，**不校验消息状态** |
| 非 turn 消息 patch 通道 | `agentProtocolIpc.ts:805` → `message:patch-non-turn` | 直接调 `updateMessageContent`，无状态校验（故**不可**复用为本需求的编辑通道） |
| 排队 → 执行 | 同文件 `claimQueuedTurnAtomically`（`:590-612`，`:602`） | 状态改为 `sent`，写入输入历史，并同 turn 创建助手 `streaming` 消息 |
| 取消排队（主进程） | 同文件 `deleteQueuedUserMessage`（`:1250-1275`） | 删除消息、receipt 置 `cancelled`、更新会话计数与预览 |
| 上下文资格 | `chatMessageQueue.ts` → `filterMessagesForChatApi` | **排队消息已被排除**，不进入 LLM 上下文 |
| 渲染端 mutation 网关 | `src/renderer/services/messageMutationGateway.ts` | 已有 `commitMessagePatch` / `commitMessageDelete`，统一「先 await DB，再原子更新 store」 |
| 相关样式 | `theme/layout.css` | `.chat-bubble-row--queued`（`:894`）、`.chat-cancel-queue-btn`（`:984`）、`.composer-status__queue`（`:1505`） |
| 相关文案 | `src/renderer/i18n/resources/zh-CN/chat.json` | `streaming.queued`（`:24`）、`streaming.cancelQueue`（`:25`）、`input.queuePending`（`:111`）、`input.hintRunningQueue`（`:109`）、`input.queueSend`（`:110`） |

### 2.2 复用原则

- **数据读取不改**：横条数据源复用 `listQueuedUserMessages(messages, sessionId)`，不新增 store 切片。**排序键须统一为 `sequence`**：该方法现按 `timestamp` 排序，而主进程取队首按 `sequence` 升序（`getNextQueuedMessage`），二者口径不同会让横条序号与实际执行顺序脱节（决策 D3）。
- **取消不改**：横条「取消」复用既有 `cancelQueuedMessage(messageId)`（→ `commitMessageDelete`），不新建接口。
- **编辑复用底层写函数**：编辑走**新增的受校验入口**（§3.7），其内部复用既有 `updateMessageContent`；**不复用** `message:patch-non-turn`（该通道不校验状态，会把已执行的排队消息也改掉）。
- **组件模式复用**：输入区已有 slot 注入模式（`modelSlot` / `thinkingSlot`），横条按同一模式注入，避免在 `MessageInput` 内耦合聊天数据。

---

## 3. 方案与功能行为

### 3.1 方案（已定）

1. 新增展示组件 `src/renderer/components/Chat/QueuedTaskBar.tsx`，接收 `items: Message[]`、`onCancel(messageId)`、`onEdit(messageId, content)`，**纯展示 + 回调**，不自行取数。
2. `ChatView.tsx` 用 `useMemo` 计算当前会话排队列表，作为 slot 注入 `MessageInput`。
3. `MessageInput.tsx` 新增可选 prop（如 `queuedBarSlot?: ReactNode`），在 `<div className="composer">` 内、`<div className="composer-box">` **之前**渲染（决策 D1）。
4. 消息列表侧**过滤掉**当前会话的排队用户消息，使其不再进入 `ChatMessageViewport` 渲染（见 §3.4）。
5. 移除底栏重复计数 `composer-status__queue`（决策 D2，见 §4.3）。
6. 新增受校验的编辑写通道（决策 D5，见 §3.7 与 §7）。

> 不采用「在 `ChatView` 中把横条放在 `MessageInput` 兄弟位置」的备选：那样横条会落在 `.composer` 的 `border-top` 之外，与输入框视觉分离，不符合「贴合输入框」的目标。

### 3.2 显隐与排序

| 条件 | 行为 |
|------|------|
| 当前会话无排队消息（`items.length === 0`） | 整块**不渲染**（不占位、无空态） |
| 有 ≥ 1 条 | 渲染横条区，按 `sequence` 升序（即真实执行顺序）自上而下排列，队首（待执行）在最上（决策 D3） |
| 会话切换 | 按新会话的排队列表重算；旧会话的排队消息不显示；若有进行中的行内编辑则关闭（见 §3.7） |
| 无会话（`sessionId` 为空） | 不渲染 |

### 3.3 横条交互

| 元素 | 行为 |
|------|------|
| 序号 | 显示 `#1`、`#2`…（随横条顺序，队首为 `#1`），用于表达执行次序（决策 D3） |
| 内容摘要 | 显示排队消息正文的**单行省略**文本；附件存在时在尾部追加附件数量徽标（如「+2 张」） |
| 悬停 | 原生 `title` 展示完整内容（换行折叠），便于确认 |
| 点击主体 | 进入**行内编辑**（决策 D5，规格见 §3.7）。主体须为可聚焦元素（`role="button"` 或 `<button>`），保证键盘可达 |
| 取消按钮 | 点击 → 调 `onCancel(messageId)` → 复用 `cancelQueuedMessage`；成功后该项**立即从横条消失**（由 store 更新驱动，本地不预删）。失败沿用 `chatView.warnings.cancelQueueFailed` 警告，该项保持可见 |
| 状态点 | 每行仅一个状态点，**不带文字**；「排队中」语义由标题行承载，避免同屏重复（决策 D7）。状态点须有可访问名（见 §5） |
| 新条目入场 | 新排队消息出现时轻微淡入上滑，提示「已排入」；动效参数见 §4.2 |

### 3.4 消息列表侧的行为

- `ChatMessageViewport` 接收的消息集合需**排除当前会话的排队用户消息**（新增一层过滤，如 `visibleMessages`），确保不再出现重复展示。
- 搜索排除须覆盖**两条数据来源**：展示数组（`messages` / `displayEntries`）与**数据库搜索语料**（搜索面板打开时经 `chatGetSearchCorpusPage` 加载、再由 `mergeSearchCorpusWithLive` 合并）。排队消息应在进入匹配的单一出口统一排除（决策 D6），数据库语料查询本身也应排除 `status = 'queued'` 的用户消息，避免「搜得到但定位不到」的不一致。
- `ChatBubble` 中排队相关分支（`queued` 标签、`showCancelQueued` 按钮、`chat-bubble-row--queued`）**保留实现**（作为纵深防御），但因不再有排队消息进入列表而不再触发；如需清理，属可选的收尾项，不作为验收条件。清理后 `ChatView` 的 `canCancelQueued` 接线同步失效，可一并移除。
- 数据层面不变：消息仍以 `status: 'queued'` 落库；`filterMessagesForChatApi` 继续将其排除在上下文之外。

### 3.5 「转正」衔接（关键）

排队消息执行时，主进程 `claimQueuedTurnAtomically` 把该消息 `status` 由 `queued` 改为 `sent`（`operations.ts:602`）。

预期效果：该消息**从横条消失**，同时以**正常用户气泡**出现在消息列表中的原有位置（其 sequence 不变），助手回复紧随其后流式输出。

要求：不出现「横条消失但气泡迟迟不出现」的空窗（由同一次状态更新驱动，渲染端不得本地预删除排队项）；不出现同一条消息「横条与气泡同时存在」的重复。

### 3.6 边界情况

| 场景 | 期望 |
|------|------|
| 连续排队多条（≤10） | 横条依次堆叠，编号连续，队首在最上 |
| 一次性取消全部排队 | 最后一条取消后整块横条卸载，输入区回到无排队布局，无跳动残留 |
| 取消队首（`#1`） | 其余项重新编号为 `#1…#n`，队首变为原 `#2` |
| 排队期间列表因生成而变长 | 横条位置**不变**（本需求的核心收益），高度不随列表变化 |
| 排队期间用户切换会话 | 切回原会话后原排队项仍正确显示（显隐规则见 §3.2） |
| 排队消息含图片附件 | 横条显示文本摘要 + 附件数量徽标；不渲染缩略图（避免占高） |
| 排队消息为纯图片（无文本） | 摘要位显示占位文案（如「[图片]」，走 i18n），仍可取消；进入编辑后空文本不允许保存（见 §3.7） |
| 排队消息文本很长 | 单行截断 + 省略号；`title` 展示全文 |
| 排队消息数量达到上限 | 沿用现有上限行为（超出提交被主进程拒绝），横条仅展示实际存在的条目，不新增溢出提示 |
| 正在编辑的项被执行 | 该项从横条消失，编辑态关闭，并提示「该条已开始执行，无法修改」（见 §3.7） |
| 正在编辑时用户点击另一条 | 存在未保存改动则不切换；无改动则直接切换（见 §3.7） |

### 3.7 行内编辑（决策 D5）

**进入**

- 点击横条主体（非取消按钮）→ 该行原地由「摘要行」展开为「编辑行」，内容预填原文本，自动聚焦且光标置于末尾。
- **同时只允许一条处于编辑态**。

**编辑行形态**

- 文本域（textarea），自适应高度：`minRows = 1`、`maxRows = 4`。
- 附件：不提供增删入口；既有附件仍以徽标形式显示（只读）。
- 操作区：保存（主操作）与放弃编辑两个按钮，键盘可达。

**键盘与提交**

| 操作 | 行为 |
|------|------|
| `Enter` | 提交保存（与 composer 的发送习惯一致） |
| `Shift + Enter` | 换行 |
| `Esc` | 取消编辑，放弃本次改动，回到摘要行 |
| 内容为空（或仅空白） | 保存按钮禁用；`Enter` 不提交 |
| 内容与原值相同 | 视为无改动，直接退出编辑态（不发起写请求） |

**提交结果**

| 结果 | 行为 |
|------|------|
| 成功 | 该行摘要更新为新文本，退出编辑态；**sequence 与横条位置不变**（位置不变是本决策的核心收益） |
| 失败：`message_not_queued`（已被 claim 执行或已被删除） | 退出编辑态，提示「该条已开始执行，无法修改」（新 i18n key）；该项随 store 更新消失 |
| 失败：`empty_content` | 前端已禁用，不应出现 |
| 其他失败 | 沿用现有用户可见错误格式化（`formatUserFacingError`），保持编辑态不退出，便于重试 |

**与列表 / 会话的交互**

- 编辑态中该条被执行（状态由 `queued` 变为其他）：横条项消失 → 编辑态自动关闭 → 提示「该条已开始执行，无法修改」。
- 编辑态中该条被**主动取消**（或已被删除）：编辑态**静默**关闭，**不得**提示「该条已开始执行」——该提示只用于「已进入执行」这一情况。
- 会话切换或消息列表**视图重载**：编辑态关闭并放弃未保存改动。判据必须是「会话标识」与「列表重载代次」，**不得**用消息数组的引用或内容变化作判据——助手流式输出、消息追加、确认落库、向前分页等日常更新都会重写该数组，用它判定会把正常更新误当成重载、丢弃用户正在编辑的草稿。
- 正在编辑时点击另一条：有未保存改动则**不切换**并提示（`queuedBar.unsavedChanges`）；无改动则切换编辑目标；点击当前正在编辑的条目不重置草稿。
- 焦点：进入编辑时焦点移入 textarea 且光标置于末尾；提交成功或取消后焦点回到该行主体；若该行已消失而横条仍有其他条目，焦点移至横条列表区域；若横条整体卸载，焦点回到输入框。

**写通道规格（主进程）**

新增 IPC `chat:update-queued-message`，入参 `{ sessionId, messageId, content }`：

1. 事务内读取消息，校验 `role === 'user' && status === 'queued'`；不满足则返回 `{ ok: false, error: 'message_not_queued' }`。
2. `content.trim()` 为空则返回 `{ ok: false, error: 'empty_content' }`。
3. 复用 `updateMessageContent(db, messageId, { content })`（**不触碰** `status` 与 `attachments`）。
4. **重算并写回 `queue_input_requests.fingerprint`**（`queueInputFingerprint({ text: content, attachments })`），使入队幂等校验与内容保持一致；否则同 `requestId` 重放会抛 `QUEUE_REQUEST_FINGERPRINT_MISMATCH`。
5. 若该消息为会话最后一条，更新 `session.preview`。
6. `bumpScopeVersion(session:{sessionId}:messages)`，返回 `{ ok: true, message, sequence }`。

**渲染端**：在 `messageMutationGateway` 新增 `commitQueuedMessageEdit`，成功后 dispatch `patchMessage` + `patchDisplayMessage`（保持原 sequence，不改变排序）；排队消息不在 API context overlay 中，**不触碰** overlay 与 context summary。

---

## 4. 视觉规格

### 4.1 位置与层级

- 位于输入框**上方**、消息滚动区**下方**，属于底栏（composer）区块的一部分，**固定不随消息滚动**。
- 插入点（决策 D1，已定）：`.composer` 容器内、`.composer-box` **之前**（即输入框外框的顶部之上、底栏内边距之内），与输入框视觉贴合。
- 与输入框之间留约 `8px` 间距；与底栏左右内边距对齐（沿用 `.composer` 的 `padding: 12px 16px` 口径）。
- 层级低于弹窗/抽屉/确认浮层，不做成绝对定位浮层（避免遮挡列表与输入框）。

### 4.2 外观

| 属性 | 规格 |
|------|------|
| 形态 | 横向条（摘要态行高约 28–32px），圆角沿用 `--sa-radius-*`，背景区别于输入框底色 |
| 标题行 | **始终显示**（条目 ≥ 1 条时），形如「排队中 · 共 N 条」，小号次要文字（决策 D7；自此「排队中」文字只出现在标题行） |
| 单条结构（摘要态） | `[序号] [状态点] [内容摘要（flex:1，单行省略）] [附件徽标?] [取消按钮]` |
| 单条结构（编辑态） | `[序号] [状态点] [textarea（自适应 ≤4 行）] [取消按钮] [保存] [放弃编辑]` |
| 内容摘要 | `text-overflow: ellipsis; white-space: nowrap; overflow: hidden` |
| 取消按钮 | 图标按钮（`X` 系）或文字按钮，沿用 `chat-cancel-queue-btn` 的视觉语言；`aria-label` 带内容摘要 |
| 滚动（摘要态） | 限制最大高度为 3 条行高（决策 D4），超出**内部滚动**；滚动不带动消息列表 |
| 滚动（编辑态） | 被编辑行高度自适应；横条区上限放宽为「标题 + 编辑行（≤4 行）+ 1 条行高」，其余条目在剩余区域内滚动；进入编辑时将编辑行滚入可视区 |
| 颜色 | 使用主题 token（`--sa-border` / `--sa-bg-elevated` / 次要文字色），明暗主题一致可读 |
| 动效 | 入场淡入 + 上滑 150ms；取消消失可瞬时或淡出；`prefers-reduced-motion` 下降级为无过渡（本文件唯一的动效规格来源） |

### 4.3 与底栏现有排队计数（`input.queuePending`）的关系

底栏现有计数（见 §2.1「输入区计数（现状）」）在横条上线后与之信息重复，且窄宽度下会被折叠。

**决策 D2（已确认：移除）**：删除底栏中的 `composer-status__queue` 计数展示，由横条标题统一承载「共 N 条」。计数一律以横条数据源为准，即 `items.length`（`MessageInput` 原有的 `queueCount` prop 随之停用；若已无其他用途可一并删除）。`input.queuePending` 因此不再被 UI 引用（key 保留或清理由实现决定，需通过 i18n 校验）。

---

## 5. 无障碍

- 横条区使用 `role="list"`（或 `ul/li` 语义），每条为 `listitem`。
- 横条主体为可聚焦元素，`aria-label` 形如「编辑排队消息：{{摘要}}」；取消按钮为原生 `<button>`，可 `Tab` 聚焦、`Enter`/`Space` 触发，`focus-visible` 有可见焦点环。
- 取消按钮 `aria-label` 形如「取消排队：{{摘要}}」，保证屏幕阅读器可辨识目标条目。
- 因行内状态点不含文字（决策 D7），须保证「排队中」语义可被读出：由标题行（`role="status"` 或等价）或每个 `listitem` 的 `aria-label` 承载，二者取其一。
- 编辑态：进入时将焦点移入 textarea 且光标置于末尾；`Esc` 取消；保存 / 放弃按钮键盘可达；提交或取消后焦点回到该行主体（避免焦点丢失到 `body`）；若该行已消失而横条仍有其他条目，焦点移至横条列表区域；若横条整体卸载，焦点回到输入框。
- 排队条数变化可经 `aria-live="polite"` 区域播报（可选，避免频繁打断生成中的朗读）。
- 动画降级规则以 §4.2 为准。

---

## 6. 国际化

- 新增 key 归属 `chat` 命名空间（建议收拢在 `queuedBar` 分组），中英同步：

| key | zh-CN | en-US（建议） |
|-----|-------|---------------|
| `queuedBar.heading` | 排队中 · 共 {{count}} 条 | Queued · {{count}} total |
| `queuedBar.cancel` | 取消排队 | Cancel queued |
| `queuedBar.cancelAria` | 取消排队：{{preview}} | Cancel queued: {{preview}} |
| `queuedBar.imageOnly` | [图片] | [Image] |
| `queuedBar.editAria` | 编辑排队消息：{{preview}} | Edit queued message: {{preview}} |
| `queuedBar.save` | 保存 | Save |
| `queuedBar.discardEdit` | 放弃编辑 | Discard edit |
| `queuedBar.alreadyStarted` | 该条已开始执行，无法修改 | This message has already started; it can no longer be edited |
| `queuedBar.unsavedChanges` | 当前编辑尚未保存，请先保存或放弃 | Your edit hasn't been saved yet — save or discard it first |

- 决策 D7 后行内不再有状态文字，「排队中」只出现在标题行，由 `queuedBar.heading` 承载；`streaming.queued` 不再被横条引用（保留 key 或清理由实现决定）。
- 禁止硬编码中文，所有可见文案走 `t()`；新增 key 后运行 `npm run i18n:generate-types` 更新类型，提交前 `npm run i18n:check` 校验。

---

## 7. 影响范围

| 文件 | 改动 |
|------|------|
| `src/renderer/components/Chat/QueuedTaskBar.tsx`（新增） | 横条组件（摘要态 + 行内编辑态，展示与回调） |
| `src/renderer/components/Chat/QueuedTaskBar.test.tsx`（新增） | 组件测试 |
| `src/renderer/components/Chat/MessageInput.tsx` | 新增 `queuedBarSlot` prop 并在 `composer-box` 之前渲染（决策 D1）；移除底栏 `composer-status__queue` 计数（决策 D2） |
| `src/renderer/components/Chat/ChatView.tsx` | 计算 `queuedMessages`，注入 slot；消息列表过滤排队项；接线 `onEdit`；可选清理 `canCancelQueued` |
| `src/renderer/services/messageMutationGateway.ts` | 新增 `commitQueuedMessageEdit`（成功后 `patchMessage` + `patchDisplayMessage`，保持 sequence） |
| `src/renderer/services/chatSearchAdapter.ts` | 搜索匹配入口统一排除排队消息（覆盖数据库语料与展示数组，决策 D6） |
| `src/shared/api.ts` | 新增 `chatUpdateQueuedMessage` 契约声明（判别联合，与 preload 一致） |
| `src/renderer/theme/layout.css` | 新增 `.queued-task-bar*` 样式（含编辑态）；`.composer` 内间距微调 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/chat.json` + 生成类型 | 新增 `queuedBar.*` |
| `electron/preload.ts` | 新增 `chatUpdateQueuedMessage` → `chat:update-queued-message` |
| `electron/ipc/agentProtocolIpc.ts` | 新增 `chat:update-queued-message` handler（校验 queued + 复用 `updateMessageContent` + 重算指纹 + 更新 preview + bump scope） |
| `electron/database/operations.ts` | 新增 `updateQueuedUserMessageContent`（事务内校验 `status = 'queued'`、更新内容、同步 receipt 指纹、更新会话预览）；`getSearchCorpusPage` 的 SQL 排除排队用户消息 |
| `src/renderer/components/Chat/ChatBubble.tsx` | 仅可选清理排队分支（非验收项），不改数据语义 |

改动边界：**新增 1 条 IPC 通道**；不改领域类型（`Message` 结构不变）、不改排队判定与消费时序、不改数据库 schema（仅更新既有行）。

---

## 8. 测试

| 用例 | 期望 |
|------|------|
| 无排队消息 | 横条不渲染 |
| 1 条排队 | 横条出现，编号 `#1`，摘要为消息文本 |
| 3 条排队 | 顺序与执行顺序一致（按 `sequence`），队首 `#1` 在最上，标题显示「共 3 条」 |
| 同毫秒内连续排队两条 | 横条顺序与主进程取队首顺序一致（按 `sequence`，而非 `timestamp`） |
| 消息列表中含排队消息 | 列表中**不**出现该排队气泡（无重复） |
| 点击取消（队首） | 调 `cancelQueuedMessage`，该项消失，其余重新编号 |
| 取消全部 | 横条整块卸载，列表与输入区无布局跳动 |
| 取消失败（mock 抛错） | 提示 `chatView.warnings.cancelQueueFailed`，条目保留 |
| 生成过程中新增过程消息 | 横条位置与高度不变 |
| 排队消息被执行 | 该项从横条消失，同时以用户气泡进入消息列表（不重复、不空窗） |
| 切换会话 | 横条随会话切换，互不串号 |
| 纯图片排队消息 | 摘要显示 `queuedBar.imageOnly` |
| 长文本 | 单行截断且 `title` 为全文 |
| `prefers-reduced-motion` | 无入场动画 |
| 搜索结果 | 不含排队消息 |
| 点击主体进入编辑 | 该行展开为 textarea，预填原文本并聚焦 |
| 编辑后保存成功 | 摘要更新为新文本，**横条顺序与位置不变**（sequence 未变） |
| 编辑期间该条被执行（服务端返回 `message_not_queued`） | 退出编辑态并提示「该条已开始执行，无法修改」 |
| 保存空内容 | 保存按钮禁用，`Enter` 不提交 |
| 编辑无改动后提交 | 不发写请求，直接退出编辑态 |
| `Esc` 退出编辑 | 放弃改动，摘要行恢复原文本 |
| 编辑中点击另一条（有未保存改动） | 不切换目标 |
| 会话切换时正在编辑 | 编辑态关闭，改动放弃 |
| 主进程：编辑已 claim 的消息 | 返回 `message_not_queued`，DB 内容不变 |
| 主进程：编辑成功后同 `requestId` 重放 enqueue | 不抛 `QUEUE_REQUEST_FINGERPRINT_MISMATCH`（指纹已同步） |

测试文件就近放置，命名沿用现有风格：`QueuedTaskBar.test.tsx`、`ChatView.queuedBar.test.tsx`、`electron/database/operations.updateQueuedMessage.test.ts`（如适用）。

---

## 9. 验收标准

1. 排队中的任务以横条形式固定展示在输入框上方，**不随消息列表滚动/增长而位移**。
2. 排队卡片不再出现在消息列表中；同一条消息在任意时刻**只在一处出现**（横条或气泡）。
3. 每条横条可单独取消，取消后立即消失；取消全部后整块卸载。
4. 排队项被执行时，从横条无缝转为消息列表中的用户气泡，无重复、无明显空窗。
5. 会话切换、长文本、纯图片、附件、上限等边界行为符合 §3.6。
6. 点击横条主体可行内编辑文本；保存成功后**位置与顺序不变**；空内容不可保存。
7. 该条已开始执行时保存，提示「该条已开始执行，无法修改」，且数据库内容不被改写。
8. 位置、配色、字号遵循现有主题 token；明暗主题均清晰可读。
9. 键盘可操作（含 `Tab` / `Enter` / `Esc`），`aria-label` 可辨识，动画尊重 `prefers-reduced-motion`。
10. 全部文案经 `t()` 国际化，`npm run i18n:check` 通过。
11. 不改动排队判定规则、队列上限、数据库 schema；新增写通道仅作用于 `status = 'queued'` 的消息。
12. 横条顺序与主进程取队首顺序一致（按 `sequence`），`#1` 恒为下一个执行的条目。

---

## 10. 决策记录

### 10.1 已确认

| 编号 | 决策 | 结论 |
|------|------|------|
| D1 | 横条嵌入位置（原 Q1） | 置于 `.composer` 容器内、`composer-box` 之前，与输入框贴合 |
| D2 | 底栏「还有 N 条排队」文案（原 Q3） | 移除，避免与横条标题重复 |
| D3 | 序号 + 横条排序键（原 Q2） | 显示序号 `#1`…（队首为 `#1`）；横条顺序统一按 `sequence` 升序，不用 `timestamp` |
| D4 | 横条最大可见行数（原 Q4） | 3 条行高，超出内部滚动（编辑态另有规则，见 §4.2） |
| D5 | 整条点击行为（原 Q5） | **行内展开编辑**，仅允许改文本；该条已执行时提示「该条已开始执行，无法修改」 |
| D6 | 排队消息是否可搜索（原 Q6） | 排除，与消息列表一致 |
| D7 | 「排队中」文字重复（原 Q7） | 标题行始终显示（≥1 条），行内只用状态点、不再有文字 |

### 10.2 待确认

无。实现中若出现新的分歧点，按 §11 的格式追加「决策依据」条目。

---

## 11. 决策依据留档：D5 为何新增写通道

| 事实 | 位置 | 含义 |
|------|------|------|
| 无「编辑排队消息」通道 | `electron/preload.ts` 仅有 `chatEnqueueQueuedMessage` / `chatDeleteQueuedMessage` | 需新增通道 |
| `message:patch-non-turn` 不校验状态 | `agentProtocolIpc.ts:805` → `updateMessageContent` | 直接复用会在「该条已被 claim 执行」时也改成功，制造脏数据，故**不可复用** |
| 入队带 `requestId` + fingerprint 幂等 | `enqueueQueuedUserMessage`（`operations.ts:566-587`） | 编辑后必须重算指纹，否则同 `requestId` 重放抛 `QUEUE_REQUEST_FINGERPRINT_MISMATCH` |
| 排队消息执行时写入输入历史 | `claimQueuedTurnAtomically` → `appendSessionInputHistoryInTransaction` | 存在必须处理的竞态窗口，也决定了失败提示语 |
| 底层写函数可复用 | `updateMessageContent`（`operations.ts:1285+`） | 成本本质是「加一个带校验的入口」，而非重写写库逻辑 |
| 既有取消通道 | `deleteQueuedUserMessage` + `commitMessageDelete` | 编辑的渲染端接线可照抄该模式（先 await DB，再原子更新 store） |
| 产品目前无「编辑已发送消息」能力 | — | 本次仅开放「编辑排队消息」，属有意为之的能力不对称（理由：排队消息尚未进入上下文，改动无副作用） |
