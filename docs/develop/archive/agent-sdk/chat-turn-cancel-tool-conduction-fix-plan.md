# 聊天中止「停不下来」修复计划：turn 级取消传导补全（v3.1）

> 状态：**已实施（2026-10-13，分支 `fix/chat-turn-cancel-tool-conduction`，基于 `8d749454`）**。Phase 独立提交：Phase 1 `c5c2ccb7`（1a/1b/1c + main.ts 钥匙 + G1 转绿）、Phase 2（审计打点 + 投影白名单 + abortSignal 测试重做）、Phase 3 `86d613cf`（accepted 分支提示 + i18n）、Phase 4 `ab6a2d85`（G6 前提修复 + G1 窗口加固）。实施期与 v3.1 文本的偏差均已在对应小节以「实施回写」标注。
> 日期：2026-10-13 修订（首轮评审 2026-10-12，报告：`docs/review/2026-10-12-chat-turn-cancel-tool-conduction-fix-plan-review.md`；二轮 R1–R6 与三轮复核为评审方反馈，关键证据已由计划方逐条实测核实）
>
> **实施期基线差异（重要）**：实施开工时（`8d749454`）本机实测红基线为 **4 红（G1×3 + G6×1），非下文记载的 17 红**——G2 四条、G3/G4 六条、G5 三条共 13 条已随并行提交自然转绿（归类表中它们本就标注「待复跑」，多数为超时形态）。残余 4 条的根因与处置见 1.4「实施回写」。
>
> **最终验收实测（2026-10-13，全量 `npm test`）**：9684 passed | 43 failed | 34 skipped（1039 文件）。43 条失败**全部与本分支无关**：17 个失败文件经「分支定向重跑 + 主工作区基线对照」双跑确认——42 条在 `8d749454` 基线上同样失败（main 既有红，分布域为 storage 路径防护 / confirmation 提取器 / butler 恢复 / grep 双根等，与本计划改动域零交集），1 条（`sessionStorageMaintenance` 磁盘空间用例）单独复跑通过、属环境抖动。**本分支改动直接相关的全部测试文件（toolChatLoop×13、activeAgentToolCancellation、runShellExecutor、agentLogger、appIpc.file、hostedIntegration 120 条、SessionListPane、ChatView.abort、abortSignal 新文件）全绿，引入 0 个新失败**。main 既有 43 红不在本计划范围，已如实留档待后续立项（教训再次印证 4.1 流程教训：只有全量才暴露）。
>
> **行号快照声明**：本文所有 `文件:行号` 基于 commit `ea273da6`（2026-10-13 06:25）。仓库存在并行提交，行号会漂移（v1→v3 期间 `invocationAssembler.ts` 已漂移 +20~34 行）；**实施时一律以符号检索定位，行号仅作快速导航**。
>
> **v3.1 相对 v3 的变化（三轮复核的 6 条顺手修订 + 2 项确认闭环）**：
> 1. 行号修正：第二处 `HOSTED_HANDOFF_REQUIRED` 实为 `toolChatLoop.ts:1191`（v3 误写 `:1126`——那里抛的是 `HOSTED_REQUIRED_USER_NOT_IN_REQUEST`）；`main.ts` 的 `onCancel` 实为 `:1004`；`chat:cancel-turn` handler 起于 `agentProtocolIpc.ts:940`；`invocationAssembler.ts` 三处更新为 `:359-360 / :839 / :937`；`components.ts` 接口为 `:69-75`（引用 `:71`）；
> 2. 路径补全：`electron/tools/runShellExecutor.ts`、`electron/tools/registeredAgentTurnTools.ts`、`electron/remote/imRemoteAgent.ts`、`electron/confirmation/approvalAgent.ts`；
> 3. 2b 措辞修正：Inner catch 里**没有** `chatSignal.aborted` 分支（该判定只在外层 `:683`），打点条件就是 `error instanceof ChatCancelledError` 命中分支；`retractAttemptPreview` 当前是 no-op（`:1108`），仅作定位标志物；
> 4. **确认项 B（2b-i）闭环**：agent-sdk 全仓 `outcome === 'cancelled'` / `outcome: 'cancelled'` 零命中——取消全部走抛错，`llm.cancel` **只留 Inner catch 一处打点**，「两处都留」作废；
> 5. **确认项 A（三把钥匙）闭环**：`butlerInvoker`（acceptedTurn 必填）与 `approvalAgent`（`:342-345` 本地构造必有）不会降级；**唯一可能降级的是 `electron/remote/imRemoteAgent.ts:399-403`（turnId / acceptedTurn 均可选）**——1a 单测第 3 条（降级场景）必要性确认成立；
> 6. 归类表修正：G2 首变体名是 `enabled`（用例模板为 `when %s changes`）；G1 用例起于 `:2608`、cancel 触发 `:2688`；G3/G4 实为**同一个 `it.each`**（`:3713`，`['navigate','act'] × 三源 = 6 case`），编号保留但注明。

---

## 一、先把问题说清楚（人话版）

### 1.1 两个中止按钮，是同一个按钮

- 输入区的停止按钮：`ChatView.tsx:494-496` → `abortSessionRun(sessionId)`
- 会话列表的停止按钮：`SessionListPane.tsx:60-63` → `abortSessionRun(item.id)`

两者调用**同一个函数**（`chatRunnerService.ts:164`），函数第一步就会**同步**删掉运行状态（`chatRunnerService.ts:174`）——所以第一次点击之后，两个按钮的显示条件（`runningSessions`）同时消失，两个按钮一起变。**按钮本身不需要改**，有测试钉着（`ChatView.abort.test.tsx`）。

### 1.2 「一个能停、一个不能停」的正确解释

既然两个按钮的本地止血都即时生效，差异只剩**观感**，由三件事叠加：

1. **点击后没有任何反馈**：输入区按钮点了只是变回发送态，没有「已受理」提示（列表按钮有 `message.info`，`SessionListPane.tsx:62`）；
2. **消息还在滚**：取消被接受后 turn 进入最长 5 秒的收尾窗口（finishing），窗口内消息增量照常放行（`isFinishingEventAllowed`，`turnCoordinator.ts:413`）——用户看到「还在生成」，判定为「没反应」；
3. **任务真的没停**：根因（1.3）——正在执行的工具收不到中止信号，继续跑到自然结束。这条与按钮无关，点哪个按钮都一样；用户换列表按钮再点时，往往时间点已晚（收尾窗口接近收敛甚至已终态），按钮消失 + 提示弹出，观感上「一击即停」。若此刻 turn 已终态，主进程对取消返回「拒绝」（`turnCoordinator.ts:390-392`），但本地清理与提示照常——这种「谎报已中止」由 Phase 3 修正。

> 按钮差异 = 反馈有无 + 点击时点，不是机制差异；停不下来的根因在工具传导。

### 1.3 真正的根因：取消信号只传了一半

把中止想象成拉总电闸。拉闸之后：

- ✅ **LLM 流断了**——SDK 请求绑定了取消信号（`toolChatLoop.ts:1120`），9-29 修复的成果，有效；
- ❌ **正在执行的工具没停**——长 shell 命令、浏览器自动化、MCP 调用，收不到中止信号。

断点（代码级，已经三轮评审逐条核对）：

1. `signalChatCancel`（`chatCancelRegistry.ts:42-46`）参数语义是 requestId，实际被传入 turnId——它做的三个动作里，撤确认卡与杀工具两个动作按 requestId 索引（`toolConfirmRegistry.ts:286/297`），拿 turnId 去查查不到；
2. 杀工具的旧注册表（`toolConfirmRegistry` 的 per-request abort）在新架构下**已无任何注册者**（`registerToolCancel` 在 `toolChatLoop.ts:156` 是死 import，全仓无调用点）；
3. 新架构的工具取消路由表是 `activeAgentToolCancellation`（会话+turn+工具三元组，`electron/activeAgentToolCancellation.ts`），但它唯一的触发点是 UI **单工具卡片**的取消按钮（`tool:cancel` IPC，`agentProtocolIpc.ts:528-531`）。**turn 级中止（点中止按钮）完全不经过它。**

净效果：点中止后，模型生成停了，工具继续跑到自然结束；工具循环只能在工具结束后于回合边界检查取消标志。一个跑几分钟的 shell 命令，就让用户「点了几分钟都停不下来」。

### 1.4 测试已经红了（17 个，全量归类见表）

实测命令与结果（首轮与三轮复核各实测一次，数量一致）：

```
npx vitest run --project electron electron/claudeStreamHandlers.hostedIntegration.test.ts
→ Test Files 1 failed (1)；Tests 17 failed | 103 passed (120)
```

> 原始运行日志存档：`shell-output/hosted-integration-run.log`（第一轮完整输出，含各用例失败详情）。该命令的可用性以开工确认清单第 0 项（R2）当日验证为准。

**全量归类表（证据形态标注：「已有断言证据」= 失败输出含具体断言差异；「待复跑」= 超时类或证据不足，复跑命令见开工确认清单第 0 项）**：

| 组 | 用例（数量） | 失败形态（证据形态） | 归属 |
|---|---|---|---|
| G1 | `keeps a Desktop Hosted run_shell post-claim side effect unknown after cancel / revoke / authorization-change`（3） | 断言失败 `shell side effect missing` ×1 + `EBUSY` ×3（**已有断言证据**；用例起于 `hostedIntegration.test.ts:2608`，cancel 触发在 `:2688`） | **Phase 1 钉子**（B6：三源统一承诺） |
| G2 | `rechecks Desktop browser authorization when enabled / deniedActions / actRequiresConfirm / actSessionTrustEnabled changes during confirmation`（4） | **仅 1 条有断言证据**（`CONFIRMATION_DENIED` ≠ 期望 `BROWSER_PREPARED_POLICY_CHANGED`）；**另 3 条为 `Test timed out in 15000ms`，归属待复跑定**（是否同链、是否负载抖动） | **Phase 4**（确认重查 reason 归类；3 条超时先复跑判别） |
| G3 | `does not project a late Desktop Hosted browser navigate result after post-claim cancel / revoke / authorization-change`（3） | 待复跑分类（**待复跑**） | **Phase 5**（invalidation 链收敛，见 3.5）。注：G3 与 G4 实为同一个 `it.each`（`:3713`，`['navigate','act'] × 三源 = 6 case`），编号按 action 拆分保留 |
| G4 | `does not project a late Desktop Hosted browser act result after post-claim cancel / revoke / authorization-change`（3） | 待复跑分类（**待复跑**） | **Phase 5**（同上，与 G3 同一测试块） |
| G5 | `records a Desktop Hosted browser cancel / revoke / authorization-change before dispatch claim without entering the browser executor`（3） | 待复跑分类（**待复跑**） | **Phase 5** |
| G6 | `rechecks a Desktop run_shell approval when ShellConfig tightens the timeout while waiting`（1） | `Test timed out in 15000ms`（**待复跑**，受负载影响） | **Phase 4**（确认重查链）；先复跑判别是否纯抖动 |

归类口径：G3/G4/G5 与 G1 同属一条「invalidation（取消/撤销/授权变化）→ 工具中断 → 结果投影」链的不同环节，**不再「单列」**（B5）；「清零」定义：**本次交付结束时，上表 17 个用例全部转绿，或逐条附根因与理由移出该测试文件**——不留未归因的红。

红基线来历（N5）：该组用例由 `48276742`（2026-09-29「feat(agent-sdk): route product lanes through Hosted Runtime」）引入，非 10-08 回归——**红基线自 hosted 路由上线起长期存在**；归类时需一并确认每条是「既有行为被写红的回归」还是「新预期未实现」。

> **实施回写（2026-10-13，`8d749454` 基线实测，逐条 N5 定性）**：
> - **G1（3 条）**：失败形态 `shell side effect missing` + 收尾 `EBUSY`。根因有二：① 取消传导缺失（产品缺陷，Phase 1 修复）；② **测试平台方言缺陷**——命令 `printf … ; sleep 10` 在 win32 默认 PowerShell 5.1 下 `printf` 不存在（`>` 重定向先建空文件、`sleep` 是 Start-Sleep 别名），「副作用已提交」前提无法建立。定性：**回归（传导缺失）+ 测试缺陷（方言）**，二者同提交修复（命令按平台改写，断言零改动）。另：前提等待窗口 5s→10s（满载下 PS 冷启动抖动致假红）。
> - **G6（1 条）**：15s 超时，两轮复跑稳定失败。定性：**新预期未实现的反面——测试前提失效**：当前基线 read-only 命令经 `shellOutsideReadOnly` 走 `shell-precheck-auto-allow` 直通，不进用户确认，测试挂死在审批等待（`waitForToolConfirm` 永不被调用）。超时收紧的重查拒绝机制（`assertPreparedShellExecutionCurrent` 的 configRevision 比较）**本身完好**。修复：改用 workdir 内写入命令（默认 write-execute-ask）恢复确认前提，断言全部保留且真实通过。
> - **G2（4 条）/ G3（3 条）/ G4（3 条）/ G5（3 条）**：实施基线上已全部转绿（随并行提交），无需处置；hostedIntegration 全文件 120/120 复跑两轮确认稳定。

### 1.5 日志查无此事

9-29 方案 Phase 3 的中止审计（`turn.cancel` / `llm.cancel`）连同测试文件 `toolChatLoop.abortSignal.test.ts` 已在后续 merge 中整体丢失（提交 7de673f3 加过，当前源码搜不到）。Phase 2 重做。

---

## 二、修完之后长什么样（验收标准，全部可测）

1. **任意时刻点中止，执行中的工具 2 秒内收到中断**：shell 杀进程并回收输出、浏览器/MCP 调用 abort、目录句柄释放（`EBUSY` 消失）；
2. **turn 终态及时收敛**：工具停 → 执行方退出 → turn 在 5 秒窗口内提前收敛；
3. **日志有据可查**：`turn.cancel`（字段 `turnId / requestId / accepted`）、`turn.cancel.tools`（字段 `turnId / requestId / sessionId / cancelledTools`）、`llm.cancel`（字段 `requestId / sessionId / loopRound / abortToCatchMs`），**且这些字段经日志投影后仍然可见**（B3）；
4. **列表按钮的提示说真话**：取消被接受才提示「已中止」；
5. **G1 的三个用例转绿**（三源统一承诺，见 B6）；
6. **不回归**：取消轮已产出的部分 token 用量照常记账（9-29 方案评审 B1 钉过的行为）。

---

## 三、改动方案（按阶段，可直接照做）

### Phase 1（主修复）：把「杀工具」接进所有中止来源的公共路径

#### 3.0 落点图（先看图再写代码）

三式中断源、一个公共断点、一处共用收尾（B6 的回答）：

```
【中断源 A：点中止按钮】
  渲染端 abortSessionRun → chat:cancel-turn → turnRuntime.cancel
  → coordinator.cancel → cancelHook → signalChatCancel(turnId)
  → ChatCancelRegistry: controller.abort()                            ┐
                                                                        │
【中断源 B：应用退出】cancelAllActiveChats() → 同上 controller.abort()   ├─ 都汇到
                                                                        │ chatSignal 的 abort 事件
【中断源 C：测试/脚本直调】runtime.chatCancels.signalChatCancel(turnId) ┘
                                                                        ↓
     ★ 公共落点（本 Phase 新增）：toolChatLoop.ts:591 之后
     chatSignal.addEventListener('abort', () =>
       cancelAllActiveAgentToolsForTurn(args.sessionId, executionId))
     —— 当前产品只有 hosted 一条执行路径（R1 口径），
        这个 chatSignal 就是它的取消信号                                   ↓
                                                                activeAgentToolCancellation
                                                                逐工具 cancel()（与 UI 单工具
                                                                取消按钮同一回调）→ 工具 abort

【中断源 D：revoke / 授权变化】（不经过 chatSignal！）
  toolRevocations.revokeToolForLane / policyAuthorizationChanges.publish
  → packages/agent-sdk toolExecutionPort.ts:84-88 既有联动
    （permits.invalidateBinding + admission.invalidate → aborts active leases）
  → 同样到达「工具 abort」这一步

【共用收尾（Phase 1c，四源同一处）】
  工具 abort → 执行器杀进程/终止请求 → await 退出 → 输出回收 → 目录句柄释放
```

> 为什么落点在 `toolChatLoop.ts:591`（B1 的回答）：v1 挂在 `main.ts:1004` 的 `onCancel`，但 17 红基线里 cancel 用例**直调 `runtime.chatCancels.signalChatCancel(turnId)`**（`hostedIntegration.test.ts:2688`；run_shell 用例起于 `:2608`）且注入的 `turnRuntime` 是 mock——`onCancel` 那条链在测试里根本不存在，改了也白改。迁移后：IPC 取消、应用退出、测试直调三类来源全部经过 `ChatCancelRegistry` 的 controller.abort → chatSignal abort 事件，一个监听全覆盖；且此处 `executionId = args.turnId ?? args.requestId`（`:571`）与 chatSignal 注册 key 同源，`args.sessionId` 就在作用域内（`:594` 已用）。
>
> **执行路径口径（R1 修正）**：当前产品执行**只有 hosted 一条路径**——`toolChatLoop.ts:629/:1191` 在无 handoff 回调时直接抛 `HOSTED_HANDOFF_REQUIRED`，全文件已无 `APIUserAbortError`；v1/v2 中「内联路径 / 两条路径一个出口」的表述作废。上述 abort 监听对这条唯一的 hosted 路径生效。
>
> 不选「registry 内部联动」：`ChatCancelRegistry.signalChatCancel(requestId)` 手里只有 executionId、没有 sessionId（`packages/agent-sdk/src/runtime/components.ts:71`，接口 `:69-75`），拼不出三元组 key。
>
> **`main.ts:1004` 仍要改一处（保留自 v1 且经评审确认成立）**：撤确认卡补上正确的钥匙——`signalChatCancel` 之外，在 cancelHook 里按 `turn.requestId` 调 `cancelAllToolConfirmsForRequest(turn.requestId)`（turn 对象是完整 `TurnStarted`，`turnRuntime.ts:26-29`）。这解决的是「等待确认中的工具卡没被撤销」，与工具中断是两件事。

#### 改动 1a：工具取消路由表加「整 turn 批量取消」

**文件**：`electron/activeAgentToolCancellation.ts`

```ts
/** 取消指定 (sessionId, turnId) 下全部在准备/执行中的 SDK 工具调用，返回取消数量。 */
export function cancelAllActiveAgentToolsForTurn(sessionId: string, turnId: string): number {
  const prefix = JSON.stringify([sessionId, turnId]) + ','   // 形如 ["sid","tid", —— 含尾逗号
  let count = 0
  for (const [key, entry] of [...activeCancellations]) {
    if (!key.startsWith(prefix)) continue
    entry.cancel()          // 只调 cancel，不直接 delete（N7）：让注册句柄的清理路径自行注销，
                            // 与 registeredAgentTurnTools 的 cleanupPrepared 一致性守卫保持同路
    count++
  }
  return count
}
```

> v1 示例的前缀构造有 bug（`slice(0, -1)` 多留一个引号，恒匹配 0 个，N1），已修正为「序列化后补尾逗号」；1a 单测的「返回 2」断言必须能抓住这类错误（红绿验证见后）。
>
> **实施回写（1a 前缀构造二次修正）**：上行「序列化后补尾逗号」（`JSON.stringify([sid,tid]) + ','` → `["sid","tid"],`）**仍是错的**——真实 key 是三元组序列化 `["sid","tid","tool"]`，闭括号处是 `,` 而非 `],`，该前缀恒匹配 0 个（TDD 红阶段即被「返回 2」断言抓住，正是本行预言的缺陷形态）。正确写法：`JSON.stringify([sessionId, turnId]).slice(0, -1) + ','` → `["sid","tid",`。实现与单测均按此落地。

**为什么安全**：`entry.cancel()` 与 UI 单工具取消按钮（`tool:cancel` → `cancelActiveAgentTool`）调用的是**同一个回调**（注册点 `invocationAssembler.ts:937`；回调体 `electron/tools/registeredAgentTurnTools.ts:136` `cancelController.abort('tool-cancelled')`，且该 controller 会进入执行期 `combined.signal`）。单工具取消能停的工具，整批复用同一回调就能停。

#### 改动 1b：在公共落点接线（替代 v1 的 onCancel 挂载）

**文件**：`electron/toolChatLoop.ts`，`registerChatCancel(executionId)`（`:591`）之后：

```ts
// llm.cancel 的计时起点（R1：Inner catch 与本处不同作用域，经 WeakMap 跨层传递）
const cancelTimestamps = new WeakMap<AbortSignal, number>()   // 模块级，文件顶部声明
chatSignal.addEventListener('abort', () => {
  cancelTimestamps.set(chatSignal, performance.now())
  const cancelledTools = cancelAllActiveAgentToolsForTurn(args.sessionId, executionId)
  // R4：此处不打 turn.cancel（该名字保留给 IPC 处理器的 accepted 记录），
  // 工具传导数量落独立子事件，字段形状互不混淆
  logAgentEvent('warn', 'turn.cancel.tools', {
    turnId: executionId, requestId: args.requestId, sessionId: args.sessionId,
    cancelledTools
  })
}, { once: true })
```

说明：

- `{ once: true }`：abort 只会发生一次，监听器随 controller 生命周期（`:686` `clearChatCancel` 后 controller 丢弃；该函数只注销不 abort，监听不会误触发）可回收；
- `cancelledTools` 落进日志（B2 建议）：「传导到了但匹配到 0 个」这类静默失效从此可见；
- **事件命名（R4）**：`turn.cancel` 只在 IPC 处理器（Phase 2a）打，承载「取消被没被接受」；本落点打 `turn.cancel.tools`，承载「abort 后传导杀了几个工具」。两个事件不同名、字段形状各自固定，杜绝同名异形；
- **执行路径**：当前产品只有 hosted 一条路径（见 3.0 口径修正），本监听对它生效；
- `main.ts:1004` 的确认卡钥匙补齐照做（见 3.0 末尾说明），`turn.cancel`（accepted）的打点保留在 Phase 2 的 IPC 处理器。

#### 改动 1c：工具被 abort 之后的「收尸」（四源共用，N6 拆分后的两条独立验证）

**验证 ①（进程回收）**：`electron/tools/runShellExecutor.ts:395-399` 现状 `onAbort = () => { interrupted = true; void supervisor.terminate().then(...) }`——**未 await 进程退出**。改为 abort 分支内等待 terminate 完成（带超时，超时升级强杀），确认 Windows 上走进程树终止且不误伤父进程链（沿用 supervisor 现有实现，不新写终止逻辑）。

**验证 ②（post-claim 的 marker 期望）**：`shell side effect missing; providerCalls=1` 是与进程回收**另一类**现象——marker 未落盘或未及落盘。实施第一步先回到测试断言本身（`expect(await fs.readFile(markerPath)).toBe('effect-committed')`）确认 post-claim 语义下期望值到底是什么：副作用已发生的，应**等 shell 收尾并落盘**后按语义记 uncertain/completed，而不是让 marker 悬空。两件事分开修、分开验，不允许在「等 terminate」与「等 side effect」之间来回试错。

#### Phase 1 的红绿验证

- **红（基线）**：1.4 归类表 G1 三个用例（命令与结果见 1.4；其中超时类失败标注「受负载影响」，复跑两次取稳定形态）；
- **绿（目标）**：G1 三个变体全部转绿——cancel 变体由 1a+1b 覆盖，revoke / authorization-change 变体由 **1c 的共用收尾**覆盖（它们的中断能力在 `toolExecutionPort.ts:84-88` 既有联动里，缺的是收尾）；
- **新增单测**（`electron/activeAgentToolCancellation.test.ts`）：
  1. 同 turn 注册两个工具 + 另一 turn 一个工具 → 批量取消只命中本 turn 的两个，返回 2，另一 turn 不受影响；
  2. 空 turn 调用 → 返回 0，不抛错；
  3. **降级场景**（B2 + 三轮复核确认 A）：登记端在 `acceptedTurnId` 缺失时用 requestId 登记（复现 `invocationAssembler.ts:359-360` 的降级；唯一现实来源是 `electron/remote/imRemoteAgent.ts:399-403`，其余调用点不降级），批量取消用同一 key 仍能命中——钉住「三把钥匙同源」。

---

### Phase 2：恢复中止审计（重做丢失的 Phase 3）

| 改动 | 文件 | 内容 |
|---|---|---|
| 2a | `electron/ipc/agentProtocolIpc.ts:940` | `chat:cancel-turn` 打点 **`turn.cancel`**，字段 `turnId / requestId / accepted`（accepted = `turnRuntime.cancel` 返回值；requestId 从 handler 内已取到的 turn 对象取，`:943` `turnRuntime.getTurn(turnId)`，取不到时省略字段）。这是「取消被没被接受」的权威记录 |
| 2b | `electron/toolChatLoop.ts` **Inner catch（`:1192-1195`）** | `llm.cancel` 打点（**落点定稿，R1 + B4 方案 ii，三轮复核闭环**）：打点位于 Inner catch 内、**`error instanceof ChatCancelledError` 命中的分支**（Inner catch 没有 `chatSignal.aborted` 分支——该判定只在外层 `:683`；`retractAttemptPreview` 当前是 no-op `:1108`，仅作定位标志物），字段 `requestId / sessionId / loopRound / abortToCatchMs`。**为什么必须是 Inner catch**：`loopRound` 是 Inner 局部变量（`:1026`）；外层 wrapper 的 `chatSignal.aborted` 判定（`:683`）没有 loopRound 上下文。**计时起点跨作用域传递**：`abortToCatchMs = performance.now() - cancelTimestamps.get(chatSignal)`（起点由 1b 的 WeakMap 写入；取不到时不打该字段并告警，不编造数值） |
| 2b-i（R1，三轮复核闭环） | 同上 | **只留 Inner catch 一处打点**：agent-sdk 全仓 `outcome === 'cancelled'` / `outcome: 'cancelled'` 零命中——取消全部走抛错（`ToolExecutionRejectedError('CANCELLED')` / `ToolExecutionAfterDispatchError` 等），不存在「以 result.outcome 结算不抛错」的入口。「两处都留」作废；实施时若发现新的 result 型取消入口（超出本轮静态核查），再按本行同样理由评估 |
| 2c | `electron/agentLogger/types.ts` | `AgentLogEventName` 闭合联合增加 **`'turn.cancel'`、`'turn.cancel.tools'`、`'llm.cancel'`** 三个事件（R4：两个 turn 级事件不同名不同形；不加则编译报错） |
| 2d | `electron/agentLogger/agentLogProjection.ts:7` | `TARGET_EVENTS` 纳入三个事件。**理由更正（v1 写反了）**：投影逻辑是「未命中 `TARGET_EVENTS` 的事件原样透传（`:60`），命中才按 `COMMON_KEYS` 收紧过滤（`:93`）」——纳入白名单是为了让审计事件走字段白名单的可控路径，而不是「不加就丢字段」 |
| 2f（B3） | 同上 `:18` | `COMMON_KEYS` 增加 `accepted`、`abortToCatchMs`、`cancelledTools`——不加这三个键，2a/1b/2b 打的字段在投影时会被整体丢弃（投影命中白名单后只保留 `COMMON_KEYS` 内的键），验收标准 3 直接不成立（7de673f3 原提交正是「纳入白名单并扩 COMMON_KEYS」两件事）。路由安全性（三轮复核）：`turn.cancel` / `turn.cancel.tools` / `llm.cancel` 不会被 `shell.*` / `script.exec.*` 前缀分支误路由（全文仅 `:57/:59` 两个 `startsWith` 分支） |
| 2e | 测试 | 恢复 `electron/toolChatLoop.abortSignal.test.ts`（从 `git show 7de673f3` 找回断言骨架）：① SDK stream 调用第二参数携带 signal；② 取消结算为 cancelled 而非 failed（**按 R1 口径更新断言形态**：现行取消异常是 `ChatCancelledError` / `HostedTurnFinalizedError` 等，全文件已无 `APIUserAbortError`）；③ 取消轮部分 usage 照常落账。**投影契约测试补三条**（N8）：`turn.cancel` 投影后保留 `accepted`；`turn.cancel.tools` 投影后保留 `cancelledTools`；`llm.cancel` 投影后保留 `abortToCatchMs`——「字段清单 ↔ COMMON_KEYS」逐项对照，不靠试跑 |

**`cancelledTools=0` 的二义性说明（R5）**：`0` 有两种完全不同的含义——① abort 时该 turn 本来就没有工具在跑（正常：LLM 阶段点中止）；② 有工具在跑但 key 不匹配没杀到（异常：传导失效）。日志本身区分不了这两种，**传导正确性靠测试钉住**（1a 单测第 1/3 条 + G1 集成钉子），不靠日志猜；日志分析时若 `turn.cancel.tools` 的 0 与同 turn 的 `tool.progress` 事件并存，即为异常信号。

> **实施回写（2b 打点条件修正）**：v3.1 的「打点条件就是 `error instanceof ChatCancelledError` 命中分支」经实测不成立——hosted 路径上原生 `ChatCancelledError` 只在 pre-LLM 判定（`throwIfChatCancelled`）抛出，流中段取消以 `HostedTurnFinalizedError(cancelled/interrupted)` 或包装后的 `HostedTurnHandoffError` 到达 Inner catch，instanceof 条件永不命中。实际实现取 **`chatSignal.aborted`** 作为打点条件（覆盖上述全部形态；abort 之外的错误不会误触），字段形状不变。2b-i 结论（只留 Inner catch 一处打点）维持成立。

---

### Phase 3：列表按钮「已中止」提示说真话

**现状**：`SessionListPane.tsx:60-63` 无条件弹「已中止」——哪怕取消被拒绝（turn 早已结束）。

**改动**（含 N4 的签名与调用点适配）：

1. `chatRunnerService.ts` 的 `abortSessionRun` **async 化**，返回 `Promise<boolean>`：
   - `meta.turnId` 存在 → 返回 `await window.api.chatCancelTurn(turnId)`（该 IPC 主进程本就返回 accepted，`agentProtocolIpc.ts:957` 附近；渲染端现在 `void` 掉了）；
   - meta 不存在（本地兜底清理）→ 返回 `false`；
   - 内部其余清理逻辑保持同步执行顺序不变（rejectAll → clearLive → removeRunningSession 照旧先做，**不为等 IPC 返回拖延本地止血**）；
2. 三个调用点适配：
   - `SessionListPane.tsx:61`（`stopRun`）：`const accepted = await abortSessionRun(id)` 后按 accepted 分支提示——`true` → 复用现有 `session.aborted`；`false` → 新增文案「该任务已结束，无需中止」。**注意提示时序**：`await` 的是一次很快的 IPC invoke，弹提示前本地止血已完成（按钮已消失），不会出现「先弹提示后关按钮」的倒挂；
   - `SessionListPane.tsx:69`（`del`）：改为 `void` 或 `await` 均可（删除场景 accepted 不影响后续 `sessionDelete`），保持行为不变即可；
   - `ChatView.tsx:495`（`abort`）：改 `void abortSessionRun(sessionId)`，**无提示、静默止血**（输入区按钮的反馈就是按钮态变化本身）；
3. `ChatView.abort.test.tsx:66-67` 的 `chatCancelTurn` 同步断言确认仍成立（`window.api.chatCancelTurn` 是 mock，调用发生在 `abortSessionRun` 内第一个 await 之前，`fireEvent.click` 后同步可达——实施时以测试实测为准，若因 async 化失稳则在断言前加 `await waitFor`）；
4. i18n：`zh-CN` 先加 key、`en-US` 同步 → `npm run i18n:generate-types` → 提交前 `npm run i18n:check`。

**测试**：`SessionListPane` 补两个分支断言（mock `chatCancelTurn` 返回 true / false，断言两种提示）。

---

### Phase 4：确认重查链（G2 四个 + G6 一个）

**G2 现象**：browser 确认重查期望落 `BROWSER_PREPARED_POLICY_CHANGED`（告诉用户「配置变了，请重新确认」），实际落 `CONFIRMATION_DENIED`（「被拒绝」）——归错类误导用户。仅 1 条有断言证据（首轮实测），另 3 条为超时待复跑。定位方向：hosted 确认适配层（`agentSdkConfirmationPort` / `refreshExecutionContext` recheck 链）里 reason 被兜底改写的位置；**优先修代码透传原始 reason**，而不是改测试期望。

**G6（B5 纳入）**：`rechecks a Desktop run_shell approval when ShellConfig tightens the timeout while waiting`——失败形态是 15 秒超时，与 G2 同属「确认阶段重查」链。**先复跑两次**：稳定失败 → 纳入 Phase 4 排查（可能是重查等待未受超时变更驱动，真实挂死）；两次均绿 → 记为负载抖动，从钉子清单移除并注明。不允许静默留在「已知红」里。

---

### Phase 5（B5/B6 的完整闭环）：invalidation 链收敛验证（G3/G4 六个 + G5 三个）

G3/G4（post-claim 后迟到的 browser 结果不得投影；同一 `it.each` 的 6 个 case，`:3713`）与 G5（claim 前取消/撤销/授权变化不得进入 browser executor）与 G1 同属一条链，处置：

1. **Phase 1 落地后立即复跑这九个用例**：工具被正确中断/租约被正确拒绝后，迟到结果与 claim 前进入执行器的源头消失，预计相当一部分随钉子转绿；
2. 仍未转绿的逐条归因，按根因分派：
   - 中断传导仍有缺口 → 回 Phase 1 补（同一提交系列）；
   - 投影语义问题（结果已被正确中断但仍被投影）→ 独立小修，落在 Phase 5 自己的提交；
   - 超时抖动 → 复跑两次取稳定形态，稳定失败才归因；
3. **Phase 5 不得留「未归因」用例**：每个用例的结局只能是「转绿」或「附根因说明移出」。

---

### 观察项（本次明确不改）

1. **finishing 5 秒窗口**：保留。工具能被杀之后执行方会在窗口内退出并提前收敛；若落地后日志显示窗口仍频繁打满再评估缩到 2~3 秒。
2. **finishing 期间消息继续滚动**：保留（流式尾巴数据不丢）。可选体验增强：中止被接受后状态区显示「正在中止…」——与 Phase 3 的提示文案一起做，不阻塞。

### 合并评审观察项（2026-10-13，非阻断，供后续立项）

1. **llm.cancel 打点口径略宽**：条件为 `chatSignal.aborted`——abort 后任何到达 Inner catch 的错误（含与 LLM 无关者）都会记为 `llm.cancel`。计划文档已声明此为实测口径，可接受；若后续要收紧，可在判定处叠加错误形态白名单。
2. **abortSessionRun 的 IPC 异常文案**：`chatCancelTurn` 被 `.catch(() => false)` 兜底后返回 false，UI 会显示「该任务已结束」——把 IPC 故障误标为 turn 终态。概率低；如需更真实可区分「IPC 失败」与「受理拒绝」两种 false。
3. **既存遗留（非本分支引入）**：`chatCancelRegistry.signalChatCancel` 内部仍以收到的 turnId 键调 `cancelAllToolConfirmsForRequest` / `cancelAllToolsForRequest`（requestId 键域，静默 no-op——Phase 1 的 main.ts 钥匙补齐只解决了确认卡一半）；且 `registerToolCancel` 已无任何生产调用方，属死路径。建议后续单独清理。
4. **真机验收清单未关单**：本计划真机项（长 shell 秒停、确认卡即时取消、无进程残留等）仍需按 4.3 逐项过一遍。已实测一项：长命令执行中点中止，三事件齐全、107ms 收敛、终态 `cancelled`（见 1.4 实施回写）；剩余项待真机补齐后方可关单。

---

## 四、测试计划

### 4.1 分层

| 层 | 内容 | 时点 |
|---|---|---|
| 定向单测 | 1a 三条（含降级场景）；2e 六条断言；Phase 3 两个分支 | 各阶段内红绿 |
| 契约回归 | G1 三条（Phase 1 完成后转绿）；G3/G4 六条 + G5 三条（Phase 5 复跑归类）；G2/G6（Phase 4） | 对应 Phase 完成后 |
| 项目级 | `npm run test:electron`（Phase 1/2 后）、`npm run test:renderer`（Phase 3 后） | 每阶段收尾 |
| 全量 | `npm test` | 最终验收一次 |

**「清零」定义（B5）**：本次交付结束时 1.4 表中 17 个用例全部转绿，或逐条附根因与理由移出；不允许任何「未归因的红」。流程教训：这批红在 main 上挂了很久没人看到，因为只有全量才暴露——**最终验收必须全量清零**。

### 4.2 钉子（防回归断言，一个不能丢）

- 取消轮部分 usage 照常记账（9-29 方案 B1）；
- 取消错误结算为 `cancelled` 而非 `failed`（9-29 方案 1b，按 R1 口径钉现行异常形态）；
- G1 三条：post-claim 三源中断 + 收尾（marker 语义、目录可清理）；
- 投影契约：`accepted` / `abortToCatchMs` / `cancelledTools` 经投影后可见（B3）。

### 4.3 真机手工验收清单

1. agent 跑长 shell 命令，执行中点**输入区**中止 → 命令进程秒停、消息停滚、按钮恢复；
2. 同场景点**列表**停止 → 行为一致；
3. 模型长思考期间点中止 → 立即停（9-29 修复不退化）；
4. 工具确认卡片等待中点中止 → 卡片立即取消、turn 即时终结；
5. 每步后查日志：`turn.cancel`（`accepted=true`）与 `turn.cancel.tools`（`cancelledTools≥1`；LLM 阶段点中止时为 0 属正常，见 R5 说明）与 `llm.cancel`（`abortToCatchMs` 合理）均在，**且设置页日志投影里能看到这些字段**；
6. 中止后检查工作目录：无进程残留、临时目录可删。

---

## 五、风险与回滚

| 风险 | 缓解 |
|---|---|
| 批量取消误伤同会话其它 turn | 前缀含 turnId（1a 修正后写法），单测第 1 条钉住 |
| 登记端 `turnId ?? requestId` 降级导致匹配 0 个（B2） | key 与登记端同源（共用 `executionId`）；`cancelledTools` 落日志使静默失效可见；单测第 3 条钉住降级场景（现实来源：`electron/remote/imRemoteAgent.ts:399-403`） |
| revoke / authorization-change 变体不随 Phase 1 转绿（B6） | 落点图已明确两源走 `toolExecutionPort.ts:84-88` 既有联动、缺的是 1c 共用收尾；若复跑仍红按 Phase 5 第 2 条归因，不许悬置 |
| 工具 abort 后结算为 failed 而非 cancelled | 复用 `tool:cancel` 单工具取消的既有结算语义（同一回调）；G1 绿测试断言 outcome |
| 杀进程树误伤父进程 | 沿用 supervisor 现有树杀实现，不新写终止逻辑；terminate 改为 await（带超时升级） |
| `llm.cancel` 计时起点缺失（hosted 取消早于监听注册等边界） | WeakMap 里取不到时间戳时打点省略 abortToCatchMs 字段并告警，不编造数值 |
| Phase 3 async 化引入调用点时序问题 | 三个调用点逐一适配（N4）；本地止血先于 await，`ChatView.abort.test` 断言实测确认 |
| 行号漂移导致实施定位偏差 | 本文行号基于 `ea273da6` 快照（见文档头声明）；实施以符号检索为准 |
| 回滚 | 五个 Phase 各自独立提交，revert 单笔即可；Phase 1 与 2e 的 signal 契约测试同进退 |

---

## 六、实施顺序与提交切分

1. **提交 1（Phase 1）**：1a + 1b（公共落点接线 + `turn.cancel.tools` 打点）+ 1c（收尾两条验证）+ 三条单测 + G1 转绿；`main.ts:1004` 确认卡钥匙补齐随本提交；
2. **提交 2（Phase 2）**：审计打点（2a/2b）+ 类型与投影白名单（2c/2d/**2f**）+ 恢复测试与投影契约断言（2e）；
3. **提交 3（Phase 3）**：accepted 分支提示 + i18n + 调用点适配；
4. **提交 4（Phase 4）**：G2 reason 归类 + G6 复跑处置；
5. **提交 5（Phase 5）**：G3/G4/G5 复跑归类与残余修复；
6. **收尾**：全量 `npm test` 按 4.1 的「清零」定义验收 → 更新本文档状态为「已实施」→ 真机验收清单过一遍。

> **实施记录（提交切分落地情况）**：提交 1 = `c5c2ccb7`（Phase 1）；提交 2 = Phase 2 审计（`e89de026`，含 2c 中 `turn.cancel.tools` 因 1b 编译需要提前随提交 1 入库，类型其余部分随本提交）；提交 3 = `86d613cf`（Phase 3）；提交 4 = `ab6a2d85`（Phase 4，G6 + G1 窗口加固，同时覆盖 Phase 5 的复跑归类——G3/G4/G5 已随并行提交转绿、hostedIntegration 全文件 120/120 两轮确认）；提交 5 = 本文档收尾。2b 打点条件按实测修正为 `chatSignal.aborted`（见 Phase 2 实施回写）。

---

## 七、开工前确认清单

> 三轮复核已闭环两项（B、A），剩余四项已于实施开工当日全部闭环（✅ = 实施回写）。

- [x] ✅ **0（R2，第一项）**：`npx vitest 4.1.6` 可用，复跑命令 `npx vitest run --project electron <file>` 实测可用。**前置条件**：workspace 包 `@spaceassistant/agent-provider-pi-ai` 的 `dist` 不随库分发，全新 checkout 须先 `npm run build:agent-provider-pi-ai`（`npm test` 的 pretest 自动做，定向 vitest 需手动），否则报「Failed to resolve entry for package "@spaceassistant/agent-provider-pi-ai"」（首轮复跑即命中此错，构建后消失）；
- [x] **A（B2 扩展：三把钥匙同源）——已闭环（三轮复核实测）**：`butlerInvoker`（acceptedTurn 必填）与 `approvalAgent`（`electron/confirmation/approvalAgent.ts:342-345` 本地构造必有）**不会降级**；唯一可能降级的是 `electron/remote/imRemoteAgent.ts:399-403`（`turnId: args.turnId`、`acceptedTurn: args.acceptedTurn` 均可选）。处置：批量取消 key 与登记端同一表达式（`executionId`，`toolChatLoop.ts:571`）；单测第 3 条的降级场景即针对 imRemote 形态，必要性确认成立；
- [x] ✅ **`cancel()` 之后注册句柄的注销可达性（N7 跟进）**：确认可达——`cleanupPrepared`（内含 `record.unregisterActiveCancellation?.()`）有四条触发路径：执行 `finally`（registeredAgentTurnTools execute 正常/abort/异常结算均经此）、recheck 阶段 catch、`executeDeferred` 的 `finally { discardPreparedTool }`、SDK 未派发路径的 `discardPreparedTool`。批量取消只调 `cancel()` 不 delete 的设计无残留风险；
- [x] ✅ **SDK 侧工具被 abort 后结算语义**：确认走抛错（与确认项 B 一致）——`toolExecutionPort.ts` 中 dispatch 前 abort → `ToolExecutionRejectedError('CANCELLED'/'REVOKED'/'AUTHORIZATION_STALE')`；进入执行器后 abort → `ToolExecutionAfterDispatchError`（结果不确定性保留）。`llm.cancel` 单点打点方案不受影响；
- [x] **B（R1 / 2b-i）——已闭环（三轮复核实测）**：agent-sdk 全仓 `outcome === 'cancelled'` / `outcome: 'cancelled'` 零命中，取消全部走抛错（`ToolExecutionRejectedError('CANCELLED')` / `ToolExecutionAfterDispatchError`）——`llm.cancel` 只留 Inner catch 一处打点（2b-i 已按此定稿）；
- [x] ✅ **G2 的 3 条超时 + G6（R6）**：G2 四条在实施基线已全部转绿（随并行提交），无需归类；G6 两轮复跑均为稳定 15s 超时（非负载抖动），根因与修复见 1.4 实施回写（测试前提失效，Phase 4 修复后转绿）；
- [x] ✅ **17 红逐条定性（N5）**：见 1.4「实施回写」——G1 为「回归（传导缺失）+ 测试方言缺陷」、G6 为「测试前提失效（read-only shell 直通化所致）」、G2/G3/G4/G5 实施基线已绿无需定性。

## 复评携带物（对应首轮评审第四节要求）

1. **落点图**：3.0 节（三源 + 公共断点 + 共用收尾；含 R1 的 hosted 单路径口径修正）；
2. **17 红归类表**：1.4 节（含归属、失败形态、R6 的「已有断言证据 vs 待复跑」标注）；
3. **实测红基线**：命令与结果见 1.4；可用性以开工确认清单第 0 项（R2）当日验证为准。
