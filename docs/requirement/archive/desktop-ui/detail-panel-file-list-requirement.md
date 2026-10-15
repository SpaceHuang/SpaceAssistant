# 右侧详情栏文件列表 — 需求规格

**版本：** 1.2  
**日期：** 2026-06-01  
**状态：** 待评审  
**关联文档：** [file-pane-tree-requirement.md](./file-pane-tree-requirement.md)、[file-content-viewer-requirement.md](./file-content-viewer-requirement.md)、[referenced-files-requirement.md](./referenced-files-requirement.md)、[llm-wiki-requirement.md](./llm-wiki-requirement.md)、[remove-plan-mode-requirement.md](./remove-plan-mode-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-06-01 | 初稿：项目文件列表迁入 detail-panel-top |
| 1.1 | 2026-06-01 | §4.2 决议：LLM Wiki 采用方案 C，左侧保留精简「Wiki」Tab |
| 1.2 | 2026-06-01 | §5.1 / §11.2：Wiki Tab 图标选定 `education/book_2_ai`（line + fill） |

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [目标布局](#3-目标布局)
4. [迁移范围](#4-迁移范围)
5. [左侧栏变更](#5-左侧栏变更)
6. [右侧栏详细规格](#6-右侧栏详细规格)
7. [交互与导航变更](#7-交互与导航变更)
8. [与文件预览的关系](#8-与文件预览的关系)
9. [组件与代码结构](#9-组件与代码结构)
10. [样式与无障碍](#10-样式与无障碍)
11. [待决事项](#11-待决事项)
12. [非目标](#12-非目标)
13. [验收标准](#13-验收标准)
14. [关联文档修订清单](#14-关联文档修订清单)

---

## 1. 概述

### 1.1 功能定位

将当前位于 **左侧栏「文件」Tab** 中的 **项目文件列表**（`FileTree` 及其工具栏），迁移至 **右侧详情面板上半区**（`detail-panel-top`），与下半区的「引用的文件」并列展示。

用户在对话过程中浏览、选中、管理项目文件时，**无需为查看项目文件而在左侧活动栏切换 Tab**，会话列表与聊天区保持可见，项目文件操作与内容预览集中在右侧栏完成。

**LLM Wiki** 仍保留在左侧栏独立 **「Wiki」Tab**（仅 Wiki 树，不含项目文件列表），与项目文件浏览分离；Wiki 未启用时不显示该 Tab。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 对话过程中可在右侧栏直接浏览项目文件树，减少左侧 Tab 切换 |
| G2 | 文件树点击 → 文件预览的链路保持在右侧栏内闭环（树在上、预览全屏覆盖、引用文件在下） |
| G3 | 复用现有 `FileTree` / `FileTreeToolbar` 能力，不重写树逻辑 |
| G4 | 搜索、工具卡片、引用文件列表等既有「打开文件」入口，不再强制跳转左侧 Tab（项目文件在右侧选中；Wiki 路径仍切至 Wiki Tab） |
| G5 | 与 `ReferencedFilesPanel`、飞书远程状态栏、`ResizeHandle` 分栏机制兼容 |
| G6 | Wiki 浏览独立保留在左侧「Wiki」Tab，不与右侧项目文件树混排 |

### 1.3 设计原则

- **会话优先**：左侧栏专注会话管理、Wiki 浏览与搜索；**项目文件**浏览归属右侧「工作上下文」区域。
- **行为一致**：文件树的单击、右键、拖拽、新建/删除/重命名等行为与 [file-pane-tree-requirement.md](./file-pane-tree-requirement.md) 保持一致，仅变更挂载位置。
- **预览优先于树**：打开文件预览时仍采用全栏 `FileOverlay`（与 [referenced-files-requirement.md §3.4](./referenced-files-requirement.md) 一致），预览期间文件树暂不可见；关闭预览后恢复上下分栏。

---

## 2. 现状与问题

### 2.1 当前布局

```text
┌─ 左侧栏 ─────────┬─ 中间聊天区 ─────┬─ 右侧 DetailPanel ─────┐
│ Activity Bar     │                  │ selectedFile 为空时：     │
│  · 会话          │   ChatView       │  ├ detail-panel-top      │
│  · 文件 ← FilePane│                  │  │   「暂无详情」空态      │
│  · 搜索          │                  │  ├ ResizeHandle           │
│                  │                  │  ├ detail-panel-bottom    │
│                  │                  │  │   ReferencedFilesPanel │
│                  │                  │  └ FeishuRemoteStatusBar  │
│                  │                  │ selectedFile 非空时：     │
│                  │                  │  └ FileOverlay（全栏）    │
└──────────────────┴──────────────────┴──────────────────────────┘
```

### 2.2 左侧「文件」Tab 现有内容

`FilePane`（`src/renderer/components/FilePane/FilePane.tsx`）包含：

| 区块 | 组件 | 说明 |
|------|------|------|
| 顶栏 | `FileTreeToolbar` | 标题「文件」+ 新建目录 / 刷新 |
| 上段 | `FilePaneSection`「文件列表」+ `FileTree` | **本次迁移主体** |
| 下段 | `FilePaneSection`「LLM Wiki」+ `FileTree` | Wiki 独立树（启用 Wiki 时） |
| — | 段间 `ResizeHandle` | 调节文件列表与 Wiki 高度比 |

### 2.3 用户痛点

1. **Tab 切换频繁**：对话中 Agent 提到某文件、用户想对照查看或手动打开文件时，需从「会话」切到「文件」，再切回「会话」继续输入。
2. **上下文割裂**：左侧栏在同一时刻只能展示会话列表或文件树之一，文件浏览与多会话切换无法并行。
3. **右侧栏上半区闲置**：`detail-panel-top` 在移除 Plan 模式后仅为「暂无详情」空态（见 [remove-plan-mode-requirement.md §4.2](./remove-plan-mode-requirement.md)），空间利用率低。
4. **间接导航成本高**：搜索命中文件、聊天内文件链接、`ReferencedFilesPanel` 点击等路径会调用 `setSiderKey('files')` 强制切换左侧 Tab（`App.tsx` `handleSearchFileClick`），打断当前左侧视图。

---

## 3. 目标布局

### 3.1 迁移后整体结构

```text
┌─ 左侧栏 ─────────────┬─ 中间聊天区 ─────┬─ 右侧 DetailPanel ──────────────┐
│ Activity Bar         │                  │ selectedFile 为空时：              │
│  · 会话              │   ChatView       │  ├ detail-panel-top             │
│  · Wiki（Wiki 启用时）│                  │  │   项目文件树 + 工具栏         │
│  · 搜索              │                  │  ├ ResizeHandle                  │
│  （移除原「文件」Tab）│                  │  ├ detail-panel-bottom           │
│                      │                  │  │   ReferencedFilesPanel        │
│                      │                  │  └ FeishuRemoteStatusBar         │
│                      │                  │ selectedFile 非空时：              │
│                      │                  │  └ FileOverlay（全栏，不变）       │
└──────────────────────┴──────────────────┴──────────────────────────────────┘
```

### 3.2 `detail-panel-top` 内容结构

```text
detail-panel-top
├── 顶栏（detail-panel-file-header）
│   ├── 标题：「文件」
│   └── FileTreeToolbar（新建目录、刷新）
└── 可滚动区域
    └── FileTree（embedded，项目根目录树）
```

- 移除 `detail-panel-top--empty` 空态及「暂无详情」文案（有文件树时不再显示）。
- 容器保留 `role="region"`，`aria-label` 建议改为 **「项目文件」**。

### 3.3 与下半区的关系

| 区域 | 职责 | 数据来源 |
|------|------|----------|
| **上半区** | 主动浏览：用户从项目树中查找、打开、管理文件 | 文件系统 + `FileTree` |
| **下半区** | 被动汇总：当前会话 Agent 已读写的文件 | 工具调用记录 → `ReferencedFilesPanel` |

两者互补：上半区是完整项目视图；下半区是会话相关的「最近涉及文件」快捷入口。

---

## 4. 迁移范围

### 4.1 纳入迁移（必须）

| 项 | 说明 |
|----|------|
| `FileTree`（项目根树） | 含懒加载、选中态、右键菜单、拖拽、Wiki 收录入口等 |
| `FileTreeToolbar` | 新建目录、刷新（行为不变） |
| 段标题语义 | 顶栏标题「文件」替代原 `FilePaneSection`「文件列表」折叠头 |
| `filePaneNavigation` 订阅 | `subscribeFilePaneSelect` 改由右侧文件树组件挂载 |
| `filePanePrefs` 中文件列表相关 UI 状态 | 若仅服务左侧 FilePane，评估废弃或迁移（见 §11） |

### 4.2 LLM Wiki 分段 — **方案 C（已决议）**

当前 `FilePane` 下半段为 **LLM Wiki** 独立树。经评审，Wiki **不迁入** `detail-panel-top`，以避免右侧栏纵向堆叠过多（项目文件树 + Wiki 树 + 引用文件）。

**决议：方案 C — 左侧保留精简「Wiki」Tab**

| 项 | 说明 |
|----|------|
| 位置 | 左侧 Activity Bar + 内容区，替代原「文件」Tab 中与 Wiki 相关的部分 |
| 内容 | **仅** LLM Wiki 树（原 `FilePane` 下段 `FileTree`，`rootRelPath: wikiRoot`，只读） |
| 可见性 | `config.wiki.enabled === true` 时显示 Wiki Tab；未启用 Wiki 时不显示该 Tab |
| 不包含 | 项目文件列表、`FileTreeToolbar` 新建目录/刷新（Wiki 树只读，工具栏仅保留「打开」与「刷新」） |
| 预览 | 单击 Wiki 内文件 → 仍走 `openFile`，在右侧 `FileOverlay` 预览（与项目文件一致） |

**未采纳方案备忘：**

| 方案 | 未采纳原因 |
|------|-----------|
| A（Wiki 迁入 detail-panel-top） | 右侧上半区过于拥挤 |
| B（取消独立 Wiki 树面板） | Wiki 浏览路径过少，与现有 llm-wiki 产品预期不符 |

### 4.3 不迁移 / 不变

| 项 | 说明 |
|----|------|
| `FileOverlay` / `FileContentView` | 预览逻辑、工具栏、快捷键不变 |
| `ReferencedFilesPanel` | 仍在 `detail-panel-bottom` |
| `FeishuRemoteStatusBar` | 仍在分栏最底部 |
| `ResizeHandle`（detail-panel 级） | 仍调节「上半区（文件）」与「下半区（引用文件）」比例 |
| 后端 IPC | 无新增；沿用现有 `file:*` / `wiki:*` 通道 |

---

## 5. 左侧栏变更

### 5.1 「文件」Tab → 「Wiki」Tab（条件显示）

- 自 Activity Bar **移除**原文件夹图标「文件」Tab（`siderKey === 'files'`）。
- 当 `config.wiki.enabled === true` 时，新增 **「Wiki」** Activity Bar 入口（`siderKey === 'wiki'`）。
- `siderKey` 类型由 `'sessions' | 'files' | 'search'` 改为 `'sessions' | 'wiki' | 'search'`（Wiki 未启用时不含 `'wiki'` 分支，运行时仍为 `'sessions' | 'search'`）。
- 移除 `App.tsx` 中对完整 `FilePane` 的条件渲染。

**Activity Bar 顺序（Wiki 启用时）：** 会话 → Wiki → 搜索

**图标（已选定）：** 使用 Mingcute **`book_2_ai`** 系列——书本 + AI 星形，与「LLM Wiki」语义一致，且与会话（chat）、搜索（search）、原文件夹（folder）图标明显区分。

| 状态 | 源文件（`res/mingcute-icons-main/svg/`） | 运行时资产（`src/renderer/assets/`） |
|------|------------------------------------------|--------------------------------------|
| 未选中 | `education/book_2_ai_line.svg` | `book_2_ai_line.svg` |
| 选中 | `education/book_2_ai_fill.svg` | `book_2_ai_fill.svg` |

实现时与其他 Activity Bar 图标一致：

1. 从 `res/mingcute-icons-main/svg/education/` 复制至 `src/renderer/assets/`；
2. 在 `App.tsx` 以 `?raw` 导入；
3. 经现有 `patchSvg` 将 `fill="#09244B"` / `fill="#09244b"` 替换为 `fill="currentColor"`；
4. 传入 `IconTab`：`title="Wiki"`。

**备选（未采用）：** `education/book_3`（层叠书本）——更偏通用「文档库」，缺少 AI 语义；`education/bookmarks`——更偏书签收藏，与 Wiki 知识库含义弱相关。

### 5.2 左侧「Wiki」Tab 内容区

新建 **`WikiPane`**（或自 `FilePane` 拆分），结构如下：

```text
WikiPane
├── app-pane-header
│   ├── 标题：「Wiki」
│   └── 操作区：刷新 Wiki 树、「打开」Wiki 根目录（等同现 FilePane Wiki 段 headerExtra）
└── 可滚动区域
    ├── wikiInitialized === false → 占位 +「初始化 Wiki」按钮
    └── wikiInitialized === true  → FileTree（只读，rootRelPath = wiki.rootPath）
```

| 对比原 FilePane | Wiki Tab |
|-----------------|----------|
| 项目文件树 | **无** |
| `FileTreeToolbar`（新建目录） | **无** |
| LLM Wiki 树 | **有**（占满内容区） |
| 段间 ResizeHandle / `FilePaneSection` 折叠 | **无**（单段全高，无需 Section 头） |
| `filePanePrefs` 双段高度比 | **废弃** Wiki 相关分段 prefs；Wiki Tab 不再读写 `fileListHeightRatio` 等 |

### 5.3 左侧栏顶栏规则

- 会话 / 搜索 Tab：始终显示统一顶栏（标题 + 操作按钮），删除原 `siderKey !== 'files'` 的特殊判断。
- Wiki Tab：显示「Wiki」标题 + 刷新 / 打开按钮；**无**「新会话」类按钮。

### 5.4 空状态与引导

- 首次升级无数据迁移；项目文件选中态非持久化，Wiki 树展开态同现网。
- 发版说明建议注明：**项目文件 → 右侧栏上方**；**LLM Wiki → 左侧 Wiki Tab**（启用 Wiki 时）。

---

## 6. 右侧栏详细规格

### 6.1 默认高度分配

当前 `referencedFilesHeight` 默认 `0.46`（上 54% / 下 46%）。迁入文件树后建议调整：

| 场景 | `referencedFilesHeight` 默认值 | 上半区（项目文件树） | 下半区（引用文件） |
|------|----------------------------------|----------------------|---------------------|
| 迁移后默认 | `0.38` | 62% | 38% |

- 双击 `ResizeHandle` 重置为上述新默认值（替换原 `0.46`）。
- 最小高度约束不变：每区 ≥ 80px（与 referenced-files 需求一致）。

### 6.2 文件树在 `detail-panel-top` 内的布局

- `detail-panel-top` 使用 `display: flex; flex-direction: column; min-height: 0`（已有）。
- 顶栏 `detail-panel-file-header`：`height` 对齐 `--sa-pane-header-height`（与 `app-pane-header` 一致），底部分割线。
- 树区域：`flex: 1; min-height: 0; overflow: auto`。
- **不**在 `detail-panel-top` 外再套一层 `app-pane-header`（避免与 DetailPanel  grid 行高冲突）。

### 6.3 工具栏行为

与 [file-pane-tree-requirement.md §3](./file-pane-tree-requirement.md) 一致：

| 按钮 | 行为 |
|------|------|
| 新建目录 | 在当前选中目录或根目录创建 |
| 刷新 | 仅刷新 **右侧** 项目文件树（Wiki 树刷新在左侧 Wiki Tab 内独立操作） |

> 注：当前 `FileTreeToolbar` 未暴露「新建文件」按钮（与需求文档 §3 表略有差异），以 **现网实现为准**，本需求不新增按钮。

### 6.4 选中态与预览联动

- 单击文件节点：调用 `DetailPanelContext.openFile(relPath)`，进入 `FileOverlay` 全栏预览。
- 选中态（`selectedKey`）在文件树中高亮；关闭预览（`closeFile()`）后选中态保留，树恢复可见。
- 打开预览 **不** 清空文件树内部展开/折叠状态。

### 6.5 与 Wiki 的边界

- **右侧** `detail-panel-top` **不包含** Wiki 树或 Wiki Section。
- `hideWikiFromFileTree === true` 时，右侧项目文件树仍 **不展示** `wiki.rootPath` 目录（行为不变）。
- Wiki 初始化、浏览、刷新均在左侧 **Wiki Tab**（§5.2）完成。

---

## 7. 交互与导航变更

### 7.1 需修改的调用点

| 入口 | 现状 | 变更后 |
|------|------|--------|
| 搜索 → 项目文件结果点击 | `setSiderKey('files')` + `requestFilePaneSelect` + `openFile` | **移除** `setSiderKey('files')`；保留 `requestFilePaneSelect` + `openFile`（右侧树选中） |
| 搜索 → Wiki 路径结果点击 | 同左 | `setSiderKey('wiki')` + `requestFilePaneSelect({ preferWiki: true })` + `openFile` |
| `ChatView` 内文件路径点击 | `requestFilePaneSelect` | 不变；`preferWiki` 时左侧切 Wiki Tab，否则仅右侧项目树响应 |
| `ReferencedFilesPanel` 点击 | `openFile` | 不变 |
| `ToolCallCard` 等 | 经 `openFile` 或 `requestFilePaneSelect` | 不变 |

### 7.2 `filePaneNavigation` 服务

- 保持 `requestFilePaneSelect` / `subscribeFilePaneSelect` 机制，**解耦**「树在哪个面板」与「谁请求选中某路径」。
- 订阅者拆为两个：
  - **右侧** `DetailPanelFileList`：处理项目文件路径（`preferWiki !== true` 或路径不在 Wiki 根下）；
  - **左侧** `WikiPane`：处理 `preferWiki === true` 或 `isUnderWikiRoot(relPath)` 的路径。
- 收到 `requestFilePaneSelect` 时：

  **项目文件路径：**
  1. 调用 `FileTree.selectPath(relPath)`（右侧树）；
  2. 更新右侧 `selectedKey`；
  3. **不**切换左侧 Tab。

  **Wiki 路径（`preferWiki` 或路径在 Wiki 根下且 Wiki 已启用）：**
  1. `setSiderKey('wiki')`；
  2. 调用 WikiPane 内 `FileTree.selectPath(relPath)`；
  3. 更新 Wiki 树 `selectedKey`；
  4. 清空右侧项目树选中态（可选，避免双高亮）。

### 7.3 键盘与焦点

- 文件树内联编辑（新建/重命名）行为不变。
- 不要求为文件 Tab 保留全局快捷键（原无独立快捷键）。

---

## 8. 与文件预览的关系

### 8.1 布局切换（维持现规）

与 [referenced-files-requirement.md §3.4](./referenced-files-requirement.md) **保持一致**：

```text
selectedFile 为空：
┌─────────────────────┐
│ 项目文件树           │  ← detail-panel-top（不含 Wiki）
├─────────────────────┤
│ 引用的文件           │  ← detail-panel-bottom
├─────────────────────┤
│ 飞书远程状态         │
└─────────────────────┘

selectedFile 非空：
┌─────────────────────┐
│ FileOverlay（全栏）  │
│ 工具栏 + 内容        │
└─────────────────────┘
```

### 8.2 关闭预览后的恢复

- 恢复迁移前的上下分栏比例（内存态，非持久化）。
- 文件树滚动位置、展开节点、选中项 **保持不变**。

### 8.3 不在本次范围

- 预览时左侧保留窄条文件树（分屏预览 + 树并存）。
- 在 `FileOverlay` 工具栏增加「文件树侧栏」开关。

---

## 9. 组件与代码结构

### 9.1 建议组件划分

| 组件 / 模块 | 职责 |
|-------------|------|
| `DetailPanelFileList`（新建） | 挂载于 `detail-panel-top`；顶栏 + 项目根 `FileTree` |
| `WikiPane`（新建） | 挂载于左侧 Wiki Tab；Wiki 只读 `FileTree` + 初始化占位 |
| `DetailPanel/index.tsx` | `selectedFile` 为空时在 top 渲染 `DetailPanelFileList`，替代空态 div |
| `FilePane` | **删除**；逻辑拆分至 `DetailPanelFileList` + `WikiPane` |
| `App.tsx` | `files` Tab → 条件渲染 `wiki` Tab；`handleFileSelect` / `handleCollectToWiki` 下沉或通过 props 传递 |

### 9.2 Props 与 Context

`DetailPanelFileList` 建议接收或通过 hook 获取：

```typescript
type DetailPanelFileListProps = {
  workDir: string
  onFileSelect: (relPath: string) => void  // 通常绑定 openFile
  onCollectToWiki?: (relPath: string) => void
}
```

- `workDir` 来自 `config.workDir`。
- `onCollectToWiki` 逻辑可从 `App.tsx` 原 `handleCollectToWiki` 平移。

### 9.3 样式

| 文件 | 变更 |
|------|------|
| `detailPanel.css` | 新增 `.detail-panel-file-header`、`.detail-panel-file-body`；移除或保留 `.detail-panel-top--empty`（无内容时使用） |
| `filePane.css` | 类名复用或迁移为 `detail-panel-file-*` 前缀；避免左侧栏遗留样式 |

### 9.4 测试影响

| 测试 | 调整 |
|------|------|
| `filePaneNavigation.test.ts` | 不变（服务层） |
| `DetailPanelContext.test.tsx` | 补充 top 区渲染文件树的相关断言（可选） |
| 若有 `FilePane` 快照 / 集成测试 | 迁移至 `DetailPanelFileList` |

---

## 10. 样式与无障碍

| 项 | 要求 |
|----|------|
| 区域标签 | `detail-panel-top`：`role="region"`，`aria-label="项目文件"` |
| 顶栏标题 | 可见文本「文件」，字号/字重对齐 `app-pane-header-title` |
| 滚动 | 树区域独立滚动；不在整个 `detail-panel-split` 上滚动 |
| 窄屏 | 右侧栏 `minSize` 180px 不变；树横向溢出使用省略号（与现 FileTree 一致） |
| 对比度 / 选中行 | 沿用 FileTree 现有 token，不另定规范 |

---

## 11. 待决事项

### 11.1 `filePanePrefs` 存储键

- 原 `FilePaneSectionUiState`（双段折叠/高度比）在方案 C 下 **大部分废弃**：
  - 右侧项目文件树为单段全高，**不再读写** `fileListCollapsed` / `fileListHeightRatio`；
  - 左侧 Wiki Tab 为单段全高，**不再读写** `llmWikiCollapsed`；
  - 实现时可删除 `filePanePrefs` 或保留键名仅作向后兼容空读（无 UI 绑定）。

### 11.2 右侧栏默认宽度

- 现默认 240px。迁入文件树后，是否将 `defaultSize` 提高到 280～320px **可选**；非阻塞项，可在实现阶段按体验微调。

---

## 12. 非目标

- 重写 `FileTree` 或变更树交互规格（仍遵循 file-pane-tree-requirement）
- 在 `detail-panel-top` 嵌入文件 **内容** 预览（预览仍由 `FileOverlay` 全栏承担）
- 合并「项目文件树」与「引用的文件」为单一列表
- 支持多工作区 / 多根目录
- 文件 Tab 快捷键（如 VS Code `Ctrl+Shift+E`）——本期不做
- 在 `detail-panel-top` 嵌入 Wiki 树（Wiki 固定走左侧 Wiki Tab，方案 C）
- 修改 `ReferencedFilesPanel` 的数据采集与过滤规则

---

## 13. 验收标准

### 13.1 布局与迁移

1. 左侧 Activity Bar **无**原「文件」图标；会话与搜索 Tab 正常。
2. `selectedFile` 为空时，`detail-panel-top` 展示**项目**文件树 + 工具栏，**无**「暂无详情」空态；**不含** Wiki 树。
3. 右侧项目文件树能力完整：展开/折叠、选中预览、右键菜单、拖拽、新建目录、刷新、删除确认、重命名。
4. Wiki 启用时，左侧 Activity Bar 显示「Wiki」Tab；内容为 Wiki 只读树 + 初始化占位，**无**项目文件列表；刷新 / 打开 Wiki 根目录可用。
5. Wiki 未启用时，左侧 **无** Wiki Tab，布局与现网两 Tab（会话 + 搜索）一致。

### 13.2 导航

6. 搜索命中**项目**文件：右侧打开预览，**左侧仍停留在搜索或会话 Tab**。
7. 搜索 / 聊天内点击 **Wiki 路径**：左侧切至 Wiki Tab 并选中节点，右侧 `openFile` 预览。
8. `ReferencedFilesPanel` 点击：右侧预览；若为 Wiki 路径且 Wiki 启用，同步左侧 Wiki Tab 选中（与现 `preferWiki` 逻辑一致）。
9. `requestFilePaneSelect` 在目标树未挂载时排队；挂载后仍能正确选中路径。

### 13.3 预览与分栏

10. 打开文件后 `FileOverlay` 仍占满整个右侧栏；关闭后恢复项目文件树 + 引用文件分栏。
11. `ResizeHandle` 可拖动；双击重置为 §6.1 新默认值；飞书状态栏始终贴底可见（未预览时）。

### 13.4 回归

12. 「收录到 Wiki」右键/工具栏入口在**右侧**项目文件树上下文菜单中仍可用。
13. `hideWikiFromFileTree === true` 时，右侧项目树仍不展示 Wiki 根目录。
14. 无 `workDir` 或目录不可读时，右侧文件树展示友好错误/空态，不导致 DetailPanel 崩溃。

---

## 14. 关联文档修订清单

| 文档 | 修订内容 |
|------|----------|
| [referenced-files-requirement.md](./referenced-files-requirement.md) | §3.3.1 上半区由「占位符」改为「项目文件树」（不含 Wiki） |
| [remove-plan-mode-requirement.md](./remove-plan-mode-requirement.md) | §4.2 空态说明由「暂无详情」更新为「由 detail-panel-file-list 需求接管上半区」 |
| [file-pane-tree-requirement.md](./file-pane-tree-requirement.md) | §8 组件结构：项目树 → DetailPanel；§11 与 Wiki 关系改为独立 Wiki Tab |
| [llm-wiki-requirement.md](./llm-wiki-requirement.md) | §10.1 文件 Tab 双分段 → **左侧 Wiki Tab 单段** + 右侧项目文件树 |
| [file-content-viewer-requirement.md](./file-content-viewer-requirement.md) | §2 现状：打开入口补充「右侧项目文件树 / 左侧 Wiki 树」 |
| [product_requirement.md](./product_requirement.md) | §4.2 左侧 Tab：「文件」→「Wiki」（条件显示）；§4.4 右侧栏补充项目文件树 |

---

*文档结束*
