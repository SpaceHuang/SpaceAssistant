# 文件内容查看器 — 后台自动刷新 — 需求规格

**版本：** 1.2  
**日期：** 2026-06-15  
**状态：** 待评审  
**关联文档：** [file-content-viewer-requirement.md](./file-content-viewer-requirement.md)、[content-viewer-url-support-requirement.md](./content-viewer-url-support-requirement.md)、[detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-06-15 | 初稿：Agent 写文件时查看器自动同步，含防抖与无闪烁刷新策略 |
| 1.1 | 2026-06-15 | §11 决议：D1–D4 已定；同步修订 §4.2.1、§4.4、§4.5、§6.2、§8、附录 |
| 1.2 | 2026-06-15 | §11 决议 D5：主进程只转发 watch 事件，debounce 仅在渲染侧 |

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [目标与非目标](#3-目标与非目标)
4. [功能需求](#4-功能需求)
5. [防抖与写入稳定性](#5-防抖与写入稳定性)
6. [无闪烁刷新策略](#6-无闪烁刷新策略)
7. [架构设计](#7-架构设计)
8. [交互规格](#8-交互规格)
9. [边界场景](#9-边界场景)
10. [验收标准](#10-验收标准)
11. [已决议事项](#11-已决议事项)

---

## 1. 概述

### 1.1 背景

用户在右侧 **文件内容查看器**（`FileOverlay` / `FileContentView`）中打开某文件后，若 Agent 通过 `write_file` / `edit_file` 等工具在后台修改该文件，查看器**不会自动更新**。用户只能依赖手动点击工具栏「刷新」，或关闭后重新打开，才能确认 Agent 声称的变更是否已落盘。

这与「Agent 改完即见」的预期不符，增加了核对成本，也削弱了用户对工具结果的信任感。

### 1.2 功能定位

为**本地文件预览模式**（`contentMode === 'file'`）增加 **后台自动同步**：当当前正在预览的文件在工作目录内被修改时，查看器在写入稳定后自动拉取最新内容并更新展示，**无需用户手动刷新**。

### 1.3 核心约束（来自产品诉求）

| # | 约束 | 说明 |
|---|------|------|
| C1 | **防抖** | Agent 连续写入或分段落盘时，避免查看区频繁整页刷新 |
| C2 | **低视觉干扰** | 刷新过程不应出现「关闭再打开」式的白底 / 全屏 Loading，尽量保持阅读连续性 |

---

## 2. 现状与问题

### 2.1 当前数据流

```text
用户打开文件
  → DetailPanelContext.loadFile(relPath)
  → window.api.fileReadFile(relPath)        // 一次性读取
  → previewContent / imageDataUrl 写入 state
  → FileContentView 按 fileType 渲染 CodeView / MarkdownRenderView / ImageView / WebView

Agent 写文件成功
  → toolChatLoop 调用 notifyFileTreeChanged({ kind: 'paths', relPaths: [rel] })
  → 渲染进程 fileTreeSyncBus（400ms 防抖）→ 仅刷新 FileTree 目录列表
  → 查看器 state **不受影响**
```

### 2.2 手动刷新路径及其问题

`refreshFile()` 复用 `loadFile(selectedFile, { preserveViewMode: true })`，但 `loadFile` **始终**执行：

```typescript
setIsLoading(true)   // → FileContentView 整区替换为 <Spin />
// ... 读取 ...
setIsLoading(false)
```

因此即使手动刷新，用户也会看到内容区被 Loading 占位替换，产生**白底闪烁**；自动刷新若直接复用该路径，问题会被放大（Agent 一次任务可能触发多次写入）。

### 2.3 已有可复用能力

| 能力 | 位置 | 与本需求关系 |
|------|------|--------------|
| 写文件后树同步事件 | `electron/toolChatLoop.ts` → `file:tree-changed` | 可作为「文件已变更」的主信号源 |
| 渲染侧事件防抖 | `src/renderer/services/fileTreeSyncBus.ts`（400ms） | 可复用或扩展为查看器专用总线 |
| 文件元数据 | `window.api.fileGetMetadata`（size、mtime、isText） | 用于变更检测与写入稳定性判断 |
| 静默保留视图模式 | `loadFile(..., { preserveViewMode: true })` | 自动刷新须默认启用 |
| 项目记忆热重载 | `electron/projectMemory.ts`（fs.watch + 500ms debounce） | 主进程单文件 watch 的参考实现 |
| WebView 软刷新 | `refreshPage()` / `WebViewController.reload()` | HTML 渲染模式应用软刷新而非 remount |

### 2.4 问题小结

| 问题 | 影响 |
|------|------|
| 无变更订阅 | Agent 改文件后查看器内容 stale |
| 刷新 = 全屏 Loading | 手动刷新仍有 Spin；**自动同步**须避免 |
| 树同步与内容预览脱节 | 用户看到树节点更新但内容不变，认知不一致 |
| Shiki / Markdown 全量重算 | 大文件自动刷新时 CPU 与滚动位置易丢失 |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 查看器打开某本地文件时，该文件被 Agent（或外部进程）修改并落盘后，**自动**展示最新内容 |
| G2 | 单次 Agent 写入过程（含多次 `edit_file` / 临时写盘）在查看器侧**合并为少量**（理想情况 1 次）可见更新 |
| G3 | 自动刷新时**不**出现全屏 Loading / 白底占位；旧内容保持可见直至新内容就绪 |
| G4 | 自动刷新后保持 Markdown/HTML 渲染模式、查找状态；滚动位置：非文末附近保持 scrollTop，距底 < 50px 时滚至文末 |
| G5 | 与现有 `file:tree-changed`、文件树刷新逻辑兼容，不重复造轮子 |

### 3.2 非目标

| 条目 | 说明 |
|------|------|
| 实时协作 / OT 级 diff 动画 | 不做逐字符同步，仅整文件（或整图）替换 |
| 查看器内编辑 | 仍只读；写操作继续由 Agent 工具完成 |
| 在线 URL 模式自动刷新 | `contentMode === 'url'` 不纳入本需求（用户自行 F5 / 工具栏刷新） |
| 跨 workDir 聚合 watch | 切换工作目录时停止旧 watch，仅跟踪当前 workDir |
| 文件树选中联动 | 树选中变化不触发内容重载（已有 `openFile` 行为不变） |

---

## 4. 功能需求

### 4.1 触发条件

满足以下**全部**条件时，进入自动同步流程：

1. `contentMode === 'file'` 且 `selectedFile != null`
2. 检测到 `selectedFile` 对应路径发生**内容变更**（见 §4.2）
3. 查看器处于打开状态（`FileOverlay` 可见）
4. 非用户主动触发的 `openFile` / `refreshFile` 加载过程中（避免与显式操作竞态）

### 4.2 变更检测（双通道）

采用 **事件驱动 + 元数据校验** 组合，保证 Agent 写入与外部编辑均可覆盖。

#### 4.2.1 通道 A：Agent / 工具链事件（主路径）

- 订阅现有 `file:tree-changed` IPC（经 `fileTreeSyncBus` 或同级封装）。
- 当 `event.kind === 'paths'` 且 `relPaths` 中包含**当前 `selectedFile` 的规范化相对路径**时，标记该文件「待同步」。
- 当 `event.kind === 'refreshExpanded'`（如 `run_shell` 后粗粒度刷新）时：**不**直接重载查看器；在 debounce 窗口结束后对 `selectedFile` 做一次 `mtime` 比对，**仅在实际变化时**同步（避免无意义读取，同时覆盖 shell 修改当前文件的场景）。

> 说明：`write_file` / `edit_file` 成功时主进程已发送精确 `relPaths`，应优先依赖此通道，延迟低、路径准确。

#### 4.2.2 通道 B：当前打开文件的 fs.watch（补充路径）

- 当 `selectedFile` 设定或变更时，主进程对该文件建立 **单文件 watch**（参考 `projectMemory.ts`）；关闭文件或切换 workDir 时释放。
- watch 触发 `change` 事件后，**主进程不做 debounce**，立即向渲染进程推送 `file:content-changed`（新 IPC，payload：`{ relPath }`）；防抖与 settle 统一在渲染侧 `fileContentSyncBus` 处理（见 §5、§11 D5）。
- 用于覆盖：外部编辑器保存、Agent 通过 shell 修改、以及未来未走 `notifyFileTreeChanged` 的写入路径。

#### 4.2.3 变更确认

防抖窗口结束、准备读取前，调用 `fileGetMetadata(selectedFile)`：

- 若 `mtime`（及必要时 `size`）与上次成功加载时记录的值相同 → **跳过**读取（去重）。
- 若文件不存在 → 进入 §9.2 删除态。
- 若 `size > MAX_FILE_READ_SIZE` → 进入 §9.3 过大态。

### 4.3 同步行为

| 文件类型 | 自动同步方式 |
|----------|--------------|
| 文本 / 代码（CodeView） | 静默 `fileReadFile` → 更新 `previewContent` |
| Markdown 代码模式 | 同 CodeView |
| Markdown 渲染模式 | 同左；更新 `previewContent` 后 `MarkdownRenderView` 重渲染 |
| 图片 | 静默读取 → 更新 `imageDataUrl` |
| HTML 渲染模式（WebView） | 调用 `refreshPage()` 软刷新 WebView，**不** remount `FileOverlay` |
| HTML 代码模式 | 同文本 |
| 不支持 / 过大 | 按读取结果切换至对应当前错误态（见边界场景） |

### 4.4 与用户手动操作的关系

| 操作 | 行为 |
|------|------|
| 用户点击工具栏「刷新」 | **保持现有行为**：`isLoading=true` 全屏 Loading + Toast「已刷新」；不改为静默路径 |
| 用户切换 Markdown 渲染/代码 | 不触发额外同步；若期间有 pending 同步，完成后保留用户所选 `viewMode` |
| 用户关闭查看器 | 立即停止 watch 与 pending debounce |
| 用户打开另一文件 | 取消旧文件 watch / pending，对新文件建立 watch |

### 4.5 反馈策略（已决议：完全静默）

自动同步**完全静默**：

- 无 Modal、无 Toast、无工具栏文案、无进度条
- **禁止**使用全屏 `Spin` 作为自动同步反馈

手动刷新仍保留 Toast「已刷新」（见 §4.4）。

---

## 5. 防抖与写入稳定性

### 5.1 设计目标

Agent 写大文件或连续 `edit_file` 时，磁盘可能在短时间内多次 `change`；需在「尽快看到结果」与「少刷新几次」之间折中。

### 5.2 防抖参数

| 参数 | 建议值 | 说明 |
|------|--------|------|
| `DEBOUNCE_MS` | **500ms** | 与 `projectMemory` 一致；略高于 fileTreeSyncBus 的 400ms，使树与内容略同步 |
| `SETTLE_MS` | **300ms** | 防抖结束后再等待 mtime 连续不变的最短时间（写入稳定窗口） |
| 最大等待 | **5s** | 自首次标记待同步起，超过则强制尝试一次读取，避免极端慢写永不更新 |

同一 `selectedFile` 在 debounce 窗口内的多次事件**合并为一次**同步任务。

### 5.3 写入稳定（Settle）算法

```text
onChange(selectedFile):
  pending = true
  reset debounce timer (500ms)

onDebounceFire:
  loop:
    meta = fileGetMetadata(selectedFile)
    if meta.mtime == lastLoadedMtime: return   // 已被其他路径更新或误报
    wait SETTLE_MS
    meta2 = fileGetMetadata(selectedFile)
    if meta2.mtime == meta.mtime: break         // 稳定
    meta = meta2
    if elapsed > MAX_WAIT: break
  silentReload(selectedFile)
  lastLoadedMtime = meta.mtime
```

说明：

- 对**小文件单次 write**，settle 仅增加约 300ms 延迟，可接受。
- 对**流式/分段写**，mtime 持续变化会延长等待直至 `MAX_WAIT`，避免半写入内容展示。

### 5.4 与 fileTreeSyncBus 的关系

| 方案 | 描述 | 建议 |
|------|------|------|
| A. 独立总线 | 新建 `fileContentSyncBus`，独立 debounce/settle | **推荐**：职责清晰，参数可不同于树刷新 |
| B. 扩展 fileTreeSyncBus | 同一 enqueue，查看器过滤 `selectedFile` | 实现快，但树刷新 400ms 与内容 500ms+settle 耦合 |

---

## 6. 无闪烁刷新策略

### 6.1 加载态分离

在 `DetailPanelContext` 中区分两类加载：

| 类型 | 触发 | `isLoading` | UI 表现 |
|------|------|-------------|---------|
| **初始加载** | `openFile` 首次打开 | `true` | 允许现有全区 `Spin`（打开新文件时尚未有过内容） |
| **后台同步** | 自动刷新 | **`false`** | 保留当前 `previewContent` / WebView 画面直至新数据就绪 |

新增内部方法建议：`silentReloadFile(relPath)`，**不得** `setIsLoading(true)`。

### 6.2 各渲染器策略

#### 6.2.1 CodeView（含 Shiki 高亮）

| 策略 | 说明 |
|------|------|
| 保留旧内容 | 新 `content` 到达前继续渲染旧 HTML / 纯文本 |
| 异步高亮 | Shiki 重新 highlight 完成后一次性替换 `dangerouslySetInnerHTML` |
| 降级 | 高亮计算期间可短暂显示无高亮纯文本（现有逻辑），但**容器不卸载** |
| 滚动 | 同步前记录 `scrollTop` 及「距底部距离」；更新后：若同步前距底部 **< 50px** → **滚到底部**（便于跟进 Agent 追加内容）；否则恢复原 `scrollTop` |

#### 6.2.2 MarkdownRenderView

- 更新 `content` prop 触发重渲染，**不**卸载 `MarkdownSearchScope` 外层。
- 滚动策略同 §6.2.1：距底 < 50px 则滚底，否则 `requestAnimationFrame` 恢复原 `scrollTop`。
- Wiki 索引视图（`WikiIndexView`）同样适用该滚动策略。

#### 6.2.3 ImageView

- 新 `dataUrl` 生成后再替换 `<img src>`；旧图保持显示至替换瞬间，避免空白。

#### 6.2.4 HTML WebView 渲染模式

- 使用 `refreshPage()` / `webViewController.reload()`。
- **禁止**为同步而 `setLocalFileViewerUrl(null)` 或 remount `WebView` 组件（会导致白屏）。
- `isWebViewLoading` 可在 WebView 内展示细条进度，但 `FileContentView` 不应退回全屏 Spin。

#### 6.2.5 查找 / 搜索面板

- 若详情栏查找面板打开且 query 非空：同步后**重新执行**当前搜索（已有 adapter 能力），并保持 `currentHighlightIndex` 尽量不变（若 match 数变化则 clamp）。

### 6.3 需避免的反模式

| 反模式 | 后果 |
|--------|------|
| 自动同步走 `loadFile` 且 `isLoading=true` | 全屏 Spin，白底闪烁 |
| 同步时 `resetState` / 关闭 overlay | 工具栏与布局重建 |
| 每次同步变更 `selectedFile` 引用触发 key remount | React 子树重建 |
| HTML 模式通过重新 `fileToViewerUrl` 换 URL 触发导航 | WebView 白屏时间长 |

---

## 7. 架构设计

### 7.1 组件职责

```text
┌─ 主进程 ─────────────────────────────────────────────────────┐
│ toolChatLoop / 其他写入路径                                     │
│   └─ notifyFileTreeChanged (已有)                               │
│ fileContentWatcher (新，与 projectMemory 模式一致)              │
│   └─ watch(selectedAbsPath) → 立即 send file:content-changed    │
│ IPC: file:get-metadata, file:read-file (已有)                   │
└────────────────────────────────────────────────────────────────┘
                              │ IPC
┌─ 渲染进程 ─────────────────────────────────────────────────────┐
│ fileContentSyncBus (新)                                         │
│   ├─ 订阅 file:tree-changed（过滤 selectedFile）               │
│   ├─ 订阅 file:content-changed                                │
│   └─ debounce + settle → 回调                                   │
│ DetailPanelContext                                              │
│   ├─ lastLoadedMtime / lastLoadedSize                           │
│   ├─ silentReloadFile()                                         │
│   └─ useEffect: selectedFile 变化 → 主进程 start/stop watch     │
│ FileContentView / CodeView / MarkdownRenderView (滚动恢复)      │
└────────────────────────────────────────────────────────────────┘
```

### 7.2 新增 / 变更 API（建议）

| API | 方向 | 说明 |
|-----|------|------|
| `file:watch-content` | invoke | 参数 `{ relPath \| null }`；null 表示停止 watch |
| `file:content-changed` | 主→渲染 push | `{ relPath: string }` |
| `fileWatchContent` / `fileOnContentChanged` | preload 暴露 | 与上对应 |

渲染侧 **不强制** 新增 read API；继续复用 `fileReadFile` + `fileGetMetadata`。

### 7.3 状态字段（DetailPanelContext 扩展）

| 字段 | 类型 | 说明 |
|------|------|------|
| `lastLoadedMtime` | `number \| null` | 上次成功加载的 mtime，用于去重 |
| `isBackgroundSyncing` | `boolean` | 可选；内部状态 / 测试断言用，**不**驱动任何 UI 反馈 |

### 7.4 与 workDir 切换

- `workDir` 变更时：主进程停止所有 content watch；渲染进程 `resetState` 时清除 sync 状态（现有逻辑已关闭预览）。

---

## 8. 交互规格

### 8.1 用户可见行为

| 场景 | 预期体验 |
|------|----------|
| 正在看 `foo.ts`，Agent 修改 `foo.ts` | 约 0.5–1s 后内容悄然更新，滚动位置大致保持，无白屏 |
| 正在看 `foo.ts`，Agent 修改 `bar.ts` | 查看器不变；仅文件树对应目录刷新 |
| Agent 连续 5 次 edit 同一文件 | 查看器更新 1–2 次，非 5 次闪烁 |
| 用户正在滚动阅读（非底部） | 更新后视口不跳到顶部，保持原 scrollTop |
| 用户已滚至文末附近（距底 < 50px） | 自动同步后滚到底部，展示 Agent 追加内容 |
| 文件被删 | 内容区显示错误态（见 §9.2），非空白 overlay |

### 8.2 键盘与工具栏

- 现有 `F5` / 刷新按钮：**保持现有行为**（`isLoading=true` + Toast「已刷新」），本需求不改造手动刷新路径。
- 无新增快捷键。

### 8.3 i18n

自动同步无 UI 文案。§9 错误态若需新增 key，须走 `detailPanel` 命名空间，例如：

- `detailPanel.fileView.fileDeleted` — 「文件已被删除或移动」

---

## 9. 边界场景

### 9.1 读取失败（权限、临时锁）

- 保留当前已展示内容。
- 可选：工具栏下方一次性 warning，不打断阅读。
- 日志写入 Agent 日志（不含文件正文）。

### 9.2 文件被删除

- 同步时 `fileReadFile` 或 `stat` 失败且 errno 为 ENOENT。
- 展示错误态：`fileDeleted` 文案 + 保留路径在工具栏。
- 停止对该路径的 watch。

### 9.3 文件变为过大

- 读取返回 `kind: 'too_large'`。
- 切换至现有「文件过大」UI；清除 `previewContent`。
- 停止自动同步直至用户重新打开或手动刷新。

### 9.4 打开文件与同步竞态

- `openFile(A)` 执行期间忽略 A 的自动同步事件。
- `openFile` 完成后写入 `lastLoadedMtime`，再启用 watch。

### 9.5 二进制 / unsupported

- 若从文本变为 unsupported：按 `applyReadResult` 切换 UI。
- unsupported 类型不建立 content watch（无意义）。

### 9.6 HTML 本地预览

- 依赖 WebView reload；若 reload 失败，展示 `webViewError`，保留工具栏刷新能力。

---

## 10. 验收标准

### 10.1 功能

- [ ] 打开 `test.md`，Agent `write_file` 修改同一文件，**无需手动操作**，10s 内查看器显示新内容。
- [ ] 打开 `a.ts`，Agent 修改 `b.ts`，查看器内容不变。
- [ ] Agent 对同一文件连续 3 次 `edit_file`（间隔 < 300ms），查看器完整刷新次数 ≤ 2。
- [ ] 外部编辑器保存当前打开文件，查看器在 settle 后自动更新（验证 fs.watch 通道）。
- [ ] 关闭查看器后，对该文件的写入**不再**触发读取（无多余 IPC）。

### 10.2 体验与性能

- [ ] 自动同步全程**不出现** `FileContentView` 全屏 `Spin`（`isLoading` 保持 false）。
- [ ] 自动同步前后，内容区背景色连续，**无**整页白底闪烁（人工目测 + 录屏评审）。
- [ ] 1000 行以内文本文件、用户未在文末附近时，自动同步后滚动位置偏差 ≤ 2 行。
- [ ] 用户距底部 < 50px 时自动同步，视口滚至文末（可见最新追加内容）。
- [ ] Markdown 渲染模式下，同步后仍停留在渲染模式。

### 10.3 回归

- [ ] 手动「刷新」仍可用，且**仍显示**全屏 Loading + Toast（与自动同步路径区分）；`openFile` 首次打开仍有 Loading。
- [ ] 文件树 `file:tree-changed` 刷新行为无回归。
- [ ] HTML WebView / URL 模式行为符合 §3.2 非目标，不误触发文件 read。

### 10.4 测试

- [ ] 单元测试：`fileContentSyncBus` debounce/settle 合并逻辑。
- [ ] 单元测试：`silentReloadFile` 不置 `isLoading`。
- [ ] 组件测试：mock `file:tree-changed` 后 `previewContent` 更新且 `isLoading === false`。

---

## 11. 已决议事项

| # | 问题 | 决议 | 说明 |
|---|------|------|------|
| D1 | Agent 追加写入时是否自动滚到底部 | **B. 距底近则滚底** | 同步前距底部 < 50px 时，更新后滚至文末；否则保持 scrollTop |
| D2 | 自动同步是否显示 Toast | **A. 完全静默** | 无 Toast、无工具栏提示、无进度条 |
| D3 | `refreshExpanded` 是否对 selectedFile 做 mtime 探测 | **B. 探测** | debounce 结束后比对 mtime，有变化才同步 |
| D4 | 手动刷新是否改为静默路径 | **A. 保持 Loading** | 手动刷新继续 `isLoading=true` + Toast，与自动同步分离 |
| D5 | 主进程 watch 与渲染 debounce 是否合并 | **A. 仅渲染 debounce** | 主进程 `fs.watch` 收到 `change` 后立即 push；500ms debounce + settle 仅在 `fileContentSyncBus` |

---

## 附录：手动刷新与自动同步的行为对比

| 维度 | 手动 `refreshFile`（保持现状） | 自动同步（本需求） |
|------|-------------------------------|-------------------|
| 触发 | 用户点击 / F5 | 文件变更事件 |
| `isLoading` | **true**（全屏 Spin） | **false**（静默） |
| Toast | 「已刷新」 | 无 |
| 滚动 | 刷新后回到顶部（现状） | 距底 < 50px 滚底，否则保 scrollTop |
| `preserveViewMode` | true | true |
| HTML 渲染 | `refreshPage()` | 同左 |

实现时建议抽取 **`reloadFileContent({ silent: boolean })`**：`silent: false` 供手动刷新，`silent: true` 供自动同步，共享读取与 state 更新逻辑，仅区分 Loading / Toast / 滚动策略。
