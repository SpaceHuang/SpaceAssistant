# 会话 d961cc51 工作目录边界与策略分层：缺口清单及后续技术方案

**日期：** 2026-09-25

**状态：** 阶段 A～D 已实施并通过用户评审；Windows/Linux 平台 CI 尚待运行。追踪证据见[实现矩阵](./session-d961cc51-boundary-policy-layering-implementation-matrix.md)。

**实现分支：** `codex/boundary-policy-layering-tdd`（检查时 HEAD `ce95376f`，工作树含未提交变更）

**需求来源：** [工作目录边界与沙箱策略分层需求](../requirement/session-d961cc51-workdir-boundary-and-sandbox-policy-layering-requirement.md)

**既有方案：** [路径事实化与沙箱-策略分层技术方案](./session-d961cc51-boundary-policy-layering-technical-plan.md)

> 本文以功能分支当前工作树为实现依据，按需求中的 D-1～D-11 逐项归并为四个问题。它是缺口分析及后续工作方案，不表示下述待办已经实施或验证。工作树当时有未提交变更，结论不能简单等同于 HEAD `ce95376f` 的提交内容。

## 1. 结论摘要

截至本次静态核对，需求的主要架构方向已有实现：`read_file` / 单路径 `grep` 与写入工具已有路径事实、策略判定和许可校验；shell 有路径及读写效果事实；Feishu 附件进入下载登记、事实探测和读取许可链路；远程写许可也保留了工作目录限制。

仍需继续处理的明确缺口有四项：

1. **`list_directory` 没进入路径事实和许可链路。** 它仍可能由策略层自动放行，再由执行器的 `resolveSafeReadPath` 终局拒绝；这是 D-1、D-2、D-6、D-8、D-10、D-11 的直接残留。
2. **桌面读取许可闭环没有统一覆盖所有读取工具和兼容入口。** `read_file` 与 `grep` 已接许可，但执行器仍留有未绑定许可时的旧路径回退（桌面带调用身份时会拒绝，其他入口/通道仍可能走旧解析）。需要把正式生产路径统一为“gate 许可或明确拒绝”，避免执行器自行补做策略判断。
3. **桌面文件读取的固定决策绕过 strict/custom 生效规则。** `read_file` / `grep` 当前直接调用 `decideDesktopReadV1`，该函数不接收规则集或套餐；workdir-normal 和 outside-workdir 因而固定 auto-allow，可能直接签发 permit。新增 `list_directory` 时若复制这条固定分支，也会扩大同一问题。
4. **D-11 横向通道的验收证据尚未形成一份完整矩阵。** 多个通道已有对应事实、策略或 veto 审计实现，但需求原列为待核实的 wiki、工作目录切换、Feishu、MCP/toolkit 等路径，需要以现行代码和端到端用例逐项确认其终局结论与审计是否一致。

D-4 / D-5 所说的“持久路径授权记忆”和“重试惩罚”不列入本轮实现缺口。依照会话中已确认的产品取向，普通、非敏感的桌面目录外只读访问由策略确定性放行；敏感/系统目标仍按规则要求真人确认。不会新增跨调用路径授权缓存、同账户进程攻击假设或重试惩罚。该决定不等于需求字面上的授权记忆已经实现；若以后产品要支持“授权一次并记住”，应另立范围和审批期限、路径范围、撤销及过期规则。

## 2. 现状与缺口矩阵

状态标记：**已实现**表示当前工作树可见生产接线；**部分**表示主流程已接入但存在明确旁路或未闭合范围；**按产品决定不做**表示需求提到但本轮有意不实现；**待验收**表示静态代码已有实现线索，尚需完整调用链测试证明。

| 需求问题 | 当前判断 | 代码依据及实际缺口 | 后续处理 |
| --- | --- | --- | --- |
| **问题一：边界事实跨层不一致（D-1～D-3）** | **部分** | `read_file`、`grep`、`write_file`、`edit_file` 已接入路径事实与许可/策略链路；`list_directory` 仍在执行器调用 `resolveSafeReadPath`，gate 未产相应事实。执行器的旧路径回退还需按正式 lane/入口逐一收口。写入探测错误已有独立 deny/fallback 码，但要验证 UI、审计及结果错误分类全链路同义。 | 阶段 A 接入目录读取；阶段 B 关停无 permit 的生产回退并补异常分类验收。 |
| **问题二：越界授权无载体、反复裁决（D-4/D-5）** | **按产品决定不做** | 普通桌面 outside-workdir 只读按确定性策略放行，免去原案例中审批 Agent 对同类读取逐次随机裁决的来源。一次性确认登记已绑定 `requestId/toolUseId/inputDigest/factId` 并消费；没有持久“允许此路径/目录”的缓存，也没有基于拒绝重试次数的处罚。 | 本方案不增加记忆或惩罚逻辑。将不做理由及范围写入需求追踪；敏感/系统目标仍逐次真人确认。 |
| **问题三：沙箱和策略职责混装（D-6～D-8）** | **部分** | read/write facts 与 permit 已将多数路径授权前置到 gate；写自动评估已消费 `WritePathFact`。但 `list_directory` 和旧读取回退仍使用带 `extraRoots` 的 `resolveSafeReadPath`，因此 `skills` 根等业务例外仍留在执行器。`file-fast-track` 继续使用策略评估器判定体量和可自动放行性；此为策略评估而非路径解析，但应维持其输入来自同一事实、且结果审计可见。 | 阶段 A/B 后移除不再需要的读取边界旁路；保留原子写、身份复核等机制层保护。快通道只做策略评估，不重新分类路径。 |
| **问题四：策略缺输入、执行层越位（D-9～D-11）** | **大部已实现，横向验收未闭合** | shell gate 已产 `path-target`、`command-effect` 和启发式风险事实；未知/探测失败不作为普通只读自动放行。读写 permit 失败及 `switch_work_dir` 的执行期限制已有 `policy.execution-veto` 记录；wiki raw 已有事实/规则；Feishu 附件已接登记和许可；远程写入许可消费时仍检查 workDir。需求 D-11 的 MCP/toolkit 和各特殊 lane 需补成统一验收矩阵，确认不存在遗漏的执行器安全否决或无审计失败。 | 阶段 C 做通道清点与端到端验收。仅保留策略后不可避免的身份、目标类型和环境机制检查，并将其记为机制 veto。 |
| **读取策略绕过（D-1/D-6/D-10 的交叉缺口）** | **未解决，P0** | `toolCallGate.ts` 对 desktop `read_file` / `grep` 直接使用 `decideDesktopReadV1`；`readPolicyV1.ts` 不消费 `effectiveRules`、套餐变换或 policy deps。结果是 strict/custom 对 workdir-normal/outside-workdir 的 ask/deny 不生效，后续 permit builder 仍按固定 auto-allow 生成读取许可。 | 阶段 A/B 明确重构读取决策：保留目标类型与事实完整性硬拒绝、敏感/系统 locked 真人确认；普通 zone 的 allow/ask/deny 交给生效规则和套餐语义决定。strict/custom 收紧后不得登记或签发无确认 permit。 |

### 2.1 关键差别：实现缺口、产品取舍与未验证项

- **实现缺口：** `list_directory` 未纳入 gate/permit。这会使审计上的策略放行和执行器的终局拒绝继续脱节，应优先修复。
- **兼容性风险：** `read_file` / `grep` 执行器保留旧解析支路。需要用生产调用点证明没有正式入口依赖无 permit 读取；若没有，应 fail-closed 并移除支路；若有，应先让入口构造同一事实与 permit。
- **策略缺口：** 固定的 `decideDesktopReadV1` 绕过生效规则。即使读取事实和 permit 正确，strict/custom 的收紧也不会生效；必须先让三种读取工具共享同一套规则决策，再允许它们签发 permit。
- **产品取舍：** D-4 的长期路径授权与 D-5 的重试计数不是当前目标。普通越界只读由规则解决，敏感访问每次需真人批准。不以“同一电脑上其他程序精确竞态”为此次实现前提。
- **证据缺口：** D-11 中跨 lane 的部分问题属于未完成验收，不能仅凭单元测试或通用 gate 测试宣布关闭。

## 3. 目标架构与必须保持的不变量

```text
工具入参
  → Facts Provider（一次解析，产出目标、zone、目标类型、必要 identity）
  → Policy（唯一授权判决：allow / confirm / deny）
  → Confirmation（仅策略要求时，绑定调用和 facts）
  → Permit（绑定 lane、requestId、toolUseId、输入摘要、目标和规则）
  → Executor（消费 permit；只做身份、类型、I/O 与原子性保护）
  → policy.decision + 必要时 policy.execution-veto
```

所有后续阶段应保持以下不变量：

1. **目录项名称或元数据只能在策略允许或真人确认之后读取。** gate 可探测目标目录本身的属性，但不能先 `readdir` 再决定是否授权。
2. **执行器不能用旧路径校验重新作授权决定。** 执行时许可缺失、摘要不符或身份/类型改变时拒绝，并记录带调用标识和失败类别的 veto。
3. **`policy.decision` 描述授权结论，`policy.execution-veto` 描述授权后的机制失败。** 不用“路径越界”同时表示策略拒绝、目标解析失败和目录不可用。
4. **普通 desktop outside-workdir 只读行为沿用已确认的策略方向。** 敏感/系统路径优先匹配并要求真人确认；automation 无真人确认能力时按 locked deny 规则处理。
5. **路径事实只产生一次。** 写快通道、确认构造器、执行器不得各自使用不同的 home、敏感前缀或路径别名规则重新分类。
6. **默认动作可由套餐和 custom 规则按既有策略契约收紧。** 普通 outside-workdir read 的默认 allow 不能写成绕开 `decide()` 的固定返回；strict 的 ask 或 custom 的 ask/deny 命中时不得产生 auto-allow permit。
7. **V1 目录读取只枚举目标目录的直接子项。** 不因本阶段扩展为递归扫描、多路径 grep 或 OS 级 sandbox。

## 4. 分阶段技术方案

### 阶段 A：把 `list_directory` 接入读取授权闭环（P0）

**目标：** 消除当前最明确的“策略自动放行、执行器因 workDir 再拒绝”残留，并让 D-1/D-2/D-10 对目录读取有一致审计。

#### A0. 先修复桌面读取决策绕过（`read_file` / `grep` / `list_directory` 共用）

此项是阶段 A 的前置任务，不能只在新目录工具上接 permit 而保留现有固定决策。

- 用 policy engine 的生效规则链替代 `decideDesktopReadV1` 对普通目标 zone 的固定 `auto-allow` 返回。结构性门槛仍可直接 deny：缺事实、目标类型不支持、grep 目标不符合单目标契约；这些不是套餐可覆盖的策略。
- 在 `defaultRules.ts` 为 `read_file`、`grep`、`list_directory` 提供明确的 desktop 读取 zone 决策：新增 `read-target-workdir-allow` 处理 `workdir-normal`；`outside-workdir` 沿用已有 `path-outside-readonly-allow` 规则及其 custom 覆盖，避免新增更早命中的重复规则遮蔽用户已有设置。zone token 必须由事实生成。
- sensitive-file 与 system-dir 继续走 locked `confirm-every-time` + `answerer=user` 的规则，排在普通 allow 规则前，不允许 strict/custom 将其放宽或改变为 Agent 批准。
- 在 desktop strict 的 scope package 中，将上述普通读取 allow 规则收紧为 `ask`；standard 保持默认 allow；custom 对相同 rule id 的 `ask`/`deny` 覆盖按现行 `effectiveRules` 生效。custom 未覆盖的动作维持其已解析默认值。不要另加一个在 policy engine 之后覆盖 decision 的“安全例外”。
- 调用统一 `decide(facts, context, effectiveRules, deps)`，让 lane/package/custom 动作与常规策略同序匹配。若读取规则在专用 helper 中组合，也必须消费完全相同的 `effectiveRules`/transform，并遵守锁定 floor；不得保留绕过规则集的终局固定 allow。
- 对普通读取规则被 strict/custom 改为 ask 的情况，确认通过后也必须建立一次性登记并签发与当前 inputDigest/factId/ruleId 绑定的 permit。允许的 answerer 依决策规则及确认通道而定；敏感/system 的 locked 规则仍限真人。deny、拒绝、取消、超时、重放均不得发 permit。
- 规则结果必须在 permit builder 前确定：只有最终有效决策为 auto-allow 才能直接生成 permit；require-confirm 必须有匹配确认结果后再生成；deny 永远不生成。

#### A0 验收：套餐和自定义读取策略

| 工具 | standard | strict | custom ask / deny | 许可及执行断言 |
| --- | --- | --- | --- | --- |
| `read_file` | workdir/outside 普通文件按默认 allow | 普通 zone 命中 strict 收紧规则并进入确认 | ask 进入确认；deny 直接拒绝 | ask 未确认时 permit 缺失；deny 永无 permit；确认后才签发精确 permit |
| `grep` | 单路径普通文件按默认 allow | 同 `read_file` | 同 `read_file` | gate→确认→permit→真实 grep 全链路验证 |
| `list_directory` | 目录目标按默认 allow | 同一 strict 收紧规则 | ask/deny 按有效规则执行 | 未通过策略/确认前不得 `readdir`，不得签发 auto-allow permit |
| sensitive/system 三工具 | 真人确认 | 仍是真人确认 | custom 不得放宽 locked floor | Agent 批准、旧登记或错误 factId 均不能签发 permit |

#### A1. 增加目录事实

在 `electron/confirmation/extractors/readPathFacts.ts` 增加目录读取事实探测接口，或扩展现有 `ReadPathFact` 契约，区分“单文件读取”和“单层目录枚举”目标。建议对象至少包含：

```ts
type DirectoryReadFact = {
  rawPath: string
  normalizedPath: string
  zone: PathZone
  targetKind: 'directory' | 'missing' | 'file' | 'symlink' | 'special' | 'unknown'
  identity?: FileIdentity
  scope: 'direct-entries'
}
```

- 使用调用提供的 `workDir`、`userDataDir`、`homeDir`、平台和自定义敏感前缀；不得在 helper 内另取宿主配置。
- 只探测目标自身，不调用 `readdir`、glob、walk 或读取子项内容。
- `.`, 空路径和相对目录按现行工具契约归一到 workDir；不存在路径保留绝对 normalized path 并标记 missing；普通文件、特殊文件和解析错误分别表达。
- 保持 sensitive → system → outside → workdir 的分类优先级。

#### A2. 在 gate 中先判策略，后枚举

- `toolCallGate.ts` 为 `list_directory` 生成目录事实，并将 zone 纳入 `facts.signals` 和 `policy.decision.pathZones`。
- 将 A0 定义的同一组规则应用于 directory fact：workdir-normal/outside-workdir 在 standard 下默认放行，在 strict/custom 下按其生效动作确认或拒绝；sensitive/system-dir 使用真人确认；automation 无人确认的情形沿用明确的 deny 规则。
- 对缺事实、未知目标类型、探测 I/O 失败采取 fail-closed，分别返回输入错误、集成错误或环境错误，不能回退为 `default-read-outbound-allow`。
- 一次调用只授权一个目录、一个 `factId` 和 `direct-entries` scope。许可不得授权递归进入子目录或打开其中的文件内容。
- sensitive/system 的待确认登记沿用现有一次性 registry，确认必须绑定 requestId、toolUseId、inputDigest、factId 和 ruleId。

#### A3. 执行器消费目录许可

- 在 `ToolExecutionContext` 中使用统一读取许可，不为 `list_directory` 另造布尔授权字段。
- 执行器入口校验 tool、调用 id、摘要、factId、scope、normalized path 和目录 identity。许可缺失或不匹配时不调用 `readdir`。
- 目录目标身份与 gate 快照不一致时返回 `mechanism` diagnostic；记录 `policy.execution-veto`，含 decision rule、zone、caseId，不记录路径原文。
- 仅执行一次浅层枚举；对子项用 `lstat` 获取类别，不追随 symlink 去读取外部目标内容。维持既有输出数量/字节限制（如现有工具已有相应上限）；若没有，作为实现时必须补齐的防止意外超大结果的边界。
- 权限确认发生前不收集、缓存或发回目录项名称/size/mtime。

#### A4. 阶段 A 验收矩阵

| 场景 | gate / 策略 | executor / 审计 |
| --- | --- | --- |
| workdir 内目录 | 产生 directory fact；standard auto-allow，strict/custom 依生效规则 | 仅最终 allow 或确认通过后签发 direct-entries permit |
| 普通 workdir 外目录（desktop） | outside-workdir fact；standard 默认 allow，strict/custom 依生效规则 | 仅最终 allow 或确认通过后浅层枚举；审计记 zone |
| 敏感目录 / 系统目录 | 真人确认；确认前不得触发 readdir | 确认后许可仅覆盖该目录；执行身份变更时 veto |
| missing / 文件 / special / unknown | 不发 permit；按输入/机制/环境原因终止 | 不调用 readdir，不走旧 `resolveSafeReadPath` 回退 |
| 确认拒绝、取消、超时、重放 | 无可消费的登记 | 无 permit、无 readdir、无目录项结果 |
| 混用调用 id、摘要或 scope | policy deny/veto | 不枚举并产生可归因审计 |
| symlink 目标 | 事实按最终目标分类；确认前不读取目录项 | 许可路径/身份不符则机制 veto |

### 阶段 B：关闭旧读路径旁路，统一错误与审计（P0）

**目标：** 让正式执行入口只接受 gate 产生的 permit，使 `pathSecurity` 不再在执行器内决定“这个读取目标是否获准”。

1. 全仓检索 `read_file`、`grep`、`list_directory` 的所有注册和执行入口，列出调用时 `requestId/toolUseId/lane/readExecutionPermit` 的来源。对每个正式入口证明 permit 必传；没有合法调用的 legacy fallback 直接删除。
2. `read_file`、`grep`、`list_directory` 在所有产品 lane 下统一执行 permit 校验。不能只依赖“desktop 且 id 存在时拒绝”；缺少调用身份或 permit 也必须 fail-closed，除非是明确不暴露给产品调用的内部测试适配器。
3. 清理这些执行器中的旧 `resolveSafeReadPath(workDir, ..., [userDataDir/skills])` 授权分支。若 skills 是正式可读目标，应由路径事实 + 策略规则批准；不要把 skills 根作为沙箱 helper 的隐式策略输入。
4. 错误与审计分类固定为：`input`（参数/目标类型错误）、`policy`（无许可、许可不匹配或策略拒绝）、`mechanism`（目标身份或类型在批准后改变）、`environment`（权限、磁盘、I/O 等环境错误）、`integration-violation`（生产链路漏传 permit）。结果 DTO 与审计 `caseId` 使用同一分类。
5. write/edit 继续由 `WritePathFact` 和 `WriteExecutionPermit` 承载目标及确认；快通道只使用该事实和现有大小阈值，不重新调用路径分类器。不得因路径身份变化而将 `mechanism` 误标为“用户未授权”。
6. 移除或改造 `decideDesktopReadV1` 固定 allow 分支。若保留同名 helper，它必须显式接收经过 lane/package/custom 解析的规则决策，不得自行制造超出有效规则的 auto-allow。permit 生成只读取最终 `Decision`，不得另按 zone 推导批准。

**阶段 B 验收：** 对三种读取工具覆盖 desktop、Feishu、WeChat、automation 适用分支；standard/strict/custom 的 auto-allow、ask、deny 组合必须过 gate→permit→真实执行器。故意遗漏 permit 时确保真实 executor 不读、不 grep、不 readdir，并产生可识别的 veto/拒绝记录；对路径别名、`~`、Windows 绝对路径、工作目录内 symlink 指外、missing 路径保持已有边界语义。

### 阶段 C：D-11 横向安全判决与审计矩阵（P1）

**目标：** 区分已修复通道与尚未充分验证通道，不把每个执行器的“安全检查”一概迁入 policy。身份、文件类型、原子提交、预算/取消和平台 I/O 仍可由执行边界守护，但要说明它属于机制或生命周期约束。

#### C1. 按通道做一项项清点

| 通道 | 当前可见实现 | 要核对的剩余事项 |
| --- | --- | --- |
| `write_file` / `edit_file` | `WritePathFact`、write permit、远程 workDir 再校验、原子写保护、执行 veto | 桌面/远程分别测目录外绝对路径、outside symlink、hardlink、missing/new、父目录 identity 改变；区分策略决策与机制失败 |
| `run_shell` | 路径目标、command-effect、path-outside-heuristic 进入 facts；desktop 只读外部自动放行仅在既有 decision 已 auto-allow 时细化 | 确认未知解析、redirect、混合读写、敏感/系统、自定义敏感前缀、strict/custom ask 均不会被 shortcut 覆盖；审计只落 zone/类别、不落路径原文 |
| `run_script` | 静态路径事实、提取完整性信号，动态/不完整分析走确认或 deny | 各语言的 API 覆盖与提取失败是否始终 fail-closed；真实 gate→executor 用例 |
| `switch_work_dir` | profile-target fact 进入规则；敏感 profile 有执行期复核和 veto 记录 | 执行期复核是否只处理 profile 状态变化/机制问题；拒绝与 `policy.decision` 的关联和 remote lane 实测 |
| wiki raw 写保护 | gate 产 `wiki-raw-target`，default rule 有 deny | 开启 wiki 配置的真实写入链路；确保执行器不保留无审计的第二套同义策略否决 |
| Feishu 附件 | 入站资源下载/附件登记、归属事实、permit 和读取执行器已接入 | 本机实际 compact schema、消息所有权、未登记 id、大小上限、取消/过期、确认和文件变化的端到端覆盖 |
| MCP / `toolkit.call` / browser | 现有 gate 规则已覆盖主要策略判定 | 依 D-11 原判据逐执行器检索；只对发现的安全性二次否决补 facts/rules 或 execution-veto，不扩大本方案为全工具重构 |

#### C2. veto 审计契约

所有“策略批准后未执行”的路径应满足：

- 有先前 `policy.decision` 的 requestId/toolUseId 可关联；
- veto 含 toolName、decisionRuleId、failureClass、caseId；路径类失败只记录 `pathZone` 和 factId，不落原路径；
- `mechanism/environment` veto 不改写原 policy decision 为 deny，也不伪装为路径授权问题；
- 遇到执行器抛错、取消、撤权或超时，保留当前行为分类；仅对安全/许可约束产生 veto 事件，不把普通业务输入错误泛化为策略 veto。

### 阶段 D：需求映射、回归门禁与文档收敛（P1）

1. 建立 D-1～D-11 到实现文件、规则 id、测试文件和结论的追踪表，附上“已实现 / 不做决定 / 待验证 / 未完成”。
2. 测试重点走真实入口：`evaluateToolCallGate → confirmation flow → toolChatLoop execution context → actual executor → audit`。现有 permit/helper 单测继续保留，但不替代跨层测试。
3. 至少加入这些反向断言：确认前 `readdir`/读取方法未调用；敏感目标 cannot agent-approve；目录外 shell 只读规则不覆盖 strict/custom ask；远程写许可不能扩大 workDir；失效/重放确认不能生成 permit；执行期 identity mismatch 会留 veto；审计不含绝对路径。
4. 对 Windows、macOS、Linux 路径形式按项目支持矩阵运行静态和平台测试。平台 CI 缺失时将“尚未验证”留在交付结论中，不把静态通过表述为平台已验证。
5. 只有阶段 A～D 的阻断项关闭，并经代码评审后，才可宣称本需求全部完成。D-4/D-5 需注明按产品决定不实现授权记忆/重试惩罚，不能写成代码已经具备。

## 5. 分阶段交付顺序与评审边界

| 顺序 | 交付阶段 | 主要产物 | 阶段停止条件 |
| --- | --- | --- | --- |
| 1 | 阶段 A：先修桌面读取规则绕过，再接 `list_directory` facts + permit | 标准/strict/custom rule、套餐变换、确认登记与 agent/user-approved permit、目录事实、执行器接线、跨层测试 | 三种工具按有效策略决定；严格/自定义 ask/deny 不产生 auto permit；确认后目标精确绑定；目录名称/元数据在授权前不可见 |
| 2 | 阶段 B：读取旁路收口及错误分类 | 入口清点、旧路径回退移除或受控替换、统一 diagnostic、回归测试 | 所有产品 lane 的读取执行都必须消费 permit；没有执行器自行授权的旧分支 |
| 3 | 阶段 C：D-11 通道矩阵 | 通道表、缺失 case 修复、跨 lane 审计测试 | 所有已确认的策略后安全否决均有前置规则或明确机制归属与 veto；未能实测项明确标记 |
| 4 | 阶段 D：追踪和交付检查 | D-1～D-11 追踪矩阵、平台结果、更新文档 | 阻断项关闭，评审通过，结论准确说明 D-4/D-5 取舍及未验证平台 |

每阶段完成后暂停并提交具体代码与阶段验收结果给用户评审；收到通过结论后再进入下一阶段。若评审阻断，先修复该阶段问题并重新提交，不跳到后续阶段。

## 6. 本方案明确不实施的内容

- 不新增路径记忆缓存、不把审批 Agent 的一次通过转为长期路径授权、不调整记忆资格 I3。
- 不按重试次数降低自动放行率或提高风险。普通外部只读由固定规则处理；敏感操作由真人逐次确认。
- 不为 shell 宣称文件系统沙箱；只使用已有可提取 facts 和命令效果分类。无法完整分析时保持确认/拒绝，不猜测为只读。
- 不以“本机其他同账户程序精准竞态攻击”作为本阶段威胁模型或实现验收项；仍保留普通的调用绑定、目标身份复核和安全原子写，以防目标变化或程序错误。
- 不借此扩展到递归目录搜索、多路径 grep、OS 级隔离、全体工具重写或不相关安全清理。

## 7. 完成标准

本需求可以标记为“实现完成”需同时满足：

1. `read_file`、`grep`、`list_directory` 的 gate、授权、permit、执行和审计链路闭环；无未授权旧读取回退。
2. desktop standard/strict/custom 三档读取决策进入同一有效规则链；strict 收紧规则和 custom ask/deny 对三种工具均实际生效，收紧时没有 auto-allow permit，确认之前不会进入执行器读取。
3. 写入、shell/script 与特殊 lane 按 D-11 清单逐项有可验证的判决归属；例外是机制复核时，失败归类和审计不能伪装成策略拒绝。
4. Q-1 的策略意图及 sensitive/system 优先级在测试和审计中稳定；strict/custom 套餐可收紧而不被目录外只读自动放行覆盖。
5. D-4/D-5 的不实现决定、适用范围和未来若要启用授权记忆所需的独立评审条件有明确记录。
6. 真实生产入口的集成测试、相关类型检查、平台验证和代码评审均通过；仅 helper 单测通过不作为闭环依据。

## 8. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-09-25 | 基于 `codex/boundary-policy-layering-tdd` 当前工作树及恢复后的 v0.7 需求，归并 D-1～D-11 的剩余缺口；将 `list_directory`、无 permit 兼容支路及 D-11 横向验收列为后续阶段；按会话中已确认的产品取向，将持久路径授权记忆与重试惩罚记录为不实施事项；给出分阶段技术方案和阶段评审门槛。 |
| 0.2 | 2026-09-25 | 根据评审补入 P0：桌面 `read_file` / `grep` 经 `decideDesktopReadV1` 固定 allow、绕过 strict/custom 生效规则。调整阶段 A/B 与完成标准：三种读取工具共用 effective rules；standard 保留默认读取动作，strict/custom 的 ask/deny 必须在 permit 生成前生效；敏感/系统 locked 真人确认保持不可放宽；确认型读取也须有正确 answerer 的一次性许可闭环。 |
| 0.3 | 2026-09-25 | 实施阶段 A 时复用既有 `path-outside-readonly-allow` 承载桌面目录外读取决策，避免重复、更早命中的新规则遮蔽用户已有 custom 覆盖；workdir-normal 使用新增读取 allow 规则。 |
| 0.4 | 2026-09-26 | 阶段 A～D 已完成并通过用户代码评审；实现矩阵补入 D-11 微信附件路径通道。全量测试、类型检查、i18n 和 diff 检查通过。Windows/Linux 未在本机运行，继续标为待对应 CI 验证。 |
