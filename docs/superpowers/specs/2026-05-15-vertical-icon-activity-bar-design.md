# Vertical Icon Activity Bar Design

## Goal
Replace the horizontal Ant Design Tabs in the left Sider with a VS Code-style vertical icon column (Activity Bar) to save UI space.

## Layout
- Sider (280px) splits into two columns:
  - **Activity Bar** (~48px): vertical icon column on the left edge
  - **Content Pane** (~232px): displays the active panel (sessions, files, search)

## Activity Bar
- 3 icon buttons stacked vertically: Sessions, Files, Search
- Icons from `res/mingcute-icons-main/svg/`:
  - Sessions: `contact/chat_3_line.svg` / `contact/chat_3_fill.svg`
  - Files: `file/folder_line.svg` / `file/folder_fill.svg`
  - Search: `file/search_line.svg` / `file/search_fill.svg`
- Selection state:
  - Unselected: `_line` (outline) icon, transparent background
  - Selected: `_fill` (solid) icon, light background, blue left border indicator
  - Hover: light gray background
- Bottom area: settings icon (`system/settings_1_line.svg`), opens ConfigModal via `setSettingsOpen`

## Content Pane
- Renders `LeftSessions`, `FilePane`, or `SearchPane` based on active key
- Components unchanged

## Code Changes
- `App.tsx`: Remove `Tabs`, add `useState` for `activeKey`, build Activity Bar + content area layout
- Import SVG icons as React components (Vite handles SVG imports)
- Add CSS for Activity Bar styling (icon sizing, hover/active states, left border indicator)

## No Changes
- `LeftSessions`, `FilePane`, `SearchPane` components
- `ConfigModal`, `AboutModal`
- Redux store slices
