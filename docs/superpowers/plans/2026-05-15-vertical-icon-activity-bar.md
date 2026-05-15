# Vertical Icon Activity Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the horizontal Ant Design Tabs in the left Sider with a VS Code-style vertical icon column (Activity Bar) to save UI space.

**Architecture:** Split the left Sider into two columns — a narrow 48px Activity Bar on the left with icon buttons, and a content pane on the right. State managed with `useState` instead of Ant Design `Tabs`. SVG icons imported as raw strings from `res/mingcute-icons-main/svg/`.

**Tech Stack:** React 18, TypeScript, Ant Design 5 (Layout only), Vite, inline SVG

---

### Task 1: Copy required SVG icons to src/renderer/assets

Copy the 7 SVG files needed for the Activity Bar into the renderer's assets directory so Vite can import them cleanly.

**Files:**
- Copy: `res/mingcute-icons-main/svg/contact/chat_3_line.svg` → `src/renderer/assets/chat_3_line.svg`
- Copy: `res/mingcute-icons-main/svg/contact/chat_3_fill.svg` → `src/renderer/assets/chat_3_fill.svg`
- Copy: `res/mingcute-icons-main/svg/file/folder_line.svg` → `src/renderer/assets/folder_line.svg`
- Copy: `res/mingcute-icons-main/svg/file/folder_fill.svg` → `src/renderer/assets/folder_fill.svg`
- Copy: `res/mingcute-icons-main/svg/file/search_line.svg` → `src/renderer/assets/search_line.svg`
- Copy: `res/mingcute-icons-main/svg/file/search_fill.svg` → `src/renderer/assets/search_fill.svg`
- Copy: `res/mingcute-icons-main/svg/system/settings_1_line.svg` → `src/renderer/assets/settings_1_line.svg`

- [ ] **Step 1: Create assets directory**

```bash
mkdir -p src/renderer/assets
```

- [ ] **Step 2: Copy SVG files**

```bash
cp res/mingcute-icons-main/svg/contact/chat_3_line.svg src/renderer/assets/chat_3_line.svg
cp res/mingcute-icons-main/svg/contact/chat_3_fill.svg src/renderer/assets/chat_3_fill.svg
cp res/mingcute-icons-main/svg/file/folder_line.svg src/renderer/assets/folder_line.svg
cp res/mingcute-icons-main/svg/file/folder_fill.svg src/renderer/assets/folder_fill.svg
cp res/mingcute-icons-main/svg/file/search_line.svg src/renderer/assets/search_line.svg
cp res/mingcute-icons-main/svg/file/search_fill.svg src/renderer/assets/search_fill.svg
cp res/mingcute-icons-main/svg/system/settings_1_line.svg src/renderer/assets/settings_1_line.svg
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/assets/
git commit -m "chore: add Activity Bar SVG icons from mingcute set"
```

---

### Task 2: Add Activity Bar CSS styles

Add styles for the Activity Bar and its icon buttons to `styles.css`.

**Files:**
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add Activity Bar styles to styles.css**

Append the following to `src/renderer/styles.css`:

```css
.activity-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 48px;
  min-width: 48px;
  border-right: 1px solid #f0f0f0;
  padding-top: 4px;
  justify-content: space-between;
}

.activity-bar-top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}

.activity-bar-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 8px;
}

.activity-bar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: none;
  background: transparent;
  cursor: pointer;
  position: relative;
  color: #8c8c8c;
}

.activity-bar-btn:hover {
  background: rgba(0, 0, 0, 0.04);
  color: #434343;
}

.activity-bar-btn.active {
  color: #1677ff;
}

.activity-bar-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: #1677ff;
  border-radius: 1px;
}

.activity-bar-btn svg {
  width: 24px;
  height: 24px;
}

.activity-bar-btn svg path[fill="#09244B"] {
  fill: currentColor;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/styles.css
git commit -m "style: add Activity Bar CSS styles"
```

---

### Task 3: Rewrite App.tsx — replace Tabs with Activity Bar + content pane

Remove Ant Design `Tabs`, implement Activity Bar with `useState`, and render content panes conditionally.

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Update imports in App.tsx**

Replace line 2:
```tsx
import { Button, Empty, Input, Layout, List, Tabs, Typography, message } from 'antd'
```
with:
```tsx
import { Button, Empty, Input, Layout, List, Typography, message } from 'antd'
```

Add after the existing imports (after line 11):
```tsx
import chatLineSvg from './assets/chat_3_line.svg?raw'
import chatFillSvg from './assets/chat_3_fill.svg?raw'
import folderLineSvg from './assets/folder_line.svg?raw'
import folderFillSvg from './assets/folder_fill.svg?raw'
import searchLineSvg from './assets/search_line.svg?raw'
import searchFillSvg from './assets/search_fill.svg?raw'
import settingsSvg from './assets/settings_1_line.svg?raw'
```

Add `useMemo` to the react import on line 1:
```tsx
import { useEffect, useMemo, useState } from 'react'
```

- [ ] **Step 2: Add IconTab helper component**

Add this component before `AppShell` (after `SearchPane`, around line 157):

```tsx
function IconTab({
  lineSvg,
  fillSvg,
  active,
  onClick,
  title
}: {
  lineSvg: string
  fillSvg: string
  active: boolean
  onClick: () => void
  title: string
}) {
  const svg = useMemo(
    () => (active ? fillSvg : lineSvg),
    [active, fillSvg, lineSvg]
  )
  return (
    <button
      type="button"
      className={`activity-bar-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={title}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
```

- [ ] **Step 3: Replace the Sider content in AppShell**

Replace the Sider section (lines 178-189):
```tsx
<Layout.Sider width={280} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
  <Tabs
    defaultActiveKey="sessions"
    items={[
      { key: 'sessions', label: '会话', children: <LeftSessions /> },
      { key: 'files', label: '文件', children: <FilePane /> },
      { key: 'search', label: '搜索', children: <SearchPane /> }
    ]}
    style={{ height: '100%' }}
    tabBarStyle={{ paddingLeft: 8 }}
  />
</Layout.Sider>
```

with:
```tsx
<Layout.Sider width={280} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', padding: 0 }}>
  <div className="activity-bar">
    <div className="activity-bar-top">
      <IconTab lineSvg={chatLineSvg} fillSvg={chatFillSvg} active={siderKey === 'sessions'} onClick={() => setSiderKey('sessions')} title="会话" />
      <IconTab lineSvg={folderLineSvg} fillSvg={folderFillSvg} active={siderKey === 'files'} onClick={() => setSiderKey('files')} title="文件" />
      <IconTab lineSvg={searchLineSvg} fillSvg={searchFillSvg} active={siderKey === 'search'} onClick={() => setSiderKey('search')} title="搜索" />
    </div>
    <div className="activity-bar-bottom">
      <button
        type="button"
        className="activity-bar-btn"
        onClick={() => dispatch(setSettingsOpen(true))}
        title="设置"
        dangerouslySetInnerHTML={{ __html: settingsSvg }}
      />
    </div>
  </div>
  <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
    {siderKey === 'sessions' && <LeftSessions />}
    {siderKey === 'files' && <FilePane />}
    {siderKey === 'search' && <SearchPane />}
  </div>
</Layout.Sider>
```

- [ ] **Step 4: Add siderKey state to AppShell**

Add inside `AppShell` function, after line 160 (`const dispatch = useAppDispatch()`):

```tsx
const [siderKey, setSiderKey] = useState<'sessions' | 'files' | 'search'>('sessions')
```

- [ ] **Step 5: Remove the "设置" button from the header bar**

Since settings now lives in the Activity Bar, remove the header settings button. Replace lines 191-195:
```tsx
<div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between' }}>
  <Text strong>SpaceAssistant</Text>
  <Button size="small" onClick={() => dispatch(setSettingsOpen(true))}>
    设置
  </Button>
</div>
```
with:
```tsx
<div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0' }}>
  <Text strong>SpaceAssistant</Text>
</div>
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: replace horizontal Tabs with vertical Activity Bar"
```

---

### Task 4: Verify in dev server

Run the dev server and verify the Activity Bar works correctly.

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Manual verification checklist**
- Activity Bar shows 3 icons vertically on the left edge of the Sider
- Clicking each icon switches the content pane (sessions, files, search)
- Selected icon shows fill variant + blue left border indicator + blue color
- Unselected icons show line variant + gray color
- Hover shows subtle gray background
- Settings icon at bottom opens ConfigModal
- No visual regressions in content panes
