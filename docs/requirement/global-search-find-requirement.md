# 全局查找功能（Ctrl+F / Cmd+F）需求文档

**版本：** 1.1
**日期：** 2026-06-10
**状态：** 已确认

---

## 目录

1. [概述](#1-概述)
2. [功能范围](#2-功能范围)
3. [UI 设计](#3-ui-设计)
4. [交互行为](#4-交互行为)
5. [搜索匹配逻辑](#5-搜索匹配逻辑)
6. [性能约束](#6-性能约束)
7. [技术方案](#7-技术方案)
8. [高亮样式](#8-高亮样式)
9. [快捷键定义](#9-快捷键定义)
10. [改动文件清单](#10-改动文件清单)
11. [验收标准](#11-验收标准)
12. [非目标](#12-非目标)
13. [已确认决策](#13-已确认决策)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前存在三类搜索能力，职责各不相同：

| 功能 | 组件 / IPC | 范围 | 入口 |
|------|-----------|------|------|
| **文件内查找** | `SearchPanel` | 当前打开文件的源码模式 | 文件查看器内 `Ctrl+F` |
| **侧边栏全局搜索** | `SearchPane` + `search:execute` | 跨会话消息 + 工作区文件 | 左侧活动栏「搜索」图标 |
| **（本次新增）上下文查找** | `SearchBar` | 当前活跃面板内的可见内容 | 全局 `Ctrl+F` |

本次需求填补的空白是：**聊天消息列表**和**文件查看器 Markdown 渲染模式**没有查找能力。文件源码模式已有 `SearchPanel` 覆盖，本次不改动其行为。

### 1.2 目标

新增 VS Code 风格的**上下文查找栏**（`SearchBar`）：按 `Ctrl+F`（Mac: `Cmd+F`）在窗口右上角弹出浮动搜索栏，根据当前焦点面板自动适配搜索策略，支持区分大小写、全词匹配、正则表达式三种搜索选项。

### 1.3 与现有搜索功能的关系

```
┌─────────────────────────────────────────────────────────────────┐
│  用户意图                                                        │
├──────────────────────────┬──────────────────────────────────────┤
│  在当前可见内容中定位文本   │  跨会话 / 跨文件检索历史内容           │
│  （Ctrl+F，即时高亮导航）   │  （侧边栏 SearchPane，结果列表跳转）    │
├──────────────────────────┼──────────────────────────────────────┤
│  SearchBar（新增）          │  SearchPane + search:execute（已有）  │
│  · 聊天消息列表             │  · 所有会话消息                      │
│  · 文件 Markdown 渲染模式   │  · 工作区文件内容                    │
│                           │  · 异步 IPC，无 DOM 高亮              │
├──────────────────────────┤                                      │
│  SearchPanel（已有，保留）  │                                      │
│  · 文件源码模式             │                                      │
└──────────────────────────┴──────────────────────────────────────┘
```

**关键区分**（类比 VS Code）：

| VS Code | SpaceAssistant 对应 | 说明 |
|---------|---------------------|------|
| `Ctrl+F` Find | `SearchBar` + `SearchPanel` | 在当前可见上下文中查找并高亮 |
| `Ctrl+Shift+F` Search | `SearchPane` | 跨资源全局检索，返回结果列表 |

用户感知差异：
- **Ctrl+F**：不离开当前视图，直接在页面上高亮匹配项并循环跳转
- **侧边栏搜索**：输入关键词后列出跨会话/跨文件命中，点击结果跳转到对应位置

---

## 2. 功能范围

### 2.1 支持搜索的面板

| 面板 | 搜索模式 | 搜索源 | 负责组件 |
|------|----------|--------|----------|
| **聊天消息列表** | DOM 文本搜索 | 渲染后的可见文本（忽略 Markdown 语法标记） | `SearchBar`（新增） |
| **文件查看器 — Markdown 渲染模式** | DOM 文本搜索 | 渲染后的可见文本 | `SearchBar`（新增） |
| **文件查看器 — 源码模式** | 文本搜索 | `previewContent` 原始字符串 | `SearchPanel`（已有，**不改动**） |
| **文件查看器 — HTML 渲染模式（WebView）** | 不支持 | — | — |
| **文件查看器 — 图片 / 不支持类型** | 不支持 | — | — |

### 2.2 搜索选项

三个开关，可独立组合：

| 开关 | 标识 | 说明 |
|------|------|------|
| 区分大小写 | `Aa` | 关闭时忽略大小写，打开时严格匹配 |
| 全词匹配 | `W` | 仅匹配完整单词边界；对正则模式无效；**对中文内容不生效**（见 5.1） |
| 正则表达式 | `.*` | 将查询文本作为正则表达式解析；无效正则时输入框变红并提示错误 |

切换任一开关时**立即重新搜索**，不清空查询输入。

### 2.3 Ctrl+F 路由规则

| 当前上下文 | `Ctrl+F` 行为 |
|-----------|--------------|
| 焦点在 `MessageInput` | **不打开**任何搜索栏（见 9. 快捷键定义） |
| 聊天消息列表区域 | 打开 `SearchBar` |
| 文件查看器 — Markdown 渲染模式 | 打开 `SearchBar` |
| 文件查看器 — 源码模式 | 打开已有 `SearchPanel`（`FileOverlay` 现有逻辑，不改动） |
| 文件查看器 — HTML / 图片 / 不支持 | 不打开 `SearchBar`（`SearchPanel` 也不可用） |

`SearchBar` 与 `SearchPanel` **不同时显示**；源码模式下 `SearchBar` 不介入。

---

## 3. UI 设计

### 3.1 搜索栏布局

浮动搜索栏位于**主窗口右上角**，始终固定在该位置，不跟随面板切换移动。

```
┌─────────────────────────────────────────────────────────┐
│  [🔍 输入框...                  ]  Aa  W  .*  ↑  ↓  3/12  ✕ │
└─────────────────────────────────────────────────────────┘
```

从左到右依次为：

1. **搜索输入框**：`placeholder` 使用 `search.detail.placeholder`（与 `SearchPanel` 复用），打开时自动聚焦，若有选中文本则自动填入
2. **Aa 按钮**：区分大小写开关，激活态高亮
3. **W 按钮**：全词匹配开关，激活态高亮
4. **`.*` 按钮**：正则表达式开关，激活态高亮
5. **↑ 按钮**：上一个匹配项（无匹配时 disabled）
6. **↓ 按钮**：下一个匹配项（无匹配时 disabled）
7. **匹配计数**：`当前索引 / 总匹配数`，如 `3/12`，无匹配时显示 `0/0`
8. **✕ 关闭按钮**：关闭搜索栏并清除所有高亮

### 3.2 正则错误提示

当正则表达式无效时：
- 输入框状态变为 `error`（红色边框）
- 输入框下方显示红色错误提示，**仅使用 i18n key `search.detail.regexInvalid`**，不透传底层 `RegExp` 构造器的英文错误信息
- 匹配计数显示 `0/0`
- ↑ ↓ 按钮 disabled

### 3.3 显示/隐藏规则

- **打开**：按 `Ctrl+F` / `Cmd+F` 打开（受 2.3 路由规则约束）
- **关闭**：按 `Esc` 或点击 ✕ 按钮关闭，同时**清除所有高亮**
- 搜索栏打开时面板切换（如从聊天切到文件 Markdown 渲染），搜索自动切换到新面板上下文，不清除查询
- 切换到**不支持搜索**的面板（HTML WebView、图片等）时，搜索栏**保持可见但进入 disabled 状态**（见 3.4）

### 3.4 HTML WebView / 不支持类型的 disabled 状态

采用 **disabled 可见**策略（非隐藏），避免面板切换时搜索栏闪烁：

- 输入框、`Aa` / `W` / `.*` / ↑ / ↓ 全部 `disabled`
- 输入框下方显示灰色提示文字，i18n key：`searchBar.unsupportedPanel`（如「当前面板不支持查找」）
- 匹配计数显示 `—`（非 `0/0`，避免误导）
- 关闭按钮 ✕ **仍可用**，允许用户手动关闭
- 已有高亮在切换到此面板时**立即清除**

### 3.5 无障碍（a11y）

- 搜索栏容器使用 `role="search"`，`aria-label` 引用 i18n
- 匹配计数区域使用 `aria-live="polite"`，导航跳转时播报「第 N 项，共 M 项匹配」
- 所有按钮提供 `aria-label` 和 `title`（复用 `search.detail.*Title` 系列 key）
- 当前匹配项高亮元素添加 `aria-current="true"`

---

## 4. 交互行为

### 4.1 打开行为

1. 用户按 `Ctrl+F` / `Cmd+F`（且当前上下文允许打开，见 2.3）
2. 搜索栏显示在窗口右上角
3. 如果有文本选中，选中文本自动填入输入框
4. 输入框自动聚焦，全选文本
5. 自动执行搜索（如有预填文本）
6. 确定 `activePanel`：`chat` 或 `file-markdown`（根据当前焦点/活跃面板）

### 4.2 输入搜索

- 用户输入时实时搜索，debounce **150ms**
- 输入框为空时清除所有高亮，匹配计数显示 `0/0`

### 4.3 导航行为

| 操作 | 行为 |
|------|------|
| `Enter` | 跳转到下一个匹配项；到达末尾后**无限循环**到第一个 |
| `Shift+Enter` | 跳转到上一个匹配项；到达开头后**无限循环**到最后一个 |
| 点击 ↑ 按钮 | 同 `Shift+Enter` |
| 点击 ↓ 按钮 | 同 `Enter` |

**聊天消息列表**：跨消息导航，自动滚动到目标消息的匹配位置（`scrollIntoView({ block: 'center' })`）。

**文件查看器 Markdown 渲染模式**：在内容区域内自动滚动到匹配位置。

### 4.4 关闭行为

- 按 `Esc` 或点击 ✕
- 清除当前面板所有搜索高亮
- 搜索栏隐藏，输入框内容保留（下次打开时恢复）

### 4.5 流式响应期间的搜索

聊天消息在流式响应期间内容持续变化：

- 使用 `MutationObserver` 监听消息列表 DOM 变化
- **策略**：流式更新进行中时**挂起**搜索执行；DOM 停止变化后 debounce **300ms** 再重新执行搜索
- 挂起期间匹配计数显示上一次有效结果，末尾附加 `…` 表示正在更新（如 `3/12…`）
- 搜索结果（匹配数、当前索引）在 debounce 触发后更新；若当前索引超出新结果范围，重置为 `0`

---

## 5. 搜索匹配逻辑

### 5.1 已有基础设施

`src/renderer/components/DetailPanel/searchUtils.ts` 已实现：

- `SearchOptions` 类型（`caseSensitive`、`wholeWord`、`useRegex`）
- `SearchMatch` 类型（`start`、`end`）
- `buildSearchRegex()` — 构建正则表达式
- `findSearchMatches()` — 在纯文本中查找匹配项
- `getSearchRegexError()` — 正则校验（已返回 i18n 文案）

消息列表搜索和 Markdown 渲染模式均复用此模块。

**全词匹配与中文**：JavaScript `\b` 单词边界对 CJK 字符无效。当搜索内容包含中日韩字符时，`wholeWord` 选项**自动忽略**（等效于关闭），`W` 按钮显示为 disabled 并 tooltip 说明「全词匹配不适用于中文内容」。纯 ASCII 内容时正常工作。

### 5.2 聊天消息列表搜索（DOM 文本提取）

由于消息内容经过 `react-markdown` 渲染为 HTML DOM，搜索需要两步：

**步骤 1：DOM 文本提取**

遍历消息列表容器内所有可见文本节点（`textNode`），拼接为完整纯文本，同时建立字符偏移 → DOM 节点的索引映射：

```
offsetMap: Array<{
  node: Text,           // 对应的文本节点
  textStart: number,    // 该节点在完整文本中的起始偏移
  textEnd: number       // 该节点在完整文本中的结束偏移
}>
```

每条 `ChatBubble` 的内容区域作为独立的搜索块，块之间以换行符 `\n` 分隔（确保跨消息边界时不会产生误匹配）。

**步骤 2：匹配与高亮**

1. 对拼接后的纯文本调用 `findSearchMatches(text, query, options)`
2. 通过 `offsetMap` 将每个匹配的字符偏移映射到具体的 `TextNode + offset`
3. 对匹配的 `TextNode` 使用 `Range` API 包裹高亮 `<mark>` 标签：
   - 普通匹配：`class="sa-search-highlight"`
   - 当前匹配：`class="sa-search-highlight sa-search-highlight-current"`
4. 导航时更新当前匹配的 class 并调用 `scrollIntoView({ block: 'center' })`

**高亮更新优化**：查询词变化时，优先比较新旧匹配列表；若仅当前索引变化，仅切换 `sa-search-highlight-current` class，避免全量 DOM 重建。查询词或选项变化时才清除并重建所有高亮。

### 5.3 文件查看器 Markdown 渲染模式搜索

`MarkdownRenderView` 同样使用 `react-markdown` 渲染，采用与消息列表相同的 DOM 文本提取策略（含 5.2 的高亮更新优化）。

### 5.4 文件查看器源码模式

**不在本次范围内**。继续使用已有 `SearchPanel` + `FileOverlay` 的 `Ctrl+F` 逻辑，不做改动。

---

## 6. 性能约束

| 场景 | 约束 | 策略 |
|------|------|------|
| 聊天消息列表 | 单面板可见消息 ≤ 500 条 | 超出时不截断搜索，但 debounce 输入增至 300ms；若单次搜索耗时 > 200ms，在控制台输出 warn |
| 单条消息文本 | ≤ 100,000 字符 | 超出时跳过该条消息的 DOM 提取，不影响其他消息 |
| 匹配项数量 | ≤ 1,000 个 | 超出时仅高亮前 1,000 个，匹配计数显示 `当前/1000+` |
| DOM 高亮重建 | 单次操作 ≤ 50ms（目标） | 采用 5.2 增量更新策略；必要时使用 `requestAnimationFrame` 分批插入 |
| 流式更新 | MutationObserver 回调 | 合并同一帧内的多次 mutation，避免频繁触发 |

以上约束在开发阶段通过手动测试大会话（500+ 消息）验证，不作为自动化性能测试的硬性门禁。

---

## 7. 技术方案

### 7.1 架构概览

```
App
├── SearchProvider (React Context)
│   ├── 全局搜索状态: { isOpen, query, options, activePanel, matchIndex, totalMatches, panelSupported }
│   ├── 操作方法: open(), close(), setQuery(), goNext(), goPrev(), toggleOption()
│   └── SearchBar（全局搜索栏 UI，浮动在窗口右上角）
│
├── ChatView
│   └── useChatSearchAdapter()
│       ├── 订阅 SearchContext（activePanel === 'chat' 时激活）
│       ├── 遍历 .chat-message-list DOM
│       ├── 提取文本 + 建立偏移映射
│       ├── 调用 findSearchMatches()
│       └── 高亮 + 导航
│
└── DetailPanel / FileContentView
    └── useFileMarkdownSearchAdapter()
        ├── 仅 Markdown 渲染模式激活
        ├── DOM 文本提取（同 ChatView）
        └── HTML WebView / 源码模式：不挂载 adapter

FileOverlay（不改动）
└── SearchPanel（保留，继续服务源码模式）
```

### 7.2 SearchProvider

新增 `src/renderer/components/Search/SearchProvider.tsx`：

- 使用 React Context 持有全局搜索状态
- 提供 `useSearch()` hook 供各面板 adapter 订阅
- 处理 `Ctrl+F` / `Cmd+F` 全局键盘事件，按 2.3 路由规则决定是否打开
- 焦点在 `MessageInput` 时**不拦截** `Ctrl+F`（见 9. 快捷键定义）
- 监听面板切换，更新 `activePanel` 和 `panelSupported` 状态

### 7.3 SearchBar 组件

新增 `src/renderer/components/Search/SearchBar.tsx`：

- 浮动定位，`position: fixed; top: 16px; right: 24px; z-index: 1000`
- Ant Design `Input` + 自定义按钮组
- 订阅 `useSearch()` 获取/更新状态
- `panelSupported === false` 时渲染 disabled 状态（见 3.4）

### 7.4 useChatSearchAdapter

新增 `src/renderer/services/chatSearchAdapter.ts`：

- 导出 `useChatSearchAdapter(containerRef)` hook
- 负责 DOM 文本提取、偏移映射、高亮渲染、导航滚动
- 使用 `MutationObserver` + 300ms debounce 处理流式内容变化（见 4.5）

### 7.5 useFileMarkdownSearchAdapter

新增 `src/renderer/services/fileMarkdownSearchAdapter.ts`：

- 导出 `useFileMarkdownSearchAdapter(viewMode, containerRef)` hook
- 仅在 `viewMode === 'render' && fileType` 为 markdown 类时激活
- DOM 文本提取匹配，逻辑同 `useChatSearchAdapter`

### 7.6 现有代码改动

| 文件 | 改动 |
|------|------|
| `SearchPanel.tsx` | **不改动**（继续服务文件源码模式） |
| `FileOverlay.tsx` | **不改动**（保留 `SearchPanel` 渲染和 `Ctrl+F` 逻辑） |
| `FileContentView.tsx` | 集成 `useFileMarkdownSearchAdapter`（仅 Markdown 渲染模式） |
| `CodeView.tsx` | **不改动**（源码模式高亮仍由 `SearchPanel` 驱动） |

### 7.7 国际化

在现有 `search` 命名空间下新增 key（与 `SearchPanel` 的 `search.detail.*` 共存）：

| Key | 中文 | 英文 |
|-----|------|------|
| `searchBar.unsupportedPanel` | 当前面板不支持查找 | Find is not supported in this panel |
| `searchBar.matchCount` | {{current}} / {{total}} | {{current}} / {{total}} |
| `searchBar.matchCountOverflow` | {{current}} / {{total}}+ | {{current}} / {{total}}+ |
| `searchBar.matchCountUpdating` | {{current}} / {{total}}… | {{current}} / {{total}}… |
| `searchBar.wholeWordCjkHint` | 全词匹配不适用于中文内容 | Whole word match does not apply to CJK text |
| `searchBar.navAnnouncement` | 第 {{current}} 项，共 {{total}} 项匹配 | Match {{current}} of {{total}} |

复用已有 key：`search.detail.placeholder`、`search.detail.regexInvalid`、`search.detail.caseSensitiveTitle` 等。

---

## 8. 高亮样式

### 8.1 CSS 定义

```css
.sa-search-highlight {
  background-color: rgba(255, 196, 0, 0.35);
  color: inherit;
  border-radius: 2px;
  padding: 0;
}

.sa-search-highlight-current {
  background-color: rgba(255, 152, 0, 0.55);
  outline: 1px solid rgba(255, 152, 0, 0.7);
  outline-offset: 0;
  border-radius: 2px;
}
```

- 橙黄色系，与项目蓝色主题不冲突
- 半透明底色 + 当前项 `outline`，确保在当前浅色主题下清晰可辨
- 本项目近期版本**不提供暗黑主题**，高亮样式仅针对现有浅色 UI 设计与验证，无需预留 `[data-theme="dark"]` 或相关 CSS 变量

### 8.2 与 SearchPanel 高亮的关系

`SearchPanel` 驱动的源码模式继续使用现有 `detail-search-hit` / `detail-search-current` class，**不在本次统一样式范围内**。`SearchBar` 驱动的 DOM 高亮统一使用 `.sa-search-highlight` / `.sa-search-highlight-current`。

---

## 9. 快捷键定义

| 快捷键 | 条件 | 行为 |
|--------|------|------|
| `Ctrl+F` / `Cmd+F` | 焦点在 `MessageInput` | **不拦截**，不打开任何搜索栏 |
| `Ctrl+F` / `Cmd+F` | 聊天区 / 文件 Markdown 渲染模式 | 打开 `SearchBar` |
| `Ctrl+F` / `Cmd+F` | 文件源码模式 | 打开已有 `SearchPanel`（`FileOverlay` 现有逻辑） |
| `Esc` | `SearchBar` 打开时 | 关闭 `SearchBar`，清除高亮 |
| `Esc` | `SearchPanel` 打开时 | 关闭 `SearchPanel`（现有逻辑，不改动） |
| `Enter` | `SearchBar` 输入框聚焦 | 跳转到下一个匹配项 |
| `Shift+Enter` | `SearchBar` 输入框聚焦 | 跳转到上一个匹配项 |

**MessageInput 说明**：`<textarea>` 在 Electron/Chromium 中通常不会触发浏览器「页面内查找」。因此焦点在 `MessageInput` 时，`Ctrl+F` 定义为**静默忽略**（不打开搜索栏、不拦截事件），避免与聊天输入体验冲突。用户需先将焦点移到消息列表区域再使用查找。

**冲突处理**：
- `SearchBar` 与 `SearchPanel` 的 `Esc` 各自独立，仅关闭当前打开的那个
- `SearchBar` 打开时 `Esc` 优先于其他 `Esc` 行为（如关闭弹窗）

---

## 10. 改动文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/renderer/components/Search/SearchProvider.tsx` | 全局搜索 Context + Provider |
| `src/renderer/components/Search/SearchBar.tsx` | 浮动搜索栏 UI 组件 |
| `src/renderer/components/Search/searchBar.css` | 搜索栏样式 |
| `src/renderer/services/chatSearchAdapter.ts` | 聊天消息列表搜索适配器 |
| `src/renderer/services/fileMarkdownSearchAdapter.ts` | 文件 Markdown 渲染模式搜索适配器 |
| `src/renderer/i18n/resources/zh-CN/search.json` | 追加 `searchBar.*` key |
| `src/renderer/i18n/resources/en-US/search.json` | 追加 `searchBar.*` key |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/renderer/App.tsx`（或顶层布局组件） | 包裹 `SearchProvider`，渲染 `SearchBar` |
| `src/renderer/components/Chat/ChatView.tsx` | 集成 `useChatSearchAdapter` |
| `src/renderer/components/DetailPanel/FileContentView.tsx` | 集成 `useFileMarkdownSearchAdapter` |
| `src/renderer/styles.css` | 添加 `.sa-search-highlight` 样式 |

### 不改动 / 不删除

| 文件 | 说明 |
|------|------|
| `SearchPanel.tsx` | 保留，继续服务文件源码模式 |
| `FileOverlay.tsx` | 保留 `SearchPanel` 渲染和 `Ctrl+F` 逻辑 |
| `CodeView.tsx` | 保留 `SearchPanel` 驱动的高亮逻辑 |

---

## 11. 验收标准

1. **打开/关闭**：在聊天区按 `Ctrl+F` 打开 `SearchBar`，浮动在窗口右上角；按 `Esc` 或点击 ✕ 关闭，高亮清除
2. **自动填充**：打开时有选中文本则自动填入输入框
3. **实时搜索**：输入文字后 debounce 150ms 自动搜索并高亮所有匹配项
4. **区分大小写**：切换 `Aa` 开关立即重新搜索，开启时严格区分大小写
5. **全词匹配**：切换 `W` 开关立即重新搜索；纯 ASCII 内容时仅匹配完整单词；含中文内容时 `W` 按钮 disabled
6. **正则表达式**：切换 `.*` 开关立即重新搜索；无效正则时输入框变红，显示 i18n 错误文案（非英文底层错误）
7. **导航**：Enter 下一个、Shift+Enter 上一个、↑ ↓ 按钮可用；到达末尾/开头后**无限循环**
8. **匹配计数**：实时显示 `当前/总数`，如 `3/12`；无匹配时 `0/0`；超出 1000 时显示 `N/1000+`
9. **消息列表搜索**：从渲染后 DOM 文本中搜索，跨消息导航，自动滚动到匹配位置
10. **流式响应**：消息内容变化时挂起搜索，停止变化 300ms 后重新搜索；更新中计数显示 `…` 后缀
11. **文件 Markdown 渲染模式**：从渲染后 DOM 文本中搜索并高亮
12. **文件源码模式**：`Ctrl+F` 仍打开已有 `SearchPanel`，行为与改动前一致
13. **HTML WebView / 不支持类型**：`SearchBar` 保持可见但 disabled，显示「当前面板不支持查找」提示；✕ 可关闭
14. **面板切换**：从聊天切到文件 Markdown 渲染时，搜索自动切换到新面板上下文，查询词保留
15. **MessageInput 冲突**：焦点在 `MessageInput` 时 `Ctrl+F` 不打开任何搜索栏
16. **视觉可辨性**：高亮在当前浅色主题下清晰可见（本项目近期版本不考虑暗黑主题）
17. **与侧边栏搜索区分**：`SearchBar`（Ctrl+F 上下文查找）与 `SearchPane`（侧边栏跨会话搜索）入口和交互独立，互不干扰
18. **无障碍**：搜索栏有 `role="search"`；导航时 `aria-live` 区域播报当前匹配位置

---

## 12. 非目标

以下功能不在本次范围内：

- HTML WebView 内的搜索
- 替换功能（仅查找，不替换）
- 搜索历史记录
- 跨会话 / 跨文件全局搜索（由已有 `SearchPane` + `search:execute` 提供，见 1.3）
- 图片内容的 OCR 搜索
- 统一 `SearchPanel` 与 `SearchBar` 的 UI（源码模式继续使用 `SearchPanel`）
- 修改 `SearchPanel` 源码模式的高亮样式
- 暗黑主题适配（近期版本不提供暗黑主题）

---

## 13. 已确认决策

| # | 决策 | 选项 |
|----|------|------|
| 1 | 全局 `SearchBar` + 各面板 adapter 架构 | A |
| 2 | 消息列表从渲染后 DOM 文本搜索 | A |
| 3 | Markdown 渲染模式搜 DOM 文本；HTML WebView 不做搜索 | A |
| 4 | Ctrl+F 打开 / Esc 关闭并清除高亮 | A |
| 5 | Enter/Shift+Enter 跨消息无限循环导航 | A |
| 6 | 查找栏浮动在窗口右上角 | B |
| 7 | 始终固定在主窗口右上角 | B |
| 8 | 流式内容：挂起 + 停止变化后 debounce 300ms | — |
| 9 | `SearchPanel` 保留，源码模式不改动 | — |
| 10 | HTML WebView 时 SearchBar disabled 可见（非隐藏） | — |
| 11 | MessageInput 聚焦时 Ctrl+F 静默忽略 | — |
| 12 | 全词匹配对 CJK 内容自动禁用 | — |
| 13 | 正则错误仅显示 i18n 文案，不透传底层错误 | — |
