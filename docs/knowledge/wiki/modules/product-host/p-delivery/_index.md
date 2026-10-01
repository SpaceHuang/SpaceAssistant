---
pageType: module
module: p-delivery
boundary: product-host
status: active
codeAnchors:
  - electron/feishu/feishuInboundParser.ts:1
  - electron/feishu/feishuImChannel.ts:1
  - electron/wechat/weChatCommandRouter.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# IM Delivery · `p-delivery`

## 模块契约

飞书 / 微信远程投递面：入站消息解析与准入判定、IM 内确认、出站消息与进度回传、凭据与状态侧栏。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「IM 渠道投递与确认」：`shouldAcceptInbound` 准入、IM Y/N 确认、出站消息确认的移除决策

## 开放偏差

（暂无）
