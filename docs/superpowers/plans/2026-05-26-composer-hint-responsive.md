# Composer Hint 自适应隐藏 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 composer-footer 左侧空间不足时自动隐藏 hint 提示文案，空间恢复后重新显示。

**Architecture:** 在 MessageInput 组件中使用 ResizeObserver 监听左侧容器宽度，与子元素自然宽度之和比较，通过 CSS class 切换实现 hint 的隐藏/显示。

**Tech Stack:** React 18, TypeScript, CSS, ResizeObserver API

---

### Task 1: 更新 CSS 样式

**Files:**
- Modify: `src/renderer/theme/layout.css:640-643` (`.composer-hint`)
- Modify: `src/renderer/theme/layout.css:628-638` (`.composer-model-chip`)
- Modify: `src/renderer/theme/layout.css` (新增 `.composer-hint--hidden`)

- [ ] **Step 1: 为 `.composer-hint` 添加防折行和防收缩属性**

在 `layout.css` 第 640-643 行，将：

```css
.composer-hint {
  font-size: 11px;
  color: var(--sa-text-tertiary);
}
```

改为：

```css
.composer-hint {
  font-size: 11px;
  color: var(--sa-text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
}
```

- [ ] **Step 2: 为 `.composer-model-chip` 添加防收缩属性**

在 `layout.css` 第 628-638 行，在 `.composer-model-chip` 规则块内添加 `flex-shrink: 0;`：

```css
.composer-model-chip {
  font-size: 12px;
  color: var(--sa-text-secondary);
  background: var(--sa-bg-muted);
  padding: 2px 8px;
  border-radius: 999px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
```

- [ ] **Step 3: 新增 `.composer-hint--hidden` 规则**

在 `.composer-hint` 规则块之后添加：

```css
.composer-hint--hidden {
  visibility: hidden;
  position: absolute;
  pointer-events: none;
}
```

- [ ] **Step 4: 提交**

```bash
git add src/renderer/theme/layout.css
git commit -m "style: composer-hint 添加防折行属性及隐藏样式"
```

---

### Task 2: 实现自适应隐藏逻辑

**Files:**
- Modify: `src/renderer/components/Chat/MessageInput.tsx`

- [ ] **Step 1: 添加 useRef 和 useEffect 导入**

将第 1 行：

```tsx
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
```

改为：

```tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
```

- [ ] **Step 2: 添加 ref 和 state 声明**

在 `textareaRef` 声明（第 40 行）之后，`chatMode` 解构（第 41 行）之前，添加：

```tsx
  const leftRowRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLSpanElement>(null)
  const modelChipRef = useRef<HTMLSpanElement>(null)
  const [hintHidden, setHintHidden] = useState(false)
```

- [ ] **Step 3: 添加 ResizeObserver effect**

在 `send` 函数定义（第 52-57 行）之后，添加 `checkOverflow` 回调和 `useEffect`：

```tsx
  const checkOverflow = useCallback(() => {
    const container = leftRowRef.current
    const hint = hintRef.current
    if (!container || !hint) return

    const containerWidth = container.clientWidth
    const selectEl = container.querySelector('.composer-mode-select') as HTMLElement | null
    const selectWidth = selectEl ? selectEl.offsetWidth : 108
    const chipWidth = modelChipRef.current ? modelChipRef.current.offsetWidth : 0
    const hintWidth = hint.offsetWidth

    const gap = 8
    let neededWidth = selectWidth + gap + hintWidth
    if (chipWidth > 0) {
      neededWidth = selectWidth + gap + chipWidth + gap + hintWidth
    }

    setHintHidden(neededWidth > containerWidth)
  }, [])

  useEffect(() => {
    const container = leftRowRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      checkOverflow()
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [checkOverflow])
```

- [ ] **Step 4: 在 model chip 上绑定 ref**

将第 104 行：

```tsx
            {modelLabel ? <span className="composer-model-chip">{modelLabel}</span> : null}
```

改为：

```tsx
            {modelLabel ? <span ref={modelChipRef} className="composer-model-chip">{modelLabel}</span> : null}
```

- [ ] **Step 5: 在 hint span 上绑定 ref 并应用条件 className**

将第 105 行：

```tsx
            <span className="composer-hint">{running ? '执行中，Enter 或点击右侧按钮中止' : 'Enter 发送，Shift+Enter 换行'}</span>
```

改为：

```tsx
            <span
              ref={hintRef}
              className={`composer-hint${hintHidden && !running ? ' composer-hint--hidden' : ''}`}
            >
              {running ? '执行中，Enter 或点击右侧按钮中止' : 'Enter 发送，Shift+Enter 换行'}
            </span>
```

- [ ] **Step 6: 在左侧 div 上绑定 ref**

将第 90 行：

```tsx
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
```

改为：

```tsx
          <div ref={leftRowRef} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
```

- [ ] **Step 7: 提交**

```bash
git add src/renderer/components/Chat/MessageInput.tsx
git commit -m "feat: composer-hint 根据容器宽度自适应隐藏"
```

---

### Task 3: 验证

- [ ] **Step 1: 启动开发服务器验证**

```bash
npm run dev
```

手动验证：
1. 缩小主窗口宽度，观察 hint 是否在空间不足时自动隐藏
2. 恢复窗口宽度，观察 hint 是否重新显示
3. 拖动左侧栏分隔线增大面板宽度，观察行为
4. 切换模型（有/无 modelLabel），验证判断正确
5. 发送消息进入 running 状态，确认 hint 始终显示
6. 快速拖动窗口/分隔线，确认无闪烁

- [ ] **Step 2: 提交（如有修复）**

如有任何修复，提交修正。否则此任务无需提交。 |