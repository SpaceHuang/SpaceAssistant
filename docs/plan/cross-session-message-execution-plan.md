# 跨会话消息投递执行计划

> 基线：[v1.4 技术方案](../develop/tools-mcp/in-flight/cross-session-message-technical-design.md)，文件 Git blob `1e6f70357c36615a9bcf78d849de0ee708dc1948`；实现源码基线由 B04 固定为 main `ce1f382eab0d258f3e6a61e814bd31760cc341db` 及其后代。需求验收、状态、接口、迁移和回滚规格以方案为准。

## 0. 开工边界【人必读】

先验证本机能否在不接外部服务的情况下重现发送、撤回、执行和等待链路。开发者用临时数据库、真实本机运行时和替身模型验证。负责人已按方案推荐项批准来信保存格式与撤权边界；B-01 五项设计条件完成复审，具体入口屏障仍须由实现测试验收。

其他平台、候选安装包和真实模型账号只用于本功能发布验收，不阻断本机开发、测试或源码关闭。上游触发器代码合入 main 并通过本计划 B02 定向测试，即满足源码集成基线；不要求先正式发布上游安装包。正式发布只属于发布验收，不作为迁移、等待集成或源码关闭的前置。真实 IM 发送不在本期验收范围；本机用调用计数核对没有平台外发。排查入口、构造样本、设计竞态和恢复测试由执行者负责。

## 1. 阶段交付与回退【人机共读】

| 阶段 | 输入与交付 | 允许改动与隔离 | 回退及兼容 |
|---|---|---|---|
| 准备 | 核对本机工具链、现有触发器源码和已批规格；记入口与测试基线 | 本计划及证据；不安装到用户数据目录、不改生产代码 | 无数据改动 |
| P1 存储与来源 | 交付迁移、可信来源、请求与撤回、批准刷新和最终接纳事务 | 存储、数据库、共享类型及就近测试；不注册新工具/条件 | 按方案 §11 回退阶段提交或恢复升级前整库；保留旧格式读取，仅替换指定删除关系 |
| P2 桌面能力 | 交付服务、策略、排水、模型材料、全部执行与恢复核验 | 工具、排水、IPC 内部处理、运行时、历史和装配；新工具仅在本机测试装配暴露 | 阶段提交可回退；已接纳事实不得清除；不移除旧触发器或普通输入门禁 |
| P3 等待与源码关闭 | 交付准确等待、一次通知、全链回归和本机关闭演练 | 原触发器、装配与测试；使用临时库完成完整功能接线，候选发布前保持方案 §11 的未启用安排 | 回退阶段提交或恢复整库；不移除旧条件、旧通知授权或引入永久开关 |
| 发布验收 | 记录正式版本和目标平台证据；按已批准合同启用 | 正式发布与启用由发布负责人执行 | 对应旧版本及整库备份；发布关闭与源码关闭分别记录 |

方案 U-01 改为本机源码集成核验：确认触发器合入 SHA 是 main 祖先，并在 B04 检出通过 B02 的定向测试。该证据满足正式迁移与等待集成的源码前置；不依赖上游正式发布。B04 将已有隔离检出前移到当前 main 后代，重走依赖与基线测试，不在旧 schema 上分配迁移号。U-02 用本机 Electron SQLite 临时库核验，U-03 用替身捕获实际适配器输出并核对策略，U-04 留给本功能候选包和真机发布验收。Python 机制实验不抵扣应用级用例。

### 检出与文档版本

B01 先用 `git worktree list --porcelain` 定位检出，再用 `git -C "$impl_dir" rev-parse HEAD`、`git -C "$impl_dir" status --porcelain` 验证目标 SHA 和干净状态。可以复用匹配的隔离检出；若没有，由执行者在实施时选择独立目录，例如 `git worktree add --detach "$impl_dir" 3e992dde1304cb7913ce03cc250958123f678c23`。不在带有既有修改的项目目录切分支、装依赖或覆盖文件。记录绝对路径、完整 SHA、锁文件摘要，再在该目录准备工具链；本计划修订不创建实施工作树。

计划版本和方案版本单独固定：本轮计划修订前从 main 提交 `837790650d8be267e578881869562755579970a8` 读取，方案基线为 v1.2 blob `f4728862aa16c24cff0fee06324f39489c34117b`，修订版 v1.4 blob 见本计划头部。B04 将实施检出从旧基线前移至 main `ce1f382eab0d258f3e6a61e814bd31760cc341db` 后代，记录旧、新 SHA、锁文件与重跑结果；基线变更后不沿用旧通过证据。

## 2. 依赖表【机｜人工可跳过】

此表是唯一顺序来源；逗号表示全部前置均满足。无依赖的任务可独立启动；并行任务改到同一文件时，由执行者串行落补丁。阶段出口只消费表中前置任务已产出的证据。

| 任务 | 前置 |
|---|---|
| B01 | 无 |
| B02 | B01 |
| B03 | B02 |
| B05 | B03 |
| E01 | 无 |
| B04 | B03, E01 |
| S01 | B04 |
| S02 | S01 |
| S03 | S02 |
| S04 | S03 |
| S05 | S03 |
| S06 | S05 |
| S07 | S04, S06 |
| S08 | S07 |
| A01 | S08 |
| A02 | A01 |
| A03 | A02 |
| A04 | A01 |
| A05 | A02, A04 |
| A06 | A05 |
| A07 | A06 |
| A08 | A03, A07 |
| A09 | A08 |
| A10 | A09 |
| T01 | A10 |
| T02 | T01 |
| T03 | T02 |
| T04 | T03 |
| T05 | T04 |
| T06 | T05 |
| T07 | T06 |
| T08 | T07 |
| E04 | T08, E01 |
| E02 | E04 |
| E03 | T08, E02 |

## 3. 任务登记【机｜人工可跳过】

除标明外部的 E04/E02/E03 外均为本机任务，由实现者执行，阶段出口由复核者核查。E01 是上游源码集成与定向测试证据，不再要求正式发布；E04/E02/E03 属本功能候选与发布流程，不进入源码门禁。每行只有一个进度标记；关闭时附源码 SHA、测试名/命令、结果及证据位置。建议用 `docs/plan/evidence/cross-session-message/<任务ID>.md` 保存脱敏摘要，大日志留在临时目录；不要记录正文、密钥或令牌。

下表 `vt <路径>` 代表 `npm exec vitest run <路径>`，从 B01 记录的检出根运行；B04 完成后，以 B04 记录的 main 后代实施检出根为准；同阶段路径合并运行。标“拟”的测试文件须在对应任务落地时建立，若采用现有测试文件替代，在证据中更新实际命令。授权屏障在相应实现前写具名用例；若记录 RED，必须以同一命令复跑 GREEN，且 RED 只接受目标行为缺失，环境/既有失败单记。涉及事务的用例使用真实 SQLite；策略、故障、时钟和模型可注入，不替换被测裁决器。

| 任务与状态 | 目标文件 / 模块与产物 | 完成判据、对应验收和证据 |
|---|---|---|
| - [x] B01 建立本机依赖基线 | `package.json`、锁文件、本机临时测试目录；环境记录 | 隔离目录、干净状态、main 集成基线 SHA 和锁文件摘要已复核；Node ≥22.13、npm、依赖及 Electron SQLite 探测记录见 `docs/plan/evidence/cross-session-message/B04.md`。PI provider 构建和 SQLite 探测通过（AC-08/19）。 |
| - [x] B02 固定触发器与绕过入口基线 | `electron/triggers/`、`turnRuntime.ts`、`ipc/agentProtocolIpc.ts`、`claudeStreamHandlers.ts`、`main.ts`；入口清单 | `vt electron/triggers/{protocol,recovery,delivery,authorization}.test.ts electron/turnRuntime.test.ts electron/claudeStreamHandlers.callerContract.test.ts`；记普通、触发器及 UUID 经双执行入口、直接 IPC/模型入口、启动/续跑恢复到 source/provider 的调用位置。重基线结果与入口清单见 B04；54 项测试通过。准备 V-04/07/09（AC-05/08/19）。 |
| - [x] B03 固定批准后的实施合同 | 方案 §0、§7～10 和 B-01 复审记录；合同与覆盖索引 | 负责人批准 D-02/D-04 推荐项；技术方案 v1.4 记录裁决；B-01 五项设计关闭条件复审见 `docs/plan/evidence/cross-session-message/B03-review-preparation.md`。实现屏障测试仍由 A/T 项验收。 |
| - [x] B05 提前验证独立接收投递（可选） | 独立检出中的现有 desktop 排水、服务测试和临时库；可移植补丁或验证记录 | 用临时 fixture 验证现有接纳回执、忙闲与队列顺序；`npm exec vitest run electron/outbound/outboundDrainer.test.ts`，25 项通过。证据见 `docs/plan/evidence/cross-session-message/B05.md`。仅为 V-02/04 独立投递子集，不预占迁移号、不接等待触发器、不替代 P1/P2。 |
| - [x] E01 核实触发器已集成 main | 触发器合入 SHA、main 祖先关系及 B02 定向测试记录 | `28bec58e` 是 main `ce1f382eab0d258f3e6a61e814bd31760cc341db` 的祖先；B04 SHA 上 B02 定向测试 54 项通过。证据见 `docs/plan/evidence/cross-session-message/E01.md`。正式发布不作为源码前置。 |
| - [x] B04 固定 main 实施检出并复验 | E01 集成 SHA、本机 Git 对象、批准后的合同、B01/B02 记录；实施基线卡 | 实施 worktree 已前移至 main `ce1f382eab0d258f3e6a61e814bd31760cc341db` 后代；路径、干净状态、锁文件与 B01/B02 重跑结果见 `docs/plan/evidence/cross-session-message/B04.md`。后续按该 main schema 排迁移号；正式触发器发布与源码实施无关。准备 V-04/07/09（AC-05/08/19）。 |
| - [x] S01 落地单列迁移 | `electron/database/{schema,migrations}.ts`；`electron/database/migrations.agentSessionMessage.test.ts` | `npm exec vitest run electron/database/migrations.agentSessionMessage.test.ts`：3 项通过；v123→v124 迁移逐列保留旧回执、校验复合 PK/FK/索引、拒绝入向外键依赖，覆盖重入、事务回滚和未来版本拒绝。代码提交 `6ba6db2a`；证据见 `docs/plan/evidence/cross-session-message/S01.md`。V-07（AC-08/19）。 |
| - [ ] S02 严格识别并保护来源 | `electron/database/queueInputSource.ts`、`electron/sessionStorage/`、`src/shared/domainTypes.ts`；可信解析及读取分类 | `vt electron/database/desktopQueueCompatibility.test.ts electron/ipc/agentProtocolIpc.updateQueuedMessage.test.ts` 及拟 `electron/database/agentSessionMessageStore.test.ts`；旧 NULL 兼容，正文/前缀伪造不升级，未知版本拒绝，IM、编辑和导入不能改写来源。V-03/07/09（AC-02/04/19）。 |
| - [ ] S03 写入原子接纳与幂等收据 | `electron/database/operations.ts`、`electron/sessionStorage/`；窄命令端口 | `vt electron/database/agentSessionMessageStore.test.ts`；并发同 owner/key 一条、跨 owner 独立、目标或原始正文变化冲突、写入窗口故障全回滚。这里只验持久收据，不验唤醒。V-02/07（AC-04/08/09）。 |
| - [ ] S04 实现未执行终态和准确结算读取 | 同存储端口、删除及清理写口；结算查询 | `vt electron/database/agentSessionMessageStore.test.ts electron/database/desktopQueueCompatibility.test.ts`；旧普通收据显式清理，来信墓碑保留，五类原因及时间冻结、终态后幂等不依赖正文、已领取准确绑定 Turn、非 owner 不可见。V-02/05/06/07（AC-08/10/14/15/16/17/20/21，存储子集）。 |
| - [ ] S05 刷新执行批准并保留原绑定 | `electron/sessionStorage/`、`electron/database/operations.ts`；批准读写端口 | `vt electron/database/agentSessionMessageStore.test.ts`；排队态的旧摘要 CAS、批准代次及摘要绑定、原始绑定不变、未知或不一致材料拒绝。此项用批准样本，真实策略在 A02。V-09a/d（AC-19）。 |
| - [ ] S06 在领取事务提交最终接纳凭据 | `electron/database/operations.ts`、`electron/sessionStorage/`；事务和宿主历史锚点 | `vt electron/database/operations.queueScope.test.ts electron/database/agentSessionMessageStore.test.ts`；受控屏障验证旧批准不能建 Turn；逐写口注入故障，无半套 claimed/Turn/历史/admission；旧普通和触发器仍可领取。V-07/09a/d（AC-08/19/20，存储子集）。 |
| - [ ] S07 实现撤回 CAS 并验证竞争 | `electron/database/operations.ts`、`electron/sessionStorage/`；撤回写口与存储状态机用例 | `vt electron/database/agentSessionMessageStore.test.ts electron/database/operations.queueScope.test.ts`；两种胜序、他人/重复/已领/其他终态；重开库无复活；固定种子跑接纳、领取、撤回、删除、结算、重开子集。V-05/08/09d（AC-07/08/12/14/15/16/17，存储子集）。 |
| - [ ] S08 关闭 P1 并提交 | P1 测试、数据库临时样本、阶段提交 | 汇总 S01～S07 证据，执行 §4 存储门禁与本机 Electron 旧库对拍；确认新能力未暴露。仅关闭 V-02/03/05/07/08/09a/d 已实现的存储子集（AC-04/08/09/15～17/19），不标记后续端到端通过。 |
| - [ ] A01 封装可信发送和撤回服务 | 拟 `electron/capabilities/sessionMessageService.ts` 及同名测试、`capabilities/types.ts` | `vt electron/capabilities/sessionMessageService.test.ts`；所有权×可见性×lane、隐藏同不存在、非法零写入；持久接纳即返回，唤醒失败不回滚收据。V-01/02/05（AC-01～04/08/09/11/15～18，服务子集）。 |
| - [ ] A02 接入写策略和排队批准刷新 | `electron/capabilities/handlers/session.ts`、现有 toolkit 策略/审计与宿主批准适配；具名决策轨迹 | `vt electron/capabilities/handlers/session.test.ts electron/capabilities/sessionMessageService.test.ts`；各档位确认/拒绝/允许，记录实际 rule ID 与 trace；新批准经策略，final-check 只核验；接纳前撤权、策略或目标代次变化时，拒绝或按方案刷新，拒绝零 dispatch。V-01/09a（AC-03/11/18/19）。 |
| - [ ] A03 接入工具发现与结构化读取 | `electron/capabilities/handlers/session.ts`、工具注册及共享 DTO、错误资源；测试装配 | `vt electron/capabilities/handlers/session.test.ts`；发现/调用两个写工具，验证回执和稳定错误；read 截断保留 source，纯消息导入不升权。V-01/03（AC-01/02/04/11/18/19）。 |
| - [ ] A04 实现持久接纳核验与 TurnRuntime 守卫 | `electron/turnRuntime.ts`、coordinator、宿主存储读取及装配端口 | `vt electron/turnRuntime.test.ts`；双 execute 入口在执行或 source callback 前强制核验，缺端口拒绝，匹配原凭据的 UUID 不因来源撤权被重批；损坏、材料不一致零调用并终结原 Turn，普通和触发器门禁保持。V-09b/c/d（AC-19/20）。 |
| - [ ] A05 封闭直接 prepare/execute IPC | `electron/ipc/agentProtocolIpc.ts`、`electron/main.ts`、拟 `electron/ipc/agentProtocolIpc.agentSessionAdmission.test.ts` | `vt` 拟测试；直接 prepare 从可信来源刷新并领取，拒绝客户端伪造；直接 execute 经 A04；验证无效 token/租约、合法接纳后撤权和损坏凭据。V-04/09a/b/c（AC-05/07/19）。 |
| - [ ] A06 封闭直接模型入口并构造来源材料 | `electron/claudeStreamHandlers.ts`、宿主历史适配；实际 provider 输入捕获 | `vt electron/claudeStreamHandlers.callerContract.test.ts electron/claudeStreamHandlers.hostedIntegration.test.ts`；直接入口缺材料零 provider/handoff；捕获上下文、压缩/恢复、正文伪造输入，验证来源不变为用户批准，旧 SDK 历史仍可读；不把批准放进执行配置。V-03/09b/c（AC-02/04/19/20）。 |
| - [ ] A07 接入桌面排水与唤醒 | `electron/outbound/`、`electron/main.ts`；排水入口与释放后补唤醒 | `vt electron/outbound/outboundDrainer.test.ts`；无窗口启动、忙/确认只排队、租约释放补扫、桌面顺序及与手动/触发器/IM 竞争、斜杠正文不执行；首轮加三次、busy 不计失败、存储恢复、零 IM 消费和出站。V-04/09（AC-05/06/07/09/12/18/19）。 |
| - [ ] A08 接入启动与继续执行恢复 | `electron/main.ts`、会话恢复、排水和 hosted 执行装配；重开库屏障证据 | `vt electron/sessionStorage/recovery.test.ts electron/outbound/outboundDrainer.test.ts electron/claudeStreamHandlers.hostedIntegration.test.ts`；queued 重新核验当前批准，claimed 查持久凭据或原准确 Turn orphan 终态；双重恢复不复制或退队，损坏零 source/provider，已接纳历史继续走原工具策略。V-04/07/09b/c/d（AC-05/08/12/19/20）。 |
| - [ ] A09 验证授权与副作用全入口 | 上述集成测试；B-01 入口与屏障证据矩阵 | 合跑 A02、A04～A08 测试；按入口标明 V-09a～d 适用性与证据，核对真实调用计数、现有 Turn 终态、目标目录不借全局切换、日志不含正文。通知结算留给 T06。V-01/03/04/09（AC-01～07/11/12/18/19/20）。 |
| - [ ] A10 关闭 P2 并提交 | P2 阶段证据及提交 | 引用 A01～A09 与 S08；合并运行 P1 受影响回归与 §4 P2 门禁，复核 B-01 授权用例已覆盖桌面路径，未注册生产新能力。V-01/03/04/09（AC-01～07/11/12/18/19/20）。 |
| - [ ] T01 解析等待条件及登记权限 | `src/shared/domainTypes.ts`、`electron/triggers/` protocol、hostService、注册 handler；条件和基线 | `vt electron/triggers/protocol.test.ts electron/triggers/hostService.test.ts`；仅 owner 本会话、准确请求、无 active Turn 也可登记、未知版本拒绝；旧条件对拍。V-06/07（AC-10/13/14/19～21，登记子集）。 |
| - [ ] T02 以持久事实匹配等待 | `electron/triggers/` sources、service、recovery；结算适配及 revision CAS | `vt electron/triggers/{sources,service,recovery}.test.ts`；先订阅再读与登记返回前对账；快速终态不漏，准确 Turn、四种 outcome、五种未执行原因、source-gap、到期及取消竞态；重启不重复匹配。此处验事件落库。V-06/07（AC-10/13/14/20/21）。 |
| - [ ] T03 复用一次性通知投递 | `electron/triggers/` delivery、receiverStarter；固定请求键与结果更新 | `vt electron/triggers/{delivery,receiverStarter,recovery}.test.ts`；覆盖匹配后未投递、投递后未更新两个崩溃窗口，忙时排队、同 key 不重复、缺口与通知 Turn 分别记录、owner 删除不新建会话。V-06/07（AC-10/14/20/21）。 |
| - [ ] T04 封闭目标删除后的授权链 | `electron/triggers/` hostService、authorization、sourceContext、runtimeMaterials 与 delivery；共享 owner 事实授权适配 | `vt electron/triggers/{hostService,hostAuthorization,authorization,delivery,sourceContext,runtimeMaterials}.test.ts`；登记/对账/投递/重放/模型材料逐入口验证；目标删前和删后登记均可通知 owner，拒绝跨 owner、错误基线或当前通知撤权，零目标正文读取、零平台出站；通知仍走原触发器接纳。V-06/09（AC-10/14/19/20/21）。 |
| - [ ] T05 跑完整固定种子状态机 | `electron/triggers/invariants.test.ts` 及来信存储、排水集成 fixture；种子及最小失败序列 | `vt electron/triggers/invariants.test.ts electron/database/agentSessionMessageStore.test.ts`；用方案 V-08 全部动作对拍，含登记/取消/重启和派发失败；每步断言接纳、执行、通知唯一性、终态不复活及 scope 隔离。V-08（AC-07/08/12/14/16/20）。 |
| - [ ] T06 合跑端到端矩阵 | `electron/claudeStreamHandlers.hostedIntegration.test.ts`、触发器及存储集成 fixture；完整追溯表 | 用真实临时库、替身模型和渠道 spy 联通工具→排水→执行→通知；合跑 S/A/T 相关定向命令。逐条对照方案 §13 的 V-01～09、AC-01～21；包含 V-09c 的原 Turn 失败通知、删除目标端到端与通知授权屏障，记录实际通过用例，不能用单层通过代替。 |
| - [ ] T07 演练本机关闭和整库回退 | 方案 §11、临时应用库与旧版源码/构建产物；演练记录 | 在本机停止 writer，验证备份、升级、故障回滚、升级后恢复原整库及旧应用重开；对拍旧行/FK、无新增收据遗留，记录备份后写入丢失边界。验证未注册时不能产生新格式业务数据；不对用户库演练。V-07（AC-08/14/19/20）。 |
| - [ ] T08 关闭源码阶段并提交 | 最终构建/测试记录、P3 阶段提交 | 核对 T01～T07、A10 的证据与方案全量映射；执行 §4 最终门禁；记录外部缺项和发布状态，不把它们计入源码失败。V-01～09（AC-01～21，本机范围）。 |
| - [ ] E04 产出并交接可验收候选包 | **候选打包，发布负责人或现有打包流程**；基于 T08 的隔离候选提交、平台包与清单 | 候选接通已批的新工具和等待条件，供隔离账号/临时数据目录验收，不对用户分发。记录 T08 SHA、B04 main 基线 SHA、候选 SHA、接线差异、各平台打包命令（`npm run pack:mac` / `npm run pack:win` 或现有等效流程）、产物路径、SHA-256、版本、隔离启动方式及烟测结果。若 main 基线或接线以外代码变化，先核对合同并完成受影响复验，再重建和交接；E02 只接收完成复验的这批包。准备 V-03/04/07/09（AC-05/08/19）。 |
| - [ ] E02 验证候选包与真实模型 | **外部，发布验收人**；E04 清单、对应 macOS/Windows 候选包、真实模型账号 | 按清单验证 SHA-256、平台、版本及新能力已接线，按 U-04 在隔离配置中记录安装/重启、无窗口启动、真实模型来源识别、审批边界及关闭/恢复证据。V-03/04/07/09（AC-05/08/19）；缺项只标相应发布场景未验。 |
| - [ ] E03 审核发布并按已批合同启用 | **外部，发布负责人**；发布记录、备份及回退定位 | 核对待发布包与 E02 已验包一致；产物或接线发生变化，回到 E04/E02 复验受影响项。引用 T07 演练与 T08 源码验收，核验备份及旧版本可用，再面向用户启用。V-07（AC-08/14/19/20）。 |

## 4. 本机阶段门禁与证据【机｜人工可跳过】

- **S08（证据生产者 S01～S07）**：合并执行相关 Vitest 命令，并运行 `npm run check:session-storage-boundary`、`npm run check:session-storage-cleanup-boundary`、`npm run check:message-fact-ownership`。用 B01 已验证的 Electron 运行时跑迁移样本，保存生产迁移入口、旧行对拍与回滚输出；Vitest 记录和附录 B 不能替代 Electron 对拍。
- **A10（S08、A01～A09）**：合并 P2 与受影响 P1 回归，运行 `npm run build:electron:incremental` 一次、`npm run typecheck:shared`、`npm run check:agent-sdk`、`npm run typecheck:agent-sdk`、`npm run check:system-invariant-registry`。涉及错误资源时运行 `npm run i18n:generate-types`、`npm run i18n:check`；涉及渲染类型时运行 `npm run typecheck:renderer`。安全记录列 facts / policy / final-check / invariant 阶段、实际 rule ID 与 failure case、边界测试命令。
- **T08（A10、T01～T07）**：从本地依赖运行 `npm test`、`npm run build`，复核受影响门禁与完整覆盖表，附 T07 回退证据。阶段收尾只提交本阶段改动；先记测试所用源码 SHA，提交后核对差异并关联阶段提交。本功能候选打包、真机和真实模型验收不进入本段门禁；上游 main 合入 SHA 和本机集成测试由 E01/B04 核验。

## 5. 执行中的规格偏差【机｜人工可跳过】

证据发现格式、授权边界或入口与方案不符时，记录受影响任务及方案 ID，先修订规格，再重排依赖；未受影响的本机任务继续。单纯路径、命令或任务拆分变化只更新计划。B-01 设计复审、运行用例通过和发布关闭是不同证据，不互相代记。

## 6. 本轮评审修订索引【人机共读】

对照 2026-11-05 计划修订：负责人确认合入 main 并通过本机集成测试足以作为源码基线；移除上游正式发版作为实施前置，E01 改为 main 集成核验，B04 前移到当前 main 并重跑基线。E04→E02→E03 仍分别负责本功能候选包、验收与正式启用。
