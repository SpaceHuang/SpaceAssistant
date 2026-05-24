# LLM Wiki 支持 — 需求规格

**版本：** 1.6  
**日期：** 2026-05-24  
**状态：** 待评审  
**参考来源：** [Karpathy — LLM Wiki (gist)](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)  
**关联文档：** [skills-requirement.md](./skills-requirement.md)、[tools-requirement.md](./tools-requirement.md)、[file-pane-tree-requirement.md](./file-pane-tree-requirement.md)、[file-content-viewer-requirement.md](./file-content-viewer-requirement.md)、[referenced-files-requirement.md](./referenced-files-requirement.md)、[wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05-24 | 初稿：基于 Karpathy LLM Wiki 模式，细化 SpaceAssistant 适配需求 |
| 1.1 | 2026-05-24 | 文件 Tab 改为 VS Code 式双分段布局（文件列表 + LLM Wiki） |
| 1.2 | 2026-05-24 | 取消 `wiki_search` 内置工具，Query 检索统一复用 `grep` + `index.md` |
| 1.3 | 2026-05-24 | 逐项确认 OQ-1～OQ-7 决议并写入正文 |
| 1.4 | 2026-05-24 | Ingest 命令增加中文别名：`/wiki 摄取`、`/wiki 提取`（等效 `ingest`） |
| 1.5 | 2026-05-24 | 新增外部文件「收录到 Wiki」需求，见 [wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md) |
| 1.6 | 2026-05-24 | 用户可见文案统一：Ingest 相关 UI 统称「收录到 Wiki」 |

---

## 目录

1. [概述](#1-概述)
2. [Karpathy 模式摘要](#2-karpathy-模式摘要)
3. [现状分析与适配机会](#3-现状分析与适配机会)
4. [目标与非目标](#4-目标与非目标)
5. [用户故事](#5-用户故事)
6. [Wiki 目录与文件规范](#6-wiki-目录与文件规范)
7. [Schema 机制](#7-schema-机制)
8. [三大核心操作](#8-三大核心操作)
9. [聊天与命令入口](#9-聊天与命令入口)
10. [Wiki 浏览界面](#10-wiki-浏览界面)
11. [工具与自动化扩展](#11-工具与自动化扩展)
12. [配置与数据模型](#12-配置与数据模型)
13. [IPC 接口设计](#13-ipc-接口设计)
14. [与现有功能的关系](#14-与现有功能的关系)
15. [安全与权限](#15-安全与权限)
16. [非功能需求](#16-非功能需求)
17. [发布计划](#17-发布计划)
18. [验收标准](#18-验收标准)
19. [待解决问题](#19-待解决问题)
20. [相关文件](#20-相关文件)

---

## 1. 概述

### 1.1 背景

Karpathy 提出的 **LLM Wiki** 是一种与经典 RAG 不同的个人/团队知识库模式：LLM 不在每次提问时从原始文档中临时检索片段，而是 **增量编译并持续维护** 一套结构化、互相关联的 Markdown Wiki。原始资料只读存放；知识以 Wiki 页面的形式 **复利积累**——交叉引用、矛盾标注、主题综合在 ingest 阶段即完成，查询时直接读取已编译好的页面。

SpaceAssistant 已具备实现该模式的关键基建：

- 工作目录（`workDir`）与沙箱化文件工具（`read_file` / `write_file` / `grep` / `list_directory`）
- Skills 机制（可注入领域操作规范）
- 右侧详情面板文件查看器、引用的文件列表
- 流式聊天 + Tool Use 循环

本需求将 Karpathy 的 **抽象模式** 落地为 SpaceAssistant 可配置、可浏览、可审计的一等功能模块，同时保留「用户与 LLM 协作演化 Schema」的灵活性。

### 1.2 核心差异：LLM Wiki vs RAG vs Skills

| 维度 | 经典 RAG | Skills | LLM Wiki（本需求） |
|------|----------|--------|-------------------|
| 产物 | 临时检索片段 | 运行时 System Prompt 片段 | **持久化 Markdown 页面** |
| 知识是否复利 | 否，每次重发现 | 否，规范静态 | **是，随 ingest/query 增长** |
| 用户可见性 | 低（向量库/片段） | 中（Skill 文件） | **高（可浏览的 Wiki 树）** |
| LLM 职责 | 检索 + 回答 | 遵循规范 | **维护 Wiki + 回答 + 归档** |
| 原始资料 | 索引库 | 无 | **`raw/` 只读归档** |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **Wiki 是一等公民目录** | 目录结构固定约定；文件 Tab 下半区独立分段展示 Wiki |
| **raw 不可变、wiki 由 LLM 写** | 工具层面对 `raw/` 写操作需用户确认或禁止 |
| **Schema 可协作演化** | 初始模板由应用提供，用户与 LLM 可共同修改 |
| **渐进增强** | Phase 1 靠 Skill + 现有文件工具即可跑通；后续加 UI、搜索、Lint 辅助 |
| **不替代 Skills** | Wiki Skill 管「知识库维护工作流」；其他 Skills 管「任务执行规范」 |

---

## 2. Karpathy 模式摘要

> 以下摘自 [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)，作为本需求的理论依据；具体目录名与页面格式由本文档 §6–§7 在 SpaceAssistant 语境下实例化。

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Schema（配置/规范）                                         │
│  告诉 LLM：目录约定、页面类型、ingest/query/lint 工作流       │
└───────────────────────────┬─────────────────────────────────┘
                            │ 指导
┌───────────────────────────▼─────────────────────────────────┐
│  Wiki（LLM 维护层）                                          │
│  实体页、概念页、主题综合、对比分析… 互链 Markdown            │
│  特殊文件：index.md（目录）、log.md（时间线）                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ 编译自
┌───────────────────────────▼─────────────────────────────────┐
│  Raw Sources（只读源）                                       │
│  文章、论文、笔记、剪藏… LLM 读取但不修改                     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 三大操作

| 操作 | 目的 | 典型产出 |
|------|------|----------|
| **Ingest** | 将新资料编译进 Wiki | 更新 10–15 个相关页面、`index.md`、`log.md` |
| **Query** | 基于 Wiki 回答问题 | 带引用的回答；**优质回答可归档为新 Wiki 页** |
| **Lint** | 健康检查 | 矛盾、过时声明、孤儿页、缺失交叉引用、待补来源 |

### 2.3 索引策略

Karpathy 建议在中等规模（~100 源、数百页）下，**先读 `index.md` 定位页面，再深入阅读**，无需 embedding RAG。SpaceAssistant **不内置**专用 Wiki 搜索工具；规模变大时优先 **`grep` 限定 `wiki/` 路径** 或 **`list_directory` 枚举**，用户在 SCHEMA 中也可自行约定外部工具（如 [qmd](https://github.com/tobi/qmd)）——属于可选扩展，非产品必达能力。

---

## 3. 现状分析与适配机会

### 3.1 已有能力映射

| 现有模块 | 与 LLM Wiki 的关系 |
|----------|-------------------|
| `workDir` + 路径沙箱 | Wiki 根目录挂载在工作目录下，天然受 `pathSecurity` 保护 |
| 内置文件工具 | Ingest/Query/Lint 的文件读写主体；LLM 通过 Tool Use 维护 Wiki |
| 内置 `grep` | 已基于 ripgrep，可限定 `path: llm-wiki/wiki` 做 Wiki 内检索，**无需**另建 `wiki_search` |
| Skills | 承载 `llm-wiki` Skill，注入 ingest/query/lint 工作流与 Schema 摘要 |
| 文件树 + 详情面板 | 用户浏览 Wiki 页面；Obsidian 式「LLM 写、人读」体验 |
| 引用的文件 | 会话内 Wiki 变更可追溯 |
| Plan 模式 | **首版不整合**（OQ-5）；Phase 3 再评估 Wiki 专用 Plan 模板 |
| 上下文占用环 | Query 时读多页 Wiki，需纳入上下文估算 |

### 3.2 缺口

| 缺口 | 说明 |
|------|------|
| Wiki 目录约定 | 无标准 `raw/`、`wiki/`、`index.md` 布局 |
| Schema 模板 | 无开箱即用的 Wiki 维护规范文件 |
| 专用 Skill | 未内置 Karpathy 式 `llm-wiki` Skill |
| 聊天命令 | 无 `/wiki ingest` 等快捷入口 |
| raw 只读策略 | 文件工具未区分 Wiki 子目录权限 |
| Wiki 浏览 UI | 文件 Tab 无独立 Wiki 分段；无 index 导航、无页面间链接跳转 |
| 会话级 Wiki 上下文 | Query 时未自动注入 `index.md` 或相关页摘要 |
| Lint / 搜索辅助 | 无 raw 只读拦截；Lint 无结构化 checklist 模板（检索本身已有 grep） |

---

## 4. 目标与非目标

### 4.1 目标

| # | 目标 |
|---|------|
| G1 | 在工作目录下支持 **标准化 LLM Wiki 目录结构**（`raw/` + `wiki/` + Schema） |
| G2 | 提供 **可安装/内置的 `llm-wiki` Skill**，使 Agent 能按规范执行 Ingest / Query / Lint |
| G3 | 聊天内支持 **`/wiki` 斜杠命令**，显式触发三大操作 |
| G4 | 文件 Tab 采用 **双分段可收起布局**（上：文件列表，下：LLM Wiki）；详情面板支持 Wiki 内链跳转 |
| G5 | **`raw/` 层只读保护**（LLM 不可 silently 修改原始资料） |
| G6 | Query 回答中 **引用 Wiki 页面路径**；用户可选 **将回答归档为 Wiki 新页** |
| G7 | 设置页提供 Wiki **启用开关、根路径、初始化向导** |
| G8 | Ingest / Lint 产生的 Wiki 变更在 **引用的文件** 与工具卡片中可追踪 |

### 4.2 非目标

| 项目 | 说明 |
|------|------|
| 完整 Obsidian 替代品 | 不做插件生态、图谱编辑；仅只读预览 + 链接跳转 |
| 云端同步 / 多人协作 | Wiki 为本地 Git 可管的 Markdown；协作靠 Git，不在应用内实现 |
| 替代向量 RAG 基础设施 | 首版不内置 embedding 索引；Wiki 检索复用 `grep`，不新增 `wiki_search` 工具 |
| 自动后台 Ingest | 不监听文件夹自动 ingest；由用户或命令显式触发 |
| 图片 OCR / PDF 解析引擎 | 复杂格式转换依赖用户预处理或 LLM 多模态；首版仅支持文本类 Markdown |
| 专用 Wiki 搜索工具 | 不新增 `wiki_search`；`grep` + `index.md` 已覆盖 Karpathy 推荐的中等规模场景 |
| 企业级 Wiki 审批流 | 不做 human-in-the-loop 发布门禁（可后续加） |

---

## 5. 用户故事

### US-01：初始化 Wiki

**作为研究者**，我希望在设置中一键初始化 Wiki 目录结构，以便立即开始往 `raw/` 放入资料并让 AI 维护 Wiki。

### US-02：Ingest 新资料

**作为读者**，我把剪藏的文章放进 `raw/`，在聊天输入 `/wiki ingest raw/2026-04-03-article.md`（或 `/wiki 摄取 …`、`/wiki 提取 …`），希望 AI 总结要点、更新实体页与 `index.md`，并在详情面板看到新页面。

### US-03：基于 Wiki 提问

**作为用户**，我问「X 和 Y 有什么矛盾？」，希望 AI **先查 `wiki/index.md` 定位页面**，再综合回答并给出 `wiki/...` 路径引用。

### US-04：归档优质回答

**作为用户**，当 AI 给出一份很好的对比分析后，我希望点击「归档到 Wiki」，将其保存为 `wiki/...` 新页并更新 index。

### US-05：Lint 健康检查

**作为长期使用者**，我执行 `/wiki lint`，希望 AI 列出矛盾页、孤儿页、过时声明，并可选自动修复交叉链接。

### US-06：浏览 Wiki

**作为用户**，我希望在文件 Tab 中像 VS Code 资源管理器一样，**上方浏览项目文件、下方浏览 LLM Wiki**，两个分段均可独立收起；从 Wiki 分段的 `index.md` 进入，点击文内 `[[]]` 或 Markdown 链接在右侧预览跳转。

### US-07：保护原始资料

**作为用户**，我不希望 AI 在 Ingest 时意外改写 `raw/` 里的原文；若必须修正格式，需经我确认。

### US-08：与 Skills 共存

**作为开发者**，我的项目已有代码审查 Skill；启用 Wiki 后，研究类问题走 Wiki Query，写代码仍走原有 Skill，互不干扰。

---

## 6. Wiki 目录与文件规范

### 6.1 根路径

| 项 | 规格 |
|----|------|
| 默认根目录 | `<workDir>/llm-wiki/`（**可见目录**，已决议 OQ-1） |
| 可配置 | `AppConfig.wiki.rootPath` 可为相对 `workDir` 的路径，默认 `llm-wiki` |
| 初始化 | 目录不存在时，通过「初始化 Wiki」创建标准结构 |
| 命名原则 | **不**采用 `.llm-wiki` 隐藏目录；便于 Git 管理、Obsidian 打开、文件 Tab Wiki 分段展示 |

### 6.2 标准目录树

```
<workDir>/llm-wiki/
├── SCHEMA.md              # Wiki 维护规范（见 §7）
├── raw/                   # 只读源（用户写入；LLM 仅 read；首版仅文本类，见 §6.7）
│   └── YYYY-MM-DD-slug.md # 建议命名：日期 + 短 slug（.md / .txt）
├── wiki/                  # LLM 维护层（LLM read/write）
│   ├── index.md           # 全库目录（必读入口）
│   ├── log.md             # 追加式操作日志
│   ├── entities/          # 实体页（人物、组织、产品…）
│   ├── concepts/          # 概念页
│   ├── topics/            # 主题综合 / 综述
│   ├── sources/           # 与 raw 对应的摘要页（可选）
│   └── queries/           # 由 Query 归档的分析页（可选）
└── .wiki-meta.json        # 应用维护的元数据（版本、最后 lint 时间等，可选）
```

> **说明：** 子目录名可在 SCHEMA 中与 LLM 协作调整；应用只 **强制** 存在 `raw/`、`wiki/`、`wiki/index.md`、`wiki/log.md`、`SCHEMA.md`。

### 6.3 `wiki/index.md` 格式（模板）

```markdown
# Wiki Index

> 由 LLM 在每次 ingest 后更新。Query 时先读本文件。

## Entities
- [entity-name](entities/entity-name.md) — 一行摘要

## Concepts
- [concept-name](concepts/concept-name.md) — 一行摘要

## Topics
- [topic-name](topics/topic-name.md) — 一行摘要

## Sources
- [2026-04-03-article](sources/2026-04-03-article.md) — 一行摘要 · raw: `../raw/2026-04-03-article.md`

## Recent Queries
- [comparison-x-y](queries/comparison-x-y.md) — 一行摘要
```

### 6.4 `wiki/log.md` 格式（模板）

```markdown
# Wiki Log

追加式日志。每条以统一前缀开头，便于 grep。

## [2026-05-24T10:00:00] ingest | 2026-04-03-article.md
- 新建 sources/2026-04-03-article.md
- 更新 entities/foo.md, topics/bar.md
- index 已更新

## [2026-05-24T11:30:00] query | 「X 与 Y 的差异」
- 只读，未写入 Wiki

## [2026-05-24T12:00:00] lint | 全库
- 发现 2 处矛盾，1 个孤儿页
```

**日志条目前缀规范：** `## [ISO8601] <operation> | <summary>`

### 6.5 Wiki 页面 Front Matter（推荐）

Lint 与 UI 筛选可依赖 YAML front matter（LLM 在 SCHEMA 指导下添加）：

```yaml
---
title: Page Title
type: entity | concept | topic | source | query
sources: ["raw/2026-04-03-article.md"]
updated: 2026-05-24
tags: [tag1, tag2]
---
```

### 6.6 命名与链接约定

| 规则 | 说明 |
|------|------|
| 文件名 | 小写、连字符分词、`*.md` |
| 站内链接 | 相对路径 Markdown 链接；支持 Obsidian 式 `[[page-name]]`（渲染时解析） |
| 指向 raw | 使用相对路径 `` [`raw/...`](../raw/...) ``，仅引用不嵌入全文 |
| 矛盾标注 | 在正文中用固定块引用格式：`> ⚠️ 矛盾：...（见 [other](path)）` |

### 6.7 raw 资料格式（OQ-7 已决议）

| 项 | 规格 |
|----|------|
| 首版支持 | **仅文本类**：`.md`、`.txt`（及同内容可 utf-8 读取的纯文本） |
| 首版不支持 | 图片、PDF、Office 等二进制格式的自动 ingest |
| 用户若放入非文本 raw | Ingest 前提示「首版仅支持文本 raw」；LLM 不应尝试解析二进制 |
| 后续扩展 | 多模态 ingest 单独立项，不在当前范围 |

---

## 7. Schema 机制

### 7.1 `SCHEMA.md` 角色

对应 Karpathy 的 CLAUDE.md / AGENTS.md：定义 **Wiki 如何组织、如何 ingest/query/lint**。应用初始化时写入 **默认模板**；用户与 LLM 可随使用演化。

### 7.2 默认模板内容纲要

初始化时 `SCHEMA.md` 应包含：

1. **目录说明**：`raw/` vs `wiki/` 职责
2. **页面类型**：entity / concept / topic / source / query 的定义与示例
3. **Ingest 工作流**：读 raw → 与用户讨论要点（可选）→ 写/更新 wiki 页 → 更新 index → 追加 log
4. **Query 工作流**：`read_file(index)` → 定位页 → `read_file` 深入 → index 未覆盖时 `grep(path=wiki/)` → 带路径引用回答 → 若用户要求则归档
5. **Lint 工作流**：矛盾、过时、孤儿、缺页、缺链 checklist
6. **禁止事项**：不得修改 `raw/`；不得删除 log 历史；index 必须保持可扫描
7. **输出语言**：默认 zh-CN（与产品一致）

> **OQ-2 已决议：** SCHEMA **不包含** Obsidian Web Clipper 等第三方工具指引；用户自行选择 raw 来源工具。

### 7.3 与 Skill 的关系

| 载体 | 职责 |
|------|------|
| `SCHEMA.md` | 领域特定、可演化、随 Wiki 仓库 Git 管理 |
| `llm-wiki` Skill | 通用工作流、触发词、与 SpaceAssistant 工具配合方式 |

**加载顺序（Query/Ingest/Lint 时）：**

1. 自动加载 `llm-wiki` Skill（若已启用）
2. 读取 `<wikiRoot>/SCHEMA.md` 注入 system prompt（截断策略见 §16）
3. **不**预注入 `wiki/index.md`（OQ-3 已决议）；由 Skill 规定 Query 第一步 `read_file(wiki/index.md)`

### 7.4 内置 Skill：`llm-wiki`（OQ-6 已决议）

应用 **内置** `llm-wiki` Skill 资源；`wiki:init` 初始化 Wiki 时 **自动安装** 到 `<workDir>/.space-skills/llm-wiki/`（与 [skills-requirement.md](./skills-requirement.md) 项目级 Skill 规范一致）。若已存在同名 Skill，默认 **不覆盖**（`wiki:init` 可选 `installSkill: true` 强制重装）。

参考实现可借鉴 [hdonghong/karpathy-llm-wiki](https://github.com/hdonghong/karpathy-llm-wiki) 的工作流封装：

```yaml
---
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
```

Skill 正文引用 SCHEMA 路径，并说明使用 `read_file` / `write_file` / `grep` / `list_directory` 的操作顺序；**Query 必须显式 read index，不依赖应用预注入**。**不**在 Skill 内重复 SCHEMA 的领域细节。

---

## 8. 三大核心操作

### 8.1 Ingest

#### 8.1.1 触发方式

| 方式 | 说明 |
|------|------|
| `/wiki ingest <rawRelPath>` | 处理单个 raw 文件 |
| `/wiki 摄取 <rawRelPath>` | **中文别名**，等效 `ingest` |
| `/wiki 提取 <rawRelPath>` | **中文别名**，等效 `ingest` |
| `/wiki ingest --all` | 批量处理 `raw/` 下尚未 ingest 的文件（见 §8.1.4）；**无**中文别名 |
| 聊天自然语言 | 「把 raw/xxx 编进 Wiki」→ 自动激活 `llm-wiki` Skill |
| 文件树右键 | raw 文件上「收录到 Wiki」（Phase 2；Phase 2.5 统一文案，原「Ingest 到 Wiki」） |
| 文件列表 / 详情面板 | **任意 workDir 内文本文件**「收录到 Wiki」：先拷贝至 `raw/` 再 Ingest（Phase 2.5，见 [wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md)） |

#### 8.1.2 执行流程

```
用户触发 ingest
    ↓
校验：Wiki 已初始化、raw 文件存在、路径在 raw/ 下
    ↓
加载 llm-wiki Skill + SCHEMA.md
    ↓
LLM read_file(raw) → 分析
    ↓
（可选）向用户摘要要点，询问强调方向 — 首版可省略，由设置 wiki.interactiveIngest 控制
    ↓
LLM 批量 write_file / edit wiki 下多页
    ↓
更新 wiki/index.md、追加 wiki/log.md
    ↓
UI：工具卡片 + 引用的文件列表刷新；可选 Toast「Ingest 完成，更新 N 页」
```

#### 8.1.3 写入确认策略

| 路径 | confirmMode 行为 |
|------|------------------|
| `wiki/**` | 遵循全局 `tools.confirmMode`（默认 diff 确认） |
| `raw/**` | **禁止 LLM 写入**；若用户手动编辑 raw，与 Wiki 无关 |
| `SCHEMA.md` | 写入需确认（medium risk） |

#### 8.1.4 批量 Ingest 与去重

- `.wiki-meta.json` 或 `log.md` 记录已 ingest 的 raw 路径
- `--all` 仅处理尚未出现在 log 中 `ingest` 条目的 raw 文件
- 单批上限默认 10 个文件（`wiki.maxBatchIngest`），防止上下文爆炸

#### 8.1.5 并行 Ingest 与冲突（OQ-4 已决议）

| 项 | 策略 |
|----|------|
| 并发模型 | **乐观并发**：不全局锁、不排队；多会话可同时 ingest |
| 写入安全 | `write_file` 仍走 diff 确认 + 文件 checkpoint |
| 冲突处理 | 应用 **不** 做 merge；冲突由用户在 Git 中解决 |
| 用户提示 | Wiki 设置或 SCHEMA 中说明：「Wiki 为共享目录，并行 ingest 可能产生编辑冲突」 |
| 后续 | 若反馈强烈再评估单会话锁或 ingest 队列（当前 **非目标**） |

### 8.2 Query

#### 8.2.1 触发方式

| 方式 | 说明 |
|------|------|
| `/wiki query <question>` | 显式 Wiki 模式提问 |
| `/wiki <question>` | `query` 子命令可省略 |
| 自然语言 + Skill 匹配 | 含「根据 Wiki」「知识库」等触发词 |

#### 8.2.2 执行流程

```
用户问题
    ↓
加载 llm-wiki Skill + SCHEMA.md
    ↓
LLM read_file(wiki/index.md) → 选定相关页
    ↓
（index 未覆盖时）LLM grep(pattern, path=wiki/) → 补充候选页
    ↓
LLM read_file(相关 wiki 页…) 
    ↓
综合回答，正文内引用 `wiki/...` 路径
    ↓
（可选）UI 显示「归档到 Wiki」按钮
    ↓
追加 log（query 条目，标注是否归档）
```

#### 8.2.3 回答引用格式

助手消息应包含 **可点击的 Wiki 路径**（链到详情面板打开文件）：

```markdown
根据 [entities/foo](wiki/entities/foo.md) 与 [topics/bar](wiki/topics/bar.md) …
```

#### 8.2.4 归档回答

| 项 | 规格 |
|----|------|
| 入口 | 助手消息操作栏「归档到 Wiki」 |
| 默认路径 | `wiki/queries/YYYY-MM-DD-slug.md` |
| 流程 | 将回答整理为 Markdown 页 → LLM 或模板写入 → 更新 index → log |
| 会话 | 归档后写入引用的文件 |

### 8.3 Lint

#### 8.3.1 触发方式

`/wiki lint` 或 `/wiki lint --fix`（允许 LLM 在确认后修复）

#### 8.3.2 检查项

| 检查项 | 说明 |
|--------|------|
| 矛盾 | 跨页声明冲突 |
| 过时 | 新 source 已 supersede 旧结论但未更新 |
| 孤儿页 | wiki 内无入链的页面 |
| 缺页 | index 或正文提到但文件不存在 |
| 缺链 | 实体首次出现却无 entity 页 |
| raw 覆盖 | raw 有文件但 sources 无对应摘要（可选） |
| index 一致性 | index 条目与文件系统不一致 |

#### 8.3.3 输出

- 聊天内结构化报告（表格或列表）
- 追加 `log.md` lint 条目
- `--fix` 时修复操作走 write_file 确认流

---

## 9. 聊天与命令入口

### 9.1 `/wiki` 斜杠命令

| 命令 | 功能 |
|------|------|
| `/wiki help` | 显示帮助 |
| `/wiki init` | 在当前 workDir 初始化 Wiki 结构（需确认） |
| `/wiki ingest <path>` | Ingest 指定 raw 文件 |
| `/wiki 摄取 <path>` | 同 `ingest`（中文别名） |
| `/wiki 提取 <path>` | 同 `ingest`（中文别名） |
| `/wiki ingest --all` | 批量 ingest |
| `/wiki query <question>` | Wiki 模式提问 |
| `/wiki <question>` | 同 query |
| `/wiki lint` | 健康检查 |
| `/wiki lint --fix` | 检查并提议修复 |
| `/wiki status` | 显示 Wiki 根路径、页数、最近 log 条目 |

**实现：** 新建 `wikiCommandService.ts`，模式对齐 [skillCommandService.ts](../../src/renderer/services/skillCommandService.ts)。`ingest` / `摄取` / `提取` 在解析层归一化为同一子命令后再走 Ingest 流程。

### 9.2 命令与 Skill 联动

- 解析到 `/wiki` 命令时：**强制激活** `llm-wiki` Skill（等同 `/skill use llm-wiki` 的会话级效果）
- 记录到 `session.metadata` 的 wiki 操作日志（对齐 Skill activation log）

### 9.3 系统提示

命令执行后在聊天区插入不可持久化的系统提示行：

```
[Wiki] Ingest 已开始：raw/2026-04-03-article.md
[Wiki] 已加载 index.md（142 页）
```

---

## 10. Wiki 浏览界面

### 10.1 文件 Tab 双分段布局（Phase 2）

文件 Tab 采用与 **VS Code 资源管理器** 相近的分段结构：上方为项目 **文件列表**，下方为 **LLM Wiki**，两段均为 **可独立展开/收起的 Section**，而非将 Wiki 嵌为文件树顶部的虚拟节点。

#### 10.1.1 整体结构

```
┌─ 文件 Tab ─────────────────────────────────────┐
│ [工具栏：新建文件 / 新建目录 / 刷新]             │  ← 作用于「文件列表」分段
├────────────────────────────────────────────────┤
│ ▼ 文件列表                                      │  ← Section 标题行（可点击收起）
│   📁 <workDir 根目录名>                         │
│   ├── src/                                     │
│   ├── docs/                                    │
│   └── …                                        │
│   （启用 Wiki 时默认 **不展示** wiki.rootPath）  │
├────────────────────────────────────────────────┤  ← 可选：可拖动分隔条调节上下高度
│ ▼ LLM Wiki                                      │  ← Section 标题行（可点击收起）
│   📄 SCHEMA.md                                 │
│   📁 raw/                                      │
│   📁 wiki/                                     │
│   │   📄 index.md          ← 推荐入口，可弱高亮 │
│   │   📄 log.md                                │
│   │   📁 entities/                             │
│   │   📁 concepts/                             │
│   │   └── …                                    │
│   └── …                                        │
└────────────────────────────────────────────────┘
```

**与 VS Code 的对应关系：**

| VS Code 资源管理器 | SpaceAssistant 文件 Tab |
|-------------------|-------------------------|
| 文件树（Folder 视图） | **文件列表** 分段 |
| 大纲（Outline，当前文件结构） | **LLM Wiki** 分段（Wiki 目录树，非单文件大纲） |

> Wiki 分段展示的是 **Wiki 根目录下的目录树**，语义上类似「专用资源视图」，布局交互对齐 VS Code 的多 Section 折叠模式。

#### 10.1.2 Section 标题行规格

| 元素 | 规格 |
|------|------|
| 标题文案 | 上段固定 **「文件列表」**；下段固定 **「LLM Wiki」** |
| 展开/收起 | 左侧 chevron（`▼` 展开 / `▶` 收起）；点击 **整行标题** 切换 |
| 字体 | 11px，secondary 色，全大写或半粗（与 VS Code Section 风格一致） |
| 默认状态 | 两段默认 **展开** |
| 持久化 | 收起状态写入 UI 偏好（如 `localStorage` 或 `AppConfig.ui.filePaneSections`），重启后恢复 |
| 可见性 | `wiki.enabled === false` 时 **仅渲染「文件列表」**，不占位 LLM Wiki 分段 |

#### 10.1.3 文件列表分段（上）

| 项 | 规格 |
|----|------|
| 内容 | 现有文件树（见 [file-pane-tree-requirement.md](./file-pane-tree-requirement.md)） |
| 根节点 | `workDir` 项目根，行为与现网一致 |
| Wiki 目录排除 | `wiki.enabled === true` 且 Wiki 已初始化时，文件列表 **隐藏** `wiki.rootPath` 子树（默认 `llm-wiki/`），避免与下段重复展示；用户可在设置中关闭「从文件列表隐藏 Wiki 目录」（见 §12.1 `hideWikiFromFileTree`） |
| 工具栏 | 保留在 Tab 顶栏；新建/刷新等操作 **仅作用于文件列表** |
| 滚动 | Section 内容区独立 `overflow-y: auto` |
| 最小高度 | 收起时为 0（仅标题行）；展开时建议 min-height ~120px |

#### 10.1.4 LLM Wiki 分段（下）

| 项 | 规格 |
|----|------|
| 显示条件 | `wiki.enabled === true` |
| 根节点 | Wiki 根目录（`<workDir>/<wiki.rootPath>/`），展示 `SCHEMA.md`、`raw/`、`wiki/` 等 |
| 树行为 | 与文件列表相同：目录懒加载、单击文件打开详情面板、单击目录展开/折叠 |
| 推荐入口 | `wiki/index.md` 在树中 **弱高亮**（如左侧色条或 bold） |
| 未初始化 | Section 内显示占位：「Wiki 尚未初始化」+ **「初始化 Wiki」** 按钮（调用 `wiki:init`） |
| 空 raw/ | 允许；`raw/` 无文件时仍显示空目录节点 |
| 工具栏 | Section 标题行右侧可选操作：**刷新**、**在资源管理器中打开**（Phase 2，`wiki:open-root`） |
| 滚动 | 独立 `overflow-y: auto` |
| 最小高度 | 展开时建议 min-height ~100px |

#### 10.1.5 分段间高度与分隔

| 项 | 规格 |
|----|------|
| 布局 | 上下堆叠；文件列表在上，LLM Wiki 在下 |
| 高度分配 | 默认：文件列表占剩余空间 **60%**，LLM Wiki 占 **40%**（Wiki 分段未显示时文件列表占满） |
| 可拖动分隔条 | Phase 2 **可选**：两段之间 4px 拖拽手柄，调整比例；比例持久化 |
| 收起交互 | 任一段收起后，另一段 **占满** 该 Section 可用高度 |

#### 10.1.6 选中态与跨分段

| 场景 | 行为 |
|------|------|
| 选中文件 | 文件列表与 Wiki 分段 **互斥高亮**（同一时刻仅一段内一个节点选中） |
| 从聊天打开 Wiki 页 | 自动展开 LLM Wiki 分段，选中并 scrollIntoView 对应节点 |
| 从详情面板内链跳转 | 若目标在 Wiki 下，高亮 Wiki 分段内节点；若在项目文件中，高亮文件列表分段 |

### 10.2 Wiki 树内交互（Phase 2）

| 行为 | 说明 |
|------|------|
| 点击 `index.md` | 右侧详情面板打开；顶栏可选「Index 视图」渲染（分类列表，见 §10.3） |
| Wiki 内链 | Markdown 预览点击相对链接 → 在同一详情面板打开目标页，并同步 Wiki 分段选中态 |
| `[[wikilink]]` | 解析为 `wiki/` 下同名 md（简单规则，首版不支持 alias） |
| raw 文件右键 | 「收录到 Wiki」（见 §8.1.1） |

### 10.3 Index 快捷视图（Phase 2，可选）

详情面板打开 `wiki/index.md` 时，顶栏可切换 **「树视图 / Index 视图」**：Index 视图按 Entities / Concepts / Topics 分组列表，点击条目打开对应页（与 Wiki 分段树互补，非替代）。

### 10.4 引用的文件集成

Wiki 相关路径在引用的文件列表中带 **Wiki 徽章**；`raw/` 与 `wiki/` 分组或 filter。

### 10.5 与 Obsidian 的关系

产品 **不内置** Obsidian；用户可在外部用 Obsidian 打开同一文件夹。SpaceAssistant 提供 **只读预览 + 链接跳转**；文件 Tab 下半段的 LLM Wiki 分段对应 Karpathy「Obsidian 是 IDE，LLM 是程序员」中 **浏览 Wiki 产物** 的角色。

---

## 11. 工具与自动化扩展

### 11.1 Phase 1：复用现有内置工具

Ingest / Query / Lint **不新增** IPC，完全依赖：

- `read_file`
- `write_file` / `edit_file`
- `grep`
- `list_directory`

### 11.2 Wiki 检索：复用 `grep`，不新增 `wiki_search`

**结论：`grep` 足够，不计划内置 `wiki_search` 工具。**

原 Phase 3 曾设想在 Wiki 页数超过阈值时注册专用搜索工具。经评估，SpaceAssistant 已有基于 ripgrep 的 `grep` 工具，能力与 Karpathy gist 在中等规模下推荐的「index + 按需深入」策略重叠，新增 `wiki_search` 属于重复建设。

#### 11.2.1 为何 `grep` 够用

| 能力 | `grep`（现网） | 曾设想的 `wiki_search` |
|------|----------------|------------------------|
| Wiki 范围限定 | `path: "llm-wiki/wiki"` 或相对路径 | 默认 wiki 根 |
| 关键词命中 | ripgrep 正则 / 字面量 | 同类 |
| 上下文行 | `-A/-B/-C`、`output_mode` | snippet |
| 性能 | 本地 rg，百～千页 Markdown 无压力 | 同类或更重 |
| 维护成本 | 零（已有） | 新工具定义、执行器、测试、文档 |

Karpathy 明确指出：~100 源、数百页时 **先读 `index.md`** 往往优于向量检索；`grep` 适合 index 未覆盖时的 **补充定位**（实体名、专有名词、矛盾标注 `⚠️` 等）。

#### 11.2.2 Query 推荐检索顺序（写入 SCHEMA / Skill）

```
1. read_file(wiki/index.md)     → 按分类定位候选页
2. read_file(候选页…)          → 深入阅读
3. grep(pattern, path=wiki/)   → index 未命中时的补充搜索
4. list_directory(wiki/…)      → 枚举某子目录（如 entities/）
```

**`grep` 调用示例（LLM 通过工具）：**

```json
{
  "pattern": "contradict|矛盾",
  "path": "llm-wiki/wiki",
  "glob": "**/*.md",
  "output_mode": "content",
  "-i": true,
  "head_limit": 30
}
```

#### 11.2.3 何时仍可能需要「更强搜索」

以下场景 **不在 SpaceAssistant 产品范围内**，用户可在 SCHEMA 中自行约定：

| 场景 | 建议 |
|------|------|
| 千页以上、纯语义「找相似概念」 | 用户自建 [qmd](https://github.com/tobi/qmd) 等 CLI，LLM 通过 `run_script` 调用（若用户启用） |
| 需要 BM25 + 向量混合排序 | 外部工具；非内置 |
| index 过大无法一次 read | 拆分 index（按字母/类别多文件），或 grep 扫 front matter |

若未来 **实测量级** 证明 `grep` + 分片 index 仍不足，再单独立项评估；**当前需求不预留 `wiki_search` 接口**。

### 11.3 Phase 3：可选 `wiki:parse-index` IPC（仅 UI）

返回解析后的 `index.md` 结构（JSON），供文件 Tab **Index 视图**渲染，**不是** LLM 工具。LLM 侧仍 `read_file(index.md)` 即可；首版 UI 可直接读 Markdown 不强制该 IPC。

### 11.4 raw 只读执行层

在 `builtinExecutors.ts` 的 `write_file` / `edit_file` 执行前增加：

```typescript
if (isUnderWikiRaw(relPath, wikiConfig)) {
  throw new ToolError('WIKI_RAW_READONLY', 'raw/ 为只读源，不可通过工具修改')
}
```

用户通过 OS 或文件树手动编辑 raw **不受限**。

---

## 12. 配置与数据模型

### 12.1 AppConfig 扩展

```typescript
export interface WikiConfig {
  /** 是否启用 LLM Wiki 功能 */
  enabled: boolean
  /** 相对 workDir 的 Wiki 根路径 */
  rootPath: string
  /** 启用 Wiki 时，从上方「文件列表」分段隐藏 wiki.rootPath，避免与下方 Wiki 分段重复 */
  hideWikiFromFileTree: boolean
  /** Ingest 前是否与用户交互确认要点 */
  interactiveIngest: boolean
  /** 批量 ingest 单批上限 */
  maxBatchIngest: number
}

/** 文件 Tab 分段 UI 状态（可存 localStorage 或 AppConfig.ui） */
export interface FilePaneSectionUiState {
  fileListCollapsed: boolean
  llmWikiCollapsed: boolean
  /** 文件列表分段占比 0~1；仅当 Wiki 分段可见时有效 */
  fileListHeightRatio: number
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  enabled: false,
  rootPath: 'llm-wiki',
  hideWikiFromFileTree: true,
  interactiveIngest: false,
  maxBatchIngest: 10
}
```

### 12.2 会话元数据

```typescript
interface SessionWikiState {
  /** 本会话是否处于 Wiki 模式（由 /wiki 命令激活） */
  wikiModeActive: boolean
  /** 本会话已归档的 query 页路径 */
  archivedQueries: string[]
}

// 存入 Session.metadata.wiki
```

### 12.3 `.wiki-meta.json`（可选）

```typescript
interface WikiMeta {
  schemaVersion: 1
  initializedAt: string
  lastLintAt?: string
  ingestedRawPaths: string[]
  pageCount?: number
}
```

由应用在 ingest/lint 成功后更新，供 `wiki status` 与 UI 展示。

---

## 13. IPC 接口设计

### 13.1 Phase 1 最小接口

| 通道 | 参数 | 返回值 | 功能 |
|------|------|--------|------|
| `wiki:init` | `{ overwrite?: boolean; installSkill?: boolean }` | `{ ok: true; rootPath: string; skillInstalled: boolean } \| { ok: false; error }` | 创建标准目录与模板；**默认安装** `llm-wiki` Skill 到 `.space-skills/` |
| `wiki:status` | `{}` | `WikiStatus` | 是否已初始化、页数、路径、最近 log |
| `wiki:get-schema` | `{}` | `{ content: string } \| null` | 读取 SCHEMA.md |
| `wiki:resolve-path` | `{ relPath: string }` | `{ absPath: string; kind: 'raw' \| 'wiki' \| 'schema' \| 'other' }` | 供 UI 解析链接 |

```typescript
interface WikiStatus {
  enabled: boolean
  rootPath: string
  initialized: boolean
  pageCount: number
  rawCount: number
  lastLogEntry?: string
}
```

### 13.2 Phase 2 扩展

| 通道 | 功能 |
|------|------|
| `wiki:list-pages` | 列出 wiki 下所有 md（供 Index 面板） |
| `wiki:parse-index` | 解析 index.md 为结构化条目 |
| `wiki:open-root` | 在系统文件管理器中打开 Wiki 根目录 |

### 13.3 现有通道变更

| 通道 | 变更 |
|------|------|
| `config:get` / `config:set` | 增加 `wiki: WikiConfig` |
| 文件工具执行 | 增加 raw 只读校验（§11.4） |

---

## 14. 与现有功能的关系

| 功能 | 关系 |
|------|------|
| **Skills** | `llm-wiki` 为专用 Skill；与项目其他 Skill 并行匹配 |
| **Tools** | Wiki 维护与检索均通过现有文件工具；Query 用 `index.md` + `grep`，不新增搜索工具 |
| **Plan 模式** | **首版不整合**（OQ-5）；Phase 3 再评估；长任务暂用普通 Tool 循环 |
| **上下文占用环** | Query 读取多页时计入 estimated tokens |
| **文件 checkpoint** | Wiki 页 write 前快照，支持回滚 |
| **会话备份** | Wiki 文件在工作目录下，随项目 Git 管理；不在 session backup 内 |
| **工作目录** | Wiki 必须在已配置且可写的 workDir 下 |

---

## 15. 安全与权限

| 项 | 策略 |
|----|------|
| 路径 | 全部路径解析经 `pathSecurity`，禁止 traversal |
| raw 只读 | LLM 工具不可写 `raw/` |
| SCHEMA 修改 | 需用户确认 |
| 脚本执行 | Wiki 工作流 **不应** 依赖 `run_script` 修改 Wiki；Lint 修复用 write_file |
| 日志脱敏 | agentLogger 对 Wiki 内容无特殊豁免，仅记录路径与操作类型 |
| 恶意 Markdown | 预览时 sanitization 与现网 ChatMarkdown 一致 |

---

## 16. 非功能需求

| 指标 | 要求 |
|------|------|
| Wiki 初始化 | < 500ms |
| `wiki:status` | < 200ms（页数可异步缓存） |
| index.md 预加载 | **不预注入**；LLM 通过 Skill 在 Query 时自行 `read_file` |
| SCHEMA 注入 | 受 `maxSystemChars`（模型上下文 10%）截断，与 Skill 共用配额 |
| 兼容性 | `wiki.enabled` 默认 false；未启用时零行为变化 |

---

## 17. 发布计划

### Phase 1 — 可运行最小闭环（MVP）

- [ ] `WikiConfig` 与 `wiki:init` / `wiki:status`
- [ ] `wiki:init` 自动安装 `llm-wiki` Skill 至 `.space-skills/`
- [ ] 标准目录模板 + 默认 `SCHEMA.md`
- [ ] 内置或预置 `llm-wiki` Skill 安装指引
- [ ] `/wiki` 命令（init / ingest / query / lint / status）
- [ ] raw 只读工具拦截
- [ ] 设置页 Wiki 区块：启用开关、初始化按钮、根路径
- [ ] Query 回答中的 Wiki 路径可点击打开详情面板

### Phase 2 — 浏览体验

- [ ] 文件 Tab **双分段布局**：「文件列表」在上、「LLM Wiki」在下，均可收起
- [ ] 分段收起状态与高度比例持久化
- [ ] Wiki 分段独立目录树（懒加载、选中、滚动）
- [ ] `hideWikiFromFileTree`：文件列表默认不展示 `llm-wiki/`
- [ ] Index 视图 / 内链跳转 / `[[wikilink]]` 解析
- [ ] raw 文件右键「收录到 Wiki」
- [ ] 「归档到 Wiki」按钮
- [ ] 引用的文件 Wiki 徽章与过滤
- [ ] `session.metadata.wiki` 状态持久化

### Phase 2.5 — 导入体验补全

- [ ] 文件列表 / 详情面板「收录到 Wiki」（外部文件拷贝至 `raw/` 后 Ingest）
- [ ] `/wiki ingest|摄取|提取 <任意 workDir 路径>` 自动导入
- [ ] `wiki:import-raw` / `file:copy` IPC

### Phase 3 — 规模与智能

- [ ] `wiki:parse-index` 结构化索引（可选，仅 UI Index 视图）
- [ ] Lint `--fix` 半自动修复流
- [ ] 导入外部剪藏（**粘贴** → 写入 raw → ingest 一步；可复用 Phase 2.5 导入管线，见 [wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md)）
- [ ] SCHEMA 模板补充：`grep` 限定 `wiki/` 的 Query 检索范例
- [ ] **评估** Plan 模式 Wiki 专用模板（OQ-5：Phase 3 再议，首版不做）

---

## 18. 验收标准

### 18.1 Phase 1

- [ ] 设置中启用 Wiki 并初始化后，`llm-wiki/` 下存在 `raw/`、`wiki/`、`SCHEMA.md`、`wiki/index.md`、`wiki/log.md`
- [ ] `/wiki ingest raw/test.md` 能在 `wiki/` 生成/更新页面并更新 index 与 log
- [ ] `/wiki 摄取 raw/test.md`、`/wiki 提取 raw/test.md` 与 `ingest` 行为一致
- [ ] LLM 通过工具 **无法** 写入 `raw/`（返回明确错误）
- [ ] `/wiki query` 回答含 `wiki/...` 路径且点击可在详情面板打开
- [ ] 未启用 Wiki 时，应用行为与现网一致
- [ ] `wiki.enabled=false` 时不加载 `llm-wiki` Skill 的 alwaysLoad

### 18.2 Phase 2

- [ ] 文件 Tab 可见 **「文件列表」** 与 **「LLM Wiki」** 两个可收起分段，默认均展开
- [ ] 收起任一分段后，另一分段占满可用高度；刷新应用后收起状态保持
- [ ] `wiki.enabled=false` 时仅显示文件列表分段，无 LLM Wiki 占位
- [ ] Wiki 分段内可从 `index.md` 导航至子页；聊天/内链打开 Wiki 页时自动展开 Wiki 分段并定位节点
- [ ] Markdown 内相对链接可跳转
- [ ] 「归档到 Wiki」后新页出现在 index 与引用的文件中

### 18.2.1 Phase 2.5

- [ ] 对 workDir 内 `docs/foo.md` 使用「收录到 Wiki」后，生成 `raw/` 副本并 Ingest；源文件保留
- [ ] `/wiki 提取 docs/foo.md` 与 UI 行为一致

### 18.3 Phase 3

- [ ] `/wiki lint` 能列出至少：孤儿页、index 不一致项
- [ ] SCHEMA / Skill 文档中明确 Query 检索顺序（index → read → grep）

---

## 19. 待解决问题（已决议）

以下条目已于 2026-05-24 评审确认；实现以 **决议** 列为准。

| # | 问题 | 决议 |
|---|------|------|
| OQ-1 | Wiki 根目录默认 `llm-wiki` 还是 `.llm-wiki`？ | **`llm-wiki/` 可见目录**；默认不可改为隐藏名，但 `rootPath` 仍可配置其他相对路径 |
| OQ-2 | 是否内置 Obsidian Web Clipper 导入指引？ | **不做**；SCHEMA 不含第三方剪藏工具说明 |
| OQ-3 | Query 时 index 全量注入 vs Skill 指导自读？ | **不预注入**；删除 `preloadIndexOnQuery`；Skill 规定 Query 第一步 `read_file(index.md)` |
| OQ-4 | 多会话并行 ingest 冲突？ | **乐观并发** + write 确认 + checkpoint；冲突靠 Git，不做锁/队列 |
| OQ-5 | 是否与 Plan 模式深度整合？ | **Phase 3 再评估**；Phase 1/2 不整合 |
| OQ-6 | 内置 Skill vs 用户自建？ | **`wiki:init` 时自动安装**内置 Skill 到 `.space-skills/llm-wiki/` |
| OQ-7 | 图片 raw 如何 ingest？ | **首版仅文本**（`.md`/`.txt`）；图片/PDF 不承诺 |
| ~~OQ-8~~ | ~~是否内置 `wiki_search`？~~ | **已关闭**：复用 `grep`，见 §11.2 |

---

## 20. 相关文件

| 文件 | 改动类型（规划） |
|------|------------------|
| `src/shared/domainTypes.ts` | 新增 `WikiConfig`、`WikiStatus` |
| `src/shared/api.ts` | Wiki IPC 类型 |
| `electron/appIpc.ts` | Wiki handlers |
| `electron/wiki/wikiPaths.ts` | 路径解析、raw 只读判断 |
| `electron/wiki/wikiInit.ts` | 初始化模板写入 |
| `electron/tools/builtinExecutors.ts` | raw 只读拦截 |
| `electron/preload.ts` | 暴露 Wiki API |
| `src/renderer/services/wikiCommandService.ts` | `/wiki` 命令解析 |
| `src/renderer/components/Chat/ChatView.tsx` | 命令分发、归档按钮 |
| `src/renderer/components/Config/ConfigModal.tsx` | Wiki 设置区块 |
| `src/renderer/components/FilePane/*` | 双分段布局、Wiki 树、Section 收起态（Phase 2） |
| `docs/requirement/wiki-import-ingest-requirement.md` | 外部文件导入并 Ingest（Phase 2.5） |
| `docs/requirement/file-pane-tree-requirement.md` | 补充与 LLM Wiki 分段的布局关系（引用本文档 §10.1） |
| `docs/requirement/skills-requirement.md` | 交叉引用 llm-wiki Skill |

---

**文档版本**: v1.4  
**创建日期**: 2026-05-24  
**更新日期**: 2026-05-24 — UI 文案统一为「收录到 Wiki」（见 wiki-import-ingest-requirement.md v1.1）  
**适用范围**: SpaceAssistant LLM Wiki 功能
