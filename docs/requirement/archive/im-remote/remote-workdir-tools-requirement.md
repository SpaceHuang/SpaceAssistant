# 远程工作目录工具集需求规格

> 版本：v2.1  
> 创建日期：2026年7月12日  
> 修订日期：2026年7月12日（v2 评审修订）  
> 状态：草案  
> 前置依赖：[multi-workdir-requirement.md](./multi-workdir-requirement.md)、[tools-requirement.md](./tools-requirement.md)  
> 关键前置：`WorkDirProfile.sensitive` 字段（见 §8.4）

---

## 1. 概述

### 1.1 背景与问题

当前项目已支持多工作目录配置与切换，但远程用户（飞书、微信指令）无法感知当前处于哪个工作目录，也无法切换。

**核心架构问题**：原有设计使用全局共享的工作目录状态，导致远程用户切换会影响桌面端和其他远程会话，存在并发冲突风险。

**正确的设计原则**：每个会话（桌面、飞书、微信）应有独立的工作目录绑定，类似多终端登录的服务器，每个终端用户拥有自己的当前工作目录字段。

### 1.2 功能定位

构建面向远程使用场景的工作目录工具集，允许远程用户通过指令：
1. **查询**当前所有已配置的工作目录及当前会话绑定的目录
2. **切换**当前会话绑定的工作目录

**核心约束**：
- 该工具集**仅面向远程用户开放**，禁止桌面 Agent 使用
- 切换操作仅影响当前会话，不影响全局状态或其他会话

### 1.3 目标

| ID | 目标 |
|----|------|
| G1 | 远程用户可通过工具调用查询所有工作目录列表及当前会话绑定的目录 |
| G2 | 远程用户可通过工具调用切换当前会话绑定的工作目录 |
| G3 | 工具集仅对远程会话（飞书/微信）可用，桌面会话不可见 |
| G4 | 工作目录切换操作写入审计日志 |
| G5 | 与现有会话级工作目录解析机制（`resolveWorkDirForSession`）完全兼容 |

---

## 2. 用户故事

### US-RWD01：远程查询工作目录列表

**作为** 飞书/微信远程用户，**当** 我发送指令"查看当前工作目录"，**我希望** Agent 能返回所有已配置的工作目录列表及当前会话绑定的目录，**以便** 确认当前操作环境。

### US-RWD02：远程切换工作目录

**作为** 飞书/微信远程用户，**当** 我发送指令"切换到项目 A"，**我希望** Agent 能切换当前会话绑定的工作目录并返回确认信息，**以便** 在正确的项目目录下执行后续操作，且不影响其他用户。

### US-RWD03：防止桌面 Agent 穿越

**作为** 桌面端用户，**当** 桌面 Agent 执行任务时，**我希望** 工作目录工具集对桌面 Agent 不可用，**以便** 避免任务执行时意外穿越到其他工作区。

### US-RWD04：微信远程用户切换工作目录（高优先级）

**作为** 微信远程用户，**当** 我发送指令"切换到项目 A"，**我希望** Agent 能切换当前会话绑定的工作目录，**以便** 在正确的项目目录下执行后续操作。

**背景说明**：微信当前无 `resolveWorkDirFromFeishuCommand` 等价物，远程用户**完全无法**在会话中切换工作目录。本需求对微信用户尤为重要，是实现微信远程多项目操作的关键功能。

---

## 3. 架构设计

### 3.1 会话级工作目录绑定机制

项目已有的 `resolveWorkDirForSession` 函数支持会话级工作目录绑定：

```typescript
// 工作目录解析优先级
export function resolveWorkDirForSession(
  db: AppDatabase,
  sessionId: string,
  listProfiles: () => WorkDirProfile[],
  getActiveProfileId: () => string,
  getActiveWorkDir: () => string
): ResolvedSessionWorkDir | null {
  // 1. 优先使用会话绑定的 workDirProfileId
  if (session.workDirProfileId) {
    const profile = listProfiles().find((p) => p.id === session.workDirProfileId)
    if (profile?.path) {
      return { profileId: profile.id, workDir: profile.path }
    }
  }
  // 2. 回退到全局 active profile
  return {
    profileId: getActiveProfileId(),
    workDir: getActiveWorkDir()
  }
}
```

**本工具集复用此机制**：
- `list_work_dirs`：查询所有目录，并标记当前会话绑定的目录（而非全局 active）
- `switch_work_dir`：通过 `updateSession` 设置当前会话的 `workDirProfileId`

### 3.2 多会话隔离模型

```
┌─────────────────────────────────────────────────────────────┐
│                      工作目录配置（全局）                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Profile1 │  │ Profile2 │  │ Profile3 │                  │
│  │ 项目A    │  │ 项目B    │  │ 项目C    │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   桌面会话        │  │   飞书会话        │  │   微信会话        │
│ workDirProfileId │  │ workDirProfileId │  │ workDirProfileId │
│   = Profile2    │  │   = Profile1    │  │   = Profile3    │
│  独立绑定        │  │  独立绑定        │  │  独立绑定        │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

**优势**：
- 每个会话独立，互不影响
- 无需并发访问控制
- 无需桌面通知机制
- 实现简单，复用现有代码

### 3.3 与飞书入站解析的统一策略

**现状问题**：飞书 `remoteCommandRouter` 通过 `resolveWorkDirFromFeishuCommand` 按单条入站消息解析 profile，但不写入 `session.workDirProfileId`。导致同会话后续消息无 `@` 前缀时，`resolveWorkDirForSession` 会回退到全局 active profile，与实际执行目录不一致。

**采用方案 A（推荐）**：

| 步骤 | 说明 |
|------|------|
| 1 | 飞书入站解析到 profile 时，同步调用 `updateSession(db, sessionId, { workDirProfileId })` 持久化绑定 |
| 2 | 远程代理统一使用 `resolveWorkDirForSession` 作为 `resolveWorkDir` 来源 |
| 3 | 入站解析的静态 `workDir` 仅作为初始回退值 |
| 4 | 后续无 `@` 前缀的飞书消息继承会话已绑定的目录 |

**会话绑定继承规则**：

| 场景 | 行为 |
|------|------|
| 飞书消息带 `@项目` | 解析到 profile 后，更新会话绑定并使用该目录 |
| 飞书消息不带 `@项目` | 使用会话已绑定的目录（若无绑定则回退全局 active） |
| 调用 `switch_work_dir` | 更新会话绑定，覆盖之前的入站解析结果 |
| 新会话创建 | 无绑定，回退全局 active profile |

**飞书入站 ambiguous 处理**：飞书现网 `resolveWorkDirFromFeishuCommand` 多匹配时走数字回复（`buildDisambiguationReply`），工具侧走 `ambiguous` 数组由 Agent 追问。入站 ambiguous 仍走现有 IM 数字选择，与会话绑定在用户选择后写入。

---

## 4. 工具定义

### 4.1 工具清单

| 工具名 | 描述 | 需要确认 | 风险等级 | 可用范围 |
|--------|------|---------|---------|---------|
| `list_work_dirs` | 列出所有已配置的工作目录，包含当前会话绑定状态 | 否 | low | 仅远程 |
| `switch_work_dir` | 切换当前会话绑定的工作目录 | 否 | low | 仅远程 |

> **注意**：由于切换仅影响当前会话，风险等级为 low，无需用户确认。

### 4.2 风险等级注册

必须在 `domainTypes.ts` 的 `builtinToolRiskLevel` 函数中明确注册 `switch_work_dir` 为 low 风险：

```typescript
export function builtinToolRiskLevel(name: string): ToolRiskLevel {
  switch (name) {
    // ... 现有工具
    case 'list_work_dirs':
    case 'switch_work_dir':
      return 'low'
    default:
      return 'medium'
  }
}
```

**重要**：`builtinToolRiskLevel` 的 `default` 分支返回 `'medium'`，如果不明确注册，`switch_work_dir` 将被视为 medium 风险并触发确认流程。

### 4.3 确认机制排除

必须确保 `switch_work_dir` 不在 `builtinToolNeedsConfirmation` 函数的确认列表中：

```typescript
export function builtinToolNeedsConfirmation(name: string): boolean {
  return (
    name === 'edit_file' ||
    name === 'write_file' ||
    name === 'run_script' ||
    name === 'run_lark_cli' ||
    name === 'run_shell'
    // switch_work_dir 不在此列表中，无需确认
  )
}
```

### 4.4 工具详细定义

#### list_work_dirs

```json
{
  "name": "list_work_dirs",
  "description": "列出所有已配置的工作目录，包含当前会话绑定的目录状态。仅在远程会话（飞书/微信）中可用。",
  "input_schema": {}
}
```

**输入参数**：无

**返回数据**：

```typescript
interface ListWorkDirsResult {
  directories: Array<{
    id: string
    name: string
    path: string
    isBound: boolean
    isDefault: boolean
    isActive: boolean
    isSensitive: boolean
    aliases?: string[]
  }>
  currentBoundId: string
  activeProfileId: string
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `directories` | array | 所有工作目录列表 |
| `directories[].id` | string | 目录配置 ID |
| `directories[].name` | string | 目录名称 |
| `directories[].path` | string | 目录路径 |
| `directories[].isBound` | boolean | 是否为当前会话绑定的目录 |
| `directories[].isDefault` | boolean | 是否为系统默认目录（`isDefault: true`） |
| `directories[].isActive` | boolean | 是否为全局 active 目录（用户当前选中的目录） |
| `directories[].isSensitive` | boolean | 是否为敏感目录（`sensitive: true`，远程不可访问） |
| `directories[].aliases` | string[] | 目录别名列表 |
| `currentBoundId` | string | 当前会话绑定的目录 ID |
| `activeProfileId` | string | 全局 active 目录 ID（无绑定时回退到此） |

**语义澄清**：

| 字段 | 来源 | 用途 |
|------|------|------|
| `isDefault` | `profile.isDefault` | 系统默认目录标记 |
| `isActive` | `getActiveProfileId()` | 用户当前选中的全局目录，无绑定时回退到此 |
| `isBound` | `session.workDirProfileId` | 当前会话绑定的目录 |

**执行逻辑**：
1. 调用 `workDirManager.listProfiles()` 获取所有工作目录
2. 调用 `resolveWorkDirForSession()` 获取当前会话绑定的目录 ID
3. 调用 `workDirManager.getActiveProfileId()` 获取全局 active 目录 ID
4. 返回目录列表，标记每个目录的绑定状态、active 状态和 sensitive 状态

#### switch_work_dir

```json
{
  "name": "switch_work_dir",
  "description": "切换当前会话绑定的工作目录。仅在远程会话（飞书/微信）中可用。切换后当前会话的所有后续操作将在新目录下执行，不影响其他会话。",
  "input_schema": {
    "type": "object",
    "properties": {
      "profile_id": {
        "type": "string",
        "description": "工作目录配置的 ID（来自 list_work_dirs 的 id 字段），优先级最高"
      },
      "name": {
        "type": "string",
        "description": "工作目录名称，支持精确匹配或模糊匹配"
      },
      "alias": {
        "type": "string",
        "description": "工作目录别名，用于远程指令快捷匹配"
      }
    },
    "description": "至少提供 profile_id、name 或 alias 中的一个。匹配优先级：profile_id > name（精确）> alias（精确）> name（模糊）"
  }
}
```

**输入参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `profile_id` | string | 可选 | 工作目录配置的唯一 ID，优先级最高 |
| `name` | string | 可选 | 工作目录名称，支持精确匹配或模糊匹配 |
| `alias` | string | 可选 | 工作目录别名，用于远程指令快捷匹配 |

**匹配优先级**：
1. `profile_id` 精确匹配（最高优先级）
2. `name` 精确匹配（大小写不敏感，trim）
3. `alias` 精确匹配（匹配 `aliases` 数组中的任意一个，大小写不敏感，trim）
4. `name` 模糊匹配（包含匹配，大小写不敏感）

**匹配规则**：与 `feishuWorkDirResolver.ts` 的 `normalize()` 函数一致，即 `trim().toLowerCase()` 后进行比较。

**多匹配消歧规则**：
- 当模糊匹配命中多个 profile 时，返回 `success: false` + `ambiguous` 候选列表
- Agent 应向用户展示候选列表并请求明确选择

**返回数据**：

```typescript
interface SwitchWorkDirResult {
  success: boolean
  profileId?: string
  profileName?: string
  workDir?: string
  error?: string
  ambiguous?: Array<{
    id: string
    name: string
    aliases?: string[]
  }>
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否切换成功 |
| `profileId` | string | 切换到的目录 ID（成功时） |
| `profileName` | string | 切换到的目录名称（成功时） |
| `workDir` | string | 切换到的目录路径（成功时） |
| `error` | string | 错误信息（失败时） |
| `ambiguous` | array | 匹配到多个候选目录时返回（失败时） |

**执行逻辑**：
1. 根据输入参数确定目标工作目录（遵循匹配优先级和大小写不敏感规则）
2. 若匹配到多个目录，返回 `ambiguous` 候选列表
3. 若目标目录为 `sensitive: true`，返回错误：`"该工作目录为敏感目录，不允许远程访问"`
4. 验证目录存在且路径可写（调用 `checkDirectoryWritable`）
5. 调用 `updateSession(db, sessionId, { workDirProfileId: targetProfileId })` 设置会话绑定
6. 写入审计日志（仅当绑定实际发生变化时）
7. 返回切换结果

---

## 5. 远程专属机制

### 5.1 工具可见性控制

工具定义在发送给模型时，根据会话来源进行过滤：

| 会话来源 | 工作目录工具可见 |
|---------|----------------|
| 桌面端（Renderer） | 否 |
| 飞书远程（Feishu） | 是 |
| 微信远程（WeChat） | 是 |

**实现方式**：在 `toolsConfigRuntime.ts` 的 `filterBuiltinToolsForApi` 函数中添加远程会话判断逻辑：

```typescript
export function filterBuiltinToolsForApi(
  cfg: ToolsConfig,
  feishu?: FeishuConfig | null,
  browserConfig?: BrowserConfig | null,
  remoteContext?: RemoteContext | null,
  shellConfig?: ShellConfig | null,
  wechat?: WeChatConfig | null
): typeof BUILTIN_TOOL_DEFINITIONS {
  let list = BUILTIN_TOOL_DEFINITIONS.filter((t) => isToolEnabledByConfig(t.name, cfg))
  
  // ... 现有过滤逻辑 ...
  
  // 工作目录工具仅在远程会话中可用
  if (!remoteContext) {
    list = list.filter((t) => t.name !== 'list_work_dirs' && t.name !== 'switch_work_dir')
  }
  
  return list
}
```

### 5.2 会话来源判断

会话来源通过 `remoteContext` 字段判断：

```typescript
interface ToolExecutionContext {
  // ... 现有字段
  remoteContext?: FeishuRemoteContext | WeChatRemoteContext
}
```

- 存在 `remoteContext` → 远程会话 → 工作目录工具可见
- 不存在 `remoteContext` → 桌面会话 → 工作目录工具隐藏

### 5.3 执行器层守卫

除工具定义过滤外，执行器层也需添加守卫，防止异常路径调用：

```typescript
// listWorkDirsExecutor 和 switchWorkDirExecutor 的开头必须添加：
if (!ctx.remoteContext) {
  return { success: false, error: '该工具仅在远程会话中可用' }
}
```

**双重防护机制**：

| 防护层 | 机制 | 作用 |
|--------|------|------|
| 工具定义过滤 | `filterBuiltinToolsForApi` 排除工具 | 桌面 Agent 无法看到工具定义 |
| 执行器层守卫 | `!remoteContext` 检查 | 即使异常调用也被拒绝 |

### 5.4 ToolsConfig 策略

工作目录工具的 `deniedTools` 行为：

| 配置 | 远程会话行为 | 说明 |
|------|-------------|------|
| `deniedTools` 包含 `list_work_dirs` | 工具不可用 | 遵循全局 tools 配置 |
| `deniedTools` 包含 `switch_work_dir` | 工具不可用 | 遵循全局 tools 配置 |
| `deniedTools` 不包含 | 工具可用 | 默认行为 |

**设计原则**：工作目录工具遵循全局 `ToolsConfig`，不特殊绕过 `deniedTools`。用户若在设置中禁用这些工具，远程也将不可用。

---

## 6. 安全机制

### 6.1 路径有效性验证

切换前验证目标目录路径：

| 验证项 | 规则 | 错误提示 |
|--------|------|---------|
| 目录存在 | `fs.existsSync(profile.path)` | `"目录已失效，请重新配置"` |
| 目录可写 | 调用 `checkDirectoryWritable` | `"无法写入该目录：{error}"` |

**实现要点**：使用 `workDirManager.checkDirectoryWritable()` 进行权限校验，与配置保存时的验证逻辑一致。

### 6.2 敏感目录防护

`sensitive: true` 的 profile 禁止远程访问：

| 场景 | 行为 |
|------|------|
| 调用 `switch_work_dir` 切换到敏感目录 | 返回错误：`"该工作目录为敏感目录，不允许远程访问"` |
| 调用 `list_work_dirs` | 返回目录列表，但标记 `isSensitive: true` |
| 飞书入站解析命中敏感目录 | 返回错误：`"该项目为敏感项目，不允许远程访问"` |

**来源**：[multi-workdir-requirement.md](../requirement/multi-workdir-requirement.md) §7.1 定义 `sensitive: true` 的 profile 禁止远程执行。

#### 已绑定 sensitive 会话的执行策略

| 场景 | 行为 |
|------|------|
| 会话已绑定 sensitive profile | 远程 Agent 在启动时检测到绑定的 profile 为 sensitive，拒绝启动并返回错误 |
| 桌面侧将 profile 标记为 sensitive | 已绑定该 profile 的远程会话在下一次工具调用时检测到，拒绝继续执行 |
| 已绑定 sensitive 会话尝试切换 | `switch_work_dir` 返回错误：`"该工作目录为敏感目录，不允许远程访问"` |

**实现建议**：在 `resolveWorkDirForSession` 返回结果中包含 `isSensitive` 标记，远程 Agent 启动时或工具循环入口处检查，若为 sensitive 则拒绝执行。

### 6.3 审计日志

工作目录切换操作写入审计日志。

#### 飞书审计事件

```typescript
// 已存在于 feishuTypes.ts FeishuAuditEvent 中
{ type: 'workdir_switch'; profileId: string; profileName: string; ts: number }
```

#### 微信审计事件

```typescript
// 需要新增到 WeChatAuditEvent
{ type: 'workdir_switch'; profileId: string; profileName: string; ts: number }
```

**审计内容**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `'workdir_switch'` |
| `profileId` | string | 切换到的工作目录配置 ID |
| `profileName` | string | 切换到的工作目录名称 |
| `ts` | number | 切换时间戳（毫秒） |

#### 审计去重规则

**现状**：飞书 `remoteCommandRouter` 在入站解析到 profile 时已写入 `workdir_switch` 审计。

**去重策略**：
1. 仅当绑定**实际发生变化**时写入审计（切换到同一目录不写）
2. 飞书入站解析与工具切换统一由 `bindSessionWorkDir` helper 写入审计

#### bindSessionWorkDir 统一 helper

**设计意图**：入站绑定与工具切换共用同一业务逻辑，确保 sensitive 校验、可写校验、去重审计等规则在两个入口一致执行。

**定义**：

```typescript
interface BindSessionWorkDirParams {
  sessionId: string
  profileId: string
  remoteContext: FeishuRemoteContext | WeChatRemoteContext
  source: 'inbound' | 'tool'
}

interface BindSessionWorkDirResult {
  success: boolean
  error?: string
}

async function bindSessionWorkDir(
  db: AppDatabase,
  workDirManager: WorkDirManager,
  params: BindSessionWorkDirParams
): Promise<BindSessionWorkDirResult> {
  // 1. 查询当前会话的绑定状态
  const session = getSession(db, params.sessionId)
  if (!session) {
    return { success: false, error: '会话不存在' }
  }
  
  // 2. 查询目标 profile
  const profiles = workDirManager.listProfiles()
  const profile = profiles.find((p) => p.id === params.profileId)
  if (!profile) {
    return { success: false, error: '工作目录配置不存在' }
  }
  
  // 3. sensitive 校验（已在调用方完成，但保留防御式检查）
  if (profile.sensitive === true) {
    return { success: false, error: '该工作目录为敏感目录，不允许远程访问' }
  }
  
  // 4. 去重检查：绑定未变化时直接返回成功，不写审计
  if (session.workDirProfileId === params.profileId) {
    return { success: true }
  }
  
  // 5. 更新会话绑定
  updateSession(db, params.sessionId, { workDirProfileId: params.profileId })
  
  // 6. 写入审计日志
  writeWorkDirSwitchAudit(params.remoteContext, params.profileId, profile.name)
  
  return { success: true }
}
```

**调用位置**：

| 调用方 | 调用时机 | source 参数 |
|--------|---------|------------|
| `switchWorkDirExecutor` | 用户调用 `switch_work_dir` 工具 | `'tool'` |
| `remoteCommandRouter` | 飞书入站解析到 profile | `'inbound'` |

**实现建议**：提取为独立函数，放置在 `workDirManager.ts` 或新建 `workDirBinding.ts` 模块。

---

## 7. 工具执行器实现

### 7.1 上下文扩展

当前 `ToolExecutionContext` 已包含 `appDatabase` 和 `workDir`，但存在一个关键问题：`workDir` 是在调用 `runToolChatSession` 时作为静态参数传入的，在整个工具循环中不会重新解析。这导致 `switch_work_dir` 切换后，后续工具调用仍使用旧的 `workDir` 值。

**解决方案**：将静态 `workDir` 替换为动态解析回调。

#### RunToolChatSessionArgs 扩展

```typescript
export type RunToolChatSessionArgs = {
  // ... 现有字段
  workDirManager?: WorkDirManager
  resolveWorkDir?: () => string
}
```

#### ToolExecutionContext 扩展

```typescript
interface ToolExecutionContext {
  // ... 现有字段（已包含 appDatabase）
  workDir: string
  workDirManager?: WorkDirManager
}
```

**扩展字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `workDirManager` | `WorkDirManager` | 工作目录管理器实例，用于查询工作目录列表 |
| `resolveWorkDir` | `() => string` | 动态解析当前会话工作目录的回调函数，每次工具调用前调用 |

**实现方式**：
1. 在 `toolChatLoop.ts` 的 `RunToolChatSessionArgs` 类型中添加 `workDirManager` 和 `resolveWorkDir`
2. 在 `runToolChatSessionInner` 函数中，从 `args` 解构获取 `workDirManager` 和 `resolveWorkDir`
3. 在每次工具调用前，调用 `resolveWorkDir()` 获取最新的工作目录
4. 在构建工具执行上下文时，将最新的 `workDir` 和 `workDirManager` 传递给 `ToolExecutionContext`
5. 远程代理调用 `runToolChatSession` 时，传入 `workDirManager` 和 `resolveWorkDir` 回调

**关键改动点**：在 `runToolChatSessionInner` 的工具循环中，`workDir` 在多个地方被使用（shell precheck、workspace layout、file auto-approval、confirm diff 生成等），因此必须在每次工具迭代的**开头**重新解析。

```typescript
// 原代码（静态 workDir）
const {
  // ...
  workDir,  // 静态绑定，整个循环不变
  // ...
} = args

// ...

for (const tu of toolUses) {
  // shell precheck、workspace layout、auto-approval、confirm diff 都使用同一个 workDir
  // ...
}

// 修改后（动态解析）
const {
  // ...
  workDir: initialWorkDir,  // 保留初始值作为回退
  resolveWorkDir,
  // ...
} = args

// ...

for (const tu of toolUses) {
  // 在每次迭代开头重新解析 workDir
  const workDir = resolveWorkDir ? resolveWorkDir() : initialWorkDir
  
  // 后续所有使用 workDir 的地方都会使用最新值：
  // - shell precheck（runShellPrecheck 调用）
  // - workspace layout candidate building（buildAndSnapshotCandidates 调用）
  // - write dir resolution（getWriteDirChoice 逻辑）
  // - file auto-approval evaluation（writeFileAutoApproval 调用）
  // - confirm diff generation（确认差异生成逻辑）
  // - exec.execute（工具执行器调用）
  // ...
}
```

**需要重新解析 workDir 的位置**：

| 位置 | 用途 | 逻辑锚点 |
|------|------|---------|
| shell precheck | 检查 shell 命令路径安全性 | `runShellPrecheck` 调用 |
| workspace layout candidates | 构建写入目录候选 | `buildAndSnapshotCandidates` 调用 |
| write dir resolution | 解析实际写入目录 | `getWriteDirChoice` 逻辑 |
| file auto-approval | 评估文件自动批准 | `writeFileAutoApproval` 调用 |
| confirm diff | 生成确认差异 | 确认差异生成逻辑 |
| exec.execute | 工具执行器 | 工具执行器调用 |

**实现要点**：将 `const workDir` 改为 `let workDir`（或在循环内重新声明），在每次工具迭代开头调用 `resolveWorkDir()` 更新值。

**远程代理调用方式**：

飞书远程代理（`feishuRemoteAgent.ts`）调用时传入动态解析回调：

```typescript
const res = await runToolChatSession({
  // ... 其他参数
  workDir: ctx.workDir,  // 初始值
  workDirManager: ctx.workDirManager,
  resolveWorkDir: () => {
    return resolveWorkDirForSession(
      ctx.db,
      ctx.sessionId,
      ctx.workDirManager.listProfiles.bind(ctx.workDirManager),
      ctx.workDirManager.getActiveProfileId.bind(ctx.workDirManager),
      ctx.workDirManager.getActiveWorkDir.bind(ctx.workDirManager)
    )?.workDir ?? ctx.workDir
  }
})
```

### 7.2 执行器注册

在 `tools/builtinExecutors.ts` 中注册新工具执行器：

```typescript
const registry = new Map<string, ToolExecutor>([
  // ... 现有工具
  [listWorkDirsExecutor.name, listWorkDirsExecutor],
  [switchWorkDirExecutor.name, switchWorkDirExecutor]
])
```

### 7.3 执行器实现要点

#### listWorkDirsExecutor

```typescript
async function listWorkDirsExecutor(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutorResult> {
  if (!ctx.remoteContext) {
    return { success: false, error: '该工具仅在远程会话中可用' }
  }
  
  const { workDirManager, sessionId, appDatabase } = ctx
  
  if (!workDirManager || !appDatabase) {
    return { success: false, error: '缺少必要的上下文信息' }
  }
  
  const profiles = workDirManager.listProfiles()
  const activeProfileId = workDirManager.getActiveProfileId()
  const resolved = resolveWorkDirForSession(
    appDatabase,
    sessionId,
    () => profiles,
    () => activeProfileId,
    workDirManager.getActiveWorkDir.bind(workDirManager)
  )
  
  const currentBoundId = resolved?.profileId ?? ''
  
  return {
    success: true,
    data: {
      directories: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        isBound: p.id === currentBoundId,
        isDefault: Boolean(p.isDefault),
        isActive: p.id === activeProfileId,
        isSensitive: Boolean(p.sensitive),
        aliases: p.aliases ?? []
      })),
      currentBoundId,
      activeProfileId
    }
  }
}
```

#### switchWorkDirExecutor

```typescript
async function switchWorkDirExecutor(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutorResult> {
  if (!ctx.remoteContext) {
    return { success: false, error: '该工具仅在远程会话中可用' }
  }
  
  const { workDirManager, sessionId, appDatabase, remoteContext } = ctx
  
  if (!workDirManager || !appDatabase) {
    return { success: false, error: '缺少必要的上下文信息' }
  }
  
  const profiles = workDirManager.listProfiles()
  
  const profileId = input.profile_id as string | undefined
  const name = input.name as string | undefined
  const alias = input.alias as string | undefined
  
  const normalize = (s: string) => s.trim().toLowerCase()
  
  let matches: WorkDirProfile[] = []
  
  if (profileId) {
    matches = profiles.filter((p) => p.id === profileId)
  } else if (name) {
    const normalizedName = normalize(name)
    const exactMatches = profiles.filter((p) => normalize(p.name) === normalizedName)
    if (exactMatches.length > 0) {
      matches = exactMatches
    } else {
      matches = profiles.filter((p) => normalize(p.name).includes(normalizedName))
    }
  } else if (alias) {
    const normalizedAlias = normalize(alias)
    matches = profiles.filter((p) => p.aliases?.some((a) => normalize(a) === normalizedAlias))
  }
  
  if (matches.length === 0) {
    return { success: false, error: '未找到匹配的工作目录' }
  }
  
  if (matches.length > 1) {
    return {
      success: false,
      ambiguous: matches.map((p) => ({
        id: p.id,
        name: p.name,
        aliases: p.aliases ?? []
      }))
    }
  }
  
  const targetProfile = matches[0]
  
  if (targetProfile.sensitive === true) {
    return { success: false, error: '该工作目录为敏感目录，不允许远程访问' }
  }
  
  try {
    await workDirManager.checkDirectoryWritable(targetProfile.path)
  } catch (err) {
    return { success: false, error: `无法写入该目录：${(err as Error).message}` }
  }
  
  const result = await bindSessionWorkDir(
    appDatabase,
    workDirManager,
    {
      sessionId,
      profileId: targetProfile.id,
      remoteContext,
      source: 'tool'
    }
  )
  
  if (!result.success) {
    return { success: false, error: result.error }
  }
  
  return {
    success: true,
    data: {
      profileId: targetProfile.id,
      profileName: targetProfile.name,
      workDir: targetProfile.path
    }
  }
}
```

### 7.4 切换范围说明

`switch_work_dir` 工具切换的是**当前会话绑定的工作目录**（`session.workDirProfileId`），而非全局状态。

| 特性 | 说明 |
|------|------|
| 影响范围 | 仅当前会话 |
| 其他会话 | 不受影响 |
| 全局状态 | 不改变 |
| 桌面端 | 不受影响 |

**会话级绑定的生命周期**：
- 新会话创建时，`workDirProfileId` 为空，回退到全局 active profile
- 调用 `switch_work_dir` 后，会话绑定到指定 profile
- 后续该会话的所有文件操作（`read_file`、`list_directory`、`edit_file` 等）都使用绑定的目录
- 会话删除后，绑定关系随之消失

---

## 8. 与现有机制的兼容性

### 8.1 resolveWorkDirForSession 复用

本工具集完全复用现有的 `resolveWorkDirForSession` 机制：

| 场景 | 行为 |
|------|------|
| 会话有绑定 | 使用绑定的目录 |
| 会话无绑定 | 回退到全局 active profile |
| 绑定的 profile 被删除 | 回退到全局 active profile |

### 8.2 工具定义注入

工具定义在 `builtinToolDefinitions.ts` 中添加，与现有工具保持一致的定义格式。

### 8.3 远程代理集成

工作目录工具的可见性通过 `toolsConfigRuntime.ts` 的 `filterBuiltinToolsForApi` 函数控制，根据 `remoteContext` 参数判断是否包含工作目录工具。远程代理调用 `runToolChatSession` 时传入 `remoteContext`，工具定义在 `toolChatLoop` 侧自动过滤。

远程代理需注入的上下文：
- `workDirManager`：工作目录管理器实例
- `resolveWorkDir`：动态解析工作目录的回调函数

**飞书远程代理**（`feishuRemoteAgent.ts`）：调用 `runToolChatSession` 时传入上述上下文。
**微信远程代理**（`weChatRemoteAgent.ts`）：调用 `runToolChatSession` 时传入上述上下文。

---

## 9. 安全分析

### 9.1 安全机制总览

本方案的安全性依赖于以下多层防护机制：

| 安全层 | 机制 | 作用范围 |
|--------|------|---------|
| **Profile 白名单** | `switch_work_dir` 仅匹配预配置的 profile | 防止切换到任意路径 |
| **路径边界检查** | `resolveSafePath` / `resolveSafePathReal` | 所有文件工具的硬边界 |
| **符号链接防护** | `fs.realpath` 解析后二次校验 | 防止通过符号链接逃逸 |
| **会话级隔离** | 每个会话独立绑定，互不影响 | 防止跨会话干扰 |
| **sensitive 目录拦截** | `bindSessionWorkDir` helper 检查 `profile.sensitive` | 防止远程访问敏感目录 |
| **执行器层守卫** | `!remoteContext` 检查 | 双重防护，防止桌面端调用 |
| **审计日志** | 记录所有切换操作（仅绑定变化时） | 可追溯性 |

### 9.2 Profile 白名单机制

`switch_work_dir` 工具**不接受任意路径输入**，只能切换到预配置的工作目录：

```typescript
// 核心安全逻辑：仅从预配置列表中匹配
const profiles = workDirManager.listProfiles()

let targetProfile: WorkDirProfile | undefined

if (profileId) {
  targetProfile = profiles.find((p) => p.id === profileId)
}

if (!targetProfile && name) {
  targetProfile = profiles.find((p) => p.name === name)
}

if (!targetProfile && alias) {
  targetProfile = profiles.find((p) => p.aliases?.includes(alias))
}

// 如果没有匹配到预配置的 profile，返回错误
if (!targetProfile) {
  return { success: false, error: '未找到匹配的工作目录' }
}
```

**安全保证**：远程用户无法通过 `switch_work_dir` 切换到工作目录配置之外的任何路径。

### 9.3 路径边界检查

所有文件操作工具（`read_file`、`write_file`、`edit_file`、`list_directory`）都使用 `resolveSafePath` 或 `resolveSafePathReal` 进行路径校验：

```typescript
// pathSecurity.ts 核心安全函数
export function resolveSafePath(basePath: string, relativePath: string): string {
  const base = path.resolve(basePath)
  const resolved = path.resolve(base, normalizeRelPathInput(relativePath))
  const rel = path.relative(base, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出工作目录范围')
  }
  return resolved
}
```

**安全保证**：
- 防止路径穿越（`../` 攻击）
- 防止绝对路径直接输入
- 所有文件操作都被限制在 `workDir` 之下

### 9.4 符号链接防护

`resolveSafePathReal` 函数在解析真实路径后再次校验，防止通过符号链接逃逸：

```typescript
export async function resolveSafePathReal(basePath: string, relativePath: string): Promise<string> {
  const resolved = resolveSafePath(basePath, relativePath)
  const baseReal = await fs.realpath(path.resolve(basePath))
  const targetReal = await fs.realpath(resolved)
  const rel = path.relative(baseReal, targetReal)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出工作目录范围')
  }
  return targetReal
}
```

**安全保证**：即使工作目录内存在指向外部的符号链接，也无法通过它访问外部文件。

### 9.5 动态解析数据流

`resolveWorkDir` 回调确保切换后立即生效，且数据流完整：

```
switch_work_dir 执行
        │
        ▼
bindSessionWorkDir(db, workDirManager, { sessionId, profileId, remoteContext, source })
        │
        ├── 校验 sensitive
        ├── 去重检查（绑定未变化则返回）
        ├── updateSession(db, sessionId, { workDirProfileId })
        └── writeWorkDirSwitchAudit()
        │
        ▼
下一次工具迭代开始
        │
        ▼
resolveWorkDir() 调用
        │
        ▼
resolveWorkDirForSession() 从数据库读取更新后的 session
        │
        ▼
返回新的 workDir 路径
        │
        ▼
所有后续文件工具使用新 workDir
        │
        ▼
resolveSafePath(newWorkDir, filePath) 进行边界检查
```

**安全保证**：切换后所有文件操作都在新目录的边界内执行。

### 9.6 删除 Profile 后的安全回退

当绑定的 profile 被删除时，`resolveWorkDirForSession` 会安全回退到全局 active profile：

```typescript
if (session.workDirProfileId) {
  const profile = listProfiles().find((p) => p.id === session.workDirProfileId)
  if (profile?.path) {
    return { profileId: profile.id, workDir: profile.path }
  }
}

// 绑定的 profile 不存在时，回退到全局 active
return {
  profileId: getActiveProfileId(),
  workDir: getActiveWorkDir()
}
```

**安全保证**：不会出现无工作目录的情况，始终有有效的路径边界。

### 9.7 残留风险：run_shell 工具

`run_shell` 工具的路径安全依赖于启发式检测（`shellPathAnalysis.ts`），而非硬边界：

| 风险 | 说明 | 当前防护 |
|------|------|---------|
| 任意命令执行 | 用户可执行 `cd / && rm -rf /` 等危险命令 | `shellSecurityHints` 和 `shellPrecheck` 进行启发式检测 |
| 路径逃逸 | 通过 shell 命令访问工作目录之外的文件 | `isOutsideWorkDir` 检查，但非强制阻止 |

**注意**：这是**现有系统的风险**，本方案不增加新风险，也不改进 `run_shell` 的安全机制。

### 9.8 安全结论

| 风险场景 | 是否可利用 | 防护机制 |
|---------|-----------|---------|
| 远程用户切换到工作目录之外的路径 | **否** | Profile 白名单机制 |
| 远程用户读取工作目录之外的文件 | **否** | `resolveSafePath` 硬边界 |
| 远程用户写入工作目录之外的文件 | **否** | `resolveSafePath` 硬边界 |
| 通过符号链接访问外部文件 | **否** | `resolveSafePathReal` 二次校验 |
| 删除绑定的 profile 导致无目录 | **否** | 自动回退到全局 active profile |
| 跨会话干扰 | **否** | 会话级独立绑定 |
| `run_shell` 执行危险命令 | **是（原有风险）** | 启发式检测，非本方案范围 |

---

## 10. IPC 通道设计

无需新增 IPC 通道，复用现有工具执行器机制：

| 通道 | 说明 |
|------|------|
| `claude-chat-create-with-tools` | 远程代理调用，工具定义中包含工作目录工具 |

---

## 11. 测试用例

### 11.1 list_work_dirs 工具

| 用例 | 验证点 |
|------|--------|
| 远程会话调用 | 返回所有工作目录列表 |
| 当前绑定标记 | 正确标记当前会话绑定的目录 |
| 默认目录标记 | 正确标记默认目录 |
| 别名显示 | 显示已配置的别名 |
| 空列表 | 返回空数组（正常情况不应出现） |

### 11.2 switch_work_dir 工具

| 用例 | 验证点 |
|------|--------|
| 通过 ID 切换 | 成功绑定到指定目录 |
| 通过名称切换 | 成功绑定到指定目录 |
| 通过别名切换 | 成功绑定到指定目录 |
| 目录不存在 | 返回错误 |
| 目录路径失效 | 返回错误 |
| 重复切换同一目录 | 成功但不执行实际操作 |
| 无参数 | 返回错误：缺少必要参数 |
| 仅影响当前会话 | 其他会话不受影响 |
| 切换后后续工具使用新目录 | 同一工具循环中，switch_work_dir 后的 read_file/list_directory 等工具使用新绑定的目录 |

### 11.3 桌面端工具不可见

| 用例 | 验证点 |
|------|--------|
| 桌面会话工具列表 | 工作目录工具不在工具定义中（API 过滤层） |
| 桌面 Agent 调用尝试 | 工具不存在，返回错误（工具定义未暴露） |
| 执行器直接调用守卫 | 绕过 API 过滤直接调用执行器，返回错误：`"该工具仅在远程会话中可用"`（执行器层守卫） |

### 11.4 审计日志

| 用例 | 验证点 |
|------|--------|
| 飞书切换审计 | 写入 `workdir_switch` 事件 |
| 微信切换审计 | 写入 `workdir_switch` 事件 |
| 审计内容完整 | 包含 profileId、profileName、时间戳 |

### 11.5 会话隔离

| 用例 | 验证点 |
|------|--------|
| 飞书切换不影响微信 | 微信会话仍使用原目录 |
| 微信切换不影响桌面 | 桌面端仍使用原目录 |
| 桌面切换不影响远程 | 远程会话仍使用绑定的目录 |

### 11.6 安全测试

| 用例 | 验证点 |
|------|--------|
| Profile 白名单验证 | 尝试切换到未配置的路径，返回错误 |
| 路径穿越防护 | 尝试读取 `../` 路径，返回错误 |
| 绝对路径防护 | 尝试使用绝对路径读取文件，返回错误 |
| 符号链接逃逸防护 | 工作目录内的符号链接指向外部，尝试访问返回错误 |
| 删除绑定 Profile 后的回退 | 绑定的 profile 被删除后，自动回退到全局 active profile |
| 回退后路径边界仍有效 | 回退后文件操作仍受 `resolveSafePath` 边界约束 |
| sensitive profile 拒绝 | 尝试切换到 sensitive 目录，返回错误 |
| 执行器层守卫 | 桌面会话直接调用执行器，返回错误：`"该工具仅在远程会话中可用"` |

### 11.7 多匹配消歧测试

| 用例 | 验证点 |
|------|--------|
| name 模糊匹配命中多个 | 返回 `success: false` + `ambiguous` 候选列表 |
| alias 大小写不敏感 | 大小写不同仍能匹配 |
| name 首尾空格 | trim 后匹配 |

### 11.8 飞书入站绑定一致性测试

| 用例 | 验证点 |
|------|--------|
| 飞书入站 `@项目` 后绑定一致 | 入站解析到 profile 后，`list_work_dirs` 显示正确的 `isBound` 状态 |
| 飞书无 `@` 前缀继承绑定 | 后续消息无 `@` 前缀时，使用会话已绑定的目录 |
| 飞书入站与工具切换互覆盖 | 工具切换后覆盖入站解析的绑定，反之亦然 |

### 11.9 ToolsConfig 策略测试

| 用例 | 验证点 |
|------|--------|
| deniedTools 包含工作目录工具 | 工具在远程不可用 |
| deniedTools 不包含工作目录工具 | 工具在远程可用 |

### 11.10 微信远程切换持久性测试

| 用例 | 验证点 |
|------|--------|
| 微信调用 switch_work_dir 切换目录 | 切换成功，返回新目录信息 |
| 微信同会话第二条消息继承绑定 | 切换后同会话第二条消息仍使用绑定的目录 |
| 微信切换后 list_work_dirs 显示正确 | `isBound` 状态正确标记 |
| 微信切换后文件操作使用新目录 | 切换后的 `read_file`、`list_directory` 使用新目录 |

---

## 12. 实施任务拆分

| 序号 | 任务 | 说明 | 优先级 |
|------|------|------|--------|
| T0 | sensitive 字段前置依赖 | 在 `src/shared/feishuTypes.ts` 的 `WorkDirProfile` 中添加 `sensitive?: boolean` 字段；若 multi-workdir 里程碑已完成则跳过 | P1 |
| T1 | 工具定义添加 | 在 `builtinToolDefinitions.ts` 中添加 list_work_dirs 和 switch_work_dir | P0 |
| T2 | 工具执行器实现 | 在 `tools/builtinExecutors.ts` 中实现两个工具的执行逻辑（含多匹配消歧、sensitive 检查、remoteContext 守卫） | P0 |
| T3 | 远程专属过滤 | 在 `toolsConfigRuntime.ts` 的 `filterBuiltinToolsForApi` 中添加远程会话判断 | P0 |
| T4 | toolChatLoop 动态 workDir | 在 `toolChatLoop.ts` 中添加 `resolveWorkDir` 回调参数，每轮工具迭代开头重新解析 workDir | P0 |
| T5 | 远程代理上下文注入 | 在 `feishuRemoteAgent.ts` 和 `weChatRemoteAgent.ts` 的 ctx 类型中添加 `workDirManager`，调用 `runToolChatSession` 时传入 `workDirManager` 和 `resolveWorkDir` 回调 | P0 |
| T5.1 | deps 注入链路 | 在主进程 deps 模块和 `remoteCommandRouter` 中向远程 agent 注入 `WorkDirManager` 实例 | P0 |
| T6 | 飞书入站与 session 绑定对齐 | 修改 `remoteCommandRouter`，入站解析到 profile 时调用 `bindSessionWorkDir` helper（而非裸 `updateSession`） | P0 |
| T7 | bindSessionWorkDir helper | 提取 `bindSessionWorkDir` 统一 helper，包含 sensitive 校验、可写校验、去重审计 | P0 |
| T8 | 审计日志集成 | 提取 `writeWorkDirSwitchAudit` helper，飞书入站解析和工具执行器共用 | P1 |
| T9 | 微信审计事件新增 | 在 `WeChatAuditEvent` 中添加 `workdir_switch` 事件类型 | P1 |
| T10 | 风险等级注册 | 在 `domainTypes.ts` 的 `builtinToolRiskLevel` 和 `builtinToolNeedsConfirmation` 中注册新工具 | P1 |
| T11 | 测试验证 | 编写并运行测试用例（含多匹配消歧、sensitive 拒绝、飞书入站绑定一致性、微信持久绑定） | P0 |

---

## 13. 验收标准

- [ ] `list_work_dirs` 工具可返回所有工作目录列表及当前会话绑定的目录，包含 `isBound`、`isActive`、`isSensitive` 状态
- [ ] `switch_work_dir` 工具支持通过 ID/名称/别名三种方式切换
- [ ] `switch_work_dir` 工具仅影响当前会话，不影响其他会话
- [ ] 工作目录工具仅在远程会话（飞书/微信）中可见
- [ ] 桌面会话中工作目录工具不可见（工具定义过滤 + 执行器层守卫双重防护）
- [ ] 切换操作写入飞书/微信审计日志（仅当绑定实际变化时）
- [ ] 与现有会话级工作目录解析机制完全兼容
- [ ] 切换后同轮工具循环中的后续工具调用使用新绑定的目录
- [ ] 飞书入站 `@项目` 解析后同步持久化到 `session.workDirProfileId`
- [ ] 飞书无 `@` 前缀消息继承会话已绑定的目录
- [ ] 多匹配消歧：模糊匹配命中多个 profile 时返回候选列表
- [ ] sensitive profile 拒绝：尝试切换到敏感目录时返回明确错误
- [ ] 匹配规则与 `feishuWorkDirResolver` 对齐（大小写不敏感、trim）
- [ ] `bindSessionWorkDir` 统一 helper 实现，入站解析与工具切换共用同一逻辑
- [ ] 微信远程切换后同会话第二条消息仍使用绑定的目录（持久绑定）
- [ ] 已绑定 sensitive 会话的远程 Agent 拒绝执行
- [ ] `workDirManager` 成功注入到远程 agent 的 ctx 中

---

**文档结束**