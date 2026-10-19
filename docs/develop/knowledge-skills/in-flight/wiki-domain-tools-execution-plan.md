# Wiki 专属能力接口执行计划

> 状态：执行中；E-00 至 E-14、E-16 已关闭；E-15 真实飞书/微信验收与 E-17 启用未关闭。沿用现有集中 Wiki 根和文件存储机制；当前阶段证据见 §7.1。
> 技术规格：[Wiki 专属能力接口技术方案](./wiki-domain-tools-technical-plan.md)
> 需求与 AC 真源：[Wiki 专属能力接口需求](../../../requirement/knowledge-skills/in-flight/wiki-domain-tools-requirement.md)
> 计划规则：验收与不变量只引用技术方案 INV-* 和需求 AC-*；本文件是任务、依赖、证据与进度的唯一真源。

## 第 0 层：执行摘要【人必读】

**目标：** 让 Agent 经 Wiki 领域工具读写共享知识；由主进程管理页面身份、SCHEMA、来源、版本、索引日志、冲突和恢复。命令、Skill、工具发现、执行和通用文件旁路共用一个可信生命周期状态。

**顺序：** 先核对文件安全写入链路和 schema parser，再建立文件模型、外部编辑协调、领域读写、工具路由和旁路策略；必要原位迁移、源码验收、外部验收、发布启用依序进行。旧版本写入不受新版控制；迁移和启用均须处理外部变化冲突。

**本机源码阶段：** parser、真实命令入口集成、sourceId 导入链路、外部文件变化协调、幂等重试和工具安全矩阵均须完成；E-14 的验收必须经过真实本地 `/wiki` 路由和 Skill 路由，不能以伪造入口替代。

**外部验收与源码关闭分开：** 真实飞书/微信确认、桌面长正文确认展示、正式安装包升级、旧版应用写入后的新版本文件变化协调，以及本次候选发布目标平台（macOS arm64）的 userData 权限与安全文件发布能力。它们不阻止 E-14 源码关闭；本次 macOS 候选发布适用的 E-15/E-16 项是该目标安装 E-17 的前置。Windows 和其他平台的运行验收是各自平台发布的外部验收，不作为当前 macOS 候选发布或源码推进门禁；不得把 macOS 证据外推为其他平台通过。

**当前工作区保护：** 在 worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/wiki-domain-tools`、分支 `codex/wiki-domain-tools` 工作。本轮续跑基线为 `bc23fdf3`；Wiki 工具注册与边界修复提交为 `2703d5e5`。原工作区不作代码写入。代码阶段与文档阶段分开提交。

## 1. 开工门槛与环境边界

### 1.1 决策与基线复核（E-00）

开始实现前，须核对技术方案第 0 层 D-TP-01 至 D-TP-05 已记录的选择，并复核当前代码事实、目标文件和调用签名。D-TP-05 已决定复用现有文件写入逻辑；其他技术实现细节按技术方案已定规格推进。若复核发现事实变化，先修订技术方案与本 DAG。旧版应用仍按原代码写入 Wiki 是已明确的运行事实，不再作为待裁决项。

D-TP-01 至 D-TP-05 的产品/技术边界已有裁决；E-04 复用现有文件写入逻辑，不另建提交协议。E-00 记录基线和裁决状态，并核验 `.wiki-service/` 目录可使用现有安全写入链路。

### 1.2 开工基线

- E-00 记录 `git rev-parse --short HEAD`、`git branch --show-current`、`git status --short`、`npm exec vitest -- --version`，并复核技术方案 §1.3 的代码符号。
- E-01 核验现有 Wiki 根定位、文件 identity、`safeAtomicWrite` 和目录句柄 worker 的调用契约；不得增加 SQLite 探针或数据库备份门禁。
- E-01 只使用临时 Wiki fixture 验证现有安全 helper 的文件读回、hash 和 identity 冲突行为；生产 operation journal 恢复由 E-07 验收，不作为 E-01 前置。
- 生产 Wiki 数据仅在 E-13/E-17 确有必要的原位文件迁移时操作；若无需迁移，以只读 dry-run 证明 no-op；外部渠道与安装包验收使用隔离 fixture 或数据副本。

### 1.3 本机与外部验收

| 验收类型 | 内容 | 对源码关闭 E-14 | 对启用 E-17 |
| --- | --- | --- | --- |
| 本机 | 定向 Vitest、真实本地命令/Skill 到 service 的集成测试、权限矩阵、迁移故障注入、类型/i18n/构建、完整测试 | 必须通过 | 必须通过 |
| 外部渠道 | 真实飞书/微信确认与拒绝、automation 无人工确认拒绝、桌面长恢复正文展示 | 不阻塞 | 必须有逐项记录 |
| 外部发布与文件系统 | 本次 macOS arm64 候选包升级、旧版应用写入后新版本对外部文件变化的协调、该目标 userData 权限、现有 safeAtomicWrite 文件系统能力、冲突版本可读 | 不阻塞 | 本次目标安装必须有逐项记录；Windows/其他平台单列为对应平台发布验收，不阻塞本次 macOS 候选发布 |

外部验收记录路径为 `docs/develop/knowledge-skills/in-flight/wiki-domain-tools-release-acceptance.md`，由 E-15/E-16 创建并填写。它不得被 mock 结果或源码测试报告替代。

## 2. 依赖 DAG（唯一真源）

| 任务 ID | 动作 | 依赖 | 目标文件/模块 | 需求 AC | 完成判据与验证命令/证据 | 环境 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-00 | 核对技术方案并记录实现基线 | — | 两份 Wiki 方案；git 基线记录 | — | D-TP-01~05 决策状态写入方案；旧版应用写 Wiki 的行为按已知兼容事实记录，不列为决策；记录 HEAD、分支、status、Vitest 版本和代码符号复核。命令：`git rev-parse --short HEAD`、`git status --short`、`npm exec vitest -- --version` | 本机 | - [x] |
| E-01 | 核对 Wiki 文件安全写入链路和基线 | E-00 | `electron/wiki/wikiMount.ts`；`electron/wiki/wikiWriteMutex.ts`；`electron/safeAtomicWrite.ts`；`electron/confirmation/directoryHandleWriter.ts`；现有文件边界测试 | AC-16、AC-19、AC-20、AC-22 | 复核 Wiki 根解析、目录句柄写入、identity 检查和现有 `write_file`/`edit_file` 调用顺序；以临时 fixture 验证现有 helper 的读回、hash 和 identity 冲突行为；记录真实符号/签名；不把后续 production journal recovery 纳入本项，不新增存储实现或 SQLite 探针。命令：`npm exec vitest run electron/safeAtomicWrite.test.ts electron/tools/builtinExecutors.fileState.test.ts` | 本机 | - [x] |
| E-02 | 实现 Schema parser 与动态分类类型 | E-00 | `src/shared/wikiDomainTypes.ts`；`electron/wiki/wikiSchema.ts`；`electron/wiki/wikiSchema.test.ts` | AC-02、AC-03、AC-17、AC-20 | 唯一读取结构区块，诊断重复/缺失字段、ID、父级、格式版本；命令：`npm exec vitest run electron/wiki/wikiSchema.test.ts` | 本机 | - [x] |
| E-03 | 建立现有 Wiki 根内的文件模型与访问适配器 | E-01、E-02 | `electron/wiki/wikiFileStore.ts`；`wikiPaths.ts`；`wikiLifecycle.ts`；`wikiFileStore.test.ts` | AC-05、AC-07、AC-13、AC-16、AC-21、AC-22、AC-25 | 定义 `.wiki-service/` 和根内 bootstrap seal 文件布局、相对路径约束、catalog 可重建规则和文件读写适配；所有写入调用现有安全 helper；不建数据库、不移动根目录；只覆盖数据访问与适配，不提前实现生产 operation recovery/projection 或迁移恢复。命令：`npm exec vitest run electron/wiki/wikiFileStore.test.ts electron/wiki/wikiCatalog.test.ts` | 本机 | - [x] |
| E-04 | 让 Wiki 写服务复用现有文件写入安全链路 | E-03 | `electron/wiki/wikiWriteService.ts`；`electron/safeAtomicWrite.ts`；`electron/confirmation/directoryHandleWriter.ts`；`electron/wiki/wikiWriteService.test.ts`；文件写工具边界测试 | AC-13、AC-16、AC-19、AC-20、AC-22 | Wiki 页面/SCHEMA/raw/index/log 写入共用 `acquireWikiWriteMutex`、读取状态/identity 校验和 `safeAtomicWrite`；不新增硬链接归档、detached inode 或自定义发布器。对拍现有 `write_file` / `edit_file` 的外部修改、目标替换、新建目标抢占行为；冲突后重新读取可重试。命令：`npm exec vitest run electron/wiki/wikiWriteService.test.ts electron/safeAtomicWrite.test.ts electron/tools/builtinExecutors.fileState.test.ts` | 本机 | - [x] |
| E-05 | 实现外部变化协调与只读迁移预检 | E-02、E-03、E-04 | `electron/wiki/wikiReconciler.ts`；`wikiMigrationPreflight.ts`；`wikiPaths.ts`；`wikiReconciler.test.ts`；`wikiMigrationPreflight.test.ts` | AC-12、AC-16、AC-19、AC-20、AC-21、AC-22、AC-26 | 页面/SCHEMA/raw/hash/marker/别名/tombstone 变化生成正确 revision 或诊断；预检报告确定性类别映射、标题冲突、旧索引需转成普通页面的内容、无法分类内容、旧日志归档位置及清单 hash，完全不写用户文件；projection/recovery 实现留给 E-07/E-13。命令：`npm exec vitest run electron/wiki/wikiReconciler.test.ts electron/wiki/wikiMigrationPreflight.test.ts` | 本机 fixture | - [x] |
| E-06 | 接通领域读取与应用绑定来源导入 | E-05 | `electron/wiki/wikiDomainRead.ts`；`wikiSourceService.ts`；`wikiDomainTools.ts`；`wikiDomainRead.test.ts`；`wikiSourceService.test.ts`；`wikiDomainTools.test.ts` | AC-01、AC-08、AC-09、AC-10、AC-18、AC-21 | search/open/read_page/read_source 只接收领域 ID 或服务句柄；页面按固定 revision 分段读取，覆盖长文档 startLine 定位、cursor 续读、Unicode 边界、读取中外部编辑保持快照一致、句柄过期及逐次授权；来源读取同样有界。导入只接受应用绑定的 sourceRef，不接受 Agent 任意路径；跨 projectId 同 lane 对拍；拒绝无副作用。命令：`npm exec vitest run electron/wiki/wikiDomainRead.test.ts electron/wiki/wikiSource.test.ts electron/tools/builtinExecutors.wikiRead.test.ts` | 本机 | - [x] |
| E-07 | 接通域级串行化、写入幂等、操作恢复与投影 | E-03、E-04、E-05 | `electron/wiki/wikiDomainCoordinator.ts`；`wikiWriteService.ts`；`wikiProjection.ts`；`wikiDomainCoordinator.test.ts`；`wikiWriteService.test.ts` | AC-02、AC-03、AC-04、AC-05、AC-06、AC-07、AC-13、AC-18、AC-22、AC-26 | 所有写/协调操作按域锁→排序文件锁完成完整扫描、跨页树/标题/Schema 校验、领域提交或隔离；检查成功 invocation 先于可变基线校验；覆盖 A/B 双向移动、双建同标题、reconciler 与写入交错、随机操作序列后无环/标题唯一/Schema 合法不变量；覆盖 `domain_committed` 事件首次进入 log、该状态崩溃后恢复、log 已写但 completed 前崩溃及重复恢复。命令：`npm exec vitest run electron/wiki/wikiDomainCoordinator.test.ts electron/wiki/wikiWriteService.test.ts electron/wiki/wikiOperationRecovery.test.ts electron/wiki/wikiProjection.test.ts electron/tools/builtinExecutors.wikiWrite.test.ts` | 本机 | - [x] |
| E-08 | 接通 SCHEMA 提案、确认绑定和 safe apply | E-02、E-04、E-05、E-07 | `electron/wiki/wikiSchemaProposal.ts`；domain coordinator；`electron/confirmation/toolCallGate.ts`；`electron/confirmation/writeExecutionPermit.ts`；`electron/confirmation/writePermitExecutor.ts`；`electron/tools/builtinExecutors.ts`；proposal 与 executor 测试 | AC-15、AC-17、AC-20、AC-26 | apply 在域锁内重读提案基线与全部活动页；跨对象检查全部通过后才提交 SCHEMA；并发页面变更、Schema 收紧后现存页面不兼容、外部改动、伪造确认和重复调用均拒绝且零部分写入。permit 绑定主体/lane/proposalId/base version/hash/diff。命令：`npm exec vitest run electron/wiki/wikiSchemaProposal.test.ts electron/wiki/wikiDomainCoordinator.test.ts electron/tools/builtinExecutors.wikiSchema.test.ts electron/confirmation/toolCallGate.wikiSchema.test.ts` | 本机 | - [x] |
| E-09 | 接通页面历史查看和聊天恢复 | E-06、E-07、E-08 | `electron/wiki/wikiHistoryService.ts`；`electron/wiki/wikiDomainTools.ts`；`electron/wiki/wikiToolDiscovery.ts`；`src/shared/policy/defaultRules.ts`；`src/renderer/components/Chat/GenericConfirmCard.tsx`；对应测试 | AC-19、AC-23、AC-24 | 全部恢复冲突一次返回且零写入；覆盖项由用户选择；确认展示最终全文及元数据；automation 拒绝。命令：`npm exec vitest run electron/wiki/wikiDomainTools.test.ts electron/wiki/wikiHistoryService.test.ts electron/wiki/wikiToolDiscovery.test.ts src/shared/policy/defaultRules.contract.test.ts electron/confirmation/toolCallGate.test.ts src/renderer/components/Chat/GenericConfirmCard.test.tsx` | 本机；真实渠道 E-15 | - [x] |
| E-10 | 将 `/wiki` 命令、Skill 和来源流程接入 sourceId API | E-06、E-07、E-08、E-09 | `src/shared/outbound/wikiCommandService.ts`；`electron/wiki/wikiImport.ts`；`electron/wiki/wikiDomainTools.ts`；`electron/skills/bundled/llmWikiSkill.ts`；`electron/wiki/wikiCommandRoute.integration.test.ts` | AC-01、AC-08、AC-09、AC-14、AC-16、AC-18 | 从真实本地命令路由走到应用导入绑定、sourceId、Wiki service；Skill 不指示 Agent 用文件工具维护页面/index/log；未依赖后续启用任务。命令：`npm exec vitest run src/shared/outbound/wikiCommandService.test.ts electron/wiki/wikiCommandRoute.integration.test.ts electron/skills/bundled/llmWikiSkill.test.ts`；bulk 导入由主进程枚举非隐藏目录下的 Markdown/text 普通文件，跳过 symlink，限制 250 个文件、单文件 10 MiB、合计 50 MiB；所有来源逐个绑定 sourceId 后交给模型。批量失败/host port 缺失时不启动 Agent。定向命令 3 文件、50 项通过；`npx tsc -p tsconfig.electron.json --noEmit` 通过。 | 本机集成 | - [x] |
| E-11 | 接通首次初始化、memory 发现入口与 lifecycle dispatch | E-03、E-06、E-07、E-10 | `electron/wiki/wikiLifecycle.ts`；`electron/wiki/wikiInit.ts`；`electron/wiki/wikiMigrationPreflight.ts`；`electron/wiki/wikiToolDiscovery.ts`；`electron/toolChatLoop.ts`；对应测试 | AC-01、AC-10、AC-11、AC-14、AC-16、AC-18、AC-25 | 本任务唯一负责 bootstrap seal/initializer 和首次生命周期建立。真实初始模型工具集中注册名为 `memory` 的 query/limit/offset 发现工具；调用返回匹配操作名、用途与完整 schema，tool loop 将 schema 注入后续可调用工具集合，授权仍独立检查。测试存量 Wiki 首次启动→seal→preflight、空 Wiki→domain_ready、initializing 中断续跑、state 删除/损坏/seal 不匹配进入 recovery_required 且不重置；从可信备份恢复后核验 root identity 与 manifest，无备份时维持只读；dispatch 每次重新核验 lifecycle。命令：`npm exec vitest run electron/wiki/wikiLifecycle.test.ts electron/wiki/wikiInit.shared.test.ts electron/wiki/wikiMigrationPreflight.test.ts electron/wiki/wikiToolDiscovery.test.ts electron/wiki/wikiCommandRoute.integration.test.ts` 覆盖空库、目标格式存量根、迁移中断、控制面缺失/损坏 fail-closed、同一根中从可信 seal/state 备份恢复后重新核验身份；领域发现与 dispatch 每次复核 lifecycle。8 文件/55 项的 E11–E13 综合回归通过。 | 本机集成 | - [x] |
| E-12 | 封锁通用文件旁路并保留 WikiPane 路径兼容 | E-04、E-10、E-11 | `src/shared/policy/defaultRules.ts`；Wiki file facts/extractor；`electron/confirmation/toolCallGate.ts`；`electron/ipc/fileIpc.ts`；WikiPane/path alias；`builtinExecutors.wikiBypass.test.ts`；`electron/ipc/fileIpc.wikiMount.test.ts`；`src/renderer/components/WikiPane/WikiPane.test.tsx` | AC-08、AC-10、AC-11、AC-12、AC-18、AC-24 | `domain_enabled` 下 read/grep/list/write/edit/copy/move/rename/delete/shell 对挂载、别名、绝对路径、大小写、symlink 按稳定 rule ID 拒绝；普通工作目录不受影响；事实提取、Policy trace、permit final-check、executor 未调用均有断言。命令：`npm exec vitest run electron/tools/builtinExecutors.wikiBypass.test.ts electron/ipc/fileIpc.wikiMount.test.ts electron/confirmation/toolCallGate.wikiMount.test.ts src/renderer/components/WikiPane/WikiPane.test.tsx`；新增 gate 路径矩阵覆盖词汇挂载、只读别名、大小写变体、点段归一、真实绝对路径、shell 与 symlink；已有 tool execution 集成断言拒绝后 executor 未调用，file IPC 覆盖 copy/move/rename/delete 生命周期门禁，普通工作目录保持兼容。`npm exec vitest run electron/confirmation/toolCallGate.test.ts src/shared/policy/defaultRules.contract.test.ts electron/ipc/fileIpc.wikiMount.test.ts src/renderer/components/WikiPane/WikiPane.test.tsx`：4 文件、187 项通过。 | 本机 | - [x] |
| E-13 | 实现必要原位迁移的 manifest/写屏障与逐项恢复 | E-03、E-04、E-05、E-07、E-08、E-10、E-11、E-12 | `electron/wiki/wikiMigrationCoordinator.ts`；`wikiMigrationJournal.ts`；`wikiMigrationPreflight.ts`；`wikiLifecycle.ts`；对应测试 | AC-13、AC-16、AC-19、AC-20、AC-21、AC-22、AC-25、AC-26 | 使用 E-11 已建立的 bootstrap/lifecycle。覆盖存量集中库首次 seal→preflight→用户确认→迁移→domain_ready；空 Wiki→domain_ready；初始化中断后的 migration 恢复及控制面缺失/损坏不得重置 legacy。必要迁移前确认 E-05 报告；逐项写入后、manifest 更新前强制崩溃，验证 pending+new_hash 核验后幂等补记；覆盖 old_exists true/false 的继续和回退删除分支。SCHEMA 分类区块、marker/categoryId 与 index/log 视图仍在原根迁移；冲突停 recovery_required 且保留现场。命令：`npm exec vitest run electron/wiki/wikiBootstrapMigrationApproval.test.ts electron/wiki/wikiBootstrapMigration.test.ts electron/wiki/wikiMigrationCoordinator.test.ts electron/wiki/wikiMigrationJournal.test.ts electron/wiki/wikiMigrationPreflight.test.ts electron/wiki/wikiLifecycle.test.ts electron/wiki/wikiInit.shared.test.ts src/renderer/components/WikiPane/WikiPane.test.tsx`。WikiPane 展示预检文件、类型、hash 差异、分类/索引/日志摘要；主进程原生对话框绑定用户确认与 manifest hash；apply 前重新预检，过期/诊断/取消零写入；中断按已确认 migrationId 恢复；覆盖 old_exists true/false、pending+new_hash、外部变化回滚保留。8 文件/55 项通过；renderer/Electron 类型检查、i18n 检查通过。 | 本机故障注入 | - [x] |
| E-14 | 关闭本机源码阶段并完成本地故障恢复演练 | E-01、E-02、E-03、E-04、E-05、E-06、E-07、E-08、E-09、E-10、E-11、E-12、E-13 | Wiki/工具/策略/渲染测试；类型/i18n/构建；技术方案证据附录 | AC-01–AC-26 | 所有 AC 对应用例通过；集成用例使用真实 `/wiki`/Skill 路由和 memory discovery；安全、跨页交错、日志提交点、bootstrap 中断与逐文件迁移恢复证据齐全。命令：`npm test`、`npm run build`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`、`npm run check:system-invariant-registry` | 本机 | - [x] |
| E-15 | 完成真实渠道与确认展示验收 | E-14 | `wiki-domain-tools-release-acceptance.md`；真实桌面/飞书/微信/automation 会话记录 | AC-10、AC-15、AC-19、AC-23、AC-24 | 逐项记录真实渠道授权、Schema/恢复确认、拒绝、取消、长正文可读性和 automation 无确认拒绝；记录应用版本、lane、匿名化证据和结论；任一失败不得通过。macOS 本地 IM discovery 与 Wiki config 传播回归：`npm exec vitest run electron/toolChatLoop.deferred.test.ts electron/runtime/invocationAssembler.test.ts -- -t 'IM lane 执行 memory discovery|propagates Wiki config into the registered tool execution context'`；该命令只验证源码回归，不替代真实微信通过证据 | 外部账号 + 桌面；源码回归可在本机执行 | - [～] |
| E-16 | 完成本次 macOS arm64 候选安装包与外部文件变化协调验收 | E-14 | `wiki-domain-tools-release-acceptance.md`；macOS 候选安装包；隔离 userData fixture | AC-11、AC-12、AC-16、AC-19、AC-20、AC-22、AC-26 | 在本次 macOS arm64 目标验证候选版本使用原有 Wiki 文件与存储位置；用旧版应用/外部编辑器修改 fixture Wiki 后启动新版，验证 reconciler 检测并协调页面、SCHEMA、raw 变化及 index/log 重建；确认迁移报告和目标标题冲突处理符合 AC-16；验证该 macOS 目标 userData 权限及现有 safeAtomicWrite 能力。Windows 与其他平台各自发布时单独验收，不阻塞本次目标。不得执行数据格式反向迁移；不得用真实用户数据代替 fixture，除非另有批准窗口 | 本次目标平台/安装包 | [验收记录](./wiki-domain-tools-release-acceptance.md)；本轮 `npm exec vitest run electron/wiki/wikiMigrationPreflight.test.ts electron/wiki/wikiMigrationCoordinator.test.ts electron/wiki/wikiMigrationJournal.test.ts`：3 文件/21 项通过（index 投影及同标题异路径用例先 RED、修复后 GREEN）；`npm run build:electron:incremental`、arm64 候选打包、签名验证通过；隔离候选 UI 完成 4 文件预检、6 对象迁移、原生确认和投影验证，6 个 manifest entries 全部 verified；最新候选 UI 对迁移标题冲突列出两条路径并禁用确认，取消后 Wiki/control 文件零变化。旧 index/log 备份 SHA-256 与原字节匹配。合并既有旧版写入后的 page/SCHEMA/raw 协调、标题冲突零写入、默认 userData 路径与权限/safeAtomicWrite 证据 | - [x] |
| E-17 | 在本次目标平台外部验收通过后启用领域工具与旁路规则 | E-14、E-15、E-16 | 本次 macOS 目标 Wiki 根 bootstrap seal、`.wiki-service/state.json`；发布记录；必要迁移 manifest | AC-01、AC-08、AC-11、AC-14、AC-16、AC-25 | 本次 macOS 目标适用的 E-15/E-16 项均有通过证据；目标 Wiki 根 bootstrap seal/state 身份匹配、格式有效且生命周期可从 domain_ready 转换；同一生命周期转换使新工具可用、当前版本旧路由改道、当前版本通用文件旁路门禁生效。旧版运行期间可直接写原 Wiki 文件，新版重启后通过 reconciler 协调，不设置旧版拦截或版本下限。Windows/其他平台没有因 macOS 证据被视为通过；在其平台发布/启用前另行完成对应平台外部验收。无本次目标适用记录、待复核或未知状态均不得启用 | macOS 候选发布 + 目标安装启用 | - [ ] |

### 2.1 DAG 与职责自检

- DAG 唯一真源是上表；无自依赖、跨阶段环或验收自环。
- E-03 只做文件模型/适配器；E-07 拥有生产 operation recovery 与 projection；E-05 只做只读预检/外部文件协调；E-13 仅对必要原位迁移维护 manifest 与重启恢复，无迁移时验收为无写入 no-op。
- E-10 在 E-14 前完成并以真实 `/wiki` 命令/Skill 本地链路验收；E-11 的生命周期 gate 也在 E-14 前完成，不依赖 E-17 启用。
- E-14 仅依赖本机证据。E-15/E-16 是外部任务，不阻塞源码；E-17 只依赖本次目标平台适用的 E-15/E-16 证据。其他平台验收归入各自平台发布，不阻塞当前候选目标。
- AC-01 至 AC-26 至少映射一项实现任务；需求稿仍是 AC 真源。

## 3. 阶段检查点

| 检查点 | 证据任务 | 通过条件 | 失败出口 |
| --- | --- | --- | --- |
| G0 决策与文件写入链路 | E-00、E-01 | D-TP-01~05 有裁决；旧版应用写入兼容事实已记录；现有 Wiki 根解析、identity 检查和安全写入链路完成源码复核与临时 fixture 验证 | 暂停文件模型实现；若现有安全写入链路不满足要求，修订方案；E-02 parser 可独立继续 |
| G1 文件模型与安全提交 | E-02、E-03、E-04 | parser/文件模型可独立通过；外部写入和目标抢占用例证明 no-overwrite；安全原语不支持时 fail closed | 不开始 E-05，不修改 Wiki 数据 |
| G2 外部协调与迁移预检 | E-05 | 页面/SCHEMA/raw 变化、alias、tombstone、冲突正确；dry-run 文件 hash 不变 | 停留在只读状态 |
| G3 领域读写 | E-06、E-07 | 真正 read/import/save/move；旧 revision 重试回放；pending 恢复不重复事件；projection failure 不报 success | 不注册新工具 schema |
| G4 SCHEMA 与历史恢复 | E-08、E-09 | 确认绑定正确；冲突零写入；最终恢复内容展示和 automation 拒绝通过 | 不接入 Agent 路由 |
| G5 真实入口与旁路 | E-10、E-11、E-12 | `/wiki` 命令/Skill 真实链路走 sourceId；真实 `memory` discovery/schema 注入和生命周期状态跨 registry/dispatch/policy/file IPC 一致；安全矩阵和 WikiPane 测试通过 | 保持 domain_ready；不运行原位迁移 |
| G6 迁移与源码关闭 | E-13、E-14 | 每文件故障可继续或停冲突；本机 AC、回退、类型、i18n、完整测试/构建证据通过 | recovery_required 或继续源码修复；外部验收未开始不影响 E-14 |
| G7 外部发布验收 | E-15、E-16 | 本次 macOS 目标适用的每项均有版本、环境、证据、结论和负责人确认；Windows/其他平台另列为其平台发布验收，不在本门禁范围 | 保持 domain_ready，不启用 |
| G8 发布启用 | E-17 | 本次 macOS 目标适用的外部签署证据齐备，目标 Wiki 根的状态与必要迁移清单通过；该结论不代表其他平台验收通过 | 不转 domain_enabled；保留原文件与诊断 |

门禁仅引用本行之前的任务证据。G0 不依赖数据库探针；G7 的外部证据在 G8 之前产出；不存在 G8 之后补验再追认启用。

## 4. 任务完成约定

- 每个实现任务须提供本行指定的定向测试；完成判据不可由 E-14 的全量测试替代。
- 主进程改动按任务合并运行 Vitest；安全任务同时断言 Policy facts/trace、permit final-check 和 executor/dispatch 未调用。
- 渲染契约变化运行 `npm run typecheck:renderer`；共享类型变化运行 `npm run typecheck:shared`；文案变化运行 `npm run i18n:generate-types` 和 `npm run i18n:check`。
- 安全 invariant 变化运行 `npm run check:system-invariant-registry`；locked Policy rules 仍由共享 Policy Engine 管理，不登记成 invariant 绕过策略。
- 按仓库纪律中间构建最多一次 `npm run build:electron:incremental`；E-14 才运行全量 `npm test` 与 `npm run build`。
- 每阶段收尾提交阶段变更，记录提交号、目标 AC、失败处理和可回退实体；不混入本计划建立前的其他工作区改动。
- 只有产物、任务完成判据和对应证据齐备才标完成；被决策、外部环境或 conflict 阻塞时保持未开始并记录阻塞依据。

## 5. 回退与启用次序

1. 只有确认存在必要原位迁移时才进入 `migrating`；先落 lifecycle/manifest，再改变目标文件。屏障只约束当前版本的旧命令、Skill、raw 导入、通用文件写入和新领域写入，不影响旧版应用或外部编辑器。没有迁移内容时保持 dry-run no-op。
2. 原位迁移中失败时，只能在每个活动目标仍为本次 new_hash、原文件备份与 manifest 相符时逐项恢复；全量原始清单 hash 核对完成后才恢复当前版本的 legacy 状态。任何外部差异都停在 recovery_required，不覆盖变化文件。
3. 外部渠道和安装包验收使用隔离数据副本。源码 E-14 关闭不等于发布启用。
4. E-15 与 E-16 全部通过后，E-17 核对目标 Wiki 根状态；若存在必要迁移则确认 manifest 全部 verified，否则确认迁移 dry-run 为 no-op；随后将 lifecycle 转 domain_enabled 并应用当前版本 locked bypass。
5. 首个领域写成功后保持 `domain_enabled`。用户启动旧版时，旧版仍能按原有行为写 Wiki 文件；本方案不尝试从新版拦截旧二进制，也不做数据格式降级。
6. 用户再次启动新版后，reconciler 检测并协调旧版期间发生的页面、SCHEMA、raw 变化，并按当前数据重建 index/log；不得用旧备份覆盖更新后的文件。
7. 不提供“受限试用”绕过外部门禁。若负责人希望试点，需另补适用范围与退出标准并更新需求决策、技术方案和 DAG。

## 6. 评审修订核销

| 评审项 | 计划修订 | 关闭证据 |
| --- | --- | --- |
| B-01 幂等重试顺序 | E-07 将 invocation 查询放到可变版本检查前，并持久化输入指纹/调用身份 | 成功后旧 revision 重试、pending 恢复、同键异参拒绝用例 |
| B-02 外部编辑竞态 | E-04 复用并对拍 safeAtomicWrite、Wiki mutex 与文件写工具既有竞态保护 | 外部变化被识别时拒绝写入并保留现有内容；不实现第二套文件提交协议 |
| B-03 迁移恢复窗口 | E-13 定义 step × 存在性 × hash 分支；覆盖 pending+new_hash 及 old_exists true/false | 写目标后、manifest 更新前崩溃；恢复补记不重写，回退只恢复旧文件或安全删除本次创建项 |
| B-07 跨页面/SCHEMA 约束 | E-07 域锁与锁顺序；E-08 在域锁内应用 Schema | 双向移动、重复标题、SCHEMA/页面交错及随机序列不变量测试 |
| B-08 日志投影循环 | `domain_committed` 是领域提交/事件成立点；投影读取 `domain_committed` 与 `completed` | 首次保存日志可见；两处崩溃恢复无漏记、无重复 |
| B-09 lifecycle 首次初始化 | E-11 建 seal/init 与分流；E-13 覆盖迁移期恢复 | 存量库/空库可达初始化；state/seal 损坏不重置，进入显式恢复 |
| B-04 源码入口/启用状态 | E-10 真实入口先于 E-14；E-11 统一 lifecycle；E-17 才执行外部启用 | 实际 `/wiki`/Skill 本地集成证据；状态跨入口对拍 |
| B-05 备份探针 | 按复用既有集中 Wiki 文件存储的裁决，移除 SQLite 备份探针和数据库门禁；E-01 核验现有文件安全写入链路 | G0 以源码复核和临时文件 fixture 为证，不新增数据库或存储备份方案 |
| B-06 外部验收 | E-15/E-16 必须先于 E-17，待复核不算通过 | 签署 release acceptance；未完成时停在 domain_ready |
| 隐性任务依赖/早期 GREEN | E-03/E-05/E-07/E-13 分开文件模型、协调、operation recovery、migration recovery 责任 | 每任务按定向命令独立关闭 |
| 命令路由与 safety contract | E-10 真实 sourceId 链路；E-12 明确 facts、Policy、permit、executor 模块和测试 | 集成/策略/最终检查用例逐任务运行 |
| P/E/G 对齐 | 技术方案 P0–P7 在 §2.10 映射 E/G；本计划 G0–G8 只引用先前任务 | 方案与 DAG 交叉核对 |

## 7. 计划维护

- 每次推进只改任务状态、证据和实际偏差，不在计划中重定义 AC/INV。
- 代码签名、需求 AC、D-TP 裁决或文件安全原语变化时，先修技术方案，再同步 DAG、门禁和目标命令，并保留修订记录。
- 任务新增/合并/重排时，重新核对依赖、P/E/G 映射和每条门禁的证据产出时间；不得只改表格中的依赖文本。

### 7.1 本轮执行证据（2026-10-20）

| 任务 | 提交/证据 | 验证结果 |
| --- | --- | --- |
| E-00 至 E-07 | 实现提交：`167aff40`、`ee8a601c`、`4c4874c7`、`458932cd`、`1882f85c`、`c62dbecb`；当前回归命令覆盖实际存在的 parser、file store、write service、reconciler/preflight、domain read/source、coordinator 测试 | 23 个测试文件、347 项通过；另含 file IPC、策略、WikiPane 和确认卡 |
| E-08 | `71aa517d`；提案前后全文由 tool input 展示，final-check 对比应用前 SCHEMA 和存储提案全文 | `wikiSchemaProposal.test.ts`、`wikiDomainTools.test.ts`、`wikiToolDiscovery.test.ts`、`GenericConfirmCard.test.tsx` 等 4 文件、43 项通过；Electron/renderer 类型检查通过 |
| E-09 | `9f873506`、`21ec6a40`；包含 tombstone 同 pageId 恢复、版本递增、冲突/确认/材料绑定，以及完整恢复正文确认展示 | `wikiDomainTools.test.ts`、`wikiHistoryService.test.ts`、`wikiToolDiscovery.test.ts`、`defaultRules.contract.test.ts`、`toolCallGate.test.ts` 共 177 项通过；确认卡测试 24 项通过 |
| E-10 | `c86aad50`；单文件与 `--all` 均通过主进程 sourceId 绑定，模型只获得绑定 ID | 3 个测试文件、50 项通过；Electron TypeScript 检查通过 |
| E-11 | `2d16c458`、`fbbbd8df`；bootstrap/lifecycle discovery、trusted backup fail-closed 与恢复核验 | 8 文件/55 项的阶段回归覆盖 lifecycle 与 migration 边界；类型检查通过 |
| E-12 | `d4980bb4`；补充 policy/gate 的 alias、case、dot-segment、absolute、shell、symlink 路径矩阵 | 4 个测试文件、187 项通过；拒绝后 executor 未调用和 file IPC 操作覆盖 |
| E-13 | `dbe843b2`；bootstrap 预检、WikiPane 审阅、主进程原生确认、hash final-check 与 journal resume 接通 | 8 文件/55 项通过；renderer/Electron 类型检查、i18n 检查通过 |
| 构建 | E-11 阶段提交 `2d16c458` 前执行 | `npx tsc -p tsconfig.electron.json --noEmit`、`npm run build:electron:incremental` 通过 |
| E-14 | `f5b27dbd`、`61e320a7`、`2737d84f`、`2703d5e5`；本轮 TDD 补齐 memory discovery 已声明但 runtime 未注册的 `save_page` / `move_page`，修正根页面入参契约、来源快照校验及符合领域格式的 Wiki 首启 no-op 预检；清理 Feishu/WeChat shutdown 后遗留的审计订阅 | RED：registry parity 测试明确缺少 `memory.wiki_save_page`、`memory.wiki_move_page`，新增 handler 测试因导出/注册缺失失败；实现后通过。最终 `npm test`：1108 文件通过、1 跳过；10495 项通过、111 跳过。`npm run build`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`、`npm run check:system-invariant-registry` 通过；构建有既有动态导入和大 chunk 警告。Wiki 工具、迁移预检和 channel shutdown 定向回归：7 文件/59 项通过 |
| E-15 | 桌面 Schema mock、真实 DeepSeek 长正文/取消、automation 拒绝已有通过证据；修复版 macOS 候选已收到新的真实微信 Wiki 搜索消息 | release acceptance 记录了旧候选的 `wiki_lifecycle_unavailable` 失败及修复版复验：新入站调用 `memory` discovery，返回 11 个操作 schema；随后发起 `memory_wiki_search(query=runtime)`，DB 调用状态仍为 `calling`，`wechat.confirm.prompt_delivery_settled` 证明确认提示已送达，尚无批准/拒绝及搜索结果。源码回归 `npm exec vitest run electron/wechat/weChatIpc.test.ts electron/toolChatLoop.deferred.test.ts electron/runtime/invocationAssembler.test.ts -- -t 'composes the WeChat router with Wiki config|IM lane 执行 memory discovery|propagates Wiki config into the registered tool execution context'` 3 项通过，但不替代真实搜索证据。飞书 CLI 1.0.98 用户授权已完成；隔离候选显示账号已授权、远程监听已连接，但 owner 绑定仍待完成，且候选 `appConfigured=false`，尚无真实飞书 Wiki turn。微信搜索确认仍待用户响应 | Codex / 2026-10-20 |
| E-16 | macOS arm64 候选包静态校验、旧版写入协调、page/SCHEMA/raw 外部变化、标题冲突零写入、默认 userData 路径与权限、safeAtomicWrite、迁移报告/确认/备份均完成 | 历史候选外部协调、冲突与默认 userData 证据见 release acceptance。本轮修复版 HEAD 执行 `npm run build:electron:incremental` 与 `npx electron-builder --mac dir --arm64 --config.directories.output=/private/tmp/wiki-domain-tools-release` 成功；`npm exec vitest run electron/wiki/wikiMigrationPreflight.test.ts electron/wiki/wikiMigrationCoordinator.test.ts electron/wiki/wikiMigrationJournal.test.ts` 3 文件/21 项通过。预检投影与同标题异路径冲突断言均先 RED，实现后 GREEN；协调器实测 index/log journal 备份逐字与 SHA-256 匹配。临时候选 `com.spaceassistant.wikidomaincandidate2` 通过签名校验，在 `/tmp/wiki-domain-tools-rerun-userdata` 隔离数据中由 Wiki UI 审阅 4 个 legacy 文件/6 项迁移对象，原生确认后迁移完成，manifest 所有条目 verified；生成 index 含原页面和迁移说明页面，log 只含服务生成格式。最新 `com.spaceassistant.wikidomaincandidate3` 对迁移说明与另一页面同标题的 fixture 显示两条冲突路径、禁用确认按钮，取消后文件哈希不变。详情与备份 hash 见 [release acceptance](./wiki-domain-tools-release-acceptance.md)。Windows/其他平台不属于本次门禁 | - [x] |
| E-17 | 未执行 | E-15 真实飞书/微信会话仍未完成；不得启用 `domain_enabled` |

| E-15/E-16 本轮补充 | E-15：桌面真实模型长正文确认/取消、automation 拒绝已通过；修复版候选微信入站已证明 memory discovery 可用，并将 `memory_wiki_search(query=runtime)` 确认提示绑定送达，但尚无批准/拒绝及搜索结果。飞书 CLI 1.0.98 用户授权现已完成；隔离候选账号授权、远程监听已连接，但 owner 绑定与真实 Wiki turn 未完成，`appConfigured=false`。E-16：修复版 macOS arm64 候选已完成 Wiki UI 预检、原生确认与迁移，index/log 投影纳入同一 journal，旧字节备份核验一致；其余默认 userData、外部 page/SCHEMA/raw 编辑、冲突零写入和权限证据沿用 release acceptance。E-15 未关闭；Windows/其他平台不阻塞当前 macOS 目标。E-17 未执行。 |

