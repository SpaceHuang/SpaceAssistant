# main 分支死代码盘点与安全清理方案

> 初次盘点：2026-10-14；复核基准：2026-10-15 `main`，`HEAD=ebdff6fa`（`v0.2.7`）；评审修订：v2
> 目的：估算未接线代码范围，给出不改变现有正常行为的清理顺序。本文只记录盘点与计划，不删除或改接任何产品代码。

## 1. 结论摘要

本次把“死代码”拆成两类：**模块没有从应用入口接入**，以及**已接入模块内有声明从未被读取**。静态结果只能产生清理候选；在确认 IPC、配置、动态加载、迁移脚本及外部调用边界以前，不将候选直接判定为可删除。

| 项目 | 盘点结果 | 解释 |
|---|---:|---|
| 应用源码模块静态筛查 | 1,083 个非测试 TS/JS 源文件 | 当前 `main` 跟踪的 `electron/`、`src/`、`packages/` 文件，不含脚本目录 |
| 没有静态应用入口路径 | 56 个模块 | 当前基线复核结果；已分流脚本、动态入口、声明、测试支持与复核候选 |
| 排除已确认的非产品入口后 | **28 个待人工复核模块** | 见第 4 节；并不等于 28 个已确认可删模块 |
| 可直接确认安全删除 | **0 个** | 删除前仍需核对行为归属及替代验收证据 |
| TypeScript 未使用诊断位置 | **277 处** | 当前基线临时开启 `noUnusedLocals/noUnusedParameters` 后，对两个应用 TS 项目输出去重；不是函数数或可删代码行数 |

复核结论：相比初次盘点的 `879c7d04`，当前 `main` 有 4 个新增非测试 TS/JS 源文件；静态不可达数仍为 56、待复核候选仍为 28。未使用诊断从 278 个位置变为 277 个。以下数字均以本节标明的当前基线为准。

高置信度的“应用运行时未接线”例子是 `electron/tools/agentSdkTurnDispatch.ts` 及其 permit/prepared-store 辅助模块，共 4 个文件。现有方案文档已把 `createAgentSdkTurnDispatch` 描述为错误依赖路径并标记废弃；但其单测仍覆盖撤权、输入冻结和 dispatch 屏障，必须先映射到当前生产执行路径的回归证据，不能连测试一起直接删。

**建议先做未使用绑定的分批清理，再处理模块级候选。** 对授权、确认、Turn/History、数据库迁移、IPC 和 IM 的代码，必须先证明生产路径已有等价覆盖；否则保留，或先补真实接线测试。

## 2. 盘点方法与证据边界

### 2.1 应用模块引用图

复核基线为当前 `main` 的 `ebdff6fa`，产品源码工作树与该提交一致。对 1,083 个非测试 TS/JS 文件使用 TypeScript AST 建立静态 import/re-export、字面量 `require()` 与字面量 `import()` 图；入口按当前构建方式取 Electron `main`/`preload`、Vite 主窗口和浮窗入口、Agent SDK 导出和 pi-ai provider 包入口。`scripts/`、Vitest setup、声明文件和 type gate 作为独立入口类别另行核对，不混入产品运行时根集合。路径别名按根 `tsconfig.json` 的 `@/*` 规则解析。应用图另行核对了非静态加载方式：

- 浮窗 preload 由 `electron/floatingNotification.ts` 拼接路径加载。
- spill 引用清理与 storage profile 使用 `Worker` 路径加载 Worker 文件。
- npm 脚本、`vitest.config.mts` 中的 setup 文件、TypeScript 声明和 type gate 作为各自领域入口单独核对。
- electron-builder 把 `dist-electron/**/*` 纳入产物，而 `tsconfig.electron.json` 编译 `electron/**/*.ts`。因此应用无法从入口到达的模块仍可能被编译并进入分发目录，确有整理价值。

静态扫描不能可靠识别路径拼接、反射、数据库记录中的插件/任务名、用户脚本、IPC 字符串协议和外部包消费者。因此，下表“无静态应用路径”只表示应用入口的 import/re-export 图没有到达该模块，不代表已证明运行时永不访问。

### 2.2 未使用声明扫描

在当前 `main` 基线上临时执行 `tsc -p tsconfig.electron.json` 和 `tsc -p tsconfig.renderer.json`，加上 `--noUnusedLocals --noUnusedParameters --noEmit --incremental false`。没有修改 tsconfig，也没有运行 Vitest。

- Electron 项目输出 237 个未使用诊断，Renderer 项目输出 56 个；共享文件重复报告 16 个，按文件、行、列去重为 277 个。
- 诊断集中在 `electron/toolChatLoop.ts`（88 处）、`src/renderer/components/Chat/ChatView.tsx`（18 处）、`electron/claudeStreamHandlers.ts`（11 处）和 `src/shared/api.ts`（9 处）。
- 其中既有未使用 import，也有局部变量、类型和参数。删除 import 前仍要检查模块副作用；参数、导出类型和跨进程合同不能只因函数体未读取就从接口删除。
- 项目当前没有启用这两项 `noUnused` 编译选项；以上是一次性清理信号，不能解读为正常构建当前失败。
- TS6133 只说明变量绑定没有被读取，不说明初始化器、后续赋值或求值顺序可以删除。状态变更与调用副作用要按第 5.1 节单独分类。

### 2.3 初筛集合的分流

AST 图得到的 56 个无静态应用入口模块已按当前仓库入口复核，并完成以下分流；这里的“无静态入口”不等于运行时不可达：

| 分流 | 数量 | 当前基线中的文件 |
|---|---:|---|
| 由维护/审计脚本使用 | 6 | `electron/database/sessionStorageProfile.ts`、`sessionStorageCleanupEstimate.ts`、`remoteTrackOperationalMetrics.ts`、`testHelpers.ts`、`electron/runtime/sessionProjectionObservation.ts`、`electron/storageProfile/localReadonlySample.ts` |
| 由路径拼接或 Worker 加载 | 4 | `electron/floatingNotificationPreload.ts`、`electron/storage/spillReferenceCollectorWorker.ts`、`spillReferenceWorkerAck.ts`、`electron/storageProfile/storageProfileWorker.ts` |
| 环境/模块声明 | 4 | `electron/electron-ambient.d.ts`、`piAiModuleDeclarations.d.ts`、`src/renderer/global.d.ts`、`vite-env.d.ts` |
| 测试、fixture 或测试包专用 | 13 | `electron/confirmation/imChannelTestUtils.ts`、`electron/processOutput/testFixtures.ts`、`electron/testSetup.ts`、`electron/testSupport/{agentLogCapture,claudeStreamHandlers,invocationAssembler}.ts`、`electron/tools/readPermitTestUtils.ts`、`electron/wechat/__mocks__/wechatBotMock.ts`、`packages/agent-provider-testing/src/index.ts`、`src/renderer/components/Chat/testUtils/{chatMessageFixtures,mixedMessageFixtures,renderProbe}.ts`、`src/shared/testSupport/leakAssertions.ts` |
| 编译期 type gate | 1 | `src/shared/configSetTypeGate.ts`，由 shared typecheck 配置包含 |
| **待人工复核** | **28** | 第 4 节清单；逐个确认后的当前统计，不代表可直接删除 |

计数按互斥分流计算。`electron/database/testHelpers.ts` 同时被测试和维护脚本引用，计入脚本类；脚本/测试图之外另核对了 `floatingNotificationPreload` 的路径拼接、spill collector/ack 与 storage profile Worker 的加载关系。因此这 28 个候选已经排除了当前可证明的脚本、Worker、preload、声明和 test-support 入口。

## 3. 清理时必须保护的行为

清理范围只包括经证明未使用的实现，不借“整理”改变下列行为或合同：

1. **对话主链路**：首个模型响应 handoff、工具注册与输入规范化、上下文压缩/恢复、History 与 transcript 投影、取消和超时终态。
2. **工具执行安全**：确认后授权版本复核、permit/admission claim、撤权与取消屏障、dispatch 后结果不确定状态、文件路径和写入保护。
3. **跨进程合同**：`src/shared/api.ts` 与 `electron/preload.ts` 通道对；事件名、payload、订阅释放和浮窗 preload 路径。
4. **持久化兼容**：SQLite schema、迁移、旧配置双读/迁移、备份恢复、spill 引用回收和进程重启恢复。不得把兼容读取误删为“旧代码”。
5. **IM 与 Automation**：飞书/微信入站鉴权、异步确认、队列及预算、身份切换、消息投影、Butler task 调度和隔离。

模块不可达时，先判断它是“待删除实现”“只服务测试/维护”“迁移兼容合同”“尚未完成接线的功能”。最后一类必须明确决定接线或退休，不能靠删文件掩盖未完成能力。

## 4. 28 个模块级复核候选

下表里的模块都没有静态应用入口路径，但测试可能直接引用它们。建议逐组清理，并先记录“现有断言 → 当前生产路径 → 保留/迁移/删除”的对应关系。

| 领域 | 候选文件 | 初步处理建议 |
|---|---|---|
| 旧 stream / 输入拼接辅助（3） | `electron/anthropicStreamDelta.ts`、`electron/modelEventSource.ts`、`electron/toolUseInputMerge.ts` | 对照当前 pi-ai/Hosted provider 流、Anthropic 原始事件解析及 RegisteredTool 输入合同。确认线上解析与 tool-call 拼接不再依赖后，迁移必要断言到现行 adapter，再删除旧 helper 和仅针对旧实现的测试。 |
| SDK permit dispatch 孤岛（4） | `electron/tools/agentSdkTurnDispatch.ts`、`electron/tools/permitBoundCoordinatorDispatch.ts`、`electron/tools/permitRevocationBridge.ts`、`electron/tools/preparedInvocationStore.ts` | 生产源码没有调用点；历史方案把 `createAgentSdkTurnDispatch` 标为错误依赖路径。先把其 canonical-input、授权漂移、撤权/取消与 claim 时序测试映射至 `registeredAgentTurnTools`、SDK permit/admission 和真实 Hosted caller。等生产路径测试能覆盖同等安全不变量，再删孤岛及纯孤岛测试。 |
| 确认 / 安全旧辅助（6） | `electron/confirmation/confirmCardPayload.ts`、`decisionCache.ts`、`deferredApprovalCachePolicy.ts`、`remoteAsyncApprovalAcceptanceMatrix.ts`、`securityActionIntentRecovery.ts`、`shellConfirmationAdapter.ts` | 此组涉及卡片 payload、决策缓存、延迟审批和执行动作。分别确认当前 `agentSdkConfirmationPort`、`ToolConfirmRegistry`、decision cache writer、持久化确认与 shell gate 的合同覆盖；不能因名称含 legacy 或没有产品 import 就一起删除。 |
| Remote / IM 辅助（3） | `electron/remote/deferredApprovalNotificationSender.ts`、`imWorkflowSkillHarness.ts`、`electron/wechat/weChatQuoteBinding.ts` | 核对飞书和微信的真实调用层、CLI/SDK 消息字段与当前通知发送者。保留纯 harness 若它仍是测试夹具；quote binding 或 notification 若是未接线产品能力，明确按“接线”或“功能退休”处理。 |
| Renderer 待确认辅助（3） | `src/renderer/hooks/useActionablePendingConfirms.ts`、`src/renderer/services/confirmationSnapshotGate.ts`、`pendingConfirmationService.ts` | 对照当前 `pendingConfirmStore`、Turn display 和 `ToolCallCard` 的审批提交流程。先有渲染器/IPC 接线证据证明当前路径对 stale turn fail closed，再判断这组测试独有实现是否冗余。 |
| Shared 纯逻辑（5） | `src/shared/llm/outputMaxTokens.ts`、`src/shared/outbound/chatOutboundClassifier.ts`、`promptSerialization.ts`、`spillSemantics.ts`、`surfaceProjection.ts` | 逐项全仓搜函数名、字符串协议、测试和文档；确认没有动态名/跨包消费者。若算法已迁入其他模块，保留对现行实现的边界回归后再删；若仍是有效合同，改由产品路径调用而非删除。 |
| Session projection 诊断（2） | `electron/runtime/sessionProjectionConsistencyAudit.ts`、`sessionProjectionRetirementCandidates.ts` | 当前主要被审计测试和方案材料使用。`check-session-storage-boundary.mjs` 明确把 `sessionProjectionConsistencyAudit.ts` 列为 privileged reader，故必须先确认迁移/清理 owner gate 与边界扫描器可安全退役，再动代码。 |
| 包装层 / attribution（2） | `electron/browser/browserDependencyRecovery.ts`、`electron/database/remoteTrackAttributionMetrics.ts` | 前者是 Electron 到 Shared browser recovery 的再导出包装，Shared 实现仍在用；无外部入口证据时可优先复核。后者先确认 SQLite remote-track 版本、现行指标 reader 和离线报表没有依赖其输出，再决定是否删。 |

上表计数：3 + 4 + 6 + 3 + 3 + 5 + 2 + 2 = 28。

## 5. 分阶段实施方案

### 阶段 0：冻结清理边界与依赖清单

**不改产品代码。** 当前 `main` 的静态盘点、56 项分流及 28 个复核候选已完成。实施时只为获批的小批次确认具体责任人、等价行为证据和是否存在仓库外消费者；路径拼接、Worker、脚本、HTML、type gate 等仓库内入口不再作为待发现事项。仓库外消费者没有源代码证据时，需由功能 owner 明确兼容窗口和退役决定。

阶段门槛：候选模块的处置决定（保留、迁移接线、退休、删除）及 owner 写入批次清单；未完成行为映射的候选不得进入删除批次。

### 阶段 1：清理未使用绑定

按文件分组处理 277 个诊断位置，先从小型、低副作用模块开始；对 `toolChatLoop.ts` 和 `ChatView.tsx` 这类核心大文件单独分批 review，不在一次提交中机械删除数十项。

- 每个局部声明与赋值先归入清单中的一种处理类别，再改代码：

  | 类别 | 处理方式 |
  |---|---|
  | 纯绑定清理 | 初始化器及后续赋值都无可观察副作用时，才可删除未使用绑定或整条语句。 |
  | 保留初始化调用 | 返回值未使用但调用必须发生时，只去掉变量绑定，保留原调用、参数求值、`await`（如有）、异常行为和执行顺序。 |
  | 保留状态变更 | 初始化器或后续赋值会写数据库/文件、注册或释放资源、改计数、调用外部服务或触发 getter 时，保留这些操作；不得将 TS6133 当作删掉整句的依据。 |

- 本轮已有具体反例：[weChatCommandRouter.ts:818](../../electron/wechat/weChatCommandRouter.ts#L818) 的 `parked` 绑定未被读取，但初始化器调用 `parkImInboxMessageForClarification(...)`；该同步调用在 [imInbox.ts:190](../../electron/database/imInbox.ts#L190) 中开启事务并写入消息、澄清记录及版本。调用之后紧接着创建发送尝试并发送澄清消息。清理 `parked` 时可以移除变量名，但必须保留整个调用作为表达式语句；删掉整条声明会跳过持久化，破坏后续澄清回复流程。
- 对有状态变更的条目，清单记录调用方边界、状态写入、后续操作顺序及失败/抛错行为。若现有测试没有覆盖该行为，先补调用方回归证据；纯类型、纯常量且初始化器无副作用的机械清理不要求单独补测试。
- import 也必须检查模块初始化副作用；不能因具名导入未读取就误删承担注册/初始化的模块载入。
- 不删除公开函数形参、导出的类型/枚举、IPC DTO 字段、持久化字段或 callback 位置参数；需要精简 API 时另立行为变更计划。

阶段门槛：Renderer 改动通过 renderer typecheck；Electron 改动通过增量编译与相关测试；共享类型改动通过 shared typecheck。按功能批次验证，不把 277 个告警一次性清空作为验收。含状态变更的初始化器/赋值必须有调用方边界回归证据，且测试确认副作用仍发生、先后顺序不变。

### 阶段 2：先处理有明确迁移证据的断连孤岛

先复核第 4 节 SDK permit dispatch 孤岛和 browser recovery 包装层。对 SDK 孤岛建立安全合同矩阵：冻结输入、计划后授权变化、撤权发生在 claim 前后、取消、executor 零调用、在途结果结算。确认当前真实 Hosted caller 已覆盖每项后，才移除旧 dispatch/helper；否则将缺失项迁入现行生产实现的测试。

阶段门槛：Agent SDK 与 Electron 定向测试/typecheck、`check:agent-sdk` 通过。`build:electron:incremental` 可用于开发期检查；包含模块删除的阶段收尾必须再运行清理输出目录的 `npm run build:electron`，不能把增量编译通过当作旧产物已删除的证据。确认服务、执行器调用数与终态行为没有变化。

### 阶段 3：按行为域复核其余 23 个候选

每次只处理一个小域：旧 stream/输入拼接；确认与决策缓存；Remote/IM；Renderer 待确认；Shared 逻辑；Session projection 诊断；metrics。对每一项制作断言迁移映射表：

| 删除前必须回答 | 放行条件 |
|---|---|
| 当前线上由哪个函数、IPC handler、worker 或脚本承担相同行为？ | 给出具体生产调用链，不以同名单元测试替代 |
| 旧测试测的是算法，还是也测了 channel、payload、身份、时序等接线？ | 接线专属断言保留为现行 caller/wrapper smoke |
| 是否涉及旧数据库/配置/History/JSONL 数据？ | 迁移和恢复读路径有旧数据 fixture；确认窗口期与版本合同已结束 |
| 删除后错误是否仍 fail closed，撤权/取消是否仍阻止 executor？ | 真实执行边界回归验证，不只测 helper 返回值 |

阶段门槛：优先按仓库既有清理规则执行“先补接线 smoke → 定向通过 → 再删旧测试/实现”。每个包含 Electron 模块删除的独立交付批次，在定向测试和增量开发检查后必须执行 `npm run build:electron` 清洁构建；记录源文件删除项与输出中对应 `.js`、`.js.map` 均已消失。IM、真实通知、worker 启停、打包 preload 等跨运行时路径需从该次干净构建产物验收，不以 jsdom 或 Node 单测代替。

### 阶段 4：增加防回流门禁并最终验收

只有阶段 0 的入口清单稳定后，才决定是否新增轻量源码图检查。检查需读取 TS import/re-export、package exports、Vite HTML entries、Electron `loadFile`/preload、Worker 路径、npm scripts 和 typecheck/test setup；允许名单显式写原因，避免再把动态入口误判成死文件。此门禁只负责报告候选，不能自动删文件。

最终验收必须在所有源码删除后运行 `npm run build`。该命令通过 `build:electron` 先清理 `dist-electron`，并重建 renderer 与主进程产物。验收清单逐项核对：

1. 删除清单中的 Electron 源文件，其 `dist-electron/<相对路径>.js` 与 `.js.map` 不存在；类型声明等本来不生成 JS 的文件标注为不适用。
2. 本次干净构建生成的 renderer 产物中，不再含已删除模块的代码/导出；对 Vite chunk 记录实际核对方式和结果。
3. 从这次干净产物执行所需的 Electron 主进程、preload、Worker 与 UI 冒烟验收；外部 IM 验收也必须使用这次干净构建，不能使用旧 `dist-electron`。
4. 将 clean build 结果、产物缺失检查和运行时验收结果写入各阶段交付记录。

`build:electron:incremental` 只作为开发期编译反馈：它不清理 `dist-electron`，删除源文件后可能遗留对应旧 JS/map。每个删除阶段要么执行 `npm run build:electron`，要么有明确、可复核的等价产物清理与干净构建证据；最终 `npm run build` 是强制门槛，不能以增量构建或定向测试替代。

每个已批准阶段独立提交，提交中包含实现/删除、断言迁移和验证结果。阶段收尾按仓库测试策略合并跑相关测试；全量 `npm test` 只安排在阶段收尾或最终验收，不作为每步循环。

## 6. 验收范围

| 本地可验证 | 需要真实运行环境或外部系统 |
|---|---|
| 干净 `npm run build`；删除清单对应 JS/map 缺失检查；TypeScript 引用、导出及构建产物闭包；Electron/Renderer/SDK 定向测试；IPC/preload 通道合同；SQLite fixture 与重启恢复；模拟 Worker 生命周期；renderer 审批 stale-version 拒绝 | 从干净构建产物启动 Electron 并验证 preload；不同平台 Worker 启动/终止；真实飞书/微信账号的入站、异步审批与通知回执；旧用户 profile/数据库上的迁移兼容；依赖原生 UI 的浮窗交互 |

清理实现开始前要为每个候选模块选定所需的验收形态。只有本地静态/单测证据的模块，不能据此宣称真实 IM 或旧 profile 的兼容性已验收。

## 7. 已知限制与当前状态

- 本次复核基于 `main@ebdff6fa`；复核时产品源码与该提交一致。相较初次盘点，已将基线和数量更新为 1,083 个非测试源码、56 个静态无入口模块、28 个待复核候选及 277 个去重未使用诊断位置。
- 本次没有删除/修改产品代码，没有运行测试或构建，也没有执行真实 IM、目标用户 profile 或打包 preload 验收。临时未使用扫描因这些既有诊断返回非零；它不是标准项目 typecheck 结果。
- 仓库既有 [测试清理审计](./automated-test-suite-cleanup-audit.md) 规定薄包装清理前必须先补接线 smoke；既有 [Run Shell/工具生命周期计划](./run-shell-dialect-mismatch-false-positive-and-fatal-turn-abort-improvement-plan.md) 已将 `createAgentSdkTurnDispatch` 路径更正为错误依赖图。本方案沿用这些现有证据和门槛。
- [本方案评审](../review/main-dead-code-cleanup-audit-and-plan-2026-10-14-review.md)提出的 P1 初始化器副作用和 P2 干净产物验收阻断已分别写入阶段 1、阶段 2/3 与阶段 4 门槛。评审核查的是 `879c7d04`；本次对当前 `main@ebdff6fa` 重跑源码图和未使用扫描，确认 56/28 模块统计仍成立、未使用诊断为 277 个（较初次结果变化 1 个）。模块删除放行仍以逐项行为证据为准。
