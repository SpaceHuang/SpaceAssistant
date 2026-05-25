# Composer Hint 自适应隐藏 — 设计文档

**日期：** 2026-05-26
**状态：** 已确认

---

## 目标

当 `composer-footer` 左侧区域因窗口变窄或面板变宽导致元素无法同行时，自动隐藏 `composer-hint`；空间恢复后自动重新显示。

## 修改范围

仅涉及 2 个文件：
- `src/renderer/components/Chat/MessageInput.tsx` — 组件逻辑
- `src/renderer/theme/layout.css` — 样式

## CSS 变更

### `.composer-hint` 修改

新增属性：
- `white-space: nowrap` — 不允许内部换行
- `flex-shrink: 0` — 不允许收缩

### `.composer-hint--hidden` 新增

```css
.composer-hint--hidden {
  visibility: hidden;
  position: absolute;
  pointer-events: none;
}
```

使用 `visibility: hidden` + `position: absolute` 而非 `display: none`，以便 JS 仍能通过 `offsetWidth` 读取元素自然宽度，同时从布局流中移除释放空间。

### `.composer-model-chip` 修改

新增 `flex-shrink: 0`（已有 `white-space: nowrap`）。

## 组件逻辑变更

### 新增 ref

- `leftRowRef` — 绑定到左侧 flex 容器 div
- `hintRef` — 绑定到 composer-hint span
- `modelChipRef` — 绑定到 composer-model-chip span

### 新增 state

- `hintHidden: boolean` — 控制是否隐藏 hint，默认 `false`

### 新增 effect

`useEffect` 中创建 `ResizeObserver` 监听 `leftRowRef.current`，回调中执行测量：

1. 获取容器宽度：`leftRowRef.current.clientWidth`
2. 获取各子元素宽度：select（实际 `offsetWidth`）、modelChip（若有，`offsetWidth`）、hint（`offsetWidth`）
3. 计算所需总宽：`selectWidth + gap(8) + chipWidth(若有+gap) + hintWidth`
4. 比较：`hintHidden = neededWidth > containerWidth`

### hint 渲染条件

```tsx
<span
  ref={hintRef}
  className={`composer-hint${hintHidden && !running ? ' composer-hint--hidden' : ''}`}
>
```

当 `running === true` 时，始终不加 `--hidden` class，始终显示。

## 边界情况

| 情况 | 处理 |
|------|------|
| running 状态 | 不隐藏，始终显示 |
| modelLabel 为空（无 modelChip） | chipWidth = 0，仅计算 select + hint |
| 快速拖动分隔线 | ResizeObserver 原生按帧回调，不产生闪烁 |
| hint 隐藏后读宽度 | `position: absolute` 元素仍有 `offsetWidth` |
| modelLabel 动态变化 | ResizeObserver 持续监听，自动重新测量 |

## 验收标准

| # | 验收项 |
|---|--------|
| A1 | 窗口缩小到元素无法同行时，hint 自动隐藏 |
| A2 | 窗口恢复后，hint 自动重新显示 |
| A3 | 拖动左侧栏分隔线增大面板，同上行为 |
| A4 | 模型标签不存在时，宽度判断仍然正确 |
| A5 | running 状态下，hint 始终显示 |
| A6 | 隐藏/显示切换不引起布局抖动 |
| A7 | 快速拖动分隔线时无视觉异常 |