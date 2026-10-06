# A-09：运行时、IPC/数据库接线与构建配置归属审阅

- 日期：2026-10-05
- 输入冻结：[`session-storage-a00-review-input-freeze.md`](./session-storage-a00-review-input-freeze.md)，122 个原有工作区路径；本报告及 A-01…A-08 报告属于冻结后新增记录。
- 审阅方式：静态核对 `git diff`、冻结清单分类及 `origin/main` 内容；未运行测试、未改产品代码、未删除或覆盖已有改动。
- 结论：A-09 文件归属审阅完成；没有新增正确性 finding。报告中标记为“集成冲突”的路径应在 B 阶段按受影响切片合并解决，不能算作存储重构的新功能任务。

## 主线集成与跨层持久化交叉点（逐路径归属）

| 路径 | 归属与处理 |
| --- | --- |
| `electron/appIpc.sessionUpdate.test.ts` | 会话更新边界测试；存储 IPC/metadata 安全交叉点，纳入集成回归。 |
| `electron/database/index.ts` | 存储实现：只读数据库入口导出。 |
| `electron/database/migrations.agentHistory.test.ts` | 存储实现 + schema 冲突：canonical History 与上游迁移兼容覆盖；I 阶段保留两边迁移。 |
| `electron/database/migrations.sessionContentCutover.test.ts` | 存储实现：正文 cutover 状态迁移。 |
| `electron/database/migrations.sourceTruthSpillGc.test.ts` | 存储实现：spill GC schema 回归。 |
| `electron/database/migrations.ts` | 存储实现 + 必要主线冲突：canonical schema 迁移与 continuation/Butler/usage schema 共存；需以顺序迁移保留两边字段。 |
| `electron/database/migrations.v11.test.ts` | 既有迁移回归，仅命名/预期随 schema 变化；集成时保留主线兼容语义。 |
| `electron/database/operations.test.ts` | 存储实现 + 上游 schema 回归：session/profile/usage/automation 持久化验收。 |
| `electron/database/operations.ts` | 存储实现 + 必要主线冲突：canonical projection 与 session/Butler/usage 数据操作共享 repository。 |
| `electron/database/schema.ts` | 存储实现 + 必要主线冲突：canonical schema 与上游 continuation、automation、usage 字段共用版本链。 |
| `electron/database/sqliteStore.ts` | 存储实现：只读连接入口及数据库配置。 |
| `electron/database/thinkingEffort.test.ts` | 既有功能回归；仅验证迁移后原字段仍可用。 |
| `electron/database/usageStatsFacts.test.ts` | 既有 usage 功能回归；存储迁移需保留模型身份字段。 |
| `electron/ipc/agentProtocolIpc.ts` | 混合：canonical message skeleton 读取属存储接线；retry/continuation IPC 属上游会话功能，按主线现有实现集成。 |
| `electron/ipc/sessionIpc.ts` | 混合：canonical 消息读写属存储接线；directory grant 与 context compaction 已在主线，集成复用上游实现及安全校验。 |
| `electron/main.ts` | 混合：storage cleanup boundary、观察记录和启动测量属存储；上游 IPC/服务注册按主线保留。 |
| `electron/messageCodec.ts` | 存储投影/消息编码交叉点；需保持既有消息字段语义。 |
| `electron/outbound/outboundAcceptor.test.ts` | 存储/主线交叉回归：canonical-only queue、稳定 request ID 与主线 continuation 行为。 |
| `electron/outbound/outboundAcceptor.ts` | 混合：durable queue/commit 属存储；continuation、retry、Butler route 等既有会话语义属主线集成。 |
| `electron/runtime/agentSdkUsageRecorder.test.ts` | 既有 usage 回归；确保存储迁移没有丢弃 attribution。 |
| `electron/runtime/agentSdkUsageRecorder.ts` | 既有 usage attribution 接线；与消息正文迁移正交。 |
| `electron/runtime/canonicalHistory.test.ts` | 存储实现 + 主线交叉：canonical History fold 与 invocation 行为回归。 |
| `electron/runtime/canonicalHistory.ts` | canonical History 读取；存储实现需保留主线 snapshot fold 语义。 |
| `electron/runtime/hostedTurnHandoff.test.ts` | 上游 Hosted handoff 回归；仅有跨层持久化影响时随集成运行。 |
| `electron/runtime/invocationAssembler.test.ts` | 存储/主线交叉：canonical history 装配及 invocation 上下文契约。 |
| `electron/runtime/invocationAssembler.ts` | 混合：canonical reader 属存储；directory grant/context 注入必须集成主线既有授权链。 |
| `electron/runtime/sessionTranscriptProjection.test.ts` | 存储实现：transcript projection 对拍。 |
| `electron/runtime/sessionTranscriptProjection.ts` | 存储实现：transcript projection/canonical reader。 |
| `electron/runtime/sqliteAgentHistory.test.ts` | 存储实现：History/canonical transaction、恢复与投影回归。 |
| `electron/runtime/sqliteAgentHistory.ts` | 存储实现：canonical History 持久化与修复。 |
| `electron/sessionBackupManager.test.ts` | 存储交叉回归：backup/restore 消费消息正文。 |
| `electron/sessionTitleSuggest.outlet.test.ts` | 主线产品语义 + 存储 reader 交叉；沿用主线标题策略，只验证 canonical reader 供数。 |
| `electron/sessionTitleSuggest.ts` | 混合：正文读取改走 canonical reader；标题门槛/产品策略留给主线，不能扩成存储重构独立功能。 |
| `electron/toolChatLoop.invocation.test.ts` | 主线工具循环 + canonical History 交叉回归。 |
| `electron/toolChatLoop.ts` | 混合：canonical invocation history 属存储；工具循环及重试语义按主线集成。 |
| `electron/turnCoordinatorStorage.test.ts` | 存储实现：Turn 与消息持久化适配。 |
| `electron/turnCoordinatorStorage.ts` | 存储实现：TurnCoordinator 的数据库适配。 |
| `electron/usageStats/usageStatsRecorder.test.ts` | 既有 usage 回归，需保留主线扩展字段。 |
| `electron/usageStats/usageStatsRecorder.ts` | 既有 usage 持久化；与正文迁移正交。 |
| `src/renderer/components/Chat/MessageInput.test.tsx` | 主线交互回归；只涉及续接状态入口时随集成复用，不属于 storage 功能。 |
| `src/shared/api.ts` | 混合 API 合约：storage maintenance IPC 属存储；主线 continuation/session API 随集成。 |
| `src/shared/assistantFactAggregator.ts` | 混合：canonical continuation summary 可作为已定主线 retry/continuation 合约；不可另起 UI/Agent 功能。 |
| `src/shared/domainTypes.ts` | 混合共享类型：session/storage 字段与上游 Butler/session 状态字段按各自主线保留。 |
| `src/shared/outboundProtocol.ts` | 主线 outbound/continuation 合约，与 storage durable queue 有交叉。 |
| `src/shared/skillHintRecords.ts` | 主线 continuation 状态记录；集成复用，不是存储重构新增范围。 |
| `src/shared/turnBoundaryCompaction.test.ts` | 主线 compaction 回归，持久化字段交叉时保留。 |
| `src/shared/turnBoundaryCompaction.ts` | 主线用户 compaction 算法；属于既有产品能力，与存储正文迁移正交。 |
| `src/shared/turnCoordinator.test.ts` | 主线 Turn/terminal recovery + durable storage 交叉回归。 |
| `src/shared/turnCoordinator.ts` | 混合：Turn 持久化/终态恢复交叉存储；retry/continuation 扩展按主线集成。 |
| `electron/database/migrations.mainSchemaCompatibility.test.ts` | 上游迁移与存储迁移兼容测试；仅用于验证共同 schema 版本链。 |
| `electron/sessionCompactionLock.test.ts`、`electron/sessionCompactionLock.ts` | 已有主线 compaction 并发控制，属于独立上游功能，不纳入 storage 新任务。 |
| `electron/sessionContextCompaction.test.ts`、`electron/sessionContextCompaction.ts` | 已有主线 context compaction；集成时复用，不改写为 storage feature。 |
| `electron/sessionContextSummary.test.ts`、`electron/sessionContextSummary.ts` | 已有主线 context summary；集成时复用，不改写为 storage feature。 |

## 构建/验证配置与资源边界（逐路径归属）

| 路径 | 归属与处理 |
| --- | --- |
| `.gitignore` | 存储发布边界：忽略仅由受控发布作业注入的 `release-input/`。 |
| `package.json` | 混合配置：cleanup boundary 检查及发布元数据打包属存储；其他 build/provider 命令按主线合并。 |
| `scripts/after-pack.cjs` | 存储发布边界：验证并写入 cleanup deployment/compatibility metadata。 |
| `scripts/session-storage-cold-start-profile.ts` | 存储测量工具：合成隔离 profile 冷启动/renderer 到达测量，不代表外部设备或 OS cache 实测。 |
| `scripts/session-projection-observation-report.ts` | 存储观察证据报告生成器。 |
| `scripts/session-projection-scope-profile-audit.ts` | 存储 profile scope 只读审计工具；真实用户 profile 执行仍需单独授权。 |

## 与 origin/main 的已存在能力

下列 10 个未跟踪文件与 `origin/main` 内容逐字节一致：

- `electron/sessionDirectoryGrants.ts`、`electron/sessionDirectoryGrants.test.ts`
- `src/shared/sessionDirectoryGrant.ts`、`src/shared/sessionDirectoryGrant.test.ts`
- `electron/sessionCompactionLock.ts`、`electron/sessionCompactionLock.test.ts`
- `electron/sessionContextCompaction.ts`、`electron/sessionContextCompaction.test.ts`
- `electron/sessionContextSummary.ts`、`electron/sessionContextSummary.test.ts`

目录授权与 context compaction 文件均为主线既有能力副本，不是当前分支新开发需求；工作区保持原样，B 阶段直接以 `origin/main` 的实现作为合入基线解决重复路径。目录授权入口/UI 不重写。continuation renderer 状态也按主线复用。标题策略遵循已定主线语义，存储侧只负责 canonical reader 供数。

## 范围结论

- 需作为本存储主线接入的改动：canonical schema/History/reader、durable queue 与事务边界、projection/backfill/cleanup/maintenance、安全发布 boundary、只读 profile/观察工具。
- 必须在集成时合并处理的冲突：schema 版本链、session IPC/API、Turn/continuation/outbound、invocation context、main 注册点。该清单是集成切片导航，不是可独立重做的产品功能。
- 既有无关但本地副本出现的工作：目录授权、session context compaction/summary、用户 compaction、标题产品策略、Hosted/Butler/usage 能力。不得另列为存储重构开发任务。
- 未发现本轮 A-09 产生的额外工作区路径或需要删除/改写的用户改动。A-00 冻结清单逐路径核对完毕；本报告新增后，当前工作区状态不再等同冻结快照。
- 新增 finding：无。既有 F-A01-01、F-A03-01、F-A05-01、F-A05-02、F-A06-01、F-A07-01、F-A08-01、F-A08-02 仍待 A-10 统一修复与复审。
