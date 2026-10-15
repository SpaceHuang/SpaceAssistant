# 消息列表「跳到最新」入口 — 需求规格

## 1. 概述

在对话特别长时，用户向上滚动翻看历史后，缺乏快速回到列表末尾查看最新消息的手段。本需求在消息列表右下角增加一个悬浮「跳到最新」按钮：仅当用户向上滚动离开底部时出现，点击后平滑滚动到列表末尾并自动消失。

目标：提升长对话场景下用户在历史与最新消息之间往返的操作体验，不引入额外认知负担。

### 1.1 非目标

- 不统计或展示「离开底部期间新增的未读消息数」角标。
- 不改变现有流式生成时的「贴底自动滚动」行为。
- 不新增独立的导航栏或常驻工具条。

---

## 2. 现状与复用

聊天滚动相关基础设施已存在于代码中，本需求**尽量复用而非新建**：

| 能力 | 位置 | 复用方式 |
|------|------|---------|
| 是否贴底判定（120px 阈值） | `src/renderer/utils/chatScroll.ts` → `isChatScrollNearBottom` | 按钮显隐判定取其反向 |
| 滚动到底部（smooth / 尊重 reduced-motion） | `src/renderer/utils/chatScroll.ts` → `scrollChatToBottom` | 点击时调用 `{ force: true }` |
| 当前贴底状态引用 | `src/renderer/components/Chat/ChatView.tsx` → `stickToBottomRef` | 作为显隐依据的来源 |
| 减弱动画偏好 | `src/renderer/utils/motionPreference.ts` → `scrollBehaviorPreference` | 自动随复用 `scrollChatToBottom` 生效 |

现有滚动监听已在 `ChatView.tsx` 的 `useEffect` 中挂载到 `.chat-scroll` 容器（`onScroll` 更新 `stickToBottomRef.current`）。本需求在该监听基础上派生一个 React state 用于驱动按钮显隐。

---

## 3. 功能行为

### 3.1 显隐规则

| 条件 | 按钮状态 |
|------|---------|
| 距底部 > 120px（即 `isChatScrollNearBottom` 为 false） | 显示 |
| 距底部 ≤ 120px（贴底） | 隐藏 |
| 点击后滚动过程中 | 滚动到位即隐藏（由显隐规则自然收敛） |

- **过渡**：显示/隐藏使用淡入淡出（约 150ms），避免突兀。
- **初始状态**：会话打开时若已贴底则不显示；若打开时定位在历史位置（罕见）则显示。
- **流式生成中**：用户主动上滑后，按钮照常显示；若用户贴底则不显示（与现有自动滚动互不干扰）。

### 3.2 点击行为

- 点击按钮 → 调用 `scrollChatToBottom(scrollRef.current, { force: true, behavior: 'smooth' })`。
- 不强制刷新 `stickToBottomRef`：`onScroll` 在滚动到位后会将其重置为 true，按钮随之隐藏。
- 尊重 `prefers-reduced-motion`：经 `scrollBehaviorPreference` 自动降级为 `auto`（瞬时）。

### 3.3 边界情况

| 场景 | 行为 |
|------|------|
| 切换会话 | 新会话挂载后按其滚动位置重新判定显隐 |
| 消息极少（无滚动条） | 始终贴底，按钮不显示 |
| 滚动期间快速点击多次 | 幂等，重复调用 `scrollChatToBottom` 无副作用 |
| 流式到达新消息导致列表变长 | 若已上滑，按钮保持显示；若贴底则不显示 |

---

## 4. 视觉规格

### 4.1 位置

- 悬浮于 `.chat-scroll` 容器**右下角**，绝对定位，不随列表内容滚动。
- 与容器右边缘、下边缘各留约 `12px` 间距，避免紧贴边角。
- 层级高于消息气泡（`z-index` 高于消息内容，低于弹窗/抽屉类浮层）。
- 不得遮挡输入区：按钮位于滚动容器可视区内，输入区为独立兄弟节点，二者无重叠。

### 4.2 外观

| 属性 | 规格 |
|------|------|
| 形状 | 圆形 |
| 尺寸 | 32×32 px |
| 背景 | 半透明深色背景（沿用应用气泡/工具栏色板，保证在浅色与深色消息上均可读） |
| 图标 | 向下箭头（`arrow/` 系，如 `arrow-down`），`currentColor`，约 16px |
| 投影 | 轻微阴影，增强浮层层次感 |
| Hover | 背景加深、光标 `pointer` |
| 进入/退出 | 淡入淡出 150ms（`prefers-reduced-motion` 时无过渡） |

> 图标来源：从 `res/mingcute-icons-main/svg/arrow/` 复制对应 SVG 到 `src/renderer/assets/`，按现有 `?raw` + `currentColor` 方式使用。

### 4.3 文案

按钮仅图标，不显示文字。提供 `title`（原生 tooltip）与 `aria-label` 用于无障碍与悬停提示：

| 文案 | 值 |
|------|----|
| tooltip / aria-label | 「跳到最新消息」 |

---

## 5. 无障碍

- 按钮为原生 `<button>`，键盘 `Tab` 可聚焦，`Enter` / `Space` 触发与点击相同行为。
- `aria-label` 描述用途。
- 焦点可见样式（focus ring）需可见，不与圆形外观冲突。
- 动效全部经 `prefers-reduced-motion` 降级。

---

## 6. 国际化

- 新增翻译 key，归属 `chat` 命名空间：
  - `chat.scrollToLatest.label` = 「跳到最新消息」
- 禁止硬编码中文，所有可见文案走 `t()`。
- 新增 key 后运行 `npm run i18n:generate-types` 更新类型，提交前 `npm run i18n:check` 校验。

---

## 7. 影响范围

| 文件 | 改动 |
|------|------|
| `src/renderer/components/Chat/ChatView.tsx` | 新增按钮元素、显隐 state（由现有 `onScroll` 派生）、点击处理 |
| `src/renderer/styles.css`（或对应布局样式文件） | 新增 `.chat-scroll-to-latest` 样式 |
| `src/renderer/assets/` | 新增向下箭头 SVG |
| `src/renderer/i18n/resources/zh-CN/chat.json` 及其他 locale | 新增 `scrollToLatest.label` |

不改领域类型、不改数据流、不新增 IPC 通道、不触及主进程。

---

## 8. 测试

| 用例 | 期望 |
|------|------|
| 贴底时 | 按钮不可见 |
| 上滑超过 120px | 按钮淡入显示 |
| 点击按钮 | 列表平滑滚到底部，到位后按钮隐藏 |
| `prefers-reduced-motion` | 滚动瞬时完成、无淡入淡出过渡 |
| 消息不足以产生滚动条 | 按钮始终不显示 |
| 键盘聚焦 + Enter | 与点击等价 |
| 流式生成中上滑 | 按钮显示；贴底时不显示 |

测试文件就近放置：`src/renderer/components/Chat/ChatView.scrollToLatest.test.tsx`（如现有 `ChatView.*.test.tsx` 命名风格允许复用）。

---

## 9. 验收标准

1. 用户向上滚动离开底部后，右下角出现「跳到最新」按钮；贴底时不出现。
2. 点击按钮平滑回到列表末尾，按钮随之消失。
3. 纯图标，无未读计数；hover/聚焦有清晰提示。
4. 尊重 `prefers-reduced-motion`，键盘可操作。
5. 文案通过 `t()` 国际化，i18n 校验通过。
6. 不影响现有流式贴底自动滚动行为。
