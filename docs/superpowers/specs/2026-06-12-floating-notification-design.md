# 待确认状态桌面浮动通知 — 技术设计文档

**日期：** 2026-06-12
**关联需求：** [pending-confirm-floating-notification.md](../../requirement/pending-confirm-floating-notification.md)

---

## 1. 架构概述

### 1.1 模块划分

```
electron/
├── floatingNotification.ts             # 浮动 BrowserWindow 创建/销毁/位置计算
├── floatingNotificationManager.ts      # 弹出/关闭决策 + 主进程侧待确认跟踪
├── floatingNotificationPreload.ts      # 浮动窗口专用预加载（最小 API 面）
electron/main.ts                        # 注册主窗口 focus/blur/hide/show 监听
electron/appIpc.ts                      # 注册通知相关 IPC handler
src/shared/api.ts                       # 新增 FloatingNotificationApi 类型
src/renderer/
├── components/FloatingNotification/
│   ├── FloatingNotificationApp.tsx      # 浮动窗口根组件
│   └── floatingNotification.css        # 样式
├── floatingNotificationEntry.tsx        # ReactDOM 挂载入口
├── services/testPopCommandService.ts    # /test-pop 命令解析
components/Chat/ChatView.tsx            # 拦截 /test-pop 命令
floating-notification.html              # Vite 多页入口 HTML
vite.config.ts                          # 多页配置
```

### 1.2 核心设计决策

**主进程侧维护待确认跟踪。** 当前 `pendingConfirmStore` 在渲染进程中维护（通过 `toolOnConfirmRequest` / `toolOnResult` IPC 事件订阅），但弹出决策需要主进程做出（只有主进程知道 `isVisible()`、`isFocused()`）。因此在 `FloatingNotificationManager` 中维护一份主进程侧的待确认 Map，与渲染进程的 `pendingConfirmStore` 独立但数据一致。

## 2. 数据流

```
toolChatLoop.ts 发送 tool:confirm-request 到渲染进程
  → 同时调用 FloatingNotificationManager.onConfirmRequest(...)
    → 主进程侧 pendingItems Map 新增
    → evaluate() → 检查窗口状态 → 若需弹出 → pushToFloatingWindow()

toolChatLoop.ts 发送 tool:result 到渲染进程
  → 同时调用 FloatingNotificationManager.onToolResult(...)
    → 主进程侧 pendingItems Map 移除
    → evaluate() → 若无待确认项 → 关闭浮动窗口

主窗口事件 (focus/blur/hide/show/minimize/restore)
  → FloatingNotificationManager.onWindowStateChange()
    → evaluate() → 弹出或关闭
```

## 3. FloatingNotificationManager

### 3.1 接口

```typescript
class FloatingNotificationManager {
  private pendingItems: Map<string, PendingConfirmEntry> = new Map()
  private floatingWin: BrowserWindow | null = null
  private blurDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private closeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private dismissed = false

  // toolChatLoop 调用
  onConfirmRequest(entry: PendingConfirmEntry): void
  onToolResult(requestId: string, toolUseId: string): void
  onAllCancelledForRequest(requestId: string): void

  // main.ts 窗口事件驱动
  onMainWindowFocus(): void
  onMainWindowBlur(): void
  onMainWindowHide(): void
  onMainWindowShow(): void
  onMainWindowMinimize(): void
  onMainWindowRestore(): void

  // /test-pop 调试
  showTestNotification(): void

  // 应用退出
  destroy(): void

  private evaluate(): void
  private pushToFloatingWindow(): void
  private buildNotificationData(): FloatingNotificationData
}
```

### 3.2 evaluate() 决策矩阵

| pendingItems | 主窗口状态 | 动作 |
|:--|:--|:--|
| 空 | 任意 | 关闭浮动窗口（500ms 防抖） |
| 非空 | visible + focused | 关闭浮动窗口 |
| 非空 | !visible 或 !focused | 弹出/更新浮动窗口（dismissed=true 时跳过，除非是新确认项） |

### 3.3 dismissed 标记

- 用户点击 ✕ 关闭后设为 `true`
- 新确认请求到达时重置为 `false`（有新确认需求，重新弹出）

### 3.4 防抖策略

| 场景 | 延迟 | 说明 |
|:--|:--|:--|
| blur → 弹出 | 2s | 避免短暂 Alt+Tab 误弹 |
| 待确认清空 → 关闭 | 500ms | 避免快速连续确认时闪烁 |
| 新确认项到达 | 0ms | 即时更新 |

## 4. 浮动窗口

### 4.1 窗口属性

| 属性 | 值 |
|:--|:--|
| 尺寸 | 宽 280px，高约 108px |
| 位置 | 屏幕右下角 workArea，距边缘 20px |
| alwaysOnTop | true，level: 'floating' |
| focusable | false |
| skipTaskbar | true |
| transparent | true（背景透明，仅内容可点击） |
| frame | false |
| resizable | false |

### 4.2 位置计算

```typescript
function calculatePosition(windowWidth: number, windowHeight: number): { x: number; y: number } {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { x, y, width, height } = primaryDisplay.workArea
  return {
    x: x + width - windowWidth - 20,
    y: y + height - windowHeight - 20
  }
}
```

### 4.3 加载方式

- **开发模式：** 加载 Vite 开发服务器 `http://127.0.0.1:9240/#/floating-notification`（hash 路由）
- **生产模式：** 加载打包后的 `dist/renderer/floating-notification.html`

使用 Vite 多页配置，`floating-notification.html` 作为独立入口。

## 5. IPC 设计

### 5.1 通道

| 通道 | 方向 | 功能 |
|:--|:--|:--|
| `notification:get-data` | 渲染→主 | 浮动窗口初始化时请求当前数据 |
| `notification:update` | 主→渲染 | 推送 FloatingNotificationData 到浮动窗口 |
| `notification:close` | 主→渲染 | 通知浮动窗口关闭 |
| `notification:focus-session` | 渲染→主 | 点击确认项，聚焦会话 |
| `notification:show-main` | 渲染→主 | 点击"回到主界面" |
| `notification:dismiss` | 渲染→主 | 点击 ✕ |
| `test-pop:show` | 渲染→主 | /test-pop 命令（仅 DEV） |

### 5.2 API 类型

```typescript
interface FloatingNotificationApi {
  notificationReady: () => Promise<void>
  notificationGetData: () => Promise<FloatingNotificationData>
  notificationFocusSession: (payload: { sessionId: string; toolUseId?: string }) => Promise<void>
  notificationShowMain: () => Promise<void>
  notificationDismiss: () => Promise<void>
  notificationOnUpdate: (cb: (data: FloatingNotificationData) => void) => () => void
  notificationOnClose: (cb: () => void) => () => void
  testPopShow: () => Promise<void>
}
```

## 6. 数据结构

```typescript
interface PendingConfirmEntry {
  sessionId: string
  sessionName: string
  toolUseId: string
  toolName: string
  toolLabel: string
  requestId: string
  createdAt: number
}

interface FloatingNotificationData {
  totalSessions: number
  totalItems: number
  latestItem: {
    sessionId: string
    sessionName: string
    toolUseId: string
    toolName: string
    toolLabel: string
    createdAt: number
  } | null
}
```

## 7. UI 组件

### 7.1 FloatingNotificationApp

浮动窗口根组件，不加载 Redux store。结构：

```
FloatingNotificationApp
├── 标题栏（⚠ 待确认操作 + ✕ 按钮）
├── 中间内容区（会话名 + 工具名，仅展示最近一条）
└── 底部操作栏（共 X 个会话 · Y 项待确认 + 回到主界面按钮）
```

- 初始化时调用 `notificationGetData()` 获取当前数据
- 订阅 `notificationOnUpdate` 实时刷新
- 订阅 `notificationOnClose` 关闭自身
- 点击事件通过 `notificationFocusSession` / `notificationShowMain` / `notificationDismiss` 通知主进程

### 7.2 入口文件

`floatingNotificationEntry.tsx`：独立 ReactDOM 挂载点，仅渲染 `FloatingNotificationApp`，不包含 Router、Redux Provider 等主窗口基础设施。

## 8. /test-pop 调试命令

与 `/test-cards` 模式一致：

- `parseTestPopCommand(text)` → `{ type: 'chat' | 'command' | 'run' }`
- 仅开发模式可用
- `/test-pop help` 展示帮助
- `/test-pop` → 调用 IPC `test-pop:show`，主进程跳过窗口状态检查直接弹出 mock 数据
- Mock 数据：2 个会话，3 项待确认，最近一条为 "测试会话 — run_shell — npm install react"

## 9. i18n

新增 `notification` 命名空间，包含 key：

- `title`: 待确认操作
- `summary`: 共 {sessions} 个会话 · {items} 项待确认
- `backToMain`: 回到主界面
- `aria.notification` / `aria.itemClick` / `aria.closeButton` / `aria.backToMainButton`

## 10. 测试

| 测试文件 | 覆盖内容 |
|:--|:--|
| `electron/floatingNotification.test.ts` | 位置计算、窗口创建/销毁 |
| `electron/floatingNotificationManager.test.ts` | 决策矩阵、防抖定时器、dismissed 标记 |
| `src/renderer/components/FloatingNotification/FloatingNotificationApp.test.tsx` | UI 渲染、点击事件、i18n |
| `src/renderer/services/testPopCommandService.test.ts` | 命令解析、dev/prod 分支 |

## 11. 实现顺序

| 阶段 | 内容 |
|:--|:--|
| 1 | `src/shared/api.ts` 类型定义、Vite 多页配置、`floating-notification.html` |
| 2 | `electron/floatingNotification.ts` + 测试 |
| 3 | `electron/floatingNotificationManager.ts` + 测试 |
| 4 | `electron/floatingNotificationPreload.ts`、`electron/preload.ts` 修改 |
| 5 | `electron/appIpc.ts` 注册 handler、`electron/main.ts` 注册窗口事件 |
| 6 | `FloatingNotificationApp.tsx` + 样式 + 入口 + 测试 |
| 7 | `testPopCommandService.ts` + 测试、`ChatView.tsx` 修改 |
| 8 | i18n 资源文件 + 类型生成 + 校验 |
