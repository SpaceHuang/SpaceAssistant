# Agent 能力集合（toolkit）：自我知觉与功能执行的网关式工具设计

- 日期：2026-09-17（v2，按评审修订）
- 状态：需求提案 v2 —— 已按 `agent-toolkit-capability-gateway-requirement-review.md`（本地评审报告，不入版本控制）修订，待复审
- 关联文档：`docs/requirement/mcp-agent-driven-oauth-install-requirement.md`（下称「前案」）。**本文取代前案 §5.2.2/§5.2.3 的「mcp_manage 专用工具面」，保留 §5.2.1（mcpService 抽取，本案 §7 Phase 2 沿用）**。前案 P1（OAuth 健壮化）全部有效；P2①②（变更事件、过期推送）有效，**P2③④（授权浮动通知、端到端验收路径）依赖本期未纳入的 `action.mcp.login/refresh`，随本案 Phase 3 生效**（§1.4）。`action.mcp.add` 的行为规范沿用前案 §5.2.2（含 `env` 与 `oauthScopes` 入参，见 §4.2）。

---

## 1. 背景与动机

### 1.1 问题：专用工具路线不可持续

前案为「Agent 自主接入远程 MCP」提出新增专用内置工具 `mcp_manage`。评审否决：这类需求场景很多（环境自省、会话查询、MCP 管理……），逐个追加专用工具会导致：

1. **上下文浪费**：内置工具 schema 随每次模型请求全量携带（`src/shared/builtinToolDefinitions.ts` 当前已定义 16 个内置工具 + `history.read` / `skills.read` 两个元工具）。每加一个专用工具，常驻成本按请求次数累加，而多数请求根本用不到它。
2. **模型面嘈杂**：工具越多，模型选择工具的出错概率越高。

### 1.2 已有先例：`history.read` / `skills.read`

仓库已采用过「网关 + 按需加载」模式（`builtinToolDefinitions.ts:285-286`）：

- `history.read`：不把压缩历史全量塞进上下文，而是让模型按窗口/条目/关键词**按需查询**；
- `skills.read`：不把全部技能说明常驻上下文，而是让模型**按需读取**指定技能的完整说明。

本方案把该模式推广为通用的**能力集合（toolkit）**：模型面只暴露**两个稳定工具**，集合内的能力可自由增删，对上下文零增量。

**边界澄清：`history.read` / `skills.read` 是模式先例，但不收编进能力集合。** 三者虽同属「网关 + 按需」模式，但层次不同：

- `history.read` 读的是**当前会话被压缩的历史事实**——模型对自身对话记忆的回查接口。数据源是随请求传入的 `historyFacts`（`toolChatLoop.ts:433-434, 2097`），与压缩管道的窗口/条目/`max_tokens` 预算深度耦合，属于模型的记忆系统而非「产品功能」。其 `input_schema` 单独序列化约 203 字节（整条定义行约 346 字节），全仓库最小之列，收编净节省 ≈ 0，却会给高频的记忆回查路径增加 `find→call` 一跳（且常发生在 tool loop 中途，多一轮模型往返）。
- `skills.read` 是技能系统的按需文档读取器，同理保持独立。
- `action.session.read`（读任意会话的**原始消息**，来自 DB）与 `history.read`（读**当前会话的蒸馏事实**，含压缩时提炼的结论）互补而非重叠；若让模型用原始消息回查替代事实回查，token 成本反而更高。

toolkit 吸收的是它们的**约定**而非本体：紧凑单行 schema、`cursor/limit/max_tokens` 分页与预算参数风格（见 §3.1、§8）。

### 1.3 目标

1. Agent 能**自我知觉**：了解产品名称/版本/形态、宿主系统、开发环境、工作目录、当前时间等运行环境事实（来源任务中「识别当前 Agent 的真实产品名称、版本、MCP 配置能力和实际运行环境」一步的正面解法）。
2. Agent 能**执行产品功能**：添加 MCP 连接、查询会话状态、分页枚举会话、读取会话消息。
3. 新增能力只需在注册表加一条描述符，模型面不变、上下文零增长。

### 1.4 端到端目标的分期交代（与前案 P0 承诺的关系）

前案的 P0 承诺是「Agent 端到端完成接入，用户只在浏览器确认一次授权」。本案将该承诺分期实现，避免静默缩水：

- **Phase 2（本期）**：Agent 可完成 `add → OAuth discovery 结构化结论`，授权一步**降级为引导用户在设置页点击**（`action.mcp.login` 不在本期，见 §4.2 与 §7 Phase 2 验收的边界标注）；
- **Phase 3**：补 `action.mcp.login/refresh` 后恢复前案 P0 的完整承诺；前案 P2③④（OAuth 浮动通知、端到端验收路径）随之生效。

---

## 2. 设计原则

| 原则 | 含义 |
|---|---|
| 网关稳定 | 对模型只暴露 `toolkit.find` + `toolkit.call` 两个工具，schema 永不随能力增删变化 |
| 按需发现 | 能力的存在性与调用方式通过 `toolkit.find` 查询获得，不常驻上下文 |
| 确定性匹配 | `find` 的匹配是纯函数（关键词打分），不引入 LLM/向量检索，可单测 |
| 单一事实来源 | 每个能力一个描述符（id/用途/参数 schema/风险级/处理器），find 返回的「调用方式」由描述符生成，与实际校验逻辑同源，不会漂移 |
| 最小信任 | 能力自带风险级；`act` 类能力调用前必须过既有确认通道；结果经脱敏与尺寸上限 |
| lane 隔离 | 初期仅桌面 lane 注册（与 MCP 工具快照的 lane 策略一致） |

---

## 3. 总体设计

### 3.1 两个网关工具

内部名沿用仓库点号风格（`history.read`、`skills.read` 同款）。点号名发给 API 前经 `sanitizeAnthropicToolsPayloadForStrictGateways` **单向**转换为 compat 名（`toolkit_find`/`toolkit_call`）——「出向有转换、回向无逆映射」是既有缺陷，网关工具能否被分发执行取决于 §3.6 的回向分发修复：

**`toolkit.find` — 查询集合中是否有特定用途的工具**

```jsonc
// 入参
{
  "query": "想知道当前是什么操作系统、有没有 WSL",   // 自然语言用途描述，或精确能力 id
  "family": "env"                                   // 可选：'env' | 'action'，缩小搜索范围
}
// 出参（命中）
{
  "ok": true,
  "matches": [
    {
      "id": "env.system",
      "summary": "获取操作系统类型/版本/架构/系统语言/是否安装 WSL",
      "usage": "toolkit.call 入参：{ \"id\": \"env.system\" }；无参数",
      "returns": "{ os, osVersion, arch, systemLanguage, wsl: { installed, version? } }",
      "risk": "read",                               // read=免确认；act=需用户确认
      "notes": ["结果缓存 10 分钟"]
    }
  ],
  "hint": "调用方式：toolkit.call { id, params }"
}
// 出参（未命中）：ok=true, matches=[], index=[全部能力的 {id, summary} 紧凑列表], hint 提示可换关键词重查
```

**`toolkit.call` — 调用集合中的具体工具**

```jsonc
// 入参
{ "id": "env.system", "params": {} }
// 出参
{ "ok": true, "id": "env.system", "data": { ... } }
// 失败
{ "ok": false, "id": "...", "error": { "code": "unknown-capability | invalid-params | denied | failed | timeout", "message": "...", "hint": "可用 toolkit.find 重新查询调用方式" } }
```

两个 schema 合计约 1.5 KiB（纳入回归测试阈值，见 §8）。

### 3.2 能力描述符与注册表

新增主进程模块 `electron/capabilities/`：

```ts
export type CapabilityFamily = 'env' | 'action'

export interface CapabilityDescriptor<P = unknown> {
  id: string                       // 'env.system' / 'action.session.read'
  family: CapabilityFamily
  summary: string                  // 一句话用途：find 的匹配与返回主体
  keywords: string[]               // 匹配关键词（中英，如 ['系统','操作系统','os','wsl']）
  paramsSchema: ZodType<P>         // toolkit.call 的参数校验（唯一真源）
  paramsDoc: string                // 给模型看的参数说明（find.usage 由它生成）
  returnsDoc: string
  risk: 'read' | 'act'             // 确认策略输入
  lane?: 'desktop'                 // 缺省 desktop
  handler: (params: P, ctx: CapabilityContext) => Promise<unknown>
}
```

`registry.ts` 持有描述符数组；`match.ts` 为纯匹配函数；`handlers/{env,session,mcp}.ts` 分系列实现。工具定义加在 `src/shared/builtinToolDefinitions.ts`（两条），执行器按 `electron/tools/plannedToolRegistry.ts` 既有模式注册。

### 3.3 匹配算法（`match.ts`，纯函数）

1. `query` 等于某能力 `id` → 直接返回该能力（精确路径）；
2. 否则对 `query` 做分词，按「id 命中 > summary 命中 > keywords 命中」加权打分，阈值截取（默认最多 3 条，按分排序）；
3. `family` 参数先行过滤；
4. 无命中 → 返回全量紧凑索引（`{id, summary}`），引导模型换词或直接按 id 调用。

不做模糊语义匹配；关键词表由能力作者维护（每条 3-8 个词），评审时随描述符一起过。

### 3.4 调用流程

```
toolkit.call(id, params)
  → 1. id 解析（未知 → unknown-capability + index 兜底提示）
  → 2. lane 校验（desktop 限定）
  → 3. zod 校验参数（invalid-params，错误信息含 zod 摘要）
  → 4. 风险确认（risk='act' → 走既有确认通道；确认卡片展示能力 summary + 参数摘要，如 endpoint 全文）
  → 5. handler 执行（统一超时上限 10s；env 探测类自带缓存）
  → 6. 结果封装（序列化 > 256 KiB 截断并附提示；全程 logSanitize 脱敏，凭据类字段只出布尔存在性）
```

### 3.5 系统提示最小配合

在 `llmSystemPrompt` 追加约两行常驻说明（~60 token）：「产品提供能力集合：需要了解运行环境（产品/系统/开发环境/工作目录/时间）或执行产品功能（添加 MCP、查询会话状态/列表/消息）时，先用 toolkit.find 查询用法，再用 toolkit.call 调用；能力不足时如实报告，不要编造。」——让模型知道「该去查」，细节按需加载。

### 3.6 工具名双向转换与分发（评审阻断项 B1 的修复设计）

**问题事实**（源码已复核）：出向转换无条件生效——`effectiveTools.ts:37` 对 builtin + MCP 工具统一 sanitize（`.`→`_`，见 `src/shared/anthropicToolSanitize.ts:4-6`，且会折叠连续下划线、去首尾下划线），授权白名单只含 compat 名（`effectiveTools.ts:38-42`）；回向缺失——分发循环 `toolChatLoop.ts:1209` 直接用 API 返回的 `tu.name` 对注册表/执行器做**精确匹配**（`:1233-1234`），全仓库不存在逆映射（`normalizeExternalToolName` 只处理 `Bash→run_shell` 历史别名）。后果是两难：模型回调 `toolkit_find` → 通过授权但查无此名，落「未知工具」分支（`:1240` 附近）；回调 `toolkit.find` → 被 `authorizeToolCall` 以 `tool_not_authorized` 拦下。**现有 `history.read`/`skills.read` 已处于同一两难**（静态证据链闭合）。

**修复方案（择「逆映射」路线）**：

1. `computeEffectiveTools` 在 sanitize 前收集内部名清单，反向产出 `compatToInternal: ReadonlyMap<string, string>` 随结果一并返回；
2. 构建期撞名校验：该映射是多对一（`a.b`、`a_b`、`a..b` 的 compat 形态同为 `a_b`），凡两个内部名 compat 形态相同即**构建期报错**——今后禁止 `a.b` 与 `a_b` 形态并存（纳入单测）；
3. 分发循环在 `const toolName = tu.name` 之后、授权与查找之前做一次逆映射（`compatToInternal.get(name) ?? name`），授权、注册表、执行器、mcpSnapshot 查找全部改用内部名；
4. 事件/日志/工具结果的出向名**维持现状 compat 口径**（渲染端 `ToolCallCard` 匹配面不扩大）；`toolCallLabel`（`src/shared/toolCallLabel.ts` 静态 switch，`toolChatLoop.ts:942` 发出的已是 compat 名）新增条目按「compat 名 + 内部名」双口径覆盖——现有 case 连 `history_read` 都未覆盖。

**前置任务（已完成，2026-09-17）**：B1 已按本节「逆映射」路线修复——`computeEffectiveTools` 产出 `compatToInternal` 逆映射表并做构建期撞名校验，分发循环在授权、吊销复查、注册表/执行器查找、mcpSnapshot 查找与确认门控入口统一回向解析（`electron/effectiveTools.ts`、`electron/toolChatLoop.ts`）；回归用例 `electron/effectiveTools.compatName.test.ts` 完成红→绿验证（修复前 3/3 失败复现两难，修复后通过）。真机端到端复验（触发历史压缩后让模型回查）建议随下次 `npm run dev` 冒烟确认。**回退方案**（保留备查）：若逆映射路线被否，本案网关内部名直接采用下划线形态 `toolkit_find`/`toolkit_call`（§3.1 的点号风格表述随之作废，点号仅保留在展示文案层）。

---

## 4. 初始能力清单（9 项）

### 4.1 环境知觉系列（family=env，全部 risk=read）

| id | 用途 | 返回要点 | 实现来源 |
|---|---|---|---|
| `env.agent` | 当前 Agent 自身信息 | 产品名称、版本（`app.getVersion()`）、形态（`desktop`）、是否支持用户交互（`true`，桌面聊天+确认弹窗）、产品语言（用户选择的 i18n locale） | 应用常量 + config |
| `env.system` | 宿主操作系统 | OS 类型/版本/架构、系统语言、WSL 检测（仅 Windows：`System32\wsl.exe` 存在性 + `wsl --status`，**参数数组 spawn**，2s 超时，结果缓存 10min；非 Windows 恒 `false`） | `process`/`os` + 探测 |
| `env.dev` | 开发环境 | node/python（含 `python3`/`py` 回退）/git 等的可用性与版本（`--version` spawn，3s 超时，缓存 10min；未装返回 `{available:false}` 而非报错） | 子进程探测 |
| `env.workspace` | 当前配置情况 | 当前工作目录地址（复用 `list_work_dirs` 工具的数据源，保证口径一致） | config |
| `env.time` | 当前时间 | 本地日期时间、时区、UTC 偏移、ISO 8601、星期（按产品语言本地化） | 纯本地 |

### 4.2 功能执行系列（family=action）

| id | 用途 | 参数 | 行为与来源 | risk |
|---|---|---|---|---|
| `action.mcp.add` | 添加 MCP 连接 | name、transport(`http`/`stdio`)、endpoint 或 command/args/**env**、auth 模式、可选 **oauthScopes** | 与前案 §5.2.2 入参一致（`env` 为 stdio 环境变量表；`oauthScopes` 非空时传入 SDK `auth()` 覆盖自动解析，语义见前案 P1 第 4 条）：URL/私网校验（endpointPolicy）与重定向拒绝（传输/连接层）→ 保存 profile → 自动 OAuth discovery → 返回结构化结论（支持 DCR / 需 Client ID / 仅 Bearer）。**本期不含 OAuth login 能力**——授权仍需用户在设置页点击；`action.mcp.login/logout/refresh` 作为预留扩展位（见 §7 Phase 3、§1.4） | **act** |
| `action.session.status` | 某会话是否正在运行 | sessionId | 主进程需补「sessionId → 活跃流」登记（现状 `chatCancelRegistry.ts` 以 requestId 为键，需对齐 claudeStreamHandlers 的会话-请求绑定补一层映射） | read |
| `action.session.list` | 分页枚举用户会话 | offset/游标、limit（默认 20，≤50） | 复用 `listSessions`（`operations.ts:129`，注意其返回**全量 `Session[]`**，非轻量 DTO），能力层裁剪为紧凑字段（id/标题/更新时间/运行中标志），兼顾 §6 尺寸上限 | read |
| `action.session.read` | 读取某会话消息 | sessionId、cursor、limit | 按 sequence 游标分页，复用 `getMessagesPage`（`operations.ts:736`，比 offset 分页更适合增量读取）；单条大消息截断为摘要 + 提示 | read |
| `action.mcp.list`（v2.4 追加） | 列出已配置 MCP 服务：启用/连接状态、发现/启用工具数；模型自查「服务已连接但白名单为空」 | 无参数（strict） | 复用 `listProfiles` + 工具缓存计数；只出结构化旗标与计数——**不出 endpoint、不出凭据、`lastError` 仅含 `code`**（原始 message 可能含主机名/URL 或服务端可控文本，属提示注入面，只保留在设置页诊断通道）；「已启用但 0 工具白名单」返回 hint 引导设置页勾选 | read |

> 与既有工具的关系：`switch_session`（切换当前会话）、`list_work_dirs`（列工作目录）已存在且语义不同，能力实现必须复用其数据源而非另起口径；`history.read` 读的是压缩历史事实，`action.session.read` 读的是原始会话消息，两者不重叠但在系统提示中无需刻意区分（`find` 负责路由）。

### 4.3 存量内置工具迁移评估

对现有 16 个内置工具逐个评估「是否收编进能力集合」。判定框架：**低频调用 × 简单 schema × 不在紧密 tool loop 热路径 × 无深度确认/安全集成**，四条同时满足才收编。

| 分类 | 工具 | 结论 |
|---|---|---|
| **首批收编（唯一，1 个）** | `browser_detect` | 环境诊断型，与本集合完全同型：只读、低频（环境装好后基本不再用）、schema 极小（单 boolean 参数）、自带缓存。迁为 `env.browserDetect`（`force` 参数透传）；配套把 `browser` 工具依赖失败文案改为提示「可用 `toolkit.call {id:'env.browserDetect'}` 重新检测」（自描述错误引导发现） |
| 保持独立（领域链路专有 / 已是网关 / 元工具） | `read_feishu_attachment`、`run_lark_cli`、`history.read`、`skills.read` | `read_feishu_attachment` 是飞书链路专有工具（评审定论），与 `run_lark_cli` 同属飞书工具族，收进「自我知觉 + 通用产品功能」集合不符合定位；`run_lark_cli` 本身就是 lark-cli 的网关（一个工具覆盖整个 CLI 面），飞书工作流高频且有专属影响分级（`classifyLarkCliImpact`）；后两者见 §1.2 边界澄清 |
| 保持独立（本身已是网关/元工具） | `run_lark_cli`、`history.read`、`skills.read` | `run_lark_cli` 本身就是 lark-cli 的网关（一个工具覆盖整个 CLI 面），飞书工作流高频且有专属影响分级（`classifyLarkCliImpact`）；后两者见 §1.2 边界澄清 |
| **永不收编（核心热路径，8 个）** | `read_file` `edit_file` `write_file` `list_directory` `grep` `run_script` `run_shell` `browser` | 每个编码任务调用多次，`find→call` 每次多一轮模型往返不可接受；且确认体系的内容抽取器直接解析其入参（`write_file` 自动批准、`run_shell` 计划批准/脚本分析/敏感路径、`browser` act 危险度评估），网关化会破坏这条安全链路 |
| 远程 lane 五件套（不动，5 个） | `list_work_dirs` `switch_work_dir` `switch_session` `wechat_reply` `wechat_send` | 按 lane 门控注入（`toolsConfigRuntime.ts:52-66`：仅远程会话/微信启用时进入工具列表），**不占桌面请求上下文**，迁移无桌面收益；且 toolkit 初期 desktop-only。若未来 toolkit 多 lane 化，可整批评估为 `action.workdir.*` / `action.session.switch` / `action.wechat.*`——IM 场景对紧凑工具面的需求更强，是该模式更好的试验田 |

净效果：18 个现有定义（16 内置 + 2 元工具）收编 `browser_detect` 后为 **19 = 18 + 2 网关 − 1**，比「按功能继续加专用工具」的增长模式仍显著优。诚实地说：**存量迁移空间很小，本方案的主要价值是止住未来的增长**（例如前案差点新增的 `mcp_manage`），而非回收现有上下文——这说明现有工具面本身是健康的。

---

## 5. 与现有架构的集成点

| 层 | 改动 |
|---|---|
| 工具定义 | `src/shared/builtinToolDefinitions.ts` 增加 `toolkit.find` / `toolkit.call` 两条（形态对齐 `history.read`） |
| 工具元数据 | `src/shared/builtinToolMetadata.ts` 是**静态按工具名**的兜底表（`riskLevel` 只是 base 值）：`toolkit.find` → `read/low`；`toolkit.call` 静态兜底取保守值（`act/high`）——动态裁决不靠这张表 |
| 确认体系 | 动态裁决走既有主路径（4 个生产先例：`run_lark_cli` 按 args 分类、`browser` 按 action、`run_script` 静态分析、MCP 按 server+toolName）：给 `toolkit.call` 注册参数提取器，派生 `toolkit-capability:${id}` **信号 token**（先例：`lark-subcommand → lark-${impact}`），policy 规则按 token 配置各能力确认策略——规则 schema 不支持直配 `params.id`，必须经信号；裁决链为 `runExtractors → policyEngine.decide` |
| 确认卡片 | 渲染端按工具名硬编码分发卡片（`ToolCallCard.tsx`），新增 `ToolkitConfirmCard`，载荷复刻 `McpConfirmCard.tsx` 的「网关 + 子实体」先例（能力 summary + 参数 JSON），结构化扩展位用 `ConfirmSummary.sections` |
| 执行器 | `electron/capabilities/` 新模块 + `electron/tools/plannedToolRegistry.ts` 注册 |
| UI 标签 | `src/shared/toolCallLabel.ts`（静态 switch，UI 收到的事件名为 compat 名）新增 compat + 内部名双口径条目（口径随 §3.6 统一）；能力级展示「toolkit.call · env.system」；i18n 补 `zh-CN`/`en-US`（`npm run i18n:generate-types` + `i18n:check`） |
| 审计 | 走既有安全审计 sink；`action.*` 全量记录（含参数摘要，脱敏） |

---

## 6. 安全与策略

**确认矩阵（默认值）**

| 能力 | 默认策略 | 理由 |
|---|---|---|
| `env.*` 全部 | 免确认 | 只读、无敏感数据（不含凭据/消息正文） |
| `action.session.status/list` | 免确认 | 元数据级；与既有跨会话搜索（`search:execute`）同级 |
| `action.session.read` | 免确认 + 审计 | 跨会话读取用户消息属敏感读取：有跨会话搜索先例，但须留审计痕迹；是否加配置开关见 §9 |
| `action.mcp.add` | **需确认** | 写配置 + 发起网络发现；确认卡必须展示完整 endpoint（防诱导配置恶意端点；私网/保留地址拒绝在 `endpointPolicy`，重定向拒绝在传输/连接层——`mcpConnectionManager` 的 302 用例，两层独立兜底） |
| `action.mcp.list`（v2.4 追加） | 免确认 | 只读配置概览：仅服务名/开关状态/计数/存在性旗标与结构化 `lastError.code`；endpoint、凭据、错误 message 均不出能力边界 |

**通用约束**：结果尺寸上限 256 KiB（截断 + 提示）；handler 超时 10s；探测类缓存 10min；spawn 一律参数数组、禁 shell 字符串拼接；结果与日志经 `logSanitize`；凭据零出现——profile 侧沿用 `mcpConfigStore` 的存在性布尔旗标模式（`secretPresent`），与 `logSanitize`（日志脱敏）是两个独立机制的组合。

---

## 7. 分阶段实施与验收

**Phase 1 — 框架 + 环境知觉系列**
前置：B1 回向分发修复落地（§3.6，存量缺陷独立立项），否则网关工具不可分发。
实施：`registry/match` + 两个网关工具 + `env.*` 五能力（含 `browser_detect` 收编为 `env.browserDetect` 及 `browser` 失败文案改造）+ 确认/i18n/标签集成。确认链三处必改：`toolkit.call` 参数提取器与信号 token、渲染端 `ToolkitConfirmCard`、**`toolChatLoop.ts:1671` `confirm-requested` 事件的 `riskLevel` 按工具名硬编码改为采用裁决结果的风险级**（否则 `toolkit.call` 确认卡风险级恒为 `medium`）。
验收：Agent 在对话中 `find → call` 获取环境信息；`find` 未命中返回索引；`history_read`/`skills_read`/`toolkit_*` 经 sanitize→逆映射可正确分发（回归用例）；上下文体积回归达标；`npm run test:renderer`（标签/i18n）与定向 electron 测试绿。

**Phase 2 — 功能执行系列**
`action.session.status/list/read`（含 sessionId→活跃流登记，实施要点见 §9 第 4 条）+ `action.mcp.add`（mcpService 抽取，见前案 §5.2.1）。
验收：分页枚举与游标读取经内存 DB 用例；`mcp.add` 三态结论经**扩展后的 loopback mock server** 覆盖（支持 DCR / 无 DCR 仅预设 / 不支持 OAuth）；确认卡触发与拒绝路径覆盖；以「生财有术」任务形态做演示：Agent 自省环境 → `mcp.add`（用户确认一次）→ 引导用户在设置页完成 OAuth 授权（本期边界，如实告知；端到端恢复见 §1.4）。

**Phase 3 — 扩展能力（按需，模型面零变化）**
注册表加项即可：`action.mcp.login/logout/refresh`（前案 P1 健壮化配套）、`action.session.rename`、`action.config.*` 等。每次新增能力按 §6 矩阵过风险评估，这是本架构的治理门槛。

---

## 8. 测试设计

- `match.ts` 纯函数：精确 id / 关键词打分排序 / family 过滤 / 无命中返回索引（含中文分词边界）。
- `toolkit.call` 契约：未知 id、zod 校验失败、denied（确认拒绝）、handler 抛错、超时——五类结构化错误码。
- env handlers：注入 fake runner（不真 spawn），覆盖超时/缓存 TTL/WSL 探测矩阵（win 非 win × wsl.exe 存在性）。
- session handlers：内存 SQLite，分页游标正确性、运行中标志、空会话。
- `mcp.add`：复用 `mcpOauthService.test.ts` 的 **loopback mock server + `authorize` 回调注入缝**（非 fetch 注入），三态结论需扩展 mock server 端点覆盖（支持 DCR / 无 DCR 仅预设 / 不支持 OAuth——现有缝只覆盖授权码流）；URL/私网拒绝走 `endpointPolicy` 用例，重定向拒绝走传输层用例（`mcpConnectionManager.test.ts` 的 302 先例）；确认触发断言。
- 工具名双向转换（§3.6）：sanitize → 逆映射解析回内部名的往返用例；compat 撞名的构建期报错用例；`history_read`/`skills_read` 分发回归。
- **上下文预算回归**：断言两网关工具 schema 序列化体积 < 2 KiB（防未来无意膨胀）。
- 脱敏快照：构造含 token 形态字段的 handler 返回，断言输出零泄漏。

## 9. 风险与开放问题

1. **两跳成本**：首次使用多一轮 `find`。缓解：系统提示两行索引让模型「知道去查」；`find.usage` 足够详细使同会话后续直接 `call`。若实测命中率低，可在系统提示升级为「id+一句话」紧凑清单（仍远小于逐工具 schema）。
2. **匹配质量**：关键词表靠人工维护；无命中的全量索引兜底可保证不出现「死路」。上线后观察 find→call 转化与重查率再决定是否增强。
3. **`action.session.read` 的隐私边界**：默认免确认 + 审计是否足够，是否提供「跨会话读取需确认」的配置开关，待评审定。
4. **会话运行状态登记**：现状仅按 requestId 登记（`chatCancelRegistry.ts:16`），需补 `Map<sessionId, Set<requestId>>` 反向映射；重入语义是主要坑——`registerChatCancel` 对同 requestId 会先静默 abort 旧 controller（`:19-20`），注册/清理必须挂 `toolChatLoop.ts:486`（注册）与 `:514`（清理）的写点、按 requestId 粒度删除，否则重入 + 旧请求清理会丢登记。
5. **能力即权限**：`toolkit.call` 让「新增能力」变得便宜，治理上必须保持「注册表评审 + 确认矩阵定级」的门槛，防止绕过风险评估直接加能力。
6. **与 `skills` 的概念区分**：skills 是「提示词/流程包」，toolkit 是「产品功能 API」；文档与系统提示措辞需避免混用。

---

## 附：上下文成本估算

| 方案 | 常驻 schema 体积（每请求） | 新增能力时 |
|---|---|---|
| 逐个专用工具（9 个） | ≈ 9 × ~700 token ≈ 6K+ token | 继续线性增长 |
| **本方案（2 网关）** | ≈ 2 × ~350 token + 系统提示 ~60 token ≈ **0.8K token** | **≈ 0**（仅 find 结果一次性进入当轮） |

以现有 18 个内置工具定义为基数（其中 5 个为远程 lane 门控注入，不占桌面请求成本，见 §4.3），桌面常驻口径下本方案避免工具面膨胀约 33%（19→20 而非 19→27，含 `browser_detect` 收编），并为后续所有「产品功能暴露给 Agent」的需求提供固定成本通道。

---

## 修订记录

- **v2.4（2026-09-19）**：新增 `action.mcp.list`（read 免确认，§4.2/§6 已登记）并配套 MCP 空白名单修复（TDD）：
  ① 能力输出安全边界写死——只出服务名/开关状态/计数/存在性旗标与结构化 `lastError.code`；不出 endpoint、不出凭据、不出错误 message（防 endpoint 泄漏与服务端可控文本进入模型上下文/提示注入面），paramsSchema 用 `.strict()` 暴露模型错误调用；
  ② `mcp:refresh-tools` 白名单自动回填——服务启用且 `enabledToolNames` 为空（`action.mcp.add` 创建 + 设置页授权路径的必然产物）时，刷新成功即全选本次发现工具并返回 `autoEnabledToolCount` 供 UI 提示；已有选择不覆盖、禁用不回填；`updateServerStatus` 扩展 `enabledToolNames` 补丁；
  ③ 渲染端同口径：设置页「测试连接」退化分支（存在未命名草稿无法整体落盘）在草稿上自动勾选并提示；`McpServerCard` 增加「已发现 N 个工具，尚未启用」警示横幅；
  ④ OAuth 后台路径防惊吓——`mcp:refresh-tools`/`testConnection` 的 provider 以 `interactive: false` 构造：token 失效时不再静默弹浏览器授权（旧链路无人 `finishAuth`，授权成功后仍以 Unauthorized 失败），转译为 `auth-required` 结构化状态引导用户走「连接账户」。

- **v2（2026-09-17）**：按 `agent-toolkit-capability-gateway-requirement-review.md`（本地评审报告，不入版本控制）修订——① 新增 §3.6「工具名双向转换与分发」（阻断项 B1：逆映射 + 构建期撞名校验 + `history.read`/`skills.read` 存量缺陷前置立项）；② `action.mcp.add` 补齐 `env`/`oauthScopes` 入参（P1-1）；③ 新增 §1.4 端到端目标分期交代，前案 P2③④ 归属 Phase 3（P1-2）；④ 与前案的取代/保留关系精确化为 §5.2.2/§5.2.3（P1-4）；⑤ 确认体系机制归属修正（提取器信号 + `toolkit-capability:${id}` 信号 token，静态元数据表仅兜底；新增确认卡片与 `riskLevel` 硬编码实施项）；⑥ 引用偏差修正（§1.2 字节数、§4.2 `listSessions` 返回形态、§5 `toolCallLabel` 口径、§6 secretPresent 与重定向归属、§8 mock server 测试缝、§9 `Set<requestId>` 重入语义）。
- **v2.1（2026-09-17）**：§3.6 前置任务完成——B1 存量缺陷已按逆映射方案修复（授权白名单切换为内部名口径，分发循环统一回向解析），回归测试 `electron/effectiveTools.compatName.test.ts` 红→绿；定向与依赖关联测试通过，增量构建通过。
- **v2.2（2026-09-18）**：Phase 1 + Phase 2 实施完成（分支 `codex/agent-toolkit-capability-gateway`，TDD 推进）。
  Phase 1（e5fc9770）：`electron/capabilities/`（descriptor/registry/match 纯函数匹配/callCapability 五类结构化错误码/凭据布尔化脱敏）；网关工具 `toolkit.find`/`toolkit.call` 定义与执行器接入（经 §3.6 逆映射分发）；`env.*` 六能力（含 §4.3 首批收编 `env.browserDetect`，`browser_detect` 退出模型面，browser 依赖失败文案与 browser-setup-guide 技能同步改造）；确认链三处必改完成——`toolkit-capability` 提取器 + `toolkit-read`/`toolkit-act`/`toolkit-capability:${id}` 信号 token + defaultRules 双规则、渲染端 `ToolkitConfirmCard`（复刻 McpConfirmCard 先例）、`confirm-requested` riskLevel 改用裁决结果；标签/i18n（zh/en）/lane 隔离（远程会话过滤）；上下文预算回归（两网关 schema < 2 KiB）。
  Phase 2（00ca73be）：`chatActiveStreams` sessionId→活跃流反向登记（按 requestId 粒度删除，重入安全，§9.4）；`action.session.status/list/read`（内存 SQLite 覆盖分页游标/运行中标志/大消息截断，复用 listSessions(user-visible)/getMessagesPage 口径）；`mcpService` 抽取（前案 §5.2.1，addMcpServer + testMcpConnection，mcpIpc 委托同一入口）；`action.mcp.add`（loopback mock server 三态结论 + 私网拒绝 + 确认拒绝路径 + 零凭据泄漏）。
  验收：定向测试全绿；全量 `npm test` 4024 通过（12 失败经基线 commit 比对为 Windows 环境既有失败：symlink 权限/路径分隔符/ripgrep macOS staging，与本案无关）；`npm run build` 全量通过。
  待真机验收（§1.4 边界）：桌面会话 `find→call` 实测、`action.mcp.add` 对真实端点（如生财有术）的结论与设置页授权引导、`npm run dev` 冒烟确认 §3.6 B1 真机端到端。Phase 3（`action.mcp.login/refresh` 等）按需另起。
- **v2.3（2026-09-18）**：按 `agent-toolkit-capability-gateway-code-review.md`（本地评审报告，不入版本控制）完成评审修复（2 阻断 + 6 严重 + 建议项子集）。
  阻断：B1 act 能力入参凭据不再泄入确认/审计链——新增 `src/shared/capabilityParamSanitize.ts`（extractor 摘要与 ToolkitConfirmCard 展示前凭据值布尔化，输入/输出两侧对称）；`SecurityAuditLog` 增补 JSON 形态凭据打码并收紧 `Bearer\s+\S+` 的贪婪吞噬。B2 `addMcpServer` 改追加语义——既有 profile 经 `existingProfilesAsWriteInputs` 合并回全量列表，既有服务与加密凭据保留，重名保存失败。
  严重：S1 `runProbe` 超时/信号杀死归 `code:null`（WSL 不再误报）；S2 `requestLocale`/`lane` 接入 ToolExecutionContext 并透传 CapabilityContext；S3 新增 `getMessagesPageWithSequence`，能力返回真实 sequence（删除空洞不错标）；S4 discovery 前置于落库并带 5s 超时（超时归入结论）；S5 discovery 专用 fetch 手动跟随重定向并逐跳过 endpointPolicy（SSRF 拦截，合成 403 + 拦截态结论文案）；S6 toolkit 系统提示并入 `buildToolCapabilityConventionHint` 按工具面条件注入、使用 compat 名 `toolkit_find`/`toolkit_call`；S7 `confirm-requested` riskLevel 取 max(裁决, medium)。
  建议项：call id 大小写归一、取消语义独立文案、handler 错误消息过 scrubString、结果脱敏键清单补 headerValue/env:、超时经 AbortController 通知 handler、env overrides 不污染单例、session.read notes 口径修正、testMcpConnection 标注共享类型、删除死代码、`ok:false` 以 `success:false` 回报（data 保留）、`confirmedByUser` 纵深防御、metadata 测试断言 browser_detect 已注销、save-failed/stdio-env e2e 用例、env.system 缓存共享入 notes。
  显式取舍（建议项 8）：toolkit.call 的工具入参（如 accessToken）会随 assistant 消息 tool_calls 持久化到 SQLite 与 sessions/ 明文备份——与 run_shell 命令行带 secret 同类既有行为；确认卡/审计链已布尔化，落库链暂沿用现状，后续如需落库前打码另立需求。
- **v2.4（2026-09-18）**：按 `agent-toolkit-capability-gateway-code-review-v2.md`（修复复核轮，本地评审报告，不入版本控制）完成第二轮修复（45d407e5）。
  阻断：R1 确认完成后详情展开明文——`ToolCallCard` 的 paramPreview 对 toolkit.call/toolkit_call 入参走 `sanitizeCapabilityParamsForDisplay`，展示路径彻底关闭。
  严重：S1' `logSanitize` 键级脱敏扩展（精确清单 + 共享 CREDENTIAL_KEY_PATTERN + 复合键宽匹配 + env 表整体脱敏）；S2' `mcpConfigStore.appendServer`——saveProfiles 主体下沉 saveProfilesLocked，「读-合并-写」整体进写锁临界区，addMcpServer 改走 appendServer，并发交错不丢服务。
  建议项：commandTrustedAt 补齐、S5 正向真用例（同源 302→DCR）、discovery 整体 deadline 8s、paramSanitize 专属单测 + 键清单共享常量 + headerName 放行 + env 大小写、审计兜底补高熵凭据前缀值、confirmRequestedRiskLevel 回归测试、act-ask locked 前提固化测试。
  仍开放（跟进级）：建议 4（mcpConnectionManager challenge 元数据 fetch 的 endpointPolicy 接入，预存在）与建议 9（skillPrompt 整体 i18n 化）随后续批次处理。
