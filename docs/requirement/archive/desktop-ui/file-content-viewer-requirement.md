# 文件内容查看器 — 需求规格

**版本：** 1.1
**日期：** 2026-05-16
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

文件内容查看器是用户在详情面板（右侧栏）**只读预览**文件内容的核心组件。通过文件树点击或消息卡片触发，在右侧栏展示文件内容，支持多种文件类型的预览、语法高亮、查找等功能。

> **功能边界说明：** 查看器不承担内容修改职责。文件内容的增删改统一由 AI 助手通过工具调用完成；用户在查看器中仅需浏览、定位与核对内容。

### 1.2 目标

将当前简陋的文本预览升级为功能完善的文件内容查看器，提供与 VS Code 相近的文件预览体验。

---

## 2. 现状分析

### 2.1 现有实现

当前实现位于 `src/renderer/App.tsx`：

```tsx
const [filePreview, setFilePreview] = useState('')
const handleFileSelect = async (relPath: string) => {
  const r = await window.api.fileReadFile(relPath)
  setFilePreview(r.content.slice(0, 4000))  // 限制 4000 字符
}
```

右侧栏渲染：

```tsx
<Layout.Sider width={240} theme="light" ...>
  {filePreview ? (
    <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{filePreview}</div>
  ) : (
    <Text type="secondary">右侧栏预留（功能开发中）</Text>
  )}
</Layout.Sider>
```

### 2.2 现有能力

| 功能 | 状态 | 说明 |
|------|------|------|
| 文件读取 | ✅ 已实现 | 通过 `window.api.fileReadFile` |
| 基础文本展示 | ✅ 已实现 | 简单 pre-wrap 渲染 |
| 文件大小限制 | ✅ 已实现 | 4000 字符硬限制 |
| 打开入口 | ✅ 已实现 | FileTree.onFileSelect 回调 |

### 2.3 缺失能力

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 语法高亮 | 高 | 未集成 Shiki |
| Markdown 渲染 | 高 | 无代码/渲染双模式 |
| 工具栏 | 高 | 无 FileToolbar 组件 |
| 查找 | 中 | 无搜索面板 |
| 图片预览 | 中 | 未实现 |
| 文件导出 | 低 | 未实现 |
| 用默认编辑器打开 | 低 | 未实现 |

---

## 3. 功能需求

### 3.1 文件打开入口

#### 3.1.1 文件树触发

| 属性 | 说明 |
|------|------|
| 位置 | 左侧工作区面板的「文件」标签页 |
| 入口组件 | `FileTree.tsx` |
| 触发方式 | 点击文件树中的文件节点 |
| 回调链 | `FileTree.onFileSelect(relPath)` → 右侧栏显示内容 |

#### 3.1.2 消息文件卡片触发（预留）

| 属性 | 说明 |
|------|------|
| 位置 | 聊天消息区域的消息卡片 |
| 触发方式 | 点击消息中显示的文件卡片按钮 |
| 状态 | 首期可先不实现，占位即可 |

#### 3.1.3 状态管理

- **状态定义**：`selectedFile: string | null`，存储当前打开文件的相对路径
- **状态共享**：通过 React Context 或 Redux 管理
- **关闭文件**：点击关闭按钮或按 Escape 键，清除选中状态

---

### 3.2 工具栏功能

#### 3.2.1 工具栏组成

| 按钮 | 图标 | Tooltip | 功能说明 | 优先级 |
|------|------|---------|----------|--------|
| 视图切换 | 文字按钮 | 渲染/代码 | Markdown 文件的代码模式与渲染模式切换 | 高 |
| 用默认编辑器打开 | `external_link_line` | 用默认编辑器打开 | 调用系统默认应用打开当前文件 | 中 |
| 查看所在目录 | `folder_open_line` | 查看所在目录 | 在文件资源管理器中打开并高亮文件 | 中 |
| 刷新 | `refresh_1_line` | 刷新 | 重新读取文件内容 | 高 |
| 导出为... | `export_line` | 导出为... | 仅 Markdown 文件显示，支持导出 PDF | 低 |
| 关闭 | `close_line` | 关闭 | 关闭文件查看，返回占位符状态 | 高 |

#### 3.2.2 工具栏样式

- **高度**：36px
- **布局**：flex 布局，视图切换按钮居左，其余按钮居右
- **按钮尺寸**：28×28px，圆角 6px
- **背景**：与面板背景一致，底部边框分隔

---

### 3.3 内容查看功能

#### 3.3.1 文件类型支持

| 类型 | 支持后缀 | 处理方式 | 优先级 |
|------|----------|----------|--------|
| 纯文本 | `.txt`, `.log`, `.csv`, `.tsv` | 直接读取渲染 | 高 |
| Markdown | `.md`, `.mdx`, `.rst` | 支持代码/渲染双模式 | 高 |
| Web 代码 | `.html`, `.css`, `.scss`, `.js`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte` | 语法高亮 | 高 |
| 后端代码 | `.py`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.cs`, `.cpp`, `.c` | 语法高亮 | 高 |
| 脚本 | `.sh`, `.bash`, `.ps1`, `.bat`, `.cmd` | 语法高亮 | 中 |
| 配置/数据 | `.json`, `.jsonc`, `.yaml`, `.yml`, `.toml`, `.ini`, `.xml` | 语法高亮 | 高 |
| 图片 | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`, `.ico` | 图片渲染 | 中 |
| 不支持 | `.pdf`, `.doc`, `.zip`, `.exe`, `.dll` 等 | 显示占位提示 | 中 |

#### 3.3.2 文本类文件查看

- **自动换行**：支持 `white-space: pre-wrap`，`word-break: break-all`
- **行号显示**：代码模式下左侧显示行号，不可选中，与代码垂直对齐
- **内容滚动**：支持垂直和水平方向滚动
- **文件大小限制**：2 MB，超出显示"文件过大"提示

#### 3.3.3 图片类文件查看

- **图片渲染**：使用 `<img>` 标签内嵌预览
- **SVG 处理**：作为图片渲染
- **无后缀文件**：尝试当文本读取

---

### 3.4 代码高亮能力

#### 3.4.1 技术方案

采用 **Shiki** 作为语法高亮引擎：

- **主题支持**：默认使用 `light-plus`（VS Code 默认浅色主题）
- **语言覆盖**：TypeScript、JavaScript、Python、Go、Rust、Java、CSS、HTML、JSON、YAML、Markdown、Bash、SQL 等
- **实例复用**：模块级别缓存，同一应用生命周期内只初始化一次

#### 3.4.2 集成要点

- **异步初始化**：应用启动时预初始化，避免阻塞 UI
- **降级处理**：高亮失败时静默回退到纯文本显示
- **行号集成**：行号与高亮代码并排显示，保持视觉一致性

---

### 3.5 查找需求

#### 3.5.1 查找功能

- **快捷键**：`Ctrl+F` 打开查找面板
- **实时搜索**：输入时即时高亮匹配项
- **搜索选项**：
  - `Aa` 大小写匹配（`Alt+C`）
  - `W` 整词匹配（`Alt+W`）
  - `.*` 正则表达式（`Alt+R`）
- **结果导航**：上一个/下一个，环形循环，自动滚动居中
- **匹配计数**：显示当前项/总数（如 `3 / 12`）

#### 3.5.2 不提供替换功能（设计决策）

**决策：** 文件内容查看器不提供查找替换、就地编辑或写回磁盘能力。

**原因：** 明确查看器的功能定位为**只读预览与内容定位**，避免与 IDE/编辑器职责重叠。内容修改统一由 AI 助手完成——用户通过对话描述修改意图，AI 调用文件读写工具执行变更，用户在查看器中刷新或重新打开文件即可核对结果。

**因此明确排除：**

| 排除项 | 说明 |
|--------|------|
| 替换面板 | 不提供 `Ctrl+H` 快捷键及「替换为 / 替换 / 全部」等 UI |
| 内容写回 | 不提供 `setPreviewContent` 等修改预览内容的对外 API |
| 就地编辑 | 代码区、渲染区均不可编辑 |

> 若后续确有批量文本替换需求，应通过 AI 对话或独立编辑工具完成，而非在查看器内实现。

#### 3.5.3 面板交互

- **关闭方式**：`Escape` 键或点击关闭按钮
- **高亮样式**：黄色背景高亮所有命中项，橙色背景标记当前项
- **错误处理**：正则表达式非法时显示红色边框和错误提示

---

### 3.6 Markdown 文件支持

#### 3.6.1 渲染切换

支持三种视图模式：

| 模式 | 说明 | 触发方式 |
|------|------|----------|
| 代码模式 | 显示原始文本，带行号和语法高亮 | 默认进入，或点击「代码」按钮 |
| 渲染模式 | Markdown 渲染预览 | 点击「渲染」按钮 |

**切换按钮特点：**
- 仅 Markdown 文件显示
- 显示目标模式名称（当前代码→显示"渲染"，当前渲染→显示"代码"）
- 模式状态不持久化，每次打开新文件默认进入代码模式

#### 3.6.2 Markdown 文件导出（低优先级）

支持导出为 PDF：

| 格式 | 实现方式 | 特点 |
|------|----------|------|
| PDF | Electron `webContents.printToPDF()` | 渲染结果与预览完全一致，含代码高亮 |

---

## 4. 架构设计

### 4.1 目标架构

```
DetailPanel（详情面板容器）
└── FileOverlay（文件浮层，selectedFile 非空时显示）
    ├── FileToolbar（工具栏）
    └── FileContentView（文件内容查看区）
        ├── 代码模式（行号 + 语法高亮）
        └── 渲染模式（Markdown 渲染）
```

### 4.2 组件划分

| 组件 | 文件路径 | 职责 |
|------|----------|------|
| DetailPanel | `src/renderer/components/DetailPanel/index.tsx` | 详情面板容器，状态管理 |
| FileOverlay | `src/renderer/components/DetailPanel/FileOverlay.tsx` | 文件浮层，条件渲染 |
| FileToolbar | `src/renderer/components/DetailPanel/FileToolbar.tsx` | 工具栏按钮组 |
| FileContentView | `src/renderer/components/DetailPanel/FileContentView.tsx` | 文件内容主视图 |
| SearchPanel | `src/renderer/components/DetailPanel/SearchPanel.tsx` | 查找面板（只读高亮，不支持替换） |
| shikiHighlighter | `src/renderer/utils/shikiHighlighter.ts` | Shiki 语法高亮封装 |

### 4.3 状态管理

通过 React Context `DetailPanelContext` 管理：

```typescript
interface DetailPanelState {
  selectedFile: string | null  // 当前打开的文件相对路径
  fileContent: string | null    // 文件内容
  fileType: FileType | null     // 文件类型
  viewMode: 'code' | 'render'   // Markdown 视图模式
  isLoading: boolean            // 加载状态
}

interface DetailPanelActions {
  openFile: (relPath: string) => Promise<void>
  closeFile: () => void
  refreshFile: () => Promise<void>
  setViewMode: (mode: 'code' | 'render') => void
}
```

---

## 5. 组件规格

### 5.1 DetailPanel

| 属性 | 类型 | 说明 |
|------|------|------|
| 无 props | - | 通过 Context 获取状态 |

**渲染逻辑：**
- `selectedFile` 为 `null` → 显示占位符"右侧栏预留（功能开发中）"
- `selectedFile` 非空 → 渲染 `FileOverlay`

### 5.2 FileToolbar

| 属性 | 类型 | 说明 |
|------|------|------|
| filePath | `string` | 当前文件相对路径 |
| fileType | `FileType` | 文件类型 |
| viewMode | `'code' \| 'render'` | 当前视图模式 |
| onViewModeChange | `(mode: 'code' \| 'render') => void` | 视图切换回调 |
| onClose | `() => void` | 关闭文件回调 |
| onRefresh | `() => void` | 刷新文件回调 |
| onExport | `(format: 'pdf') => void` | 导出回调 |

### 5.3 FileContentView

| 属性 | 类型 | 说明 |
|------|------|------|
| content | `string` | 文件内容 |
| fileType | `FileType` | 文件类型 |
| viewMode | `'code' \| 'render'` | 视图模式 |

**渲染规则：**
- `fileType === 'markdown'` 且 `viewMode === 'render'` → Markdown 渲染
- 其他情况 → 代码模式（带语法高亮和行号）

### 5.4 SearchPanel

| 属性 | 类型 | 说明 |
|------|------|------|
| open | `boolean` | 是否显示查找面板 |
| onClose | `() => void` | 关闭回调 |
| onHighlightsChange | `(matches, index) => void` | 高亮匹配项变化回调 |

**快捷键：**
- `Ctrl+F` - 打开查找
- `Escape` - 关闭面板

**不提供：** `Ctrl+H` 替换面板、替换输入框、单个/全部替换操作。

---

## 6. 交互规格

### 6.1 文件打开流程

```
用户点击 FileTree 中的文件
  → handleFileSelect(relPath) 执行
  → DetailPanelContext.openFile(relPath) 调用
  → fileReadFile IPC 获取内容
  → selectedFile, fileContent, fileType 状态更新
  → FileOverlay 渲染文件内容
```

### 6.2 文件关闭流程

```
用户点击关闭按钮
  → DetailPanelContext.closeFile() 调用
  → selectedFile, fileContent, fileType 置空
  → 显示占位符状态
```

### 6.3 快捷键映射

| 快捷键 | 功能 | 作用域 |
|--------|------|--------|
| `Ctrl+F` | 打开查找面板 | FileContentView 聚焦时 |
| `Escape` | 关闭面板/退出搜索 | SearchPanel 打开时 |
| `Ctrl+W` | 关闭文件 | FileOverlay 聚焦时 |

---

## 7. 后端 API 需求

### 7.1 现有 API

| API | 说明 |
|-----|------|
| `file:read-file` | 读取文件内容 |

### 7.2 新增 API

| API | 说明 | 优先级 |
|-----|------|--------|
| `file:get-metadata` | 获取文件元数据（大小、修改时间等） | 低 |
| `file:open-in-system` | 调用系统默认应用打开文件 | 中 |
| `file:show-in-explorer` | 在文件资源管理器中显示并高亮文件 | 中 |
| `file:export-pdf` | 将 Markdown 导出为 PDF | 低 |

### 7.3 API 响应格式

#### file:get-metadata

```typescript
interface FileMetadata {
  size: number        // 文件大小（字节）
  mtime: number       // 修改时间（Unix timestamp）
  isText: boolean     // 是否可作为文本读取
}
```

---

## 8. 验收标准

### 8.1 功能验收

| 功能 | 验收条件 |
|------|----------|
| 文件打开 | 点击文件树中的文件，右侧栏正确显示文件内容 |
| 文本文件 | .txt, .log, .csv 等纯文本正确显示 |
| 代码高亮 | .ts, .js, .py 等代码文件正确高亮显示 |
| Markdown | 支持代码模式和渲染模式切换 |
| 行号显示 | 代码模式下左侧显示行号，与内容对齐 |
| 图片预览 | .png, .jpg, .svg 等图片正确显示 |
| 查找功能 | Ctrl+F 打开查找，输入即高亮，支持上下跳转 |
| 只读边界 | 查看器内不可编辑、不可替换；内容变更仅通过 AI 工具完成 |
| 工具栏按钮 | 各按钮功能正常，图标正确 |
| 关闭文件 | 点击关闭或按 Escape 返回占位符状态 |
| 刷新文件 | 点击刷新按钮重新加载文件内容 |

### 8.2 性能验收

| 指标 | 标准 |
|------|------|
| 文件打开速度 | < 500ms（2MB 以内文件） |
| 语法高亮 | < 1s（首次初始化），< 100ms（后续） |
| 查找响应 | < 100ms（10000 行以内） |

### 8.3 视觉验收

| 项目 | 标准 |
|------|------|
| 布局 | 与现有 UI 风格一致 |
| 工具栏 | 36px 高，按钮 28×28px |
| 配色 | 与 Ant Design 主题协调 |
| 动画 | 过渡平滑，无明显卡顿 |

---

## 9. 相关文件

| 文件路径 | 说明 |
|----------|------|
| `src/renderer/components/DetailPanel/` | 新建，详情面板组件目录 |
| `src/renderer/utils/shikiHighlighter.ts` | 新建，语法高亮工具 |
| `src/renderer/App.tsx` | 修改，集成 DetailPanel |
| `electron/appIpc.ts` | 可能需要新增 IPC 通道 |
| `src/shared/api.ts` | 可能需要新增类型定义 |

---

**文档修订记录：**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0 | 2026-05-16 | 初始版本，结合参考文档与项目实际情况 |
| 1.1 | 2026-05-16 | 移除替换功能需求：查看器定位为只读预览，内容修改统一由 AI 完成；同步更新 SearchPanel 规格、快捷键与验收标准 |
