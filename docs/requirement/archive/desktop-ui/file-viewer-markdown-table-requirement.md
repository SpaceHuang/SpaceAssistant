# 文件查看器 Markdown 表格渲染与结构化复制 — 需求规格

**版本：** 1.1  
**日期：** 2026-06-19  
**状态：** 待评审  
**关联文档：**
- [file-content-viewer-requirement.md](./file-content-viewer-requirement.md)（文件内容查看器整体需求）
- [llm-wiki-requirement.md](./llm-wiki-requirement.md)（Wiki 文档场景，表格使用频率高）

> **v1.1 相对 v1.0 的主要变更**：复制需求从「仅表格」扩展为**块级 Markdown 结构化复制**——选中内容若包含标题（`#`）、列表（`-` / `1.`）、围栏代码块（` ``` `）、表格、引用等任一结构块，均从源 Markdown 切片输出，支持「一大段混合内容」一次性复制保留格式。

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [问题与目标](#3-问题与目标)
4. [功能需求](#4-功能需求)
5. [技术方案](#5-技术方案)
6. [UI 与样式规格](#6-ui-与样式规格)
7. [交互规格](#7-交互规格)
8. [验收标准](#8-验收标准)
9. [相关文件](#9-相关文件)
10. [实施范围与非目标](#10-实施范围与非目标)

---

## 1. 概述

### 1.1 背景

文件内容查看器在 Markdown **渲染模式**下，通过 `ReactMarkdown` + `remark-gfm` 将 Markdown 解析为 HTML 并展示。存在两类体验问题：

1. **表格样式**：GFM 表格几乎无专用 CSS，视觉上接近浏览器默认渲染，宽表难读。
2. **复制丢格式**：渲染模式下用户拖选一段内容（常跨多个块）复制时，浏览器只写入**渲染后的纯文本**，Markdown 结构符号全部丢失——不仅表格的 `|` 管道符，还包括标题的 `#`、列表的 `-` / `1.`、围栏代码块的 ` ``` `、引用的 `>`、链接的 `[](url)` 语法等。粘贴到编辑器、聊天输入框或 Wiki 文档后需手工补回格式。

### 1.2 功能定位

本需求仅针对**详情面板文件查看器**中 Markdown 文件的**渲染预览**（`viewMode === 'render'`），优化：

1. **表格视觉呈现**：对齐项目暖色设计体系，提升可读性与宽表可用性。
2. **结构化复制（Markdown-preserving copy）**：渲染模式下，当选区与任一**可映射块级节点**相交时，剪贴板 `text/plain` 输出对应源 Markdown 片段，而非 DOM 纯文本。

> **不在本需求范围**：代码模式（`CodeView`）下的复制——该模式展示原始 Markdown 源码，复制行为已天然正确，无需改动。

---

## 2. 现状分析

> 以下均基于当前仓库实现核实，非假设。

### 2.1 渲染链路

```
DetailPanelContext.previewContent（原始 Markdown 字符串）
  └── FileContentView（fileType === 'markdown' && viewMode === 'render'）
        └── MarkdownSearchScope
              └── MarkdownRenderView
                    └── ReactMarkdown
                          remarkPlugins: [remarkGfm, remarkSemanticStatusEmoji]
                          rehypePlugins: [rehypeExternalLinks]
                          components: 自定义 h1–h6、a；其余块级节点使用默认 HTML 元素
```

**关键文件：**

| 组件 / 模块 | 路径 | 职责 |
|-------------|------|------|
| 内容路由 | `src/renderer/components/DetailPanel/FileContentView.tsx` | 按 `fileType`、`viewMode` 选择 `MarkdownRenderView` 或 `CodeView` |
| Markdown 渲染 | `src/renderer/components/DetailPanel/MarkdownRenderView.tsx` | `ReactMarkdown` 渲染，`expandWikilinks` 预处理 |
| 状态与源码 | `src/renderer/components/DetailPanel/DetailPanelContext.tsx` | 持有 `previewContent`（完整源文本）、`viewMode` |
| 样式 | `src/renderer/components/DetailPanel/detailPanel.css` | `.detail-md-render` 仅定义标题 scroll-margin、pre/code 样式 |
| 依赖 | `package.json` | `react-markdown@^9.0.1`、`remark-gfm@^4.0.0` |

### 2.2 当前 Markdown 渲染组件定制情况

`MarkdownRenderView` 仅覆写两类节点：

```tsx
// src/renderer/components/DetailPanel/MarkdownRenderView.tsx
components={{
  ...headingComponents,   // h1–h6：注入 id 供锚点跳转
  a(props) { ... }        // 链接：MarkdownLinkOrStatusDot（Wiki 链接、状态圆点）
}}
```

**未定制**的块级节点（均由 `react-markdown` + `remark-gfm` 默认渲染为 HTML）包括：

| mdast 类型 | 渲染 HTML | 源语法示例 |
|------------|-----------|------------|
| `heading` | `h1`–`h6`（已有定制，但未标注源码偏移） | `# 标题` |
| `paragraph` | `p` | 普通段落 |
| `list` | `ul` / `ol` | `- item` / `1. item` |
| `blockquote` | `blockquote` | `> 引用` |
| `code`（围栏） | `pre` > `code.language-*` | ` ```lang … ``` ` |
| `table` | `table` | GFM 管道表格 |
| `thematicBreak` | `hr` | `---` |
| `html` | 原始 HTML（若源含 inline HTML） | `<details>` 等 |

对比聊天区 `ChatMarkdown`：额外定制了 `pre` / `code`，围栏块走 `ShikiCodeBlock`；**文件查看器无此定制**，代码块为默认 `<pre><code>`（样式见 `detailPanel.css` 中 `pre` / `code` 规则）。

### 2.3 当前样式缺口

`.detail-md-render` 现有规则（`detailPanel.css:289–316`）：

- 标题 `scroll-margin-top`
- 容器 padding、字号、行高、背景色
- `pre` / `code` 代码块样式（背景、圆角、横向滚动）

**无任何 `table`、`th`、`td` 相关规则。** 宽表在窄面板内可能撑破布局，表头与数据行无视觉区分。

文件查看器渲染根节点为 `.detail-md-render`，**未使用**聊天区 `.sa-prose` 类名。

### 2.4 视图模式与默认行为

`DetailPanelContext` 中（`DetailPanelContext.tsx:48–50`）：

```typescript
function defaultViewModeForFileType(fileType: FileTypeCategory | null): ViewMode {
  if (fileType === 'markdown' || fileType === 'html') return 'render'
  return 'code'
}
```

Markdown 文件打开后**默认进入渲染模式**。工具栏切换：`FileToolbar.tsx` 提供「渲染 / 代码 / Index（仅 wiki/index.md）」分段控件。

### 2.5 复制行为（当前）与格式丢失清单

渲染模式下**无**自定义 `copy` 事件处理。用户 Ctrl+C / 右键复制时，浏览器按 DOM 选区生成剪贴板：

| 选中内容（渲染态） | 当前 `text/plain` | 丢失的 Markdown |
|------------------|-------------------|-----------------|
| `## 小节标题` | `小节标题` | `#` 前缀与层级 |
| `- 项 A` / `1. 项 A` | `项 A` | 列表标记与缩进 |
| 围栏代码块 | 代码正文（无围栏、无语言标记） | ` ```lang ` 与结束围栏 |
| GFM 表格 | 制表符/换行分隔的单元格文本 | `\|` 管道符与对齐分隔行 |
| `> 引用文字` | `引用文字` | `>` 前缀 |
| `[链接](url)` | 多为可见文字或 `文字 url` | Markdown 链接语法 |
| 混合大段（标题+列表+代码+表格） | 拼接纯文本，结构全丢 | 全部块级标记 |

| 剪贴板 MIME | 粘贴到 Markdown 编辑器的结果 |
|-------------|------------------------------|
| `text/plain` | 结构丢失，需手工重排 |
| `text/html` | 部分编辑器采用 HTML，与 Markdown 工作流不一致 |

**源码可用性**：`previewContent` 在 Context 中完整保留；`MarkdownRenderView` 实际解析的是 `expandWikilinks(content)` 之后的字符串。渲染过程**未**建立 DOM 节点与源码偏移的映射。

### 2.6 关联能力（不受影响但需知悉）

| 能力 | 实现 | 备注 |
|------|------|------|
| Ctrl+F 查找 | `MarkdownSearchScope` → `fileMarkdownSearchAdapter` → `domSearchAdapter` | DOM 文本搜索；块级标注不应破坏文本节点 |
| PDF 导出 | `FileToolbar.handleExportPdf` → `renderToStaticMarkup(<MarkdownRenderView …>)` | 表格样式与标注属性会进入导出 HTML |
| Wiki Index 视图 | `WikiIndexView` 解析 `wiki/index.md` 为列表 | 非全量 Markdown 渲染，不在范围 |
| wikilink 展开 | `expandWikilinks`（`wikiMarkdown.ts`） | `[[name]]` → `[name](llm-wiki/wiki/name.md)`，复制基准为展开后字符串 |
| 状态 emoji | `remarkSemanticStatusEmoji` | 渲染为 `.sa-md-status-dot` 圆点；复制仍取源片段（含原始 emoji 或源文本） |

---

## 3. 问题与目标

### 3.1 用户痛点

| 场景 | 当前体验 | 期望体验 |
|------|----------|----------|
| 查看含表格的 Wiki / 需求 `.md` | 表格无线框、表头不突出，宽表难读 | 清晰边框、表头区分、宽表可横向滚动 |
| 选中整张表格复制 | 粘贴后变成纯文本列 | 粘贴后为 GFM 表格 |
| 选中含 `#` 标题的一段复制 | 粘贴后无 `#` | 保留 `#` / `##` 等层级标记 |
| 选中列表项复制 | 粘贴后无 `-` 或序号 | 保留列表 Markdown |
| 选中代码块复制 | 粘贴后无 ` ``` ` 围栏 | 保留围栏与语言标识行 |
| 选中「标题 + 段落 + 列表 + 代码 + 表格」大段 | 结构全部丢失 | 一次性粘贴为可编辑 Markdown |
| 切换到代码模式复制 | 已正确 | 保持不变 |

### 3.2 目标

1. 为 `.detail-md-render` 内 GFM 表格提供与 SpaceAssistant 暖色主题一致的样式。
2. 渲染模式下，选区与任一**已标注块级节点**相交时，剪贴板输出**源 Markdown 连续片段**（见 §4.2、§5.2），覆盖表格及标题、列表、代码块、引用等结构。
3. 不破坏现有查找、锚点跳转、Wiki 链接、PDF 导出、代码模式等行为。

### 3.3 非目标

- 不实现块级内容就地编辑。
- 不改变 `CodeView` / 代码模式复制逻辑。
- 不改造 `ChatMarkdown` 聊天区（样式与复制均可列为后续复用任务）。
- 不处理 `WikiIndexView`。
- 不以 `text/html` 作为主交付格式。
- **行内 partial 精细还原**（仅选中一个词并保留 `**bold**`）：本期不做；见 §4.2.5。

---

## 4. 功能需求

### 4.1 表格视觉增强（P0）

#### 4.1.1 适用范围

- 容器：`.detail-md-render` 内由 `remark-gfm` 生成的 `<table>`。
- 视图：仅 Markdown **渲染模式**。

#### 4.1.2 布局与滚动

- 表格外层增加**横向滚动容器**（宽表在详情面板分栏场景下不撑破布局）。
- 表格 `width: 100%`，`border-collapse: collapse`。
- 单元格 `word-break: break-word`。

#### 4.1.3 视觉层次

| 元素 | 要求 |
|------|------|
| 表头行 `th` | 背景 `--sa-bg-muted` 或 `--sa-bg-subtle`，字重略高 |
| 数据行 `td` | 背景 `--sa-split-pane-bg` / `--sa-bg-elevated` |
| 边框 | `--sa-border` / `--sa-border-strong`，1px 实线 |
| 对齐 | 保留 `remark-gfm` 写入的 `text-align` / `align` |

#### 4.1.4 与现有元素协调

- 表格上下 `margin` 与段落、代码块一致（建议 `0.75em 0`）。
- 不引入 Ant Design `Table` 组件。

### 4.2 结构化复制为 Markdown（P0）

#### 4.2.1 设计原则

采用**块级源码映射 + 连续区间切片**，统一处理表格与其余 Markdown 结构，避免为每种块类型单独写 DOM→Markdown 反序列化逻辑。

核心思路：

1. 渲染时为块级 mdast 节点对应的 DOM 元素写入 `data-md-start` / `data-md-end`（字节偏移，对应 `rendered` 字符串）。
2. 复制时收集与选区相交的所有已标注块，按 `start` 排序。
3. 输出 `rendered.slice(firstBlock.start, lastBlock.end)` 作为 `text/plain`。

这样「一大段混合内容」自然保留中间所有 `#`、`-`、` ``` `、`|` 等源语法。

#### 4.2.2 须标注的块级节点

| 组件 key | HTML 元素 | mdast 类型 | 复制须保留的语法 |
|----------|-----------|------------|------------------|
| `h1`–`h6` | 标题（已有定制，扩展标注） | `heading` | `#` … `######` |
| `p` | 段落 | `paragraph` | 段落文本及行内 `**`、`*`、`` ` ``、`[]()` 等 |
| `ul` / `ol` | 列表 | `list` | `-` / `*` / `1.` 及嵌套缩进 |
| `blockquote` | 引用 | `blockquote` | `>` 前缀 |
| `pre` | 围栏代码外层 | `code` | ` ```lang ` … ` ``` ` |
| `table` | 表格（含 wrap） | `table` | GFM 管道表格 |
| `hr` | 分隔线 | `thematicBreak` | `---` / `***` 等 |

**不单独标注** `li`、`td`、`th` 等子节点——复制粒度落在父块（整张表、整个列表、整个代码块等），与 §4.2.4 一致。

#### 4.2.3 触发条件与行为

在 `.detail-md-render`（或 `.detail-md-search-root`）监听 `copy` 事件：

| 选区情况 | 行为 |
|----------|------|
| 与 **零个** 已标注块相交 | **不拦截**，浏览器默认复制 |
| 与 **一个或多个** 已标注块相交 | `preventDefault`，输出 §4.2.1 连续切片 |
| 选区跨多个块（如 h2 → 列表 → 代码 → 表） | 从**第一个**相交块的 `start` 到**最后一个**相交块的 `end` 切片 |
| 选区仅触及某块的一部分（如表格单个单元格、列表一项、代码块一行） | 仍输出该块所属**完整块**；多块时按上条取并集区间 |

**纯行内选区**（仅在单个 `p` 内选中几个词、且用户期望短 snippet）：若与该 `p` 相交，输出**整个段落**源 Markdown（见 §4.2.5）。

#### 4.2.4 剪贴板格式

| MIME | 要求 |
|------|------|
| `text/plain` | **必须**为源 Markdown 片段（含结构符号） |
| `text/html` | 可选；不替代 Markdown 作为主交付 |

粘贴验收：本应用聊天输入框、VS Code / Cursor 中 `.md` 文件、常见 Markdown 编辑器。

#### 4.2.5 粒度与已知限制

| 决策 | 说明 |
|------|------|
| 块级并集切片 | 混合大段复制的核心能力；选中从第二节标题到第三节表格时，中间所有块级语法完整保留 |
| 部分块 → 整块源 | 避免生成缺分隔行/缺围栏/列数不齐的残缺 Markdown |
| 单段落部分选中 → 整段源 | 实现简单且保留行内标记；若用户仅需纯文本，可切代码模式复制 |
| wikilink 已展开 | 复制结果含 `[Title](llm-wiki/wiki/…)` 而非 `[[Title]]`，与当前 `rendered` 一致，需在 UI 上无需提示 |
| 状态 emoji 插件 | 复制取源文本；若源为 emoji 则粘贴为 emoji，若源为其他形式则原样 |
| 嵌套块（引用内列表等） | 标注外层 `blockquote` 即可；切片含嵌套完整源 |
| 任务列表 `- [ ]` | `remark-gfm` 支持；标注 `ul`/`ol` 父级 |

**本期不做：**

- 仅复制列表中某一 `li` 而保留合法缩进（整块列表代替）。
- 仅复制表格中某几行。
- 仅选中 `**加粗**` 两个星号而不带段落其余部分。

#### 4.2.6 与代码模式的关系

- 代码模式不挂载 `.detail-md-render`，**不注册** copy 拦截。
- 代码模式复制行为保持现状。

---

## 5. 技术方案

### 5.1 表格样式实现

纯 CSS + 可选 `table` 组件 wrap：

```tsx
table({ node, children, ...props }) {
  return (
    <div className="detail-md-table-wrap" data-md-start={…} data-md-end={…}>
      <table {...props}>{children}</table>
    </div>
  )
}
```

样式写入 `detailPanel.css`，使用 `--sa-border`、`--sa-bg-muted` 等变量。

### 5.2 结构化复制：块标注与切片

#### 5.2.1 标注方式

`react-markdown@9` 的 `components` 回调接收 `node`（含 `position.start.offset` / `position.end.offset`）。

**推荐**：抽取共用 helper，避免重复：

```typescript
function withMdSource<T extends keyof JSX.IntrinsicElements>(
  Tag: T,
  node: { position?: { start: { offset?: number }; end: { offset?: number } } }
) {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return {
    'data-md-start': start,
    'data-md-end': end
  } as const
}
```

在 `h1`–`h6`、`p`、`ul`、`ol`、`blockquote`、`pre`、`table`（或 wrap）、`hr` 组件中写入上述属性。

**标题组件**：在现有 `markdownHeading` 工厂中合并 `node` 参数与 `data-md-*`。

**代码块**：`MarkdownRenderView` 当前未拆分 `pre`/`code`；标注挂在 `pre` 对应 mdast `code` 节点（围栏含 ` ``` ` 行）。

**列表**：标注 `ul`/`ol` 根元素，不逐 `li` 标注。

#### 5.2.2 复制处理器

挂载于 `containerRef`（`useEffect` + cleanup），参考 `xtermHelpers.ts` 中 `attachShellTerminalCopy` 模式：

```typescript
function buildMarkdownCopyText(
  rendered: string,
  container: HTMLElement,
  selection: Selection
): string | null {
  const range = selection.rangeCount ? selection.getRangeAt(0) : null
  if (!range || range.collapsed) return null

  const blocks = [...container.querySelectorAll('[data-md-start][data-md-end]')]
    .filter((el) => range.intersectsNode(el))
    .map((el) => ({
      start: Number(el.getAttribute('data-md-start')),
      end: Number(el.getAttribute('data-md-end'))
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a.start - b.start)

  if (blocks.length === 0) return null

  const from = blocks[0].start
  const to = blocks[blocks.length - 1].end
  return rendered.slice(from, to)
}
```

`copy` 事件：`const text = buildMarkdownCopyText(...)`；若 `text != null` 则 `preventDefault` + `setData('text/plain', text)`。

#### 5.2.3 源字符串基准

```typescript
const rendered = expandWikilinks(content, wikiRootPath)
// ReactMarkdown children={rendered}
```

`rendered` 存于 `useRef`，供 copy 处理器与 mdast offset 对齐。**不得**用磁盘原始 `previewContent` 切片（wikilink 未展开时偏移不一致）。

#### 5.2.4 与查找、PDF 的兼容

- 块标注属性在块容器上，不改变文本节点布局；`data-md-*` 不影响 `extractDomSearchText`。
- PDF 导出忽略 `data-md-*`；表格 wrap 样式须打印可读。

### 5.3 测试建议

| 类型 | 内容 |
|------|------|
| 单元测试 | `buildMarkdownCopyText`：mock DOM + selection，多块并集切片 |
| 单元测试 | 各块类型 offset 标注 helper |
| 组件测试 | 渲染含 h2 + ul + pre + table 的 MD，模拟 copy 输出与源一致 |
| 手动 | 大段混合选中 → 粘贴到 `.md`；宽表滚动；Ctrl+F 命中各块内文本 |

---

## 6. UI 与样式规格

### 6.1 结构示意

```
.detail-md-render
  ├── h2[data-md-start][data-md-end]
  ├── p[data-md-start][data-md-end]
  ├── ul[data-md-start][data-md-end]
  ├── pre[data-md-start][data-md-end]
  │     └── code.language-ts
  └── .detail-md-table-wrap[data-md-start][data-md-end]
        └── table
```

### 6.2 表格 CSS 变量

| 用途 | 变量 |
|------|------|
| 边框 | `--sa-border`、`--sa-border-strong` |
| 表头背景 | `--sa-bg-muted` |
| 正文背景 | `--sa-split-pane-bg` |
| 文字 | `--sa-text` |

---

## 7. 交互规格

| 操作 | 行为 |
|------|------|
| 拖选任意含结构块的内容 | 视觉选区与现有一致 |
| Ctrl+C / Cmd+C | 选区触达已标注块时，写入 Markdown 源片段（§4.2） |
| 右键 → 复制 | 同上 |
| 仅选纯文本且不在已标注块内（理论上不应出现） | 浏览器默认 |
| 渲染 ↔ 代码切换 | copy 行为随模式切换，无需提示 |

无需新增工具栏按钮或 i18n 文案。

---

## 8. 验收标准

### 8.1 表格样式

- [ ] 含 GFM 表格的 `.md` 渲染模式：边框、表头区分、宽表横向滚动。
- [ ] 对齐分隔行（`:---` 等）渲染正确。

### 8.2 结构化复制

- [ ] 仅选表格内单元格 → 粘贴为完整 GFM 表格。
- [ ] 仅选标题文字 → 粘贴含 `#` / `##` 前缀。
- [ ] 仅选列表项 → 粘贴含 `-` 或 `1.` 及正确缩进。
- [ ] 仅选代码块内一行 → 粘贴含 ` ```lang ` 围栏与完整代码正文。
- [ ] 选中「h2 + 段落 + 列表 + 代码 + 表格」跨块大段 → 粘贴为连续合法 Markdown，顺序与源文件一致。
- [ ] 选区不含任何已标注块 → 与升级前默认复制一致。
- [ ] 代码模式复制 → 仍为完整源 Markdown，行为不变。
- [ ] wikilink 文档：复制结果与 `expandWikilinks` 后内容一致。

### 8.3 回归

- [ ] Ctrl+F 可在标题、列表、代码、表格内搜索并高亮。
- [ ] 标题锚点、Wiki 链接跳转正常。
- [ ] PDF 导出含表格文档可读。
- [ ] `npm test` 通过，覆盖 `buildMarkdownCopyText` 与块标注。

---

## 9. 相关文件

| 文件 | 变更类型 |
|------|----------|
| `src/renderer/components/DetailPanel/MarkdownRenderView.tsx` | 修改：块级 components 标注、copy 监听、`rendered` ref |
| `src/renderer/components/DetailPanel/detailPanel.css` | 修改：表格样式 |
| `src/renderer/utils/markdownRenderCopy.ts` | 新增：`buildMarkdownCopyText`、`mdSourceAttrs` 等 |
| `src/renderer/utils/markdownRenderCopy.test.ts` | 新增 |
| `src/renderer/components/DetailPanel/MarkdownRenderView.test.tsx` | 新增（建议） |

---

## 10. 实施范围与非目标

### 10.1 建议分期

| 阶段 | 内容 |
|------|------|
| P0 | 表格 CSS + 全块级 `data-md-*` 标注 + `copy` 连续切片 |
| P1 | 边界用例单测补全（嵌套引用、任务列表、空块） |
| P2（可选） | 块标注 helper / 表格样式抽取供 `ChatMarkdown` 复用 |

### 10.2 核实记录

| 陈述 | 核实来源 |
|------|----------|
| 渲染使用 `remark-gfm`，块级节点大多未定制 | `MarkdownRenderView.tsx:73–93` |
| 文件查看器代码块为默认 pre/code，非 Shiki | 对比 `ChatMarkdown.tsx:36–53` |
| `.detail-md-render` 无 table 样式 | `detailPanel.css:289–316` |
| 默认渲染模式 | `DetailPanelContext.tsx:48–50` |
| wikilink 在渲染前展开 | `MarkdownRenderView.tsx:46`、`wikiMarkdown.ts:1–8` |
| 无 copy 拦截 | `DetailPanel` 目录无 clipboard 处理 |
| PDF 导出复用 `MarkdownRenderView` | `FileToolbar.tsx:137–139` |

---

**文档结束**
