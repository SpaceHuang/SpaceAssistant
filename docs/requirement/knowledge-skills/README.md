# knowledge-skills —— Skills 与 Wiki 知识能力

> 定位：Skill 发现、安装与执行，以及共享 Wiki 的知识组织和 Agent 能力接口｜代码域：electron/skills/、electron/wiki/
> 核对基线：main 7c0edc41（2026-10-17）

## 需求基线与现行需求

- [需求基线](./需求基线.md) —— 当前有效口径及代码核验入口。
- [Skills 需求](./skills-requirement.md) —— Skill 发现、安装和会话使用约定。

## 在途

- [LLM Wiki 专属能力接口需求（讨论稿）](./in-flight/wiki-domain-tools-requirement.md) —— 将 Wiki 检索、页面保存、Schema 分类、索引和日志维护收敛到 Wiki 专属能力；D-01 至 D-06 均已决定，包含 MCP 式按需加载、单主父级导航、用户确认后应用 SCHEMA、服务维护索引和日志、在 SCHEMA 文档内维护结构化分类。

## 归档

- [knowledge-skills 需求归档](../archive/knowledge-skills/) —— LLM Wiki、Wiki 导入与集中共享存储等既有需求原件。
- [归档索引](../archive/INDEX.md)

## 取证命令

    git log --date=short --format='%ad %h %s' -- electron/skills electron/wiki
    rg -n 'wikiProjectStore|wikiMount|wikiMigration|wikiWriteMutex' electron/wiki

