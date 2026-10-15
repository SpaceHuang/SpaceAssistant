# architect baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- docs/develop/architect` = **0 条**（本目录**零搬迁**，仅更新 README 基准行）

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| A1 本次对本目录只做基准行更新，文件零搬迁 | [README](./README.md) | `git diff --stat 17236274..HEAD -- docs/develop/architect` | 仅 `README.md` 基准行 1 处改动 | 一致 |
| A2 术语对齐：Agent Core = Agent SDK | [README](./README.md) §命名沿革 | `rg -n 'agentCore\|agent-core' electron/` | **0 命中**；`rg -n '@spaceassistant/agent-sdk' packages/agent-sdk/package.json` 命中 | 一致 |
| A3 形态决策已拍板（同进程库） | [`agent-sdk-shape-decision.md`](./agent-sdk-shape-decision.md) | `ls packages/agent-sdk/package.json` | 存在（`@spaceassistant/agent-sdk`） | 一致 |
| A4 图产物齐全 | — | `ls docs/develop/architect/*.html docs/develop/architect/*.json` | 命中（`product-architecture-design.html`；`agent-sdk-architecture-design.{html,architecture.json,visual-check.json}`） | 一致 |
| A5 外部对照研究三篇齐备 | — | `ls docs/develop/architect/*comparison*` | 命中（claude-code / codex / dsh 三篇） | 一致 |

## 矛盾与时间线检查

- 本目录多篇自述「状态：待评审」= **尚未经架构评审定稿**，不代表未实施；是否实施以代码为准（[rules §3.0](../_consolidation/docs-consolidation-rules.md)）。已在 README「状态口径」节说明，避免读者误判。
- **history 抽样**（1 条）：`b1865da4`（IM 安全设计入架构层）命中。

## 无法核验项

- 架构「理想态」的达成度属长期目标，无法用命令判定 —— 本记录只核验"文档与代码是否对齐"，不评估目标完成度。

## 抽样复核建议（用户抽 2 条）

A2、A3。
