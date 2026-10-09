export const DEFAULT_SCHEMA_MD = `# LLM Wiki Schema

> 本文件定义 Wiki 目录约定与 ingest / query / lint 工作流。可与 LLM 协作演化。

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

本 Skill 指导你使用 SpaceAssistant 内置文件工具维护 Karpathy 式 LLM Wiki。

## 路径约定

Wiki 是 SpaceAssistant 的**跨项目共享记忆库**：所有工作目录共享同一份。路径仍写作 \`llm-wiki/...\`（应用自动映射到共享存储，无需关心物理位置）。**必须先读取** \`llm-wiki/SCHEMA.md\` 获取完整规范。

## 共享协作守则

- 写页面前先 \`read_file\` \`llm-wiki/wiki/index.md\` 并用 \`grep\` 查重，**优先更新既有页面**而非新建平行页；
- 新建实体/概念页时检查是否与其他项目的知识冲突，冲突时合并并在页内注明差异场景；
- 归档仅属于单一项目的专属内容时，放置到 \`llm-wiki/wiki/projects/<projectId>/\` 分区（projectId 形如 \`p-<hash8>\`，在 ingest 结果或 wiki:status 中可见）；
- 日志条目格式：\`## [YYYY-MM-DD HH:mm] [project:<id>] <动作>\`；
- **不要用 shell / 终端访问 \`llm-wiki/...\` 路径**——shell 工作目录不经过共享库映射，会找不到文件；一律使用内置文件工具。

## 工具

使用 \`read_file\`、\`write_file\`、\`edit_file\`、\`grep\`、\`list_directory\`。不依赖其他专用工具。

## Ingest

1. 读取 SCHEMA.md
2. \`read_file\` 目标 raw 文件（路径须在 \`raw/\` 下）
3. 按 SCHEMA 更新 wiki 页面、index.md、log.md
4. **禁止** 写入 \`raw/\`

## Query

1. 读取 SCHEMA.md
2. **必须** \`read_file(wiki/index.md)\` 作为第一步
3. \`read_file\` 相关 wiki 页；index 未覆盖时用 \`grep\` 限定 \`wiki/\` 路径
4. 回答中引用 \`wiki/...\` 路径

## Lint

1. 读取 SCHEMA.md
2. 按 SCHEMA checklist 检查全库
3. 输出结构化报告；修复时走 write_file 确认流
4. 向 log.md 追加 lint 条目

## 语言

默认使用 zh-CN 输出。
`
