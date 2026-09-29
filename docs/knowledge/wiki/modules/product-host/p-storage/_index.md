---
pageType: module
module: p-storage
boundary: product-host
status: active
codeAnchors:
  - electron/database/operations.ts:383
  - electron/secureApiKey.ts:1
  - electron/feishu/feishuAuditLogger.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Storage Adapter · `p-storage`

## 模块契约

宿主存储实现：SQLite（当前）/ JSONL（后续），负责消息、会话、凭据、审计日志与去重记录的持久化、
迁移与保留期。SDK 只规定记录语义，不含具体存储。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「凭据加密、审计日志、去重存储」：`secureApiKey`（safeStorage）、`feishuAuditLogger`、`feishuProcessedStore`

## 开放偏差

（暂无）

## 附属反链

> 以下卡片**主责**在别的模块，本模块为「附属模块」（`relatedModules`）。

- [LLM Wiki 支持](../p-ui/requirement-llm-wiki.md)（主责 `p-ui`）
  —— 本模块承担其持久化：`.wiki-meta.json`（`schemaVersion` / `initializedAt` / `ingestedRawPaths`）、
  会话 Wiki 态（`wikiModeActive` / `archivedQueries`）
- [Wiki 外部文件导入并 Ingest](../p-ui/requirement-wiki-import-ingest.md)（主责 `p-ui`）
  —— 本模块承担其可选记录：`.wiki-meta.json` 的 `importedSources`（OQ-I5，P2）
