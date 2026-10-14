# 搜索 Tab 结果展示优化 — 需求规格

## 1. 概述

当前搜索 Tab 搜索结果列表中，每条结果仅以 `[session]` / `[file]` 文本前缀区分类型，视觉区分度极低。同时，点击文件类型结果无任何响应，点击会话结果仅切换会话而不定位到具体消息。本需求优化这两个问题。

---

## 2. 现状分析

### 2.1 搜索数据流

```
SearchPane (App.tsx:121)
  → window.api.searchExecute(query)
    → ipcRenderer.invoke('search:execute', query)
      → appIpc.ts:815
        1. 遍历 db.data.messages，匹配 content (最多 50 条)
        2. searchFilesUnder() 递归扫描文本文件 (最多 40 个)
        → SearchResult[]
```

### 2.2 当前 SearchResult 数据结构

```ts
// src/shared/domainTypes.ts:613
export interface SearchResult {
  id: string          // "msg:<id>" 或 "file:<fullPath>"
  type: 'session' | 'file'
  title: string       // 会话名称 或 文件相对路径
  preview: string     // 匹配内容截断预览 (最多 160 字符)
  path?: string       // 仅 file 类型，文件相对路径
  sessionId?: string  // 仅 session 类型，所属会话 ID
}
```

### 2.3 问题一：类型区分度低

当前渲染代码（`App.tsx:143-144`）：

```tsx
<Text strong ellipsis>
  [{item.type}] {item.title}
</Text>
```

- 仅用 `[session]` / `[file]` 纯文本标签，无图标、无颜色
- 视觉扫读时难以快速分辨哪些是聊天记录、哪些是文件命中

### 2.4 问题二：点击行为缺失

当前点击处理（`App.tsx:139-141`）：

```tsx
onClick={() => {
  if (item.sessionId) dispatch(setSession(item.sessionId))
}}
```

| 结果类型 | 点击行为 | 问题 |
|---------|---------|------|
| session（有 `sessionId`） | 切换到对应会话 | 仅切换会话，不滚动到匹配消息。用户需手动在长对话中翻找 |
| file（无 `sessionId`） | **无任何响应** | `if (item.sessionId)` 为 false，整个分支跳过 |

---

## 3. 需求：增强结果类型区分

### 3.1 每条结果显示图标

| 结果类型 | 图标 | 说明 |
|---------|------|------|
| session（聊天消息） | `chat/chat_3_line.svg`（或类似消息图标） | 表示该结果是 AI 对话中的一条消息 |
| file（文本文件） | `file/file_line.svg` | 表示该结果是工作目录下的文件 |

图标位于每条结果行首，尺寸 16×16，与文本间距 8px。

### 3.2 类型标签

移除 `[{item.type}]` 纯文本标签，改为：

- **session 类型**：在标题行末尾显示浅色标签 `聊天`（Ant Design `<Tag>`，蓝色或默认色）
- **file 类型**：在标题行末尾显示浅色标签 `文件`（Ant Design `<Tag>`，绿色）

### 3.3 辅助信息行

在标题下方、preview 上方增加一行辅助信息：

| 结果类型 | 辅助信息内容 | 格式 |
|---------|------------|------|
| session | 所属会话名称 | `📁 {会话名}`，若与 title 相同则省略此行 |
| file | 文件所在目录路径 | `📂 {目录路径}`，取 `path` 的 `dirname` |

辅助信息使用 `Text type="secondary"` 更小字号（12px）渲染。

### 3.4 布局示意

```
┌─────────────────────────────────────────┐
│ 💬  有哪些方式可以优化渲染性能     聊天  │  ← 图标 + title + Tag
│     📁 前端性能优化讨论                  │  ← 辅助信息（会话名）
│     "你可以使用 React.memo、useMemo     │  ← preview（截断）
│     useCallback 来避免不必要的重渲染..." │
├─────────────────────────────────────────┤
│ 📄  src/utils/perf.ts              文件  │  ← 图标 + title(文件名) + Tag
│     📂 src/utils/                       │  ← 辅助信息（目录路径）
│     "...export function memoize<T>       │  ← preview（截断）
│     (fn: T): T { const cache = new      │
│     Map(); return ((...args) => {..."   │
└─────────────────────────────────────────┘
```

---

## 4. 需求：完善点击行为

### 4.1 点击聊天消息结果

点击 session 类型结果时：

1. 切换到对应会话（`dispatch(setSession(item.sessionId))`）——**保留现有行为**
2. **新增**：切换到会话后，自动滚动到对应消息位置

**实现方案**：

- `SearchResult` 新增 `messageId?: string` 字段
- 后端 `appIpc.ts` 搜索结果中填充 `messageId: m.id`
- 前端切换 session 后，通过 Redux 或 DOM 查询滚动到对应消息气泡
- 消息气泡需添加 `data-message-id` 属性以支持 `scrollIntoView`

> **备选方案**：若消息定位实现复杂，首期可先切换到会话 + 弹出 `message.info` 提示"已切换到对应会话"，后续迭代再做精确定位。

### 4.2 点击文件结果

点击 file 类型结果时：

1. 切换到文件 Tab（左侧活动栏 `siderKey = 'files'`）
2. 在文件树中展开到该文件所在目录
3. 选中该文件，在右侧预览区显示文件内容
4. 可选：在文件预览中高亮匹配关键词

**实现方案**：

- 搜索结果项 `onClick` 中调用 `dispatch(setFilePreview(item.path))` 或等效 action
- 同时触发文件树导航到目标文件路径
- 若文件树暂不支持编程式导航到指定文件，首期可先打开文件预览 + 弹出 `message.info` 提示文件路径

> **备选方案**：首期最小实现——点击文件结果直接在当前界面用 Modal 或右侧面板展示文件内容（含关键词高亮），不依赖文件树的导航能力。

### 4.3 首期交付范围

| 功能 | 优先级 | 说明 |
|------|-------|------|
| 图标区分 session/file | P0 | 视觉区分度最直接的提升 |
| Tag 标签替换文本前缀 | P0 | 配合图标形成清晰的类型标识 |
| 辅助信息行 | P1 | 进一步丰富上下文 |
| 文件结果点击打开预览 | P0 | 修复点击无响应 bug |
| 会话结果点击滚动到消息 | P1 | 提升实用性，首期可降级为提示 |

---

## 5. 数据结构变更

### 5.1 SearchResult 扩展

```ts
// src/shared/domainTypes.ts
export interface SearchResult {
  id: string
  type: 'session' | 'file'
  title: string
  preview: string
  path?: string
  sessionId?: string
  messageId?: string  // 新增：消息 ID，用于点击后滚动定位
}
```

### 5.2 后端适配

`electron/appIpc.ts` 中 session 类型结果构建时增加 `messageId`：

```ts
results.push({
  id: `msg:${m.id}`,
  type: 'session',
  title: s?.name ?? m.sessionId,
  preview: m.content.slice(0, 160),
  sessionId: m.sessionId,
  messageId: m.id,  // 新增
})
```

---

## 6. 组件结构

| 组件/文件 | 职责 | 改动类型 |
|----------|------|---------|
| `src/renderer/App.tsx` — `SearchPane` | 搜索结果列表渲染与点击交互 | **重构** |
| `src/renderer/components/Search/SearchResultItem.tsx` | 单条搜索结果渲染（图标、标签、辅助信息、preview） | **新建** |
| `src/shared/domainTypes.ts` | `SearchResult` 增加 `messageId` | **修改** |
| `electron/appIpc.ts` | 搜索结果填充 `messageId` | **修改** |

> 建议将 `SearchPane` 从 `App.tsx` 中抽取为独立组件 `src/renderer/components/Search/SearchPane.tsx`，降低 `App.tsx` 复杂度。

---

## 7. 图标清单

| 用途 | 图标文件 |
|------|---------|
| 聊天消息结果 | `chat/chat_3_line.svg`（需确认项目中是否存在，否则用 `communication/chat_3_line.svg`） |
| 文件结果 | `file/file_line.svg`（已存在） |

---

## 8. 不在本次范围

- 搜索历史记录的 UI 优化（当前 `search:get-history` 已有后端支持但前端未展示）
- 搜索结果筛选/排序
- 搜索结果高亮匹配关键词（preview 中加粗/高亮）
- 文件预览中的关键词高亮
- 跨会话消息合并展示
