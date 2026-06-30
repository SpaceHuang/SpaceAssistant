# V1 — 工作区管理（M1）

> **版本**：V1.6（细化版）  
> **发布**：M1 **一次性可发布单元**  
> **状态**：需求细化（可进入技术设计）  
> **依赖**：现有 multi-workdir 实现（[multi-workdir-requirement.md](../multi-workdir-requirement.md)）  
> **后续**：[v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md)（M2，独立）  
> **现状**：[multi-workdir-file-management-as-is.md](../../analysis/multi-workdir-file-management-as-is.md)  
> **附录**：[v1-workspace-management-m1-detail.md](./v1-workspace-management-m1-detail.md)（规则编号索引、R7 类型草稿）

---

## 1. 概述

### 1.1 发布边界（R1–R8）

| ID | 内容 | 摘要 |
|----|------|------|
| R1 | 工作台安装向导 | 零 Profile 强制；先于 API Key；创建方向 Profile + AI 成长 |
| R2 | 内置布局模板 | `layout.json` + 内置方向/项目模板；只补缺失不覆盖 |
| R3 | focus + 新建项目 | 会话级 `focusRelPath`；3 步新建项目 Modal |
| R4 | 文件树增强 | 整树、顶栏、hover 建删 |
| R5 | AI 成长 + 聚合读 | 系统 Profile + 主进程结构化只读聚合 API |
| R6 | SessionBackup 同步 | 切换 Profile 后备份路径随 active workDir |
| R7 | 配置版本 + v1 并行 | `workspaceSchemaVersion`；M1 侧车；不破坏 v1 三件套 |
| R8 | 写入路径 Hook（F6）+ `ProjectGatePromptCard`（F5 字母选项） |

**M1 不包含**：Git（V6+）、用户自定义模板（D3）、升格向导（D1）、搜索展示 focus（D2）等 — 见 [M1-deferred-open-and-out-of-scope.md](./M1-deferred-open-and-out-of-scope.md)。

### 1.2 非目标（明确不做）

| ID | 结论 |
|----|------|
| X1 | 无 DB「项目」实体；项目 = 文件夹 + 会话 focus |
| X2 | 子文件夹自动升格为 Profile |
| X3 | 文件树默认只显示 focus 子树 |
| X4 | 文件树节点「设为当前项目」 |
| X5 | 当前项目条上的「新建项目」 |
| X6 | 跨方向复用项目模板 |
| X7 | 老用户专用 layout 升级 Banner |
| X8 | 向导内 Git init |
| X10 | 扩大 `read_file` 沙箱做跨 Profile 全文读 |

完整列表见 deferred §4。

### 1.3 与现网实现的关系

| 主题 | M1 决策 |
|------|---------|
| 会话存储 | **继续**全局 `{userData}/spaceassistant-data.json` + `Session.workDirProfileId` 过滤（supersede 旧 multi-workdir 文档中的 per-workDir 文件方案） |
| Profile 切换 | 复用 `workdir:*` IPC、`WorkDirSelector`、streaming 时禁止切换 |
| 路径安全 | 复用 `pathSecurity.resolveSafePath(Real)` |
| SessionBackup | **必修** R6：现网 manager 启动时绑死初始 workDir（见 as-is §5.3） |
| 搜索会话 | M1 **不**改跨 Profile 搜索；后置 D2 |

工程可分 PR 开发，**产品验收只认 M1 一次发布**。

---

## 2. 心智模型

### 2.1 三层结构（P1–P3）

```
工作方向（Profile）→ 事情/项目（workDir 子文件夹，可选 focus）→ 产出分类（bucket）
```

| 层级 | 含义 | 磁盘 |
|------|------|------|
| Profile | 长期工作方向；**不是**单次任务 | `{profile.path}` = workDir 根 |
| 项目 | 一次创作/开发事项 | `{workDir}/{projectsRoot}/{name}/` |
| Bucket | 项目内或方向级产出分类 | 模板定义的子目录 |

### 2.2 升格与项目（P4–P6）

| ID | 规则 |
|----|------|
| P4 | 事情默认 = workDir 下**子文件夹**，不自动新建 Profile |
| P5 | 用户认为事项足够大 → **手动**新建 Profile + 文件级迁移（M1 无 D1 向导） |
| P6 | 历史会话仍绑原 `workDirProfileId`；升格后会话不自动跟随 |

### 2.3 五类创作方向 + AI 成长

| `templateId` | 显示名（zh-CN） | 默认目录名（向导） | `layoutKind` |
|--------------|----------------|-------------------|--------------|
| `video` | 视频 | `视频` | `projects-root` |
| `writing` | 写作 | `写作` | `projects-root` |
| `develop` | 开发 | `开发` | `projects-root` |
| `learning` | 学习 | `学习` | `projects-root` |
| `archive` | 归档 | `归档` | `projects-root` |
| `ai-growth` | AI 成长 | `AI成长` | `flat-buckets` |

`develop` 合并原 software/data **方向**；项目模板仍分 `software` / `data` / `minimal`。

### 2.4 能力绑定

| 能力 | 创作 Profile | AI 成长 |
|------|--------------|---------|
| 新建项目 / focus | ✓ | ✗ |
| `projectsRoot` | 有（默认 `项目`） | 无 |
| 文件树「新建项目」 | ✓ | ✗（仅刷新） |
| 聚合读 | 消费端（只读 API） | 数据源 |
| 跨 Profile 写 | ✗（M1 默认，见 §8.3） | 在本 Profile 内正常写 |

---

## 3. 数据模型

### 3.1 存储分层

```
{userData}/spaceassistant-data.json
├── configs
│   ├── config.workspaceSchemaVersion     // 1 | 2
│   ├── config.workspaceV1                // M1 侧车 JSON
│   ├── config.workDirProfiles            // v1 形态数组
│   ├── config.activeWorkDirProfileId
│   └── config.workDir                    // = active.path（三件套）
├── sessions[]                            // + workDirProfileId, focusRelPath?
└── messages[]

{workDir}/layout.json                     // 方向级布局
{workDir}/{projectsRoot}/{project}/layout.json   // 新建项目时写入；非「是否项目」判定条件
```

### 3.2 WorkDirProfile（v1 与 M1 共用，禁止扩展持久化字段）

```typescript
interface WorkDirProfile {
  id: string
  name: string      // UI 显示名
  path: string      // 绝对路径，workDir 根
  aliases?: string[]
  isDefault?: boolean
}
```

M1 元数据（`templateId`、`layoutKind`、`deletable` 等）存 **`config.workspaceV1.profiles[profileId]`**，见 §10。

### 3.3 Session 扩展

```typescript
interface Session {
  // …既有字段
  workDirProfileId?: string
  focusRelPath?: string
  /** 写入项目门禁；见 §6.2 */
  projectGate?: ProjectWriteGate
}
```

- `focusRelPath` 示例：`项目/我的短片/`（POSIX 斜杠，无 leading `/`）
- 新建会话：**不**继承上一会话 focus（F1）
- 切换 Profile：**不清除** focus 字段，但 UI/工具以当前 Profile 校验；无效 focus 视为空

### 3.4 layout.json

```typescript
interface LayoutFile {
  version: 1
  templateId: string
  layoutKind: 'projects-root' | 'flat-buckets'
  projectsRoot?: string          // 如 "项目"
  buckets: BucketDef[]
  locale: string                 // 生成 physicalName 时的 locale，如 zh-CN
}

interface BucketDef {
  id: string                     // 稳定英文 id，如 "source"
  physicalName: string           // 磁盘目录名
  children?: BucketDef[]
}
```

---

## 4. 工作台安装向导（R1）

### 4.1 触发与阻塞

| 条件 | 行为 |
|------|------|
| `workDirProfiles.length === 0` | **强制**向导；阻塞 API Key 配置与聊天发送 |
| `workspaceSchemaVersion >= 2` 且已有 Profile（v1 用户） | **不**弹向导（O7）；静默升 v2 + 初始化侧车（§10） |
| 向导进行中 | 可返回上一步（P17）；取消 = 仍停留在向导（不可绕过） |

**阻塞范围**：设置页除「关于」外可浏览，但 **LLM / 聊天 / 发送** 均不可用，直至向导完成或跳过路径不适用（已有 Profile）。

### 4.2 向导步骤

| Step | 标题 | 内容 | 校验 |
|------|------|------|------|
| 0 | 欢迎 | 三层心智说明（P13） | — |
| 1 | 总仓 | 选择父目录 `root`（**不落库**，O2） | 可写、路径合法 |
| 2 | 创作方向 | 五类多选卡片（P14），≥1（O3） | 至少 1 项 |
| 3 | 工作区路径 | 每方向默认 `{root}/{目录名}/`；可编辑 | 路径不重复（P15）；可写 |
| 4 | 确认创建 | 预览将创建的 Profile 列表 + **AI 成长**（O4，不可取消） | — |
| 5 | 应用模板 | 每行「应用布局模板」Checkbox，**默认勾选**（O5） | — |
| 6 | 完成 | 选择默认打开的 Profile（O6）；写入 DB | 失败可重试/回滚（P16） |

**O6**：全新安装完成后激活用户所选或列表第一个**创作** Profile；**v1→v2 升级不适用**（C7 保持原 active）。

### 4.3 创建结果

对每个勾选方向 + AI 成长：

1. `workDirProfiles` **追加**条目（`id` 新生 UUID）
2. `workspaceV1.profiles[id]` 写入 `templateId`、`layoutKind` 等
3. 若 Step 5 勾选：调用模板引擎创建目录 + `{path}/layout.json`
4. AI 成长：`systemManaged: true`，`deletable: false`

**失败回滚（P16）**：单 Profile 创建失败时，删除本次向导已创建的目录（若为空）及 DB 条目；向导停留 Step 6 并展示错误。

### 4.4 添加工作区（非向导）

路径：**设置 → 工作区 → 添加**

| Step | 内容 |
|------|------|
| 1 | 选择创作方向（五类之一） |
| 2 | 选择/输入 path |
| 3 | 可选「应用方向模板」（默认勾选） |

- **不**重复创建 AI 成长（若已存在 `templateId: ai-growth` 的 Profile）
- M1 UI **禁止**删除 `deletable: false` 的 Profile（v1 设置页不受限，见 R7 C6）

---

## 5. 布局模板（R2）

### 5.1 原则

| ID | 规则 |
|----|------|
| T8 | **只补缺失、不覆盖**：已有文件/目录不删不改内容 |
| T9 | 缺失 bucket 按模板创建目录 |
| T10 | 合并 `layout.json` 时不降级 `version`；`templateId` 以首次写入为准，后续应用只补 bucket |
| T10b | M1 **仅内置**模板；用户自定义后置 D3 |

**「已有目录」判定（O5）**：path 已存在即可应用；不要求空目录。

**再次应用模板**：用户手动触发「应用模板」时仍遵守 T8–T10。

**App locale 变更**：M1 **不重命名**已落盘物理目录；仅影响后续新建。

### 5.1.1 `projectsRoot` 解析与冲突（L1–L4）

侧车 `workspaceV1.profiles[id].projectsRoot` 与磁盘 `{workDir}/layout.json` 的 `projectsRoot` **可能不一致**（legacy 升 v2、手改 JSON、仅应用一半模板等）。**运行时以磁盘为准**；侧车为缓存，负责 reconcile。

| ID | 规则 |
|----|------|
| L1 | **读取优先级**（创作 Profile，`layoutKind = projects-root`）：① `{workDir}/layout.json` 的 `projectsRoot`（文件存在且字段非空）→ ② `workspaceV1.profiles[profileId].projectsRoot` → ③ 默认 `项目` |
| L2 | **冲突处理**：① 与 ② 不一致时，**以 ① 为准**执行枚举、新建项目、**F6 Hook** 路径；**不**依据侧车改磁盘目录名（T8） |
| L3 | **Reconcile**：M1 启动、切换 Profile、应用模板成功后，若 ① 存在且 ①≠② → **写回侧车** `workspaceV1.profiles[profileId].projectsRoot = ①`（侧车向磁盘对齐） |
| L4 | **写入原子性**：应用方向模板 / 新建 Profile 并应用模板时，`layout.json` 与侧车 **同一事务**写入相同 `projectsRoot` |

**无 `{workDir}/layout.json`**（legacy、`templateId: legacy`）：走 L1 ②→③；用户首次「应用方向模板」后按 L4 双写，此后走 L1 ①。

**`flat-buckets`（AI 成长）**：无 `projectsRoot`；L1 不适用。

### 5.2 方向模板（workDir 根）

创作方向共用结构：

- `projectsRoot`: `项目`
- workDir 根下 bucket（与 `项目/` 并列）：

| bucket id | zh-CN 物理名 |
|-----------|-------------|
| `shared` | `共享` |
| `scratch` | `临时` |

另创建目录 `{projectsRoot}/`（即 `项目/`），不在 `buckets[]` 重复定义。

**ai-growth**（`flat-buckets`，无 `projectsRoot`）：

| bucket id | zh-CN 物理名 |
|-----------|-------------|
| `weekly` | `周报` |
| `review` | `复盘` |
| `improvements` | `改进记录` |
| `issues` | `问题改进` |
| `shared` | `共享` |
| `scratch` | `临时` |

### 5.3 项目模板（`{projectsRoot}/{项目名}/`）

路径：`{workDir}/项目/{项目名}/layout.json`（`projectsRoot` 可配置，默认 `项目`）。

#### develop 方向

| templateId | 卡片标题 | buckets（zh-CN） |
|------------|----------|------------------|
| `develop-software` | 软件 | `源码/`、`文档/`、`测试/`、`资源/` |
| `develop-data` | 数据 | `数据/`、`脚本/`、`报告/`、`临时/` |
| `develop-minimal` | 极简 | `产出/` |

#### 其他创作方向（video / writing / learning / archive）

| templateId | 卡片标题 | buckets（zh-CN） |
|------------|----------|------------------|
| `{dir}-standard` | 标准 | `素材/`、`草稿/`、`产出/` |
| `{dir}-minimal` | 极简 | `产出/` |

示例：`video-standard`、`writing-minimal`。  
**不得**在 develop 方向展示 writing 模板（X6）。

### 5.4 模板资源

- 内置包路径（实现）：`resources/workspace-templates/`（或等价目录）
- 每个模板含 `manifest.json` + i18n 字符串；zh-CN 为物理名来源
- 详细 manifest 字段见附录 detail §2

---

## 6. 当前项目 focus（R3）

### 6.1 规则 F1–F6

| ID | 规则 |
|----|------|
| F1 | 新建会话 `focusRelPath` 为空 |
| F2 | focus **会话级**；存 Session 字段 |
| F3 | 切换 focus **不**改磁盘 |
| F4 | 文件树节点**不可**设为 focus（X4） |
| F5 | **首次写入前**若未确定项目 → **一次**询问用户（§6.2）；**不**重复弹散落确认 |
| F6 | 已确定 focus 后 → **写入路径 Hook** 静默校正（§6.6）；**不**因路径对错弹用户确认 |

### 6.2 写入与项目：两阶段语义（F5 / F6）

| 阶段 | 条件 | 对用户 | 工程 |
|------|------|--------|------|
| **A. 项目归因**（F5） | 会话**尚未确定**所属项目 | **首次**写入意图时询问**一次**（§6.2.1） | 不重复弹「写错路径」警告 |
| **B. 模板落盘**（F6） | 已有**有效 focus** | **静默**；不弹路径纠错确认 | **写入前 Hook** + 提示词（§6.6） |

**原则**：

1. **不确定项目** → 问用户「这对话属于哪个项目？」（会话级，非每次写文件）。
2. **已确定项目** → 模板规定 bucket；Hook **程序校正**路径；**不**靠用户逐次确认。

**Session 门禁**（建议 `Session.projectGate`）：

```typescript
type ProjectWriteGate =
  | { status: 'pending' }                 // 未询问
  | { status: 'focus'; focusRelPath: string }
  | { status: 'opt_out' }                 // 用户选「暂不指定项目」；本会话不再 F5、不 F6
```

- 新建会话 → `pending`（F1）
- 项目条 / 新建项目 Modal / 聊天解析设 focus → `focus`，**不弹** F5
- focus **无效**（§6.5.3）→ 视同 `pending`

**AI 成长**（G3）：无 F5 / F6。

---

### 6.2.1 阶段 A — 首次写入项目归因（F5）

**触发**（全部满足）：创作 Profile；`projectGate === pending`（或 focus 无效）；本会话**第一次** `write_file` / `edit_file` 意图。

**交互原则**：**轻量、字母选项**；不用多按钮 Modal。用户 **点选字母按钮** 或 **在输入框回复单个字母**（如 `A`）即可。

**流程**：

1. 主进程 **拒绝执行** 本次 write/edit，进入「待选项目」状态。
2. 聊天区插入 **项目归因卡片**（`ProjectGatePromptCard`），展示候选项目列表。
3. 用户选字母 → 写 `focusRelPath` + `projectGate→focus` → 提示 Agent **在同一轮或下一轮** 带项目路径重试写入。
4. 已在项目条 / 新建项目 Modal 主动设 focus → **不触发** F5。

**卡片文案（zh-CN 示例）**：

```
即将写入：draft.md

请选择文件应归属的项目（回复字母）：

A. 视频A创作
B. 视频B创作
C. 其他项目…

回复字母告诉我你的选择。
```

- 每行 = 一个 **去重后** 的候选项目（显示名 = 项目文件夹名或用户 familiar name）。
- 末项 **固定** 为 **「其他项目…」**（不占候选名额；见 §6.2.2 解析规则）。
- 卡片内 **可点** `[A]` `[B]` `[C]` 按钮；与键盘输入字母 **等价**。
- **无** diff 预览为主内容；可选一行小字「预备路径：{targetRelPath}」。

**与 confirmMode**：F5 **优先于** auto-approve。

---

### 6.2.2 候选项目来源与排序（须排重）

候选列表由主进程或渲染层汇总，按 **`focusRelPath`（`{projectsRoot}/{项目名}/`）去重**。

| 优先级 | 来源 | 解析规则 |
|--------|------|----------|
| P1 | **右侧文件树当前选中项** | 若选中 `{projectsRoot}/{项目}/…` 下路径 → 所属项目；若选中 `{projectsRoot}/{项目}` 目录本身 → 该项目 |
| P2 | **本对话曾打开/预览的文件** | 会话内 `selectedFile`、引用文件列表、文件查看器打开过的 workDir 内路径（渲染进程上报或 Session 侧记录）→ 反查所属项目 |
| — | **排重** | 同一 `focusRelPath` 只保留 **一条**；P1 优先于 P2 |
| — | **上限** | 字母选项 **最多 6 个**（A–F）；超出按 P1 优先、P2 内 **最近打开优先** 截断 |

**不属于任何项目**的路径（workDir 根、`共享/` 等）**不**产生候选。

**末项「其他项目…」**（恒为最后一字母，如已有 A–F 则其为下一字母或固定 **G** — 实现取 **最后一个字母**）：

| 用户选末项 | 行为 |
|------------|------|
| 点击 / 回复末字母 | 展开 **§6.4 全量项目枚举** 二级列表（或聚焦当前项目条下拉）；选定后 `gate→focus` |
| 可选 | 列表内增 **「暂不指定项目」** → `gate→opt_out`（本会话不 F6；不再 F5） |

**用户回复解析**：

- 单字符 `A`–`Z`（大小写不敏感）→ 对应选项
- 无效字母 → 卡片保持；Toast「请输入有效选项」
- 选有效项目字母 → 拒绝的 write **不自动重跑**；tool_result 告知模型：`用户选择项目 {name}，请在该项目目录下重试写入`

---

### 6.2.3 阶段 A 之后

| `projectGate` | 后续 write/edit |
|---------------|-----------------|
| `focus` | §6.6 Hook；**不弹** F5 |
| `opt_out` | 直接写；无 Hook；**不弹** F5 |
| `pending` 且用户未选字母就继续聊天 | 仍 pending；**下次** write 意图再展示归因卡片 |

---

### 6.2.4 协议（项目门禁）

```typescript
interface ProjectGateOption {
  letter: string       // 'A' | 'B' | …
  label: string        // 展示名，如「视频A创作」
  focusRelPath: string
  source: 'file_tree_selection' | 'session_opened_file'
}

// tool:confirm-request（或独立 project-gate-request 事件）
{
  projectGateConfirm: true
  pendingWrite?: { toolName: string; targetRelPath: string }
  options: ProjectGateOption[]
  otherOptionLetter: string   // 如 'C' 或 'G'
  promptText: string          // 含「回复字母…」
}

// 响应：点击按钮或解析用户消息后
{ decision: 'letter'; letter: string }
| { decision: 'other_project'; focusRelPath: string }
| { decision: 'opt_out' }
```

非 F5 的 write 确认**仍**用现网 `WriteConfirmCard`（两按钮）。

**Session 侧建议**：维护 `sessionOpenedRelPaths: string[]`（本对话打开过的 workDir 相对路径，去重，供 P2）。

---

### 6.3 设定 focus 的四通道

| 通道 | 行为 |
|------|------|
| 新建项目 Step 3 | 设 focus + `gate→focus` |
| 当前项目条 | 下拉 → `gate→focus` |
| 聊天解析 | 用户确认 → `gate→focus` |
| F5 首次写入门禁 | §6.2.1 字母选项卡片（P1 文件树 + P2 会话打开文件） |

---

### 6.6 阶段 B — 写入路径 Hook（F6 / R8）

**位置**：主进程，在 `write_file` / `edit_file` **执行器之前**（`toolChatLoop` 内统一入口）；**禁止**仅依赖模型提示词。

**前置**：`projectGate.status === 'focus'` 且 focus 有效。

**输入**：`workDir`、`focusRelPath`、Agent 给的 `targetRelPath`、工具名、可选 `content` 摘要 / 扩展名。

**数据**：读取 `{focusRoot}/layout.json`（项目模板 buckets + manifest 路由规则）。

**处理**（静默，**不弹 UI**）：

1. 若 `targetRelPath` 已在 `{focusRelPath}/` 子树内且命中合法 bucket → **原样**
2. 若在项目子树但 bucket 不对 → **改写到** manifest 规则 bucket（如 `.png` → `素材/`，`.md` 脚本 → `脚本/` 或 `草稿/`，见内置路由表）
3. 若在项目**外**（含 workDir 根、`共享/`、其他项目）→ **改写到** `{focusRelPath}/{默认 bucket}/` + 文件名（默认 bucket 一般为 `产出/`，以模板为准）
4. 若无法推断 → `{focusRelPath}/产出/{filename}`

**输出**：

```typescript
interface WritePathHookResult {
  relPath: string           // 最终写入路径
  rewritten: boolean
  reason?: 'outside_project' | 'wrong_bucket' | 'default_bucket'
}
```

- 写入 `tool_result` 附加字段（模型可见）：`路径已校正至 {relPath}（原因：…）`
- UI **可选**折叠一行系统提示；**不**阻塞用户

**提示词**（辅助，非唯一手段）：系统提示注入当前 focus、`layout.json` bucket 列表与路由摘要；**Hook 为准**。

**Hook 规则表**（M1 内置，随项目模板 manifest；技术设计展开）：

| 信号 | 目标 bucket（示例，develop-software） |
|------|--------------------------------------|
| 扩展名 png/jpg/webp/gif | `资源/` |
| 扩展名 md 且内容含「脚本/分镜」等 | `文档/` 或方向 manifest 指定 |
| 扩展名 ts/js/py 等 | `源码/` |
| 无法分类 | `产出/` |

**规则 F6a–F6d**：

| ID | 规则 |
|----|------|
| F6a | focus 确定后，路径校正 **必须** 走 Hook，不能仅靠 prompt |
| F6b | Hook **不**触发用户确认 |
| F6c | `opt_out` 会话 **不**运行 Hook |
| F6d | Hook 在沙箱 `resolveSafePath` **之前**改相对路径 |

---

### 6.5 当前项目条（UI 规格）

**可见性**：

| 条件 | 显示 |
|------|------|
| 当前为**创作** Profile | 显示 |
| AI 成长 Profile（G3） | **隐藏**整条 |
| 无当前 Session | 显示但 **disabled** |

**位置与布局**：聊天输入区**紧上方**；与输入框同宽；高度约 **32px**；不占用消息列表区域。

```
┌─ ChatView ─────────────────────────────────────────────┐
│  …消息列表…                                             │
├────────────────────────────────────────────────────────┤
│  📁 当前项目  [ 我的短片        ▾ ]     ← project bar   │
├────────────────────────────────────────────────────────┤
│  MessageInput …                                        │
└────────────────────────────────────────────────────────┘
```

---

#### 6.5.1 常态样式（有效 focus / 未指定）

| 状态 | 触发区展示 | 样式 |
|------|------------|------|
| **未指定** | 标签「当前项目」+ 占位「未指定项目」 | 与输入区协调的浅底条；占位符次要色；`▾`  chevron |
| **已指定且有效** | 标签「当前项目」+ **项目文件夹名**（`focusRelPath` 最后一级） | 正常色；hover 浅灰底 |
| **Streaming** | 同上 | 整条 `disabled`；不可改 focus（与 WorkDir 切换同逻辑） |

- **不展示**完整 `focusRelPath` 于触发区；完整路径放 **Tooltip**（`{projectsRoot}/{name}/` 相对 workDir）。
- **无**「新建项目」按钮（X5）。

**控件**：Ant Design `Select`，`bordered={false}` 或自定义 compact trigger，视觉对齐 `WorkDirSelector` 的简洁风格；`suffixIcon` = `ChevronDown`。

---

#### 6.5.2 下拉面板

**宽度**：不小于触发区，**max-width 360px**；`placement` 默认 `bottomLeft`。

**结构**：

```
┌─ 选择项目 ──────────────────────┐
│  ○  短片 A                       │  ← 当前有效项：勾选/高亮
│  ○  文档 B                       │
│  ○  legacy 文件夹                 │
│  ─────────────────────────────  │
│  ✕  清除当前项目                  │  ← destructive 次要文字，非红底
└─────────────────────────────────┘
```

| 项 | 规格 |
|----|------|
| 列表项 | 来自 **§6.4** 枚举；每项主行 = **文件夹名**；副行（可选）= 相对 `{projectsRoot}/` 路径，12px 次要色 |
| 排序 | 文件夹名字母序（localeCompare zh-CN） |
| 单选 | 点击项 → 写 `Session.focusRelPath` → 关闭面板 → 成功 **无 Toast**（静默） |
| 当前项 | 面板内 `selected` 高亮 |
| 空列表 | 仅显示「暂无项目」禁用项 + 「清除」；引导文案「在文件树中新建项目」 |
| 「清除当前项目」 | 固定在列表**底部**，`Divider` 分隔；清空 `focusRelPath`；未指定时 **disabled** |
| 键盘 | ↑/↓ 移动；Enter 选中；Esc 关闭 |

**不展示**于下拉内：新建项目、跳转文件树（X5）。

---

#### 6.5.3 无效 focus（校验与文案）

**校验时机**：切换 Session、切换 Profile、收到 `file:tree-changed`、打开下拉前。

**与 F5**：focus 无效 → `projectGate` 视同 `pending`；**下次首次写入意图**可再弹项目归因卡片。

**判定为无效**（任一满足）：

| # | 条件 |
|---|------|
| I1 | `focusRelPath` 非空，但磁盘路径 `{workDir}/{focusRelPath}` **不存在**或**不是目录** |
| I2 | 路径越界 `resolveSafePath` 失败 |
| I3 | 规范化后**不在**当前 `projectsRoot` 下（含 `projectsRoot` 被 L1 变更后旧 focus 仍指向旧前缀） |
| I4 | 等于 `{projectsRoot}/` 本身（缺项目名） |

**不自动清除** DB 中的 `focusRelPath`；仅 UI 标无效，直至用户**重选**或**清除**（便于用户重建同名目录后恢复有效）。

**无效态样式**：

| 元素 | 规格 |
|------|------|
| 触发区 | 琥珀色左边框或 `Warning` 图标；项目名后附「（无效）」 |
| 辅助说明 | 触发区下方或 Tooltip 一行原因文案（见下表） |
| 下拉 | 仍可用；鼓励用户重选或清除 |

**i18n 文案（zh-CN 为来源）**：

| key 建议 | 文案 | 场景 |
|----------|------|------|
| `workspace.projectBar.label` | 当前项目 | 固定标签 |
| `workspace.projectBar.placeholder` | 未指定项目 | 无 focus |
| `workspace.projectBar.invalidSuffix` | （无效） | 后缀 |
| `workspace.projectBar.invalidMissing` | 项目文件夹不存在，请重新选择或清除 | I1 |
| `workspace.projectBar.invalidOutsideRoot` | 项目不在当前工作区的项目目录下，请重新选择 | I3 |
| `workspace.projectBar.invalidMalformed` | 项目路径无效，请重新选择 | I2、I4 |
| `workspace.projectBar.clear` | 清除当前项目 | 下拉底项 |
| `workspace.projectBar.emptyList` | 暂无项目 | 枚举为空 |
| `workspace.projectBar.emptyHint` | 可在左侧文件树新建项目 | 枚举为空 |
| `workspace.projectBar.tooltip` | `{path}` | 有效态 Tooltip |

**无效 + 用户操作**：

| 操作 | 行为 |
|------|------|
| 点击无效触发区 | 正常打开下拉；选定有效项目 → `gate→focus` |
| focus 确定后 Agent 写入 | **F6 Hook** 静默校正；**不弹**路径确认 |
| 删除项目目录后 | 无效态；`projectGate` 视同 `pending` |
| 切换 Profile | 若 Session 的 focus 在新 workDir 下无效 → 无效态；**不**静默改 Session |
| 重建同名目录 | 校验通过 → 自动恢复有效态（无需重选） |

---

#### 6.5.4 规则 FB1–FB6

| ID | 规则 |
|----|------|
| FB1 | 仅创作 Profile 展示；AI 成长隐藏 |
| FB2 | 触发区显示项目**文件夹名**；完整路径仅 Tooltip |
| FB3 | 下拉 = 枚举单选 + 底部分隔「清除」 |
| FB4 | 无效 focus **不**自动清字段；显示原因文案 |
| FB5 | Streaming 时 disabled |
| FB6 | 变更 focus 仅写当前 Session；**不**改磁盘（F3） |

---

**定义**：项目 = `{workDir}/{projectsRoot}/` 下的**一级子目录**；**不要求**存在 `layout.json`（与 X1「项目 = 文件夹」一致）。

**枚举算法**：

1. 解析 `projectsRoot`：**§5.1.1 L1**（磁盘 `layout.json` 优先于侧车）
2. 列出 `{workDir}/{projectsRoot}/` 的**直接子项**
3. 保留：**是目录**、名称不以 `.` 开头
4. 排除：非目录、`.` / `..`

**`layout.json` 的角色**：

| 场景 | 是否必须有 `layout.json` |
|------|--------------------------|
| focus 下拉 / 聊天解析匹配 | **否** — 手动或 v1 遗留目录可选 |
| 新建项目 Modal 创建 | **是** — Step 3 确认时**必定**写入 `{projectsRoot}/{name}/layout.json` + 模板 buckets |
| 模板 bucket 补全 | 有则按 T8 合并；无则视为未应用项目模板 |

**`focusRelPath` 赋值**：选中项目 `foo` → `focusRelPath = "{projectsRoot}/foo/"`（相对 workDir，POSIX 斜杠， trailing `/` 可选，实现内统一规范化）。

---

## 7. 文件树与新建项目（R4）

### 7.1 文件树范围

- **整棵** workDir 树（X3 禁止 focus 子树模式）
- **不排除** `sessions/`、`.agent/`、`.space-skills/`、`llm-wiki/`（与现网一致）；Agent 工具仍按现有规则跳过/保护
- focus 对应节点：**高亮** + 可选 scroll-into-view；不隐藏其他节点

### 7.2 顶栏

| Profile 类型 | 顶栏 |
|--------------|------|
| 创作 | **新建项目** + **刷新** |
| AI 成长 | 仅 **刷新** |

### 7.3 hover 操作

| 操作 | 范围 | 确认 |
|------|------|------|
| 新建子目录 | 任意目录节点 | 输入名称后创建 |
| 删除 | 文件或目录 | **一律**二次确认 |

**删除语义**：

- 目录：**递归删除**（与现网 `file:delete` 一致）
- 删除项目目录不自动清 Session focus；显示无效态；`projectGate` 视同 `pending`

**禁止删除**（灰显或隐藏）：workDir 根节点本身。

### 7.4 新建项目 Modal（3 步）

**入口**：创作 Profile 文件树顶栏「新建项目」；**无**其他入口（X5）。

**容器**：Ant Design `Modal` + 步骤条（`Steps`，3 步）；宽度 **640px**；`destroyOnClose`；标题 i18n `workspace.newProject.title`（如「新建项目」）。

**上下文**：打开时锁定当前 `activeWorkDirProfileId`；`projectsRoot` 按 **§5.1.1 L1** 解析；项目模板集合按当前 Profile 的 `templateId`（侧车）过滤（develop 3 张，其余 2 张，§5.3）。

**步骤导航**：

| 控件 | 行为 |
|------|------|
| 取消 | 关闭 Modal；若 Step≥2 或 Step1 已输入名称 → 二次确认「放弃新建？」 |
| 上一步 | Step 2/3 可见；回退**保留**已填名称与已选模板 |
| 下一步 | Step 1→2、2→3；当前步校验不通过则 disabled + 字段错误 |
| 创建 | 仅 Step 3；触发落盘（§7.4.4） |

---

#### 7.4.1 Step 1 — 项目名称

| 项 | 规格 |
|----|------|
| 控件 | 单行 `Input`，autofocus；label「项目名称」 |
| 占位符 | i18n 示例名（如「我的短片」） |
| 实时校验 | 失焦或点击「下一步」时校验 |

**校验规则**：

| 规则 | 错误文案要点 |
|------|--------------|
| 非空 | 请输入项目名称 |
| 长度 ≤ 64 | 名称过长 |
| 禁止字符 `\ / : * ? " < > \|` | 含非法字符 |
| 兄弟不重名 | `{projectsRoot}/{name}` 已存在（**不区分大小写**，Windows 按现网 path 规则） |

**下一步**：全部通过方可进入 Step 2。

---

#### 7.4.2 Step 2 — 项目模板（横向卡片）

**布局**：

```
┌─ 选择项目模板 ─────────────────────────────────────┐
│  Step 2/3                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  图标    │  │  图标    │  │  图标    │  ← 横向 │
│  │  标题    │  │  标题    │  │  标题    │    flex │
│  │  一行摘要 │  │  一行摘要 │  │  一行摘要 │         │
│  │  bucket  │  │  bucket  │  │  bucket  │         │
│  │  标签×n  │  │  标签×n  │  │  标签×n  │         │
│  └──────────┘  └──────────┘  └──────────┘         │
│         ↑ 选中态：主色描边 + 浅底 + 右上角勾          │
└────────────────────────────────────────────────────┘
```

| 项 | 规格 |
|----|------|
| 排列 | 横向 `flex`，卡片 **等宽**；2 张时各占 ~50%，3 张时各 ~33%；窄窗 **不换行**（保持单行） |
| 卡片内容 | ① 方向内置图标 ② 模板标题（如「软件」「标准」「极简」）③ **一行**说明（i18n，≤40 字）④ bucket **标签行**：各 bucket 的 zh-CN 物理名，`Tag` 或 pill，超出 `ellipsis` |
| 交互 | **整卡可点**；单选；选中态仅一张 |
| 默认选中 | 进入 Step 2 时自动选中**列表第一项**（develop → `develop-software`；其余 → `{dir}-standard`） |
| 键盘 | 卡片组 `role="radiogroup"`；←/→ 切换；Enter = 选中并等同点击「下一步」 |
| Hover | 未选中卡 `cursor: pointer` + 浅边框高亮 |

**卡片数据**：来自内置模板 manifest（§5.3）；**不得**出现其他方向的模板（X6）。

**下一步**：必须已选中一张模板。

---

#### 7.4.3 Step 3 — 目录预览与确认

**布局**：

```
┌─ 确认创建 ─────────────────────────────────────────┐
│  Step 3/3                                          │
│  将在以下位置创建项目：                               │
│  {workDir .basename} / {projectsRoot} / {name} /   │  ← 面包屑，过长 ellipsis
│  ┌─ 预览树（只读）──────────────────────────────┐  │
│  │ 📁 我的短片                                  │  │
│  │   📁 源码                                    │  │
│  │   📁 文档                                    │  │
│  │   …                                          │  │
│  │   📄 layout.json                             │  │  ← 文件节点，灰色小字
│  └──────────────────────────────────────────────┘  │
│  ☑ 设为当前项目（focus）          ← 默认勾选       │
│                    [ 上一步 ]  [ 创建 ]            │
└────────────────────────────────────────────────────┘
```

| 项 | 规格 |
|----|------|
| 预览树 | **只读**；**不**调用 `file:list-directory`；由 **Step1 名称 + Step2 模板 manifest** 在前端即时生成 |
| 树根 | 显示 **项目名**（文件夹），非完整绝对路径 |
| 树子节点 | 模板 buckets 的 `physicalName`，顺序与 manifest 一致；**不**展开 bucket 子级 |
| `layout.json` | 固定叶子节点，样式弱化为次要（小字/灰）；表示将写入项目 layout |
| 面包屑 | `{profile 名} / {projectsRoot} / {name}` 或等价相对路径，帮助用户定位 |
| 联动 | 从 Step 2 **返回** Step 1 改名称或 Step 2 改模板后，再进 Step 3 时预览**即时更新** |
| 「设为当前项目」 | `Checkbox`，默认 **勾选**；对应 §6.3 新建项目通道；创建成功后若勾选则写 `Session.focusRelPath` |
| 创建按钮 | Primary；文案「创建」；点击后 loading，禁止重复提交 |

**预览树 vs 落盘**：预览仅展示 **将要创建** 的目录与 `layout.json`；不含 workDir 根下 `共享/`、`临时/` 等方向级 bucket。

---

#### 7.4.4 创建与结果

**落盘顺序**（主进程 IPC，原子性由后端保证）：

1. `mkdir` `{workDir}/{projectsRoot}/{name}/`
2. 写入 `{projectsRoot}/{name}/layout.json`（项目模板 `templateId`、`layoutKind: projects-root`、buckets）
3. 按 T9 创建各 bucket 空目录
4. 若勾选 focus → 更新当前 Session 的 `focusRelPath`（§6.4）
5. `file:tree-changed`（或等价）刷新文件树；关闭 Modal；成功 Toast

**失败**（P16 同类）：

| 阶段 | UI |
|------|-----|
| 目录已建、后续失败 | 尝试删除刚建的空项目树；Modal **保持** Step 3；Toast 错误原因 |
| 权限/磁盘满 | 不创建；Toast + 留在 Step 3 |

**成功后**：文件树 **展开并 scroll** 至 `{projectsRoot}/{name}`（若实现成本低；否则仅刷新）。

---

#### 7.4.5 规则编号 NP1–NP8

| ID | 规则 |
|----|------|
| NP1 | 仅创作 Profile 可打开；AI 成长无此 Modal |
| NP2 | Step 2 模板卡片横向单选；默认第一项 |
| NP3 | Step 3 预览树只读、前端合成，不预创建磁盘 |
| NP4 | 创建必定写入项目 `layout.json` + buckets |
| NP5 | 「设为当前项目」默认勾选；作用于**当前 Session** |
| NP6 | 取消/关闭有未保存输入时二次确认 |
| NP7 | 模板卡片 bucket 标签来自 manifest zh-CN 物理名 |
| NP8 | 项目路径与枚举 §6.4 一致：`{projectsRoot}/{name}/` |

---

## 8. AI 成长与聚合读（R5）

### 8.1 Profile 规则 G1–G7

| ID | 规则 |
|----|------|
| G1 | AI 成长为 `templateId: ai-growth` 的 Profile；向导 O4 创建 |
| G2 | `layoutKind: flat-buckets`；无 `projectsRoot` |
| G3 | 无新建项目、无 focus、无 F5/F6 |
| G4 | 创作 Profile **消费**聚合读；AI 成长 **提供**数据 |
| G5 | 创作 Profile 内检测到「写周报/复盘/改进记录」等意图 → **提示**切换 AI 成长 Profile（Banner 或工具返回文案） |
| G6 | 飞书远程：不对 `sensitive` Profile 执行聚合读（复用 `WorkDirProfile` 扩展或 feishu 配置，技术设计定）；返回**摘要**非全文 |
| G7 | M1 UI 禁止删除 AI 成长；v1 可删 → M1 启动补建（C6） |

### 8.2 跨 Profile 写（M1 默认，闭合 U2）

| 场景 | M1 行为 |
|------|---------|
| 创作 Profile 请求写入 AI 成长目录 | **拒绝**；返回 G5 提示 |
| 创作 Profile 调用聚合读 | **允许**（只读） |
| AI 成长 Profile | 正常读写本 workDir |
| 扩大 `read_file` 跨 Profile | **禁止**（X10） |

### 8.3 聚合读 API G8–G11（M1 最小契约）

**实现位置**：主进程；暴露 Agent 工具 + 内部 IPC（UI 后续可用）。

**工具名（暂定）**：`query_workspace_digest`

**输入**：

```typescript
interface QueryWorkspaceDigestInput {
  /** 目标 Profile；默认 ai-growth；创作 Profile 调用时仅限聚合读 */
  profileId?: string
  /** 相对 workDir 的子路径；默认 AI 成长各 bucket 根 */
  buckets?: string[]
  /** ISO 或 ms 时间窗 */
  since?: string | number
  until?: string | number
  /** 关键词，可选 */
  query?: string
  /** 单文件摘要最大字符，默认 500 */
  maxCharsPerFile?: number
  /** 最多文件数，默认 20 */
  limit?: number
}
```

**输出**：

```typescript
interface QueryWorkspaceDigestResult {
  profileId: string
  profileName: string
  items: Array<{
    relPath: string
    title: string
    snippet: string
    modifiedAt: number
  }>
  truncated: boolean
}
```

| ID | 规则 |
|----|------|
| G8 | 仅读取指定 Profile 的 workDir 内**文本类**文件（.md / .txt 等，技术设计列举） |
| G9 | 不返回二进制；不返回超 `maxCharsPerFile` 的全文 |
| G10 | **不**扩大 `read_file` 沙箱；跨 Profile 读必须走本 API |
| G11 | 索引：M1 采用 **mtime 扫描**（U5 默认）；超时返回部分结果并 `truncated: true` |

**G5 意图词表（最小）**：`周报`、`复盘`、`改进`、`问题改进`、`AI成长` — 技术设计可扩展。

---

## 9. SessionBackup（R6）

### 9.1 问题

现网 `SessionBackupManager` 在 `main.ts` 启动时绑定**初始** workDir；切换 Profile 后备份仍写旧路径（as-is §5.3）。

### 9.2 要求

| ID | 规则 |
|----|------|
| S1 | 切换 Profile 后，下一次备份写入 `{新 workDir}/sessions/{id}-{date}/` |
| S2 | 切换瞬间进行中的备份：先 flush 或 queue 至新路径（技术设计二选一） |
| S3 | **不迁移**历史备份目录；旧 Profile 下已有 `sessions/` 保留 |
| S4 | `getWorkDir()` 单一来源：`WorkDirManager.getActiveWorkDir()`（与 C4 一并治理） |

---

## 10. 配置版本与 v1 并行（R7）

**兼容基线**：已发布 **v1**（multi-workdir，`workspaceSchemaVersion = 1`）。同 `appId` → 共用 `spaceassistant-data.json`。

**目标**：不要求 v1 平滑升级；v1 与 M1 可交替使用；v1 仍能使用**全部 Profile 路径**。

| ID | 规则 |
|----|------|
| C1 | `config.workspaceSchemaVersion`：`1`=v1，`2`=M1 |
| C2 | M1 元数据存 `config.workspaceV1`；**禁止**扩 `WorkDirProfile` 持久化字段 |
| C3 | v1→v2：已有 Profile **原样保留**；仅**追加**；禁止删改已有 `id`/`path` |
| C4 | `activeWorkDirProfileId`、`config.workDir`、运行时 workDir **始终 mirror** |
| C5 | v1 忽略 `workspaceV1`、`focusRelPath`、`layout.json` 语义 |
| C6 | v1 删除 systemManaged Profile 合法；M1 启动可补建 |
| C7 | v1→v2 **不改变** `activeWorkDirProfileId` |

### 10.1 v1 升 v2 默认元数据

对每个已有 Profile 写入侧车：

| 字段 | 默认值 |
|------|--------|
| `templateId` | `legacy` |
| `layoutKind` | `projects-root` |
| `projectsRoot` | `项目` |
| `systemManaged` | `false` |
| `deletable` | `true` |

用户后续通过「添加工作区 / 应用模板」演进；**不得**修改已有 path。

### 10.2 验收场景

| 场景 | 期望 |
|------|------|
| A | v1 单 Profile → M1 追加向导/工作区 → v1 仍见原 Profile 且 path 不变 |
| B | v1 改 path → M1 跟随同一 `profileId` |
| C | v1 只保存 API Key → M1 不丢 `workspaceV1` / focus |
| D | v1 删 AI 成长 → M1 补建 |
| E | v1 切换 active → M1 一致 |

类型草稿见 [m1-detail §7.4](./v1-workspace-management-m1-detail.md)。

---

## 11. 待决事项与 M1 默认（不阻塞开发）

| ID | 议题 | M1 默认 |
|----|------|---------|
| U1 | 复盘会话入口 | 不做独立入口；自然语言 + 切换 AI 成长 |
| U2 | 跨区写 | **仅提示 + 拒绝跨 Profile 写**（§8.2） |
| U3 | `sessionKind` | 不做；普通 Session + AI 成长 Profile 足够 |
| U4 | 聚合读工具名 | `query_workspace_digest`（可别名） |
| U5 | 索引 | mtime 扫描 |
| U6 | focus Agent 工具 | M1 提供 `set_session_focus` IPC/工具；可选 |
| U7 | 当前项目条高级入口 | 仅切换/清除 |

---

## 12. 验收标准（M1）

### 12.1 安装与模板

- [ ] 零 Profile 首次启动：向导阻塞聊天；完成后 ≥1 创作方向 + AI 成长；模板目录存在
- [ ] O5：已有目录应用模板只补缺失
- [ ] v1 用户升 v2：不弹向导；原 Profile path/id 不变；active 不变（C7）

### 12.2 focus、项目门禁与写入 Hook

- [ ] 首次 write 且 pending → 字母选项卡片；选项来自 **文件树选中 + 会话打开文件**，排重
- [ ] 点 `[A]` 或输入 `A` 等价；选定 → focus + gate→focus
- [ ] 末项「其他项目」→ 全量枚举；可选 opt_out
- [ ] focus 后 F6 Hook 静默改路径，无用户路径确认
- [ ] 同会话 focus/opt_out 后不再 F5

### 12.3 文件树与新建项目

- [ ] 整树 + focus 高亮；创作 Profile 有新建项目；AI 成长仅刷新
- [ ] 删除须确认；递归删除目录
- [ ] Modal Step 2：横向卡片单选、默认第一项、bucket 标签与 §5.3 一致
- [ ] Modal Step 3：只读预览树随名称/模板联动；`layout.json` 叶子展示
- [ ] 创建成功写 layout + buckets；勾选时写 focus；失败不残留空目录（可尽力）

### 12.4 AI 成长与聚合读

- [ ] M1 不可删 AI 成长；创作区跨区写拒绝 + G5 提示
- [ ] `query_workspace_digest` 返回摘要；不读 sensitive Profile（G6）
- [ ] 不扩大 `read_file` 跨 Profile

### 12.5 工程

- [ ] 切换 Profile 后会话备份进新 `{workDir}/sessions/`
- [ ] 三件套一致（C4）
- [ ] R7 场景 A–E 通过
- [ ] 无 Git 硬依赖

---

## 13. 文档与后续

| 文档 | 用途 |
|------|------|
| [v1-workspace-management-m1-detail.md](./v1-workspace-management-m1-detail.md) | 规则编号、R7 类型、状态机 |
| [M1-deferred-open-and-out-of-scope.md](./M1-deferred-open-and-out-of-scope.md) | 后置 / 不做 |
| [multi-workdir-file-management-as-is.md](../../analysis/multi-workdir-file-management-as-is.md) | 代码基线 |

**下一步**：编写 `docs/develop/workspace-management-technical-design.md`（`ProjectGateConfirmCard`、`writePathHook` 模块、模板 manifest 路由表、IPC）。

---

## 14. 关联文档

- [README.md](./README.md)
- [v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md)
- [multi-workdir-requirement.md](../multi-workdir-requirement.md)

---

## 15. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| V1.0 | 2026-06-27 | 初版范围索引 |
| V1.1 | 2026-06-27 | 对话细化：数据模型、模板 bucket、focus/F5、聚合读契约、R7、验收 |
| V1.2 | 2026-06-27 | §5.1.1 projectsRoot 冲突；§7.4 新建项目 Modal 交互细化 |
| V1.3 | 2026-06-27 | §6.5 当前项目条：下拉样式、无效 focus 文案与行为 |
| V1.4 | 2026-06-27 | §6.2.1 F5 三选项确认卡片；R8；confirm IPC 扩展 |
| V1.5 | 2026-06-27 | **重写 F5/F6**：首次项目归因 + 写入 Hook 静默校正 |
| V1.6 | 2026-06-27 | F5 简化为字母选项（文件树选中 + 会话打开文件，排重） |
