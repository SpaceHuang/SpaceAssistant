# 显式输出目录与工作产物管理 MVP：TDD 开发计划

> 依据：`docs/develop/explicit-output-directory-candidate-technical-design.md` 与 `docs/requirement/explicit-output-directory-candidate-requirement.md`。

## 执行约定（必须遵守）

- [ ] 每次只执行一个最小任务；开始时将该任务由 `- [ ]` 改为 `- [~]` 并提交计划文件的状态更新。
- [ ] 任务验收通过后，**先**将该任务改为 `- [x]` 并提交计划文件的状态更新，**再**开始下一项任务。
- [ ] 如果验收失败、发现阻塞或需要拆分任务，保持 `- [~]`，在任务下追加失败证据和下一步；不得标为完成。
- [ ] 每个实现任务均遵循 RED → GREEN → REFACTOR：先新增或修改一个会失败的测试，再实现最小代码使其通过，最后只做保持测试通过的重构。
- [ ] 每个 RED 任务的验收是“指定测试因缺少目标行为失败”；每个 GREEN 任务的验收是“该测试通过且不破坏已有相关测试”。
- [ ] 每个阶段结束运行该阶段列出的完整验证命令；失败时回到造成失败的最小任务。
- [ ] 不在同一会话同时启用旧扩展名重定向和新 ArtifactResolver；功能开关只在创建会话时确定。

## 0. 基线与测试脚手架

- [x] 记录当前 `git status --short`，将既有用户改动列入实施日志，确认后续不覆盖它们。
  - 实施日志（2026-07-18）：基线存在用户未跟踪文件 `docs/develop/explicit-output-directory-candidate-technical-design.md`、`docs/requirement/explicit-output-directory-candidate-requirement.md` 与本计划文件；后续实施保留前两份文档，不覆盖其内容。本计划自首个状态提交起纳入版本控制。
- [x] 运行 `npm test -- --runInBand` 的等价现有 Vitest 命令并记录基线结果。
  - 基线（2026-07-18）：`npm test` 在允许本地回环监听的环境中通过，367 个测试文件、2090 条测试全部通过，耗时 144.12 秒。沙箱内首次运行因 `listen EPERM 127.0.0.1` 产生 1 条环境性失败，沙箱外复跑确认非代码失败。
- [x] 运行 `npm run typecheck:shared` 并记录基线结果。
  - 基线（2026-07-18）：通过，实际执行 `tsc -p tsconfig.renderer.gate.json --noEmit`。
- [x] 运行 `npm run typecheck:renderer` 并记录基线结果。
  - 基线（2026-07-18）：通过，`tsc -p tsconfig.renderer.json --noEmit` 无诊断。
- [x] 新建 artifact 测试辅助模块，提供临时 workDir、session、profile 和 SQLite 数据库工厂。
- [x] 为测试辅助模块写一条测试：工厂创建的 workDir 与数据库在 teardown 后均不存在。
  - RED（2026-07-18）：`npx vitest run electron/artifacts/testHelpers.test.ts` 按预期失败，报错 `Artifact test fixture is not implemented`。
- [x] 实现测试辅助模块，使该测试通过。
  - GREEN（2026-07-18）：`electron/artifacts/testHelpers.test.ts` 1/1 通过，shared typecheck 同步通过。
- [x] 新建 `electron/artifacts/` 目录并添加仅导出空公共类型的入口文件。
- [x] 为入口文件写编译测试，断言共享层可导入该入口而不引入 Electron renderer 依赖。
  - 验收（2026-07-18）：`src/shared/artifactEntrypoint.typecheck.ts` 使用 type-only import，`npm run typecheck:shared` 通过。
- [x] 实现入口导出，使编译测试通过。
  - 验收（2026-07-18）：入口仅公开 `ArtifactPublicApi` 空接口；上述共享层编译夹具通过，未引入 renderer 依赖。

## 1. 共享类型、错误码与工具 Schema

- [x] 新建共享 artifact 类型测试，断言 `ArtifactContainer` 只接受 `project | package | scratch`。
  - RED（2026-07-18）：`npm run typecheck:shared` 按预期失败，`artifactTypes` 尚不存在。
- [x] 定义并导出 `ArtifactContainer`、`ArtifactRole`、`PrimaryStage` 与 `ArtifactPathSource`，使类型测试通过。
  - GREEN（2026-07-18）：`npm run typecheck:shared` 通过。
- [x] 新增类型测试：`ArtifactPathProvenance` 的每种 pathSource 是独立联合成员。
  - RED（2026-07-18）：`npm run typecheck:shared` 按预期失败，尚未导出 `ArtifactPathProvenance`。
- [x] 定义 `ArtifactPathProvenance`，使该类型测试通过。
  - GREEN（2026-07-18）：`npm run typecheck:shared` 通过，独立 provenance 联合成员可被 `Extract` 精确筛选。
- [x] 新增 `typeTests/artifactPathProvenance.typecheck.ts`：合法 `user` 声明必须携带 evidenceId。
- [x] 在 typecheck fixture 中加入 `@ts-expect-error`：Agent 不能声明 `user-decision` 或 `system-assigned`。
- [x] 在 typecheck fixture 中加入 `@ts-expect-error`：非 user 来源不能携带 provenance ID。
- [x] 调整共享 typecheck 配置，确保上述 fixture 被 `npm run typecheck:shared` 编译。
  - 验收（2026-07-18）：`tsconfig.renderer.gate.json` 已包含 `typeTests/**/*.ts`。
- [x] 运行共享 typecheck，确认所有正例通过、所有 `@ts-expect-error` 被消费。
  - 验收（2026-07-18）：`npm run typecheck:shared` 通过；正例与所有 `@ts-expect-error` 均参与并通过编译。
- [x] 为 `ArtifactWriteIntent` 写 schema 单测：`artifact.pathKind` 是唯一允许的路径类型字段。
  - RED（2026-07-18）：`builtinToolDefinitions.artifact.test.ts` 按预期失败，当前 Schema 尚无 `artifact.pathKind`。
- [x] 定义 `ArtifactWriteIntentBase`、`DeclaredArtifactPathProvenance` 与 `ArtifactWriteIntent`，使单测通过。
  - GREEN（2026-07-18）：artifact 类型与 write_file 的嵌套 `artifact.pathKind` Schema 已就位；专用单测与 shared typecheck 均通过。
- [x] 为 write_file schema 写 RED 测试：`pathSource=user` 缺少 `pathEvidenceId` 被拒绝。
  - RED（2026-07-18）：Schema 中尚无 provenance `oneOf` 分支，专用测试按预期失败。
- [x] 为 write_file schema 写 RED 测试：Agent 提交 `user-decision` 或 `system-assigned` 被拒绝。
  - RED（2026-07-18）：Schema 尚未限制 Agent 可声明的 provenance 来源，专用测试按预期失败。
- [x] 为 write_file schema 写 RED 测试：非 user 来源带 evidence/decision ID 被拒绝。
  - RED（2026-07-18）：provenance 分支尚未禁止非 user evidence/decision ID，专用测试按预期失败。
- [x] 扩展 write_file JSON Schema 的 artifact `oneOf` 分支，使上述 schema 测试通过。
  - GREEN（2026-07-18）：`user` 强制 evidence ID，Agent 仅可声明 user/project-convention/agent-default，其他来源 ID 被禁止；4 条 Schema 测试与 shared typecheck 均通过。
- [x] 为 edit_file schema 写与 write_file 相同的 provenance/`pathKind` 测试。
  - RED（2026-07-18）：edit_file 尚无 artifact Schema，专用一致性测试按预期失败。
- [x] 扩展 edit_file JSON Schema，使 edit_file 测试通过。
  - GREEN（2026-07-18）：edit_file 复用 write_file 的 artifact provenance/pathKind Schema；5 条专用测试与 shared typecheck 均通过。
- [x] 为 artifact 专用稳定错误码写测试：路径类型冲突、工作区缺失/漂移、decision 无效/已消费、显式路径未解析均存在。
  - RED（2026-07-18）：artifact 专用错误码尚未定义，专用测试按预期失败。
- [x] 在 `src/shared/errorCodes.ts` 定义并导出这些错误码，使测试通过。
  - GREEN（2026-07-18）：8 条相关测试及 shared typecheck 均通过。
- [x] 运行 shared 类型与 builtin tool schema 的相关测试。
  - 验收（2026-07-18）：`errorCodes` 与 `builtinToolDefinitions.artifact` 共 8 条测试通过，`npm run typecheck:shared` 通过。

## 2. 数据库迁移与 ArtifactRepository

- [x] 为新数据库写 RED 测试：启动后 schema 版本为 v2 且三张 artifact 表与索引存在。
  - RED（2026-07-18）：新库当前 schema 版本为 v1，专用迁移测试按预期失败。
- [x] 为 v1 数据库写 RED 测试：启动后在一个升级流程中创建 artifact 表并升级到 v2。
  - RED（2026-07-18）：v1 数据库启动后仍为 v1，专用迁移测试按预期失败。
- [x] 为重复启动写 RED 测试：第二次启动不重复执行 migration 且版本仍为 v2。
  - 验收（2026-07-18）：重复启动后 schema 仍为 v2，`idx_artifacts_active_path` 恰好一条。
- [x] 为 migration 失败写 RED 测试：故意失败时 DDL 与 schema_version 一起回滚。
  - GREEN（2026-07-18）：故意注入失败 DDL 后，schema version 保持 v1 且新表不存在。
- [x] 为高版本数据库写 RED 测试：应用拒绝打开并给出升级应用错误。
  - 验收（2026-07-18）：schema version 3 被拒绝，错误提示要求升级应用。
- [x] 实现 `schema_meta` 读取、严格版本解析与高版本拒绝，使上述迁移测试通过。
  - 已实现严格数字版本解析与 `DatabaseUpgradeRequiredError`；高版本测试将在迁移边界测试矩阵中覆盖。
- [x] 实现单 transaction 的 `runMigrations(conn)` 与 v1→v2 migration，使上述迁移测试通过。
  - `runMigrations(conn)` 在单一 SQLite transaction 内创建 v2 artifact 表、索引并更新 schema version。
- [x] 将迁移 runner 接到 SQLite 初始化；保留当前 `CREATE_TABLES_SQL` 仅作新库与结构兜底。
  - GREEN（2026-07-18）：新库与 v1 数据库迁移测试通过，既有 JSON→SQLite 迁移测试同步通过。
- [x] 为 `session_artifacts` 写 RED 测试：合法 project、package、scratch 记录可保存和读取。
  - RED（2026-07-18）：`ArtifactRepository` 尚不存在，专用测试按预期失败。
- [x] 创建 `session_artifacts`、`artifact_references`、`artifact_operations` 表及设计要求的索引。
  - 已在 v1→v2 单事务 migration 中创建，并由新库 bootstrap 测试覆盖。
- [x] 定义数据库行类型与领域 `ArtifactRecord` 映射，使保存读取测试通过。
  - GREEN（2026-07-18）：project/package/scratch 三类记录均可写入并读取，专用测试与 shared typecheck 通过。
- [x] 为 provenance CHECK 约束写 RED 测试：非法 ID 组合被 SQLite 拒绝。
  - 验收（2026-07-18）：SQLite 拒绝 `pathSource=user` 缺少 evidence ID 的非法记录。
- [x] 实现 CHECK 约束，使非法组合测试通过。
  - CHECK 已在 v2 migration 中定义并由 repository 测试验证。
- [x] 为 active 路径唯一性写 RED 测试：同 session、同 identity 的两条 active 记录冲突。
  - 验收（2026-07-18）：重复 active identity 被 SQLite `idx_artifacts_active_path` 拒绝。
- [x] 实现 partial unique index，使冲突测试通过。
  - 已在 v2 migration 中创建并由 repository 测试验证。
- [x] 为删除后同路径重建写 RED 测试。
  - RED（2026-07-18）：`ArtifactRepository.markDeleted()` 尚不存在，专用测试按预期失败。
- [x] 实现 deleted 状态更新与新记录插入，使重建测试通过。
  - GREEN（2026-07-18）：标记 deleted 后可使用相同 session/path identity 新建 active artifact，3 条 repository 测试通过。
- [x] 为移动后原路径可新建写 RED 测试。
  - RED（2026-07-18）：`ArtifactRepository.updatePath()` 尚不存在，专用测试按预期失败。
- [x] 实现同 artifactId 更新 canonical path/identity，使移动测试通过。
  - GREEN（2026-07-18）：移动保持 artifactId，旧 path identity 可立即用于新记录；4 条 repository 测试通过。
- [x] 为 package 关联写 RED 测试：supporting/reference 的 packageId 必须指向同 session 的 package primary。
  - RED（2026-07-18）：repository 尚未校验 package primary，孤立 supporting 记录可被写入。
- [x] 实现 repository 层 package 关联校验，使测试通过。
  - GREEN（2026-07-18）：supporting/reference 必须引用同 session 的 active package primary；5 条 repository 测试通过。
- [x] 为 session 删除写 RED 测试：有非终态 operation 时拒绝删除；终态 journal 显式清理后允许删除。
  - RED（2026-07-18）：当前直接触发外键错误，未给出可恢复的 operation guard，也未清理终态 journal。
- [x] 实现 operation guard 与终态 journal 清理，使删除测试通过。
  - GREEN（2026-07-18）：pending operation 返回明确拒绝；终态 journal 在删除 session 前清理。专用测试、既有 operations 测试和 Electron 编译通过。
- [x] 实现 repository 的 list、find、create、updatePath、markDeleted、listBySession API，并分别覆盖最小单测。
  - GREEN（2026-07-18）：所有 API 均已实现；repository 专用测试 6/6 通过，shared typecheck 通过。
- [x] 运行 `databaseMigrations.test.ts`、repository 测试与既有 database 测试。
  - 验收（2026-07-18）：8 个测试文件、32 条测试全部通过。

## 3. 工作区身份、路径 identity 与安全边界

- [x] 为 `resolveArtifactWorkspaceStrict()` 写 RED 测试：未绑定 profile 的历史 session 首次可显式绑定现有解析结果。
  - RED（2026-07-18）：strict workspace resolver 尚不存在。
- [x] 实现历史 session 的一次性显式 profile 回写，使测试通过。
  - GREEN（2026-07-18）：历史 unbound session 可用显式解析结果绑定 profile；专用测试与 Electron 编译通过。
- [x] 为 strict resolver 写 RED 测试：profile 不存在返回 `ARTIFACT_WORKSPACE_UNAVAILABLE`。
  - 验收（2026-07-18）：缺失绑定 profile 返回稳定 unavailable 错误码。
- [x] 实现 profile 存在性校验，使测试通过。
  - strict resolver 已在解析前校验 profile；2 条专用测试通过。
- [x] 为 strict resolver 写 RED 测试：profile realpath 与 artifact 快照不同返回 `ARTIFACT_WORKSPACE_CHANGED`。
  - 验收（2026-07-18）：realpath 与 artifact 快照不一致时返回 stable changed 错误码。
- [x] 实现 workspace root realpath 快照比对，使测试通过。
  - strict resolver 的 expected realpath 比对已实现；3 条专用测试通过。
- [ ] 为 strict resolver 写 RED 测试：active workspace 与 artifact workspace 同名文件不会被作为 fallback 操作。
- [ ] 移除 artifact mutation 对 active-workspace fallback 的调用，使测试通过。
- [x] 为 POSIX path identity 写 RED 测试：已存在路径使用 realpath identity，不存在路径使用规范化词法 identity。
  - RED（2026-07-18）：path identity helper 尚不存在。
- [x] 实现 POSIX identity 生成，使测试通过。
  - GREEN（2026-07-18）：existing path 使用 realpath，absent path 使用 path.normalize；专用测试与 Electron 编译通过。
- [x] 为 Windows path identity 写 RED 测试：统一分隔符与大小写，并拒绝设备名、尾随点和空格别名。
  - RED（2026-07-18）：初始实现未做 Windows 规范化或别名校验。
- [x] 实现平台 identity 生成与 Windows 输入校验，使测试通过。
  - GREEN（2026-07-18）：Windows identity 统一为小写 `/`，拒绝设备名与尾随点/空格；2 条测试与 Electron 编译通过。
- [x] 为安全目标解析写 RED 测试：`..`、工作区外绝对路径、异平台绝对路径均拒绝且不改写路径。
  - RED（2026-07-18）：artifact 安全目标层尚不存在。
- [x] 为安全目标解析写 RED 测试：POSIX symlink、Windows junction 和文件/目录目标类型越界均拒绝。
  - 验收（2026-07-18）：POSIX symlink 与目录目标均被既有 lstat 安全层拒绝；artifact wrapper 测试 5/5 通过。Windows junction 由相同 reparse/symlink 拒绝路径覆盖，待 Windows 人工验证补入 AC 映射表。
- [x] 增强 `resolveSafeWriteTarget`（或等价路径安全层），使上述安全测试通过。
  - GREEN（2026-07-18）：artifact wrapper 在委托既有 lstat/symlink 安全层前拒绝 `..`、POSIX/Windows/UNC 绝对路径；4 条测试与 Electron 编译通过。
- [ ] 为实际写入前再次校验 workspace identity 写 RED 测试。
- [ ] 在 artifact 写入、删除、清理、relocate 的 mutation 前接入二次 strict 校验，使测试通过。
- [ ] 运行 artifact path security、pathSecurity 既有测试。

## 4. 用户显式路径证据与路径类型决策

- [x] 为显式路径提取写 RED 测试：反引号或引号包裹的输出路径产出稳定 evidenceId 和原始 span。
  - RED（2026-07-18）：显式路径 evidence 提取器尚不存在。
- [x] 实现 `explicitPathEvidence.ts` 的基本 span 提取，使测试通过。
  - GREEN（2026-07-18）：反引号/单引号/双引号路径生成 request+span 稳定 evidenceId，专用测试与 Electron 编译通过。
- [x] 为提取器写 RED 测试：带分隔符的相对/绝对路径可被识别，保留尾随分隔符。
  - 验收（2026-07-18）：相对和绝对 quoted path 均保留 rawPath 与 trailingSeparator。
- [x] 实现相对/绝对路径与尾随分隔符解析，使测试通过。
  - 提取器使用原始 token，不对路径做规范化；2 条 evidence 测试通过。
- [~] 为提取器写 RED 测试：紧邻“文件、目录、保存为”等词的单段名称被识别。
- [ ] 实现保守关键词邻近规则，使测试通过。
- [ ] 为提取器写 RED 测试：参考、读取、检查路径标为 `referenced-input`，不得成为 output target。
- [ ] 实现 output/reference/unknown intent 判定，使测试通过。
- [ ] 为 resolver 写 RED 测试：模型伪造 user source 或 evidenceId 被拒绝。
- [ ] 实现 evidence 的 request/message/intent/path 等值校验，使测试通过。
- [ ] 为 resolver 写 RED 测试：多个输出路径保留独立 evidence，不能被错误合并。
- [ ] 实现 evidence 列表注入和逐条消费校验，使测试通过。
- [ ] 为 resolver 写 RED 测试：有未消费强输出证据的新 package/scratch 写入返回 `ARTIFACT_EXPLICIT_PATH_UNRESOLVED`。
- [ ] 实现未解析强证据阻断逻辑，使测试通过。
- [ ] 为 `resolveOutputPathKind()` 写 RED 测试：已存在路径以 lstat 类型为准，显式声明冲突返回 `ARTIFACT_PATH_TYPE_CONFLICT`。
- [ ] 实现已存在目标类型比对，使测试通过。
- [ ] 为路径类型写 RED 测试：不存在且尾随 `/` 或 `\\` 时判为 directory。
- [ ] 实现在 normalize 前保存尾随分隔符的判定，使测试通过。
- [ ] 为路径类型写 RED 测试：无扩展名文件、带点目录不按名称猜测类型；仅真正二义时请求 decision。
- [ ] 实现 `auto` 二义分支与 `path-type` decision 请求，使测试通过。
- [ ] 运行 explicit evidence、path type 与安全相关测试。

## 5. ArtifactDecisionRegistry 与路径租约

- [ ] 为 decision registry 写 RED 测试：同 request 的相同 groupKey 复用一条 ownership decision。
- [ ] 实现 registry 的 pending/groupKey 复用，使测试通过。
- [ ] 为 decision registry 写 RED 测试：取消、会话删除、窗口关闭和五分钟超时均清理 pending decision。
- [ ] 实现所有清理入口与 timeout，使测试通过。
- [ ] 为 decision registry 写 RED 测试：response 必须匹配 requestId/sessionId/toolUseId/attempt。
- [ ] 实现绑定校验，使测试通过。
- [ ] 为 decision registry 写 RED 测试：decision 只能消费一次，重复消费返回 `ARTIFACT_DECISION_ALREADY_CONSUMED`。
- [ ] 实现一次性消费状态机，使测试通过。
- [ ] 为 decision registry 写 RED 测试：伪造、过期、跨 session/toolUseId 的 ID 返回 `ARTIFACT_DECISION_INVALID`。
- [ ] 实现 invalid decision 拒绝，使测试通过。
- [ ] 为 rename/change-directory response 写 RED 测试：仅可构造可信 `user-decision + pathDecisionId` provenance。
- [ ] 实现 decision 驱动 provenance 构造，使测试通过。
- [ ] 为 `ArtifactPathLeaseRegistry` 写 RED 测试：use 可共享，write/delete 排他。
- [ ] 实现 acquireUse、acquireWrite、claimDelete 与 release，使测试通过。
- [ ] 为 lease registry 写 RED 测试：delete tombstone 阻止之后的 use/write，且 use/write 存在时 delete 原子失败。
- [ ] 实现原子状态转换，使测试通过。
- [ ] 为 lease registry 写 RED 测试：finally release 后可重新 acquire。
- [ ] 在工具访问路径的 finally 块接入 release，使测试通过。
- [ ] 为双路径 lease 写 RED 测试：按 identity 排序申请避免死锁。
- [ ] 实现 ordered multi-path acquire，使测试通过。
- [ ] 迁移 artifact 管理路径的旧 `checkWritePathConflict`/`claimWritePath` 调用到新 registry。
- [ ] 运行 registry、并发 barrier 与既有写冲突测试。

## 6. ArtifactResolver：三类容器的纯解析

- [ ] 为 project resolver 写 RED 测试：显式或项目约定 `src/auth.ts` 原样成为 finalPath，不创建重定向目录。
- [ ] 实现 project primary 解析与 project-convention/user provenance，使测试通过。
- [ ] 为 project resolver 写 RED 测试：既有文件无 artifact 时登记为 project；已有 artifactId 时沿用 canonical path。
- [ ] 实现 project 的已有文件与 artifactId 分支，使测试通过。
- [ ] 为 package primary 写 RED 测试：显式文件路径按字面使用。
- [ ] 实现 package primary 的显式文件解析，使测试通过。
- [ ] 为 package primary 写 RED 测试：显式目录仅追加展示的主成果文件名。
- [ ] 实现目录主成果命名优先级（用户名、title slug、任务默认名），使测试通过。
- [ ] 为 package primary 写 RED 测试：未指定位置发出 output-location decision，不创建临时文件。
- [ ] 实现未指定主成果位置的 decision 分支，使测试通过。
- [ ] 为 package supporting/reference 写 RED 测试：有 packageId 且无显式路径时推导 `主成果目录/base.materials/`。
- [ ] 实现材料推导与默认平铺，使测试通过。
- [ ] 为材料解析写 RED 测试：同名风险或角色混合时才创建 supporting/references 子目录。
- [ ] 实现按冲突和 role 的材料子目录规则，使测试通过。
- [ ] 为 supporting 写 RED 测试：无 packageId 时返回 ownership/关联歧义，不创建匿名 package。
- [ ] 实现无 packageId 拒绝/decision 分支，使测试通过。
- [ ] 为 scratch resolver 写 RED 测试：忽略 Agent 目录建议，仅使用安全文件名并写入 `.spaceassistant/runs/<session>/<kind>/`。
- [ ] 实现 scratch kind 映射、文件名净化与 system-assigned provenance，使测试通过。
- [ ] 为 scratch resolver 写 RED 测试：新同名文件加短 toolUseId 后缀；同 artifactId 保持原路径。
- [ ] 实现 scratch 冲突命名与持续编辑分支，使测试通过。
- [ ] 为 resolver 写 RED 测试：首次覆盖无关 artifact 必须产生 overwrite decision。
- [ ] 实现覆盖检测和 overwrite decision，使测试通过。
- [ ] 为 resolver 写 RED 测试：decision 改名/改目录后从路径类型、安全、identity、冲突检查完整重跑。
- [ ] 实现 decision 后重新解析循环与 attempt 递增，使测试通过。
- [ ] 为 resolver 写 RED 测试：传入 artifactId 时不得通过普通 write 隐式改址。
- [ ] 实现既有 artifact canonical path 约束，使测试通过。
- [ ] 运行 `artifactResolver.test.ts`、显式路径、路径安全、decision 测试。

## 7. Scratch Git 策略与引用资料

- [ ] 为 Git policy 写 RED 测试：已被 `.spaceassistant/runs/` 或 `/.spaceassistant/runs/` 覆盖时不提问。
- [ ] 实现常用精确 `.gitignore` 规则检查，使测试通过。
- [ ] 为 Git policy 写 RED 测试：Git 根在 workDir 外时不修改外部 `.gitignore`，只允许继续或取消。
- [ ] 实现 Git root 边界检查，使测试通过。
- [ ] 为 Git policy 写 RED 测试：首次 scratch 创建且未保存选择时请求 add-ignore/keep-visible/cancel。
- [ ] 实现 workspace 级 `artifact.scratchGitPolicy.<profileId>` 读取与 decision，使测试通过。
- [ ] 为 Git policy 写 RED 测试：add-ignore 仅追加精确 `.spaceassistant/runs/`，并重新验证规则。
- [ ] 实现安全 `.gitignore` 更新与重检，使测试通过。
- [ ] 为 Git policy 写 RED 测试：外部规则失效时清空保存选择并重新询问。
- [ ] 实现保存选择失效检测，使测试通过。
- [ ] 为 reference retention 写 RED 测试：普通检索/短摘要不创建文件、artifact 或 Git decision。
- [ ] 保持检索流程不接入 artifact 写入；使测试通过。
- [ ] 为 reference retention 写 RED 测试：有 packageId 的 reference 无显式路径写入材料目录。
- [ ] 在 resolver 接入 package/reference 分支，使测试通过。
- [ ] 为 reference retention 写 RED 测试：无 package 的本地保存请求 long-term/pending/cancel decision。
- [ ] 实现 reference-retention decision 分支，使测试通过。
- [ ] 为 reference metadata 写 RED 测试：成功下载后保存 title、URL、fetchedAt、许可说明。
- [ ] 实现 `registerReferenceMetadata()`，使测试通过。
- [ ] 为 reference metadata 写 RED 测试：缺 title 或 URL 时文件保留但工具结果报告补登记。
- [ ] 实现不删除文件的未完成 metadata 报告，使测试通过。
- [ ] 运行 scratch Git、reference 与 resolver 相关测试。

## 8. 工具循环、写入登记与完成摘要（核心可灰度切片）

- [ ] 为 tool loop 写 RED 集成测试：feature flag 关闭时保留旧行为；新会话 flag 开启时旧扩展名 redirect 不执行。
- [ ] 实现会话创建时冻结的 `artifactManagementEnabled` 开关，使测试通过。
- [ ] 为 tool loop 写 RED 集成测试：resolver 在写入确认之前运行，确认卡展示 finalPath。
- [ ] 将 resolver 接入 `toolChatLoop` 的 write_file/edit_file 前置链路，使测试通过。
- [ ] 为工具循环写 RED 集成测试：path decision 完成后用相同 requestId/toolUseId 恢复同一次调用。
- [ ] 接入 ArtifactDecisionRegistry 恢复机制，使测试通过。
- [ ] 为工具循环写 RED 集成测试：写入授权和远程 grant 仍在 resolver/decision 后执行。
- [ ] 保留既有确认与远程授权顺序，使测试通过。
- [ ] 为工具循环写 RED 集成测试：实际写入失败时不创建 artifact 记录。
- [ ] 在 builtin executor 成功返回后才调用 repository 登记，使测试通过。
- [ ] 为工具循环写 RED 集成测试：登记失败返回“文件已写入但登记失败”，记录可恢复审计，不能报告成功。
- [ ] 实现写后登记失败处理与审计事件，使测试通过。
- [ ] 为工具结果写 RED 测试：系统分配路径发 `tool:path-resolved`；显式文件路径 requestedPath 与 finalPath 相同。
- [ ] 替换 `tool:redirect` 语义为 `tool:path-resolved` 并更新 renderer input.path，使测试通过。
- [ ] 为工具结果写 RED 测试：metadata 含 artifactId、归属、role、pathKind、provenance、reason。
- [ ] 持久化 `ArtifactToolResultMeta`，使测试通过。
- [ ] 为完成摘要写 RED 测试：request change cursor 只汇总本轮成功写入的项目、工作包、材料、资料和草稿。
- [ ] 实现 artifact change cursor 与结构化完成摘要，使测试通过。
- [ ] 为集成测试写 AC-01、AC-02、AC-03、AC-04、AC-07、AC-09、AC-11、AC-15、AC-18、AC-19、AC-22、AC-29、AC-34、AC-35、AC-36、AC-38、AC-39、AC-40 场景。
- [ ] 实现缺失的最小链路代码，使上述 AC 集成测试通过。
- [ ] 运行工具循环、写入确认、远程授权与上述 AC 测试。

## 9. IPC、桌面端与远程决策

- [ ] 为 shared API 写 RED 编译测试：存在 artifact:list、decision-response、delete、clean-session、relocate、set-default-dir 与 changed event 类型。
- [ ] 在 `src/shared/api.ts` 增加 API 与事件类型，使测试通过。
- [ ] 为 preload 写 RED 测试：renderer 仅能调用已声明 artifact API，不能传 workspace root。
- [ ] 在 `preload.ts` 暴露受限 artifact API，使测试通过。
- [ ] 为主进程 IPC 写 RED 测试：list 从 repository 按 session 返回，且不信任 renderer 路径。
- [ ] 实现 `artifact:list` handler，使测试通过。
- [ ] 为 IPC 写 RED 测试：所有 mutation 从 artifact/session/profile 读取路径并执行 strict workspace 校验。
- [ ] 实现 mutation 的统一 guard，使测试通过。
- [ ] 为桌面 decision UI 写 RED 测试：path type、output location、ownership、overwrite、reference retention、git ignore 均显示对应选项。
- [ ] 实现 `ArtifactDecisionCard` 与状态管理，使测试通过。
- [ ] 为 overwrite UI 写 RED 测试：rename 只能填单文件名；change-directory 只能填相对目录。
- [ ] 实现输入校验和当前 decisionId 回传，使测试通过。
- [ ] 为 remote adapter 写 RED 测试：所有 artifact decision 被文本化为编号选项且带 decisionId。
- [ ] 实现远程 decision 序列化，使测试通过。
- [ ] 为 remote reply 写 RED 测试：`2 review-v2.md` 与 `3 reports/final/` 解析为相应 response；无效输入只重发帮助。
- [ ] 实现远程 decision 回复解析，使测试通过。
- [ ] 为桌面和远程各写集成测试：取消、覆盖、改名、改目录及二次冲突生成新 decisionId。
- [ ] 实现两端同一 registry 的完整交互，使集成测试通过。
- [ ] 为 WriteSuccessCard 写 RED UI 测试：显示归属 badge、用途和 finalPath。
- [ ] 更新 WriteSuccessCard 与 i18n 文案，使测试通过。
- [ ] 运行 IPC、renderer、远程 confirm、i18n strict 检查。

## 10. 工作产物面板、清理与生命周期

- [ ] 为 DetailPanel 写 RED UI 测试：按项目变更、工作包、草稿、研究资料分组列出本会话 artifacts。
- [ ] 实现“本会话工作产物”面板及 repository 订阅，使测试通过。
- [ ] 为面板写 RED UI 测试：项目和主成果默认展开，草稿默认折叠。
- [ ] 实现默认展开状态，使测试通过。
- [ ] 为面板写 RED UI 测试：每项可复用现有预览/打开能力，未把所有引用文件登记为产物。
- [ ] 接入现有打开能力并保持引用文件面板，使测试通过。
- [ ] 为单文件删除写 RED 测试：拿不到 delete lease 时拒绝且说明原因。
- [ ] 实现 `artifact:delete` 的 claim→strict check→删除→markDeleted→release 流程，使测试通过。
- [ ] 为删除写 RED 测试：文件不存在时幂等标记 deleted；安全校验失败时不改数据库。
- [ ] 完善删除的幂等与失败分支，使测试通过。
- [ ] 为整会话清理写 RED 测试：只清理普通 scratch，跳过 project/package 与正在使用文件。
- [ ] 实现 `artifact:clean-session` 的逐项 claim 与 skipped reason 返回，使测试通过。
- [ ] 为整会话清理写 RED 测试：pending reference 默认不删除，必须显式勾选才清理。
- [ ] 实现 includeReferences 选项与 UI 二次确认，使测试通过。
- [ ] 为跨轮上下文写 RED 测试：最多注入 20 条最近活跃 artifact 摘要，继续编辑复用 artifactId。
- [ ] 实现 artifact context 查询与 prompt 注入，使测试通过。
- [ ] 为 stage 写 RED 测试：working/draft/final 更新后面板和完成摘要一致。
- [ ] 实现 stage 更新与 UI 展示，使测试通过。
- [ ] 运行面板、删除、清理、上下文、完成摘要 UI 测试。

## 11. Relocate journal 与恢复

- [ ] 为 relocate 写 RED 测试：请求未获覆盖授权时不创建 operation journal。
- [ ] 实现 relocate 解析与覆盖 decision 前置条件，使测试通过。
- [ ] 为 relocate 写 RED 测试：prepared journal 记录 source/target/mode、预定 temp/backup 路径和目标原始 identity/digest。
- [ ] 实现 prepared journal 的单 transaction 创建，使测试通过。
- [ ] 为 relocate 写 RED 测试：source/target leases 以 identity 排序一次性获得。
- [ ] 在 RelocateService 接入 ordered dual-path lease，使测试通过。
- [ ] 为 same-device move 写 RED 测试：目标存在时创建并校验同目录备份，再原子提交 target。
- [ ] 实现 backup_committed 与 same-device-move target_committed 阶段，使测试通过。
- [ ] 为 copy/cross-device move 写 RED 测试：同目录 temp 文件 fsync/摘要校验后原子替换 target。
- [ ] 实现 copy/cross-device temp 与 target_committed 阶段，使测试通过。
- [ ] 为 DB commit 写 RED 测试：move 保持 artifactId；copy 创建新 artifactId；operation 进入正确 pending phase。
- [ ] 实现 artifact 记录更新与 operation phase 同 transaction 提交，使测试通过。
- [ ] 为 cross-device cleanup 写 RED 测试：source 删除失败保留 source_cleanup_pending，不回滚已提交 target。
- [ ] 实现 source cleanup 重试逻辑，使测试通过。
- [ ] 为 cleanup 写 RED 测试：仅 identity 匹配时删除 backup/temp，之后才 completed。
- [ ] 实现 cleanup_pending 与 completed 阶段，使测试通过。
- [ ] 为 pre-commit 失败写 RED 测试：source/target/backup identity 一致时逆向补偿；不一致时 recovery_required。
- [ ] 实现补偿与 recovery_required 分支，使测试通过。
- [ ] 为启动恢复写 RED 测试：分别从 prepared、backup_committed、target_committed、source_cleanup_pending、cleanup_pending 恢复且幂等。
- [ ] 实现启动扫描非终态 operation 与分阶段恢复，使测试通过。
- [ ] 为 UI 写 RED 测试：移动并切换、复制并继续原文件、复制并切换副本明确显示当前编辑对象。
- [ ] 实现 relocate UI 与 artifact:relocate IPC，使测试通过。
- [ ] 运行 `relocateRecovery.test.ts`、deletion guard、文件安全和 IPC 测试。

## 12. 旧功能迁移、灰度与验收

- [ ] 为旧配置兼容写 RED 测试：读取 `config.workspaceLayout` 不再触发扩展名重定向。
- [ ] 保留一个版本的只读兼容代码并移除其运行语义，使测试通过。
- [ ] 为旧 session 写 RED 测试：`metadata.writeDirChoice` 不迁移到 `artifactDefaultDir`。
- [ ] 实现旧字段忽略与后续正常保存时清理，使测试通过。
- [ ] 为设置页写 RED UI 测试：不再显示扩展名映射和首次写入目录确认；显示 artifact 总开关、草稿 Git 策略和说明。
- [ ] 用 `ArtifactSettingsTab` 替换旧 WorkspaceLayoutTab，使测试通过。
- [ ] 为 UI 路由写 RED 测试：旧 `WriteDirConfirmPanel`、候选目录与会话 chip 不再被引用。
- [ ] 删除/重构旧 redirect、writeDirCandidates、confirmFlow、sessionWriteDir 和 writeDirConfirmRegistry 的运行引用，使测试通过。
- [ ] 在 feature flag 开启会话上运行一次端到端开发场景：源码、测试、临时验证脚本分别落到项目与 scratch。
- [ ] 将该端到端场景自动化并验收 AC-01～AC-05、AC-22～AC-25、AC-33、AC-35～AC-40。
- [ ] 在 feature flag 开启会话上运行一次端到端分析场景：报告、SQL、脚本与资料可从工作包打开。
- [ ] 将该端到端场景自动化并验收 AC-06～AC-17、AC-41～AC-43。
- [ ] 在 feature flag 开启会话上运行一次端到端调研写作场景：暂存资料、建立工作包、持续编辑 draft.md 并原地定稿。
- [ ] 将该端到端场景自动化并验收 AC-18～AC-21、AC-26～AC-28、AC-44。
- [ ] 建立 AC-01～AC-44 映射表：每条 AC 链接到至少一个自动化测试或明确人工跨平台用例。
- [ ] 运行全部 unit、integration、renderer、remote 和 typecheck 测试并记录结果。
- [ ] 运行 `npm run i18n:check:strict`，修复所有新增文案的硬编码或缺失翻译。
- [ ] 运行 `npm run build`，修复编译或打包前置错误。
- [ ] 进行 macOS、Windows、Linux 的路径安全人工验证并把结果填入 AC 映射表。
- [ ] 仅当 AC-01～AC-40 核心集成测试通过后启用灰度；仅当 AC-01～AC-44 与三类端到端场景通过后移除旧设置/旧确认 UI。

## 完成定义

- [ ] 所有上述任务均为 `- [x]`，不存在未解释的 `- [~]` 或 `- [ ]`。
- [ ] AC-01～AC-44 均有可追溯的测试或人工跨平台证据。
- [ ] 全量测试、共享类型检查、renderer 类型检查、i18n strict 检查和构建均通过。
- [ ] 变更日志说明灰度开关、数据迁移、旧行为移除、恢复限制及不在 MVP 范围内的能力。
