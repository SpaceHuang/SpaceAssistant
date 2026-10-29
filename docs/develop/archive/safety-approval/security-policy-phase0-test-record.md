# Phase 0 全量测试记录

- 日期：2026-10-15（Asia/Shanghai）
- 源码 commit：`8c0d2a89f78816d4a7d1b1a1890ad59f608cee4f`
- worktree 源码变更：无；本阶段只有基线/契约/inventory 文档。
- 命令：`npm test -- --reporter=dot`（脚本实际执行 `vitest run --project electron --project renderer`）
- 依赖安装：`npm ci` 成功，锁文件未改。由于 npm `allow-scripts` 策略未运行 Electron postinstall，首次测试时集成用例并发下载二进制并报 `EEXIST`；随后以 `node node_modules/electron/install.js` 安装锁定的 Electron `44.1.1`，第二次全量不再出现该安装错误。
- 最终结果：`15 failed | 1052 passed | 1 skipped` 个测试文件；`159 failed | 9920 passed | 111 skipped` 个测试；退出码 1，Vitest duration 797.93s。

## 已确认失败类别（基线无源码改动）

| 类别 | 失败证据 | 归类 / 后续处理 |
|---|---|---|
| policy snapshot 与源码规则集合漂移 | `src/shared/policy/defaultRules.contract.test.ts` 预期 65 左右的历史 rule ID 集，当前 `DEFAULT_POLICY_RULES` 有更多已迁入 IM 规则；列出 `im-low-risk-*`、`im-write-sensitive-path-confirm` 等当前规则时不相等 | 基线测试/契约同步问题；Phase 2 重写规则前先确定更新方式，不能静默刷新快照 |
| schema migration 测试断言落后 | `electron/database/migrations.imPolicyStore.test.ts` 预期 schema_meta 94、当前实际 95；`migrations.wikiProjects.test.ts` 断言旧 schema version 95、源码 `DB_SCHEMA_VERSION=99` | 历史迁移测试夹具/预期版本漂移；本计划原则上不需要 DB DDL，后续 scope check 防止误触 |
| 策略 gate test fixture/期望与当前契约不一致 | `toolCallGate.wikiMount.test.ts` 缺 `IM_POLICY_SNAPSHOT_REQUIRED` 依赖；`toolDecisionMatrix.test.ts` 期待旧 ruleId `browser-act-danger-ask`，当前返回 `im-browser-act-danger-human`；`securityTaskSetGate.integration.test.ts` 缺 desktop baseline observation | 先核对调用契约及有效规则，再确定它们是测试 fixture 过时还是行为缺陷；关联 P2 baseline matrix |
| 测试代码缺陷 | `electron/remote/deferredApprovalNotificationDelivery.test.ts` 使用未定义的 `getDbConnection` | 独立测试修复项，不由当前文档盘点处理 |
| approval/recheck 行为断言漂移 | `electron/remote/imRemoteAgent.test.ts` 预期 `FACTS_CHANGED`，当前返回 `RECHECK_REQUIRES_CONFIRMATION`；多个 hosted/remote write tests 期望旧事件或 executor 次数 | 与本计划 P1-06/P2-10/P4-03 高度相关；实施前先写准确的 stale approval/redecision regression，保留更安全的 executor=0 不变量 |
| 环境/凭据依赖 | `claudeStreamHandlers.hostedIntegration.test.ts` 报测试 API Key 无法经 safeStorage 读取；首轮 hosted test 还受 Electron 未安装影响，第二轮已解决后者 | mock/key fixture 应不依赖桌面 Keychain；真实 safeStorage/正式包属外部验收 |
| CI 注入文档状态改变测试 prompt | `electron/runtime/invocationAssembler.test.ts` 收到实际 AGENTS 注入中的 `AGENTS.md was not loaded (token-budget-exceeded)`，与 fixture 期望的纯 system prompt 不符 | 环境/测试隔离问题；不是策略逻辑失败，后续不得让此块进入产品 prompt |
| 其他集成/行为失败 | 第一轮已明确的 `butlerInvoker.test.ts` 六个 revoke/authorization-change 场景断言与当前 `result.ok` 不一致；最终汇总共 15 个失败文件、159 个断言 | 需依据每阶段相关调用链分类修复/登记；不把整体全量失败描述成通过 |

本记录证明的是：在本次源码未改动的 worktree 上，基线全量测试不全绿。Phase 0 的源码/规则发现可继续；每个相关垂直切片仍须先针对失败路径建立测试、实施后重跑定向测试。最终源码验收仍需再跑全量测试，明确记录残余失败及其是否由本分支引入。
