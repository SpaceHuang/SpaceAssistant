# Docs Wiki Schema

**版本**：v1.7
**更新**：2026-09-26

> 本文件定义 SpaceAssistant **项目文档**知识库的目录约定与 ingest / query / lint 工作流。
> 分类主轴取自 [Agent SDK 架构设计](../develop/architect/agent-sdk-architecture-design.html) 与
> [架构源数据](../develop/architect/agent-sdk-architecture-design.architecture.json) 的模块分类。
> 可与 LLM 协作演化。

## 变更记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-09-26 | 初稿：3 边界 → 16 模块分类轴；强制 front matter；三级索引 |
| v1.1 | 2026-09-26 | 新增横切综述机制：拆分 `view` / `overview` 两类页面，引入 `covers` 与 `origin`；新增「综述新鲜度」lint 项；`docType` 补齐 `superpowers` 来源；扩展版本收敛规则覆盖序数与 sha 命名 |
| v1.2 | 2026-09-26 | 根路径迁移至 `docs/wiki`（原顶层 `docs-wiki`）；修正 SCHEMA 头部相对链接；新增「自指排除」硬规则；精确化 `docs/` 只读保护的适用范围 |
| v1.3 | 2026-09-26 | 根路径定名 `docs/knowledge`（原 `docs/wiki`），消除页面层 `wiki/` 与根目录重名；同步更新根路径声明、结构示例、自指排除范围与只读保护表 |
| v1.4 | 2026-09-26 | 修正 §2.2.4 溯源示例相对路径深度（`../modules/` → `../../modules/`）；澄清 §3.3 路径基准：`sourceDocs` 相对工作目录根、`compiledFrom` 相对 wiki 根 |
| v1.5 | 2026-09-26 | 修正「信源声明」的**事实错误**：`docs/analyze/`、`docs/review/` 未被 git 跟踪（约 227 篇 / 444 篇）；新增信源版本控制状态表；§3.3 `sourceDocs` 补溯弱化提示；§3.4 补注 review 版本追溯依赖文件系统而非 git |
| v1.6 | 2026-09-26 | **修正 §2.2.3 硬规则的误判缺陷**（跨模块需求会被错判为 `overview`）；新增 §2.3 需求类文档的归属与状态规则（主责/附属模块、状态双轨、派生链）；`docType` 明确由**内容**判定而非目录；§3.3 新增 `relatedModules` / `sourceStatus` / `relatedCards` / `reviewVersions` 四个字段 |
| v1.7 | 2026-09-26 | 依据首次大跨模块 ingest 的复核结果更新：只读保护表机制描述由「工具层硬拦截」更正为「**策略层声明式 deny**」（`wiki-raw-write-deny` + `wiki-raw-target` 信号）；§3.3 补 `relatedCards` 路径基准、`codeAnchors` 加「机制迁移不可自动检出」提示 |

---

## 目录说明

**Wiki 根路径**：`docs/knowledge`（项目配置 `wiki.rootPath = "docs/knowledge"`）。
根目录位于信源目录 `docs/` 内部，因此 `docs/` 下**只有这一处** Wiki 结构，不额外另设顶层目录。

```
docs/knowledge/               ← Wiki 根
├── SCHEMA.md                 ← 本规范文件
├── raw/                      ← 只读原始资料（**策略层硬拦截**，见下）
└── wiki/                     ← LLM 维护的结构化页面
    ├── index.md              ← 顶层索引（§四第 1 级）
    ├── log.md                ← 追加式日志（§四第 3 级）
    ├── modules/<boundary>/<module>/
    ├── cross/views/  cross/overviews/
    ├── ledgers/
    └── queries/
```

> `wiki/` 这一层是应用契约规定的固定名（`<root>/wiki/index.md`、`<root>/wiki/log.md`）。
> 根目录取名 `knowledge` 而非 `wiki`，正是为了避免出现 `docs/wiki/wiki/` 这类双层重名路径。

**信源声明**：权威信源是 `docs/` 下**除 `docs/knowledge/` 以外**的文档
（`analyze/` `develop/` `i18n/` `manual/` `plan/` `requirement/` `review/` `superpowers/`，约 444 篇 md）。
不要求把信源复制进 `raw/`；`raw/` 空置保留，用于外部资料。

信源的**版本控制状态不一致**，直接影响溯源可靠性：

| 状态 | 目录 | 篇数 | 溯源含义 |
|------|------|------|----------|
| git 跟踪 | `develop/` `requirement/` `plan/` `manual/` `i18n/` `superpowers/` `废弃/` | 约 217 | 原文变更可追溯，可回溯历史版本 |
| **未纳入 git** | `analyze/`、`review/` | 约 227 | **原文删除或修改不可追溯**，溯源链弱化 |

> `docs/analyze/` 与 `docs/review/` 被 `.gitignore` 排除，定位为本地评审产物。
> `sourceDocs` 指向未跟踪文件时，卡片正文应注明「原文未纳入 git，删除后本页溯源失效」。
> 本 Wiki 自身（`docs/knowledge/`）**不**被忽略，走正常版本控制。

**自指排除（硬规则）**：Wiki 根位于信源目录 `docs/` 内部，故 ingest 扫描 `docs/` 时必须
**排除 `docs/knowledge/` 整棵子树**（含本 `SCHEMA.md`），否则会把 Wiki 自身当作信源递归收录。

**只读保护范围（精确）**：

| 路径 | 保护方式 |
|------|----------|
| `docs/knowledge/raw/**` | **硬拦截（策略层）**：`src/shared/policy/defaultRules.ts` 的 `wiki-raw-write-deny` 规则（第 1 步段，`locked: true` + `action: 'deny'`），由 `toolCallGate.ts` 产出 `wiki-raw-target` 信号触发。错误文案含 `WIKI_RAW_READONLY`。`locked` 表示任何套餐不得调松、不可覆盖；用户手动编辑 raw 不受限 |
| `docs/knowledge/wiki/**` | 可写；走全局 `tools.confirmMode` 确认流 |
| `docs/knowledge/SCHEMA.md` | 写入需确认（medium risk） |
| `docs/` 下其余信源（`develop/` 等） | **不受硬拦截**；靠「只读约定 + write 确认 + git」三重软约束 |

---

## 一、分类主轴：三层边界 → 模块

分类第一层是架构图的 **3 个边界区**，第二层是 **模块**。
`doc` 与 `module` 页**必须**归属且只归属一个模块（`module` 字段），模块决定目录位置。
`view` 与 `overview` 页**不写** `module`，改由 `covers` 表达覆盖面（见 §2.2）。

### 1.1 PRODUCT HOST · 产品宿主

| 模块 id | 名称 | 代码锚点（示例） |
|---------|------|------------------|
| `p-drivers` | Product Drivers | `electron/preload.ts:5`、`electron/remote/imRemoteAgent.ts:44` |
| `p-assembly` | Product Assembly | `electron/main.ts:256`、`electron/runtime/invocationAssembler.ts:134` |
| `p-host-adapters` | Host Adapters | `electron/main.ts:628`、`electron/runtime/invocationAssembler.ts:294` |
| `p-storage` | Storage Adapter | `electron/database/operations.ts:383`、`electron/database/sqliteStore.ts:3` |

### 1.2 AGENT SDK · 可复制的 Agent 执行库

| 模块 id | 名称 | 代码锚点（示例） |
|---------|------|------------------|
| `s-runtime` | Agent SDK Runtime | `electron/runtime/invocationAssembler.ts:32`、`src/shared/agent/invocation.ts:250` |
| `s-core` | Agent SDK Core | `electron/toolChatLoop.ts:773`、`packages/agent-core/src/index.ts:1` |
| `s-safety` | Safety Boundary | `electron/confirmation/toolCallGate.ts:1`、`src/shared/policy/policyEngine.ts:1` |
| `s-capability` | Capability Registry | `electron/tools/builtinExecutors.ts:1439`、`electron/effectiveTools.ts:12` |
| `s-history` | History / Storage Port | `src/shared/agent/invocation.ts:178`、`electron/chatMessageBuild.ts:7` |
| `s-model` | Model / Backend Port | `electron/toolChatLoop.ts:1`、`electron/anthropicClientFactory.ts:1` |

### 1.3 PROVIDER / BACKEND REPLACEMENT · 可替换实现

| 模块 id | 名称 | 代码锚点（示例） |
|---------|------|------------------|
| `x-providers` | Provider Adapters | `electron/anthropicClientFactory.ts:1`、`packages/agent-core/src/index.ts:1` |

### 1.4 宿主扩展域（架构图未覆盖）

架构图只表达执行链路与宿主边界，**不覆盖 UI、交付与自动化面**。
下列扩展域承接图中无归属的文档；归入扩展域前必须先确认无法挂到 1.1–1.3 的核心模块。

| 模块 id | 边界 | 名称 | 覆盖的文档领域 |
|---------|------|------|----------------|
| `p-ui` | product-host | UI Surface | 文件树、详情面板、聊天渲染、i18n / 语言环境 |
| `p-delivery` | product-host | IM Delivery | 飞书 / 微信远程投递、凭据、状态侧栏 |
| `p-automation` | product-host | Automation | 后台 Mission、管家、审批代理、自动批准 |
| `p-workspace` | product-host | Workspace | 工作区、会话、产物 / 输出目录、artifact 管理 |
| `s-context` | agent-sdk | Context Budget | 上下文占用、token 计量与成本 |

**扩展域晋升 / 合并规则**：某领域文档 ≥ 5 篇且与现有模块的代码锚点无交集时，方可新增扩展域；否则并入最邻近模块。

---

## 二、页面类型与横切综述

### 2.1 页面类型

`pageType` 表示该页在知识库中的**角色**，与所摘要文档的类型（`docType`）是两个维度。

| pageType | 目录 | 说明 |
|----------|------|------|
| `module` | `wiki/modules/<boundary>/<module>/_index.md` | 模块枢纽页：该模块的契约、开放偏差与卡片清单 |
| `doc` | `wiki/modules/<boundary>/<module>/<docType>-<slug>.md` | 单篇文档的要点卡片（**不复制全文**） |
| `view` | `wiki/cross/views/<slug>.md` | 架构图视图，**封闭集合**（固定 5 个，对应 `.architecture.json` 的 `meta.views`） |
| `overview` | `wiki/cross/overviews/<slug>.md` | 横切综述，**开放集合**（见 §2.2） |
| `ledger` | `wiki/ledgers/<slug>.md` | 偏差台账 / 版本路线 / 持续验收 |
| `query` | `wiki/queries/<slug>.md` | 由 Query 归档的分析页 |

`docType` 取值与 `docs/` 现有目录对齐：

| docType | 来源目录 |
|---------|----------|
| `requirement` | `docs/requirement/` |
| `design` | `docs/develop/*-design.md`、`docs/superpowers/specs/` |
| `plan` | `docs/plan/`、`docs/develop/*-plan.md`、`docs/superpowers/plans/` |
| `review` | `docs/review/` |
| `analysis` | `docs/analyze/`、`docs/develop/*-audit.md`、`*-diagnosis.md`、`*-analysis.md` |
| `decision` | `docs/develop/*-decision.md` |
| `architecture` | `docs/develop/architect/` |
| `manual` | `docs/manual/`、`docs/i18n/` |

> ⚠️ **`docType` 由内容判定，目录仅作辅助**。上表是「某目录**通常**装什么」的经验映射，
> 不是硬规则。实测 `docs/requirement/` 的 91 篇中含 10 篇非需求文档
> （2 篇 design、1 篇 improvements、3 篇无统一后缀、2 篇中文 `_v6.1` 命名）；
> `-v2-improvements.md` 这类「改进方案」更接近 `design`。
> ingest 时若目录与内容不符，**以内容为准**，并在 `log.md` 备注。

### 2.2 横切综述：`view` 与 `overview`

综述类内容的本质特征是 **归属 ≠ 来源**：它覆盖多个模块，但无法归给其中任何一个。
因此单独设层，`module` 字段在此层失效。

#### 2.2.1 两种综述必须区分

| | 人工权威综述 | LLM 合成综述 |
|--|-------------|-------------|
| 例 | `docs/analyze/remote-security-analysis.md` | 「我们的安全机制是怎么设计的」 |
| 性质 | **独立原始文档**，有作者 / 版本 / 日期 | 从多张卡片**派生**的合成物 |
| 过时风险 | 原文不变它就不变 | **双重风险**：底层卡片更新即可能过时 |
| front matter | `origin: authored`，`sourceDocs` 必填 | `origin: synthesized`，`compiledFrom` 必填 |

#### 2.2.2 目录分层

```
wiki/cross/
├── views/        ← 架构图 5 视图（封闭集合，一一对应 .architecture.json 的 views）
└── overviews/    ← 横切综述（开放集合，随文档增长）
```

#### 2.2.3 边界约束（防止 `overview` 滥用）

| 情形 | 应走 |
|------|------|
| `covers` 只涉及 1 个模块 | `doc` 页（挂该模块） |
| 一次问答的历史快照 | `query` 页 |
| 结构化清单（契约 / 偏差 / 卡片索引） | `module` 页 |

硬规则（**两条都要满足**）：

1. **`covers` 必须 ≥ 2 个模块**
2. **内容性质必须是「叙述性综合分析」** —— 即对跨模块既有事实的归纳、评价、对比或风险判定

⚠️ 第 2 条是对 v1.5 及更早版本**缺陷的修正**。原规则只要求「≥ 2 个模块」，
但**功能需求天然横跨多层**（UI 功能必然牵动 UI + 能力 + 存储），
实测抽样 5 篇需求全部命中 4–8 个模块。若只看模块数，它们会被尽数误判为 `overview`。

**跨模块 ≠ 综述。** 判据表：

| 内容 | 跨模块？ | 应走 |
|------|---------|------|
| 「远程安全机制概述」（对既有机制的归纳与评价） | 是 | `overview` ✅ |
| 「Wiki 功能需求规格」（对**新功能**的规格定义） | 是 | `doc`（见 §2.3） |
| 「文件面板树状展示需求」 | 是 | `doc`（见 §2.3） |
| 单模块设计文档 | 否 | `doc` |

`overview` 与 `query` 的实用判据：**这内容需不需要跟着底层变**？
需要持续维护 → `overview`；一次性存档 → `query`。

#### 2.2.4 溯源要求

`overview` 正文的**每个结论**须标注来源卡片路径。综述页位于 `wiki/cross/overviews/`，
指向 `wiki/modules/` 下卡片时需上溯两级（`../../`）：

```markdown
远程指令的确认链路由 [s-safety/tool-gate](../../modules/agent-sdk/s-safety/design-tool-gate.md) 定义……
```

这是「综述新鲜度」lint 能够定位变旧卡片的前提。

### 2.3 需求类文档（`requirement` / `design` / `plan`）

需求、设计、计划类文档与综述的差别在于：**它们定义「要做什么」，而非「已然是什么」**。
其跨模块性是内在的（一个功能牵动多层），因此**不适用 §2.2 的综述判定**，
但仍须回答「挂到哪」与「原文状态是什么」两个问题。

#### 2.3.1 归属：主责模块 + 附属模块

一个 `doc` 页有且仅有一个**主责模块**（`module`，决定目录位置），
可另列若干**附属模块**（`relatedModules`，仅建立反链，不决定目录）。

**主责模块判定**：文档的**主体交付面**落在哪个模块 —— 看标题与 §1 概述的落点，
**不是**关键词出现频次最高者。判定示例：

| 文档 | 关键词最高 | 主责模块 | 附属模块 |
|------|-----------|---------|---------|
| `file-pane-tree-requirement.md` | `p-ui`(24) | `p-ui` | `s-safety`, `s-capability`, `p-workspace` |
| `wiki-import-ingest-requirement.md` | `p-ui`(31) | `p-ui` | `p-workspace`, `s-safety`, `s-capability`, `s-model` |
| `context-usage-ring-requirement.md` | `s-context`(66) | `s-context` | `p-ui`, `s-model`, `p-workspace`, `s-capability` |

无法判定主责模块时向用户确认，不猜测。

#### 2.3.2 状态：双轨制

**需求原文的「状态」与 Wiki 卡片的 `status` 是两个不同维度，必须分字段记录。**

| 字段 | 管什么 | 取值 |
|------|--------|------|
| `status` | **卡片自身**的生命周期 | 受控枚举：`draft` / `active` / `superseded` / `deprecated` |
| `sourceStatus` | **原文**标注的状态 | 自由文本，**忠实转录，不做解释或归一化** |

原因：实测 91 篇需求原文出现 **34 种**不同状态表述（`待评审` `已实现` `草案` `已决议`
`修订待评审` `问题清单，待评审` `方案补强 / P0 未关闭` …），且部分是**超长句子**，
承载决策台账（如「B1/B2 已解决；D4 已否决；D6/D7 待定；实现已落地，待抽查复评」）。
强行归一化会丢失这些信息。

**唯一必需的映射**（其余不映射）：

| 原文状态含 | 卡片 `status` |
|-----------|--------------|
| `已废弃` / `Deprecated` / `已被替代` | `deprecated` |
| 其余一切 | `active` |

即：**卡片 `status` 表达「这页是否仍可作为当前结论引用」，与需求是否开发完毕无关。**

#### 2.3.3 派生链：`relatedCards` 与 `reviewVersions`

需求 → 设计 → 计划 → 评审 是**派生/反馈**关系，不是版本取代关系，因此**不得**用
`supersedes` 表达（后者专用于同主题新旧版本）。

| 字段 | 语义 |
|------|------|
| `relatedCards` | 横向上下游卡片路径：本需求派生的 design / plan，或据以修订的 review |
| `reviewVersions` | 本需求收到的评审版本列表（配合 §3.4 收敛，只列**最大版本**） |

实测：8 篇需求有配对评审（最高 14 版），51/91 篇含「关联文档」字段（18 篇关联 ≥3 篇）。
这些关系必须落在卡片上，否则 Query 时无法沿链追溯。

---

## 三、Front Matter（必填）

`wiki/` 下的**卡片页与模块页**必须以 YAML front matter 开头。

**豁免**（不写 front matter，lint 不得报缺失）：

| 文件 | 原因 |
|------|------|
| `SCHEMA.md` | 规范文件，位于 Wiki 根目录，不属于 `wiki/` 页 |
| `wiki/index.md` | 索引特殊文件（§四第 1 级） |
| `wiki/log.md` | 日志特殊文件（§四第 3 级） |

### 3.1 `doc` / `module` 页

以一张需求卡为例（含 §2.3 新增字段）：

```yaml
---
pageType: doc
docType: requirement
module: p-ui                       # 主责模块，决定目录位置
relatedModules: [s-capability, p-workspace]   # 附属模块，仅建反链
boundary: product-host
status: active                     # 卡片生命周期（受控枚举）
sourceStatus: "待评审"              # 原文状态，忠实转录
sourceDocs:
  - docs/requirement/wiki-import-ingest-requirement.md
codeAnchors:
  - electron/wiki/wikiImport.ts:1
  - electron/preload.ts:5
relatedCards:
  - modules/product-host/p-ui/requirement-llm-wiki.md
reviewVersions: []                 # 该需求收到的评审最高版本
supersedes: []
supersededBy: []
updated: 2026-09-26
---
```

### 3.2 `view` / `overview` 页

```yaml
---
pageType: overview
origin: authored
covers: [p-drivers, p-delivery, p-automation, s-safety, s-capability]
boundary: cross
status: active
sourceDocs:
  - docs/analyze/remote-security-analysis.md
codeAnchors: []
supersedes: []
supersededBy: []
updated: 2026-07-14
---
```

`origin: synthesized` 时改为 `compiledFrom: [<卡片相对路径>...]`，且所列卡片必须存在且为 `active`。

### 3.3 字段表

| 字段 | 必填 | 说明 |
|------|------|------|
| `pageType` | 是 | 见 §2.1 |
| `docType` | `doc` 页必填 | 见 §2.1 |
| `module` | `doc` / `module` 页必填 | **主责模块**，必须命中 §一的模块表；决定目录位置。`view` / `overview` 页**省略** |
| `relatedModules` | 否 | **附属模块**数组（§2.3.1）；仅建立模块页反链，不决定目录。**不得**含 `module` 的值 |
| `status` | 是 | **卡片生命周期**：`draft` / `active` / `superseded` / `deprecated` |
| `sourceStatus` | `doc` 页建议 | **原文状态**自由文本，忠实转录（§2.3.2）。仅 `已废弃`/`Deprecated` 映射为 `status: deprecated` |
| `relatedCards` | 否 | 横向派生链（§2.3.3）：派生的 design / plan，或据以修订的 review。路径**相对 wiki 根**（如 `modules/agent-sdk/s-core/design-xxx.md`），与 `compiledFrom` 同基准 |
| `reviewVersions` | 否 | 该文档收到的评审最高版本（配合 §3.4 收敛） |
| `covers` | `view` / `overview` 页必填 | 模块 id 数组，**≥ 2 个**（`view` 页由视图 focus 决定） |
| `boundary` | 是 | `product-host` / `agent-sdk` / `provider` / `cross`（`cross` 仅 `view` / `overview` 可用） |
| `origin` | `view` / `overview` 页必填 | `authored` / `synthesized` |
| `status` | 是 | `draft` / `active` / `superseded` / `deprecated` |
| `sourceDocs` | `doc` 页必填；`origin: authored` 的综述页必填 | 相对**工作目录根**的原始文档路径（与 `codeAnchors` 同基准），如 `docs/develop/foo.md`、`raw/foo.md`；指向 `analyze/`、`review/` 时应注明溯源弱化（见「信源声明」） |
| `compiledFrom` | `origin: synthesized` 必填 | 合成所依据的卡片路径，相对 **wiki 根**，如 `modules/agent-sdk/s-core/design-xxx.md` |
| `codeAnchors` | 是 | `路径:行号`，**可直接 lint**；无代码归属时写 `[]`。注意：自动校验只能发现「文件缺失 / 行号越界」，**发现不了机制迁移**（如 raw 只读从执行层迁至策略层）—— 核心机制的锚点需人工复核 |
| `supersedes` | 否 | 本页取代的 wiki 页路径 |
| `supersededBy` | `superseded` 时必填 | 取代本页的 wiki 页路径 |
| `updated` | 是 | `YYYY-MM-DD` |

### 3.4 版本收敛规则

`docs/review/` 存在 175 篇带版本后缀的文档（最高至 `-v32`），命名风格不一。统一收敛：

| 命名形态 | 例 | 处理 |
|----------|-----|------|
| 数字版本 | `-review-v9.md` | 只为**最大版本号**建 `active` 卡片 |
| 序数版本 | `-second-review.md`、`-third-review.md` | 序数视为版本号，只为最大序数建卡片 |
| sha 快照 | `feat-...-83a37a6-...md` | 视为同一主题的历史快照，只保留最新 |

旧版本**仅在 `log.md` 留痕**，不逐版建页。

> ⚠️ `docs/review/` 未纳入 git（见「信源声明」），版本序号的判定**依赖文件名与文件系统**，
> 无法通过 git 历史追溯。删除旧版文件即永久丢失该版痕迹，收敛前应先确认。

---

## 四、索引分层（三级）

规模约 444 篇，单文件 index 不可行，因此分层：

1. `wiki/index.md` — 顶层：3 边界 → 模块清单（含卡片数、开放偏差数）+ 跨模块（视图 / 综述）+ 台账 + 最近变更。**Query 第一步必读。**
2. `wiki/modules/<boundary>/<module>/_index.md` — 模块内：按 `docType` 分组列出卡片，并汇总开放偏差与风险。
3. `wiki/log.md` — 追加式操作日志，条目前缀固定为 `## [ISO8601] <operation> | <summary>`。

顶层 index 只保留模块级指针与计数；**不得**在 `wiki/index.md` 罗列全部卡片。
`cross/` 下每个主题在顶层 index 只占**一行**，不展开其 `covers` 明细。

---

## 五、Ingest 工作流

1. `read_file` 读取 `docs/` 目标文档（或 `raw/` 外部资料）
2. **判定形态**（三步，顺序不可颠倒）
   1. **先判内容性质**：是「叙述性综合分析」（对既有事实的归纳/评价/对比）→ 综述类；
      还是「规格/设计/计划」（定义要做什么）→ 文档类
   2. 综述类且 `covers` ≥ 2 模块 → 走 `overview` 分支（步骤 3b）
   3. 文档类 → 走 `doc` 分支（步骤 3a）。**跨模块不构成 `overview` 的理由**（§2.2.3）
3a. 判主责模块与附属模块：主责按**主体交付面**（标题 + §1 概述落点）判定，
   关键词频次仅作参考；附属模块列入 `relatedModules`。无法判定时向用户确认，不猜测
3b. 判综述性质：有独立人工原文 → `origin: authored`；仅为合成产物 → `origin: synthesized`；确定 `covers`
4. 若为 review 系列，检查是否已有同主题卡片；有则更新并推进 `supersedes` 链（见 §3.4）
5. 写入卡片（`pageType: doc` 或 `overview`），**只写要点与指针，不复制原文**；
   需求类文档另记 `sourceStatus`（忠实转录原文状态）与 `relatedCards`
6. 更新该模块 `_index.md`；综述页则同时更新所涉模块的 `_index.md` 反链；
   有 `relatedModules` 的卡片，同时更新各附属模块 `_index.md` 的反链；必要时更新 `wiki/index.md` 计数
7. 向 `wiki/log.md` 追加 ingest 条目

**禁止**：不得修改 `raw/`；不得删除 log 历史；不得把长文档全文粘入 wiki。

---

## 六、Query 工作流

1. `read_file(wiki/index.md)` — 按边界与模块定位候选模块；**综述类问题优先看 `cross/overviews/`**
2. `read_file(<module>/_index.md)` — 取该模块卡片清单
3. `read_file` 深入相关卡片；`status` 非 `active` 的页面不得作为当前结论引用
4. index 未覆盖时 `grep(pattern, path=wiki/)`；已知模块时可直接 `grep(pattern, path=wiki/modules/<boundary>/<module>/)`
5. 综合回答，正文引用 `wiki/...` 路径
6. 用户要求时归档为 `wiki/queries/` 新页

回答中若涉及架构事实，应同时给出 `codeAnchors` 指向的代码位置。
若回答同时命中综述页与底层卡片，**须先校验综述页 `updated` 是否落后于底层卡片**；落后时以卡片为准并提示综述待更新。

---

## 七、Lint 工作流

基础检查项：矛盾声明、过时结论、孤儿页、缺页、缺链、index 与文件系统不一致。

本项目特有检查项：

| 检查项 | 判定 |
|--------|------|
| Front matter 缺失 | `wiki/` 下非豁免页缺少 front matter 或必填字段（见 §三） |
| 模块合法性 | `module` 是否命中 §一的模块表 |
| 归属一致性 | `module` 与所在目录路径是否自洽、`boundary` 是否与模块匹配 |
| 代码锚点失效 | `codeAnchors` 的路径不存在，或行号超出文件总行数 |
| 版本链断裂 | `supersededBy` 指向的页不存在，或 supersede 关系成环 |
| 版本未收敛 | 同主题存在更高版本卡片，但本页仍为 `active` |
| 信源缺失 | `sourceDocs` 指向的 `docs/` 文件不存在 |
| 自指收录 | `sourceDocs` 指向 `docs/knowledge/` 下路径（Wiki 自身不得作为信源） |
| 顶层 index 膨胀 | `wiki/index.md` 出现具体卡片条目而非模块指针 |
| 模块页缺失 | `wiki/index.md` 列出的模块指针，其 `_index.md` 尚未建立 |
| **综述新鲜度** | `overview.updated` 早于其 `covers` 各模块内**任一 active 卡片**的 `updated` |
| 综述覆盖面 | `overview.covers` 少于 2 个模块，或含非法的模块 id |
| 合成溯源失效 | `origin: synthesized` 的 `compiledFrom` 卡片不存在或非 `active` |
| 综述缺溯源 | `overview` 正文结论未标注来源卡片路径 |
| 附属模块非法 | `relatedModules` 含非模块表内的 id，或含与 `module` 重复的值 |
| 需求误判为综述 | `pageType: overview` 但内容为规格/设计/计划（§2.2.3 第 2 条） |
| 派生链断裂 | `relatedCards` 指向的卡片不存在 |
| 状态未映射 | 原文含 `已废弃` / `Deprecated`，但卡片 `status` 仍为 `active` |

**综述新鲜度**是 `overview` 存在的代价：底层卡片更新而综述未跟进，知识库会对同一问题给出两套答案。

Lint 报告需按模块分组输出；修复走 `write_file` 确认流，并向 `log.md` 追加 lint 条目。

---

## 八、输出语言

默认 zh-CN。字段名、模块 id、路径保持英文。
