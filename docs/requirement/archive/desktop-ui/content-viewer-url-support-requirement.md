# 内容查看器 URL 支持升级 — 需求规格

**版本：** 1.0
**日期：** 2026-06-03
**状态：** 待评审

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [功能需求](#3-功能需求)
4. [架构设计](#4-架构设计)
5. [组件规格](#5-组件规格)
6. [交互规格](#6-交互规格)
7. [后端 API 需求](#7-后端-api-需求)
8. [验收标准](#8-验收标准)

---

## 1. 概述

### 1.1 功能定位

内容查看器是用户在详情面板（右侧栏）预览内容的核心组件。当前仅支持本地文件查看，本次升级将扩展为：

| 内容类型 | 原状态 | 升级后状态 |
|----------|--------|------------|
| 本地文本文件 | ✅ 支持 | ✅ 保持支持 |
| 本地图片文件 | ✅ 支持 | ✅ 保持支持 |
| 本地网页文件（.html） | ⚠️ 仅显示源代码 | ✅ 渲染为网页 |
| 在线网址（URL） | ❌ 不支持 | ✅ 支持访问 |

### 1.2 目标

将内容查看器升级为**轻量级浏览器组件**，支持：
1. **在线网址访问**：输入并浏览任意 HTTP/HTTPS 网址
2. **本地网页渲染**：打开 HTML 文件时渲染为网页而非源代码
3. **浏览器级行为**：前进、后退、刷新、地址栏、链接点击等标准浏览器功能

### 1.3 功能边界

| 边界 | 说明 |
|------|------|
| 只读预览 | 不提供编辑功能，仅用于查看 |
| 安全限制 | 遵循 Electron webSecurity 策略，禁止 file:// 跨域访问 |
| 资源加载 | 允许加载网页依赖资源（CSS、JS、图片等） |
| 弹窗拦截 | 默认拦截弹出窗口 |

---

## 2. 现状分析

### 2.1 现有实现

当前 `FileContentView.tsx` 根据文件类型选择渲染方式：

```typescript
if (fileType === 'markdown' && viewMode === 'render') {
  return <MarkdownRenderView content={previewContent} ... />
}
return <CodeView content={previewContent} filePath={selectedFile} ... />
```

`.html` 文件被识别为代码文件，仅显示语法高亮的源代码。

### 2.2 缺失能力

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 在线网址访问 | 高 | 无法输入和访问 URL |
| HTML 文件渲染 | 高 | .html 文件仅显示源代码 |
| 浏览器导航 | 高 | 无前进/后退/刷新按钮 |
| 地址栏 | 高 | 无法输入和显示当前 URL |
| 链接点击 | 高 | 页面内链接无法跳转 |
| 加载状态 | 中 | 无页面加载进度指示 |
| 错误处理 | 中 | 网络错误无友好提示 |

---

## 3. 功能需求

### 3.1 URL 输入与访问

#### 3.1.1 地址栏功能

| 属性 | 说明 |
|------|------|
| 位置 | 工具栏区域，文件路径显示位置 |
| 输入类型 | 支持 HTTP/HTTPS URL |
| 自动补全 | 支持历史记录下拉建议 |
| 协议处理 | 自动补全 `https://`（如输入 `example.com` 自动转为 `https://example.com`） |
| 快捷键 | `Ctrl+L` 聚焦地址栏 |

#### 3.1.2 URL 验证规则

| 规则 | 说明 |
|------|------|
| 协议要求 | 必须以 `http://` 或 `https://` 开头 |
| 域名格式 | 符合标准域名格式（如 `example.com`, `localhost:3000`） |
| IP 地址 | 支持 IP:端口格式（如 `192.168.1.1:8080`） |
| 本地路径 | 支持 `file://` 协议访问本地文件 |

### 3.2 本地网页渲染

#### 3.2.1 HTML 文件处理

| 文件类型 | 处理方式 | 优先级 |
|----------|----------|--------|
| `.html` | 渲染为网页 | 高 |
| `.htm` | 渲染为网页 | 高 |
| `.xhtml` | 渲染为网页 | 中 |
| `.mhtml` | 显示为不支持 | 低 |

#### 3.2.2 资源加载策略

| 资源类型 | 处理方式 |
|----------|----------|
| 内联资源 | ✅ 正常加载（`<style>`, `<script>`, `<img src="data:">`） |
| 相对路径资源 | ✅ 相对于 HTML 文件路径加载 |
| 绝对路径资源 | ✅ 正常加载 |
| 跨域资源 | ⚠️ 受 CSP 限制 |

### 3.3 浏览器导航功能

#### 3.3.1 导航按钮

| 按钮 | 图标 | Tooltip | 功能说明 | 状态控制 |
|------|------|---------|----------|----------|
| 后退 | `arrow_left_line` | 后退 | 返回上一页 | 无前一页时禁用 |
| 前进 | `arrow_right_line` | 前进 | 前进到下一页 | 无下一页时禁用 |
| 刷新 | `refresh_1_line` | 刷新 | 重新加载当前页面 | 始终可用 |
| 停止 | `stop_line` | 停止加载 | 中断当前请求 | 仅加载中显示 |

#### 3.3.2 导航历史

| 特性 | 说明 |
|------|------|
| 历史记录 | 维护会话级导航历史 |
| 最大记录数 | 100 条 |
| 跨会话持久化 | 不持久化，仅当前会话有效 |

### 3.4 浏览器行为一致性

#### 3.4.1 链接点击处理

| 行为 | 说明 |
|------|------|
| 普通链接 | 在当前查看器中打开 |
| `target="_blank"` | 拦截并提示用户选择（在查看器打开或外部浏览器打开） |
| 右键菜单 | 支持"在外部浏览器中打开" |

#### 3.4.2 页面交互

| 行为 | 说明 |
|------|------|
| JavaScript 执行 | 允许（受安全策略限制） |
| Cookie | 允许（会话级） |
| LocalStorage | 允许（会话级） |
| 表单提交 | 允许 |

#### 3.4.3 安全策略

| 策略 | 说明 |
|------|------|
| CSP | 应用默认内容安全策略 |
| 同源策略 | 遵循浏览器同源策略 |
| 文件协议 | 禁止 `file://` 访问远程资源 |
| 弹窗 | 默认拦截，可手动允许 |

### 3.5 视图模式切换

#### 3.5.1 HTML 文件模式切换

| 模式 | 说明 | 触发方式 |
|------|------|----------|
| 渲染模式 | 渲染为网页 | 默认进入 |
| 代码模式 | 显示源代码 | 点击"代码"按钮 |

#### 3.5.2 切换按钮行为

- 仅 HTML 文件显示切换按钮
- 模式状态不持久化，每次打开默认进入渲染模式

---

## 4. 架构设计

### 4.1 目标架构

```
DetailPanel（详情面板容器）
└── FileOverlay（文件浮层）
    ├── FileToolbar（工具栏，含地址栏）
    └── FileContentView（内容查看区）
        ├── CodeView（代码模式）
        ├── MarkdownRenderView（Markdown 渲染）
        ├── ImageView（图片查看）
        ├── WebView（网页视图）← 新增
        └── UnsupportedView（不支持类型）
```

### 4.2 新增/修改组件

| 组件 | 文件路径 | 职责 | 状态 |
|------|----------|------|------|
| WebView | `src/renderer/components/DetailPanel/WebView.tsx` | 网页渲染组件，封装 Electron WebView | 新增 |
| FileToolbar | `src/renderer/components/DetailPanel/FileToolbar.tsx` | 增强：添加地址栏和导航按钮 | 修改 |
| FileContentView | `src/renderer/components/DetailPanel/FileContentView.tsx` | 增强：添加 WebView 分支 | 修改 |
| DetailPanelContext | `src/renderer/components/DetailPanel/DetailPanelContext.tsx` | 增强：添加 URL 相关状态和操作 | 修改 |

### 4.3 状态管理增强

扩展 `DetailPanelContext`：

```typescript
interface DetailPanelState {
  // 原有状态...
  selectedUrl: string | null           // 当前访问的 URL
  urlHistory: string[]                 // 导航历史
  historyIndex: number                 // 当前历史位置
  isWebViewLoading: boolean            // WebView 加载状态
  webViewError: string | null          // WebView 错误信息
}

interface DetailPanelActions {
  // 原有操作...
  openUrl: (url: string) => Promise<void>
  navigateBack: () => void
  navigateForward: () => void
  refreshPage: () => void
  stopLoading: () => void
}
```

### 4.4 数据流

```
用户输入 URL → openUrl(url) → WebView.loadURL(url)
                                ↓
                           触发 did-start-loading
                                ↓
                      isWebViewLoading = true
                                ↓
                           触发 did-finish-load
                                ↓
                      isWebViewLoading = false, 更新历史记录
```

---

## 5. 组件规格

### 5.1 WebView 组件

| 属性 | 类型 | 说明 |
|------|------|------|
| url | `string` | 当前要加载的 URL |
| isLoading | `boolean` | 加载状态（外部控制） |
| onLoadStart | `() => void` | 开始加载回调 |
| onLoadFinish | `(url: string) => void` | 加载完成回调 |
| onLoadError | `(error: string) => void` | 加载错误回调 |
| onLinkClick | `(url: string, target: string) => void` | 链接点击回调 |

### 5.2 FileToolbar 增强

| 属性 | 类型 | 说明 |
|------|------|------|
| showNavigation | `boolean` | 是否显示导航按钮 |
| canGoBack | `boolean` | 是否可后退 |
| canGoForward | `boolean` | 是否可前进 |
| currentUrl | `string` | 当前 URL |
| isLoading | `boolean` | 加载状态 |
| onNavigateBack | `() => void` | 后退回调 |
| onNavigateForward | `() => void` | 前进回调 |
| onRefresh | `() => void` | 刷新回调 |
| onStop | `() => void` | 停止加载回调 |
| onUrlChange | `(url: string) => void` | URL 变更回调 |

### 5.3 FileContentView 增强

| 属性 | 类型 | 说明 |
|------|------|------|
| isUrlMode | `boolean` | 是否为 URL 模式 |
| url | `string` | 当前 URL |

**渲染规则扩展：**

| 条件 | 渲染组件 |
|------|----------|
| `isUrlMode || (fileType === 'html' && viewMode === 'render')` | WebView |
| 其他条件 | 原有逻辑不变 |

---

## 6. 交互规格

### 6.1 URL 访问流程

```
用户在地址栏输入 URL 并回车
  → onUrlChange(url) 触发
  → DetailPanelContext.openUrl(url) 调用
  → WebView 开始加载
  → isWebViewLoading = true
  → 加载完成 → isWebViewLoading = false
  → 更新导航历史
```

### 6.2 链接点击流程

```
用户点击页面内链接
  → onLinkClick(url, target) 触发
  → 如果 target="_blank"
      → 显示选择弹窗（在查看器打开 / 在外部浏览器打开）
  → 否则
      → openUrl(url) 在当前查看器打开
```

### 6.3 快捷键映射

| 快捷键 | 功能 | 作用域 |
|--------|------|--------|
| `Ctrl+L` | 聚焦地址栏 | WebView 激活时 |
| `Alt+Left` | 后退 | WebView 激活时 |
| `Alt+Right` | 前进 | WebView 激活时 |
| `F5` | 刷新页面 | WebView 激活时 |
| `Ctrl+F5` | 强制刷新（忽略缓存） | WebView 激活时 |
| `Escape` | 停止加载 | 加载中 |

### 6.4 右键菜单

| 菜单项 | 说明 |
|--------|------|
| 在新标签页中打开 | 在查看器中打开（预留） |
| 在外部浏览器中打开 | 调用系统默认浏览器打开 |
| 复制链接地址 | 复制链接 URL |
| 刷新 | 刷新当前页面 |

---

## 7. 后端 API 需求

### 7.1 新增 API

| API | 说明 | 优先级 |
|-----|------|--------|
| `browser:open-external` | 在外部浏览器中打开 URL | 高 |

### 7.2 API 响应格式

#### browser:open-external

**请求参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| url | `string` | 要打开的 URL |

**响应：**

| 字段 | 类型 | 说明 |
|------|------|------|
| success | `boolean` | 是否成功 |
| error | `string \| null` | 错误信息 |

---

## 8. 验收标准

### 8.1 功能验收

| 功能 | 验收条件 |
|------|----------|
| URL 输入 | 在地址栏输入 URL 并回车，正确加载网页 |
| HTML 文件渲染 | 打开 .html 文件，默认渲染为网页 |
| 模式切换 | HTML 文件可切换代码/渲染模式 |
| 后退 | 点击后退按钮或 Alt+Left，返回上一页 |
| 前进 | 点击前进按钮或 Alt+Right，前进到下一页 |
| 刷新 | 点击刷新按钮或 F5，重新加载页面 |
| 停止加载 | 加载中点击停止按钮或 Escape，中断加载 |
| 链接点击 | 点击页面内链接，在当前查看器打开 |
| 外部链接 | `target="_blank"` 链接提示用户选择打开方式 |
| 外部浏览器 | 支持在系统默认浏览器中打开 URL |
| 加载状态 | 页面加载时显示加载指示器 |
| 错误处理 | 网络错误显示友好提示信息 |

### 8.2 性能验收

| 指标 | 标准 |
|------|------|
| URL 加载速度 | 与系统浏览器相当 |
| 页面响应 | 交互无明显延迟 |
| 内存占用 | 单页面 < 50MB |

### 8.3 安全验收

| 项目 | 标准 |
|------|------|
| CSP 策略 | 正确应用内容安全策略 |
| 跨域限制 | 遵循浏览器同源策略 |
| 文件协议 | 禁止 file:// 访问远程资源 |
| 弹窗拦截 | 默认拦截弹出窗口 |

### 8.4 浏览器一致性验收

| 行为 | 验收条件 |
|------|----------|
| JavaScript | 页面脚本正常执行 |
| Cookie | Cookie 正确存储和发送 |
| 表单提交 | 表单可正常提交 |
| 资源加载 | CSS、JS、图片等资源正常加载 |

---

## 9. 相关文件

| 文件路径 | 说明 |
|----------|------|
| `src/renderer/components/DetailPanel/WebView.tsx` | 新建，网页视图组件 |
| `src/renderer/components/DetailPanel/FileToolbar.tsx` | 修改，添加地址栏和导航按钮 |
| `src/renderer/components/DetailPanel/FileContentView.tsx` | 修改，添加 WebView 分支 |
| `src/renderer/components/DetailPanel/DetailPanelContext.tsx` | 修改，添加 URL 状态管理 |
| `electron/appIpc.ts` | 修改，添加 browser:open-external IPC 通道 |
| `src/shared/api.ts` | 修改，添加 API 类型定义 |

---

**文档修订记录：**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0 | 2026-06-03 | 初始版本，定义 URL 支持和本地网页渲染需求 |