# 消息列表流式抖动修复方案

| 字段 | 内容 |
| --- | --- |
| 文档状态 | v1.1，J-01～J-04 已实施并通过自动化验收（270 文件 / 1647 用例全绿）；§6.3 手动验收待真机 |
| 评审 | [评审报告](../review/chat-message-list-streaming-jitter-fix-plan-review.md)：B-01（阻断）已修复；S-01/S-02 落入 J-04，S-03 落入 J-03 表述，S-04 记入 §5 |
| 分析日期 | 2026-09-17 |
| 问题现象 | 最新一条消息 / 最新一张卡片流式更新内容时，**整个消息列表**在视觉上剧烈抖动（滚动位置游动、跳变），而非仅最新气泡内容变化 |
| 分析范围 | `ChatView`、`ChatMessageViewport`（react-virtuoso@4.12.8）、`ChatMessageList`、`ChatBubble`、`ChatMarkdown`、`turnDisplayStore`、`pendingConfirmStore`、`theme/layout.css` |
| 关联文档 | [消息列表渲染进程性能优化技术方案](./chat-message-list-renderer-performance-optimization-design.md)（已落地两批，锁定 react-virtuoso@4.12.8）、[流式生成界面卡顿分析](./streaming-ui-performance-analysis.md)（聚焦"卡顿/掉帧"，本文聚焦"视觉抖动/滚动位置跳动"，两者互补） |
| 约束 | 每个修复项（J-xx）独立提交、可单独回退；不升级 react-virtuoso 版本；不改变 turnDisplay 推送协议与 rAF 合帧机制 |

---

## 1. 结论（TLDR）

抖动不是消息内容本身的问题，而是**三层机制互相竞争**：

1. **CSS 层**：`.chat-scroll` 设置了 `scroll-behavior: smooth`（`src/renderer/theme/layout.css:575`），把 react-virtuoso 依赖的**瞬时 scrollTop 补偿**动画化。流式期间最后一项每帧长高 → Virtuoso 每帧做位置补偿 → 每次补偿都变成 ~300ms 平滑动画 → 动画不断重启、互相打断 → 整个列表持续游动。这是最大根因。react-virtuoso 官方明确要求不要在 scroller 上设置该属性。
2. **JS 层**：`followOutput` 在贴底时返回 `'smooth'`（`src/renderer/components/Chat/ChatMessageViewport.tsx:107`），流式期间每次 item resize 触发一次平滑滚动，而滚动目标（底部）本身在移动，动画永远追不上，形成"橡皮筋"效应，与第 1 层双重平滑叠加。
3. **渲染层**：`ChatMessageList.tsx:90` 对**每一行、每次渲染**都用 `Object.fromEntries(...)` 新建 `confirmationReadyByToolId` 对象，`ChatBubble` 的 `memo`（浅比较）对该 prop 永远失效。任何让视口整体重渲染的事件（典型：工具确认卡 `pendingConfirmItems` 变化）都会导致**所有可见气泡全部重渲染** + Virtuoso 全列表高度重测——这正是"卡片正在更新时抖得最厉害"的直接原因。附带开销：`pendingConfirmStore.ts:85` 每次 TurnDisplay 到达都执行两次全量 `JSON.stringify` 守卫。

修复优先级：**J-01 + J-02（必做，解决滚动抖动主因）→ J-03 + J-04（必做，消除全列表重渲染放大器）→ J-05（观察项，默认不实施）**。

## 2. 抖动机链（代码事实）

流式更新链路（现状，rAF 合帧本身是健康的）：

```
主进程 TurnDisplay 推送（每次 delta，版本化全量快照）
  → initTurnDisplayBridge rAF 合帧，每帧最多一次 flush（src/renderer/services/turnDisplayStore.ts:54-60）
  → 流式行的 ChatMessageList 实例重渲染（该行顶层 useTurnDisplay(turnId) 订阅，src/renderer/hooks/useTurnDisplay.ts）
  → 该行气泡内容长高 → Virtuoso ResizeObserver 检测 → 位置补偿 + followOutput
```

问题出在最后两步的处理方式上：

| # | 代码位置 | 事实 | 后果 |
| --- | --- | --- | --- |
| 1 | `src/renderer/theme/layout.css:575` | `.chat-scroll { scroll-behavior: smooth }` | CSS 规范下，**未显式指定 behavior 的程序化滚动（含直接赋值 `scrollTop`）全部动画化**。Virtuoso 内部位置补偿假设赋值即时生效，被动画化后与实际位置脱节，逐帧重新补偿，形成位置震荡 |
| 2 | `src/renderer/components/Chat/ChatMessageViewport.tsx:107` | `followOutput = () => (stickRef.current ? 'smooth' : false)` | 流式期间每次 item 高度变化触发一次平滑滚动；目标在移动，动画逐次重启 |
| 3 | `src/renderer/components/Chat/ChatMessageList.tsx:90` | `confirmationReadyByToolId={Object.fromEntries(pendingConfirmItems.filter(...).map(...))}` | 每行每次渲染产生新引用，`ChatBubble = memo(...)`（`ChatBubble.tsx:219`，默认浅比较）失效；任一触发全列表重渲染的事件都放大为所有可见气泡重渲染 |
| 4 | `src/renderer/services/pendingConfirmStore.ts:85` | `if (JSON.stringify(this.items) === JSON.stringify(updated) && ...) return` | 每次 TurnDisplay 到达（每帧）执行两次全量 stringify；有确认卡期间是纯 CPU 损耗，掉帧加剧抖动感 |
| 5 | `src/renderer/components/Chat/ChatMarkdown.tsx:73-76` | 流式期间每帧全文 `normalizeMarkdownMath` + `projectMarkdownForSearch` + ReactMark 整树重渲 | 掉帧来源；未闭合 Markdown 块（代码块/表格）中间态高度跳变造成内容级抖动（次要） |

参考：`handleScrollToLatest`（`ChatView.tsx:205-209`）与 `scrollToMessageId`（`ChatMessageViewport.tsx:85-90`）使用显式 `behavior: 'smooth'` 参数，**不依赖** CSS 的 `scroll-behavior`，删掉 CSS 后这些用户手势路径仍然平滑——这是 J-01 安全性的前提，已验证。

## 3. 修复项总览

| 编号 | 优先级 | 改动位置 | 一句话描述 | 风险 |
| --- | --- | --- | --- | --- |
| J-01 | P0 | `src/renderer/theme/layout.css` | 删除滚动容器的 `scroll-behavior: smooth` | 低 |
| J-02 | P0 | `src/renderer/components/Chat/ChatMessageViewport.tsx` | `followOutput` 从 `'smooth'` 改为瞬时贴底 | 低 |
| J-03 | P1 | `ChatView.tsx` + `ChatMessageList.tsx` | `confirmationReadyByToolId` 引用稳定化（值三态透传），使非确认卡行的 `ChatBubble.memo` 生效 | 中（涉及组件 props 契约与既有测试） |
| J-04 | P2 | `src/renderer/services/pendingConfirmStore.ts` | `JSON.stringify` 守卫改为结构化相等比较 | 低 |
| J-05 | 观察项 | `ChatMarkdown` / `ShikiHighlightedCode` | 流式 Markdown 中间态高度稳定化 | 高（默认不实施，见触发条件） |

实施顺序即编号顺序；J-01、J-02 可合入同一提交，J-03、J-04 各自独立提交。

---

## 4. TODO 明细

### J-01 移除 `.chat-scroll` 的 `scroll-behavior: smooth`

**背景**：见 §2 表格第 1 行。这是"整个列表游动"的最大根因。

**改动内容**：

文件 `src/renderer/theme/layout.css`。

改前（565-576 行）：

```css
.chat-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
  /* Virtuoso 的绝对定位 viewport 从滚动层 top:0 开始渲染，滚动层上的
   * padding 会被 viewport 覆盖；间距统一由内层 item-list 容器提供。 */
  scroll-behavior: smooth;
}
```

改后：删除 `scroll-behavior: smooth;` 这一行，其余保留。

同时清理随之冗余的 reduced-motion 覆盖（642-645 行），改前：

```css
@media (prefers-reduced-motion: reduce) {
  .chat-scroll {
    scroll-behavior: auto;
  }

  .chat-scroll-to-latest {
    transition: none;
  }
  ...
}
```

改后：删除该 media query 内的 `.chat-scroll { scroll-behavior: auto; }` 规则块（默认值已是 `auto`，规则失去意义），`.chat-scroll-to-latest` 与 `.composer-send` 的降级保留。

**不改**：`ChatMessageViewport.tsx` 中 `scrollToIndex({ behavior: 'smooth' })` 两处（85-90、91-98 行）与 `ChatView.tsx:208` 的 `scrollToBottom('smooth')`。react-virtuoso 的显式 `behavior` 参数走原生 `scrollTo({ behavior })`，不依赖 CSS 属性，删除后这些用户手势仍平滑。

**完成判据**（全部满足才算完成）：

- [ ] `rg -n "scroll-behavior" src/renderer` 输出中不再包含 `.chat-scroll` 相关联的 `smooth`（`components.css` 中 `overscroll-behavior` 为另一属性，不算命中）。
- [ ] `src/renderer/theme/layout.css` 中 642-645 行的 `.chat-scroll` reduced-motion 覆盖已删除，且该 media query 块内其余规则完整保留。
- [ ] `npm run typecheck:renderer` 通过（本项不改 TS，跑一次确认无意外牵连）。
- [ ] 手动验收（`npm run dev`，长会话 ≥100 条消息）：
  - 发起一次长流式回复，视线盯住列表中部的历史气泡：**列表静止，只有最新气泡内容增长并贴底**，无上下游动；
  - 向上滚动离开底部，再点击"回到底部"按钮：**仍有平滑滚动动画**；
  - 搜索结果跳转（`scrollToMessageId` 路径）：**仍有平滑滚动动画**。

**回退**：单独 revert 该提交即可恢复原状。

---

### J-02 `followOutput` 改为瞬时贴底

**背景**：见 §2 表格第 2 行。流式跟随必须是瞬时的，平滑动画只保留给用户手势（滚到底部按钮、搜索跳转）。

**改动内容**：

文件 `src/renderer/components/Chat/ChatMessageViewport.tsx:107`。

改前：

```ts
const followOutput = useCallback(() => (stickRef.current ? ('smooth' as const) : false), [])
```

改后：

```ts
const followOutput = useCallback(() => stickRef.current, [])
```

说明：react-virtuoso 的 `FollowOutput` 类型为 `boolean | 'smooth' | 'auto'`，返回 `true` 表示以默认（瞬时）方式贴底。每帧一次的瞬时贴底在视觉上是连续的；`'smooth'` 才会产生追逐抖动。

**不改**：`useImperativeHandle` 中的 `scrollToBottom(behavior)`（91-98 行）保持参数化，`ChatView` 的 `scrollBottom(force)` 路径（`ChatView.tsx:376-400`）不变——它们服务于用户手势与 turn 启动定位，不属于逐帧跟随。

**完成判据**（全部满足才算完成）：

- [ ] `src/renderer/components/Chat/ChatMessageViewport.tsx` 中 `followOutput` 的返回值类型为布尔（`stickRef.current`），文件内不再出现 `followOutput ... 'smooth'`。
- [ ] 定向测试通过：
  ```bash
  npm exec vitest run src/renderer/components/Chat/ChatView.scrollToLatest.test.tsx
  ```
- [ ] 手动验收（`npm run dev`）：
  - 长流式回复期间停在底部：**最新内容逐帧贴底，无平滑动画的"追赶感"**，滚动条位置稳定；
  - 停在底部时流式进行中，用滚轮向上滚动：列表**立即停止跟随**并停在用户滚到的位置（`stickToBottom` 变 false，出现"回到底部"按钮）；
  - 点击"回到底部"：**平滑**滚动到底部后恢复贴底跟随。

**回退**：单独 revert；与 J-01 互不依赖，但建议同批验证。

---

### J-03 `confirmationReadyByToolId` 引用稳定化

**背景**：见 §2 表格第 3 行。目标是让 `ChatBubble` 的 `memo` 对**非确认卡行**生效：同一份 `pendingConfirmItems` 下，传给每一行 `ChatBubble` 的 `confirmationReadyByToolId` 必须是**同一对象引用**（当前每行每次渲染都新建）。

**生效边界（评审 S-03）**：确认卡所在行的 `toolsInteractive` 来自 `resolveMessageToolsInteractive`，对含 confirming/executing 工具的消息每次调用都返回新对象（`resolveMessageToolsInteractive.ts:140/148`），这些行的 memo 仍会失效——这是预期，不在本项范围内。本项收益覆盖占绝大多数的普通行/历史行。

**改动内容**：

1. `src/renderer/components/Chat/ChatView.tsx`（约 974 行 `usePendingConfirmSnapshot()` 之后）新增派生缓存：

```ts
const confirmationReadyBySession = useMemo(() => {
  const map: Record<string, Record<string, boolean | undefined>> = {}
  for (const item of pendingConfirmItems) {
    const byTool = (map[item.sessionId] ??= {})
    // 原样透传三态：undefined（未知/旧路径）/ false（未就绪）/ true（就绪）。
    // 下游 ToolCallCard 六处确认卡门禁均为 confirmationReady !== false
    // （ToolCallCard.tsx:431/440/449/458/467/476），undefined 不得归一为 false，
    // 否则确认 UI 会被静默判定"未就绪"而不可交互。
    byTool[item.toolUseId] = item.confirmationReady
  }
  return map
}, [pendingConfirmItems])
```

2. `src/renderer/components/Chat/ChatMessageList.tsx`：
   - props 增加 `confirmationReadyBySession: Record<string, Record<string, boolean | undefined>>`（加入 `ChatMessageListProps`；值类型与 `ChatBubble.tsx:51` 的 `confirmationReadyByToolId` props 类型对齐）；
   - 模块顶部增加常量 `const EMPTY_CONFIRM_READY: Record<string, boolean | undefined> = {}`；
   - 行内渲染（原 90 行）改前：

```tsx
confirmationReadyByToolId={Object.fromEntries(pendingConfirmItems.filter((item) => item.sessionId === m.sessionId).map((item) => [item.toolUseId, item.confirmationReady]))}
```

   改后：

```tsx
confirmationReadyByToolId={confirmationReadyBySession[m.sessionId] ?? EMPTY_CONFIRM_READY}
```

3. `ChatView.tsx` 的 `renderViewportMessage`（1083-1122 行）：透传 `confirmationReadyBySession={confirmationReadyBySession}`，依赖数组**新增** `confirmationReadyBySession`（`pendingConfirmItems` 保留——`ChatMessageList` 内部 `restorePendingConfirmToolCalls` 仍需要它）。

**语义说明**：原实现按 `sessionId` 过滤后对每行生成"该会话全部待确认工具 → `item.confirmationReady` 原值"的映射，值是 `boolean | undefined` 三态；新实现按 `sessionId` 预先分组并**原样透传同值**——值语义与原实现完全一致（含 `undefined` 原样保留，不归一），仅对象引用稳定。特别地，`ToolCallCard` 六处确认卡分支的门禁是 `confirmationReady !== false`（`ToolCallCard.tsx:431/440/449/458/467/476`），`undefined`（未知/旧路径）与 `false`（明确未就绪）语义不同：**禁止**任何把 `undefined` 归一为 `false` 的实现（如 `=== true` / `?? false`），否则确认 UI 会被静默禁用。`ChatBubble` 内部对该 prop 的消费方式与类型不变。

**完成判据**（全部满足才算完成）：

- [ ] `rg -n "Object.fromEntries" src/renderer/components/Chat/ChatMessageList.tsx` 无 `confirmationReadyByToolId` 相关联的命中。
- [ ] 扩展 `src/renderer/components/Chat/ChatMessageList.memo.test.tsx`（或在该文件新增用例），断言以下三点：
  1. 同一 `pendingConfirmItems` 引用下重渲染 `ChatMessageList`，传给各行 `ChatBubble` 的 `confirmationReadyByToolId` 引用不变（可用 vi.mock 探针或包裹组件记录 props）；
  2. `pendingConfirmItems` 中某项 `confirmationReady` 翻转后，对应会话行的 prop 内容更新（`ChatBubble` 收到新引用与新值）；
  3. `pendingConfirmItems` 为空数组时行内收到的是稳定空对象（两次渲染同一引用）；
  4. **（评审 B-01）`undefined` 透传**：`confirmationReady` 为 `undefined` 的 item，行内收到的值必须是 `undefined` 而非 `false`——断言 `received[toolUseId] === undefined && received[toolUseId] !== false`，且 `'toolUseId' in received === true`（键存在、值为 `undefined`，与原 `Object.fromEntries` 行为一致，防止实现时用 `?? false` 或 `=== true` 归一）。
  用例运行：
  ```bash
  npm exec vitest run src/renderer/components/Chat/ChatMessageList.memo.test.tsx
  ```
- [ ] 既有相关测试全部通过（props 契约变化会波及以下文件，若有编译/断言失败需同步修正测试而非跳过）：
  ```bash
  npm exec vitest run src/renderer/components/Chat/ChatMessageList.failureReason.test.tsx src/renderer/components/Chat/ChatMessageList.perf.measure.test.tsx src/renderer/components/Chat/ChatMessageList.perf.batch2.measure.test.tsx src/renderer/components/Chat/ChatBubble.test.tsx
  ```
- [ ] `npm run typecheck:renderer` 通过。
- [ ] 手动验收（`npm run dev`）：触发一个需要确认的工具（例如让 agent 执行一次写文件），在确认卡片出现、确认快照到达（`confirmationReady` 翻转）、点击批准/拒绝的每个时点观察列表：**历史气泡无任何位置跳动**，只有确认卡片自身更新。

**回退**：单独 revert。回退后恢复为逐行新建对象，功能不损失（原行为本来就是每次重算）。

---

### J-04 `pendingConfirmStore` 守卫改为结构化相等比较

**背景**：见 §2 表格第 4 行。当前守卫 `JSON.stringify(this.items) === JSON.stringify(updated)` 在每次 TurnDisplay 到达（每帧）时执行两次全量序列化；确认卡存在期间（含 `input`/`diff` 大对象）开销显著。

**改动内容**：

文件 `src/renderer/services/pendingConfirmStore.ts`。

1. 模块内新增比较函数（放在 class 外部或 private method 均可）：

```ts
// 不变量（评审 S-01）：confirmationSnapshot 永不脱离 confirmationReady 单独变化——
// snapshot 仅在 pendingConfirmStore.ts:94-95 的 .then 回调中与 confirmationReady=true 同时写入，
// 而投影重建的 next 恒为 confirmationReady:false 且无 snapshot，
// 因此本函数不比较 confirmationSnapshot，snapshot 差异必然已被 confirmationReady 捕获。
// 若未来出现单独写 snapshot 的路径，必须把该字段纳入比较，否则会静默丢失 notify。
function samePendingItems(a: PendingConfirmItem[], b: PendingConfirmItem[]): boolean {
  if (a.length !== b.length) return false
  const index = new Map(a.map((item) => [`${item.requestId}:${item.toolUseId}`, item]))
  for (const item of b) {
    const prev = index.get(`${item.requestId}:${item.toolUseId}`)
    if (!prev) return false
    if (prev.sessionId !== item.sessionId
      || prev.toolName !== item.toolName
      || prev.riskLevel !== item.riskLevel
      || prev.turnId !== item.turnId
      || prev.turnVersion !== item.turnVersion
      || prev.confirmationReady !== item.confirmationReady
      || prev.autoApproveFallback !== item.autoApproveFallback
      || prev.currentPageUrl !== item.currentPageUrl
      || prev.sessionTrustedHint !== item.sessionTrustedHint
      || prev.createdAt !== item.createdAt) return false
    // 深字段保留原 JSON.stringify 语义，但只对单个 item 的差异字段执行
    if (JSON.stringify(prev.input) !== JSON.stringify(item.input)) return false
    if (JSON.stringify(prev.diff ?? null) !== JSON.stringify(item.diff ?? null)) return false
    if (JSON.stringify(prev.mcp ?? null) !== JSON.stringify(item.mcp ?? null)) return false
    if (JSON.stringify(prev.shellSecurityHints ?? null) !== JSON.stringify(item.shellSecurityHints ?? null)) return false
    if (JSON.stringify(prev.memoryTiers ?? null) !== JSON.stringify(item.memoryTiers ?? null)) return false
    if (JSON.stringify(prev.dangerInfo ?? null) !== JSON.stringify(item.dangerInfo ?? null)) return false
  }
  return true
}
```

   注意：比较字段集合以 `syncFromProjection`（59-82 行）实际写入的字段为准，后续给 `PendingConfirmItem` 新增字段时需同步维护此函数。

**已知边界（评审 S-02，记录不治理）**：`createdAt: tool.startedAt ?? Date.now()`（`pendingConfirmStore.ts:78`）使无 `startedAt` 的 item 每次 sync 的 `createdAt` 都不同，守卫（无论新旧实现）恒判定"已变化"→ 每帧 notify。这是现状既有行为，非本项引入；J-04 对该类 item 的收益从"消除两次全量序列化"降级为"按字段比较"。若需彻底治理（如以首个 projection 的 `createdAt` 为准），另行立项。

2. 85 行守卫改前：

```ts
if (JSON.stringify(this.items) === JSON.stringify(updated) && !args.retryAttempt) return
```

   改后（保持 `retryAttempt` 强制放行的语义，仅交换连接顺序以避免短路歧义）：

```ts
if (!args.retryAttempt && samePendingItems(this.items, updated)) return
```

**完成判据**（全部满足才算完成）：

- [ ] `rg -n "JSON.stringify\(this.items\)" src/renderer/services/pendingConfirmStore.ts` 无命中（守卫不再整体序列化数组）。
- [ ] `samePendingItems` 函数上方存在固化"snapshot 不脱离 `confirmationReady` 单独变化"不变量的注释（评审 S-01）。
- [ ] `src/renderer/services/pendingConfirmStore.test.ts` 新增用例并通过：
  1. **幂等不通知**：对同一份 projection 连续调用两次 `syncFromProjection`，第二次调用后订阅 listener 的调用计数不变；
  2. **变化通知**：第二次调用时传入 `confirmationReady` 不同的同构 items，listener 被再次调用；
  3. **retry 放行**：`retryAttempt > 0` 时即使 items 相同也执行 notify（保持原 `!args.retryAttempt` 语义）；
  4. **深度字段变化通知**：仅 `input` 对象内容不同的两次调用，第二次触发 notify。
  运行：
  ```bash
  npm exec vitest run src/renderer/services/pendingConfirmStore.test.ts
  ```
- [ ] `npm run typecheck:renderer` 通过。

**回退**：单独 revert，恢复 JSON.stringify 守卫。

---

### J-05（观察项，默认不实施）流式 Markdown 中间态高度稳定化

**触发条件**（同时满足才立项实施）：J-01 ~ J-04 全部落地后，按 §6.3 的方法录制，仍可观察到**已完成段落**（非最新增长点附近）的高度跳变；或用户反馈内容级抖动仍明显。

**候选措施**（届时按实测选择，不在本方案展开）：

1. 流式活跃段：最后一个未闭合的块级语法（代码块/表格）在闭合前降级为纯文本渲染，闭合后一次性升格为完整渲染；
2. Shiki 高亮完成后替换 DOM 时锁定容器高度（首帧与替换帧行高一致性断言）；
3. 流式 Markdown 中的图片使用固定宽高比容器占位。

**完成判据**：触发条件不成立时，本项保持"不做"，在本文档实施进度表中标记"⏸ 未触发"即可。

---

## 5. 附带发现（不在本方案实施，另行跟踪）

- `ChatView.tsx:1083-1122` 的 `renderViewportMessage` 闭包引用了 `streamingAssistant`，但依赖数组（1104-1121 行）未包含它，存在 stale closure 隐患（`turnId` 可能读到旧值）。当前因 `runningSessions` 同步变化而未暴露，建议后续补依赖或改从 ref 读取。
- `src/renderer/services/pendingConfirmStore.ts:88-121` 每次满足条件的 sync 都会对每个 confirming 工具发起 `chatGetPendingConfirmation` IPC，`input` 等字段直接改在已发布到 React 状态的 item 上（94-110 行，原地可变），与 Redux 不可变惯例相悖；J-04 的比较函数已将 `confirmationReady` 等纳入比较以兼容该行为，但原地可变本身建议后续单独治理。
- `src/renderer/components/Chat/ChatMessageList.tsx:89` 的 `displayToolSummaries` 同为每渲染 `Object.fromEntries(...)`（评审 S-04），但仅影响流式行（该行本就每帧更新），实际危害低，不在本方案范围；后续做 J-05 或新一轮渲染优化时可一并考虑。

---

## 6. 整体验收门禁

### 6.1 定向测试（每个 J 项提交前必跑）

```bash
npm exec vitest run \
  src/renderer/components/Chat/ChatView.scrollToLatest.test.tsx \
  src/renderer/components/Chat/ChatMessageList.memo.test.tsx \
  src/renderer/components/Chat/ChatMessageList.failureReason.test.tsx \
  src/renderer/components/Chat/ChatBubble.test.tsx \
  src/renderer/services/pendingConfirmStore.test.ts \
  src/renderer/services/turnDisplayStore.test.ts
```

J-03 / J-04 涉及契约变化时额外跑：

```bash
npm exec vitest run \
  src/renderer/components/Chat/ChatMessageList.perf.measure.test.tsx \
  src/renderer/components/Chat/ChatMessageList.perf.batch2.measure.test.tsx
```

### 6.2 全量验收（全部 J 项完成后、提交前一次）

```bash
npm run typecheck:renderer
npm run test:renderer
```

### 6.3 手动验收脚本（真机，`npm run dev`）

前置：一个 ≥100 条消息的长会话。

| 步骤 | 操作 | 期望观察（修复后） |
| --- | --- | --- |
| 1 | 发送一条会触发 ≥2000 字长回复的消息，不碰鼠标 | 列表完全静止，仅最新气泡逐帧增长并贴底；滚动条稳定在底部 |
| 2 | 流式进行中向上滚动约 200px | 跟随立即停止，出现"回到底部"按钮，列表停在当前位置 |
| 3 | 点击"回到底部" | 平滑滚动到底部，随后恢复贴底跟随 |
| 4 | 搜索跳转到一条历史消息 | 平滑滚动 + 居中定位（行为与修复前一致） |
| 5 | 触发一个工具确认（写文件类），观察卡片出现/快照到达/批准三个时点 | 历史气泡无位置跳动，仅确认卡片自身更新 |
| 6 | 系统设置开启"减少动态效果"后重复步骤 1 | 行为一致（贴底瞬时，无回归） |

### 6.4 Performance 录制判据（可选，用于量化对比）

DevTools Performance 录制流式 10 秒：

- 修复前特征：`scroll` 事件呈连续补间（动画帧序列），且伴随每帧全列表 Recalculate Style / Layout；
- 修复后特征：滚动位置变化为离散的 `scrollTop` 赋值（无补间动画帧）；确认卡事件不再触发全可见区气泡重渲染（React DevTools Profiler 中历史行 highlight 消失）。

## 7. 实施进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| J-01 删除 CSS smooth | ✅ 已完成 | `layout.css` 删除 `scroll-behavior: smooth` 及 reduced-motion 冗余覆盖；`rg "scroll-behavior"` 仅剩解释注释与 `overscroll-behavior` |
| J-02 followOutput 瞬时贴底 | ✅ 已完成 | TDD：新增 `ChatMessageViewport.followOutput.test.tsx`（红：返回 `'smooth'` → 绿：返回布尔）；实现改为 `() => stickRef.current` |
| J-03 confirmationReadyByToolId 稳定化 | ✅ 已完成 | TDD：新增 `ChatMessageList.confirmReady.test.tsx`（4 断言，含评审 B-01 的 undefined 透传）；`ChatView` 增加 `confirmationReadyBySession` useMemo；既有 4 个测试文件同步补必填 props |
| J-04 pendingConfirmStore 守卫浅比较 | ✅ 已完成 | TDD：先以 4 条特征用例锁定行为（旧实现下全绿），再重构为 `samePendingItems`（含评审 S-01 不变量注释），重构后保持绿；S-02 已知边界已记录于 §J-04 |
| J-05 流式 Markdown 中间态 | ⬸ 观察项 | 触发条件未复证，保持不实施 |
| §6.1 定向测试 | ✅ 通过 | 8 文件 53 用例 + perf 2 用例全绿 |
| §6.2 全量验收 | ✅ 通过 | `typecheck:renderer` 无错误；`test:renderer` 270 文件 / 1647 用例全绿 |
| §6.3 手动验收 | ⬜ 待真机 | 需 `npm run dev` 长会话流式场景人工观察（6 步脚本） |
