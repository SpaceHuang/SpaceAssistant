---
pageType: module
module: s-safety
boundary: agent-sdk
status: active
codeAnchors:
  - electron/confirmation/toolCallGate.ts:1
  - src/shared/policy/policyEngine.ts:1
  - electron/shell/shellSecurity.ts:1
  - electron/pathSecurity.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Safety Boundary · `s-safety`

## 模块契约

**不可绕过、fail-closed** 的安全边界：Policy 判定、Gate 门禁、确认与 Answerer。
SDK 对外承诺未注册能力不可执行、高风险调用统一拒绝或确认。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「安全机制主体」：14 条 Shell 验证器、路径穿越双重防护、确认策略归一化、`remote_read_only` 实际拦截范围

## 开放偏差

（暂无）

## 附属反链

> 以下卡片**主责**在别的模块，本模块为「附属模块」（`relatedModules`）。

- [LLM Wiki 支持](../../product-host/p-ui/requirement-llm-wiki.md)（主责 `p-ui`）
  —— 本模块承担其安全约束：`raw/` 只读拦截已迁至策略层
  （`policy/defaultRules.ts` 的 `wiki-raw-write-deny`，`locked: true` + `deny`）；
  `SCHEMA.md` 写入需确认；脚本内容安全日志（见「代码锚点」）
