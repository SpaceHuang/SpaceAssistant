---
pageType: module
module: p-workspace
boundary: product-host
status: active
codeAnchors:
  - electron/remote/remoteAgentRegistry.ts:1
  - electron/remote/remoteSessionSwitchGuard.ts:1
  - electron/workDirBinding.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Workspace · `p-workspace`

## 模块契约

工作区 / 会话 / 产物管理：会话级工作目录绑定、并发占用注册、切换守卫、输出目录与 artifact 管理。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「并发、会话与工作目录守卫」：`tryClaimRemoteSession` single-flight、`canSwitchRemoteSession`、`canBindSessionWorkDir`

## 开放偏差

（暂无）

## 附属反链

> 以下卡片**主责**在别的模块，本模块为「附属模块」（`relatedModules`）。

- [LLM Wiki 支持](../p-ui/requirement-llm-wiki.md)（主责 `p-ui`）
  —— 本模块承担其前置条件：Wiki 必须在已配置且可写的 workDir 下；会话级 Wiki 态
- [Wiki 外部文件导入并 Ingest](../p-ui/requirement-wiki-import-ingest.md)（主责 `p-ui`）
  —— 本模块承担其前置条件：需已选会话、源路径须在 workDir 沙箱内
