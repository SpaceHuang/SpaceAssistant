# Provider 重试退避执行计划

> 方案真源：[provider-retry-backoff-plan.md](../develop/agent-sdk/in-flight/provider-retry-backoff-plan.md)。本计划只安排工作、依赖与证据；行为、事件契约、AC 和阶段出口以方案为准；任务顺序与依赖以本计划为准。基线：2026-10-30 工作区，HEAD `0d189776`，方案文件 SHA-256 `14f240d22b4713fc09fea26b49d8accc5cb0d2da1a6cead8623570d5b46a0184`（含未提交修改）；开始实施前重新记录基线，若变化则重新核对本计划。

## 阅读入口 【人必读】

目标：模型请求遇到可恢复故障时，按已批准的次数、等待上限和回合预算重试，留下可对账的尝试记录，并在聊天中显示恢复状态。

执行顺序以本计划的依赖表为准：先完成计数与审计，再完成单次上限和回合预算，最后完成卡片。`AC-27` 的完整验收放在余额实现之后；阶段 1 只验收已实现的计数部分，不宣称整条 AC 已通过。卡片容器缺失时，在已批准的界面归属与交互范围内本地实现所需容器，不等待另一项目进度。

需要负责人决定的新增产品取舍：**无**；如规格冲突的修订改变已批准行为或界面，回到方案按项目规则审批。执行者负责代码核查、测试、证据和回退演练。

## 验收边界与工作约定 【人机共读】

- **本机**：模拟 provider、注入时钟和随机源、故障注入、SQLite 历史重放及渲染测试可验证方案 AC；这些是源码阶段出口。先确认依赖安装、Node/npm 与 Electron 构建环境可用。
- **外部**：真实服务商限流分布、实际收费和压缩调用叠加观察对应方案 `U-2`、`U-3`，需要真实服务商/数据，另记证据，不作为源码开发前置门禁。真实渠道和跨平台安装包不在本计划的本机验收承诺内。
- 不实现超过五次尝试或设置项，不新增方案以外的 IPC；任何方案未定义的行为或契约冲突先登记并修订方案，不由执行计划代为裁决。
- 状态只用 `- [ ]`、`- [～]`、`- [x]`；完成时在对应证据栏记录命令、结果、提交号和产物。测试与路径变化先记录再更新计划，不把预期失败当作通过。
- 以下任务为单一开发工作流；每阶段完成后在干净的独立提交中提交本阶段改动，保留用户既有改动。提交前遵守仓库的全量验收与代码评审要求。回退演练使用隔离工作树或临时分支，绝不覆盖当前工作区。
- 测试命令采用仓库 Vitest 指定文件；任务实施时若新建测试文件，必须加入该任务命令并记录。开发期间合并定向测试；每阶段最多一次主进程增量构建，阶段收尾或提交前才运行全量测试。

## 依赖表 【机｜人工可跳过】

下表是任务依赖的唯一真源；阶段出口所需证据均由更早任务产生。G0 核对实际行为冲突；阶段出口按已同步方案 §2.7 核对。依赖中的 G 表示门禁通过，T 表示任务完成。

| ID | 前置 | 目标 |
|---|---|---|
| T0 | 无 | 环境、代码入口与现有测试基线 |
| G0 | T0 | 核对零余额与单次上限的行为冲突 |
| T1 | T0 | 计数、重试策略、审计与用量链路 |
| T2 | T1 | 新事件的后端消费、重放和修复 |
| G1 | T2 | 阶段 1 验收、回退演练与提交 |
| T3 | G1 | 原始 Retry-After、单次上限与错误返回 |
| G2 | T3 | 阶段 2 验收、回退演练与提交 |
| T4 | G2、G0 | 回合余额与边界矩阵 |
| G3 | T4 | 阶段 3 验收、回退演练与提交 |
| G4a | T0 | 定位现有容器或确定本地实现范围 |
| T5 | G3 | 事件时序、终结及失败处理 |
| T6 | T5、G4a | 卡片投影、重建、国际化及交互 |
| G4 | T6 | 阶段 4 验收、回退演练与提交 |
| T7 | G4 | 全链路本机最终验收和绕过通道检查 |
| T8 | T7 | 源码关闭、回退记录及交付 |
| X1 | T8 | 可选外部观察；不作为本机门禁 |

## 与方案阶段安排的差异 【人机共读】

| 方案安排 | 本计划安排与原因 |
|---|---|
| 原方案阶段 1 将完整 `AC-27` 列为出口，阶段 3 才实现余额 | 方案 §2.7 已同步：G1 检查计数部分，G3 在真实余额实现后验收完整 `AC-27`，避免依赖未来产物。 |
| 原方案将 `not-dispatched` 和卡片终结放在阶段 4 | 方案 §2.7 已同步：T4 先完成余额拒绝的未派发审计，以满足 `AC-14`；T5–T6 完成其余终结和卡片呈现。 |
| 阶段 4 依赖压缩方案的系统操作卡片，缺失时推迟或自带 | G4a 提前核查；现有容器可用则复用，否则在批准的入口、外观和交互范围内由 T6 本地构建最小可复用容器，使用本机组件测试验证。不把另一项目完成作为开发门槛；若核查发现必须改变已批准界面语义，再单独处理审批。 |
| 最终验收置于各阶段完成之后 | 本计划保留各阶段本机出口，同时单列最终跨入口测试和隔离回退；真实服务商观察不阻塞源码关闭。 |

## 任务登记 【机｜人工可跳过】

每项默认环境为本机；目标目录同时限定允许改动范围。涉及新文件时，先用 `rg --files` 定位已有归属，并把实际路径登记在证据栏；若范围需扩展，先记原因。方案引用均指方案 §2.6 的原 AC。

### 基线与规格门禁

- [x] **T0｜建立可复现基线**。范围：只读 `package.json`、`vitest.config.mts`、`packages/agent-sdk/src/`、`electron/runtime/`、`electron/sessionLedgerOutbox.ts`、`src/renderer/`、方案及计划；记录 `git status --short`、`git rev-parse HEAD`、方案哈希、Node/npm 版本、现有用户改动和调用路径。核查 `recoverProviderAttempt` 的主回合、审批子代理、定时任务、续跑及 adapter 重试入口；确认目标测试存在。依赖就绪判据：依赖已安装且项目命令可启动；缺失时按仓库常规安装依赖，记录版本与结果。基线命令：`npm exec vitest run packages/agent-sdk/test/turn.test.ts packages/agent-sdk/test/history.test.ts electron/runtime/agentSdkProviderRecovery.test.ts electron/runtime/sqliteAgentHistory.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/sessionLedgerOutbox.test.ts`。失败时区分环境故障与既有失败，记录测试名、日志、影响，不将既有失败计为目标行为的 RED。
  - 产物 / 完成判据：基线记录、入口清单及测试结果；关联 AC-3、AC-9、AC-11、AC-28a 的现状核查，不声称已满足最终 AC。
  - 证据：worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/provider-retry-backoff`；`HEAD=0d1897769485450ed02127eeed687f16b214661e`；方案 SHA-256 `14f240d22b4713fc09fea26b49d8accc5cb0d2da1a6cead8623570d5b46a0184`；计划 SHA-256（基线）`8791bdd6827f0d69d9d07b79511c39d64c71c335f99b2ba063d223f5da410336`；Node `v26.4.0`、npm `11.17.0`。依赖初始缺失，`npm ci` 成功（1086 packages；有仓库依赖既有的 peer/deprecation 与 audit 警告）。指定基线命令 6 个文件通过：6 files / 455 tests。调用路径：主回合在 `packages/agent-sdk/src/turn.ts`；共享端口沿 `invocation.ts` → `electron/runtime/hostedAgentTurnHost.ts` / `invocationAssembler.ts`，宿主恢复实现在 `electron/runtime/agentSdkProviderRecovery.ts`；现有测试文件均存在。工作区原有未提交项留在主 worktree，没有带入此 worktree；两个方案文档按已核对哈希作为本任务输入。
- [x] **G0｜核对错误码优先级**。范围：方案 §2.2、§2.4、AC-14 和本计划；零余额且候选超过单次上限时，两处文字可能要求不同错误码。先核对已批准决策和上下文；若仍有冲突，按文档规范修订方案并复读，明确唯一返回码及回归用例。仅影响涉及该裁决的实现，不要求为阶段顺序差异修改方案；如果修订改变已批准行为，按项目规则处理审批。完成判据：记录核对结论、方案哈希和可执行断言。
  - 证据：方案 §2.4 裁决顺序第 3 步先判 `candidate > singleCapMs`，第 4 步才判 `remainingMs <= 0`，故二者同时成立时错误码唯一为 `PROVIDER_RETRY_AFTER_EXCEEDS_SINGLE_CAP`；余额错误码适用于未超单次上限的候选。可执行断言：120 秒服务端要求 / 60 秒单次上限始终返回超单次上限码（AC-16）；45 秒要求 / 20 秒余额且未超单次上限返回预算耗尽码并带 `retryAt`（AC-17）。方案哈希同 T0。无需修订规格。

### 阶段 1：尝试模型与后端审计

- [x] **T1｜实现统一尝试与审计链路**。范围：`packages/agent-sdk/src/turn.ts`、`history.ts`、`invocation.ts` 及相关导出/类型，`electron/runtime/agentSdkProviderRecovery.ts`，`packages/agent-sdk/test/turn.test.ts`、`history.test.ts`、`electron/runtime/agentSdkProviderRecovery.test.ts`；以 T0 的调用路径补齐必要的直接调用方。按方案接通首次/恢复来源、物理上限和分类计数，注入时钟与随机源，生成每次实际尝试结果并按 attempt 去重累计 usage；覆盖无 usage、部分流、丢弃响应、首次认证失败和混合序列。先增加可达的目标用例并记录预期失败，再实现；没有自然 RED 时记录原因，不人为制造失败。
  - 产物 / 完成判据：针对 `AC-1`、`AC-4`、`AC-5`、`AC-21`、`AC-23`、`AC-25`、`AC-29` 的内核/策略用例通过；`AC-27` 的物理和分类计数部分用随机序列验证；完整 AC 待 T4 的真实余额链路通过。定向命令：`npm exec vitest run packages/agent-sdk/test/turn.test.ts packages/agent-sdk/test/history.test.ts electron/runtime/agentSdkProviderRecovery.test.ts`；`npm run typecheck:agent-sdk`；`npm run check:agent-sdk`。
  - 证据：RED：`npm exec vitest run electron/runtime/agentSdkProviderRecovery.test.ts` 在新「5 次 + 抖动 + recoveryKind」用例上因实际 `maxAttempts=3` 且缺 `plannedWaitMs/recoveryKind` 失败（其余 9 tests pass）；新 History kind、重放幂等、SQLite usage 源和 outbox target 用例也分别在实现前失败。GREEN：`npm exec vitest run packages/agent-sdk/test/turn.test.ts -t "silent-overflow response before model History commit"` 通过，证明 provider-attempt-result 是 usage 唯一累计点；六文件合并定向运行（turn、history、providerRecovery、sqliteAgentHistory、sessionLedgerOutbox、desktopObserver）6 files / 462 tests passed；`npm run typecheck:agent-sdk` 与 `npm run check:agent-sdk` 通过。混合序列使用固定种子 Fisher-Yates，验证四类恢复计数与物理上限。提交前阶段门禁仍待 G1。
- [x] **T2｜接入后端消费与修复**。范围：`electron/runtime/sqliteAgentHistory.ts`、`electron/runtime/agentSdkDesktopObserver.ts`、`electron/sessionLedgerOutbox.ts`、`electron/runtime/sessionLedgerOutboxProjector.ts` 及对应测试 `electron/runtime/sqliteAgentHistory.test.ts`、`electron/runtime/agentSdkDesktopObserver.test.ts`、`electron/sessionLedgerOutbox.test.ts`；必要的共享账本类型以 T0 核查为准。覆盖读取组装、投影校验、修复、外发、观察者关联、未知 kind 和重复结果。数据库 kind 为文本的假设重新核对；若不成立，停止并修订方案。
  - 产物 / 完成判据：`AC-28a` 每个后端消费点有独立可定位用例，`AC-25` 的持久化重放及用量去重通过。命令：`npm exec vitest run electron/runtime/sqliteAgentHistory.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/sessionLedgerOutbox.test.ts packages/agent-sdk/test/history.test.ts`。
  - 证据：RED：SQLite canonical context meter 在实现前未从 provider-attempt-result 读取 usage；outbox 在实现前未为该事件生成 request-usage target；History 拒绝新 kind。GREEN：六文件合并定向运行 6 files / 462 tests passed，覆盖 SQLite canonical 读取/旧镜像去重/修复、outbox 实际投影及桌面观察者 requestId/attempt/outcome 关联；数据库 kind 为文本并经现有 JSON event envelope 持久化。`sessionLedgerOutboxProjector` 沿用通用 request-usage 投影器，由端到端投影断言覆盖。
- [x] **G1｜阶段 1 关闭**。证据来自 T1、T2 的 AC-1、AC-4、AC-5、AC-21、AC-23、AC-25、AC-28a、AC-29 和 AC-27 计数部分；完整 AC-27 留给 G3；补跑其定向用例、`npm run build:electron:incremental`，并按阶段收尾规则执行 `npm test`。在隔离工作树演练仅回退本阶段提交候选的代码，验证回退后旧事件读取和既有用量路径；记录命令与结果。检查未混入其他工作区修改后提交本阶段，记录提交号。阶段 4 的卡片和 `INV-8` 不在此门禁内。
  - 证据：`npm run build:electron:incremental` 通过（Pi AI runtime closure、session-storage cleanup/module graph 边界门禁及 Electron TypeScript 编译）；`npm test` 通过，1228 files passed / 1 skipped，11841 tests passed / 140 skipped，约 20m55s，运行中 Node 报 `MaxListenersExceededWarning` 但退出码为 0。阶段 1 代码提交 `b746a2617898ddf9fd5004e1a236210bdb1d3067`。隔离回退：临时 worktree 在该提交上执行 `git revert --no-edit b746a2617898ddf9fd5004e1a236210bdb1d3067`，再运行 `npm exec vitest run electron/runtime/sqliteAgentHistory.test.ts electron/sessionLedgerOutbox.test.ts packages/agent-sdk/test/history.test.ts`，3 files / 255 tests passed，验证旧事件读取、outbox 和 History 路径；临时 worktree/分支已删除。提交前 `git diff --check` 通过；评审检查未发现阶段阻断项。

### 阶段 2：服务端等待与单次上限

- [x] **T3｜保留原始等待值并接通单次裁决**。范围：`electron/runtime/agentSdkProviderRecovery.ts`、`packages/agent-sdk/src/turn.ts`、相关错误码/端口定义及两侧对应测试。覆盖 Retry-After 数值和 HTTP-date、45 秒精确等待、120 秒超限、无提示不编造时间，验证拒绝时 provider 未再次调用。测试注入时钟，不真实等待。
  - 产物 / 完成判据：`AC-2`、`AC-16`、`AC-17` 的时间解析部分。命令：`npm exec vitest run electron/runtime/agentSdkProviderRecovery.test.ts packages/agent-sdk/test/turn.test.ts`；类型或边界变动时运行 `npm run typecheck:agent-sdk` 和 `npm run check:agent-sdk`。
  - 证据：RED：新增 45 秒与 120 秒边界用例，旧代码分别把 45 秒截为 30 秒、把 120 秒错误安排为 30 秒重试。GREEN：两文件定向运行 180 tests passed；覆盖 HTTP-date 注入时钟、45 秒精确调度（集成捕获实际 `setTimeout` 参数）、120 秒单次上限拒绝、`serverAskedMs` / `retryAt` 透传及拒绝后 provider 调用次数仍为 1。`npm run typecheck:agent-sdk`、`npm run check:agent-sdk` 通过。
- [x] **G2｜阶段 2 关闭**。证据来自 T3；执行定向测试、`npm run build:electron:incremental`、`npm test`。在隔离工作树回退阶段 2，确认阶段 1 的审计与重试测试仍通过，记录回退对象和结果；提交阶段 2。
  - 证据：`npm run build:electron:incremental` 通过；`npm test` 通过，1228 files passed / 1 skipped，11845 tests passed / 140 skipped，约 25m48s，期间 Node `MaxListenersExceededWarning` 不影响退出码。阶段 2 代码提交 `13920bf0aa26efa53a8813260fbdfb23da88919f`。隔离回退：临时 worktree 在该提交上执行 `git revert --no-edit 13920bf0aa26efa53a8813260fbdfb23da88919f` 后运行五组测试（providerRecovery、sqliteAgentHistory、sessionLedgerOutbox、turn、history），5 files / 435 tests passed，阶段 1 审计与退避保持有效；临时 worktree/分支已删除。`git diff --check` 通过，评审未发现阶段阻断项。

### 阶段 3：回合等待预算

- [x] **T4｜实现回合余额与边界**。范围：`packages/agent-sdk/src/turn.ts`、`invocation.ts`、相关宿主恢复端口及 `packages/agent-sdk/test/turn.test.ts`、`electron/runtime/agentSdkProviderRecovery.test.ts`。覆盖跨 modelTurn 共享、单调时钟实耗扣减、取消、实测超支、恰好耗尽、零余额与零/正候选、各专用恢复；按 G0 明确的顺序断言返回码、是否派发、审计与计数。加入随机操作序列及状态不变量，并固定随机种子以便复现。
  - 产物 / 完成判据：`AC-7`、`AC-13`、`AC-14`、`AC-15`、`AC-17` 的超余额部分及完整 `AC-27`；实现零余额拒绝的 `not-dispatched` 记录，断言不增加物理及分类计数。命令：`npm exec vitest run packages/agent-sdk/test/turn.test.ts electron/runtime/agentSdkProviderRecovery.test.ts`；`npm run typecheck:agent-sdk`。
  - 证据：RED：新增跨 modelTurn 40s + 30s、零余额 0ms、计划恰好耗尽、专用 idle-timeout 零等待及种子随机预算状态序列；实现前余额始终被传为 `Infinity`，跨回合超额等待仍派发并成功。GREEN：`npm exec vitest run packages/agent-sdk/test/turn.test.ts electron/runtime/agentSdkProviderRecovery.test.ts` 2 files / 185 tests passed；覆盖跨 modelTurn 保持 20s 余额、超过余额不派发并写 attempt 2 的 `not-dispatched`、provider 正常耗时不扣预算、等额等待仍执行、等待实测超支 1s 写 `waitBudgetOverrunMs`、零预算拒绝与专用零等待例外；`npm run typecheck:agent-sdk`、`npm run check:agent-sdk` 通过。随机不变量测试以固定种子验证 1000 次扣减后余额范围、单调性和公式。
- [x] **G3｜阶段 3 关闭**。证据来自 T4 的 AC-7、AC-13、AC-14、AC-15、AC-17 超余额部分及完整 AC-27；执行定向测试、`npm run build:electron:incremental`、`npm test`。在隔离工作树回退阶段 3，验证阶段 2 单次上限与阶段 1 记录仍有效；提交阶段 3。
  - 证据：`npm run build:electron:incremental` 通过；`npm test` 通过，1228 files passed / 1 skipped，11850 tests passed / 140 skipped，约 26m30s，Node `MaxListenersExceededWarning` 不影响退出码。阶段 3 代码提交 `17ba6087ab9711523cfa2aff4ede8e558a78790a`；事件字段补充文档提交 `d725bc6c8baae061963ee3e5cb3668dfb380493c`。隔离回退：临时 worktree revert 阶段 3 提交后运行五组测试（providerRecovery、sqliteAgentHistory、sessionLedgerOutbox、turn、history），5 files / 439 tests passed，阶段 2 单次上限与阶段 1 记录仍有效；临时 worktree/分支已删除。`git diff --check` 通过，评审未发现阶段阻断项。

### 阶段 4：事件时序与界面

- [x] **G4a｜定位或准备本地卡片容器**。范围：只读压缩方案及 `src/renderer/components/Chat/`、`src/renderer/services/`、共享显示类型。记录可复用容器、重建入口与测试；不存在时登记 T6 本地实现最小可复用容器的具体文件范围，保持方案附录 E 已批准的入口、状态和折叠交互。此核查不要求压缩方案落地；只有发现必须改变已批准界面语义时，才停止依赖该变更的部分并按项目规则处理。完成判据：有可执行的本地实现路径及测试文件清单。
  - 证据：复用 `src/renderer/components/Chat/SystemOperationRow.tsx` 与 `ChatBubble.tsx` 中的 activity timeline 容器；`Message.systemOperations` 已由共享类型、assistant activity timeline 与 turn display protocol 投影。T6 只扩展 `SystemOperationRecord` 联合类型、行内容和现有容器，不新建消息布局。现有测试基点：`SystemOperationRow.test.tsx`、`src/shared/assistantActivityTimeline.test.ts`、`turnProjectionService.test.ts`、`turnDisplayReconciliation.test.ts`；T6 增加 retry 操作渲染与恢复测试。
- [x] **T5｜接通安排、等待和终结时序**。范围：`packages/agent-sdk/src/turn.ts`、`history.ts`，`electron/runtime/agentSdkDesktopObserver.ts`、`sqliteAgentHistory.ts`、相关账本投影及对应测试。验证先追加安排再等待、追加失败不派发、等待取消、未派发终结、结果追加失败、重启/旧账本恢复及同请求关联；保持模型 transcript 不含重试事件。
  - 产物 / 完成判据：`AC-18`–`AC-20`、`AC-22`、`AC-24`、`AC-26` 的后端时序及记录部分；界面部分留给 T6。命令：`npm exec vitest run packages/agent-sdk/test/turn.test.ts packages/agent-sdk/test/history.test.ts electron/runtime/sqliteAgentHistory.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/sessionLedgerOutbox.test.ts`。
  - 证据：RED/GREEN：`packages/agent-sdk/test/turn.test.ts` 新增排程事件追加失败、取消不派发、结果记录追加失败等边界测试；`agentSdkDesktopObserver.test.ts` 覆盖重试卡片同 requestId 原地更新与成功/取消投影；`sqliteAgentHistory.test.ts` 覆盖结果幂等、旧路径回放和事件消费。G4 回退演练在隔离 worktree 对 `a5323dc9` 执行 `git revert --no-commit a5323dc9` 后运行 6 个相关套件，6 files / 471 tests passed，旧 UI、History、outbox 与 Agent SDK 路径可用；临时 worktree 已删除。阶段实现提交 `a5323dc9`。
- [x] **T6｜接通重试卡片与历史重建**。范围：G4a 确认的 `src/renderer/components/Chat/` 卡片容器、`src/renderer/services/turnProjectionService.ts` 及重建链路、所需 `src/shared/` 显示类型、`src/renderer/i18n/resources/{zh-CN,en-US}/`、生成的 i18n 类型及对应测试。复用已有容器；若缺失则在已批准界面范围内创建最小可复用容器；覆盖等待可见、连续重试原地更新、成功折叠、失败、取消、崩溃重建、旧账本及不泄露服务端原文。
  - 产物 / 完成判据：`AC-12`、`AC-18`–`AC-20`、`AC-24`、`AC-26`、`AC-28b` 的界面用例通过。命令：`npm exec vitest run src/renderer/services/turnProjectionService.test.ts src/renderer/services/turnDisplayReconciliation.test.ts`，并加入 G4a 确认的组件测试；`npm run i18n:generate-types`、`npm run i18n:check`、`npm run typecheck:renderer`。
  - 证据：RED/GREEN：`SystemOperationRow.test.tsx` 覆盖运行中等待、成功、失败、取消、中断和结果未知文案；`electron/runtime/sessionTranscriptProjection.test.ts` 覆盖同 requestId 连续更新、崩溃后中断、unknown-after-dispatch 结果未知、旧账本只保留安排事实及 SQLite 消息页重建；`agentSdkDesktopObserver.test.ts` 覆盖实时投影。定向验证：`npm exec vitest run packages/agent-sdk/test/turn.test.ts packages/agent-sdk/test/history.test.ts electron/runtime/sqliteAgentHistory.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/sessionLedgerOutbox.test.ts` 6 files / 471 tests passed；渲染投影、重建与组件定向测试通过。`npm run i18n:generate-types`、`npm run i18n:check`、`npm run typecheck:renderer`、`npm run check:agent-sdk`、`npm run typecheck:shared`、`npm run build:electron:incremental` 均通过。
- [x] **G4｜阶段 4 关闭**。证据来自 T5、T6；合并运行对应定向测试、`npm run build:electron:incremental`、`npm run typecheck:renderer`、`npm run i18n:check`、`npm test`。在隔离工作树回退阶段 4，验证阶段 1–3 后端及旧界面可运行；若回退留下无法读取的持久化事件，停止并先修订迁移/回退方案。提交阶段 4。
  - 证据：阶段 4 `npm test` 通过（1228 files passed / 1 skipped，11858 tests passed / 140 skipped）；期间有 Node `MaxListenersExceededWarning`，Vitest 退出码为 0。阶段实现提交 `a5323dc9`；G4 隔离回退及旧账本兼容证据见 T5/T6。

### 最终验收与交付

- [x] **T7｜完成端到端本机验收**。范围：各阶段测试及 T0 确认的调用入口；验证 `AC-3`、`AC-6`、`AC-8`、`AC-9`、`AC-10`、`AC-11`，复核全部方案 AC 与阶段证据的映射，覆盖主回合、审批子代理、定时任务、续跑及 adapter 无内部重试。命令：按 T0 查到的具体入口测试追加至 `npm exec vitest run`；执行 `npm run check:agent-sdk`、`npm run typecheck:shared`、`npm run i18n:check`、`npm test` 和 `npm run build`。记录每个 AC 的测试名、命令、结果及未覆盖项；发现不可达或规格冲突时回方案修订。
  - 证据：入口矩阵 GREEN：主 turn/静默 overflow 用例 `electron/claudeStreamHandlers.hostedIntegration.test.ts`「recovers a Desktop Hosted silent overflow and rolls back its provisional text」；审批子代理 429 重试及 canonical schedule event `electron/confirmation/approvalAgent.test.ts`；定时任务 Hosted 重试 `electron/butler/butlerInvoker.test.ts`；续跑目标 turn 429 重试和 checkpoint 工具结果不重放 `electron/toolChatLoop.invocation.test.ts`「从已结算 checkpoint 续跑时携带真实工具结果，且隔离目录中的写入不重放」；adapter 一次 wire attempt 且错误不泄漏 `packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts`「makes one wire attempt on provider failure and normalizes errors without leaking response text」。T7 对应定向运行均通过；最终续跑文件 27 tests passed。`npm run check:agent-sdk`、`npm run typecheck:shared`、`npm run i18n:check` 及 `npm run build` 通过。最终 `npm test`：1228 files passed / 1 skipped，11859 tests passed / 140 skipped，1213.10s，退出码 0；出现既有 `MaxListenersExceededWarning`。源码 AC 映射见技术方案 §2.6 与各阶段 T1–T7 证据；没有真实服务商流量/收费数据，归外部项 X1。
- [x] **T8｜完成源码关闭和交付**。范围：本计划证据、各阶段提交及隔离回退演练记录；复核 G1–G4 和 T7 的命令结果、提交号、工作区差异与未解决问题。按仓库代码评审要求完成评审并处理阻断项；确认各阶段可回退实体和旧数据兼容证据，记录外部项。源码关闭后才可进入发布/启用流程；本计划不授权发布。
  - 证据：实现提交：`b746a261`、`7904aeb9`、`13920bf0`、`f2c5c8b2`、`17ba6087`、`819f1c01`、`d725bc6c`、`6f4b9909`、`a5323dc9`、`128d9cb3`；提交前完成 `code-review-and-quality` 五轴评审及修复。2026-10-30 合并前复审又发现两项边界缺陷：失败流已报告 usage 未进入 attempt result / 回合汇总；流因取消或超时抛错时已派发尝试缺少结果记录。修复分别保留每个物理 attempt 的 usage 并生成账本 sidecar、在首次与恢复请求异常取消路径结算已派发尝试；未派发路径不记作 physical attempt。回归用例在 `packages/agent-sdk/test/turn.test.ts`，覆盖 usage 后断连再成功（汇总 12/4）、usage 后取消/超时、无 usage 取消、恢复尝试取消及结果不重复。修复后该文件 178 tests passed；评审相关六文件 558 tests passed / 6 skipped；`npm run typecheck:agent-sdk`、`npm run check:agent-sdk` 通过；最终 `npm test` 通过，1228 files passed / 1 skipped，11864 tests passed / 140 skipped（1162.81s，退出码 0）。期间有 Node `MaxListenersExceededWarning`。重试事件以兼容的文本 kind + JSON event envelope 存储，旧账本无结果时仅展示已知安排、不推断。各阶段隔离回退对象与命令见 G1–G4；外部观察 X1 仍未执行。
- [ ] **X1｜记录真实服务商观察**（外部，非源码门禁）。在具备授权账号和适当数据后观察方案 `U-2` 的限流分布及收费；压缩方案落地后观察 `U-3`。记录环境、样本范围、时间和结论，避免将模拟结果说成真实收费证据。
  - 证据：未执行真实服务商请求；当前没有授权账号和适当生产样本，也未获准产生可能计费的请求。模拟测试不能作为限流分布或收费证据。此项按依赖外部授权和数据的非源码门禁保留，源码关闭不受阻塞。

## 阶段范围与回退摘要 【人机共读】

| 阶段 | 输入 / 产物 | 允许变更 | 清理与回退 |
|---|---|---|---|
| 1 | 基线方案；计数、退避、结果事件与后端消费（完整 AC-27 在阶段 3） | T1、T2 所列内核、宿主、账本和测试 | 移除被统一累计替代的重复用量路径；回退本阶段提交，验证旧账本及原有链路 |
| 2 | G1；原始服务端值、单次裁决 | T3 所列策略、端口、测试 | 移除两处旧 30 秒钳制；回退本阶段提交恢复旧上限 |
| 3 | G2；回合余额、未派发审计和完整 AC-27 | T4 所列内核、端口、测试 | 不移除历史兼容代码；回退本阶段提交恢复阶段 2 行为 |
| 4 | G3、G4a；事件时序和卡片（容器可本地实现） | T5、T6 所列事件、投影、UI、翻译、测试 | 移除旧的等待后安排顺序；回退本阶段提交并核对已写新事件的旧版读取 |

每阶段的回退演练均在隔离环境进行，不能仅凭 `git revert` 命令成功证明数据兼容。阶段 5（突破五次）按方案不排入本次执行。
