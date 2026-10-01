---
pageType: module
module: p-ui
boundary: product-host
status: active
codeAnchors:
  - src/renderer/components/FileTree/FileTree.tsx:1
  - src/renderer/components/DetailPanel/DetailPanelFileList.tsx:15
  - src/renderer/components/WikiPane/WikiPane.tsx:24
  - src/renderer/services/filePaneNavigation.ts:11
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# UI Surface · `p-ui`

## 模块契约

界面呈现层：文件树与文件面板、详情面板与预览、聊天消息渲染（Markdown / 工具卡片）、
i18n 与语言环境、设置界面。**不含**业务编排与执行逻辑。

## 卡片清单

### requirement

- [LLM Wiki 支持](requirement-llm-wiki.md) — Wiki 功能总规划（Phase 1/2/2.5/3）：三层结构、Schema 机制、三大操作、双分段界面 · 附属 `s-capability` `s-safety` `p-workspace` `p-storage` `s-context`
- [Wiki 外部文件导入并 Ingest](requirement-wiki-import-ingest.md) — 统一「收录到 Wiki」入口，拷贝至 raw 后触发 Ingest · `p-workspace` `s-capability` `p-storage`（父需求：LLM Wiki 支持）

### design / plan / review / analysis
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「Electron 应用层与渲染面」相关部分

## 开放偏差

（暂无）
