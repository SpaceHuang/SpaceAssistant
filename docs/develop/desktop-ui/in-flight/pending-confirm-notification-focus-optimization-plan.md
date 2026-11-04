# 待确认通知抢焦点与遮挡问题：核验及优化方案

> 文档类型：技术方案（方向已确认）  
> 核验日期：2026-11-04  
> 代码基线：`90a0f7bd3af7d7530a0028c71923e7c6a15e21bd`  
> 状态：方向已由用户确认；P1 实施已完成并通过定向自动化、Electron 类型检查、增量 / 完整构建及全量测试；P2 已核验 macOS 通知系统投递、通知权限开启时的前台焦点保持，并由用户实测点击系统通知后主窗口置前、Dock 图标显示数字徽标。门禁剩余项为真实待确认通知点击后的最新会话定位，以及 Dock 徽标清除后的目视确认。Windows 实机回归为非阻断补充项（用户已确认）。

## 第 0 层：决策摘要【人必读】

**一句话：** 后台待确认时，macOS 改用系统通知与 Dock 待确认角标；Windows 保留当前自绘浮窗，确认操作仍由主界面完成。

**只有 3 分钟的话：** 看已定决策 D-1 和 macOS 验收标准 AC-1～AC-4。

### D-1：macOS 后台待确认提醒方式（已决定）

SpaceAssistant 在后台运行时仍须提醒用户有操作等待确认。当前自绘浮窗会覆盖其他应用，并存在焦点干扰路径。用户已决定：**macOS 使用系统通知，并在 Dock 图标显示待确认数量；Windows 保留当前自绘浮窗；本次不改 Windows 行为。** 仓库核验未找到待确认系统托盘泡泡入口，Windows 当前与其他平台共用 `FloatingNotificationManager` 自绘浮窗链路。

- macOS 系统通知只用于提醒，不展示工具参数，不提供批准 / 拒绝操作。
- 用户点击系统通知后，应用返回前台并定位到最新的待确认会话与确认卡片。
- Dock 角标显示当前待确认项总数；待确认项清空时清除角标。点击 Dock 图标仍走应用既有激活流程。
- 系统通知不可用或被系统设置屏蔽时，不弹自绘浮窗、不自动激活应用；Dock 角标与应用内待确认状态仍反映待处理项。
- Windows 当前自绘浮窗行为保持不变；不得将 macOS 改动扩展到 Windows 通知链路。用户已明确选择保留该行为；仓库检索确认待确认提醒由 `FloatingNotificationManager` 调用 `createFloatingNotificationWindow` 实现，并无独立托盘泡泡入口。

下钻：事实证据见 F-1～F-5；规格与验收见 INV-1～INV-3、AC-1～AC-4。

### 不需要用户决定

- 代码链路、当前测试覆盖和 Electron API 语义由实现者核验。
- 数据库、会话存储、agent-sdk、持久化和现有 IPC 均不需要为本方案新增契约。
- 确认授权逻辑不变；无论提醒是否显示，确认仍必须由现有桌面确认卡完成。

## 第 1 层：范围与链路【人机共读】

### RP-1 一句话变更

macOS 后台待确认时，从“自绘置顶浮窗自动出现”改为系统通知与 Dock 角标；Windows 保持原有自绘浮窗；确认操作仍回到主界面完成。

### RP-2 链路图

```text
现状
confirm-request
  → FloatingNotificationManager（待确认集合唯一维护者）
  → createFloatingNotificationWindow（alwaysOnTop + floating）
  → ready-to-show: show() → moveTop()
  → macOS 桌面上方出现浮窗

目标（macOS）
confirm-request
  → 待确认通知管理器（待确认集合唯一维护者）
  → Electron Notification + app.dock.setBadge(count)
  → 用户点击系统通知 / Dock 图标
  → 主窗口显式恢复并聚焦；通知点击定位最新待确认会话
```

### RP-3 变更面

| 单元 | 作用简述 | 改动类型 | 对应 `D/INV` | 跨边界 |
|---|---|---|---|---|
| `electron/floatingNotification.ts` | 创建桌面确认提示窗口 | 保留 Windows 浮窗；macOS 不再调用 | D-1、INV-1 | 否 |
| `electron/floatingNotificationManager.ts` | 汇总待确认项并决定提醒生命周期 | 增加 macOS 通知与角标分支 | D-1、INV-2 | 否 |
| `electron/main.ts` | 创建主窗口并连接窗口事件 | 注入平台与通知文案 | D-1、AC-3 | 否 |
| `electron/ipc/desktopIpc.ts` | 注册桌面进程 IPC 处理器 | 复用现有主窗口导航事件，不改 | AC-3 | 否 |
| `electron/floatingNotification.test.ts` | 校验浮窗原生窗口选项 | 保留 Windows 回归 | AC-1、AC-2 | 否 |
| `electron/floatingNotificationManager.test.ts` | 校验提醒状态转换 | 增加 macOS 通知 / 角标状态测试 | AC-1、AC-2、AC-4 | 否 |
| `electron/pendingConfirmNotification.ts` | 创建 macOS 待确认系统通知 | 新建 | D-1、INV-1、INV-3 | 否 |

### RP-4 契约面六面

| 契约面 | 结论 | 依据 |
|---|---|---|
| ① agent-sdk 接口契约 | 不改 | 提醒发生在宿主窗口层，不改变工具确认端口或审批记录。 |
| ② 会话存储接口契约 | 不改 | 待确认集合继续由内存管理器维护，不新增数据库字段或写入。 |
| ③ IPC / 预加载 | 保持现状 | 浮窗通道继续服务 Windows；macOS 提醒复用现有主窗口导航事件，不新增 IPC。 |
| ④ `src/shared/` 类型 | 保持现状 | 浮窗类型继续服务 Windows；本次不新增共享领域类型。 |
| ⑤ 持久化格式与迁移 | 不改 | 本方案不落盘。 |
| ⑥ 领域数据格式 | 不改 | 不变更确认策略、授权结果或错误码。 |

### RP-5 量级与拆分判断

本次只实施 macOS 分支：在待确认管理器增加系统通知与 Dock 角标协调，新增通知创建单元；Windows 继续使用现有自绘浮窗。仓库未发现待确认系统托盘泡泡实现，因此本方案按用户确认保留实际存在的 Windows 行为。复用现有主界面导航；不增加持久化字段、agent-sdk 或会话存储契约。浮窗 IPC / preload 仍供 Windows 浮窗使用，macOS 自动提醒路径不再调用。

### RP-6 待批准项与弱点

- 已批准：D-1，macOS 使用系统通知与 Dock 角标；Windows 保留当前自绘浮窗。
- 不新增通知开关或持久化设置；通知权限与勿扰行为由 macOS 系统控制。
- 最可能被推翻的假设：macOS 系统通知可能被系统设置屏蔽或延迟；若用户因此漏掉待确认项，需要基于实际反馈评估后续补救，不在本次偷偷恢复置顶浮窗。
- 第二处弱点：系统通知点击与 Dock 激活后定位最新待确认项，须验证应用处于隐藏、最小化、已退出窗口但进程存活等路径。
- 第三处弱点：Dock 角标只适用于 macOS；必须确保 Windows 自绘浮窗和其他平台路径不受影响。

## 第 2 层：规格【机｜人工可跳过】

### F-1～F-5：事实卡

| ID | 已核事实 | 复现方式 / 证据 |
|---|---|---|
| F-1 | 用户确认请求经 `wrapNotify()` 调用 `FloatingNotificationManager.onConfirmRequest()`；若主窗口不可见、最小化或未聚焦，管理器会触发自动浮窗。 | `rg -n "case 'confirm-request'|onConfirmRequest|ensureFloatingWindow" electron/runtime/invocationAssembler.ts electron/floatingNotificationManager.ts` |
| F-2 | 浮窗构造选项包含 `alwaysOnTop: true`、`focusable: false`；创建后调用 `setAlwaysOnTop(true, 'floating')`。 | `rg -n "alwaysOnTop|focusable|setAlwaysOnTop" electron/floatingNotification.ts` |
| F-3 | `ready-to-show` 回调调用 `win.show()` 后立即 `win.moveTop()`；通知 IPC 就绪时，管理器也会调用 `moveTop()`，不可见时调用 `show()`。 | `rg -n "\.show\(|moveTop" electron/floatingNotification.ts electron/floatingNotificationManager.ts` |
| F-4 | 管理器对主窗口 blur 延迟 2 秒再显示浮窗；主窗口聚焦会关闭浮窗。 | `rg -n "onMainWindowBlur|2000|onMainWindowFocus" electron/floatingNotificationManager.ts electron/main.ts` |
| F-5 | Electron 官方 API 文档定义 `show()` 为“显示并给予焦点”、`showInactive()` 为“显示但不聚焦”；`moveTop()` 将窗口移到 z-order 顶部且不依赖焦点。`focusable: false` 是单独的窗口可聚焦属性，不能抵消主动置顶。 | [BrowserWindow API：show / showInactive / moveTop / focusable](https://www.electronjs.org/docs/latest/api/browser-window) |

**核验结论：** 强制覆盖其他窗口已经由代码与 API 契约确认。`show()` 是主动请求焦点的 API，因此当前实现确实存在焦点干扰路径；但是窗口同时设为 `focusable: false`，且本次 macOS 原生窗口隔离探测未得到有效输出，不能把“macOS 应用一定被激活、键盘第一响应者一定切走”写成已实测事实。现有测试验证的是调用决策，不是 macOS WindowServer 行为。

### 绕过通道清单

- 主界面自身显示与聚焦：启动时 `electron/main.ts` 的 `win.show()` / `win.focus()`；用户点击通知返回主界面时 `electron/ipc/desktopIpc.ts` 的 `show()` / `restore()` / `focus()`。这些是启动或明确点击路径，不属于确认请求自动提醒路径。
- 测试通知：`showTestNotification()` 会复用浮窗创建与同步逻辑；切换后须移除或改为显式测试系统通知，不能残留置顶浮窗入口。
- 飞书 / 微信远程确认通过 IM 消息处理，不经过此桌面浮窗链路。

### INV-1～INV-3：不变量

- **INV-1：** 自动提醒显示不得改变用户当前键盘输入目标，也不得自动将 SpaceAssistant 激活到前台。
- **INV-2：** 提醒呈现失败、权限关闭或提醒被遮挡时，待确认授权状态与现有确认超时行为保持原样；提醒不能批准或执行工具。
- **INV-3：** 只有用户明确点击提醒 / 应用入口时，才允许恢复并聚焦主窗口。

### 状态与所有权

| 状态 | 唯一 writer | 提交点 | 恢复 / 清理 |
|---|---|---|---|
| 待确认项目集合 | `FloatingNotificationManager` | `onConfirmRequest` / `onToolResult` / `onAllCancelledForRequest` | 确认结果、取消、超时事件清除；进程退出清理通知资源 |
| macOS 系统通知实例 | `FloatingNotificationManager` | 待确认项从 0 变为非 0 时创建一次 | 点击 / 关闭 / 待确认项清空时关闭；同一批待确认持续期间不重复弹通知 |
| macOS Dock 角标 | `FloatingNotificationManager` | 每次待确认集合变化后更新为当前数量 | 数量归零时设置为空字符串；非 macOS 不调用 Dock API |

### AC-1～AC-4：验收映射

| 验收 | 可执行断言 | 证据类型 |
|---|---|---|
| AC-1 自动提醒不抢焦点 | macOS 通知创建路径不调用 `BrowserWindow.show/focus` 或 `app.focus`；确认请求到达时前台应用与键盘目标保持不变。 | 单测 + macOS 原生验收 |
| AC-2 提醒状态正确 | macOS 待确认数变化时 Dock 角标等于待确认项数量，清空后角标为空；同一批待确认只创建一条系统通知。Windows 现有自绘浮窗行为保持不变。 | 单测 + macOS 原生验收；Windows 实机回归为非阻断补充项 |
| AC-3 用户主动返回后可处理 | 点击系统通知后主窗口恢复 / 聚焦并导航到最新待确认会话；点击 Dock 图标按既有激活行为打开应用；确认卡仍由现有确认 IPC 完成。 | 现有导航测试 + 手动验收 |
| AC-4 不影响授权与清理 | 通知不支持、创建失败、重复提醒、并发待确认、确认完成、取消、超时和退出均不产生自动批准；待确认清空时通知与角标清理。 | 管理器边界测试 |

### 验收边界

当前环境可验证：管理器状态转换、系统通知创建 / 点击 / 关闭、Dock 角标计数与清理、macOS 自动提醒不创建浮窗，以及 Windows 旧行为未变的定向测试。
macOS 门禁验收：在实际 Electron 窗口确认前台应用名、键盘第一响应者、正在输入时焦点保持、系统通知权限 / 勿扰状态、真实通知点击返回路径、Dock 角标出现与清除。Windows 旧行为由自动化回归证明；Windows 实机回归可记录，但不阻断本方案验收。

P2 本机观察（2026-11-04）：用户授权后，在“系统设置 → 通知”开启 SpaceAssistant 通知；桌面、通知中心、锁定屏幕均已勾选，提醒样式为临时，应用图标标记开启。完整构建后，以隔离 userData 启动 arm64 worktree `.app`（`com.spaceassistant.app`），确认 `Notification.isSupported()` 为 true。通过当前 `FloatingNotificationManager` 实例创建真实 Electron 系统通知；macOS `usernoted` 日志记录其已投递至 alert / lock screen / notification center，并以 banner 呈现（14:05、14:12、14:14、14:39；21:05、21:06、21:09）。14:39 焦点实测时，系统设置搜索框处于键盘焦点；待确认到达前后 SpaceAssistant 主窗口均未聚焦，搜索框焦点仍保持。勿扰自动化显示为“09:00–17:00，关闭 - 每天”。

同一隔离运行中，Dock `setBadge` 由管理器按 1、2 项待确认状态调用，清空时置空；对真实 Electron Notification 实例触发 `click` 事件后，管理器在实际 Electron 主窗口上发送 `notification:navigate-session` 到最新待确认项。该事件由调试控制台触发。21:09 另由用户手动点击系统测试通知，用户确认主窗口已置前；此测试通知的点击回调只负责恢复 / 聚焦主窗口，不携带真实待确认项，因此最新会话定位仍只有事件处理级验证，未通过真实待确认横幅点击验收。随后在隔离实例中调用 Electron `app.dock.setBadge("2")`，用户目视确认 Dock 图标右上角显示红色数字 2；再调用 `setBadge("")` 已成功返回，等待用户确认数字已消失。Dock 图标标记已在系统设置启用。隔离实例目前仍运行，以便继续原生验收；Windows 实机回归未执行（当前主机为 macOS），Windows 自动化测试仍覆盖原自绘浮窗路径且不作门禁。

本轮执行了：

```text
node_modules/.bin/vitest run --project=electron electron/floatingNotification.test.ts electron/floatingNotificationManager.test.ts
```

结果：2 个测试文件、25 项测试通过（方案核验时）。该测试集 mock 了 Electron `BrowserWindow`，不证明系统级激活行为。隔离 Electron 探测当时未得到有效进程输出，记为未验证；实施后仍须完成 macOS 原生验收。

P1 实施验证：`npm exec vitest run --project=electron electron/pendingConfirmNotification.test.ts electron/floatingNotificationManager.test.ts electron/floatingNotification.test.ts` 通过（3 个测试文件、31 项测试）；`npx tsc -p tsconfig.electron.json --noEmit` 通过；`npm run build:electron:incremental` 与 `npm run build` 通过运行时闭包、session storage 边界 / 模块图、agent provider 构建及 TypeScript 编译门禁。macOS arm64 目录打包通过：`npm exec electron-builder -- --mac dir --arm64`（先运行 `npm run prepare:rg -- --target=darwin-arm64` 补齐该 worktree 缺失的 ripgrep staging）。

全量验收：`npm test` 通过，1,257 个测试文件通过、1 个跳过；12,171 项测试通过、140 项跳过（总计 12,311 项）。

### 阶段建议

| 阶段 | 内容 | 出口证据 | 可回退实体 |
|---|---|---|---|
| P1 实施 | 为 macOS 自动提醒接入系统通知、Dock 角标和点击导航；保留 Windows 浮窗及其 IPC / 资源。 | AC-1～AC-4 自动化测试通过，类型检查通过。 | 回退本阶段代码改动 |
| P2 平台验收 | macOS 原生确认焦点与通知 / Dock 体验；Windows 实机回归作为补充观察。 | 门禁按 AC 完成 macOS 手动记录，覆盖正在输入、权限关闭 / 勿扰、点击返回和角标清零；Windows 原行为由自动化回归覆盖，实机结果不作门禁。 | 回退 P1 代码改动 |

### 变更外扩与风险

- 新增 macOS 系统通知呈现行为；浮窗 IPC、预加载接口、共享数据类型和页面资源继续服务 Windows。无新增持久化字段、错误码、设置项或 agent-sdk / 会话存储接口。
- 不主动请求系统通知权限；通知不可用或被系统屏蔽时不自动激活窗口、不回退到置顶浮窗，Dock 角标和应用内待确认状态继续有效。
- Windows 自绘浮窗与其他平台行为不在本次改动范围；自动化回归证明既有 Windows 路径未变，Windows 实机回归不作为本方案门禁。

## 附录：术语

| 业务词 | 内部对应 |
|---|---|
| 待确认提醒 | macOS 操作系统通知；Windows 保留自绘浮窗，不具备授权能力 |
| 主动返回主界面 | 用户点击提醒后执行窗口恢复、聚焦和会话定位 |
| 激活应用 | macOS 前台应用切换；与 Electron BrowserWindow 是否可聚焦是不同层面的观察量 |
