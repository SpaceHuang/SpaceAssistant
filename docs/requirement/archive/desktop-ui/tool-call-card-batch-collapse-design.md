# 工具调用卡片批量折叠 — 交互设计方案

**日期**：2026-06-05
**状态**：已实施
**问题**：工具调用卡片与思考块各自占一整行，收起后信息量极少但空间开销大。思考频繁时列表显得空洞，信息效率低。

---

## 1. 目标

将连续的思考块（ThinkingBlock）和工具调用卡片（ToolCallCard）自动归组为"活动批次"，每个批次折叠为一条概述行，点击可展开回完整列表。提升消息列表的信息密度，同时降低视觉负载。

---

## 2. 分组规则

以 `chat-activity-track` 为分组容器，对其中的连续项目按以下规则切分批次：

| 边界类型 | 说明 |
|---------|------|
| 用户消息 | 下一条用户消息出现时，当前批次结束 |
| 系统文本回复 | activityTimeline 中出现 `kind === 'text'` 条目（Assistant 正式文本回复），当前批次结束 |
| 空闲超时 | 连续 **3 分钟以上**无新消息、新卡片、新进展（以最后一个条目的 `timestamp` 为起点），当前批次结束 |

同一批次内包含连续的 `ThinkingBlock` 和 `ToolCallCard`。

---

## 3. 概述行设计

收拢后的概述行替代原本分散的多个卡片行：

```
🔧 读取 app.tsx 等 5 项                    ▸
```

- **左侧**：第一个条目的图标 + 标签文字 + `等 N 项` 计数
  - 若批次全是思考块：🧠 图标 + `思考中 等 N 项`
- **右侧**：chevron 箭头（折叠 ▸，展开 ▾）
- 整行可点击，hover 时背景变 `--sa-bg-subtle`
- `min-height: 26px`，padding `4px 6px`，与现有 `.tool-row__main` / `.chat-thinking__toggle` 密度一致
- 颜色使用 `--sa-text-tertiary`（与思考块 toggle 一致），hover 时变为 `--sa-text-secondary`

---

## 4. 视觉层次

### 折叠态

```
🔧 读取 app.tsx 等 5 项              ▸
```

- 无边框、无背景色，与现有思考/工具行同级别
- chevron 指向右

### 展开态

```
🔧 读取 app.tsx 等 5 项              ▾
│ 🧠 思考中
│ 🔧 读取 app.tsx
│ 🔧 编辑 app.tsx
┆
```

- 无容器边框、无容器背景色
- 批次内部卡片流左侧加一条 **2px accent 细线**（`--sa-chat-assistant-accent`，与 assistant 文本左侧 accent 线一致），作为同组微弱视觉线索
- 内部卡片保持现有 `gap: 8px`，零改动
- chevron 指向下

### 批次间距

批次之间（折叠态概述行之间）间距保持 8px，与现有 `.chat-activity-track` 的 gap 一致。

---

## 5. 折叠行为

| 场景 | 行为 |
|------|------|
| 已完成批次 | 自动折叠为概述行，折叠动画 150ms |
| 进行中的批次 | **始终保持展开**，不折叠 |
| 最新完成的批次 | 完成后保持展开 **5 秒**，然后自动折叠 |
| 钉住的批次 | 用户点击概述行上的 📌 图标钉住，永不自动折叠 |

---

## 6. 动画

- **折叠**：`grid-template-rows: 1fr → 0fr`，150ms，`--sa-ease-out`
- **展开**：`grid-template-rows: 0fr → 1fr`，200ms，`--sa-ease-out`
- **`prefers-reduced-motion: reduce`**：瞬间切换，无过渡
- 内部卡片进入展开批次时无额外入场动画（保持现有行为）

---

## 7. 组件设计

### 新增组件：`ActivityBatch`

```
ActivityBatch
├── batchHeader（概述行）
│   ├── 首条目图标（ToolRowIcon / Brain）
│   ├── 标签文字 + "等 N 项"
│   ├── Pin 按钮（可选，hover 可见）
│   └── Chevron（▸/▾）
└── batchBody（卡片列表容器，可折叠）
    └── 原始 ThinkingBlock / ToolCallCard 列表（无改动）
```

**Props**：
- `items: ActivityTimelineItem[]`（批次内条目列表）
- `autoCollapse: boolean`（是否自动折叠，进行中的批次为 false）
- `onTogglePin: () => void`
- `pinned: boolean`

### 修改：`ChatBubble`

在 `ChatBubble.tsx` 的 `chat-activity-track` 渲染循环中，将连续的 `thinking` / `tool` 条目按分组规则归组后，用 `ActivityBatch` 包裹，替代原来直接逐个渲染 `ThinkingBlock` / `ToolCallCard` 的方式。

### 数据流

```
ChatBubble
  ├── 从 message 获取 activityTimeline
  ├── 按分组规则（用户消息/文本回复/空闲超时）将 timeline 切分为批次
  ├── 每个批次包裹为 <ActivityBatch>
  │   └── 内部渲染原始 ThinkingBlock / ToolCallCard
  └── 文本回复、skill 提示等非批次的条目直接渲染
```

### 空闲超时检测

在 `ChatBubble` 或 `ChatView` 层维护一个计时器：当最后一个批次的最新条目 `timestamp` 距今超过 3 分钟且无新消息流入时，标记该批次为已完成并触发折叠。

---

## 8. 兼容性

- 现有 `ThinkingBlock` 和 `ToolCallCard` 组件**零改动**
- 现有 CSS token 全部复用，不新增自定义颜色
- 暗色主题自动适配（通过 `--sa-*` token）
- i18n：新增 key `batch.count`（"等 {count} 项"）、`batch.thinkingCount`（"思考中 等 {count} 项"）

---

## 9. 与设计系统的一致性

- 符合 **Flat-By-Default Rule**：概述行 rest 态无边框无阴影
- 符合 **The One Voice Rule**：accent 线复用 `--sa-chat-assistant-accent`，不引入新颜色
- 符合 **精致来自克制**：不增加装饰，仅通过间距和一条 accent 线建立层级
- 动画曲线使用 `--sa-ease-out`，时长在 150–250ms 范围内
