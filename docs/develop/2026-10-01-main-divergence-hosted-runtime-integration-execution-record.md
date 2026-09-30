# 本地 main 与云端 main 分叉接入实施记录

对应计划：[本地 main 与云端 main 分叉接入计划](2026-10-01-main-divergence-hosted-runtime-integration-plan.md)

## 阶段 0：冻结基线与差异清单

### 基线命令与结果

执行时间：2026-10-01（Asia/Shanghai）

```text
$ git status --short --branch
## main...origin/main [ahead 33, behind 46]
?? docs/develop/2026-10-01-main-divergence-hosted-runtime-integration-plan.md

$ git rev-parse HEAD
60dcc36eda41b8e18313aebfb8f39bb683f24e67

$ git rev-parse origin/main
8dad02848c44692bafa7f61271bc6e3d6f406216

$ git merge-base HEAD origin/main
2c2611c645d0c50fa9c3a46b025a987a370ef57c

$ git rev-list --left-right --count origin/main...HEAD
46  33
```

分支核对：当前分支为 `main`；`backup/main-before-origin-merge-20261001` 指向同一基线 HEAD。阶段 0 未 fetch 或改变提交图。没有预先存在的已跟踪工作区修改；上面的计划文件是本轮任务输入，后续新增的实施记录也是任务产物，记录中的“干净”均指除此任务文档外没有未审阅的用户改动。

### 六层取消身份与信号链路

| 边界 | 当前身份/信号来源 | 现状与测试覆盖状态 |
|---|---|---|
| Renderer：`ChatView.tsx` → `chatRunnerService.abortSessionRun` | 组件从当前 `sessionId` 读取 `runningSessions[sessionId].turnId` 并调用 `chatCancelTurn(turnId)`；service 同步清本会话 waiter/live/running 状态。requestId 仅用于本地 unregister 清理。 | 已有通用运行态测试；计划要求新增/核对共享 requestId 隔离，待阶段 3 判定。 |
| Main：`electron/toolChatLoop.ts` → Hosted request | `executionId = turnId ?? requestId`；`registerChatCancel(executionId)` 获得 `chatSignal`；Hosted request 使用同一 signal。工具撤权另以 `requestId` 和 `executionId` 登记，需阶段 3 检查碰撞隔离。 | turn cancel IPC 路由需以阶段 3 测试验证；取消注册表底层仍按传入字符串索引。 |
| SDK：`packages/agent-sdk/src/turn.ts` | `input.request.signal` 在回合循环中用于 abort 检查；`AgentTurnCancelledError` 终态写为 `invocation-interrupted`，payload status 为 `cancelled`。 | 有既有取消测试；缺失 usage、iterator 直接 throw、重试/派工具禁止等分支待阶段 2 验收。 |
| Provider：`packages/agent-provider-pi-ai/src/index.ts` | 接收 `PreparedModelCall.request.signal`，以同一对象传给 pi-ai bridge options。 | 当前预取消、abort 后 `error`/`done: aborted` 会生成零值 usage；for-await 遇 iterator 直接 throw 时未按已 abort signal 转取消。阶段 1 待测试先行。 |
| History：`electron/runtime/sqliteAgentHistory.ts` / SDK history | SDK 的 cancelled 终态为 `invocation-interrupted` + `{status: 'cancelled'}`；`decodeTerminalOutcome` 映射为 `cancelled`。 | 映射代码已存在；无 usage 取消的持久化一致性待阶段 2 集成测试核验。 |
| 观测：`electron/agentLogger/types.ts` / `agentLogProjection.ts` | 当前 agent logger 事件联合和投影目标列表没有 `llm.cancel` / `turn.cancel` 事件；投影对目标事件字段使用 allowlist。 | 取消/失败可观测性及正文脱敏尚待阶段 4 测试判定；先不增加事件。 |

### 阶段 0 结论

- 基线值与计划头部记录一致：`main`、本地 HEAD `60dcc36e`、origin HEAD `8dad0284`、merge-base `2c2611c6`、ahead/behind `33/46`。
- 工作树除计划文档外没有修改；未改产品代码，未运行测试，未移动 `origin/main`。
- 已标明 renderer、main、SDK、provider、History、观测六个边界的身份/信号来源。待测缺口未预先标记完成。

## 阶段 1：provider 取消语义与 usage 事实

### TDD 红灯

在只修改 `packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts` 后运行：

```text
$ npx vitest run packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts
Exit code: 1
Test Files  1 failed (1)
Tests       5 failed | 19 passed (24)
```

失败覆盖了预取消伪造零 usage、`error` 缺 usage、`done: aborted` 缺 usage、上游 abort 后收尾没有 cancelled terminal、signal 已 abort 时 iterator 直接抛 `network reset` 被当普通失败。含显式零 usage 和真实正 usage 的两种取消记录，以及未取消时网络异常仍失败的对照已通过。

### 最小实现与绿灯

- 修改 `packages/agent-provider-pi-ai/src/index.ts`：取消前 dispatch 只输出 cancelled finish；`error` 与 `done: aborted` 仅在上游明确给出 input/output 数字 usage 时映射 usage，包含真实零值；同一 signal 已 abort 时 iterator 异常收敛为 cancelled；abort 后上游不再产生事件但结束迭代时补一个 cancelled finish。
- 未改变成功响应 usage、provider 普通网络失败、工具映射、归因或统计口径；取消仍传递同一个 `AbortSignal` 对象。

```text
$ npx vitest run packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts
Exit code: 0
Test Files  1 passed (1)
Tests       24 passed (24)
```

测试明确断言 bridge 调用次数、signal 对象身份、usage/finish chunk 序列、stall abort 收口，以及未 abort 的同一网络异常仍被抛出。阶段 2 将继续验证 SDK 对“cancelled 可无 usage、其他 finish 不可缺 usage”的消费契约；本阶段未运行全量测试、类型门禁或构建。

## 阶段 2：SDK turn 取消与 History 终态一致性

### TDD 红灯

先在 `modelStream.test.ts`、`turn.test.ts` 和 `hostedAgentTurnHost.test.ts` 写入新契约，再运行计划指定的五文件聚焦命令。初始结果：**3 项失败、231 项通过**。失败证据分别为：

- stream collector 因缺少 usage 在 cancelled finish 处抛 `InvalidModelStreamError`；
- SDK 把 signal abort 后 iterator 的 `network reset` 当作普通网络失败并继续进入 recovery 回调；
- Hosted Host 对真实零值 usage 的取消没有调用 usage recorder。

继续补充“取消时带未完成 tool-call proposal”和“取消前已 abort 不 dispatch provider”断言后，collector 还复现了 cancelled finish 被旧的 tool-call reason 一致性检查拒绝。添加 Hosted recorder 的请求/History 对照断言，明确检查 `request_usage`、`usage-updated`、step fact 和唯一 cancelled terminal。

### 最小实现与绿灯

- `packages/agent-sdk/src/model.ts` 将收集结果建模为区分联合：仅 `finish.reason === 'cancelled'` 可以没有 usage；stop、tool-calls、length 仍要求实际 usage。取消态允许带不完整 tool proposal，因为 turn 会整次丢弃该输出，不派发工具。
- `packages/agent-sdk/src/turn.ts` 在取消时不做 provider recovery；signal abort 后 iterator error 先走取消/timeout 分类；真实已观察 usage 以 `disposition: cancelled` 记一次，并把 usage sidecar 写入 `model-attempt-discarded`；没有 usage 时不调用 recorder。取消后写唯一 `invocation-interrupted/status=cancelled` terminal；已 abort 的 request 不进入工具执行。
- `hostedAgentTurnHost.test.ts` 通过实际 Host + fake provider + MemoryHistory + `createAgentSdkUsageRecorder` 验证缺 usage 时 recorder、`request_usage`、`usage-updated`、step fact、usage sidecar 均为零；明确零值 usage 时上述事实恰好一次，History terminal 能被 `decodeTerminalOutcome` 解码为 cancelled。
- 保留 timeout 映射：signal reason 为 timeout 时仍得到 `TURN_TIMED_OUT` 与 timeout History outcome。

```text
$ npx vitest run packages/agent-sdk/test/modelStream.test.ts packages/agent-sdk/test/turn.test.ts electron/runtime/hostedAgentTurnHost.test.ts electron/runtime/terminalOutcome.test.ts electron/runtime/sqliteAgentHistory.test.ts
Exit code: 0
Test Files  5 passed (5)
Tests       235 passed (235)

$ npm run typecheck:agent-sdk
Exit code: 0
```

期间首次 SDK 类型检查暴露了取消/非取消结果联合未在返回处充分收窄，以及 turn 后续访问可选 usage 的 TS 错误；收紧了 finish 子类型并增加非取消路径 usage 守卫，最终类型检查通过。取消竞态专测及 Hosted usage 侧断言另行重跑均通过。无取消后 recovery、重试或 tool executor 的断言；provider dispatch 恰好一次，History 只有一个 cancelled terminal。普通未取消 `network reset` 仍失败。

## 阶段 3：UI 停止动作与 turn-scoped IPC

### TDD 红灯与定向复现

- 为运行索引增加同一 `requestId` 被两个 session 使用的用例，并为 `abortSessionRun` 增加隔离断言。初次运行 `npx vitest run src/renderer/services/runRequestIndex.test.ts src/renderer/services/chatRunnerService.abort.test.ts` 时，索引仍错误返回 B，且缺少精确运行解析 API：**2 个文件失败**。
- `ChatView.abort.test.tsx` 通过临时恢复旧的组件直调 IPC 行为做对照：测试观察到 IPC 虽已调用，当前 session 的 running 状态仍残留，**1 项失败**。
- SDK 集成回归以两个 session、不同 turn、共享外部 `requestId` 和独立 `AbortSignal` 建立 A/B 审批 waiter；取消 A 后确认 B waiter 未被拒绝、B signal 未取消，批准 B 后 B 的工具和第二轮模型调用仍完成。另有 admission 测试验证取消 A 后排队的 B 可获准执行。

### 最小实现与绿灯

- `runRequestIndex` 将登记改为 `requestId -> sessionId -> registration`；仅一个 owner 时才允许旧式 request-only 解析，多 owner 时返回歧义；新增 session + request 精确解析及 session-scoped unregister，避免结束 A 时删掉 B 的映射。
- `finishSessionRun`、`abortSessionRun` 使用 session-scoped 清理。`ChatView` 的停止操作调用 `abortSessionRun(sessionId)`，由 service 同步清理本 session running/live/pending confirmation 状态，并用其 `turnId` 发出取消 IPC。
- 新增/扩展 service、组件、admission 和 SDK 跨层用例，检查共享 requestId 下 B 的审批、工具执行、模型后续轮次及 History completed 终态不受 A 取消影响。

```text
$ npx vitest run src/renderer/services/runRequestIndex.test.ts src/renderer/services/chatRunnerService.abort.test.ts
初始：2 个文件失败；实现后：2 个文件通过，5 项通过。

$ npx vitest run src/renderer/components/Chat/ChatView.abort.test.tsx
旧组件行为对照：1 项失败；改用 session service 后：1 项通过。

$ npx vitest run packages/agent-sdk/test/turn.test.ts -t "cancels only turn A when different sessions share requestId"
1 项通过。

$ npx vitest run electron/runtime/callAdmission.test.ts -t "shared requestId"
1 项通过。

$ npx vitest run src/renderer/services/chatRunnerService.abort.test.ts src/renderer/components/Chat/ChatView.abort.test.tsx electron/runtime/callAdmission.test.ts electron/runtime/hostedTurnHandoff.test.ts
Exit code: 0
Test Files  4 passed (4)
Tests       84 passed (84)
```

额外运行包含运行索引和完整 SDK turn 文件的聚焦组合：6 个文件、203 项通过。阶段 3 的取消对象按 session/turn 隔离；UI 的即时状态清理与主进程实际取消分别由 service/component 和 admission/SDK 测试验证。

## 阶段 4：取消审计隐私

检查取消终态的可诊断性时，保留现有 `invocation-interrupted/status=cancelled` canonical History 事实、`decodeTerminalOutcome` 的 cancelled 映射及 session `turn_end` 终态；阶段 2 Host 集成用例验证写入与解码一致。agent logger 没有单独 `llm.cancel` / `turn.cancel` 事件，但本次计划的区分需求可由已有 History/session 终态提供，新增一条只重复表达相同终态的日志不会增加必要诊断信息，因此不扩大事件 schema。

计划指定的投影/日志和 Host 用例已运行：

```text
$ npx vitest run electron/agentLogger/agentLogProjection.test.ts electron/agentLogger/agentLogger.test.ts electron/runtime/hostedAgentTurnHost.test.ts
Exit code: 0
Test Files  3 passed (3)
Tests       31 passed (31)
```

投影测试确认输出仍受 allowlist 控制；取消事实可从 canonical History 与 session `turn_end` 读取，无需新增重复的取消事件，也没有为诊断加入正文、prompt、工具输入或凭据字段。

## 阶段 5：全量兼容与静态门禁

### 门禁执行与失败修复

- `npm run typecheck:agent-sdk`、`npm run typecheck:agent-provider-pi-ai`、`npm run typecheck:renderer`、`npm run typecheck:shared` 均退出码 0。
- `npm run check:agent-sdk` 通过：SDK 入口闭包 21 个模块，无 electron/shared/renderer/node:sqlite 依赖；shared 不依赖 SDK；provider package closure 完整。
- 第一次 `npm test`：**803 个文件通过、1 个跳过；7075 项通过、106 项跳过、5 项失败**。5 项都在 `turnProjectionService.test.ts`，错误为 `turnDisplayToMessage` 对缺少 `activity` 的旧 display 快照调用 `.map()`（`src/shared/turnDisplayProtocol.ts:172`）。单文件重跑稳定得到同样 5 项失败；这些用例 fixture 明确没有新字段，属于协议兼容输入。
- 按 TDD 在 `turnDisplayProtocol.test.ts` 新增“旧 display 缺少 activity”用例。红灯：`npx vitest run src/shared/turnDisplayProtocol.test.ts -t "旧 display 缺少 activity"` 以同一 `Cannot read properties of undefined (reading 'map')` 失败。最小修复将转换改为 `(activity ?? []).map(...)`，没有改变当前协议输出。
- 共享协议回归 **10/10**、原失败 `turnProjectionService.test.ts` **23/23** 通过。

### 最终门禁结果

```text
$ npm test
Exit code: 0
Test Files  804 passed | 1 skipped (805)
Tests       7081 passed | 106 skipped (7187)

$ npm run typecheck:agent-sdk
Exit code: 0
$ npm run typecheck:agent-provider-pi-ai
Exit code: 0
$ npm run typecheck:renderer
Exit code: 0
$ npm run typecheck:shared
Exit code: 0
$ npm run check:agent-sdk
Exit code: 0
$ npm run build
Exit code: 0
```

build 仅报告已有动态 import 无法拆 chunk 和 chunk 超过 500 kB 的提示，无构建错误。构建生成的图标与 i18n 文件在 Git 状态核对中没有留下差异。排除功能关键符号扫描未命中本轮生产 diff；尚待阶段 6 合并后的全树扫描。

## 阶段 6：历史收敛、最终树审核与云端接受

### 审核及 PR 对齐证据口径

原本地 `main` 到 PR 最终 source 分支的 diff 只能用于定位差异，不能单独代表原有本地提交，也不能单独证明其中的准入改动进入了 PR。提交可能被合并、回退、重排或重写，导致这组 diff 与原提交内容不一一对应。核对本地准入内容时，以逐项准入记录为索引，结合 PR 最终 diff、云端合并后的 tree，以及必要的代码和测试证据逐项确认。另行审查 PR base 前进后新增的云端提交及其 tree 变化；只有确认差异均归属于已审核远端新增改动或完整进入云端的本地准入改动，才执行本地 `main` 对齐。

阶段 6 继续执行中：云端 fetch 后 SHA 仍为 `8dad02848c44692bafa7f61271bc6e3d6f406216`，分叉为 remote-only 46 / local-only 34。逐提交清单见计划 §2.1；已用 `git log --reverse --format='%H%x09%P%x09%s' <merge-base>..origin/main` 固定完整 SHA/父提交/主题，并对每个 SHA 导出文件变更。普通提交按其 commit tree diff 审核；4 个 merge commit（`6fad2cb6`、`98857144`、`a06c966c`、`c96acc2e`、`773e11d7`、`ac97b559`，共 6 个）按第一父 tree diff 审核，同时核对第二父及该分支子提交各自的处置行。初始 46 项中 6 个是 merge commit；其余普通提交与文件清单均和 §2.1 的唯一处置相符。最后的 `8dad0284` 同时触及策略注册与规则测试，继续按“排除”处理，不能只保留测试改动。

生命周期修复已以 `ae092513fc670c5e50655e1c22287903e32cd5c5` 提交。双亲 merge、最终树审查、推送/PR、云端接受和本地 main 对齐仍未完成。

### 双亲 merge 与文件准入清理

开始合并时 `git merge --no-ff --no-commit origin/main` 报告 8 个冲突文件：数据库 migration/schema 与测试 5 个、旧 `electron/toolChatLoop.ts` 1 个、两个已有本地取消测试的 add/add 2 个。数据库冲突保留本地 schema/迁移及测试；`toolChatLoop.ts` 保留 Hosted Runtime/agent-sdk 执行路径，取消语义由已通过阶段 1–5 的 SDK/provider/host 实现提供；add/add 保留本地 turn-scoped renderer 测试。没有将旧 tool loop 或远端归因迁移带入合并树。

无冲突改动按逐提交处置表处理：移除远端 v19 attribution schema/operations/query/API/UI/i18n/测试及新增归因需求文档；移除 grep 自动降级、fallback 专用测试、不可用提示分层和 dev rg 自动准备；移除脚本路径提取、安全规则档位、loose allow 和会话信任改动。原本地基线已有的同名 helper/行为保持不动，判断依据是相对本地 HEAD 的最终 tree diff。

适配准入的 grep 生命周期仅保留 ProcessSupervisor 有界树终止、forced settle、Mac 进程组启动、结构化 cancelled/timeout 终态，以及不带 pattern/cwd/path 的 `grep.terminate` allowlist 诊断；加入执行器对 `ctx.signal`（Hosted 当前 turn signal）的测试，不复制旧循环单独 `chatSignal` 字段。远端 logger `llm.cancel`/`turn.cancel` 不带入，因为现有 History/session terminal 已覆盖诊断。保留 `agentLogProjection` allowlist 去重。release commit 只准入 `package.json` 和 lockfile 的 `0.2.2` 版本号，不带其他依赖/脚本变化。

红灯：在临时恢复本地原有 SIGTERM-only `builtinExecutors.ts` 后，`npx vitest run electron/tools/grepAbortResponse.test.ts -t "T-A6"` 失败：返回值缺少 `terminated: forced`，注入的 ProcessKiller 未被消费。恢复有界 ProcessSupervisor 实现后，grep 终止、turn signal、ripgrep process、日志投影聚焦测试为 **7 文件 / 65 项通过**；Electron build 退出码 0。

### 最终合并树门禁

完成冲突及准入清理后，在完整 merge index/tree 上执行：

```text
$ npm test
Exit code: 0
Test Files  806 passed | 1 skipped (807)
Tests       7091 passed | 106 skipped (7197)

$ npm run typecheck:agent-sdk
Exit code: 0
$ npm run typecheck:agent-provider-pi-ai
Exit code: 0
$ npm run typecheck:renderer
Exit code: 0
$ npm run typecheck:shared
Exit code: 0
$ npm run check:agent-sdk
Exit code: 0
$ npm run build
Exit code: 0
```

build 只有已有的动态 import 与 chunk size 提示。最终代码符号扫描未命中云端新增的归因 schema/API/UI、`script-unmodeled-path-ask` loose 覆盖、grep fallback 自动路由或 dev rg prepare 入口；相对远端 HEAD 的文件清单可见被排除的新归因模块/测试及 fallback/dev prepare/script-path 文档为明确删除。当前 index 已通过 `git diff --cached --check`，没有未解决冲突。双亲 merge commit 尚未创建，推送/PR 与本地对齐尚未执行。

### 首次推送后的 CI 修复

普通 `git push origin main` 已将 merge commit `5debe7919d57dbf26835bbf5b4b715ff083d889c` 推到云端，fetch 确认当时 `main` 与 `origin/main` 同 SHA。Actions run `36757493758` 的 `test` job 随后在 `Run npm run typecheck:agent-core` 失败；当前 package scripts 已无此命令（本机复现明确输出 `npm error Missing script: "typecheck:agent-core"`），workflow 还引用不存在的 `check:agent-core`、`packages/agent-core/test/agentCore.test.ts` 和 `electron/toolChatLoop.inMemoryPorts.test.ts`。

更新 `.github/workflows/ci.yml` 使用当前 SDK 边界门禁，并换成现存的 `packages/agent-sdk/test/agentCore.test.ts`、`packages/agent-sdk/test/turn.test.ts`、`electron/runtime/hostedAgentTurnHost.test.ts`。本机验证：`typecheck:agent-sdk`、`check:agent-sdk` 均退出码 0；workflow 对应的聚焦 Vitest 为 3 文件 / 148 项通过。已触发第一次云端 run 的 job 终态仍需等完整 run 收敛；workflow 修复 commit 和第二次云端 CI 结果待完成。
