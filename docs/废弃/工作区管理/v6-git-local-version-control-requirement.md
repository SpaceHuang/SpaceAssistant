# V6 — Git 本地版本管理（isomorphic-git）

> **版本**：V6  
> **发布**：M2 **首期可发布单元**（本地闭环，不含远端）  
> **状态**：需求定稿  
> **依赖**：M1 工作区 [v1-workspace-management-requirement.md](./v1-workspace-management-requirement.md)  
> **后续**：[v7-git-remote-sync-requirement.md](./v7-git-remote-sync-requirement.md)（远端，独立发布）  
> **完整原文**：[isomorphic-git-workdir-version-control-requirement.md](./isomorphic-git-workdir-version-control-requirement.md)

---

## 1. 概述

### 1.1 与 M1 工作区的关系

| 里程碑 | Git 相关 |
|--------|----------|
| **M1（V1）** | **无** Git 功能；workDir 可为已有仓库根，应用不强制 init |
| **M2（V6 起）** | isomorphic-git 集成；与 M1 **分开发布，不捆绑** |

**M1 明确不做**（不得因未实现 Git 而阻塞 M1）：

- 安装向导内 Git 初始化
- 向导/requirement 中的「必须 init Git 才能完成」流程
- 为 Git 预留而阻塞 Profile / 模板 / focus 上线

**M1 升级用户**：已有工作区配置 **无需重做**；Git 为增量能力。

### 1.2 发布边界（本 PRD）

**V6 是一次完整、可独立发布的产品能力**：用户在当前 workDir Profile 内完成 **启用版本管理 → 查看改动 → 保存版本 → 不跟踪 → 浏览历史 → 替换内容 → 文件树看见改动**，Agent 同步获得本地 `git_*` 工具。  
**不含** pull/push/clone/凭据（见 V7）。

工程上可按 Phase 0→1→2 迭代，但 **不拆成独立 PRD**。

### 1.3 目标（G1–G2、G4–G10）

| ID | 目标 |
|----|------|
| G1 | 识别 workDir **根仓库**（0 或 1 个），展示变更与历史 |
| G2 | 本地暂存、提交、diff、log、restore |
| G4 | 多 Profile 切换时独立 Git 上下文 |
| G5 | 与路径沙箱、确认流、Shell 安全一致 |
| G6 | Agent **默认启用**本地 `git_*`；与 UI 共用 `gitService` |
| G7 | 右侧 `detail-panel-top` 底栏 Tab：**工作目录 \| 版本管理** |
| G8 | **单仓库**：每 Profile 至多一个仓库，**必须**在 workDir **根** |
| G9 | **双暴露面**：Agent 全面；UI **写作极简** |
| G10 | UI 用产品词汇；**禁止**向用户展示 `?`/`M` |

### 1.4 非目标

- 远端同步、clone、凭据（V7）
- IDE 式 SCM（暂存分组、分支条、discard UI）
- 渲染进程运行 isomorphic-git；Git LFS；SSH 原生；多仓库选择器
- merge/stash/性能优化等（V8 可选）

---

## 2. 与工作区的衔接原则

### 2.1 workDir 与仓库根

| 场景 | 行为 |
|------|------|
| workDir 已是 Git 根 | 正常启用 Git |
| workDir 为仓库子目录（`.git` 在 workDir 外） | **C-strict 阻断**；提示将 Profile 设为仓库根 |
| 空目录 / 新建 Profile | M1 不 init；V6 空态 **启用版本管理** |

### 2.2 Profile、focus、AI 成长

- **Profile 切换**：各 Profile 独立 discover / 缓存；Git 上下文随切换刷新（M1 须保证 `workDir` 路径正确，含 SessionBackup R6）。
- **focus**（V4）：会话级子路径；提交/diff 默认全仓库，focus 不单独限制 Git 作用域（细节实现阶段定）。
- **AI 成长 Profile**：workDir 可为 Git 仓库；**不**默认 init。
- **安装向导总仓**（V2 O2）：不落库；各 Profile `workDir` 以各自绝对路径为准。

### 2.3 M1 可选接口预留（非阻塞）

| 扩展点 | 说明 |
|--------|------|
| Profile 元数据 | 可选 `gitUserName` / `gitUserEmail` 等 |
| 文件树 | 节点可挂 status 装饰（V6 交付） |
| IPC | `git:*` 与 `file:*` 命名空间分离 |

---

## 3. 产品策略：双暴露面

| 维度 | Agent | 用户 UI |
|------|-------|---------|
| 本地能力 | `git_status` / `git_diff` / `git_stage` / `git_commit` / `git_ignore` / `git_discard` / `git_branch` / `git_log` / `git_restore_version` | 已修改、保存版本、查看改动、不跟踪、历史、替换内容 |
| 暂存 | 可指定 paths | **无**；保存版本 = stage all + commit |
| 分支 / discard | Agent + 确认 | **无** UI |

**UI 主路径**：版本管理 Tab → 已修改 → 查看改动 → 保存版本；新文件 → 不跟踪；历史 → 替换。工作目录 Tab 显示改动角标。

用户自然语言 → `git_*` 映射见原文 §4.9；ToolCallCard 用 `git.toolLabels.*`。

---

## 4. 技术架构

### 4.1 分层

```
Renderer: DetailPanelWorkArea（FileTree | GitPanel）+ FileOverlay（diff）
  → preload → electron/git/（gitIpc, gitService, gitRepoDiscovery, gitFs, gitAuthor, gitSuggestMessage）
  → isomorphic-git 1.x（仅主进程，pin ^1.38）
```

### 4.2 单仓库模型（§4.10）

| 场景 | 行为 |
|------|------|
| workDir = 仓库根 | 正常启用 |
| workDir 内嵌套 `.git` | `GIT_NESTED_REPO`，阻断 init |
| `.git` 在 workDir 外 | `GIT_ROOT_OUTSIDE_WORKDIR`，提示改 Profile 路径 |
| 无仓库 | 空态 **为当前文件夹启用版本管理** |

### 4.3 设计原则

- discover 按 `profileId` 缓存；切换 Profile 失效并重扫
- 同仓库操作互斥锁；`git:state-changed` 驱动 UI 刷新
- author 优先级：仓库 config → Profile → 全局 GitConfig → 无效则阻止提交（§4.7）
- `GitConfig.agentToolsEnabled` 默认 **true**

---

## 5. UI 规格

### 5.1 DetailPanel 布局（§6.4）

- **detail-panel-top**：`WorkDirSelector` + 内容区（FileTree | GitPanel）+ **底栏 Tab**「工作目录 | 版本管理」（默认工作目录）
- 版本管理 Tab **无**工具栏、**无** `GitRepoSelector`
- 打开项目文件 → 切回 **工作目录** Tab
- **V6 无同步按钮**

### 5.2 GitPanel 状态机

| 状态 | 展示 |
|------|------|
| `loading` | Spin |
| `nested-blocked` / `root-outside` | 阻断说明，无 init |
| `no-repo` | **启用版本管理** |
| `ready-clean` / `ready-dirty` | 空态 / 完整面板 |
| `error` | Alert |

### 5.3 主面板（ready-dirty）

- **保存版本** → Modal（变更摘要 + 版本说明；打开自动 AI 预填；确认 → `git:saveVersion`）
- **已修改（n）**：flat 列表；新文件空心圆点；单击 diff；新文件 `⋯` → 不跟踪
- **历史**：log、查看差别、**替换内容**（单层 Modal）
- author 无效：保存 disabled + 引导设置

### 5.4 文件树改动标记

- **工作目录** Tab 节点角标/色点，随 `git:state-changed` 刷新

---

## 6. 功能清单（V6 一次性交付）

| 能力 | UI | Agent | IPC |
|------|-----|-------|-----|
| discover / status | Tab + 列表 | `git_status` | `git:discover`, `git:status` |
| init | 启用版本管理 | — | `git:init` |
| 保存版本 | Modal | `git_stage`+`git_commit` | `git:saveVersion`, `git:suggestVersionMessage` |
| diff | FileOverlay | `git_diff` | `git:diff` |
| 不跟踪 | `⋯` 菜单 | `git_ignore` | `git:ignore` |
| 历史 / 替换 | 折叠列表 | `git_log`, `git_restore_version` | `git:log`, `git:restoreVersion`, `git:diffCommit` |
| 文件树标记 | 角标 | — | — |
| 分支 / discard | — | `git_branch`, `git_discard` | `git:branch`, `git:discard` |

---

## 7. 数据模型、安全、模块

- 类型与 IPC：见原文 §8（V6 不含 `git:pull`/`git:push`/`git:clone`）
- 安全分级：见原文 §10（V6 无凭据）
- 模块清单：见原文 §9（`electron/git/*`、`Git/` 组件、`gitExecutors`）

---

## 8. 用户故事

| ID | 作为… | 我希望… | 以便… |
|----|--------|---------|--------|
| US-V6-01 | 写作者 | 一键保存版本并写说明 | 改动有命名快照 |
| US-V6-02 | 写作者 | 看 diff 和历史、用存档替换 | 回顾与改回某一版 |
| US-V6-03 | 写作者 | 不跟踪临时文件 | 列表干净 |
| US-V6-04 | M1 升级用户 | 不重做工作区就能用 Git | Git 是增量功能 |
| US-V6-05 | 聊天用户 | Agent 执行本地 Git | 不用记 git 命令 |

---

## 9. 验收标准

- [ ] M1 发布物无 Git UI / isomorphic-git 硬依赖
- [ ] 本地闭环：启用 → 保存 → 历史 → 替换 → 再保存
- [ ] 单仓库 / C-strict 规则；切换 Profile 上下文正确
- [ ] 不跟踪不删文件；UI 无 Git 字母状态码；ToolCall 产品词汇
- [ ] **无**同步/clone/凭据（留 V7）

---

## 10. 工作量参考

原文 Phase 0–2 合计约 **13–19 人日**。

---

## 11. 关联文档

- [v1-workspace-management-requirement.md](./v1-workspace-management-requirement.md)
- [v7-git-remote-sync-requirement.md](./v7-git-remote-sync-requirement.md)
- [v8-git-advanced-requirement.md](./v8-git-advanced-requirement.md)
- [README.md](./README.md)
- [isomorphic-git-workdir-version-control-requirement.md](./isomorphic-git-workdir-version-control-requirement.md)
