# 文件面板树状展示 — 需求规格

## 1. 概述

将文件 Tab 的平铺列表改为树状浏览器，支持目录展开/折叠、工具栏操作、右键菜单、拖拽移动，使之接近 VS Code 资源管理器的体验。

---

## 2. 树状结构

### 2.1 数据模型

```
FileTreeNode {
  name: string          // 文件/目录名
  relPath: string       // 相对于 workDir 的相对路径（如 "src/utils/helper.ts"）
  isDirectory: boolean
  size?: number         // 仅文件
  expanded?: boolean    // 仅目录，是否展开
  children?: FileTreeNode[]  // 仅目录，展开后懒加载填充
  loading?: boolean     // 仅目录，子节点加载中
}
```

- 根节点为 workDir 本身，始终展开，显示为项目根目录名
- 子节点按 **目录优先** → **文件其次** 排序，同类型按名称字典序
- 目录节点采用懒加载：点击展开时调用 `fileListDirectory`，首次展开前 `children` 为空

### 2.2 渲染规则

- 目录：显示展开/折叠三角图标 + 文件夹图标 + 目录名
  - 未展开：`folder_line` 图标
  - 已展开：`folder_open_line` 图标（若无 folder_open 可用，保持 folder 图标不变）
- 文件：显示文件图标 + 文件名
  - 文件图标根据扩展名区分（可选，首期可统一使用 `file_line` 图标）
- 缩进：每层 16px，使用 padding-left 实现
- 行高：32px，选中行背景 `rgba(22,119,255,0.12)`，hover 背景 `rgba(0,0,0,0.04)`
- 只显示文件名，不显示路径；相对路径信息通过 `relPath` 字段携带，供右键菜单等使用

### 2.3 交互

- 单击目录 → 展开/折叠
- 单击文件 → 在右侧预览区显示文件内容（保持现有行为）
- 双击目录 → 无额外行为（单击已展开）

---

## 3. 工具栏

位于 `sider-content-header` 中标题"文件"的右侧，包含以下图标按钮：

| 按钮 | 图标来源 | 行为 |
|------|---------|------|
| 新建文件 | `system/add_line` | 弹出内联输入框，输入文件名后在当前选中目录（或根目录）创建空文件 |
| 新建目录 | `file/new_folder_line` | 弹出内联输入框，输入目录名后在当前选中目录（或根目录）创建目录 |
| 刷新 | `system/refresh_2_line` | 重新从根目录加载整个树 |

### 3.1 内联输入框

新建文件/目录时，在目标位置下方出现一个文本输入框，默认值分别为 `untitled` / `新建文件夹`，全选状态。按 Enter 确认创建，按 Escape 取消。输入框消失后刷新该目录的子节点列表。

---

## 4. 右键菜单

### 4.1 菜单项

```
┌──────────────────────┐
│ 添加到对话            │
├──────────────────────┤
│ 复制路径              │
│ 复制相对路径          │
├──────────────────────┤
│ 重命名...             │
│ 删除                  │
└──────────────────────┘
```

- **添加到对话**：将文件内容读取后作为上下文添加到当前会话（具体对接方式待定，首期可先占位，点击后提示"功能开发中"）
- **复制路径**：复制绝对路径到剪贴板（workDir + relPath 拼接）
- **复制相对路径**：复制 relPath 到剪贴板
- **重命名...**：进入内联重命名编辑模式（见 4.2）
- **删除**：弹出确认对话框（见第 5 节）

### 4.2 分隔线规则

- "添加到对话" 与 "复制路径" 之间有分隔线
- "复制相对路径" 与 "重命名" 之间有分隔线

### 4.3 菜单显示条件

- 右键点击文件或目录节点时显示
- 右键点击空白区域不显示菜单

### 4.4 内联重命名

点击"重命名..."后，该节点名称变为可编辑的输入框，当前名称全选。按 Enter 确认，按 Escape 取消。输入框失焦时也视为确认。

---

## 5. 删除确认对话框

### 5.1 设计要求

- **不使用** 系统 `confirm()` / `alert()`
- 使用自绘 Modal，样式与项目统一（可基于 Ant Design `Modal` 或自绘组件）
- 标题：`确认删除`
- 内容：`确定要删除 "{name}" 吗？{isDirectory ? "该目录下所有内容将被一并删除。" : "此操作不可撤销。"}`
- 按钮：`取消`（默认焦点） | `删除`（红色危险按钮）

### 5.2 行为

- 点击"取消"或按 Escape → 关闭对话框，不执行删除
- 点击"删除" → 调用后端删除 API，成功后从树中移除该节点
- 删除目录时递归删除所有子内容

---

## 6. 拖拽移动

### 6.1 规则

- 可拖拽的对象：文件节点、目录节点
- 有效放置目标：仅目录节点
- 拖拽到目录上时，该目录高亮显示（背景色变化）
- 拖拽到非目录区域或自身/子目录时，显示禁止图标，释放无效果

### 6.2 限制

- 不能将目录拖入自身或自身的子目录（防止循环）
- 不能将节点拖到其当前所在目录（无意义的移动）

### 6.3 行为

- 释放后调用后端移动 API（`file:move`），将源路径移动到目标目录下
- 移动成功后，从原位置移除节点，在目标目录下刷新子节点
- 移动失败时显示错误提示（`message.error`），不改变树状态

### 6.4 视觉反馈

- 拖拽开始：被拖拽节点半透明
- 拖拽经过目录：目录背景变为浅蓝色 `rgba(22,119,255,0.08)`
- 拖拽经过无效目标：光标变为 `not-allowed`

---

## 7. 后端 API 新增

当前后端仅支持 `file:list-directory` 和 `file:read-file`，需新增以下 IPC 通道：

| IPC 通道 | 签名 | 说明 |
|---------|------|------|
| `file:create-file` | `(relPath: string) => Promise<void>` | 创建空文件（含中间目录） |
| `file:create-directory` | `(relPath: string) => Promise<void>` | 创建目录（含中间目录） |
| `file:delete` | `(relPath: string) => Promise<void>` | 删除文件或目录（目录递归删除） |
| `file:rename` | `(relPath: string, newName: string) => Promise<void>` | 重命名（同目录下改名） |
| `file:move` | `(srcRelPath: string, destDirRelPath: string) => Promise<void>` | 将文件/目录移动到目标目录下 |

### 7.1 安全约束

- 所有操作均通过 `resolveSafePath` 校验，确保路径不逃离 workDir
- `file:rename` 的 `newName` 不允许包含路径分隔符（`/` 或 `\`），仅允许改名不允许移位
- `file:move` 的目标目录必须存在且为目录

### 7.2 需要同步修改的文件

| 文件 | 改动 |
|------|------|
| `src/shared/api.ts` | 在 `SpaceAssistantApi` 中新增 5 个方法签名 |
| `electron/appIpc.ts` | 新增 5 个 `ipcMain.handle` 处理器 |
| `electron/preload.ts` | 新增 5 个 IPC 调用映射 |

---

## 8. 前端组件结构

| 组件/文件 | 职责 |
|----------|------|
| `src/renderer/components/FileTree/FileTree.tsx` | 树组件主入口，管理树状态和交互 |
| `src/renderer/components/FileTree/FileTreeNode.tsx` | 单个树节点渲染（图标、名称、展开/折叠、拖拽） |
| `src/renderer/components/FileTree/FileTreeContextMenu.tsx` | 右键菜单 |
| `src/renderer/components/FileTree/FileTreeToolbar.tsx` | 工具栏（新建文件、新建目录、刷新） |
| `src/renderer/components/FileTree/DeleteConfirmModal.tsx` | 删除确认对话框 |
| `src/renderer/components/FileTree/InlineInput.tsx` | 内联输入框（新建/重命名共用） |
| `src/renderer/App.tsx` | FilePane 改为引用 FileTree 组件 |

---

## 9. 图标清单

| 用途 | 图标文件 |
|------|---------|
| 目录（折叠） | `file/folder_line.svg` |
| 目录（展开） | `file/folder_open_line.svg`（若无则用 `folder_fill`） |
| 文件 | `file/file_line.svg` |
| 新建文件 | `system/add_line.svg` |
| 新建目录 | `file/new_folder_line.svg` |
| 刷新 | `system/refresh_2_line.svg` |
| 删除（右键菜单） | `system/delete_line.svg` |
| 重命名（右键菜单） | `editor/pencil_line.svg` |
| 复制（右键菜单） | `file/copy_line.svg` |

---

## 10. 不在本次范围

- 文件内容编辑（只读预览）
- 文件扩展名图标区分（统一文件图标）
- Git 状态标记
- 文件搜索/过滤
- "添加到对话"的完整实现（首期占位）
- 多选操作

---

## 11. 与 LLM Wiki 分段的关系

启用 LLM Wiki 后，文件 Tab 由单一文件树扩展为 **上下双分段** 布局，详见 [llm-wiki-requirement.md §10.1](./llm-wiki-requirement.md#101-文件-tab-双分段布局phase-2)：

| 分段 | 位置 | 内容 |
|------|------|------|
| **文件列表** | 上 | 本文档 §2–§9 所定义的项目文件树 |
| **LLM Wiki** | 下 | Wiki 根目录独立树（`SCHEMA.md`、`raw/`、`wiki/` 等） |

- 两段均为 **可收起 Section**，交互对齐 VS Code 资源管理器中的分段折叠
- 工具栏（§3）仍位于 Tab 顶栏，默认仅作用于 **文件列表** 分段
- 当 `wiki.hideWikiFromFileTree === true` 时，文件列表分段 **不展示** `llm-wiki/` 目录，避免与下方 Wiki 分段重复
