# 聊天中止响应延迟：验证结论与修复方案

> 状态：评审修订完成（评审意见见 docs/review/chat-abort-latency-plan-review.md，B1/N1/N2/N3 已全部落实），待放行实施
> 日期：2026-09-29
> 现象：turn 执行中点击聊天输入框的「中止」按钮后，UI 迟迟不恢复、消息继续滚动，感知延迟明显。

---

## 一、验证结论（已实证）

中止慢不是单一缺陷，而是四个延迟点叠加。前两个是主因，均已被代码审查 + 行为测试 + 运行日志三方证实。

### 1.1 LLM 流式请求未绑定 AbortSignal（最大延迟源，已测试实证）

`electron/toolChatLoop.ts:1336` 的 SDK 调用**只传了单参数**：

```ts
const stream = client.messages.stream({ ...toolLoopStreamParams })
```

Anthropic SDK 签名为 `stream(body, options?: RequestOptions)`，`RequestOptions.signal?: AbortSignal`（node_modules 类型已确认）——SDK 自带的请求级硬中断能力完全未被使用。

取消信号（`chatSignal`）只能在 `for await` 循环体内的 `throwIfChatCancelled(chatSignal)`（`toolChatLoop.ts:1346`）被检查，而该检查**只有在下一个 SSE 事件到达时才会执行**。

**行为验证测试**（已运行通过，验证后已删除不入库）：mock 流产出事件 1 后挂起在事件间隔上，此时调用 `signalChatCancel(requestId)`：

| 断言 | 结果 |
|---|---|
| abort 后 80ms，流处理仍未被打断（runToolChatSession 未返回） | ✅ 实证成立 |
| 放行「下一个事件」后取消才生效（以 `cancelled: true` 结束） | ✅ 实证成立 |
| `client.messages.stream` 第二参数为 `undefined`（signal 未绑定） | ✅ 实证成立 |

**运行日志佐证**（`logs/Agent-20260919.log`，glm-5.3-flash @ open.bigmodel.cn anthropic 兼容端点）：单轮 LLM 请求总耗时 7.5s～50s（5 轮依次 7492/15124/31627/36453/49660ms）。这意味着每轮存在一个最长 50 秒的窗口，期间若用户点中止，取消信号无处生效。另外日志中**没有任何取消/中止事件留痕**——中止操作当前不可观测。

受影响的具体场景（取消延迟 = 下一个事件到达时间）：

- 请求已发出、等待响应头 / 首个事件（TTFB）：慢端点或深度思考模型下常见 10s+；
- 模型长思考、SSE 事件间隔拉长；
- 网络 stall。

### 1.2 渲染端中止无本地止血（感知慢的直接原因，代码实证）

`ChatView.abort()`（`src/renderer/components/Chat/ChatView.tsx:443-446`）点击后**只发一个 `chat:cancel-turn` IPC，不做任何本地状态清理**：

```ts
const abort = useCallback(() => {
  const turnId = sessionId ? runningSessions[sessionId]?.turnId : undefined
  if (turnId) void window.api.chatCancelTurn(turnId)
}, [runningSessions, sessionId])
```

按钮状态、输入框解锁、消息停止滚动，全部等主进程 turn 终态回传链走完（见 1.4）。已 import 的 `abortSessionRun`（`chatRunnerService.ts:165`，含本地立即清理）在该函数中**未被调用**。

对照：会话列表的停止按钮（`SessionListPane.tsx:61,69`）走的正是 `abortSessionRun`——会本地立即 `removeRunningSession` + 清 live 消息。**同一个「停止」语义，两个入口行为不一致，聊天框的中止按钮恰好是最慢路径。**

### 1.3 turn 状态机 5 秒 finishing 兜底窗口（下限保障）

`src/shared/turnCoordinator.ts:372-375`：cancel 被接受且 turn 正在执行时进入 finishing，启动 `finishingWindowMs ?? 5_000` 兜底定时器。正常路径下 tool loop 抛 `ChatCancelledError` 退出 → execute promise settle → `finalizeFinishing` 立即终结（不等满 5 秒）；但只要执行方因任何原因（卡在不消费 signal 的工具、SDK 清理慢等）5 秒内未退出，UI 就要等满 5 秒才收到终态。

### 1.4 终态回传后的渲染端串行解锁链

`src/renderer/services/turnProjectionService.ts:130-177`：收到 terminal display 后，渲染端还要：

1. `chatGetTurnTerminal` 回查，且要求 `committedVersion >= display.version`（checkpoint 已提交）；不满足则**指数退避重试**（100ms·2ⁿ，间隔上限 30s）；
2. `chatGetMessagePage` 拉取 60 条消息；
3. `routePatchMessage` + `setChatStatus('completed')` 之后才删除 `runningSessions`、解锁输入框。

**完整延迟公式**：`感知延迟 ≈ max(执行方感知取消的延迟【1.1/1.3】, 终态收尾) + checkpoint 提交 + 渲染端回查链【1.4】`，且全程 UI 无任何本地反馈【1.2】。

### 1.5 工具执行阶段的取消（现状可接受）

`signalChatCancel` 会同时 `cancelAllToolsForRequest`（`toolConfirmRegistry.ts:280`）abort 每个工具的 signal；`run_shell` 等已实现 abort 监听杀进程（`runShellExecutor.ts:373`），响应较快。等待用户确认阶段取消为即时（`resolve('cancelled')`）。此环节不是本次瓶颈。

---

## 二、修复方案

按性价比排序，Phase 1 + 2 为主修复，Phase 3 为配套可观测性。Phase 1、2 相互独立，可分两笔提交。

### Phase 1（主修复）：LLM 流式请求硬中断

**改动 1a：绑定 signal**（`electron/toolChatLoop.ts` 约 1336 行）

```ts
const stream = client.messages.stream({ ...toolLoopStreamParams }, { signal: chatSignal })
```

**改动 1b：abort 错误识别为取消**。绑定后，signal abort 会使 `for await` 抛出 `APIUserAbortError`（而非 `ChatCancelledError`），若不加处理会落入现有 `llm.error` 分支（`toolChatLoop.ts:1607+`），整轮被错误结算为 failed 而非 cancelled。

**插入位置（评审 B1 修订）**：扩展判定必须放在现 1629 行的位置——即 catch 块内 `retractAttemptPreview()`（1610）与**用量结算块（1611-1628）之后**。现状取消路径在重抛前会先结算流式中段已拿到的部分 usage（落 `request_usage` 事件 + `recordStepUsage`），该行为必须原样保留；若把判定提前到结算块之前，会造成「流式中段中止」丢失部分用量记账的回归：

```ts
} catch (e) {
  retractAttemptPreview()
  if (usage && !attemptUsageRecorded) {
    // ……现 1611-1628 用量结算块原样不动……
  }
  // 扩展取消判定（原 1629 行位置）：优先以 chatSignal.aborted 判定
  // （不依赖错误类形态，同时覆盖 abort 与网络错误竞态），其次识别 APIUserAbortError
  if (e instanceof ChatCancelledError || chatSignal.aborted || e instanceof APIUserAbortError) {
    throw new ChatCancelledError()
  }
  ...
}
```

同时需检查该 try 块内 `for await` 之后的其余代码路径（`stream.finalMessage()` 等若在 abort 后调用也可能抛同型错误），统一走同一判定（同样放在任何 usage/结果处理之后）。

**效果**：TTFB / 长 thinking / 网络 stall 场景的取消延迟从「等下一个事件（最坏数十秒）」降为即时（fetch 层立即销毁连接）。

### Phase 2：渲染端本地立即止血

**改动 2a**：`ChatView.abort()` 复用 `abortSessionRun`（替换现有手写实现）：

```ts
const abort = useCallback(() => {
  if (sessionId) abortSessionRun(sessionId)
}, [sessionId])
```

`abortSessionRun`（`chatRunnerService.ts:165-176`）内部已包含 `chatCancelTurn(meta.turnId)`、无 turnId 时的 `unregisterRunRequestsForSession` 兜底、`pendingConfirmStore.rejectAllForSession`、`clearLiveSession`、`removeRunningSession`——与 SessionListPane 现行为完全对齐，两个入口收敛为同一语义。

**效果**：点击瞬间按钮切回发送态、本地消息停止等待新 delta；主进程 terminal 随后到达时经 `turnProjectionService` 自然收敛（该收敛路径即 SessionListPane 现有路径，已有先例，无新增风险）。

**边界说明**：中止后若主进程仍有极少量已发出但未到达的 delta 事件，`clearLiveSession` 后这些事件会因 live 快照不存在而被 `routeAddMessage/routePatchMessage` 重建（`ensureLiveSession` 会从 store 种子化）。风险与 SessionListPane 入口现状一致，不新增处理。

### Phase 3：中止路径可观测性

当前日志无任何取消留痕，事后无法验证修复效果。增加两条审计事件（`logAgentEvent('warn', ...)`，遵循 `sanitizeForLog` 纪律，不含消息正文）：

- `llm.cancel`：tool loop 取消判定命中时打点（在重抛 `ChatCancelledError` 前、部分 usage 结算之后），字段 `requestId / sessionId / loopRound / abortToCatchMs（chatSignal abort 时间戳与 catch 时刻的差值）`；
- `turn.cancel`：`chat:cancel-turn` 处理器（`electron/ipc/agentProtocolIpc.ts:700`）打点，字段 `turnId / requestId / accepted（cancel 是否被接受）`。

配套改动（评审 N2 补充，缺一则类型报错 / 投影丢字段）：

- `electron/agentLogger/types.ts`：向闭合联合类型 `AgentLogEventName` 增加 `'llm.cancel'`、`'turn.cancel'`；
- `electron/agentLogger/agentLogProjection.ts`：向 `TARGET_EVENTS` 白名单加入这两个事件，否则设置页日志投影会丢弃其字段。

### 观察项（本次不改）：finishingWindowMs

`CoordinatorDeps.finishingWindowMs` 类型已具备（`turnCoordinator.ts:35`），main.ts 装配处可传。**建议 Phase 1/2 落地后再评估是否缩短**：修复 1 之后，LLM 阶段取消即时生效，5 秒窗口只剩「工具卡死不响应 signal」一种触发场景，此时它是给工具优雅收尾（如 shell 杀进程后的输出收集）的保护窗口而非常态延迟。若后续日志显示该窗口仍频繁打满，再考虑 2000～3000ms。

---

## 三、测试计划（红绿验证）

1. **契约测试**：tool loop 调用 `client.messages.stream` 时第二参数携带 `{ signal: chatSignal }`（以本次验证用的临时测试为基底改造为正式用例；现状下该断言为红，修复后转绿）。
2. **行为回归**：
   - mock 流在 signal abort 后抛 `APIUserAbortError`，断言 tool loop 结算为 `cancelled: true` 而非 failed（钉住 1b 不回归为 llm.error）；
   - **取消轮部分 usage 仍落账**（评审 B1 补充）：流式中段已产出 usage 时中止，断言 `request_usage` 事件与 `recordStepUsage` 照常结算、不被取消判定短路（现状行为，修复不得回归）。
3. **渲染端**（评审 N3 补充分支覆盖）：
   - happy path：`runningSessions` 存在且带 `turnId` 时，abort 后 `runningSessions` 立即清除、`chatCancelTurn` 被调用、`pendingConfirmStore` 对应确认被拒绝；
   - **meta 存在但 `turnId` 缺失**：走 `unregisterRunRequestsForSession` 兜底分支，本地清理照常执行；
   - **`runningSessions` 无该会话**：仍执行 rejectAll / clearLiveSession / removeRunningSession，不抛错。
   （参考 `SessionListPane.ownership.test.tsx` 的 mock 方式。）
4. **收尾**：定向测试通过后跑 `npm run test:electron` + `npm run test:renderer`（提交前），不跑全量 `npm test`。

## 四、风险与回滚

| 风险 | 缓解 |
|---|---|
| 1b 把非 abort 的网络错误误判为取消 | 判定以 `chatSignal.aborted` 为锚，只有中止已发生时才吞异常；测试 2 钉住 |
| 1b 判定位置错误导致取消轮丢失部分用量记账（评审 B1） | 判定固定插在现 1629 行位置（用量结算块之后），现状「流式中段中止先结算部分 usage 再重抛」的行为原样保留；测试 2 的 usage 落账断言钉住 |
| 渲染端止血与主进程 terminal 收敛竞态 | 与 SessionListPane 现行为同构，属已验证路径；1.4 的版本比对（`display.version` / `committedVersion`）天然幂等 |
| 回滚 | 每阶段独立提交，revert 单笔即可；signal 绑定与错误识别一并回滚（两者必须同进退） |

## 五、验收标准

1. LLM 流式任意时刻（含 TTFB 等待期）点中止：HTTP 请求即时销毁，日志出现 `llm.cancel`，turn 终态为 cancelled；
2. 工具执行中 / 等待确认中点中止：行为不劣于现状（shell 即时杀进程、确认即时取消）；
3. 聊天框中止按钮点击后**本地立即**恢复可输入（不等主进程）；
4. 会话列表停止按钮行为不变（与聊天框收敛为同一实现）；
5. 第三、四节测试全绿。
