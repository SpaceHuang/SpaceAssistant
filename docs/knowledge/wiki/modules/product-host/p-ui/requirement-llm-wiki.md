---
pageType: doc
docType: requirement
module: p-ui
relatedModules: [s-capability, s-safety, p-workspace, p-storage, s-context]
boundary: product-host
status: active
sourceStatus: "待评审"
sourceDocs:
  - docs/requirement/llm-wiki-requirement.md
codeAnchors:
  - electron/wiki/wikiPaths.ts:4
  - electron/wiki/wikiPaths.ts:35
  - electron/wiki/wikiInit.ts:53
  - electron/wiki/wikiTemplates.ts:1
  - src/shared/policy/defaultRules.ts:20
  - electron/confirmation/toolCallGate.ts:495
  - src/shared/outbound/wikiCommandService.ts:1
  - src/renderer/components/WikiPane/WikiPane.tsx:24
  - src/renderer/components/Config/WikiTab.tsx:12
  - src/shared/domainTypes.ts:453
  - src/renderer/components/Chat/ChatView.tsx:746
relatedCards:
  - modules/product-host/p-ui/requirement-wiki-import-ingest.md
reviewVersions: []
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# LLM Wiki 支持 — 需求要点（父需求）

> **原文**：[docs/requirement/llm-wiki-requirement.md](../../../../../requirement/llm-wiki-requirement.md)
> v1.6 · 2026-05-24 · 1009 行 · 状态「待评审」· 参考 Karpathy LLM Wiki (gist)
> **主责模块**：`p-ui`（用户可见交付面：设置页 / 文件 Tab 分段 / 命令入口 / 归档）
> **附属模块**：`s-capability`（文件工具维护 Wiki）、`s-safety`（raw 只读、SCHEMA 写入确认）、
> `p-workspace`（workDir 前置、会话）、`p-storage`（`.wiki-meta.json`、会话 Wiki 态）、
> `s-context`（SCHEMA 注入截断、上下文占用）

## 要解决的问题

Karpathy 式 LLM Wiki 模式要求「LLM 增量编译并持续维护结构化 Markdown Wiki」，
而 SpaceAssistant 缺三样东西：**Wiki 目录约定**、**Schema 模板**、**专用 Skill**。
本需求把抽象模式落地为可配置、可浏览、可审计的一等功能模块。

核心差异（原文 §1.2）：产物是**持久化 Markdown 页面**而非临时检索片段；知识**复利积累**；
用户**可见性高**（可浏览的 Wiki 树）。

## 核心机制

**① 三层结构**（原文 §2.1）

```
Schema（SCHEMA.md）  → 告诉 LLM 目录约定、页面类型、三大工作流
Wiki（wiki/）        → LLM 维护的互链 Markdown + index.md + log.md
Raw（raw/）          → 只读源，LLM 仅 read
```

**② Schema 机制 —— 规范与执行分离**（原文 §7.3）

| 载体 | 职责 |
|------|------|
| `SCHEMA.md` | 领域特定、可随仓库 Git 演化 |
| `llm-wiki` Skill | 通用工作流、触发词、与文件工具的配合方式 |

初始化时自动安装 Skill 到 `.space-skills/llm-wiki/`；Query **不预注入** index（OQ-3），
由 Skill 规定第一步 `read_file(wiki/index.md)`。

**③ 三大操作**

| 操作 | 产出 |
|------|------|
| **Ingest** | 更新 10–15 个相关页面 + index + log；支持 `--all` 批量（靠 log 去重，单批上限 10） |
| **Query** | 检索顺序固定：`index.md` → 深入页 → `grep(path=wiki/)` 补搜；正文引用 `wiki/...` 路径 |
| **Lint** | 矛盾 / 过时 / 孤儿页 / 缺页 / 缺链 / index 一致性 |

**④ 关键决议：不新增 `wiki_search`**（原文 §11.2，OQ-8 已关闭）
理由：`grep`（ripgrep）在中等规模（~100 源、数百页）足够；`index + 按需深入` 优于向量检索。
规模扩大时的方案是**拆分 index**，而非引入 embedding。

## 交付面

| 面 | 内容 |
|----|------|
| 命令 | `/wiki init \| ingest \| 摄取 \| 提取 \| query \| lint [--fix] \| status \| help` |
| 界面 | 文件 Tab **双分段**（上「文件列表」/ 下「LLM Wiki」，可独立收起）；`index.md` 可切换 Index 视图；内链跳转；`[[wikilink]]` 解析 |
| 配置 | `WikiConfig`：`enabled` / `rootPath` / `hideWikiFromFileTree` / `interactiveIngest` / `maxBatchIngest` |
| 归档 | 助手消息「归档到 Wiki」→ `wiki/queries/YYYY-MM-DD-slug.md` |
| 会话态 | `Session.metadata.wiki`：`wikiModeActive` / `archivedQueries` |

## 发布计划

| 阶段 | 内容 |
|------|------|
| **Phase 1** | `WikiConfig` + `wiki:init`/`wiki:status` + Skill 自动安装 + 目录模板 + `/wiki` 命令 + raw 只读拦截 + 设置页 |
| **Phase 2** | 文件 Tab 双分段 + Wiki 树 + Index 视图 + 内链跳转 + 收录/归档按钮 + 引用的文件徽章 |
| **Phase 2.5** | 外部文件导入（见子需求） |
| **Phase 3** | `wiki:parse-index`（仅 UI）+ Lint `--fix` + 粘贴导入 + **评估** Plan 模式整合（OQ-5 不做） |

## 已决议的开放问题（原文 §19）

| # | 决议 |
|---|------|
| OQ-1 | 根目录用**可见目录** `llm-wiki/`，不用隐藏名 |
| OQ-2 | **不**内置 Obsidian Web Clipper 指引 |
| OQ-3 | Query **不预注入** index，由 Skill 指导自读 |
| OQ-4 | 多会话并行 ingest 用**乐观并发**（不锁不排队，冲突靠 Git） |
| OQ-5 | 与 Plan 模式整合 **Phase 3 再评估** |
| OQ-6 | `wiki:init` 时**自动安装**内置 Skill |
| OQ-7 | 首版**仅文本**（`.md` / `.txt`），不承诺 PDF / 图片 |
| OQ-8 | **已关闭**：不新增 `wiki_search`，复用 `grep` |

## 与当前代码的偏差（2026-09-26 ingest 复核）

**① raw 只读拦截的机制已迁移（执行层 → 策略层）** —— 最重要的一项

原文 §11.4 与 §15 规定「在 `builtinExecutors.ts` 的写执行器里判 `isUnderWikiRaw` 并抛错」。
**该实现已不存在**：`builtinExecutors.ts` 中 `ERR_WIKI_RAW_READONLY` 与 `isUnderWikiRaw`
调用**均已移除**（`isUnderWikiRaw` 现仅存定义与测试）。

现行机制为**策略层声明式规则**：

| 环节 | 位置 |
|------|------|
| 事实产出 | `electron/confirmation/toolCallGate.ts:495` → `facts.signals.push({ kind: 'wiki-raw-target' })` |
| 信号类型 | `src/shared/confirmation/types.ts:107` → `{ kind: 'wiki-raw-target' }` |
| 拦截规则 | `src/shared/policy/defaultRules.ts:20` → `id: 'wiki-raw-write-deny'`，第 1 步段（`locked: true` + `deny`） |

语义**更强**：`locked` 表示任何套餐不得调松、不可覆盖。错误文案仍含 `WIKI_RAW_READONLY`。
此变更与 `docs/develop/session-d961cc51-boundary-policy-layering-technical-plan.md` 的规划一致（该计划已实施）。

**② `run_script` 内容级安全分析已实现** —— 对应综述页标记的「极高威胁缺口」

新增 `electron/shell/scriptContentSecurity.ts`（`analyzeScriptContent`）与
`electron/confirmation/extractors/scriptAnalysisExtractor.ts`，产出信号：
`script-network`（网络访问）、`script-language-analysis:unverified`（语言未接完整分析）、
`script-path-extraction:unknown`、`script-uncertified`、`clean`。
策略层据此分级：桌面 clean 免确认（`script-clean-allow-desktop`）、
远程含网络直接拒绝（`script-network-deny-remote`）、无人值守未认证语言拒绝
（`automation-unverified-script-language-deny`）。

**③ 路径与实现位置偏差**

| 原文预期 | 当前实际 |
|----------|----------|
| `src/renderer/services/wikiCommandService.ts` | `src/shared/outbound/wikiCommandService.ts` |
| `electron/appIpc.ts`（Wiki handlers） | `electron/ipc/agentProtocolIpc.ts` |
| `src/renderer/components/FilePane/*` | 该目录已不存在；文件面板由 `DetailPanelFileList.tsx` + `WikiPane` 承担 |

**④ 已实现但原文列为建议**

- `remoteAllowLocalWrite` 默认值**已改为 `true`**（`electron/remote/remoteToolPolicy.ts:61`），
  对应原文 §3.3.3
- `remote_read_only` 已降为 **legacy 值**：`electron/tools/coordinatorConfirmationAdapter.ts:15`
  定义 `LegacyPolicyCode = 'remote_read_only' | 'authorization_revoked'`，统一映射为 `'policy'`

**⑤ Phase 2 / 3 部分 IPC 未实现**

`wiki:list-pages` / `wiki:parse-index` / `wiki:open-root` 全库 **0 处**（符合原文预期）。
已实现的 IPC 为：`wiki:init` / `wiki:status` / `wiki:get-schema` / `wiki:resolve-path` / `wiki:import-raw`。

**结论**：原文的**设计框架与决议仍然有效**，但 §11.4 的 raw 只读实现方式已被
策略层方案取代，且 §7.1.1 所列缺口已由脚本内容分析关闭。

## 派生链

- **子需求**：[Wiki 外部文件导入并 Ingest](requirement-wiki-import-ingest.md)
  —— 本需求 Phase 2.5 的展开（已记入 `relatedCards`）
- **本需求已落地为知识库规范**：`docs/knowledge/SCHEMA.md` 是本需求 Schema 机制
  在「项目文档」场景的**实例化**（见该文件 §2.2 / §2.3）
- **评审**：无配对评审（实测 `docs/review/` 中无同名系列）

## 待建卡片

- `s-capability/design-script-content-security` —— 脚本内容分析器（`scriptContentSecurity.ts`）
- `s-safety/design-policy-default-rules` —— `defaultRules.ts` 声明式规则体系
- `p-assembly/plan-boundary-policy-layering` —— 边界策略分层计划（含 raw 只读迁移）
