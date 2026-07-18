# Agent 工作产物管理 MVP 技术方案

## 1. 文档目标

本文给出 `docs/requirement/explicit-output-directory-candidate-requirement.md` 的 MVP 技术实现方案，并以当前项目代码为基础约束设计范围。

本方案的核心不是继续增强“按扩展名整理目录”，而是用轻量的成果登记与路径解析替换现有目录重定向逻辑，使系统能够同时处理：

- 正式项目变更；
- 可交付、可核对的工作包；
- 会话级一次性草稿；
- 用户明确指定的精确文件或目录；
- 同一成果的跨轮持续编辑。

MVP 不建设通用资产管理平台，不做复杂自然语言实体识别，不做自动过期、空间配额、自动打包和跨工作目录输出。

### 1.1 工作区基础约束

本方案不改变当前项目的工作区机制。用户仍通过现有工作区功能创建、选择和切换工作空间，会话仍通过 `workDirProfileId` 绑定工作区，远程会话仍使用现有工作区解析与切换流程。

本文后续出现的“根目录”“输出目录”“项目目录”“工作包目录”和“草稿区”，除非特别说明，均以**当前会话绑定工作区的根目录 `workDir`** 为起点：

- Agent 文件工具中的路径仍是相对当前 `workDir` 的路径；
- 项目变更、工作包和会话草稿都只能位于当前 `workDir` 内；
- `.spaceassistant/runs/<session-id>/` 位于当前 `workDir` 下；
- 工作包的 `.materials/` 相对于其主成果生成，但最终仍位于当前 `workDir` 内；
- 切换应用当前激活工作区，不会静默改变一个已绑定会话的产物根目录；新请求仍由现有机制解析会话工作区，但产物 mutation 还必须通过第 6.1 节的严格工作区身份校验；
- 产物管理不新增工作区、切换工作区、修改 `workDirProfileId`，也不提供跨工作区移动或复制能力。

因此，产物管理是现有工作区机制之上的会话内文件归属层，而不是新的工作区或虚拟文件系统。

## 2. 当前实现与主要差距

### 2.1 可复用能力

当前项目已经具备以下基础能力，应直接复用：

| 能力 | 当前实现 | 本方案用途 |
|---|---|---|
| 会话与工作目录绑定 | `electron/workDirBinding.ts`、`workDirManager.ts` | 原样保留现有工作区创建、选择、切换和会话绑定机制；以会话解析出的 `workDir` 作为所有产物的硬边界 |
| 安全读写 | `electron/pathSecurity.ts`、`builtinExecutors.ts` | 复用路径穿越、symlink、普通文件、原子写入和并发修改检查 |
| 文件写入确认 | `toolChatLoop.ts`、`WriteConfirmCard.tsx` | 继续承担写入授权及覆盖确认，不与归属选择混用 |
| 会话持久化 | SQLite `sessions.metadata`、`messages.tool_calls` | 保存轻量会话关联及工具结果 |
| 文件引用与预览 | `DetailPanel/useReferencedFiles.ts`、文件面板 | 打开项目文件、工作包文件和草稿文件 |
| 工具执行互斥 | `checkWritePathConflict`、`claimWritePath` | 防止跨会话并发写同一路径 |
| 远程写入授权 | `remoteWriteGrantRegistry` | 新归属逻辑不能绕过远程授权 |

### 2.2 必须替换的旧行为

现有 `electron/workspaceLayout` 的行为是：

1. 会话首次 `write_file` 前选择一个写入目录；
2. 把该目录保存为会话级 `writeDirChoice`；
3. 对新文件取 basename；
4. 按扩展名映射到 `Script/`、`Docs/`、`Config/` 等子目录；
5. 通过 `tool:redirect` 回写最终路径。

它与新需求存在四个根本冲突：

- 会话级目录会被无关的新成果继承；
- 显式路径会被截断为 basename 后重定向；
- 扩展名被错误地用作文件归属；
- 正式源码、migration、报告材料和临时脚本无法稳定区分。

因此不能在 `redirect.ts` 上继续叠加例外。MVP 应删除工具循环中的扩展名重定向分支，废弃 `writeDirChoice` 的运行语义，以“单次写入声明 + 成果关联”代替。

## 3. 设计原则

1. **路径先于分类**：项目文件和用户逐项指定的文件路径直接使用工具输入路径，归属只影响登记、展示和未指定路径的默认生成。
2. **归属由 Agent 声明、系统校验**：LLM 负责理解任务语义并声明用途；主进程只接受有限枚举并执行确定性校验，不在主进程再做一套脆弱的自然语言分类器。
3. **已有文件保持原位**：`edit_file` 以及覆盖已有文件的 `write_file` 不做自动迁移，默认沿用已登记归属或记为项目变更。
4. **系统只为 scratch 和未指定路径的材料分配路径**：正式项目文件绝不自动改目录；工作包材料只在没有显式路径时推导 `.materials/`。
5. **数据库保存业务关系，文件系统保存文件**：不建设完整 artifact manifest。SQLite 是归属、关联、来源和清理状态的唯一业务数据源。
6. **确认职责分离**：归属/路径歧义确认在解析阶段完成；写入授权、敏感路径及覆盖确认继续走既有确认链。
7. **失败不降级**：解析、建目录、Git 选择或写入失败时返回错误，不回退项目根目录。
8. **工作区机制不变**：ArtifactResolver 只消费现有机制解析出的 `workDir`，不得选择、切换或重绑工作区；本文所有相对路径均相对该根目录。
9. **产物身份不可漂移**：产物记录保存创建时的 Profile 与工作区真实根路径。Profile 缺失或路径变化时拒绝产物修改、删除和改址，绝不回退到 active workspace 解释旧路径。

## 4. 总体流程

```text
用户消息与已有成果关联
        ↓
LLM 调用 write_file / edit_file，并声明 artifact 元数据
        ↓
ArtifactResolver 校验归属、成果关联、路径类型和 workDir 边界
        ↓
必要时发起一次归属/路径/Git 选择
        ↓
得到唯一 finalPath，回写工具调用记录
        ↓
既有写入确认与远程授权
        ↓
builtin executor 安全写入
        ↓
ArtifactRepository 登记结果并发送 artifact:changed
        ↓
聊天工具卡片、工作产物面板、完成摘要使用同一份记录
```

路径解析必须发生在写入确认之前，这样确认卡展示的是最终路径；产物登记只在实际写入成功后提交，避免留下幽灵记录。

## 5. 数据模型

### 5.1 工具声明

在 `write_file` 和 `edit_file` 输入中增加可选 `artifact` 对象：

```ts
type ArtifactContainer = 'project' | 'package' | 'scratch'
type ArtifactRole = 'primary' | 'supporting' | 'reference' | 'scratch'
type PrimaryStage = 'working' | 'draft' | 'final'
type ArtifactPathSource =
  | 'user'
  | 'user-decision'
  | 'project-convention'
  | 'agent-default'
  | 'system-assigned'

type ArtifactPathProvenance =
  | { pathSource: 'user'; pathEvidenceId: string; pathDecisionId?: never }
  | { pathSource: 'user-decision'; pathDecisionId: string; pathEvidenceId?: never }
  | { pathSource: 'project-convention'; pathEvidenceId?: never; pathDecisionId?: never }
  | { pathSource: 'agent-default'; pathEvidenceId?: never; pathDecisionId?: never }
  | { pathSource: 'system-assigned'; pathEvidenceId?: never; pathDecisionId?: never }

type DeclaredArtifactPathProvenance = Extract<
  ArtifactPathProvenance,
  { pathSource: 'user' | 'project-convention' | 'agent-default' }
>

interface ArtifactWriteIntentBase {
  container: ArtifactContainer
  role: ArtifactRole
  artifactId?: string       // 继续编辑已有成果时填写
  packageId?: string        // supporting/reference 关联工作包时填写
  title?: string            // 首次创建主成果的短标题
  stage?: PrimaryStage      // 仅 primary 有效
  requestedPath?: string    // 用户逐项指定的原始路径；用于审计，不参与二次拼接
  pathKind?: 'file' | 'directory' | 'auto' // 缺省 auto；是路径类型协议的唯一字段
  materialKind?: 'query' | 'script' | 'note' | 'data' | 'other'
  temporaryReason?: string  // scratch 必填，说明为何可删除
}

type ArtifactWriteIntent = ArtifactWriteIntentBase & DeclaredArtifactPathProvenance
```

约束如下：

- `project` 只允许 `primary`，表示项目最终状态中的正式文件；此处的 primary 是“正式项目文件”，不是工作包主成果；
- `package` 允许 `primary`、`supporting`、`reference`；
- `scratch` 通常只允许 `scratch`；唯一例外是尚未建立工作包、且用户明确同意暂存的待决定资料，此时允许 `reference`；
- `reference` 的来源信息在下载或保存成功后通过单独的登记接口补充；
- 已有 `artifactId` 时，以数据库中的规范路径和归属为准，禁止工具调用悄悄改址；
- `pathKind` 缺省为 `auto`，只位于 `artifact` 对象内；`write_file`、`edit_file` 的顶层不再定义同名字段；
- `edit_file` 对已有成果只允许最终解析为 `file`；目录语义仅用于 `write_file` 创建主成果或材料时由 resolver 补全文件名，不能把目录传给底层 executor；
- `ArtifactPathSource` 是 intent 解析、resolver、repository、工具结果和持久化共用的唯一来源枚举；
- `ArtifactPathProvenance` 必须保持“每个 `pathSource` 一个顶层联合成员”，不能把多个来源合并进同一对象属性；这样 `Extract` 才会按来源正确分配，TypeScript 类型与 JSON Schema 的 `oneOf` 分支也能逐项对应；
- Agent 工具 JSON Schema 使用 `DeclaredArtifactPathProvenance` 对应的 `oneOf`，不包含主进程专用的 `user-decision`、`system-assigned` 分支；`pathSource=user` 时必须提供有效 `pathEvidenceId`，不能仅凭模型自报的 `requestedPath` 获得显式路径优先级；
- `user-decision` 只能由主进程在验证并消费当前 registry 中的 decision 后构造，必须携带 `pathDecisionId` 且不得携带 `pathEvidenceId`；其他来源不得携带两种 provenance ID；
- 缺少声明时采用保守兼容规则：修改已有文件记为 `project`；新文件不再按扩展名重定向。灰度期可允许写入但不创建 artifact 记录，工具结果单独标记 `unclassified` 并提示 Agent 重试声明；正式启用后新文件必须声明。`unclassified` 不是 `ArtifactContainer` 的第四种值。

不新增 `create_artifact` 工具。成果声明直接附着于文件写工具，可减少一次模型往返，也避免“登记成功但文件未写入”的中间状态。

### 5.2 SQLite 表

新增三张表，数据库 schema version 升级并引入正式 migration runner：

```sql
CREATE TABLE session_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  work_dir_profile_id TEXT NOT NULL,
  workspace_root_real TEXT NOT NULL,
  package_id TEXT,
  container TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  stage TEXT,
  canonical_path TEXT NOT NULL,
  path_identity_key TEXT NOT NULL,
  requested_path TEXT,
  path_source TEXT NOT NULL,
  path_evidence_id TEXT,
  path_decision_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (path_source = 'user' AND path_evidence_id IS NOT NULL AND path_decision_id IS NULL) OR
    (path_source = 'user-decision' AND path_evidence_id IS NULL AND path_decision_id IS NOT NULL) OR
    (path_source IN ('project-convention', 'agent-default', 'system-assigned')
      AND path_evidence_id IS NULL AND path_decision_id IS NULL)
  )
);

CREATE TABLE artifact_references (
  artifact_id TEXT PRIMARY KEY NOT NULL REFERENCES session_artifacts(id) ON DELETE CASCADE,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  access_note TEXT,
  license_note TEXT
);

CREATE TABLE artifact_operations (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES session_artifacts(id),
  operation TEXT NOT NULL,
  move_mode TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  temp_path TEXT,
  target_existed INTEGER NOT NULL DEFAULT 0,
  target_backup_path TEXT,
  target_backup_identity TEXT,
  target_original_identity TEXT,
  target_original_size INTEGER,
  target_original_digest TEXT,
  expected_size INTEGER,
  expected_digest TEXT,
  temp_identity TEXT,
  phase TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_artifacts_active_path
  ON session_artifacts(session_id, path_identity_key)
  WHERE status = 'active';

CREATE INDEX idx_artifacts_session_container
  ON session_artifacts(session_id, container, status);
CREATE INDEX idx_artifacts_package
  ON session_artifacts(package_id, role, status);
```

说明：

- `package_id` 直接指向同表中 `role=primary` 的记录。SQLite 不增加自引用外键，避免主成果移动、删除时产生复杂级联；在 repository 层校验即可。
- `workspace_root_real` 是主进程从当前会话工作区 `realpath` 得到的不可由 Agent 或 renderer 提供的根快照；它只用于防止身份漂移，不用于跨工作区自动寻找文件。
- `canonical_path` 存相对 `workDir`、统一 `/` 的展示路径；`path_identity_key` 由主进程按当前平台生成，用于锁和 active 唯一性。Windows 统一分隔符、大小写并拒绝设备名及尾随点/空格别名；POSIX 对已存在路径使用 realpath identity，对不存在路径使用规范化词法 identity。不能用展示路径直接做文件身份比较。
- `path_source/path_evidence_id/path_decision_id` 通过 CHECK 保持与 `ArtifactPathProvenance` 一致；repository 在写库前还要验证 evidence 或 decision 确实属于当前 request/session/toolUseId，数据库约束只负责防止非法字段组合。
- `status` 仅取 `active | deleted`。partial unique index 只约束 active 记录；删除后可以在原路径建立新的 artifact。移动直接更新同一 active 记录的路径，因此提交后原路径同样释放。
- relocate 的 artifactId 保持稳定：移动并切换更新同一记录的路径，历史由 operation journal 保留；复制操作创建新的 artifactId，原记录保持 active。`artifact_operations` 仅保存移动/复制恢复所需的最小 journal，不扩展为通用文件事务框架。`recovery_required` 是 operation phase，不把路径身份不确定的 artifact 从 active 唯一约束中移除。
- `artifact_operations.artifact_id` 使用默认 RESTRICT，不级联删除恢复 journal。artifact 或 session 删除前必须确认不存在非终态 operation；终态 operation 可在同一删除事务中显式清理后再删除 artifact。
- “使用中”状态只由主进程内存 registry 管理，不落库；应用重启后不存在仍在执行的旧请求，无需恢复锁状态。
- 成果级默认目录仍保存在 `sessions.metadata.artifactDefaultDir`，只有用户明确说“后续都输出到”时写入。旧 `writeDirChoice` 不迁移到该字段，防止旧会话目录被误当成用户的新默认。

### 5.3 数据库迁移机制

当前 `sqliteStore.initSchema()` 只执行 `CREATE_TABLES_SQL`，已有 `schema_version` 不会升级，不能承载本次变更。先新增 `runMigrations(conn)`：

1. 新数据库先建立 `schema_meta`，版本视为 0；已有数据库读取并严格解析版本；
2. 数据库版本高于应用支持版本时拒绝打开并给出升级应用提示；
3. 在一个 SQLite transaction 中，按 `v1 -> v2 -> ...` 顺序执行每个 migration；
4. 每个 migration 完成后立即在同一 transaction 内更新 `schema_meta.schema_version`，供后续 migration 判断前置版本；transaction 未提交前这些更新对外不可见；
5. 任一步骤失败则整个 transaction 回滚，数据库版本和 DDL 均保持原状；
6. migration 完成后再执行当前版本的 `CREATE_TABLES_SQL` 作为新库初始化与结构兜底，但不能用它替代版本迁移。

本功能作为 v2 migration 创建上述三张表和索引。必须测试全新数据库、v1 升级、重复启动、migration 中途异常回滚及高版本数据库拒绝打开。

### 5.4 不引入完整 manifest

需求示意中的 `.spaceassistant/runs/<session-id>/index.json` 在 MVP 中只作为可选的文件系统说明文件，不作为状态源。为避免数据库和 JSON 双写不一致，首版不生成它；“本会话草稿文件/研究资料”入口直接查询 SQLite。若后续需要工作目录可移植性，再单独设计 manifest 导入导出。

## 6. 路径解析

新增 `electron/artifacts/artifactResolver.ts`。调用方必须先通过现有会话工作区解析逻辑取得 `workDir`，再将它连同工具名、工具路径、声明、会话、当前请求的用户消息和已有成果传给 resolver。resolver 不读取“当前激活工作区”作为替代值，也不执行工作区切换或会话重绑。输出为：

```ts
interface ResolvedArtifactWriteBase {
  artifactId: string
  packageId?: string
  container: ArtifactContainer
  role: ArtifactRole
  requestedPath: string
  finalPath: string
  pathKind: 'file' | 'directory'
  reason: string
  existed: boolean
  needsDecision?: ArtifactDecisionRequest
}

type ResolvedArtifactWrite = ResolvedArtifactWriteBase & ArtifactPathProvenance
```

### 6.1 通用校验顺序

1. 通过 `resolveArtifactWorkspaceStrict()` 固定本次操作的工作区身份；
2. 校验声明枚举组合和用户路径证据；
3. 若给出 `artifactId`，读取已有记录并校验属于当前 session 和同一工作区身份；
4. 判定输入路径是文件还是目录；
5. 生成候选最终路径；
6. 调用增强后的 `resolveSafeWriteTarget` 校验词法边界、已存在父目录、symlink/junction 和目标类型；
7. 检查首次覆盖冲突；
8. 使用 `path_identity_key` 检查成果规范路径冲突；
9. 返回唯一 `finalPath` 或决策请求。

`resolveArtifactWorkspaceStrict()` 不修改现有 `resolveWorkDirForSession()`，也不改变工作区 UI 行为。它专用于 artifact 创建后的写入、删除、清理和改址：session 必须存在且 `workDirProfileId` 非空，Profile 必须仍存在；当前 Profile path 的 realpath 必须与 artifact 的 `workspace_root_real` 相同；否则返回 `ARTIFACT_WORKSPACE_UNAVAILABLE` 或 `ARTIFACT_WORKSPACE_CHANGED`。绝不使用 active profile fallback。对于尚未绑定 Profile 的历史 session，首次启用产物功能时按现有解析结果显式写回其 `workDirProfileId`，之后再创建 artifact；若无法绑定则拒绝创建。

这不会禁止用户在现有工作区设置中删除 Profile 或修改路径，只会使指向旧根的 artifact 进入不可操作状态并提示恢复原 Profile/路径或手动处理。它避免为本功能改变基础工作区管理机制。

所有 `requestedPath`、`finalPath` 和 `canonical_path` 都是相对严格解析出的 `workDir` 的路径。只在安全校验和实际文件操作期间生成绝对路径，绝对根只能来自主进程。请求开始时捕获 `{profileId, workspaceRootReal}`，每次 destructive mutation 和实际写入前再次比较；变化时拒绝，不把路径重新解释到另一个工作区。

### 6.2 文件与目录判定

新增 `resolveOutputPathKind()`，严格按需求中的顺序处理：

- 使用 `ArtifactWriteIntent.pathKind`；缺省或 `auto` 时由 resolver 判定，Agent 依据用户的“文件/目录/保存为”等措辞填写明确值；
- 目标已存在时以 `lstat` 结果为准，声明冲突直接报错；
- 不存在且原始输入以 `/` 或 `\\` 结尾时判为目录。必须在任何 normalize 之前保留尾随分隔符；
- 项目约定或用户语义唯一时由 `pathKind` 明确表达；
- `auto` 且两种解释均合理时，发起文件/目录选择。

明确声明与已有目标类型冲突时返回稳定错误码 `ARTIFACT_PATH_TYPE_CONFLICT`，不进入写入确认。`path-type` decision 返回 `{ pathKind: 'file' | 'directory' }` 后，registry 用原 `requestId + toolUseId` 唤醒同一次工具调用，resolver 以该可信选择重新执行；不要求模型重发工具参数。最终 `pathKind` 写入 `ResolvedArtifactWrite` 和工具结果 metadata，便于 UI 与审计保持一致。

不能以扩展名、有无点号判断路径类型。目录输出确定后，主成果文件名依次取：用户指明名称、`title` 生成的安全 slug、任务类型默认名。自动命名必须在确认卡和写入卡中展示；同名时不自动追加 `(1)`。

### 6.3 三类容器的路径策略

**项目变更**

- `path` 必须是项目约定或用户明确要求的精确相对路径；
- 不做任何目录重定向；
- 新建和修改均登记为项目变更；
- 已存在文件优先沿用既有 artifact 记录，否则创建项目记录。

**工作包主成果**

- 显式文件路径按字面使用；
- 显式目录路径只在目录内补主成果文件名；
- 没有位置时发送工作包位置选择，不创建临时主成果；
- 继续编辑已有 `artifactId` 时直接使用 `canonical_path`，不重复选择和覆盖确认。

**工作包材料**

- `pathSource=user` 时按 `path` 字面使用；
- 未显式指定路径且存在 `packageId` 时，由主成果 `dir/baseName.materials/` 推导；
- 单一材料默认平铺；当同一包已有不同角色或同名风险时才创建 `supporting/`、`references/`，`materialKind` 仅用于可选的 `queries/`、`scripts/`、`notes/`；
- 没有 `packageId` 的 supporting 视为归属歧义，不自动建立匿名工作包。

**会话草稿**

- 忽略 Agent 提议的目录，只接受安全文件名或用途名；
- 系统分配到 `.spaceassistant/runs/<session-id>/<kind>/<filename>`；
- kind 只取 `scripts | data | cache | pending-references`；
- 普通 scratch 不能使用 `pending-references`，该目录仅用于用户同意暂存但尚未关联工作包的资料；
- 同名不覆盖：同一 `artifactId` 继续使用原路径；新草稿冲突时使用短 toolUseId 后缀，且最终路径必须展示。

### 6.4 用户显式路径证据

不能把 `pathSource=user` 的真实性交给模型。新增 `explicitPathEvidence.ts`，在原始用户消息进入模型前生成只读证据：

```ts
interface ExplicitPathEvidence {
  id: string                 // messageId + span 起止位置的稳定摘要
  messageId: string
  raw: string                // 原始 span，保留尾随分隔符
  normalizedCandidate: string
  hintedKind: 'file' | 'directory' | 'unknown'
  intent: 'output-target' | 'referenced-input' | 'unknown'
  start: number
  end: number
}
```

提取器采用保守规则，只识别反引号/引号包裹路径、绝对或含分隔符的相对路径，以及紧邻“文件/目录/文件夹/保存为”等关键词的单段名称。它还根据邻近的“输出到、保存为、写入、更新、修改”等动作标记 `output-target`，根据“参考、读取、基于、检查”等动作标记 `referenced-input`；无法可靠判断则为 `unknown`。它不靠扩展名判断类型。证据随原始 messageId 保存在本次 request context，并以编号列表注入工具提示；模型只能引用 `pathEvidenceId`，不能创建证据。

resolver 接受 `pathSource=user` 的条件是：证据属于当前请求可见的用户消息、`intent=output-target`，且工具 `path`、`requestedPath` 与证据候选在当前平台规范化后匹配。`referenced-input` 绝不能作为输出位置；`unknown` 只有经过用户 decision 后才能升级为可信输出位置。多个候选分别保留独立 evidenceId；模型无法关联成果时触发 decision，不能把某一个变成全会话默认。若用户确实给出输出路径但模型漏报，主进程不尝试猜测成果映射：对新 package/scratch 写入发现未消费的强 `output-target` 证据时，返回 `ARTIFACT_EXPLICIT_PATH_UNRESOLVED` 并让模型带 evidenceId 重试；项目约定路径和用户提到的输入文件不因此阻塞。

该机制只保证保守识别到的证据不可伪造，不承诺理解任意自然语言。未被提取器识别、且系统无法唯一判断的路径仍通过位置 decision 由用户确认。

主进程据此保证：

- `finalPath` 与合法的文件级 `requestedPath` 规范化后完全相等；
- 目录级路径只允许追加已展示的主文件名；
- 安全拒绝时不改写为工作目录内的同名文件；
- `requestedPath`、工具 `path` 和 `pathEvidenceId` 不一致时拒绝，防止模型伪造 user source 或声明与实际写入脱节。

### 6.5 改址的可恢复状态机

已有成果改址不通过普通 `write_file` 隐式完成。新增 `artifact:relocate` IPC，用户在 UI 中选择：移动并切换、复制并切换、仅设置未来默认。

移动/复制不能假设 SQLite transaction 可以回滚文件系统。`RelocateService` 使用 `artifact_operations` journal，并区分 `same-device-move | cross-device-move | copy`。phase 只允许单调前进：

```text
prepared
  → backup_committed（目标原先存在时）
  → target_committed
  → source_cleanup_pending（仅 cross-device-move，且 artifact 已提交）
  → cleanup_pending（artifact 已提交，待删除备份/临时文件）
  → completed

任一未提交 artifact 的阶段可补偿为 rolled_back；
无法安全前进或补偿时进入 recovery_required。
```

具体顺序如下：

1. 完整解析新路径并完成冲突决策后，在 DB transaction 中创建 `prepared` journal，记录 source/target、模式、新内容大小/摘要，以及旧目标是否存在、identity、大小和摘要。operationId 确定后，同时预先记录目标同目录下唯一的 `target_backup_path`（需要覆盖时）和 `temp_path`；未获覆盖批准时不创建 operation。
2. 获取第 11 节的 source/target 排他 lease，再次执行严格工作区、source identity、target identity 和安全路径校验。
3. 若目标已存在，在**目标同目录、同文件系统**按 journal 中的路径用 `O_CREAT | O_EXCL` 创建受控备份名 `.<basename>.spaceassistant-<operationId>.bak`，复制、fsync 并核对旧目标 identity/大小/摘要，随后持久化 `target_backup_identity` 和 `phase=backup_committed`。备份名由系统生成，不接受 Agent/renderer 输入；如果预定路径已存在，将本 operation 标为 `rolled_back` 并以新 operationId 重新开始，绝不覆盖该文件。若在备份创建与 phase 更新之间崩溃，`prepared` 恢复逻辑根据预存路径和 identity/摘要识别完整或部分备份。
4. 对 copy/cross-device-move，将 source 复制到 journal 预存的目标同目录受控临时文件，fsync、核对新内容摘要并记录 `temp_identity`，再以现有安全原子替换能力提交到 target。对 same-device-move，在备份已提交并再次核对旧 target identity 后，以平台安全替换方式将 source rename 到 target；若平台不能直接替换，允许先删除已备份且 identity 未变的旧 target 再 rename。目标提交后写 `phase=target_committed`。崩溃发生在删除旧 target 与提交新 target 之间时，backup 仍是旧目标的可恢复副本。
5. 在一个 DB transaction 中更新 artifact：move 更新原 artifactId，copy 创建新 artifactId。same-device-move 和 copy 同步将 operation 置为 `cleanup_pending`；cross-device-move 同步置为 `source_cleanup_pending`。不能先标记 `completed`。
6. cross-device-move 在 `source_cleanup_pending` 阶段按 source identity 删除源文件，成功后进入 `cleanup_pending`。失败或崩溃时 artifact 已规范指向 target，恢复流程只做幂等前向清理，不回滚到 source。
7. `cleanup_pending` 仅在路径和记录的 backup/temp identity 匹配时删除受控临时文件和旧目标备份；全部成功后才进入 `completed`。备份清理失败不影响规范路径，但必须保留 journal 并在后续启动或用户重试时继续清理。

在 artifact DB commit 之前失败或取消时执行逆向补偿：验证 identity 后，把新 target 恢复为 source（same-device-move）或删除新 target（copy/cross-device-move），再把 backup 原子恢复为旧 target。只有 source、新 target、backup identity 与 journal 一致时才自动补偿；任何不一致都进入 `recovery_required`，保留所有文件并在 UI 展示位置，不猜测哪一份应删除。覆盖授权只批准最终替换，不扩大为失败时丢弃旧目标，因此旧目标备份必须保留到 `cleanup_pending` 完成。

应用启动时扫描所有非终态 operation，并在拿到相同 leases、通过严格工作区校验后恢复：

- `prepared/backup_committed`：检查 source、target、backup 和临时文件；未提交 target 时补偿，已匹配新摘要则提升为 `target_committed`；
- `target_committed`：若 artifact 尚未提交，优先重放 DB commit；无法提交才按 identity 补偿；
- `source_cleanup_pending`：只重试源删除并前进；
- `cleanup_pending`：只清理 backup/temp 并完成；
- `recovery_required`：不自动删除，由用户触发“重试恢复”或手动处理后确认。

所有恢复动作必须幂等。MVP 不把该 journal 用于普通文件写入。

## 7. 归属判定与提示词

在工具系统提示中加入短规则表，而不是把整份需求塞入 prompt：

1. 实现、修复、测试、配置和 migration 使用 `project`；
2. 用户阅读或交付的报告、CSV、草稿使用 `package/primary`；
3. 可核对 SQL、脚本、口径和资料使用 `package/supporting|reference`；
4. 缓存、失败尝试、一次性验证输入使用 `scratch`；
5. 用户明确路径必须原样放入 `path` 并标记 `pathSource=user`；
6. 继续同一成果时复用系统提供的 `artifactId`；
7. 归属确实有两个高影响合理选项时，先调用轻量决策，不自行猜测。

每轮构造 LLM 上下文时仅注入当前会话最近活跃成果摘要，最多 20 条：`artifactId、title、container/role、stage、canonicalPath、packageId`。这样“继续完善”“改第三节”可由模型匹配已有成果，又不会把最后一个目录当作全会话默认。

MVP 不实现通用语义向量匹配。若模型无法唯一匹配成果，发送成果选择卡；用户选择结果只作用于本轮目标。

## 8. 决策与确认机制

新增统一的 `ArtifactDecisionRegistry`，复用当前 `writeDirConfirmRegistry` 的 request/session 等待模式，但请求类型为判别联合：

```ts
interface ArtifactDecisionBase {
  decisionId: string
  requestId: string
  sessionId: string
  toolUseId: string
  attempt: number
}

type ArtifactDecisionRequest = ArtifactDecisionBase & (
  | { kind: 'output-location'; artifactDraftId: string; suggestedName: string }
  | { kind: 'path-type'; rawPath: string }
  | { kind: 'ownership'; groupKey: string; options: ('project' | 'package' | 'scratch')[] }
  | { kind: 'overwrite'; finalPath: string; unrelatedArtifactId?: string }
  | { kind: 'reference-retention'; options: ('long-term' | 'pending' | 'cancel')[] }
  | { kind: 'git-ignore'; workDirProfileId: string }
)

type ArtifactDecisionResponse = ArtifactDecisionBase & (
  | { kind: 'path-type'; pathKind: 'file' | 'directory' }
  | { kind: 'output-location'; path: string }
  | { kind: 'ownership'; container: 'project' | 'package' | 'scratch' }
  | { kind: 'overwrite'; action: 'overwrite' | 'cancel' }
  | { kind: 'overwrite'; action: 'rename'; newName: string }
  | { kind: 'overwrite'; action: 'change-directory'; newDirectory: string }
  | { kind: 'reference-retention'; action: 'long-term' | 'pending' | 'cancel' }
  | { kind: 'git-ignore'; action: 'add-ignore' | 'keep-visible' | 'cancel' }
)
```

同一请求中相同 `groupKey` 的归属选择复用一次结果。registry 必须在请求取消、会话删除、窗口关闭和 5 分钟超时后清理。

`rename` 的 `newName` 必须是单一文件名，不能含路径分隔符，并保留当前候选目录；`change-directory` 的 `newDirectory` 是相对当前严格工作区根的目录，并保留当前候选文件名。两者均属于用户在可信 decision 中给出的新路径意图，resolver 将 `pathSource` 记为 `user-decision`，并把已验证的 `decisionId` 写入 `pathDecisionId`，但不能复用旧 finalPath 的证据或覆盖批准。它必须从路径类型、工作区边界、真实路径、active identity 冲突到覆盖检查完整重跑；若新位置再次冲突，以同一 `requestId + toolUseId`、新的 `decisionId` 和递增 `attempt` 再次发起 overwrite decision，直到得到唯一位置、取消或超时。

registry 对 decision 采用一次性消费：只有状态为 pending 且 request/session/toolUseId/attempt 全部匹配的 `decisionId` 才能生成 `user-decision` provenance；消费后重复响应返回 `ARTIFACT_DECISION_ALREADY_CONSUMED`，伪造、过期或跨工具 ID 返回 `ARTIFACT_DECISION_INVALID`。Agent 工具输入若直接出现 `pathSource=user-decision` 或 `pathDecisionId`，在 JSON Schema 层拒绝，不能到达 resolver。

桌面端在“改名/改目录”选项内直接提供输入框。远程 IM 使用带值回复，例如 `2 review-v2.md` 或 `3 reports/final/`；解析失败只重发当前 decision 帮助，不创建文件。renderer 或远程 adapter 只能回传当前 registry 中存在的 decisionId，主进程校验 request/session/toolUseId 全部一致后才接受。

决策完成后才进入既有文件写入确认：

- 决策卡回答“写到哪里/属于什么”；
- `WriteConfirmCard` 回答“是否允许本次写入”；
- 已有成果的正常持续编辑仍遵循当前读后写和 auto-approve 策略，不额外弹目录卡；
- 首次覆盖无关文件即使 auto-approve 满足，也必须先经过 overwrite 决策。

远程 IM 首版使用文本化的同一决策 payload，经现有 confirm manager 返回编号选择；不能因远程通道缺少桌面卡片而跳过决策。

## 9. Git 忽略策略

新增工作区级配置，作用域仍使用现有 `workDirProfileId`，不引入新的工作区标识：

```ts
type ScratchGitPolicy = 'add-ignore' | 'keep-visible' | null
// configs key: artifact.scratchGitPolicy.<workDirProfileId>
```

首次实际创建 scratch 或 pending reference 前：

1. 以当前会话解析出的 `workDir` 为边界判定 Git 工作区；若 Git 仓库根位于 `workDir` 外，MVP 不修改外部 `.gitignore`，改为提示继续但不忽略或取消；
2. 检查 `.gitignore` 是否已覆盖 `.spaceassistant/runs/`；
3. 已覆盖则直接创建；
4. 未覆盖且没有已保存选择则显示三选一；
5. `add-ignore` 仅向工作区根 `.gitignore` 追加精确行 `.spaceassistant/runs/`，并继续走正常写入确认；
6. `keep-visible` 保存 workspace 选择并显示未跟踪提示；
7. 取消则本次写入失败，不在其他位置创建。

检查规则只需支持 Git 常用的精确目录规则及前导 `/` 形式；复杂 negate 规则可通过 `git check-ignore`（若 Git 可用）得到最终判定。修改 `.gitignore` 后重新检查，若外部改动使规则失效则清空保存选择并再次询问。

## 10. 研究资料

普通网页检索和短摘要不触发任何本地文件逻辑。只有工具准备把资料写入工作目录时才进入 artifact 流程。

- 有工作包：声明 `package/reference + packageId`，显式路径优先，否则写入 `.materials`；
- 无工作包但用户明确要求保留：触发 `reference-retention`；
- 选择长期保存：再选择工作目录内路径，创建普通 `package/reference` 记录，可暂时没有 packageId；
- 选择会话暂存：保存到 `pending-references/`，记录仍使用 `container=scratch, role=reference`，UI 与普通 scratch 分组展示；
- 选择取消：不下载、不落盘；
- Agent 主动建议为持续研究暂存时，也必须先走同一选择。

资料保存成功后调用内部 `registerReferenceMetadata()` 写入标题、URL、获取时间和许可说明。缺少标题或 URL 时资料写入视为未完成，工具结果提示补登记；本地文件不删除，以免破坏已完成下载。

## 11. 使用中保护、清理与提升归属

新增单一的 `ArtifactPathLeaseRegistry`，key 为 `workspace_root_real + path_identity_key`，替代 artifact 路径上“先检查再操作”的用法：

- 同一个同步临界区内提供 `acquireUse()`、`acquireWrite()` 和 `claimDelete()`；状态转换不跨 `await`；
- use lease 可共享，write/delete lease 排他。存在 use/write lease 时 `claimDelete()` 原子失败；存在 delete tombstone 时新的 use/write acquire 原子失败；
- `read_file`、`write_file`、`edit_file`、`run_script` 和明确引用该路径的 `run_shell` 在任何文件访问前 acquire，finally 中 release；清理必须先拿到 delete claim，随后才再次校验工作区和路径并删除，finally 释放 tombstone；
- source/target relocate lease 按 identity key 排序后一次性申请，避免双路径操作死锁；
- 将现有 `checkWritePathConflict` / `claimWritePath` 的写冲突职责收进该 registry。迁移完成后 artifact 路径不再同时持有两套锁，因此没有双 registry 锁顺序问题；未纳入 artifact 管理的兼容写入暂时继续使用旧 registry；
- shell 命令无法可靠解析所有间接依赖，MVP 只保护工具显式 path、脚本入口和本轮 ArtifactResolver 标记的依赖；UI 文案不承诺识别任意 shell 内部访问；
- 单文件删除拿不到 delete claim 时拒绝；整会话清理逐项 claim，跳过使用中项并返回原因；
- 普通草稿清理默认排除 `role=reference` 的待决定资料；清理资料必须独立勾选；
- 文件删除成功后更新 `status=deleted`，文件不存在时幂等标记 deleted；安全校验失败则不改数据库。

“保留到工作包/转为项目文件”使用同一个 `artifact:relocate` 服务：

- 移动并切换：安全移动文件并更新唯一规范路径和归属；
- 复制并继续原文件：新建第二条 artifact 记录，旧记录仍是当前编辑对象；
- 复制并切换副本：新建记录并把当前成果关联切到新记录；
- UI 必须明确显示当前编辑对象，不能只显示“已复制”。

具体移动、跨设备 fallback 和异常恢复统一遵循第 6.5 节状态机，本节不再定义另一套顺序。

## 12. 前端与 IPC 改造

### 12.1 IPC

在 `src/shared/api.ts` 和 `preload.ts` 增加：

- `artifact:list({ sessionId })`；
- `artifact:decision-response(...)`；
- `artifact:delete(...)`、`artifact:clean-session(...)`；
- `artifact:relocate(...)`；
- `artifact:set-default-dir(...)`；
- `artifact:changed` 事件；
- `artifact:open` 继续复用现有文件预览/文件夹打开能力，不新增实际打开实现。

所有 mutation IPC 先读取 session、artifact 和 Profile，再调用 `resolveArtifactWorkspaceStrict()`；不得直接采用 `resolveWorkDirForSession` 的 active fallback。不接受 renderer 提供工作区根路径或要求切换工作区；传入 artifactId 后从数据库取 `canonicalPath`、`workspace_root_real` 和 identity，防止伪造路径或 Profile 漂移后删除其他工作区文件。

### 12.2 工具结果

扩展持久化工具结果或 tool call metadata：

```ts
interface ArtifactToolResultMetaBase {
  artifactId: string
  container: ArtifactContainer
  role: ArtifactRole
  requestedPath?: string
  finalPath: string
  pathKind: 'file' | 'directory'
  reason: string
  packageId?: string
  stage?: PrimaryStage
}

type ArtifactToolResultMeta = ArtifactToolResultMetaBase & ArtifactPathProvenance
```

`tool:redirect` 改名为更准确的 `tool:path-resolved`，仅用于系统确实分配路径的 scratch、目录级主成果和默认材料；显式文件路径的 `requestedPath` 与 `finalPath` 相同。渲染进程继续将 `input.path` 更新为 finalPath，保证右侧引用文件可打开。

`WriteSuccessCard` 增加紧邻展示的归属 badge、用途和相对路径，例如“项目变更 · `src/auth.ts`”或“支撑材料 · `report.materials/query.sql`”。

### 12.3 本会话工作产物面板

在现有 DetailPanel 增加“本会话工作产物”，按数据库记录分组：

- 项目变更；
- 工作包，按 packageId 展开主成果、支撑材料和资料；
- 草稿文件；
- 本会话研究资料。

项目和主成果默认展开，草稿默认折叠。每项支持打开；scratch 支持删除、保留到工作包、转为项目文件。现有“引用文件”仍保留，避免把所有读过的文件错误登记为产物。

### 12.4 完成摘要

不要依赖模型自行完整罗列。每个 request 开始时记录 artifact change cursor，结束时由主进程生成结构化摘要数据并注入完成事件：

- 本轮新增/修改的项目文件；
- 工作包主成果及 stage；
- 支撑材料和研究资料数量；
- 草稿文件数量及入口。

模型正文可自由总结，但 UI 固定摘要以实际成功写入记录为准。

## 13. 旧功能迁移

### 13.1 配置与 UI

- 移除设置页中的扩展名映射表和“首次写入目录确认”；
- 将原“目录规范”入口改为“工作产物”，MVP 只保留功能总开关、草稿 Git 策略状态和说明；
- 保留读取旧 `config.workspaceLayout` 的兼容代码一个版本，但不再执行重定向；保存新配置后可删除旧字段；
- 删除 `WriteDirConfirmPanel`、候选目录收集和会话 chip；工作包位置选择使用新的 ArtifactDecisionCard。

### 13.2 旧会话

- 不把 `sessions.metadata.writeDirChoice` 迁移为成果默认目录；
- 历史 tool call 仍按原路径正常展示；
- 只对新写入建立 artifact 记录，不扫描全仓库反推历史归属；
- 可在读取 session metadata 时忽略旧字段，后续正常更新 session 时清理。

### 13.3 建议删除或重构的模块

| 当前模块 | 处理 |
|---|---|
| `workspaceLayout/redirect.ts` | 删除扩展名重定向，路径解析迁入 `artifacts/artifactResolver.ts` |
| `writeDirCandidates.ts`、`confirmFlow.ts` | 删除，位置选择改为成果级 decision |
| `sessionWriteDir.ts` | 删除运行语义，仅保留一次性兼容清理函数 |
| `writeDirConfirmRegistry.ts` | 泛化为 `ArtifactDecisionRegistry` |
| `WorkspaceLayoutTab.tsx` | 替换为精简的 ArtifactSettingsTab |

## 14. 实施顺序

### 阶段一：基础设施，仅内部启用

1. 引入正式数据库 migration runner、三张表及 repository；
2. 实现严格工作区身份、平台路径 identity、用户路径证据和工具 JSON Schema；
3. 实现 ArtifactDecisionRegistry、路径类型 decision 和 ArtifactPathLeaseRegistry；
4. 完成工作区漂移、迁移回滚、显式路径防伪和 delete/use 并发故障测试。

此阶段保持 `artifactManagementEnabled=false`，不向用户宣称满足任何完整 AC 场景。

### 阶段二：可独立验收的核心写入切片

1. 接入 `toolChatLoop`，以 resolver 替换旧 workspace redirect；
2. 一次性交付 project、package primary、supporting 和 scratch 的路径解析、必要决策、写入登记、工具卡和完成摘要；
3. 接入桌面与远程 decision，覆盖无位置、多目录、归属歧义、覆盖和取消；
4. 完成 AC-01～AC-15、AC-22～AC-25、AC-29～AC-40 后才允许灰度。

### 阶段三：生命周期切片

1. 实现 reference metadata、pending references 和普通检索不落盘；
2. 实现跨轮成果上下文、草稿/定稿状态；
3. 实现带 journal 的 relocate、复制与当前编辑对象切换；
4. 实现工作产物面板、单文件及整会话清理；
5. 完成剩余 AC 和三类端到端场景后移除旧设置与旧确认 UI。

同一会话不能同时启用旧扩展名重定向和新 resolver。灰度开关只允许在会话创建时确定，运行中的会话不热切换两套语义。

## 15. 测试方案

### 15.1 单元测试

- `artifactResolver.test.ts`：三类容器、显式文件/目录、尾随分隔符、无扩展名文件、带点目录、材料路径推导、同名冲突、继续编辑和改址拒绝；
- `artifactPathSecurity.test.ts`：`..`、绝对路径、异平台路径、symlink、junction、Windows 设备名、尾随点/空格；
- `artifactRepository.test.ts`：active partial unique、package 关联、状态迁移、删除后同路径重建、移动后原路径重建、session 删除级联；
- `scratchGitPolicy.test.ts`：已忽略、追加精确规则、继续不忽略、取消、规则外部失效；
- `artifactPathLeaseRegistry.test.ts`：use/write/delete 原子互斥、finally 释放、整会话跳过、双路径排序；使用可控 barrier 覆盖“delete claim 前后开始 use”的两种交错；
- `artifactDecisionRegistry.test.ts`：分组复用、超时、取消、一次性消费、伪造/过期 decisionId 和跨 session/toolUseId 隔离；
- `src/shared/typeTests/artifactPathProvenance.typecheck.ts`：使用 `satisfies` 和 `@ts-expect-error` 的纯编译夹具，断言 Agent 可声明 `user`、`project-convention`、`agent-default`，不可声明 `user-decision`、`system-assigned`；同时断言 user 缺少 evidenceId、user-decision 缺少 decisionId、其他来源携带任一 provenance ID 都无法通过类型检查。使用非 `*.test.ts` 后缀，确保不会被现有 `tsconfig.renderer.gate.json` 排除，并由 `typecheck:shared` 实际执行；
- `explicitPathEvidence.test.ts`：模型伪造 user source、漏报显式路径、一条消息两个输出路径、输入参考路径不被当成输出、尾随分隔符、无扩展名文件和带点目录；
- `databaseMigrations.test.ts`：新库、v1 升 v2、重复启动、中途失败回滚和高版本拒绝；
- `relocateRecovery.test.ts`：覆盖后 DB commit 失败、覆盖后崩溃、备份恢复失败、源删除失败、目标 identity/摘要不匹配，以及 prepared、backup_committed、target_committed、source_cleanup_pending、cleanup_pending 各阶段崩溃恢复；
- `artifactDeletionGuard.test.ts`：存在非终态 operation 时禁止删除 artifact/session，终态 journal 显式清理后可删除；

### 15.2 工具循环集成测试

- 正式 `.sql` migration 不重定向；
- 明确 `docs/review/review.md` 的结果路径完全一致；
- scratch 脚本写到会话目录但执行 cwd 仍为 workDir；
- 写入确认卡显示 finalPath；
- 用户拒绝位置、Git 或覆盖后没有文件和 artifact 记录；
- 远程授权、auto-approve 和新决策的先后顺序正确；
- 写入失败不登记，登记失败应把请求标为失败并记录可恢复审计，不能谎报成功；
- 会话绑定 Profile 被删除或路径修改后，写入、删除、清理和改址均返回工作区身份错误，且不能作用于 active workspace 中的同名路径；
- 工具 schema 验证 `artifact.pathKind` 的唯一位置、缺省 `auto`、类型冲突错误码及 decision 后同一 tool call 恢复；验证 provenance `oneOf`：user 必须有 evidenceId，Agent 不能声明 user-decision/system-assigned，其他来源不能携带 evidenceId/decisionId；
- 桌面端和远程端分别覆盖 overwrite、改名、改目录、取消；改名/改目录后的新位置重新触发冲突时生成新 decisionId，并重新执行全套安全校验；
- decision 改名/改目录后能够以 `user-decision + pathDecisionId` 进入写入确认并持久化；伪造、重复消费或跨 toolUseId 的 decisionId 均在写入前被拒绝。

### 15.3 UI 测试

- 工具卡显示容器、用途和最终路径；
- 工作包、草稿与研究资料正确分组；
- 归属提升和复制时明确当前编辑对象；
- 普通草稿清理不删除 pending references；
- 草稿/定稿状态和完成摘要与实际记录一致；
- 中英文文案及键盘可访问性。

### 15.4 端到端场景

至少覆盖需求中的三个组合场景：

1. 开发任务同时新增源码、测试和临时验证脚本；
2. 数据库分析生成报告、SQL 和分析脚本，SQL 可从工作包打开；
3. 调研写作暂存 PDF、建立工作包、持续修改 `draft.md` 并在原路径定稿。

验收测试以 AC-01～AC-44 建立映射表，每条 AC 至少有一个自动化测试或明确的人工跨平台用例。

## 16. 可观测性与异常处理

沿用 `agentLogger`，新增以下事件：

- `artifact.resolve`：请求路径、最终路径、归属、pathSource、reason；
- `artifact.path_rejected`：拒绝类型，不记录文件内容；
- `artifact.decision`：决策类型和结果；
- `artifact.write_committed`：artifactId、路径、容器、role、字节数；
- `artifact.relocated`、`artifact.deleted`、`artifact.cleanup_skipped`；
- `artifact.explicit_path_mismatch`：用于计算显式路径改写率；
- `artifact.scratch_git_policy`。

日志不记录文件正文、网页资料正文或用户敏感输入。指标按需求文档定义从这些事件聚合，不在 MVP 中引入新的遥测服务。

若文件写入成功但数据库提交失败，返回“文件已写入但产物登记失败”的明确错误并记录 finalPath；下次打开工作产物面板时可通过本会话成功 tool call 提供一次“补登记”操作。MVP 不做全目录自动扫描恢复。

## 17. 明确不做的事项

- 不按扩展名决定归属或目录；
- 不自动扫描仓库并分类已有文件；
- 不自动移动主成果对应的 `.materials`；
- 不建设跨会话、跨工作区的成果搜索或复用；
- 不替换、包装或改变现有工作区创建、选择、切换和会话绑定机制；
- 不允许产物操作隐式切换工作区或把相对路径重新解释到其他工作区；
- 不解析任意 shell 命令以推断所有文件副作用；
- 不自动过期、压缩、配额清理或随稿打包；
- 不支持 workDir 外授权写入；
- 不用向量检索解决“继续这个”之类的复杂多成果消歧。

这些限制保留了需求要求的完整 MVP 主链路，同时将新增复杂度集中在路径解析、轻量持久化和必要的用户决策三个可测试模块中。
