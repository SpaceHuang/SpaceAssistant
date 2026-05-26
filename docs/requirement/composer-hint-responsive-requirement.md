# 聊天输入区 — 自适应隐藏提示文案需求规格

**版本：** 1.0
**日期：** 2026-05-26
**状态：** 待评审

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [功能需求](#3-功能需求)
4. [技术方案](#4-技术方案)
5. [交互规格](#5-交互规格)
6. [验收标准](#6-验收标准)

---

## 1. 概述

### 1.1 功能定位

`composer-footer` 左侧区域包含三个串联元素：模式选择器（Select）、模型标签（composer-model-chip）、键盘提示（composer-hint）。当主窗口变窄或用户拖动左侧栏宽度增大，导致该行无法容纳所有元素时，优先隐藏提示文案；待容器恢复足够宽度后自动重新显示。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 当左侧元素行发生折行时，自动隐藏 `composer-hint` |
| G2 | 当容器宽度恢复到能容纳所有元素时，自动重新显示 `composer-hint` |
| G3 | 隐藏/显示切换流畅无闪烁，不产生布局抖动 |
| G4 | 不影响 `composer-model-chip`（不存在时，仅判断模式选择器 + hint 是否能同行） |

### 1.3 非目标

- 不改变 compose-footer 的整体布局结构（flex + space-between）
- 不改变左侧元素的渲染顺序
- 不处理 `composer-hint` 内容动态变化的情况（当前内容固定为运行中/常规两种）

---

## 2. 现状分析

### 2.1 当前结构

```
composer-footer (flex, space-between, gap: 8px)
├── div.left (display: flex, flex-wrap: wrap, gap: 8px, min-width: 0)
│   ├── Select (.composer-mode-select, min-width: 108px)
│   ├── span (.composer-model-chip, 可选渲染, white-space: nowrap)
│   └── span (.composer-hint, font-size: 11px)
└── div.right (display: flex, gap: 8px)
    ├── ContextUsageRing
    └── button (.composer-send)
```

### 2.2 触发场景

| 场景 | 说明 |
|------|------|
| 主窗口宽度减小 | 用户手动缩小窗口，或窗口被平铺到半屏 |
| 左侧栏宽度增大 | 用户向右拖动左侧栏分隔线，增大会话/文件面板宽度 |
| 右侧栏宽度增大 | 用户向左拖动右侧栏分隔线（预留位） |
| 主窗口宽度增大 | 反向操作，逐步恢复隐藏元素显示 |

### 2.3 当前问题

当前 `composer-hint` 使用 `flex-wrap: wrap` 后的折行行为完全由 CSS 控制，无论空间多小都会渲染但折行显示。窄窗口下占用额外垂直空间，体验不佳。

---

## 3. 功能需求

### F1: 溢出隐藏

当如下条件满足时，`composer-hint` 应当不可见（`visibility: hidden` 且高度/边距归零，避免布局占位）：

> 左侧容器（div.left）的实际可用宽度 < 所有左侧子元素的最小宽度之和

具体判定逻辑：
1. 通过 `ResizeObserver` 监听 div.left 的实际宽度变化
2. 测量 `模式选择器` + `模型标签（若存在）` + `提示文案` 三者（或两者）的自然宽度之和
3. 若测量宽度 > 容器宽度，则隐藏 `composer-hint`
4. 若测量宽度 <= 容器宽度，则显示 `composer-hint`

### F2: 隐藏方式

使用 `className` 切换（如 `composer-hint--hidden`），CSS 规则：

```css
.composer-hint--hidden {
  visibility: hidden;
  position: absolute;
  pointer-events: none;
}
```

> 注意：不使用 `display: none`，以避免 ResizeObserver 重新测量时的布局抖动。使用 `visibility: hidden` + `position: absolute` 将其从流中移除，既能释放空间，又能在 JS 中保持元素引用以获取自然宽度。

### F3: 模型标签不存在的情况

当 `modelLabel` 为空时，`composer-model-chip` 不渲染。此时仅需判断模式选择器 + 提示文案二者是否能同行。

### F4: 运行状态不适用此规则

当 `running === true` 时，hint 显示"执行中，Enter 或点击右侧按钮中止"，此时始终显示，不参与自适应隐藏逻辑。

---

## 4. 技术方案

### 4.1 组件层实现思路

在 `MessageInput` 中新增：

1. `leftRowRef` — 绑定到 div.left 的元素引用
2. `hintRef` — 绑定到 `composer-hint` span 的元素引用
3. 一个 `useState<boolean>(false)` 控制是否隐藏 hint
4. 一个 `useEffect` 中创建 `ResizeObserver`，回调中测量并更新隐藏状态

测量逻辑伪代码：

```
function checkOverflow() {
  const containerWidth = leftRowRef.current.clientWidth
  const selectWidth = 108 (min-width, 或实际测量)
  const chipWidth = modelLabel ? modelChipRef.current.offsetWidth : 0
  const hintWidth = hintRef.current.offsetWidth (始终可获取，因为是 visibility:hidden 而非 display:none)

  const gap = 8
  const neededWidth = selectWidth + (chipWidth > 0 ? gap + chipWidth : 0) + gap + hintWidth

  setHintHidden(neededWidth > containerWidth)
}
```

> 注意：`visibility: hidden` 的元素仍然占据布局空间，因此 `offsetWidth` 可正常读取。我们使用 `position: absolute` 将其从流中移除释放空间，但 JS 中的 offsetWidth 仍然反映其自然宽度。

**修正**：由于我们需要 `position: absolute` 从流中移除释放空间，但又要能读取 `offsetWidth`，这两者可以兼得——`position: absolute` 的元素仍然有 `offsetWidth`，只要它没有被 `display: none`。

### 4.2 CSS 补充

```css
.composer-hint {
  font-size: 11px;
  color: var(--sa-text-tertiary);
  white-space: nowrap;       /* 新增：不允许内部换行 */
  flex-shrink: 0;            /* 新增：不允许收缩 */
}

.composer-hint--hidden {
  visibility: hidden;
  position: absolute;
  pointer-events: none;
}
```

### 4.3 需要新增的白名单元素

`composer-model-chip` 也需要加上 `flex-shrink: 0` 和 `white-space: nowrap`，确保其宽度不会被压缩导致误判。

### 4.4 边界情况

| 情况 | 处理 |
|------|------|
| hint 被隐藏后容器又被缩小 | 无影响，hint 已隐藏 |
| hint 显示后容器被放大 | 继续显示，正常 |
| 快速拖动分隔线 | ResizeObserver 按帧回调，不会产生闪烁。可选 throttle（rAF 包裹） |
| running 状态 | 始终显示 hint，不参与判断 |
| modelLabel 动态变化 | modelLabel 变化时也需要触发重新测量（已在 ResizeObserver 覆盖范围内） |

---

## 5. 交互规格

### 5.1 状态流转

```
         [容器宽度充足]
         hint 正常显示
              │
    窗口缩小/面板变大
              │
              ▼
         [容器宽度不足]
         hint 隐藏（visibility:hidden + position:absolute）
              │
    窗口放大/面板变小
              │
              ▼
         [容器宽度充足]
         hint 重新显示
```

### 5.2 视觉规格

- 过渡应当平滑：由于使用 `visibility` + `position` 切换，hint 的隐藏和出现不引起其他元素的位置抖动
- hint 隐藏后，右侧元素（ContextUsageRing + Send 按钮）不应发生位置变化

---

## 6. 验收标准

| # | 验收项 |
|---|--------|
| A1 | 主窗口宽度缩小到模式选择器 + 模型标签 + hint 无法同行时，hint 自动隐藏 |
| A2 | 主窗口宽度恢复后，hint 自动重新显示 |
| A3 | 拖动左侧栏分隔线增大左侧面板宽度，同上行为 |
| A4 | 模型标签不存在时（仅模式选择器 + hint），宽度判断仍然正确 |
| A5 | 执行中（running）状态下，hint 始终显示，不受此逻辑影响 |
| A6 | 隐藏/显示切换不引起布局抖动或闪烁 |
| A7 | 快速拖动分隔线时无视觉异常 |