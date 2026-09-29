---
pageType: module
module: s-capability
boundary: agent-sdk
status: active
codeAnchors:
  - electron/tools/builtinExecutors.ts:1439
  - electron/tools/builtinExecutors.ts:844
  - electron/effectiveTools.ts:12
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Capability Registry · `s-capability`

## 模块契约

宿主能力注册与执行：Tools / Shell / Script / Browser / MCP / Lark CLI。
宿主能力经端口注入，未注册能力不可执行；远程上下文下按策略动态过滤可用工具。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「工具执行面」：`write_file` / `run_shell` / `run_script` / `browser` / `run_lark_cli` 的确认与校验差异

## 开放偏差

（暂无）

## 附属反链

> 以下卡片**主责**在别的模块，本模块为「附属模块」（`relatedModules`）。

- [LLM Wiki 支持](../../product-host/p-ui/requirement-llm-wiki.md)（主责 `p-ui`）
  —— 本模块承担其主体：Wiki 维护完全依赖文件工具（`read_file` / `write_file` / `grep` / `list_directory`）；
  §11.2 决议**不新增 `wiki_search`**，Query 检索复用 `grep`；脚本内容分析（`scriptContentSecurity.ts`）
- [Wiki 外部文件导入并 Ingest](../../product-host/p-ui/requirement-wiki-import-ingest.md)（主责 `p-ui`）
  —— 本模块承担其约束：`raw/` 只读拦截（策略层 `wiki-raw-write-deny`）、源文件文本类型判定
