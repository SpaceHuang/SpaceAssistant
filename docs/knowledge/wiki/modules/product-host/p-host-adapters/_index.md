---
pageType: module
module: p-host-adapters
boundary: product-host
status: active
codeAnchors:
  - electron/main.ts:628
  - electron/main.ts:1
  - electron/preload.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Host Adapters · `p-host-adapters`

## 模块契约

产品侧实现端口：Electron 装配（窗口、IPC、预加载桥）、投递与凭据接入。
SDK 只定义端口，宿主提供实现。

## 卡片清单

### analysis
（暂无）

### design / plan / review / requirement
（暂无）

## 综述反链

- [远程使用场景安全机制概述](../../../cross/overviews/remote-security-overview.md)
  —— 覆盖本模块的「Electron 应用层安全」：`contextIsolation` / `nodeIntegration` 配置、`contextBridge` 白名单暴露、`setWindowOpenHandler`、缺失的 CSP

## 开放偏差

（暂无）
