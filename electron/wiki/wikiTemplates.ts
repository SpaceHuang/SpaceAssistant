export const DEFAULT_SCHEMA_MD = `# LLM Wiki Schema

> 本文件定义 Wiki 分类和整理原则。页面读写、来源读取、搜索、索引和日志均通过 SpaceAssistant 的 Wiki 领域工具完成。

<!-- wiki-categories:start -->
{
  "formatVersion": 1,
  "categories": [
    { "id": "entity", "name": "实体", "description": "人物、组织、产品等实体", "status": "active" },
    { "id": "concept", "name": "概念", "description": "概念与术语", "status": "active" },
    { "id": "topic", "name": "主题", "description": "主题综合与综述", "status": "active" },
    { "id": "source", "name": "来源摘要", "description": "与原始资料对应的摘要页", "status": "active" },
    { "id": "query", "name": "查询归档", "description": "用户要求归档的查询分析页", "status": "active" }
  ]
}
<!-- wiki-categories:end -->

## 目录说明

- \`raw/<projectId>/\`：按来源项目分区的原始资料；Agent 只通过 \`memory.wiki_read_source\` 按 sourceId 读取。
- \`wiki/\`：跨项目共享的结构化页面；Agent 通过 Wiki 领域工具搜索、打开和保存。
- \`wiki/projects/<projectId>/\`：保留用于兼容既有库的项目页面分区。
- \`SCHEMA.md\`：本规范及唯一的机器可读分类定义。

## 共享协作守则

- Wiki 是跨项目共享记忆库：所有获准的项目会话共享同一份页面。保存前使用 \`memory.wiki_search\` 查重，优先更新既有页面。
- 搜索结果提供稳定页面 ID；通过 \`memory.wiki_open_page\` 和 \`memory.wiki_read_page\` 查看页面，通过 \`memory.wiki_save_page\` 创建或更新。
- 需要整理来源时，先用应用绑定的 sourceId 调用 \`memory.wiki_import_source\`，再用 \`memory.wiki_read_source\` 读取；不得传路径。
- \`index.md\` 与 \`log.md\` 是服务生成的投影。Agent 不直接读写它们。不要用 shell、终端、通用文件或 grep 工具访问 Wiki 路径。

## 页面类型

| 类型 | 目录 | 说明 |
|------|------|------|
| entity | wiki/entities/ | 人物、组织、产品等实体 |
| concept | wiki/concepts/ | 概念与术语 |
| topic | wiki/topics/ | 主题综合 / 综述 |
| source | wiki/sources/ | 与 raw 对应的摘要页 |
| query | wiki/queries/ | 由 Query 归档的分析页 |

## Ingest 工作流

1. 使用应用绑定的 sourceId 调用 \`memory.wiki_import_source\` 导入来源。
2. 使用 \`memory.wiki_read_source\` 按有界片段读取来源。
3. 使用 \`memory.wiki_search\` 查重，再通过 \`memory.wiki_save_page\` 保存页面。
4. 服务自动更新索引与操作日志。

**禁止：** 不得修改 \`raw/\`；不得删除 log 历史。

## Query 工作流

1. 使用 \`memory.wiki_search\` 按关键词查找候选页面。
2. 使用 \`memory.wiki_open_page\` 与 \`memory.wiki_read_page\` 按需读取。
3. 综合回答并引用页面标题；用户要求归档时用 \`memory.wiki_save_page\` 保存。

## Lint 工作流

检查：矛盾声明、过时结论、孤儿页、缺页、缺链。索引与日志由服务维护，Agent 不手动修订。

## 输出语言

默认 zh-CN。
`

export const DEFAULT_INDEX_MD = `# Wiki Index

> 由 LLM 在每次 ingest 后更新。Query 时先读本文件。

## Entities

（暂无）

## Concepts

（暂无）

## Topics

（暂无）

## Sources

（暂无）

## Recent Queries

（暂无）
`

export const DEFAULT_LOG_MD = `# Wiki Log

追加式日志。每条以统一前缀开头，便于 grep。

`

export const WIKI_SUBDIRS = ['raw', 'wiki/entities', 'wiki/concepts', 'wiki/topics', 'wiki/sources', 'wiki/queries'] as const

export const BUNDLED_LLM_WIKI_SKILL_MD = `---
name: llm-wiki
description: "维护 Karpathy 式 LLM Wiki：ingest 原始资料、基于 Wiki 回答问题、lint 健康检查"
triggers:
  - wiki
  - ingest
  - 知识库
  - lint
version: "1.0.0"
author: "SpaceAssistant"
---

# LLM Wiki Skill

本 Skill 指导你使用 SpaceAssistant Wiki 领域工具维护共享知识。

## 路径约定

Wiki 是 SpaceAssistant 的**跨项目共享记忆库**：所有工作目录共享同一份。通过 \`memory\` 工具发现 \`memory.wiki_*\` 操作。**不得**向 Agent 暴露或使用 Wiki 物理路径。
原始来源按 \`raw/[project:<id>]/\` 隔离保存；不要用 shell 绕过 Wiki 领域工具访问这些文件。

## 共享协作守则

- 写页面前先调用 \`memory.wiki_search\` 查重，**优先更新既有页面**而非新建平行页；
- 新建实体/概念页时检查是否与其他项目的知识冲突，冲突时合并并在页内注明差异场景；
- 来源项目只用于来源标注，不是知识访问权限边界；不要在页面中自行猜测 projectId。
- index 与操作日志由 Wiki 服务维护；Agent 不写索引、日志或 raw 原文。

## 工具

先调用 \`memory\` 发现需要的操作和 schema，再使用对应 \`memory.wiki_*\` 工具。发现工具只披露 schema，不代替授权。

## Ingest

1. 使用应用绑定的 sourceId 导入来源；禁止传入任意路径。
2. 通过 \`memory.wiki_read_source\` 分段读取来源，并按 SCHEMA 选择 categoryId。
3. 使用 \`memory.wiki_search\` 查重，使用 \`memory.wiki_save_page\` 保存页面。
4. **禁止** 使用通用文件工具访问或写入 Wiki；禁止 Agent 写入索引、日志和 raw。

## Query

1. 使用 \`memory.wiki_search\` 查找候选页面。
2. 使用 \`memory.wiki_open_page\` 与 \`memory.wiki_read_page\` 按有界片段读取。
3. 回答中引用页面标题，不引用物理路径。

## Lint

1. 使用领域查询读取 SCHEMA 和相关页面。
2. 输出结构化报告；页面修复使用专属保存操作与现有确认流程。
3. 不直接编辑 index.md 或 log.md。

## 语言

默认使用 zh-CN 输出。
`
