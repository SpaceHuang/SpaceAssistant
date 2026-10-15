# 执行生命周期可靠性收敛开发计划

日期：2026-09-30  
基线：本地 `main`；执行身份、Session Transcript、History 恢复及 Driver 投递以当前代码和 [Driver 与 Runtime 生命周期及结果送达改进方案](./2026-09-29-driver-runtime-lifecycle-improvement-plan.md) 为准。  
性质：面向现有执行链路的重构与缺陷修复计划，不新增用户功能。

## 1. 目标

把最近几轮集中出现的生命周期问题收敛为可验证的一组契约：一次用户输入从接受到执行、审批/取消、历史提交、结果投递，在任何终态或恢复边界都能回答：

1. 这次执行属于哪个会话、turn 和用户消息？
2. 当前权威状态是什么，由哪个持久事实确定？
3. 失败、取消、超时、进程重启后哪些内容可继续使用，哪些副作用绝不能重放？
4. 如何通过本机自动化测试证明状态没有串会话、丢历史、假成功或重复执行？

完成后，同一身份和状态规则应贯穿桌面、Feishu、WeChat、Butler、Approval 入口；兼容旧数据的路径应受限、可观测，并且不在缺少生产观测证据时贸然删除。

## 2. 范围和边界

### 纳入

- `AcceptedTurn` 身份从接受边界至 Runtime、History、确认/取消、终态投影和结果投递的传递与核验。
- Turn/工具执行/审批/History/Transcript/Driver delivery 的状态所有权、状态转换、恢复和幂等性。
- 失败回复重试、继续输入、启动恢复、History cutover、跨会话隔离和投递对账的回归测试。
- 对重复状态逻辑、旧 ID 兼容逻辑和已失效调用路径的审计；只有有证据且不破坏旧会话时才清理。

### 不纳入

- 新设置页、运维页、状态面板、配置项、用户操作或新的业务功能。
- 改变会话交互、审批策略、远端投递承诺或失败消息展示语义；若修复必须明确改变既有行为，应先作为范围问题记录，不在此计划中默认扩张。
- Windows 专属测试、其他无法在本机自动执行的步骤、真实 IM 账号/服务演练、生产部署后的遥测观察。它们不作为本计划完成条件。
- 未经零命中证据证明安全的旧数据兼容路径删除。
- 与生命周期可靠性无关的界面、排队任务栏或文档改动。

## 3. 已有实现与计划关系

开始实施前以 `git status` 和当前代码复核，不能把历史报告中的“已完成”直接当成本次 HEAD 的测试证据。

当前代码已具备并应复用的基础：

- 不可变 `AcceptedTurn` 及接受后持久身份记录；新执行使用 `turnId`，保留旧 requestId/History 读取适配。
- Session transcript 版本、执行 claim/FIFO、checkpoint、启动对账以及 `commit_uncertain` 栅栏。
- 共享 terminal outcome 解码，规范 History 与 Transcript/Turn 投影的终态核验。
- Driver delivery journal、`deliveryId`、多目标状态、`delivery_uncertain`、TTL、supersede 和重启恢复。
- 本次“重试回复”修复：同一 user message 关联的所有失败 assistant 尝试一并排除；旧 accepted input 恢复不依赖数据库时间戳出现在模型 API 消息中。

这些基础分别在 `electron/runtime/acceptedTurnContext.ts`、`src/shared/acceptedTurn.ts`、`electron/runtime/terminalOutcome.ts`、`electron/runtime/sessionTranscriptStartup.ts`、`electron/driver/deliveryHub.ts`、`electron/driver/sqliteDeliveryJournal.ts`、`electron/database/operations.ts` 等处。已有总体方案的阶段 0–2 实现记录继续由其原文维护；本计划不复制其大规模入口迁移工作，而是针对跨模块契约的一致性和剩余缺口做收敛验收。

## 4. 工作包和可验收任务

每项使用 TDD：先新增能在旧行为下失败的回归，再做最小修复，最后验证既有调用方。任务只有在“实现、针对性回归、必要类型/构建门禁”全部满足后才标记完成。

### WP0：建立实际基线与契约清单

**任务**

- [x] 盘点入口、身份字段和状态事实：Desktop、Feishu、WeChat、Butler、Approval 各记录 `requestId`、`turnId`、`sessionId`、`currentUserMessageId` 的生成点、传递点、存储点和查找点。
- [x] 盘点终态写入者和读取者：TurnRuntime、Agent SDK History、Session Transcript、UI 投影、Butler run、Driver journal。每个终态标注规范来源和投影用途。
- [x] 以本地代码和可执行用例核验既有生命周期方案中的完成项；列出仍有调用方自行拼装身份/状态、仍无回归覆盖的具体文件和入口。不要把“理论笛卡尔积不全”当作缺陷，需指出未覆盖的具体危险边界。
- [x] 将本次 retry 修复作为固定基线用例：一个 user message 对应多次 failed assistant，重试上下文排除全部 failed attempts；未关联 turn 的兼容场景也必须有定义。

**验收证据**

- [x] 文档内有完整的入口矩阵与状态事实矩阵；每一行都有源码位置和至少一个测试文件作为证据。
- [x] 矩阵中的 ID 用途无“requestId/turnId 可互换”等模糊描述；如保留旧数据例外，明确触发条件和拒绝条件。
- [x] 核验出的缺口转为后续 WP 的具体任务或书面说明为无缺陷，不遗留未决的“进一步检查”。

**建议定向命令**

```bash
rg -n "AcceptedTurn|turnId|requestId|decodeTerminalOutcome|commit_uncertain|delivery_uncertain" electron src/shared
```

### WP1：统一执行身份的入口契约

**任务**

- [x] 明确 `AcceptedTurn` 是已接受执行的稳定身份契约；所有新入口在任何模型/工具副作用前完成构造和持久接受。
- [x] 审计入口 assembler、远端 adapter、Approval 与取消/确认 IPC：内部身份查询必须解析到 `(sessionId, turnId)` 或有明确定义的复合键，不能只凭可能跨会话复用的 `requestId` 命中运行中状态。
- [x] 对尚未接受的入口失败、重复接收、同 `requestId` 跨会话、同一 turn 重复请求、会话/用户消息不匹配建立行为表；拒绝时不得部分启动 Runtime。
- [x] 将外部 requestId 到 canonical turn 的解析限制在入口边界；内部模块不得各自实现不一致的 fallback。旧数据读取必须走标注为 legacy 的适配函数。
- [x] 只在 WP0 发现重复且可安全共享的适配时抽取小型 resolver；不得为了“统一”而新增第二份状态表或宽泛改造 SDK 公共 API。本轮盘点未发现需要新抽取的重复 resolver，因此没有扩展该层。

**验收测试**

- [x] 同一 Runtime 中两个会话共用 requestId、使用不同 turnId 并发执行时相互独立；取消/终态/结果查询 A 不影响 B。CallAdmission 取消与 Approval 父任务配额均增加同 ID 跨会话回归。
- [x] 同一 requestId 在一个会话映射到多个活动 turn 时，查找明确拒绝含糊结果，不任取一条。
- [x] user message ID、session ID 或 AcceptedTurn 与持久 turn 任一不匹配时，provider 和工具 executor 调用次数均为 0。
- [x] 桌面、Feishu、WeChat、Butler、Approval 每条真实装配链至少有一个 AcceptedTurn 到 canonical terminal 的集成断言；远端 router 使用真实 SQLite TurnRuntime，IM agent/Hosted History 与共享 terminal adapter 分层组合验证。

**验收命令**

```bash
npx vitest run electron/runtime/acceptedTurnContext.test.ts electron/runtime/invocationAssembler.test.ts electron/remote/turnExecutionAdapter.test.ts electron/confirmation/approvalAgent.test.ts
npx tsc -p tsconfig.electron.json --noEmit
```

### WP2：收敛终态转换与投影

**任务**

- [x] 分别维护两张转换表，不把执行终态与提交/恢复栅栏混为一谈：
  - **canonical History 执行终态**：`completed`、`failed`、`cancelled`、`timed_out`、`interrupted`。这些值必须由实际 History terminal event 解码；`decodeTerminalOutcome` 不得从 claim/checkpoint 推造执行终态。
  - **Session 提交/恢复状态**：包括 `ready`、`commit_uncertain` 等 transcript/claim 状态。`commit_uncertain` 表示跨存储提交或恢复证据不足，可能存在 History terminal，也可能不存在；它不是 History terminal，也不能为满足验收而伪造 terminal event。
  - 对每张表注明事实来源、允许转换、持久化位置、投影消费者及禁止的反向推断。
- [x] 核实 `decodeTerminalOutcome` 是从 canonical terminal 解释已结束执行的唯一路径；发现重复解释时改为复用，不扩大其职责到尚未持久 terminal 的实时结果。
- [x] 对 approval reject/timeout、用户取消、工具撤权、Runtime 超时、History append 失败、checkpoint 失败、Driver 发送未知结果，分别指定是否能写 History terminal、session fence 状态、用户可见既有结果和是否可重放；History 无法确认时保留“未知”，不得补造执行事实。
- [x] 核验 terminal 写入前失败、写入成功但确认丢失、投影写入失败三种边界；确保幂等恢复不会重复执行模型或工具。
- [x] 仅修复可复现的状态折叠、错误 success 标记、虚假 delivered 时间戳或遗留运行态；不新建状态 UI。

**验收测试**

- [x] 每种 canonical History 执行终态至少有一个 History event 到 Transcript/TurnRuntime/现有 UI 投影的断言；timeout 和 cancel 明确区分。
- [x] `commit_uncertain` 按 Session 提交/恢复状态独立验收，并分别覆盖：History terminal 已存在但 checkpoint 提交失败；History terminal 不存在或无法读取、执行结果不确定。断言均为 Session/claim 保持 uncertain fence、不伪造 History terminal、不自动重跑模型或工具；只有存在且通过校验的 History terminal 才能参与其自身的执行终态投影。
- [x] 对拒绝/取消/撤权用真实工具入口断言 executor 0 次；对执行后 checkpoint 不确定断言 executor 不重跑且 session fence 持续。
- [x] terminal 重复投递/恢复不会产生第二个 terminal、第二次工具副作用或错误成功缓存。
- [x] `delivery_uncertain`、`pending`、`failed-degraded` 不产生 delivered 时间；只有可确认送达时才有 delivered 时间。

**验收命令**

```bash
npx vitest run electron/runtime/terminalOutcome.test.ts electron/turnRuntime.test.ts electron/toolChatLoop.safetyReject.test.ts electron/driver/deliveryHub.test.ts electron/butler/butlerInvoker.test.ts electron/runtime/hostedTurnHandoff.test.ts electron/runtime/sessionTranscriptStartup.test.ts
npx tsc -p tsconfig.electron.json --noEmit
```

### WP3：History、重试与重启恢复使用同一上下文边界

**任务**

- [x] 把失败回复重试、显式继续输入、accepted input 重启恢复、Transcript checkpoint 恢复分别定义为上下文来源；同一恢复入口内不可同时猜测 DB message sequence、History stream 和 API request 内容。
- [x] 对 retry context 定义返回契约：目标失败 assistant、原始 user message、全部同 user 的 failed assistant IDs、历史边界及附件/多模态语义。`ChatView` 仅提交解析结果，不重复推导失败消息集合。
- [x] 将 failed assistant 集合的关联优先级固定为持久 turn 的 `user_message_id`；仅旧数据没有因果关联时使用受限 fallback，并确保 fallback 不跨越下一条已接受 user/queued turn。
- [x] accepted input 恢复时通过 message ID、session ID、role 和 fingerprint 核验持久消息；API 消息的时间戳等存储元数据不参与内容相等判断。相同文本有多次出现时必须匹配正确 occurrence，不得只按文本任意选择。
- [x] 最新 History stream 不可用、terminal 缺失、checkpoint 不匹配时保持 fail closed，并记录可定位的 stage/reason；不得静默退回旧 transcript 或将系统提示词存入会话 checkpoint。
- [x] 校验压缩前后失败恢复：失败 turn 使用正确的已提交基线和明确策略，不丢此前成功轮次，也不混入失败轮部分 assistant/tool 输出。

**验收测试**

- [x] 三次以上失败后点击重试，请求保留先前已提交对话和原 user input，但不含任何失败 assistant placeholder；API context 完整消息序列及 turn exclusion 持久化/重载有断言。
- [x] 成功轮后失败、失败后继续；失败时发生预请求压缩；进程在 accepted input 后重启；每种情况下后续 turn 只看到策略规定的内容。
- [x] 相同 user 文本在历史中重复、DB timestamp 存在而 API timestamp 缺失、旧数据没有 persisted turn 三种输入都覆盖正确匹配/拒绝行为。
- [x] system 指令不进入 transcript/checkpoint；不完整或歧义 History 不可回退到较旧成功流。

**验收命令**

```bash
npx vitest run electron/database/operations.test.ts electron/runtime/hostedTurnHandoff.test.ts electron/runtime/sessionHistoryCutover.test.ts electron/runtime/sessionTranscriptStartup.test.ts electron/runtime/acceptedTurnContext.test.ts
npx tsc -p tsconfig.electron.json --noEmit
npx tsc -p tsconfig.renderer.json --noEmit
```

### WP4：审批、取消、撤权和工具执行共享同一 turn 所有权

**任务**

- [x] 从 confirmation 卡创建到响应消费，确认记录必须绑定 session/turn/execution；跨会话同 requestId 不可消费另一 turn 的确认。
- [x] 确认执行按钮展示期间，取消操作应能覆盖“批准后、运行租约登记前”和工具开始事件异步提交期间的边界；执行器 dispatch 前再次校验 abort/revocation。
- [x] 拒绝审批、超时、撤权、用户取消分别走统一的“工具未执行”结算路径；拒绝不得以 `llm.error` 伪装成模型失败，也不得漏写工具未执行事实。
- [x] 已进入执行器后的取消按既有工具副作用语义结算；不能将已执行/结果未知误记为未执行，也不能因 turn 结束清除其他 session/turn 的 guard。
- [x] 审计旧取消注册表、SDK 当前执行取消端口和兼容转发路径：保留正在用的路径，移除旧路径前必须先有覆盖所有调用者的证明。

**验收测试**

- [x] 对 shell/script 审批的 approve、reject、timeout、取消四路，断言工具 executor 次数、History tool result、turn terminal 与确认卡最终状态。
- [x] 使用可控 Promise 暂停在确认提交、租约登记、工具开始事件提交、executor dispatch 四个点，逐点注入 cancel/revoke；未派发的点 executor 均为 0。
- [x] 两会话共享 requestId 时，确认、撤权和取消 A 均不改变 B 的状态；确认卡只在所属会话投影。
- [x] 每个失败回归先证明旧代码 RED，再在修复后 GREEN；测试不可只 mock 被调用函数而未检查副作用和持久终态。

**验收命令**

```bash
npx vitest run electron/confirmation/approvalAgent.test.ts electron/confirmation/agentSdkConfirmationPort.test.ts electron/chatCancelRegistry.test.ts electron/toolRevocationRegistry.test.ts electron/toolChatLoop.safetyReject.test.ts electron/tools/permitBoundCoordinatorDispatch.test.ts
npx tsc -p tsconfig.electron.json --noEmit
```

### WP5：Driver 投递与执行结果对账

**任务**

- [x] 核实入口执行结果、Butler run 和 Driver journal 对同一 turn/delivery 的关联字段；一个 turn 的投递更新不得误改另一 run。
- [x] 确保所有状态转换通过 journal 的持久转换接口，不在 adapter、Butler、Driver 各自维护可相互覆盖的 deferred 状态。
- [x] 对 supersede、overflow、driver re-register、reachability flush、TTL、外部发送后本地确认失败和重启恢复路径逐项核验终态回写；被取代项不能永久 `pending`。
- [x] 多目标状态投影保持逐目标事实；部分送达、部分 deferred/uncertain 时不能将整个结果误记成功或失败。
- [x] 不自动重试 `delivery_uncertain`，除非现有远端契约可以幂等确认；不增加重发入口或送达状态页面。

**验收测试**

- [x] 取代、溢出、driver 重注册的旧 delivery 在 journal、run 投影和重启读取中都有确定终态，不残留 pending。
- [x] 两个 turn 共用 requestId 或 supersedeKey 作用域不同，状态更新不会串 run/会话/目标。
- [x] 模拟远端已接收但本地确认失败，重启后不重复外发；journal 与现有 run 投影保留 uncertain/既有恢复语义。
- [x] 多目标至少覆盖全部 delivered、混合 delivered+deferred、混合 delivered+uncertain 三种组合。

**验收命令**

```bash
npx vitest run electron/driver/deliveryHub.test.ts electron/butler/butlerDelivery.test.ts electron/butler/taskStore.test.ts electron/butler/butlerInvoker.test.ts
npx tsc -p tsconfig.electron.json --noEmit
```

### WP6：状态与身份兼容路径收口

**任务**

- [x] 搜索 `requestId` fallback、sessionId 代替执行 ID、进程内结果缓存、旧取消注册表、重复 terminal mapper、History legacy stream 选择等兼容分支。
- [x] 对每个分支记录数据来源、触发条件、可观测原因码、失败关闭行为和覆盖它的迁移/兼容测试。
- [x] 只删除能够通过本机测试证明无新数据依赖、且现有持久数据迁移/读取行为仍有测试保护的死分支；依赖部署后零命中数据的兼容逻辑保留，不把生产观测列为本计划本机必达项。
- [x] 为关键 fallback 加结构化诊断或测试可观察信号；禁止记录消息正文、system prompt、凭据或工具参数敏感内容。

**验收证据**

- [x] 搜索结果中每条命中都被归类为当前 canonical 路径、必要 legacy adapter、可删除死代码或经测试拒绝的无效路径。
- [x] 所有保留的 legacy adapter 都有正向兼容和错误归属/跨 session 拒绝测试。
- [x] 不因追求“代码唯一”删除尚无生产零命中证据的旧 History 读取能力。

**验收命令**

```bash
rg -n "requestId.*turnId|turnId.*requestId|invocationId|register.*Cancel|legacy|fallback" electron src/shared packages/agent-sdk/src
npm run check:tool-result-invariants
```

### WP7：全量本机验收与计划结项

**任务**

- [x] 先运行 WP0–WP6 的定向测试；失败时保留首个失败用例、期望/实际值和相关栈，不用全量成功覆盖定向失败。
- [x] 完成本机所有项目验证：全量测试、Electron/renderer/shared 类型检查、Electron 构建、i18n 检查、工具结果不变量检查及 `git diff --check`。
- [x] 对新增测试做反向确认：每个修复至少有一个测试在旧逻辑下失败的证据（本计划实施记录、测试名与失败断言），并证明断言覆盖持久状态/最终请求/实际副作用。
- [x] 更新本计划实施记录：每任务列出文件范围、RED/GREEN 回归、执行命令与结果；未满足条件的项保持未完成并说明阻碍。
- [x] 最后核对变更范围，不包含本计划无关的用户文档、队列任务栏、UI 功能或生成产物。

**本机验收命令**

```bash
npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1
npm run typecheck:renderer
npm run typecheck:shared
npx tsc -p tsconfig.electron.json --noEmit
npm run build:electron
npm run i18n:check
npm run check:tool-result-invariants
git diff --check
```

只有全部本机命令通过、WP0–WP6 的本机验收证据齐全、无遗留未归类身份/状态路径时，才能标记计划的本机范围完成。生产零命中观测、真实 IM 服务端演练及 Windows 专属验证不要求在本计划本机迭代中执行，也不能伪称已完成。

## 5. 推荐实施顺序与依赖

```text
WP0 基线盘点
  ├─ WP1 身份契约 ─┬─ WP2 终态转换 ── WP4 审批/取消
  │                ├─ WP3 History/重试/恢复
  │                └─ WP5 Driver 投递对账
  └──────────────────── WP6 兼容路径审计
                         ↓
                    WP7 本机验收
```

- WP0 先完成，用盘点结果缩小实施范围，避免重做既有 `AcceptedTurn`、transcript claim 或 delivery journal。
- WP1 是身份边界，WP2 是终态语义；WP3–WP5 分别修复并验证三个主要状态消费者。
- WP6 只能在 canonical 路径与调用者矩阵清楚后执行；不能为了缩短计划而提前删兼容逻辑。
- 每个任务以独立小提交推进；一次提交只覆盖一个工作包内紧密相关的修复和回归。

## 6. 风险及处理

| 风险 | 处理与完成判据 |
| --- | --- |
| 已有模块保存重复但含义不同的状态 | 先标明事实与投影来源；只统一状态转换入口，不强行合并不同生命周期的数据表。 |
| 统一身份时破坏旧会话 | 新路径一律使用 canonical turn；旧数据经显式 legacy adapter；为两者分别建正反向回归。 |
| 失败轮上下文误删或重复 | 使用用户消息 ID/turn 因果关系确定历史范围；测试最终发送给 provider 的完整消息序列。 |
| 恢复逻辑自动重放有副作用操作 | 工具执行后遇到不确定状态保持 fence/uncertain；恢复只对账，不重新执行模型或工具。 |
| 投递状态被误认为外部实际送达 | 无远端幂等确认时保留 `delivery_uncertain`，不声称 exactly-once，不自动重复发送。 |
| 计划范围扩成新产品功能 | 只修改现有持久事实、状态映射、内部诊断和回归测试；任何新 UI、设置或用户操作均不纳入。 |

## 7. 实施记录

### WP0 基线盘点（2026-09-30）

#### 入口身份矩阵

| 入口 | 身份生成与接受 | Runtime/History 传递 | 持久化与查找 | 现有证据 / 缺口 |
| --- | --- | --- | --- | --- |
| Desktop | `TurnRuntime.prepare` 在 `electron/ipc/agentProtocolIpc.ts` 建立 `turnId`、`requestId`、`sessionId` 和 user message；`electron/claudeStreamHandlers.ts` 用 `loadAuthoritativeTurnContext` 校验 turn/session/request/start token，再创建并持久化 `AcceptedTurn`。 | `assembleInvocation` 收到 `acceptedTurn`；Hosted History invocation 与 turn 均以 `turnId` 为 canonical key。 | `turns.turn_id` 是执行主键；`turns.request_id` 只在 `(sessionId, requestId)` 的入口幂等查询中使用；AcceptedTurn 记录在 `accepted_turn_contexts`。 | `electron/claudeStreamHandlers.hostedIntegration.test.ts` 覆盖真实 Desktop 到 Hosted History/terminal。通过；无 WP0 缺口。 |
| Feishu | `electron/feishu/remoteCommandRouter.ts` 从 `TurnRuntime.prepare` 获得 `prepared.turnId`，并通过 `createAcceptedTurnFromPrepared` 持久接受。 | `runFeishuRemoteAgent` 收到与 prepared turn 完全一致的 `AcceptedTurn`；router 使用同一个 turnId 执行及写终态。 | TurnRuntime 按 `turnId` 更新；入口重放按 `(sessionId, requestId)` 解析；History 新流按 `turnId`。 | `electron/feishu/remoteCommandRouter.test.ts` 使用真实 SQLite TurnRuntime，断言 user/session/request/turn 归属及 completed outcome；`electron/remote/imRemoteAgent.test.ts` 覆盖 Hosted History terminal。通过。 |
| WeChat | `electron/wechat/weChatCommandRouter.ts` 使用 prepared turn 并调用 `createAcceptedTurnFromPrepared`。 | `runWeChatRemoteAgent` 收到与 prepared turn 完全一致的 `AcceptedTurn`；router 使用同一个 turnId 执行及写终态。 | 与 Feishu 相同：TurnRuntime 以 `turnId` 写终态，History 新流以 `turnId` 为键；外部 requestId 只用于路由幂等。 | `electron/wechat/weChatCommandRouter.test.ts` 使用真实 SQLite TurnRuntime，断言 user/session/request/turn 归属及 completed outcome；`electron/wechat/weChatRemoteAgent.test.ts` 覆盖 Hosted History terminal。通过。 |
| Butler | `electron/butler/butlerInvoker.ts` 创建任务会话后由 `TurnRuntime.prepare` 生成身份，再接受 AcceptedTurn。 | AcceptedTurn 传入 `runButlerModelTurn`，Hosted History 和 projection 由 accepted turn 的 turnId 归属。 | `turns`、History、transcript 以 turnId 关联；Automation task run 另有 `runId`，delivery 以 deliveryId/target 关联，不用 requestId 替代 runId。 | `electron/butler/butlerInvoker.test.ts` 覆盖 AcceptedTurn、History terminal 和 run/delivery 投影。通过。 |
| Approval | `electron/confirmation/approvalAgent.ts` 为每次内部审批推理创建 `(turnId=requestId, sessionId, currentUserMessageId)` 并先写 AcceptedTurn；这是独立审批 turn，不能与触发它的父 turn 混为一谈。 | `assembleInvocation` 与 Hosted handoff 接收同一 AcceptedTurn；超时取消按 accepted turnId 发出。 | AcceptedTurn/History/transcript 使用内部 turnId；approval confirmation/tool call identity 由 SDK call/confirmationId 持有。 | `electron/confirmation/approvalAgent.test.ts` 覆盖接受、Hosted History terminal、取消和 transcript。通过。 |

#### 状态事实与投影矩阵

| 状态对象 | 权威事实 / 写入者 | 消费者和用途 | 证据 / 边界 |
| --- | --- | --- | --- |
| Canonical execution terminal | Agent SDK History 中 `invocation-completed`、`invocation-failed`、`invocation-interrupted`；转换由 `electron/runtime/terminalOutcome.ts` 解码。 | Hosted transcript、Turn coordinator recovery 和状态投影读取其实际 History event；不能由 claim/checkpoint 推造。 | `packages/agent-sdk/src/history.ts` 验证事件状态；`electron/runtime/terminalOutcome.test.ts`、`electron/runtime/hostedTurnHandoff.test.ts`、`electron/turnCoordinatorStorage.test.ts`。本轮发现解码器对非法 `status=commit_uncertain` payload 曾退化为 `failed`，WP2 已有 RED/GREEN 回归。 |
| TurnRuntime turn | `turns` 行和其 user/assistant message；通过 `TurnRuntime` 与 `electron/turnCoordinatorStorage.ts` 状态迁移。终态只投影到相应 turn，不覆盖其他 session/turn。 | Desktop/IM 当前执行事件、renderer 状态及重启时残留恢复。 | `electron/turnRuntime.test.ts`、`electron/turnCoordinatorStorage.test.ts`、`electron/remote/turnExecutionAdapter.test.ts`。执行身份主键是 `turnId`；`requestId` 仅按 session 查找或作为旧调用入口标识。 |
| Session Transcript / claim | `session_transcript_entries` 是逐 turn 提交历史；checkpoint 与 `session_execution_claims/queue` 的 `ready`、`commit_uncertain`、`blocked` 是 session 提交/恢复状态。 | 后续 Hosted request 构建读取 checkpoint；startup reconciler 对账；不从 uncertain 状态推导执行 terminal，也不自动重放副作用。 | `electron/database/sessionTranscript.ts`、`electron/runtime/hostedTurnHandoff.ts`；测试 `electron/runtime/sessionTranscriptStartup.test.ts`、`electron/runtime/hostedTurnHandoff.test.ts`。 |
| History 与 renderer 投影 | History 是执行事件事实；session event/turn message 是渲染消费投影，不是新的执行授权事实。 | `TurnRuntime` 发布已归属 turn 的消息/步骤事件；启动修复从 canonical History 补投影。 | `electron/turnRuntime.test.ts`、`electron/claudeStreamHandlers.hostedIntegration.test.ts`、`electron/runtime/sqliteAgentHistory.test.ts`。投影丢失不得触发模型/工具重放。 |
| Butler run | `automation_task_runs` 保存任务运行结果；写入者是 Butler invoker/task store。 | 结果摘要关联当前 runId；投递状态只能从 Driver delivery journal 对账。 | `electron/butler/butlerInvoker.test.ts`、`electron/butler/taskStore.test.ts`。`deliveredAt` 只允许在可确认的 delivered 状态产生。 |
| Driver delivery | `driver_deliveries(deliveryId,target)` 与 `driver_delivery_events` 是逐目标投递事实；状态由 `SqliteDeliveryJournal` 转换。 | `DeliveryHub` 恢复/flush；Butler task run 由 journal 聚合逐目标状态。`delivering` 重启转 uncertain，不能自动再次外发。 | `electron/driver/sqliteDeliveryJournal.ts`、`electron/driver/deliveryHub.ts`、`electron/butler/taskStore.ts`；回归位于 `electron/driver/deliveryHub.test.ts`、`electron/butler/butlerDelivery.test.ts`、`electron/butler/taskStore.test.ts`。 |
| Retry context | `turns.user_message_id` 是新数据的因果关联；无持久关联的旧数据仅回退到 failed assistant 前最近的、未被后续 accepted/queued turn 越过的 user。 | retry API 将所有关联失败 assistant IDs 交给 context builder；AcceptedTurn message resolver 从持久 turn exclusion 还原模型上下文。 | `electron/database/operations.ts`、`src/renderer/components/Chat/ChatView.tsx`、`electron/runtime/acceptedTurnContext.ts`；测试 `electron/database/operations.test.ts`、`electron/turnCoordinatorStorage.test.ts`、`src/renderer/services/apiContextQueueAndRetry.test.ts`。多次失败 ID、最终 API context 消息序列、turn exclusion 持久化均有断言；跨层类型补齐 `RetryContextTarget.excludeMessageIds`。 |

#### 初始盘点缺口（已由后续工作包关闭）

- WP1：Feishu/WeChat 真实 SQLite TurnRuntime、AcceptedTurn 身份链以及 CallAdmission/Approval 同 ID 隔离已覆盖。
- WP2：非法 History terminal 解码修复及 History/Transcript/Turn 投影状态矩阵已验证。
- WP3：多次失败 retry、重复 accepted 文本、timestamp 元数据、压缩失败与 system checkpoint 边界已验证。
- WP4：审批/取消/撤权及异步 History/tool dispatch 暂停点已与 executor 副作用和终态回写断言对应。
- WP5：supersede、overflow、重注册、TTL、重启和 Butler run 投影均有确定状态测试。
- WP6：所有身份和状态兼容命中已逐类登记于“WP6 兼容与身份搜索分类”；保留的旧 History 路径仍有 session/turn 所有权验证。

### WP1–WP6 实施结果（2026-09-30）

| 工作包 | 状态 | 完成证据 |
| --- | --- | --- |
| WP0 | 完成 | 基线矩阵五入口/七类状态；初始定向基线 19 文件、430 项通过。 |
| WP1 | 完成 | `electron/feishu/remoteCommandRouter.test.ts`、`electron/wechat/weChatCommandRouter.test.ts` 新增真实 SQLite TurnRuntime 路由回归；`electron/runtime/callAdmission.test.ts` 共享 requestId 跨会话取消 RED：调用不存在的 turn API；GREEN 后只移除指定 turn；`electron/appIpc.file.test.ts` 锁定 IPC 通过 turnId 调用；`electron/confirmation/agentChannel.test.ts` 共享 requestId 跨会话审批配额 RED：B 被 `parent-limit` 拒绝；GREEN 改以 turnId 分组。`electron/runtime/invocationAssembler.test.ts` 锁定 turnId 透传。 |
| WP2 | 完成 | `electron/runtime/terminalOutcome.test.ts` 新增非法 `invocation-failed/status=commit_uncertain` payload 必须拒绝解码；旧解码 RED 返回 `failed`，收紧 decoder 后 GREEN。修复仅涉及终态解码，不把 commit 状态并入 History 终态。 |
| WP3 | 完成 | `electron/runtime/hostedTurnHandoff.test.ts` 重复文本 accepted input 回归在旧按文本/时间戳选 occurrence 时 RED（`Canonical session History could not safely provide the Hosted transcript`）；按 AcceptedTurn 当前 user occurrence 反向匹配后 GREEN。三次 failed attempt retry context 断言排除所有失败 assistant，保留此前历史与目标 user；压缩失败、system 不入 checkpoint、旧数据受限 fallback 均有现存回归。 |
| WP4 | 完成 | `packages/agent-sdk/test/turn.test.ts` 在 `tool-call-started` History append Promise 阻塞时发 cancel：旧行为 executor 为 0 但缺少 `tool-call-not-dispatched`（RED）；修复恢复未派发状态并补齐 `REQUEST_CANCELLED` terminal 事实后 GREEN。审批提交期间取消、获批后租约恢复、撤权/recheck、dispatch 后未知结果分别由 SDK、`imRemoteAgent` 与 Approval 测试覆盖。 |
| WP5 | 完成 | `electron/driver/deliveryHub.test.ts` 覆盖 supersede、overflow、重注册、TTL、外部已接收但本地 ack 失败、重启及多目标；`electron/butler/taskStore.test.ts` 和 `butlerDelivery.test.ts` 覆盖 run 投影、`deliveredAt` 与目标分组合并。WP5 四文件定向回归通过。 |
| WP6 | 完成 | 归类见下表；唯一需要修复的跨会话路径为桌面 CallAdmission IPC 按 requestId 取消等待项，已改为 turnId。必要的旧 requestId History 读取保留且受 session owner 与 turnId 验证。 |
| WP7 | 完成 | WP1–WP6 扩展定向测试 28 文件 758 项通过；远端 router 单独 24 项通过；全量 802 文件通过、1 文件跳过，7,061 项通过、106 项跳过；四个类型边界、Electron 构建、i18n、tool-result 不变量和 `git diff --check` 全通过。平台专属 Windows 与真实 IM 服务端步骤按本计划定义不属于本机完成条件。 |

#### WP6 兼容与身份搜索分类

| 命中 | 分类/触发条件 | 保护证据 |
| --- | --- | --- |
| `electron/remote/imRemoteAgent.ts` 的 `args.turnId ?? requestId` 与 `acceptedTurn?.turnId ?? args.turnId ?? requestId` | legacy adapter：直接调用旧远端 Agent API 且未提供 AcceptedTurn/turnId 时，以旧 requestId 兼容 History；生产 Feishu/WeChat router 均传 prepared turnId 与 AcceptedTurn。新路径先验证 AcceptedTurn 与 session/用户身份，不匹配 fail closed。 | `electron/remote/imRemoteAgent.test.ts` AcceptedTurn 匹配/错配及 legacy History 测试；Feishu/WeChat router 测试。 |
| `turnCoordinatorStorage.ts` 中按 `(sessionId, requestId)` 查 turns | canonical 入口幂等查询，不作为运行中执行所有权键；数据库唯一约束与 intent fingerprint 阻止同会话重用不兼容请求。 | `electron/turnCoordinatorStorage.test.ts` 重启/幂等；`src/shared/turnCoordinator.test.ts` intent 冲突和重复 turn。 |
| `turnCoordinatorStorage.ts` 的 History `turnId` 优先、`requestId` 回退 | 必要 legacy adapter：仅在 session-owned History 列表中没有 canonical turn stream 时尝试旧 requestId stream；terminal 还须匹配当前 turnId、session owner。不得回退到其他 session 或任意旧 stream。 | `electron/turnCoordinatorStorage.test.ts` canonical 与 legacy recovery；`electron/runtime/sqliteAgentHistory.test.ts` 未知 owner 不进入 session index；跨 session History 回归。 |
| `executeRemoteTurn` 的 `completedResults` 进程内缓存 | canonical turn 结果重放缓存，以 `turnId`（不是 requestId）分区；DB terminal 可恢复时不重新运行 provider。 | `electron/remote/turnExecutionAdapter.test.ts` 同 Runtime 跨 session 共用 requestId、结果隔离、重试不执行 provider。 |
| `CallAdmissionGate.cancel(requestId)` | 必要 legacy/嵌套审批取消接口；桌面 turn IPC 改用新增 `cancelByTurnId(turnId)`。两者分离，避免 turn 的取消误删其他会话同 requestId waiter。 | `electron/runtime/callAdmission.test.ts` 共享 ID 取消 GREEN；`electron/confirmation/agentChannel.test.ts` 内层 approval waiter cancel。 |
| `AgentChannel` 的审批内层 requestId 与 parent quota | 内层 admission requestId 供确认执行追踪/取消；父任务并发分组现优先使用 `turnId`，旧调用缺 turnId 时回退 requestId。 | `electron/runtime/invocationAssembler.test.ts` turnId 透传；`electron/confirmation/agentChannel.test.ts` 跨会话同 requestId 配额隔离与队列取消。 |
| `chatCancelRegistry` / SDK Runtime `signalChatCancel` | 当前 Hosted SDK 取消端口；主进程 TurnRuntime 与远端租约均按 canonical turn/executionId 发信号，注册发生在 tool loop 当前执行入口。不是未接线的旧取消表。 | `packages/agent-sdk/test/turn.test.ts` 与 `electron/remote/imRemoteAgent.test.ts` cancel/revocation dispatch 回归。 |
| `ApprovalAdmission.cancel(innerRequestId)` waiter 查找 | 当前审批容量池取消只匹配 AgentChannel 生成的内层 requestId；生成器有进程级递增 invocation 序列，且每个 AgentChannel 的 inflight 按内层 ID 隔离。已接受 turnId 用于 parentTask 配额作用域。 | `electron/confirmation/agentChannel.test.ts` 并发/排队取消、跨 turn 配额隔离。 |

#### 定向门禁记录

- `npx vitest run electron/runtime/acceptedTurnContext.test.ts electron/runtime/invocationAssembler.test.ts electron/remote/turnExecutionAdapter.test.ts electron/confirmation/approvalAgent.test.ts electron/runtime/terminalOutcome.test.ts electron/turnRuntime.test.ts electron/toolChatLoop.safetyReject.test.ts electron/driver/deliveryHub.test.ts electron/butler/butlerInvoker.test.ts electron/runtime/hostedTurnHandoff.test.ts electron/runtime/sessionTranscriptStartup.test.ts electron/database/operations.test.ts electron/runtime/sessionHistoryCutover.test.ts electron/confirmation/agentSdkConfirmationPort.test.ts electron/chatCancelRegistry.test.ts electron/toolRevocationRegistry.test.ts electron/tools/permitBoundCoordinatorDispatch.test.ts electron/butler/butlerDelivery.test.ts electron/butler/taskStore.test.ts` — 19 files, 431 tests passed。
- `npx vitest run electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts` — 2 files, 24 tests passed。
- `npx vitest run electron/appIpc.file.test.ts -t "desktop cancel IPC delegates"` — 1 test passed; desktop cancel IPC forwards the canonical turn ID to CallAdmissionGate.
- 新增 TDD RED/GREEN 定向用例：`electron/runtime/callAdmission.test.ts` 共享 requestId 的 turn 专属取消；`electron/confirmation/agentChannel.test.ts` 两个共享 requestId 的 turn 独立占用审批配额；`packages/agent-sdk/test/turn.test.ts` 工具开始 History 异步提交期间取消；`electron/runtime/hostedTurnHandoff.test.ts` 重复文本 accepted occurrence 恢复；`electron/runtime/terminalOutcome.test.ts` 非法 commit 状态不得映射为执行 failed。

#### WP7 全量本机验收

| 命令 | 结果 |
| --- | --- |
| `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` | 802 test files passed, 1 skipped；7,061 tests passed, 106 skipped。 |
| `npm run typecheck:shared` | 通过。 |
| `npm run typecheck:renderer` | 通过。 |
| `npx tsc -p tsconfig.electron.json --noEmit` | 通过。 |
| `npm run typecheck:agent-sdk` | 通过。 |
| `npm run build:electron` | 通过；runtime closure 检查通过。 |
| `npm run i18n:check` | 通过（既有扫描统计：1,736 hardcoded Chinese occurrences，含 source/test；门禁未失败）。 |
| `npm run check:tool-result-invariants` | 27 files，0 violations。脚本重写的扫描报告已恢复，未纳入变更。 |
| `git diff --check` | 通过。 |

RED/GREEN 记录：跨层 retry 类型首次 Electron/renderer 检查出现 `TS2339: excludeMessageIds does not exist on RetryContextTarget`，补齐共享返回类型后通过；SDK `turn.test.ts` 新回归第一次 agent-sdk 类型检查出现两处 `TS18046: event.payload is unknown`，将断言按公开 History payload 类型缩窄后通过。它们是测试/契约的编译 RED，不代表运行时失败。

| 工作包 | 状态 | 完成证据 |
| --- | --- | --- |
| WP0 | 完成 | 矩阵已列出五入口身份、各持久状态的事实来源与测试证据；定向基线 19 个文件、430 项通过；六项具体缺口分别派到 WP1–WP6。 |
| WP1 | 进行中 | Feishu/WeChat command router→AcceptedTurn→canonical History terminal 同链覆盖缺口已定位。 |
| WP2 | 进行中 | 非法 `commit_uncertain` History payload 原先会解码为 `failed`；RED 断言复现、解码收紧后 115 项定向测试和 Electron 类型检查通过。 |
| WP3 | 部分已有实现，待按本计划核验 | retry/history 定向测试及实际请求序列断言待记录 |
| WP4 | 部分已有实现，待按本计划核验 | 审批/取消边界矩阵待核验 |
| WP5 | 部分已有实现，待按本计划核验 | Driver/run 投影完整任务表待核验 |
| WP6 | 未开始 | |
| WP7 | 未开始 | |
