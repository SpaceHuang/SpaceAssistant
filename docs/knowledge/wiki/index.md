# Docs Wiki Index

> 顶层导航，只放模块指针与计数，不罗列具体卡片。Query 时先读本文件。
> 分类依据：`docs/develop/architect/agent-sdk-architecture-design.html` 的模块分类。

**状态**：已 ingest 3 篇（1 张 `overview` 卡 + 2 张 `doc` 卡）；9 个模块枢纽页已建立。

## 边界总览

| 边界 | 模块数 | 卡片数 | 开放偏差 |
|------|--------|--------|----------|
| PRODUCT HOST · 产品宿主 | 8 | 2 | — |
| AGENT SDK · 可复制的 Agent 执行库 | 7 | 0 | — |
| PROVIDER / BACKEND REPLACEMENT | 1 | 0 | — |
| 跨模块（视图 / 综述 / 台账） | 8 | 1 | — |

## PRODUCT HOST · SpaceAssistant 产品宿主

### 核心模块（架构图）

- `p-drivers` — Product Drivers（Desktop / Remote / Automation 入口）→ [模块页](modules/product-host/p-drivers/_index.md) · 0 卡片
- `p-assembly` — Product Assembly（composition root · 产品策略）→ [模块页](modules/product-host/p-assembly/_index.md) · 0 卡片
- `p-host-adapters` — Host Adapters（Electron · 投递 · 凭据）→ [模块页](modules/product-host/p-host-adapters/_index.md) · 0 卡片
- `p-storage` — Storage Adapter（SQLite today · JSONL later）→ [模块页](modules/product-host/p-storage/_index.md) · 0 卡片

### 宿主扩展域（架构图未覆盖）

- `p-ui` — UI Surface（文件树 · 详情面板 · 聊天渲染 · i18n）→ [模块页](modules/product-host/p-ui/_index.md) · 2 卡片
- `p-delivery` — IM Delivery（飞书 / 微信远程投递）→ [模块页](modules/product-host/p-delivery/_index.md) · 0 卡片
- `p-automation` — Automation（后台 Mission · 管家 · 审批代理）→ [模块页](modules/product-host/p-automation/_index.md) · 0 卡片
- `p-workspace` — Workspace（工作区 · 会话 · 产物管理）→ [模块页](modules/product-host/p-workspace/_index.md) · 0 卡片

## AGENT SDK · 可复制的 Agent 执行库

- `s-runtime` — Agent SDK Runtime（Admission · Profile · Ports，唯一装配点）→ [模块页](modules/agent-sdk/s-runtime/_index.md) · 0 卡片
- `s-core` — Agent SDK Core（Invocation · context · tool loop）→ [模块页](modules/agent-sdk/s-core/_index.md) · 0 卡片
- `s-safety` — Safety Boundary（Policy · Gate · Answerer，fail-closed）→ [模块页](modules/agent-sdk/s-safety/_index.md) · 0 卡片
- `s-capability` — Capability Registry（Tools · Shell · Browser · MCP）→ [模块页](modules/agent-sdk/s-capability/_index.md) · 0 卡片
- `s-history` — History / Storage Port（Message log · turn ledger · rebuild）→ [模块页](modules/agent-sdk/s-history/_index.md) · 0 卡片
- `s-model` — Model / Backend Port（Normalized stream · usage）→ [模块页](modules/agent-sdk/s-model/_index.md) · 0 卡片
- `s-context` — Context Budget（上下文占用 · token 计量）→ [模块页](modules/agent-sdk/s-context/_index.md) · 0 卡片

## PROVIDER / BACKEND REPLACEMENT · 可替换实现

- `x-providers` — Provider Adapters（Anthropic · OpenAI · other）→ [模块页](modules/provider/x-providers/_index.md) · 0 卡片

## 跨模块

### 架构视图（封闭集合 · 对应 `.architecture.json` 的 5 个 views）

- `whole-system` — 三层边界总览 → [视图页](cross/views/whole-system.md)（待建）
- `sdk-boundary` — Agent SDK 边界 → [视图页](cross/views/sdk-boundary.md)（待建）
- `replacement-axis` — Provider 替换轴 → [视图页](cross/views/replacement-axis.md)（待建）
- `migration-focus` — 迁移焦点 → [视图页](cross/views/migration-focus.md)（待建）
- `storage-boundary` — Storage 边界 → [视图页](cross/views/storage-boundary.md)（待建）

### 横切综述（开放集合）

- `remote-security-overview` — 远程使用场景安全机制概述（`covers`: p-drivers, p-delivery, p-workspace, p-storage, s-safety, s-capability, p-host-adapters）→ [综述页](cross/overviews/remote-security-overview.md) · 1 卡片

## 台账

- [架构偏差台账 D0–D4](ledgers/architecture-deviations.md) — owner / 版本 / 状态 / 证据 / 回滚点（待建）
- [版本路线 V0–V3](ledgers/version-roadmap.md) — 边界冻结到 SDK 发布（待建）

## 归档问答

（暂无）

## 最近变更

- 2026-09-26 · ingest `docs/requirement/llm-wiki-requirement.md` → `p-ui/requirement-llm-wiki.md`（**父需求卡**，1009 行 / 7 模块命中，验证 v1.6 规则在均衡型跨模块文档上的判定）；**复核发现 2 处重大机制变更**：raw 只读拦截已从执行层迁至策略层、`run_script` 内容级分析已实现。
- 2026-09-26 · ingest `docs/requirement/wiki-import-ingest-requirement.md` → `p-ui/requirement-wiki-import-ingest.md`（**首张 `doc` 卡**，验证 v1.6 新规则：主责 `p-ui` + 3 个附属模块，跨 4 模块但未误判为 `overview`）。
- 2026-09-26 · SCHEMA v1.6：**修正 §2.2.3 硬规则误判缺陷**（跨模块需求会被错判为 `overview`）；新增 §2.3 需求类文档规则（主责/附属模块、状态双轨、派生链）；`docType` 改为按内容判定；新增 4 个 front matter 字段。
- 2026-09-26 · SCHEMA v1.5：修正信源声明的版本控制事实（`analyze/`、`review/` 未纳入 git，约 227 篇），新增信源状态表。
- 2026-09-26 · ingest `docs/analyze/remote-security-analysis.md` → `cross/overviews/remote-security-overview.md`（首个 `overview`，`covers` 7 模块）；建立 7 个模块枢纽页。
- 2026-09-26 · SCHEMA v1.4：修正溯源示例相对路径深度（`../../modules/`）、澄清 `sourceDocs` / `compiledFrom` 路径基准。
- 2026-09-26 · SCHEMA v1.3：Wiki 根定名 `docs/knowledge`，消除页面层 `wiki/` 与根目录重名。
- 2026-09-26 · SCHEMA v1.2：Wiki 根迁移至 `docs/wiki`，新增自指排除规则。
- 2026-09-26 · SCHEMA v1.1：新增 `view` / `overview` 分层与「综述新鲜度」lint 项。
