# Phase 3 测试记录

日期：2026-10-15。范围：系统 invariant 首次登记、登记完整性门禁、贡献规范与执行 veto 审计归因。

## 定向验证

- `npm run check:system-invariant-registry`：通过，5 个登记项、9 个测试引用存在；正反例 fixture 验证合法项通过，缺 owner、缺 test 引用、空 test 列表失败。
- `npm exec vitest run src/shared/security/systemInvariantRegistry.test.ts electron/confirmation/recursionGuard.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/readReadIntegration.test.ts electron/confirmation/executionVetoAudit.test.ts`：5 个文件、171 项通过。
- 先加入完整 registry 覆盖测试，空 registry 时 1 项失败；填入登记项后测试转绿。
- 门禁自测先发现空 owner 和空 tests 未被捕获，修复后负例稳定失败、合法样例通过。
- `git diff --check`：阶段结束前运行。

## 关闭范围

`SYSTEM_INVARIANT_REGISTRY` 只供源代码 lint/架构检查读取，不进入运行时 Policy Engine。已登记：递归审批保护、permit subject/expiry 校验、SDK capability admission、运行期间 capability 撤销、recheck 后不静默升级为第二次审批。locked policy deny、outbound/outside-workdir/sensitive/MCP 行为留在 policy contract；普通输入验证和环境错误不登记。

执行 veto 支持可选 `invariantId`，read permit executor 关联 `SYS-PERMIT-001`；审计仍保留 `failureClass` 与 `caseId`，不覆盖原 `policy.decision`。

## 全量测试（阶段门槛）

执行 `npm test`，退出码 1；Vitest duration 779.08s：14 个文件失败、1060 通过、1 skipped；159 个测试失败、9979 通过、111 skipped。

失败数与 Phase 1 记录的 159 相同，失败文件数为 14（低于其 15）；既有 Hosted/API key 凭据不可用、checkpoint/SQLite 注入、环境 prompt 和 WeChat/Feishu recheck/审批阈值竞态仍在。WeChat “审批期间新建目标”和“审批等待时阈值变化”已在原始主 worktree 复现。新增的 registry、recursion、permit audit 定向测试全绿；全量失败中未见 P3 新增测试文件。全量测试非零退出，不能声明全量 suite 通过。

## 阶段结论

源码门禁、贡献规范、5 项系统底线登记和 permit veto 审计关联已完成；P3 关闭门槛满足源码交付范围。真实 IM/MCP、正式包和生产数据验收仍按用户确认留作外部验收。
