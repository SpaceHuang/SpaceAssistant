# LLM Wiki 功能 — 普通用户视角可用性分析

**分析日期：** 2026-06-01  
**分析方法：** 以普通用户视角，结合当前项目实际代码实现，模拟首次使用和日常使用两个阶段，识别"不会用"和"不好用"的场景。

---

## 一、分析方法说明

本分析模拟一位**不了解 Karpathy LLM Wiki 概念**、**不熟悉命令行**、**对 AI 工具抱有"聊天即所得"期望**的普通用户。分析覆盖完整的用户旅程：发现功能 → 首次配置 → 首次使用 → 日常使用 → 遇到问题。

每个场景标注：
- 🔴 **阻断**：用户卡住，无法继续
- 🟡 **困惑**：用户能继续但不确定做得对不对
- 🟢 **不便**：能用但体验差，可能放弃使用

---

## 二、场景分析

### 场景 1：发现 Wiki 功能

**用户状态：** 打开 SpaceAssistant，看到左侧活动栏有会话、搜索、设置三个图标。

**问题：** 🔴 Wiki 功能默认关闭，活动栏不显示 Wiki 图标。

**实际代码：** `App.tsx:224` — Wiki 图标仅在 `wikiEnabled` 为 true 时渲染：
```tsx
{wikiEnabled ? (
  <IconTab ... active={siderKey === 'wiki'} title="Wiki" />
) : null}
```

**用户困境：** 用户根本不知道有这个功能存在。只有主动打开设置 → 翻到 Wiki 标签页 → 开启开关，才能看到 Wiki 入口。没有任何功能发现引导（如设置页的"新功能"提示、首次启动的介绍等）。

**建议：** 即使 Wiki 未启用，也可在活动栏显示 Wiki 图标（灰色/虚线），点击后引导至设置页开启。

---

### 场景 2：首次配置 Wiki

**用户状态：** 在设置中找到 Wiki 标签页，看到一系列配置项。

**问题 1：** 🟡 配置项含义不清晰。

**实际代码：** `WikiTab.tsx` 展示了 5 个配置项 + 1 个按钮：
- "启用 LLM Wiki" — 什么是 LLM Wiki？
- "Wiki 根路径（相对工作目录）" — 什么是工作目录？相对路径是什么？
- "从文件列表隐藏 Wiki 目录" — 为什么要隐藏？隐藏后去哪找？
- "Ingest 前与用户交互确认要点" — Ingest 是什么？
- "批量 Ingest 单批上限" — 完全不知所云

**用户困境：** 每个选项都用了领域术语（LLM、Wiki、Ingest），普通用户无法判断这些选项的影响。只能保持默认值，但默认值背后的含义也不清楚。

**问题 2：** 🔴 "初始化 Wiki" 按钮在开关下方，且仅在开关打开后才可点击（`disabled={!wiki.enabled}`）。

**用户困境：** 用户开启开关后，看到一个可点击的按钮"初始化 Wiki"。点击后发生了什么？代码中 `initWiki()` 创建了一整套目录结构并安装了 Skill（`wikiInit.ts:53-121`），但用户只看到一个 Toast "Wiki 已初始化：llm-wiki（已安装 llm-wiki Skill）"。然后呢？用户不知道该做什么。

**建议：** 初始化成功后提供引导步骤：如"请将资料放入 raw/ 目录，然后在聊天中使用 /wiki ingest 开始"。

---

### 场景 3：理解 Wiki 的目录结构

**用户状态：** 初始化完成后，点击左侧 Wiki 图标，看到文件树。

**问题 1：** 🟡 目录结构让人困惑。

**实际代码：** `WikiPane.tsx:105-121` — Wiki 面板渲染一个只读文件树，根节点是 wiki 根目录名（如 `llm-wiki`）。用户看到：

```
llm-wiki/
├── SCHEMA.md
├── raw/
├── wiki/
│   ├── index.md
│   ├── log.md
│   ├── entities/
│   ├── concepts/
│   ├── topics/
│   ├── sources/
│   └── queries/
└── .wiki-meta.json
```

**用户困境：** 用户不理解每个目录/文件的用途。`raw/` 和 `wiki/` 的区别是什么？为什么有两个地方放文件？`entities/`、`concepts/`、`topics/` 各自放什么？`SCHEMA.md` 是什么？没有 tooltip、没有引导说明。

**问题 2：** 🟡 `index.md` 被弱高亮标记为"推荐入口"，但用户可能不知道为什么要从这里开始。

**实际代码：** `WikiPane.tsx:27` — `highlightPaths = [wikiIndexPath]`，只有一条 CSS 高亮样式。

**用户困境：** 点击 `index.md` 打开的是一个空模板（"（暂无）"），用户看不到任何有价值的内容。

---

### 场景 4：首次放入资料并使用 Ingest

**用户状态：** 用户有一篇想交给 AI 分析的文章。

**问题 1：** 🔴 用户不知道应该把文件放在哪里。

**用户困境：** 需求文档明确"raw/ 由用户写入"，但普通用户不会去读需求文档。用户可能：
- 直接把文件拖到聊天框（不支持）
- 在文件树中粘贴到 wiki/ 目录下（文件树是只读的，`treeOptions.readOnly: true`）
- 用系统文件管理器手动放入（需要知道 raw/ 的绝对路径）

**实际代码：** `WikiPane.tsx:119` — Wiki 文件树 `readOnly: true`，用户无法在应用内直接添加文件到 raw/。

**问题 2：** 🟡 使用 `/wiki ingest` 命令时路径容易出错。

**用户困境：** 用户需要输入 `/wiki ingest raw/my-article.md`。但：
- 用户可能记不住文件名
- 没有文件路径自动补全
- 中文别名 `/wiki 摄取`、`/wiki 提取` 虽然友好但用户可能不知道

**实际代码：** `wikiCommandService.ts:10` — `INGEST_ALIASES = new Set(['ingest', '摄取', '提取'])`

**问题 3：** 🟡 Ingest 执行过程中用户看不到进度。

**用户困境：** 执行 `/wiki ingest` 后，LLM 开始工作。用户能看到工具调用（read_file、write_file 等），但不理解这些操作在做什么。没有进度摘要如"正在分析文章…"、"已更新 3 个页面…"。

**问题 4：** 🔴 如果用户文件不在 raw/ 下，`/wiki ingest` 的行为不一致。

**实际代码：** `wikiCommandService.ts:95-98` — 非 raw/ 路径会触发 `wikiImportRaw`，自动拷贝到 raw/ 再 ingest。但：
- 拷贝后的路径可能与用户预期不同（有自动重命名逻辑，`wikiImportPaths.ts:35-51`）
- 用户放入 `docs/article.md` 并执行 `/wiki ingest docs/article.md`，文件被拷贝到 `raw/article.md`，但用户可能以为原文件被移动了

---

### 场景 5："收录到 Wiki"右键菜单

**用户状态：** 用户在文件树中右键点击一个文件，看到"收录到 Wiki"选项。

**问题 1：** 🟡 菜单项出现条件不直观。

**实际代码：** `FileTree.tsx:98-100`：
```tsx
const showCollect = Boolean(
  onCollectToWiki && canShowCollectToWiki(node.relPath, wikiRootPath, node.isDirectory, wikiEnabled)
)
```
只在文件（非目录）、非 wiki 内部文件、非二进制文件上显示。用户右键一个目录或 PDF 时看不到这个选项，不知道为什么。

**问题 2：** 🟡 点击后的行为与预期不符。

**实际代码：** `wikiImportService.ts:38-64` — `collectToWiki` 流程：
1. 检查 wiki 是否启用 → 未启用则提示错误
2. 检查 wiki 是否初始化 → 未初始化则提示错误
3. 调用 `wikiImportRaw` 拷贝文件
4. 自动触发 ingest

**用户困境：** 用户点击"收录到 Wiki"后，文件被拷贝到 raw/，然后自动在聊天中发送 `/wiki ingest`。但：
- 用户可能不在聊天界面，不知道发生了什么
- 如果当前没有活跃会话，`options.sessionId` 为空，函数直接返回 null（`wikiImportService.ts:44-46`），静默失败

**问题 3：** 🔴 没有会话时"收录到 Wiki"静默失败。

**实际代码：**
```tsx
if (!options.sessionId) {
  options.onMissingSession?.()
  return null
}
```
`App.tsx:191` 传入 `onMissingSession: () => message.warning('请先选择或创建一个会话')`，但文件树右键调用时（`FileTree.tsx:112`）直接调用 `onCollectToWiki?.(node.relPath)`，没有处理返回值和错误。用户看到 warning 但不知道如何解决。

---

### 场景 6：使用 Wiki Query 提问

**用户状态：** 用户想基于 Wiki 内容提问。

**问题 1：** 🟡 用户不知道何时该用 `/wiki` 命令，何时该直接聊天。

**用户困境：** 需求文档设计了两套触发方式：`/wiki query <问题>` 和自然语言（含"根据 Wiki""知识库"等触发词）。但：
- 自然语言匹配依赖 Skill 的 trigger 关键词（`wikiTemplates.ts:83-87`），匹配率不可预测
- 用户说"帮我查一下之前那个文章里的概念"，不带触发词，不会激活 Wiki 模式
- 用户不确定当前是否处于 Wiki 模式

**问题 2：** 🟡 没有可视化的"Wiki 模式"指示。

**实际代码：** `wikiSessionState.ts` 维护了 `wikiModeActive` 状态，但在 UI 中没有明显展示。用户不知道当前会话是否已激活 Wiki 模式。

**问题 3：** 🟢 Query 结果中的 Wiki 路径引用依赖 Markdown 链接渲染。

**实际代码：** `wikiCommandService.ts:145-152` — `isWikiPathLink` 判断链接是否为 wiki 路径。但 LLM 生成的回答可能不遵循标准 Markdown 链接格式，用户可能看到的是纯文本路径而非可点击链接。

---

### 场景 7：归档回答到 Wiki

**用户状态：** AI 给出了一份很好的分析回答，用户想保存到 Wiki。

**问题 1：** 🔴 "归档到 Wiki"按钮容易被忽略。

**实际代码：** `ChatView.tsx:848-849`：
```tsx
showArchiveToWiki={Boolean(cfg?.wiki?.enabled && m.role === 'assistant' && m.status === 'completed' && m.content.trim())}
onArchiveToWiki={() => handleArchiveToWiki(m.content)}
```
按钮仅在消息操作栏中显示，与其他操作（复制、重新生成等）混在一起。用户可能根本注意不到。

**问题 2：** 🟡 归档路径不可控。

**实际代码：** `ChatView.tsx:766-768`：
```tsx
const date = new Date().toISOString().slice(0, 10)
const relPath = `${wikiRoot}/wiki/queries/${date}-archive.md`
```
路径自动生成为 `YYYY-MM-DD-archive.md`，用户无法自定义。如果同一天归档多次，后面的会覆盖前面的。

**问题 3：** 🟡 归档后没有确认反馈。

用户点击"归档到 Wiki"后，系统发送一条 `/wiki query` 指令给 LLM 执行归档。但用户看不到归档是否成功、页面保存到了哪里。需要手动去 Wiki 树中寻找。

---

### 场景 8：Wiki 面板日常浏览

**用户状态：** 用户想浏览 Wiki 中积累的知识。

**问题 1：** 🔴 Wiki 面板只是一个普通文件树，没有 Wiki 特有的浏览体验。

**实际代码：** `WikiPane.tsx:105-121` — 直接复用 `FileTree` 组件，没有额外的 Wiki 视图。

**用户困境：** 需求文档（§10.3）设计了"Index 快捷视图"——在详情面板打开 `index.md` 时可按 Entities/Concepts/Topics 分组展示。但**未实现**。用户只能逐个点击文件查看，无法获得知识库的全局视图。

**问题 2：** 🟡 没有搜索/过滤功能。

Wiki 面板没有搜索框。用户想找某个概念相关页面时，必须：
1. 在聊天中用 `/wiki query`（需要切换上下文）
2. 手动展开目录树逐个查找

**问题 3：** 🟢 无法在 Wiki 面板中直接看到页面摘要。

文件树只显示文件名（如 `transformer-architecture.md`），没有预览或摘要。用户必须点击每个文件才能判断是否是想要的内容。

**问题 4：** 🟡 `[[wikilink]]` 跳转未实现。

需求文档（§10.2）提到支持 Obsidian 式 `[[wikilink]]` 解析和跳转。`wikiMarkdown.ts:2-8` 中的 `expandWikilinks` 函数可以将 `[[page]]` 转换为 Markdown 链接，但在详情面板中点击链接后是否能正确跳转、高亮 Wiki 树中的对应节点，依赖于详情面板的链接处理逻辑，可能存在断层。

---

### 场景 9：Wiki Lint 健康检查

**用户状态：** 用户使用 Wiki 一段时间后，想检查知识库质量。

**问题 1：** 🔴 Lint 功能完全依赖 LLM，没有结构化输出。

**实际代码：** `wikiCommandService.ts:112-121` — Lint 只是发送一条指令给 LLM：
```tsx
text: fix ? '请执行 Wiki Lint 健康检查，并在确认后修复可自动修复的问题。' : '请执行 Wiki Lint 健康检查。'
```

**用户困境：** Lint 结果以聊天形式返回，混在其他对话中。用户无法：
- 看到历史 Lint 结果的对比
- 知道哪些问题已修复、哪些未修复
- 一键跳转到有问题的页面
- 过滤特定类型的问题（如只看"矛盾"）

**问题 2：** 🟡 `--fix` 和普通 Lint 的区别不明显。

用户可能不理解 `--fix` 的含义：是自动修复还是"检查并建议修复"？代码中 `--fix` 模式让 LLM 在确认后修复，但普通用户不知道还需要手动确认。

---

### 场景 10：错误处理与异常状态

**用户状态：** 用户在使用过程中遇到各种错误。

**问题 1：** 🔴 错误信息过于技术化。

**实际代码示例：**
- `wikiCommandService.ts:48` — `'[Wiki] Wiki 功能未启用，请先在设置中开启'` — 不告诉用户在设置的哪里开启
- `wikiCommandService.ts:75` — `'[Wiki] Wiki 尚未初始化，请先执行 /wiki init 或在设置中初始化'` — 两种方式让用户困惑
- `builtinExecutors.ts:282` — `'raw/ 为只读源，不可通过工具修改 (WIKI_RAW_READONLY)'` — 错误码 `WIKI_RAW_READONLY` 对用户无意义

**问题 2：** 🟡 部分错误静默处理。

- `wikiImportService.ts:44-46` — 无会话时 `collectToWiki` 返回 null，调用方可能不检查
- `wikiImport.ts:57` — 目录不能收录到 Wiki，用户右键目录时直接不显示菜单项，而非点击后提示

**问题 3：** 🟡 Wiki 状态不一致时的体验。

如果用户手动删除了 wiki 目录中的文件（通过系统文件管理器），Wiki 面板的状态可能与实际不一致。`refreshWikiStatus` 只在组件挂载和 wikiRoot 变化时触发。

---

### 场景 11：多会话并行使用 Wiki

**用户状态：** 用户在两个会话中同时操作 Wiki。

**问题：** 🟡 没有冲突提示。

**实际代码：** 需求文档 OQ-4 决议采用"乐观并发"策略，冲突由 Git 解决。但：
- 普通用户不会用 Git
- 两个会话同时 ingest 可能导致文件内容被覆盖
- 没有任何警告提示用户"Wiki 正在被另一个会话修改"

---

## 三、问题汇总与严重程度

### 阻断级问题（用户无法完成任务）

| # | 场景 | 问题 |
|---|------|------|
| 1 | 发现功能 | Wiki 默认关闭，活动栏无入口，用户不知道功能存在 |
| 2 | 首次配置 | 初始化后无下一步引导，用户不知道做什么 |
| 3 | 放入资料 | Wiki 文件树只读，无法在应用内添加文件到 raw/ |
| 4 | 收录到 Wiki | 无活跃会话时静默失败 |
| 5 | 归档回答 | 同一日期多次归档会覆盖 |
| 6 | 日常浏览 | 无 Index 视图，用户无法概览知识库 |
| 7 | Lint 检查 | 结果无结构化展示，无法追踪修复状态 |

### 困惑级问题（用户能做但不确定）

| # | 场景 | 问题 |
|---|------|------|
| 8 | 首次配置 | 配置项术语过于专业 |
| 9 | 目录结构 | 不理解 raw/ vs wiki/ 的区别 |
| 10 | Ingest | 路径输入无补全，中文别名不为人知 |
| 11 | 收录到 Wiki | 菜单项出现条件不透明 |
| 12 | Query | 不确定当前是否处于 Wiki 模式 |
| 13 | 归档 | 归档路径不可自定义 |
| 14 | 错误处理 | 错误信息技术化，缺乏操作指引 |

### 不便级问题（能用但体验差）

| # | 场景 | 问题 |
|---|------|------|
| 15 | Ingest | 无进度指示和结果摘要 |
| 16 | 日常浏览 | 无搜索过滤、无页面摘要预览 |
| 17 | [[wikilink]] | 跳转可能不可靠 |
| 18 | 多会话 | 无冲突警告 |
| 19 | 状态同步 | 外部修改后状态可能不一致 |
| 20 | Wiki 面板 | "打开"按钮跳转到系统资源管理器，打断应用内体验 |

---

## 四、根因分析

### 根因 1：概念门槛过高

LLM Wiki 基于 Karpathy 的高级模式，涉及 raw/wiki 分层、Schema 规范、Ingest/Query/Lint 三大操作、Skill 机制等。当前实现**假设用户理解这些概念**，没有提供任何渐进式引导或概念解释。

### 根因 2：功能入口分散

Wiki 功能跨越了设置页、活动栏、聊天命令、右键菜单、消息操作栏五个入口。用户需要在不同位置完成不同操作，心智负担重。

### 根因 3：反馈循环缺失

用户执行操作（初始化、ingest、归档、lint）后，除了聊天中的工具调用记录，没有专门的 Wiki 状态面板来展示"发生了什么"。用户不知道操作是否成功、产生了什么影响。

### 根因 4：只读文件树的限制

Wiki 面板的文件树设为只读（`readOnly: true`），用户无法在应用内管理 raw/ 文件。这迫使用户切换到系统文件管理器，打断了工作流。

### 根因 5：过度依赖聊天界面

所有 Wiki 操作（ingest、query、lint、归档）都通过聊天指令触发，结果也只在聊天中展示。没有一个专门的 Wiki 管理界面来集中查看状态、历史、统计。

---

## 五、改进建议优先级

### 高优先级（解决阻断问题）

1. **功能发现**：Wiki 图标始终显示在活动栏（灰色态），点击后引导开启
2. **初始化引导**：初始化后展示 3 步引导（放入资料 → 执行 ingest → 开始提问）
3. **文件导入**：Wiki 面板增加"添加资料"按钮，支持拖拽或文件选择器
4. **无会话处理**：收录到 Wiki 时如无会话，自动创建临时会话或提供明确指引
5. **归档去重**：自动追加序号避免覆盖（如 `2026-06-01-archive-2.md`）
6. **Index 视图**：实现需求文档 §10.3 的 Index 快捷视图

### 中优先级（解决困惑问题）

7. **术语解释**：配置项增加 tooltip 解释
8. **目录说明**：Wiki 面板中每个子目录显示简短说明
9. **Wiki 模式指示器**：聊天输入框旁显示当前是否处于 Wiki 模式
10. **错误信息优化**：用平实的语言说明问题和解决步骤
11. **路径补全**：`/wiki ingest` 后提供 raw/ 下文件列表

### 低优先级（体验优化）

12. **Ingest 进度**：Wiki 面板显示 ingest 进行中状态
13. **Wiki 搜索**：Wiki 面板增加搜索过滤
14. **操作历史**：Wiki 面板显示最近的 ingest/lint 操作记录
15. **冲突检测**：多会话修改同一文件时发出警告

---

## 六、高优先级改进项修复计划

> **计划日期：** 2026-06-02  
> **范围：** 针对第五章中 6 个高优先级（阻断级）问题  
> **状态：** 改进 6（Index 视图）经代码审查确认已完整实现，实际需开发 5 项  
> **原则：** 遵循现有代码模式（Redux、IPC handler、Ant Design、CSS 变量），所有 UI 文案使用 zh-CN

### 改进项概览

| # | 改进项 | 涉及文件 | 预估工作量 |
|---|--------|---------|-----------|
| 1 | Wiki 功能发现 — 始终显示图标 | App.tsx, styles.css | 小 |
| 2 | 初始化引导 — 三步指引卡片 | WikiPane.tsx, wikiPane.css | 小 |
| 3 | 文件导入 —「添加资料」按钮 | appIpc.ts, preload.ts, api.ts, WikiPane.tsx | 中 |
| 4 | 无会话自动创建 | App.tsx, DetailPanel/index.tsx, FileOverlay.tsx, wikiImportService.ts | 小 |
| 5 | 归档去重 — 序号追加 | ChatView.tsx | 小 |
| 6 | Index 视图 | 已实现，仅需验证 | 无 |

---

### 改进 1：Wiki 功能发现 —— 始终显示图标

**问题回顾：** Wiki 默认关闭时活动栏无图标，用户不知道功能存在。

**目标：** 活动栏始终显示 Wiki 图标。未启用时图标置灰（opacity 0.35），点击跳转设置 Wiki 标签页。

**文件修改：**

**`src/renderer/App.tsx`**

1. 为 `IconTab` 组件增加 `disabled?: boolean` 属性：

```tsx
function IconTab({
  lineSvg, fillSvg, active, onClick, title, disabled = false
}: {
  lineSvg: string; fillSvg: string; active: boolean
  onClick: () => void; title: string; disabled?: boolean
}) {
  const dispatch = useAppDispatch()
  const svg = active ? fillSvg : lineSvg
  return (
    <button
      type="button"
      className={`activity-bar-btn${active ? ' active' : ''}${disabled ? ' activity-bar-btn--disabled' : ''}`}
      onClick={disabled ? () => dispatch(openSettings({ tab: 'wiki' })) : onClick}
      title={disabled ? 'Wiki 未启用，点击前往设置' : title}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
```

2. 移除条件渲染（约第 224 行），改为始终渲染：

```tsx
<IconTab
  lineSvg={wikiLineSvg} fillSvg={wikiFillSvg}
  active={siderKey === 'wiki'}
  onClick={() => setSiderKey('wiki')}
  title="Wiki"
  disabled={!wikiEnabled}
/>
```

**`src/renderer/styles.css`** 或对应 CSS 文件：

```css
.activity-bar-btn--disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
```

**验证：**
- 未启用 Wiki 时图标可见但置灰
- hover 时 title 显示"Wiki 未启用，点击前往设置"
- 点击后打开设置并定位到 Wiki 标签
- 启用 Wiki 后图标恢复正常

---

### 改进 2：初始化引导 —— 三步使用指引

**问题回顾：** Wiki 初始化成功后仅一个 Toast，用户不知道下一步做什么。

**目标：** 初始化后在 WikiPane 中展示可关闭的 3 步引导卡片。

**文件修改：**

**`src/renderer/components/WikiPane/WikiPane.tsx`**

1. 新增状态：`const [showInitGuide, setShowInitGuide] = useState(false)`

2. 在 `initWiki` 函数中（约第 66 行），`message.success` 之后增加 `setShowInitGuide(true)`

3. 新增 `useEffect` 监听 `wikiInitialized` 变化：

```tsx
useEffect(() => {
  if (wikiInitialized) setShowInitGuide(true)
}, [wikiInitialized])
```

4. 在 header 与 body 之间插入引导卡片：

```tsx
{wikiInitialized && showInitGuide && (
  <div className="wiki-init-guide">
    <div className="wiki-init-guide-header">
      <span className="wiki-init-guide-title">Wiki 已就绪，开始使用</span>
      <Button type="text" size="small" onClick={() => setShowInitGuide(false)}>关闭</Button>
    </div>
    <div className="wiki-init-guide-steps">
      <div className="wiki-init-guide-step">
        <span className="wiki-init-guide-step-num">1</span>
        <div>
          <div className="wiki-init-guide-step-title">添加资料</div>
          <div className="wiki-init-guide-step-desc">将 Markdown 或文本文件放入 raw/ 目录</div>
        </div>
      </div>
      <div className="wiki-init-guide-step">
        <span className="wiki-init-guide-step-num">2</span>
        <div>
          <div className="wiki-init-guide-step-title">执行收录</div>
          <div className="wiki-init-guide-step-desc">在对话中输入 /wiki ingest &lt;文件路径&gt;，让 AI 分析并编入 Wiki</div>
        </div>
      </div>
      <div className="wiki-init-guide-step">
        <span className="wiki-init-guide-step-num">3</span>
        <div>
          <div className="wiki-init-guide-step-title">开始查询</div>
          <div className="wiki-init-guide-step-desc">使用 /wiki query &lt;问题&gt; 基于 Wiki 知识库提问</div>
        </div>
      </div>
    </div>
  </div>
)}
```

**`src/renderer/components/WikiPane/wikiPane.css`**

```css
.wiki-init-guide {
  margin: 8px 12px;
  padding: 10px 12px;
  border-radius: var(--sa-radius-md, 6px);
  background: var(--sa-bg-muted, #f5f5f5);
  border: 1px solid var(--sa-border-light, #e8e8e8);
}
.wiki-init-guide-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.wiki-init-guide-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--sa-text);
}
.wiki-init-guide-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wiki-init-guide-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.wiki-init-guide-step-num {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--sa-primary);
  color: #fff;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.wiki-init-guide-step-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--sa-text);
}
.wiki-init-guide-step-desc {
  font-size: 11px;
  color: var(--sa-text-tertiary, #999);
}
```

**验证：**
- 点击「初始化 Wiki」后引导卡片出现
- 从设置页初始化后，切换到 Wiki 面板也看到引导
- 点击「关闭」按钮引导消失
- 刷新页面后引导不再出现（wikiInitialized 为 true 但 showInitGuide 初始为 false）

---

### 改进 3：文件导入 ——「添加资料」按钮

**问题回顾：** Wiki 文件树只读，用户无法在应用内添加文件到 raw/。

**目标：** WikiPane header 增加「添加资料」按钮，弹出原生文件选择器，选中 .md/.txt 拷贝到 raw/。

**文件修改：**

**`electron/appIpc.ts`** — 新增 IPC handler `'wiki:import-files'`

```typescript
ipcMain.handle('wiki:import-files', async (): Promise<WikiImportFilesResult> => {
  const win = getMainWindow()
  if (!win) return { ok: false, error: '窗口未就绪' }
  const wikiConfig = readWikiConfig(ctx.db)
  if (!wikiConfig.enabled) return { ok: false, error: 'Wiki 未启用' }
  const workDir = ctx.getWorkDir()
  const root = resolveWikiRootAbs(workDir, wikiConfig)

  const result = await dialog.showOpenDialog(win, {
    title: '选择要导入 Wiki 的资料',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '文本文件', extensions: ['md', 'txt'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: true, imported: [], errors: [] }
  }

  const imported: string[] = []
  const errors: string[] = []
  for (const absSrc of result.filePaths) {
    try {
      const basename = path.basename(absSrc)
      const baseRawRelPath = `${wikiConfig.rootPath}/raw/${basename}`
      const rawRelPath = await resolveAvailableRawPath(workDir, baseRawRelPath)
      if (!rawRelPath) { errors.push(`${basename}: 无法生成目标路径`); continue }
      const destAbs = resolveSafePath(workDir, rawRelPath)
      await fs.mkdir(path.dirname(destAbs), { recursive: true })
      await fs.copyFile(absSrc, destAbs)
      imported.push(rawRelPath)
    } catch (e) {
      errors.push(`${path.basename(absSrc)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ok: true, imported, errors }
})
```

类型定义：

```typescript
type WikiImportFilesResult =
  | { ok: true; imported: string[]; errors: string[] }
  | { ok: false; error: string }
```

**`electron/preload.ts`** — 暴露 API

```typescript
wikiImportFiles: () => ipcRenderer.invoke('wiki:import-files'),
```

**`src/shared/api.ts`** — 类型声明

```typescript
wikiImportFiles: () => Promise<
  { ok: true; imported: string[]; errors: string[] } | { ok: false; error: string }
>
```

**`src/renderer/components/WikiPane/WikiPane.tsx`**

1. header 操作区增加「添加资料」按钮（位于「打开」之前）：

```tsx
{wikiInitialized ? (
  <>
    <Button type="text" size="small" onClick={() => void handleImportFiles()}>
      添加资料
    </Button>
    <Button type="text" size="small" onClick={() => void window.api.fileShowInExplorer(wikiRoot)}>
      打开
    </Button>
  </>
) : null}
```

2. 处理函数：

```typescript
const handleImportFiles = async () => {
  const result = await window.api.wikiImportFiles()
  if (!result.ok) {
    message.error(result.error)
    return
  }
  if (result.imported.length > 0) {
    message.success(`已导入 ${result.imported.length} 个文件`)
    void wikiTreeRef.current?.refresh()
  }
  if (result.errors.length > 0) {
    result.errors.forEach((e) => message.warning(e))
  }
}
```

**验证：**
- 点击「添加资料」弹出系统文件选择对话框
- 对话框仅显示 .md/.txt 文件
- 多选文件均可导入
- 同名文件自动重命名（如 `note.md` → `note-20260602-120000.md`）
- 导入后文件树自动刷新，新文件出现在 raw/ 下

---

### 改进 4：无会话自动创建

**问题回顾：** 无活跃会话时点击「收录到 Wiki」静默失败。

**目标：** 自动创建临时会话，确保收录流程继续。

**涉及的三处调用点：**

| 位置 | 文件 |
|------|------|
| App.tsx 的 `handleCollectToWiki` | `src/renderer/App.tsx:187-195` |
| DetailPanel 的 `handleCollectToWiki` | `src/renderer/components/DetailPanel/index.tsx:26-34` |
| FileOverlay 的 `handleCollectToWiki` | `src/renderer/components/DetailPanel/FileOverlay.tsx:34-43` |

**修改模式（三处相同）：**

```typescript
const handleCollectToWiki = async (srcRelPath: string) => {
  let sessionId = currentSessionId
  if (!sessionId) {
    const s = await window.api.sessionCreate({ name: '临时会话 (Wiki 收录)' })
    dispatch(upsertSession(s))
    dispatch(setSession(s.id))
    sessionId = s.id
    message.info('已自动创建临时会话用于 Wiki 收录')
  }
  void collectToWiki(srcRelPath, {
    wikiEnabled: Boolean(config?.wiki?.enabled),
    sessionId,
    onError: (text) => message.error(text),
    onSuccess: (text) => message.success(text)
  })
}
```

**注意：** `DetailPanel/index.tsx` 和 `FileOverlay.tsx` 当前未导入 `useAppDispatch` 和 session actions（`upsertSession`、`setSession`），需补充导入。

**`src/renderer/services/wikiImportService.ts`**

移除 `onMissingSession` 回调和 null 返回分支。`collectToWiki` 的 options 类型中去掉 `onMissingSession`。

**验证：**
- 删除所有会话后，右键文件「收录到 Wiki」
- 验证自动创建名为「临时会话 (Wiki 收录)」的会话
- 验证收录流程正常继续
- 已有会话时行为不变

---

### 改进 5：归档去重 —— 序号追加

**问题回顾：** 同一天多次归档都使用 `YYYY-MM-DD-archive.md`，后者覆盖前者。

**目标：** 文件存在时自动追加序号。

**文件修改：**

**`src/renderer/components/Chat/ChatView.tsx`**

1. 新增辅助函数（组件内或模块级）：

```typescript
async function resolveArchivePath(wikiRoot: string, date: string): Promise<string> {
  const basePath = `${wikiRoot}/wiki/queries/${date}-archive.md`
  try {
    await window.api.fileGetMetadata(basePath)
    // 文件存在，找下一个可用序号
    for (let i = 2; i < 100; i++) {
      const candidate = `${wikiRoot}/wiki/queries/${date}-archive-${i}.md`
      try {
        await window.api.fileGetMetadata(candidate)
      } catch {
        return candidate
      }
    }
    // 超过 100 个，使用时间戳兜底
    return `${wikiRoot}/wiki/queries/${date}-archive-${Date.now()}.md`
  } catch {
    return basePath
  }
}
```

2. 修改 `handleArchiveToWiki`（约第 763 行）为 async：

```typescript
const handleArchiveToWiki = useCallback(
  async (assistantContent: string) => {
    if (!sessionId) return
    const wikiRoot = (cfg?.wiki?.rootPath ?? DEFAULT_WIKI_CONFIG.rootPath)
      .replace(/\\/g, '/').replace(/^\/+/, '')
    const date = new Date().toISOString().slice(0, 10)
    const relPath = await resolveArchivePath(wikiRoot, date)
    const excerpt = assistantContent.slice(0, 2000).trim()
    // 更新 metadata...
    void send(
      `/wiki query 请将以下助手回答归档为 Wiki 新页（${relPath}），更新 index 与 log，并确保正文结构清晰：\n\n${excerpt}`
    )
  },
  [send, sessionId, cfg?.wiki?.rootPath, currentSession?.metadata, dispatch]
)
```

**验证：**
- 当日首次归档：`2026-06-02-archive.md`
- 当日第二次：`2026-06-02-archive-2.md`
- 聊天 prompt 中显示的路径与实际归档路径一致

---

### 改进 6：Index 视图（已实现，仅需验证）

**代码审查结论：** 此功能已完整实现。

| 模块 | 文件 | 作用 |
|------|------|------|
| WikiIndexView 组件 | `src/renderer/components/DetailPanel/WikiIndexView.tsx` | 分组渲染 index 条目为可点击列表 |
| 状态 Hook | `useWikiIndexViewState`（同文件） | 判断当前文件是否为 index.md，管理视图切换 |
| 工具栏切换 | `src/renderer/components/DetailPanel/FileToolbar.tsx` | 显示「Index」segment 按钮 |
| 内容路由 | `src/renderer/components/DetailPanel/FileContentView.tsx:70-78` | `wikiIndexView` 为 true 时渲染 WikiIndexView |
| 数据解析 | `src/shared/wikiMarkdown.ts:31-51` | `parseWikiIndexMarkdown` 解析 index.md |

**验证步骤：**
1. 启动应用，在 Wiki 面板点击 `wiki/index.md`
2. 详情面板工具栏应出现「Index」/「渲染」/「代码」三个切换按钮
3. 切换到「Index」视图，应看到按 Entities/Concepts/Topics 等分组展示的条目
4. 点击条目跳转到对应 Wiki 页面
5. 切换回「渲染」或「代码」视图正常
6. 空 index.md 时显示「未能解析 index 条目」提示

---

### 实施顺序

各项改进相互独立，推荐按以下顺序实施：

1. **改进 1（功能发现）** — 改动最小，最快见效
2. **改进 2（初始化引导）** — 紧随其后，与改进 1 构成完整的"首次用户体验"
3. **改进 4（无会话处理）** — 小改动解决静默失败
4. **改进 5（归档去重）** — 单文件改动
5. **改进 3（文件导入）** — 涉及 IPC 层，工作量大一些
6. **改进 6（Index 视图）** — 纯验证，随时可做

### 关键代码模式参考

| 模式 | 参考文件 |
|------|---------|
| IPC handler 注册 | `electron/appIpc.ts` 中现有 `wiki:import-raw` handler |
| Preload API 暴露 | `electron/preload.ts` |
| API 类型声明 | `src/shared/api.ts` |
| Redux dispatch | `src/renderer/App.tsx` 中 `useAppDispatch()` |
| Ant Design 消息 | `App.useApp().message` |
| CSS 变量 | `var(--sa-primary)`, `var(--sa-bg-muted)`, `var(--sa-text)` |
| 测试 mock | `WikiPane.test.tsx` 中 `window.api` mock |
| 文件树刷新 | `wikiTreeRef.current?.refresh()` |
