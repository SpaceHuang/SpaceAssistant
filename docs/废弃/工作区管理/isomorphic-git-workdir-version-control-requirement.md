# 工作目录 Git 版本管理（isomorphic-git）需求调研

> 版本：v3.0  
> 状态：规格已定（待开发）；**§4.10 单仓库模型（取代 §4.2–4.4 多仓库）**；§6.5 写作极简 UI（v2.8）  
> 分版本 PRD：[README.md](./README.md) · [V6 本地版本管理](./v6-git-local-version-control-requirement.md) · [V7 远端同步](./v7-git-remote-sync-requirement.md) · [V8 进阶（可选）](./v8-git-advanced-requirement.md)  
> 前置依赖：[multi-workdir-requirement.md](../multi-workdir-requirement.md)、[detail-panel-file-list-requirement.md](../detail-panel-file-list-requirement.md)、[file-pane-tree-requirement.md](../file-pane-tree-requirement.md)、[tools-requirement.md](../tools-requirement.md)、[shell-security-enhancement-requirement.md](../shell-security-enhancement-requirement.md)

---

## 目录

1. [概述](#1-概述)（含 [§1.4 产品策略：双暴露面](#14-产品策略双暴露面已决)）
2. [isomorphic-git 调研结论](#2-isomorphic-git-调研结论)
3. [本项目现状与差距](#3-本项目现状与差距)
4. [仓库作用域模型](#4-仓库作用域模型)（**[§4.10 单仓库 v3（已决）](#410-单仓库简化模型v3-已决取代-424-多仓库模型)** · [§4.9 用户用语映射](#49-用户用语与-agent-工具映射已决)）
5. [方案选型对比](#5-方案选型对比)
6. [推荐架构](#6-推荐架构)（含 [§6.5 版本管理面板](#65-版本管理面板交互规格)）
7. [功能范围与分期](#7-功能范围与分期)
8. [数据模型与 IPC 设计](#8-数据模型与-ipc-设计)
9. [模块改造清单](#9-模块改造清单)
10. [安全与权限](#10-安全与权限)
11. [与现有能力的关系](#11-与现有能力的关系)
12. [非功能需求与风险](#12-非功能需求与风险)
13. [工作量估算](#13-工作量估算)
14. [已决问题汇总](#14-已决问题汇总)
15. [版本管理 UI 已决项](#15-版本管理-ui-已决项)
16. [参考资料](#16-参考资料)

附录：[A 伪代码](#附录-aphase-0-最小实现伪代码) · [B Agent 工具 Phase 1](#附录-b建议的-agent-工具签名phase-1) · [C Agent 工具 Phase 3 远程](#附录-cagent-工具签名phase-3-远程) · [D 双暴露面速查](#附录-d双暴露面速查实现-checklist)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 以 **工作目录（workDir）** 作为 Agent 与文件 UI 的沙箱边界。用户可将 workDir 指向本地项目根目录或任意子目录，并通过多工作目录 Profile 在多个项目间切换。当前版本管理依赖 Agent 通过 `run_shell` 调用系统 `git` 命令（如 `git status`），缺少：

- 结构化的 Git 状态数据（供 UI 与 Agent 消费）
- 独立于 Shell 的版本管理界面
- 跨平台一致的行为（不依赖用户是否安装 Git、Git 版本是否一致）
- 凭据与危险操作的可控治理

本调研评估接入 **[isomorphic-git](https://isomorphic-git.org/)** 的可行性，并分析在本项目中为 workDir（及其子目录）提供 Git 版本管理能力所需的工程工作。

**产品定位（v2.1）**：SpaceAssistant 面向写作与 Agent 协作。Git 在工程上提供完整版本能力，但 **版本管理 Tab** 仅实现 **写作极简** 交互（§6.5）；**Agent** 通过全面 `git_*` 工具承担分支、部分提交、丢弃、clone 等进阶操作（§4.9、§1.4）。不提供 IDE 式 SCM 面板（无暂存分组、分支条、Git 工具栏等）。

### 1.2 目标

| ID | 目标 |
|----|------|
| G1 | 自动识别当前 workDir **根仓库**（0 或 1 个），展示变更与历史（§4.10） |
| G2 | 支持暂存、提交、查看 diff/log 等本地核心工作流 |
| G3 | 可选支持 fetch/pull/push（HTTPS + 凭据管理） |
| G4 | 与多工作目录切换联动，各 Profile 独立 Git 上下文 |
| G5 | 与现有路径沙箱、工具确认、Shell 安全策略一致 |
| G6 | Agent **默认启用** `git_*` 结构化工具；与 Git UI 共用主进程 Git 服务；`run_shell` 仅作进阶回退 |
| G7 | Git 与项目文件树共用右侧 `detail-panel-top`，底栏 Tab **「工作目录 | 版本管理」** 切换，整体位于「引用的文件」之上 |
| G8 | **单仓库**：每个 workDir Profile **至多一个** Git 仓库，**必须**位于 workDir **根**；**无**仓库选择器（§4.10） |
| G9 | **双暴露面**：`gitService` 与 Agent `git_*` 工具能力全面；**版本管理 Tab UI 为写作极简**（§6.5）；UI 未暴露的操作由 Agent 与 `run_shell` 承担 |
| G10 | **用语一致**：UI 使用产品词汇（保存版本、已修改、**不跟踪**、同步）；**禁止**向用户展示 Git 状态字母 `?`/`M`；Agent 通过 tool description + 系统提示映射用户自然语言至 `git_*`（§4.9） |

### 1.3 非目标（首期）

| 非目标 | 说明 |
|--------|------|
| 渲染进程直接运行 isomorphic-git | 所有 Git IO 走主进程 IPC |
| 完整替代 GitHub Desktop / 专业 Git 客户端 | 用户 UI 为写作极简（§6.5）；进阶 Git 由 Agent + `run_shell` 承担 |
| 独立 Git 翻译 Skill | 用户用语映射写入 tool description + 系统提示（§4.9）；可选薄 Skill 仅管歧义与多步编排 |
| Git LFS 完整支持 | isomorphic-git 无原生 LFS smudge/clean |
| SSH 协议原生支持 | 需 HTTPS 或系统 Git 回退 |
| Git hooks 执行与管理 | 不在应用内触发或配置 hooks |
| 子模块一键递归操作 | 可识别，完整 UX 后置 |

### 1.4 产品策略：双暴露面（已决）

> **已决**：同一 `gitService` 之上，**Agent 工具面能力全面**，**用户 UI 面为写作极简**；不是两套 Git 实现，而是 **两种暴露粒度**。

#### 1.4.1 第一性原理（写作场景）

| 用户本质需求 | 产品词汇（UI） | 底层 Git |
|-------------|---------------|----------|
| 知道改了什么 | **已修改** | `status` |
| 存一个有说明的快照 | **保存版本** | stage + `commit` |
| 对比上一版 | **查看改动** | `diff` |
| 别让某文件出现在列表里 | **不跟踪** | 写 `.gitignore`（文件**不删**） |
| 与远端对齐（可选） | **同步** | `pull` + `push` |

分支、暂存区、fetch、discard、部分提交等 **不是** 写作者第一路径，**不在默认 UI 暴露**，由 Agent 承接。

#### 1.4.2 双暴露面对照

| 维度 | Agent 工具面 | 用户 UI 面（§6.5） |
|------|-------------|---------------------------|
| **目标用户** | 模型 + 自然语言指挥 | 写作者点击操作 |
| **能力范围** | Phase 1 本地 `git_*`；**Phase 3** 起 `git_pull` / `git_push` / `git_clone` 等远端；Phase 4 stash/merge 等；`run_shell` 回退 | **Phase 1–2** 本地闭环（§6.5）；**Phase 3** 同步；不含暂存 UI / 分支 UI |
| **术语** | 工具名 `git_*`；**对用户回复**用产品词汇（§4.9.6） | **禁止** staging、HEAD、index 等面向用户文案 |
| **暂存区** | `git_stage` 可指定 paths | **无**；`git:saveVersion` = stage all + commit |
| **分支** | `git_branch` | **无** UI |
| **危险操作** | discard / delete untracked / force push / **reset --hard**：确认流（§10.2） | **替换内容** 单层确认 Modal（§6.5.6）；**无**独立 discard UI |
| **不跟踪新文件** | `git_ignore` | 未纳入版本管理的文件行 `⋯` → **不跟踪**（§6.5.5） |
| **历史 / 替换** | `git_log`、`git_restore_version` | 当前文件夹 **历史** → **替换内容**（§6.5.6） |
| **用语映射** | tool description + 系统提示（§4.9） | i18n `git.*`（§6.5.8） |

#### 1.4.3 用户主路径（默认 UI）

```text
打开「版本管理」Tab → 看「已修改」→ （可选）查看改动 diff
      → 点「保存版本」→ 二级界面写/生成版本说明 → 确认保存
      → 对新文件行：⋯ → 「不跟踪此文件」（§6.5.5）
Phase 2+：历史 → **替换内容**（一次确认）；工作目录 Tab 文件树改动标记
Phase 3+：同步（远端）
```

**≤3 步**完成存档；**不**做暂存区分组、行内 stage、分支条、Git 工具栏等专业 SCM 交互。

#### 1.4.4 与 Agent _chat 的分工

| 用户意图示例 | 推荐路径 |
|-------------|---------|
| 「把今天改的存个版本」 | Agent → `git_status` + `git_stage` + `git_commit`；或引导用户点 **保存版本** |
| 「只提交 chapter-1.md」 | **仅 Agent**（UI 不支持部分提交） |
| 「切到 dev 分支」 | **仅 Agent** → `git_branch` |
| 「别跟踪 logs 目录」 | UI **不跟踪** 或 Agent → `git_ignore` |
| 「撤销对 xxx 的修改」 | **仅 Agent** → `git_discard` + 确认 |
| 「回到昨天存的那个版本」 | UI **历史** → **替换内容**；或 Agent → `git_restore_version` |

聊天里 Agent 执行 Git 操作时，ToolCallCard 展示 **产品标签**（如「保存版本」），使用户 UI 与 Agent 反馈 **词汇一致**（§4.9.6）。

---

## 2. isomorphic-git 调研结论

### 2.1 库定位

isomorphic-git 是纯 JavaScript 实现的 Git 客户端，读写标准 `.git` 目录，与 canonical Git 磁盘格式兼容。设计上通过 **依赖注入** 提供：

| 依赖 | Node/Electron 主进程 | 浏览器（本项目不需要） |
|------|----------------------|------------------------|
| `fs` | Node 原生 `fs` / `fs/promises` | LightningFS / zen-fs 等 |
| `http` | `isomorphic-git/http/node` | `isomorphic-git/http/web` |
| 认证 | `onAuth` / `onAuthSuccess` / `onAuthFailure` 回调 | 同上 |
| 进度 | `onProgress` / `onMessage` 回调 | 同上 |

**对 SpaceAssistant 的适配性**：Electron **主进程**可直接使用 Node `fs` + `http/node`，无需 LightningFS，也不应将库打包进渲染进程（体积与安全考量）。

### 2.2 已支持的核心 API（v1.38.x，2026）

按场景归类（完整列表见 [官方文档](https://isomorphic-git.org/docs/en/)）：

| 类别 | 代表 API | 产品价值 |
|------|----------|----------|
| 仓库发现 | `findRoot`、`resolveRef`、`getConfig` | 识别仓库根、读取 remote |
| 工作区状态 | `statusMatrix`、`status` | 文件树角标、变更列表 |
| 暂存与提交 | `add`、`remove`、`commit`、`readCommit` | 核心提交流程 |
| 历史 | `log`、`readBlob`、`walk` | 提交历史、diff 基础 |
| 分支 | `branch`、`listBranches`、`checkout` | 分支切换 |
| 远程 | `clone`、`fetch`、`pull`、`push`、`listRemotes` | 同步 |
| 合并 | `merge`、`abortMerge`、`isMerge` | 进阶 |
| 其他 | `stash`、`tag`、`reset`（部分） | 后置 |

CLI 封装 `isogit` 亦可用，但本项目应优先 **编程式 API + 自有 IPC**，以便与确认流、日志、i18n 集成。

### 2.3 关键限制

| 限制 | 影响 | 缓解策略 |
|------|------|----------|
| **无原生 SSH** | `git@github.com:...` 无法直接 clone/push | `autoTranslateSSH` 转 HTTPS + Token；或文档说明需配置 HTTPS remote；极端场景回退 `run_shell` |
| **无 Git LFS** | 检出后 LFS 指针文件非真实二进制 | 文档声明；大仓库用户继续用系统 Git；可选集成 `isogit-lfs` 社区方案（后置评估） |
| **sparse-checkout** | 稳定版无一等 API | 2.0 开发中；首期不做 |
| **子模块** | v1.36+ 可解析 `.git` 文件指向的 linked gitdir，但无完整 `submodule update` UX | 按独立仓库实例处理；文档说明限制 |
| **性能** | 大仓库 status/log 纯 JS 较慢 | 缓存、增量 status、操作节流、后台 Worker（后置） |
| **签名提交 GPG** | 需 `onSign` 自行实现 | 首期不支持 GPG 签名提交 |
| **Electron HTTP 代理** | `http/node` 基于 simple-get，不自动读 `HTTP_PROXY` | 企业代理场景需自定义 http 客户端（后置） |

### 2.4 依赖版本策略（已决）

> **已决**：**锁定 isomorphic-git 1.x**（实现时 pin 至当前 stable，如 `^1.38.0`），**不等待** 2.0 再开发 Git 功能；2.0 稳定发布后 **按需评估迁移**，非首期阻塞项。

| 项 | 规格 |
|----|------|
| **选用版本** | npm `isomorphic-git@^1.38`（或当时 latest 1.x）；**不**依赖 2.0 beta / `@next` |
| **不等待 2.0 的原因** | 2.0 仍处架构重构（ESM monorepo、GitBackend）；API 未稳定；无明确 GA 时间 |
| **迁移预留** | 所有 isomorphic-git 调用 **仅经** `electron/git/gitService.ts`（及子模块）；UI / IPC / Agent **不**直接 import isomorphic-git，便于将来换 2.x 或回退系统 Git |
| **打包范围** | 依赖仅主进程（`tsconfig.electron.json`）；**禁止** Vite 渲染 bundle 引用 |
| **后续** | 2.0 GA 后单独开迁移评估（sparse-checkout、性能等）；不在 Phase 0–3 范围内 |

---

## 3. 本项目现状与差距

### 3.1 工作目录体系

已实现多工作目录 Profile（`electron/workDirManager.ts`），切换时联动会话、Wiki、Skill、项目记忆、Agent 日志路径等。Git 模块需：

- 切换 Profile 时 **丢弃内存缓存、重新 discover**
- 每个 Profile 独立凭据与状态，不串仓

### 3.2 文件与路径安全

| 机制 | 位置 | 与 Git 的关系 |
|------|------|---------------|
| `resolveSafePath` | `electron/pathSecurity.ts` | 所有文件工具限制在 workDir 内 |
| `.git` 跳过 | `electron/appIpc.ts` 搜索、`builtinExecutors.ts` GREP | 避免工具直接读写 `.git` |
| Wiki raw 只读 | `builtinExecutors.ts` | 与 Git 无冲突 |

**关键差距**：若 workDir 设为仓库 **子目录**（如 `monorepo/packages/app-a`），Git 根目录可能在 workDir **之上**，超出当前沙箱。已采用 **C-strict** 策略处理（见 §4.3）：不向 workDir 外扩展 Git 访问。

### 3.3 现有 Git 相关能力

| 能力 | 现状 |
|------|------|
| Agent 执行 git | `run_shell` 可跑 `git status` 等（**Git 工具上线后降为回退路径**） |
| 危险 git 命令 | `shellSecurity.ts` 对 `push -f`、`reset --hard`、`clean -fdx` 强制确认 |
| 文件快照 | `fileCheckpointingEnabled` 在 `userData/file-history/` 做会话级备份，**不是 Git** |
| 文件树 | `useFileTree` 支持 `rootRelPath` 子树根，但无 Git 状态 |
| UI | 无 Source Control 面板；项目文件树在右侧 `detail-panel-top`（见 [detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md)） |

### 3.4 架构约束（来自 CLAUDE.md）

- 主进程 CommonJS 编译至 `dist-electron/`
- IPC：`preload.ts` → `appIpc.ts`
- 类型单一来源：`src/shared/domainTypes.ts`
- 新 UI 文案必须 i18n

---

## 4. 仓库作用域模型

> **v3.0（已决）**：实施以 **[§4.10 单仓库简化模型](#410-单仓库简化模型v3-已决取代-424-多仓库模型)** 为准。  
> §4.1–§4.5 中 **§4.2–§4.4 多仓库 / 扫描 / 聚焦子项目** 规格 **存档**，**不再开发**。

用户所说的「工作目录」在 v3 下简化为：**一个 workDir Profile = 一个项目文件夹 = 0 或 1 个 Git 仓库（根在 workDir）**。

### 4.1 场景 A：workDir 即 Git 仓库根

```
workDir = E:\Projects\MyApp\
          └── .git/
          └── src/ ...
```

- **发现**：`findRoot({ fs, filepath: workDir }) === workDir`
- **操作范围**：整个仓库
- **实现难度**：低（标准路径）

### 4.2 场景 B：workDir 内包含多个独立 Git 仓库（**存档，v3 不实施**）

> **v3 已取代**：见 §4.10。下列内容仅供历史对比。

> **已决策略**：扫描 workDir 内全部 Git 仓库并 **一并注册**；版本管理 Tab 用 **仓库选择器**（≥2 时）切换当前仓库；**可选** 文件 Tab 选中路径时自动同步选择器。

```
workDir = E:\Projects\
          ├── repo-a/.git/
          └── repo-b/.git/
```

- **发现**：自 workDir 起向下扫描（深度见 `GitConfig.repositoryScanMaxDepth`，**默认 1**，对齐 VS Code `git.repositoryScanMaxDepth`）；对每个满足 C-strict（`.git` 在 workDir 内）的路径生成 `GitRepoBinding`；workDir 自身若也是仓库（场景 A 与 B 叠加）一并纳入列表
- **UI**：
  - Git Tab 顶栏（`WorkDirSelector` 下方）显示 **仓库下拉**（显示名优先 `relToWorkDir` 或目录 basename）
  - 变更列表、分支、提交等 **仅展示当前选中仓库**
  - 仅 1 个仓库时 **隐藏下拉**，行为等同场景 A
  - **可选增强**：文件 Tab 选中某文件/目录时，若其落在某一 `GitRepoBinding.dir` 下，自动切换 Git Tab 的当前仓库（用户仍可用下拉手动覆盖）
- **Agent**：`git_*` 工具支持 `repo_rel_path?`；省略时使用 UI 当前选中仓库；若路径唯一匹配则自动解析
- **明确不做**：「只显示当前选中路径所属仓库、不列出其它仓库」（Cursor 原生亦非此模式）
- **参考**：VS Code/Cursor 在 Source Control 中并列展示多 repo；Cursor 默认 `git.autoRepositoryDetection: "openEditors"` 较懒，本产品 **主动扫描**（更接近 VS Code 的 `true`）
- **实现难度**：中

#### 4.2.1 仓库扫描深度（已决）

> **已决**：`GitConfig.repositoryScanMaxDepth` **设置页可配**，**默认 `1`**，语义对齐 VS Code `git.repositoryScanMaxDepth`。

| 值 | 扫描范围（自 workDir 起） |
|----|---------------------------|
| **1**（默认） | workDir 自身 + **直接子目录**中的 Git 仓库 |
| **2** | 再向下一层（如 `workDir/group/project/`） |
| **n** | 继续加深；实现时与 VS Code 一样 BFS 遍历，跳过 `node_modules` 等忽略目录（见下） |

- **设置入口**：设置页 Git 区块（数字输入，建议范围 1–5；高级用户可文档说明更大值）。
- **忽略目录**：默认跳过 `node_modules`、`.space-skills` 等与 VS Code `git.repositoryScanIgnoredFolders` 类似名单；可后置扩展。
- **变更生效**：修改深度后重新 `git:discover`（切换 workDir 时自动触发）。
- **为何默认 1**：与 VS Code 一致——常见「并列多 repo」够用，避免 deep scan 拖慢大 workDir；嵌套更深用户自行调高。

### 4.3 场景 C：workDir 是某 Git 仓库的子目录（**存档；v3 合并为 §4.10.1 父级 .git 阻断**）

> **已决策略（C-strict）**：仅当 `.git` 位于 workDir **内部**时启用 Git 功能；否则不 discover 仓库，并向用户提示调整工作目录。

```
Git root = E:\Projects\MyApp\     ← workDir 之外
workDir  = E:\Projects\MyApp\packages\foo/
```

- **发现**：从 `startDir`（workDir 或 `focusRelPath` 解析路径）向上调用 `findRoot`；若找到的仓库根 `root !== workDir` 且 `.git` 不在 workDir 子树内，则 **判定为不支持**
- **沙箱冲突**：`.git` 位于 workDir 外，与 `resolveSafePath` 沙箱边界不一致；**不**向 workDir 外扩展 Git 或文件工具访问
- **行为**：
  - `git:discover` 返回 `{ supported: false, reason: 'GIT_ROOT_OUTSIDE_WORKDIR' }`（或等价结构）
  - UI / Agent 展示 i18n 提示：**「请将工作目录设为仓库根目录或其父目录」**
  - 用户可将 workDir Profile 路径改为 `E:\Projects\MyApp\`（场景 A），或在 monorepo 中改用场景 D（workDir 设为含 `.git` 的上层目录）
- **明确不做**：C-readonly-up（只读访问父级 `.git`）、C-expand-sandbox（临时扩大沙箱至 repo root）

### 4.4 场景 D：workDir 内某子目录为 Git 根（**存档，v3 不实施**）

> **v3 已取代**：请将 workDir Profile 路径 **直接设为** 该子项目根目录（§4.10.1）。

```
workDir = E:\Workspace\
          └── client/.git/    ← 用户关注此子目录
          └── docs/           ← 非 git
```

- **发现**：作为场景 B 的特例——扫描后 `client/` 出现在仓库列表中；用户可通过 **仓库选择器** 选中，或通过 `GitConfig.focusRelPath` / 文件树选中路径 **默认聚焦** 该仓库
- **与 B 的关系**：B 是「列出全部 + 用户选」；D 是「列表中通常只关心其中一个」，靠选择器或 `focusRelPath` 决定初始选中项，**不**单独隐藏其它已发现仓库
- **实现**：复用 B 的 `discoverRepos`；`focusRelPath` 仅影响 **默认 activeRepo**，不影响扫描范围

### 4.5 RepoBinding 与 discover 结果

```typescript
interface GitRepoBinding {
  /** 稳定 ID，如 relToWorkDir 或 hash(dir) */
  id: string
  /** 仓库工作树根（绝对路径）；C-strict 下必须在 workDir 子树内 */
  dir: string
  /** .git 目录或 gitdir 文件路径 */
  gitdir: string
  /** 相对 workDir 的路径；空字符串表示 workDir 即 dir */
  relToWorkDir: string
  /** UI 显示名，默认 basename(dir) */
  displayName: string
}

/** git:discover 成功时 */
interface GitDiscoverResult {
  supported: true
  repos: GitRepoBinding[]
  /** 建议默认选中的 repo id（单仓库或 focusRelPath 匹配时） */
  defaultRepoId: string | null
}

/** discover 失败（场景 C 等） */
interface GitDiscoverUnsupported {
  supported: false
  reason: 'GIT_ROOT_OUTSIDE_WORKDIR' | 'NOT_A_REPO'
  detectedRootOutside?: string
}

type GitDiscoverResponse = GitDiscoverResult | GitDiscoverUnsupported
```

### 4.6 Agent Git 工具策略（已决）

> **已决（方案 A）**：Git 能力上线后，Agent **默认启用** `git_status` / `git_diff` / `git_stage` / `git_commit` 等结构化工具；与 Git Tab **共用** `electron/git/gitService`，不默认走 `run_shell` 解析 `git status` 文本。

| 项 | 规格 |
|----|------|
| **默认开关** | `GitConfig.agentToolsEnabled === true`（新装与升级默认值）；设置页可关闭 |
| **适用条件** | 当前 workDir `git:discover` 至少 1 个 repo 且 Git 功能未全局禁用时，向模型注册 `git_*` 工具 |
| **工具描述** | 在 system/tool schema 中明确：**查看状态、diff、暂存、提交优先使用 `git_*`** |
| **run_shell 定位** | **回退**，用于 isomorphic-git 未覆盖或结构化工具失败时，例如：`git rebase -i`、`git stash`、LFS、复杂 pipe、用户明确要求 shell |
| **不做的** | 不全面禁止 `run_shell` 中的 `git` 子命令（避免误伤进阶操作）；不在首期做 shell 层自动拦截 `git status` |
| **确认流** | `git_commit` 及 **Phase 3** 的 push/pull 等与 UI 共用同一确认 / 风险分级（§10.2） |
| **多仓库** | ~~Agent 工具 `repo_rel_path?`~~ → **v3 无此参数**；见 §4.10 |

### 4.7 提交身份（author）解析（已决）

> **已决**：`git commit`（UI 与 Agent）写入 `user.name` / `user.email` 时，按以下 **优先级链** 解析；任一层级要求 **name 与 email 均非空** 才算有效。

| 优先级 | 来源 | 读取方式 |
|--------|------|----------|
| **1** | **本仓库** `git config` | `git.getConfig({ dir, path: 'user.name' })` / `user.email`（含 local 覆盖 global 的标准 Git 规则） |
| **2** | **当前 workDir Profile** | `WorkDirProfile.gitUserName` / `gitUserEmail`（设置页工作目录条目内可配） |
| **3** | **应用全局默认** | `AppConfig.git.userName` / `userEmail`（设置页 Git 区块） |
| **4** | 均无有效值 | **阻止提交**；返回 `GIT_AUTHOR_NOT_CONFIGURED`；UI / Agent 提示配置（i18n：`git.errors.authorNotConfigured`） |

**行为细则**：

- **不修改**仓库 `.git/config`：应用只在 commit 时把解析结果传给 `git.commit({ author: { name, email } })`（或等价参数），除非用户显式使用「保存为仓库默认身份」类操作（**首期不做**写回 config）。
- **UI 预览**：Git Tab 提交区展示「将以此身份提交：Name \<email\>」，来源标注（仓库 / Profile / 全局）可选。
- **Agent**：`git_commit` 使用同一 `resolveCommitAuthor(workDir)`；…
- **init 新仓库**：若三级均无配置，init 后首次 commit 仍走同一校验；不在 init 时静默写入假身份。

```typescript
interface GitAuthor {
  name: string
  email: string
  source: 'repo' | 'profile' | 'global'
}

// electron/git/gitAuthor.ts（示意）
async function resolveCommitAuthor(ctx: {
  workDir: string
  profile: WorkDirProfile
  globalGit: GitConfig
}): Promise<GitAuthor | { error: 'GIT_AUTHOR_NOT_CONFIGURED' }>
```

**WorkDirProfile 扩展（草案）**：

```typescript
interface WorkDirProfile {
  // ...现有字段
  gitUserName?: string
  gitUserEmail?: string
}
```

### 4.8 Clone 目标路径（**存档；v3 见 §4.10.7**）

> **v3 已调整**：clone 推荐 **新建 WorkDir Profile** + workDir 根；下列 §4.8 子目录 clone **不再实施**。

> **已决**：UI 发起 **clone** 时 **不**默认克隆到 workDir 根目录；须通过 **弹窗** 让用户指定 workDir **内的目标子目录**（相对路径），确认后再执行。

**弹窗流程（设置页 / 空态 onboarding「克隆仓库」）**：

| 步骤 | 说明 |
|------|------|
| 1 | 输入远程 URL（HTTPS；SSH URL 提示改用 HTTPS 或 shell 回退） |
| 2 | **选择目标子目录**：相对 workDir 的路径（如 `vendor/lib`、`repos/my-app`）；提供目录树或路径输入 + 浏览；**默认不预填 workDir 根**（`.`） |
| 3 | 可选默认值：从 URL 解析建议目录名（如 `https://github.com/org/foo.git` → 建议 `foo`），用户可改 |
| 4 | 校验：`resolveSafePath(workDir, destRelPath)`；目标不存在或为空目录；若已含 `.git` 则拒绝 |
| 5 | 确认后 `git:clone`；进度展示；完成后 `git:discover` 并选中新区 repo |

**明确不做**：

- 不静默 clone 到 workDir 根（避免污染当前工作区根、与现有 `SPACEASSISTANT.md` / 会话备份等文件冲突）
- 不在首期做「clone 到 workDir 外」

**Agent / 工具（Phase 3）**：

- 新增 `git_clone` 时 **`dest_rel_path` 必填**（无 UI 弹窗）；Agent 须显式指定子目录；仍走同一 `resolveSafePath` 校验
- 用户通过聊天 clone 且未给路径时，Agent 应询问目标子目录，而非默认 `.`

```typescript
// git:clone 请求
interface GitCloneRequest {
  url: string
  /** 相对 workDir，必填；UI 由弹窗收集，Agent 由工具参数提供 */
  destRelPath: string
}
```

### 4.9 用户用语与 Agent 工具映射（已决）

> **已决（双暴露面）**：面向用户的 **版本管理 Tab** 使用产品词汇（§6.5）；面向 Agent 的 **`git_*` 工具** 保持 Git 标准能力与命名。二者共用 `gitService`，通过 **tool description + 系统提示** 对齐用户自然语言，**不**默认加载独立「Git 翻译 Skill」。

#### 4.9.1 双暴露面原则

```text
                    gitService（完整 Git 领域能力）
                                  │
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
   Agent 工具面（全面）                    用户 UI 面（极简，§6.5）
   git_status / git_stage / …            已修改 + 保存版本 + diff + 不跟踪 + 同步
   细粒度 IPC + run_shell 回退            git:saveVersion 等 UI 编排（可选）
```

| 层 | 职责 | 规格 |
|----|------|------|
| **gitService** | 单一真实来源 | 所有 Git IO；UI 与 Agent **不得**各写一套逻辑 |
| **Agent `git_*`** | 全面结构化工具 | 按 Phase 注册；description 含 UI 同义词（§4.9.3） |
| **用户 UI** | 写作极简 | §6.5；**不跟踪** 为除保存版本/同步/恢复外的高频写操作（§6.5.5） |
| **run_shell** | 回退 | rebase / stash / LFS 等；沿用 `dangerous_git`（§4.6） |

**UI 编排示例**（`git:saveVersion`，可选 IPC，仅 UI 使用）：

```typescript
// 用户点「保存版本」：stage 全部未提交变更 + commit（Agent 仍可用 git_stage + git_commit 细粒度操作）
async function saveVersion(workDir: string, message: string) {
  const paths = await gitService.listUncommittedPaths(workDir)
  await gitService.stage(workDir, paths)
  return gitService.commit(workDir, { message })
}
```

**状态展示**：主进程仍返回完整 `GitRepoStatus`（含 staged/unstaged）；极简 UI **合并渲染为「已修改」**；Agent / ToolCallCard 仍展示完整结构。

#### 4.9.2 UI 产品词汇 ↔ Agent 工具（术语表）

实现时 **UI i18n** 与 **Agent 系统提示** 共用下表（zh-CN 为真实来源）：

| UI / 用户常说 | 含义 | Agent 工具 | 禁止混淆为 |
|---------------|------|-----------|-----------|
| **已修改** / 改了哪些 | 未提交的本地变更 | `git_status` | 已 push 的远程历史 |
| **保存版本** / 存档 / 存个版本 | 创建 Git 快照 | `git_stage`（全部或指定 paths）+ `git_commit` | `write_file` / 编辑器存盘 |
| **查看改动** / 和上一版比 | 文件 diff | `git_diff` | 全文重写文件 |
| **不跟踪** / 别出现在列表里 / 别跟踪这个 | 写入 `.gitignore`，文件仍留在磁盘 | `git_ignore` | **删除文件**、`git_discard`、临时隐藏 |
| **同步** / 备份到云端 | 与 remote 对齐 | `git_pull` + `git_push`（或按用户意图只 pull/只 push） | 飞书同步、会话备份 |
| **撤销修改** / 改坏了还原 | 工作区恢复为 HEAD | `git_discard` | `git revert`、编辑器 Undo |
| **切分支** / 换分支 | checkout | `git_branch` | 切换 workDir Profile |
| **历史** / 以前存过哪些版本 | 提交 log | `git_log` | `fileCheckpointing` 会话快照 |
| **用此次存档替换** / 回到某次存档的内容 | 把当前文件内容换成某次 commit 的快照 | `git_restore_version` | `git_discard`（仅回到**最新**保存版）、编辑器 Undo、`reset --hard` |
| **克隆** / 拉个项目 | clone 到 workDir 子目录 | `git_clone`（`dest_rel_path` 必填） | 选 workDir Profile |

**Agent 回复用户时**应使用 **UI 词汇**（如「已保存版本」），ToolCallCard 展示友好标签（与 `git.*` i18n 共用，如 `git.actions.saveVersion`），内部仍调 `git_commit`。

#### 4.9.3 歧义处理（必写进系统提示）

| 用户说 | 风险 | Agent 行为 |
|--------|------|-----------|
| **保存** / **存一下** | 可能指编辑器存盘 | 若上下文在讨论版本/改动/版本管理 Tab → 倾向 **保存版本**（`git_commit`）；若刚编辑单文件且未提 Git → **先问一句**或先用 `read_file` 确认是否仅需写回磁盘 |
| **提交** | 可能指发送聊天 | 结合上下文；涉及文件变更时 → **Git commit**，非发送消息 |
| **撤销** | Undo / discard / revert / 替换 混淆 | **先澄清**：编辑器 Undo vs **上次保存版本之后的改动**（`git_discard`）vs **用历史某次存档替换当前文件**（`git_restore_version`）vs 删历史 commit（`reset --hard`，仅 Agent） |
| **同步** | 可能指飞书 / 云盘 | 在 Git 上下文 → pull/push；否则确认是否指 Git remote |

**不需要**单独 Skill 仅罗列上表；上表写入 Agent **Git 工作流**系统提示片段（约 10–20 行）。若后续需要多步编排（如：不跟踪 → stage `.gitignore` → 询问是否保存版本），可新增可选薄 Skill **`git-writing-workflow`**（§4.9.5），**非首期阻塞**。

#### 4.9.4 工具 description 模板（Phase 1–2）

注册 `git_*` 时，description **必须**包含：① 功能说明；② UI/用户同义词（§4.9.2）；③ 与哪些工具 **不要** 混淆。实现时可直接采用下列模板（en 可译，zh 优先给中文模型）：

**`git_status`**

```text
查看 Git 仓库变更状态（已修改文件列表、是否干净、当前分支）。
用户说「改了哪些」「有什么变动」「看看状态」时使用。
不要用来保存文件或提交版本。
```

**`git_diff`**

```text
查看指定文件相对上一版本的 unified diff。
用户说「看看改了什么」「和上一版有什么不同」「查看改动」时使用。
path 为仓库内相对路径；staged 可选。
```

**`git_stage`**

```text
暂存或取消暂存文件（git add / reset）。
用户说「只提交某几个文件」「先暂存」时使用；若用户说「保存版本」且未指定文件，应先 git_status 再 stage 全部变更后 git_commit。
UI「保存版本」在后台等价于 stage all + commit，Agent 可显式分步调用本工具与 git_commit。
```

**`git_commit`**

```text
创建 Git 版本快照（commit）。用户说「保存版本」「存档」「存个版本」「提交改动」时使用。
不要用 write_file 代替 commit。提交前需有效 author（§4.7）；message 必填。
若用户只说「保存」且意图不明，先确认是否指 Git 存档而非编辑器存盘。
```

**`git_ignore`**

```text
将路径追加到仓库根 .gitignore，使**尚未纳入版本管理**的文件不再出现在「已修改」列表。用户说「不跟踪」「别跟踪这个文件/文件夹」「别让它出现在列表里」时使用。
**对用户说明**：文件**不会从磁盘删除**；若需真正删文件，须用文件管理或 Agent，不要用本工具。
不要与 git_discard 或删除文件混淆。
```

**`git_discard`**

```text
丢弃已跟踪文件的工作区修改，恢复为 HEAD 版本（危险，须确认）。用户说「撤销修改」「改坏了恢复」且针对已跟踪文件时使用。
不要用于未跟踪文件（?）；不要与 git revert 或编辑器 Undo 混淆。
```

**`git_branch`**

```text
列出、创建、切换 Git 分支。用户说「切分支」「换到 xxx 分支」时使用。
若工作区有未提交变更，checkout 会被拒绝（GIT_DIRTY_WORKING_TREE）；引导用户先保存版本或显式 discard。
```

**`git_pull` / `git_push`**

```text
从 remote 拉取 / 推送到 remote（须确认）。用户说「同步」「拉最新」「推到远端」时使用。
「同步」通常指 pull 后再 push；有本地未提交变更时 pull 前提醒先保存版本。
禁止 force push。
```

**`git_clone`**

```text
克隆远程仓库到 workDir 内指定子目录。dest_rel_path 必填（§4.8）。用户说「克隆」「拉个项目下来」时使用。
```

**`git_log`**

```text
查看提交历史。用户说「以前存过哪些版本」「历史记录」时使用。与会话级 fileCheckpointing 无关。
```

**`git_restore_version`**

```text
把工作区文件内容换成某次已保存版本（commit）的快照。用户说「用那次存档替换」「回到昨天那个版本的内容」「改回某一版」时使用。
与 git_discard 不同：discard 只撤销**上次保存版本之后**的改动；本工具把文件内容换成**历史某次**存档。
**对用户说明**：历史里的各次存档**不会删除**；替换后请在「已修改」检查，再「保存版本」固化。
工作区有**上次保存版本之后**的改动时，替换会覆盖这些改动——UI 在同一确认框内说明，**不**另开 discard 弹窗。
```

#### 4.9.5 可选 Skill（非首期）

| 项 | 规格 |
|----|------|
| **默认** | **不**注册独立「Git 翻译 Skill」；§4.9.2–4.9.4 已足够 |
| **可选** | `git-writing-workflow`：仅含歧义澄清话术、多步编排（不跟踪后提示保存 `.gitignore`）、与 `fileCheckpointing` 区分说明 |
| **加载条件** | 设置页开关或 discover 有 repo 时注入；**不得**替代 tool description |

#### 4.9.6 ToolCallCard 与 i18n

- 工具名 `git_commit` 等对用户展示为 **「保存版本」** 等（`git.toolLabels.*`），与版本管理 Tab 文案一致。
- Agent 结构化结果摘要使用 UI 词汇，避免对用户暴露 `staged` / `HEAD` 等术语，除非用户明确使用 Git 词汇。

### 4.10 单仓库简化模型（v3，已决；取代 §4.2–§4.4 多仓库模型）

> **动机**：写作场景下 **一个项目文件夹 = 一条版本时间线**；多仓库选择器、扫描深度、子目录聚焦增加认知负担，与 C-strict 沙箱叠加后场景矩阵过复杂。

#### 4.10.1 核心规则（已决）

| 规则 | 规格 |
|------|------|
| **一 Profile 一仓库** | 每个 `WorkDirProfile` 的 workDir 内 **0 或 1** 个 Git 仓库 |
| **仓库根 = workDir 根** | `.git` **必须**位于 workDir 根（`workDir/.git`）；**禁止** workDir 子目录内独立 `.git` |
| **启用版本管理** | `git:init` 在 **workDir 根** 执行；该文件夹及 **全部子目录** 文件纳入同一仓库 |
| **嵌套代码库检测** | **init 前** + **每次 `git:discover`** 扫描 workDir 子树；若存在 **任一** 子路径 `.git` 且 **不是** workDir 根 → **`GIT_NESTED_REPO`** |
| **父级 .git（原场景 C）** | workDir 自身无 `.git`，但 **父目录** 有 `.git` → **`GIT_ROOT_OUTSIDE_WORKDIR`**（与 v2 C-strict 相同，话术统一为换 workDir） |
| **多项目** | 靠 **多个 WorkDir Profile** 切换，**非** 一个 Profile 内多 repo |

#### 4.10.2 `git:discover`（v3）

```typescript
/** v3：无 repos[]、无 defaultRepoId、无 repoId */
type GitDiscoverResponse =
  | { supported: true; hasRepo: true }
  | { supported: true; hasRepo: false }                    // 可 init
  | {
      supported: false
      reason: 'GIT_NESTED_REPO' | 'GIT_ROOT_OUTSIDE_WORKDIR'
      /** 嵌套时：如 client/.git，供 UI 展示 */
      nestedPaths?: string[]
      detectedRootOutside?: string
    }
```

| 步骤 | 逻辑 |
|------|------|
| 1 | 若 `workDir/.git` 存在 → `{ hasRepo: true }` |
| 2 | 自 workDir 向下扫描（跳过 `node_modules` 等）；若发现 **子目录** `.git` → `GIT_NESTED_REPO` + `nestedPaths` |
| 3 | 若 workDir 无 `.git`，自 workDir 向上 `findRoot`；若 root **严格在 workDir 外** → `GIT_ROOT_OUTSIDE_WORKDIR` |
| 4 | 否则 → `{ hasRepo: false }` |

**删除**：`GitRepoBinding[]`、`activeRepoId`、`repositoryScanMaxDepth`、`focusRelPath`、`syncRepoFromFileSelection`。

#### 4.10.3 启用版本管理（init）UI

```text
┌─ 版本管理 ─────────────────────────────────────┐
│  当前工作目录还没有版本管理                       │
│  [ 为当前文件夹启用版本管理 ]                     │
│  启用后，此文件夹及子文件夹内的文件都可保存版本。   │
└────────────────────────────────────────────────┘
```

| 项 | 规格 |
|----|------|
| 前置 | `discover` → `hasRepo: false` 且 **非** unsupported |
| 点击 | `git:init()`（无 `destRelPath`；固定 workDir 根） |
| 嵌套阻断 | `GIT_NESTED_REPO` → **无** init 按钮；i18n `git.empty.nestedRepo`（例：「检测到 client/ 下已有代码库。请换一个工作目录，或移除嵌套代码库后再启用。」） |
| 父级阻断 | `GIT_ROOT_OUTSIDE_WORKDIR` → i18n `git.empty.rootOutside`（例：「请把工作目录设成你要管理的文件夹本身。」） |

#### 4.10.4 UI / 状态机简化（相对 v2）

| 删除（v2 有 → v3 无） | 说明 |
|----------------------|------|
| `GitRepoSelector` | 顶栏仅 `WorkDirSelector` |
| `repos[]` / `activeRepoId` | Redux 仅 `hasRepo` + 当前 `status` / `log` |
| 切换 activeRepo 的 loading / 缓存键 | Tab 切换只 refresh 当前 Profile |
| 文件树 → 同步仓库选择器 | 文件树与版本 **同一作用域** |
| 设置页 **扫描深度** | 整段删除 |
| IPC / Agent **`repoId` / `repo_rel_path`** | 省略；隐含当前 workDir 根仓库 |
| `commitMessageDraftByRepoId` 等 | → `commitMessageDraft`（按 Profile 持久化即可） |
| `pendingReplaceOidByRepoId` | → `pendingReplaceOid` |

**保留**：底栏 **工作目录 | 版本管理** 双 Tab（§6.4）；§6.5 全部写作极简交互。

#### 4.10.5 面板状态机（v3，取代 §6.5.3 多 repo 分支）

| 状态 | 条件 | 展示 |
|------|------|------|
| `loading` | discover / 切换 Profile / Tab 激活 | `Spin` |
| `nested-blocked` | `GIT_NESTED_REPO` | Alert + 嵌套路径列表；**无** init |
| `root-outside` | `GIT_ROOT_OUTSIDE_WORKDIR` | Alert + 引导改 Profile 路径 |
| `no-repo` | `hasRepo: false` | §4.10.3 空态 + **启用版本管理** |
| `ready-clean` / `ready-dirty` | `hasRepo: true` | §6.5.2 主面板 |
| `syncing` / `error` | 同 v2 | 同 v2 |

#### 4.10.6 IPC 与 Agent（v3 签名）

**原则**：所有 `git:*` invoke **省略 `repoId`**；主进程用当前 `workDir` 根仓库。

| 通道 | v3 参数（示意） |
|------|----------------|
| `git:discover` | `()` → `GitDiscoverResponse` |
| `git:init` | `()` → init at workDir root |
| `git:status` | `()` → `GitWorkDirStatus` |
| `git:diff` | `{ relPath, staged? }` |
| `git:log` | `{ depth?, ref? }` |
| `git:saveVersion` / `git:restoreVersion` / … | 无 repo 字段 |

**Agent 工具（附录 B）**：删除全部 `repo_rel_path?`；`git_clone` 见 §4.10.7。

```typescript
/** v3：binding 固定为 workDir 根，可内联不再暴露 id */
export interface GitWorkDirStatus {
  branch: string | null
  clean: boolean
  changes: GitFileChange[]   // relPath 相对 workDir
  ahead: number
  behind: number
  error?: string
}
```

#### 4.10.7 Clone 与远端（v3 调整）

| 项 | v2 | v3 |
|----|----|-----|
| UI clone 目标 | workDir **内子目录**（§4.8） | **不推荐**在同一 Profile 内 clone 出嵌套 repo |
| v3 推荐 | — | **新建 WorkDir Profile**，clone 到 **该 Profile 的 workDir 根**（`destRelPath: '.'` 且 workDir **空**） |
| 同一 workDir 已有文件 | — | clone 到根 **须**确认覆盖风险；或引导新建 Profile |

Phase 3 **同步** 按钮：implicit 当前 workDir 根 remote，**无** repo 选择。

#### 4.10.8 与 v2 多仓库规格的兼容说明

| 用户场景 | v2 | v3 引导 |
|---------|-----|---------|
| `workDir/` 下 `repo-a/`、`repo-b/` 两个 git | 仓库下拉切换 | **不支持** → 拆成两个 Profile，或只保留一个子项目并移除另一个 `.git` |
| `workDir/client/.git`，关注 client | 选择器聚焦 client | workDir **改为** `.../client` 本身 |
| monorepo 根目录写作 | 场景 A | **支持** — workDir = monorepo 根，init 一次管全仓 |

#### 4.10.9 实现清单（discover 伪代码 v3）

```typescript
export async function discoverWorkDirGit(workDir: string): Promise<GitDiscoverResponse> {
  if (await hasDotGit(workDir)) {
    const nested = await findNestedGitDirs(workDir, { skip: IGNORED_DIRS })
    if (nested.length > 0) {
      return { supported: false, reason: 'GIT_NESTED_REPO', nestedPaths: nested }
    }
    return { supported: true, hasRepo: true }
  }
  const nested = await findNestedGitDirs(workDir, { skip: IGNORED_DIRS })
  if (nested.length > 0) {
    return { supported: false, reason: 'GIT_NESTED_REPO', nestedPaths: nested }
  }
  const root = await git.findRoot({ fs, filepath: workDir })
  if (root && root !== workDir && !isSubpath(workDir, root)) {
    return { supported: false, reason: 'GIT_ROOT_OUTSIDE_WORKDIR', detectedRootOutside: root }
  }
  return { supported: true, hasRepo: false }
}
```

---

## 5. 方案选型对比

| 维度 | isomorphic-git（推荐） | simple-git（包装系统 git） | 继续仅用 run_shell |
|------|------------------------|----------------------------|-------------------|
| 系统依赖 | 无，随应用打包 | 要求用户安装 Git | 要求用户安装 Git |
| 结构化数据 | 原生 JS 对象 | 需解析 stdout | 需解析 stdout |
| UI 集成 | 易 | 难 | 难 |
| SSH / LFS / hooks | 弱 | 完整 | 完整 |
| 包体积 | +~1–2 MB（主进程） | 极小 | 无 |
| 安全治理 | 可逐 API 控制 | 命令字符串黑盒 | 已有 validator |
| 跨平台一致性 | 高 | 中（Git 版本差异） | 中 |

**结论**：

- **主路径**：isomorphic-git 实现结构化 Git 服务 + UI + **默认启用的 Agent `git_*` 工具**。
- **补充路径**：保留 `run_shell` 用于 isomorphic-git / `git_*` 未覆盖的能力（如 `git rebase -i`、LFS、SSH-only remote），并沿用现有 `dangerous_git` 规则。
- **可选后续**：设置项「远程同步使用系统 Git」作为高级回退，不作为首期范围。

---

## 6. 推荐架构

### 6.1 分层

```
┌─────────────────────────────────────────────────────────┐
│  Renderer                                                │
│  detail-panel-top: FileTree | GitPanel（极简，§6.5）    │
│  FileOverlay（diff）/ Agent ToolCallCard（产品词汇）       │
└───────────────────────────┬─────────────────────────────┘
                            │ window.api.git*  +  git:saveVersion（UI 编排）
┌───────────────────────────▼─────────────────────────────┐
│  preload.ts                                              │
└───────────────────────────┬─────────────────────────────┘
                            │ ipc invoke / events
┌───────────────────────────▼─────────────────────────────┐
│  electron/git/                                           │
│  gitIpc.ts          IPC 注册                             │
│  gitService.ts      业务编排（锁、确认、日志）            │
│  gitRepoDiscovery.ts  场景 A–D 发现                      │
│  gitFs.ts           Node fs → isomorphic-git fs 适配     │
│  gitCredentials.ts  safeStorage 凭据                     │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  isomorphic-git + fs + http/node                         │
└───────────────────────────┬─────────────────────────────┘
                            │
                     本地 .git 目录
```

### 6.2 设计原则

1. **Git 逻辑只在主进程**：渲染进程不引入 isomorphic-git（§2.4）。
2. **isomorphic-git 调用隔离**：仅 `electron/git/*` 直接依赖 1.x API；对外暴露 `gitService` 领域接口。
3. **双暴露面（§4.9）**：Agent 工具全面；用户 UI 仅 §6.5 写作极简；共用 `gitService`，UI 仅为编排层。
4. **仓库级互斥锁**：同一 `dir` 上 clone/pull/checkout 等互斥，避免并发写 `.git`。
5. **事件驱动刷新**：`git:state-changed` 推送至渲染进程；可与 `file:tree-changed` 联动。
6. **危险操作走确认流**：复用现有 `tool-confirm` 或专用 `git-confirm` IPC，与 `dangerous_git` 规则对齐。
7. **discover 结果缓存（v3）**：按 `(profileId)` 缓存 `GitDiscoverResponse`；workDir 切换或 `workDir/.git/HEAD` 变更时失效

### 6.3 fs 适配要点

isomorphic-git 需要特定签名的 `fs` 对象（`readFile`、`writeFile`、`mkdir`、`stat` 等）。主进程可：

- 使用官方示例的 `fs/promises` 轻量包装；或
- 引用 `isomorphic-git` 文档中的 Node 适配片段。

**注意**：Windows 路径统一 `path.resolve`，处理 `.git` 为 **文件**（linked worktree / submodule）时读取 `gitdir:` 指向。

### 6.4 UI 入口与布局（已决）

> **已决**：Git 与项目文件列表共用右侧 **`detail-panel-top`**（引用文件面板 `detail-panel-bottom` 之上），通过 **底栏水平 Tab** 在 **「工作目录」** 与 **「版本管理」** 视图间切换。不新增左侧 Activity Bar 入口。

#### 6.4.1 在 DetailPanel 中的位置

与 [detail-panel-file-list-requirement.md §3](./detail-panel-file-list-requirement.md) 现有分栏一致：

```text
┌─ 右侧 DetailPanel（无 FileOverlay 时）──────────────────┐
│ detail-panel-top  ← 本节改造范围                         │
│ ├─ 共用顶栏（WorkDirSelector + 上下文工具栏）             │
│ ├─ Tab 内容区：FileTree | GitPanel（二选一，占满剩余高度） │
│ └─ 底栏 Tab：[ 工作目录 ] [ 版本管理 ]（水平排列，§6.4.2）     │
├─ ResizeHandle                                          │
│ detail-panel-bottom — ReferencedFilesPanel（引用文件）    │
└─ FeishuRemoteStatusBar                                   │
```

- **上半区**（`detail-panel-top`）：**工作目录**（现有文件树） **或** **版本管理**（Git 面板）。
- **下半区**（`detail-panel-bottom`）：引用的文件；与 Tab 无关，始终可见（除非 `FileOverlay`）。

#### 6.4.2 底栏 Tab 文案（已决）

| 内部 key | 中文文案（zh-CN） | 对应组件 | 默认选中 |
|----------|-------------------|----------|----------|
| `workdir` | **工作目录** | 现有 `FileTree` / 文件目录区（与现网「工作目录」语义一致） | **是** |
| `version` | **版本管理** | 新增 `GitPanel` / 版本管理区 | 否 |

- i18n：`git.tabs.workDir` → `工作目录`；`git.tabs.versionManagement` → `版本管理`（en-US 建议 `Work Directory` / `Version Management`）。
- 实现时 Tab 的 `aria-label` / 可见文本均走 `t()`，禁止硬编码。
- 代码与状态命名可用 `workdir` / `version`，与 UI 文案解耦。

#### 6.4.3 结构规格

| 区域 | 规格 |
|------|------|
| **共用顶栏** | 保留现有 `detail-panel-section-header`；**始终显示** `WorkDirSelector`（Git 上下文随工作目录切换） |
| **上下文工具栏** | **工作目录** Tab → `FileTreeToolbar`；**版本管理** Tab → **无**工具栏（refresh 由 Tab 激活 / `git:state-changed` 触发）；**无** `GitRepoSelector`（§4.10） |
| **Tab 内容区** | **工作目录** → `FileTree`；**版本管理** → `GitPanel`（§6.5.11） |
| **底栏 Tab** | 位于 `detail-panel-top` 底部；两枚 Tab：**工作目录 | 版本管理**；默认 **工作目录** |
| **aria** | 外层 `role="region"`，`aria-label` 建议 **「工作目录与版本管理」**；底栏 `role="tablist"` |

#### 6.4.4 交互规则

| 规则 | 说明 |
|------|------|
| Tab 切换 | 点击底栏 Tab 切换内容区；**不**影响下半区引用文件列表 |
| 工作目录切换 | 切换 `WorkDirSelector` → 重新 `git:discover`；刷新当前 Profile 的 Git 状态 |
| 外部导航 | 打开项目文件 → **切回「工作目录」Tab** 并定位 |
| 文件预览 | `FileOverlay` 覆盖全栏；关闭后恢复 Tab |
| Git 变更项 | **版本管理** Tab：单击变更行 → diff（§6.5.9）；**新文件行** `⋯` → 不跟踪（§6.5.5） |
| 空仓库 / 非仓库 | **版本管理** Tab 空态；底栏 Tab 仍显示 |
| Tab 持久化 | 可选记住上次 Tab；默认 **工作目录** |

#### 6.4.5 组件改造方向

```text
DetailPanelWorkArea
├── detail-panel-section-header
│   ├── WorkDirSelector
│   └── activeTab === 'workdir' ? FileTreeToolbar : null
├── detail-panel-work-body
│   ├── workdir  → FileTree
│   └── version  → GitPanel（§6.5.11，绑定当前 Profile workDir）
└── detail-panel-work-tabs
    ├── Tab: t('git.tabs.workDir')
    └── Tab: t('git.tabs.versionManagement')
```

新增 `src/renderer/components/Git/GitPanel.tsx` 等子组件；**不**在左侧栏或中间聊天区增加 Git 入口。

#### 6.4.6 明确不做

| 方案 | 原因 |
|------|------|
| 左侧 Activity Bar 独立 Git Tab | 与「项目工作上下文在右侧」原则冲突 |
| Git 与文件树纵向堆叠（无 Tab） | 右侧上半区过高，与 Wiki 不迁入 detail-panel-top 的决策一致 |
| Git 放入 `detail-panel-bottom` | 与「引用文件」语义混淆 |
| 顶栏 Tab（Tab 在 WorkDirSelector 上方） | 已决为 **底栏** Tab |
| 仅展示「当前路径所属仓库」、不列出其它 repo | 与多 repo 发现策略不一致（§4.2） |

### 6.5 版本管理面板交互规格

> **已决**：版本管理 Tab **仅**实现本节写作极简 UI。Agent 全面 Git 能力见 §4.9；**不提供**暂存分组、分支条、Git 工具栏、discard/删 untracked 等 IDE 式交互。

#### 6.5.1 设计原则

| 原则 | 说明 |
|------|------|
| 写作心智 | 用户只见 **已修改 / 保存版本 / 查看改动 / 不跟踪 / 历史 / 用存档替换 / 同步**；不见 staging、HEAD、未提交、discard 等词 |
| 主路径 ≤3 步 | 存：看改动 → 保存版本（§1.4.3）；替：历史 → **替换内容**（**一次** Modal）→ 保存版本（§6.5.6） |
| Agent 补全进阶 | 分支、discard、删 untracked、hard reset / revert、clone、stash 等 **仅** Agent + `run_shell`（§1.4.2） |
| UI 写操作边界 | **保存版本** / **同步** / **不跟踪** / **替换内容**（§6.5.5–6）；**无** discard、hard reset |
| 与 fileCheckpointing 区分 | 会话「恢复编辑」vs 项目 **用历史存档替换**；UI 用 **替换**，不用「回滚/恢复」（§6.5.6.1） |
| 单一 gitService | UI 编排（`git:saveVersion`）与 Agent `git_*` 调用同一服务（§4.9.1） |

#### 6.5.2 布局与文案

```text
┌─ 顶栏：WorkDirSelector ────────────────────────────────────────────┐
├─ git-panel-body（flex 列；min-height:0）───────────────────┤
│  [ 保存版本 ]  primary；flex-shrink:0；disabled 见 §6.5.4.1      │
│  （author 无效：按钮下 Alert + 链到设置，§4.7）                     │
│  （Phase 3）[ 同步 ]  secondary；置于保存按钮下方                   │
│  ┌─ git-panel-changes-scroll（flex:1; overflow-y:auto）───────────┐ │
│  │  已修改（n）                                                    │ │
│  │    GitChangeRow × n                                             │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  （Phase 2+）GitHistorySection 可折叠「历史」                       │
└────────────────────────────────────────────────────────────────────┘

主面板 **不**展示版本说明输入框；说明在 §6.5.4.2 **保存版本** 二级界面（Modal）。
```

#### 6.5.3 面板状态机（v3，§4.10.5）

| 状态 | 条件 | 主体展示 |
|------|------|----------|
| `loading` | discover / 切换 Profile / Tab 激活 | 列表区 `Spin` |
| `nested-blocked` | `GIT_NESTED_REPO` | `git.empty.nestedRepo` + 嵌套路径；**无** init |
| `root-outside` | `GIT_ROOT_OUTSIDE_WORKDIR` | `git.empty.rootOutside` |
| `no-repo` | `hasRepo: false` | §4.10.3 **为当前文件夹启用版本管理** |
| `ready-clean` | 有 repo，无变更 | `git.empty.clean` |
| `ready-dirty` | 有 repo，有变更 | §6.5.2 完整布局 |
| `syncing` | pull/push/clone 进行中 | 禁用 **保存版本** / **同步** |
| `error` | IPC 失败 | 顶部 `Alert` + 保留上次成功数据（若有） |

切换 **版本管理 Tab** 或 **WorkDir Profile**：先展示缓存再后台 `git:status`（避免闪烁）。

#### 6.5.4 交互规格

##### 6.5.4.1 主面板：「保存版本」入口（已决）

| 元素 | 规格 |
|------|------|
| **保存版本** 按钮 | 位于 **已修改** 列表 **上方**；**不**在主面板展示版本说明输入框 |
| 点击 | 打开 **保存版本二级界面** `GitSaveVersionSheet`（§6.5.4.2）；**不**直接 commit |
| disabled 条件 | 无任意未提交变更；author 无效（`GIT_AUTHOR_NOT_CONFIGURED`）；`syncing`；二级界面已打开 |
| author 无效 | 按钮 disabled + 下方 Alert「去设置」；**不**打开二级界面 |

##### 6.5.4.2 保存版本二级界面（Modal，已决）

> **已决**：版本说明与确认保存放在 **二级界面**（Ant Design `Modal` / 同等 Portal，**非**聊天区）。契合 Agent 产品：主面板只负责「发现改动」；命名快照时再写说明。**打开 Modal 时自动 AI 预填一次**；用户可编辑或点 **生成版本说明** 重生成。

**布局**：

```text
┌─ 保存版本 ──────────────────────────────── × ┐
│  将保存 3 个文件的改动                        │
│  chapter-1.md · outline.md · notes.md       │  ← 紧凑列表，可滚动；仅 basename
│  ┌─────────────────────────────────────────┐ │
│  │ 版本说明（多行）                          │ │
│  │ 打开且无草稿 → 自动 AI 预填（§6.5.4.3）   │ │
│  │ 预填中：TextArea disabled + 占位文案      │ │
│  └─────────────────────────────────────────┘ │
│  [ 生成版本说明 ]          ← 手动重生成 §6.5.4.3 │
│  （生成中：按钮 loading；失败 Alert/toast）   │
│                    [ 取消 ]  [ 确认保存 ]    │
└──────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 标题 | `git.saveVersion.sheetTitle`（「保存版本」） |
| 变更摘要 | 未提交 path 数量 + basename 列表（来自当前 `git:status`） |
| 版本说明 | `TextArea`；placeholder `git.commit.messagePlaceholder`；**打开时自动预填**见 §6.5.4.3 |
| **打开时 AI 预填** | Modal `open` 且当前 repo **无草稿**（TextArea 空白）→ **自动**调用 §6.5.4.3；有草稿 → **不**自动覆盖 |
| **生成版本说明** | 手动重生成；调用 §6.5.4.3；结果 **覆盖** TextArea；用户可再编辑 |
| **确认保存** | `git:saveVersion`；成功 → 关闭 Modal + toast + 清空草稿 + 刷新 status |
| **取消** | 关闭 Modal；**保留**草稿（§6.5.4.4） |
| 确认 disabled | message 空白；`syncing`；commit 进行中 |
| 键盘 | Esc → 取消；Enter 不默认提交（避免误触） |

**与「二次确认」关系**：二级界面本身即 **确认步**；**确认保存** 不再弹第三层 Modal（取代原 UI-C「点提交不二次确认」——语义改为 **Sheet 内一次确认**）。

##### 6.5.4.3 AI 生成版本说明（已决）

| 项 | 规格 |
|----|------|
| **自动触发** | Modal **打开**且当前 Profile **无草稿** → 立即 `git:suggestVersionMessage()` |
| **手动触发** | 按钮 **生成版本说明** → 重生成并覆盖 TextArea |
| **有草稿时不自动** | 若 `commitMessageDraftByProfileId[profileId]` 非空 → **仅恢复草稿** |
| **输入** | `()`；主进程基于 workDir 根仓库 status + diff 摘要 |
| **模型** | 复用应用已配置的 LLM（与聊天同一 API Key / 模型配置）；**独立短 prompt**，非完整 Agent 会话 |
| **输出** | `{ message: string }` 一行或多行中文说明；风格：写作向、过去时、无 Git 术语；写入 TextArea 并同步草稿 |
| **进行中 UI** | `suggestingMessage` 状态：TextArea **disabled**；placeholder 或上方弱提示 `git.saveVersion.generating`（「正在生成版本说明…」）；**生成版本说明** 按钮 loading；**确认保存** disabled |
| **失败** | toast / Modal 内弱 Alert；TextArea 保持原内容（自动预填失败则留空，用户可手填或点按钮重试）；**不**阻塞关闭 Modal |
| **取消 / 关闭** | 用户快速关闭 Modal 时，进行中的请求 **可忽略** 结果（`aborted` / mount 守卫），避免关闭后仍写入 Redux 草稿 |
| **流式（可选）** | Phase 1 可 **非流式** 一次性填入；流式追加为增强 |
| **Agent 工具** | **不**新增 `git_*` 工具；聊天里用户仍可说「帮我写 commit message」→ Agent 用 `git_diff` + 回复文案 |

**Prompt 要点（实现参考）**：根据下列变更文件及 diff 摘要，生成一句简短的「版本说明」（commit message），中文，≤100 字，描述「做了什么」而非「改了哪些行」。

##### 6.5.4.4 版本说明草稿

| 项 | 规格 |
|----|------|
| 存储 | Redux `commitMessageDraft`（按 **workDirProfileId** 键控，v3 无 repoId） |
| 时机 | 二级界面 TextArea **onChange** 防抖写入；**取消**关闭仍保留 |
| 清空 | **确认保存**成功后清空 |
| 范围 | session 内按 repo；切换 Tab/repo 保留；关应用不持久化 |

##### 6.5.4.5 `git:saveVersion` 语义（不变）

| 项 | 规格 |
|----|------|
| 步骤 | stage 全部未提交 paths → `commit(message)` |
| IPC | `{ message }` → `{ oid }`；由二级界面 **确认保存** 调用 |
| author | `resolveCommitAuthor`（§4.7）；在打开 Sheet 前或确认前校验 |

**已修改列表（GitChangeList）**

| 项 | 规格 |
|----|------|
| 数据来源 | `git:status` → 合并 `changes` 为 flat 列表（**不**向用户区分 staged/unstaged） |
| 排序 | repo 相对路径字典序 |
| 行展示 | basename；`title`= 完整相对路径；**禁止**展示 `M`/`?` 等 Git 字母 |
| 新文件行（内部 `status === '?'`） | 行首 **空心圆点**（或「新」字徽章，二选一实现）；`aria-label` / `title`：`git.change.newFileHint`（「新文件，尚未纳入版本管理」） |
| 已修改行（已跟踪） | 可选弱化实心点；**无**「新文件」提示 |
| 单击行 | Phase 1+ → `openGitDiff` → FileOverlay unified diff（§6.5.9） |
| 行尾 **查看改动** | 与单击相同（窄栏可点区域小，保留文字链） |
| 已跟踪行（非 `?`） | **无**右键菜单；**无** discard / stage 入口 |
| **新文件行** | 行尾 **`⋯`** → 上下文菜单（§6.5.5）；**无**「删除文件」入口 |

> **同步**按钮规格见 §6.5.10；**Phase 1–2 不展示**（远端能力 Phase 3 交付）。

#### 6.5.5 新文件「不跟踪」（已决）

> **内部**：Git / `git:status` 用 **`?`** 表示 untracked；**规格与代码注释可用「? 行」**，**对用户 UI 禁止出现 `?` 字符**（见上表「新文件行」）。  
> **已决**：用户可见动词统一 **「不跟踪」**，**不用「忽略」**（易误解为临时隐藏或删除文件）。

**为何不用「忽略」**

| 用户误解 | 实际行为 | 产品用词 |
|---------|---------|---------|
| 「忽略 = 假装没看见」 | 写入 `.gitignore`，**持久**不再出现在列表 | **不跟踪** |
| 「忽略 = 删文件」 | 磁盘文件 **保留** | 确认文案强调 **不会删除文件** |
| 「? 是什么」 | Git 内部状态码 | UI 用 **新文件** + 空心圆点 |

**为何保留在 UI**

| 原因 | 说明 |
|------|------|
| 高频 | `.space-skills/`、Wiki、导出 PDF、临时稿等未纳入版本管理的文件 |
| 低认知 | 「别出现在列表里」→ **不跟踪**；不向用户解释 `.gitignore` |
| 安全 | 不删文件；可编辑 `.gitignore` 撤销规则 |
| Agent 可替代但不够快 | 菜单一步 vs 聊天描述路径 |

**入口**

| 入口 | 规格 |
|------|------|
| **主入口** | 新文件行 **`⋯`** → **不跟踪此文件** / **不跟踪此文件夹** |
| **可选增强** | 桌面 **右键** 同菜单；窄栏以 `⋯` 为主 |

**菜单结构（仅新文件行）**

```text
⋯ 菜单
├── 查看改动          git.context.viewDiff
├── 打开文件          git.context.openFile
├── ─────────
├── 不跟踪此文件 *    git.context.untrackFile   → 确认 Modal（§6.5.5.1）→ git:ignore
├── ─────────
├── 复制相对路径      git.context.copyPath
└── 在工作目录中显示   git.context.reveal
```

\* 目录时用 `git.context.untrackFolder`。

**不显示**：丢弃更改、**删除文件**、暂存/取消暂存（避免与「不跟踪」混淆）。

##### 6.5.5.1 不跟踪确认 Modal `GitUntrackConfirmSheet`

> **已决**：由「无二次确认」改为 **轻量确认 Modal**（仍属低风险 §10.2，但须消除「删文件」误解）。

```text
┌─ 不跟踪此文件？ ───────────────────────────── × ┐
│  「drafts/temp.md」将从「已修改」列表中移除。      │
│  · 文件本身 **不会删除**，仍留在工作目录中。       │
│  · 之后默认 **不再显示**在此列表（不跟踪规则）。      │
│  · 保存版本后，该规则会一并存档。                  │
│                    [ 取消 ]  [ 不跟踪 ]          │
└─────────────────────────────────────────────────┘
```

| 项 | 规格 |
|----|------|
| 主按钮 | `git.untrack.confirm`（「不跟踪」），**非**「确认删除」 |
| 目录 | 标题/摘要用 `git.context.untrackFolder`；pattern 写入 `logs/` 等形式 |
| 成功后 | 关闭 Modal；`git:ignore`；刷新 status；toast 双行（§6.5.5.2） |

##### 6.5.5.2 Toast 与 `.gitignore` 写入

**`.gitignore` 写入规格**

| 项 | 规格 |
|----|------|
| 写入目标 | 仓库根 `{repoRoot}/.gitignore`；不存在则 **创建** |
| 写入内容 | 追加一行 **repo 相对路径**（POSIX `/`）；已存在相同条目则 **跳过** |
| 目录 | 路径以 `/` 结尾或 stat 为 directory 时，写入目录 pattern（如 `logs/`） |
| 安全 | `resolveSafePath`；禁止写 workDir 外、禁止改 `.git/**` |
| 风险级别 | **低** — 须 **确认 Modal**（§6.5.5.1）；**不**删文件 |
| 成功后 | 该 path 从 **已修改** 消失 |
| toast 主文案 | `git.untrack.success`（「已从列表移除，文件未删除」） |
| toast 副文案 | `git.untrack.hintSaveVersion`（「保存版本后，不跟踪规则会一并存档」）— **默认开启** |
| `.gitignore` 自身 | 操作后 **出现在已修改**；用户 **保存版本** 时随 `saveVersion` 一并 commit |
| Agent 对齐 | 用户说「别跟踪 logs/」→ Agent 调 `git_ignore`；**回复用户**用 **「不再跟踪」**，不说「已 ignore」 |

**已跟踪行（`M`/`A`/`D`/…）**

- **不**显示「不跟踪」（对已跟踪文件无效；需 Agent / shell `git rm --cached` 等）
- **不**显示「丢弃更改」（危险操作仅 Agent，§1.4.2）

**i18n 禁止（对用户可见文案）**

| 禁止 | 改用 |
|------|------|
| `?`、`M`、`untracked` | 新文件 + 空心圆点 + `git.change.newFileHint` |
| 忽略 / Ignore | **不跟踪** |
| Add to .gitignore | （不暴露） |
| 删除 / Remove file | （不提供） |

#### 6.5.6 历史列表与「替换内容」（Phase 2，已决）

> **v2.8 简化（已决）**：取消 **版本详情 Modal**、**阻断式 dirty 流程**、**第三层丢弃 Modal**。用户从 **历史行** 直达 **一个** 确认 Modal；脏工作区用 **同屏警告 + 仍可选替换**，不再 disabled 主按钮、不再单独「丢弃未保存改动」。

##### 6.5.6.1 概念与用语（已决）

| 用户说 | UI 动作 | Git 语义 | UI |
|--------|---------|----------|-----|
| 看看以前存过哪些 | **历史** 列表 | `log` | ✅ |
| 和那次比一下 | **查看差别** → FileOverlay | diff(commit, HEAD) | ✅ |
| 用那次的内容 / 改回某一版 | **替换内容** | checkout 目标 commit → 工作区；**不移动** HEAD | ✅ |
| 撤销**上次保存版本之后**的编辑 | — | vs HEAD | ❌；Agent `git_discard` |
| 删掉之后的存档 | — | `reset --hard` | ❌ Agent only |

**对用户禁用**：回滚、恢复、未提交、未保存改动、丢弃、discard、HEAD、checkout。

**对用户统一动词**：**替换** / **替换内容**（不用「恢复到此版本」——易误解为删历史或覆盖后来存档）。

**一句解释（Modal / 帮助）**：**把当前文件改成某次「保存版本」时的内容；历史里的存档都不会删。**

**默认策略（不变）**：非破坏性 — HEAD 不动、后续 commit 保留；替换后进入 **已修改** → 用户 **保存版本** 固化。

##### 6.5.6.2 历史列表 `GitHistorySection`

```text
▼ 历史（12）
  6/27 14:32  完善了第一章结构     [ 当前 ]
              [ 查看差别 ]  [ 替换内容 ]          ← 非当前行
  6/26 09:10  补充人物小传
              [ 查看差别 ]  [ 替换内容 ]
```

| 项 | 规格 |
|----|------|
| 数据 / 排序 / 分页 | 同 v2.6（`git:log`、新→旧、加载更多） |
| 行展示 | 时间 + 版本说明；当前 HEAD 弱标签 `git.history.current` |
| **单击行** | **展开/收起** 行内详情（Accordion，**非 Modal**）：改动文件 basename 列表 |
| **查看差别** | FileOverlay：该 commit ↔ 当前 HEAD（§6.5.9） |
| **替换内容** | 打开 **唯一** 确认 Modal `GitReplaceVersionSheet`（§6.5.6.3）；当前行 **无** 此按钮 |
| **`⋯` 菜单** | 同上行两操作 + 复制版本说明（可选） |

**取消 `GitVersionSheet`**（无独立「版本详情 Modal」）。

##### 6.5.6.3 替换确认 Modal `GitReplaceVersionSheet`（唯一一层）

> **风险**：§10.2 **高** — 须确认；但 **仅一层 Modal**。

**工作区干净**（「已修改」里无 **已跟踪** 变更，或仅有新文件行）：

```text
┌─ 用「完善了第一章结构」替换当前文件？ ─────────── × ┐
│  · 将把 3 个文件改回 6/27 14:32 那次存档的内容。    │
│  · 历史里的各次存档 **都会保留**，不会消失。          │
│  · 替换后在「已修改」看一眼，再点「保存版本」。       │
│                    [ 取消 ]  [ 替换 ]              │
└────────────────────────────────────────────────────┘
```

**有「上次保存版本之后」的改动**（`已修改` 含已跟踪变更 —— **同一 Modal**，**不** disabled `[ 替换 ]`）：

```text
┌─ 用「完善了第一章结构」替换当前文件？ ─────────── × ┐
│  · 将把 3 个文件改回 6/27 14:32 那次存档的内容。    │
│  · 历史里的各次存档 **都会保留**，不会消失。          │
│  ⚠ 你还有 2 个文件在上次「保存版本」之后又改动了。   │
│     点「替换」会 **丢失** 这些改动：                │
│     chapter-1.md · outline.md                      │
│  · 若想保留这些改动，请先点「先保存当前改动」。       │
│         [ 取消 ]  [ 先保存当前改动 ]  [ 替换 ]      │
└────────────────────────────────────────────────────┘
```

| 项 | 规格 |
|----|------|
| **用语** | 全文用 **「上次保存版本之后」**，**禁止**「未提交 / 未保存改动 / 丢弃」 |
| **[ 替换 ]** | 始终可点（脏工作区亦然）；一次 `git:restoreVersion`（覆盖已跟踪 path，**无需**先调 discard） |
| **[ 先保存当前改动 ]** | 关闭本 Modal，保留 `pendingReplaceOid`；打开 `GitSaveVersionSheet`；成功后 **自动重开** 本 Modal |
| **[ 取消 ]** | 清除 `pendingReplaceOid` |
| **成功后** | 关闭 Modal；toast `git.replace.success`；刷新 status → **已修改** |
| **第三层 Modal** | **禁止**（含 discard 确认） |

##### 6.5.6.4 为何可以单层（设计说明）

| 旧方案问题 | 新方案 |
|-----------|--------|
| 详情 Modal + 恢复 Modal + 丢弃 Modal | **0** 详情 Modal + **1** 替换 Modal |
| 「未保存改动」与编辑器存盘混淆 | 对齐产品词 **「上次保存版本之后」** |
| disabled 主按钮 + 二选一处置 | 同屏说清后果；**替换** 或 **先保存当前改动** |
| 「恢复」暗示删历史 | **「替换当前文件」** + 明确 **存档都会保留** |

##### 6.5.6.5 `git:restoreVersion` / Agent `git_restore_version`

| 层 | 规格 |
|----|------|
| IPC | `git:restoreVersion` invoke `{ oid }` → `{ changedPaths }` |
| gitService | 目标 commit 与 HEAD 有差异的 **已跟踪** paths → checkout 到工作区；**不**改 HEAD；**不**删后续 commit |
| 脏工作区 | **允许**调用；checkout 直接覆盖对应 path 内容（等价于用户理解的一次「替换」） |
| Agent / ToolCallCard | 工具名 `git_restore_version` 不变；对用户展示 **「用存档替换」**（`git.toolLabels.git_restore_version`） |

##### 6.5.6.6 与 discard / 保存版本 的关系

```text
  上次保存版本之后又改了 ──► 可先 [ 先保存当前改动 ] ──► 保存版本 Modal
                           ──► 或 [ 替换 ]（丢失这些改动，历史存档仍在）

  历史某次存档 ──► [ 替换 ] ──► 文件内容 = 该次存档；已修改 vs 最新 HEAD
                           ──► 保存版本 ──► 新存档写入历史（旧存档仍在）
```

#### 6.5.7 Agent 完整能力 vs UI 暴露（对照表）

| 能力 | gitService / API | Agent 工具 | 默认 UI |
|------|------------------|-----------|---------|
| 查看变更 | `status` | `git_status` | **已修改** 列表 |
| diff | `diff` | `git_diff` | 单击 / 查看改动 |
| 保存快照 | stage + `commit` | `git_stage` + `git_commit` | **保存版本** |
| 忽略 untracked | 写 `.gitignore` | `git_ignore` | 新文件行 **⋯ → 不跟踪**（§6.5.5） |
| 丢弃 tracked 修改 | `discard` | `git_discard` | **无** |
| 删除 untracked | fs delete | （Phase 1+ 工具或 shell） | **无** |
| 分支 | `branch`/`checkout` | `git_branch` | **无** |
| 历史 | `log` | `git_log` | Phase 2 **历史**列表（§6.5.6） |
| 用存档替换 | `restoreVersion` | `git_restore_version` | 历史行 → **一个** Modal（§6.5.6.3） |
| init | `init` | （工具或 shell） | 空态按钮 |
| clone | `clone` | `git_clone` | Phase 3 设置 / onboarding |
| pull / push | `pull`/`push` | `git_pull`/`git_push` | Phase 3 **同步** |
| 文件树角标 | status 装饰 | — | Phase 2 **工作目录** Tab |
| stash / merge / rebase | 各 API | `run_shell` 回退 | **无** |

#### 6.5.8 i18n 关键 key（zh-CN 为源）

| key | zh-CN 示例 | 用途 |
|-----|-----------|------|
| `git.tabs.versionManagement` | 版本管理 | 底栏 Tab |
| `git.actions.saveVersion` | 保存版本 | 主面板按钮 |
| `git.saveVersion.sheetTitle` | 保存版本 | Modal 标题 |
| `git.actions.generateMessage` | 生成版本说明 | 二级界面手动重生成按钮 |
| `git.saveVersion.generating` | 正在生成版本说明… | Modal 打开自动预填 / 手动生成进行中 |
| `git.actions.confirmSave` | 确认保存 | Modal 主按钮 |
| `git.saveVersion.summary` | 将保存 {{count}} 个文件的改动 | 变更摘要 |
| `git.actions.sync` | 同步 | Phase 3 按钮 |
| `git.actions.viewDiff` | 查看改动 | 已修改行 |
| `git.actions.viewDiffHistory` | 查看差别 | 历史行（相对当前） |
| `git.actions.replaceContent` | 替换内容 | 历史行 |
| `git.sections.modified` | 已修改 | 列表组标题 |
| `git.sections.history` | 历史 | Phase 2 折叠区 |
| `git.history.empty` | 还没有保存过版本 | 历史空态 |
| `git.history.current` | 当前 | 当前 HEAD 对应行 |
| `git.history.loadMore` | 加载更多 | 历史分页 |
| `git.replace.sheetTitle` | 用「{{message}}」替换当前文件？ | 确认 Modal 标题 |
| `git.replace.summary` | 将把 {{count}} 个文件改回 {{date}} 那次存档的内容 | Modal 要点 |
| `git.replace.historyKept` | 历史里的各次存档都会保留，不会消失 | Modal 要点 |
| `git.replace.hintSaveAfter` | 替换后在「已修改」看一眼，再点「保存版本」 | Modal 要点 |
| `git.replace.dirtyWarning` | 你还有 {{count}} 个文件在上次「保存版本」之后又改动了。点「替换」会丢失这些改动 | 脏工作区警告 |
| `git.replace.saveFirst` | 先保存当前改动 | 脏工作区次按钮 |
| `git.replace.confirm` | 替换 | 确认 Modal 主按钮 |
| `git.replace.success` | 已替换为所选存档的内容 | toast |
| `git.history.expandFiles` | 本版本改动了 {{count}} 个文件 | 行内 Accordion |
| `git.empty.clean` | 没有待保存的修改 | 干净工作区 |
| `git.empty.noRepo` | （v3 由 §4.10.3 取代）为当前文件夹启用版本管理 | 空态主文案 |
| `git.empty.nestedRepo` | 此工作目录下已有其他代码库（如 {{paths}}）。请换一个工作目录，或移除嵌套代码库后再启用 | `GIT_NESTED_REPO` |
| `git.empty.rootOutside` | 请把工作目录设成你要管理的文件夹本身 | `GIT_ROOT_OUTSIDE_WORKDIR` |
| `git.actions.enableVersionControl` | 为当前文件夹启用版本管理 | init 按钮 |
| `git.commit.messagePlaceholder` | 描述本次修改… | 版本说明 |
| `git.saveVersion.success` | 已保存版本 | toast |
| `git.change.newFileHint` | 新文件，尚未纳入版本管理 | 新文件行圆点 `title` / `aria-label` |
| `git.context.untrackFile` | 不跟踪此文件 | 新文件行菜单 |
| `git.context.untrackFolder` | 不跟踪此文件夹 | 新文件目录菜单 |
| `git.untrack.sheetTitle` | 不跟踪此文件？ | 确认 Modal 标题（文件） |
| `git.untrack.sheetTitleFolder` | 不跟踪此文件夹？ | 确认 Modal 标题（目录） |
| `git.untrack.summary` | 「{{name}}」将从「已修改」列表中移除 | 确认 Modal 摘要 |
| `git.untrack.notDeleted` | 文件本身不会删除，仍留在工作目录中 | 确认 Modal 要点 |
| `git.untrack.persistent` | 之后默认不再显示在此列表 | 确认 Modal 要点 |
| `git.untrack.confirm` | 不跟踪 | 确认 Modal 主按钮 |
| `git.untrack.success` | 已从列表移除，文件未删除 | toast |
| `git.untrack.hintSaveVersion` | 保存版本后，不跟踪规则会一并存档 | toast 副文案 |
| `git.toolLabels.git_commit` | 保存版本 | ToolCallCard |
| `git.toolLabels.git_ignore` | 不再跟踪 | ToolCallCard |
| `git.toolLabels.git_restore_version` | 用存档替换 | ToolCallCard |

#### 6.5.9 与 FileOverlay / Diff

| 阶段 | 单击变更行 / 查看改动 |
|------|----------------------|
| Phase 0 | 不响应或 toast「尚未开放」 |
| Phase 1+ | FileOverlay **diff**（unified patch） |
| 历史 **查看改动** | diff **目标 commit ↔ 当前 HEAD**（恢复预览）；IPC `git:diffCommit` 或 `git:diff` 扩展 `{ ref }` |

- UI 调用 `git:diff({ relPath })` — 工作区相对 HEAD 的统一 diff（v3 无 `repoId`）。
- Overlay 标题：`git.diff.title`（如 `{basename} — 改动`）。
- 新文件行菜单「查看改动」：untracked 视为相对空树的新增。
- Agent `git_diff` 与 UI 共用 `gitService.diff`。

**Phase 3 可选**：并排 diff、语法高亮增强。

#### 6.5.10 同步与远端（Phase 3）

| 项 | 规格 |
|----|------|
| 入口 | **同步** 按钮（§6.5.4.1）；**无** pull/push 工具栏 |
| 确认 | Modal；有未保存修改时警告先 **保存版本** |
| 进度 | 按钮 loading 或面板内简短文案 |
| 冲突 | Alert + 建议 Agent / shell 解决 |
| clone | **设置页**或空态 onboarding 弹窗（§4.8）；**Phase 3** 交付 |

#### 6.5.11 组件拆分

```text
GitPanel
├── GitSaveVersionButton（主面板，§6.5.4.1）
├── GitSyncButton（Phase 3）
├── git-panel-changes-scroll
│   └── GitChangeList / GitChangeRow …
├── GitHistorySection（Phase 2，§6.5.6）
│   └── GitHistoryRow（行内 Accordion）
└── （无 GitRepoSelector，§4.10）

GitSaveVersionSheet（Modal Portal，§6.5.4.2）
GitReplaceVersionSheet（Modal，§6.5.6.3，**唯一**一层）
GitUntrackConfirmSheet（Modal，§6.5.5.1）
GitUntrackedContextMenu
```

Redux `gitSlice`（v3）：`hasRepo`、`status`、`log`、`pendingReplaceOid`、`commitMessageDraftByProfileId`、…

#### 6.5.12 与 Agent / 分期的关系

| Phase | UI | Agent 工具 |
|-------|-----|-----------|
| 0 | 只读 **已修改** | `git_status` |
| 1 | + **保存版本** + diff + **不跟踪** + 空态 init | + `git_diff`, `git_stage`, `git_commit`, `git_ignore`, `git_discard`, `git_branch`… |
| 2 | + **历史** + **替换内容** + **工作目录**文件树改动标记 | + `git_log`, `git_restore_version` |
| 3 | + **同步**；clone / 凭据（设置页） | + `git_pull`, `git_push`, `git_clone` |

> **分期原则（已决）**：**Phase 1–2 先把本地版本闭环做完整**（存版本、看 diff、看历史、树上看见改动）；**Phase 3 再接远端**（同步、clone、凭据）。Agent 远端工具与 UI **同步** 均在 Phase 3 注册，避免半成品 remote 能力干扰本地写作流。

#### 6.5.12 无障碍

- **已修改** 列表 `role="list"`；新文件行 `⋯` 的 `aria-label` 含文件名与 `git.change.newFileHint`。
- **保存版本** / **同步** 在 `syncing` 时 `aria-busy`。
- 所有可见文案走 `git.*`；不对用户展示 Git 状态字母。

---


## 7. 功能范围与分期

> **分期原则（已决）**：**Phase 1–2 = 本地版本闭环**（发现 → 已修改 → diff → 保存版本 → 历史 → 文件树标记）；**Phase 3 = 远端**（同步、clone、凭据、Agent `git_pull`/`git_push`/`git_clone`）。不在 Phase 2 交付半成品 remote UI。

### 7.1 Phase 0 — 只读发现（MVP 基础）

| 功能 | API | Agent | UI（§6.5） |
|------|-----|-------|-------------------|
| 仓库发现 | v3 `discoverWorkDirGit` | — | 状态机 §6.5.3 / §4.10.5 |
| 当前分支 / 变更 | `currentBranch`, `statusMatrix` | `git_status` | 只读「已修改」列表 |
| 工作目录切换联动 | discover on switch | — | 自动刷新 |
| UI 壳层 | — | — | 底栏 Tab：**工作目录 \| 版本管理**（§6.4.2） |

**交付物**：`electron/git/*` 骨架 + `git:discover` / `git:status` IPC + `DetailPanelWorkArea` 底栏 Tab + `GitPanel` Phase 0 只读。

### 7.2 Phase 1 — 本地写操作

| 功能 | API | Agent | UI |
|------|-----|-------|---------|
| 暂存 / 取消暂存 | `add`, `remove` | `git_stage` | **不暴露**；「保存版本」内 stage all |
| 提交 | `commit`（§4.7 author） | `git_commit` | **保存版本** + `git:saveVersion`（可选 IPC） |
| 查看 diff | status + blob/walk | `git_diff` | 单击 / 查看改动 → FileOverlay |
| 写 `.gitignore` / 不跟踪 | 编辑 `.gitignore` | `git_ignore` | **新文件行 `⋯` → 不跟踪**（§6.5.5） |
| 丢弃 / 删 untracked | checkout / fs | `git_discard` 等 | **仅 Agent** |
| 分支 / init | `listBranches`, `checkout`, `init` | `git_branch`, … | **仅 Agent** / 空态 init |

**Agent 工具**：§4.9.4 description 模板；默认启用（§4.6）。

### 7.3 Phase 2 — 本地体验完整

| 功能 | API | Agent | UI |
|------|-----|-------|---------|
| 提交历史 | `log` | `git_log` | 版本管理 Tab **历史**列表（§6.5.6） |
| 恢复 / 替换 | `restoreVersion` | `git_restore_version` | 历史 → **一个** Modal（§6.5.6.3） |
| 文件树状态 | `statusMatrix` 装饰 | — | **工作目录** Tab 内改动角标/色点 |
| diff 增强（可选） | — | — | FileOverlay 并排/高亮（可部分后置 Phase 3） |

**交付物**：本地写作闭环——用户可 **存版本、看 diff、翻历史、用存档替换、在文件树上看见哪些文件有改动**，无需 remote。

### 7.4 Phase 3 — 远端同步

| 功能 | API | Agent | UI |
|------|-----|-------|---------|
| clone | `clone` + 弹窗（§4.8） | `git_clone` | 设置 / onboarding |
| fetch / pull / push | `fetch`, `pull`, `push` | `git_pull`, `git_push` | **同步**单按钮（pull→push） |
| 凭据 | `onAuth` + safeStorage | 同 UI | 设置页 |
| 设置页 Git 区块 | — | — | 身份、凭据、Agent 开关（**无**扫描深度） |

### 7.5 Phase 4 — 进阶（可选）

- merge / stash / cherry-pick
- 子模块识别与分仓库操作
- 系统 Git 回退模式
- status 性能优化（Watch `.git/index` + debounce）

---

## 8. 数据模型与 IPC 设计

### 8.1 共享类型（v3，§4.10）

> v2 的 `GitRepoBinding` / `repoId` **废弃**。

```typescript
export type GitFileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

export interface GitFileChange {
  relPath: string          // 相对 workDir
  status: GitFileStatusCode
  staged: boolean
}

export interface GitWorkDirStatus {
  branch: string | null
  detached: boolean
  clean: boolean
  ahead: number
  behind: number
  changes: GitFileChange[]
  error?: string
}

export type GitDiscoverResponse =
  | { supported: true; hasRepo: boolean }
  | {
      supported: false
      reason: 'GIT_NESTED_REPO' | 'GIT_ROOT_OUTSIDE_WORKDIR'
      nestedPaths?: string[]
      detectedRootOutside?: string
    }

export interface GitCommitRequest {
  message: string
  amend?: boolean
  scopePaths?: string[]
}

export interface GitRemoteAuthProfile {
  id: string
  host: string
  username?: string
  tokenEnc?: string
  updatedAt: number
}
```

### 8.2 IPC 通道（v3）

| 通道 | 方向 | 说明 |
|------|------|------|
| `git:discover` | invoke | `()` → `GitDiscoverResponse`（§4.10.2） |
| `git:init` | invoke | `()` → workDir 根 init（§4.10.3） |
| `git:status` | invoke | `()` → `GitWorkDirStatus` |
| `git:diff` | invoke | `{ relPath, staged? }` → `{ patch }` |
| `git:log` | invoke | `{ depth?, ref? }` → commits[] |
| `git:restoreVersion` | invoke | `{ oid }` → `{ changedPaths }`（§6.5.6.5） |
| `git:diffCommit` | invoke | `{ oid, relPath? }` → `{ patch }` |
| `git:stage` | invoke | `{ paths, stage: boolean }`（Agent） |
| `git:discard` | invoke | `{ paths }`（Agent） |
| `git:deleteUntracked` | invoke | `{ paths }`（Agent） |
| `git:ignore` | invoke | `{ paths }`（§6.5.5） |
| `git:commit` | invoke | `GitCommitRequest` → `{ oid }` |
| `git:saveVersion` | invoke | `{ message }` → stage all + commit |
| `git:suggestVersionMessage` | invoke | `()` → `{ message }` |
| `git:branch` | invoke | `{ ... }`（Agent） |
| `git:fetch` / `git:pull` / `git:push` | invoke | `{ ... }`（Phase 3） |
| `git:clone` | invoke | `{ url, destWorkDirProfileId? }` 或新建 Profile 流（§4.10.7） |
| `git:state-changed` | event | 主进程 → 渲染 |

`src/shared/api.ts` 与 `electron/preload.ts` 同步扩展 `window.api.git*`。

### 8.3 配置扩展（`AppConfig`）

```typescript
interface GitConfig {
  enabled: boolean
  agentToolsEnabled: boolean  // default: true
  userName?: string
  userEmail?: string
}

/** WorkDirProfile 扩展（优先级 2，§4.7） */
interface WorkDirProfileGitOverride {
  gitUserName?: string
  gitUserEmail?: string
}
```

- `GitConfig` 存应用级字段；**v3 无** `activeRepoId` / 扫描深度；草稿按 **workDirProfileId** 分 Profile（§6.5.4.4）。
- Profile 级 `gitUserName` / `gitUserEmail` 写在 `WorkDirProfile` 或 `config.workDirProfileGitOverrides[profileId]`（实现时二选一，文档以 Profile 字段为准）。

---

## 9. 模块改造清单

### 9.1 主进程（新增 / 修改）

| 文件 | 工作 |
|------|------|
| `electron/git/gitFs.ts` | **新增** Node fs 适配 |
| `electron/git/gitRepoDiscovery.ts` | **新增** v3 `discoverWorkDirGit`（§4.10.9）；**无**多 repo 扫描 |
| `electron/git/gitAuthor.ts` | **新增** `resolveCommitAuthor`（§4.7 优先级链） |
| `electron/git/gitSuggestMessage.ts` | **新增** `git:suggestVersionMessage`：status + diff 摘要 → LLM（§6.5.4.3） |
| `electron/git/gitService.ts` | **新增** 封装 isomorphic-git；`saveVersion`、`suggestMessage`、`log`、`restoreVersion` 编排 |
| `electron/git/gitCredentials.ts` | **新增** 凭据 CRUD + onAuth |
| `electron/git/gitIpc.ts` | **新增** 注册 IPC |
| `electron/git/gitService.test.ts` | **新增** 临时目录集成测试 |
| `electron/appIpc.ts` | **修改** 引入 `registerGitIpc` |
| `electron/main.ts` | **修改** workDir 切换时 invalidate git cache |
| `electron/database.ts` | **修改** 存储 `gitConfig`、加密 token |
| `package.json` | **修改** 添加 `isomorphic-git@^1.38`（主进程依赖，§2.4） |

### 9.2 预加载与共享类型

| 文件 | 工作 |
|------|------|
| `electron/preload.ts` | 暴露 git API |
| `src/shared/api.ts` | TypeScript 类型 |
| `src/shared/domainTypes.ts` | Git 领域类型、`GitConfig` |
| `src/shared/feishuTypes.ts` / `WorkDirProfile` | **修改** 可选 `gitUserName` / `gitUserEmail`（§4.7） |
| `src/shared/errorCodes.ts` | `GIT_NESTED_REPO`、`GIT_ROOT_OUTSIDE_WORKDIR`、`GIT_AUTHOR_NOT_CONFIGURED`、… |

### 9.3 渲染进程 UI

| 文件 | 工作 |
|------|------|
| `src/renderer/components/Git/` | **新增** `GitPanel` 等（§6.5.11） |
| `src/renderer/components/Git/GitUntrackedContextMenu.tsx` | **新增** 新文件行 ⋯ 菜单（§6.5.5） |
| `src/renderer/components/Git/GitUntrackConfirmSheet.tsx` | **新增** 不跟踪确认 Modal（§6.5.5.1） |
| `src/renderer/components/Git/GitHistorySection.tsx` | **新增** 历史列表（§6.5.6.2） |
| `src/renderer/components/Git/GitReplaceVersionSheet.tsx` | **新增** 替换确认 Modal（§6.5.6.3，**唯一**一层） |
| `src/renderer/components/FileOverlay/` 或 `FileContentView` | **修改**（Phase 1）**diff 模式**：`openGitDiff` + `git:diff`；（Phase 2）`git:diffCommit`（§6.5.9） |
| `src/renderer/components/Git/GitSaveVersionSheet.tsx` | **新增** 保存版本 Modal（§6.5.4.2）；`open` 且无草稿时 `useEffect` 自动 `git:suggestVersionMessage` |
| `src/renderer/components/Git/GitSaveVersionButton.tsx` | **新增** 主面板入口（§6.5.4.1） |
| `src/renderer/components/Git/gitPanel.css` | 主面板：**保存版本** 按钮 + **已修改** 列表 + **历史** |
| `src/renderer/components/DetailPanel/DetailPanelFileList.tsx` | **重构** 为 `DetailPanelWorkArea`（或等价）：共用顶栏 + 底栏 Tab + 文件/Git 内容区（§6.4） |
| `src/renderer/components/DetailPanel/index.tsx` | **修改** `aria-label`、挂载重构后的工作区组件 |
| `src/renderer/components/DetailPanel/detailPanel.css` | **修改** 底栏 Tab、工作区 flex 布局 |
| `src/renderer/components/FileTree/` | **修改**（Phase 2）**工作目录** Tab 内 Git 改动装饰 |
| `src/renderer/services/filePaneNavigation.ts` | **修改** 打开项目文件时切回 **工作目录** Tab |
| `src/renderer/store/gitSlice.ts` | **新增** `hasRepo`、`status`、`log`、`discover`（v3 无 `repos[]` / `activeRepoId`） |
| `src/renderer/i18n/resources/*/git.json` | **新增** §6.5.8 全部 key（含 `git.untrack.*`、`git.change.newFileHint`、`git.toolLabels.*`） |
| `src/renderer/styles.css` | 与 `detailPanel.css` 协调的 Git 面板样式 |

### 9.4 Agent 工具

| 文件 | 工作 |
|------|------|
| `electron/tools/gitExecutors.ts`（或 `builtinExecutors` 分文件） | **新增** `git_*`；description 采用 §4.9.4 模板 |
| `electron/tools/types.ts` / 工具注册 | **修改** discover 有 repo 且 `agentToolsEnabled` 时注入；系统提示含 §4.9.2–4.9.3 |
| 工具 schema / description | **修改** 写明优先于 `run_shell git …`（§4.6） |
| `src/renderer/components/Chat/ToolCallCard.tsx` | Git 工具友好标签（§4.9.6，`git.toolLabels.*`） |
| 设置页 / `WorkDirList` | Git：身份、凭据、Agent 开关（**无**扫描深度，§4.10） |

### 9.5 安全与策略

| 文件 | 工作 |
|------|------|
| `electron/shell/shellSecurity.ts` | 保持 `dangerous_git`；**不**拦截普通 `git status`（与 §4.6 回退路径兼容） |
| `electron/pathSecurity.ts` | **无需改动**（C-strict 不扩展沙箱）；discover 时校验 `.git` 在 workDir 内 |
| 确认流 | push/pull、discard、delete untracked 等接入确认；**保存版本** 不二次确认（§15 UI-C）；`commit --amend`（Phase 3）可单独评估 |

### 9.6 文档与 i18n 脚本

- 运行 `npm run i18n:generate-types` / `i18n:check`
- 可选：`docs/develop/isomorphic-git-technical-design.md`（Phase 0 完成后）

---

## 10. 安全与权限

### 10.1 路径与 `.git` 保护

| 规则 | 说明 |
|------|------|
| 禁止 `read_file` / `edit_file` 直接读写 `.git/**` | 保持现有 GREP/搜索跳过；可显式加 write 拒绝 |
| clone/init 目标必须在 workDir 内 | `resolveSafePath(workDir, destRelPath)` |
| 场景 C 父级 `.git` | **不访问**；返回 `GIT_ROOT_OUTSIDE_WORKDIR`，提示用户调整 workDir |

### 10.2 操作风险分级

| 级别 | 操作 | 策略 |
|------|------|------|
| 低 | status, diff, log, branch -a | 直接执行 |
| 中 | add, commit, checkout branch | commit 需 §4.7 有效 author；Agent checkout 在 dirty tree 时 **拒绝** |
| 低（须确认 Modal） | **`git:ignore` / 不跟踪** | 追加 `.gitignore`；**须**确认 Modal（§6.5.5.1）；**不**删文件 |
| 高 | push, pull, merge, reset, clean, **git:discard**, **git:deleteUntracked**, **`git:restoreVersion`（UI：替换）** | 须 **单层** 确认 Modal（§6.5.6.3）；不另开 discard Modal |
| 禁止 | push --force | 默认拒绝（与 `dangerous_git` 一致） |

### 10.3 凭据

- 使用 `electron/secureApiKey.ts` 同款 `safeStorage` 加密 token/password
- 按 host 存储，**不**写入 workDir 内文件
- 日志经 `sanitizeForLog` 脱敏，不记录 token 与完整 remote URL 凭据

### 10.4 飞书远程与多工作目录

- 远程指令若触发 Git 写操作，尊重 Profile `sensitive` 标记
- 与 [feishu-integration-requirement.md](./feishu-integration-requirement.md) 中工作目录路由一致：Git 上下文随解析到的 workDir 切换

---

## 11. 与现有能力的关系

| 现有能力 | 关系 |
|----------|------|
| **fileCheckpointing** | 互补：会话级快照 vs 项目级 Git 版本（§6.5.1）；UI 文案区分「恢复编辑」与「历史版本」；Agent 说明见 §4.9.3 |
| **run_shell + git** | **`git_*` 为 Agent 默认路径**（**全面**）；shell 用于 rebase/stash/LFS 等回退（§4.6）；UI 不 mirror shell 能力 |
| **Agent 自然语言** | 用户说「保存版本/不跟踪/同步」等；映射 §4.9；ToolCallCard 用 `git.toolLabels.*` 与极简 UI 一致 |
| **file:tree-changed** | Agent 改文件后 Git 状态应更新；可在文件 watcher 后 debounce 触发 `git:state-changed` |
| **多 workDir** | 每 Profile 独立 discover 与凭据 scope |
| **detail-panel-top** | Git 与文件树底栏 Tab 共存；**默认** `GitPanel`（§6.5.11） |
| **filePaneNavigation** | 打开项目文件时自动切至 **工作目录** Tab |
| **项目记忆 SPACEASSISTANT.md** | 可随 **保存版本** 一并 commit；无直接冲突 |
| **Wiki `llm-wiki/`** | 建议 **新文件 → 不跟踪**（§6.5.5）或 Agent `git_ignore`；避免长期占据已修改列表 |
| **搜索** | 继续跳过 `.git`；**已修改** 列表为变更文件主入口 |

---

## 12. 非功能需求与风险

### 12.1 性能

- 目标：中型仓库（~5k 文件）status 响应 < 3s（首次）；缓存后 < 500ms
- 大仓库可提供「仅扫描 focus 子树」选项（场景 D）；场景 C 不支持，需用户调整 workDir

### 12.2 可靠性

- 与外部 Git CLI / IDE 并行操作同一仓库：遵循 Git 文件锁；冲突时 surfacing 错误信息
- 操作中断：isomorphic-git 写入 `.git` 与 canonical git 兼容，一般可 repair

### 12.3 测试

- 主进程 `node` 环境 Vitest + 临时仓库 fixture
- 覆盖：init → add → commit → log；clone（mock http）；discover 场景 A/B
- 渲染进程：GitPanel 组件测试（mock api）

### 12.4 主要风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| SSH-only 团队无法 push | 中 | 高 | 文档 + HTTPS 迁移指引 + shell 回退 |
| 用户 workDir 指向 monorepo 子包 | 中 | 中 | C-strict 提示调整 workDir；文档说明场景 D |
| 大 monorepo 性能 | 中 | 中 | scoped status、异步刷新 |
| 与 shell git 行为不一致 | 低 | 中 | 测试矩阵、用户可见差异说明 |

---

## 13. 工作量估算

粗粒度 **人日**（1 人全职，含测试与 i18n）：

| 阶段 | 内容 | 估算 |
|------|------|------|
| Phase 0 | … + 底栏 Tab（工作目录 \| 版本管理）+ 版本管理占位 | 4–6 天 |
| Phase 1 | stage/commit/diff/ignore + Agent 本地工具 | 5–7 天 |
| Phase 2 | **历史** + **替换内容** + 文件树标记 + 本地闭环打磨 | 4–6 天 |
| Phase 3 | clone / **同步** / 凭据 + Agent 远端工具 | 5–8 天 |
| **合计（至可用产品）** | Phase 0–3 | **17–26 天**（v3 单仓库较 v2 略减） |

不含 Phase 4 进阶与系统 Git 回退模式。

---

## 14. 已决问题汇总

> 本节原「待决问题」已全部闭合；实现以 §4–§6、§8.3 为准。

1. ~~**场景 C 策略**~~：**已决** — C-strict（§4.3）
2. ~~**UI 入口**~~：**已决** — 右侧 `detail-panel-top` 底栏 Tab（§6.4）
3. ~~**多仓库（场景 B）**~~：**v3 取消** — 单仓库 §4.10；§4.2–4.4 **存档**
4. ~~**Agent 默认**~~：**已决** — 方案 A，默认启用 `git_*` 工具（§4.6）；设置可关
5. ~~**提交身份**~~：**已决** — 仓库 git config → Profile → 全局 → 否则阻止提交（§4.7）
6. ~~**clone 默认位置**~~：**v3 调整** — 推荐 **新建 Profile** clone 到 workDir 根（§4.10.7）；§4.8 子目录 clone **存档**
7. ~~**isomorphic-git 版本**~~：**已决** — 锁定 **1.x**，不等待 2.0；`gitService` 封装便于日后迁移（§2.4）
8. ~~**底栏 Tab 文案**~~：**已决** — **工作目录** \| **版本管理**（§6.4.2）；默认选中工作目录
9. ~~**扫描深度**~~：**v3 删除** — 无 `repositoryScanMaxDepth`（§4.10）
10. ~~**双暴露面**~~：**已决** — Agent 工具全面；用户 UI 极简（§4.9.1、§6.5）；共用 `gitService`
11. ~~**用户用语映射**~~：**已决** — tool description + 系统提示（§4.9）；**不**默认独立翻译 Skill
12. ~~**新文件不跟踪**~~：**已决** — UI **不跟踪** + 确认 Modal（§6.5.5）；**禁止** `?`/`忽略` 对用户文案；与 Agent `git_ignore` 共用服务
13. ~~**产品策略**~~：**已决** — §1.4 双暴露面；UI **仅** §6.5 写作极简，**不做** IDE 式 SCM
14. ~~**分期顺序**~~：**已决** — Phase 2 本地完整；Phase 3 远端（§7）
15. ~~**版本说明位置**~~：**已决** — **不在**主面板；**保存版本** → 二级 Modal；**打开时自动 AI 预填** + 手动 **生成版本说明**（§6.5.4.2–4.3）
16. ~~**回滚 / 替换历史内容**~~：**已决** — **替换内容** + **单层** Modal（§6.5.6）；取消详情/丢弃第三层；脏工作区用 **「上次保存版本之后」** 文案
17. ~~**「? / 忽略」用语**~~：**已决** — 用户见 **新文件 + 不跟踪**（§6.5.5）
18. ~~**三层 Modal**~~：**已决取消** — v2.8 起历史 **行内展开** + **GitReplaceVersionSheet** 一层（§6.5.6.4）
19. ~~**单仓库模型**~~：**v3 已决** — workDir 根唯一 `.git`；嵌套阻断；**无** `GitRepoSelector` / `repoId`（§4.10）

---

## 15. 版本管理 UI 已决项

> 策略类问题见 §14。原 IDE/SCM 向 UI 讨论项（暂存分组、分支条、GitToolbar 等）**已取消**——产品不做复杂版本管理界面。

| ID | 结论 |
|----|------|
| UI-A | **布局** — 主面板：**保存版本** 按钮 + **已修改** 列表 +（Phase 2）**历史**；**无**主面板说明框（§6.5.2） |
| UI-B | **diff** — 单击变更行 / 「查看改动」→ FileOverlay（§6.5.9） |
| UI-C | **保存版本** — 点主按钮 → **二级 Modal** 写说明 → **确认保存**；Sheet 即确认步（§6.5.4.2） |
| UI-C2 | **AI 版本说明** — Modal **打开**且无草稿 → **自动** `git:suggestVersionMessage`；按钮 **生成版本说明** 供重生成（§6.5.4.3） |
| UI-D | **不跟踪** — 新文件行 `⋯` → 确认 Modal → **不跟踪**；**无**删除文件 / discard（§6.5.5） |
| UI-E | **历史** — 可折叠列表 + **行内展开**（§6.5.6.2）；**无**详情 Modal |
| UI-F | **替换内容** — 历史行 → **一个** Modal（§6.5.6.3） |
| UI-G | **说明草稿** — 按 **Profile** 记忆（§6.5.4.4） |
| UI-H | **同步** — Phase 3；Phase 1–2 无（§6.5.10） |
| UI-I | **文件树标记** — Phase 2 **工作目录** Tab（§7.3） |
| UI-J | **单仓库** — **无** `GitRepoSelector`；init 在 workDir 根；嵌套 `.git` 阻断（§4.10） |

---

## 16. 参考资料

- [isomorphic-git 官网](https://isomorphic-git.org/)
- [isomorphic-git GitHub](https://github.com/isomorphic-git/isomorphic-git)
- [fs 适配说明](https://isomorphic-git.org/docs/en/fs)
- [http 客户端说明](https://isomorphic-git.org/docs/en/http)
- [onAuth 认证](https://isomorphic-git.org/docs/en/onAuth)
- 项目内：`electron/pathSecurity.ts`、`electron/workDirManager.ts`、`electron/shell/shellSecurity.ts`
- [VS Code：Discover nested Git repositories (1.72)](https://code.visualstudio.com/updates/v1_72#_discover-nested-git-repositories)
- 项目内：[detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md)、[multi-workdir-requirement.md](./multi-workdir-requirement.md)、[tools-requirement.md](./tools-requirement.md)

---

## 附录 A：Phase 0 最小实现伪代码

```typescript
// electron/git/gitService.ts（v3 示意）
import git from 'isomorphic-git'
import { discoverWorkDirGit } from './gitRepoDiscovery'

export async function getStatus(workDir: string): Promise<GitWorkDirStatus> {
  const d = await discoverWorkDirGit(workDir)
  if (!d.supported || !d.hasRepo) throw new Error('NO_REPO')
  const matrix = await git.statusMatrix({ fs: gitFs, dir: workDir })
  // ... map → GitFileChange[]（relPath 相对 workDir）
}
```

```typescript
// electron/git/gitRepoDiscovery.ts（v3，§4.10.9）
export async function discoverWorkDirGit(workDir: string): Promise<GitDiscoverResponse> {
  // 见 §4.10.9 伪代码
}
```

---

## 附录 B：建议的 Agent 工具签名（Phase 1）

> **description 正文**须采用 §4.9.4 模板（含 UI 同义词与歧义说明），下表仅列签名。

| 工具 | 参数 | 说明 |
|------|------|------|
| `git_status` | `{}` | 当前 workDir 根仓库变更 |
| `git_diff` | `{ path, staged? }` | unified diff |
| `git_stage` | `{ paths, unstage? }` | 暂存/取消 |
| `git_commit` | `{ message, paths? }` | 提交 |

以上工具在 discover `hasRepo: true` 且 Git 未禁用时注册（**v3 无 `repo_rel_path`**）。

Phase 1 另见 §4.9.4：`git_ignore`、`git_discard`、`git_branch` 等 description 模板。

## 附录 B2：Agent 工具签名（Phase 2 本地）

| 工具 | 参数 | 说明 |
|------|------|------|
| `git_log` | `{ depth?, ref? }` | 提交历史 |
| `git_restore_version` | `{ oid }` | 用存档替换工作区内容（§6.5.6.5） |

## 附录 C：Agent 工具签名（Phase 3 远程）

> Phase 3 与 UI **同步**、clone、凭据一并交付；Phase 1–2 Agent **不**注册下列工具（本地工具见附录 B）。

| 工具 | 参数 | 说明 |
|------|------|------|
| `git_clone` | `{ url, dest_rel_path }` | **`dest_rel_path` 必填**（§4.8）；与 UI 弹窗同一校验；需确认 |

---

## 附录 D：双暴露面速查（实现 checklist）

| 检查项 | 规格 |
|--------|------|
| **单仓库** | workDir 根 `.git`；嵌套 `.git` → `GIT_NESTED_REPO`（§4.10） |
| 单一 `gitService` | UI / Agent / IPC 均经 `electron/git/gitService.ts` |
| 唯一 UI | `GitPanel`；**无** `GitRepoSelector` |
| 用户主按钮 | 主面板 **保存版本** → Modal **确认保存** |
| AI 说明 | Modal 打开 **自动预填** + **生成版本说明** 重生成 → `git:suggestVersionMessage`（§6.5.4.3） |
| 历史 / 替换 | **历史**行 → **替换内容**（单层 Modal）→ `git:restoreVersion`（§6.5.6） |
| 用户列表 | 单一 **已修改**；不展示 staged/unstaged 分组 |
| 新文件不跟踪 | `GitUntrackedContextMenu` + `GitUntrackConfirmSheet`（§6.5.5） |
| Phase 2 本地 | **历史** + **替换内容** + **工作目录**文件树标记；**无**同步按钮 |
| Phase 3 远端 | **同步**（pull→push）、clone、凭据；Agent 远端工具 |
| Agent 工具 | Phase 1 本地；Phase 2 +`git_log`/`git_restore_version`；Phase 3 +`git_pull`/`git_push`/`git_clone` |
| 用户/chat 词汇一致 | i18n §6.5.8 + ToolCallCard `git.toolLabels.*` |
| 系统提示 | §4.9.2 术语表 + §4.9.3 歧义规则 |
| UI 不提供 | 分支切换、stage、discard、hard reset、revert、删 untracked、Git 工具栏、暂存分组 |

---
