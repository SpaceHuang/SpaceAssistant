# 本地 main 与云端 main 分叉接入计划

日期：2026-10-01
基线：本地 `main` `60dcc36e`；`origin/main` `8dad0284`；共同祖先 `2c2611c6`。
分叉：本地领先 33 个提交，云端领先 46 个提交。
性质：待实施计划。按 TDD 分阶段接入并收敛 main 历史；最终以云端 main 接受本地修复为完成条件。每项均以本机可执行的测试和检查验收。本计划不要求 Windows 验证。

## 1. 目标与约束

解决本地 `main` 无法以非强制方式推送到云端的问题，并处理云端旧 `toolChatLoop` 与本地 Hosted Runtime/agent-sdk 重构之间的架构冲突：保留本地 Runtime 架构，将仍然需要的中断行为通过现有 SDK/provider/host 边界接入；逐条审核云端独有提交及依赖，合并后落实准入/排除清单；最终验证云端 `main` 已包含修复。

本轮是重构兼容和缺陷修复，不扩展产品能力。不得恢复云端旧执行循环来消除冲突；不得让用量归因界面、规则档位配置、grep 降级能力、脚本指纹信任等未准入能力留在最终树中。提交祖先关系与最终文件树是两项独立检查：云端提交历史必须成为本地祖先，但其每项改动只有列入准入清单后才能保留在最终树；被排除的改动须在 merge result 中显式还原/删除并验证。不能以“无冲突”替代行为验收。

## 2. 分叉范围与取舍

当前云端独有的 46 个提交大致分为以下主题。实施阶段 6 必须重新生成逐提交清单，确保这 46 项及其依赖逐项都有唯一处置结论；下表是当前基线的初始分类，不替代逐提交审核。

| 云端主题 | 本轮决定 | 理由/处理 |
|---|---|---|
| agent-sdk / Hosted Runtime 迁移 | 已在本地实现 | 保留本地实现；不以云端旧 `toolChatLoop.ts` 覆盖。 |
| 对话中止：请求级 AbortSignal、取消错误归类、UI 立即结束本地运行态 | 纳入行为对照与缺口修复 | 本地已在 Hosted 请求构造处传 `chatSignal`，SDK/provider 也有 signal 接口；先用跨边界测试判定行为是否完整，只补失败的环节。 |
| 中止审计事件 `llm.cancel` / `turn.cancel` | 纳入行为兼容；以本地测试后的最小实现为准 | 不盲目覆盖本地日志投影；不记录 prompt、响应正文、工具输入或凭据。若已有日志已足够区分，远端事件代码在最终树中不重复保留。 |
| Agent Token 用量内容归因、schema v19、新统计查询与构成 UI | 排除其产品行为 | 独立新统计能力，与本地 Runtime 生命周期修复无依赖。逐项还原其 shared module、DB schema/migration/operations、查询、IPC/preload、renderer、i18n、资源、测试和依赖；保留本地 SDK usage recorder 的既有契约。 |
| grep 中止/终止纪律 | 只准入聊天取消信号接线与子进程终止缺陷修复 | grep 自动降级、fallback JS、ripgrep dev 准备、分层 unavailable 文案排除；对准入的取消/终止修复保留对应现有工具路径及单测。 |
| `run_script` 路径提取、安全规则档位、信任记忆 | 本轮排除 | 这些属于独立脚本安全问题/策略和信任行为，虽有 bugfix 提交，也超出本次 Hosted Runtime 分叉收敛的限定范围；相关 extractor、IR、设置、策略、信任存储和测试均不带入。 |
| release、文档导入、Wiki 草稿等 | release 元数据保留，其余草稿排除 | 保留 `0.2.2` release 版本元数据；独立开发草案、知识文档、需求稿不自动带入。每项处置必须在 46 项提交清单中可查。 |

### 2.1 当前远端独有提交处置基线

下表对当前已知的 46 个 remote-only commits 逐项给出初始决定。`适配` 表示只保留该提交中标明的 lifecycle 行为，最终实现必须通过阶段 1–5 测试；提交其余内容仍按 `排除` 清单处理。阶段 6 fetch 后若远端有新提交，须追加同格式行。

| SHA | 提交主题（简写） | 初始处置 | 最终树要求 |
|---|---|---|---|
| `25bef9e7` | grep 方案基线文档 | 排除 | 不带入独立 grep 方案文档。 |
| `e9d58480` | dev 前置准备 rg | 排除 | 不带入 dev 脚本/平台下载逻辑。 |
| `7657c546` | grep 子进程终止纪律 | 适配 | 保留已有 grep 执行器的可靠取消/终止修复及 `electron/tools/ripgrepExecutorProcess.test.ts` 回归；不带 fallback 能力。 |
| `877900c1` | grep fallback JS 与自动降级 | 排除 | 不带 fallback 实现、自动路由、相关依赖/测试。 |
| `7a82e9f2` | rg 不可用提示分层 | 排除 | 不带新增提示和错误码。 |
| `1d4cab51` | grep 感知聊天取消 | 适配 | 保留当前会话取消 signal 的正确接线；以 `electron/tools/grepChatSignal.test.ts` 与共享 requestId 隔离用例验证。 |
| `189eabdd` | grep 关联文档同步 | 排除 | 不带独立文档状态更新。 |
| `7e520a73` | fallback 无效正则修复 | 排除 | 对应 fallback 整体不准入，不保留其专用路径。 |
| `6fad2cb6` | grep fallback 分支合并 | 适配 | merge commit 的 tree diff 只保留 `7657c546`、`1d4cab51` 已准入行为；不得带入 fallback 分支内容。 |
| `4bb8c0cb` | LLM 请求硬中断及取消分类 | 适配 | 将 request signal、abort/网络异常竞态和取消终态适配到 Hosted provider/SDK；不恢复旧循环。 |
| `440404c6` | renderer 停止即时清理 | 适配 | 只保留 `abortSessionRun` 与 turn-scoped IPC 的兼容行为和隔离测试。 |
| `7de673f3` | 取消审计事件 | 适配 | 仅当现有诊断不足时保留最小、脱敏的取消审计。 |
| `98857144` | 对话取消分支合并 | 适配 | merge tree 只保留上述取消接线的等价实现；检查完整 renderer/main diff。 |
| `81a797ea` | agent log 事件清单去重 | 保留 | 保留无重复 allowlist 条目及投影回归。 |
| `a06c966c` | log 去重分支合并 | 保留 | 保留与 `81a797ea` 等价的最终清理，不带旁支功能。 |
| `2af615d8` | script path 提取器补齐 | 排除 | 不带 extractor/IR、安全确认路径变化。 |
| `01428d7b` | 桌面规则档位覆盖 | 排除 | 不带设置、API、策略覆盖能力。 |
| `b6c83c25` | unknown 策略拆分与放宽 | 排除 | 不带安全策略/风险档位行为变化。 |
| `d6a22460` | 安全设置注释 | 排除 | 随未准入的规则档位功能一并排除。 |
| `df55acd0` | 确认可解释性与脚本信任 | 排除 | 不带信任记忆、确认原因产品行为。 |
| `1b753f2e` | script path 方案实施记录 | 排除 | 不带无关实施文档。 |
| `419ede3a` | 策略规则测试加固 | 排除 | 属于未准入策略功能的专用测试。 |
| `c96acc2e` | 桌面规则档位分支合并 | 排除 | merge tree 不保留规则档位改动。 |
| `7f745500` | browser-act 信任需求文档 | 排除 | 不带独立需求文档。 |
| `3402a671` | script path 安全阻断修复 | 排除 | 本轮限于 runtime cancellation，脚本安全缺陷另行处理。 |
| `fdbeb9a4` | 用量归因模块与 schema v19 | 排除 | 不带模块、迁移、列、operations 与专用测试。 |
| `4f710b67` | script path 变体修复 | 排除 | 不带 extractor/确认路径改动。 |
| `af39ba67` | tool loop 用量归因接线 | 排除 | 不带旧循环归因与新的工具归因维度。 |
| `9cf59fc9` | 用量摊回逻辑 | 排除 | 不带归因纯逻辑。 |
| `3b46cda2` | Python walrus 提取修复 | 排除 | 不带脚本提取器/IR 改动。 |
| `6234f8eb` | 用量归因聚合查询 | 排除 | 不带 DB 查询、IPC/preload/API。 |
| `dab9fbe9` | UsageStats 构成 UI | 排除 | 不带 UI、i18n、图表组件。 |
| `ff6a5cde` | ContextUsageRing 分组显示 | 排除 | 不带用量构成 UI 改动。 |
| `2d483650` | script path walrus/decode/global 修复 | 排除 | 不带脚本 IR/提取实现。 |
| `5d39d28d` | 归因版本号 UI 修整 | 排除 | 归因 UI 不准入，此修整无独立适用对象。 |
| `c98dd85f` | 脚本字典推导式/decode 修复 | 排除 | 不带脚本提取器改动。 |
| `b6c86fa5` | 用量归因需求文档 | 排除 | 不带独立需求。 |
| `7c609287` | 归因评审修复 | 排除 | 归因功能及其专用修复均不准入。 |
| `fd583b72` | walrus 递归透传修复 | 排除 | 不带脚本 IR/提取实现。 |
| `773e11d7` | 用量归因分支合并 | 排除 | merge tree 不保留归因模块及依赖。 |
| `75050bf7` | walrus 条件性透传修复 | 排除 | 不带脚本提取器改动。 |
| `8129f2a5` | lambda 默认值透传修复 | 排除 | 不带脚本提取器改动。 |
| `a4508f16` | script path 方案文档更新 | 排除 | 不带独立实施文档。 |
| `ac97b559` | script path 分支合并 | 排除 | merge tree 不保留 extractor、规则放宽或信任记忆。 |
| `ae2bc6be` | release 0.2.2 | 保留 | 保留应用版本与 release 元数据；检查不覆盖本地 SDK 依赖/入口。 |
| `8dad0284` | 补登记 script-unmodeled-path-ask loose 覆盖；修 G12 CI | 排除 | 该提交不只是测试/CI 修正：还把 `script-unmodeled-path-ask` 在 loose 档设为 `allow`，属于本轮排除的安全策略行为变化。最终树不得留下此覆盖；测试与策略注册需按其父提交的准入结论一起还原核对。提交正文报告此前 Linux CI 失败、作者本地全量测试 770 文件/6137 用例通过；检查时对应 GitHub workflow 仍是 In progress，因此不能据此记为云端 CI 已通过。 |

## 3. 不变量

1. 一个正在运行的会话只取消其当前 `turnId`；共享 `requestId` 不得使另一个 session/turn 被取消。
2. 用户取消后，Hosted 模型 provider 必须收到该 turn 的 signal；HTTP/SSE 等待不能依赖“下一个 chunk 到达”才停止。
3. 取消的唯一事实由 SDK turn 结果与 canonical History terminal 保持一致；取消不得记成普通 `failed`，也不得再派发后续工具。
4. 取消已发生时的迟到网络异常按取消收口；普通网络失败仍按失败处理。
5. 被取消的模型尝试最多记录一次实际已获得的 usage；没有 usage 时不得伪造 token 记录。取消不触发 provider 自动重试。
6. UI 的停止动作立即清理本地运行态，并通过现有 turn-scoped 取消 IPC 通知主进程；清理 UI 状态不等同于宣称工具副作用已回滚。
7. 生产日志只输出允许的稳定字段与 reason code，不写消息正文、system prompt、工具输入或原始错误响应。

## 4. 分阶段 TDD 任务

### 阶段 0：冻结基线与差异清单

**目的：** 开始修改前固定分叉基线，并确认哪些边界已有实现，避免重复造轮子。

1. 保存 `git status --short --branch`、`git rev-parse HEAD`、`git rev-parse origin/main` 和 `git rev-list --left-right --count origin/main...HEAD` 到实施记录；确认工作树干净且 `origin/main` 没有在计划执行中继续移动。
2. 对照以下现有链路并记录每个边界的实际身份/信号来源：
   - renderer：`src/renderer/components/Chat/ChatView.tsx` -> `src/renderer/services/chatRunnerService.ts::abortSessionRun`；
   - main：`electron/toolChatLoop.ts` 的 turn cancel registry 与 `createHostedModelRequest(... signal)`；
   - SDK：`packages/agent-sdk/src/turn.ts` 的取消终态；
   - provider：`packages/agent-provider-pi-ai/src/index.ts` 的 `PreparedModelCall.request.signal` -> provider stream options；
   - 历史：`electron/runtime/sqliteAgentHistory.ts` 的 terminal 映射；
   - 观测：`electron/agentLogger/types.ts`、`electron/agentLogger/agentLogProjection.ts`。
3. 给差异表逐项标记“现有实现及测试已覆盖 / 缺少测试 / 测试失败需修复”；不得将计划中的测试清单预先标成已完成。

**验收：** 基线本地 HEAD、origin HEAD、merge-base、分叉数量和工作树状态均有记录；每条链路都标明真实传递的 `sessionId`、`turnId`、`requestId` 和 `AbortSignal`；不改产品代码。

### 阶段 1：provider 取消语义与 usage 事实

**目的：** 钉住远端修复意图在当前 provider 架构下的等价契约。

1. 在 `packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts` 将取消用例拆成可分别判定的四种输入：
   - signal 在 dispatch 前已取消：bridge 调用次数为 0；输出 `finish(cancelled)`；**不输出 usage chunk**。
   - 在途请求收到 abort，provider 未返回 usage：bridge 收到同一个 signal；消费及时结束；输出 cancelled；**不输出 usage chunk**。
   - 在途请求收到 abort，provider 已返回真实 usage：只输出该真实 usage 一次，再输出 cancelled；不补造/重复 usage。
   - 未取消的普通网络错误：仍抛失败，不得被误分类为 cancelled。
2. 增加底层 stream 抛错竞态：可控 async iterator 在收到 abort 后直接 `throw new Error('network reset')`，而不是 yield pi-ai 的 `error`/`done: aborted` 事件。provider 层必须把 signal 已 aborted 的该异常映射为取消终态；同样的 throw 若 signal 未 aborted，必须仍抛失败。
3. 明确覆盖两种 upstream 取消形态（`error`/`done: aborted`）且 usage 缺失、usage 存在的组合。缺失 usage 时不得用 `{ inputTokens: 0, outputTokens: 0 }` 占位；真实 usage 数值为 0 时，因为 provider 明确返回了 usage，仍按一条真实 usage 处理。
4. 用可控 async generator / 可控 fetch Response 实现 stall，不用真实外网、不用长 sleep；确保测试有短超时保护，失败时不会挂住 Vitest worker。
5. 以上述测试先确认当前代码失败，再改 `packages/agent-provider-pi-ai/src/index.ts`。本阶段生产代码验收边界是：保留 signal 传递及已有错误语义；signal 已 abort 时，stream 迭代器直接抛错也转为 cancelled；只移除缺失 usage 时的合成 usage。不改统计口径、不添加归因字段。

**测试命令：**

```bash
npx vitest run packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts
```

**验收：** 四种输入、`error`/`done: aborted` 缺失与存在 usage 的组合、以及 abort 后 iterator 直接抛错的断言均通过；测试分别断言 bridge 次数、signal 对象相等、chunk 序列及取消/失败结果。临时恢复现有“无 usage 生成 0 usage”实现时，缺 usage 用例必须失败；移除 signal 转发时在途用例必须失败；移除 abort 后直接抛错的归类时竞态用例必须失败。完成后不存在把“未收到用量”写成零 token provider attempt 的行为。

### 阶段 2：SDK turn 取消与 History 终态一致性

**目的：** 确保取消穿过 provider 后不会被 SDK 收敛成 failed、继续派工具或重复记账。

1. 在 `packages/agent-sdk/test/turn.test.ts` 或最贴近现有模型流取消用例的位置补测试：
   - provider stream 在途时 abort 且从未收到 usage chunk，turn 以 `cancelled` 终止，`recordProviderAttemptUsage`、usage session event 和 usage-updated fact 均调用 0 次；
   - 请求前 abort 同样不写 provider attempt usage 或零值 step fact；
   - 已收到真实 usage 后 abort，保留已观察到的 usage 事实且只写一次，但不接受半截 assistant/tool proposal；另测真实 usage 明确为 0 的情况仍按一次真实记录保留；
   - provider 在 signal abort 后从 async iterator 直接抛普通网络异常：SDK 最终是 cancelled；`recoverProviderAttempt` 为 0、provider dispatch 只有一次、History 只有一个 cancelled terminal；同一异常在 signal 未 abort 时仍走普通失败路径；
   - abort 后不执行 provider retry、tool executor 或下一次 model turn；
   - 同一 turn 重复/迟到 abort 只产生一个 terminal。
2. 由于当前 SDK stream collector 将 usage 视为必需字段，先在 `packages/agent-sdk/test/modelStream.test.ts` 增加契约测试：普通 `stop`/tool response 缺 usage 仍失败关闭；只有 `finish.reason === 'cancelled'` 才允许没有 usage，且收集结果明确表示“无 usage”（不构造零值）。再按测试最小修改 `packages/agent-sdk/src/model.ts`、`packages/agent-sdk/src/turn.ts` 的取消收口/记账调用。
3. 在 `electron/runtime/hostedAgentTurnHost.test.ts` 增加 host 集成断言，覆盖真实 Hosted host + fake provider + history：取消事实写入 canonical History 的终态与 outcome 解码器相符；无 usage 的取消不调用 `recordProviderAttemptUsage`，有真实 usage 时恰好调用一次。
4. 记录并核对三类持久/事件出口：SDK callback、`createAgentSdkUsageRecorder` 的 `recordStepUsage`、`request_usage` session event。无 usage 的取消在三处均为零条；不能仅断言 SDK callback 没被调用而漏掉 provider usage chunk 已提前生成的路径。
5. 若现有实现已满足新契约，测试通过即不改对应生产文件；若失败，先用最小生产改动修复，禁止改写执行循环。

**测试命令：**

```bash
npx vitest run packages/agent-sdk/test/modelStream.test.ts packages/agent-sdk/test/turn.test.ts electron/runtime/hostedAgentTurnHost.test.ts electron/runtime/terminalOutcome.test.ts electron/runtime/sqliteAgentHistory.test.ts
```

**验收：** History 只有一个 cancelled terminal；不存在 failed terminal/llm.error 误记；取消之后工具派发次数为 0。abort 后 stream 直接 throw 时 `recoverProviderAttempt` 和第二次 provider dispatch 均为 0，未 abort 的同一异常仍按失败处理。无 usage 取消的 SDK callback/session event/数据库 step fact 均为 0 条；有 usage 取消三者与实际 usage 一致且最多一条；真实的零值 usage 与缺失 usage 可由测试区分。普通未取消且缺 usage 的 provider response 仍失败关闭。

### 阶段 3：UI 停止动作与 turn-scoped IPC

**目的：** 验证本地停止交互与新执行架构一致，不恢复旧 requestId 取消路径。

1. 新建 `src/renderer/services/chatRunnerService.abort.test.ts`，钉住 `abortSessionRun(sessionId)`：
   - 当前会话有 turn 元数据时只发送该 `turnId` 的取消；
   - 缺少 turn 元数据时仍走既有 request 清理兼容路径；
   - 清理 running session、live state 和确认 waiter 是同步本地动作。
2. 新建 `src/renderer/components/Chat/ChatView.abort.test.tsx`，验证停止按钮委托给 `abortSessionRun`，不从组件旁路发另一个身份不一致的取消请求。
3. 加一条跨会话身份碰撞隔离测试：A/B 的 `sessionId` 不同、`turnId` 不同、**`requestId` 明确相同**；二者同时运行。停止 A 后只向 A 的 `turnId` 发取消；B 的 `runningSessions` 元数据、request/turn 关联和后续完成清理仍对应 B，不能被 `unregisterRunRequest` 的 requestId 碰撞误删。放在 ChatView/service 测试里，不新建 UI 能力。
4. 补 main/SDK 侧同一身份碰撞对照：取消 A 后 B provider signal 未 abort；B 的 tool admission、待确认 waiter 不被释放/拒绝；B 的工具可继续执行并正常完成其 turn/history terminal。

**测试命令：**

```bash
npx vitest run src/renderer/services/chatRunnerService.abort.test.ts src/renderer/components/Chat/ChatView.abort.test.tsx electron/runtime/callAdmission.test.ts electron/runtime/hostedTurnHandoff.test.ts
```

**验收：** 测试夹具明确断言 `sessionA !== sessionB`、`turnA !== turnB`、`requestIdA === requestIdB`；停止 A 后 IPC 只带 `turnA`，A 的 UI 立即解除运行态，而 B 的运行元数据、request/turn 注册、AbortSignal、确认 waiter、admission、工具执行和完成事件全部保留。若当前实现与断言一致，不改 UI。

### 阶段 4：取消审计与日志隐私（仅在缺口存在时）

**目的：** 让取消可与失败区分，同时不泄露 prompt、工具参数或原始 provider 错误。

1. 先增加投影测试：取消日志只允许稳定的 `turnId`/`requestId`/`sessionId`（按当前 logger allowlist 能力）及原因码；注入 system prompt、用户文本、API 响应正文后确认均不出现在结果中。
2. 若现有日志无法区分“用户取消”和“普通失败”，再在类型、取消投影和真实 IPC/turn 入口增加最少的取消事件；事件名和字段以当前 agent logger 规范为准，不复制旧 tool loop 的宽泛 payload。
3. 覆盖 event allowlist、序列化和错误竞态；日志写失败不得改变 turn 的取消结果。

**测试命令：**

```bash
npx vitest run electron/agentLogger/agentLogProjection.test.ts electron/agentLogger/agentLogger.test.ts electron/runtime/hostedAgentTurnHost.test.ts
```

**验收：** 若现有事件足以诊断取消，阶段以测试确认后结束且无生产改动；若补事件，审计能定位到 turn 且敏感正文字段被剔除，取消终态不依赖 logger 成功。

### 阶段 5：全量兼容与静态门禁

1. 对 agent-sdk/provider/runtime 及 renderer 中被触及测试做聚焦回归。
2. 运行全量 Vitest、相关类型检查和构建，检查旧执行循环没有被引入运行路径、Hosted Runtime 依赖边界未被绕过。
3. 运行 agent SDK 边界/依赖门禁、共享层类型检查、renderer 类型检查及 electron bundle 构建。
4. 检查本轮 diff：不应出现 `usageAttribution`、schema v19、用量构成 UI、grep fallback、script-path/policy 规则等排除项；测试新增范围仅覆盖上文生命周期契约。

**本机门禁命令：**

```bash
npm test
npm run typecheck:agent-sdk
npm run typecheck:agent-provider-pi-ai
npm run typecheck:renderer
npm run typecheck:shared
npm run check:agent-sdk
npm run build
```

**验收：** 全部命令通过；如失败，记录第一条失败、失败测试、项目代码栈和预期/实际值，修复后重跑对应命令。Windows 构建/运行验证不作为本轮必须项。

### 阶段 6：历史收敛、最终树审核与云端接受

**目的：** 在保留远端历史的前提下，将已准入的修复放入云端可接受的历史；确保被排除的独立能力不留在最终树，并以非强制推送或受保护分支 PR 合并完成本轮目标。

1. **冻结最终远端基线。** 执行 `git fetch origin`；记录最新 `origin/main` SHA、当前本地 HEAD、merge-base 及 ahead/behind。若远端已从本计划基线 `8dad0284` 前进，重新导出新的 remote-only commit 清单，并把新增项加入本阶段审核后再继续。
2. **逐提交分类 46 项及依赖。** 保存 `git log --reverse --format='%H%x09%s' <merge-base>..origin/main` 和每个提交的文件变更。普通提交用 `git show --format= --name-status <commit>`；merge commit 用 `git diff --name-status <commit>^1 <commit>` 核对其相对第一父提交的合入 tree，并核对第二父及其引入的子提交（子提交也各有自己的处置行）。为每个 SHA 标记且仅标记一种处置：
   - `保留`：符合重构/缺陷修复范围，依赖明确，行为测试纳入阶段 1–5 或该修复的既有测试；
   - `适配`：修复意图保留，但实现需移植到 Hosted Runtime/agent-sdk；记录原提交、目标模块、对应测试；
   - `排除`：独立功能/超出范围；列出需从 merge result 还原或删除的代码、测试、迁移、依赖、IPC/preload、UI、i18n、构建资源及文档。
   不允许空白、模糊或多个相互矛盾的结论。生成逐提交处置表作为实施记录；`git show --stat` 的主题摘要不能替代逐项检查。
3. **先在本地完成生命周期修复提交。** 阶段 1–5 通过后，以小提交记录 provider/SDK/UI 的必要修复及测试，保持本地 Hosted Runtime 调用路径。此时不推送，也不把 `origin/main` 祖先关系伪装为已解决。
4. **执行保留远端祖先的双亲合并。** 从本地 `main` 执行普通 `git merge --no-ff origin/main`（可先 `--no-commit` 进入审核）；禁止 force push、reset/rebase 覆盖云端历史。处理冲突时保留本地 `electron/toolChatLoop.ts` + agent-sdk/Hosted Runtime 架构，将已准入的远端行为按阶段 2 的兼容边界移植；对排除项生成明确的 tree cleanup/revert 变更。合并冲突清单与每个冲突的选择理由写入实施记录。
5. **检查无冲突变更和依赖闭包。** 对 merge-base 到合并 HEAD 的完整文件清单逐文件审查，不限于 Git 报告的冲突。重点检查 `package.json`/lockfile、schema/migrations/operations、IPC/preload/API、renderer/settings/i18n、脚本、模型/工具注册、打包资源、测试、文档。每项最终内容必须可追溯到第 2 步的一条准入记录；排除项的源文件和间接入口不得残留。排除项测试若依赖被删除能力，应一并删除；仍适用的回归测试须留下。
6. **重跑最终树验证。** 在双亲 merge 完成、cleanup/revert 已落地后，运行阶段 5 全部门禁，并重跑每个 `保留/适配` 项所列的定向测试。另对排除清单做符号/路径扫描，检查用量归因模块及 v19 字段、grep fallback 与 ripgrep 前置项、规则档位/信任记忆 UI/API/持久化没有出现在最终树；按第 2 步确认的实际命名补全扫描表达式。发现残留即未通过。
7. **验证可推送祖先关系。** 确认 `git merge-base --is-ancestor origin/main HEAD` 退出码为 0，且 `git rev-list --left-right --count origin/main...HEAD` 的 remote-only 计数为 0；检查 merge commit 有本地和当时 `origin/main` 两个父提交，最终 diff 和状态符合准入表。
8. **推送已验证的提交。** 先记录最终本地 merge SHA 与通过门禁的结果，再尝试普通 `git push origin main`；禁止 `--force`/`--force-with-lease`。若 push 成功，fetch 并确认 `origin/main` 指向或包含该已验证提交，且云端必需检查通过。若错误是 non-fast-forward，表示远端新增提交，回到步骤 1；只有确认是 branch protection/权限拒绝直推时才走步骤 9 的 PR 路径。
9. **受保护分支时准备 PR 源分支。** 若直推因 branch protection/权限被拒绝，从已验证的 merge SHA 建立独立本地集成分支，例如 `codex/main-divergence-integration-20261001`：`git switch -c <branch> <verified-merge-sha>`。确认新分支 HEAD 与已验证 SHA 一致后，普通推送到 `origin/<branch>`（`git push -u origin <branch>`），禁止强推。若同名远端分支已存在，先 fetch 并比较提交图；仅允许正常快进更新，否则另建唯一分支，不能覆盖他人提交。记录远端源分支 SHA。
10. **创建/更新 PR 并同步新增远端提交。** 以 `origin/<branch>` 为 PR head、`origin/main` 为 base；记录 PR 编号、head SHA、base SHA。等待仓库要求的检查通过。若 PR 期间 `origin/main` 前进，先将新 tip 合并进集成分支，回到步骤 1–7 对新增提交重新分类、审核最终树并重跑全量门禁，再普通推送更新源分支和 PR；不得直接在旧 base 上宣告验证有效。
11. **合并 PR 并核验云端最终树。** 满足仓库保护检查后完成 PR 合并，再 `git fetch origin`。PR 保留 merge commit 时确认远端包含本地集成 merge；若采用 squash/rebase，核对 PR merge SHA、PR diff 与远端最终文件树确实包含等价修复，不要求本地 merge SHA 成为远端祖先。检查远端 main 的必需生命周期/CI 门禁通过，记录合并方式、merge SHA、最新远端 SHA 和验证结果。push 或源分支 push 若因远端提交变化 non-fast-forward，回到步骤 1 重新审核增量，不 force push。
12. **将本地 `main` 对齐到云端 `main`。**
    - 先 `git fetch origin` 并记录 PR 合并 SHA、PR 最终 head/source SHA（已包含合并前最新 base）、该 source 对应的 base SHA，以及当前 `origin/main` SHA。若远端 tip 在 PR 合并后继续前进，逐项审核新提交及其最终树影响，按步骤 1–7 中适用的门禁重新验证；不能把这些新提交当作未纳入的本地改动。
    - 若普通 main push 成功，确认本地 `main` 与 fetch 后的 `origin/main` 指向同一 SHA；若本地 HEAD 是远端 tip 的祖先且只多出已审核的远端后续提交，工作树干净时可用 `git merge --ff-only origin/main`，其他情况回步骤 1–7。
    - 若 PR 以 merge commit 合并且本地 merge SHA 是 `origin/main` 祖先，先确认工作树干净，再执行 `git switch main && git merge --ff-only origin/main`。
    - 若 PR 采用 squash/rebase，先确认工作树干净；保存原本地 `main` 的可恢复备份引用，例如 `git branch backup/main-before-pr-align-20261001 main`（若名称已存在，使用新名称，不覆盖旧引用）。不能用原本地 `main` 与最新 `origin/main` 的整体 tree 是否相同作为丢弃旧分叉历史的门槛，因为后者可能含有已审核的远端新增提交。改为留下以下可复核证据：
      1. 记录 PR 最终 source/head SHA 与 tree SHA、PR 合并 SHA 与 tree SHA、PR base SHA；核验 PR 的已验证变更在云端 PR 合并结果中完整体现。若合并时 base 未变化，合并结果应与最终 source tree 相同；若合并期间 base 前进或采用 rebase，逐项核对额外 tree 差异来自已审核的 base 提交，且 PR 中本地准入改动仍完整存在。任何无法归因的差异都暂停对齐并调查。
      2. 原本地 `main` 到 PR 集成分支最终 source 的 diff 仅用于定位差异，不能单独证明原本地提交或其准入改动已进入 PR；合并、回退、重排或重写提交都可能改变这组 diff。实施记录须按逐项准入记录核对每项本地准入改动，并以 PR 最终 diff、云端合并后的 tree 及必要的代码/测试证据确认其完整进入云端。再检查 PR 合并后新增的 `origin/main` 提交及其 tree 变化，确认均已审核并通过适用门禁。将差异分为“已审核的远端新增改动”与“未进入云端的本地准入改动”；只有后一类非空时才阻止对齐，并通过后续提交/PR 补齐。
      3. 上述核验通过且工作树干净后，执行 `git switch main && git reset --hard origin/main`。备份分支保留原提交图，除非后续明确清理，不在本步骤删除。
    - 对齐后确认 `git rev-parse main` 与 `git rev-parse origin/main` 相同、`git rev-list --left-right --count origin/main...main` 输出 `0 0`、`git status --short --branch` 无改动；记录原本地 HEAD、备份引用（如适用）、PR source/base/merge SHA 与 tree SHA、PR 合并后新增远端提交的处置、最终远端 SHA 和对齐结果。

**验收：** 双亲历史保留审核时的云端 tip，所有云端独有提交都有保留/适配/排除结论；最终树只保留准入能力且依赖闭包完整；阶段 1–5 与准入项测试在最终 merge tree 通过；本地最终 merge 前 `origin/main` 是 HEAD 祖先且 remote-only commit 数为 0。随后普通非强制 main push 成功，或已验证 merge SHA 被正常推送到独立 `codex/...` 源分支、PR head/base 与 SHA 可核验、PR 完成合并且最新云端 `main` 的最终树包含本地修复并通过必需门禁。最后本地 `main` 与 `origin/main` 指向同一提交且工作树干净；若 squash/rebase 改写历史，原提交图仍通过备份引用可恢复。仅有本地 commit、仅有源分支 push、仅创建未合并 PR、或 PR 合并后本地 main 仍分叉均不算完成。

## 5. 不纳入验收的事项

- Windows 平台打包、运行或人工验收；本计划不要求在本机模拟 Windows。
- Agent Token 用量内容归因及其 UI、grep 自动降级、ripgrep 准备、脚本路径提取与安全规则调整。
- 任何新设置页、运行时运维页、取消后恢复/重试交互或其他面向用户的新入口。
- 将远端历史整体 cherry-pick 到本地或 force push 覆盖远端历史。
- 在提交逐项处置表、最终树审核和云端接受验证完成前宣告本轮完成。

## 6. 实施记录

| 阶段 | 状态 | 实际改动/命令/结果 |
|---|---|---|
| 0. 基线与差异清单 | 完成 | 基线及六层身份/信号链路记录见 [实施记录](2026-10-01-main-divergence-hosted-runtime-integration-execution-record.md)。唯一未跟踪项为本计划文档；阶段 0 未改产品代码。 |
| 1. Provider 取消穿透 | 完成 | `anthropicAdapter.test.ts` 先新增契约测试，基线 5 项失败；按失败最小修复 provider 后该文件 24/24 通过。详细断言与结果见 [实施记录](2026-10-01-main-divergence-hosted-runtime-integration-execution-record.md)。 |
| 2. SDK/History 终态 | 完成 | Collector 仅允许 cancelled terminal 缺 usage；turn 在取消时跳过恢复/工具派发，真实 usage 最多记一次并写入现有 History/usage recorder 出口。计划聚焦集成 235 项通过，`typecheck:agent-sdk` 通过；具体红绿证据见 [实施记录](2026-10-01-main-divergence-hosted-runtime-integration-execution-record.md)。 |
| 3. UI 与 turn 隔离 | 完成 | request 索引按会话保存并在身份歧义时拒绝回退；停止操作同步清理本会话 UI 并按 turnId 通知主进程。renderer、admission、Hosted handoff 和 SDK 跨会话共享 requestId 回归验证通过，见实施记录。 |
| 4. 取消审计隐私 | 完成 | agent logger 投影/日志与 Hosted Host 定向测试 31/31 通过；取消/失败继续由既有 History 和 session `turn_end` 区分，不新增重复事件；既有 allowlist 投影测试通过。 |
| 5. 全量兼容门禁 | 完成 | `npm test` 终验 804 文件通过、1 跳过；7081 项通过、106 跳过。agent-sdk/provider/renderer/shared 类型检查、`check:agent-sdk` 与 `npm run build` 均通过。首轮全量发现 5 项旧 display 缺 activity 失败，新增共享协议兼容回归并在转换边界默认空轨迹后重跑全量通过；build 仅有 chunk/import 提示。 |
| 6. 历史收敛、最终树审核与云端接受 | 进行中 | 云端 46 项逐提交分类及文件清单已审阅；生命周期修复、计划文档、双亲 merge 和 workflow 修复已推送。第二次 Actions run 暴露 Ubuntu 测试依赖 `/tmp` 的本机目录状态；已按 TDD 修正四个测试文件的隔离夹具，并在 `TMPDIR=/tmp` 模拟下全量测试、类型检查、SDK 边界和 build 均通过。测试夹具修复的提交与新 CI 仍待推送/验收；最新 CI 通过及本地 main/origin 对齐仍待完成，详情见实施记录。 |

## 7. 逐项完成判定表

阶段任务只在对应行的证据齐全后标为完成；“改过代码”或“测试命令退出码为 0”本身不足以完成。

| ID | 完成条件 | 必须留存的证据 |
|---|---|---|
| 0.1 | 本地 HEAD、origin HEAD、merge-base、分叉计数和工作树状态固定 | 命令输出写入实施记录 |
| 0.2 | 每一跳的 session/turn/request identity 与 AbortSignal 来源已核对 | 六个模块边界的代码位置和结论 |
| 1.1 | 取消前未 dispatch：无 bridge 调用、无 usage、cancelled finish | provider 单测断言及测试结果 |
| 1.2 | 在途取消且无 provider usage：及时结束、无 usage chunk/重试 | provider 单测断言及测试结果 |
| 1.3 | 在途取消且有真实 usage：只保留该 usage 一次 | provider 单测 chunk 序列及测试结果 |
| 1.4 | `error`、`done: aborted` 缺失 usage 均不合成零值；普通失败语义不变 | provider 两分支断言及测试结果 |
| 1.5 | signal abort 后底层 iterator 直接 throw 网络异常仍收敛为取消；未 abort 时仍失败 | provider 竞态单测结果 |
| 2.1 | SDK 仅允许 cancelled terminal 缺 usage，其他 finish 缺 usage 仍拒绝 | model stream 单测结果 |
| 2.2 | 无 usage cancel 不触发 callback、session usage event、usage fact 或 DB step fact | SDK/runtime 集成 spy/真实 DB 断言及测试结果 |
| 2.3 | 有真实 usage cancel 恰好记一次，真实零值与缺失可区分 | SDK/runtime 集成断言及测试结果 |
| 2.4 | cancel 只产生一个 History terminal，且不执行工具/重试 | Hosted host/History 集成测试结果 |
| 2.5 | abort 后 stream throw 不触发 recovery/第二次 provider dispatch，History cancelled；未 abort 对照失败 | turn/runtime 集成测试结果 |
| 3.1 | 点击停止立即清理本会话 UI 并只取消当前 turn | renderer service/component 测试结果 |
| 3.2 | 两 session 不同 turn、共享 requestId 时，取消 A 不影响 B 全生命周期 | renderer 与 main/runtime 隔离测试结果 |
| 4.1 | 日志足够区分取消/失败，或证明无需增加日志 | 现有事件检查结论；如有改动，allowlist 隐私测试结果 |
| 5.1 | 聚焦测试、全量测试、类型门禁、边界检查和 build 均通过 | 每条命令及退出码/失败记录 |
| 6.1 | 最新云端基线固定，remote-only 提交清单完整，46 项及增量项均有唯一处置结论 | fetch 后 SHA/计数；逐 SHA 处置表及文件清单 |
| 6.2 | 生命周期修复以本地小提交记录，双亲 merge 保留云端 tip 祖先关系 | 修复提交摘要；merge commit 两父 SHA 和冲突处置记录 |
| 6.3 | 无冲突文件、间接依赖、迁移、测试、UI、资源均按准入/排除清单处理 | merge-base..HEAD 文件审查矩阵；排除扫描结果 |
| 6.4 | 最终 merge tree 聚焦测试、全量门禁、类型检查和 build 通过 | 命令、退出码、保留项定向测试结果 |
| 6.5 | `origin/main` 是 HEAD 祖先，remote-only 数为 0 | ancestor 检查退出码及 rev-list 计数 |
| 6.6 | 若直推受保护规则拒绝，已验证 merge SHA 推送到独立源分支，无覆盖远端提交 | 本地分支名、远端源分支名/SHA、普通 push 输出及 ancestry 对照 |
| 6.7 | PR head 指向远端集成分支、base 指向 main；新增 main 提交已重新整合和验证 | PR 编号/head/base SHA；如 base 前进，新增提交处置表及重跑门禁结果 |
| 6.8 | 云端实际接受修复：main push 成功或 PR 已合并且远端最终树包含修复 | 普通 push 输出或 PR merge SHA/方式；fetch 后远端 SHA、提交或等价补丁关系、最终树及门禁结果 |
| 6.9 | 本地 `main` 对齐到云端 `main`；squash/rebase 前的本地历史仍可恢复；逐项准入的本地改动已由 PR 最终 diff 和云端合并 tree 证明完整进入云端；PR 合并后新增远端提交已单独审核 | 合并方式；原本地 HEAD 和备份 ref；PR source/base/merge SHA 与 tree SHA；逐项准入记录到 PR 最终 diff、合并 tree 及代码/测试证据的对照（原本地 `main` 到 PR source 的 diff 仅作差异线索）；PR 合并后远端增量的逐项处置及门禁；最终 `main`/`origin/main` SHA、`0 0` rev-list 计数和干净 status |
