# 内置 SubAgent 机制产品需求说明书

> 版本：1.3
> 状态：待评审
> 日期：2026-08-09
> 需求类型：后台 Mission 内置执行后端
> 主要依据：
> - [Builtin-Agent 子进程详细设计](../../Users/builtin-agent-design.md)
> - [AgentRunHost 详细设计](../../Users/agent-run-host-design.md)
> - [Builtin Subagent 设计结论](../../Users/builtin-subagent-design-conclusions.md)
> - [后台任务执行层设计文档 v3](./background-task-execution-layer-design-v3.md)
> - [Background Mission Soft-Gate 简化方案](../develop/background-mission-soft-gate-simplification-plan.md)
> - [Builtin SubAgent 详细开发方案](../develop/builtin-subagent-development-plan.md)
>
> 本文是产品与系统行为层的需求基线。上述详细设计与本文冲突时，应先按本文确认产品语义，再更新技术设计。

---

## 1. 背景与问题

SpaceAssistant 的后台 Mission 需要一个可长期运行、可取消、可恢复、可审计且受宿主安全边界约束的自治执行 Agent。外部 Codex 具备较强的规划、工具使用和内部委派能力，但用户可能未安装、未登录、版本不满足要求，或当前环境不允许启动 Codex。

如果后台 Mission 只能依赖外部 Agent，则会出现以下问题：

- 用户已具备可用的 LLM 服务配置，却因未安装 Codex 无法使用后台任务；
- 不同后端分别实现生命周期、安全、持久化和结果导入，行为不一致且维护成本高；
- 将复杂任务预先编译成静态 DAG，会削弱自治 Agent 根据执行结果动态调整策略的能力；
- 在 Electron 主进程内直接运行推理循环，会增加主进程阻塞、资源泄漏和崩溃扩散风险；
- 若子进程自行持有 API Key 或直接执行工具，宿主难以统一实施授权、预算和路径控制。

因此，需要提供 SpaceAssistant 自带的 **Builtin SubAgent**：它是一个独立、薄、无密钥、不内置直接副作用执行器的推理子进程，通过私有 Builtin RPC 借用宿主 LLM 与工具能力。首个版本只作为 backgroundMission 的 Builtin backend；未来出现第二个真实调用方后，再基于实际差异提取通用 Runtime。

---

## 2. 产品定位

### 2.1 一句话定义

Builtin SubAgent 是 SpaceAssistant 随应用交付、由 backgroundMission 托管的内置自治执行后端；它在独立子进程中负责推理和行动决策，由宿主统一控制权限、工具执行、预算、取消和结果接收。

### 2.2 核心原则

1. **Agent 拥有认知控制权**：Agent 自主分析、规划、执行、观察、调整、验证和修订。
2. **宿主拥有执行控制权**：宿主决定能力是否可用、操作是否授权、资源是否充足、路径是否安全、运行是否应停止、结果是否可被接收。
3. **用户确认目标和边界**：用户确认 Mission 的目标、成功标准、约束、权限、预算与交付合同，不确认一张静态执行图。
4. **先交付真实纵向闭环**：MVP 由 `BuiltinBackend` 直接接入 AgentRunHost；只要求子进程推理内核不导入 Mission 数据模型，不预建通用 caller 或场景 adapter 体系。
5. **密钥不离开主进程**：Builtin 不读取、不接收、不持有任何 LLM API Key。
6. **副作用不在 Agent 内执行**：文件、终端及后续扩展工具均由宿主执行。
7. **正确性不依赖提示词**：提示词与计划用于增强自治质量，不作为路径安全、权限控制、取消或正式状态提交的唯一保障。
8. **信任边界如实表达**：Builtin 是受信任组件，具体威胁模型见 §11.1。

### 2.3 与交互 Agent 委派的关系

未来界面交互 Agent 仍可能复用 Builtin 子进程、推理循环和 Host RPC，但本期不定义 interactive caller、workspace 模式、result 映射或 fake adapter。第二个真实调用方排期后，应先验证其生命周期、权限和流式结果需求，再从 `BuiltinBackend` 提取真正共享的接口；不得为了未来复用而让首版后台链路承担未经验证的抽象。

---

## 3. 目标与非目标

### 3.1 产品目标

| ID | 目标 |
|---|---|
| G-01 | 用户无需安装外部 Codex，也能完成后台 Mission 的创建、自治执行、观察、取消、恢复和结果接收闭环 |
| G-02 | Builtin 与 Codex 复用同一 AgentRunHost、状态机、安全边界、事件持久化和结果导入链路 |
| G-03 | Builtin 子进程与 Electron 主进程故障隔离且不接收宿主密钥；产品实现不在其中提供文件、Shell、网络等副作用执行器，所有产品工具能力通过绑定当前 invocation 身份的 Host RPC 请求；Mission 场景再额外绑定 Run/generation |
| G-04 | 执行过程中持续保留 Mission 约束，受固定预算和最大轮次限制，并能在工具失败后调整策略 |
| G-05 | 所有工具副作用受现有路径安全、写冲突、确认、预算、取消与 generation fencing 机制约束 |
| G-06 | 运行过程对用户可见且可审计，异常状态有明确解释和恢复路径 |
| G-07 | 首发目标平台的应用可直接启动 Builtin，不依赖用户额外安装运行时或 CLI；其他平台按后续发布 Gate 扩展 |
| G-08 | Builtin 子进程推理内核不依赖 Mission/AgentRun/Candidate/Recovery 类型；宿主侧 `BuiltinBackend` 可以理解 AgentRun |
| G-09 | Builtin 不得扩大当前 Run 的工作区、工具、预算或用户授权；所有产品能力只由宿主签发的 Run-scoped capability grant 授予 |

### 3.2 非目标

| ID | 非目标 |
|---|---|
| NG-01 | 不恢复 WorkflowCompiler、Task DAG、Stage、ReadinessResolver、TaskInputBinding 或宿主语义失败传播 |
| NG-02 | MVP 不在 Builtin 内实现多 Agent 并行委派或递归 SubAgent |
| NG-03 | MVP0 不支持原地恢复；长任务恢复在后续阶段通过新 AgentRun 和 RecoveryContext 完成 |
| NG-04 | 不让 Builtin 直接调用 LLM 服务、读取宿主配置或获得 API Key |
| NG-05 | 产品协议和实现不为 Builtin 提供绕过 Host gateway 的文件系统、网络、Shell 或外部系统调用路径；不承诺在应用包篡改、供应链失陷或子进程任意代码执行后仍由该边界阻止本机访问 |
| NG-10 | 不扩大 §11.1 声明的子进程信任边界 |
| NG-06 | 不要求用户选择或理解具体后端差异；诊断界面可显示实际后端 |
| NG-07 | MVP 不建立 Mission 间依赖图；并行需求由 Intake 拆成独立 Mission |
| NG-08 | 私有 Builtin RPC 不宣称 ACP 兼容，也不为尚未确定的第三方 Agent 互操作预建协议面 |
| NG-09 | 不以 `plan.md`、`state.json` 或 Agent 文本声明作为正式完成、验证通过或授权扩大的证据 |
| NG-11 | MVP 不交付界面交互 Agent 的新入口、不替换既有 `dispatch_subagent`，也不要求 fake interactive adapter |

---

## 4. 用户与核心场景

### 4.1 目标用户

- 未安装或未配置 Codex，但已配置可用 LLM 服务的用户；
- 希望离开当前聊天后让复杂任务在后台持续执行的用户；
- 需要可取消、可恢复、可审计执行过程的开发者或知识工作者；
- 需要一致安全边界和交付验收的团队用户。

### 4.2 用户故事

| ID | 用户故事 |
|---|---|
| US-01 | 作为未安装 Codex 的用户，我希望确认 Mission 后系统自动开始执行，而不是要求我先安装外部工具 |
| US-02 | 作为用户，我希望看到当前目标、状态、近期进展、工具活动、资源消耗和实际后端 |
| US-03 | 作为用户，我希望高风险或超出既有授权的操作仍需我确认 |
| US-04 | 作为用户，我希望随时取消 Mission，并看到相关子进程和终端的停止或待清理状态 |
| US-05 | 作为用户，我希望 Agent 陷入重复失败时系统主动提醒或请求我决策，而不是持续消耗预算 |
| US-06 | 作为用户，我希望应用或 Agent 崩溃后能够基于已有工作成果恢复，而不是从零开始或续接未知进程 |
| US-07 | 作为用户，我希望最终收到经过确定性验证和可选独立 Review 的不可变交付结果 |

---

## 5. 总体概念与职责边界

### 5.1 核心对象

| 对象 | 定义 |
|---|---|
| Mission | 用户已确认的目标、成功标准、约束、授权、预算和交付合同 |
| AgentRun | 一次具体执行尝试；具有后端、generation、状态、预算与资源归属 |
| BuiltinBackend | AgentRunHost 的 Builtin 后端适配器，负责启动子进程、Builtin RPC、Host capability 转发、取消和 Run outcome 映射 |
| BuiltinRuntime | 子进程中的推理内核，不导入 Mission、AgentRun、Candidate 或 Recovery 类型 |
| AgentRunHost | backgroundMission 的权威托管组件，负责 Mission 状态、generation、预算、事件、恢复与收尾 |
| Builtin Agent | 独立子进程中的薄推理循环 |
| RunDetailDTO | 查询层按需从 AgentRun、事件、预算、Decision、workspace 和资源表组装的非权威界面模型 |
| ProgressNote | 面向用户的 best-effort 进展摘要，不作为正确性前提 |
| Candidate | AgentRun 结束后由宿主扫描、固化并验证的不可变候选结果 |
| RecoveryContext | 新一代 AgentRun 恢复时由宿主注入的目标、约束、已有成果和失败上下文 |

### 5.2 职责分配

| 决策或动作 | Agent | AgentRunHost / 宿主 | 用户 |
|---|---:|---:|---:|
| 分析目标、规划步骤、调整策略 | 主责 | 不理解语义计划 | 确认目标边界 |
| 选择要调用的已授权工具 | 主责 | 提供能力清单 | — |
| 路径安全和保留目录保护 | 请求参数不可信 | Host ToolGateway 主责、强制 | — |
| 执行文件与终端操作 | 请求 | 主责 | 按策略确认 |
| LLM 服务调用 | 请求 | 主责，持有密钥 | 配置服务 |
| 预算核算与超限终止 | 被约束 | 主责 | 确认预算 |
| 取消和进程回收 | 配合 | 主责、强制兜底 | 发起取消 |
| 判断正式交付物 | 提交意图 | 扫描、固化、验证、导入 | 接收或决策 |
| 运行恢复（GA） | 提供非权威执行摘要 | 创建新 Run 并注入上下文 | 必要时决策 |
| Review 裁定 | 可自验 | 启动独立 Review | 按策略参与 |

### 5.3 Builtin backend 与统一后端原则

“Builtin backend”由理解 AgentRun 的宿主适配层和不理解 Mission 语义的子进程推理内核组成。“统一后端”是指 backgroundMission 上层不按后端分叉 Mission 调度、状态机、取消恢复、持久化和交付流程；不要求在只有一个调用场景时提前建立通用 Invocation Host。

- `AgentRun.backend` 是可观测、诊断、兼容和安全注册所需的事实字段；
- 后端能力通过握手协商，不通过调度器硬编码推断；
- `_llm/chat` 是 Builtin 专属能力，只能在宿主亲自启动、完成握手且绑定当前 Run 身份的 Builtin transport 上注册；
- correlation 只用于观测，不参与授权；工具、工作区和预算权限只来自宿主签发的 `CapabilityGrant`；
- ResourcePulse 由宿主统一产生，后端只消费结构化资源事实；
- UI 主流程不要求用户预先选择后端，但运行详情应透明显示实际后端及回退原因。
- 子进程协议实验可以与 backgroundMission 并行；完整 Host、预算、恢复和 UI 合同必须由真实 AgentRun/backend 纵向闭环驱动，不用两个 fake 消费者共同推演。

---

## 6. 后端选择与准入

### 6.1 自动选择规则

本节自动选择规则属于 Long-running GA。MVP0 由 feature flag 或内部配置显式选择 Builtin，不自动从 Codex 回退；但 Builtin authorization 在任何阶段都不得接受 Codex authorization。

创建 AgentRun 时，宿主按以下顺序选择后端：

1. 若 Mission 或组织策略明确锁定某一后端，则按策略执行准入检查；
2. 否则优先使用具有有效 execution authorization 的首选外部 Agent；authorization 可以是与后端身份绑定的 `backend_trust` 或 Host/OS 证据支持的 `verified_admission`，两者语义不得互换；
3. 外部 Agent 未安装、未登录、版本不兼容、协议不可用、authorization 无效或策略选择回退时，重新评估并选择 `builtin`；
4. Builtin 仅在存在可用 LLM 服务配置、可解析模型、可满足最低预算且所需 Host gateway 可用时通过准入；Builtin 不要求自身 runtime sandbox profile；
5. 所有后端均不可用时，Mission 不进入 `running`，状态保持可恢复，并向用户展示可操作的阻塞原因。

### 6.2 回退行为

- 自动回退不扩大 Mission 的目标、授权和预算；若 backend identity、execution mode 或 assurance 变化触发宿主确认策略，则必须获得对应的新确认；
- 回退原因写入 AgentRun 启动事件和诊断日志；
- 不因后端变化扩大工具、网络、路径或外部系统授权；
- Codex 的 trust acknowledgement 或 verified admission profile 不得传递给 Builtin；Builtin 必须生成绑定自身 backend identity、Host capability snapshot 和权限策略版本的新 authorization；
- 外部 Agent 在运行中崩溃时，不允许在同一 AgentRun 内热切换 Builtin；
- 崩溃恢复必须结束旧 Run、增加 generation，并按当前准入规则创建新 Run；新 Run 可以选择不同后端。

### 6.3 Builtin 最低准入

- 内置子进程产物存在且校验通过；
- Builtin RPC 协议版本兼容；
- MVP 唯一目标 provider/profile 已启用且健康；
- 模型支持本需求所需的工具调用格式，或宿主适配层能够可靠转换；
- Mission 私有 worktree 可创建；
- 预算、路径和权限策略可初始化；
- Host ToolGateway 和 PermissionGateway 可用；仅当 capability grant 开启预定义验证命令时才要求对应命令执行端口，GA 开启通用 Shell 时才要求完整 HostTerminalService；
- 子进程启动环境不包含宿主密钥。

---

## 7. 生命周期需求

### 7.1 状态机

```text
queued → starting → running
                      ├→ waiting → running
                      │     └→ parking → parked → recovering → running
                      ├→ crashed → recovering → running
                      ├→ submitting → reviewing → completed
                      ├→ failed
                      └→ cancelling → cancelled
```

状态定义与后台任务执行层 v3 保持一致。Builtin 不新增一套平行状态机。

### 7.2 启动

| ID | 需求 |
|---|---|
| FR-LC-01 | 宿主必须先创建私有 worktree、运行输入和预算上下文，再启动子进程 |
| FR-LC-02 | 子进程必须通过 Node 子进程方式独立运行，stdin/stdout 专用于协议，stderr 专用于诊断 |
| FR-LC-03 | 宿主必须依次完成 `initialize`、`session/new`、`session/prompt`，任一步失败均不得进入 `running` |
| FR-LC-04 | `session/new` 必须传入实际 worktree、上下文窗口和允许的能力；不得传入 API Key |
| FR-LC-05 | 首次 `session/prompt` 必须包含 Mission 目标、成功标准、约束、交付合同、预算摘要和恢复上下文（若有） |
| FR-LC-06 | 只有握手成功且初始 prompt 已被接受后，AgentRun 才能进入 `running` |
| FR-LC-07 | 启动阶段必须设置超时；超时后关闭 transport、回收进程与终端资源并记录结构化错误 |

### 7.3 运行

| ID | 需求 |
|---|---|
| FR-LC-08 | 一个 AgentRun 只绑定一个 Agent 子进程和一个 Builtin RPC session |
| FR-LC-09 | Agent 可多轮请求 LLM 和工具，直至完成、取消、预算耗尽、等待决策或失败 |
| FR-LC-10 | Agent 的计划属于非权威运行信息，不创建宿主 Task DAG |
| FR-LC-11 | 宿主必须持续核算 token、工具调用、运行时长、终端数和输出量等预算 |
| FR-LC-12 | 用户决策等待期间应区分“短时 waiting”和“可释放资源的 parked” |
| FR-LC-13 | waiting 宽限期内收到用户答复时可在原 Run 继续；进入 parked 后只能通过新 Run 恢复 |

### 7.4 完成与提交

| ID | 需求 |
|---|---|
| FR-LC-14 | `_llm/chat` 的 `end_turn` 只表示单次模型调用结束，不是 Run 级结果；AgentRunHost 不得据此迁移 AgentRun 状态 |
| FR-LC-15 | Builtin 必须通过当前 `session/prompt` 的最终响应返回且仅返回一个有效 `BuiltinRunResult`；MVP0 只有 BuiltinBackend 映射并事务接受的 `submit_candidate` 才触发 `submitting` |
| FR-LC-16 | 宿主必须扫描私有 worktree，按交付合同生成 Candidate，并运行确定性验证 |
| FR-LC-17 | Candidate 必须绑定不可变 revision；不得直接引用仍可变化的 worktree 作为正式结果 |
| FR-LC-18 | 需要 Review 时进入 `reviewing`；仅在验收策略满足后进入 `completed` |
| FR-LC-19 | Agent 主动放弃、请求决策或报告失败时，必须返回对应的结构化 Run outcome；宿主按 §9.5 迁移状态，不得从 Agent 文本或模型 stop reason 推断 |

MVP0 的 Review policy 固定为“不要求 Review”：Candidate 的 required validators 全部通过后即可进入 `completed`。可选或强制 Review 属于 Long-running GA，Builtin 项目不为 MVP0 新增 Review 实现。

### 7.5 取消与 Drain

| ID | 需求 |
|---|---|
| FR-LC-20 | 用户取消后先原子失效当前 generation，再进入 `cancelling` |
| FR-LC-21 | 宿主向 Agent 发送 `session/cancel`，中止进行中的 LLM 请求，取消未决权限请求 |
| FR-LC-22 | 所有 pending / in-progress 工具调用必须收敛为终态，禁止永久悬挂 |
| FR-LC-23 | 宿主必须终止该 Run 创建的终端及其进程树；宽限期后强制终止 Agent 子进程 |
| FR-LC-24 | `cancelled` 仅在资源确认释放后生效，并分别记录 `finishedAt` 与 `resourcesReleasedAt` |
| FR-LC-25 | 取消后到达的旧 generation 事件、工具结果和提交必须被 fencing 拒绝 |

### 7.6 崩溃与恢复

| ID | 需求 |
|---|---|
| FR-LC-26 | 子进程异常退出、协议断开或宿主重启后，旧 Run 标记 `crashed` 并进入 drain |
| FR-LC-27 | 恢复必须封存 RecoveryBundle，直接包含当前 Mission 约束、AgentRun 事实、预算账本、worktree 成果、最近事件、未决 permission/Decision、stuck/失败事实和失败原因；不依赖 RunSnapshot |
| FR-LC-28 | Builtin 声明 `loadSession: false`，禁止假装原地续接内存上下文 |
| FR-LC-29 | 恢复通过新 generation、新 AgentRun、新子进程和新的 `session/new` 完成 |
| FR-LC-30 | 新 Run 的 prompt 必须明确区分可信 Mission 约束、宿主观测事实、旧 Agent 自述和未验证成果 |

---

## 8. Builtin 推理能力需求

### 8.1 基础推理循环

Builtin 必须实现以下最小闭环：

```text
接收 Mission prompt
  → 构造持久 Mission 约束与当前上下文
  → 请求宿主调用 LLM
  → 接收文本及工具调用
  → 请求宿主授权并执行工具
  → 将工具结果加入上下文
  → 继续推理或结构化结束
```

要求：

- 同一时刻只处理一个 `session/prompt`；
- 每次 LLM 响应中的工具调用按可预测顺序处理；MVP 默认串行；
- 工具失败必须作为结构化工具结果返回模型，不得吞错；
- LLM 无工具调用时可结束当前轮，但必须提供最终摘要和完成声明；
- 必须设置单 Run 最大推理轮次，达到上限时返回明确 stop reason；
- 取消信号应能打断 LLM、权限等待、终端等待和推理循环。

### 8.2 Mission 约束持久化

Builtin 必须从宿主输入中提取并放入不可被普通历史覆盖的 persistent system block：

- goal；
- success criteria；
- constraints；
- output contract；
- 授权和预算摘要；
- RecoveryContext 中仍然有效的硬约束。

这里的“提取”是读取宿主提供的结构化字段，不要求 Builtin 从自然语言中猜测或重新分类。`constraints` 只是自然语言 `string[]`，不定义 ID、category、scope 或 included/excluded scope。

规则只有四条：

1. Agent 在整个 Run 中必须遵守 constraints，可以调整策略，但不能删除、放宽或重新解释它们。
2. 路径、工具、Shell、网络、权限和预算等可强制边界由 `CapabilityGrant`、`WorkspaceCapability` 或宿主策略保证，不依赖 Agent 自觉。
3. 宿主能确定识别的冲突在 Mission 确认阶段拒绝；运行中发现自然语言语义冲突时，Agent 停止相关行动并请求决策。
4. 宿主强制策略优先于自然语言字段；计划、历史摘要和 Agent 自述不得覆盖 Mission 字段。

### 8.3 规划与复杂任务

- Agent 应先形成可调整计划，再开始复杂执行；
- 计划可通过 Builtin RPC 事件展示；
- `plan.md` 可作为 Agent 工作文件，但不是必需的宿主协议文件；
- Agent 可按复杂度决定在同一上下文连续执行，或按子任务重建干净上下文；
- MVP 不要求用“子任务数量大于 5”作为固定产品阈值，该阈值应为内部策略或可配置项；
- 子任务隔离只能约束 Agent 的注意力，实际写入边界仍由宿主的 Mission 授权强制保证；
- Builtin 不得在内部启动新的 Agent 子进程。

### 8.4 MVP0 上下文策略

MVP0 不引入磁盘工作记忆、专用运行目录、状态文件 schema 或 LLM 摘要压缩。Builtin 只维护：

- 不可被普通消息覆盖的 Mission persistent system block；
- 当前 Run 的有界最近消息和工具结果；
- 宿主提供的真实 token 用量与固定上下文上限。

达到安全上下文阈值且无法继续容纳下一轮时，Builtin 返回 `incomplete(reasonCode: 'CONTEXT_EXHAUSTED')`，保留已有 worktree 成果，不额外调用 LLM 生成摘要。结构化工作记忆和上下文压缩只有在取得真实长任务数据、确认收益后才进入 Long-running GA 设计。

### 8.5 分层失败处理

- 单次工具失败：将完整结构化错误返回 Agent，由 Agent调整参数或方法；
- 同类操作连续失败达到策略阈值：注入“更换策略”提示；
- 达到宿主僵局阈值：由宿主发出僵局警告；
- 警告后仍无改善：AgentRun 进入 `waiting` 请求用户决策；
- 预算不足或任务不可完成：Agent 输出已完成内容、未完成项、阻塞原因和建议，不得伪报成功。

---

## 9. Builtin RPC 协议需求

### 9.1 协议基线

- 使用 SpaceAssistant 私有、版本化的 JSON-RPC 2.0 over stdio 协议；不声明 ACP 兼容；
- 每行一个完整 JSON 对象，stdout 禁止输出协议外文本；
- 诊断输出只能写入 stderr，并进行敏感信息脱敏；
- 请求、响应和通知必须校验 schema、invocationId/sessionId/executionToken 绑定和大小限制；Mission adapter 在协议边界外额外校验 runId/generation；
- 未知方法返回 JSON-RPC `method not found`，无效参数返回 `invalid params`；
- pending RPC 在 transport 关闭、取消或超时后必须全部 reject 并释放。

### 9.2 必需流程

1. `initialize`：协议版本与能力协商；
2. `session/new`：创建当前 Run 的 Builtin 会话并传入所需上下文；
3. `session/prompt`：提交结构化 Mission 输入并等待单一结果；
4. `session/update`：传输文本、计划、工具状态与用量；
5. `session/cancel`：请求停止当前会话。

### 9.3 宿主提供的能力

| Builtin RPC 方法 | 可用后端 | 说明 |
|---|---|---|
| `session/request_permission` | 通用 | 将工具授权请求交给宿主策略和用户 |
| `fs/read_text_file` | 通用 | 在 `WorkspaceCapability` 授权根和读取范围内读取文本 |
| `fs/write_text_file` | 通用 | 在 `WorkspaceCapability` 授权根和写入范围内写入文本 |
| `terminal/create` | GA；MVP0 仅可选预定义验证命令 | PermissionGateway 裁决后由 HostTerminalService 执行；Builtin 不直接 spawn |
| `terminal/output` | GA；MVP0 仅配合预定义验证命令 | 分页或流式读取 Host 终端输出与退出状态 |
| `terminal/kill` | GA；MVP0 仅配合预定义验证命令 | 由 HostTerminalService 终止终端及可识别进程树 |
| `_llm/chat` | 仅 Builtin | 由宿主使用已配置服务完成模型调用 |

### 9.4 `_llm/chat` 统一语义

详细设计中“最终 message 是否位于 RPC 响应”存在不一致，本需求统一为：

- 文本增量通过 `session/update.agent_message_chunk` 推送，供 UI 和事件流消费；
- `_llm/chat` RPC 最终响应必须包含规范化后的完整 assistant message、stopReason 和 usage；
- Builtin 只使用 RPC 最终响应更新内部对话历史，避免从 UI 事件反向拼装上下文；
- 规范化契约只用于 Builtin 子进程与宿主通信；MVP0 的 BuiltinBackend 直接调用唯一目标 provider/profile，不要求 LlmProxy、ProviderAdapter、provider registry 或 factory；宿主不向 Builtin 暴露服务商密钥或专有鉴权；
- 第二个 provider 真正接入时，再从两个具体实现中提取公共接口；
- 模型选择必须来自宿主批准的运行配置，Builtin 请求中的 model 只能是建议值，宿主拥有最终裁决权。

建议契约：

```ts
interface LlmChatRequest {
  sessionId: string
  messages: NormalizedMessage[]
  system?: string
  tools?: NormalizedTool[]
  modelHint?: string
  maxOutputTokens?: number
  thinkingBudget?: number
}

interface LlmChatResponse {
  message: NormalizedAssistantMessage
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'cancelled'
  usage: {
    inputTokens: number
    outputTokens: number
  }
}
```

### 9.5 Builtin result 与 Run 级结构化结束协议

#### 9.5.1 协议定位

`_llm/chat.stopReason` 只描述一次模型调用为何停止；`BuiltinRunResult` 描述子进程如何收敛；`BuiltinRunOutcome` 是宿主为 AgentRun 接受的场景结果。三者不得混用。

Builtin 必须将且仅将一个 `BuiltinRunResult` 作为 `session/prompt` JSON-RPC 请求的最终响应返回；不得再通过普通文本、`session/update` 或工具结果提交第二套终态。MVP0 的唯一权威 schema 为：

```ts
type BuiltinRunResult =
  | { kind: 'submit'; summary: string }
  | { kind: 'failed'; reasonCode: string; summary: string }
```

`BuiltinBackend` 将 `submit` 确定性映射为 `submit_candidate`，将 `failed` 映射为失败 outcome，再交给 AgentRunHost 事务接受。MVP0 不在 result 中声明 artifact 路径；正式交付物始终由宿主根据 output contract 扫描 worktree。Long-running GA 若需要 partial、needs-input 或 recovery result，必须基于真实需求升级协议版本和 schema，不得把未启用类型预埋进 MVP0 联合类型。

映射后的 Run outcome 使用以下 backgroundMission 场景信封；该信封不是通用协议类型：

```ts
interface BuiltinRunOutcomeEnvelope {
  protocolVersion: 1
  source: 'builtin' | 'host'
  missionId: string
  runId: string
  generation: number
  sessionId: string
  executionToken: string
  outcomeId: string
  outcome: BuiltinRunOutcome
}

type BuiltinRunOutcome =
  | {
      kind: 'submit_candidate'
      summary: string
      claimedDeliverableKeys: string[]
    }
  | {
      kind: 'failed'
      errorCode: string
      summary: string
    }
```

字段规则：

- `executionToken` 由 AgentRunHost 在启动当前 prompt 前生成，是不可预测、单次使用的 opaque token，并随可信宿主输入传给 Builtin；
- `source: 'builtin'` 由 BuiltinBackend 在成功校验 transport 和 result 后生成，不从子进程接受该字段；`source: 'host'` 只允许 AgentRunHost 在取消、硬预算耗尽等宿主优先事件中内部生成；
- `outcomeId` 由 BuiltinBackend 根据 result identity 生成，用于日志、重放和幂等识别；
- `missionId`、`runId`、`generation`、`sessionId` 和 `executionToken` 必须全部与当前执行上下文完全一致；
- `claimedDeliverableKeys` 只能引用 `outputContract.deliverables` 中已声明的 key；它是扫描提示，不是交付物存在或有效的证据；
- `summary` 是 Agent 自述，不得替代 Candidate 扫描或验证记录；
- `reasonCode`、`errorCode` 必须来自宿主下发的稳定枚举或使用受控的 `AGENT_*` 扩展前缀；

#### 9.5.2 Outcome 与状态迁移

| Outcome | AgentRunHost 行为 | AgentRun / Mission 迁移 |
|---|---|---|
| `submit_candidate` | 停止新工具调用，扫描并固化 Candidate，执行 required validators | `running → submitting → completed/failed` |
| `failed` | 不生成 Candidate，记录错误摘要 | `running → failed` |

补充规则：

- `submit_candidate` 只是“请求宿主接收候选”，不表示成功标准已满足；
- Candidate 扫描为空、required deliverable 缺失或验证失败时进入 `failed`，不回写或篡改原 outcome；
- 其他 outcome 不属于 MVP0；GA 立项时再根据真实需求定义 result、outcome、字段和迁移。

#### 9.5.3 校验、幂等与异常收敛

BuiltinBackend 先校验 JSON-RPC request ID、result schema、Run/generation/session/executionToken 与 capability identity。完成确定性映射后，AgentRunHost 接收 outcome 时必须依次校验：

1. JSON-RPC 响应对应当前未决 `session/prompt` request ID；
2. schema 和 `protocolVersion` 有效；
3. Mission、Run、generation、session 全部匹配；
4. `executionToken` 有效且未消费；
5. 当前 generation 仍有效且 Run 仍允许接受 outcome；
6. `submit_candidate` 校验 deliverable key，`failed` 校验错误码和字段大小。

校验通过后，宿主在当前 `agent_runs` 行上执行一次 compare-and-set：匹配 Run、generation、execution token hash 和可接受状态，并要求 outcome 字段仍为空；同一事务写入 outcome 和新状态：

- 完全相同的重放只返回已接受结果，不重复扫描、创建 Decision 或迁移状态；
- outcome 已存在时，完全相同的重放返回原结果；不同内容、`outcomeId` 或 kind 记为协议冲突并拒绝；
- outcome 缺失、schema 无效、身份不匹配或 transport 在响应前断开，MVP0 按 `BUILTIN_RUN_RESULT_INVALID` 或 `AGENT_PROCESS_CRASHED` 收敛为失败；GA 才接入 RecoveryBundle；
- 当前 Run 已进入 cancelling、cancelled、crashed 或其他终态后到达的 outcome 一律视为迟到结果，不产生正式副作用；
- `session/update` 中出现任何声称完成、等待或失败的文本，只作为事件记录，不触发状态迁移。

#### 9.5.4 并发与优先级

终态竞争采用宿主事务和 generation fencing 裁决，优先级如下：

1. generation 已失效或用户取消已提交：取消获胜，outcome 被拒绝；
2. 宿主已确认硬预算耗尽：宿主停止新执行，并以 `source: 'host'` 生成 `incomplete(reasonCode: 'RUN_BUDGET_EXCEEDED')` 的受控收尾记录；Agent 后续 outcome 不得覆盖；
3. 已成功事务化接受的有效 outcome：该 outcome 获胜，后续 transport 断开只影响资源回收，不改写结果；
4. outcome 尚未被接受时 transport 断开或子进程退出：按崩溃处理；
5. 同时到达的多个候选 outcome：只有首次通过比较交换者可被接受，其余按冲突或重放规则处理。

权限拒绝、单次工具失败和单次 LLM `max_tokens` 本身不是 Run 终态；Builtin 应继续调整策略，或最终返回合适的 Run outcome。

### 9.6 事件类型

MVP0 只支持：

- `agent_message_chunk`：面向用户的 Agent 文本增量；
- `plan`：非权威计划及步骤状态；
- `tool_call`：工具调用创建；
- `tool_call_update`：pending、waiting_permission、in_progress、completed、failed、rejected、cancelled；
- `usage_update`：累计 token、工具次数和运行时间；

同一 `toolCallId` 必须有且只有一个创建事件，并最终收敛到一个终态。

`resource_pulse` 和 `stuck_warning` 随对应 GA 能力引入，不预注册为 MVP0 事件。协议错误直接写脱敏日志和 AgentRun 最小错误字段，不建立独立 `diagnostic` 事件类型。

---

## 10. 工具执行与权限

### 10.1 权限责任收口

详细设计中 Builtin 内部 `shouldRequestPermission()` 与宿主 PermissionHandler 存在重复判定。本需求统一为：

> **Agent 描述意图，宿主判定风险与授权。**

- Builtin 不得自行决定某操作“无需确认”；
- Builtin 先发送 tool call，再向对应宿主工具方法发起执行请求；
- AgentRunHost 根据工具类型、参数、Mission 授权、交互模式、信任规则和风险策略决定自动放行、请求确认或拒绝；
- `session/request_permission` 可作为协议表现形式，但是否需要调用由宿主工具网关决定，不能依赖 Agent 自报；
- 未知工具、未知参数和无法判断风险的操作默认拒绝或要求确认。

### 10.2 工具最小集

MVP 至少提供以下模型层工具，并由 Builtin 映射到宿主能力：

| 模型工具 | 宿主实现 | 默认风险 |
|---|---|---|
| `read_file` | `fs/read_text_file` | 低 |
| `write_file` | `fs/write_text_file` | 中 |
| `edit_file` | 原子编辑能力；无原子能力时受版本检查的 read + write | 中 |
| `grep` | 宿主搜索能力，禁止通过字符串拼接 Shell | 低 |
| `list_directory` | 宿主目录读取能力 | 低 |
| `run_shell` | MVP 必须实现的 Host `terminal/create/output/kill` | 按命令、Mission scope 和平台策略动态判定 |

要求：

- `grep`、目录读取应优先使用宿主原生实现；不得依赖系统一定安装 `grep` 或 `ls`；
- `edit_file` 必须检测读取版本或内容摘要，避免 read-modify-write 覆盖并发变更；
- Shell 必须使用结构化 command + args，禁止将未验证输入拼成宿主 Shell 字符串；
- 终端输出必须支持截断、分页和最大字节预算；
- 工具 schema 由宿主能力协商结果生成，禁止向模型声明实际不可用的工具。
- 通用 `run_shell` 属于 Long-running GA。MVP0 可关闭 Shell，或只暴露宿主预定义的验证命令；文件型 Mission 不因 HostTerminalService 缺失而拒绝准入。

### 10.3 用户确认

- 复用现有确认卡片、信任规则和工具调用状态机；
- 卡片显示来源为后台 Mission，并展示 Mission、Run、后端、工具、目标路径或命令及风险；
- 允许一次、拒绝一次、信任或永久拒绝等选项必须服从现有安全策略；
- 自动模式仅在 Mission 已授权范围内生效，高危或越界操作仍需确认或直接拒绝；
- 用户拒绝应作为可观察结果返回 Agent，允许其调整策略；
- 确认超时按拒绝处理，并可按策略将 Run 转入 waiting 或 parked。

### 10.4 用户问询

当 Agent 缺少会实质改变目标、交付或授权的信息时，应通过结构化 Decision 请求用户，而非在普通文本中无限等待。

- 请求包含问题、原因、可选项、是否允许自由输入和超时策略；
- UI 显示 Mission 决策卡片；
- 等待期间暂停无活动超时，但继续计算是否需要 park；
- 回复必须绑定 runId、generation 和 decisionId；
- 旧 generation 的回复不得恢复已失效 Run；
- 普通执行策略问题优先由 Agent 自主解决，不应频繁打扰用户。

---

## 11. 安全需求

### 11.1 子进程信任边界与密钥隔离

Builtin 是 SpaceAssistant 的受信任应用组件，不作为恶意代码隔离边界。MVP 不要求 Host/OS 强制 runtime sandbox；“无直接工具”由依赖边界、无密钥环境、Host RPC capability、代码审查和测试保证。若应用包被篡改、依赖供应链失陷或子进程发生任意代码执行，本需求不承诺依靠该进程边界阻止本机文件或网络访问。

| ID | 需求 |
|---|---|
| SEC-01 | Builtin 子进程环境必须使用 allowlist 构造，不继承 LLM API Key、会话令牌、数据库凭据或外部集成密钥 |
| SEC-02 | `_llm/chat` 只注册到宿主亲自 spawn 且握手标识为 Builtin 的 transport |
| SEC-03 | 每次 `_llm/chat` 必须校验预期 PID、进程存活、session/run/generation、预算和取消状态 |
| SEC-04 | `_llm/chat` 不是网络监听服务，不得绑定 TCP/Unix 公共 socket |
| SEC-05 | stderr、事件、错误和持久化内容不得包含密钥或完整敏感环境变量 |
| SEC-06 | `electron/subagent/builtin/` 不得依赖项目文件执行器、数据库、Electron IPC、凭据模块、Shell runner 或网络客户端；产品工具请求只能经注册的 Host RPC method 发出 |
| SEC-07 | lifecycle containment 只管理进程归属、取消和回收，不得被解释为文件、网络或工具权限边界 |

### 11.2 Host 路径安全

- 所有 Builtin 文件请求均由 Host ToolGateway 将路径相对 worktree 解析，再做真实路径和符号链接逃逸检查；
- 拒绝绝对路径逃逸、`..` 逃逸、符号链接逃逸和大小写/盘符绕过；
- MVP0 在实际文件操作前执行一次统一校验，不要求额外的 handle-relative 抗 TOCTOU 层；当前威胁模型不承诺抵御本机恶意进程并发替换路径；
- 拒绝写入 revision store、staging root、应用配置、数据库、凭据和宿主协议保留区；
- Mission 授权范围小于 worktree 时，还必须执行更窄的 allowlist；
- 路径 lease 与写冲突检测必须覆盖 Builtin 写入；
- 路径校验失败不得向 Agent 泄露边界外文件内容。

### 11.3 Host 终端安全

- Builtin 不直接执行 Shell；所有 `terminal/*` 请求由 PermissionGateway 和 HostTerminalService 处理；
- cwd 必须符合 Mission authorization 和宿主当前平台策略；
- 不注入敏感环境变量；
- 按现有 Shell 安全策略进行命令解析、风险评估、确认和阻断；
- 子进程及孙进程必须归属于当前 AgentRun 的可回收进程树；
- 限制并发终端数、单命令时长、输出大小和总运行时；
- 网络访问服从 Mission 授权与应用网络策略，不因 Builtin 自动获得网络权限；
- 正常取消、超时、应用退出和 Run 结束时必须回收当前可识别的终端进程树；macOS 不使用 Endpoint Security 或 ES Helper，App 异常崩溃后的逃逸后代重识别和释放只作 best-effort，无法确认释放时必须进入 `release_pending` / `recovery_required`。

### 11.4 Generation fencing

所有可能改变正式宿主状态的动作必须携带并校验 Mission ID、Run ID 和 generation，包括：

- 工具授权结果；
- Decision 回复；
- AgentRun 正式状态变更；
- Candidate 提交与导入；
- Review 提交；
- Deliverable 发布；
- 外部系统副作用。

私有 worktree 内已经发生的文件写入不能由 fencing 回滚，因此必须依靠进程隔离、worktree 隔离和最终导入闸门共同保护正式状态。

---

## 12. ResourcePulse、僵局与预算

### 12.1 责任归属

ResourcePulse 和 Stuck Detection 由 AgentRunHost 实现并对后端统一可用。ResourcePulse 只传递宿主可确认的资源事实；Stuck Detection 只使用宿主可观察信号。Builtin 内部计数仅用于调整推理策略，不替代宿主预算或状态升级。

### 12.2 ResourcePulse

默认触发条件：

- token 消耗达到预算的 25%、50%、75%；
- 工具调用数达到预算的 25%、50%、75%；
- 运行时间达到预算的 30%、60%、90%；
- 距上次 pulse 超过 30 分钟。

规则：

- 同一阈值每个 Run 只触发一次；
- pulse 包含触发原因、elapsed/remaining time、token 和工具调用次数，可附带最近结构化工具错误；
- pulse 作为系统控制消息进入 Agent 上下文，同时写独立事件供 UI 展示；
- pulse 不调用 LLM、不要求 Agent 总结或回复、不创建恢复点；
- success criteria 在执行期间的宿主状态始终为 unknown；pulse 不包含完成度、交付缺口或验收判断；
- success criteria 仍作为 persistent context 存在，但只有提交后的 Validator/Review 可产生权威 passed/failed/blocked 结果。

### 12.3 僵局检测

默认信号：

| 信号 | 默认阈值 |
|---|---:|
| 连续工具失败 | 5 次 |
| 同一路径反复编辑 | 8 次 |
| 相同 3 工具序列重复 | 3 轮 |
| 警告后仍触发僵局 | 5 分钟内再次满足任一条件 |

行为：

1. 首次满足条件：记录结构化原因并注入僵局警告；
2. 出现新的工具成功、结构化输出、文件 hash 变化或其他宿主可观察结果后，重置相应检测窗口；
3. 警告后仍无改善：进入 waiting 并请求用户决策；具体 Decision schema 在 GA 立项时定义；
4. 达到 park 条件时释放资源并进入 parked；
5. 阈值应支持应用级配置，但 MVP 可只提供默认值而不开放 UI。

### 12.4 预算超限

- MVP0 预算账本只核算 token 消耗（input + output）、工具调用次数和 wall-clock runtime；
- LLM 调用次数只作诊断，不是独立预算；终端并发/高水位、输出字节和压缩次数不进入 MVP0 账本；
- 预算由宿主权威核算，Agent 自报用量仅用于交叉校验；
- 达到软阈值时发送 ResourcePulse；
- 达到硬阈值时拒绝新的 LLM/工具请求并启动受控收尾；
- 应为 Agent 保留有限的结构化收尾额度，用于总结部分成果和阻塞原因；
- 收尾额度不得用于继续执行高成本工具；
- 超限结果应区分 token、时间或工具次数。

---

## 13. 数据、事件与持久化

### 13.1 AgentRun 扩展

```ts
type AgentBackend = 'builtin' | 'codex'

interface AgentRunBuiltinOptions {
  resourcePulseEnabled: boolean
  stuckDetectionEnabled: boolean
  contextCompressionRatio: number
  maxInferenceTurns: number
}

interface AgentRun {
  // 复用 v3 既有字段
  backend: AgentBackend
  backendSelectionReason?: string
  backendCapabilities?: Record<string, unknown>
  builtinOptions?: AgentRunBuiltinOptions
}
```

`builtinOptions` 仅在 backend 为 Builtin 时生效；通用调度不得依赖这些字段决定 Mission 语义。

MVP0 不建立独立 execution-token 或 outcome 表。一个 AgentRun 只有一个 session、一个 token 和最多一个 outcome；token hash 与可空 outcome 字段直接存入 `agent_runs`，通过 `outcome IS NULL` 的 compare-and-set 保证只接受一次。GA 若允许同一 Run 多次 prompt/waiting/resume，再迁移为一对多子表。

### 13.2 RunDetailDTO 查询聚合

MVP 不定义持久化的权威 `RunSnapshot`，不建立 `run_snapshots` 表，也不要求 `SnapshotProjector`。Mission 详情由查询层按需组装 `RunDetailDTO`：

```ts
interface RunDetailDTO {
  run: AgentRun
  recentEvents: RunEvent[]
  usage: RunUsage
  pendingPermissions: PermissionRequest[]
  pendingDecisions: MissionDecision[]
  workspaceSummary?: WorkspaceSummary
  latestProgressNote?: ProgressNote
  resources: RunResourceStatus
}
```

字段必须直接来自权威数据源：状态/backend/generation 来自 `agent_runs`，最近活动来自带游标的事件查询，用量来自预算账本，未决交互来自 permission/Decision 表，变更来自 workspace scan/diff，资源状态来自 containment 和资源表。

`RunDetailDTO` 不持久化、不作为审计或恢复事实、不驱动取消或状态迁移。实测出现查询性能问题时可增加短时内存缓存或可丢弃、可重建的查询缓存，但不得将缓存升级为权威数据源。增量事件游标可保存在客户端订阅上下文或明确的 `lastEventId` 字段，不因此引入完整 snapshot 对象。

### 13.3 ProgressNote

- 可来自 Agent 原生进展输出或事件摘要器；
- 必须标记来源、生成时间和覆盖事件范围；
- 缺失、延迟或错误不得阻止 Run 推进；
- 不应持久化模型隐藏思考链；
- UI 应将其表述为“进展摘要”，不得表述为验证结论。

### 13.4 日志与隐私

- 记录启动、握手、状态迁移、工具摘要、权限、预算、取消、资源回收和错误；
- 默认不记录完整 prompt、完整文件内容、完整终端输出或隐藏思考；
- 对用户可见日志与诊断日志分层；
- 日志关联 Mission ID、Run ID、generation、sessionId 和后端；
- 敏感字段统一脱敏；
- 持久化策略沿用项目既有保留期与导出规则。

---

## 14. 用户界面与交互

### 14.1 Mission 创建

- Mission 预览继续展示目标、成功标准、权限、预算和交付合同；
- 不要求用户理解 Builtin RPC；
- 若所有后端均不可用，确认前应显示阻塞原因；
- 若只能使用 Builtin，可提示“将使用内置执行引擎”，但不制造能力贬损暗示。

### 14.2 Mission 列表

每项至少显示：

- Mission 标题；
- 当前状态；
- 进度摘要；
- 运行时长和预算占用；
- waiting / 权限 / 用户决策提醒；
- 完成、失败、取消或恢复状态。

后端标识可作为次要诊断信息，不应成为主状态。

### 14.3 Mission 详情

至少包含：

- 目标、成功标准和授权边界；
- 实际后端及选择/回退原因；
- 当前计划摘要和近期 ProgressNote；
- 工具调用时间线及终态；
- token、工具次数、时长和预算；
- resource pulse、僵局警告与用户 Decision；
- worktree 变更和 Candidate / Review 状态；
- 取消操作；
- 失败时的错误、已保留成果和恢复入口。

### 14.4 权限与 Decision

- 有待确认操作时明显提示并聚焦到对应卡片；
- 卡片显示该操作来自后台 Mission，而非当前聊天主 Agent；
- 用户离开详情页后，应用仍应通过全局通知提示；
- 历史事件只读，不允许对旧 generation 的卡片再次作答；
- parked 后用户作答触发“创建恢复 Run”，不得把旧卡片表现为原地继续。

### 14.5 i18n 与可访问性

- 所有新增文案使用 i18n key，禁止硬编码；
- 状态不得只用颜色区分；
- 工具、预算和警告时间线支持键盘访问；
- 屏幕阅读器能读出 Mission、风险、待确认动作和按钮结果；
- 错误文案包含用户可执行的恢复建议。

---

## 15. 打包与跨平台

| ID | 需求 |
|---|---|
| FR-PKG-01 | Builtin 编译产物随应用发布，不要求用户安装 Node、Codex 或其他 CLI |
| FR-PKG-02 | 打包产物必须可由 Electron 主进程定位并执行；若位于 asar，必须使用 `asarUnpack` 或等效机制 |
| FR-PKG-03 | 开发与打包环境使用统一的路径解析接口，不允许业务代码散落判断路径 |
| FR-PKG-04 | Windows 启动不弹控制台窗口，并能终止完整进程树 |
| FR-PKG-05 | macOS/Linux 使用进程组或等效机制回收孙进程 |
| FR-PKG-06 | 构建校验必须验证 Builtin 入口存在、可启动并能完成最小握手 |
| FR-PKG-07 | Builtin 代码不得 import Electron 渲染模块或依赖主进程全局状态 |

---

## 16. 异常与错误规范

至少定义以下稳定错误码：

| 错误码 | 场景 | 用户行为 |
|---|---|---|
| `BUILTIN_ARTIFACT_MISSING` | 内置产物缺失或损坏 | 重新安装/修复应用 |
| `BUILTIN_RPC_VERSION_MISMATCH` | 协议版本不兼容 | 更新应用 |
| `BUILTIN_RPC_HANDSHAKE_TIMEOUT` | 握手超时 | 重试并查看诊断 |
| `LLM_PROFILE_UNAVAILABLE` | 无可用 LLM 服务或模型 | 前往模型设置 |
| `LLM_PROXY_TIMEOUT` | 模型调用超时 | 自动有限重试或恢复 |
| `RUN_BUDGET_EXCEEDED` | 达到硬预算 | 查看部分成果并调整预算重试 |
| `WORKTREE_CREATE_FAILED` | 私有工作树创建失败 | 检查仓库和磁盘 |
| `PATH_OUT_OF_SCOPE` | 工具路径越界 | Agent 调整方案或用户修改授权 |
| `TOOL_PERMISSION_REJECTED` | 用户或策略拒绝 | Agent 调整方案 |
| `TERMINAL_PROCESS_FAILED` | 命令启动或运行失败 | 查看脱敏 stderr |
| `AGENT_PROCESS_CRASHED` | Builtin 子进程异常退出 | 创建恢复 Run |
| `BUILTIN_RUN_RESULT_INVALID` | Run result 缺失、格式错误、身份不匹配或发生协议冲突 | 拒绝结果并安全结束当前 Run |
| `AGENT_STUCK` | 僵局升级 | 用户提供决策或结束 |
| `RUN_CANCELLED` | 用户取消 | 查看已保留但未导入成果 |

错误必须包含：

- 稳定错误码；
- 面向用户的本地化摘要；
- 脱敏技术原因；
- Mission/Run/generation 关联；
- 是否可重试；
- 推荐下一步；
- 已创建资源是否清理完成。

---

## 17. 验收标准

验收分两级：MVP0 只要求 §19 权威范围表及各小节中明确标注的 MVP0 条目；GA 候选项不得反向成为 MVP0 开工或完成条件。

### 17.1 后端选择（自动回退为 GA）

- [ ] MVP0 由 feature flag 或内部配置显式选择 Builtin，不自动从 Codex 回退
- [ ] Builtin authorization 拒绝 Codex trust acknowledgement、authorization 和 admission profile
- [ ] [GA] 未安装或未通过 Codex 准入时，已配置 LLM 的用户可自动使用 Builtin 启动 Mission
- [ ] [GA] 自动回退不扩大权限或预算，并在详情中显示原因
- [ ] Builtin 不可用时 Mission 不进入假运行态，用户能看到可操作阻塞原因
- [ ] 运行中的外部 Agent 失败不会在同一 Run 内静默切换后端

### 17.2 进程与协议

- [ ] Builtin 在独立子进程运行，故障不导致 Electron 主进程退出
- [ ] 完成 `initialize → session/new → session/prompt` 全链路
- [ ] stdout 中的协议外文本不会污染 RPC；诊断写入 stderr
- [ ] malformed JSON、未知方法、重复 ID、超大消息和连接中断均能安全收敛
- [ ] transport 关闭后无 pending Promise、监听器或句柄泄漏
- [ ] `_llm/chat` 最终响应包含完整规范化 message、stopReason 和 usage
- [ ] 每个 `session/prompt` 最终响应包含且仅包含一个符合 schema 的 `BuiltinRunResult`
- [ ] 模型级 `end_turn`、`max_tokens` 或 `refusal` 不会直接触发 AgentRun 状态迁移
- [ ] Builtin result 的 Run/generation/session/execution token 被严格校验
- [ ] 相同 outcome 重放保持幂等，冲突 outcome、迟到 outcome 和 token 复用被拒绝

### 17.3 LLM 与密钥

- [ ] Builtin 进程环境和输入中不存在 API Key
- [ ] `_llm/chat` 仅对预期 Builtin 进程开放
- [ ] 非 Builtin 后端调用 `_llm/chat` 被拒绝并记录安全事件
- [ ] MVP 唯一目标 provider/profile 的请求、完整响应、流式增量、工具调用和 usage 均能可靠转换为规范化语义
- [ ] 流式文本可实时展示，内部历史使用最终规范化消息，无重复拼接
- [ ] 依赖检查确认 Builtin 未导入项目文件执行器、数据库、Electron IPC、凭据模块、Shell runner 或网络客户端
- [ ] 文档和 UI 不把 Builtin 描述为 Host/OS 强制沙箱

### 17.4 工具与权限

- [ ] 读、写、编辑、搜索和目录列表的 Host 工具闭环可运行
- [ ] MVP0 未启用 Shell 时文件型 Mission 可正常运行；若启用预定义验证命令，其执行与取消均经过 PermissionGateway/HostTerminalService
- [ ] Agent 不自判授权；所有操作均经过宿主工具网关
- [ ] 路径越界、符号链接逃逸、保留目录写入均被拒绝
- [ ] `edit_file` 能识别并发内容变化，避免静默覆盖
- [ ] 高风险 Shell 与未授权写入触发现有确认卡片
- [ ] 用户拒绝、确认超时和策略阻断能作为结构化结果返回 Agent
- [ ] 终端输出受大小限制，正常取消后当前可识别进程树被回收；macOS 异常恢复不伪造强释放证明

### 17.5 MVP0 推理质量保障

- [ ] Mission 硬约束位于 persistent system block，不会被普通历史覆盖
- [ ] constraints 在协议和持久化中只是自然语言列表，不需要 ID、category、includedScope 或 excludedScope
- [ ] 路径、工具、Shell、网络、权限和预算安全测试只依赖 `CapabilityGrant`、`WorkspaceCapability` 和宿主策略，不从 constraints 推导放行
- [ ] 宿主无法确定判定的约束冲突在 MVP0 中以 `CONSTRAINT_CONFLICT` 失败，Agent 不自行放宽解释
- [ ] 上下文达到安全上限时返回 `CONTEXT_EXHAUSTED`，不启动摘要压缩或写入磁盘工作记忆
- [ ] 连续失败时 Agent 收到调整策略提示
- [ ] 达到最大推理轮次时明确结束，不无限循环
- [ ] Agent 无法完成时输出部分成果与阻塞原因，不伪报成功

### 17.6 ResourcePulse、僵局与预算（GA）

- [ ] token、工具和时间阈值按规则各触发一次 ResourcePulse
- [ ] pulse 同时进入 Agent 上下文和运行事件流，且只包含宿主可确认的资源事实
- [ ] pulse 不调用 LLM、不要求 Agent 总结，不记录 success criteria 完成状态或交付缺口
- [ ] 连续失败、重复编辑、重复工具序列均有测试覆盖
- [ ] 僵局警告后无改善时进入 waiting，并创建结构化 Decision
- [ ] 硬预算超限后拒绝新执行，只允许有限收尾
- [ ] 宿主用量为权威值，不能由 Agent 自报覆盖

### 17.7 取消与恢复（MVP0 只验收取消）

- [ ] LLM 请求、权限等待、工具执行和普通推理期间均可取消
- [ ] 取消后所有工具调用进入终态，Agent、终端和孙进程无泄漏
- [ ] 旧 generation 的迟到事件、Decision 回复和 Candidate 提交被拒绝
- [ ] outcome 与取消并发时取消优先；硬预算已生效时 Agent outcome 不能覆盖宿主收尾结果
- [ ] 有效 outcome 已事务化接受后发生 transport 断开，不会把已接受结果错误改写为 crashed
- [ ] Builtin 崩溃后生成 RecoveryBundle，并通过新 Run 恢复
- [ ] 恢复不依赖 `session/load`，并保留已有 worktree 成果
- [ ] 恢复 prompt 能区分宿主事实与旧 Agent 自述

### 17.8 结果与界面（MVP0 只验收提交、验证和最小详情）

- [ ] `submit_candidate` 触发扫描、验证并固化 Candidate，但不直接完成 Mission
- [ ] `failed` 不生成 Candidate，并保留错误信息
- [ ] 正式结果绑定不可变 revision
- [ ] MVP0 详情可查看 backend、最小状态、usage 和错误
- [ ] [GA] Review、完整详情及非 MVP0 outcome 在对应 schema 立项后验收
- [ ] 不建立 `run_snapshots` 表、`SnapshotProjector` 或依赖 snapshot 的 UI/取消/恢复链路
- [ ] 所有新增 UI 文案完成中英文 i18n 且无硬编码
- [ ] 历史卡片只读，不能对旧 Run 重复确认

### 17.9 打包与跨平台

- [ ] MVP0 首发目标平台的开发构建能启动 Builtin 并完成冒烟 Mission；三平台安装包属于 Long-running GA Gate
- [ ] 用户机器无需额外安装 Node 或 CLI
- [ ] Windows 无控制台弹窗，各平台取消后无残留进程
- [ ] 打包校验能发现 Builtin 入口缺失或路径错误

### 17.10 Builtin 内核边界

- [ ] Builtin 子进程推理内核和 RPC schema 不导入 Candidate/Recovery 等宿主持久化类型
- [ ] 宿主侧 `BuiltinBackend` 可以理解 AgentRun，不为未来 interactive Agent 预建 caller/workspace/result 抽象
- [ ] correlation 伪造不得改变 capability，跨 Run/generation/session 的授权复用被拒绝

---

## 18. 测试要求

### 18.1 MVP0 单元测试

- Builtin RPC 序列化、schema 校验、请求匹配、超时、关闭和错误响应；
- Builtin 推理循环、工具结果回填、取消和最大轮次；
- LLM 服务格式到规范化协议的双向转换；
- Builtin 禁止依赖、Host RPC method allowlist、capability token 和身份绑定；
- `BuiltinRunRequest/Result`、`WorkspaceCapability`、`CapabilityGrant` 及权限缩减；
- BuiltinBackend 的 `submit/failed` 到 Run outcome 的确定性映射；
- Host 文件工具风险判定、路径安全、符号链接和写冲突；
- 执行期 success criteria 状态为 unknown，Validator 运行后才产生权威验收结果；
- persistent Mission block、有界历史和 `CONTEXT_EXHAUSTED`；
- generation fencing。

### 18.2 MVP0 集成测试

- 无工具问答；
- 读文件 → 编辑 → 正常提交 → Candidate/Validator；
- 权限允许、拒绝、超时；
- 可选预定义验证命令的 allow/deny；未启用 Shell 时文件型 Mission 仍可运行；
- LLM 调用中取消；
- `submit/failed` 的 schema、身份绑定和状态迁移；
- outcome 重放、冲突、缺失、无效、迟到，以及与取消/预算/transport 断开的竞态；
- 达到 token、工具、时间预算；
- Candidate 扫描和确定性验证；
- feature flag 显式选择 Builtin，并可安全关闭回滚。

### 18.3 Long-running GA 候选测试

以下能力进入 Phase 4～7 后才要求对应测试，不得阻塞 MVP0：

- Codex 自动回退及 authorization 隔离；
- ResourcePulse、Stuck Detection、waiting/parking/Decision；
- RecoveryBundle、新 Run 恢复及完整 outcome 映射；
- Review、完整 RunDetailDTO 与恢复 UI；
- 通用 Shell、终端资源限制和进程树回收；
- 三平台安装产物。

### 18.4 MVP0 冒烟测试

MVP0 首发目标平台至少执行：

1. 定位并启动 Builtin；
2. 完成 Builtin RPC 握手；
3. 通过 Host `fs/read_text_file` 读取 worktree 内测试文件；
4. 触发一次模拟 LLM 响应；
5. 正常结束并确认无残留进程。

---

## 19. 权威范围表

MVP0 只验证真实 AgentRun → Builtin → Host LLM/文件工具 → Candidate/Validator 的纵向链路。其他章节不得扩大下表范围。

| 能力 | MVP0 | Long-running GA / 后续 |
|---|---:|---:|
| 独立子进程、Builtin RPC、单 provider | ✓ | ✓ |
| 文件读写编辑、固定预算、取消、fencing | ✓ | ✓ |
| `submit/failed`、Candidate、Validator | ✓ | ✓ |
| feature flag、最小详情、首发平台开发态 | ✓ | ✓ |
| 自动 Codex 回退、waiting/parking/recovery | — | ✓ |
| ResourcePulse、Stuck、Review、通用 Shell | — | ✓ |
| 上下文压缩、工作记忆、三平台安装包 | — | 由数据和发布计划决定 |
| Interactive adapter、ACP、递归 SubAgent、Workflow DAG | — | 未立项 |

---

## 20. 待评审事项

以下事项不阻塞需求主体，但需在实现计划冻结前确认：

| ID | 问题 | 建议默认 |
|---|---|---|
| OQ-02 | Builtin MVP 选择哪个唯一 provider/profile 作为首批适配目标 | 从当前主 Agent 已验证的服务与模型组合中选择一个；第二个 provider 在 MVP 后接入 |

---

## 21. 前置依赖

- 后台 Mission / AgentRun 数据模型与状态机；
- 私有 worktree和 generation fencing；RecoveryBundle 属于 Long-running GA 依赖；
- 现有 LLM 配置、流式调用，以及至少一个已验证 provider/profile 的请求/响应与 usage 能力；
- Host ToolGateway 路径安全、写冲突和 PermissionGateway；HostTerminalService 属于可选验证命令或 GA 依赖；
- 工具确认卡片；Decision 属于 Long-running GA 依赖；
- Candidate、revision 和确定性验证；Review 属于 Long-running GA 依赖；
- 主进程子进程树管理和打包配置。

具体模块和文件布局由开发方案定义。
