# Phase 1 测试记录

日期：2026-10-15。工作目录：`.worktrees/security-policy-three-stage`。本阶段先执行新增回归用例得到红，再实现 facts producer、gate/审批 provenance 和兼容接线，之后合并定向验证。

## 定向验证

- `npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/agentSdkConfirmationPort.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/extractors/extractors.test.ts electron/confirmation/shellConfirmationAdapter.test.ts electron/confirmation/extractors/shellEffectFacts.test.ts electron/confirmation/securityAuditLog.test.ts electron/tools/weChatToolExecutor.test.ts electron/tools/wechatOutboundRegisteredTools.test.ts src/shared/confirmation/invocationFactsSnapshot.test.ts src/shared/confirmation/imOutboundFacts.test.ts src/shared/confirmation/imAttachmentFacts.test.ts src/shared/confirmation/outboundClassification.test.ts`：14 files / 367 tests passed。
- provenance / snapshot focused set：4 files / 214 tests passed。
- `npm run typecheck:shared`：通过。
- `npx tsc -p tsconfig.electron.json --noEmit`：通过。
- `npm run build:electron:incremental`：首次在类型检查阶段因 `factsProvenance` 暂加到了 clue 类型而非 `ConfirmRequest` 类型失败；修复接口后 `tsc -p tsconfig.electron.json --noEmit` 通过。阶段内不重跑增量构建。
- `git diff --check`：通过。

## 全量测试（阶段门槛）

按用户确认的阶段纪律运行 `npm test -- --reporter=dot`，退出码 1：15 个测试文件失败、1054 通过、1 skipped；159 个测试失败、9937 通过、111 skipped；Vitest duration 765.99s。失败仍集中在既有类别：策略快照基线漂移（defaultRules snapshot）、Hosted/API Key 测试凭据不可用、checkpoint/撤权与 recheck 流程时序断言。全量日志中未发现 P1 新增测试文件失败；本阶段新增/修改的 facts producer、gate、adapter、audit 定向集合仍为 14 files / 367 passed。

## 失败对照

- 新增 `agentChannel` provenance 用例先失败（审批 clue 未包含 facts provenance），实现后相关集合通过。
- 新增 command effect/completeness 用例先失败（extractor 只有 command-sequence），实现后定向测试通过。
- gate snapshot 首轮发现合法 `undefined` optional facts 被稳定 serializer 拒绝；按 JSON 对象语义忽略 undefined 字段后 gate 集合通过。
- `approvalAgent.test.ts` 全文件持续出现 14 个失败，集中在 Hosted provider 启动/撤权 claim 时序、timeout terminal kind、以及 mocked `runToolChatSession` 未调用；Phase 0 全量记录已有同类 Hosted/SQLite/撤权基线失败。新增 prompt provenance 单测通过。最终全量结果须复核是否新增。
