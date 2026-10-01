---
pageType: module
module: p-drivers
boundary: product-host
status: active
codeAnchors:
  - electron/preload.ts:5
  - electron/remote/imRemoteAgent.ts:1
  - electron/feishu/remoteCommandRouter.ts:129
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Product Drivers · `p-drivers`

## 模块契约

产品入口层：只负责**谁发起、何时发起、结果给谁**，不承载执行逻辑。
Desktop / Remote / Automation 三类 Driver 共用同一条 SDK 调用路径。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「远程指令入口与路由」：`imRemoteAgent`、`RemoteCommandRouter` / `WeChatCommandRouter`、去重 / 限流 / 白名单

## 开放偏差

（暂无）
