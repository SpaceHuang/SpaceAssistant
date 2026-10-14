# knowledge-skills 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。本主题在 develop 侧原无成体系文档，时间线以**代码提交**为主。证据源：`git log`（命令见文末）。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-11 | — | Skill 安装体积与云端安装决策闭环（v1.0） | `skill-install-size-limit-and-cloud-install-requirement.md`（已归档） | 安装策略定型 |
| 2026-09-12 | — | Skill GitHub 嵌套目录发现 v1.4 | `skill-github-nested-directory-discovery-requirement.md`（已归档） | 嵌套发现可用 |
| 2026-10-10 | `5c7e7a8a` | Wiki 集中共享存储 P0+P1：挂载层、probe/permit/executor、grep 双根、wiki 模块 | `wiki-shared-centralized-storage-requirement.md`（已归档） | **实现先于需求回写**（需求档 v1.12 未标注已实施） |
| 2026-10-11 | `4f5e1c59` | 迁移前创建共享 `wiki/` 目录 | — | 迁移不因缺目录失败 |
| 2026-10-11 | `072d1103` | Wiki 实现评审：9 项阻断项 + P1 修复 | — | 阻断项清零 |
| 2026-10-11 | `f612dd5a` | Wiki 评审 v2：BLK-5 残留（结构段大小写不敏感）+ 3 项 P1 | — | 残留收口 |
| 2026-10-11 | `9c34f7a4` | Wiki 迁移失败上浮 + 迁移 UI 对齐设计系统 | — | 失败可见 |

## 存疑

- `wiki-shared-centralized-storage-requirement.md` 自述无「已实施」标注，但 `electron/wiki/` 下符号齐备（`wikiProjectStore`、`wikiMount`、`wikiMigration`、`wikiWriteMutex`）—— 判定为**状态滞后**，已按代码更正。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/skills electron/wiki
rg -n 'wikiProjectStore|wikiMount|wikiMigration|wikiWriteMutex' electron/wiki
```
