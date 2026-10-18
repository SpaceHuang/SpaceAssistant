export const DEFAULT_SCHEMA_MD = `# LLM Wiki Schema

> 本文件定义 Wiki 目录约定与 ingest / query / lint 工作流。可与 LLM 协作演化。

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

- \`raw/<projectId>/\`：只读原始资料，按来源项目分目录（\`projectId\` 形如 \`p-<hash8>\`；用户/应用写入，LLM **仅 read**）
- \`wiki/\`：LLM 维护的结构化 Markdown 页面（read/write），**跨项目共享**——写前先读 index + grep 查重，优先更新既有页
- \`wiki/projects/<projectId>/\`：（可选）仅属于单一项目的专属页面分区
- \`SCHEMA.md\`：本规范文件

## 共享协作守则

- Wiki 是跨项目共享记忆库：所有项目的 Agent 共享同一份页面。写页面前先读 \`wiki/index.md\` 并 grep 查重，优先更新既有页面；冲突时合并并注明差异场景。
- 日志条目格式：\`## [YYYY-MM-DD HH:mm] [project:<id>] <动作>\`。
- 不要用 shell / 终端访问 \`llm-wiki/...\` 路径（shell 不经过共享库映射）；一律使用内置文件工具。

## 页面类型

| 类型 | 目录 | 说明 |
|------|------|------|
| entity | wiki/entities/ | 人物、组织、产品等实体 |
| concept | wiki/concepts/ | 概念与术语 |
| topic | wiki/topics/ | 主题综合 / 综述 |
| source | wiki/sources/ | 与 raw 对应的摘要页 |
| query | wiki/queries/ | 由 Query 归档的分析页 |

## Ingest 工作流

1. \`read_file\` 读取 raw 文件
2. 分析要点，更新/创建 wiki 下相关页面（entity、concept、topic、source 等）
3. 更新 \`wiki/index.md\`
4. 向 \`wiki/log.md\` 追加 ingest 条目

**禁止：** 不得修改 \`raw/\`；不得删除 log 历史。

## Query 工作流

1. \`read_file(wiki/index.md)\` — 按分类定位候选页
2. \`read_file\` 深入阅读相关页
3. index 未覆盖时 \`grep(pattern, path=wiki/)\` 补充搜索
4. 综合回答，正文引用 \`wiki/...\` 路径
5. 用户要求时归档为 \`wiki/queries/\` 新页

## Lint 工作流

检查：矛盾声明、过时结论、孤儿页、缺页、缺链、index 与文件系统不一致。

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
