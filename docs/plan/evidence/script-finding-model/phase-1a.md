# 阶段 1a：位置与发现 — 关闭证据

## 结果

- 阶段提交 SHA：待提交后填入
- 基线依赖：F00 提交 `317d5789`（包含执行计划、技术方案快照和 F00 基线证据）
- 阶段任务：F01、F02、F03、F04
- 阶段任务证据：[`F01.md`](F01.md)、[`F02.md`](F02.md)、[`F03.md`](F03.md)、[`F04.md`](F04.md)
- 总验收汇总：1,257 test files passed / 1 skipped；12,184 tests passed / 140 skipped。完整门禁与故障处理见 [`F04.md`](F04.md)。

## 阶段提交文件清单

提交后以 `git show --format= --name-only <SHA>` 复核并记录精确文件清单。

## 依赖闭包与回退

1. F00 基线提交 `317d5789` 保留计划、技术方案快照及入口/基线证据。
2. 回退本阶段提交整体撤销 IR 位置、首批 findings、分析失败策略以及对应测试和锁定规则目录登记。
3. 不回退 F00；不删除历史数据。阶段 1b/1c 不在此闭包中。

## 隔离回退 smoke

待阶段提交后，在临时 detached worktree 对该提交执行 `git revert --no-edit`，再验证旧 script-analysis 行为与 locked-floor inventory，并运行定向 smoke。结果与临时 worktree 清理情况将在提交后补记。
