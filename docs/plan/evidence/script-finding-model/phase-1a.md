# 阶段 1a：位置与发现 — 关闭证据

## 结果

- 阶段实现提交 SHA：`2c6d4a29d7c1004ae9be123abbf9ee92ed0fb615`
- 基线依赖：F00 提交 `317d5789`（包含执行计划、技术方案快照和 F00 基线证据）
- 阶段任务：F01、F02、F03、F04
- 阶段任务证据：[`F01.md`](F01.md)、[`F02.md`](F02.md)、[`F03.md`](F03.md)、[`F04.md`](F04.md)
- 总验收汇总：1,257 test files passed / 1 skipped；12,184 tests passed / 140 skipped。完整门禁与故障处理见 [`F04.md`](F04.md)。

## 阶段提交文件清单

由 `git show --format= --name-only 2c6d4a29d7c1004ae9be123abbf9ee92ed0fb615` 复核的精确文件清单：

```text
docs/develop/safety-approval/security-policy-locked-floor-classification.md
docs/plan/evidence/script-finding-model/F01.md
docs/plan/evidence/script-finding-model/F02.md
docs/plan/evidence/script-finding-model/F03.md
docs/plan/evidence/script-finding-model/F04.md
docs/plan/evidence/script-finding-model/phase-1a.md
docs/plan/script-finding-model-execution-plan.md
electron/confirmation/extractors/extractors.test.ts
electron/confirmation/extractors/scriptAnalysisExtractor.ts
electron/confirmation/scriptAnalysisFailureGate.test.ts
electron/shell/scriptContentSecurity.test.ts
electron/shell/scriptContentSecurity.ts
electron/shell/scriptGolden.test.ts
electron/shell/scriptIr/pythonAdapter.test.ts
electron/shell/scriptIr/pythonAdapter.ts
electron/shell/scriptIr/types.ts
src/shared/confirmation/types.ts
src/shared/policy/defaultRules.contract.test.ts
src/shared/policy/defaultRules.ts
src/shared/policy/policyEngine.test.ts
```

## 依赖闭包与回退

1. F00 基线提交 `317d5789` 保留计划、技术方案快照及入口/基线证据。
2. 回退本阶段提交整体撤销 IR 位置、首批 findings、分析失败策略以及对应测试和锁定规则目录登记。
3. 不回退 F00；不删除历史数据。阶段 1b/1c 不在此闭包中。

## 隔离回退 smoke

在 detached worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/script-finding-model-revert` 从阶段实现提交 `2c6d4a29d7c1004ae9be123abbf9ee92ed0fb615` 起执行 `git revert --no-edit`，产生隔离回退提交 `c33437401c49a886dc0d02790acc79d044ddab2c`。回退后运行：

```text
npm exec -- vitest run electron/shell/scriptIr/pythonAdapter.test.ts electron/shell/scriptContentSecurity.test.ts electron/shell/scriptGolden.test.ts electron/confirmation/extractors/extractors.test.ts src/shared/policy/lockedFloorClassification.test.ts
```

结果：5 files / 238 tests passed；旧 script-analysis 路径和旧 locked-floor inventory 在阶段回退后可用。临时 worktree 已确认干净，之后移除。
