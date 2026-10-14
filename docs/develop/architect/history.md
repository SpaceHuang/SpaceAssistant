# architect 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。本目录为**长期稳定层**（本次原地保留），变更以「文档整理」与「决策落定」为主。
> 证据源：`git log`（命令见文末）。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-12 | — | 本目录成体系整理：产品架构理想态、Agent SDK 演进 Roadmap、形态决策、三产品对照与 DSH/Claude Code/Codex 对照研究 | `architect/README.md` | 确立「基准 / 规划 / 决策记录 / 参考研究」四类与引用约定 |
| 2026-09-15 | — | 形态决策拍板：按同进程库推进 | `agent-sdk-shape-decision.md` | 影响 SDK 包形态与宿主装配方式 |
| 2026-10-13 | `b1865da4` | 新增 IM 安全设计（架构层） | — | 架构面补充 IM 安全域 |
| 2026-10-14 | — | 本次文档梳理：仅更新基准行（`工作区 HEAD` → `main 17236274`），目录与文件零搬迁 | 本文件 | 保持长期稳定层的引用面不变 |

## 存疑

- 本目录多篇自述「状态：待评审」，表示**尚未经架构评审定稿**，不代表未实施；是否实施以代码为准（核验流程见 `../_consolidation/docs-consolidation-rules.md` §3.0）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- docs/develop/architect
git log --date=short --format='%ad %h %s' --grep='architecture' -25
```
