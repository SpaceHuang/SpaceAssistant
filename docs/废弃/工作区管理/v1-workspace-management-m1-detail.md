# V1 附录 — M1 功能详细规格

> **主文档**：[v1-workspace-management-requirement.md](./v1-workspace-management-requirement.md)（V1.1 细化版）  
> **后置 / 不做 / 待决**：[M1-deferred-open-and-out-of-scope.md](./M1-deferred-open-and-out-of-scope.md)  
> **说明**：规则编号索引、R7 类型草稿与状态机；**完整产品规格以主 PRD 为准**。

---

## 1. 工作台安装引导（R1）

### 1.1 规则 O1–O7

| ID | 规则 |
|----|------|
| O1 | 工作台向导先于 API Key |
| O2 | 总仓路径仅向导内使用，不落库 |
| O3 | 至少 1 个创作方向（五类之一） |
| O4 | AI 成长并列创建；M1 内不可删（v1 可删，M1 补建，见 C6） |
| O5 | 选用已有目录时「应用布局模板」默认勾选 |
| O6 | 完成后激活第一个创作 Profile（或用户所选）；**v1→v2 升级时见 C7，保持原 active** |
| O7 | 无老用户升级专用分支；已有 Profile 不重复弹向导 |

### 1.2 P13–P17

| ID | 规则 |
|----|------|
| P13 | 向导文案用三层心智 |
| P14 | 方向选项与五类 + 图标一致 |
| P15 | workDir 冲突提示，不静默覆盖 |
| P16 | 创建失败可重试 / 回滚 |
| P17 | 向导可返回上一步 |

### 1.3 路径

- 总仓 `root`（不落库）→ 各方向默认 `{root}/{方向名}/`；AI 成长 `{root}/AI成长/`（或 slug）
- 路径校验：`pathSecurity`；不可写则阻断

---

## 2. 布局模板（R2）

### 2.1 layout.json（T1–T4）

| 字段 | 说明 |
|------|------|
| `version` | 1 |
| `templateId` | 方向或项目模板 ID |
| `layoutKind` | `projects-root` \| `flat-buckets` |
| `projectsRoot` | 如 `项目` |
| `buckets` | `BucketDef[]`（id, physicalName, children?） |
| `locale` | 生成物理名时的 locale |

存储：`{workDir}/layout.json`；项目级 `{projectsRoot}/{project}/layout.json` 由新建项目 Modal **必定**创建；**是否算项目**见主 PRD §6.4（不要求 layout.json）。

### 2.2 应用规则 T8–T10

- **只补缺失、不覆盖**（T8）
- 缺失 bucket 按模板创建（T9）
- 合并 layout.json 不降级 version（T10）
- **`projectsRoot` 冲突**：见主 PRD §5.1.1（L1–L4）；**磁盘 layout.json 优先**，侧车 reconcile 对齐

### 2.3 内置方向（T11–T12）

`video` / `writing` / `develop` / `learning` / `archive` → `projects-root` + `项目/`  
`ai-growth` → `flat-buckets`，无 projectsRoot

### 2.4 项目模板卡片（T13–T16）

| 方向 | 卡片 |
|------|------|
| develop | software · data · minimal |
| 其他 | 标准 + minimal |

zh-CN bucket 摘要见原 layout-templates §4.2（源码/素材/草稿等）。

### 2.5 添加工作区

设置 → 工作区管理 → 添加：选方向 → 选 path → 可选应用模板 → 创建；**不**重复创建 AI 成长。

---

## 3. focus 与写入（R3，F1–F6）

| ID | 规则 |
|----|------|
| F1 | 新建会话 focus 为空；`projectGate=pending` |
| F2 | focus 会话级 |
| F3 | 切换 focus 不改磁盘 |
| F4 | 文件树不设 focus |
| F5 | **首次写入前** → 字母选项卡片 §6.2.1（P1 文件树 + P2 打开文件，排重） |
| F6 | 已确定 focus → **写入路径 Hook** §6.6；静默校正，不弹用户确认 |

**设定通道**：新建项目 / 当前项目条 / 聊天解析 / F5 首次门禁。

**当前项目条**：§6.5。**写入 Hook**：主 PRD §6.6 / R8。

---

## 4. 文件树与新建项目（R4）

- **整树**；focus 可高亮，不缩树
- 顶栏：创作 Profile → 新建项目 + 刷新；AI 成长 → 仅刷新
- hover：子目录新建 / 删除（均确认）
- **新建项目 Modal**：主 PRD **§7.4**（Step 2 横向模板卡片、Step 3 只读预览树、NP1–NP8）

---

## 5. AI 成长与聚合读（R5）

### 5.1 Profile

`templateId: ai-growth` 存于 `workspaceV1.profiles[id]`（**非** `WorkDirProfile` 字段）；flat-buckets；M1 UI 不可删（C6：v1 可删，M1 补建）。

### 5.2 目录（zh-CN）

`周报/`、`复盘/`、`改进记录/`、`问题改进/`、`共享/`、`临时/`

### 5.3 G1–G11 摘要

- 无新建项目、focus、首次 write 选项目
- G5：创作区跨区意图 → 提示切 AI 成长
- G6：远程排除 sensitive；聚合摘要非全文
- **G8–G11**：主进程结构化聚合读；不扩大 read_file

---

## 6. SessionBackup（R6）

切换 Profile 后 `SessionBackupManager` 同步 `workDir`；备份 `{workDir}/sessions/{id}-{date}/`。

---

## 7. 配置版本与 v1 并行兼容（R7）

### 7.1 背景

M1 与已发布 **v1**（multi-workdir）共用 `{userData}/spaceassistant-data.json`。v1 仅理解 `WorkDirProfile` 五字段与 `activeWorkDirProfileId` / `config.workDir` 三件套；M1 不得破坏 v1 对上述字段的读写语义。

### 7.2 配置键与版本

| 键 | v1 | M1（v2） |
|----|----|----|
| `config.workspaceSchemaVersion` | 缺省或 `1` | `2` |
| `config.workDirProfiles` | 读/写 | 读/写（与 v1 同形） |
| `config.activeWorkDirProfileId` | 读/写 | 读/写 |
| `config.workDir` | 读/写；= active.path | 读/写；**必须**与 active.path 同步 |
| `config.workspaceV1` | 不读不写 | 读/写（M1 侧车） |
| `Session.focusRelPath` | 忽略 | 读/写 |
| `{workDir}/layout.json` | 忽略（文件树可见） | 读/写 |

### 7.3 规则 C1–C7

| ID | 规则 |
|----|------|
| C1 | 引入 `workspaceSchemaVersion`：`1` = v1 multi-workdir，`2` = M1 workspace |
| C2 | M1 元数据存 `workspaceV1`；**禁止**依赖 `WorkDirProfile` 上的 `templateId` / `layoutKind` 等扩展字段（v1 `normalizeProfiles` 与设置保存会丢弃未知字段） |
| C3 | v1→v2：已有 Profile **原样保留**；向导/补建仅**追加**；禁止删除或修改已有 `id`、`path` |
| C4 | 任一端切换 Profile 后：`activeWorkDirProfileId`、`config.workDir`、运行时 `workDirState` 三者一致 |
| C5 | v1 忽略 `workspaceV1`、`focusRelPath`、`layout.json` 语义 |
| C6 | v1 删除 `systemManaged` Profile 合法；M1 启动时检测并补建（不阻塞 v1） |
| C7 | v1→v2 升级**不改变** `activeWorkDirProfileId`；O6 的「激活第一个创作 Profile」仅适用于**零 Profile 全新安装**向导 |

### 7.4 类型草稿（`config.workspaceV1`）

供技术设计引用；实现时可置于 `src/shared/workspaceTypes.ts`。

```typescript
/** configs['config.workspaceSchemaVersion'] */
export type WorkspaceSchemaVersion = 1 | 2

/** configs['config.workspaceV1'] — JSON 字符串 */
export interface WorkspaceV1Config {
  /** M1 安装/升级完成标记；v1 用户可为 false 直至补全 AI 成长等 */
  onboardingCompleted: boolean
  onboardingCompletedAt?: string
  upgradedFromVersion?: 1
  upgradedAt?: string
  /** key = WorkDirProfile.id */
  profiles: Record<string, WorkspaceV1ProfileMeta>
}

export interface WorkspaceV1ProfileMeta {
  templateId: string
  layoutKind: 'projects-root' | 'flat-buckets'
  projectsRoot?: string
  /** true = AI 成长等；M1 负责补建，v1 可删 */
  systemManaged: boolean
  /** false = M1 UI 禁止删；不约束 v1 设置页 */
  deletable: boolean
}

/** Session 扩展；v1 忽略 */
export interface SessionWorkspaceFields {
  focusRelPath?: string
}
```

**WorkDirProfile（v1 与 M1 共用，不得扩展持久化字段）**：

```typescript
interface WorkDirProfile {
  id: string
  name: string
  path: string
  aliases?: string[]
  isDefault?: boolean
}
```

### 7.5 状态机（v1 ↔ v2）

```
[全新安装] profiles 为空
  → workspaceSchemaVersion = 2（或向导完成后写入）
  → 强制 R1 向导 → 追加 Profile + workspaceV1.profiles
  → O6：激活用户所选 / 第一个创作 Profile

[v1 用户] workspaceSchemaVersion = 1，profiles 非空
  → M1 首次启动：写 version = 2，初始化 workspaceV1
  → C3：已有 Profile 写入 workspaceV1.profiles（templateId 可标 `legacy` 待用户后续选用模板）
  → C7：activeWorkDirProfileId 不变
  → O7：不弹 R1 向导；用户通过「添加工作区」补 M1 结构

[交替使用] v1 改 active / path / 删 Profile
  → M1 下次启动：以 DB 三件套为准；reconcile workspaceV1（缺 meta 补默认；缺 systemManaged 补建）

[M1 改 active]
  → 同步三件套；v1 下次打开同一目录
```

### 7.6 场景验收（R7）

| 场景 | 步骤 | 期望 |
|------|------|------|
| **A** | v1 单 Profile `MyProject` → 装 M1 → 跑向导（或添加工作区）→ 再开 v1 | 列表含 `MyProject` 且 path 不变；v1 可切回并正常使用 |
| **B** | M1 使用后 → v1 修改某 Profile path → 再开 M1 | M1 使用新 path；`workspaceV1.profiles[id]` 仍绑定同一 id |
| **C** | M1 使用后 → v1 仅保存 API Key（未动工作区）→ 再开 M1 | `workspaceV1` 与 `focusRelPath` 未丢失 |
| **D** | v1 删除 AI 成长 Profile → 再开 M1 | v1 正常；M1 检测并补建 AI 成长（若 onboarding 要求） |
| **E** | v1 切换 active → 再开 M1 | M1 active 与 v1 一致；`config.workDir` = 该 path |

### 7.7 v1 已有 Profile 的 M1 元数据默认

升 v2 时为每个已有 Profile 写入侧车条目，建议默认：

| 字段 | 默认值 |
|------|--------|
| `templateId` | `legacy` |
| `layoutKind` | `projects-root` |
| `projectsRoot` | `项目` |
| `systemManaged` | `false` |
| `deletable` | `true` |

用户后续可在 M1「添加工作区 / 应用模板」流程中改为正式方向模板；**不得**因此修改已有 path。

---

## 8. 验收清单（与主 PRD 对齐）

合并原 V2–V5 验收项；R7 场景见 §7.6；后置项见 [M1-deferred-open-and-out-of-scope.md](./M1-deferred-open-and-out-of-scope.md)。
