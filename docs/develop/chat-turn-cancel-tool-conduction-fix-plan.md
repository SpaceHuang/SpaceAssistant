# 聊天中止「停不下来」修复计划：turn 级取消传导补全

> 状态：待评审（评审通过后按第六节顺序实施）
> 日期：2026-10-12
> 前置文档：`docs/develop/chat-abort-latency-verification-and-fix-plan.md`（2026-09-29 方案：其 Phase 1「signal 绑定」与 Phase 2「本地止血」已落地且有效；其 Phase 3「中止审计」已在后续 merge 中丢失，本计划 Phase 2 负责重做）
> 关联现象：用户报告「点输入区中止按钮长时间没响应、任务停不下来；点会话列表停止按钮却能立即停」

---

## 一、先把问题说清楚（人话版）

### 1.1 两个中止按钮，其实是同一个按钮

- 输入区的停止按钮：`ChatView.tsx:494` → `abortSessionRun(sessionId)`
- 会话列表的停止按钮：`SessionListPane.tsx:60` → `abortSessionRun(item.id)`

两者调用的是**同一个函数、读的是同一个状态字段**（`chatRunnerService.ts:164`）。9 月 29 日的修复已经把两个入口收敛成一套实现了，这一点有测试钉着（`ChatView.abort.test.tsx`），**不需要再改按钮本身**。

### 1.2 那「列表按钮能停、输入区按钮不能停」是怎么回事？

是**两次点击之间状态已经变了**，不是按钮有快慢：

1. 第一次点（输入区）：取消信号发出去了，但只停掉了 LLM 流，**正在执行的工具没停**（原因见 1.3）。turn 进入一个最长 5 秒的「收尾窗口」（finishing），窗口期间消息增量事件照常放行（`turnCoordinator.ts:413-415`）——**所以你看到按钮闪了一下恢复，但消息还在滚动、任务看起来还在跑**，这就是「没响应」的感知来源。
2. 5 秒后系统强行把 turn 标记为「已取消」，UI 状态收敛。
3. 第二次点（列表）：此时 turn 已经是终态了，主进程对这次取消返回「拒绝」（`turnCoordinator.ts:392-393`：已终态 / 已在收尾中的 turn 不再接受取消）——**这次点击其实什么也没取消**。但按钮照样消失、还弹出「已中止」提示（`SessionListPane.tsx:62`），UI 立刻呈现「停好了」。

所以「列表按钮一击即停」是**假象**：活是第一次点击干的，第二次点击只是收割了 UI 状态。真正的问题不是按钮，是下面这个。

### 1.3 真正的根因：取消信号只传了一半

把中止想象成拉总电闸。现在拉闸之后：

- ✅ **LLM 流断了**——SDK 请求绑定了取消信号（`toolChatLoop.ts:1120`），9-29 修复的成果，有效；
- ❌ **正在执行的工具没停**——长 shell 命令、浏览器自动化、MCP 调用、大文件搜索，全都收不到中止信号，会一直跑到自然结束。

具体断在哪（代码级证据）：

主进程的取消钩子是 `main.ts:994`：

```ts
onCancel: (turn) => signalChatCancel(turn.turnId)
```

`signalChatCancel`（`electron/chatCancelRegistry.ts:42-46`）做三件事，但它的参数名叫 `requestId`，现在传进去的却是 `turnId`——**三个动作里有两个是拿错误的钥匙开锁**：

| 动作 | 锁的钥匙 | 结果 |
|---|---|---|
| 中止 LLM 流（chatSignal） | 按 turnId 注册 | ✅ 钥匙对，流能断 |
| 撤销「等待用户确认」的工具卡 | 按 **requestId** 索引 | ❌ 拿 turnId 去查，查不到 |
| 中止执行中的工具（shell/browser…） | 按 **requestId** 前缀索引 | ❌ 查不到；而且这个注册表在新架构下**已经没有任何人注册了**（`registerToolCancel` 在 `toolChatLoop.ts:156` 是死 import，全仓库没有调用点） |

新架构（agent-sdk）下工具级取消换了一套路由表：`activeAgentToolCancellation`（按 会话+turn+工具 三元组索引，`electron/activeAgentToolCancellation.ts`）。但它只有一条触发路径——UI 上**单个工具卡片上的取消按钮**（`tool:cancel` IPC，`agentProtocolIpc.ts:528`）。**turn 级中止（点中止按钮）完全不经过它。**

净效果：点中止后，模型生成停了，但工具还在跑。工具循环要等当前工具自然结束后才检查取消标志（`toolChatLoop.ts:1028`）。一个跑几分钟的 shell 命令，就会让你「点了几分钟都没停下来」。

### 1.4 测试已经红了，红了一段时间

跑了 `electron/claudeStreamHandlers.hostedIntegration.test.ts`：**17 个用例失败**（main 分支当前状态）。其中最有说服力的是这一组：

- `keeps a Desktop Hosted run_shell post-claim side effect unknown after cancel`（以及 revoke / authorization-change 两个变体）

失败内容：**cancel 之后 shell 进程既没被杀、也没被回收**——副作用文件没落盘（`shell side effect missing`），清理临时目录时报 `EBUSY: resource busy or locked`（**僵尸 shell 进程还占着目录**）。这就是「点了中止任务还在跑」的测试级复现。该测试文件最后改动是 10-08，说明这个回归已经存在至少四天——因为平时只跑定向测试，全量红了没人看到。

另有 4 个 browser 确认重查用例失败（期望 `BROWSER_PREPARED_POLICY_CHANGED`，实际 `CONFIRMATION_DENIED`），那是确认阶段配置漂移重查的 reason 归类问题，**与取消传导不是同一条链**，单独列为 Phase 4。

### 1.5 还有一个帮倒忙的：日志里查无此事

9-29 方案 Phase 3 的中止审计（`turn.cancel` / `llm.cancel` 打点）连同测试文件 `toolChatLoop.abortSignal.test.ts` 已经在后续 merge 中整体丢失（提交 7de673f3 加过，现在源码里搜不到）。所以这个问题一直没有日志可查、无法事后归因。本计划 Phase 2 负责重做。

---

## 二、修完之后长什么样（验收标准，全部可测）

1. **任意时刻点中止，执行中的工具 2 秒内停下**：shell 杀进程并回收输出、浏览器/MCP 调用 abort、目录句柄释放（`EBUSY` 消失）；
2. **turn 终态及时收敛**：工具停了 → 执行方退出 → turn 在 5 秒窗口内提前收敛（不必等满 5 秒）；
3. **日志有据可查**：每次点中止出现 `turn.cancel`（含是否被接受）与 `llm.cancel`（含从发出中止到捕获的耗时）；
4. **列表按钮的提示说真话**：取消被接受才提示「已中止」；turn 已结束时提示「任务已结束」而不是谎报「已中止」；
5. **hostedIntegration 里 cancel 相关的红测试转绿**；
6. **不回归**：取消轮已产出的部分 token 用量照常记账（9-29 方案评审 B1 钉过的行为，见 4.2）。

---

## 三、改动方案（按阶段，可直接照做）

### Phase 1（主修复）：把「杀工具」接进 turn 级取消

#### 改动 1a：给工具取消路由表加一个「整 turn 批量取消」的开关

**文件**：`electron/activeAgentToolCancellation.ts`

**现状**：只有精确到单个工具的 `cancelActiveAgentTool(sessionId, turnId, toolUseId)`。

**新增**：

```ts
/** 取消指定 turn 下全部在准备/执行中的 SDK 工具调用，返回取消数量。 */
export function cancelAllActiveAgentToolsForTurn(sessionId: string, turnId: string): number {
  const prefix = JSON.stringify([sessionId, turnId, ''])  // 形如 ["sid","tid"]
  let count = 0
  for (const [key, entry] of activeCancellations) {
    if (key.startsWith(prefix.slice(0, -1))) {  // 前缀匹配 ["sid","tid",…，不会误伤同会话其它 turn
      entry.cancel()
      activeCancellations.delete(key)
      count++
    }
  }
  return count
}
```

> 实施细节：`keyFor` 用 `JSON.stringify([sessionId, turnId, toolUseId])`，前缀匹配时注意 `'["sid","tid"'.startsWith` 的写法（上面 `slice(0, -1)` 就是为了去掉收尾的 `]`）；也可以直接遍历比较前两个字段（先 `JSON.parse` 或用现有 `keyFor` 重组），**取更清晰的那种写法**，原则是不误伤同会话其它 turn 的工具。

**为什么安全**：这里调用的 `cancel` 回调，和 UI 单工具取消按钮调用的是**同一个函数**（注册点 `invocationAssembler.ts:903`）。单工具取消能停的工具，整批复用同一回调就一定能停。不需要理解 SDK 内部。

#### 改动 1b：取消钩子补全联动

**文件**：`electron/main.ts:994`

**现状**：

```ts
onCancel: (turn) => signalChatCancel(turn.turnId)
```

**改为**（`turn` 参数是完整对象，带 `turnId`/`requestId`/`sessionId`，已核对 `turnRuntime.ts:26-29` 与 `turnCoordinator.ts:36`）：

```ts
onCancel: (turn) => {
  signalChatCancel(turn.turnId)                                  // ① 断 LLM 流（现状已对，保留）
  cancelAllActiveAgentToolsForTurn(turn.sessionId, turn.turnId)  // ② 杀掉该 turn 在执行的工具（新增，改动 1a）
  cancelAllToolConfirmsForRequest(turn.requestId)                // ③ 撤销等待确认的工具卡（补上正确的钥匙）
}
```

说明：

- ③ 的函数从 `./toolConfirmRegistry` 导入（导出名已核对：`cancelAllToolConfirmsForRequest` / `cancelAllToolsForRequest` / `cancelAllPendingToolConfirms`，见 `chatCancelRegistry.ts:2-6` 的现有用法）。撤确认卡用 `cancelAllToolConfirmsForRequest`；若工具 abort-controller 路径（`cancelAllToolsForRequest`）在过渡期仍有注册者，同样按 `turn.requestId` 补一次调用，双保险。
- `signalChatCancel` 内部那两个「拿 turnId 查 requestId 索引」的调用保持原样不动——查不到是无害 no-op，不必改它的内部逻辑，避免顺手重构扩大爆炸半径。
- **候选替代方案（不推荐）**：把 `signalChatCancel` 改成收 `{turnId, requestId}` 对象。侵入面大（deprecated 转发层 + 多实例 deps），收益只是少两行显式调用，不值。

**实施前确认项 A（ automation 三条路径的 key）**：`runToolChatSession` 内部用 `executionId = args.turnId ?? args.requestId` 注册 chatSignal（`toolChatLoop.ts:571`）。交互路径（`claudeStreamHandlers`）turnId 必传、key 一致；但 butler（`butlerInvoker.ts:425`）、远程 IM（`imRemoteAgent.ts:334`）、审批代理（`approvalAgent.ts:378`)三条自动化路径**实施时逐个确认 `invocation.turnId` 是否必传**。若有不传 turnId 的调用点，chatSignal 的钥匙就变成了 requestId——此时在改动 1b 里再加一行 `signalChatCancel(turn.requestId)` 兜底（registry 对不存在的 key 是 no-op，按两个 key 各 signal 一次永远无害）。

#### 改动 1c：工具被 abort 之后的「收尸」（EBUSY 指向的问题）

**现象**：测试里 cancel 后临时目录 EBUSY——进程要么没被杀、要么杀了没回收（Windows 上进程不退出，目录句柄不释放）。

**实施步骤**：

1. 顺着 SDK dispatch lease 的 `cancel` 回调读到 `run_shell` 执行器的 abort 分支（`runShellExecutor.ts:396-409` 现状：`onAbort` → `supervisor.terminate()`）；
2. 确认 terminate 之后是否 **await 进程真正退出**（拿到退出码/信号）再返回；若 fire-and-forget，改为等待（带超时，超时后升级强杀）；
3. 确认升级杀进程在 Windows 上走进程树终止（现有 supervisor 已有树杀实现的先例，grep `terminate` 核对），不误伤父进程链。

**验证**：Phase 1 完成后，1.4 节那三个 `post-claim … after cancel` 用例应当转绿：marker 落盘（或按语义落 uncertain）、临时目录可正常清理。

#### Phase 1 的红绿验证

- **红（已有）**：1.4 节 17 个失败用例是现成的基线。动手前先原样记录失败清单。
- **绿（目标）**：其中 cancel 相关用例转绿。
- **新增单测**（`electron/activeAgentToolCancellation.test.ts`）：
  - 注册同 turn 两个工具 + 另一 turn 一个工具 → `cancelAllActiveAgentToolsForTurn` 只取消本 turn 的两个，返回 2，另一 turn 的不受影响；
  - 对没有在执行工具的 turn 调用 → 返回 0，不抛错。

---

### Phase 2：恢复中止审计（重做丢失的 Phase 3）

目的：以后再出「中止不生效」，一条日志就能定位到断在哪一环，不用再像这次一样全靠读代码考古。

| 改动 | 文件 | 内容 |
|---|---|---|
| 2a | `electron/ipc/agentProtocolIpc.ts:940` | `chat:cancel-turn` 处理器打点 `turn.cancel`，字段 `turnId / requestId / accepted`（accepted 即 `turnRuntime.cancel` 的返回值） |
| 2b | `electron/toolChatLoop.ts` 取消判定处 | 打点 `llm.cancel`，字段 `requestId / sessionId / loopRound / abortToCatchMs`。**插入位置纪律**：必须在部分用量结算之后、重抛 `ChatCancelledError` 之前（9-29 方案评审 B1 的约束，防止取消轮丢用量记账） |
| 2c | `electron/agentLogger/types.ts` | 闭合联合类型 `AgentLogEventName` 增加 `'turn.cancel'`、`'llm.cancel'`（不加则编译报错，天然防漏） |
| 2d | `electron/agentLogger/agentLogProjection.ts` | `TARGET_EVENTS` 白名单纳入这两个事件（不加则设置页日志投影丢字段） |
| 2e | 测试 | 恢复 `electron/toolChatLoop.abortSignal.test.ts`（7de673f3 原文件已丢，从 `git show 7de673f3` 可找回断言骨架）：① SDK stream 调用第二参数携带 signal；② abort 错误被识别为 cancelled 而非 failed；③ 取消轮部分 usage 照常落账 |

**实施前确认项 B**：agent-sdk 架构下 LLM 调用有「toolChatLoop 内联」与「hosted 移交（`onHostedTurnHandoff`）」两条路。`llm.cancel` 若只打在 toolChatLoop，hosted 路径（用户日常聊天实际走这条）可能打不到——实施时确认 hosted 路径的取消判定落点（`packages/agent-sdk` turn 运行时的 abort 处理），必要时两边都打点，事件名相同、字段一致。

---

### Phase 3：列表按钮「已中止」提示说真话

**现状**：`SessionListPane.tsx:60-63` 无条件弹 `message.info(t('session.aborted'))`——哪怕取消被主进程拒绝（turn 早已结束），也谎报「已中止」。

**改动**：

1. `chatRunnerService.ts` 的 `abortSessionRun` 返回 `boolean`：`meta.turnId` 存在时返回 `window.api.chatCancelTurn(turnId)` 的结果（该 IPC 主进程本来就返回 accepted 布尔值，`agentProtocolIpc.ts:957`；目前渲染端 `void` 掉了），meta 不存在（本地兜底清理）时返回 `false`；
2. `SessionListPane.stopRun` 按 accepted 分支：
   - `true` → 「已中止」（现有 key 复用）；
   - `false` → 新增文案，如「该任务已结束，无需中止」；
3. i18n：`zh-CN` 先加 key，`en-US` 同步，然后 `npm run i18n:generate-types`，提交前 `npm run i18n:check`；
4. **可选顺带**：输入区停止按钮点击后补同样的轻提示（现状点了只变按钮态，没有「已受理」的确认感，这是「没响应」感知的次要放大器）。做不做由评审定，不阻塞。

**测试**：`SessionListPane` 现有测试补两个分支断言（mock `chatCancelTurn` 分别返回 true/false，断言提示文案）。

---

### Phase 4：确认重查 reason 回归（独立排查，不与 Phase 1 混车）

**现象**：4 个 browser 用例期望确认阶段配置漂移重查落 `BROWSER_PREPARED_POLICY_CHANGED`，实际落 `CONFIRMATION_DENIED`（见 1.4）。语义差异：前者告诉用户「配置变了需要重新确认」，后者是「被拒绝」——归错类会误导用户。

**实施方式**：单独一笔。先定位重查入口（hosted 确认适配层 `agentSdkConfirmationPort` / `refreshExecutionContext` 链）里 reason 被改写的位置，再决定是修归类还是修测试期望（**优先修代码**：若 `CONFIRMATION_DENIED` 是重查失败后的兜底归类，应透传原始 reason）。排查期间不阻塞 Phase 1-3 提交。

---

### 观察项（本次明确不改）

1. **finishing 5 秒窗口**：保留。工具能被杀之后，执行方会在窗口内正常退出并提前收敛，窗口退化为「工具收尾（杀进程、收集输出）」的保护垫。若 Phase 1 落地后日志显示窗口仍频繁打满，再评估缩到 2~3 秒——现在缩没有依据。
2. **finishing 期间消息继续滚动**：保留。这是取消过程中流式尾巴数据不丢的设计（`isFinishingEventAllowed`，`turnCoordinator.ts:413`）。可选体验增强（不阻塞）：中止被接受后，输入区状态区显示「正在中止…」占位文案，把「还在滚」解释给用户听。可与 Phase 3 的提示文案一起做。

---

## 四、测试计划

### 4.1 分层

| 层 | 内容 | 时点 |
|---|---|---|
| 定向单测 | Phase 1 新增批量取消用例；Phase 2e 恢复的三条断言；Phase 3 两个提示分支 | 每阶段开发中红绿 |
| 契约回归 | `hostedIntegration` cancel 相关用例（1.4 清单）转绿 | Phase 1 完成后 |
| 项目级 | `npm run test:electron`（Phase 1/2 后）、`npm run test:renderer`（Phase 3 后） | 每阶段收尾 |
| 全量 | `npm test` | 最终验收一次 |

> 流程教训写进这里：这次问题之所以潜伏四天，就是因为 `hostedIntegration` 的 17 个红只会在全量里暴露。**最终验收必须跑全量并清零**，不允许「已知红」带病合并。

### 4.2 钉子（防回归的断言，一个都不能丢）

- 取消轮部分 usage 照常记账（9-29 方案 B1）；
- abort 错误结算为 `cancelled` 而非 `failed`（9-29 方案 1b）；
- `post-claim side effect unknown after cancel` 三兄弟（本次的 EBUSY/marker 断言）。

### 4.3 真机手工验收清单（需要你上机点一遍）

1. 让 agent 跑一条长 shell 命令（如 `sleep 60` 或长构建），执行中点**输入区**中止 → 命令进程秒停、消息停滚、按钮恢复；
2. 同场景点**列表**停止 → 行为一致；
3. 模型长思考期间点中止 → 立即停（9-29 修复的行为，确认没退化）；
4. 工具确认卡片等待中点中止 → 卡片立即取消、turn 即时终结；
5. 上述每一步后查日志：`turn.cancel`（accepted=true）与 `llm.cancel`（abortToCatchMs 数值合理）都在；
6. 中止后检查工作目录：没有进程残留（文件不再增长）、临时目录可删。

---

## 五、风险与回滚

| 风险 | 缓解 |
|---|---|
| 批量取消误伤同会话其它 turn 的工具 | Phase 1a 的前缀匹配含 turnId，单测钉住「另一 turn 不受影响」 |
| 双份 signal（turnId + requestId 兜底）导致重复 abort | AbortController.abort 幂等，重复调用无害；确认项 A 若确认所有路径 key 一致，就不加兜底 |
| 工具被 abort 后结算为 failed 而非 cancelled，污染对话气泡 | 复用 `tool:cancel` 单工具取消的既有结算语义（同一条回调），Phase 1 绿测试里断言 outcome |
| 杀进程树误伤父进程 | 沿用 supervisor 现有树杀实现（grep 工具执行已有先例），不新写终止逻辑 |
| `llm.cancel` 打点位置错误导致取消轮丢用量记账 | 打点固定在用量结算之后（Phase 2b 纪律）+ 2e 的 usage 落账断言钉住 |
| 回滚 | 四个 Phase 各自独立提交，出问题 revert 单笔即可；Phase 1 与 2e 的 signal 契约测试同进退 |

---

## 六、实施顺序与提交切分

1. **提交 1（Phase 1）**：1a + 1b + 1c + 批量取消单测 + cancel 契约用例转绿；
2. **提交 2（Phase 2）**：审计打点 + 白名单 + 恢复 abortSignal 测试；
3. **提交 3（Phase 3）**：accepted 分支提示 + i18n；
4. **提交 4（Phase 4）**：确认重查 reason 归类（独立排查结论出来后）；
5. **收尾**：全量 `npm test` 清零 → 更新本文档状态为「已实施」→ 真机验收清单过一遍。

---

## 七、开工前确认清单（逐项打勾后才动第一行代码）

- [ ] **A**：`butlerInvoker.ts:425` / `imRemoteAgent.ts:334` / `approvalAgent.ts:378` 三处 `invocation.turnId` 是否必传（决定是否需要 requestId 兜底 signal）；
- [ ] `toolConfirmRegistry` 三个导出（`cancelAllToolConfirmsForRequest` / `cancelAllToolsForRequest` / `cancelAllPendingToolConfirms`）在改动 1b 中各司其职的最终取用；
- [ ] SDK dispatch lease 的 `cancel` 回调 abort 后，SDK 侧把工具结算为 cancelled（不是 failed）——读 `packages/agent-sdk` dispatch 实现确认；
- [ ] **B**：hosted 路径 `llm.cancel` 的正确打点落点（`toolChatLoop` 内联 vs `packages/agent-sdk`）；
- [ ] `hostedIntegration` 17 个失败用例全量归类：cancel 相关（Phase 1 钉子）/ browser 重查（Phase 4）/ 其它（单列，不塞进本计划）。
