# 待确认状态桌面浮动通知 — 产品需求文档

**版本：** 1.0
**日期：** 2026-06-11
**状态：** 待评审
**关联文档：**
- [confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md)（确认卡片信任机制）
- [system-tray.md](./system-tray.md)（系统托盘）
- [tools-requirement.md](./tools-requirement.md)（工具确认框架）

---

## 目录

1. [概述](#1-概述)
2. [问题分析](#2-问题分析)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [设计方案](#5-设计方案)
6. [交互行为](#6-交互行为)
7. [数据结构与 IPC](#7-数据结构与-ipc)
8. [实现要点](#8-实现要点)
9. [验收标准](#9-验收标准)
10. [多语言资源规划](#10-多语言资源规划)
11. [相关文件](#11-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前支持系统托盘常驻（见 [system-tray.md](./system-tray.md)），用户关闭主窗口后应用进入后台运行，Agent 仍可继续执行指令。工具确认超时为 **5 分钟**（`electron/toolConfirmRegistry.ts`），若超时则自动拒绝。

当前存在的问题：当主窗口被隐藏（最小化到托盘）或被其他窗口覆盖（失去焦点），同时 Agent 在执行过程中触发了工具确认请求时，用户无从得知需要介入操作，导致确认超时、指令执行失败。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 不遗漏确认 | 用户不会因窗口不可见而错过确认时机 |
| 降低超时率 | 及时引导用户回主界面操作，减少因超时导致的指令失败 |
| 后台友好 | 用户可将 SpaceAssistant 放入托盘后台运行，有确认需求时被动通知 |
| 非侵入式 | 桌面右下角浮动窗口，不打断用户当前工作流 |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **仅在必要时出现** | 仅当主窗口不可见/失去焦点 **且** 存在待确认项时才弹出 |
| **即时消失** | 所有待确认项被处理或主窗口获得焦点后立即自动关闭 |
| **不抢焦点** | 浮动窗口不夺取系统输入焦点，避免干扰用户当前操作 |
| **信息精简** | 仅展示必要信息（会话名、工具名、待确认数量），引导用户回主界面 |
| **平台一致性** | 浮动窗口外观在各平台上风格统一 |

---

## 2. 问题分析

### 2.1 当前痛点

| 场景 | 当前体验 | 期望体验 |
|------|----------|----------|
| 主窗口最小化到托盘，Agent 请求执行 `run_shell` 需确认 | 用户不知道，5 分钟后超时拒绝 | 桌面右下角弹出浮动通知，用户点击后主窗口恢复，确认卡片可见 |
| 主窗口被 VS Code 全屏覆盖，Agent 请求写入文件需确认 | 用户不知道，指令卡住 | 浮动通知出现在最上层（不抢焦点），提示用户回主界面 |
| 多个会话同时有待确认项 | 侧边栏横幅显示数量，但窗口不可见时无用 | 浮动通知汇总显示所有待确认会话和数量 |
| 用户正在其他桌面/虚拟桌面工作 | 完全不知道 SpaceAssistant 需要操作 | 浮动通知跨桌面可见（在任务栏所在桌面），引导用户切回 |

### 2.2 核心场景

```
用户发起 Agent 指令 → 最小化窗口 → Agent 执行中触发 tool:confirm-request
  → 主进程检测：窗口不可见 or 未聚焦 → 弹出浮动通知窗口
  → 用户看到通知 → 点击通知 → 主窗口恢复并聚焦 → 确认卡片高亮
  → 用户操作确认/拒绝 → 浮动通知自动消失
```

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 当主窗口不可见（隐藏/最小化）或失去焦点时，存在待确认项则弹出桌面浮动通知 |
| G2 | 浮动通知显示在屏幕右下角，不夺取系统焦点 |
| G3 | 通知内容包含：最近一条待确认的工具名称，以及底部汇总（会话数 + 总项数） |
| G4 | 点击浮动通知 → 恢复并聚焦主窗口，定位到对应会话 |
| G5 | 所有待确认项被处理后（确认/拒绝/超时/取消），浮动通知自动关闭 |
| G6 | 主窗口重新获得焦点后，浮动通知自动关闭（用户已回到主界面） |
| G7 | 支持多个会话同时存在待确认项的场景，通知汇总显示 |

### 3.2 非目标

| # | 非目标 | 说明 |
|---|--------|------|
| NG1 | 不支持在浮动通知上直接操作确认/拒绝 | 通知仅用于引导回主界面 |
| NG2 | 不支持通知历史记录 | 通知仅反映当前实时状态 |
| NG3 | 不取代系统原生通知 | 浮动窗口为自定义 UI，不作为 OS Notification Center 条目 |
| NG4 | 不支持用户配置通知开关（当前版本） | 后续迭代可加入设置项 |
| NG5 | 不支持在主窗口可见且聚焦时弹出通知 | 用户已能看到确认卡片，无需额外通知 |

---

## 4. 用户故事

### US-01：后台运行时不遗漏确认

**作为** 将 SpaceAssistant 最小化到托盘的开发者，**当** Agent 在后台执行过程中需要确认工具调用时，**我希望** 桌面右下角弹出一个浮动通知窗口，**以便** 我及时知道需要介入操作，避免因超时导致指令失败。

### US-02：被遮挡时感知确认需求

**作为** 在使用其他全屏应用（IDE、浏览器）的用户，**当** SpaceAssistant 被覆盖但 Agent 触发了确认请求时，**我希望** 看到一个置顶但不抢焦点的浮动窗口，**以便** 我能感知到确认需求并决定何时切回 SpaceAssistant。

### US-03：一键回到确认现场

**作为** 看到浮动通知的用户，**当我** 点击通知时，**我希望** 主窗口立即恢复并聚焦到有待确认的会话，**以便** 我能快速完成确认操作。

### US-04：确认完成后通知自动消失

**作为** 已处理完所有待确认项的用户，**我希望** 浮动通知自动关闭，**以便** 桌面上不留下多余的窗口。

### US-05：多会话汇总

**作为** 同时运行多个 Agent 会话的用户，**当** 多个会话都有待确认项时，**我希望** 浮动通知汇总显示所有待确认信息，**以便** 我一目了然地了解整体等待状态。

---

## 5. 设计方案

### 5.1 浮动通知窗口

#### 5.1.1 窗口属性

| 属性 | 值 | 说明 |
|------|-----|------|
| 类型 | `BrowserWindow`（无边框、透明背景） | 自定义渲染，与主窗口共享 Vite 开发服务器 |
| 尺寸 | 宽度 `280px`，高度自适应（最小 `108px`，最大 `120px`） | 紧凑卡片式布局，内容区域固定展示最近一条确认项 |
| 位置 | 屏幕右下角 | 任务栏上方，距右边缘 `20px`，距下边缘 `20px`（含任务栏偏移） |
| 置顶 | `alwaysOnTop: true`，`level: 'floating'` | 不抢焦点，始终在最上层可见 |
| 焦点策略 | `focusable: false`，`skipTaskbar: true` | 不出现在任务栏，不夺取键盘焦点 |
| 透明点击穿透 | 窗口背景透明，仅内容区域可点击 | 非内容区域鼠标事件穿透到下层窗口 |
| 关闭按钮 | 右上角小型 X 按钮 | 手动关闭（临时隐藏，有新确认时重新弹出） |
| 动画 | 从右下角滑入（~200ms ease-out） | 视觉上不突兀 |

#### 5.1.2 视觉设计

浮动通知卡片采用极致精简布局：中间内容区**仅展示最近一条确认项**，底部操作栏汇总全部待确认信息。这样即使用户同时有多个会话等待确认，卡片也始终保持小巧、不压信息。

```
┌──────────────────────────────────────┐
│ ⚠ 待确认操作                    [✕] │  ← 标题栏（32px）
│ ─────────────────────────────────── │
│                                      │
│  🗨️ 会话名称                         │  ← 最近一条待确认
│     💻 run_shell — npm install      │     仅一行，超出省略
│                                      │
│ ─────────────────────────────────── │
│  共 3 个会话 · 5 项待确认 [回到主界面]│  ← 底部操作栏（36px）
└──────────────────────────────────────┘
```

**尺寸说明：**
- 窗口宽 `280px`，圆角 `12px`，高度固定约 `108px`（内容区仅展示一条确认项，无滚动）
- 标题栏 `32px`，中间内容区约 `40px`，底部操作栏 `36px`
- 若无待确认项，窗口不显示

**中间内容区：**
- 固定展示**最近一条**待确认项（按 `createdAt` 倒序取第一条）
- 格式：会话名（一行）+ 工具名与简要描述（一行）
- 每行超出宽度省略号截断
- 多项待确认时，仅靠底部汇总行传达总量信息

**配色：**
- 背景色跟随系统主题（浅色/深色），与主窗口一致
- 标题栏左侧图标使用 `#FAAD14`（警告黄）
- 确认项左侧工具图标使用 `currentColor`，透明度 `0.65`
- 「回到主界面」按钮使用主题色

#### 5.1.3 显示逻辑

```
主进程收到 tool:confirm-request
  → 检查主窗口状态
  ├── 窗口可见 && 已聚焦 → 不弹出浮动通知（用户能看到确认卡片）
  └── 窗口不可见 or 未聚焦 → 弹出/更新浮动通知
        → 渲染进程通过 IPC 获取当前所有待确认项摘要
        → 更新浮动窗口内容
```

**窗口不可见的判定条件：**

| 条件 | 判定方式 |
|------|----------|
| 窗口被 `hide()` 隐藏 | `win.isVisible() === false` |
| 窗口被最小化 | `win.isMinimized() === true` |
| 窗口被其他窗口完全覆盖 | `win.isFocused() === false`（近似判定，见 §5.1.4） |

**注意**：Electron 无法精确判定窗口是否被其他应用完全遮挡。使用 `isFocused()` 作为近似条件：窗口未聚焦意味着用户可能正在操作其他应用，此时应弹出通知。若用户的主窗口在副屏上可见但未聚焦，弹出通知属于可接受的「过度通知」，且用户可手动关闭。

#### 5.1.4 窗口可见性跟踪

需要在主进程中持续跟踪主窗口的可见性和焦点状态：

```typescript
// 主进程监听
win.on('hide', () => updateFloatingNotification())
win.on('show', () => updateFloatingNotification())
win.on('focus', () => closeFloatingNotification())  // 用户回到主界面 → 关闭通知
win.on('blur', () => scheduleFloatingNotificationCheck())  // 失去焦点 → 稍后检查
win.on('minimize', () => updateFloatingNotification())
win.on('restore', () => updateFloatingNotification())
```

其中 `blur` 事件不立即弹出通知（用户可能只是短暂切换窗口），而是设置 2 秒防抖定时器，到期后若有待确认项则弹出。

### 5.2 通知内容数据模型

```typescript
/** 单个待确认项摘要（传递给浮动窗口） */
interface PendingConfirmSummaryItem {
  sessionId: string
  sessionName: string           // 会话显示名称
  toolUseId: string
  toolName: string              // 工具名，如 "run_shell"、"write_file"
  toolLabel: string             // 可读标签，如 "run_shell — npm install"
  createdAt: number             // 创建时间戳
}

/** 浮动通知窗口的数据 */
interface FloatingNotificationData {
  totalSessions: number              // 有待确认项的会话数
  totalItems: number                 // 待确认项总数
  latestItem: PendingConfirmSummaryItem | null  // 最近一条确认项（用于中间内容区展示）
}
```

### 5.3 生命周期状态机

```
                    ┌─────────────────────────────────┐
                    │          NO_PENDING              │
                    │  (无待确认项，通知窗口关闭)        │
                    └──────┬──────────────┬───────────┘
                           │              │
              有新确认请求  │              │ 主窗口获得焦点
              且窗口不可见   │              │
                           ▼              │
                    ┌──────────────────┐  │
                    │   NOTIFICATION    │  │
                    │   (通知窗口显示)   │◄─┘
                    └────┬───┬────┬────┘
                         │   │    │
            所有确认完成  │   │    │ 用户点击通知
            或超时/取消   │   │    │
                         ▼   │    │
                    ┌──────┐ │    │
                    │ 关闭 │◄┘    │
                    │ 通知  │     │
                    └──────┘     │
                                 ▼
                          ┌──────────────┐
                          │ 恢复主窗口    │
                          │ 聚焦对应会话  │
                          │ 关闭通知窗口  │
                          └──────────────┘
```

---

## 6. 交互行为

### 6.1 弹出时机

| 触发条件 | 行为 |
|----------|------|
| `tool:confirm-request` 触发，且主窗口 `!isVisible() \|\| !isFocused()` | 立即弹出/更新浮动通知 |
| 主窗口 `blur` 事件 | 启动 2s 防抖定时器，到期后若有待确认项则弹出 |
| 主窗口 `hide` / `minimize` 事件 | 若有待确认项则立即弹出 |
| 浮动通知窗口被用户手动关闭后，新的确认请求到来 | 重新弹出 |

### 6.2 关闭时机

| 触发条件 | 行为 |
|----------|------|
| 所有待确认项被处理（确认/拒绝/超时） | `pendingConfirmStore` 为空 → 立即关闭浮动通知 |
| 主窗口 `focus` 事件 | 立即关闭浮动通知（用户已回到主界面） |
| 用户点击通知上的 ✕ 按钮 | 关闭通知（有新确认时重新弹出） |
| 用户点击「回到主界面」按钮 | 恢复并聚焦主窗口 → 关闭通知 |
| 应用退出 | 销毁浮动通知窗口 |

### 6.3 点击行为

| 点击目标 | 行为 |
|----------|------|
| 中间内容区（最近一条确认项） | 恢复主窗口 → 切换到对应会话 → 滚动到对应确认卡片 |
| 「回到主界面」按钮 | 恢复主窗口 → 聚焦 → 切换到第一个有待确认的会话 |
| ✕ 关闭按钮 | 关闭通知窗口，不恢复主窗口 |

### 6.4 多确认项场景

- 中间内容区始终只展示**最近一条**确认项（按时间倒序取最新）
- 底部汇总行显示全部待确认信息（如「共 3 个会话 · 5 项待确认」）
- 点击中间内容区（或「回到主界面」按钮）→ 恢复主窗口并切换到最近一条确认项所属会话
- 新确认项到达时，若比当前展示的更新则刷新中间内容区

### 6.5 与系统托盘的协同

- 双击托盘图标恢复主窗口 → 同 `focus` 事件，关闭浮动通知
- 托盘右键菜单「打开主窗口」→ 同上
- 若托盘未启用（`trayEnabled === false`），浮动通知功能仍然有效（窗口可能只是被其他窗口覆盖）

---

## 7. 数据结构与 IPC

### 7.1 新增 IPC 通道

| 通道 | 方向 | 功能 |
|------|------|------|
| `notification:floating-data` | 渲染 → 主 | 渲染进程请求当前浮动通知应显示的数据 |
| `notification:update` | 主 → 渲染 | 主进程通知浮动窗口更新内容 |
| `notification:close` | 主 → 渲染 | 主进程通知浮动窗口关闭 |
| `notification:focus-session` | 渲染 → 主 | 浮动窗口被点击，请求恢复主窗口并切换到最近一条确认项所属会话 |

### 7.2 新增 API 方法

```typescript
// src/shared/api.ts 新增
interface FloatingNotificationApi {
  /** 浮动窗口就绪通知 */
  notificationReady: () => Promise<void>
  /** 请求当前浮动通知数据 */
  notificationGetData: () => Promise<FloatingNotificationData>
  /** 点击确认项，请求聚焦会话 */
  notificationFocusSession: (payload: { sessionId: string; toolUseId?: string }) => Promise<void>
  /** 点击回到主界面 */
  notificationShowMain: () => Promise<void>
  /** 关闭浮动通知（用户点击 ✕） */
  notificationDismiss: () => Promise<void>
}

/** 主进程推送到浮动窗口的事件 */
notificationOnUpdate: (cb: (data: FloatingNotificationData) => void) => () => void
notificationOnClose: (cb: () => void) => () => void
```

### 7.3 主进程新增模块

| 模块 | 职责 |
|------|------|
| `electron/floatingNotification.ts` | 浮动窗口的创建、销毁、显示/隐藏、位置计算 |
| `electron/floatingNotificationManager.ts` | 业务逻辑：根据窗口状态和待确认项决定弹出/关闭时机 |

### 7.4 浮动窗口渲染进程

浮动窗口是一个独立的 `BrowserWindow`，加载与主窗口相同的 Vite 开发服务器 URL，但路由到独立页面（如 `#/floating-notification`）。仅包含最小化的 React 组件树：

- `FloatingNotificationApp`：根组件，订阅 IPC 事件更新数据，渲染标题栏 + 单条确认项 + 底部汇总
- 不加载 Redux store、侧边栏等主窗口组件

---

## 8. 实现要点

### 8.1 模块划分

| 模块 | 位置 | 职责 |
|------|------|------|
| 浮动窗口管理 | `electron/floatingNotification.ts` | 创建/销毁 BrowserWindow，位置计算 |
| 通知决策逻辑 | `electron/floatingNotificationManager.ts` | 判断弹出/关闭时机，管理防抖定时器 |
| 渲染进程页面 | `src/renderer/components/FloatingNotification/` | 浮动窗口 UI 组件 |
| IPC 注册 | `electron/appIpc.ts` | 注册通知相关 IPC 处理器 |
| API 类型 | `src/shared/api.ts` | 新增 `FloatingNotificationApi` 方法类型 |
| 预加载 | `electron/preload.ts` | 暴露通知 API 到浮动窗口 |
| 窗口状态跟踪 | `electron/main.ts` | 在 `createMainWindow` 中注册 focus/blur/hide/show/minimize/restore 监听 |

### 8.2 浮动窗口创建流程

```
app.whenReady()
  → 创建主窗口
  → 注册主窗口 focus/blur/hide/show 事件监听
  → 初始化 FloatingNotificationManager
  → 不在启动时创建浮动窗口（懒加载，首次需要时才创建）
  
收到 tool:confirm-request
  → pendingConfirmStore 新增项
  → FloatingNotificationManager.evaluate()
    → 检查主窗口状态
    → 若需弹出且浮动窗口未创建 → createFloatingWindow()
    → 收集待确认项摘要 → 推送到浮动窗口渲染进程
```

### 8.3 浮动窗口位置计算

```typescript
function calculateFloatingWindowPosition(
  screen: Electron.Screen,
  windowWidth: number,
  windowHeight: number
): { x: number; y: number } {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { x, y, width, height } = primaryDisplay.workArea  // workArea 排除任务栏
  return {
    x: x + width - windowWidth - 20,
    y: y + height - windowHeight - 20
  }
}
```

使用 `workArea` 而非 `bounds` 以确保浮动窗口不覆盖任务栏。

### 8.4 防抖策略

| 场景 | 延迟 | 说明 |
|------|------|------|
| 主窗口 `blur` → 弹出通知 | `2s` | 避免用户短暂 Alt+Tab 切换时误弹 |
| 待确认项全部清除 → 关闭通知 | `500ms` | 避免在快速连续确认时频繁开关 |
| 新确认项到达（通知已显示） | `0ms`（即时更新） | 通知内容实时刷新 |

### 8.5 安全性

| 考量 | 措施 |
|------|------|
| 浮动窗口 webContents 安全 | 与主窗口共用同一 Vite 开发服务器，`nodeIntegration: false`，`contextIsolation: true` |
| 预加载隔离 | 浮动窗口使用独立的预加载脚本，仅暴露通知相关 API |
| 浮动窗口导航限制 | 仅允许加载通知页面 URL，禁止导航到外部地址 |

### 8.6 调试命令 `/test-pop`

为方便在开发过程中快速验证浮动通知窗口的 UI 样式、弹出/关闭行为和点击交互，新增一个纯调试用命令 `/test-pop`。

#### 8.6.1 命令行为

| 项 | 说明 |
|-----|------|
| 命令 | `/test-pop` |
| 作用 | 在桌面右下角立即弹出浮动通知窗口（模拟有待确认项的状态） |
| 可用范围 | **仅开发模式**（`import.meta.env.DEV === true`），打包后不可用 |
| 实现模式 | 与现有 `/test-cards` 命令保持一致：解析命令 → 若为 `command` 类型则展示帮助提示；若为 `run` 类型则触发浮动通知弹出 |

#### 8.6.2 子命令

| 输入 | 行为 |
|------|------|
| `/test-pop` | 弹出浮动通知窗口，使用预设 mock 数据 |
| `/test-pop help` | 展示帮助提示文本 |

#### 8.6.3 Mock 数据

弹出时使用如下预设 mock 数据填充浮动通知：

```typescript
const TEST_POP_MOCK_DATA: FloatingNotificationData = {
  totalSessions: 2,
  totalItems: 3,
  latestItem: {
    sessionId: 'test-session-1',
    sessionName: '测试会话',
    toolUseId: 'test-tool-1',
    toolName: 'run_shell',
    toolLabel: 'run_shell — npm install react',
    createdAt: Date.now()
  }
}
```

#### 8.6.4 实现流程

```
用户输入 /test-pop
  → parseTestPopCommand(text)
    ├── 非开发模式 → 返回 command 类型，提示仅开发模式可用
    ├── sub === 'help' → 返回 command 类型，展示帮助
    └── 开发模式 + 无子命令 → 返回 run 类型
  → ChatView 中拦截 run 类型
  → 通过 IPC 调用主进程 floatingNotificationManager.showTestNotification()
  → 主进程创建/显示浮动窗口，推送 mock 数据
  → 浮动窗口渲染 mock 内容
  → 用户点击浮动通知 → 恢复主窗口（不切换会话，因为测试会话不存在）
  → 用户手动关闭通知 → 通知消失
```

#### 8.6.5 新增/修改文件

| 文件 | 变更 |
|------|------|
| `src/renderer/services/testPopCommandService.ts` | **新增**：命令解析，与 `testCardsCommandService.ts` 同模式 |
| `src/renderer/components/Chat/ChatView.tsx` | 修改：在消息发送流程中拦截 `/test-pop`，调用 IPC 触发浮动通知 |
| `electron/appIpc.ts` | 修改：注册 `test-pop:show` IPC handler |
| `electron/floatingNotificationManager.ts` | 修改：新增 `showTestNotification()` 方法，跳过窗口状态检查直接弹出 |

#### 8.6.6 验收

- [ ] 开发模式下输入 `/test-pop` → 浮动通知立即弹出，展示 mock 数据
- [ ] 开发模式下输入 `/test-pop help` → 展示帮助提示
- [ ] 打包模式下输入 `/test-pop` → 提示仅开发模式可用
- [ ] 点击浮动通知中间内容区 → 主窗口恢复并聚焦
- [ ] 点击 ✕ → 通知关闭

### 8.7 测试要求

| 测试文件 | 覆盖内容 |
|----------|----------|
| `electron/floatingNotificationManager.test.ts` | 弹出/关闭决策逻辑、防抖定时器、窗口状态判定 |
| `electron/floatingNotification.test.ts` | 窗口创建/销毁、位置计算、IPC 通信 |
| `src/renderer/components/FloatingNotification/FloatingNotificationApp.test.tsx` | UI 渲染、数据更新、点击事件 |
| `src/renderer/services/testPopCommandService.test.ts` | 命令解析、开发/打包模式分支 |

---

## 9. 验收标准

### 9.1 功能验收

- [ ] 主窗口最小化到托盘后，Agent 触发工具确认 → 桌面右下角弹出浮动通知
- [ ] 主窗口被其他窗口覆盖（失去焦点）后，Agent 触发工具确认 → 桌面右下角弹出浮动通知（2s 防抖后）
- [ ] 浮动通知不夺取系统焦点（用户正在打字不会被中断）
- [ ] 浮动通知不出现在任务栏中
- [ ] 浮动通知展示最近一条待确认项的会话名和工具名
- [ ] 浮动通知底部显示「共 X 个会话 · Y 项待确认」汇总
- [ ] 点击中间内容区 → 主窗口恢复并聚焦 → 自动切换到对应会话 → 定位到确认卡片
- [ ] 点击「回到主界面」按钮 → 主窗口恢复并聚焦
- [ ] 点击 ✕ 关闭按钮 → 通知关闭（新确认到来时重新弹出）
- [ ] 所有待确认项被处理后 → 浮动通知自动关闭
- [ ] 用户双击托盘图标恢复主窗口 → 浮动通知自动关闭
- [ ] 主窗口获得焦点后 → 浮动通知自动关闭
- [ ] 新确认项比当前展示的更新时，中间内容区实时刷新
- [ ] 浮动窗口位置在屏幕右下角（任务栏上方）
- [ ] 浮动窗口在 alwaysOnTop 层级，不被其他窗口遮挡

### 9.2 边界情况

- [ ] 待确认项全部清除后通知自动关闭（500ms 防抖）
- [ ] 浮动通知被手动关闭后，新的确认请求到达 → 重新弹出
- [ ] 应用退出时浮动通知被正确销毁，无残留窗口
- [ ] 系统托盘未启用时，浮动通知功能仍正常工作
- [ ] 用户快速连续确认多条时，通知不会闪烁（500ms 防抖关闭）

### 9.3 平台兼容

- [ ] Windows 10+：浮动窗口正确显示在任务栏上方
- [ ] macOS：浮动窗口正确显示在 Dock 上方
- [ ] Linux：浮动窗口正确显示（若有托盘则在上方）

---

## 10. 多语言资源规划

### 10.1 命名空间

| 命名空间 | 用途 |
|----------|------|
| `notification`（新增） | 浮动通知窗口文案 |

### 10.2 翻译 key

```json
// src/renderer/i18n/resources/zh-CN/notification.json
{
  "title": "待确认操作",
  "summary": "共 {sessions} 个会话 · {items} 项待确认",
  "backToMain": "回到主界面",
  "aria": {
    "notification": "待确认操作浮动通知",
    "itemClick": "回到主界面确认待确认操作",
    "closeButton": "关闭通知",
    "backToMainButton": "回到主界面"
  }
}
```

```json
// src/renderer/i18n/resources/en-US/notification.json
{
  "title": "Action Required",
  "summary": "{sessions} sessions · {items} pending",
  "backToMain": "Back to Main",
  "aria": {
    "notification": "Pending confirmation floating notification",
    "itemClick": "Return to main window to confirm pending action",
    "closeButton": "Close notification",
    "backToMainButton": "Back to main window"
  }
}
```

### 10.3 开发流程

按照 [i18n-sync-guide.md](../develop/i18n-sync-guide.md) 规范：

1. 在 `zh-CN` 添加 `notification.json`
2. 运行 `npm run i18n:generate-types` 更新类型
3. 在组件中使用 `useTypedTranslation('notification')`
4. 在 `en-US` 同步相同 key 结构
5. 运行 `npm run i18n:check` 验证

---

## 11. 相关文件

| 区域 | 文件 | 变更类型 |
|------|------|----------|
| 浮动窗口管理 | `electron/floatingNotification.ts` | **新增** |
| 通知决策逻辑 | `electron/floatingNotificationManager.ts` | **新增** |
| 浮动窗口 UI | `src/renderer/components/FloatingNotification/FloatingNotificationApp.tsx` | **新增** |
| 浮动窗口样式 | `src/renderer/components/FloatingNotification/floatingNotification.css` | **新增** |
| 浮动窗口入口 | `src/renderer/floatingNotificationEntry.tsx` | **新增**（独立 React 挂载点） |
| HTML 入口 | `floating-notification.html` | **新增**（Vite 多页配置） |
| IPC 注册 | `electron/appIpc.ts` | 修改（新增通知相关 handler） |
| API 类型 | `src/shared/api.ts` | 修改（新增 FloatingNotificationApi） |
| 预加载 | `electron/preload.ts` | 修改（暴露通知 API） |
| 预加载（浮动窗口） | `electron/floatingNotificationPreload.ts` | **新增**（独立预加载） |
| 主进程入口 | `electron/main.ts` | 修改（注册窗口事件监听、初始化浮动通知管理器） |
| Vite 配置 | `vite.config.ts` | 修改（多页入口配置） |
| 调试命令服务 | `src/renderer/services/testPopCommandService.ts` | **新增**（命令解析） |
| 聊天视图 | `src/renderer/components/Chat/ChatView.tsx` | 修改（拦截 `/test-pop` 命令） |
| i18n | `src/renderer/i18n/resources/zh-CN/notification.json` | **新增** |
| i18n | `src/renderer/i18n/resources/en-US/notification.json` | **新增** |
| 测试 | `src/renderer/services/testPopCommandService.test.ts` | **新增** |
| 测试 | `electron/floatingNotificationManager.test.ts` | **新增** |
| 测试 | `electron/floatingNotification.test.ts` | **新增** |
| 测试 | `src/renderer/components/FloatingNotification/FloatingNotificationApp.test.tsx` | **新增** |

---

## 12. 后续可选迭代

1. **通知开关设置**：在设置页添加「后台待确认通知」开关，允许用户关闭浮动通知
2. **系统原生通知兜底**：若用户关闭了浮动通知，可降级使用 Electron `Notification` API 发送系统通知
3. **通知动画**：滑入/滑出动画增强体验
4. **免打扰时段**：支持设置免打扰时间窗口
5. **托盘图标角标**：托盘图标叠加待确认数量角标（类似未读消息数）

---

**文档版本**: v1.1
**创建日期**: 2026-06-11
**修订记录**:
- v1.1 (2026-06-11): 新增 `/test-pop` 调试命令（§8.6）
- v1.0 (2026-06-11): 初稿
**适用范围**: SpaceAssistant — 待确认状态桌面浮动通知
