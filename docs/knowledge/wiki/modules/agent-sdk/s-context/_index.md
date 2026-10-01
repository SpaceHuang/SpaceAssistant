---
pageType: module
module: s-context
boundary: agent-sdk
status: active
codeAnchors:
  - src/shared/contextUsageEstimate.ts:1
  - src/renderer/components/Chat/ContextUsageRing.tsx:37
  - electron/usageStats/usageStatsRecorder.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Context Budget · `s-context`

## 模块契约

上下文预算与 token 计量：上下文占用估算、用量环展示、token 成本核算与统计，
以及系统提示注入的字符配额（含 SCHEMA / Skill 共用的 `maxSystemChars` 截断）。

## 卡片清单

### requirement
（暂无）

### design / plan / review / analysis
（暂无）

## 综述反链

（暂无）

## 开放偏差

（暂无）

## 附属反链

> 以下卡片**主责**在别的模块，本模块为「附属模块」（`relatedModules`）。

- [LLM Wiki 支持](../../product-host/p-ui/requirement-llm-wiki.md)（主责 `p-ui`）
  —— 本模块承担其两项非功能需求：SCHEMA 注入受 `maxSystemChars`（模型上下文 10%）截断、
  与 Skill 共用配额；Query 读取多页 wiki 时计入 estimated tokens
