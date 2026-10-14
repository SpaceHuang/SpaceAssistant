# 会话 d961cc51 问题技术方案：路径事实化与沙箱-策略分层

**版本：** 2.6
**日期：** 2026-09-23
**状态：** 已根据评审修订，待实现前复核
**来源：** [../requirement/session-d961cc51-workdir-boundary-and-sandbox-policy-layering-requirement.md](../requirement/session-d961cc51-workdir-boundary-and-sandbox-policy-layering-requirement.md)（问题清单 v0.7，D-1 ~ D-11 / Q-1 ~ Q-10）
**代码基线：** `4bc49538`（本方案所有「现状」均已按该 HEAD 逐条核对；与清单编写时的状态存在差异，见 §0.4）
**关联文档：**

- [session-ced59b41-issue-remediation-technical-plan.md](./session-ced59b41-issue-remediation-technical-plan.md)（同批问题方案；工具结果 `diagnostic` 契约与本文共用，本文不另造一套）
- [../requirement/security-policy-single-entry-requirement.md](../requirement/security-policy-single-entry-requirement.md)（安全策略单一入口）
- [../requirement/tool-confirmation-top-level-design-v2.md](../requirement/tool-confirmation-top-level-design-v2.md)（确认机制顶层设计）
- [run-shell-agent-safe-boundary-hardening-plan.md](./run-shell-agent-safe-boundary-hardening-plan.md)（日志与载荷脱敏，关注点不同，不重叠）

## 0.0 分阶段范围冻结

本方案按安全语义分阶段交付。所有阶段共享唯一链路：`InvocationFacts → PolicyDecision → ConfirmationResult（如需要）→ ExecutionPermit → executor → audit`。当前版本为 **V1 文件读取组**，范围仅为 desktop 的 `read_file`、单路径 `grep`；只处理显式普通文件路径。`list_directory` 暂不纳入 V1，因为枚举目录本身会在策略确认前读取子项名称和元数据；多路径 `grep` 也后置，直到工具 schema 和执行器正式支持路径数组。V2 写入组、V3 shell/script、V4 automation 与特殊 lane 只定义进入条件和边界，未进入当前版本实现、编译或发布门禁。

V1 的最小结果按每个显式目标独立产生：

1. `workdir-normal`：策略 `auto-allow`，`approvedFactIds` 显式列出该目标，生成 permit 后执行。
2. 单个 `outside-workdir`：策略 `auto-allow`，生成绑定该 `factId` 的 permit 后执行。
3. `sensitive-file` / `system-dir`：策略 `require-confirm + answerer=user`；确认的 `requestId`、`inputDigest`、每个 `factId` 全部匹配后才生成 `user-confirmed` permit。V1 不包含 automation。

本阶段禁止以布尔值、路径字符串反查、调用级 `ruleId` 或执行器二次分类替代上述对象。缓存先关闭或按完整 `factsDigest + rulesVersion + lane` 隔离；只有最小闭环验收全部通过后，才允许把同一契约推广到其它工具和 lane。

### 0.1 版本路线与进入条件

| 版本 | 工具范围 | 当前状态 | 进入条件 |
| --- | --- | --- | --- |
| **V1** | `read_file`、单路径 `grep` | 当前唯一实施版本 | 两个工具均完成事实、策略、permit、执行和审计；每次调用一个显式普通文件目标；目录/通配输入 fail-closed |
| **V2** | `write_file`、`edit_file` | 后续草案 | V1 全部正负集成测试和 permit/审计门禁通过；另定义写目标事实与原子提交机制 |
| **V3** | `run_shell`、`run_script` | 后续草案 | V2 完成；另定义 command-effect、脚本提取完备性和预检顺序，不复用文件目标模型 |
| **V4** | automation、wiki、remote、feishu 等特殊 lane | 后续草案 | V1～V3 完成；每个 lane 单独定义无真人场景的 deny/confirm 终局 |

未进入当前版本的工具不得通过旧快通道、shell 预检、自动放行或执行器旁路提前接入。评审和发布只针对当前版本代码、测试和本章节。

---

## 0. 范围、取定与事实校正

### 0.1 本文覆盖的问题项

| 编号 | 问题 | 本方案任务 |
| --- | --- | --- |
| D-1 | 同一条「工作目录之外」边界由三层各自执行 | **T1-1 / T1-2 / T2-1 / T3-1 / T3-2** |
| D-2 | 越界事实不进策略层、不进审批线索包 | **T1-1 / T1-5 / T7-1** |
| D-3 | 沙箱的「无法解析」被翻译为策略码，两类失败同形 | **T3-3 / T4-2** |
| D-4 | 用户指令不构成授权凭据 | **T2-1**（把常见情形变成「本就不需要授权」，本轮不做授权维度） |
| D-5 | 同一目标可无限重试，准入退化为概率门 | **T2-1**（消掉主要重试来源；不引入惩罚机制） |
| D-6 | `pathSecurity` 内建策略语义（`extraRoots`、读宽写严） | **T1-6 / T5** |
| D-7 | 三处「策略穿着沙箱的衣服」 | **T4-1 / T4-2** |
| D-8 | 沙箱功能全挤在策略层之前 | **§1 架构梳理 + T5** |
| D-9 | 策略层缺「只读性」事实（`run_shell` 恒为 `execute`） | **T1-4** |
| D-10 | 执行层可推翻策略判决，且不留痕 | **T3-1 / T3-2 / T3-4 / T7-2** |
| D-11 | 越位代裁横跨 5 条通道 | **T6**（逐通道处理表） |

### 0.2 明确不在范围内

- **不做 OS 级隔离**（进程沙箱、容器、seccomp）。清单 §1.5 已界定本文语境的「沙箱」是应用层路径校验，本方案延续该界定。
- **不给 `run_shell` 加路径边界**。理由见 §1.6 —— 这不是「暂时不做」，而是判断它不该做。
- **不为路径域开「记住」例外**（清单 Q-3）。取定见 §0.3。
- **不评估审批 Agent 的裁决质量**，不改 `securityApprovalSkill` 的风险/授权双维模型（清单 §9 同口径）。本方案只解决「它拿不到事实」。
- **不重做 `ConfirmationAuthorizationRegistry` / prepared-shell 那条尚未接线的新链路**（见 `message-fact-production-pipeline-refactor-plan.md` 的范围声明）。本方案在**现役主链路**上落地。
- 清单 V-7（并发/配额）与 V-9（MCP/toolkit 执行器）不在此处理：前者属同批另一份清单，后者经本轮静态核对未见额外安全否决，保留为待核实。

### 0.3 取定表（对应清单第 7 章待决议题）

| 议题 | 本方案取定 | 落实位置 |
| --- | --- | --- |
| **Q-1** 越界只读是否需授权 | **归策略层；「只读 + 不涉及敏感/系统目录」放行**（采纳清单已给出的决议方向），并要求**策略层同时拿到「越界性」与「只读性」两个事实**；执行层按策略放行结论执行，不再自行否决 | T1-1 / T1-4 / T2-1 / T3-1 / T3-2 |
| **Q-2** `confirmOutsideWorkDir` 接线还是删除 | **两件都不做**：该字段已不在 `ShellConfig` 类型中（§0.4 第 1 条）。**不新增同义配置项** —— 「越界只读要不要问」由规则集表达（可覆盖、有 `ruleId`、可审计），比一个游离开关更符合「策略单一入口」 | §0.3 说明 + T2-1 |
| **Q-3** I3 是否为路径域开缓存例外 | **不开**。理由：本轮把「越界只读」从「逐次裁决」变成「策略确定性放行」后，重试成本的主要来源已经消失；为路径域破 I3 会引入「一次授权、长期免问」的新风险面，收益不抵成本 | 不做（记录于 §1.6） |
| **Q-4** 前置/后置判据是否确认为「前置产事实、后置守执行」 | **确认**。并补第三类「环境/输入错误」，避免把「参数写错了」也算成安全判决 | §1.3 / §1.4 / T5 |
| **Q-5** 敏感清单真相源归谁 | **策略层唯一持有**：一处实现（匹配函数）、一处取值（`env.sensitivePaths`，含用户自定义前缀），其余消费方只读该结果 | T4-1 |
| **Q-6** `extraRoots` 是否改为策略层输出 | **改为策略输出**：允许访问的根集合由策略判决携带，执行器不再硬编码 `[userDataDir/skills]` | T1-6 / T3-1 |
| **Q-7** 沙箱/执行层失败是否携带可区分类别 | **携带**，且复用现成的 `ToolExecutorResult.diagnostic`（`category` + `retryable` + `caseId`），不新建错误码体系 | T3-3 |
| **Q-8** 文件工具与 `run_shell` 的边界是否统一 | **不统一，但要「说明白」**：文件工具受路径边界约束，`run_shell` 不受（保持现状结论）。统一的方向只能是「更严」，而 shell 加路径白名单是假安全（§1.6）；因此本轮做的是**把不一致显式化**（工具描述与拒绝文案说明差异），而不是把它抹平 | T1-3 / §1.6 |
| **Q-9** 执行器内的安全否决是否上收策略层 | **上收**，判据沿用 D-11 给出的可操作定义（执行器内直接调 `pathSecurity`、或自行读安全配置并据此返回失败 = 第二个判决者）。逐通道处理见 T6 | T6 |
| **Q-10** 「可申诉越界」与「终局越界」是否统一 | **统一到「策略层先判、执行层后守」**：`write_file` 的 realpath 越界与 symlink 越界今后都先产事实、由策略层判决；执行层只剩机制性拒绝（TOCTOU），并带可区分错误类别 | T5 / T3-3 |

### 0.4 事实校正：与清单不一致的 6 处（按 HEAD `4bc49538` 核对）

清单基于当时的 HEAD，本轮逐条核对后有 4 处需要修正、2 项 V 系列可以直接结案。**结论方向不变，但修法因此不同**：

| # | 清单原文 | HEAD 实测 | 对方案的影响 |
| --- | --- | --- | --- |
| 1 | D-1 原因 1 / Q-2：`ShellConfig.confirmOutsideWorkDir` 是「字段存在但无消费方」 | **字段已从类型中删除**（`src/shared/domainTypes.ts:231` 起的 `ShellConfig` 无此字段）。全仓库唯一残留是 `src/shared/visionModelRouting.test.ts:68` 的历史夹具（对象以 `as AppConfig` 强转，所以不报错） | Q-2 的选项从「接线 / 删除」变为「**清理夹具残留，不新增同义开关**」 |
| 2 | D-2 原因 2：`run_shell` 的 descriptor **未声明** `path-classifier` | **已声明**：`extractors: ['command-sequence', 'path-classifier', 'network-egress']`（`src/shared/builtinToolMetadata.ts:42`）。但 `path-classifier` 实现读的是 `input.path`（`runExtractors.ts:47`），而 `run_shell` 的入参是 `command`；`network-egress` 在 `EXTRACTOR_IMPLEMENTATIONS` 里**根本没有实现**，未实现的名字被静默 `continue`（`runExtractors.ts:70`） | 结论（shell 无路径事实）成立，但原因不是「没声明」而是「**声明了却读不到入参**」。修法相应改为：**删掉这两条无效声明，改由 shell 自己的事实投影产出路径事实** |
| 3 | D-1 表格：`read_file` / `list_directory` / `grep` 有 `path-classifier` 事实但被沙箱 `throw` 吞掉 | 三个读工具的 descriptor 是 `extractors: []`（`builtinToolMetadata.ts:14-16`） | 读通道现状比清单描述**更彻底**：策略层对读工具是「不看路径直接放行」（走 `default-read-outbound-allow`）。所以读通道不只是「事实没进策略」，而是**事实从未产生** |
| 4 | V-6：`autoApproveFallback` 是否在界面可见、是否落审计 | 界面可见（`WriteConfirmCard.tsx:65`），工具记录可见（`turnDisplayProtocol.ts:151`），**安全审计不可见**（`SecurityAuditEvent` 无该字段；`toolChatLoop.ts:2147` 只写 agent 日志） | 快通道的旁路性确认成立，T4-2 需同时补「快通道结论落审计」 |
| 5 | V-2：`confirmOutsideWorkDir` 是否零消费方 | **已不存在于类型**（比「零消费方」更强） | 结案，随第 1 条处理 |
| 6 | V-3：`classifyPathWithSymlink` 是否被生产调用 | **无生产调用**（仅 `pathClassifier.ts:55` 定义 + `extractors.test.ts:129` 测试） | 结案；T1-2 直接启用它 |

V-1（`outsideWorkDirRisk` 是否有别的回流路径）：本轮再次全仓库检索，读写点仍是 `shellPathAnalysis.ts:129/216/240-245` → `shellToolLoopHelpers.ts:63` → `shellAgentLogger.ts:33` 加日志投影字段白名单（`electron/agentLogger/agentLogProjection.ts:18`）。**清单结论成立，无回流**。
V-4（策略层 `env.sensitivePaths` 是否漏了自定义前缀）：`toolCallGate.ts:305` 为 `getBuiltinSensitivePrefixes(args.userDataDir)`，**确实未传** `customSensitivePrefixes`。**清单结论成立**，T4-1 修。

---

## 1. 架构梳理：谁在前、谁在后

> 这一章回答清单 D-8 的诉求，也是本方案的骨架。它只有三句话：
> **事实只描述「这次要动的是什么」，策略只回答「要不要授权」，执行只负责「动的时候别出岔子」。**
> 现在的问题是这三件事被写进了同一个函数、同一条异常通道，于是「谁说了算」变得不可预测。

### 1.1 三层与一条时间轴

```

工具调用输入（工具名 + 入参）
      │
      ▼
① 事实层（策略层「之前」，只产出、不裁决）
   路径：绝对路径、真实目标（symlink 解析后）、分区（工作目录内 / 外 / 敏感 / 系统）、目标类型
   动作：命令序列、是否只读、脚本分析结论、疑似越界
   → 产出 ContentFacts.signals；越界在这里是**事实**，不是异常
      │
      ▼
② 策略层（唯一判决者）
   规则集 + 配置 + 缓存 → auto-allow / require-confirm（问人 / 问审批 Agent）/ deny
   同时给出「本次执行许可」：允许访问的工作目录外目标集合 + 允许的根集合
   落审计 policy.decision（含分区、ruleId）
      │
      ▼
③ 执行层（策略层「之后」，只守机制）
   按许可解析并执行
   机制保证：临时文件 O_EXCL/O_NOFOLLOW、fsync、link/rename 原子提交、身份与 nlink 复验、
            租约与串行屏障、TOCTOU 复检
   → 失败 = 机制/输入/环境错误，**不是安全判决**；不得与策略结论相反
```

### 1.2 三类的判据（写代码时用来做归属决策）

| 类别 | 回答的问题 | 典型失败 | 可否授权 | 对外措辞 |
| --- | --- | --- | --- | --- |
| **前置（事实）** | 这次要动的是什么 | 「目标在工作目录之外 / 是敏感位置 / 是符号链接」 | 是（策略层据此决定放行或询问） | 陈述事实，不写「已拒绝」 |
| **后置（机制）** | 动的时候别出岔子 | 「目标在读写之间被替换」「临时文件创建冲突」 | 否（换做法或重试） | 机制问题 + 可重试 |
| **环境/输入错误** | 参数和环境对不对 | 「缺少路径参数」「工作目录不可用」 | 否（改输入） | 输入无效 / 环境不可用 |

### 1.3 现有功能的归属清点（清单 D-8 的 22 项）

**应在前置（产出事实）**

| 功能 | 现状 | 目标 |
| --- | --- | --- |
| 词法包含校验（防 `..`） | `resolveSafePath` 抛「路径超出工作目录范围」（`pathSecurity.ts:16`） | 变成 `zone = outside-workdir` 事实 |
| realpath 后包含校验 | `assertInsideBase` 抛同一句（`pathSecurity.ts:24`） | 变成「真实目标在边界外」事实 |
| 绝对路径包含校验 | `resolveSafeWorkDirPath` 内同两处校验（`pathSecurity.ts:50-70`） | 同上 |
| symlink 逐段解析 | `resolveSafeWriteTarget` 逐段 lstat 后直接抛错（`pathSecurity.ts:171`） | 产出「真实目标 + 是否经过链接」事实 |
| 目标类型（file / dir / missing / special） | `pathSecurity.ts:175` 直接抛错 | 产类型事实 |
| 硬链接（`nlink > 1`） | `pathSecurity.ts:178` 直接抛错 | 产事实 |
| 敏感路径匹配 | 三处各调 `isSensitivePath`，参数不一（D-7 ③） | 策略层唯一持有，作为环境事实 |
| 「允许访问的根集合」 | 调用点常量 `[userDataDir/skills]`（D-6 ①） | 由策略层输出 |
| （shell）路径字面量与疑似越界 | 只进 hints 与日志（D-2） | 进 `ContentFacts.signals` |

**应在后置（守执行，全部已实现，保持不动）**

`safeAtomicWrite.ts` 的临时文件 + `O_EXCL` + `O_NOFOLLOW`、`writeAllBytes` 的 `fsync`、新建走 `link` / 覆盖走 identity 校验后 `rename`、提交后 identity + `nlink` 复验、`assertNoSymlinkAlong`、`cleanupSafeWriteTemps`、`withTransientLockRetry`、`captureFileIdentity`/`identitiesMatch`、`pathLeaseRegistry`（读写互斥 / deleting 态）、`acquireWrites`（按序加锁防死锁）、`toolPathLease`（跨会话写冲突）、`workspaceResourceKeys`（调度串行屏障）。

> 这一格**一项都不改**。它们本来就该在后置，功能也完整。

**应拆开（四处灰区）**

| 项 | 现状 | 拆法 |
| --- | --- | --- |
| 空路径 | `pathSecurity.ts:52` 抛「路径超出工作目录范围」 | 前置给「输入无效」（新错误类型），与安全无关 |
| 目标须为普通文件 | `pathSecurity.ts:175` 单一 `throw` | 前置给**类型事实**；后置在落盘前再拒特殊文件 |
| 逐段 lstat 拒 symlink | `pathSecurity.ts:171` 前置即终局 | 前置给**真实目标事实**；后置在落盘前拒链接（防 TOCTOU，必须保留） |
| 敏感路径判据源 | 三方各自调用 | 策略层唯一持有（T4-1） |

**既不是事实也不是机制（单列）**：`路径组件无法判定`（`pathSecurity.ts:167`）、`工作目录不可用`（`pathSecurity.ts:123/126`）—— 属环境错误，不该长得像安全裁决。

### 1.4 一条硬规则（判决唯一性）

写进代码注释与测试，作为后续所有改动的判据：

> 策略层是唯一判决者。执行层不得以**安全事由**作出与策略层相反的结论；
> 执行层的失败只能表述为**机制错误 / 输入错误 / 环境错误**，且必须携带可区分类别。
> 若出现「策略已放行、执行却未执行」，必须留下一条审计（T7-2），不允许静默。

### 1.5 关于预留信号 `sandbox-escape` 的处理

`FactSignal` 里有一条预留信号 `{ kind: 'sandbox-escape'; blockedReason: string }`（注释「reserved: 沙箱迭代启用」），当前无人使用。**本方案不启用它**：它的语义是「逃逸已被拦住」，这是**结论**口吻，放进事实层会把「事实 / 判决」重新混在一起。我们只用 `path-target` + `zone` 表达「目标在哪」，让策略层去说得不得。

### 1.6 三件明确不做的事（防过度设计）

1. **不给 `run_shell` 加路径边界。** `shellPathAnalysis.ts:242` 那句「Shell 不是文件沙箱」是准确的：shell 的能力面是「执行任意程序」，路径白名单挡不住 `sh -c`、`python -c`、网络、把文件复制到任意位置。加一层路径检查只会制造「已经安全」的错觉，还会让审批与审计更难解释。shell 的正解是**策略分级 + 审批**，这正是 T1-4 / T2-1 在做的事。
2. **不为路径域破 I3。** 见 Q-3 取定。
3. **不引入「重试惩罚」。** D-5 的成因是「无记忆 + 重试不可疑 + shell 无边界」三者叠加。前两项是有意设计（防误拒、防长期授权），贸然加惩罚会误伤正常重试。本方案只消掉最大的实际来源（越界只读不再逐次裁决），其余保留现状。

---

## 2. 任务分解

> 本章是后续扩展草案；在 §3 单一闭环完成前，所有 T1~T7 均不得进入本阶段实现或验收。

### T1 事实补齐（前置层）

#### T1-0 统一路径事实流水线（所有门控前置）

`evaluateToolCallGate` 先调用一次纯 `analyzeShellCommand`（仅当工具为 `run_shell`），得到不可变的 `shellAnalysis`；随后以该结果和工具原始入参执行一次异步事实准备，再进入 shell 预检、写快通道或 `decide`。`preparePathFacts` 负责生成 `path-target`、敏感匹配结果和 `command-effect`；shell 预检只消费同一份 `shellAnalysis` 与 facts，不再调用 analyzer。非 shell 工具直接跳过 analyzer。所有消费者禁止自行重新调用分类器或 `isSensitivePath`。

同一 symlink、同一自定义敏感前缀和同一 home 路径必须在三方得到相同 zone 与敏感结论；异步 symlink 分类纳入 `evaluateToolCallGate` 的前置阶段，确保任何消费者都不会早于事实生成。`analyzeShellCommand` 在一次 gate 调用内恰好执行一次。

#### T1-1 `run_shell` 产出路径事实（含分区）

**问题**：shell 链路**已经算出**「命令可能访问工作目录外」（`analysis.pathVerdict` + `shellSecurityHints.outsideWorkDirRisk`），但这些信息只进 hints 与日志，从不进 `ContentFacts`。

**做法**：在 `toolCallGate` 的 `run_shell` 分支（现在只做 `precheck` 并把结果挂到 `result.shellPrecheck`），把已算出的分析结果投影成事实：

```ts
// toolCallGate.ts：先执行一次 analyzer，再由 facts 与预检共同消费 shellAnalysis
const literals = [
  ...(shellAnalysis.facts?.paths ?? []),
  ...shellAnalysis.pathVerdict.violations.map((v) => v.path),
  ...(shellAnalysis.shellSecurityHints.scannedPaths ?? [])
].filter((p): p is string => typeof p === 'string' && p.length > 0)
// 分类前展开 ~、$HOME（Windows 另处理 %USERPROFILE%），并按 workDir 归一。
// facts.paths 是完整语法路径事实；violations/scannedPaths 仅作为补充风险字面量，统一去重。
shellPathSignals = unique(literals).map((p) => buildPathSignal(p, env))   // 事实阶段唯一分类
if (shellAnalysis.shellSecurityHints.outsideWorkDirRisk) {
  shellPathSignals.push({ kind: 'path-outside-heuristic', reason: 'command-may-touch-outside-workdir' })
}
```

关键点：

- **实现位置调整**：预检拆为「纯 analyzer（无裁决）」和「消费 shellAnalysis/facts 的安全裁决」两段；前者先于事实，后者晚于事实，消除循环依赖。
- **不改 `analyzeShellCommand` 的裁决语义**，只消费它已经产出的字面量（`verifyPathsInWorkDir` 会把 `lit.resolved` 写回，但 `pathVerdict.violations[].path` 保留原始字面量，分类器会按 `workDir` 解析相对路径，够用）。
- 同时**删掉 `run_shell` descriptor 里两条无效声明**：`path-classifier`（读不到入参）、`network-egress`（无实现）。避免「声明即事实」的错觉再次出现。
- 顺带把「未实现的提取器被静默 `continue`」（`runExtractors.ts:70`）改为一处**开发期断言**（测试断言所有声明名都在实现表中），防止下次再出现死声明。

#### T1-2 读类工具补路径事实，并启用 symlink 解析版分类

**问题**：`read_file` / `list_directory` / `grep` 的 `extractors: []`，策略层对它们没有任何路径输入（这正是「策略说放行、执行层说越界」的第一层成因）。

**做法**：

所有 lane 的 locked deny/confirm 规则必须在 shell 预检自动放行、写快通道和 automation 显式 allow 之前执行；命中 locked deny 时为不可覆盖终局，任何提前返回都必须携带该规则的 `policy.decision`。automation 的 `.env`、`/etc/hosts`、敏感 shell 与写快通道均需验证无旁路。

1. 三个读工具 descriptor 补 `extractors: ['path-classifier']`。
2. `path-classifier` 改用 **`classifyPathWithSymlink`**（已实现、无生产调用，V-3 结案），即「先 realpath、再分类」——这样「工作目录内指向外面的符号链接」也能被正确识别（清单 D-8 中「symlink 解析后的真实目标」一格）。
3. 为此把 `runExtractors` 的提取器契约放宽为可返回 `Promise`（`toolCallGate` 本身是 async，调用面改动很小）；同步提取器保持原样。

**注意**：读类工具新增 `path-target` 后会参与路径缓存键派生（`policyEngine.deriveCacheKeys` 的 `path/file` 档）。预期不产生新的缓存命中（读类工具本就走 `auto-allow`），但要在测试里固定这一预期（见 §4.1 的「事实副作用」用例）。

#### T1-3 路径字段别名对齐

`runExtractors` 的 path-classifier、事实流水线与 `writeFileAutoApproval` 统一使用 `extractPathField`（`path → filePath → file_path`，`electron/toolPathField.ts:27`）；执行器继续使用同一函数，确保别名输入不会绕过边界检查。

**做法**：两处改用 `extractPathField`。

#### T1-4 `run_script` 代码路径事实

`run_script` 的输入是 `code`，不能依赖只读 `input.path` 的通用提取器。新增生产接口 `extractScriptPathFacts(code, language)`，与现有 `extractScriptSignals` 在同一次 gate 调用中原子返回 `{ paths, completeness, dynamicAccess }`；两者共享同一解析游标和语法树，不允许一方成功而另一方失败后继续 clean allow。

完备性契约：Python 至少覆盖 `open`、`pathlib.Path.open/read_text/read_bytes`、`os.{remove,rename}`、`shutil`、`subprocess`；JavaScript/TypeScript 至少覆盖 `fs`/`fs.promises` 文件 API、`child_process`；PowerShell 覆盖 `Get-Content`、`Set-Content`、`Remove-Item`、`Start-Process`；shell 字符串/反引号、动态 import/exec、变量拼接、未知函数调用、未解析 AST 节点或子进程/解释器调用均将 `completeness='unknown'`、`dynamicAccess=true`。只有语法树完整、所有文件访问参数均为可静态求值字面量且无间接执行时才为 `complete`。

`paths` 再交给 T1-0 的同一 `preparePathFacts` 生成 `path-target`，不得在脚本提取器内另行实现敏感匹配或路径分区。`unknown` 产出 `script-path-extraction:unknown`，由前置 locked 规则 `script-path-extraction-unknown-ask` 转为真人确认；该规则必须排在 `script-clean-allow-desktop` 之前，确保 unknown 不会落入 clean allow。动态路径与间接执行必须有 gate 负例验收。

#### T1-5 补「只读性」事实，兼补「疑似越界」（D-9）

**问题**：策略引擎有「只读即放行」规则（`policyEngine.ts:279`），但判据是 descriptor 的**静态** `actionClass`，而 `run_shell` 恒为 `execute` —— 于是 `ls` 与 `rm -rf` 在策略层同档。

**为什么不动 `actionClass`**：`actionClass` 同时牵动缓存键、`baseRiskLevel`、lane 矩阵与记忆资格（`deriveMemoryEligibility`）。把它改成「按内容动态」，等于把「静态声明」和「本次事实」再次混在一层。**本轮走信号**。

**做法**：新增两条事实。

1. `{ kind: 'command-effect'; effect: 'read-only' | 'mutating' | 'unknown' }`
   - 数据源：`analyzeShellFacts` 的 `operations`（verb + args）、`connectors`、`analysisCompleteness`。
   - 需要 `shellAnalyzer` 补一个字段：`redirects: readonly string[]`（把重定向目标从 `paths` 里分出来）。现在 `paths` 把 `cat a > b` 的 `b` 与普通参数混在一起，无法据此判断「只读」。
   - 判据（**fail-closed**）：`analysisCompleteness === 'complete'` 且每个子命令 verb 命中只读白名单 且 无重定向 且 白名单外参数（如 `sed -i`、`find -delete`、`git branch -D`）不出现；任一条不满足 → `unknown`（宁可不放行）。
   - 初始白名单（可扩展、需测试固定）：`ls, cat, head, tail, wc, grep, rg, find（无 -delete/-exec）, fd, sed（无 -i）, git log|status|diff|show|ls-files, date, pwd, whoami, which, file, stat, du, df, echo, printf, sort, uniq, comm, diff, tree`。
2. `{ kind: 'path-outside-heuristic'; reason: string }`
   - 来源：`analyzeShellCommand` 已有的 `OUTSIDE_WORKDIR_RISK`（`npm run *` / `pnpm *` / `yarn *` / `npx *` 这类「没有路径字面量但可能摸到外面」的形态）。
   - 用途：进审批线索包，让审批 Agent 看到「系统认为可能越界」；规则默认不据此拦截（保持现状）。

#### T1-5 分区进入规则匹配与审计

- **规则匹配**：`policyEngine.signalTokenSet`（`policyEngine.ts:27`）目前对 `path-target` 只产出一个 token `path-target`，所以规则**写不出**「越界」这种条件。改为额外产出 `path-target:${zone}`；对 `command-effect` 同时产出 `command-effect` 与 `command-effect:${effect}`（例如 `command-effect:read-only`），与既有 `lark-write`、`toolkit-act`、`browser-act-dangerous` 同一写法。
- **审计**：`policy.decision` 目前只落 `signals: facts.signals.map(s => s.kind)`（`toolCallGate.ts` 审计段），分区不落盘 —— 于是「是否越界」在审计上不可判读（清单 D-2/D-11 的附带发现）。新增 `pathZones?: PathZone[]` 字段（**只落分区名，不落路径原文**）。

#### T1-6 允许访问的根集合改由策略层输出

- `resolveSafeReadPath(workDir, rel, extraRoots)` 现在的 `extraRoots` 是调用点硬编码 `[path.join(ctx.userDataDir, 'skills')]`（`builtinExecutors.ts:206 / 423 / 1228 / 1230` 共四处）。
- 改为：固定只读根（skills）+ 策略层本次放行的工作目录外目标集合，两者在执行器入口合并（T3-1）。沙箱原语不再知道「skills」这个业务概念。

### T2 策略层判决

#### T2-1 新增规则（顺序敏感）

在 `src/shared/policy/defaultRules.ts` 的「第 6 步段：默认表」**之前**插入（首条命中即返回，顺序即优先级）：

```ts
// 1) 敏感位置：必须真人确认（locked：任何套餐不得放宽）
{ id: 'path-sensitive-read-confirm', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], actionClass: 'read', signals: ['path-target:sensitive-file'] },
  action: 'confirm-every-time', locked: true, reason: '读取敏感位置（密钥/凭据/用户数据目录等）需真人确认' }

// automation 无真人回答者：敏感位置终局拒绝
{ id: 'automation-sensitive-path-deny', when: 'invocation',
  match: { lane: ['automation'], signals: ['path-target:sensitive-file'] },
  action: 'deny', locked: true, reason: '无人值守调用不得访问敏感路径' },
{ id: 'automation-system-dir-deny', when: 'invocation',
  match: { lane: ['automation'], signals: ['path-target:system-dir'] },
  action: 'deny', locked: true, reason: '无人值守调用不得访问系统目录' },
{ id: 'automation-script-unknown-deny', when: 'invocation',
  match: { lane: ['automation'], toolName: 'run_script', signals: ['script-path-extraction:unknown'] },
  action: 'deny', locked: true, reason: '无人值守调用无法确认脚本路径' },

// 2) shell 触及敏感位置：同样必须真人确认（locked）
{ id: 'shell-sensitive-path-ask', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_shell', signals: ['path-target:sensitive-file'] },
  action: 'confirm-every-time', locked: true, reason: '命令涉及敏感路径需真人确认' }

// 3) 系统目录：默认必须真人确认（Q-1 的 system-dir 维度；locked）
{ id: 'path-system-dir-ask', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], actionClass: 'read', signals: ['path-target:system-dir'] },
  action: 'confirm-every-time', locked: true, reason: '读取系统目录需真人确认' }

// 4) shell 触及系统目录：同样必须真人确认（不能被预检自动审批器绕过）
{ id: 'shell-system-dir-ask', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_shell', signals: ['path-target:system-dir'] },
  action: 'confirm-every-time', locked: true, reason: '命令涉及系统目录需真人确认' }

// 5) clean 脚本触及敏感/系统位置：禁止被脚本自动放行
{ id: 'script-sensitive-path-ask', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['path-target:sensitive-file'] },
  action: 'confirm-every-time', locked: true, reason: '脚本涉及敏感路径需真人确认' },
{ id: 'script-system-dir-ask', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['path-target:system-dir'] },
  action: 'confirm-every-time', locked: true, reason: '脚本涉及系统目录需真人确认' }

// 6) 脚本路径提取不完整：禁止 clean 自动放行，要求真人确认
{ id: 'script-path-extraction-unknown-ask', when: 'invocation',
  match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-path-extraction:unknown'] },
  action: 'confirm-every-time', locked: true, reason: '脚本路径无法完整判定，需真人确认' },

// 7) 工作目录外的只读访问：放行（Q-1 方向；lane 限定 desktop）
{ id: 'path-outside-readonly-allow', when: 'invocation',
  match: { lane: ['desktop'], actionClass: 'read', signals: ['path-target:outside-workdir'] },
  action: 'allow', reason: '工作目录外的只读访问免确认' }

// 8) 工作目录外的只读 shell 命令：放行（要求"每一段都只读"）
{ id: 'shell-outside-readonly-allow', when: 'invocation',
  match: { lane: ['desktop'], toolName: 'run_shell',
           signals: ['path-target:outside-workdir', 'command-effect:read-only'] },
  action: 'allow', reason: '工作目录外的只读命令免确认' }
```

要点：

- **为什么敏感在前**：`match.signals` 是「全部命中」语义（`every`），一条命令若同时触及敏感位置与越界位置，会产生多个 token。把敏感规则排在放行规则之前，靠**顺序**保证「敏感优先」这个不变量；测试里固化（§4.1「规则顺序（敏感优先）」）。
- **为什么敏感规则 `locked`**：`locked` 条目不被档位变换（`policyPackages.ts:198`），恒为「真人确认」；同时进 `DEFAULT_FLOOR`，任何套餐/自定义都无法放宽（`policyFloor.ts`）。
- **shell 敏感规则的执行顺序**：不能只依赖默认表排序。`shell-sensitive-path-ask` 使用引擎会提前处理的 `confirm-every-time` 动作；shell 预检在生成 `legacyAutoAllowEligible=true` 前必须先检查已生成的 `path-target:sensitive-file`，命中时跳过自动审批器，最终决策固定为 `require-confirm`、`answerer=user`。
- **shell 系统目录同理**：`shell-system-dir-ask` 使用同一提前处理路径；`cat /etc/hosts` 等命令命中 `path-target:system-dir` 时，必须在预检自动审批器之前转为真人确认。
- **clean 脚本同理**：`script-sensitive-path-ask` 与 `script-system-dir-ask` 必须排在 `script-clean-allow-desktop` 之前，并使用 `confirm-every-time`；命中任一事实时，clean 结论不得直接 `allow`。
- **为什么越界只读放行不 `locked`**：它是体验优化，应允许用户收紧（收紧方向是改回 `ask`；底线校验只拦放宽）。
- **行为变化提示（需产品确认）**：第 1、2 条对 IM lane 也生效，意味着「IM 会话读敏感文件」从现在的「按 actionClass 直接放行」变为「需真人确认」。这是收紧，符合「敏感必须问人」的既有红线，但属行为变化，需在评审时明确；若要最小化改动，可先把这两条的 `lane` 收成 `['desktop']`。
- **真人确认动作不可使用普通 `ask`**：desktop standard 会将 `ask` 变换成 `auto-evaluator`；敏感、系统目录及脚本未知路径统一使用 `confirm-every-time` 并 `locked`，最终断言 `decision.type=require-confirm`、`answerer=user`。越界只读 allow 规则仍可按套餐语义收紧，但不承担敏感/系统红线。
- **缓存顺序**：先生成完整 facts，再执行 locked deny/confirm 前置检查；在该检查完成前禁止读取 policy cache、shell auto-evaluator 或写快通道结果。只有未命中 locked 规则时才派生/读取缓存。缓存键和值必须包含 `factsDigest`、规则版本和 lane；旧的 auto-allow cache 不得覆盖新增敏感/系统事实或规则版本变化。

#### T2-2 写通道：把「策略判断」从快通道里拿出来

桌面 standard 下 `write_file` / `edit_file` 走确定性快通道（`toolCallGate` 注册 `file-fast-track`，批准即 `auto-allow`）。快通道里混了三件不同的事（清单 D-3/D-7 ①）：路径解析（沙箱）、敏感清单（策略）、体量阈值（策略）。

**做法**：

- 快通道移除**路径范围解析**，但保留现有敏感路径判定与 `sensitive_path` 拒绝分支；体量判断仍返回 `oversize` / `edit_too_large`。这样桌面 standard 写 `.env`、`/secrets/` 或 `userDataDir` 仍会「快通道不批 → 审批 Agent」，不会产生安全回归。
- 快通道在返回批准前必须消费 T1-0 已生成的路径事实：`write_file` / `edit_file` 命中 `path-target` 且 zone 不是 `workdir-normal` 时，返回“不自动批准”的越界原因并进入确认/审批；该检查覆盖非敏感的 `/tmp/out.txt`，不能只依赖敏感判定，也不得重新分类。
- 敏感判定的实现与路径事实共用 T4-1 的匹配函数；快通道只消费匹配结果，不再把路径解析异常翻译成敏感策略码。缺少路径仍返回独立的输入错误原因。
- 越界事实由 `path-target` 提供，写类仍按现有审批路径处理；本轮不把写工具的敏感确认迁移到规则层。

#### T2-3 D-4 / D-5 的处理口径

- **D-4（用户指令不是授权凭据）**：本轮不改审批 Skill 的授权假设，也不新增「用户授权」维度。做法是把**最常见的那类越界（只读、非敏感）**从「需要裁决」变成「策略确定性放行」——不需要授权凭据，因为不再需要授权。真正的「授权一次、后续免问」是 Q-3 的范围，本轮不做。
- **D-5（重试即概率门）**：主要来源（越界只读逐次裁决）随 T2-1 消失；其余（写类反复重试）保留现状与既有 `toolErrorRepeat` 计数，不引入惩罚机制（§1.6 第 3 条）。

### T3 执行层让位（后置层）

#### T3-1 「本次执行许可」的传递

- 许可内容：不可变授权对象 `{ requestId, inputDigest, targets: [{ normalizedPath, zone, factId, decisionRuleId }], approval: { type: 'auto-allow' | 'user-confirmed' | 'agent-approved', approvedFactIds: string[] } }`。`auto-allow` 分支只使用 `PolicyDecision.approvedFactIds`（无需确认结果）；需要确认的分支才取策略与确认结果的 `approvedFactIds` 交集。缺少策略批准目标或交集为空即不发许可。

```ts
type CandidateTarget = {
  factId: string
  zone: PathZone
  rawPath: string
  normalizedPath: string
}
type PermitTarget = CandidateTarget & { decisionRuleId: StableRuleId }

const candidateTargets: CandidateTarget[] = facts.targets.map((t) => ({
  factId: t.factId,
  zone: t.zone,
  rawPath: t.rawPath,
  normalizedPath: t.normalizedPath,
}))
```

每个 `path-target` 在事实生成时分配稳定 `factId`（同一调用内按规范化目标与出现序去重；不同字面量指向同一 symlink 目标保留各自来源并共享规范化目标），后续不得从路径字符串反查 fact。

```ts
const candidateByFactId = new Map(candidateTargets.map((t) => [t.factId, t]))
const approvedTargets: PermitTarget[] = gate.decision.approvedFactIds.map(({ factId, decisionRuleId }) => {
  const candidate = candidateByFactId.get(factId)
  if (!candidate || !decisionRuleId || decisionRuleId.startsWith('<')) {
    throw new IntegrationViolation(`approved target mapping is incomplete: ${factId}`)
  }
  return { ...candidate, decisionRuleId }
})
```

V1 采用最小安全粒度：一次调用不得混合不同安全 zone。事实准备阶段生成全部显式路径事实后、调用策略引擎前执行 zone 一致性检查；只要存在两个或以上 zone 就直接 `deny`、`approvedFactIds=[]`、不发确认请求且不生成 permit。该拒绝要求调用方拆分请求，不可通过真人确认覆盖。只有同一安全 zone 的目标才进入四条规则并可列入 `approvedFactIds`。

目标粒度固定为工具的显式输入目标，并为可观察输出建立冻结范围：`read_file` 和 V1 `grep` 各只有一个普通文件目标、一个 `factId`。`grep` 输入为目录、通配模式、多路径字段或需要递归展开时，facts provider 返回 `targetKind:'unknown'`，V1 gate 直接 `deny`，不调用 `walk`、glob 或 ripgrep 递归模式。多路径 `grep` 的 factId/permit 契约移至后续版本，直到 schema 与执行器同步扩展。目录枚举不属于 V1；`list_directory` 移至后续版本。

- 注入点：主循环构造 `executionContext` 处（`toolChatLoop.ts:2902`），仅当 `decision.type === 'auto-allow'` 或 permit builder 原子消费了当前 request 的真人批准登记后注入；`toolUserConfirmed` 只能作为界面状态，不是授权凭据：

```ts
pathPermit: buildPathPermit({ requestId, inputDigest, candidateTargets, decision: gate.decision, confirmation })
```

`normalizePermitTarget` 必须先展开 `~`、`$HOME`/`%USERPROFILE%`，再以 `workDir` 解析相对字面量，并对存在目标尽力 `realpath`；不存在目标保留归一后的绝对路径，禁止把原始相对字面量交给执行器。
`PolicyDecision.approvedFactIds` 的元素结构为 `{ factId, decisionRuleId }`，由策略引擎在首条命中规则和自动放行路径中生成；`buildPathPermit` 用该映射填充目标的 `decisionRuleId`。`auto-allow` 只接收策略映射，确认路径接收策略映射与确认结果的 factId 交集；对整次调用确认的规则，决策必须显式列出该调用全部目标的 factId，不能由执行层猜测。执行前重新计算当前工具入参摘要与规范化目标，并校验 `requestId`、`inputDigest`、`normalizedPath`、`zone` 全部一致，任一不一致即拒绝并记录 `policy.execution-veto`。`agent-approved` 只允许普通越界只读等非 locked 规则；敏感、系统目录和脚本 unknown 的 locked 规则只能产生 `user-confirmed`。

- `ToolExecutionContext` 增一个可选字段 `pathPermit?: PathPermit`；执行器只消费其中绑定的 `targets`，不再接收裸 `outsideTargets` 数组。

#### T3-2 执行器按许可执行，不再自行判「越界」

- 读类四处（`builtinExecutors.ts:206 / 423 / 1228 / 1230`）：先用与事实层相同的展开/归一函数把本次入参 `rel` 转为 `executionPath`；对相对越界目标不得把原始 `../outside/x.md` 继续传给 `resolveSafeReadPath`，而应传入对应的绝对 `executionPath`，再与 `pathPermit.targets` 中同一 `factId`、`normalizedPath` 做包含校验。许可目标必须是按 `workDir`、`~`/`$HOME` 展开并尽力 realpath 后的绝对路径，不能直接使用原始字面量。
- 写类两处：先将绝对许可目标解析为独立 permit root，再调用支持多根包含判断的 `resolveSafeWriteTarget`。该函数需明确区分绝对入参与相对入参：permit 为空时保持现状；permit 非空时不得经过 `normalizeRelPathInput` 重定基到 `workDir`，并将所有 `assertInsideBase` 改为「属于 workDir 或任一 permit root」。
- **文案与语义改造（关键）**：执行器里 `catch → { success:false, error: '路径超出工作目录范围: ...' }` 的写法要改：只有在「策略没放行却仍然越界」时才走这条，且错误文案改为「该路径位于工作目录之外，需先获得授权」，并把这类情况按 T3-4 留痕。**机制性失败**（symlink、TOCTOU、身份不符）改为各自的机制文案（T3-3），不再借用「越界」这个词。

#### T3-3 失败类别（复用现有 `diagnostic`，不另造体系）

`ToolExecutorResult.diagnostic` 已有 `{ caseId, retryable, category }`，`category` 取值含 `'policy' | 'environment' | 'executor'`（`electron/tools/types.ts`）。映射：

| 情况 | category | retryable | 文案方向 |
| --- | --- | --- | --- |
| 缺少/空路径、别名缺失 | `executor` | false | 「缺少有效的路径参数」 |
| 越界且策略未放行（不应发生，属集成缺陷） | `policy` | false | 「该路径位于工作目录之外，需先获得授权」+ 留痕 |
| symlink / 非普通文件 / 身份不符 / TOCTOU | `environment` | true | 「目标在操作过程中发生变化或不是普通文件，可换目标或重试」 |
| 必须先读后写（`ERR_FILE_NOT_READ_FOR_EDIT/WRITE`） | `executor` | false | 「这是流程要求：编辑前需先读取该文件」（不是安全拒绝） |
| 工作目录不可用 / 路径组件无法判定 | `environment` | true | 「工作目录当前不可用」 |

与同批方案（`session-ced59b41-...`）共用同一 `diagnostic` 结构，不新增第二套错误码。

#### T3-4 执行层否决留痕

当「策略已放行、执行却未执行」时（实现缺陷或机制失败），写一条审计：

```
event: policy.execution-veto
toolName / sessionId / lane / requestId
decisionRuleId: <策略判决的 ruleId>
pathZone: <分区>          // 不落路径原文
failureClass: 'input' | 'mechanism' | 'environment' | 'integration-violation'
```

用途：让「审计说放行、事实是没执行」这类问题下次能被一条查询直接捞出来（清单 D-10 的核心危害）。

### T4 唯一真相源

#### T4-1 敏感清单：一处实现、一处取值

- **取值**：`toolCallGate.ts:305` 改为 `getBuiltinSensitivePrefixes(userDataDir)` + `shellConfig?.customSensitivePrefixes`（修 V-4）。
- **实现**：统一函数签名为 `matchSensitive(input: { rawPath: string; resolvedPath: string; workDir: string; homeDir?: string; platform: 'posix' | 'win32'; builtinPrefixes: readonly string[]; customPrefixes: readonly string[] })`，由一次事实生成调用。函数必须保留既有 `isSensitivePath` 语义：`.env`/`.env.*` 后缀、`/secrets/` 目录、`userDataDir` 前缀、`~/.ssh`/home 展开、Posix 与 Windows 分隔符及盘符规则；自定义前缀与内置前缀合并后按同一平台归一化匹配。策略、写快通道和 shell 预检只消费返回的 `{ sensitive: boolean, matchedBy?: ... }`，不得各自传参或重新匹配。
- **写明一条既有语义**：`getBuiltinSensitivePrefixes` 把 `userDataDir` 本身算作敏感（`shellSensitivePaths.ts:42`）。这保证了「越界只读放行」不会顺手打开用户数据目录。

#### T4-2 写快通道归位（D-7 ① + D-3）

- `evaluateFileToolAutoApproval`：删除路径范围解析的 try/catch，但**保留**敏感路径匹配及 `sensitive_path` 拒绝（B1 回归门禁）；缺少路径返回独立输入错误。返回类型仍包含 `'sensitive_path' | 'oversize' | 'edit_too_large'`，路径事实与快通道共享 T4-1 的匹配函数。
- 结论落审计：快通道「未通过」的结论与原因码要进 `SecurityAuditEvent`（现在只在 agent 日志与确认卡，V-6 结案项）。
- 效果：清单 D-3 的「三种成因共用 `sensitive_path`」自然消失 —— 路径解析异常不再被翻译成策略码。

#### T4-3 wiki raw 上收为策略（D-11 ③）

- 现状：`wikiRawWriteBlocked`（`builtinExecutors.ts:592`）在写执行器里判 `isUnderWikiRaw`，策略层看不见；且 `ToolCallGateArgs` 里没有 `wikiConfig`。
- 做法：`ToolCallGateArgs` 增 `wikiConfig`（主循环已在作用域内）；写工具在 `wikiConfig.enabled` 时产出事实 `{ kind: 'wiki-raw-target' }`（复用现成的 `classifyWikiPath`，`electron/wiki/wikiPaths.ts:25`）；规则 `wiki-raw-deny`（`locked`，reason 沿用现有文案 `WIKI_RAW_READONLY`）；执行器里那段删掉。
- 复验条件：清单 V-8 ① 指出本环境 `wikiConfig.enabled` 非 true，需在启用 wiki 的环境实测。

### T5 灰区拆分（清单 D-8 四处，落代码）

| 项 | 现在 | 改成 |
| --- | --- | --- |
| 空路径 | `pathSecurity.ts:52` 抛「路径超出工作目录范围」 | 新增 `InvalidPathInputError`；执行器映射为「输入无效」（T3-3） |
| 目标类型 | `pathSecurity.ts:175` 直接 `throw` | 新增前置 `probePathTarget()`，返回 `{ kind: 'file' \| 'dir' \| 'missing' \| 'special' \| 'symlink' \| 'hardlink', realPath?: string }`，作为事实供策略层消费；执行层在 `safeAtomicWrite` 落盘前**再**拒一次特殊文件（已有的 identity/nlink 复验承担此责） |
| symlink / 硬链接 | `pathSecurity.ts:171/178` 前置即终局 | 前置产事实（真实目标 + 是否经链接）；后置保留 `assertNoSymlinkAlong` 与 `nlink` 复验（TOCTOU 必需），失败按机制类别表述 |
| 敏感清单 | 三方各自调用 | T4-1 |

> 注意：后置的 symlink 检查**必须保留**。前置产出的事实在「解析」到「落盘」之间可能失效，这不是冗余，而是两层各自的时间点不同（现状 `safeAtomicWrite` 自己已经这么做了 —— 架构上早就知道要两层，只是前置函数把后置的活也干了一遍）。

### T6 逐通道清理表（清单 D-11 / Q-9）

| # | 通道 | 现状（执行层否决） | 本方案处理 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | 读通道（`read_file`/`list_directory`/`grep`） | `resolveSafeReadPath` 抛错 → 终局失败，策略层不知 | 后续扩展：先完成本阶段单一 `read_file`，再推广同一契约 | **后续** |
| 2 | 写通道（symlink / 硬链接 / 非普通文件） | `resolveSafeWriteTarget` 抛错 → 终局失败 | 后续扩展：不得进入本阶段闭环 | **后续** |
| 3 | wiki raw（`wikiRawWriteBlocked`） | 只读保护写在执行器 | T4-3：上收为事实 + 规则 | P1（需 wiki 启用环境实测） |
| 4 | `switch_work_dir` 的 `sensitive` | 策略判断写在执行器，绕过策略引擎 | 同 T4-3 手法：产事实（目标 profile 的 sensitive）+ 规则 `deny` | P2（remote lane 专有，需对应 lane 实测） |
| 5 | `read_feishu_attachment` 的 feishu-media 边界 | 执行器自判资源范围 | 同上手法（产事实 + 规则） | P2（feishu lane 专有） |
| 6 | 写工具的「必须先读后写」（`ERR_FILE_NOT_READ_FOR_*`） | 执行层否决、策略层不知 | **明确不上收**。它是流程约束而非安全判决；只改文案说清性质并给独立类别（T3-3 的 `executor` 档 + 新文案） | P1 |

**不做上收的一条判据**：如果某条否决的答案是「换个做法也解决不了，只有授权或改输入」，那它属于策略层；如果答案是「按流程做就行」（第 6 条），那就留在执行层说清楚，别为了整齐把它搬进策略层。

### T7 审计与时序（让「谁说了算」可查）

- **T7-1**：`policy.decision` 增 `pathZones`（T1-5）。
- **T7-2**：新增 `policy.execution-veto` 事件（T3-4）。
- **T7-3**：`tool_result` 侧记录本次生效的 `decisionRuleId`，使「同一次调用的策略判决 → 确认 → 执行」能用 `requestId` 串起来，并能回答「审计说放行的那次，到底执行了吗」。

---

## 3. 单一闭环实施顺序（本阶段唯一门禁）

当前 V1 实现 `desktop/read_file` 与 `desktop/grep`；每次调用只处理显式输入目标。未列出的 T1~T7 内容均为后续版本扩展，不得进入 V1 门禁或发布条件：

1. 每个 V1 工具 gate 只生成一次不可变 `InvocationFacts`；每个显式路径拥有独立 `factId`、绝对 `normalizedPath`、`zone` 与 `targetKind`。
2. 唯一策略函数消费该 facts，生成 `PolicyDecision`；任何一次调用只允许所有目标属于同一 zone，否则直接 `deny` 且 `approvedFactIds=[]`；本阶段关闭旧 allow cache。
3. `require-confirm` 时调用 desktop 真人确认，生成绑定 `requestId/inputDigest/approvedFactIds` 的 `ConfirmationResult`。
4. 许可构造器用策略批准集合与确认集合（如有）的交集生成 `ExecutionPermit`，注入对应工具的专属执行器；两个执行器共享同一个 permit 校验器。
5. executor 只验证 permit 和机制状态，记录 decision、permit、result。

V1 gate 装配固定为 `evaluateToolCallGate` 的专用分支：当 `lane==='desktop'` 且工具为 `read_file` 或 `grep` 时，先调用 V1 facts provider（`extractPathField`；V1 `grep` 的单一路径调用一次），执行 zone 一致性检查，再仅使用本节四条规则构造 `PolicyDecision`。该分支不读取 `default-read-outbound-allow`、不调用旧读规则匹配、不读取旧读 cache；旧 `effectiveRules` 仅用于非 V1 工具。V1 决策、确认和 permit 完成后，主循环只能把 permit 注入对应的 `readFileExecutor`/`grepExecutor`，旧的无 permit 执行入口对 V1 调用必须返回 `policy.execution-veto`。

### 3.0 本切片实际编译的最小规则

V1 只编译以下四条适用于 `desktop/{read_file,grep}` 的规则；后文 T2-1 的通用规则表不参与 V1 编译、门禁或验收。规则按表中顺序匹配，首条命中即停止：

| 顺序 | `ruleId` | 匹配条件 | 判决 | `approvedFactIds` |
| --- | --- | --- | --- | --- |
| 1 | `read-group-sensitive-confirm` | `lane=desktop ∧ toolName∈{read_file,grep} ∧ target.zone=sensitive-file` | `require-confirm`, `answerer=user` | 确认前为空；真人批准后仅加入被确认目标 `{factId, decisionRuleId:'read-group-sensitive-confirm'}` |
| 2 | `read-group-system-confirm` | `lane=desktop ∧ toolName∈{read_file,grep} ∧ target.zone=system-dir` | `require-confirm`, `answerer=user` | 确认前为空；真人批准后仅加入被确认目标 `{factId, decisionRuleId:'read-group-system-confirm'}` |
| 3 | `read-group-outside-allow` | `lane=desktop ∧ toolName∈{read_file,grep} ∧ target.zone=outside-workdir` | `auto-allow` | 加入该单一目标 `{factId, decisionRuleId:'read-group-outside-allow'}` |
| 4 | `read-group-workdir-allow` | `lane=desktop ∧ toolName∈{read_file,grep} ∧ target.zone=workdir-normal` | `auto-allow` | 加入该单一目标 `{factId, decisionRuleId:'read-group-workdir-allow'}` |

`sensitive-file` 优先于 `system-dir`、`outside-workdir` 和 `workdir-normal`。同 zone 的多个显式目标可以共同授权；混合敏感/系统与普通越界目标时确认必须全量覆盖所有显式 factId，否则不生成 permit。确认结果不支持部分批准。缺少目标事实、`targetKind='unknown'`、事实探测环境错误或未命中四条规则时为 `deny`，批准集合为空。任何后续默认读规则、缓存命中或 lane 变换都不能覆盖这四条规则。

### 3.1 本切片的最小类型映射

| 契约对象 | 现有落点 | 本阶段字段 | 生产者 → 消费者 | 不变量 |
| --- | --- | --- | --- | --- |
| `InvocationFacts` | gate 的 `ContentFacts` + 本次 read 专用 `ReadPathFact` | gate 为本次调用生成 `requestId/inputDigest`；每个显式目标 `factId/rawPath/normalizedPath/zone/targetKind` | read facts producer → policy/confirmation/permit/executor | 只生成一次；绝对路径；每个显式目标独立 factId |
| `PolicyDecision` | policy decision | `type/ruleId/approvedFactIds[{factId,decisionRuleId}]/answerer` | policy → confirmation/permit | factId 属于 facts；deny 集合为空 |
| `ConfirmationResult` | 现有确认通道结果 + gate 保存的待确认快照 | `requestId/inputDigest/approvedFactIds/answerer:'user'/result`；V1 一次确认覆盖该调用全部显式 factId，只允许全量批准或拒绝 | confirmation → permit builder | 只能批准策略集合中的全部 factId，工具输入与待确认快照一致 |
| `ExecutionPermit` | `ToolExecutionContext` 新增字段 | `requestId/inputDigest/toolName/targets[{factId,normalizedPath,zone,ruleId,scope}]/source` | permit builder → 对应工具 executor | 无未知 fact、占位 ruleId、相对路径；scope 不可扩张 |
| `IntegrationViolation` | `ToolExecutorResult.diagnostic` | 固定 `executor` 类别和 caseId | permit builder/executor → 审计/失败结果 | 不生成 permit；保留 factId |

契约唯一真相源为[最小核心契约 v1](../review/session-d961cc51-boundary-policy-layering-minimal-core-contract-v1.md)；本文 V1 实现其 `read_file`/`grep` 子集，不在其它安全语义组复制同名结构。

本切片的代码接口固定如下，不直接复用仅返回 `PathZone` 的 `classifyPathWithSymlink` 作为事实对象：

```ts
type ReadPathFact = {
  rawPath: string
  normalizedPath: string // lexical absolute path; for existing symlink target this is the resolved real path
  zone: PathZone
  targetKind: 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'
  identity?: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }
  scope?: 'single-target' | 'direct-entries-snapshot'
}

async function probeReadPathFact(input: {
  rawPath: string
  workDir: string
  userDataDir: string
  homeDir: string
  customSensitivePrefixes: readonly string[]
}): Promise<ReadPathFact>
```

`probeReadPathFact` 负责一次词法绝对化、`lstat`/`realpath`/`stat` 探测与敏感判定；不得由调用方再补查来构造另一个 zone。文件不存在（`ENOENT`）返回 `targetKind:'missing'` 和词法绝对路径；`EACCES`、`EIO` 等其它 I/O 失败返回环境错误，不得回退成可自动放行的词法 zone。目标经 symlink 解析后 `normalizedPath` 指向 realpath，`targetKind:'symlink'` 并保留目标身份。

分区优先级固定为：`sensitive-file` → `system-dir` → `outside-workdir` → `workdir-normal`。本阶段新增 `matchReadSensitivePath({ resolvedPath, userDataDir, homeDir, platform, customPrefixes })`，并让 `getBuiltinSensitivePrefixes`/`isSensitivePath` 的本阶段重载显式接收 `homeDir` 与 `platform`；内置前缀、`~`/`%USERPROFILE%` 展开和自定义前缀全部基于传入 `homeDir`，严禁读取宿主 `os.homedir()`。因此 `.env`/`.env.*`、任意层级 `secrets/`、home 密钥目录、用户数据目录和自定义前缀均在普通 workdir/outside 分类之前匹配。不得仅用 `EnvFacts.sensitivePaths` 做前缀比较替代此函数。

### 3.2 路径解析冻结

事实阶段只调用一次 `probeReadPathFact`，gate 在返回值上分配本次唯一 `factId`，冻结 `normalizedPath/zone/targetKind/identity`；不存在路径也保留绝对路径和 `targetKind:'missing'`。执行阶段不得调用分类器、敏感匹配或重新推导 zone，只能比较摘要，并对 permit 中的同一 `normalizedPath` 做机制性身份/TOCTOU 复验。

复验失败统一返回 `mechanism` 或 `environment` diagnostic，携带原 `factId`，不得更新 facts。工作目录内 symlink 指向外部时，唯一事实为 `outside-workdir`；确认后目标变化时以 permit veto 拒绝并审计。permit 通过后，两个工具分别使用 `readFileExecutor`、`grepExecutor`，但都先调用共享 `validateExecutionPermit(toolName, requestId, inputDigest, targets)`；校验失败不得进入工具专属逻辑。`readFileExecutor` 只打开 `scope='single-target'` 的目标；`grepExecutor` 只读取 permit 中逐项批准的显式输入路径，并为每个目标记录结果。它们均不得把授权目标交给只允许 workDir/skills 的 `resolveSafeReadPath`，也不得重新分类。打开文件时使用 `O_NOFOLLOW`（平台支持时）并比较 `fstat` 与事实身份；目录快照发生变化或不支持稳定身份校验时 fail-closed，归类为机制拒绝。

### 3.3 确认登记与一次性消费

本阶段为每个待确认的 V1 `read_file`/`grep` 调用建立进程内确认登记表，唯一键为 `requestId`，值为 `{ requestId, toolUseId, inputDigest, factIds, ruleId, expiresAt, state }`。状态机固定为：

```text
pending → approved → consumed
pending → rejected | expired
approved → expired（超过 expiresAt）
```

登记发生在 gate 返回 `require-confirm`、确认请求发出之前；登记内容是不可变 facts 快照。确认事件必须同时携带 `requestId + toolUseId + inputDigest + approvedFactIds + answerer:'user' + result`，且 `approvedFactIds` 必须是该 pending 快照目标的子集；只有覆盖本次策略要求的全部目标时，才允许把对应 `pending` 项原子转换为 `approved`。拒绝、取消、超时、确认通道错误、会话结束和进程重启均删除或标记为 `expired`；重复点击、重复事件或已非 `pending` 状态一律不改变状态。

permit builder 是唯一消费点：仅接受当前 `requestId` 下、未过期且状态为 `approved` 的登记，并在构造 `user-confirmed` permit 的同一原子操作中将其改为 `consumed`。`consumed`、其它 requestId、不同 toolUseId、摘要或 factId 不匹配的结果均拒绝并记录 `policy.execution-veto`；执行器不接受布尔 `toolUserConfirmed` 作为授权凭据。确认后任何输入变化都必须重新 gate 并生成新的登记。

## 4. 单一闭环验收

### 4.1 单元与类型

- facts 只生成一次，含稳定 `factId`、绝对 `normalizedPath`、正确 `zone/targetKind`。
- `PolicyDecision.approvedFactIds` 只能引用 facts 中的唯一真实 factId 和真实 `decisionRuleId`；V1 不接受多路径调用。
- 普通工作目录内/外文件为 `auto-allow`；敏感文件/系统目录为 `require-confirm + answerer=user`；automation 误入则直接 deny。
- `./.env`、任意层级 `secrets/`、userDataDir、home 密钥目录、自定义敏感前缀均在事实层判为 `sensitive-file`，最终必须真人确认。
- 传入 `homeDir` 与宿主 home 不同的测试中，`homeDir/.ssh/id_rsa`、`homeDir/.gnupg` 和 `homeDir/.env` 仍判为 `sensitive-file`；不得依赖 `os.homedir()`。
- 事实探测结果区分存在普通文件、symlink、missing；`EACCES/EIO` 等解析失败为环境错误，不得降级到普通路径。
- 确认的 requestId、inputDigest 或 factId 不一致时不生成 permit。
- 缺失 factId、缺失/占位 ruleId 或相对 normalizedPath 时抛 `IntegrationViolation`。

### 4.2 V1 文件读取组集成入口

| 场景 | 期望 |
| --- | --- |
| 工作目录内普通文件 | 一次 facts → auto-allow → permit → 成功读取 |
| 工作目录外普通文件 | 一次 facts → auto-allow → 绑定 factId 的 permit → 成功读取 |
| `grep` 单个显式普通文件 | 生成一个 factId；permit 只覆盖该文件 |
| `grep` 目录/通配输入 | facts 为 `unknown`，gate 直接 deny；执行器不得调用 `walk`、glob 或递归 ripgrep |
| zone 一致性前置拒绝 | sensitive+outside、system+outside、sensitive+system、workdir-normal+outside 均在策略引擎前 deny；无确认登记、无 permit |
| `./.env` / `./secrets/key` | facts 为 `sensitive-file`，真人确认后才可读取 |
| userDataDir / 自定义敏感前缀 | facts 为 `sensitive-file`，`require-confirm + answerer=user` |
| 敏感文件 | 真人确认后成功读取；Agent 不可批准 |
| 系统目录文件 | 命中 `read-group-system-confirm`，真人确认后成功读取 |
| 不存在路径 | facts 保留绝对路径和 `missing`；执行返回输入/环境结果，不重新分类 |
| 工作目录内 symlink 指向外部 | facts 唯一判为 outside-workdir；执行仅复验 permit |
| 确认后 symlink/路径变化 | veto/机制 diagnostic，保留原 factId |
| 确认登记生命周期 | pending → approved → consumed；拒绝、超时、取消、重启和重复点击均不能生成 permit |
| 确认重放隔离 | 不同 requestId/toolUseId 或已 consumed 的确认结果均被拒绝 |
| 无读取许可的越界目标 | executor 不调用 `resolveSafeReadPath` 回退执行，缺失 permit 直接拒绝 |
| permit 许可的越界/敏感文件 | 真实 `readFileExecutor` 从 permit.normalizedPath 读取成功，身份与事实快照一致 |

### 4.3 V1 不验收

shell、run_script、write/edit 快通道、automation 扩展、策略缓存及 wiki/remote/feishu 通道均为后续版本，不得作为 V1 完成条件。V1 必须验收 `read_file` 和单路径 `grep` 的显式普通文件；目录、通配和多路径输入均直接 deny。`list_directory` 与多路径 `grep` 不属于 V1。

## 5. 风险与回退

| 风险 | 说明 | 缓解 / 回退 |
| --- | --- | --- |
| 放行面扩大（越界只读） | 新放行规则会真实放开工作目录外的读取 | 只读白名单 fail-closed；敏感/系统目录优先且 locked；shell 要求「每段都只读」；lane 限定 desktop。回退：两条 `allow` 规则改回 `ask`（一处 diff） |
| 许可漏传 | 策略放行但执行仍拒绝（老问题复现） | T3-4 审计 + 端到端用例（§4.3 第 1 条）兜住 |
| 事实补齐的额外 IO | 每次调用多做 1~3 次 realpath/lstat | 只在有路径字面量时执行；不引入目录遍历；与现有执行器解析次数同量级 |
| 读类工具新增事实的副作用 | 参与路径缓存键派生、`factsSummary` 文案变化、线索包多出路径 | §4.1「事实副作用」用例固定预期；线索包多出路径正是 D-2 想要的效果 |
| IM lane 行为收紧 | 敏感读从「自动放行」变「需真人确认」 | 属有意收紧；若要最小化，可先只开 desktop（见 T2-1 提示） |
| 审计 schema 增字段 | 老日志解析器可能不认识新字段 | 仅追加可选字段，不修改既有字段语义 |

---

## 6. 与其它文档的关系

- **`session-ced59b41-...-technical-plan.md`**：那份方案定义的工具结果 `diagnostic` 契约（`category` + 结构化 details）被本方案直接复用；本方案不重复其「能力/环境拒绝」部分。
- **`security-policy-single-entry-requirement.md`**：本方案的所有判决都以规则条目 + `policy.decision` 落盘，符合「单一入口」；T4-2 撤销的正是与之冲突的「快通道旁路」。
- **`run-shell-agent-safe-boundary-hardening-plan.md`**：那份处理日志与 Agent 载荷的脱敏；本方案新增的审计字段遵守其原则（只落分区与类别，不落路径原文）。
- **`message-fact-production-pipeline-refactor-plan.md`**：其中关于「prepared-shell / permit 链路尚未接线」的说明与本方案一致；本方案在现役主链路落地，不依赖那条链路。

---

## 7. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-09-23 | 首版。按 HEAD `4bc49538` 逐条核对清单 D-1~D-11、Q-1~Q-10、V-1~V-9：①给出三层架构梳理与「前置产事实 / 后置守机制 / 环境输入错误」三分类，并把 D-8 的 22 项功能逐项归属；②校正清单 6 处事实（`confirmOutsideWorkDir` 已删除、`run_shell` 的 path-classifier 属「声明了但读不到入参」、读类工具 `extractors: []`、`autoApproveFallback` 不进安全审计、V-2/V-3 结案）；③Q-1~Q-10 全部给出取定；④任务分解 T1~T7，按 P0/P1/P2 分批并给出测试与门禁；⑤明确三件不做的事（不给 shell 加路径边界、不为路径域破 I3、不引入重试惩罚） |
| 0.2 | 2026-09-24 | 根据评审 B1~B4、C1~C2 修订：保留写快通道敏感判定并增加回归门禁；补齐 `system-dir` 规则；补充 `command-effect:<effect>` token；统一展开 `~`/`$HOME` 并将 outside target 归一为绝对路径；明确写侧多根许可不能把绝对路径重定基到 workDir；增加相对越界、系统目录与 shell 家目录敏感用例。 |
| 0.3 | 2026-09-24 | 根据评审 v2 修复许可语义：确认或审批通过的 `sensitive-file` / `system-dir` 目标必须进入 `pathPermit`，仅未确认时排除；新增两条确认后执行验收。 |
| 0.4 | 2026-09-24 | 根据评审 v3 修复四项阻断问题：越界写快通道增加 zone 阻止；敏感 shell 改用引擎提前处理的 `confirm-every-time` 并阻断预检自动批准；读执行器将相对越界入参转换为绝对执行路径；将 T1-4、T4-1、T2-2 纳入 P0 并补齐回归门禁。 |
| 0.5 | 2026-09-24 | 根据评审 v4 重排门控时序：新增 T1-0 统一事实流水线，要求 facts 先于 shell 预检与写快通道生成；三方只读同一份路径/敏感结果，禁止重复分类；P0 纳入该流水线并增加一致性验收。 |
| 0.6 | 2026-09-24 | 根据评审 v5 修复循环依赖与事实缺口：shell analyzer 单次先行并向 facts/预检/策略共享结果；T1-3 路径别名提升至 P0；明确统一敏感匹配的完整输入与 `.env`、`secrets`、平台路径、自定义前缀语义。 |
| 0.7 | 2026-09-24 | 根据评审 v6 补齐 shell 系统目录保护，并规定路径事实必须覆盖 `shellAnalysis.facts.paths`，旧 verdict 仅作补充风险来源；新增系统目录与未触发旧 violation 的敏感路径验收。 |
| 0.8 | 2026-09-24 | 根据评审 v7 为 `run_script` clean 自动放行增加敏感路径与系统目录的 locked 真人确认规则，并补齐 `.env`、`/etc/hosts`、`~/.ssh/id_rsa` gate 验收。 |
| 0.9 | 2026-09-24 | 根据评审 v8 补齐 `run_script` 的代码路径事实来源：从脚本 IR 提取路径字面量并复用统一分类；提取不完整时 fail-closed，阻止 clean 自动放行；纳入 P0 与验收。 |
| 1.0 | 2026-09-24 | 根据评审 v9 将脚本提取 fail-closed 落实为 `script-path-extraction-unknown-ask` locked 规则，明确其优先于 clean allow，并增加未知提取结果的 gate 验收。 |
| 1.1 | 2026-09-24 | 根据评审 v10：系统目录读改为 locked `confirm-every-time` 真人确认；定义脚本提取完备性与动态访问 unknown 契约；将执行许可改为带 requestId、摘要、目标 factId/zone 的绑定授权对象，并增加目标绑定验收。 |
| 1.2 | 2026-09-24 | 根据评审 v11：敏感读规则实际改为 locked `confirm-every-time`；明确 `PolicyDecision` 与确认结果共同提供 `approvedFactIds`；统一批准类型为 `auto-allow`、`user-confirmed`、`agent-approved`，并限制 locked 规则只能真人批准。 |
| 1.3 | 2026-09-24 | 根据评审 v12：候选目标保留稳定 `factId`/zone；automation 对敏感、系统和脚本未知路径改为 locked deny；明确 P2 专用通道排除于本方案单一入口完成声明。 |
| 1.4 | 2026-09-24 | 根据评审 v13：定义 auto-allow 无 confirmation 时的策略授权分支；由 `PolicyDecision.approvedFactIds` 生成 `decisionRuleId`；统一要求 locked deny/confirm 先于所有预检、快通道和 automation allow。 |
| 1.5 | 2026-09-24 | 根据评审 v14：补充 `approvedByFactId` 可执行映射算法；禁止混合敏感/系统与普通越界目标的调用级授权；明确 locked 规则先于策略缓存读取并绑定 factsDigest/规则版本。 |
| 1.6 | 2026-09-24 | 根据最小核心契约冻结实现基线：先只闭环 desktop `read_file` 单目标；统一以不可变 `InvocationFacts` 生成策略批准集合和绑定 permit；补齐缺失映射拒绝、目标粒度和旧规则/旧 ask 语义清理，shell、脚本、写快通道及多目标扩展后置。 |
| 1.7 | 2026-09-24 | 根据评审 v16 收敛唯一实施边界：裁剪 P0 与验收为单一 `read_file` 入口；补充契约到现有 facts/policy/confirmation/executor 类型映射；冻结事实阶段唯一路径分类与执行阶段仅做机制复验。 |
| 1.8 | 2026-09-24 | 根据评审 v17 修复本切片事实与执行契约：定义一次性 `probeReadPathFact` 返回规范化目标、类型、身份及错误类别；敏感匹配复用完整既有语义并先于 zone 分类；read executor 直接消费 permit 目标和身份快照，不再经 workDir/skills 白名单解析。 |
| 1.9 | 2026-09-24 | 根据评审 v18 固定四条 desktop `read_file` 最小规则；将 `homeDir/platform` 接入敏感匹配与内置前缀展开；定义确认登记状态机、失效条件和 permit 的一次性原子消费。 |
| 2.0 | 2026-09-24 | 根据范围路线修改意见重组交付边界：当前版本升级为 V1 文件读取组（`read_file`/`list_directory`/`grep`）；V2 写入、V3 shell/script、V4 automation/特殊 lane 仅保留进入条件与边界；V1 单独承担当前门禁。 |
| 2.1 | 2026-09-24 | 根据评审 v19 闭合 V1 读取组语义：确认改为全量 factId 批准；目录读取采用 gate 时直接子项快照；各工具专属执行器共享 permit 校验器。 |
| 2.2 | 2026-09-24 | 根据评审 v20 收敛 V1：移除 `list_directory`，避免策略前枚举目录；任何混合 zone 的多目标调用统一 deny、批准集合为空并要求拆分调用，确认只适用于同 zone 的全量目标。 |
| 2.3 | 2026-09-24 | 补充 v20 收敛细节：混合 zone 在策略引擎前直接 deny，不产生确认登记；将 sensitive+outside、system+outside、sensitive+system 与 workdir+outside 的结果逐项列入门禁。 |
| 2.4 | 2026-09-24 | 根据评审 v21 接通 V1 gate 专用装配，隔离旧读规则、cache 与无 permit 执行入口；将 grep 限制为显式普通文件，目录/通配/递归输入在 facts 阶段 fail-closed。 |
| 2.5 | 2026-09-24 | 根据评审 v22 将 V1 `grep` 收敛为单个显式普通文件；移除多路径 factId/permit 验收，目录/通配/多路径输入统一拒绝；同步更新 grep 工具描述。 |
| 2.6 | 2026-09-24 | 根据评审 v23 同步冻结真实 grep schema 与 executor：移除 `glob`，path 仅接受单个显式普通文件；执行器在 ripgrep 前拒绝目录目标，版本号与单路径表述统一。 |
