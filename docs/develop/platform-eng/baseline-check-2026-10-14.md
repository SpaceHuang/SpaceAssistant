# platform-eng baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- docs/develop/platform-eng` = **0 条**（本主题文档零搬迁，仅新写 README / history）

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| A1 i18n 校验与类型生成命令存在 | [i18n-sync-guide.md](./i18n-sync-guide.md) | `rg -n '"i18n:check"\|"i18n:generate-types"\|"i18n:check:strict"' package.json` | 命中 | 一致 |
| A2 发版指南对应的打包脚本存在 | [release-guide.md](./release-guide.md) | `rg -n '"pack:(win\|mac\|linux)"' package.json` | 命中三个平台脚本 | 一致 |
| A3 云 main 恢复 / 分叉接入组已归档 | [README](./README.md) §归档 | `ls docs/develop/archive/platform-eng/` | 命中 10 件（含 3 个 `.tsv`） | 一致 |
| A4 死代码清理件为本地分析（未入库） | [history.md](./history.md) | `ls docs/analyze/main-dead-code-cleanup-audit-and-plan-2026-10-14.md` | 主工作区存在、本 worktree 不可见（`.gitignore` 第 58 行） | 一致 |

## 矛盾与时间线检查

- **存疑（未消解）**：`tech_design.md` 是早期技术设计总纲，与 `architect/` 的现役架构文档存在口径重叠 → 已在 [`history.md`](./history.md)「存疑」记录，**以 `architect/` 与代码为准**，待专项复核后决定是否归档。
- **history 抽样**（2 条，均可命中）：`879c7d04`（版本升至 0.2.7）、`d6c57138`（本地 main 整合 + 死文件清理）。

## 无法核验项

- 实际发版流程（tag 推送、CI 打包、安装包产物）需真机与凭据，标 `待真机核验`。

## 抽样复核建议（用户抽 2 条）

A1、A2。
