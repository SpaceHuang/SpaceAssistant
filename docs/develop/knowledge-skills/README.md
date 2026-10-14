# knowledge-skills —— 技能与知识

> 定位：Skills 安装与管理、LLM Wiki、项目记忆。
> 主要代码域：`electron/skills/`、`electron/wiki/`
> 核对基线：`main` `17236274`（2026-10-14）

## 说明

本主题的文档主要在**需求侧**（原 109 篇需求里有 10 篇属于此主题，全部归档），develop 侧本次无独立文档（原 `docs/develop/` 下无 skills/wiki 专题件）。

| 去向 | 位置 |
| --- | --- |
| 需求口径 | [`../../requirement/knowledge-skills/需求基线.md`](../../requirement/knowledge-skills/需求基线.md) |
| 需求原件（9 件归档） | [`../archive/knowledge-skills/`](../archive/knowledge-skills/)（`docs/requirement/archive/knowledge-skills/` 的对称位） |
| 知识库（不入档、不搬迁） | `docs/knowledge/`（含 `wiki/`、`SCHEMA.md`） |

## 状态提示（文档自述滞后）

`wiki-shared-centralized-storage-requirement.md`（v1.12，已归档）自述无「已实施」标注，但实现已在代码内：

```text
rg -n 'wikiProjectStore|wikiMount|wikiMigration|wikiWriteMutex' electron/wiki
```

配套开发/测试计划：`docs/plan/wiki-shared-centralized-storage-dev-test-plan.md`（不动、只引用）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/skills electron/wiki
rg -n '<符号>' electron/skills electron/wiki
```
