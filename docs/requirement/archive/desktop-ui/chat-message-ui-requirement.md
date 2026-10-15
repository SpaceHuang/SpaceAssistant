# 消息列表样式与交互 — 需求规格

## 1. 概述

本文档定义聊天消息列表的视觉样式与交互行为，涵盖用户/助手消息、思考过程、工具调用、写入确认/成功、待确认横幅、系统提示及输入区中止等要素。目标风格为轻量、信息密度适中，接近 Cursor / VS Code 类 IDE 助手的活动流体验。

---

## 2. 整体布局

### 2.1 消息行

| 属性 | 用户消息 | 助手消息 |
|------|---------|---------|
| 对齐 | 右对齐（`chat-bubble-row--user`） | 左对齐（`chat-bubble-row--assistant`） |
| 最大宽度 | 92% | 92% |
| 行间距 | `margin-bottom: 12px` | 同左 |
| 入场动画 | 淡入 + 上移 6px（`sa-message-in`） | 同左 |

### 2.2 时间戳

- 字体 11px，颜色 `--sa-text-tertiary`
- 用户消息时间戳使用半透明白色（`rgba(255,255,255,0.65)`）
- 助手消息时间戳位于活动流下方；流式生成时追加「 · 生成中」，失败时追加「 · 失败」

---

## 3. 用户消息气泡

| 属性 | 规格 |
|------|------|
| 背景 | `--sa-bubble-user` |
| 文字颜色 | `--sa-bubble-user-text` |
| 字号 | **13px** |
| 内边距 | `10px 14px` |
| 圆角 | `--sa-radius-lg` |
| 内容 | 纯文本，不使用 Markdown 渲染 |

---

## 4. 助手消息

### 4.1 正文气泡

| 属性 | 规格 |
|------|------|
| 背景 | **透明**（`transparent`） |
| 边框 | **无** |
| 阴影 | **无** |
| 内边距 | **0** |
| 内容 | Markdown 渲染（`ChatMarkdown`） |
| 流式指示 | 末尾闪烁光标（`chat-bubble-streaming::after`，字符 `▋`） |

助手正文不再使用独立的气泡容器包裹整段回复，而是以轻量文本块形式嵌入活动流。

### 4.2 活动流时间线

助手消息中的 **思考、正文、工具调用** 按实际发生顺序交错排列，而非分组堆叠（先全部 Thinking → 再正文 → 再全部工具）。

**排序规则：**

1. 每条活动项携带时间戳：`thinking.startTime`、`contentSegment.startTime`、`toolCall.startedAt`
2. 按时间戳升序排列
3. 时间戳相同时，优先级：思考 → 正文 → 工具
4. 旧消息无分段数据时，采用兼容策略：思考与工具按索引交错，正文排在最后

**容器：** `chat-activity-track`，纵向 flex，`gap: 1px`。

**数据支撑：**

- `Message.thinking.segments[]`：思考分段，含 `startTime` / `endTime`
- `Message.contentSegments[]`：正文分段，含 `startTime` / `endTime`
- `ToolCallRecord.startedAt`：工具开始执行时间

---

## 5. 思考（Thinking）块

### 5.1 视觉样式

| 元素 | 规格 |
|------|------|
| 标题按钮 | 脑图标（Lucide `Brain`，14px）+ 文字「思考」 |
| 标题字号 | **11px**，字重 500 |
| 标题颜色 | `--sa-text-tertiary`，hover 时 `--sa-text-secondary` |
| 展开正文 | 左侧 1px 竖线（`border-left: 1px solid --sa-border`），左内边距 12px |
| 正文字号 | **11px**（与标题统一） |
| 正文颜色 | `--sa-text-secondary` |
| 行高 | 1.55 |
| 背景/边框 | **无**独立卡片背景或外边框 |

### 5.2 交互

| 状态 | 行为 |
|------|------|
| 思考进行中（`active=true`，流式且当前段 `endTime` 未定义） | **默认展开** |
| 思考段结束（`endTime` 已写入） | **自动收起** |
| 用户点击标题 | 手动切换展开/收起 |
| 无障碍 | 标题按钮设置 `aria-expanded` |

---

## 6. 工具调用卡片

工具调用以轻量「活动行」（`tool-row`）形式展示，嵌入活动流时间线。

### 6.1 行样式

| 属性 | 规格 |
|------|------|
| 行字号（容器） | 13px |
| 标签字号 | **11px**，等宽字体（`--sa-font-mono`） |
| 标签颜色 | 默认 `--sa-text-secondary`；执行中 `--sa-text`；失败/拒绝 `--sa-accent` |
| 图标 | 按工具类型映射（`ToolRowIcon`）；执行中旋转动画 |
| 展开指示 | 右侧 ChevronRight，展开时旋转 90° |
| 详情区 | 左缩进 22px + 左侧竖线，与 Thinking 正文缩进风格一致 |

### 6.2 标签文案

| 工具 | 标签显示 | title 提示（hover） |
|------|---------|-------------------|
| `grep` | `在工作区搜索 '{pattern}'` | — |
| `read_file` | 文件名（basename） | 完整相对路径 |
| `list_directory` | 目录名（basename） | 完整相对路径 |
| `edit_file` | 文件名（basename） | 完整相对路径 |
| `write_file` | 文件名（basename） | 完整相对路径 |
| `run_script` | 「运行脚本」 | — |

行内标签**仅显示 basename**，完整路径通过 `title` 在 hover 时展示；待确认横幅列表（§9）复用同一套 `formatToolLabel` 规则。

### 6.3 展开/收起规则

| 工具类型 | 状态 | 默认展开 | 可手动收起 |
|---------|------|---------|-----------|
| 文件读/列目录（`read_file`、`list_directory`） | 已完成 | **收起** | 是 |
| 文件写入类（`write_file`、`edit_file`） | 待确认（`confirming`） | **展开**（独立确认卡片，见 §7） | 否 |
| 文件写入类 | 执行中 | **收起** | 是 |
| 文件写入类 | 已完成且成功 | **不展示**普通工具行，改为写入成功卡片（见 §8） | — |
| 文件写入类 | 失败 / 已拒绝 | 展开普通工具行 | 是 |
| 非文件工具 | 调用中 / 执行中 / 待确认 | 展开 | 是 |
| 非文件工具 | 已完成 | 收起（有详情时可展开） | 是 |
| 任意工具 | 失败 / 已拒绝 | 展开 | 是 |

### 6.4 详情区（`tool-row-detail`）内容

| 状态 | 展示 |
|------|------|
| 执行中 | 「取消执行」文字按钮（`onCancel` 可用时，仍为 danger 操作色） |
| 失败 / 已拒绝 | 错误信息或「已拒绝」（`.tool-row-detail__message`，**不使用**红色 danger 强调；12px，`--sa-text-secondary`） |
| 已完成 | 结果预览（`pre`，最大截断 4000 字符，`--sa-bg-muted` 背景）；非文件工具无结果时展示输入参数 JSON |
| 待确认（`run_script`） | 脚本代码预览 + 「确认」「拒绝」文字按钮 |

详情区内容主要供模型/开发者阅读，正文与错误信息均保持中性次要文字色，避免红色警示样式干扰阅读。

---

## 7. 写入确认卡片

适用于 `write_file`、`edit_file` 处于 `confirming` 状态时的专用 UI（`WriteConfirmCard`），替代普通工具行 + 底部按钮。

### 7.1 卡片容器

| 属性 | 规格 |
|------|------|
| 圆角 | `--sa-radius-md` |
| 边框 | 1px solid `--sa-border` |
| 背景 | `--sa-bg-elevated` |
| 宽度 | 100%（活动流内撑满） |

### 7.2 标题栏

| 属性 | 规格 |
|------|------|
| 整体高度 | `min-height: 34px`（与 28×28 操作按钮视觉对齐） |

| 区域 | 内容 |
|------|------|
| 左侧 | 文件类型图标 + 文件名（basename，等宽 11px）+ 变更统计 |
| 变更统计 | `+N`（绿色 `#52c41a`）、`-M`（红色 `#ff4d4f`），等宽 11px |
| 右侧 | **允许**（✓）、**拒绝**（✕）两个图标按钮，直接置于标题栏背景上；**不设**操作区独立浅色底、边框或阴影 |

**文件图标映射：**

- `.css` / `.scss` / `.less` → Hash 图标
- `.ts` / `.tsx` / `.js` / `.jsx` / `.vue` / `.py` / `.go` / `.rs` → FileCode 图标
- 其他 → FileText 图标

**操作按钮：**

| 按钮 | 图标 | aria-label / title | 默认样式 | hover |
|------|------|-------------------|---------|-------|
| 允许 | Check（16px） | 「允许」 | 浅绿底 + 绿色描边 + 深绿图标（`--sa-write-confirm-allow-*`） | 底/边略加深 + 轻阴影 |
| 拒绝 | X（16px） | 「拒绝」 | 浅红底 + 红色描边 + 深红图标（`--sa-write-confirm-deny-*`） | 底/边略加深 + 轻阴影 |

按钮固定 **28×28** px，无文字标签。

### 7.3 Diff 预览区

| 属性 | 规格 |
|------|------|
| 最大高度 | 220px，超出滚动 |
| 最大行数 | 120 行，超出以 `…` 截断 |
| 字号 | 11px 等宽 |
| 新增行 | 背景 `--sa-diff-add-bg` |
| 删除行 | 背景 `--sa-diff-remove-bg` |
| 底部 | 渐变淡出遮罩（暗示有更多内容） |

**Diff 数据来源：**

1. 优先使用 `ToolCallRecord.confirmDiff`（`oldContent` / `newContent` / `oldPath`）
2. `write_file` 无 diff 时，以空旧内容 + `input.content` 作为全量新增
3. `direct` 模式且无 diff 时，仅显示标题栏（无预览区）

Diff 算法为行级 LCS 对比，统计新增/删除行数。

### 7.4 确认后行为

用户点击允许/拒绝后，确认卡片消失；进入执行中后按 §6.3 收起；**执行成功**后展示写入成功卡片（§8），不再回退为可折叠的普通工具行。

---

## 8. 写入成功卡片

适用于 `write_file`、`edit_file` 执行**成功**（`status === 'completed'` 且 `result.success`）时的专用 UI（`WriteSuccessCard`），替代普通 `tool-row`，在活动流中更醒目地提示用户文件已变更。

### 8.1 卡片容器

| 属性 | 规格 |
|------|------|
| 布局 | 单行 flex，水平排列 |
| 高度 | `min-height: 34px` |
| 内边距 | `0 10px` |
| 圆角 | `--sa-radius-md` |
| 边框 | 1px solid `--sa-border` |
| 背景 | `--sa-bg-elevated` |
| 宽度 | 100%（活动流内撑满） |

### 8.2 行内容

| 区域 | 内容 |
|------|------|
| 左侧图标 | `ToolRowIcon`（写入/编辑类工具图标，颜色 `--sa-accent`） |
| 文件名 | basename，等宽 11px；完整路径仅在 `title`（hover） |
| 变更统计 | `+N`（绿色，仅 `N > 0` 时显示）、`-M`（红色，**仅 `M > 0` 时显示**，不展示 `-0`） |
| 右侧操作 | **「查看」** 文字按钮 |

### 8.3 「查看」按钮

| 属性 | 规格 |
|------|------|
| 文案 | 「查看」（非「查看变更」） |
| 尺寸 | 高度 26px，`padding: 0 10px` |
| 样式 | `--sa-bg-muted` 背景 + `--sa-border-strong` 描边，11px 次要文字色 |
| hover | 背景 `--sa-bg-subtle`，文字 `--sa-text` |
| 行为 | 调用 `DetailPanelContext.openFile(relPath)`，在**右侧文件内容预览区**打开该文件 |

**变更统计数据来源**（与写入确认卡片一致）：

1. 优先 `ToolCallRecord.confirmDiff` 行级 diff 统计
2. `write_file` 无 diff 时，按 `input.content` 行数计为新增

---

## 9. 待确认横幅

会话列表顶部的跨会话待确认提示（`PendingConfirmBanner`），当存在待用户确认的工具调用时展示。

| 元素 | 规格 |
|------|------|
| 容器 | `.pending-confirm-banner` |
| 列表 | `.pending-confirm-banner__list`，每项为可点击按钮 |
| 项文案格式 | `{会话名} · {工具标签}` |
| 工具标签 | 复用 `formatToolLabel`：**文件名/目录名仅显示 basename**，不展示完整路径 |
| 点击行为 | 切换到对应会话，并滚动聚焦到待确认工具卡片（`setConfirmFocusToolUseId`） |

---

## 10. 系统 / 提示消息

Skill 提示等系统级消息（`SkillHintBubble`）采用轻量文本样式，**不使用气泡边框或背景**。

| 属性 | 规格 |
|------|------|
| 容器 | `chat-system-track`，`max-width: 92%`，`margin-bottom: 4px` |
| 文字 | `chat-skill-hint` |
| 字号 | 13px |
| 颜色 | `--sa-text-tertiary` |
| 换行 | `white-space: pre-wrap` |

---

## 11. 输入区与中止交互

### 11.1 发送 / 中止按钮

| 状态 | 外观 | 行为 |
|------|------|------|
| 空闲 | 蓝色圆形按钮（**28×28** px）+ Send 图标（**14px**） | 发送消息（需非空文本） |
| 执行中 | **红色**圆形按钮（`composer-send--stop`，**28×28** px）+ Square 实心图标（**14px**） | **中止**当前 Agent 执行 |
| 快捷键 | Ctrl+Enter / ⌘+Enter | 触发主操作（空闲时发送，执行中时中止） |

图标容器使用 `line-height: 0` 与 `svg { display: block }` 保证在圆形按钮内居中对齐。

### 11.2 提示文案

| 状态 | 文案 |
|------|------|
| 空闲 | 「Ctrl+Enter 发送」 |
| 执行中 | 「执行中，点击右侧按钮中止」 |

### 11.3 中止逻辑

- 渲染进程调用 `onAbort` → 主进程 `claude-chat-cancel` IPC
- 中止后标记消息状态为已取消，保留已生成的部分内容
- 中止按钮在执行中始终可点击（不受 `disabled` 限制）

---

## 12. 组件与样式索引

| 区域 | 组件 | 样式类 / 文件 |
|------|------|-------------|
| 消息气泡 | `ChatBubble.tsx` | `.chat-bubble-*` |
| 活动流时间线 | `ChatBubble.tsx` + `assistantActivityTimeline.ts` | `.chat-activity-track` |
| 思考块 | `ThinkingBlock.tsx` | `.chat-thinking*` |
| 工具行 | `ToolCallCard.tsx` | `.tool-row*`、`.tool-row-detail*` |
| 写入确认 | `WriteConfirmCard.tsx` | `.write-confirm-card*` |
| 写入成功 | `WriteSuccessCard.tsx` | `.write-success-card*` |
| 待确认横幅 | `PendingConfirmBanner.tsx` | `.pending-confirm-banner*` |
| 系统提示 | `SkillHintBubble.tsx` | `.chat-system-track`、`.chat-skill-hint` |
| 输入区 | `MessageInput.tsx` | `.composer*` |
| 文件预览联动 | `ChatView.tsx` + `DetailPanelContext.tsx` | `openFile(relPath)` |
| 样式定义 | — | `src/renderer/theme/layout.css`、`tokens.css` |
| 工具标签 | — | `src/renderer/components/Chat/toolCallDisplay.ts` |
| Diff 计算 | — | `src/renderer/components/Chat/writeConfirmDiff.ts` |
