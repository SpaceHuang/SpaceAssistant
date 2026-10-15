# tools-mcp 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）；冲突时以 `git log` 为准。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-04 | — | `run_shell` 生命周期优化与现状评审启动（`bash-run-shell-current-state-and-optimization-review.md`） | 已归档 | 形成 shell 6 篇文档簇 |
| 2026-09-12 | — | shell 输出编码健壮性 L2/L3 内核落地 | `shell-output-encoding-robustness-implementation-record.md`（已归档） | 编码字段不再依赖平台默认 |
| 2026-10-10 | `33c57ffd` | MCP 工具向 IM 与 automation 业务回合开放 | `mcp-im-automation-tools-requirement.md`（已归档） | 飞书/微信可调用已启用 MCP 工具 |
| 2026-10-11 | `2ca72344` | shell 方言判定收紧：`$name` 误报修复 + 补齐 cmd 方言信号（P0-B） | `run-shell-dialect-mismatch-…-improvement-plan.md`（在途） | 方言误判下降 |
| 2026-10-11 | `8cb86e0b` | 诊断三出口与方言错配计数改为会话级语义（P1，D-7/D-8 定案） | 同上 | 计数不再跨会话串味 |
| 2026-10-11 | `f13ef720` | 撤销 cmd-exe-chain 误报信号并修复计数键同源性 | 同上 | 误报消除 |
| 2026-10-11 | `7d3d9e82` | 评审二轮残留：升级提示文案与夹具对齐 cmd-operator 口径 | 同上 | 文案与测试一致 |
| 2026-10-14 | `a01a6d49` | 超时 turn 的执行隔离：超时不再连累同批其它工具调用（跨主题：SDK/MCP） | `mcp-timeout-turn-failure-isolation-plan.md`（已归档） | 计划文档状态滞后，实现先落地 |
| 2026-10-14 | `a7f9e72f` | 方言计数清除用例去端到端化（5 次真实拉起降到更少） | — | 测试稳定性提升 |

## 存疑（文档与记录不一致）

- **`mcp-timeout-turn-failure-isolation-plan.md`（已归档）的头部状态被上游剥离了实施记录**（main `88abc9ed`，2026-10-15）：状态由「阶段 A-E 实现完成」改为「复评 v3 提出阻断；修订版尚未复评」，且 **§13「实施进度」整节被删除**。
  - **实际实现状态以代码为准**：`a01a6d49`（2026-10-14）已落地超时 turn 的执行隔离、`e6f1c510` 已合入 —— 与头部自述相反，属**状态滞后**（已在主题 README 标注）。
  - **被删的 §13 原文可取回**（含阶段 A–E 完成情况与验证数据：SDK Turn/执行租约 154/154、observer 21/21、Hosted 集成核心 120/120；全量 9604 通过 / 41 失败均属本机沙箱限制）：
    `git show 88abc9ed^:docs/develop/mcp-timeout-turn-failure-isolation-plan.md`

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/shell electron/mcp electron/browser electron/tools
git log --date=short --format='%ad %h %s' --grep='shell' -25
```
