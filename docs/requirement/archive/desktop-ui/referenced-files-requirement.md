# 引用的文件 — 需求规格

**版本：** 1.0
**日期：** 2026-05-18
**状态：** 待评审

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [功能需求](#3-功能需求)
4. [架构设计](#4-架构设计)
5. [组件规格](#5-组件规格)
6. [交互规格](#6-交互规格)
7. [一次性脚本过滤规则](#7-一次性脚本过滤规则)
8. [验收标准](#8-验收标准)

---

## 1. 概述

### 1.1 功能定位

「引用的文件」板块位于右侧详情面板（app-detail-sider）的下半区域，自动汇总当前会话中 AI 通过工具调用操作过的所有文件，以列表形式展示，帮助用户快速了解本次会话涉及了哪些文件、最近操作了哪些文件。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 用户无需翻阅聊天记录，即可在右侧栏一览本次会话引用的全部文件 |
| G2 | 列表按最近操作时间倒序排列，读写操作实时刷新排序，帮助用户定位最新被操作的文件 |
| G3 | 自动过滤 Agent 生成的一次性脚本文件，避免干扰用户对项目文件的认知 |
| G4 | 板块支持鼠标拖动调整高度，适配不同使用场景 |
| G5 | 点击文件可在文件查看器中打开，与文件树点击行为一致 |

### 1.3 非目标

- 不提供文件的手动添加/移除功能（列表完全由工具调用自动驱动）
- 不提供文件操作历史的回放（如操作时间线视图）
- 不跨会话聚合文件引用（每个会话独立维护自己的引用列表）

---

## 2. 现状分析

### 2.1 现有实现

当前右侧详情面板（`DetailPanel`）的布局为：

```
DetailPanel（占满整个右侧栏高度）
├── selectedFile 为空 → 占位符「选择文件以预览内容」
└── selectedFile 非空 → FileOverlay（工具栏 + 文件内容）
```

- 无「引用的文件」板块
- 无从工具调用记录中提取文件引用的逻辑
- 无一次性脚本过滤机制

### 2.2 可用数据源

工具调用记录（`ToolCallRecord`）中包含文件操作信息：

| 工具名称 | 文件路径字段 | 操作类型 |
|----------|-------------|----------|
| `read_file` | `input.path` | 读取 |
| `write_file` | `input.path` | 写入 |
| `edit_file` | `input.path` | 读写 |
| `list_directory` | `input.path` | 浏览（不计入引用） |
| `grep` | `input.path`（可选） | 搜索（不计入引用） |
| `run_script` | `input.code` | 脚本执行（需通过输出推断文件操作，不计入引用） |

**说明：** `list_directory`、`grep`、`run_script` 不计入引用列表。`list_directory` 和 `grep` 是浏览/搜索行为，未直接读写文件内容；`run_script` 的文件操作无法从 `input` 中直接提取（需解析脚本代码，复杂度高且不可靠）。

---

## 3. 功能需求

### 3.1 引用文件列表

#### 3.1.1 数据采集

从当前会话的所有消息（`Message[]`）的 `toolCalls` 数组中，提取满足以下条件的工具调用记录：

- `toolName` 为 `read_file`、`write_file` 或 `edit_file`
- `status` 为 `completed`（仅成功完成的操作计入）
- `input.path` 为非空字符串

提取后的每条记录生成一个引用条目：

```typescript
interface ReferencedFile {
  /** 文件相对路径（相对于工作目录），作为唯一标识 */
  path: string
  /** 最近一次操作时间（Unix 毫秒时间戳），取该文件所有工具调用中 completedAt 的最大值 */
  lastReferencedAt: number
  /** 操作类型标记：最近一次操作是读还是写 */
  lastOperation: 'read' | 'write'
  /** 该文件被引用的总次数 */
  referenceCount: number
}
```

#### 3.1.2 去重规则

- 同一文件路径（`path`）仅保留一条记录
- 当同一文件被多次操作时，更新 `lastReferencedAt`、`lastOperation` 和 `referenceCount`
- `lastReferencedAt` 取所有该文件工具调用中 `completedAt` 的最大值

#### 3.1.3 排序规则

- 按 `lastReferencedAt` **倒序**排列：最近被操作的文件排在最前面
- 每次有新的工具调用完成时，实时刷新列表排序

#### 3.1.4 操作类型定义

| 工具名称 | 操作类型 |
|----------|----------|
| `read_file` | `read` |
| `write_file` | `write` |
| `edit_file` | `write` |

`edit_file` 归类为 `write`，因为编辑操作会修改文件内容。

### 3.2 一次性脚本过滤

#### 3.2.1 过滤目标

Agent 在执行任务时经常生成临时脚本文件（如 Python 脚本）来处理文件，这些脚本本身不是项目代码的一部分，过多出现在引用列表中会干扰用户对项目文件的认知。

#### 3.2.2 过滤规则

满足以下**任一**条件的文件将被过滤，不显示在引用列表中：

| 规则 | 匹配模式 | 说明 |
|------|----------|------|
| 临时目录 | `tmp/`、`temp/`、`.tmp/` 开头 | 临时目录下的文件 |
| 临时文件前缀 | 文件名以 `tmp_`、`temp_` 开头 | 临时命名文件 |
| 常见脚本模式 | 文件名匹配 `script_*`、`run_*`、`fix_*`、`patch_*`、`migrate_*`、`convert_*`、`process_*`、`generate_*`、`setup_*` | Agent 常生成的一次性脚本命名模式 |
| 常见一次性后缀 | `.py` 后缀且文件名长度 ≤ 32 字符且在项目根目录或一级子目录下 | Agent 生成的简短 Python 脚本 |
| 一次性脚本标记 | 文件由 `run_script` 工具的执行结果中写入 | 间接生成的脚本（预留，本期不实现） |

**注：** 上述规则采用白名单模式——只有明确匹配的才过滤，避免误伤项目正式文件。

#### 3.2.3 过滤规则的正则表达式

```typescript
const DISPOSABLE_SCRIPT_PATTERNS: RegExp[] = [
  /^(tmp|temp|\.tmp)\//,                          // 临时目录
  /\/(tmp|temp)_[\w-]+\.\w+$/,                    // 临时文件前缀
  /\/(script|run|fix|patch|migrate|convert|process|generate|setup)_[\w-]+\.\w+$/, // 一次性脚本
  /^[^/]+\/?(script|run|fix|patch|migrate|convert|process|generate|setup)_[\w-]+\.py$/, // 根/一级子目录下的脚本
]
```

### 3.3 面板布局

#### 3.3.1 整体结构

右侧详情面板分为上下两个区域：

```
DetailPanel（占满右侧栏高度）
├── 上半区域：占位区（仅显示占位符，不放其他内容）
└── 下半区域：引用的文件列表
    ├── 板块标题栏（可拖动分隔条）
    └── 文件列表（可滚动）
```

#### 3.3.2 默认高度分配

| 区域 | 默认高度占比 |
|------|-------------|
| 上半区（占位区，仅占位符） | 50% |
| 下半区（引用的文件） | 50% |

#### 3.3.3 拖动调整高度

- 两个区域之间有一个可拖动的分隔条（resize handle）
- **拖动方向**：垂直方向
- **最小高度**：每个区域最小 80px
- **最大高度**：拖动时不超过对方区域的最小高度限制
- **视觉反馈**：分隔条高度 4px，hover 时高亮为 `var(--sa-primary)`，鼠标变为 `row-resize`
- **拖动时**：鼠标指针保持 `row-resize`，实时更新两个区域高度
- **持久化**：高度比例不持久化，每次打开面板恢复默认 50%/50%

### 3.4 文件查看器覆盖行为

#### 3.4.1 覆盖范围

当 `selectedFile` 非空时，`FileOverlay` 应覆盖整个右侧栏（包括「引用的文件」板块），而非仅覆盖上半区域。

**理由：** 文件查看需要尽可能大的显示空间，且用户查看文件时通常不需要同时看到引用列表。关闭文件查看器后，恢复上下分栏布局。

#### 3.4.2 布局切换逻辑

```
selectedFile 为空时：
┌──────────────────┐
│   占位符          │ ← 上半区（仅占位，不放其他内容）
├──────────────────┤ ← 可拖动分隔条
│  引用的文件列表    │ ← 下半区
└──────────────────┘

selectedFile 非空时：
┌──────────────────┐
│  FileOverlay      │ ← 覆盖整个右侧栏
│  (工具栏+内容)    │
│                   │
│                   │
└──────────────────┘
```

### 3.5 文件点击打开

#### 3.5.1 点击行为

点击「引用的文件」列表中的文件条目，调用 `DetailPanelContext.openFile(relPath)` 打开文件查看器，与文件树点击行为一致。

#### 3.5.2 交互细节

- **单击**：打开文件，`FileOverlay` 覆盖整个右侧栏
- **当前已打开同一文件**：不重复触发加载
- **文件不存在**：显示错误提示（Toast）

### 3.6 文件列表条目样式

#### 3.6.1 条目布局

每个文件条目为一行，包含以下元素：

```
┌─────────────────────────────────────┐
│ [图标] 文件名          [操作类型标记] │
│        完整路径（截断显示）            │
└─────────────────────────────────────┘
```

#### 3.6.2 条目元素

| 元素 | 说明 |
|------|------|
| 文件图标 | 根据文件类型显示不同图标（与文件树一致） |
| 文件名 | `pathBasename(path)`，单行截断 |
| 完整路径 | 灰色小字，单行截断，hover 时 tooltip 显示完整路径 |
| 操作类型标记 | 小圆点 + 文字：🟢 读取 / 🟠 写入 |

#### 3.6.3 条目交互

- **hover**：背景高亮，显示完整路径 tooltip
- **click**：打开文件查看器
- **选中态**：当前在查看器中打开的文件条目高亮显示

---

## 4. 架构设计

### 4.1 目标架构

```
DetailPanel（详情面板容器）
├── selectedFile 非空 → FileOverlay（覆盖全栏）
└── selectedFile 为空 → 上下分栏布局
    ├── 上半区：占位符（仅占位，不放其他内容）
    └── 下半区：ReferencedFilesPanel
        ├── 面板标题栏 + 分隔条
        └── 文件列表（可滚动）
```

### 4.2 组件划分

| 组件 | 文件路径 | 职责 |
|------|----------|------|
| DetailPanel | `src/renderer/components/DetailPanel/index.tsx` | 修改：切换全栏/分栏布局 |
| ReferencedFilesPanel | `src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx` | 新建：引用文件列表面板 |
| ReferencedFileItem | `src/renderer/components/DetailPanel/ReferencedFileItem.tsx` | 新建：单个文件条目 |
| ResizeHandle | `src/renderer/components/DetailPanel/ResizeHandle.tsx` | 新建：可拖动分隔条 |
| useReferencedFiles | `src/renderer/components/DetailPanel/useReferencedFiles.ts` | 新建：引用文件数据 hook |
| isDisposableScript | `src/renderer/components/DetailPanel/disposableScriptFilter.ts` | 新建：一次性脚本过滤逻辑 |

### 4.3 数据流

```
Redux Store (chat.messages)
    ↓
useReferencedFiles hook
    ├─ 遍历当前会话所有消息的 toolCalls
    ├─ 提取 read_file / write_file / edit_file 的 path
    ├─ 去重、合并 lastReferencedAt / lastOperation / referenceCount
    ├─ 过滤一次性脚本（isDisposableScript）
    └─ 按 lastReferencedAt 倒序排序
    ↓
ReferencedFilesPanel（接收 ReferencedFile[]）
```

### 4.4 状态管理

#### 4.4.1 引用文件数据

通过自定义 Hook `useReferencedFiles` 从 Redux Store 派生计算，不需要额外持久化：

```typescript
function useReferencedFiles(sessionId: string | null): ReferencedFile[]
```

- 输入：当前会话 ID
- 输出：排序后的 `ReferencedFile[]`
- 依赖：`chat.messages`（当前会话的消息列表）
- 计算：每次消息变化或工具调用状态变化时重新计算（使用 `useMemo` 缓存）

#### 4.4.2 面板高度

通过 `DetailPanelContext` 扩展管理：

```typescript
// 新增到 DetailPanelState
referencedFilesHeight: number  // 下半区高度百分比，默认 50
```

- 拖动分隔条时更新
- 关闭文件查看器后恢复为 50%

---

## 5. 组件规格

### 5.1 DetailPanel（修改）

**修改点：** 渲染逻辑从二选一变为分栏布局

**修改前：**
```tsx
if (!selectedFile) return <占位符 />
return <FileOverlay />
```

**修改后：**
```tsx
if (selectedFile) return <FileOverlay />  // 全栏覆盖

return (
  <div className="detail-panel-split">
    <div className="detail-panel-top" style={{ flex: 1 - ratio }}>
      <占位符 />  {/* 仅占位，不放其他内容 */}
    </div>
    <ResizeHandle onResize={setRatio} />
    <div className="detail-panel-bottom" style={{ flex: ratio }}>
      <ReferencedFilesPanel sessionId={currentSessionId} />
    </div>
  </div>
)
```

### 5.2 ReferencedFilesPanel

| 属性 | 类型 | 说明 |
|------|------|------|
| sessionId | `string \| null` | 当前会话 ID |

**渲染：**
- 面板标题栏：「引用的文件」+ 文件数量徽标
- 空状态：显示「暂无引用的文件」
- 列表：渲染 `ReferencedFileItem[]`

### 5.3 ReferencedFileItem

| 属性 | 类型 | 说明 |
|------|------|------|
| file | `ReferencedFile` | 引用文件数据 |
| isActive | `boolean` | 是否为当前查看器中打开的文件 |
| onClick | `() => void` | 点击回调 |

### 5.4 ResizeHandle

| 属性 | 类型 | 说明 |
|------|------|------|
| onResize | `(ratio: number) => void` | 拖动回调，ratio 为下半区占比（0~1） |
| minRatio | `number` | 最小占比，默认 0.15 |
| maxRatio | `number` | 最大占比，默认 0.85 |

---

## 6. 交互规格

### 6.1 列表更新时机

| 事件 | 行为 |
|------|------|
| 工具调用 `completed` | 新文件加入列表；已有文件更新排序和操作类型 |
| 工具调用 `failed` / `rejected` | 不计入列表 |
| 切换会话 | 列表刷新为新会话的引用文件 |
| 新建会话 | 列表为空 |

### 6.2 拖动交互

| 阶段 | 行为 |
|------|------|
| hover 分隔条 | 分隔条高亮，鼠标变为 `row-resize` |
| 按下鼠标 | 记录起始位置和初始比例 |
| 拖动 | 实时更新上下区域高度 |
| 释放鼠标 | 停止拖动，保持当前比例 |
| 双击分隔条 | 恢复默认 50%/50% |

### 6.3 文件打开交互

| 操作 | 行为 |
|------|------|
| 点击文件条目 | 调用 `openFile(path)`，`FileOverlay` 覆盖全栏 |
| 点击当前已打开的文件 | 不重复加载 |
| 文件加载失败 | 显示 Toast 错误提示 |

---

## 7. 一次性脚本过滤规则

### 7.1 过滤策略

采用**模式匹配**策略，基于文件路径和命名特征识别一次性脚本。不依赖文件内容分析（成本高且不可靠）。

### 7.2 详细规则

| # | 规则 | 示例 | 匹配方式 |
|---|------|------|----------|
| 1 | 临时目录下的文件 | `tmp/output.txt`、`temp/cache.json` | 路径以 `tmp/`、`temp/`、`.tmp/` 开头 |
| 2 | 临时前缀命名的文件 | `temp_data.py`、`tmp_result.json` | 文件名以 `tmp_`、`temp_` 开头 |
| 3 | Agent 常用脚本命名模式 | `script_fix_imports.py`、`run_migrate.py`、`convert_csv.py` | 文件名匹配 `script_*`、`run_*`、`fix_*`、`patch_*`、`migrate_*`、`convert_*`、`process_*`、`generate_*`、`setup_*` 模式 |
| 4 | 根目录或一级子目录下的简短 Python 脚本 | `helper.py`、`utils/process.py` | `.py` 后缀 + 位于项目前两级目录 + 文件名长度 ≤ 32 |

### 7.3 过滤实现

```typescript
const DISPOSABLE_SCRIPT_PATTERNS: RegExp[] = [
  // 规则 1：临时目录
  /^(tmp|temp|\.tmp)\//,
  // 规则 2：临时前缀
  /(?:^|\/)(tmp|temp)_[\w-]+\.\w+$/,
  // 规则 3：Agent 一次性脚本命名
  /(?:^|\/)(script|run|fix|patch|migrate|convert|process|generate|setup)_[\w-]+\.\w+$/,
  // 规则 4：根/一级目录下的简短 Python 脚本
  /^[^/]+\/?[\w-]{1,32}\.py$/,
]

export function isDisposableScript(filePath: string): boolean {
  return DISPOSABLE_SCRIPT_PATTERNS.some(p => p.test(filePath))
}
```

### 7.4 规则 4 的补充说明

规则 4 存在误伤风险（如项目根目录下的 `app.py`、`main.py`）。因此在实际实现中，规则 4 需追加一个白名单排除常见项目入口文件：

```typescript
const PROJECT_ENTRY_FILES = new Set([
  'app.py', 'main.py', 'server.py', 'manage.py',
  'wsgi.py', 'asgi.py', 'conftest.py', 'setup.py',
  '__init__.py', '__main__.py',
])
```

若文件名在白名单中，则不被规则 4 过滤。

### 7.5 未来扩展

- 可在设置中提供开关，允许用户关闭一次性脚本过滤
- 可在引用列表中提供「显示已过滤的文件」按钮，临时展示被过滤的条目
- 可通过 `.spaceassistantignore` 文件自定义过滤规则

---

## 8. 验收标准

### 8.1 功能验收

| 功能 | 验收条件 |
|------|----------|
| 引用文件列表展示 | 当前会话中 AI 通过 read_file / write_file / edit_file 操作过的文件出现在列表中 |
| 实时更新 | 工具调用完成后，列表立即更新（新增或排序刷新） |
| 排序正确 | 列表按最近操作时间倒序排列，最新操作的文件在最上方 |
| 操作类型标记 | 每个文件条目正确显示「读取」或「写入」标记 |
| 一次性脚本过滤 | 临时脚本文件（如 `script_fix.py`、`tmp_result.json`）不出现在列表中 |
| 过滤白名单 | 项目入口文件（如 `app.py`、`main.py`）不被误过滤 |
| 拖动调整高度 | 上下区域分隔条可拖动，实时调整高度比例 |
| 拖动最小限制 | 每个区域最小高度 80px，不可继续缩小 |
| 双击恢复 | 双击分隔条恢复默认 50%/50% 布局 |
| 文件查看器覆盖 | 打开文件时，FileOverlay 覆盖整个右侧栏（包括引用文件列表） |
| 关闭恢复分栏 | 关闭文件查看器后，恢复上下分栏布局 |
| 文件点击打开 | 点击引用列表中的文件，在文件查看器中正确展示内容 |
| 已打开文件高亮 | 当前查看器中打开的文件在引用列表中高亮显示 |
| 空会话 | 新建会话时，列表为空，显示「暂无引用的文件」 |
| 切换会话 | 切换会话后，列表正确刷新为对应会话的引用文件 |
| 失败操作不计入 | 工具调用失败或被拒绝时，对应文件不出现在列表中 |

### 8.2 性能验收

| 指标 | 标准 |
|------|------|
| 列表计算 | < 16ms（100 条以内工具调用记录） |
| 列表渲染 | < 50ms（50 个以内的引用文件） |
| 拖动流畅度 | 60fps，无明显卡顿 |

### 8.3 视觉验收

| 项目 | 标准 |
|------|------|
| 分隔条 | 4px 高，hover 时高亮为 `var(--sa-primary)`，cursor: `row-resize` |
| 条目高度 | 40px，包含文件名和路径两行信息 |
| 操作类型标记 | 小圆点 + 文字，读取为绿色，写入为橙色 |
| 选中态 | 背景色为 `var(--sa-primary-subtle)`，与文件树选中态视觉一致 |
| 与整体 UI 一致 | 配色、字体、圆角与 Ant Design 主题和现有详情面板风格协调 |

---

## 9. 相关文件

| 文件路径 | 说明 |
|----------|------|
| `src/renderer/components/DetailPanel/index.tsx` | 修改：切换全栏/分栏布局 |
| `src/renderer/components/DetailPanel/DetailPanelContext.tsx` | 修改：扩展高度比例状态 |
| `src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx` | 新建：引用文件列表面板 |
| `src/renderer/components/DetailPanel/ReferencedFileItem.tsx` | 新建：单个文件条目 |
| `src/renderer/components/DetailPanel/ResizeHandle.tsx` | 新建：可拖动分隔条 |
| `src/renderer/components/DetailPanel/useReferencedFiles.ts` | 新建：引用文件数据 hook |
| `src/renderer/components/DetailPanel/disposableScriptFilter.ts` | 新建：一次性脚本过滤逻辑 |
| `src/renderer/components/DetailPanel/detailPanel.css` | 修改：新增分栏布局和引用列表样式 |
| `src/shared/domainTypes.ts` | 参考：ToolCallRecord、Message 类型定义 |
| `src/renderer/components/Chat/toolCallDisplay.ts` | 参考：isFileTool、isFileWriteTool 工具判断逻辑 |

---

**文档修订记录：**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0 | 2026-05-18 | 初始版本 |
