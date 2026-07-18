# 右侧文件目录树 - 后台自动刷新 - 需求规格

**版本：** 1.1
**日期：** 2026-07-18
**状态：** 已决议
**关联文档：** [detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md)、[file-pane-tree-requirement.md](./file-pane-tree-requirement.md)、[file-content-viewer-auto-reload-requirement.md](./file-content-viewer-auto-reload-requirement.md)、[cli-subagent-integration-requirement.md](./cli-subagent-integration-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-07-18 | 初稿：梳理已有 `file:tree-changed` 机制的三处缺陷，提出展开态保留 / 滚动保持 / 防闪烁 / 覆盖补全方案 |
| 1.1 | 2026-07-18 | §13 五项决策定稿（D1=C 分期 / D2 复用规范 / D3 静默 / D4 沿用现状 / D5 降级 A）；据此修订 §8.4、§10.2、§10.3、§11.7 |

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [目标与非目标](#3-目标与非目标)
4. [功能需求](#4-功能需求)
5. [刷新策略与展开态保留](#5-刷新策略与展开态保留)
6. [滚动位置保持](#6-滚动位置保持)
7. [防闪烁与性能](#7-防闪烁与性能)
8. [通知源覆盖补全](#8-通知源覆盖补全)
9. [架构设计](#9-架构设计)
10. [交互规格](#10-交互规格)
11. [边界场景](#11-边界场景)
12. [验收标准](#12-验收标准)
13. [待决事项](#13-待决事项)
14. [关联文档修订清单](#14-关联文档修订清单)

---

## 1. 概述

### 1.1 背景

右侧详情栏上半区 `DetailPanelFileList`（见 [detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md)）承载项目文件树 `FileTree`，是用户在对话过程中浏览工作目录的主要入口。Agent 在执行任务时会持续在工作目录下**新建 / 修改 / 删除文件**（经 `write_file`、`edit_file`、`run_shell`、CLI Subagent 子进程等路径）。

用户期望：**文件树能及时反映工作目录的真实状态，无需手动点「刷新」**。当前虽已存在一条基于 `file:tree-changed` 事件的自动刷新链路，但实际体验上仍"像是要手动刷新"，且自动刷新触发时会**破坏用户已展开的目录结构与滚动位置**，导致用户不敢依赖它。

### 1.2 功能定位

在**不改变文件树现有交互规格**（展开/折叠、选中、右键、拖拽、新建/删除/重命名，见 [file-pane-tree-requirement.md](./file-pane-tree-requirement.md)）的前提下，让右侧文件树：

1. 在工作目录发生文件增删改时，**自动**更新对应目录的子节点列表；
2. 刷新过程**保留**用户当前的展开状态、选中状态、滚动位置；
3. 刷新过程**无明显闪烁**，刷新延迟控制在 **1 秒以内**。

### 1.3 核心约束（来自产品诉求）

| # | 约束 | 说明 |
|---|------|------|
| C1 | **不破坏展开状态** | 自动刷新不得折叠用户已展开的目录，不得丢失已懒加载的子树 |
| C2 | **不破坏滚动位置** | 自动刷新不得重置列表滚动条 `scrollTop` |
| C3 | **不频繁闪烁** | 连续写入应合并为少量可见更新，避免整树反复重渲染 |
| C4 | **延迟 ≤ 1s** | 自文件落盘到树列表更新，端到端延迟可接受在 1 秒以内 |

---

## 2. 现状与问题

### 2.1 已有自动刷新链路（已存在，但不可靠）

```text
主进程写入文件
  ├─ write_file / edit_file 成功
  │    └─ toolChatLoop 调 notifyFileTreeChanged({ kind: 'paths', relPaths: [rel] })   // 精确路径
  ├─ run_shell / run_script 成功
  │    └─ notifyFileTreeChanged({ kind: 'refreshExpanded' })                          // 粗粒度：刷新所有已展开目录
  └─ wiki 导入
       └─ notifyFileTreeChanged(treeChange)

渲染进程
  └─ fileTreeSyncBus（400ms 防抖合并）-> 分发 FileTreeChangeEvent
       └─ useFileTree 订阅
            ├─ kind='refreshExpanded'  -> 刷新所有已展开目录
            └─ kind='paths'            -> dirsToRefreshForPath(relPath) 计算待刷新目录 -> 逐个 refreshDirectory
```

关键代码位置：

| 文件 | 位置 | 职责 |
|------|------|------|
| `electron/toolChatLoop.ts` | `1898-1903` | 工具执行成功后发 `notifyFileTreeChanged` |
| `electron/fileTreeSyncNotify.ts` | 全文件 | `notifyFileTreeChanged` -> `file:tree-changed` IPC |
| `src/renderer/services/fileTreeSyncBus.ts` | 全文件 | 400ms 防抖合并、分发事件 |
| `src/shared/fileTreeSync.ts` | `dirsToRefreshForPath` | 由 relPath 推算需刷新的已展开祖先目录 |
| `src/renderer/components/FileTree/useFileTree.ts` | `271-291` | 订阅事件并触发 `refreshDirectory` |

### 2.2 问题 P1：自动刷新破坏已展开子树（违反 C1）—— **核心痛点**

`useFileTree.refreshDirectory`（自动刷新唯一执行路径）实现为：

```typescript
// src/renderer/components/FileTree/useFileTree.ts:253-267
const refreshDirectory = useCallback(async (key: string) => {
  const map = ensureNodeMap()
  const node = map.get(key)
  if (!node || !node.isDirectory) return
  try {
    node.children = await loadDirectory(key)   // ← 直接替换 children
  } catch {
    node.children = []
  }
  setTreeData((prev) => [...prev])
  rebuildNodeMap(treeData)
}, ...)
```

`loadDirectory` 经 `fileInfoToNode` 返回的节点**全部为 `expanded: false, children: []`**（见 `useFileTree.ts:101-113`）。因此：

- 每次自动刷新目录 D，D 之下**所有已展开的子目录会被折叠**，已懒加载的孙节点子树**全部丢失**。
- 用户展开了几层目录在观察 Agent 产出，Agent 一写文件，展开结构瞬间塌缩回根——用户被迫重新逐层展开，进而宁愿关掉自动刷新、改为手动操作。

> 对照：初始加载路径（`useFileTree.ts:168-185`）使用了 `mergePreservedDirectoryChildren` 保留展开态；但 `refreshDirectory` 与手动 `refreshTree` **均未复用该 merge 逻辑**。最近的 `fix(detail-panel): 关闭文件查看器后保留目录树展开状态`（commit `ece6a23`）已处理"关闭预览恢复展开态"，但**自动刷新路径的展开态丢失尚未修复**。

### 2.3 问题 P2：手动刷新同样重置展开态

`useFileTree.refreshTree`（工具栏「刷新」按钮、`FileTreeHandle.refresh`）：

```typescript
// src/renderer/components/FileTree/useFileTree.ts:293-316
const refreshTree = useCallback(async () => {
  const children = await loadDirectory(rootRelPath)
  setTreeData((prev) => [{ ...prev[0], children }])   // ← 同样直接替换
  setExpandedKeys([rootRelPath])                        // ← 重置为仅根展开
  ...
}, ...)
```

手动刷新会把展开状态重置为"仅根目录展开"。这与 C1 同源，本期一并修正。

### 2.4 问题 P3：通知源覆盖不全（部分写入不会触发刷新）

`notifyFileTreeChanged` 仅在主进程工具循环内对 `write_file / edit_file / run_shell / run_script` 调用。以下写入路径**不触发**文件树自动刷新：

| 写入来源 | 是否通知 | 说明 |
|----------|----------|------|
| `write_file` / `edit_file` | ✅ `paths` | 精确路径 |
| `run_shell` / `run_script` | ✅ `refreshExpanded` | 粗粒度 |
| Wiki 导入 | ✅ | `wikiImportFileTreeChange` |
| **CLI Subagent 子进程** | ❌ | Subagent 自带 `write_file/edit_file` 等，由 CLI 子进程执行，**绕过主进程工具循环**（见 [cli-subagent-integration-requirement.md](./cli-subagent-integration-requirement.md) §G3/§D14：主 Agent 仅回收"文件变更摘要"用于展示，不触发树刷新） |
| **外部编辑器 / 其他进程** | ❌ | 无工作目录 `fs.watch` |
| **浏览器下载、未来新增工具** | ❌ | 无兜底监听 |

后果：Subagent 执行完产出新文件，文件树无变化，用户必须手动刷新——这是"依赖手动刷新"的直接来源之一。

### 2.5 问题 P4：多目录串行刷新可能多次渲染（违反 C3）

`useFileTree.ts:286-289` 对待刷新目录以 `for...of await` **串行**调用 `refreshDirectory`，每个目录一次 `setTreeData`。单次 `refreshExpanded` 事件若涉及多个已展开目录，会触发多次 React 渲染；叠加 400ms 防抖窗口内的多次事件，可能产生可见闪烁。

### 2.6 问题 P5：滚动位置未显式保护（违反 C2）

antd `Tree` 在 `treeData` 引用变化但节点 `key` 稳定、组件不 remount 时，滚动容器 `.file-tree-scroll` 的 `scrollTop` 通常天然保持。但当前实现存在隐患：

- `refreshDirectory` 内 `rebuildNodeMap(treeData)` 使用闭包内可能 stale 的 `treeData`；
- 若未来为刷新引入 `key` 变更或条件 remount，`scrollTop` 会归零；
- 缺少验收基准，回归风险高。

### 2.7 问题小结

| 问题 | 影响 | 对应约束 |
|------|------|----------|
| P1 自动刷新折叠已展开子树 | 用户不敢依赖自动刷新 | C1 |
| P2 手动刷新重置展开态 | 手动刷新体验也差 | C1 |
| P3 通知源覆盖不全（Subagent/外部） | 部分新文件不可见 | C4 |
| P4 多目录串行多次渲染 | 闪烁 | C3 |
| P5 滚动位置未保护 | 视口跳动 | C2 |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 工作目录内文件增删改后，右侧文件树在 **1s 内**自动反映最新列表，无需手动刷新 |
| G2 | 自动刷新**保留**用户已展开的目录、已懒加载的子树、当前选中项 |
| G3 | 自动刷新**保留**列表滚动条 `scrollTop`（视口不跳动） |
| G4 | 连续写入合并为少量可见更新，**无整树闪烁** |
| G5 | 覆盖 Subagent 子进程、外部编辑器等绕过主进程工具循环的写入路径 |
| G6 | 复用现有 `file:tree-changed` / `fileTreeSyncBus` 机制，不推翻重写 |

### 3.2 非目标

| 条目 | 说明 |
|------|------|
| 文件**内容**自动刷新 | 由 [file-content-viewer-auto-reload-requirement.md](./file-content-viewer-auto-reload-requirement.md) 承担，本期不涉及 |
| 实时逐字符 diff | 仅整目录子节点列表替换，不做行级动画 |
| 跨 workDir 聚合监听 | 仅跟踪当前会话工作目录；切换 workDir 时停止旧监听 |
| 文件树选中联动内容预览 | 树选中变化不触发内容重载（现有 `openFile` 行为不变） |
| 新增文件高亮 / "刚刚产生"标记 | 非必须；可选增强见 §13 |
| 文件大小 / mtime 列展示 | 不在本次范围 |
| 监听 `.git` / `node_modules` / 构建产物 | 应被忽略，不触发刷新（见 §8.3） |

---

## 4. 功能需求

### 4.1 触发条件

满足以下**任一**条件即应触发对应目录的自动刷新：

1. 收到 `file:tree-changed` 事件（`paths` 或 `refreshExpanded`）—— **已有**；
2. 收到来自工作目录 `fs.watch` 兜底监听的变更事件 —— **新增**（见 §8）；
3. CLI Subagent 完成回收时主进程主动通知 —— **新增**（见 §8.2）。

### 4.2 刷新范围计算

沿用 `dirsToRefreshForPath`（`src/shared/fileTreeSync.ts`）语义，并补充：

- `paths` 事件：对每个 `relPath`，刷新其**最近已展开祖先目录**（含直接父目录若已展开）。新增文件所在目录若**未展开**，则刷新其最近已展开祖先——此时新文件不可见属预期（用户展开该目录时 `toggleExpand` 会重新懒加载，自然可见）。
- `refreshExpanded` 事件：刷新**所有当前已展开**目录。
- `fs.watch` 事件：将监听到的相对路径归一化后，等价于 `paths` 事件处理。

### 4.3 刷新行为

| 变化类型 | 行为 |
|----------|------|
| 目录下新增文件/子目录 | 列表追加新节点（默认折叠，若是目录） |
| 目录下删除文件/子目录 | 移除对应节点；若被删节点是当前 `selectedKey` 或其祖先，按 §11.4 处理 |
| 文件/目录重命名 | 旧 key 节点移除、新 key 节点插入（按排序规则归位） |
| 仅文件内容变化（size/mtime 变） | **不触发**树刷新（树不展示内容，无意义）；交由内容查看器自动刷新 |
| 目录本身被删除 | 该目录节点从父节点列表移除（由父目录刷新覆盖） |

### 4.4 与用户手动操作的关系

| 操作 | 行为 |
|------|------|
| 用户点击工具栏「刷新」 | 改为**保留展开态**的整树刷新（见 §5.4），不再 `setExpandedKeys([root])` |
| 用户正在内联新建/重命名输入 | 暂停该目录的自动刷新合并，待用户确认/取消后再纳入（见 §11.5） |
| 用户正在拖拽 | 拖拽期间暂停自动刷新 `setTreeData`，避免节点在拖拽中跳动 |
| 用户展开某目录 | 沿用现有 `toggleExpand` 懒加载，不受自动刷新影响 |

---

## 5. 刷新策略与展开态保留

### 5.1 核心原则

刷新目录 D 时，**重新读取 D 的直接子节点列表**，但对每个**仍存在且此前已展开**的子目录，**保留其 `expanded` 状态与已加载的 `children` 子树**——即"只补差异，不动结构"。

### 5.2 抽取合并函数

将现有 `mergePreservedDirectoryChildren`（`useFileTree.ts:31-43`）泛化为通用合并工具，供 `refreshDirectory`、`refreshTree`、初始加载统一复用：

```text
mergeRefreshedChildren(prevChildren, nextChildren):
  prevByKey = Map(prevChildren by key)
  return nextChildren.map(node => {
    prev = prevByKey.get(node.key)
    if (!prev || !node.isDirectory) return node           // 新增节点 / 文件：用新值
    return {
      ...node,                                            // 名称/大小等元信息用新值
      expanded: prev.expanded,                            // 保留展开态
      loading: prev.loading,
      children: prev.children.length > 0 ? prev.children : node.children  // 保留已加载子树
    }
  })
```

> 注：现有 `mergePreservedDirectoryChildren` 已实现该逻辑（单层），本期将其**提升至 `src/shared/fileTreeSync.ts`** 作为共享纯函数，并补充单元测试（含多层子树保留、重命名、删除场景）。

### 5.3 修复 `refreshDirectory`

```text
refreshDirectory(key):
  node = nodeMap.get(key)
  next = await loadDirectory(key)
  node.children = mergeRefreshedChildren(node.children, next)   // ← 替换原"直接赋值"
  setTreeData(批量合并后一次性提交)                              // ← 见 §7.2
  rebuildNodeMap(latest)
```

要点：
- 不再 `node.children = await loadDirectory(key)` 直接覆盖；
- `rebuildNodeMap` 基于最新 `treeData`（避免 stale 闭包，见 §7.3）。

### 5.4 修复 `refreshTree`（手动刷新）

- 根节点 children 改用 `mergeRefreshedChildren(prevRoot.children, loaded)`；
- **移除** `setExpandedKeys([rootRelPath])`，保留现有 `expandedKeys`；
- 选中态保留。

### 5.5 展开态保留边界

| 场景 | 处理 |
|------|------|
| 子目录 A 已展开且有懒加载子树，A 仍存在 | 保留 A 的 `expanded` 与 `children` |
| 子目录 A 被删除 | A 连同子树从列表移除（无法保留） |
| 子目录 A 重命名为 B | 视为新节点 B（默认折叠）；A 移除。展开态不跨重命名保留（可接受） |
| 新增子目录 B | 默认折叠，不自动展开 |
| 用户正编辑的 inline input 所在目录 | 见 §11.5 |

---

## 6. 滚动位置保持

### 6.1 设计目标

自动刷新前后，文件树滚动容器 `.file-tree-scroll`（`FileTree.tsx:258`）的 `scrollTop` 数值**不主动改变**；视口内容若因增删而高度变化，`scrollTop` 保持不变（可能露出/遮挡不同节点，但不跳到顶部）。

### 6.2 实现要点

| 要点 | 说明 |
|------|------|
| 节点 `key` 稳定 | 继续以 `relPath` 为 key；不引入随机/时间戳 key |
| 不 remount `FileTree` | `DetailPanelFileList.tsx:63` 的 `<FileTree key={activeProfileId \|\| workDir}>` 在 profile/workDir 不变时稳定；自动刷新不触碰该 key |
| 不重置 `expandedKeys` | 见 §5.4（移除 `setExpandedKeys([root])`） |
| `setTreeData` 仅替换 children 引用 | antd `Tree` 按 key diff，滚动容器不重建 |
| 可选：刷新前后 `scrollTop` 断言 | 测试中对滚动容器 `scrollTop` 做前后比对（见 §12.3） |

### 6.3 需避免的反模式

| 反模式 | 后果 |
|--------|------|
| 为强制刷新变更 `FileTree` 组件 `key` | 整树 remount，`scrollTop` 归零，展开态全失 |
| 刷新后 `scrollTo(0)` / `scrollToTop()` | 视口跳顶 |
| 用 `expandedKeys` 重置触发 antd 内部滚动恢复 | 滚动跳动 |

---

## 7. 防闪烁与性能

### 7.1 防抖（已有，保留）

`fileTreeSyncBus` 的 `DEBOUNCE_MS = 400ms` 满足 C4（端到端 < 1s）。本期不调整防抖时长，避免与 [file-content-viewer-auto-reload-requirement.md](./file-content-viewer-auto-reload-requirement.md) 的 500ms 内容同步产生时序耦合。

### 7.2 批量合并刷新（修复 P4）

将 `useFileTree` 订阅回调中的 `for...of await refreshDirectory` 改为**批量并发 + 单次提交**：

```text
onFileTreeSync(event):
  dirs = computeDirs(event)                       // 待刷新目录集合
  results = await Promise.all(dirs.map(loadDirectory))   // 并发读取，不逐个 setState
  setTreeData(prev => applyMerged(prev, dirs, results))  // 一次性合并提交
  rebuildNodeMap(latest)
```

- 每个目录独立 `loadDirectory`，但**不在循环内 `setTreeData`**；
- 全部读取完成后，一次性 `setTreeData` 应用所有目录的 `mergeRefreshedChildren`；
- 单次事件 = 单次 React 渲染（而非 N 次）。

### 7.3 stale 闭包修正

`refreshDirectory` / 订阅回调中 `rebuildNodeMap(treeData)` 的 `treeData` 为闭包旧值。改为在 `setTreeData((prev) => { ... rebuildNodeMap(newData); return newData })` **内部**基于 `prev` 构建并重建 map，或使用 `useRef` 镜像最新 `treeData`。

### 7.4 无变化跳过

合并后若某目录子节点 key 集合与名称/类型完全一致（无增删改），则**不产生新引用**，避免无意义重渲染。可在 `mergeRefreshedChildren` 中加短路：若 `next` 与 `prev` 逐项同 key 同名同 isDirectory，返回 `prev` 原引用。

### 7.5 并发与竞态

- 防抖窗口内多次事件合并（已有）；
- 若一次批量刷新进行中又来新事件，新事件正常入队下一防抖窗口，不与进行中的刷新交叉；
- `workDir` 切换时取消进行中的刷新（已有 `cancelled` 机制，保留）。

---

## 8. 通知源覆盖补全

### 8.1 方案矩阵

| 方案 | 描述 | 覆盖范围 | 复杂度 | 延迟 |
|------|------|----------|--------|------|
| A | 在主进程各写入点补 `notifyFileTreeChanged`（Subagent 回收、未来工具） | 仅已知写入路径 | 低 | 低 |
| B | 主进程对当前 workDir 建立递归 `fs.watch` 作为兜底 | 全部（含外部编辑、未知路径） | 中-高 | 低 |
| C | A + B 组合 | 全部 | 中-高 | 低 |

### 8.2 方案 A：补已知写入点（必做，第一期）

- **CLI Subagent 回收**：Subagent 完成回收时，主进程依据其"文件变更摘要"（见 [cli-subagent-integration-requirement.md](./cli-subagent-integration-requirement.md) §G3/§D14）调用 `notifyFileTreeChanged({ kind: 'paths', relPaths: [...] })`；若摘要不含精确路径，则发 `{ kind: 'refreshExpanded' }` 兜底。
- **其他主进程写入点**：审计 `electron/` 下所有文件写入路径（Wiki 导入已覆盖；检查是否有遗漏的写文件工具），补齐通知。

### 8.3 方案 B：workDir 递归 `fs.watch` 兜底（待决，见 §13 D1）

- 主进程在会话绑定 workDir 时，对该目录建立递归 `fs.watch`（参考已有 `electron/fileContentWatcher.ts`、`electron/projectMemory.ts` 的单文件 watch 先例）。
- 监听 `rename`（增删）/ `change` 事件；`change`（仅内容变）**忽略**（树不关心内容）；`rename` 归一化为相对路径后经 `fileTreeSyncBus` 入队。
- **必须忽略**的目录与文件（避免风暴）：`.git`、`node_modules`、构建产物（`dist`、`dist-electron`、`dist/renderer`）、`.agent/logs`、`logs/`、`sessions/`（备份目录）、Wiki 临时目录等；忽略规则复用现有路径规范（参考 `workspaceLayout/redirect`、`pathSecurity`）。
- 平台差异：`fs.watch({ recursive: true })` 在 Windows / macOS 原生支持，Linux 需较新内核；若平台不支持递归，降级为方案 A + 仅监听已展开目录（见 D1）。

### 8.4 推荐（已决议 D1 = C）

- **第一期（MVP，本次实施）**：方案 A + §5/§6/§7 的展开态/滚动/防闪烁修复。确定性改进、低风险，直接消除 P1/P2/P4/P5，并覆盖最主要的 Subagent 盲区（P3 主体）。
- **第二期（视反馈）**：方案 B 作为外部编辑与未知路径的兜底。是否实施取决于第一期上线后用户反馈；在不支持递归 watch 的平台降级为方案 A（D5）。

---

## 9. 架构设计

### 9.1 组件职责（第一期）

```text
┌─ 主进程 ─────────────────────────────────────────────────────┐
│ toolChatLoop（已有）          ── notifyFileTreeChanged(paths/refreshExpanded)
│ subagent 回收点（新增通知）   ── notifyFileTreeChanged(paths 或 refreshExpanded)
│ fileTreeSyncNotify（已有）    ── file:tree-changed IPC
│ [第二期] workDirWatcher（新） ── fs.watch -> notifyFileTreeChanged(paths)
└──────────────────────────────────────────────────────────────┘
                              │ IPC
┌─ 渲染进程 ───────────────────────────────────────────────────┐
│ fileTreeSyncBus（已有，400ms 防抖）── 分发 FileTreeChangeEvent │
│ useFileTree（增强）                                           │
│   ├─ 订阅事件 -> 批量并发 loadDirectory -> 单次 setTreeData    │
│   ├─ mergeRefreshedChildren（提升至 shared）保留展开态         │
│   ├─ 不重置 expandedKeys / selectedKey                        │
│   └─ 不触碰 FileTree key（保留 scrollTop）                    │
│ FileTree / antd Tree（不变）                                  │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 共享纯函数提升

| 函数 | 原位置 | 目标位置 | 说明 |
|------|--------|----------|------|
| `mergePreservedDirectoryChildren` | `useFileTree.ts:31-43` | `src/shared/fileTreeSync.ts`（重命名 `mergeRefreshedChildren`） | 泛化、补测试，供 refresh 路径复用 |

### 9.3 状态字段（无新增）

本期不新增 context / store 字段；展开态、选中态、滚动位置均沿用 `useFileTree` 现有 state 与 DOM，靠"不破坏"而非"显式保存恢复"实现。

### 9.4 第二期新增 API（待决）

| API | 方向 | 说明 |
|-----|------|------|
| `file:watch-workdir` | invoke | `{ relPath: string \| null }`；null 停止；绑定当前 workDir 递归监听 |
| `fileOnWorkDirChanged` | preload 暴露 | 复用 `file:tree-changed` 事件，无需新事件类型 |

第二期若实施，主进程 watch 事件直接复用 `notifyFileTreeChanged`，渲染侧零改动。

---

## 10. 交互规格

### 10.1 用户可见行为

| 场景 | 预期体验 |
|------|----------|
| 用户展开 `src/components/`，Agent 在其下新建 `Foo.tsx` | 约 0.4–0.8s 后 `src/components/` 列表出现 `Foo.tsx`，**展开态、滚动位置不变** |
| 用户展开多层 `a/b/c/`，Agent 在 `a/b/c/` 下写文件 | 仅 `a/b/c/` 列表更新；`a/`、`a/b/` 展开态与子树保留 |
| Agent 连续 5 次 `edit_file` 同一文件 | 树**不刷新**（仅内容变，§4.3）；内容查看器按其需求处理 |
| Agent 连续在 3 个不同目录新建文件 | 一次防抖窗口后，3 个目录**一次渲染**全部更新 |
| Subagent 执行完产出新文件 | 回收后约 0.4–0.8s 树出现新文件（第一期方案 A） |
| 用户拖拽节点过程中 Agent 写文件 | 拖拽期间不触发树 `setTreeData`，拖拽结束后下次防抖窗口更新 |
| 用户正在内联新建目录输入名称 | 该目录暂停自动刷新合并，确认/取消后恢复 |

### 10.2 工具栏与快捷键

- 「刷新」按钮：保留现有位置与图标；行为改为**保留展开态**的整树刷新（§5.4）。经核查 `FileTreeToolbar` + `refreshTree`，文件树手动刷新**本就无 Loading/Toast**（D4 沿用现状），本次仅改"保留展开态"，不引入任何反馈。
- 无新增快捷键。

### 10.3 i18n

本期与第二期均**无新增 UI 文案**（D3 决议：完全静默，不做"新文件高亮"，无 Toast / 标记 / 文案）。自动刷新全程对用户不可见。

---

## 11. 边界场景

### 11.1 目录读取失败（权限、临时锁）

- 保留该目录当前已展示子节点，不清空；
- 写入 Agent 日志（不含用户正文）；
- 不弹错误（静默），下次事件重试。

### 11.2 workDir 切换

- 停止进行中的批量刷新（`cancelled`）；
- 第二期停止旧 workDir 的 `fs.watch`，对新 workDir 重建；
- `useFileTree` 已有 workDir 变更重置逻辑（保留）。

### 11.3 新文件所在目录未展开

- 仅刷新最近已展开祖先；新文件在该目录折叠时不可见属预期；
- 用户随后展开该目录时，`toggleExpand` 懒加载自然读到新文件。

### 11.4 当前选中节点被删除

- `selectedKey` 对应节点被删时，置 `selectedKey = null`（沿用 `deleteNode` 现有处理）；
- 若打开的预览文件被删，交由内容查看器 §9.2 错误态（[file-content-viewer-auto-reload-requirement.md](./file-content-viewer-auto-reload-requirement.md)）。

### 11.5 内联编辑 / 拖拽进行中

- `inlineInput` 非空或拖拽进行中时，**推迟**该目录的自动刷新 `setTreeData` 至编辑/拖拽结束；
- 结束后立即纳入下一次合并刷新。

### 11.6 大量并发写入（如 `npm install`）

- 第二期 `fs.watch` 事件风暴由忽略规则（§8.3）+ 400ms 防抖 + 批量合并共同吸收；
- 极端情况下树更新可能略滞后，但不得卡死 UI；可设单次合并最大目录数（如 50），超出分批。

### 11.7 平台不支持递归 watch（第二期）

- Linux 旧内核若不支持 `recursive: true`，降级为方案 A（仅工具通知 + Subagent 通知），不阻断第一期功能（D5 决议：不引入 chokidar）。

---

## 12. 验收标准

### 12.1 展开态保留（C1）

- [ ] 展开 `a/b/c/` 三层后，Agent 在 `a/b/c/` 下新建文件，刷新后 `a/`、`a/b/`、`a/b/c/` **仍全部展开**，`a/b/c/` 列表含新文件。
- [ ] 展开 `a/b/` 且 `a/b/` 已懒加载子树后，Agent 在 `a/` 下新建无关文件，刷新后 `a/b/` 展开态与已加载子树**保留**。
- [ ] 手动点「刷新」后，已展开目录**不再**被折叠（修复 P2）。
- [ ] 自动刷新后当前 `selectedKey` 高亮保留。

### 12.2 通知覆盖（C4 / P3）

- [ ] `write_file` 新建文件后，1s 内树出现该文件（回归）。
- [ ] CLI Subagent 回收产出新文件后，1s 内树出现该文件（第一期方案 A）。
- [ ] `run_shell` 写文件后，已展开目录 1s 内更新（回归）。
- [ ] 第二期（若实施）：外部编辑器在工作目录新建文件，1s 内树出现。

### 12.3 滚动位置（C2）

- [ ] 展开较多节点使列表可滚动，滚动至中部后触发自动刷新，`.file-tree-scroll` 的 `scrollTop` 前后**数值不变**（自动化断言）。
- [ ] 自动刷新不触发 `FileTree` 组件 remount（`key` 稳定）。

### 12.4 防闪烁（C3）

- [ ] 单次 `refreshExpanded` 涉及 5 个已展开目录时，React 提交次数 **= 1**（批量合并，修复 P4）。
- [ ] Agent 连续 3 次在不同目录写文件（间隔 < 400ms），树可见更新次数 **≤ 1**（防抖 + 合并）。
- [ ] 目测无整树白底闪烁、无展开态抖动。

### 12.5 延迟（C4）

- [ ] 自文件落盘到树列表更新，端到端延迟 **≤ 1s**（工具通知路径）。

### 12.6 回归

- [ ] 手动新建 / 删除 / 重命名 / 拖拽行为无回归。
- [ ] `fileTreeSyncBus` 现有防抖与事件分发测试通过。
- [ ] `dirsToRefreshForPath` 现有测试通过。
- [ ] 内容查看器自动刷新（[file-content-viewer-auto-reload-requirement.md](./file-content-viewer-auto-reload-requirement.md)）行为不受影响。

### 12.7 测试

- [ ] 单元测试：`mergeRefreshedChildren` 保留多层展开子树、处理增删改、无变化时返回原引用。
- [ ] 单元测试：`useFileTree` 订阅回调批量合并后单次 `setTreeData`。
- [ ] 组件测试：自动刷新后 `expandedKeys`、`selectedKey`、滚动容器 `scrollTop` 不变。
- [ ] 组件测试：内联编辑期间自动刷新被推迟。

---

## 13. 已决议事项

| # | 问题 | 决议 | 说明 |
|---|------|------|------|
| D1 | 是否引入 workDir 递归 `fs.watch` 兜底（方案 B） | **C. 分期** | 第一期仅方案 A（工具通知 + Subagent 通知 + 展开/滚动/防闪烁修复）；第二期视上线反馈再决定是否加方案 B |
| D2 | 递归 watch 忽略目录清单 | **复用现有规范，集中维护** | 忽略规则复用 `workspaceLayout/redirect`、`pathSecurity` 等现有路径规范，不新增独立配置 |
| D3 | 新增文件是否做"刚刚产生"高亮 | **A. 不做（完全静默）** | 与内容查看器静默策略一致；自动刷新全程无高亮、无 Toast、无文案 |
| D4 | 手动「刷新」是否保留 Loading/Toast | **沿用现状** | 核查 `FileTreeToolbar` + `refreshTree`：文件树手动刷新**本就无 Loading/Toast**；"沿用现状"即仅改"保留展开态"，不引入任何反馈。注：本决策在文件树场景下"沿用现状"与"改为静默"实为同一行为 |
| D5 | Linux 旧内核不支持递归 watch 时 | **降级方案 A** | 不引入 chokidar 等新依赖；第二期方案 B 在不支持递归 watch 的平台降级为方案 A |

---

## 14. 关联文档修订清单

| 文档 | 修订内容 |
|------|----------|
| [detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md) | §6 文件树行为补充"自动刷新保留展开态/滚动位置"引用本需求 |
| [file-pane-tree-requirement.md](./file-pane-tree-requirement.md) | §3 工具栏「刷新」行为补充"保留展开态"（引用本需求 §5.4） |
| [cli-subagent-integration-requirement.md](./cli-subagent-integration-requirement.md) | §G3/§D14 Subagent 回收补充"触发 `notifyFileTreeChanged` 通知文件树刷新" |
| [file-content-viewer-auto-reload-requirement.md](./file-content-viewer-auto-reload-requirement.md) | 附录补充与本需求的边界划分（内容刷新 vs 列表刷新） |

---

*文档结束*
