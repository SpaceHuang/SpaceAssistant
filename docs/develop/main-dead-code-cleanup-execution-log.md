# main 死代码清理执行记录

## 工作区与基线

- 独立 worktree：`.worktrees/main-dead-code-cleanup`
- 分支：`codex/main-dead-code-cleanup`
- 实施基线：`ebdff6fa593fada24983d77e75700465368c7f55`（方案审计基线）
- 范围依据：[main 死代码盘点与安全清理方案](./main-dead-code-cleanup-audit-and-plan-2026-10-14.md)
- 产品行为 owner：仓库文档没有提供个人或团队映射；在各候选的行为合同核对完成前，不把任何候选列为已批准删除。
- 执行 owner：本清理工作流；仓库外消费者和功能退役窗口需要产品 owner 证据，当前未确认。

## 阶段 0：边界与依赖清单

### 可在当前环境验证

- 当前 worktree 与方案声明的 `main@ebdff6fa` 一致。
- 逐项检索了 28 个候选在产品源码、测试、脚本中的静态名称引用；相关测试引用不能替代生产接线证据。
- 复跑方案中的 `noUnusedLocals` / `noUnusedParameters` 扫描：Electron 237 条、Renderer 56 条；共享文件重复后需按文件/行/列去重，扫描器本身不能证明绑定及副作用可安全删除。
- 逐项基线已落在[未使用诊断清单](./main-dead-code-unused-diagnostic-baseline-2026-10-15.md)：去重后 277 条、97 个文件；其中 TS6133 为 234 条，TS6196 为 28 条，TS6192 为 15 条。核心大文件分开审查，`src/shared/api.ts` 等公开合同不按诊断机械删除。
- 后续每个批次可在本仓库用定向 Vitest、typecheck、边界检查和干净构建验证，并检查删除文件对应的 `dist-electron` 输出。

### 需外部环境或产品 owner 确认

- 从干净构建启动 Electron、验证平台相关 preload、Worker 和原生浮窗交互。
- 使用真实飞书/微信账号验证入站、异步审批与通知回执。
- 使用旧用户数据库/profile 验证迁移兼容。
- 仓库外包消费者、功能 owner 与兼容窗口。

### 候选批次初始处置

`保留`表示在行为合同有生产路径和仓库外消费者证据前不删除；`待映射`表示现有搜索结果或审计结论不足以判定退役。所有候选的删除门槛均未通过。

| 批次 | 候选 | 初始处置 | 删除前必须补齐的证据 |
|---|---|---|---|
| 旧 stream / 输入拼接 | `electron/anthropicStreamDelta.ts`、`electron/modelEventSource.ts`、`electron/toolUseInputMerge.ts` | 待映射；暂保留 | 当前 Hosted/pi-ai adapter 对原始事件解析和 tool-call 输入拼接的生产接线，以及应迁移的边界断言 |
| SDK permit dispatch | `electron/tools/agentSdkTurnDispatch.ts`、`permitBoundCoordinatorDispatch.ts`、`permitRevocationBridge.ts`、`preparedInvocationStore.ts` | 保留；内部相互依赖且含授权/撤权时序合同 | Hosted caller 的冻结输入、授权漂移、撤权、取消、claim 前后 executor 调用数与在途结果结算回归 |
| 确认 / 安全旧辅助 | `electron/confirmation/confirmCardPayload.ts`、`decisionCache.ts`、`deferredApprovalCachePolicy.ts`、`remoteAsyncApprovalAcceptanceMatrix.ts`、`securityActionIntentRecovery.ts`、`shellConfirmationAdapter.ts` | 待映射；暂保留 | `ToolConfirmRegistry`、SDK confirmation port、decision cache writer、持久化审批及 shell gate 的调用链与 payload/失败关闭断言 |
| Remote / IM | `electron/remote/deferredApprovalNotificationSender.ts`、`imWorkflowSkillHarness.ts`、`electron/wechat/weChatQuoteBinding.ts` | 待映射；暂保留 | 判定 harness 的测试夹具角色；飞书/微信真实 sender、消息字段、quote binding 与外部运行验证 |
| Renderer pending confirm | `src/renderer/hooks/useActionablePendingConfirms.ts`、`src/renderer/services/confirmationSnapshotGate.ts`、`pendingConfirmationService.ts` | 待映射；暂保留 | 当前 store、turn display、ToolCallCard 与 IPC 审批提交流程中 stale-turn fail-closed 的 smoke |
| Shared 纯逻辑 | `src/shared/llm/outputMaxTokens.ts`、`src/shared/outbound/chatOutboundClassifier.ts`、`src/shared/promptSerialization.ts`、`src/shared/spillSemantics.ts`、`src/shared/surfaceProjection.ts` | 待映射；逐项核对消费者 | 全仓/动态消费者证据；仍有效合同迁移到生产调用方并保留边界断言 |
| Session projection 诊断 | `electron/runtime/sessionProjectionConsistencyAudit.ts`、`sessionProjectionRetirementCandidates.ts` | 保留 | 清理 owner gate、迁移/清理脚本及 `check-session-storage-boundary.mjs` 的退休证据；现有扫描明确把 consistency audit 作为 privileged reader |
| 包装层 / attribution | `electron/browser/browserDependencyRecovery.ts`、`electron/database/remoteTrackAttributionMetrics.ts` | 待映射；暂保留 | Browser 包装层的外部消费者；remote-track schema 版本、指标 reader 和离线报表消费者的检查 |

### 已观察到的引用事实

- Browser recovery 的共享实现被 Renderer 产品代码直接调用；Electron 包装层目前检索到的引用在测试中，需单独判断包装层是否为外部合同。
- `imWorkflowSkillHarness` 有多个恢复/端到端测试消费者，按测试 harness 处理，不能只因无产品入口就删除。
- `sessionProjectionConsistencyAudit.ts` 被边界检查脚本显式列为 privileged reader。
- SDK permit dispatch 辅助文件间存在静态依赖；其安全测试必须映射到真实执行路径后，才可考虑退役。
- 上述事实仅作初始清单，尚未替代逐候选的测试断言和生产调用链审计。

## 阶段状态

| 阶段 | 状态 | 交付 / 验证 |
|---|---|---|
| 0. 边界与依赖清单 | 完成 | 本文件；本阶段批准删除数为 0，候选先保留/待映射；外部验收交付形态待用户选择 |
| 1. 未使用绑定分批清理 | 进行中 | 基线已精确映射至 97 个文件；首批完成，剩余诊断继续按小批次审查 |
| 2. SDK permit / browser recovery | 未开始 | 需先完成合同矩阵及定向测试 |
| 3. 其余候选 | 未开始 | 按行为域逐批映射和验收 |
| 4. 防回流检查与最终验收 | 未开始 | 强制 `npm run build` 干净构建；本地与外部运行结果分开记录 |

### 阶段 1 批次记录

| 批次 | 改动与行为证据 | 验证 |
|---|---|---|
| 1. WeChat clarification router | 清除 `weChatCommandRouter.ts` 中未使用的 `CURRENT_SCHEMA_VERSION` import 和 `assistantMessageId` 读取；将未使用的 `parked` 绑定改为原调用表达式，保留 `parkImInboxMessageForClarification` 持久化调用、参数求值和后续创建/发送 attempt 的先后顺序。现有 `ambiguous Track 消息会原子暂存并发送带句柄的选项` 测试已在修改前验证澄清记录、parked 消息与发送 attempt 状态。 | 修改前、后均 `npm exec -- vitest run electron/wechat/weChatCommandRouter.test.ts`：36/36 通过；全项目 noUnused 诊断由 277 降至 274（TS6133 234→231），该文件剩余诊断 0。 |
| 2. 无副作用绑定 | 删除 `readPermitTestUtils.ts` 的未使用 Node `path` import；`UsageStatsDrawer` 将仅用作类型的 `Dayjs` import 改为 type-only；删除无调用方的私有 `onContentChanged`；`database/index.ts` 去掉冗余的 `openSqliteDatabaseReadOnly` 本地绑定，但保留同名公开再导出。 | 修改前、后定向跑 `builtinExecutors.pathAlias.test.ts`、`fileContentSyncBus.test.ts`、`UsageStatsDrawer.test.tsx`：3 个文件 / 41 项通过；noUnused 诊断由 274 降至 270，4 个目标文件均无剩余诊断。 |
| 3. 纯类型引用 | 移除 12 个文件中未使用的 type import specifier 和私有 `StatusProps`；`src/shared/api.ts` 只调整未使用的导入，不改任何 `window.api` 字段、DTO 或导出。保留 `src/shared/configSetTypeGate.ts` 中刻意未使用的 `_WechatRequired` gate；核心 `toolChatLoop.ts` 的导入留待单独批次审查。 | `typecheck:shared`、`typecheck:renderer`、`typecheck:agent-sdk` 通过；noUnused 诊断由 270 降至 249（TS6196 28→7）。这是纯类型/私有声明清理，无运行时行为变更，按方案不另增行为测试。 |
| 4. Shared import 与消息网关 | 移除 `messageMutationGateway.ts` 中未使用的 schema 常量、display-order 类型和 Redux action 绑定；从 `domainTypes.ts` 去掉只为显式 re-export 重复引入的 Feishu/WeChat 运行时值绑定，保留被 `AppConfig` 使用的 type-only imports 及全部公开 re-export。 | 第一次 typecheck 暴露 `domainTypes.ts` 的 `FeishuConfig`/`WorkDirProfile`/`WeChatConfig` 仍参与 `AppConfig` 类型；恢复 type-only imports 后 `typecheck:shared` 与 `typecheck:renderer` 均通过。noUnused 诊断 249→244。 |
| 5. Renderer 纯 import 清理 | 从七个 Renderer 文件移除未使用的 Ant Design 控件、配置/展示组件与配置常量绑定；`MarkdownRenderView` 仅由未使用的 import 引入，检查其模块无顶层注册/监听副作用后删除。 | `npm run typecheck:renderer` 通过；noUnused 诊断 244→237，七个目标文件均无剩余诊断。只涉及纯绑定且无初始化副作用，未新增行为测试。 |
| 6. Electron 低耦合辅助 | 清理 Browser detect/error、session storage shadow、Skill parser、日志 retention、snapshot tool、wiki paths/projects、session IPC 与 cleanup estimate 中已确认未使用的导入/私有 YAML parser。Skill parser 的现行路径使用 `yaml.parse`；移除未被调用的旧 `parseSimpleYaml` 和其专属 `unquote` helper。 | 修改前、后跑 8 个对应测试文件：8/8 通过（73 passed、2 个既有 skipped）；noUnused 诊断 237→225，12 个目标文件均无剩余诊断。 |
| 7. 低耦合 Electron 导入与常量 | 清理 `stagehandService` 未用的 `createRequire` 结果、Butler 未用 `ipcMain`、策略 type import、migration path、deferred approval type、context adapter import、transaction import、spill chunk 常量及 `workDirManager` 的 `getSession` 绑定；公开函数和 IPC 参数顺序不变。 | 去重 noUnused 诊断 225→216，九个目标文件均无剩余诊断；均为未使用绑定或无初始化副作用常量，行为测试留在对应功能批次/阶段收尾。 |
| 8. 参数位置与临时值 | 保留公开/回调参数位次，只将未使用参数改为 `_` 前缀或省略未使用解构绑定；删除重复构造但未使用的 recovery request ID；把 WeChat progress merge 结果绑定改为原调用表达式以保持参数求值。保留 `callRoutingLlm` 输入类型的 `timeoutMs` 字段。 | `typecheck:renderer` 与 `typecheck:shared` 通过；noUnused 诊断 216→205，11 个目标文件均无剩余诊断。改动不改变参数位置、状态写入或调用顺序，按方案未单独增测。 |
| 9. 安全/状态辅助的未用绑定 | 将 IM outcome 与 read-confirm registry 的未使用参数改为显式忽略名但保留签名；移除 delivery hub 尾项读取与 renderer 私有 `persistKey`；将 projection audit 的 DB 读取和 SDK scheduler 的 `isWaiting` 遍历保留为调用表达式，避免丢掉潜在 getter/callback 行为；`withPhaseTimeout` 移除只在私有 helper 内转传、从不读取的 signal 参数。 | 修改前、后定向跑 8 个对应测试文件：8/8 通过（133/133）；`typecheck:agent-sdk`、`check:agent-sdk` 通过；noUnused 诊断 205→198，目标文件均无剩余诊断。 |
| 10. IPC 与迁移低风险绑定 | 删除 Electron database migrations、Feishu router、agent protocol IPC、desktop/file IPC 与 `ipcShared` 中确认未使用的导入和局部值；保留 `SCHEMA_META_KEYS`，因为实际迁移 SQL 仍读取它；`listDirectoryEntries` 保留参数位置并将未使用的 `ctx` 改为 `_ctx`。 | 修改后定向跑 10 个相关文件：10/10 通过（87/87）；`git diff --check` 通过。noUnused 扫描中这 6 个目标文件均无剩余诊断；Electron/shared 152 条、Renderer/shared 29 条，重叠共享诊断去重后总计 176 条（198→176）。增量构建因 worktree 可见依赖中缺少 pi-ai 的 `api/anthropic-messages.js` 与 `utils/transcript.js` 被 `check:pi-ai-runtime-closure` 阻断；随后直接 tsc noUnused 扫描可执行。 |
| 11. `toolChatLoop` 已迁出逻辑的导入 | 按 noUnused 编译诊断移除已迁出/未被读取的 import 和 type specifier；保留仍用于调用链与清理的 `McpConnectionManager`、`AGENT_ADDITIONAL_CONTEXT_KEYS`、`clearToolRevocationRequest` 等绑定。未修改参数、调用或状态逻辑。 | 修改前、后均运行 6 个核心 tool loop 测试文件：6/6 通过（65/65）；`git diff --check` 通过。Electron/shared 扫描从 152 降到 82，Renderer/shared 为 29，按共享诊断去重后总数 106（176→106）；除 noUnused 外无 TypeScript 错误。 |
| 12. `toolChatLoop` 私有上下文与临时值 | 删除内部函数未用的字段解构（保留导出的 `RunToolChatSessionArgs` 契约字段）、未使用的远程预算副本、`effortRetryUsed` 和无调用方的 replay helper；保留 `resolveEffectiveShellOutputMode(...)` 调用表达式与 `getRemoteTaskController().ensureTask(...)`，避免改变配置读取和远程任务初始化。 | 修改前、后均运行 `toolChatLoop.outboundBudget`、`safetyReject`、`invocation`、`effortFallback` 与 `shellOutputMode` 5 个测试文件：5/5 通过（54/54）；`git diff --check` 通过。Electron/shared 扫描 64 条，Renderer/shared 29 条，共享诊断去重后 88 条（106→88）；无非 noUnused TypeScript 错误。 |
| 13. Claude stream handler 未用绑定 | 删除 `claudeStreamHandlers.ts` 中未使用的纯导入；对导出函数与 `ClaudeTurnExecution` 回调的未用参数仅加 `_` 前缀、保留参数位置；删除未读取的 `boundaryEventWriter`，并将只用 index 的 `filter` callback 参数改为 `_message`。 | 修改前、后均运行 6 个 claude stream handler 测试文件：6/6 通过（142/142）；`git diff --check` 通过。目标文件 noUnused 诊断归零；Electron/shared 扫描 53 条，Renderer/shared 29 条，共享诊断去重后 77 条（88→77）；无非 noUnused TypeScript 错误。 |
| 14. ChatView 失效状态与 helper | 移除未渲染的 `exposureTools` state/subscription、未使用的错误/上下文翻译 hook 返回值、`chatBaseUrl` memo、旧 `buildClaudePayload` helper，以及确认无引用的 import；保留 `toolExposureService` 与其独立行为。 | 修改前、后均运行 5 个 ChatView 回归文件与 `toolExposureService.test.ts`：6/6 通过（51/51）；`npm run typecheck:renderer` 与 `git diff --check` 通过。ChatView noUnused 诊断归零；Renderer/shared 扫描 11 条、Electron/shared 53 条，共享诊断去重后总计 59 条（77→59）。 |
| 15. Runtime、shell、worker 与 workspace 绑定 | 清理 hosted handoff、invocation assembler、shell helper 的未用 imports；移除 storage worker client 的 URL import，保留 `createRequire(...).resolve('tsx/cjs/api')` 原检查和异常包装作为表达式；移除 snapshot 未用数据库 type import，并将导出的 `resolveWorkspaceSnapshot` 未读参数改 `_fallbackWorkDir`、保留其位置。 | 修改前、后均运行 8 个相关测试文件：8/8 通过（145/145）；`git diff --check` 通过。五个目标文件 noUnused 诊断归零；Electron/shared 扫描 43 条、Renderer/shared 11 条，共享诊断去重后总计 49 条（59→49）。 |
| 16. MCP service 未用依赖 | 从 `mcpService.ts` 删除未读取的 `McpServerProfile`、`McpConnectionManager`、`isOAuthFlowActive` imports；保留 endpoint validation、OAuth discovery/login 与 testConnection 调用链。 | 修改前、后均运行 `mcpService.test.ts`：1/1 通过（15/15）。普通 sandbox 首次基线运行因禁止 loopback listen 报 EPERM/超时；获批的 elevated 本机 mock-server 运行在改动前后均通过。目标文件 noUnused 诊断归零。 |
