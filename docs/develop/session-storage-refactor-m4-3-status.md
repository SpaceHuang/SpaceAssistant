# M4-3 旧消息读取路径退役门槛状态

> **当前待办以[技术设计文档前置的完整清单](./session-storage-refactor-technical-design.md#当前完整待办清单2026-10-05)为准。** 本文件下方是分日期追加的历史审阅证据，不是执行队列；其中“123 项工作区”“composer 接线待补”等描述仅反映记录当时状态，不代表当前状态。当前目录授权能力在 `origin/main` 已存在，应在分支集成时复用；当前分支不重写。M4-3 的真实发布观察、升级后 profile audit 和 owner 批准仍是 reader 删除/真实清理门禁，不阻断独立功能开发。

## 当前 M4-3 决策状态

- 源码审阅 A-00…A-12 已完成；A-12 仅放行 cleanup 默认关闭的 B 集成。详见[A-12 放行评估](./session-storage-a12-source-review-gate.md)。

- 本地候选生成/核对工具和合成集成验收：已完成。
- M3 inventory/run/worker 的数据层实现和隔离测试已完成；评审确认应用代码尚无 durable migration coordinator 调用入口。M3-6 应用入口安排在 origin/main 集成和 I-12 验收之后；M3-7 获授权补迁执行和 M3-8 正常升级后的只读审计/完整 disposition 是后续不同待办；不得把只读 census、schema upgrade 或 worker 单测记成正文补迁完成。具体依赖、授权及验收见[技术设计前置清单](./session-storage-refactor-technical-design.md#当前完整待办清单2026-10-05)和迁移计划 M3-6…M3-8。
- 正式版本观察、正常 schema upgrade 后的真实 profile 只读 audit、完整真实候选清单与 owner 决定：等待发布及外部证据；细项以技术设计前置清单 C 类为准。
- 旧 reader 保留；未获真实数据停写或清列授权。清理发布需区分默认关闭的 C-off 与重新打包、独立固定 hash 的 C-on；最终回滚审计必须针对实际 C-on 包，且数据集授权仍独立。细项以技术设计 v395 清单为准。

## A-10 源码 finding register（2026-10-05）

此表是 A-10 当前唯一 finding 状态。`已修复并复审` 表示隔离实现、回归和源码复核均完成；`延期并禁止阶段放行` 表示明确的范围 no-go，不表示风险已修复。

| ID | 严重度 | 责任任务 | 处置 | 回归证据 | 复审/放行状态 |
| --- | --- | --- | --- | --- | --- |
| F-A01-01 | P1 | A-10 | 已修复：只承认 `user/primary`、`remote/primary`、`automation/section` 三个产品组合；其它 ownership/visibility 组合 fail closed。 | inventory 与 migration suites 覆盖合法/非法组合及混合 cohort。 | 已复审；scope finding 不再阻断 M3。 |
| F-A03-01 | P1 | A-10 | 已修复：worker 处理时复核 cohort；canonical projection 读取、cache 认证与 eligibility 写入在 SQLite writer fence 事务内原子完成，scope 漂移回滚并使 run 进入 needs_attention。 | migration 与 inventory suites 含 certification 期间漂移回归。 | 已复审；scope 漂移不可留下 cache/eligibility 或产品 scope 更新。 |
| F-A05-01 | P2 | A-10 | 已修复：每次 afterPack 生成唯一 build UUID 和 target，观察日志及报告按 `artifactBuildId` 隔离；报告保留 build ID 到发布 manifest artifact SHA-256 的映射要求。 | logger、build identity、observation report suites 通过。 | 已复审；生产观察仍等待 R-06/R-07 的独立发布任务。 |
| F-A05-02 | P1 | A-10 / R-06 | 已修复实现门槛：report 必须显式输入正整数 read/shadow 最低样本、非空 required path 集合；不足或缺路径自动 no-go。样本数/路径的具体值等待 owner 批准 R-06。 | observation summary/CLI suites 覆盖小样本、跨 build 混样隔离与 required path。 | 已复审；R-06 未批准前正式观察仍 no-go。 |
| F-A06-01 | P2 | A-10 | 已修复：spill 扫描失败提供稳定 error codes 和 `complete=false`；未知分类/体积输出 `null`，estimate completeness 明示 reference、source/degraded 扫描失败。 | profile 与 estimate suites 通过。 | 已复审；未读取真实 profile，真实数据任务仍依其独立授权。 |
| F-A07-01 | P1 | SC-SCOPE（依赖 I-12） | 延期并禁止阶段放行：未实现 profile/session/认证快照/owner/有效期授权范围；SC-SCOPE 是计划已定义后续工作。 | 当前 release 开关默认关闭；未有有效 scope 时 C-on 生产部署/清理必须保持禁止。 | 阻断 C-on 真实部署、执行及其终审；不阻断 A/B、C-off 或隔离演练。owner 执行责任待 SC-SCOPE 授权记录明确；恢复条件为 I-12 完成后实现并通过 SC-SCOPE/SC-SCOPE-PKG。 |
| F-A08-01 | P1 | A-10 | 已修复：VACUUM 前要求 DB 字节摘要一致、归档 SQLite integrity/FK 检查通过、spill 与 spill-degraded 逐文件相对路径/长度/SHA-256 一致；失败时不得进入 VACUUM。 | maintenance suite 覆盖 archive 内容校验及等长 spill 篡改拒绝。 | 已复审；未验证的归档不得进入 VACUUM。 |
| F-A08-02 | P2 | A-10 | 已修复：maintenance busy guard 将 claims 与 queue 的 `queued` 纳入阻断状态。 | maintenance suite 覆盖 queued claims 与 queued queue。 | 已复审；queued 工作阻止维护。 |

A-10 最终验收：14 个定向测试文件、97 项通过；cleanup boundary 检查通过；`npx tsc -p tsconfig.electron.json --noEmit` 通过；`git diff --check` 通过。随后补充 build identity UUID/target 与当前发布目标一致性 fail-closed 校验及回归（该单测 4 项通过，Electron typecheck 与 diff check 再通过）。F-A07-01 是唯一保留的 P1 no-go，明确限制真实 C-on 部署/清理，不影响 A/B 与 C-off；因此无未处置的 A/B 阻断 finding，A-10 关闭并进入 A-11。

以下为截至各记录日期的审阅证据；过时的任务建议不得覆盖前述当前状态或技术设计前置清单。

## 决策对象

M4-3 要求移除仍在支持范围内的旧 transcript reader，并用回归与代码搜索证明所有受支持会话仍可读、旧 flag/分支不再活跃。它与 M4-3a 的方案 B 正文基线补迁评审不同。

既有 M4-3a 方案 B 决定只批准开发和隔离验收 `history-absent` 会话的 canonical 正文基线能力；不批准真实 profile 写入、reader 删除、停写或清理。当前实现仍保留 legacy reader，并由其服务尚未迁移且获准保留的 `legacy_required` 会话。

## 当前证据

- M4-1 候选范围报告及 M3-5 一致性审计已通过合成 SQLite 集成验收；真实 profile 仍为 schema v46，尚无 durable migration run，不能据此生成真实 profile 的完整候选清单。正常应用升级后，仍需只读运行新 schema 的 census/audit 并归档候选报告。
- M4-2 的日志记录和离线报表工具已完成隔离验收，但没有该方案正式发布版本的观察周期与归档报告。工具测试或本地 synthetic app 日志不替代正式版本观察。
- 截至 2026-10-05，本地和 origin tag 检查均只发现最高 `v0.2.3`；发布 workflow 只对指向 `main` 的 tag 启动。当前 `codex/session-storage-refactor-tdd` worktree 的源码和测试仍有未提交改动，不能作为正式 R 发布或观察证据。
- 当前分支与 `origin/main` 分叉：分支比较为 ahead 28 / behind 21。只读 `git merge-tree --write-tree HEAD origin/main` 预演报告 16 个内容冲突，涉及技术方案、schema/migration、History、IPC、package 与 i18n；预演未改工作区。预演时有 82 项未提交/未跟踪改动；随后增加 schema 兼容测试，当前为 83 项，均未包含在 HEAD-only 预演中。合并前需先逐项确定两侧行为如何组合，并纳入这些工作区改动的审查；不能用简单快进或机械选边解决。
  冲突文件为：`docs/develop/session-storage-refactor-technical-design.md`、`electron/appIpc.sessionUpdate.test.ts`、`electron/database/migrations.agentHistory.test.ts`、`electron/database/migrations.ts`、`electron/database/migrations.v11.test.ts`、`electron/database/operations.ts`、`electron/database/schema.ts`、`electron/database/thinkingEffort.test.ts`、`electron/database/usageStatsFacts.test.ts`、`electron/ipc/sessionIpc.ts`、`electron/outbound/outboundAcceptor.ts`、`electron/runtime/canonicalHistory.ts`、`electron/sessionTitleSuggest.ts`、`package-lock.json`、`package.json`、`src/renderer/i18n/types.ts`。其中 schema/migration、operations、IPC、outbound 与 canonical History 冲突触及行为或持久化契约，需结合双方对应测试逐项整合；锁文件与生成类型也要在源文件确定后重新核验。
- schema 冲突已具体核对：`origin/main` 的 `DB_SCHEMA_VERSION=33`，存储分支 HEAD 为 v46；两侧的 `migrations.ts` 都包含 v30→v33 迁移但逻辑有差异，分支提交还增加 v34→v46，当前未提交工作区再增加 v47→v50。集成必须合并保留 main 上 v31–v33 的新增持久化语义，并验证受支持旧版本、main v33、分支 HEAD v46 与工作区 v50 profile 的升级；HEAD-only merge-tree 没有包括 v47–v50，不能把它当完整冲突预演。不能只接受分支一侧的迁移代码或单纯 bump schema version。
- 已先按 TDD 修复迁移编号冲突的一部分：main v33 fixture 首轮红测报 `no such column: generation`；main v30 fixture首轮红测显示 `retry_of_message_id` 未创建。当前 `migrations.ts` 将 main v31 continuation-intent/retry、v32 continuation context、v33 automation/session/usage 字段与存储迁移的同号步骤合并；从 main v33 进入存储 v34 前，再幂等补建 canonical repair queue、History cursor/order 与 generation。main v30、v31、v32、v33 兼容 fixtures 加三组既有迁移回归共 45 项通过，相关数据行与 History 顺序保持。Electron TypeScript 检查和 `git diff --check` 通过。该局部修复不代表分支已合并或 R 可发布。
- 已逐项审阅 `canonicalHistory.ts` 的分叉差异：保留 main 引入的跨 invocation 稳定 ID 快照折叠，同时必须保留存储分支的 stable message ID 转换、anonymous replay 过滤、interrupted pending tool 读取语义和投影 watermark 校验；这些约束在当前 `sqliteAgentHistory.ts` 的完整 L2 fold 与缓存 L1 tail fold 路径均有调用。`canonicalHistory.test.ts` 与 `sqliteAgentHistory.test.ts` 聚焦复验共 194 项通过。该文件的行为审阅完成，尚未进行实际分支合并。
- `sessionTitleSuggest.ts` 冲突审阅：当前需求与存储分支定义按三条已完成 assistant 触发；标题补全读取必须保留 `getProjectedMessages`，避免 canonical-only 老会话读空。main 最近改为按可见 user/assistant 数触发，属于当前需求文档未采用的产品语义，不与 canonical reader 混为一谈。main 的失败重试语义经真实内存 SQLite + mock 标题服务补入：红测复现缺少 API Key 后 attempted 标记残留，修复后 4 个标题/tool-loop 测试文件 38 项通过，Electron incremental build 与 diff check 通过；未调用真实模型。该项局部组合完成，分支尚未合并。
- `toolChatLoop.ts` 在线标题差异审阅发现存储分支虽装配了标题 persistence port，但未在 Hosted turn 成功后调用，导致自动标题只剩老会话打开补全路径。先写调用链红测确认未触发，再于 Hosted 结算成功后接回调；门槛使用 History 重放后的 assistant 数 + finalization `modelTurns`，摘要输入使用 finalization 完整 user/assistant History 消息。保留当前三条 assistant 产品门槛与 stable assistant ID 写入；不采用 main 对可见 user/assistant 计数的语义变化。Hosted 成功/失败 TDD 与 deferred/lane/safety 4 个文件 47 项通过，Electron build 通过。local fake provider + mock title service，不请求真实模型。
- Hosted handoff 冲突复核确认存储分支的 stable assistant message ID 绑定以及“completed History terminal 缺少 transcript participant 时 commit-uncertain 并保留 claim”围栏都应保留。为后者新增直接行为回归：先提交已有 transcript，再注入 accepted History context + completed terminal 而不写 transcript participant，断言旧投影版本保留、checkpoint/claim 进入 `commit_uncertain`，后续 turn 无法取得执行 claim。Hosted handoff 46/46 通过；仅测试代码改动，mock Hosted 调用，不连接真实模型服务。
- `operations.ts` 冲突审阅发现 main 的 `fixedWorkDir` 创建/读取语义在存储分支的会话读写层缺失。按 TDD 增加 SQLite create/get 回归：先红测确认传入目录落库为 NULL，再为 `Session`、row mapping 和 create INSERT 接入该字段；完整 `operations.test.ts` 90 项、Electron typecheck 与 `git diff --check` 通过。保留存储分支的活跃 turn 删除拒绝、正文清理账本及 source-truth spill GC 逻辑。该项局部行为已组合，尚未完成分支合并。
- 再审 `operations.ts` 当前工作区与 `origin/main`：fixedWorkDir 当前已有 create/get 覆盖；queued turn 从 continuation intent 恢复 continuation context，`prepareTurnAtomically` 原子写 retry lineage、acceptance 和 History；usage facts 保存 model/provider/route identity，并保留 schema v51 旧 profile identity 与 orphan turn recovery。存储侧 skeleton/body 分离、revision/cutover fences、active-turn delete fence、spill GC 与 usage recovery 未丢失。`operations.test.ts`、`usageStatsFacts.test.ts`、`turnCoordinatorStorage.test.ts` 当前状态共 145 项通过。该冲突项的行为审阅完成，整个分支仍未合并。
- 按原始冲突清单复核 `thinkingEffort`：schema 版本断言更新为当前 v51，nullable override、旧开关键映射、非法值继承与跨会话隔离保留；`thinkingEffort.test.ts` 20/20 通过，无需修改实现。
- 按冲突清单复核 usage facts：model catalog ID/provider model name/route identity 从 invocation assembler 传至 SDK recorder，逐步事实、turn 汇总和 crash orphan recovery 均保留，旧数据 NULL 兼容；迁移、DB facts、usage recorder、SDK recorder 4 文件 40/40 通过，无真实模型调用。
- 按顺序复核 `sessionIpc.ts`：目录授权、上下文压缩和 session deletion IPC 保留 trust boundary，删除成功后才唤醒 spill GC。新增不可信 sender 对目录授权变更和 context compaction 的拒绝测试；appIpc session update/delete suite 15/15，连同目录 grant、thinking IPC、compaction transaction/summary 隔离测试合计 42 项通过。fake app context 注册时的 startup recovery stderr 为 `conn.exec is not a function`，不影响 handler assertion。未执行真实模型摘要请求；端到端 provider 调用需用户配置凭据时再停下请求配置。
- 按顺序复核 `outboundAcceptor.ts`：queued count、失败消息/source identity、context-pressure 只读路径改用 skeleton；canonical History 负责失败摘要。新增 canonical-only 已接受 turn 重试回归，先红后改为 projected assistant reader，避免清理 legacy 正文后重复 request 返回空 assistant；消息行缺失时 fail closed。另将队列续接测试的 source session 改为 legacy body 清空、canonical-backed-only，证明失败摘要与稳定 request ID 经 queue claim 恢复。outboundAcceptor、update-queued IPC、TurnCoordinator storage 74/74，Electron typecheck 与 diff check 通过。仅 SQLite/mock，无模型调用。
- 按顺序完成原始 16 项 merge-conflict 清单的最后一项 `src/renderer/i18n/types.ts`：确认由脚本生成，`npm run i18n:check` 通过（1,155 条硬编码中文均在测试，源码为 0），无需重生成。至此冲突文件的行为审阅清单完成；工作区当前 123 项改动仍需整体审阅并纳入集成方案，HEAD 分叉提交的集成与验证尚未开始。全程没有调用真实模型服务。
- 开始按序复核 `origin/main` 的 21 个分叉提交：已读失败 Turn 续接方案及实现、Agent SDK 派发中止/History 补洞修复、canonical session snapshot fold 和 Butler continuation 队列唤醒竞态。续接方案要求失败来源稳定可见、显式区分从头重试与 checkpoint continuation，并把输入 intent/摘要/队列受理与 request ID 幂等持久化；存储工作区对应的 SQLite intent、retry lineage、History 摘要与 canonical-only 重试读取已有定向组合证据。snapshot fold 的稳定 ID/order 校验已在当前工作区接入，并将分隔符字符串比较改为逐元素比较以避免 ID 碰撞。Agent SDK 派发中止修复仍只存在于 `origin/main`：它填补未派发工具 History 结果、避免稀疏结果数组洞；当前 storage reader 已理解 `tool-call-not-dispatched`，但 SDK 变更本身尚未集成/复验，不能遗漏。此处只做提交审阅和状态记录，没有 merge/cherry-pick，也没有真实模型请求。
- 又审阅了 main 的 Butler 固定 workDir/model-service/thinking 配置、title policy 迭代、Vitest 并行配置及 release test-provider build 变更。main v31–v33 的 automation/workDir/thinking 持久字段已在存储迁移兼容夹具中保住；Butler 的任务级精确 model-service/workDir snapshot 尚未进入 storage 工作区，集成时要保留。标题门槛由第三条 assistant 改为第三条可见 user/assistant，和本方案当前策略不同；工作区沿用 canonical projected reader 与第三条已完成 assistant 语义，最终合并前需按项目需求裁定，不能机械采用 main 或存储分支。macOS Vitest threads 并行、dot 进度、provider package test build 和跨平台 fixture 变更属于本机验证/测试基础设施，应检查后纳入；Windows 打包/安装/运行仍按用户指示跳过。
- 复核 continuation queue 唤醒竞态的具体修正后，确认当前 `outboundAcceptor.ts` 已在事务提交后通知 drain，并在 `SESSION_TURN_BUSY` 时用相同 request ID 降级入队；canonical-only queue claim 回归验证摘要和稳定 request ID 可恢复。main 后续 title quota 修复排除纯 tool_use/tool_result，当前回填仍从 projected messages 读取；最终产品门槛需把“可见消息计数”与现行“三条 assistant”一起裁定。
- 复核 main 的 session directory grant 全链：IPC 绑定当前桌面 renderer/session，grant 记录带真实路径及 `dev/ino/mode` 身份，prompt 只提供选定目录提示，读许可由 canonical path fact + lane/session scoped grant matcher 决定。当前工作区的 grant record/manager/matcher 与 session IPC 相关代码和隔离用例已在，但 `invocationAssembler`/`toolCallGate` 与 composer/preload renderer 接线仍只在 `origin/main`；集成必须一并纳入，不能把有记录/能展示误报为授权读取能力已接通。
- 在上述审阅后重新执行只读 HEAD-only `git merge-tree --write-tree HEAD origin/main`：得到临时 tree `378a72f6…`，仍为原 16 个内容冲突；比较两侧改动路径，35 个 tracked path 有工作区与 main 同时修改，需要按已完成行为审阅整合。另有 12 个本地未跟踪文件与 main 新增路径重叠（directory grant 与 context compaction modules/tests），逐文件 SHA-256 与 `origin/main` 完全一致；合并前需保留这些证据并消除 Git untracked overwrite 冲突，不能直接启动 merge。预演不包含当前 123 项工作区内容；未改写、暂存或删除任何改动。
- 对 `HEAD..origin/main` 的 21 个提交已按顺序完成分类审阅；合并决策和仍待集成的 SDK、Butler 与目录授权调用链均已记录。另核对现存干净 `codex/session-storage-refactor-integration` worktree：HEAD `9503cb78`，相对 `origin/main` ahead 21/behind 4，与当前 TDD branch 的 merge-base 是 `9f9faa1d`，因此它是另一条历史集成支线，不等同于本分支的集成结果；未切换、修改或复用其状态。接下来按迁移计划阶段顺序审阅 123 项当前工作区变更，再为含工作区变更的集成预演做准备。
- 对当前 123 项未提交改动按路径作了初步单归属：M3 migration/inventory 31、M4-2 observation 6、M4-4/5 profile/estimate 14、M4-6…M4-9 cleanup/maintenance 17、rollback/build boundary 2、cross-cutting runtime/main feature 30、docs/evidence 5、未归类 18。此为审阅导航，不视为逐行审核；下一步按 M3→M4→§8.8.5 顺序核对实现与既有验证证据，并先处理 18 个交叉文件。
- 当前源码下重新运行 M3 核心链六个定向测试文件，55/55 通过；M4-2 observation summary/CLI、agent logger/projection 四个测试文件 20/20 通过。覆盖 internal-hidden scope/History 损坏、durable run/audit 边界、空/坏观察日志和未知 transcript outcome 阻断。测试只用本地 mock/隔离 SQLite，无真实 profile 写入或模型请求。
- 按后续阶段复验 M4-4/5：`sessionStorageProfile.test.ts` 与 `sessionStorageCleanupEstimate.test.ts` 2 个文件 7/7 通过，fixtures 都在临时 synthetic SQLite/profile 下创建。覆盖 dbstat 全部表/索引、canonical 必留字节、日志脱敏和不修改 DB、session event/spill 分类及保守 DB shrink 上限；未运行实际 profile 采样/清理脚本，未接触用户数据。
- 按顺序复验 M4-6…M4-9：正文 cleanup maintenance、SQLite maintenance、production cleanup gate/config、build identity、afterPack metadata 七个测试文件 41/41 通过；静态 cleanup boundary 检查和 `git diff --check` 通过。隔离用例覆盖默认关闭、发布兼容 pin、认证/停写/pending 续跑、维护 archive 和恢复空间、活动 turn fence、VACUUM 硬终止后 reopen 与 canonical/spill 不变。afterPack 行为仅在单测 harness 中模拟，未构建新正式候选包或触碰实际数据。M4-8 的启动改善仍未证明，生产清理仍需正式 rollback floor 和逐数据集授权。
- 按冲突清单对 `canonicalHistory.ts`、`sqliteAgentHistory.ts` 和 projection 调用链复验；snapshot replacement、stable IDs、anonymous replay 过滤、pending tool 读取与 watermark checks 保留。三个直接 suite 307/307 通过，未产生新的生产代码改动。
- `sessionIpc.ts` 冲突已按 TDD 局部组合：增加 renderer 信任边界、目录授权与上下文压缩 handlers，并过滤 renderer 在 session create/update metadata 中伪造的 `sessionDirectoryGrants`；删除仍在 spill-root fence 内执行，DB 删除失败不唤醒 GC，成功后才唤醒。新增 metadata 伪造回归先红（update 可写入伪造授权），修复后与目录授权、matcher、压缩锁/流程/summary 单测共 6 个文件 31 项通过；Electron typecheck 和 `git diff --check` 通过。压缩 IPC handler 未在测试中调用，未请求真实模型服务；真实总结请求与真实目录授权交互仍未验证。该文件局部组合完成，不等于分支已合并。
- `appIpc.sessionUpdate.test.ts` 差异现同时保留存储分支的 title custom 与 session delete 后 spill GC 唤醒边界，并包含 main 的 create/update directory-grant metadata 防伪测试；13 项 suite 通过。fake app context 的启动恢复会打印 `conn.exec is not a function`，这些用例仍只证明 mock IPC patch，不证明实际 filesystem grant 流程；真实授权逻辑另由 sessionIpc/目录授权测试覆盖。
- `outboundAcceptor.ts` 已开始组合 main 的失败续接/重试路由与存储分支的正文读取边界。引入 main 的 34 项回归后先红 19 项；按当前 History 身份合同修正测试上下文，再接入 stable request ID、canonical 失败摘要、续接状态消息、续接 status 序列化和 queued claim 中的事务化上下文恢复。只需读取状态/身份的检查继续使用 `getMessageSkeletons()`，包含排队统计、source/status 查找和上下文占用计算；续接消息/附件仍随稳定 request ID 持久化。outbound/排水器 59 项、operations 90 项通过，Electron typecheck 与 `git diff --check` 通过。此为本地组合，不是分支合并；`agentProtocolIpc.ts` 的真实 startContinuation/findRetrySource 接线和完整跨层恢复验收仍待审阅。
- 随后已完成 `agentProtocolIpc.ts` 的真实接线：retry source 只读取失败 assistant 的 skeleton；checkpoint continuation 核对 desktop lane、原始执行安全快照，并用 canonical History 初始化 continuation。`TurnCoordinator.prepareAtomic` 现传递稳定 acceptance 与 retry lineage；SQLite 同事务写 acceptance、turn retry 关系、用户/assistant 消息和首条 `session-input-committed` History，队列 claim 恢复持久 continuation context。新增 TurnCoordinator 原子传递回归 1 项通过；Electron 5 个受影响文件 172 项通过，Electron typecheck 与 `git diff --check` 通过。测试全为本地 mock/SQLite，不发模型请求。尚未执行真实模型 continuation，因此只证明持久化/路由与安全校验契约，模型服务行为仍未验证。
- 真实 profile 只读 census 已记录在 [scope census 复核](./2026-10-05-session-storage-scope-census-review.md)，但它基于旧 schema，不包含新格式 canonical fold audit。该事实不授权对真实 profile 做升级、补迁或清理。

## 模型服务测试约定（2026-10-05）

- 用户已在本机配置过日常大模型服务。此前隔离包探测使用 synthetic provider，且停在 macOS Keychain/renderer 初始化之前；它只能说明该探测没有验证真实 provider，不能据此断言本机没有模型配置。把“没有模型配置”当成事实，是错误的归因。
- 已执行的存储迁移定向测试均为 mock/隔离 SQLite 测试，没有发起真实模型请求；这些测试结果只对本地存储、路由与 mock 契约有效，不代表真实模型服务可用。
- 后续若计划中的步骤确实需要真实模型请求，先暂停该步骤并请用户协助确认/配置用于测试的服务，再继续；未配置或无法确认时，不启动可能请求模型的进程，也不把失败归因于功能代码。继续可独立完成的 mock、SQLite、静态检查工作不需要等待模型服务。

## 当前结论

**M4-3 不放行。**尚缺正式发布版本的 M4-2 观察报告、正常 schema upgrade 后的真实 profile 只读 audit、基于完整 audit 的真实 M4-1 候选清单，以及产品/技术 owner 针对 reader 删除的单独批准。现有方案 B 评审不能代替这些条件。

## 按顺序继续的工作

1. 原始 16 项冲突文件和 `origin/main` 21 个分叉提交的逐项审阅已完成。接下来按迁移计划阶段顺序完成 123 项工作区改动的归属与证据核验，再把两侧已审阅的行为纳入集成预演、按序解决冲突并验证。之后按项目正式流程审阅并合入实现，发布兼容候选 R，并长期保留可取回的安装包和身份/摘要证据。正式发布与签名遵循各自发布策略；此处不把发布策略改写为本地功能门禁。
2. R 正常升级 profile 后，只读生成新 schema 的 scope census、canonical consistency audit 与 M4-1 全量候选清单；任何未知、遗漏、差异或未解决的 `legacy_required` owner 都保持 no-go。
3. 在正式发布版本观察周期结束后，用 M4-2 报表工具归档指定版本和时间范围的 transcript path、shadow 差异、recovery/cutover 事故及耗时统计。空样本、坏日志、差异、失败或超预算均不能通过。
4. 将以上真实证据交由产品/技术 owner 单独决定是否移除 reader，并为每种受支持 legacy exception 明确替代读取路径。
5. 只有 owner 批准且所有受支持会话都有已验证读取路径后，才执行 M4-3 reader 删除、回归和无活引用搜索；真实正文清理仍受 §8.8.5 的独立 rollback-floor 与逐数据集放行约束。

此状态记录是证据边界说明，不构成 owner 批准，也不触发发布、真实 profile 修改或生产清理。
