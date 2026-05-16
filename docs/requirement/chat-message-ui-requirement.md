# 消息列表样式与交互 — 需求规格

## 1. 概述

本文档定义聊天消息列表的视觉样式与交互行为，涵盖用户/助手消息、思考过程、工具调用、写入确认、系统提示及输入区中止等要素。目标风格为轻量、信息密度适中，接近 Cursor / VS Code 类 IDE 助手的活动流体验。

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
| `list_directory` | **目录名（basename）** | 完整相对路径 |
| `edit_file` | 完整路径 | — |
| `write_file` | 完整路径 | — |
| `run_script` | 「运行脚本」 | — |

### 6.3 展开/收起规则

| 工具类型 | 状态 | 默认展开 | 可手动收起 |
|---------|------|---------|-----------|
| 文件读/写/编辑/列目录（`read_file`、`write_file`、`edit_file`、`list_directory`） | 已完成 | **收起** | 是 |
| 文件写入类（`write_file`、`edit_file`） | 待确认（`confirming`） | **展开**（独立确认卡片，见 §7） | 否 |
| 文件写入类 | 执行中 / 已完成 | **收起** | 是 |
| 文件写入类 | 失败 / 已拒绝 | 展开 | 是 |
| 非文件工具 | 调用中 / 执行中 / 待确认 | 展开 | 是 |
| 非文件工具 | 已完成 | 收起（有详情时可展开） | 是 |
| 任意工具 | 失败 / 已拒绝 | 展开 | 是 |

### 6.4 详情区内容

| 状态 | 展示 |
|------|------|
| 执行中 | 「取消执行」文字按钮（`onCancel` 可用时） |
| 失败 / 已拒绝 | 错误信息或「已拒绝」 |
| 已完成 | 结果预览（`pre`，最大截断 4000 字符）；非文件工具无结果时展示输入参数 JSON |
| 待确认（`run_script`） | 脚本代码预览 + 「确认」「拒绝」文字按钮 |

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

| 区域 | 内容 |
|------|------|
| 左侧 | 文件类型图标 + 文件名（basename，等宽 11px）+ 变更统计 |
| 变更统计 | `+N`（绿色 `#52c41a`）、`-M`（红色 `#ff4d4f`），等宽 11px |
| 右侧 | **允许**（✓ 图标）、**拒绝**（✕ 图标）两个图标按钮 |

**文件图标映射：**

- `.css` / `.scss` / `.less` → Hash 图标
- `.ts` / `.tsx` / `.js` / `.jsx` / `.vue` / `.py` / `.go` / `.rs` → FileCode 图标
- 其他 → FileText 图标

**操作按钮：**

| 按钮 | 图标 | aria-label / title | hover 效果 |
|------|------|-------------------|-----------|
| 允许 | Check（15px） | 「允许」 | 绿色文字 + 绿色浅底 |
| 拒绝 | X（15px） | 「拒绝」 | 红色文字 + 红色浅底 |

按钮尺寸 26×26px，无文字标签。

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

用户点击允许/拒绝后，卡片消失，工具行恢复为普通 `tool-row` 展示；执行中及完成后按 §6.3 规则自动收起。

---

## 8. 系统 / 提示消息

Skill 提示等系统级消息（`SkillHintBubble`）采用轻量文本样式，**不使用气泡边框或背景**。

| 属性 | 规格 |
|------|------|
| 容器 | `chat-system-track`，`max-width: 92%`，`margin-bottom: 4px` |
| 文字 | `chat-skill-hint` |
| 字号 | 13px |
| 颜色 | `--sa-text-tertiary` |
| 换行 | `white-space: pre-wrap` |

---

## 9. 输入区与中止交互

### 9.1 发送按钮

| 状态 | 外观 | 行为 |
|------|------|------|
| 空闲 | 蓝色圆形按钮 + Send 图标 | 发送消息（需非空文本） |
| 执行中 | **红色**圆形按钮（`composer-send--stop`）+ Square 实心图标 | **中止**当前 Agent 执行 |
| 快捷键 | Ctrl+Enter / ⌘+Enter | 触发主操作（空闲时发送，执行中时中止） |

### 9.2 提示文案

| 状态 | 文案 |
|------|------|
| 空闲 | 「Ctrl+Enter 发送」 |
| 执行中 | 「执行中，点击右侧按钮中止」 |

### 9.3 中止逻辑

- 渲染进程调用 `onAbort` → 主进程 `claude-chat-cancel` IPC
- 中止后标记消息状态为已取消，保留已生成的部分内容
- 中止按钮在执行中始终可点击（不受 `disabled` 限制）

---

## 10. 组件与样式索引

| 区域 | 组件 | 样式类 / 文件 |
|------|------|-------------|
| 消息气泡 | `ChatBubble.tsx` | `.chat-bubble-*` |
| 活动流时间线 | `ChatBubble.tsx` + `assistantActivityTimeline.ts` | `.chat-activity-track` |
| 思考块 | `ThinkingBlock.tsx` | `.chat-thinking*` |
| 工具行 | `ToolCallCard.tsx` | `.tool-row*` |
| 写入确认 | `WriteConfirmCard.tsx` | `.write-confirm-card*` |
| 系统提示 | `SkillHintBubble.tsx` | `.chat-system-track`、`.chat-skill-hint` |
| 输入区 | `MessageInput.tsx` | `.composer*` |
| 样式定义 | — | `src/renderer/theme/layout.css` |
| 工具标签 | — | `src/renderer/components/Chat/toolCallDisplay.ts` |
| Diff 计算 | — | `src/renderer/components/Chat/writeConfirmDiff.ts` |
