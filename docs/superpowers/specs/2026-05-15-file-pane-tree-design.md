# File Pane Tree — Design Spec

## Overview

Replace the flat file list in the sider's FilePane with a tree browser backed by antd `DirectoryTree`. Support directory expand/collapse with lazy loading, toolbar actions (new file, new directory, refresh), context menu (add to chat, copy paths, rename, delete), inline input for create/rename, delete confirmation modal, and drag-and-drop move. Add 5 new backend IPC channels for file CRUD and move operations.

---

## 1. Data Model

```ts
interface FileTreeNode {
  key: string         // relPath, e.g. "src/utils/helper.ts"
  name: string        // file/directory name
  relPath: string     // relative path (same as key, convenient for passing around)
  isDirectory: boolean
  size?: number       // files only
  expanded: boolean   // directories only
  loading: boolean    // directories only, children being loaded
  children: FileTreeNode[]  // always present; empty = not loaded or no children
}
```

- Root node is workDir itself, always expanded, displays as project root name
- Child nodes sorted: directories first, then files, alphabetically within each group
- Directories use lazy loading: `fileListDirectory` called on expand; `children` is empty before first expand

---

## 2. State Management — `useFileTree` Hook

Core hook encapsulating all tree business logic, returns antd Tree-compatible props and callbacks. Receives `workDir: string` as parameter (sourced from config store via `useTypedSelector`).

### State

- `treeData: FileTreeNode[]` — root node array (single root)
- `expandedKeys: string[]` — antd Tree controlled expand
- `selectedKey: string | null` — currently selected node
- `inlineInput: { parentKey: string; type: 'file' | 'directory'; defaultName: string } | null`
- `renamingKey: string | null`

### Internal

- `nodeMap: Map<string, FileTreeNode>` — O(1) lookup index, rebuilt on tree mutations
- Tree mutations update `nodeMap` then derive new `treeData`

### Operations

| Method | Behavior |
|--------|----------|
| `toggleExpand(key)` | If directory not loaded, call `fileListDirectory`, populate children. Toggle `expanded`. |
| `refreshTree()` | Clear all, reload root children from `fileListDirectory('')`. |
| `refreshDirectory(key)` | Reload children of the given directory node. |
| `createFile(parentKey, name)` | Call `fileCreateFile`, then `refreshDirectory(parentKey)`. |
| `createDirectory(parentKey, name)` | Call `fileCreateDirectory`, then `refreshDirectory(parentKey)`. |
| `deleteNode(key)` | Call `fileDelete`, remove node from parent's children. |
| `renameNode(key, newName)` | Call `fileRename`, update node name + key. |
| `onDrop(info)` | Validate (not self/child, not same parent), call `fileMove`, then remove from old parent + refresh new parent. |

---

## 3. Component Structure

```
FilePane (refactored from App.tsx inline function)
├── FileTreeToolbar         — new file / new directory / refresh buttons
└── antd DirectoryTree
    └── titleRender → FileTreeNode
        ├── expand triangle (antd built-in)
        ├── icon (folder_line / folder_open_line / file_line)
        ├── name text OR InlineInput (create/rename)
        └── right-click → FileTreeContextMenu
            ├── 添加到对话 (placeholder: message.info)
            ├── 复制路径 / 复制相对路径
            ├── 重命名...
            └── 删除 → DeleteConfirmModal
```

### FileTree

- Main component composing `useFileTree` + antd `DirectoryTree`
- Converts `FileTreeNode[]` to antd `DataNode[]`
- `titleRender` delegates to `FileTreeNode`
- `onRightClick` opens `FileTreeContextMenu`
- `onDrop` delegates to hook
- Controlled `expandedKeys` + `selectedKeys`
- Click file → preview in right panel (existing behavior)
- Click directory → toggle expand

### FileTreeNode

- Pure render component
- Shows `folder_line` (collapsed) / `folder_open_line` (expanded) / `file_line` icon
- Normal mode: name text
- If in create/rename state: renders `InlineInput`

### InlineInput

- Props: `defaultValue`, `onConfirm(name)`, `onCancel()`, `autoFocus`, `autoSelectAll`
- Enter confirms, Escape cancels, blur confirms
- Width 100%, replaces name text area

### FileTreeContextMenu

- antd `Dropdown` with custom menu
- Separators per requirement section 4.2
- "添加到对话" → `message.info('功能开发中')`
- "复制路径" → `navigator.clipboard.writeText(workDir + relPath)`
- "复制相对路径" → `navigator.clipboard.writeText(relPath)`
- "重命名..." → `setRenamingKey(key)`
- "删除" → open `DeleteConfirmModal`

### DeleteConfirmModal

- Title: "确认删除"
- Content: `确定要删除 "{name}" 吗？` + directory-specific or file-specific warning
- Buttons: 取消 (default focus) | 删除 (red danger)
- Uses antd `Modal`

### FileTreeToolbar

- Three icon buttons in `sider-content-header` right side
- No text, tooltip on hover
- New file → `setInlineInput({ parentKey: selectedKey || rootKey, type: 'file', defaultName: 'untitled' })`
- New directory → same with `type: 'directory'`, defaultName: '新建文件夹'
- Refresh → `refreshTree()`

---

## 4. Style Overrides

Applied via scoped CSS class on FileTree container to avoid affecting other antd Tree instances:

| Property | Value |
|----------|-------|
| Row height | 32px (override antd default 28px) |
| Selected row background | `rgba(22,119,255,0.12)` |
| Hover background | `rgba(0,0,0,0.04)` |
| Indent per level | 16px (override antd default 24px) |
| Drag highlight | `rgba(22,119,255,0.08)` on drop target directory |
| Dragging node | `opacity: 0.5` |

---

## 5. Backend API — 5 New IPC Channels

| IPC Channel | Signature | Implementation |
|-------------|-----------|----------------|
| `file:create-file` | `(relPath: string) => Promise<void>` | `resolveSafePath` → `fs.mkdir` intermediate dirs → `fs.writeFile(path, '')` |
| `file:create-directory` | `(relPath: string) => Promise<void>` | `resolveSafePath` → `fs.mkdir(path, { recursive: true })` |
| `file:delete` | `(relPath: string) => Promise<void>` | `resolveSafePath` → `fs.rm(path, { recursive: true, force: true })` |
| `file:rename` | `(relPath: string, newName: string) => Promise<void>` | Validate `newName` has no `/` or `\` → `resolveSafePath` → `fs.rename(old, path.join(dir, newName))` |
| `file:move` | `(srcRelPath: string, destDirRelPath: string) => Promise<void>` | Dual `resolveSafePath` → verify dest is directory → `fs.rename(src, path.join(dest, basename))` |

### Files to modify

1. `src/shared/api.ts` — add 5 method signatures to `SpaceAssistantApi`
2. `electron/preload.ts` — add 5 `ipcRenderer.invoke` mappings
3. `electron/appIpc.ts` — add 5 `ipcMain.handle` handlers

All follow the same pattern as existing `file:list-directory` and `file:read-file`.

### Security

- All handlers use existing `resolveSafePath` to prevent path traversal
- `file:rename` rejects `newName` containing `/` or `\`
- `file:move` verifies destination is a directory

---

## 6. Icons

Source: Mingcute icon set at `res/mingcute-icons-main/svg/`. Copy to `src/renderer/assets/` and use existing `patchSvg` pattern (replace `fill="#09244B"` with `fill="currentColor"`).

| Usage | Source file | Target asset |
|-------|-----------|-------------|
| Directory (collapsed) | `file/folder_line.svg` | already exists |
| Directory (expanded) | `file/folder_open_line.svg` | `folder_open_line.svg` |
| File | `file/file_line.svg` | `file_line.svg` |
| New file | `system/add_line.svg` | `add_line.svg` |
| New directory | `file/new_folder_line.svg` | `new_folder_line.svg` |
| Refresh | `system/refresh_2_line.svg` | `refresh_2_line.svg` |
| Delete | `system/delete_line.svg` | `delete_line.svg` |
| Rename | `editor/pencil_line.svg` | `pencil_line.svg` |
| Copy | `file/copy_line.svg` | `copy_line.svg` |

---

## 7. Drag and Drop

antd `DirectoryTree` has built-in draggable support via `draggable` prop and `onDrop` callback.

### Rules

- Draggable: file and directory nodes
- Valid drop targets: directory nodes only
- Invalid drops: drop on self, drop on own descendant, drop on same parent directory
- antd Tree provides `info.dragNode`, `info.node`, `info.dropPosition` etc.

### Visual feedback

- Dragging node: `opacity: 0.5` via CSS
- Drop target directory highlight: `rgba(22,119,255,0.08)` via `dropIndicatorRender` override or CSS
- Invalid target: cursor `not-allowed` via `allowDrop` callback returning false

### Behavior

- On valid drop: call `file:move` API
- Success: remove node from old parent, refresh new parent children
- Failure: `message.error`, no tree state change

---

## 8. Testing Strategy

### Test framework

Vitest + `@testing-library/react` + `jsdom` environment (new setup, project currently has no test config).

### Unit tests — `useFileTree` hook

Mock `window.api`, test with `renderHook`:

- Initial load: `treeData` contains root directory children
- Expand/collapse: `toggleExpand` calls `fileListDirectory`, `expandedKeys` updates
- Lazy loading: unloaded directory has empty children; populated after expand
- Sort order: directories first, then alphabetical
- Create file/directory: calls API then refreshes parent
- Delete: calls API then removes node from tree
- Rename: validates, calls API, updates node
- Drag validation: rejects self-drop, child-drop, same-parent-drop
- Inline input state: `inlineInput` / `renamingKey` toggle

### Unit tests — Backend IPC handlers

Mock `fs/promises`, test 5 new handlers:

- Normal path: operation succeeds
- Security: `relPath` with `..` rejected
- `file:rename`: `newName` with `/` or `\` rejected
- `file:move`: destination not a directory rejected
- `file:create-file`: intermediate directories auto-created

### Component tests — React Testing Library

- **FileTreeToolbar**: three buttons trigger correct callbacks
- **InlineInput**: Enter confirms, Escape cancels, blur confirms, selects all default text
- **DeleteConfirmModal**: cancel closes, confirm triggers delete, different text for dir vs file
- **FileTreeContextMenu**: menu items render, separators present, clicks trigger actions

### Not tested

- antd Tree internal behavior (expand/collapse/virtual scroll) — guaranteed by antd
- Icon rendering correctness — visual verification

---

## 9. Out of Scope

- File content editing (read-only preview only)
- File extension-specific icon differentiation (unified file icon)
- Git status markers
- File search/filter in tree
- Full "add to chat" implementation (placeholder only)
- Multi-select operations
