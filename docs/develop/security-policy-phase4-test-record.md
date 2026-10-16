# Phase 4 测试记录

日期：2026-10-16。范围：执行批准对象版本化摘要、read/write permit decision 关联、执行 veto 分类/审计，以及各执行通道 final-check 复核。

## 定向验证

- `executionSubject.test.ts`：对象键顺序规范化、正文不进入摘要、工具/调用/批准对象变化导致摘要变化、拒绝不可规范化类型。
- read/write permit + gate + SDK safety + write prepared adapter 定向集合：6 个文件、216 项通过；gate 文件独立复核 146 项通过。
- `agentSdkConfirmationPort`、SDK safety、registered agent tools、permit-bound coordinator、remote policy、WeChat outbound 与 WeChat remote 集合：7 个文件、219 项通过。
- WeChat target replacement 与等待期间 approval configuration drift：2 项定向通过。后一项证明变更使原 receipt 失效，需要新的真人确认；测试夹具自动批准两次时才执行一次。
- IM outbound policy、对象 final-check、注册工具、Feishu/WeChat 发送与 policy engine：5 个文件、50 项通过；标准档 IM 普通 outbound 走 Agent review，敏感 outbound 走真人确认，系统通知由可追踪的共享 policy 决定。
- 固定任务集中的普通/敏感 outbound 策略回归：定向 1 项通过；标准档普通 IM outbound 进入策略审查，敏感 IM outbound 要求真人，不会在未批准时派发。
- execution veto audit 覆盖 decisionId/priorDecision、failureClass、caseId、invariantId、factId 脱敏；write adapter permit drift veto 时 executor 调用为 0。
- electron、agent-sdk、renderer、shared typecheck：通过；`npm run build:electron:incremental`、`npm run check:system-invariant-registry`、`git diff --check`：通过。

## 全量测试（阶段门槛）

- 最终状态下提权运行 `npm test`：退出码 1；Vitest 汇总为 14 个文件失败、1062 个通过、1 个跳过；183 项失败、9968 项通过、111 项跳过、5 个未捕获错误，耗时 750.59 秒。未再出现 `listen EPERM 127.0.0.1`。
- 失败集中于 Hosted/SQLite handoff、Hosted provider 远程代理、approval-agent、固定任务集的 Hosted dispatch、checkpoint 与少数旧决策矩阵/门控断言；另有 5 个 `PROVIDER_ROUTE_IDENTITY_COLLISION` 等异步错误。当前源码环境没有可用的 Hosted provider 路由/生产凭据，Hosted 链路全量验收记为环境限制；真实 IM/MCP 仍按源码交付范围外部待验。
- 本次全量日志：`/tmp/security-policy-p4-npm-test-closed.log`。与 P4 相关的定向用例（上文）通过；本全量结果如实保留，不声明整个仓库测试通过。
