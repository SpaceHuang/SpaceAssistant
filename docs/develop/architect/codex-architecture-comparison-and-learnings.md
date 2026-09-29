# Codex 架构对照与借鉴（对照我们的产品架构理想态）

> 定位：本文是**参考研究**，不是方案，也不是我们的架构基线。它做三件事：把 Codex 的架构讲清楚、与我们 `docs/develop/architect/product-architecture-design.md` 的理想态逐维度对比、列出值得借鉴与不该照搬的部分。
> 对照对象：`F:/Develop/codex`（Codex CLI 开源仓库，Rust 工作区约 120 个 crate）。证据用 `crate 内路径:行` 标注，均来自结构与关键注释的实际阅读，**未逐行审计实现**。
> 上游：`docs/develop/architect/product-architecture-design.md`（我们的理想态）、`docs/develop/architect/agent-core-roadmap.md`（工作块）。
> 状态：参考稿 ｜ 摸排日期：2026-09-12 ｜ 结论已按「是否影响我们正在写的方案」排序

**一句话**：Codex 把我们想做的**大部分**事情都已经做过了一遍，而且做得更「协议化」—— 它把 Agent 内核做成了一个**长驻服务（app-server）**，所有界面（TUI）、脚本（exec）、SDK、IDE 都是**同一个协议的不同客户端**；把安全做成 **permission profile 的集合交集 + 策略引擎 + 可插拔审批代理（Guardian）**；把扩展做成**声明式 + 进程外的 Hook**。我们的方向与它高度一致；差距主要在三件事：**调用契约的完整度**（steering / 恢复 / 幂等 / 追踪）、**审批代理的工程化**（预热、预算、证据、授权版本）、**存储与协议的可演进性**（只追加记录 + 派生索引 + 契约导出）。

---

## 1. Codex 架构全景

### 1.1 进程与分层

```text
┌─ 客户端（都是同一个协议的消费者） ──────────────────────────────────────┐
│  TUI（交互界面，独立 crate）    exec（脚本/CI，一次性）   Python/TS SDK   IDE │
└───────────────────────────────┬────────────────────────────────────────┘
                                │  app-server-protocol（JSON-RPC，v1/v2，
                                │  按领域分模块 + 生成 JSON Schema / TS 类型）
┌─ app-server（长驻服务，可独立进程也可进程内） ──────────────────────────┐
│  连接与传输 · 会话/线程管理 · 配置与插件热加载 · 事件广播 · 远程控制策略      │
└───────────────────────────────┬────────────────────────────────────────┘
┌─ core（Agent 内核） ───────────────────────────────────────────────────┐
│  推理循环 · 上下文装配（53 个 fragment）· 工具执行 · 沙箱与策略 · Guardian   │
│  子 Agent（agent registry/role/control）· 压缩与记忆 · 实时对话            │
└──────┬──────────────┬───────────────┬──────────────┬──────────────────┘
       │              │               │              │
   protocol       sandboxing/      execpolicy     rollout（只追加记录）
   类型与事件      平台沙箱         策略引擎        + thread-store（派生索引）
```

### 1.2 与我们六块的映射

| 我们的块 | Codex 对应 | 说明 |
| --- | --- | --- |
| **Core** | `core/` | 推理循环、上下文装配、工具执行；对外只暴露 `CodexThread` 与 `Op` |
| **Safety** | `execpolicy/` `sandboxing/` `linux-sandbox/` `windows-sandbox-rs/` `shell-escalation/` `user-verification/` 与 `core/src/guardian/` | 策略引擎 + 平台沙箱 + 审批代理，四层分开 |
| **Runtime** | `core/src/config/`（配置层栈）· `model-provider/` `models-manager/` · `skills/` `plugin/` `hooks/` | 装配发生在 Core 内部，但输入全部来自配置层栈 |
| **Driver** | `app-server/` `exec/` `tui/` `cli/` `sdk/*` | 每个入口都是协议客户端，没有一个直接调 Core |
| **Storage** | `rollout/`（只追加 JSONL，真相）· `thread-store/`（列表/搜索/归档/血缘，派生）· `protocol/src/openai_models.rs` | 真相与索引分离，SQLite 只做派生 |
| **Utils** | `utils/` `ansi-escape/` `async-utils/` `otel/` `analytics/` `diagnostics/` | 另有可观测性独立成层（我们目前没有） |

**与我们最像的一点**：Codex 也没有「业务模块」概念 —— 它的文件系统、搜索、配置、MCP、插件能力都是**工具**或**客户端功能**，不进入内核分层。我们「业务模块与 Agent 正交」的切法在 Codex 里得到印证。

**与我们最不像的一点**：Codex 的「界面」是**独立进程的协议客户端**（TUI 用 `codex_app_server_client::AppServerRequestHandle` 与 `ClientRequest`，`tui/src/app.rs:6-97`），我们目前是**同进程的渲染进程 + IPC**。这是形态差异，不是对错。

---

## 2. 逐维度对比

### 2.1 调用契约：我们的 Invocation vs Codex 的 TurnInput

| 维度 | 我们（`product-architecture-design.md` §6.2） | Codex |
| --- | --- | --- |
| 入参 | `messages + profile + events + limits + signal` | `TurnInputRequest { input, thread_settings, start, additional_context, responsesapi_client_metadata, trace }`（`protocol/src/turn_input.rs`） |
| 输入种类 | 只有消息 | `TurnInput = UserInput{content, client_id} ｜ ResponseItem ｜ InterAgentCommunication` |
| 提交语义 | 无（发起即执行） | 三种：**start-or-steer / idle-start / steer-only** |
| 中途干预 | 无 | `Op::Interrupt`、**steering**（向运行中的回合注入输入） |
| 崩溃恢复 | 无 | `Op::RecoverTurn` + `SuspendTurnOutcome{Suspended ｜ NotActive ｜ HasLiveDescendants ｜ UnsupportedTask}` |
| 幂等 | 无 | `client_id`（调用方给的输入 id） |
| 追踪 | 无 | `W3cTraceContext` 随调用传递 |
| 附加上下文 | `profile.system 附加`（字符串） | `additional_context: BTreeMap<String, AdditionalContextEntry>`（**结构化、可寻址**） |

**结论**：我们的契约方向对，但**只有「起跑」没有「跑道管理」**。最值得补的三件：`client_id` 幂等、`RecoverTurn` 语义（今天我们是「窗口没了回合就失败」，Codex 是「回合可以恢复采样」）、以及 `additional_context` 这种结构化附加上下文通道（比往 system 里拼字符串强得多）。`steering` 对我们的价值取决于产品是否要「回合进行中继续说话」，建议先不做，但在契约里**预留**。

### 2.2 进程形态与驱动源：我们的 Driver vs Codex 的 app-server

| 维度 | 我们 | Codex |
| --- | --- | --- |
| 驱动源 | 桌面界面 / 远端输入方 / 定时 / 事件（§4.1） | TUI / exec / SDK / IDE / MCP（`SessionSource` 枚举，`protocol.rs:2760`） |
| 内核与界面关系 | 同进程，IPC | **跨 crate，协议**；TUI 是 app-server 客户端 |
| 长驻服务 | 无（主进程兼任） | `app-server` + `app-server-daemon` + `app-server-transport`（连接生命周期、清理、远程控制策略） |
| 进程内直连 | 不适用 | 支持：`InProcessAppServerClient`（`exec/src/lib.rs`）—— **同一协议，传输可换** |
| 脚本化输出 | 无 | `codex exec`：默认 stdout 只有最终消息；`--json` 输出 JSONL 事件流 |
| 后台任务 | 待建（块 4） | 「中断任务」与「终止后台进程」是分开的两件事：`Op::Interrupt`、`Op::CleanBackgroundTerminals`，另有 `BackgroundTerminalInfo` 暴露状态（`core/src/lib.rs`） |
| 多客户端并发 | 未定义 | 连接级状态、连接清理、`ConnectionOrigin`、`RemoteControlPolicy` |

**结论**：**「同一协议、传输可换（进程内 / UDS / stdio）、客户端可多」比「daemon 化」本身更值得学**。我们的 `Invocation` 是 Rust 函数签名式的，没有「线上形态」；一旦要支持管家 Agent、定时触发、远端触发同时在线，就需要一个**与传输无关的调用与事件协议**（我们现在叫 IPC 通道名，散在 `appIpc.ts`）。
另外 `codex exec` 的「默认只输出最终结果 / `--json` 输出事件流「这两种模式，正是我们管家 Agent」静默落盘 or 推送结果「的现成参照 —— **同一份执行，两种消费形态**。

### 2.3 安全：我们的 Safety vs Codex 的沙箱 + 策略 + 权限剖面

Codex 的安全是**四层**，比我们的「策略引擎 + 门控 + 审计」更细：

| 层 | 机制 | 我们的对应 |
| --- | --- | --- |
| 平台沙箱 | `sandboxing/` `linux-sandbox/` `windows-sandbox-rs/`（OS 级隔离） | 无（我们只有路径安全与工具门控） |
| 策略引擎 | `execpolicy/`（命令前缀规则 allow/prompt/forbidden） | `policyEngine.decide()`（§7.1） |
| 权限剖面 | `PermissionProfile` + **集合交集**（`permission_profile_intersection.rs`） | `locked` 底线规则 |
| 审批代理 | `Guardian`（见 2.4） | 审批 Agent 方案（块 2） |

**最值得学的是「交集」这条机制**（`protocol/src/permission_profile_intersection.rs`）：

- `intersect_effective_permission_profiles(authority, requested, cwd)` —— 子调用/降级的权限 = **父权限 ∩ 请求权限**，从数学上保证「只能收紧」。
- 注释第一句就是我们的判据：「A policy cannot be intersected without weakening either input.」（`protocol/src/permission_profile_intersection.rs:20`）
- 三种情况**直接失败**（不是放宽）：`ExternalSandbox`、`PlatformDefaults`、`UnsupportedPath`；「Unsupported policy shapes fail closed.」
- 具体路径在做交集前**规范化**，「so symlinks cannot acquire authority beyond either input」。

对比我们：我们用「`locked: true` 的规则不能被下调「来实现不可放宽 —— 这是**规则级**的，Codex 是**权限集合级**的。**建议**：我们保留规则级底线，同时引入」能力集合交集「用于 **SubAgent 与降级场景**（例如 SubAgent 的 Profile 只能在父的白名单内选，本质就是交集）。

另一个可学的：`AskForApproval` 有四种档位（`protocol.rs:992`）—— `UnlessTrusted ｜ OnRequest ｜ Granular(GranularApprovalConfig) ｜ Never`，其中 `Granular` 是**按类别**给位（沙箱审批、execpolicy 提示…）。这正是我们讨论过的「档位调的是**范围**不是宽严」，Codex 已经把它做成了一个显式的结构体。

### 2.4 审批代理：我们的审批 Agent vs Codex 的 Guardian

这是**重合度最高、也最值得我们细读**的部分。Codex 的 `core/src/guardian/` 有 17 个模块（含 157KB 测试）。

**设计声明**（`guardian/mod.rs:2`，原文）：

> Hosts approval decisions and the isolated synchronous reviewer. **The extension chooses policy and evidence; core enforces permissions and mandatory review requirements.** Each approval retains its issuing context and cancellation.

对应我们的三条规则：策略内容在外（extension 选 policy）、Core 强制底线（mandatory review requirements）、审批锚定发起上下文（retains its issuing context）。**我们和它是同一个模型**。

| 关注点 | 我们的方案 | Codex | 评价 |
| --- | --- | --- | --- |
| 回答者形态 | `answerer` 端口，按 Profile 解析 | `codex_extension_api::SynchronousApprovalReviewer` 扩展；返回 `None` 表示「回落既有用户流程」 | 一致；Codex 多一句硬语义：**「No contributor is never an implicit allow」**（`decision.rs:50`）—— 建议原文吸收 |
| 缓存 | **裁决永不写缓存**（一事一议） | 「**no outcome is stored by tool-call ID**」（`decision.rs:2`）—— 同样拒绝按工具调用缓存 | 一致！但 Codex 保留了另一类东西 ↓ |
| 证据复用 | 记录是证据与输入（roadmap §1.5） | `GuardianReviewEvidence`：保留**上一轮评审**与已完成的评审，**bounded**（`MAX_PREVIOUS_REVIEWS`，`core/src/context/guardian_review_evidence.rs:41`），「never inserted into the agent's conversation」，且「**authorization changes invalidate stale records**」 | **这是我们缺的一块**：证据可复用，但要有**授权版本**做失效 |
| 隔离 | 独立的审批调用 | `GuardianReviewSession`：独立的 base_instructions、独立权限剖面、技能/记忆显式关闭、retries=1、显式 token 预算 | 我们只说了「只读工具 + 快模型 + 有界输出」，可以照它补全**降级清单** |
| 权限下限 | 只读工具 | `read_only_guardian_permission_profile = permission_profile.intersect_with_read_only()`（`reviewer_config.rs:21`）—— 审批者的权限是**父权限 ∩ 只读** | 建议直接采用「交集到只读」这个写法 |
| 延迟 | 未讨论 | **会话预热与池化**：`prewarm_guardian_review_session`、「The extension owns review policy and pooling」 | 高价值：审批在关键路径上，冷启动成本必须提前付 |
| 预算 | 有界输出 | 输入预算 + 请求预算 + `GUARDIAN_REVIEW_TIMEOUT` + 超时文案 | 我们只说了「有界」，应给出三个具体预算 |
| 反复拒绝 | 未讨论 | `AUTO_REVIEW_DENIAL_WINDOW_SIZE`（连续拒绝窗口） | 值得借鉴：连续拒绝应触发升级/降级，而不是无限自动拒绝 |
| 复审条件 | 未讨论 | `require_fresh_review`：权限升级请求、重试、格式化失败、外部取消等条件下**必须重新评审**，不得复用 | 直接可抄：这是「证据复用」的安全边界 |
| 策略文本 | 安全策略模块 | `BUNDLED_GUARDIAN_POLICY_TEMPLATE` + 租户 policy 配置，作为**独立 developer 消息**注入（`requires_separate_message = true`、`content_kind = "guardian.policy"`、markers 为空） | 细节值得抄：策略以独立 developer 片段注入，且用空 marker 避免被模型当普通标记解析 |
| 模型选择 | 审批模型能力下限由安全侧强制 | 模型目录里的 `ModelInfo.guardian` 按操作类别声明**该模型可自行审批的范围**；`requirements.auto_review_required_for_model(slug)`、`approvals_reviewer.can_set(...)` 返回 `Err` 时强制走 Guardian | **比我们更完整**：审批覆盖面是**模型元数据 + 管理员约束**共同决定，不只看用户档位 |

### 2.5 扩展点与 Hook：我们「不开放」 vs Codex「受约束地开放」

这是**唯一一处我们与 Codex 的显式分歧**。我们（§5.3）写死了：

> **可改写的生命周期 Hook**：不提供 `onToolCallStart → 改写参数` 这类回调。

Codex 提供了 **12 个 Hook 事件**（`hooks/src/lib.rs:23`）：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`；其中 9 个带 matcher（按工具名等匹配）。

而 `PreToolUse` **可以改写工具入参**：`updated_input: Option<Value>`、`block_reason: Option<String>`、`permission_mode`（`hooks/src/events/pre_tool_use.rs:31-52`）。

但它的「开放」被五道约束夹住了，这五道正是我们担心的东西的对策：

1. **声明式注册**：Hook 来自配置层栈（`config_rules.rs`、`hook_states_from_stack`），不是进程内注册的任意代码。
2. **固定事件集 + matcher**：可枚举、可列出（`HookListEntry`/`HookListEntryHandler`），不是任意回调点。
3. **进程外执行**：`command_runner.rs`（外部命令）与 `mcp_runner.rs`（MCP），与内核内存隔离。
4. **schema 校验的输出**：`schema.rs` + `output_parser.rs`；**输出不合法则不生效**（fail-safe，`invalid_reason` 分支），且只有 `can_apply_control_effects()` 的 handler 才能产生控制效果。
5. **冲突可裁决**：多个 Hook 改写入参时按 `completion_order` 取最新（`latest_updated_input`），结果确定。

**结论**：**我们不该继续维持「一律不开放」，而该改成「分层开放」**：

- Core 内部（推理循环、上下文装配顺序）**继续不开放** —— 这条底线是对的；
- **工具调用前后开放受约束的 Hook**（PreToolUse / PermissionRequest / PostToolUse 三类即可），并把这五道约束作为开放的前提写进方案；
- 我们的「**事件只观察，不改变判定**」不变量不用丢 —— Codex 把它做成了 **per-handler 的能力位**（能否产生控制效果），比「整类事件只读」更精细，正是我们该学的表达方式。

### 2.6 SubAgent 与多 Agent：我们的块 3 vs Codex

| 关注点 | 我们（roadmap §1.2、块 3） | Codex |
| --- | --- | --- |
| 会话归属 | `user / remote / automation / internal` | `SessionSource{ Cli, VSCode, Exec, Mcp, Custom(String), Internal(..), SubAgent(..), Unknown }` |
| 可见性 | `primary / section / hidden` | `ThreadSource{ User, Subagent, GuardianReview, Feature(String), MemoryConsolidation }` —— 列表按它过滤 |
| 父链 | 锚在父 turn 上 | `SubAgentSource::ThreadSpawn { parent_thread_id, depth, agent_path, agent_nickname, agent_role }` |
| 层级地址 | 无 | **`AgentPath`**（子 Agent 有层级路径，是消息寻址的基础） |
| 子→父/子↔子通信 | 结果回灌父上下文 | `InterAgentCommunication { author, recipient, other_recipients, content, encrypted_content, trigger_turn }` |
| 是否触发对方回合 | 确认回复「同一会话起新 Turn」 | `trigger_turn: bool` —— 把「投递」与「是否起回合」**解耦成参数** |
| 能力约束 | Profile 白名单内选，只能降档 | `apply_role_to_config` + 「**Roles may customize the child or reduce its capabilities, but never replace the parent session's authority**」（`core/src/agent/role.rs:3`） |
| 角色定义 | Profile 数据 | `agent-roles/`（role 文件发现与加载）+ `AgentRoleOverrides{ developer_instructions, model, model_reasoning_effort, reasoning_summary, verbosity, personality, service_tier, features, skills }` |
| 控制面 | 未展开 | `core/src/agent/control.rs`（35KB）+ `registry.rs` + `status.rs` |

**结论**：我们在块 3 里设计的「归属 + 可见性 + 父锚 + 深度上界 + 只降不升」，Codex 全都有，而且多了两样我们要认真考虑的东西：

1. **`AgentPath`（层级地址）** —— 没有它，子 Agent 之间与跨层消息只能靠 id 拼凑；有它，「谁给谁发消息」是一门可读的语言。若我们短期内不做子 Agent 间通信，可以只把它作为 id 约定保留。
2. **`trigger_turn`** —— 我们已定的「确认回复 → 同会话起新 Turn」其实是一个特例；Codex 把它参数化了。建议在方案里把它写成「投递是否触发回合」的参数，而不是硬编码一种行为。

### 2.7 存储与会话可见性

| 关注点 | 我们 | Codex |
| --- | --- | --- |
| 真相 | SQLite（WAL）+ 明文会话备份 | **只追加的 rollout 文件**（JSONL）是真相（`rollout/src/lib.rs:1`），SQLite 不作为会话真相 —— `session_index` / `rollout_reference_index` / `state_db` 提供派生索引与状态 |
| 读取 | 直接查库 | `reverse_jsonl_scanner`（反向扫描）、`seekable_reader`、`ordinal`（序号索引） |
| 会话操作 | CRUD + 列表 | `list_threads` / `search_threads` / `archive_thread` / `delete_thread` / `move_thread_to_section` / `revert_thread` / `paginated_fork` / `rollout_lineage`（血缘）/ `thread_attachments` / `projects` |
| 分区 | 我们说「管家会话独立分区」 | `thread_sections` —— 已经是实现 |
| 保留期 | 审计只追加；会话台账有 100 条窗口 | `rollout/maintenance.rs`（维护与清理） |
| 迁移 | 无 | `rollout_migration.rs`（54KB）+ `rollout_lineage.rs` |

**结论**：我们在 §8 写的「协议在内、实现在外 + 只追加 + 序号单调 + 终态收敛 + 派生索引」，Codex 的做法几乎逐条对应（JSONL 真相 + ordinal + 反向扫描 + SQLite 仅作派生）。两点建议：

- **`rollout_lineage`（血缘）**是我们没提的：会话/子会话的祖先链本身就是存储层概念，子 Agent 与 fork 都靠它。
- **`revert_thread` / `paginated_fork`**：回合回滚与分叉。我们不做 fork 可以，但「回滚」在「拒绝 + 重跑」场景会出现，值得记一笔。

### 2.8 模型目录：我们的 ModelEntry vs Codex 的 ModelInfo

我们的痛点（§10 偏差 6）：`ModelEntry` 没有能力标记、思维强度是全局布尔。Codex 的 `ModelInfo`（`protocol/src/openai_models.rs:400`）是一个**完整的模型目录条目**：

| 字段 | 作用 |
| --- | --- |
| `supported_reasoning_levels` / `default_reasoning_level` | **思维强度分档 + 默认档**（正是我们要的） |
| `support_verbosity` / `default_verbosity` | 输出冗长度也是能力 |
| `shell_type` / `apply_patch_tool_type` / `web_search_tool_type` | **工具形态由模型决定** |
| `truncation_policy` | 截断策略随模型 |
| `service_tiers` / `additional_speed_tiers` / `priority` / `visibility` | 速度档与展示 |
| `guardian: Option<GuardianModelPolicy>` | **该模型在哪些操作类别上可自行审批**（`computer_use/shell/code_mode/file_changes/mcp/network/permissions`），并注明「不覆盖强制安全与管理员要求」 |
| `model_messages`（含 `auto_review`、`policy_template`） | **审批策略模板来自模型目录** |
| `upgrade { model, migration_markdown }` | 模型下线与迁移说明 |
| `include_skills_usage_instructions` 等 | 该模型是否注入技能/插件/应用说明 |

**结论**：这解释了我们「能力校验与降级」该由谁提供 —— **宿主给的「能力」应该是目录数据，而不是散落在代码里的 `if`**。同时它给了我们一个更好的答案：**审批覆盖面可以跟模型走**（`ModelInfo.guardian`），而不只是跟用户档位走。

### 2.9 上下文装配：我们的「待重构」 vs Codex 的 fragment 机制

Codex 的 `core/src/context/` 有 **53 个文件，每个文件是一种上下文片段**，例如：`base_instructions.rs`、`environment_context.rs`、`permissions_instructions.rs`、`approved_command_prefix_saved.rs`、`network_rule_saved.rs`、`current_time_reminder.rs`、`model_switch_instructions.rs`、`compaction_summary.rs`、`memory.rs`、`guardian_policy.rs`、`guardian_review_evidence.rs`、`inter_agent_message.rs`、`hook_additional_context.rs`、`personality_spec_instructions.rs`、`legacy_*_warning.rs`。

每个片段实现统一的 `ContextualUserFragment`：声明 `content_kind()`（如 `"guardian.policy"`）、`role()`（user / developer）、`requires_separate_message()`、`markers()`。通用机制在 `context-fragments/`（`fragment.rs`、`additional_context.rs`、`annotated_content.rs`、`answered_question.rs`）。

**结论**：这正是我们 `docs/develop/context-injection-refactor-plan.md` 应该长成的样子 —— **不是「一个装配函数里加一段字符串」，而是「每个注入项一个命名、有类型、可单测、可单独开关的片段」**。三个直接可搬的约定：

1. 片段有 **name / content_kind**，因此可审计「这次上下文里有哪些片段」；
2. 片段声明 **role 与是否独立消息**，避免把 developer 指令混进 user 内容；
3. 片段可有 **markers**，且允许为空（`guardian.policy` 用空 marker 防止被误解析）。

### 2.10 协议演进与可观测性

| 关注点 | 我们 | Codex |
| --- | --- | --- |
| 契约定义 | `src/shared/api.ts` + `appIpc.ts` 通道名 | `protocol/` + `app-server-protocol/`（v1 与 v2 并存），**按领域分模块**（thread / turn / permissions / hook / plugin / model / memory / fs / config …） |
| 类型导出 | TypeScript 手写 | Rust 类型生成 **JSON Schema 与 TS 类型**（`export.rs`、`ts_rs`），有 fixture 测试防漂移 |
| 兼容 | 无 | `legacy_events.rs`、`#[serde(other)] Unknown`、`protocol_v1.md` |
| 遥测 | `agentLogger`（本地 JSONL） | `otel/`、`otel-trace-websocket/`、`analytics/`、`rollout-trace/`、`diagnostics/` |

**结论**：我们「IPC 面按领域切」的目标，Codex 是**按领域分文件 + 生成契约 + fixture 防漂移**。值得抄的是**契约生成与防漂移测试**（我们的 `api.ts` 是手写的，跨进程契约漂移目前靠类型检查兜底）。

---

## 3. 我们不必照搬的

| Codex 的做法 | 为什么我们不做 |
| --- | --- |
| daemon 化（独立 app-server 进程 + UDS/stdio） | 我们是单机桌面应用，Electron 主进程已经在扮演这个角色；当前收益不抵复杂度。**但「协议与传输解耦」要学**（见 §4） |
| JSONL 作为唯一真相、SQLite 仅派生 | 我们的会话量、搜索与列表性能要求不同，SQLite 做主存储是既有决策；**「只追加记录 + 派生索引 + 维护任务」的思想要学**，形态不必照搬 |
| OS 级沙箱（Landlock / Seatbelt / Windows sandbox） | 我们已有路径安全与工具门控；引入 OS 沙箱是独立的大工程，且平台覆盖面大。可作为**未来在危险工具上单独加固**的方向 |
| 12 类 Hook 全量开放 | 我们只需要工具调用前后与确认请求三类；其余（Session/Compact/Stop）对我们当前产品价值低 |
| `AgentPath` 层级寻址 | 我们暂不做子 Agent 间通信；先以 id 约定保留，等真需要再升级 |
| 云任务（`cloud-tasks`）、实时语音（`realtime-*`）、`code-mode` | 与我们的产品形态无关 |
| i18n | Codex 是单语言 CLI，没有这个问题；我们的横切关注点表（§2.4）与它无可比性 |

---

## 4. 值得学习的地方（按对我们的紧迫度排序）

### 第一优先：直接影响正在写的方案

1. **契约补三件**：`client_id` 幂等、`additional_context` 结构化附加通道、`trace` 随调用传递（§2.1）。
2. **审批代理的工程化清单**（§2.4）：只读权限 = `父权限 ∩ 只读`；技能/记忆显式关闭；retries 与超时显式化；**会话预热与池化**；输入/请求/超时三类预算；**连续拒绝窗口**；**`require_fresh_review` 复审条件**。
3. **证据可复用、授权不可复用**：把我们的「裁决永不写缓存」精确化为「**不复用授权，但可有界复用证据**」，并引入 **authorization version** 让陈旧证据自动失效（§2.4）。
4. **能力约束用集合交集**：SubAgent 与降级场景用「父权限 ∩ 请求权限」，`intersect` 失败即 fail-closed（§2.3）。
5. **Hook 分层开放**：Core 内部继续不开放；工具调用前后开放受约束 Hook，并写清五道约束（声明式 / 固定事件集 + matcher / 进程外 / schema 校验 + 能力位 / 冲突裁决）（§2.5）。
6. **「事件只观察」改写成 per-handler 能力位**：观察与可控是**能力**差异，不是事件类别差异（§2.5）。

### 第二优先：影响块 3 / 块 4 的方案

7. **SubAgent 的层级地址与投递参数化**：`AgentPath` + `trigger_turn`（§2.6）。
8. **会话血缘（lineage）进存储层**：父子链是存储概念，不只是内存里的引用（§2.7）。
9. **exec 的两种输出形态**：默认只输出最终结果 / `--json` 输出事件流 —— 管家 Agent 的「静默落盘 vs 推送结果」可以直接对齐（§2.2）。
10. **上下文片段化**：把 `docs/develop/context-injection-refactor-plan.md` 的目标改成「片段注册表」，每个片段有 name / role / 独立消息 / markers（§2.9）。

### 第三优先：架构卫生

11. **契约生成与防漂移测试**：按领域分模块 + 生成类型 + fixture 测试（§2.10）。
12. **模型目录承载能力**：`supported_reasoning_levels`、工具形态、截断策略、**审批覆盖面**、迁移说明（§2.8）。
13. **可观测性独立成层**：我们目前把日志塞在 Utils；Codex 有独立的 `otel/` `analytics/` `diagnostics/`。结合我们 §2.4 的横切关注点表，可考虑把「遥测/审计」从 Utils 里提出来单列一张归属表（不必单列一层）。

---

## 5. 对现有文档的修订建议

| 文档 / 小节 | 建议 |
| --- | --- |
| `product-architecture-design.md` §6.2 Invocation | 补 `client_id`、`additional_context`、`trace`、`recover/suspend` 四行，并注明「steering 预留不实现」 |
| `product-architecture-design.md` §5.3 明确不开放 | 从「不提供生命周期 Hook」改为「**分层开放**」，把五道约束写明；「事件只观察」改为能力位表述 |
| `product-architecture-design.md` §7.1 策略规则 | 保留 `locked` 底线，同时补「权限集合交集」作为 SubAgent / 降级场景的机制 |
| `product-architecture-design.md` §5.4 模型 | 把「能力校验」具体化为「宿主提供模型目录数据」，并加入「审批覆盖面可随模型声明」 |
| `product-architecture-design.md` §2.4 横切关注点 | 遥测/审计从 Utils 的注脚提升为与 i18n 并列的一行 |
| `confirmation-answerer-and-auto-approval-design.md` | 补三节：只读权限交集、复审条件（fresh review）、会话预热与预算；把「永不缓存」改写为「授权不缓存、证据有界复用 + 授权版本失效」 |
| `agent-core-roadmap.md` §1.5 内部调用落盘 | 补「血缘」与「授权版本」两个概念 |
| `docs/develop/context-injection-refactor-plan.md` | 按 §2.9 的片段化目标重写装配部分（本文件只给方向，不展开） |

---

## 6. 一句话总结

**我们的理想态方向是对的**（内核与界面解耦、安全不可绕、扩展优先走数据、会话有归属与可见性），Codex 用一套更协议化、更可演进的工程手法实现了同一套原则。**最值得我们学的三件事**：

1. **把调用、事件、扩展都变成「可枚举的协议」，而不是函数签名**（TurnInput / Op / 12 类 Hook / 按领域分的 app-server 契约）；
2. **安全用「集合运算 + 显式预算 + 可插拔代理」表达**（权限交集、三类预算、Guardian 扩展、复审条件）；
3. **记录是只追加的真相，索引是可重建的派生**（rollout + ordinal + 反向扫描 + SQLite 派生），上下文则是**一组命名片段**而不是一段拼接字符串。