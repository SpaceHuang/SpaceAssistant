# tools-mcp baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- electron/shell electron/mcp electron/browser`（开工点即基线，窗口为空）
> 本主题是计划 §6 指定的**试点**（`run_shell` 6 篇矛盾最集中）。

| 断言 | 文档出处 | 命令 | 实测 | 判定 | 处置 |
| --- | --- | --- | --- | --- | --- |
| A1 MCP 工具结果以可读表格/卡片渲染 | `archive/tools-mcp/mcp-tool-call-card-display-requirement.md`（原 requirement 侧） | `rg -n 'McpToolResultView\|McpConfirmCard\|McpElapsed' src/renderer/components` | 命中（`McpToolResultView.tsx`、`McpConfirmCard.tsx`、`McpElapsed.tsx` + 测试） | **漂移**（需求自述「待实施」） | 按代码更正（`59aae8df`，2026-10-05） |
| A2 超时 turn 的执行隔离已实现 | `archive/tools-mcp/mcp-timeout-turn-failure-isolation-plan.md` | `git log --grep='isolation' -30` | `a01a6d49`（2026-10-14）+ `e6f1c510`（merge） | **漂移**（文档自述未复评） | 按代码更正 |
| A3 shell 方言判定收紧（P0-B）与诊断三出口（P1）已落地 | `in-flight/run-shell-dialect-mismatch-…-improvement-plan.md` | `git log --grep='方言' -20` | `2ca72344`（P0-B）、`8cb86e0b`（P1，D-7/D-8 定案）、`f13ef720`、`7d3d9e82` | **部分一致**：D-1/D-7/D-8 已定案并有实现，文档自身标「待重审」 | 保留在 `in-flight/`，标「实施中（进度见 history.md）」 |
| A4 MCP 工具已向 IM/automation 回合开放 | `archive/tools-mcp/mcp-im-automation-tools-requirement.md` | `git log --grep='expose tools to IM'` | `33c57ffd feat(mcp): expose tools to IM and automation` | 一致 | — |
| A5 shell 生命周期优化已合入 main | `archive/tools-mcp/run-shell-and-tool-execution-lifecycle-optimization-plan.md` | `git log --format='%h %s' --grep='lifecycle' -20` | 文档自述合并提交 `1f6e794` | 一致（文档自带证据） | — |

## 无法核验项

- shell 方言错配的**端到端真机行为**（Windows 宿主初始化失败、cmd 方言信号）：需 Windows 真机，标 `待真机核验`（相关用例已按 `a7f9e72f` 去端到端化，自动化覆盖下降）。

## 抽样复核建议（用户抽 3 条）

A1、A2、A4。
