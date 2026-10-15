# 安全策略三阶段架构与硬编码规则收敛开发计划

- **日期：** 2026-10-15
- **状态：** 已审批；可以进入源码实施阶段（2026-10-15 第三轮复审通过）
- **背景会话：** `af47dc41-29ae-46ab-9885-bab3c4805852`
- **基线问题：** 用户实际授权安全审核 Agent 批准 outbound 调用后，`agentSdkConfirmationPort` 仍通过后置硬编码分支强制拒绝；同类“策略之后还有一层代码判决”可能散落在 gate、通道适配器和执行器中。
- **相关材料：**[工作目录边界与策略分层缺口分析](./session-d961cc51-boundary-policy-layering-gap-analysis-and-followup-plan.md)、[工作目录边界与策略分层实现追踪矩阵](./session-d961cc51-boundary-policy-layering-implementation-matrix.md)、[IM 安全审核改进开发方案](./2026-10-11-im-security-review-improvement-development-plan.md)、[安全策略统一入口需求](../requirement/security-policy-single-entry-requirement.md)。

> 本文记录已对齐的架构与迁移基线，尚未开始代码实现。迁移先保持既有策略效果，再把用户可调整的差异放入显式策略规则；任何有意改变默认行为的产品调整另行明确提出，不作为本次重构的隐含副作用。

## 1. 推进目标

把当前安全处理清晰整理为三个职责阶段，并让所有会改变授权结论的产品规则只有一个明确的策略归属：

1. **事实核实与补充（Fact production）**：检查工具调用及上下文，生成可追溯事实。这里只陈述观测结果，不做 allow / confirm / deny 判断。
2. **请求决策（Policy decision）**：读取可信事实和生效策略，唯一决定 `allow`、`require-confirm` 或 `deny`，并记录命中的规则、回答者与理由。策略 Agent 是策略的裁决组成部分，不应在其结果之后被未登记的产品规则静默改判。
3. **执行前最终检查（Execution authorization check）**：核对有效授权是否存在、是否对应本次调用，以及即将执行的实际对象/参数/版本是否仍与被批准对象一致。发现授权缺失或对象变化时阻止执行并记录授权/机制失败，不重新做风险分类或另造策略 verdict。

同时建立系统底线逻辑的统一登记入口。它用于明确记录不可被一般策略配置覆盖的系统约束及其所属阶段、输入、效果和审计方式；登记入口不是第二套有隐形优先级的 policy engine。除真正的身份、完整性、平台能力与生命周期不变量外，用户可配置的 allow/confirm/deny 选择应属于第二阶段的显式策略。

## 2. 设计原则与边界

### 2.1 三阶段职责矩阵

| 阶段 | 可以做 | 不可以做 | 典型输出 |
|---|---|---|---|
| 事实核实与补充 | 解析目标、收集调用来源/目标/范围/身份、运行事实检测器、说明检测覆盖和不确定性；保留来源和证据指针 | 因某事实“敏感”而自行拒绝；把分类器标签当最终 verdict；把探测失败伪装成命中某策略 | `ToolFacts`：`evidenceKinds=[token-like-pattern]`、`inspectionCoverage=complete|partial|unavailable`、`factId`；是否据此要求审批由第二阶段规则决定 |
| 请求决策 | 按 lane/domain/package、显式规则和可审计的策略 Agent 输出唯一策略决定；需要时生成精确待确认对象 | 在策略结果形成后再用散落的 if/regex/通道特例改写决定；将事实探测混入策略匹配但不记录 | `PolicyDecision`：`allow / require-confirm / deny`、`ruleId`、`answerer`、`reasonCode`、`factsVersion` |
| 执行前最终检查 | 核对 decision/confirmation/permit、requestId/toolUseId/inputDigest、目标/收件人/附件/版本/授权代次；做签发后身份与机制复核 | 重新判断内容是否敏感、重新推导 outbound 风险结论、按执行工具自行扩大/缩小普通策略；用 veto 覆盖原 decision 审计 | `ExecutionAuthorizationResult`：`authorized / missing-authorization / subject-mismatch / stale-or-revoked / mechanism-failure`，并与原 decision 关联 |

### 2.2 “系统底线登记入口”的适用准则

登记项必须能回答：**为什么它不能用普通策略表达？属于哪个阶段？它能拒绝还是只能校验？谁能改变？如何观测？**

建议每项至少包含：

```ts
type SafetyInvariantRegistration = {
  id: string
  owner: string
  phase: 'facts' | 'decision-floor' | 'execution-integrity'
  category: 'identity' | 'integrity' | 'capability' | 'lifecycle' | 'platform'
  description: string
  appliesTo: string[]
  effect: 'enrich-facts' | 'constrain-decision' | 'validate-authorization' | 'block-execution'
  overrideability: 'not-configurable' | 'policy-configurable'
  auditEvent: string
  tests: string[]
}
```

此结构是契约草案，不要求照此字段名实现。入口可以是静态注册表加 lint/测试，也可以是现有策略契约扩展；Phase 0 应先核查仓库现有 policy floor/locked rule/SDK capability contracts，避免创建重复的全局配置系统。

**禁止用法：** 把所有安全相关 if 都登记成 `decision-floor`，使登记表变成另一份隐藏规则表；登记不等同于合理，必须经过分类和必要性论证。不能因“底线”标签而拥有未声明的策略覆盖优先级。

### 2.3 分类判据

- 若逻辑回答“观测到了什么/分类器认为是什么”，属于**事实生产**。
- 若逻辑回答“按当前策略是否允许这类请求”，属于**策略决策**，需要显式规则或策略契约表达。
- 若逻辑回答“已批准的精确动作是否仍然是眼前要执行的动作”，属于**执行前授权/完整性校验**。
- 若逻辑回答“未授权调用不能递归调用审批器”“撤销/代次变化后旧 permit 不可使用”“SDK capability 未授权不能进入执行”等，则可能是**系统底线/生命周期机制**；须登记，并证明不属于可配置业务策略。
- 一个代码块若同时做事实分类与 verdict、或策略判断与对象完整性检查，应拆分，而不是给混合块贴单一标签。

## 3. 当前已知候选及初步归位

下表是计划输入，不是最终裁定；实施前要以当前工作树重新逐项核实函数调用链、所有 lane、配置能力和测试。

| 当前逻辑/入口 | 初步归位 | 计划动作 | 关键问题 |
|---|---|---|---|
| `electron/confirmation/agentSdkConfirmationPort.ts` 中 Agent 批准 outbound 后仍强制 deny | 第二阶段策略改判，当前属于未登记隐式策略 | 将当前 outbound 审批者选择迁为有 ruleId、适用范围和回答者的显式策略规则；确认 port 只消费策略结果和匹配的审批凭据 | outbound 档位值明确为：宽松直接放行、标准由安全审核 Agent 审批、严格由真人审批；规则在策略阶段产生该结果，adapter 不得在 Agent 批准后静默改判 |
| `electron/confirmation/toolCallGate.ts` 中 workdir 外写入覆盖既有决策 | 第二阶段策略改判，若是路径事实探测失败则拆分 | 将路径范围事实前置；普通工作目录外的 allow/confirm/deny 由生效 policy rule 决定；删除 decision 后覆盖 | 区分目标归类、permit 机制边界和策略偏好；不能削弱身份变化、symlink/hardlink、原子写等执行完整性保护 |
| `src/shared/confirmation/outboundClassification.ts` 的敏感内容/批量导出等启发式分类 | 第一阶段事实生产 | 输出标签、证据类别、覆盖/不确定状态；由第二阶段显式规则消费 | 检测结果本身永不阻断；inspection incomplete/unavailable 作为事实输入规则；日志不记录原始 secret/消息正文 |
| 微信/飞书出站工具中的附件路径、附件内容、目标账号、会话和 payload 检查 | 混合：分类/目标事实入第一阶段；已批准对象匹配和字节/版本绑定入第三阶段；“禁止某类目标”策略入第二阶段 | 拆分纯观察、显式策略判决、授权对象校验；保留精确 dispatch 防护 | `electron/tools/weChatToolExecutor.ts` 等检查是否有仅机制复核，还是直接产生策略拒绝；对用户的结果原因需能区分 |
| `electron/remote/remoteToolPolicy.ts` 独立策略路由 | 第二阶段策略域/规则契约问题 | 与共享 Policy Engine 做语义盘点，逐规则迁移或证明其为不同信任域；避免同名规则双实现 | 远程 lane 可能有不同默认风险边界；目标是规则可见、语义一致，不假定所有 lane 使用相同动作 |
| `electron/confirmation/toolCallGate.ts` shell 快捷预检/自动批准路径 | 混合：命令效果分析属于第一阶段；是否放行属于第二阶段；执行器/取消/预算是生命周期机制 | 确保 precheck 只向策略提供事实或调用同一策略决策；不可在已命中显式 ask/deny 后提早放行 | 排查快捷路径的调用顺序、未知事实、审计归因和每个 lane 的效果 |
| 策略锁定/不可覆盖规则、策略 floor 验证 | 通常第二阶段决策约束，同时是系统底线登记候选 | 统一说明 floor 的依据、范围、谁可变更、如何参与 policy decision；与普通规则同一 decision trace | locked rule 是明确策略还是不可变系统能力约束，须按具体规则分类，不一概而论 |
| 递归审批保护、二次确认限制、审批 Agent 能力准入、缺失许可/撤销/版本检查 | 多为第三阶段/SDK 生命周期底线 | 建登记项与一致的失败类别；保持 fail-closed，并报告原 decision 与执行失败的关联 | 哪些属于准入资格，哪些属于执行完整性；不能误作为用户配置规则 |
| WeChat/Feishu/remote 的出站最终检查 | 主要第三阶段 | 规范 exact subject binding：recipient/channel/session/body digest/attachment identity/authorization generation 等 | 需避免把合法的安全约束迁移为“策略规则”后导致无法保证 dispatch 对象一致 |

## 4. 执行约定：每项任务的关闭证据

后续实施按任务 ID 追踪。任务不能仅以“代码已改”或“测试通过”关闭，必须同时满足该任务列出的产物和完成判据。发现需要新拆分的逻辑时，先补任务条目再改代码。

任务状态直接在 ID 前的复选标记上维护：`- [ ]` 未开始，`- [～]` 进行中，`- [x]` 完成。阻塞或待评审时保持当前未完成标记，并在任务产物/证据栏注明原因；只有产物和完成判据都具备证据后才改为 `- [x]`。

每个候选逻辑的最小追踪记录包含：候选 ID、文件/函数、触发条件、真实调用顺序、适用 lane/tool/tier、对授权结果的影响、归属阶段、决策依据、目标变更、测试/审计证据、状态。Phase 0 清点时把 §3 每行拆成一个或多个候选 ID。

## 5. 逐任务开发计划

每项任务均可独立更新状态。完成后将该项 `- [ ]` 改为 `- [x]`；开始处理中改为 `- [～]`。

### Phase 0：建立可以评审的基线和边界

- [x] **P0-01 · 建立源码基线并登记外部证据缺口**
  - **动作：** 记录当前源码 commit、package/build 版本、配置与 schema 迁移基线；另列正式包、生产日志/数据库的可用性、保管人和无法映射的证据项
  - **产物：** `security-policy-baseline.md` 的源码基线与外部证据清单
  - **完成判据：** 源码任务可仅凭仓库基线继续；生产会话结论明确标记证据来源，未取得正式包/生产数据时只限制“原生产问题已复现”的声明，不阻塞源码分析和实现
  - **验证 / 依赖：** 仓库版本、配置/schema；正式包与生产数据仅为可选外部证据

- [x] **P0-02 · 三阶段架构契约**
  - **动作：** 把 §2.1 每阶段写为输入、输出、失败类型、禁止副作用和责任模块；补一张调用次序图
  - **产物：** 架构契约文档/图
  - **完成判据：** 任意候选点能按判据唯一映射到 facts、decision、final-check；混合点被标出拆分边界；approve 后 reject 的位置能明确解释为违反哪条契约
  - **验证 / 依赖：** 静态追踪；依赖 P0-01 的源码基线

- [x] **P0-03 · 扫描策略决策出口**
  - **动作：** 搜索 policy engine、gate、confirmation adapter、remote policy 中所有 allow/deny/confirm/answerer 变更；沿调用链区分初判、策略最终输出、最终检查
  - **产物：** 候选 inventory，含候选 ID 和代码位置
  - **完成判据：** 每个命中点有“影响授权/不影响授权”的判定、调用者、lane/tool/tier；搜索范围及排除依据可复查
  - **验证 / 依赖：** rg + 调用链核查；静态检查，不因命中词就定性

- [x] **P0-04 · 扫描事实分类和探测逻辑**
  - **动作：** 盘点敏感内容、批量导出、权限修改、路径、附件、shell 效果等分类器；记录目前是否有副作用或 verdict 分支
  - **产物：** inventory 的 facts 类章节
  - **完成判据：** 每个分类器明确输入字段、输出信号、错误/unknown 行为、使用方；凡同时返回拒绝/阻断的混合项有独立候选 ID
  - **验证 / 依赖：** 代码及调用点核查；依赖 P0-03 初步顺序图

- [x] **P0-05 · 扫描最终执行检查与系统底线**
  - **动作：** 盘点 permit、digest、identity/version、撤权代次、recursion、SDK capability、平台/生命周期限制；逐项说明阻止执行的原因
  - **产物：** inventory 的 final-check/invariant 章节
  - **完成判据：** 每项都能证明是在策略前资格校验、策略决策约束、批准对象完整性检查或机制失败中的哪一种；“只是安全相关”不能作为分类
  - **验证 / 依赖：** 代码、测试和审计事件；与 P0-03/P0-04 合并核对

- [x] **P0-06 · 候选逐项分类与反例检查**
  - **动作：** 对 inventory 每行选 `facts / policy / final-check / invariant / mechanism / functional / duplicate / false-positive`；混合行拆开；记录依据和反例
  - **产物：** 候选归位矩阵
  - **完成判据：** 所有候选都有唯一归属或明确拆分；每个 `invariant` 写出“为何不能由策略配置”的理由；每个 `policy` 写出可配置维度
  - **验证 / 依赖：** 由实现者交叉复核；依赖 P0-03～05

- [x] **P0-07 · 将已对齐原则映射到候选规则**
  - **动作：** 按 §6 的已确认基线，把 outbound、outside-workdir write、敏感内容、事实不完整、档位和 lane 条件映射到规则与现有策略配置
  - **产物：** policy-baseline 对照表
  - **完成判据：** 每个决策型候选都注明显式规则位置、档位取值、lane/tool 条件、所属规则列表的实际顺序语义、约束层 precedence 和审计来源；无“adapter 另有最终否决”
  - **验证 / 依赖：** 规则与配置静态核查；依赖 P0-06

- [x] **P0-08 · 确定底线登记表的代码落点**
  - **动作：** 核对 `security-policy-single-entry-requirement.md` 与现有 policy storage/IPC/runtime/locked floor；把底线登记定位为源码级目录/表，由代码评审与 CI 校验，不作为运行时规则存储
  - **产物：** 入口能力对照表和登记表落点
  - **完成判据：** 唯一源码真源、owner 和校验命令明确；用户策略存储与底线目录职责分开；不增加第二套运行时策略或决策排序
  - **验证 / 依赖：** 文档与现行实现核对；依赖 P0-05

- [x] **P0-09 · 定义关联审计字段**
  - **动作：** 盘点已有 request/toolUse/fact/decision/approval/permit/veto/dispatch IDs 和脱敏；标出缺口
  - **产物：** 字段映射表和审计链样例
  - **完成判据：** 可从一个脱敏样例按 ID 还原 facts→decision→approval→final check→dispatch；缺失阶段能定位；确认原始正文/API key/附件正文不进入审计
  - **验证 / 依赖：** SQLite/日志 schema 检查；不需真实外部 dispatch

- [x] **P0-10 · 建立已定基线的验收矩阵**
  - **动作：** 按 §6 已确认值填 action×tier×answerer 矩阵；lane 仅作为统一规则系统的条件；事实不完整的动作按当前版本的各档位配置取值
  - **产物：** 已填期望值的行为矩阵、测试清单
  - **完成判据：** outbound（宽松 allow/标准 Agent/严格真人）、outside-workdir write（宽松与标准 Agent/严格真人）、敏感内容（宽松 Agent/标准与严格真人）、事实不完整（按当前版本档位配置）以及 approval mismatch/撤权都有明确预期和审计 ID；Phase 1 的入口证据齐全
  - **验证 / 依赖：** 对照当前策略配置和规则；依赖 P0-01～09

- [x] **P0-11 · 记录源码交付与发布验收范围**
  - **动作：** 将源码/CI 可完成项与需要正式包、生产数据、跨平台文件系统或真实 IM/MCP 的验收项分开，记录后者的环境、责任方和缺口；默认源码阶段可独立关闭
  - **产物：** 分层验收范围及外部依赖清单（`security-policy-baseline.md`、`security-policy-three-stage-development-decisions.md`）；Phase 0 全量测试结果见 `security-policy-phase0-test-record.md`
  - **完成判据：** 每项外部验证都标明其阻塞的具体发布声明；外部资源缺失可记为“待外部验收”，不阻塞源码交付
  - **验证 / 依赖：** 仓库/环境清单；依赖 P0-01～10


- [x] **Phase 0 关闭门槛：** P0-01～11 都有产物及证据；每个策略型候选都映射到显式规则或既有默认；B-01～B-04 已确认档位值按矩阵落地；本阶段不产生矩阵外的策略变化。外部证据缺口单独登记，不阻塞源码基线关闭。Phase 收尾已按仓库纪律运行全量 `npm test` 并记录退出码 1 及当前源码基线失败；源码未改，详细分类见 `security-policy-phase0-test-record.md`。后续相关切片按记录中的路径补齐定向回归，最终全量验收再次核对是否引入。

### Phase 1：把事实生产改成纯事实输出

- [x] **P1-01 · 冻结 `ToolFacts` 最小 schema**
  - **动作：** 以 P0-02/P0-09 和现有类型为基础，逐字段确定来源、版本、采集状态、evidence kind、可信度/覆盖范围、fact ID；不保存原始敏感正文
  - **产物：** 共享事实契约与类型说明
  - **完成判据：** 每个字段都有生产者、消费者和缺省/错误语义；无 allow/deny/confirm/answerer 字段；不重复定义已有 `ContentFacts`
  - **验证 / 依赖：** 类型审查；依赖 P0-02/P0-09

- [x] **P1-02 · 并行引入 outbound 事实生产器**
  - **动作：** 将 `outboundClassification` 中启发式检测抽成纯事实生产器；输出观测到的证据类型和检查覆盖状态。此阶段保留旧授权消费者/兼容适配器，不能因事实生产器接入而改变有效决策
  - **产物：** 分类器实现和独立测试
  - **完成判据：** 给定相同输入稳定输出；模块不 import policy/executor/dispatch；事实结果不裁决；旧消费者仍维持迁移前的有效行为，且有前后行为矩阵证明
  - **验证 / 依赖：** 定向单测与依赖边界检查；依赖 P1-01

- [x] **P1-03 · 拆分 IM 附件与内容检查**
  - **动作：** 将附件路径/类型/内容检查分出事实采集与后续对象完整性比较；身份/目标允许性不留在 extractor
  - **产物：** IM outbound facts adapter
  - **完成判据：** extractor 只输出 path zone、文件身份、大小/类型、解析状态、检测标签；改目标允许性的判断有独立 policy/final-check 调用点
  - **验证 / 依赖：** Adapter 单测；依赖 P1-01、P0-06 对应候选决议

- [x] **P1-04 · 并行引入 shell/path facts producer**
  - **动作：** 梳理 shell precheck 与 path facts：将命令效果、目标范围、分析完整性输出为 facts；本阶段不移除仍在生效的策略分支，除非同一提交已有等价规则消费者及回归证据（否则留到 Phase 2 垂直切片）
  - **产物：** Shell/path facts adapter 和调用顺序说明
  - **完成判据：** `unknown/unavailable` 可传入 policy；extractor 调用不触发 executor、approval 或 policy verdict；所有失败映射有依据
  - **验证 / 依赖：** extractor 与 gate 集成测试设计/执行；依赖 P1-01、P0-06

- [x] **P1-05 · 注入事实到策略和审批材料**
  - **动作：** 将结构化事实传到 Policy Engine 与安全审核 Agent；记录 Agent 实际看到的事实版本
  - **产物：** policy context / approval evidence adapter
  - **完成判据：** 对同一调用，policy trace 与 agent prompt 指向同一事实版本；事实来源和“不确定”可见；敏感原文不进入日志
  - **验证 / 依赖：** Prompt 构造测试、决策输入测试；依赖 P1-02～04

- [x] **P1-06 · 定义事实与策略依赖变化的过期规则**
  - **动作：** 确定哪些 facts 改变会使 approval 过期；分别定义“被批准执行对象”的绑定键与“策略判决依赖”的可信事实集。策略依赖变化后必须按新策略重算/比较，不得仅因原命中 ruleId 未变就沿用旧批准
  - **产物：** fact-to-subject binding 表
  - **完成判据：** 每类事实均标出“仅决策证据”或“授权对象字段”；对象字段变化必定使最终检查失效；策略依赖变化触发新旧决策对比，只有证明新决策仍允许同一审批者、动作和对象时才可复用原批准
  - **验证 / 依赖：** 类型与边界用例；依赖 P0-10、P1-05

- [x] **P1-07 · 增加事实阶段边界测试**
  - **动作：** 对分类器/事实生产器注入敏感、普通、unknown、异常输入；观察调用计数和 side effects
  - **产物：** 边界测试
  - **完成判据：** 测试明确断言 extractor 不创建 policy deny、不询问用户、不 dispatch；异常只生成事实状态/技术错误，不伪造风险信号；兼容适配器的外部动作与迁移前矩阵一致
  - **验证 / 依赖：** 定向测试；依赖 P1-02～05

- [x] **P1-08 · 迁移审批事实审计**
  - **动作：** 让审批审计记录 factId、事实类别/证据类别和分类器版本，使用脱敏内容
  - **产物：** 审计事件字段及样例
  - **完成判据：** 用样例能解释某分类器为何输出标签而不泄露原文；历史事件兼容规则明确
  - **验证 / 依赖：** SQLite/audit 单测；依赖 P0-09、P1-05

- [x] **P1-09 · 验证兼容期行为等价**
  - **动作：** 对 outbound、敏感内容、事实不完整、附件、shell/path 现有拒绝/审批/放行路径建立迁移前后对照；事实生产器先以并行输入或 shadow 方式接入
  - **产物：** Phase 1 行为等价矩阵与回归测试
  - **完成判据：** 所有旧安全限制仍由兼容消费者实际执行；矩阵中动作和审批者逐格相同；任何删除旧限制的改动必须与 Phase 2 新规则消费者在同一垂直切片落地
  - **验证 / 依赖：** 定向回归测试；依赖 P0-10、P1-02～08


- [x] **Phase 1 关闭门槛：** 所有候选事实生产逻辑通过 P1-07 类边界断言；决策矩阵所需事实实际可达策略层；unknown/unavailable 有字段并可被策略消费；P1-09 证明本阶段没有提前移除任何有效限制。Phase 收尾依仓库纪律运行全量 `npm test` 并提交；结果及基线失败对照记录见 `security-policy-phase1-test-record.md`。

### Phase 2：统一策略决定，逐项移除决策后覆盖

- [ ] **P2-01 · 定义唯一 `PolicyDecision`**
  - **动作：** 对照现有 decision/audit 类型，确定 decisionId、facts digest/version、policy domain/tier/version、完整决策依赖指纹（匹配条件、约束层、相关规则集合及顺序/启停状态）、verdict、answerer、reason code、Agent 结果引用
  - **产物：** 决策契约及迁移映射
  - **完成判据：** 每种最终 verdict 都能说明由哪条规则/约束组合产生，并可重放当时的有效策略依赖；同一个 toolUse 不出现多个互相矛盾的 final decision；保持旧事件兼容策略已写明
  - **验证 / 依赖：** 类型/现有调用点审查；依赖 P0-02、P0-09、P0-10

- [ ] **P2-02 · outbound 语义转为策略矩阵**
  - **动作：** 建立显式 outbound 规则，并按档位设置：宽松直接放行、标准安全审核 Agent 审批、严格真人审批；lane/tool/destination 可作为规则条件，规则在策略阶段完成裁决
  - **产物：** outbound rule table 与规则定义
  - **完成判据：** 原会话所涉场景有确定动作和 answerer；其他 outbound 工具/lane 的既有行为逐项映射；各档位动作与已确认取值一致；规则有稳定 ID 和理由；保留当前引擎各约束层的实际裁决语义，不擅自改成全局首条命中
  - **验证 / 依赖：** policy engine 用例；依赖 P0-07/10

- [ ] **P2-03 · 移除 Agent approve 后硬拒绝**
  - **动作：** 使 `agentSdkConfirmationPort` 消费策略决策/有效 approval receipt，不再用未登记的 `actionClass` 分支改判；若 P2-02 规则要求真人，则拒绝必须在审批前/决策层显式发生
  - **产物：** confirmation port 变更和回归测试
  - **完成判据：** Agent approval 与显式规则给出的有效结果一致；原日志场景中不会出现“已 approve 后 adapter 才 deny”；拒绝仍能由 ruleId 解释
  - **验证 / 依赖：** `agentSdkConfirmationPort` 定向测试、gate→port 集成测试；依赖 P2-01/02

- [ ] **P2-04 · outside-workdir 写决策迁移**
  - **动作：** 将目标 zone/类型/探测状态作为事实；建立独立于目录内写入的规则：宽松和标准由安全审核 Agent 审批，严格由真人审批；移除 `toolCallGate` 对最终 verdict 的覆盖；保留 permit/执行身份核验
  - **产物：** workdir 外写策略规则和 permit 映射
  - **完成判据：** inside/outside 使用独立规则；outside-workdir 按宽松/标准 Agent、严格真人列出期望表并有测试；policy deny/confirm/allow 不被后续 scope if 改写；身份变化仍 veto
  - **验证 / 依赖：** toolCallGate、write permit 定向集成测试；依赖 P0-07/P0-10/P1 facts

- [ ] **P2-05 · 建立敏感内容与事实不完整规则**
  - **动作：** 将“检测到敏感证据”与“检查不完整/事实不可用”作为两个独立 facts 状态；敏感内容规则按档位设为宽松 Agent、标准真人、严格真人；事实不完整规则按当前版本各档位配置值迁入。事实生产器只报告观测和覆盖状态，不判断敏感、不决定是否放行
  - **产物：** sensitive-content / facts-incomplete 规则及档位对照表
  - **完成判据：** 两类事实相互区分；规则按确认的档位动作执行；无事实生产器直接阻断；多规则/约束共同命中时按当前 Policy Engine 分层语义裁决并有覆盖用例
  - **验证 / 依赖：** policy engine 与事实生产器边界测试；依赖 P0-07/P0-10、P1-02～05

- [ ] **P2-06 · remote policy 与共享规则对账**
  - **动作：** 将 `remoteToolPolicy` 每个分支映射到统一规则系统中的事实、档位配置、规则条件或登记底线；lane 可作为匹配条件，不保留重复的独立策略裁决链
  - **产物：** remote-policy 对账表与重构变更
  - **完成判据：** remote 行为逐项由统一契约下的显式规则/档位配置解释；不同 lane 的差异保留在规则条件中；同一判断不在两个策略链重复实现
  - **验证 / 依赖：** remote policy 单测及真实入口调用链；依赖 P0-06、P2-01

- [ ] **P2-07 · shell fast-track 合入唯一决策**
  - **动作：** 对 fast-track 每个入口查明调用前 decision；调整为规则明确委派时才运行，输出作为该 decision 的子证据
  - **产物：** fast-track 顺序图和代码适配
  - **完成判据：** 已匹配 deny/confirm 规则不能被 fast-track 越过；无命中时记录 fallback 来源；precheck 不能独立制造无 ruleId 最终 allow/deny
  - **验证 / 依赖：** policy/gate 定向测试；依赖 P1-04、P2-01

- [ ] **P2-08 · locked rules 与 policy floor 逐项分类**
  - **动作：** 对 locked rule/validator 列表说明是产品策略还是不可配置系统约束；对后者引用登记 ID，对前者留在 policy trace
  - **产物：** locked/floor 分类表
  - **完成判据：** 每一项只有一个责任真源；locked 不是通用豁免标签；配置覆盖结果可由 decision trace 解释
  - **验证 / 依赖：** policy floor 测试审查；依赖 P0-05/06、P3-01/02 底线登记契约

- [ ] **P2-09 · 建立无 rule 来源扫描**
  - **动作：** 找出策略后仍改变 verdict 的分支；每项必须迁移、删除或有已批准 invariant ID；添加架构测试覆盖关键目录/出口
  - **产物：** 静态门禁/架构测试
  - **完成判据：** 人为新增一个未登记“approve 后 deny”分支时测试失败；白名单项有理由和明确删除条件；不会将普通错误分支误报为策略
  - **验证 / 依赖：** 架构测试自身正反例；依赖 P2-03～08，不依赖自身

- [ ] **P2-10 · 绑定审批与完整决策依赖并处理并发变更**
  - **动作：** 为 approval 保存可重放的决策依赖指纹；规则新增/删除/重排、条件/档位/启停状态或相关事实改变时，重算决策并比较动作、审批者和对象；定义策略读取、审批完成、permit 签发、执行前复核间的版本/race 协议
  - **产物：** approval invalidation 规格、版本协议及回归测试
  - **完成判据：** 新增前置匹配 deny、规则重排、档位切换、规则启停和依赖事实变化均不会复用已失效审批；确认无关规则变更保持有效；并发更新不能让旧决策在新策略下执行
  - **验证 / 依赖：** policy authorization registry 与执行路径集成测试；任务前置以 §7 DAG 为唯一真源。P4-01 契约先行，P2-10 实现完成后由 P4-03/执行通道集成验证。

- [ ] **P2-11 · 同步 UI、文案和策略文档**
  - **动作：** 将配置控件、提示文案、需求和默认规则对齐；明确显示受 locked floor 限制的设置
  - **产物：** 配置/文档更新
  - **完成判据：** UI 文案对每个策略矩阵关键动作无矛盾；无法配置的行为能追溯到登记项/规则定义
  - **验证 / 依赖：** i18n 检查（如改文案）和契约测试；任务前置以 §7 DAG 为唯一真源。


- [ ] **Phase 2 关闭门槛：** §3 所有策略型候选有目标 rule ID/删除证明；outbound、outside-workdir write、敏感内容和事实不完整规则按档位执行确认值；策略决策遵守经核实的 Policy Engine 分层语义，未将局部有序规则扩张为全局首条命中；每个最终策略动作有审计归因。Phase 收尾依仓库纪律运行全量 `npm test` 并提交。

### Phase 3：建立系统底线登记和新逻辑门禁

- [ ] **P3-01 · 确定登记入口实现形态**
  - **动作：** 按 P0-08 确认的代码落点建立唯一源码级 invariant registry；登记可追踪系统底线，不参与运行时规则列表顺序；明确 owner、目录和变更流程
  - **产物：** registry ADR/简短设计
  - **完成判据：** 仓库只有一个底线登记真源；它只登记/校验系统约束，不提供第二份运行时 verdict；policy locked rules 继续在策略契约中表达
  - **验证 / 依赖：** 代码与需求对照；依赖 P0-08

- [ ] **P3-02 · 定义注册项字段和分类校验**
  - **动作：** 以 §2.2 草案为基准，确定 id/owner/stage/category/rationale/effect/scope/audit/test/overrideability 字段和允许值
  - **产物：** 类型/Schema 与校验器
  - **完成判据：** 缺 owner、依据、范围、测试引用的条目不能通过校验；`decision-floor` 必须给出为何不可配置的说明
  - **验证 / 依赖：** Schema 单测/校验器测试；依赖 P3-01

- [ ] **P3-03 · 登记现存 system invariant**
  - **动作：** 将 P0-05/P0-06 认定的递归 guard、SDK capability、授权撤销/代次等逐项登记；纯 policy rule 不放入 invariant registry
  - **产物：** 完整 registry 首版
  - **完成判据：** P0 清单中每项底线均有注册 ID，或有记录的“不属于底线”排除理由；代码、审计和 registry ID 对得上
  - **验证 / 依赖：** 注册表覆盖率检查；依赖 P3-02、P2-08

- [ ] **P3-04 · 增加登记完整性架构测试**
  - **动作：** 检查 ID 唯一、引用存在、测试文件存在、删除实现时登记清理；在关键策略出口检查无规则来源的授权改判
  - **产物：** CI registry lint/架构测试并接入 CI workflow
  - **完成判据：** 测试包含至少一条缺 ID/缺 owner/缺 test 的失败样例和一条合法样例；仓库 CI workflow 实际运行该检查并能阻断未登记变更
  - **验证 / 依赖：** 定向测试及脚本执行；依赖 P3-03

- [ ] **P3-05 · 增加新硬编码规则拦截约束**
  - **动作：** 为新增 deny/approved=false/dispatch suppression 入口建立可持续维护的检查；优先结构性依赖边界或显式 wrapper，避免脆弱的全局 grep 单测
  - **产物：** architecture rule 和豁免格式
  - **完成判据：** 在策略 adapter/port/executor 的目标文件加模拟未登记改判，门禁能失败；普通参数校验错误和 final-check mismatch 不被错误算作策略覆盖
  - **验证 / 依赖：** 门禁自测正反例；依赖 P2-09、P3-04

- [ ] **P3-06 · 写入开发规范**
  - **动作：** 在 AGENTS/安全开发文档要求新逻辑标注阶段、调用位置、注册/规则 ID 和边界测试；提供 PR/提交自检模板
  - **产物：** 开发规范更新
  - **完成判据：** 开发者可按 checklist 检查新安全分支；规范说明 facts 不裁决、policy 有 rule trace、final-check 不重算风险、底线先登记
  - **验证 / 依赖：** 文档审查；依赖 P3-01～05

- [ ] **P3-07 · 统一底线执行审计**
  - **动作：** 在 invariant 触发处记录 invariantId、decisionId（若有）、调用 ID、failure class；不覆盖原 policy decision
  - **产物：** audit schema/事件实现
  - **完成判据：** 每项运行时 invariant 有可关联事件；查询样例能区分 `policy.deny` 与 `execution.veto`/`invariant.block`；审计脱敏通过
  - **验证 / 依赖：** audit 单测；依赖 P0-09、P3-03


- [ ] **Phase 3 关闭门槛：** registry 既覆盖全部被认定的底线，也能被门禁验证；策略型例外不能仅靠贴 invariant ID 通过；贡献规范与 CI 有可执行检查。Phase 收尾依仓库纪律运行全量 `npm test` 并提交。

### Phase 4：统一执行前授权检查

- [ ] **P4-01 · 定义执行授权检查契约**
  - **动作：** 明确输入 policy decision、完整策略依赖指纹/版本、approval receipt、统一安全最小 execution envelope、permit、授权代次/当前 identity；定义检查结果 enum
  - **产物：** `ExecutionAuthorizationCheck` 契约
  - **完成判据：** 结果只表达授权存在性/匹配/新鲜度/机制状态，不含风险级别或 allow/confirm/deny 策略动作；策略版本改变时按 P2-10 重新核验；错误各自稳定
  - **验证 / 依赖：** 类型与边界设计；任务前置以 §7 DAG 为唯一真源；该契约先于 P2-10 实现。

- [ ] **P4-02 · 定义各工具批准对象摘要**
  - **动作：** 定义跨工具通用的安全最小 envelope 字段，再按 read/write/shell/browser/MCP/IM 补充工具特定字段；列明规范化规则和不可包含字段
  - **产物：** subject-binding 规格表
  - **完成判据：** 统一最小字段集有明确 schema；每类工具字段都有“变化时是否失效”判据；摘要算法版本化；秘密字段不以明文存储
  - **验证 / 依赖：** unit-level canonicalization 设计；依赖 P1-06

- [ ] **P4-03 · 统一 receipt/permit 消费顺序**
  - **动作：** 按 decision→必要 receipt→generation/revocation→subject digest→当前目标 identity→executor 写调用入口协议
  - **产物：** 调用序列图和共享 helper/adapters
  - **完成判据：** 所有生产调用路径都执行同一顺序；任一步失败则 executor 调用计数为 0；receipt/permit 一次性规则明确
  - **验证 / 依赖：** integration test；任务前置以 §7 DAG 为唯一真源；集成测试覆盖 P2-10 策略依赖失效协议。

- [ ] **P4-04 · 迁移文件读写执行前检查**
  - **动作：** 对 read/write/list/grep permit 检查统一错误类别，保留 path identity、symlink/hardlink、原子写机制约束
  - **产物：** file executor adapter
  - **完成判据：** 缺 permit/digest mismatch/revoked/identity changed 分别可区分；机制 veto 关联原 decision；非法对象不产生文件 I/O 副作用
  - **验证 / 依赖：** read/write integration tests；参考现有 boundary matrix；任务前置以 §7 DAG 为唯一真源。

- [ ] **P4-05 · 迁移 shell/browser/MCP 检查**
  - **动作：** 将审批对象绑定 command+cwd/capability、browser action+target、MCP server+tool+args；只保留执行完整性/权限约束
  - **产物：** execution adapter
  - **完成判据：** 任一审批关键字段变更时不进入外部执行；正常对象只 dispatch 一次；策略决定原文不被改写
  - **验证 / 依赖：** mock executor integration tests；任务前置以 §7 DAG 为唯一真源。

- [ ] **P4-06 · 迁移 IM/remote dispatch 检查**
  - **动作：** 绑定 channel、account、recipient、session、payload digest、attachment identity/version、destination；将允许性判断从 executor 移回 policy
  - **产物：** IM dispatch adapter
  - **完成判据：** 所有对象不匹配场景 dispatch 调用数为 0；附件内容变更也拒绝；消息内容 classifier 不在 dispatch 层重新判敏感
  - **验证 / 依赖：** WeChat/Feishu mock adapter tests；任务前置以 §7 DAG 为唯一真源。

- [ ] **P4-07 · 定义 execution veto 分类与审计**
  - **动作：** 统一 missing authorization、subject mismatch、revoked/stale、identity change、environment failure 等 failure class 和事件
  - **产物：** veto contract / audit mapping
  - **完成判据：** 失败类别不会写成策略 deny；每条 veto 有 decisionId 或明确“无先前决策”；原因和用户提示一致
  - **验证 / 依赖：** 审计与错误映射测试；任务前置以 §7 DAG 为唯一真源。

- [ ] **P4-08 · 逐通道核验无 executor verdict**
  - **动作：** 从 P0 inventory 重查 executor/adapter 的所有安全拒绝，区分输入校验、机制失败和遗留策略判断；迁移后者
  - **产物：** final-check closure matrix
  - **完成判据：** 每个生产执行器都能证明只做对象一致性/机制约束；未归属项阻止该通道标记完成
  - **验证 / 依赖：** 全仓调用链核查；任务前置以 §7 DAG 为唯一真源。


- [ ] **Phase 4 关闭门槛：** 每个通道至少有执行器未调用的负例和正常 dispatch 正例；批准对象变化不执行且不改写原策略 decision；每个阻断原因具备稳定 failure class。Phase 收尾依仓库纪律运行全量 `npm test` 并提交。

### Phase 5：最终架构验收和旧逻辑清理

- [ ] **P5-01 · 对 inventory 逐项销项**
  - **动作：** 将初始候选 ID 标记 migrated/preserved/removed/false-positive，并链接新位置、规则、registry、测试或排除证据
  - **产物：** inventory 完结版
  - **完成判据：** 无空状态；所有 preserved invariant 有注册 ID；所有 removed 有证明不再有调用点
  - **验证 / 依赖：** 二次静态扫描；任务前置以 §7 DAG 为唯一真源。

- [ ] **P5-02 · 运行隐藏改判反例扫描**
  - **动作：** 按 Phase 0 搜索词/目标文件复扫；追踪新增和残留分支；审阅所有白名单
  - **产物：** 二次审计报告
  - **完成判据：** 每个命中有归属；无未解释的策略终局出口；报告记录搜索命令和扫描范围
  - **验证 / 依赖：** 静态审查；任务前置以 §7 DAG 为唯一真源。

- [ ] **P5-03 · 跑三阶段边界测试集**
  - **动作：** 执行 facts、policy、registry、final-check、audit 测试；按 AGENTS 测试策略做定向验证
  - **产物：** 测试结果和失败处理记录
  - **完成判据：** 开发迭代运行受影响文件的定向测试；Phase 收尾另按仓库纪律运行全量 `npm test` 并提交；没有以更新快照掩盖策略变更
  - **验证 / 依赖：** 定向 Vitest/类型/i18n（按改动范围）；任务前置以 §7 DAG 为唯一真源；前置为 Phase 0～4 源码关闭门槛及 P5-01/P5-02。P5-06 清理完成后，由 P5-07 运行最终全量测试和完整构建。

- [ ] **P5-04 · 正式包版本回归（发布验收项）**
  - **动作：** 用对应安装包/构建版本复现原 session 类场景，检查真实 policy decision、Agent outcome、final check、dispatch
  - **产物：** release verification record
  - **完成判据：** 若交付声明包含原生产问题复现，结果能展示原 approve 后拒绝问题已消失或由显式规则在正确阶段解释；版本、配置、日志证据齐全。无对应包/数据时标为外部待验，不阻塞源码交付
  - **验证 / 依赖：** 需要正式包和对应数据；不能以 mock 代替

- [ ] **P5-05 · 外部渠道验收（发布验收项）**
  - **动作：** 若交付承诺包括真实 IM/MCP，使用测试账号/服务验证 recipient/payload/attachment 和实际副作用；否则明确列为未做
  - **产物：** external acceptance record 或范围说明
  - **完成判据：** 所有承诺的真实通道都有外部证据；未连接服务明确列为未验收，不将 mock 测试说成端到端
  - **验证 / 依赖：** 需测试账号和服务；属于外部验收边界

- [ ] **P5-06 · 清理旧接口及同步文档**
  - **动作：** 删除已无调用旧 helper/adapter、更新调用图、需求和贡献规范
  - **产物：** 清理提交与文档索引
  - **完成判据：** 删除符号全仓无引用；有效机制不被误删；旧文档不再描述已改变语义
  - **验证 / 依赖：** rg + 定向回归；任务前置以 §7 DAG 为唯一真源。

- [ ] **P5-07 · 源码最终验收与交付评审**
  - **动作：** 汇总源码任务状态、测试、未验环境、残余例外与证据；运行仓库要求的最终全量 `npm test` 和完整 `npm run build`，以及改动涉及的类型/i18n/架构门禁
  - **产物：** 最终验收记录
  - **完成判据：** 每个源码任务明确 `完成/未完成`，发布项明确 `完成/外部待验/不在本次发布声明内`；全量测试、完整构建及相关门禁结果有记录；无“总体通过”掩盖未验项
  - **验证 / 依赖：** 最终全量验收和文档评审；任务前置以 §7 DAG 为唯一真源；在 P5-06 清理后运行全量 `npm test`、完整 `npm run build` 和相关门禁。

- [ ] **P5-08 · 发布验收闭环**
  - **动作：** 对承诺包含正式包或真实渠道的发布，补齐 P5-04/P5-05 外部证据并复核本计划源码验收结果
  - **产物：** 发布验收记录
  - **完成判据：** 只有在发布声明依赖的正式包/真实渠道证据齐备后才关闭；若未作该发布声明，此项可保持“范围外”，不影响 P5-07 源码交付关闭
  - **验证 / 依赖：** 正式包、对应数据及真实服务；依赖 P5-04、P5-05、P5-07


- [ ] **源码交付关闭门槛：** 所有源码任务有测试或明确环境限制；所有 inventory 项关闭；全量测试、完整构建及相关门禁有结果；正式包/外部通道未验项醒目标出但不阻塞源码交付。
- [ ] **发布验收关闭门槛：** 仅对承诺包含正式包/真实通道验收的发布生效；对应外部证据完成后关闭 P5-08。

## 6. 已对齐的实施基线（本计划按此执行）

这些是本次逐项对齐后确定的实施基线。Phase 0 核实当前代码、既有档位配置和已确认取值的映射；其职责是形成可追踪证据，不重新开启这些策略决定。

| 基线 ID | 已对齐原则 | 对实现的约束 | 可验证的落地证据 |
|---|---|---|---|
| B-01 | outbound 规则化，按档位配置审批方式 | 宽松直接放行；标准由安全审核 Agent 审批；严格由真人审批；adapter 不得在策略/审批之后另行改判 | 统一规则矩阵、命中 ruleId/档位、Agent/真人审批回归 |
| B-02 | 工作目录外写入是独立于目录内写入的策略规则 | 宽松和标准由安全审核 Agent 审批；严格由真人审批；path zone/type/identity 是事实；执行层保留 permit、identity、symlink/hardlink 和原子写检查 | inside/outside 规则区分；各档位行为测试；执行变化只产生 final-check veto |
| B-03 | 敏感内容证据是事实输入，使用独立档位策略 | 敏感内容：宽松由安全审核 Agent 审批，标准和严格由真人审批；事实检测只报告证据，不直接拒绝；敏感规则排在一般 outbound 规则之前 | 事实输出测试；档位规则测试；无 extractor→deny/dispatch 直连 |
| B-04 | 事实检查不完整时由显式规则按档位决定 | 事实生产只报告覆盖状态/缺失字段；各档位动作迁入明示规则，并沿用当前版本配置值；不得把 incomplete 自动判成“敏感”或直接拒绝 | facts-incomplete 规则和各档位矩阵；异常/不可读输入测试 |
| B-05 | 规则配置按策略档位区分，使用同一套规则系统 | lane 可作为规则条件，但不另建独立策略裁决链；每类工具/事实保留自己的规则条件和档位动作 | 规则命中 trace；lane 变化通过 rule match 表达；无 remote adapter 重复决策 |
| B-06 | 系统安全底线统一源码登记，CI 检查登记完整性 | 单一源码 registry 记录不可配置的身份、完整性、能力、生命周期和平台约束；检查逻辑仍放在所属阶段；新增/修改必须更新登记和测试；registry 不参与运行时策略优先级 | invariant ID、owner、理由、范围、效果、审计/测试引用；CI 缺失引用反例失败 |
| B-07 | 执行对象以统一最小 envelope 做规范化比对 | envelope 包含所有影响目标、内容或动作效果的最小通用字段；工具可补充字段；规范化后比较，变化即授权不匹配并阻止执行 | 通用 envelope schema、各工具扩展表、字段变化 dispatch=0 测试 |
| B-08 | 审批绑定完整决策依赖 | 新增/删除/重排规则、条件/档位/启停、相关事实变化后，以新策略重算并比较 verdict、审批者和对象；只在证明无关或结果等价且审批仍覆盖时复用；无关规则变更不应无故撤销 | 决策依赖指纹/可重放输入；前置匹配 deny、重排、档位、启停的失效测试；无关变更保持有效；并发策略更新 race 测试 |
| B-09 | 不新增数值优先级字段，保留既有策略引擎排序与约束语义 | 当前引擎含多个约束层，deny、humanRequired、locked/floor、MCP ask、per-call confirm、缓存/自动批准等不等价于单一全局首条命中；按真实代码和回归测试记录各层 precedence。只对确实按有序列表首条命中的子域明确顺序；全局语义改变需另立有意策略变更、历史兼容/迁移及交叠矩阵 | precedence 文档；现有 deny/humanRequired/auto-approve 回归保持；各有序子域的重排测试；trace 能解释生效约束 |
| B-10 | 重构保持未被本轮明确调整的现有策略效果 | B-01～B-04 已明确的档位值按本表迁移；其他策略不顺手放宽/收紧，行为差异必须对应显式规则变更 | 迁移前后矩阵逐格对照；已确认变更与其他保持项分列 |


## 7. 执行依赖与交付切片

```text
P0 source baseline → P0 inventory/matrix → P1 facts (legacy behavior retained)
                  → P2 policy vertical slices ← P3-01/02 registry contract
                  → P3-03..07 gates/registry
                  → P4 execution binding (P2-10 invalidation + P4-01 contract)
                  → P5 source close → optional P5 release close
```

下表是完整任务 DAG；每项只有在列出的前置项关闭后才可开始。`A..B` 表示同编号前缀的连续任务范围。

| 任务 | 前置任务 |
|---|---|
| P0-01 | — |
| P0-02 | P0-01 |
| P0-03 | P0-01 |
| P0-04 | P0-03 |
| P0-05 | P0-03、P0-04 |
| P0-06 | P0-03..05 |
| P0-07 | P0-06 |
| P0-08 | P0-05 |
| P0-09 | P0-01 |
| P0-10 | P0-01..09 |
| P0-11 | P0-01..10 |
| P1-01 | P0-02、P0-09 |
| P1-02 | P1-01 |
| P1-03 | P1-01、P0-06 |
| P1-04 | P1-01、P0-06 |
| P1-05 | P1-02..04 |
| P1-06 | P0-10、P1-05 |
| P1-07 | P1-02..05 |
| P1-08 | P0-09、P1-05 |
| P1-09 | P0-10、P1-02..08 |
| P2-01 | P0-02、P0-09、P0-10 |
| P2-02 | P0-07、P0-10、P2-01 |
| P2-03 | P2-01、P2-02 |
| P2-04 | P0-07、P0-10、P1-05、P2-01 |
| P2-05 | P0-07、P0-10、P1-05、P2-01 |
| P2-06 | P0-06、P2-01 |
| P2-07 | P1-04、P2-01 |
| P3-01 | P0-08 |
| P3-02 | P3-01 |
| P2-08 | P0-05、P0-06、P2-01、P3-01、P3-02 |
| P2-09 | P2-03..08 |
| P2-10 | P2-01..08、P3-01/02、P4-01 |
| P3-03 | P3-02、P2-08 |
| P3-04 | P3-03 |
| P3-05 | P2-09、P3-04 |
| P3-06 | P3-01..05 |
| P3-07 | P0-09、P3-03 |
| P4-01 | P2-01、P3-01 |
| P4-02 | P1-06 |
| P4-03 | P2-10、P4-01、P4-02 |
| P4-04 | P2-04、P4-03 |
| P4-05 | P2-06/07、P4-03 |
| P4-06 | P1-03、P2-02/05、P4-03 |
| P4-07 | P3-07、P4-01 |
| P4-08 | P4-04..07 |
| P2-11 | P2-02..10 |
| P5-01 | P2-01..11、P3-01..07、P4-01..08 |
| P5-02 | P5-01 |
| P5-03 | Phase 0～4 关闭门槛、P5-01/02 |
| P5-04 | P5-01、外部正式包/数据可用 |
| P5-05 | P5-01、外部服务可用（若范围包含真实渠道） |
| P5-06 | P5-01/02 |
| P5-07 | P5-01/02/06；P5-03 定向检查完成 |
| P5-08 | P5-04/05/07，仅发布声明包含相应外部验收时 |
```

实现顺序建议：P0 源码基线与 inventory 完成后，P1 只并行提供事实并保留兼容行为；P3-01/02 可在 P2 之前先定义登记契约；P2 每类策略一次只迁一个垂直决策域，规则消费者、回归门禁和旧分支移除同切片；P4-01 契约先行，P2-10 完成审批失效协议后，由 P4-03 和执行通道接入并验证竞态；其余 P3 registry/CI 与 P4 各执行通道依 DAG 推进。P5-03 只在 Phase 0～4 关闭及 P5-01/02 完成后跑定向集；P5-06 清理后 P5-07 运行最终全量测试和完整构建。P5-07 是源码交付关闭，P5-08 是可选发布验收关闭。若 P0 证明既有 permit 已满足某一 P4 子项，可提交其证据并将该任务标记“复用已实现”，无需重复改造。

每个 Phase 按仓库要求单独收尾/提交。每个策略域独立提交并有自己的行为矩阵，便于出现回归时回退该域；禁止将所有 adapter 改动堆在一个大提交里。

## 8. 验收边界与总体验收矩阵

| 场景 | 事实阶段断言 | 策略阶段断言 | 最终检查断言 | 外部验收 |
|---|---|---|---|---|
| outbound 各档位 | 事实材料与策略输入一致 | 宽松 allow、标准 Agent、严格真人；命中规则有 ID | envelope 匹配后按策略决定执行；不匹配不 dispatch | 正式包复现原会话 |
| 敏感内容事实 | 只报告证据类型和覆盖状态 | 宽松 Agent、标准/严格真人 | payload envelope 变化则 mismatch | IM 测试账号可选 |
| workdir 外写 | 产 path-zone/type/identity facts | 独立规则：宽松/标准 Agent、严格真人 | path/file identity 变化 veto，不改 decision | 多平台文件系统 CI |
| recipient/attachment 改变 | 目标身份与附件事实可追踪 | 目标允许性由规则决定 | 任一绑定字段变更，dispatch=0 | WeChat/Feishu 测试通道 |
| registry invariant 触发 | 事实来源可关联（若适用） | 不把策略规则伪装成 invariant | 失败含 invariant ID/failure class | 单测/架构测试 |
| capability/撤权/递归审批 | 记录资格/生命周期事实 | 符合已登记的底线契约 | 无许可或撤销时 executor=0 | SDK 集成测试 |

**可以在当前环境完成：** 类型/纯函数/Policy Engine/SQLite 审计/permit 和 mock executor 的定向测试，目标 OS 的本机集成测试。
**必须依赖外部环境：** 未安装目标操作系统的文件系统语义、真实 WeChat/Feishu/MCP 服务端副作用、正式发行包和其生产 DB/config migration。没有这些环境时只可关闭源码任务，不可标记对应外部验收完成。

## 9. 风险、回退和停止条件

| 风险 | 控制方式 |
|---|---|
| 删除后置拒绝后扩大授权 | 先按 B-01/B-02 将当前行为迁为显式规则并有 lane/工具矩阵测试；只有规则本身发生明确变更时才改变策略效果 |
| 把“安全审核 Agent 批准”误当用户同意 | approval receipt 明确记录主体类型和授权语义；策略规则决定哪种主体可满足 confirm，不由 adapter 偷偷升降级 |
| 把执行时完整性保护误删 | 迁移前证明该判断是否比较审批对象与实际 envelope；保留 identity/version/permit/atomicity/capability checks |
| registry 变成第二套策略 | 严格限制登记类别；需解释不可配置依据；规则性“某类请求不许做”优先归 Policy Engine，不得通过注册优先级覆盖策略 |
| classifier 误报导致永久阻断 | 分类只做事实；误报结果由显式策略动作和可审计用户路径处理；提供 confidence/unknown 输入 |
| 旧包、旧 DB 或配置兼容引发语义漂移 | 先检查 schema/config migration；把策略版本与决策/许可绑定；对生产安装包做版本映射和升级测试 |
| 审计数据暴露隐私 | 记录 evidence kind / digest / 脱敏线索，不落完整消息、API key、附件正文和路径细节 |
| 工作树已有无关变更混入 | 实施前按文件级 baseline 检查；切片提交仅纳入本方案明确文件，保留用户既有删除和迁移文件 |

出现以下任一情况时暂停对应迁移并回到架构核验：代码行为与 B-01～B-10 无法对应；同一 invariant 出现两个登记真源；某通道无法提供执行对象稳定摘要；移除分支会令旧授权可被重放；现有动作无法由规则或授权完整性检查解释。

## 10. 交付清单与首阶段状态模板

最终交付至少包括：

1. 可测试的三阶段契约及调用顺序图；
2. 按候选 ID 追踪的完整 inventory、归位及排除证据；
3. 按 B-01～B-10 落实的行为矩阵及有证据的例外；
4. `ToolFacts`、`PolicyDecision`、approval receipt、final-check/veto 的契约和审计关联；
5. 底线 registry（或现有入口扩展）、CI 架构门禁和贡献规范；
6. 分通道迁移提交及边界测试；
7. 正式包、平台、真实 IM/MCP 环境验收记录；
8. 每个 P0～P5 任务的状态和证据链接。

任务记录建议模板：

```md
### P0-03 扫描策略决策出口
- 状态标记示例：`- [ ]` 未开始，`- [～]` 进行中，`- [x]` 完成
- 负责人：
- 代码基线：
- 产物：
- 完成判据：
- 验证命令/证据：
- 未覆盖项及原因：
- 评审结论：
```

**启动 Phase 1 的明确条件：** P0-01～P0-11 全部关闭，且每项产物按 B-01～B-10 建立可追溯映射；三阶段契约、候选归属、行为矩阵和登记入口有完整证据。正式包/生产数据若缺失，记录为限制原生产场景的外部复现声明，不阻塞源码任务启动。
