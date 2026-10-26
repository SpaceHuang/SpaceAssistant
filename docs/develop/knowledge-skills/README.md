# knowledge-skills —— 技能与知识

> 定位：Skills 安装与管理、LLM Wiki、项目记忆。
> 主要代码域：`electron/skills/`、`electron/wiki/`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状

- [技能与知识-现状.md](./技能与知识-现状.md) —— **现状文档**（本次梳理时按代码新写）：Skills 安装/缓存/扫描/解析/匹配/路由、LLM Wiki 存储与挂载、项目记忆。

## 在途（in-flight）

- [Wiki 专属能力接口技术方案](./in-flight/wiki-domain-tools-technical-plan.md) —— Wiki 服务、工具契约、安全边界、版本/外部编辑协调、迁移与回退设计；D-TP-01 至 D-TP-05 已决定，复用现有文件存储机制。
- [Wiki 专属能力接口执行计划](./in-flight/wiki-domain-tools-execution-plan.md) —— 对应需求 AC 的实现 DAG、阶段门禁、验证证据和发布回退顺序；尚未开始。

## 说明

本主题的文档主要在**需求侧**（原 109 篇需求里有 10 篇属于此主题，全部归档），develop 侧**原先无独立文档**（原 `docs/develop/` 下无 skills/wiki 专题件）。

| 去向 | 位置 |
| --- | --- |
| 需求口径 | [`../../requirement/knowledge-skills/需求基线.md`](../../requirement/knowledge-skills/需求基线.md) |
| 需求原件（9 件归档） | [`../archive/knowledge-skills/`](../archive/knowledge-skills/)（`docs/requirement/archive/knowledge-skills/` 的对称位） |
| ~~知识库~~（**已于 2026-10-15 移除**） | `docs/knowledge/`（`SCHEMA.md` + `wiki/`，15 文件）随 wiki 跨 profile 整合移除（提交 `054a80f8`）；现行 wiki 数据见 [`技能与知识-现状.md`](./技能与知识-现状.md) §2 |

## 状态提示（文档自述滞后）

`wiki-shared-centralized-storage-requirement.md`（v1.12，已归档）自述无「已实施」标注，但实现已在代码内：

```text
rg -n 'wikiProjectStore|wikiMount|wikiMigration|wikiWriteMutex' electron/wiki
```

配套开发/测试计划：`docs/plan/wiki-shared-centralized-storage-dev-test-plan.md`（不动、只引用）。

## 核验记录

- [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) —— 基线 `17236274`；断言逐条带可复现命令，含「矛盾与时间线检查」「无法核验项」「抽样复核建议」。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/skills electron/wiki
rg -n '<符号>' electron/skills electron/wiki
```
