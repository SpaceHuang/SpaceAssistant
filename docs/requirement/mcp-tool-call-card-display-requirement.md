# MCP 工具调用卡片展示优化 — 需求规格

**日期：** 2026-09-11
**状态：** 已定稿（决策 D1–D8 已确认；已按评审意见修订，见 [评审报告](../review/mcp-tool-call-card-display-requirement-review.md)；待实施）
**关联文档：** [mcp-integration-requirement.md](./mcp-integration-requirement.md)、[tools-requirement.md](./tools-requirement.md)、[tool-use-id-pairing-requirement.md](./tool-use-id-pairing-requirement.md)、[tool-call-card-batch-collapse-design.md](./tool-call-card-batch-collapse-design.md)、[chat-message-ui-requirement.md](./chat-message-ui-requirement.md)、[评审报告](../review/mcp-tool-call-card-display-requirement-review.md)

---

## 1. 背景与问题

MCP 外部工具已接入（见 `mcp-integration-requirement.md`），但**调用发生后的卡片展示**没有做面向人的设计：聊天区里出现的是映射工具名、原始 JSON 结果和零状态信息。用户看到一次 MCP 调用后，无法回答三个基本问题：**这是哪个服务的哪个工具、它干了什么、执行成功了吗、花了多久。**

### 1.1 问题清单（用户视角）

| 编号 | 问题 | 用户看到的现象 |
|---|---|---|
| P1 | 卡片标题是不可读的映射字符串 | 形如 `mcp_s_hot_list_019ce6b1`，看不出服务与工具语义，也看不出这个工具能干什么 |
| P2 | 执行结果是 JSON 文本 | 形如 `[{"type":"text","text":"<result>…</result>"}]`，既不是原始业务内容，也没有 Markdown/表格/代码高亮；长结果被硬截断且无「查看完整」入口 |
| P3 | 成功/失败不可辨 | 卡片只有内置工具的失败提示与 `tool-row--failed` 类名差异，没有显式状态标识；失败原因混在 JSON 里 |
| P4 | 没有耗时 | 卡片不展示任何时间信息，无法判断是「秒级返回」还是「卡了 60 秒超时」 |

### 1.2 现状实现证据（代码定位）

| 环节 | 现状实现 | 结论 |
|---|---|---|
| 工具名映射 | `src/shared/mcpTypes.ts` `generateMappedToolName()` → `mcp_<serverSlug>_<toolSlug>_<shortHash>`；`slugifyMcpName()` 只保留 `[a-z0-9_]`，服务名 slug 截断 **16** 字符、工具名 slug 截断 **32** 字符；中文服务名（如「知乎热榜」）被清空后回落为服务名兜底 `'s'`（工具名兜底为 `'t'`），末尾拼 8 位 FNV-1a hash | 映射名的设计目标是**唯一性**（满足模型 API 名称约束），本身不承载可读信息；`mcp_s_hot_list_019ce6b1` 中 `s` 即服务名兜底、`hot_list` 为工具名 slug，正是该规则的产物 |
| 行内标题 | `ToolCallCard.tsx` → `label = formatToolLabel(record.toolName, record.input, t)`；`src/shared/toolCallLabel.ts` 的 `default` 分支直接 `return toolName` | MCP 工具名没有 case 分支，直接落到 default，卡片标题就是映射名 |
| 行内图标 | `toolCallDisplay.ts` `getToolIconKind()` 的 `default` → `'generic'`；`ToolRowIcon.tsx` 用 `Wrench` 图标 | MCP 工具与「未知工具」共用扳手图标，无来源区分 |
| 图标 tooltip | `toolCallDisplay.ts` `getToolDescription()` 的 `default` → `tool.descriptions.invokeTool`（"调用工具：{{toolName}}"） | tooltip 同样是映射名 |
| MCP 元数据来源 | `electron/toolChatLoop.ts` 仅在 `needsConfirm` 分支通过 `confirm-requested` 事实下发 `mcp: { serverId, serverName, originalToolName, description }`；`src/shared/assistantFactAggregator.ts` 只在 `confirm-requested` 分支写入 `record.mcp` | **只有走过确认卡片的调用才有 `record.mcp`**。本会话信任后由 gate 判定 `auto-allow` 的调用、以及 `mcp` 字段引入之前的历史消息，都拿不到服务名/原始工具名 |
| 结果展示 | `ToolCallCard.tsx` 的 `resultStr`：`typeof data === 'string' ? data : JSON.stringify(data, null, 2)`（字符串结果**不**二次序列化），包在 `<pre className="sa-chat-inset-code sa-command-inset">` 中，`truncate(text, 4000)` | 未解析 MCP `content` 块语义 |
| MCP 结果结构 | `electron/mcp/mcpToolExecutor.ts` 当前用 `result.structuredContent ?? result.content` 二选一；其中 `content` 是 MCP 协议的块数组（`{ type: 'text', text }` / `image` / `resource`） | 用户看到的 `[{"type":"text",…}]` 只是被 `JSON.stringify` 的协议外壳，真正的业务内容埋在 `text` 字段里；若响应同时含两种字段，当前实现还会丢失 `content` |
| 状态 | 失败态：`showGenericFailureMessage`（`record.result?.userMessage ?? error`）；无成功/拒绝/中断徽标 | 成功与否只能靠「有没有红字」推断 |
| 耗时 | `ToolCallRecord.duration` 已在 `assistantFactAggregator.ts` 的 `tool-result` 分支计算（`deps.now - startedAt`），并在 `electron/messageCodec.ts` 反序列化时保留；`startedAt` / `confirmedAt` / `completedAt` 均已持久化 | 数据**已经存在**，只是渲染层从未读取 |
| 批量折叠概述行 | `ChatBubble` 的 `ActivityBatch` summary 取首个条目的 label（同样来自 `formatToolLabel`） | 折叠后概述行也显示映射名 |
| 底部状态栏 | `src/shared/streamingActivityStatus.ts` 用 `formatToolLabel` 生成 `streaming.awaitingConfirm` / 执行中 label | 执行期间状态条同样显示映射名 |

### 1.3 问题归因

1. **信息缺口**：展示层需要的「服务显示名 + 原始工具名 + 工具描述」没有被稳定地传递到渲染层（依赖确认事实，覆盖不全），也没有渲染层可用的反查通路。
2. **语义缺口**：MCP 结果存在协议封装（`content` 块数组），需要一层「结果 → 人类可读」的解析；当前实现把协议结构原样抛给用户。
3. **状态缺口**：卡片没有状态语义层（成功/失败/拒绝/中断/运行中），成功态完全静默。
4. **指标缺口**：已有 `duration` 数据但未做展示与格式化，执行中也无实时计时。
5. **一致性缺口**：同一工具在「行内卡片 / 折叠概述行 / 底部状态条 / 远程 IM 进度」四处各自取 label，改良时必须统一，否则同一次调用会出现多种叫法。

---

## 2. 目标与非目标

### 2.1 目标

| 编号 | 目标 |
|---|---|
| G1 | MCP 工具卡片标题能唯一、无歧义地回答「哪个服务的哪个工具」，并在 tooltip 中给出「这个工具干什么」。 |
| G2 | MCP 工具结果按协议语义解析后渲染为人类可读内容（文本 / Markdown / 代码 / 图片 / 资源），不再暴露协议 JSON 外壳。 |
| G3 | 卡片显式展示执行状态（运行中 / 成功 / 失败 / 已拒绝 / 已中断），失败时给出可读原因与前往设置页的入口。 |
| G4 | 卡片展示耗时：完成态显示总耗时，执行中显示实时计时；展开态可看到「等待确认 / 实际执行」的拆分。 |
| G5 | 展示数据来源可靠：不依赖「是否走过确认卡片」，历史消息（含字段引入前的老数据）在服务仍存在时也能正确显示。 |
| G6 | 改良对既有链路零破坏：搜索定位、批量折叠、复制、远程 IM 进度、暗色主题、i18n 全部保持一致。 |

### 2.2 非目标

- 不改变映射名生成规则（`mcp_<serverSlug>_<toolSlug>_<hash>` 与其唯一性/稳定性保证保持不动）；映射名只作为**内部标识与诊断信息**，不再作为用户可见主标题。
- 不改变 MCP 的确认策略、并发、超时、审计与安全边界（`mcp-integration-requirement.md` §5、§6 继续有效）。
- 不为 MCP 工具引入「结果脱敏后再交给模型」的语义变更：脱敏只作用于展示、复制与 artifact 落盘（R2.5、R7.5、D8），不改变交给模型的上下文内容。
- 不实现 MCP `resources` / `prompts` / `sampling`。
- 不新增 MCP 服务市场、工具自动推荐等能力。

---

## 3. 需求详述

### R1 卡片标题可读化

#### R1.1 标题格式

MCP 工具的行内主标题统一为：

```
<服务显示名> · <工具名>
```

- 服务显示名：`record.mcp.serverName` → 失败则用渲染层 MCP 目录反查（见 R5）→ 仍失败则 `t('tool.labels.mcpUnknownServer')`（「未知 MCP 服务」）。
- 工具名：`record.mcp.originalToolName` → 失败则用目录反查的 `originalName` → 仍失败则从映射名中解析 `<toolSlug>` 段（去掉 `mcp_` 前缀与末尾 hash）。
- 示例：
  - 有元数据：`知乎热榜 · hot_list`
  - 反查命中：`知乎热榜 · hot_list`
  - 服务已删除：`未知 MCP 服务 · hot_list`
  - 完全无法解析：`外部 MCP 工具（来源未知）`（`tool.labels.mcpUnresolved`）

#### R1.2 tooltip 内容

行内标题的 `title` 属性按以下顺序拼装（最多 3 行）：

1. 服务显示名（+ 服务 ID，便于排障）
2. 原始工具名 + 映射名（映射名以等宽样式展示，供用户复制去设置页搜索）
3. 工具描述（`record.mcp.description` 或目录中的 `description`，截断 200 字符）；描述缺失时显示 `t('tool.mcp.noDescription')`（「该服务未提供工具描述」）

> 安全约束：工具描述来自外部 MCP 服务，属于**不可信文本**，只允许作为纯文本展示（React 默认转义即可），不得渲染 Markdown/HTML，不得注入系统提示或任何指令位置。

#### R1.3 图标

- `getToolIconKind()` 对 `mcp_` 前缀返回新 kind `'mcp'`。
- 决策（已确认）：新增 MCP 专属图标。`ToolRowIcon.tsx` 新增 `'mcp'` 分支，使用 `Plug`（lucide-react，语义为「外部接入」）；不使用内置工具的扳手/电脑等图标，保证用户一眼能区分「内置工具」与「外部 MCP 工具」。
- 图标 tooltip 使用与 R1.2 相同的描述来源，不再显示 `调用工具：mcp_xxx`。

#### R1.4 一致性要求（重要）

同一工具的展示名必须**唯一**。以下位置必须全部改为调用同一个格式化函数（建议新增 `formatMcpToolLabel(record | catalogEntry, t)`）：

| 位置 | 现状 | 要求 |
|---|---|---|
| `ToolCallCard` 行内标题 | 映射名 | 新格式 |
| `ChatBubble` → `ActivityBatch` summary（折叠概述行） | 映射名 | 新格式 |
| `streamingActivityStatus.ts` 的 `awaitingConfirm` / 执行中 label | 映射名 | 新格式 |
| 远程 IM 进度 / 浮动通知中的工具名（`buildRemoteProgressHookContext` 链路） | 映射名（或确认卡文案） | 新格式，至少不出现裸映射名 |
| `McpConfirmCard` 确认卡片 | 已有「服务：X / 原始工具：Y」徽标 | 保持不变，仅确认文案与新格式不冲突 |

> 表中前 4 行为**需要改造**的展示位；末行 `McpConfirmCard` 仅为对照项，确认其无需改造。

#### R1.5 降级与兼容

- 历史消息（持久化时尚未写入 `mcp` 字段）走 R5 目录反查；反查失败不抛错、不显示空白，使用 R1.1 的降级文案。
- 反查所需目录不可用（如 IPC 失败）时，不得阻塞聊天渲染，直接使用降级文案，并在控制台/日志记录一次 warn（脱敏）。

---

### R2 结果可读化

#### R2.1 结果解析（新增共享纯逻辑）

新增 `src/shared/mcpToolResultDisplay.ts`（主/渲染进程共享、无 Node/Electron 依赖），提供：

```ts
export type McpResultBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; byteLength: number; data?: string; previewable: boolean }
  | { kind: 'resource'; uri: string; name?: string; mimeType?: string }
  | { kind: 'unknown'; raw: string }

export type McpResultDisplay = {
  /** 文本块合并结果（多块之间空行分隔） */
  text: string
  /** 结构化内容（structuredContent 或非 content 形态的 data） */
  structured?: unknown
  blocks: McpResultBlock[]
  /** 仅表示展示投影为满足展示上限而发生裁剪，不表示 artifact 丢失正文。 */
  structuredTruncated?: boolean
  unknownTruncated?: boolean
  isEmpty: boolean
}

/**
 * 主进程短期安全脱敏源：按块/字段提供已脱敏的流式可读片段。
 * 不应用展示层的结构化 256 KiB、unknown 16 KiB、实时事件或本地持久化总量上限，
 * 也不得直接传给 renderer、fact 或数据库；artifact 只能从该源生成。
 */
export type McpToolResultSecureEvent =
  | { kind: 'text'; text: string }
  | { kind: 'imagePreview'; mimeType: string; byteLength: number; data: string; previewable: true }
  | { kind: 'imageMetadata'; mimeType: string; byteLength: number; previewable: false }
  | { kind: 'resource'; uri: string; name?: string; mimeType?: string }
  | { kind: 'unknown'; text: string }
  | { kind: 'structured'; jsonChunk: string }

/**
 * 主进程短期安全脱敏源：按原始内容顺序提供可重放的安全事件流。
 * artifact 消费完整脱敏 text/structured/unknown 事件；实时 displayData 只消费有界图片预览，
 * 严禁把图片 preview data 写入 artifact、持久化或搜索。
 */
export type McpToolResultSecureSource = {
  /** 工厂保证每个用途都能从同一规范源获得相同顺序的事件；不得共享一次性迭代器。 */
  events: () => AsyncIterable<McpToolResultSecureEvent>
}

/** MCP 原始双字段结果的专用 envelope；只在主进程短期存在。 */
export type McpToolResultEnvelopeV1 = {
  __spaceAssistantMcpResult: 1
  content?: unknown
  structuredContent?: unknown
}

/** 脱敏后的内存展示投影；可包含通过校验的小图片 base64，不得直接持久化。 */
export type McpToolResultDisplayProjection = {
  __spaceAssistantMcpResult: 1
  blocks: McpResultBlock[]
  text: string
  structured?: unknown
  structuredTruncated?: boolean
  unknownTruncated?: boolean
  isEmpty: boolean
  imagePreviewBytes?: number
  displayMode: 'short' | 'medium' | 'long' | 'huge'
  artifactRequired: boolean
  hasOversizedNonTextContent: boolean
}

/** 持久化 block 严禁携带图片正文；历史 renderer 只消费此类型。 */
export type McpPersistedResultBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; byteLength: number; previewable: false }
  | { kind: 'resource'; uri: string; name?: string; mimeType?: string }
  | { kind: 'unknown'; raw: string }

/** 写入 fact/历史消息的有界展示投影；不包含任何图片 base64。 */
export type McpToolResultPersistedProjection = {
  __spaceAssistantMcpResult: 1
  /** 已解析、脱敏且不含图片 base64 的展示块；历史 renderer 的唯一正文来源。 */
  blocks: McpPersistedResultBlock[]
  text?: string
  /** 递归脱敏、有界序列化后的结构化数据；不得保存原始 structuredContent。 */
  structured?: unknown
  structuredTruncated?: boolean
  unknownTruncated?: boolean
  /** 新写入记录必填；旧消息解码时由版本适配器补齐。 */
  displayMode: 'short' | 'medium' | 'long' | 'huge'
  artifactRequired: boolean
  hasOversizedNonTextContent: boolean
  summary?: {
    blockCount: number
    textChars: number
    textBytes: number
    lineCount: number
    imageCount: number
    resourceCount: number
  }
  truncated?: boolean
  artifactTruncated?: boolean
  artifactUnavailable?: boolean
  artifactSafetyRejected?: boolean
}

export type McpToolResultSizeMetrics = {
  renderTextChars: number
  serializedModelChars: number
  persistedUtf8Bytes: number
  artifactUtf8Bytes?: number
}

export function parseMcpToolResult(data: unknown): McpResultDisplay
```

解析规则（按优先级）：

1. `data` 只有在对象自有字段 `__spaceAssistantMcpResult === 1` 且值严格匹配时，才识别为 `McpToolResultEnvelopeV1`；同时解析其中两字段：`content` 按块映射为 `text` / `image` / `resource` / `unknown`，`structuredContent` 保留其结构但进入展示投影前必须脱敏和有界化；两者都不得互相覆盖。
2. 为兼容旧消息，裸 `data` 为 MCP `content` 块数组（元素为对象且带字符串 `type`）→ 逐块映射。
3. 裸 `data` 为普通对象/数组（旧的 `structuredContent` 形态）→ 全部放入 `structured`，`text` 置空。
4. 裸 `data` 为字符串 → 单 `text` 块。
5. `undefined` / `null` / 空数组 → `isEmpty: true`。

补充语义：只要存在可展示的文本块、图片/资源/未知块或非空结构化数据，`isEmpty` 均为 `false`；仅当所有内容均为空或被安全校验完全丢弃时才为 `true`。`summary.textChars` 只统计脱敏后的文本块字符数，不计结构化 JSON、URI、图片元信息或截断提示。

主进程契约采用“安全脱敏源 + 多用途派生”：`ToolExecutorResult.data` 是**模型投影**，仅供 `formatToolResultPayload`/模型历史使用；原始 `McpToolResultEnvelopeV1` 只在主进程短期存在。主进程先对原始 envelope 做协议校验、敏感片段脱敏、图片正文剥离，并形成不受展示级单块上限影响的短期 `McpToolResultSecureSource`；该源以流式片段保存，不能把超大结构化/unknown 正文整体载入普通展示对象。再从该源分别派生实时 `displayData`、有界 `persistedDisplayData` 和 artifact 序列化结果。安全脱敏源不得直接传给 renderer、fact 或数据库。`displayData` 可供实时 renderer 使用但不得直接写入 fact/数据库；`persistedDisplayData` 供 fact、`record.result.data`、历史 renderer 和搜索使用。`displayData` 与 `persistedDisplayData` 均直接提供解析后的 `blocks/text/structured`，renderer 不得重新读取或解析原始 `content`。所有原始 envelope 必须带 `{ __spaceAssistantMcpResult: 1 }` 判别字段，不得仅凭业务字段识别，也不得再使用 `structuredContent ?? content` 覆盖。解析器对未严格匹配判别字段的普通对象一律按旧 `structuredContent` 处理。模型投影继续使用现有优先级与 `compactResultIfNeeded` 规则，保证本需求不改变模型上下文内容。

其中 `McpResultDisplay.structuredTruncated` / `unknownTruncated` 由展示投影阶段产生，只表示展示投影为满足对应展示上限而裁剪；安全脱敏源和 artifact 候选不得因此丢失正文。派生展示投影传递这些状态；本地总量裁剪另设置 `persistedDisplayData.truncated`，artifact 文件裁剪另设置 `artifactTruncated`，三类状态不得混用。

安全脱敏源的实现必须满足：原始 envelope 只遍历一次；敏感片段在进入中间缓冲前完成脱敏；`events()` 只能读取这次遍历生成的安全中间源，不得在工厂内部再次访问、解析或序列化原始 envelope。各用途通过 `events()` 可重放工厂或同一次遍历的多路分发获得相同顺序的事件。展示投影按事件顺序重建 `blocks`；artifact 可将事件按固定的文本→structured→资源/图片元信息→unknown 顺序写入，但不得因此改变实时展示的 block 顺序。为完成 artifact 重排，只允许使用按类别划分的有限容量 spool；spool 只保存已脱敏片段，合计达到 `MCP_ARTIFACT_MAX_BYTES` 后继续统计字节数但丢弃后续正文，禁止无限缓存。取消、超时或消费者失败时必须关闭迭代器/文件句柄，不得留下可读取的未完成安全源。

**复用边界**：`McpToolResultSecureSource` 不是重新发明一套全局脱敏器，而是 MCP 协议适配层对现有共享能力的编排结果。文本片段复用 `src/shared/agentSafeText.ts` 的 `sanitizeAgentText()` 核心规则；不得直接复用 `electron/tools/toolUserErrors.ts` 的 `sanitizeToolOutput()` 作为 MCP 展示结果，因为其中包含 shell 专用的错误映射和 `ERR_REQUIRE_ESM` 替换。结构化值应从 `src/shared/processResultProjection.ts` 抽取可配置的递归遍历/敏感键识别基础，分别注入模型、MCP 展示、MCP artifact 的 sink 上限；不能直接复用 process tool 的字段白名单或“超限抛错”行为。字节计数、hash、流式写入复用 `electron/shell/outputArtifactWriter.ts`；artifact 路径校验和受控打开通道复用既有 shell artifact 安全校验。MCP 专属新增内容仅限 envelope/block 解析、图片校验、投影边界编排和事件到各用途的适配。

数据用途矩阵（实现与验收必须遵守）：

| 数据用途 | 唯一来源 | 是否脱敏 | 大小/生命周期约束 |
|---|---|---:|---|
| 模型上下文 | `ToolExecutorResult.data` | 否 | 沿用现有模型投影与 1 MiB 字符上限 |
| 实时卡片 | 实时 `tool-result` 事件中的脱敏 `displayData` | 是 | 仅内存/单次事件；图片单图 ≤ 512 KiB、总计 ≤ 2 MiB，整个事件 UTF-8 ≤ `MCP_LIVE_DISPLAY_MAX_BYTES` |
| 历史卡片/搜索 | `persistedDisplayData` → `record.result.data` | 是 | UTF-8 ≤ `MCP_LOCAL_DISPLAY_MAX_BYTES`；不含图片 base64；超限只保留有界预览与元信息 |
| artifact | 规范脱敏结果生成的可读文本 | 是 | UTF-8 ≤ `MCP_ARTIFACT_MAX_BYTES`（16 MiB）；超限设置 `artifactTruncated`；图片只写元信息，不写 base64；TTL 7 天 |
| 复制 | 受控 artifact IPC；失败时 fallback 到 `persistedDisplayData` | 是 | UTF-8 ≤ `MCP_RESULT_COPY_MAX_BYTES`；超限只复制前缀并标记截断 |
| 图片预览 | 解析器输出的短期 `McpResultBlock.image.data` | 已校验 | 单图 ≤ 512 KiB、总计 ≤ 2 MiB；不得进入持久化、搜索或 artifact |
| 结构化数据 | `displayData.structured` 的有界投影 | 是 | 递归脱敏；序列化 UTF-8 ≤ `MCP_STRUCTURED_DISPLAY_MAX_BYTES`；超限只保留摘要并标记 `structuredTruncated` |

上述数据不得跨用途回退：模型占位符不得作为展示/复制内容，未脱敏模型数据不得作为本地展示或 artifact 内容，artifact 也不得回写 `record.result.data`。主进程从安全脱敏源派生 `displayData`，通过实时 `tool-result` 事件传给 renderer；renderer 只直接渲染已解析的 `displayData`，不得再次调用 `parseMcpToolResult()`。同时主进程派生 `persistedDisplayData` 写入 fact/历史；历史 renderer 只读取已解析的 `persistedDisplayData.blocks/text/structured/summary`，不得重新解析或读取原始 MCP envelope。实时事件不得作为历史恢复来源；历史重建可以恢复脱敏、有界的结构化数据，只显示图片元信息，不承诺恢复实时缩略图。

边界：数组元素不是对象、`text` 非字符串、`type` 缺失、超深嵌套等在展示投影中一律降级为 `unknown` 块（`raw` 为脱敏且有界的 `JSON.stringify` 截断片段），并设置 `unknownTruncated`（若发生展示裁剪）；同一内容在安全脱敏源中仍以脱敏流保留，供 artifact 使用。任何路径均**不得抛异常**。

结构化数据专项契约：安全脱敏源对 `structuredContent` 递归脱敏并按流式 JSON 片段保留可读正文，不应用展示级 `MCP_STRUCTURED_DISPLAY_MAX_BYTES`、深度、数组元素数或对象属性数上限；从该源派生 `displayData.structured` / `persistedDisplayData.structured` 时才执行这些展示与持久化限制，超限保留摘要并设置 `structuredTruncated: true`。`structured` 不得携带 token、endpoint、env、图片 base64 或其他未脱敏敏感值；模型投影仍保留原始语义。

未知块专项契约：安全脱敏源对 `unknown.raw` 执行片段级脱敏及图片/base64/凭据载荷剥离，并以流式片段保留可读正文，不在此阶段应用 `MCP_UNKNOWN_RAW_MAX_BYTES`；从该源派生展示和持久化 block 时才应用该上限及最终总量校验，展示裁剪设置 `unknownTruncated: true`。renderer、搜索和复制均不得把它当作未处理原文使用，异常协议块也不能绕过展示、搜索或存储边界。

图片块专项契约：`image.data` 必须是严格校验通过的 base64；仅允许 `image/png`、`image/jpeg`、`image/gif`、`image/webp`，主动内容格式（包括 SVG）不得生成 `<img>`。解析时按 base64 解码后的字节数计算 `byteLength`，不是 base64 字符数；仅当 MIME 在白名单内、base64 合法且 `byteLength <= 512 * 1024` 时，在安全事件流中生成 `imagePreview` 事件并保留原始 base64（仅用于实时受控预览），否则只生成 `imageMetadata` 事件，`previewable: false`，不抛异常。解析结果对单图及全部图片预览数据设内存上限（512 KiB/图、总计不超过 2 MiB），超限即只生成元信息；图片数据不得写入搜索索引或 artifact 文本。

#### R2.2 渲染规则

| 内容形态 | 渲染方式 |
|---|---|
| 纯文本（非 Markdown 特征） | 等宽 `<pre>`，保留换行（沿用 `sa-command-inset` 视觉） |
| Markdown 特征文本（含 `#`/`\|`/`-`/```/表格等，或 JSON 解析失败时的富文本） | 复用 `ChatMarkdown` 渲染（代码块走 Shiki 高亮、表格可复制） |
| 文本本身是 JSON（`JSON.parse` 成功且为对象/数组） | 代码块 + `json` 高亮 + 默认折叠至 12 行 |
| 文本是 XML/HTML 片段 | 代码块 + `markup` 高亮，转义显示（不执行、不注入 DOM） |
| `image` 块 | 展示「图片结果 · `<mimeType>` · 约 `<KB>`」；解析器仅对允许的图片 MIME 与合法 base64 解码后计算 `byteLength`，≤ 512 KiB 且通过校验时保留 `data` 并渲染缩略图，超过或校验失败时不保留正文、不渲染 `<img>`，只显示元信息 |
| `resource` 块 | 展示资源名 + URI（URI 需按展示规则处理成不可点击纯文本或经 `pathSecurity` 白名单后才可点击） |
| `isEmpty` | `t('tool.mcp.resultEmpty')`（「工具返回空结果」） |
| `structured` 非空 | 追加「结构化数据」小节，JSON 代码块 + 折叠 |

渲染实现位于新组件 `src/renderer/components/Chat/McpToolResultView.tsx`，由 `ToolCallCard` 在 `record.mcp`（或目录判定为 MCP 工具）时替代现有 `resultStr` 的 `<pre>` 分支；非 MCP 工具保持现状，避免影响内置工具回归。

**职责与懒渲染约束**：主进程在结果进入实时事件或持久化链路前无条件完成协议解析、校验、脱敏和投影裁剪；renderer 不调用 `parseMcpToolResult()`，也不重新脱敏。只有在卡片展开（`showDetail`）时才进行 Markdown/JSON/XML 判型、富文本转换、高亮和正文 DOM 挂载；收起态不执行这些渲染操作，避免长列表滚动时重复开销。

#### R2.3 状态显式化

行内右侧新增状态徽标（与耗时徽标相邻，见 R3）：

| 记录状态 | 徽标文案（i18n key） | 视觉 |
|---|---|---|
| `calling` / `executing` | 运行中（`tool.status.running`） | 次级色 + 轻量 pulse（`prefers-reduced-motion` 下静态） |
| `completed` 且 `result.success` | 成功（`tool.status.success`） | 成功色 |
| `failed` | 失败（`tool.status.failed`） | 危险色 |
| `failed` 且 `interrupted` | 已中断（`tool.status.interrupted`） | 危险色 |
| `rejected` | 已拒绝（`tool.status.rejected`） | 次级色 |
| `confirming` | 待确认（`tool.status.awaitingConfirm`） | 强调色 |

要求：

- 徽标必须是**文本 + 颜色**双重编码，不能只靠颜色（色盲可达性）。
- 成功态徽标是新增信息，需保证不干扰现有 `.tool-row__label` 的单行截断（label 保持 `flex: 1; min-width: 0`，徽标 `flex-shrink: 0`）。
- 失败态除徽标外，保留现有错误文案区域，并新增「打开 MCP 服务设置」链接按钮：跳转「设置 → 工具 → MCP 服务」并定位到 `record.mcp.serverId`（或目录反查到的 serverId）；无法定位时只打开设置页。

#### R2.4 超长结果与渲染分层（性能门限）

> 结论先行：**现状不会卡（结果被 `truncate(text, 4000)` 截断到 4000 字符），但本需求一旦放开「展开全部 + Markdown 解析 + Shiki 高亮」，超长结果在展开时会出现可感知卡顿。** 因此下面的分层门限属于 **P0 必做项**，不是后续优化。

##### R2.4.1 卡顿从哪来（风险点清单）

以下操作都在渲染进程主线程同步执行，开销随结果长度增长：

| 风险点 | 触发条件 | 影响 |
|---|---|---|
| Markdown → AST 解析（remark-gfm + rehype） | 展开且判定为 Markdown | 文本越长解析越慢；体积到 MB 级时是明显的长任务（**具体量级须按 R2.4.4 实测校准**） |
| Shiki 语法高亮 | 展开且命中代码块 / JSON / markup | 需加载 grammar + theme 再 tokenize，大块代码是单次同步长任务 |
| DOM 节点数暴涨 | 表格、长列表、高亮后每个 token 一个 `<span>` | 样式计算与布局耗时显著上升 |
| KaTeX 渲染 | 结果含 `$…$` / `$$…$$` | 公式数量多时叠加额外开销 |
| base64 图片内联 | `image` 块的 `data` 直接进 `<img>` | 字符串解析 + 内存占用高 |
| 脱敏正则扫描 | 主进程生成展示投影时执行 | 必须使用线性规则并按投影上限处理；不得在 renderer 展开时重复扫描 |
| 列表高度重算 | 展开使卡片变高 | `react-virtuoso` 需重新测量，可能造成滚动位置跳动 |
| 批量折叠反复挂载 | 批次收起/展开 | 若收起态仍解析渲染，滚动整段历史时开销被反复放大 |

##### R2.4.2 分层门限（按单个结果文本的字符数）

> **单位口径**：本节阈值以**字符数**为准，表中 KB 均指 `1024 字符`（即 8 KB = 8 192 字符、64 KB = 65 536 字符、512 KB = 524 288 字符）。注意与 R2.2 中 `image` 块的 `512 KiB`（**字节**，base64 解码后大小）口径不同，勿混用。

| 区段 | 文本长度 | 收起态 | 展开态 | Markdown | Shiki 高亮 | 脱敏 |
|---|---|---|---|---|---|---|
| 短 | ≤ 8 KB | 不渲染正文 | 按语义完整渲染 | ✅ | ✅ | ✅ |
| 中 | 8–64 KB | 不渲染正文 | 前 20 行 + 「展开全部（共 N 行）」；点击后再渲染完整内容 | ✅ | ✅（单块上限 64 KB） | ✅ |
| 长 | 64–512 KB | 不渲染正文 | 前 20 行 + 「展开全部」；完整内容**以纯文本渲染**（不解析 Markdown、不高亮） | ❌ | ❌ | ✅ |
| 超大 | 文本 > 512 KB，或 `hasOversizedNonTextContent === true` | 只显示元信息（块数 / 大小 / 行数） | 不渲染完整正文；显示脱敏前缀（若持久化投影有前缀）+ 元信息，并提供「复制结果」与（P2）「打开完整内容」（若 artifact 本身被 16 MiB 上限截断，必须同时显示截断状态） | ❌ | ❌ | ✅（分块执行） |

- 门限常量集中在共享模块（如 `MCP_RESULT_RENDER_LIMITS`）定义，便于测试与后续调节；上表数值为**初值**，须由 R2.4.4 实测结论校准后写回本文档。文本结果的四档使用 `renderTextChars`；非文本结果由 `hasOversizedNonTextContent` 覆盖进入“超大”档；本地持久化只使用 `persistedUtf8Bytes`；模型压缩只使用 `serializedModelChars`；artifact 与复制只使用各自 UTF-8 字节数，不得用其他口径替代。
- 「展开全部」是显式用户意图：点击后先渲染前 20 行并显示 `t('tool.mcp.renderLoading')` 加载态（避免点击无反馈），完整渲染放进 `React.startTransition` / `useDeferredValue`，保证点击与滚动仍响应。
- 收起态不执行 Markdown/JSON/XML 判型、高亮或正文 DOM 挂载；脱敏已在主进程投影阶段完成，不能下沉到展开态，保证实时事件、历史记录、搜索和复制使用同一脱敏结果。
- 纯结构化、unknown、资源或图片元信息结果不依赖 `renderTextChars` 进入分层：只要其安全脱敏源派生过程触发展示截断或 artifact 触发条件，就设置 `hasOversizedNonTextContent`，按“超大”档显示元信息，并在存在有效 artifactId 时提供打开入口。
- 后端模型上限继续有效：`mcpToolExecutor.ts` 仅对模型投影 `data` 在 `serialized.length > 1024 * 1024`（约 1,048,576 **字符**，非字节）时替换为占位符；`displayData` 不被该步骤覆盖，`persistedDisplayData` 按 R7.3.3 的本地上限生成。命中模型截断时提示 `t('tool.mcp.truncated')`。本门限与 R2.4.2 同以字符数计，测试造数据时勿按字节。

##### R2.4.2.1 门限的作用域：与「执行中 / 已完成」无关（重要澄清）

**门限是「按结果文本长度」约束渲染路径，不是「按执行阶段」约束。** 具体语义：

1. **执行期间不存在结果内容可渲染。** `tool-progress` 是**通用**进度通道：`electron/toolChatLoop.ts` 为每次工具执行提供 `sendProgress`，内置工具（如 `run_shell` / `run_script`）经 `ctx.sendProgress` 调用，触发 `tool-progress` 事实下发。MCP 的 `tools/call` 是一次性返回、没有增量结果流，`mcpToolExecutor.ts` **未调用** `ctx.sendProgress`，因此 MCP 无 `tool-progress`。因此 MCP 卡片在 `calling` / `confirming` / `executing` 期间只展示**标题 + 状态徽标 + 实时耗时**（以及 `t('tool.pending')` 提示），「不高亮」在这一阶段是无意义的——根本没有内容。
2. **门限在展示投影落盘后生效，且永久生效。** 结果写入 `record.result.data`（即有界 `persistedDisplayData`）后，是否解析 / 高亮只由该展示文本的长度与截断标记决定，**与工具是否刚执行完、以及用户何时回看历史无关**；完整超大结果从 artifact 读取，不回写消息库。
3. 因此对「> 512 KB」的正确理解是：**在聊天区永久不解析、不高亮**，无论执行刚结束还是几个月后回看历史消息。它不会在"执行完之后补上高亮"。同理 64–512 KB 档也永久走纯文本。
4. P2 的「打开完整内容」（artifact 落盘）是在**独立查看器**中打开已脱敏 artifact，不会把高亮结果搬回聊天区；若 artifact 超过 `MCP_ARTIFACT_MAX_BYTES`，查看到的是带截断状态的有界结果，因此不破坏本门限。
5. 若未来接入 MCP `notifications/progress`（协议允许）向渲染层推送增量文本，实时增量必须走与 `run_shell` 实时输出一致的**纯文本、不高亮**通道（参考 `ShellOutputView` 的 `isLive` 分支），避免出现两套实时渲染策略。

##### R2.4.3 复制路径

- 提供「复制结果」按钮，复制**脱敏后的可读文本**（不是协议 JSON、也不是未脱敏原文）。
- 复制为异步操作：长文本复制期间按钮显示进行中态。artifact 存在时通过 R7.3.2 的受控 IPC 读取已脱敏内容，最多复制 `MCP_RESULT_COPY_MAX_BYTES = 1 MiB` 的 UTF-8 字节；因此文案称“复制结果”，不得声称复制全文，超过上限时只复制前缀并追加 `t('tool.mcp.truncated')`。artifact 不存在时复制 `persistedDisplayData` 中的有界可读前缀/摘要并按同一规则提示，绝不复制模型占位符。

##### R2.4.4 性能验证方法（必须执行，不得只靠肉眼）

- 新增渲染性能测量用例（参考现有 `src/renderer/components/Chat/ChatMessageList.perf.measure.test.tsx` 与 `npm run perf:chat-list`）：
  - 用例 A（单卡展开）：结果文本 8 KB / 64 KB / 512 KB 三档，测量「点击展开 → 内容可交互」的耗时。初定目标：8 KB < 100 ms、64 KB < 300 ms；512 KB 档**不触发解析/高亮**（纯文本路径），故其展开耗时应不高于 64 KB 档。实测后把门限与结论回写 R2.4.2。
  - 用例 B（列表回退基线）：200 条消息、其中 20 条带 MCP 结果，滚动时 `ToolCallCard` 的渲染次数与总耗时不得劣于改造前基线。
- 人工验证见 MN5。

##### R2.4.5 滚动位置稳定性

- 展开导致卡片高度变化时，必须保持用户当前阅读位置（`react-virtuoso` 的 `followOutput` / `listRef` 锚定策略），不得因展开大结果把视口弹走；搜索定位（`ChatSearchActiveTarget`）的强制展开同样适用。

#### R2.5 脱敏

> 决策（已确认）：**结果展示文本与复制文本一律脱敏**，不提供「查看原始结果 / 复制原始结果」入口。

- 结果文本在渲染前执行与确认卡同族的敏感模式掩码（复用 `src/shared/mcpTypes.ts` 的 `detectSensitiveParamValue` 思路，新增共享纯函数 `maskSensitiveText()`），掩码项包括：`Bearer`/`Authorization:`、`sk-*`、`ghp_*`、`xox*`、`glpat-*`、JWT、≥32 位 hex。
- 掩码必须是**片段级替换**（只替换命中的 token 片段），不得因命中而丢弃整段文本，避免把正常业务文本（例如含 `token` 字样的说明）误伤成一片 `[REDACTED]`。
- 掩码作用于**展示投影、复制文本和 artifact**；模型投影保持原始语义，不改变交给模型的上下文。`record.result.data` 若保存 `persistedDisplayData`，必须保存已脱敏且受 `MCP_LOCAL_DISPLAY_MAX_BYTES` 限制的版本；不得保存未脱敏原文。搜索索引只允许使用已脱敏展示文本，并遵循 R4 的 fragment 约定。
- 性能约束：掩码正则为线性、无嵌套量词（规避回溯爆炸）；由主进程在投影生成阶段执行，> 512 KB 文本分块执行（见 R2.4.2），renderer 收起/展开均不重复执行。
- 单测必须断言：掩码后的原文不出现在 DOM 文本与剪贴板载荷中（例如 `expect(container.textContent).not.toContain('ghp_xxx')`）。

---

### R3 耗时展示

#### R3.1 数据来源

- 已完成/失败/拒绝记录：`record.duration`（`assistantFactAggregator.ts` 在 `tool-result` 时写入，`messageCodec.ts` 持久化保留）。
- 执行中记录：实时计时**统一以 `record.startedAt` 为起点**（端到端口径，与完成态一致）——这样走过确认的调用在「执行中 → 完成」瞬间数字单调递增，不会从「执行 4s」跳到「12.3s」；展开态的「执行」净耗时另以 `confirmedAt ?? startedAt` 为起点单独计算。
- 缺失全部时间戳（老数据、`corrupted` 占位）时不显示耗时徽标，不显示 `NaN`/`--`。

#### R3.2 展示规则

> 决策（已确认）：行内耗时展示**端到端总耗时（含等待用户确认的时间）**，与 `record.duration` 的现有口径一致；展开态再拆分「等待确认 / 执行」。

| 状态 | 行内展示 | 展开态补充 |
|---|---|---|
| `calling` / `executing` | 实时计时（每秒更新，如 `3s`、`12s`；统一以 `startedAt` 为起点） | 「等待确认 8s · 执行 12s」 |
| `completed` | `12.3s`（成功色/次级色） | 「等待确认 8s · 执行 12.3s · 总计 20.3s」 |
| `failed` | `60.0s` | 同上 + 超时提示（若错误文案含超时语义） |
| `rejected` | 不显示执行耗时；如可计算则显示「等待确认 8s」 | 同左 |

#### R3.3 格式化

新增 `formatToolDuration(ms: number): string`（建议放 `src/shared/toolDurationFormat.ts`，与 `formatStreamingElapsed` 同族）：

| 区间 | 输出 | 示例 |
|---|---|---|
| < 1000ms | `<n>ms` | `820ms` |
| < 60s | `<n.n>s`（1 位小数，整数秒显示为 `12s`） | `3.4s` / `12s` |
| ≥ 60s | 走 `tool.duration.minutes`（zh：`{{minutes}} 分 {{seconds}} 秒`） | `1 分 03 秒`（zh）/ `1m 03s`（en） |

- 数字使用 `tabular-nums`，避免计时跳动导致布局抖动。
- 文案走 i18n（`tool.duration.milliseconds` / `tool.duration.seconds` / `tool.duration.minutes`），不硬编码单位。

#### R3.4 性能约束

- 实时计时挂在状态为 `calling` 或 `executing` 的卡片上，且使用**独立叶子计时组件**（参考 `ChatRunningElapsed` 的设计：组件内部持有秒级 `now`，只让自身重渲染），不得让 `ChatMessageList` / `ToolCallCard` 列表整体每秒重渲染。这样自动放行、未发送 `tool-progress` 的 MCP 调用也能覆盖完整执行期间。
- 多个并发执行卡片共享同一个 tick 源（建议单例 `setInterval` + 订阅），避免 N 个计时器。
- 卡片进入终态后立即卸载计时器。

---

### R4 搜索、复制与主题一致性

- **搜索定位**：MCP 结果视图必须保留 `data-search-fragment-id={resultFragmentId}`，且 `paramPreview` / 结果文本的 fragment 约定不变，保证跨会话搜索「命中 MCP 工具结果」仍能定位与高亮（`chatSearchFragments`）。
- **复制**：新结果视图复用 `writeClipboardText`；表格复制沿用 `ChatMarkdown` 的表格复制能力。
- **主题**：只使用现有 token（`--sa-text-*`、`--sa-success`、`--sa-danger`、`--sa-warning`、`--sa-icon` 等），不新增颜色；必须同时验证暗色与亮色（参考 `docs/spaceassistant-agent-architecture.visual-check.*.png` 的对比检查方式）。
- **动效**：状态徽标与计时更新遵循 `prefers-reduced-motion`（`scrollIntoViewWithMotionPreference` 同族约定）。

---

### R5 元数据来源补齐（数据通路）

#### R5.1 主进程补齐（推荐，解决根因）

`src/shared/assistantFactAggregator.ts` 的 `tool-use` 事件增加可选字段：

```ts
| {
    type: 'tool-use'
    id: string
    toolName: string
    input: Record<string, unknown>
    riskLevel?: ToolCallRecord['riskLevel']
    /** 外部 MCP 工具来源（仅在工具名命中 MCP 快照时下发，不进入模型上下文） */
    mcp?: { serverId: string; serverName: string; originalToolName: string; description?: string }
  }
```

- `record` 构造处（`assistantFactAggregator.ts` 的 `tool-use` 分支）写入 `mcp`。
- 发送方 `electron/toolChatLoop.ts` 在发出 `tool-use` 事实时，用已存在的 `mcpSnapshot.entries`（与 `resolveMcpExecutor` 使用同一请求级快照）填充 `mcp`，与是否 `needsConfirm` 无关。
- 兼容性：字段可选，老持久化数据无该字段时走 R5.2；`messageCodec` 的序列化/反序列化不需要改动（`mcp` 已在其中）。
- 安全：`serverName` / `originalToolName` / `description` 均为可读非敏感字段（`mcpTypes.ts` 顶部已有「本文件类型一律可读、非敏感」的约束），不得携带 token、endpoint、env 值。

#### R5.2 渲染层目录反查（兜底，覆盖历史消息）

- 新增 `src/renderer/services/mcpToolCatalog.ts`：启动时与「设置页保存/刷新 MCP 配置后」调用 `window.api.mcpList()`（返回 `McpConfig`，含 `servers` 与 `toolCaches[serverId].tools[]`，每项含 `serverId` / `originalName` / `mappedName` / `description`），构建：

```ts
type McpToolCatalogEntry = {
  serverId: string
  serverName: string
  originalToolName: string
  description?: string
}
// 索引：mappedName → entry（映射名稳定，服务改名不影响反查）
export function resolveMcpToolFromCatalog(toolName: string): McpToolCatalogEntry | undefined
```

- 目录数据规模小（≤20 服务 × 工具列表），使用 `Map` 缓存；`mcpList()` 失败时保留上一次结果并记录 warn，不阻塞聊天。
- 反查命中优先于「映射名解析」降级；`record.mcp` 优先于反查（历史记录里保存的服务名更能反映当时的真实来源）。
- 该模块必须可单测（纯函数 + 注入式数据源，不直接依赖 `window`，便于 Vitest 测试）。

---

### R6 远程 IM 与浮动通知一致性

- 飞书 / 微信远程会话的进度与确认文案（`buildRemoteProgressHookContext` 链路、`onRemoteToolStateChange`）中涉及 MCP 工具名时，同样使用 R1 的格式化结果，避免远程侧出现裸映射名。
- 浮动通知（`FloatingNotification`）若展示工具名，同上。

---

### R7 超长结果 artifact 落盘（P2，对应 D5）

> 适用场景：结果文本超过 R2.4.2 的「超大」档（> 512 KB），或非文本块/结构化数据使 artifact 达到触发条件；聊天区不再渲染完整正文，改为「元信息 + 可用前缀 + 复制 + 打开 artifact」。本节定义落盘形态。

#### R7.0 复用边界：复用「机制」，不是复用「数据」（重要澄清）

现状是 `run_shell` 的落盘**已完整实现**，但它落的**只是 shell 的 stdout/stderr**；**MCP 结果目前完全没有落盘这一步**（`mcpToolExecutor` 在序列化后 > 1,048,576 字符（约 1 MiB）时直接 `compactResultIfNeeded` 替换为占位符就结束）。因此不存在「MCP 结果已经在文件里、直接读就行」——必须新增写入调用点。

| 层次 | 能否复用 | 说明 |
|---|---|---|
| **落盘逻辑（代码）** | ✅ 直接复用 | `OutputArtifactWriter` 是通用类（流式 `append`、内部累计 bytes/sha256、超 `maxBytes` 停写、`close()` 保证关 fd）。`append` 在 `open` 前会先缓冲，调用顺序无约束。需新增的只是**调用点**（在 `mcpToolExecutor` 内写入 MCP 专属目录）。 |
| **已生成的落盘文件（数据）** | ❌ 不可复用 | `shell-output/*.log` 内容全部为 shell 输出，不含 MCP 结果；无现成 MCP 文件可读。 |
| **打开通道** | ⚠️ 复用但需扩展 | `shell:open-output-path` 目前仅识别 `artifact-<64hex>` 且根目录白名单为 `shell-output`；需新增 `artifact-mcp-` 前缀分支（R7.3）。 |
| **清理逻辑** | ⚠️ 复用但需补齐调用点 | `cleanupExpiredOutputArtifacts` **已有调用方**——`electron/tools/runShellExecutor.ts` 在每次 `run_shell` 执行时惰性调用它（`artifactDirectory = {userDataDir}/shell-output`，TTL 7 天）。但该函数**只遍历顶层文件**（`if (!entry.isFile()) continue`，子目录被跳过，其单测亦断言保留 nested 目录），且只在执行 shell 命令时才触发。因此 `mcp/` 子目录需**另行调用**，见 H2。 |

> H1 来自「落盘逻辑可复用、但 MCP 尚无写入调用点」；H2 来自「清理逻辑可复用、但覆盖不到 `mcp/` 子目录且无启动清理」。两者都不是"能力缺失"，而是"调用点未补齐"。

#### R7.1 既有机制清单（可复用部分）

`run_shell` 已有一套成熟的输出落盘与打开链路，本需求**复用而非新造**：

| 环节 | 现状实现 | 位置 |
|---|---|---|
| 落盘目录 | `{userData}/shell-output/` | `electron/tools/runShellExecutor.ts`（`artifactRoot = path.resolve(ctx.userDataDir, 'shell-output')`） |
| 文件名 | `<sha256(toolUseId)>.log` | 同上 |
| 写入器 | `OutputArtifactWriter`：流式 append、内部累计 bytes 与 sha256、超过 `maxBytes` 立即停止写入、`close()` 返回 `{ path, bytes, sha256 }`；即使写失败也保证关闭 fd | `electron/shell/outputArtifactWriter.ts` |
| 大小上限 | `max(ioMax * 20, 2 MB)` | `electron/tools/runShellExecutor.ts` |
| 引用主键 | `artifactId = artifact-<64hex>`；无法安全暴露时为 `REDACTED_ARTIFACT_ID`（渲染层不得用它调用打开接口） | `src/shared/processResultProjection.ts` |
| 打开通道 | IPC `shell:open-output-path`：仅接受 `artifact-<64hex>` 或绝对路径，且**必须落在 `shell-output` 目录内**，否则返回 `INVALID_PATH` | `electron/appIpc.ts` |
| 渲染层入口 | `ShellOutputView` 在 `truncated` 时渲染「输出已截断，打开完整日志 →」，调用 `window.api.shellOpenOutputPath()` | `src/renderer/components/Chat/ShellOutputView.tsx` |
| 清理 | `cleanupExpiredOutputArtifacts(directory, maxAgeMs)` 按 mtime 淘汰（仅顶层文件，跳过子目录）；已由 `runShellExecutor` 在每次 shell 执行时惰性调用，TTL 7 天 | `electron/shell/outputArtifactCleanup.ts` |

#### R7.2 必须一并解决的两个既有隐患（前置修复项）

| 编号 | 隐患 | 影响 | 处理 |
|---|---|---|---|
| H1 | **`compactResultIfNeeded` 会先丢弃原文**：`mcpToolExecutor.ts` 对序列化后 > 1 MiB 的结果调用 `compactOversizedToolResultContent()`，把内容整体替换为 `[tool_result omitted: content exceeded limit; originalLength=…; maxChars=…]` 占位符 | 若在压缩**之后**才想落盘，原文已经不存在，「打开完整内容」必然打不开 | **调整顺序：先 artifact 落盘（拿原文）→ 再压缩交给模型**。落盘与「给模型的上下文」是两条独立通路 |
| H2 | **清理覆盖不到 `mcp/` 子目录、且无启动清理**：`cleanupExpiredOutputArtifacts` 已被 `electron/tools/runShellExecutor.ts` 在每次 shell 执行时惰性调用（TTL 7 天），但其实现**只遍历顶层文件**（`if (!entry.isFile()) continue`，子目录被跳过），且只在执行 shell 命令时才触发 | MCP 结果若落在 `mcp/` 子目录，永远不会被现有调用清理；用户长期不执行 shell 命令时，顶层文件也不会被回收 | 对 `shell-output/mcp` 单独接一次清理（启动时 + 可选每日）；TTL 与总量上限见 R7.5 |

> H1 是**先于 R7 的阻塞项**（否则「打开完整内容」是空功能）；H2 同样是 R7 的**必要配套**（否则 `mcp/` 下文件不回收）。注意二者的真实性质都是「调用点未补齐」，而非"既有能力缺失"。

#### R7.3 目录与命名（推荐方案 A2）

现有 IPC 的路径防护只允许 `shell-output` 根目录下的文件，因此**不能随意选目录**。两种可行方案：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A1 同目录混放 | MCP 结果直接写 `shell-output/<sha256(toolUseId)>.log`，复用 `artifact-<64hex>` 主键 | 零 IPC 改动 | 与 shell 输出混放，无法按来源分别清理 / 限量；`.log` 承载 JSON 语义模糊 |
| **A2 同根子目录（推荐）** | 写 `shell-output/mcp/<sha256(toolUseId)>.log`，主键 `artifact-mcp-<64hex>`；IPC 增加该前缀分支（先判 `artifact-mcp-` 再判 `artifact-`），**根路径校验仍复用 `shell-output` 白名单** | 与 shell 输出隔离，可独立 TTL / 限量；改动约 5 行；路径防护零放松 | 需小幅改 IPC |

A2 具体约定：

- 文件名：`mcp/<sha256(toolUseId)>.log`（沿用 sha256 主键，天然唯一、无用户输入参与、无路径遍历风险）。
- 引用主键：`artifact-mcp-<64hex>`，由**主进程直接给出**（MCP 结果不走 `processResultProjection` 的路径反推逻辑，无需新增反推规则）。
- 打开复用 `window.api.shellOpenOutputPath(artifactId)`，复制使用新增的受控 `window.api.mcpCopyResultArtifact(artifactId, maxBytes)`；不得让 `shellOpenOutputPath` 隐式承担读取职责，renderer 不感知目录差异。

#### R7.3.1 artifactId 独立数据契约（阻断项修订）

- `ToolExecutorResult` 增加可选 `artifactId?: string`；`mcpToolExecutor` 在生成超大结果 artifact 后，通过该字段返回引用，**不得把 artifactId 拼入 `data`**。
- `ToolCallResultPersisted` 与 `ToolCallRecord` 增加同名可选字段；`toolChatLoop` 写入 fact 时分别传递结果 envelope 与 `artifactId`，`assistantFactAggregator`、`messageCodec` 序列化/反序列化时保持该字段。
- `artifactId` 是仅供本地展示/打开 artifact 的元数据，不得进入 `formatToolResultPayload`、模型消息、模型历史或搜索正文；模型仍只接收压缩后的 `data`。
- 实时消息与历史重建必须使用同一字段：实时完成后可打开，应用重启后从持久化记录恢复仍可打开；缺失或 `REDACTED_ARTIFACT_ID` 时按 R7.6 隐藏入口。
- 影响面至少覆盖 `ToolExecutorResult`、`ToolCallResultPersisted`、`ToolCallRecord`、`toolChatLoop`、`assistantFactAggregator`、`messageCodec` 及 renderer 的消息编解码/投影测试；不得以修改模型结果形态的方式兼容旧链路。

#### R7.3.2 artifact 复制读取通路

- 新增 IPC `mcp:copy-result-artifact` 及公开 API `window.api.mcpCopyResultArtifact(artifactId, maxBytes)`；renderer 只传 `artifact-mcp-<64hex>`，不得传绝对路径、相对路径或 shell artifact ID。
- 主进程复用打开通道的 artifact ID 格式校验、`shell-output` 根目录白名单和 `realpath` 越界校验，再读取 `shell-output/mcp/<64hex>.log`；读取按 UTF-8 字节上限分块执行，不把超过上限的全文载入内存。截断元数据固定为同目录的 `mcp/<64hex>.meta.json`，只能由主进程按 artifactId 拼接访问，不能由 renderer 传入路径。
- 主进程仅返回 `{ ok: true, text, truncated }` 或 `{ ok: false, error }`，或直接在主进程写入剪贴板；其中 `truncated` 必须在“读取超过 `MCP_RESULT_COPY_MAX_BYTES`”或 artifact 的 `artifactTruncated === true` 任一条件成立时为 `true`。artifact 的截断状态随 MCP artifact 的受控元数据（与正文同目录、同 ID 绑定、不可由 renderer 指定路径）保存，复制通路不得仅凭本次读取长度判断。返回/写入内容必须是已脱敏 artifact，失败不得暴露路径、原文或堆栈。统一复制上限为 `MCP_RESULT_COPY_MAX_BYTES = 1 MiB`。
- 伪造 ID、shell artifact ID、路径穿越、正文或元数据文件不存在、读取失败均拒绝或返回可识别失败；元数据缺失或格式非法时必须保守返回 `truncated: true`，不得误报为完整结果。renderer 降级复制有界 `persistedDisplayData`，只在 `truncated === true` 时显示截断提示，不产生未捕获异常。

#### R7.3.3 双投影与本地持久化上限

- `ToolExecutorResult` 增加 `displayData?: McpToolResultDisplayProjection`、`persistedDisplayData?: McpToolResultPersistedProjection` 与 `sizeMetrics?: McpToolResultSizeMetrics`；`data` 始终是模型投影，`displayData` 仅供实时 renderer，`persistedDisplayData` 始终是历史/搜索投影，三者不得互换。`mcpToolExecutor` 从可重放的安全脱敏事件流分别派生 `displayData` 与 `persistedDisplayData`；artifact 使用该流的独立消费实例，不得因某一用途先消费流而使其他投影缺正文。`displayMode`、`artifactRequired` 和 `hasOversizedNonTextContent` 必须同时写入实时 `displayData` 与持久化 `persistedDisplayData`；`toolChatLoop` 另将 `sizeMetrics` 写入 fact/持久化记录。
- 本地展示投影按 `MCP_LOCAL_DISPLAY_MAX_BYTES = 1 MiB`（UTF-8 字节）限制；图片正文还必须遵守 R2.1 的单图 512 KiB、总计 2 MiB 内存上限，并在持久化前剥离所有图片 base64，仅保留 MIME、解码后字节数和预览状态。
- `structured` 使用独立的 `MCP_STRUCTURED_DISPLAY_MAX_BYTES`、最大深度、数组长度和对象属性数限制；`unknown.raw` 使用 `MCP_UNKNOWN_RAW_MAX_BYTES` 限制。上述限制只在主进程内存展示投影和持久化投影阶段生效，不能因字段类型为 `unknown` 而豁免；artifact 使用未经过这些展示级裁剪的安全脱敏源。
- 当展示投影超过本地上限时，`persistedDisplayData` 只保留：脱敏文本前缀（明确 `MCP_LOCAL_DISPLAY_PREVIEW_BYTES` 上限）、持久化 block、块数、文本总字符数/字节数、行数、图片/资源元信息、`truncated: true`；`unknown.raw` 也必须经过展示级大小限制、脱敏和图片/base64 载荷剥离。完整已脱敏可读文本/结构化内容仅从安全脱敏源写入 R7.5 artifact，并通过独立 `artifactId` 关联；不得从被裁剪的 `displayData` 或 `persistedDisplayData` 回填 artifact。
- 生成持久化投影后必须对 `JSON.stringify(persistedDisplayData)` 的 UTF-8 字节数做最终校验，结果必须 ≤ `MCP_LOCAL_DISPLAY_MAX_BYTES`。仍超限时按“结构化数据摘要 → unknown 摘要 → 文本前缀”的顺序继续收缩，直至满足上限，并设置 `truncated: true`；不得用单字段上限代替最终总量校验。新写入记录必须保存 `displayMode`、`artifactRequired` 和 `hasOversizedNonTextContent`；读取旧消息时由版本适配器按已有内容计算一次并写入内存投影，renderer 不得自行猜测或重新解析原始 MCP envelope。
- 实时 `tool-result` 事件单独受 `MCP_LIVE_DISPLAY_MAX_BYTES` 限制；若 displayData 超过该上限，先剥离图片预览、再收缩结构化数据和文本，事件仍须可安全发送，且不影响 artifact 与模型投影。
- 初始常量固定为：`MCP_LIVE_DISPLAY_MAX_BYTES = 2 MiB`、`MCP_STRUCTURED_DISPLAY_MAX_BYTES = 256 KiB`、`MCP_UNKNOWN_RAW_MAX_BYTES = 16 KiB`、`MCP_LOCAL_DISPLAY_PREVIEW_BYTES = 64 KiB`、`MCP_ARTIFACT_TRIGGER_BYTES = 512 KiB`、`MCP_ARTIFACT_MAX_BYTES = 16 MiB`、`MCP_ARTIFACT_MAX_DEPTH = 64`、`MCP_ARTIFACT_MAX_NODES = 100,000`、`MCP_ARTIFACT_MAX_EVENTS = 100,000`。前六项是 UTF-8 字节上限，后三项是 artifact 安全遍历上限；若性能实测需调整，必须同步更新本文档和自动化验收。
- 512 KiB–1 MiB、>1 MiB、超过本地持久化上限三档必须分别定义并测试：模型 payload、`record.result.data`/`persistedDisplayData`、artifact 是否存在及其内容。任何情况下不得把模型占位符写入展示投影冒充完整结果。

#### R7.4 落盘时机与条件

- **时机**：主进程 `mcpToolExecutor` 拿到 `tools/call` 结果后，先完成协议校验、流式脱敏、图片正文剥离并建立 `McpToolResultSecureSource`；随后从该源独立生成 artifact 候选，同时从该源派生受展示上限约束的 `displayData` 和 `persistedDisplayData`。按同一规则计算 `displayMode` 与 `artifactRequired`，完成 artifact 判定/落盘后，最后仅对模型投影执行 `compactResultIfNeeded`（见 H1）。artifact 不得从被裁剪的展示投影生成，也不得重新读取或序列化原始 envelope。
- **条件**：artifact 候选按固定顺序从安全脱敏源生成（文本、完整脱敏结构化 JSON、资源/图片元信息、完整脱敏 unknown 内容），计算未受文件总上限裁剪前的 `artifactUtf8Bytes`；当 `artifactUtf8Bytes > MCP_ARTIFACT_TRIGGER_BYTES`（初始值 512 KiB），或展示投影的 `persistedDisplayData.truncated === true`，或展示投影的 `structuredTruncated` / `unknownTruncated` 标记为 `true` 时必须落盘，并将 `artifactRequired` 设为 `true`。这里的展示截断标记只负责触发 artifact，不代表 artifact 候选已丢失对应正文。安全源超过 `MCP_ARTIFACT_MAX_DEPTH`、`MCP_ARTIFACT_MAX_NODES` 或 `MCP_ARTIFACT_MAX_EVENTS` 时停止 artifact 生成，设置 `artifactSafetyRejected: true` 与 `artifactUnavailable: true`，不得伪装为 `artifactTruncated`。不得只用 `renderTextChars` 判断，确保纯结构化、资源块和未知块超限时也能恢复。
- **不得影响调用结果**：落盘失败（磁盘满、权限）时，`tool-result` 仍按正常成功返回；仍保存有界、脱敏的 `persistedDisplayData`，并标记 `truncated: true` / `artifactUnavailable: true`，卡片隐藏「打开完整内容」、保留「复制结果」并复制该摘要，显示真实截断提示，同时记一次 warn；不得让工具调用失败。
- **异步**：落盘使用 `OutputArtifactWriter` 的流式写入。`artifactRequired === true` 时，工具结果必须等待正文与 metadata 原子提交完成后再返回，以保证返回的 `artifactId` 可用；只有不需要 artifact 的结果才可完全异步。artifact 写入耗时不得阻塞 renderer 的渲染线程，取消/超时仍须关闭写入句柄并按失败状态返回。

#### R7.5 内容格式、上限与清理

- **格式**：artifact 按固定顺序消费安全脱敏事件流并写入可读内容：①文本事件；②完整脱敏 structured 事件（受 artifact 总上限约束，不受展示级 256 KiB/深度/数量上限约束）；③资源与图片元信息事件；④完整脱敏 unknown 事件（受 artifact 总上限约束，不受展示级 16 KiB 单块上限约束）。各部分使用明确的小节标题和换行分隔；不得重新读取或序列化原始 envelope，`imagePreview` 事件只取其 `mimeType` / 解码后 `byteLength` / `previewable`，**不写 base64 正文**。
- **脱敏**：写入内容为**已掩码**版本（D8，与 D1 一致——不提供查看原始内容的入口）。在 `MCP_ARTIFACT_MAX_BYTES` 内，artifact 内容完整覆盖其待落盘序列化结果；超过上限时只保证有界前缀，不得再称为“完整内容”。
- **单文件上限**：固定为 `MCP_ARTIFACT_MAX_BYTES = 16 MiB`（**字节**；`OutputArtifactWriter` 按 `Buffer` 累计字节数判定 `maxBytes`）。超限时停止写入，设置 `artifactTruncated: true`，并写入 `mcp/<64hex>.meta.json`（至少包含 `artifactId`、实际写入 `bytes`、`sha256` 和 `truncated: true`）；正文文件与元数据文件必须同生、同清理，目录总量限制按两者合计。正文和元数据先写入同目录临时文件，完成、关闭并校验后再分别原子 rename；任一最终文件缺失或校验失败，artifact 按不可用处理，不得展示为完整结果。文件尾部可尽力写入可识别的「已截断」标记，但不能以尾部标记作为唯一判定依据。卡片、打开和复制路径都必须传播该状态。
- **路径安全**：沿用 `OutputArtifactWriter` 的 `mkdir -p` + 既定根目录；文件名不含任何用户输入。
- **清理**：沿用 **TTL 7 天**（与现有 `run_shell` 输出清理、`imProcessedStore` 保留期一致）+ **目录总量上限先到者生效**，最旧优先删除；清理结果记入 agent 日志。**关键点（H2）**：该函数只处理顶层文件、会跳过子目录，故 A2 下必须对 `shell-output/mcp` **单独接一次调用**（启动时 + 可选每日），不能依赖 `runShellExecutor` 里那次（它只扫顶层、且只在执行 shell 时触发）。若改用 A1（同目录混放），则可复用现有调用，但 MCP 文件会与 shell 输出共享同一 TTL / 限额。
- **崩溃恢复**：正文临时文件和元数据临时文件统一使用 `.tmp` 后缀；启动清理时删除过期 `.tmp`，并删除缺少配对正文/元数据、ID/hash 不匹配或校验失败的孤儿最终文件。读取通道只有在正文和元数据均存在且匹配时才返回 artifact 可用；任一文件处于临时/孤儿状态都按不可用处理，不向用户暴露半成品。

#### R7.6 渲染层入口

- 触发条件：`status === 'completed'` 且存在有效 `artifactId`（非空、非 `REDACTED_ARTIFACT_ID`）。文本超长或 `hasOversizedNonTextContent === true` 均可触发该 artifact 入口，不得额外要求 `renderTextChars > 512 KB`。
- 文案：`t('tool.mcp.openFullContent')`（「打开完整内容」）。
- 若 `persistedDisplayData.artifactTruncated === true`，按钮旁必须显示 `t('tool.mcp.truncated')`；此时「打开完整内容」的语义是“打开已脱敏的 artifact 结果”，不得对用户承诺包含超过 16 MiB 上限的全部内容。
- 打开失败（IPC 返回 `INVALID_PATH` 或 `shell.openPath` 报错）：不弹红色错误，降级为轻提示 `t('tool.mcp.openFailed')`，并保留「复制结果」入口。
- 打开方式为**系统默认程序**（`shell.openPath`），不是内置查看器；若后续要内置查看，需另评估 content viewer 的文件白名单（本期不做）。
- 历史回看场景：老消息若 artifact 已被 TTL 清理，点击后走上述失败降级，不出现死按钮。

#### R7.7 备选方案（何时才值得做）

若未来需要「内置查看器打开、按来源分别设置 TTL 与配额、保留原始（未脱敏）内容」三者同时满足，再引入独立的 `mcp:open-result-artifact` 通道与 `mcp-results/` 目录，并抽取共享的「artifact 根目录白名单校验」helper（目前两处校验逻辑分散在 `appIpc.ts`）。在此之前 A2 足够。

---

## 4. 交互与视觉规范

- 单行结构（在现有 `.tool-row__main` 内）：

```
[图标] 知乎热榜 · hot_list          [成功] 12.3s   [chevron]
```

- 徽标样式：`12px` 字号、`--sa-radius-sm` 圆角、`padding 1px 6px`、无边框（Flat-By-Default）；状态色用 `color-mix(in srgb, var(--sa-success|--sa-danger|--sa-text-tertiary) 12%, transparent)` 作底、文字取实色。
- 徽标顺序固定：**状态 → 耗时**，均 `flex-shrink: 0`；两者与 chevron 间距 `6px`，与 label 间距 `8px`。
- 展开态信息顺序：结果内容（R2）→ 「查看详情」折叠区（参数摘要 → 结构化数据 → 阶段耗时）→ 已有操作按钮（取消/打开设置）。
- 触达 hover 时不得因徽标出现/消失引起行高变化（徽标常驻，不做 hover 显隐）。

---

## 5. i18n 新增 key（`chat` 命名空间为例）

| key | zh-CN | en-US |
|---|---|---|
| `tool.labels.mcpTool` | `{{server}} · {{tool}}` | 同结构 |
| `tool.labels.mcpUnknownServer` | `未知 MCP 服务` | `Unknown MCP server` |
| `tool.labels.mcpUnresolved` | `外部 MCP 工具（来源未知）` | `External MCP tool (unknown source)` |
| `tool.mcp.noDescription` | `该服务未提供工具描述` | `No description provided by this server` |
| `tool.mcp.resultEmpty` | `工具返回空结果` | `Tool returned an empty result` |
| `tool.mcp.structuredData` | `结构化数据` | `Structured data` |
| `tool.mcp.imageResult` | `图片结果 · {{mimeType}} · 约 {{size}}` | `Image result · {{mimeType}} · ~{{size}}` |
| `tool.mcp.resourceResult` | `资源：{{name}}` | `Resource: {{name}}` |
| `tool.mcp.expandAll` | `展开全部（共 {{count}} 行）` | `Expand all ({{count}} lines)` |
| `tool.mcp.renderLoading` | `正在渲染结果…` | `Rendering result…` |
| `tool.mcp.resultMeta` | `{{blocks}} 个结果块 · 约 {{size}}` | `{{blocks}} result blocks · ~{{size}}` |
| `tool.mcp.openFullContent` | `打开完整内容`（P2） | `Open full content` |
| `tool.mcp.openFailed` | `无法打开完整内容` | `Failed to open full content` |
| `tool.mcp.copyResult` | `复制结果` | `Copy result` |
| `tool.mcp.copied` | `已复制` | `Copied` |
| `tool.mcp.openSettings` | `打开 MCP 服务设置` | `Open MCP server settings` |
| `tool.mcp.truncated` | `结果过大已截断` | `Result truncated (too large)` |
| `tool.status.running` | `运行中` | `Running` |
| `tool.status.success` | `成功` | `Success` |
| `tool.status.failed` | `失败` | `Failed` |
| `tool.status.rejected` | `已拒绝` | `Rejected` |
| `tool.status.interrupted` | `已中断` | `Interrupted` |
| `tool.status.awaitingConfirm` | `待确认` | `Awaiting confirmation` |
| `tool.duration.milliseconds` | `{{value}}ms` | 同 |
| `tool.duration.seconds` | `{{value}}s` | 同 |
| `tool.duration.minutes` | `{{minutes}} 分 {{seconds}} 秒` | `{{minutes}}m {{seconds}}s` |
| `tool.duration.waitingConfirm` | `等待确认 {{value}}` | `Waiting for confirmation {{value}}` |
| `tool.duration.execution` | `执行 {{value}}` | `Execution {{value}}` |
| `tool.duration.total` | `总计 {{value}}` | `Total {{value}}` |

- 落地要求：`npm run i18n:generate-types` 后类型可用；`npm run i18n:check` 通过；`zh-CN` 与 `en-US` 同步补齐。

---

## 6. 影响面清单

| 类型 | 文件 | 改动 |
|---|---|---|
| 新增 | `src/shared/mcpToolResultDisplay.ts`（+ `.test.ts`） | MCP 结果解析纯函数 + `maskSensitiveText()`（R2.5） |
| 新增 | `src/shared/mcpResultRenderLimits.ts` | 超长结果分层门限常量（R2.4.2） |
| 修改 | `electron/mcp/mcpToolExecutor.ts` | 建立流式安全脱敏源；从该源分别生成脱敏内存 `displayData`、有界 `persistedDisplayData`、artifact 与独立模型 `data`，仅压缩模型投影（R7.3.3、R7.4）；超阈值时返回独立 `artifactId` |
| 修改 | `electron/appIpc.ts` | `shell:open-output-path` 支持 MCP artifact；新增 `mcp:copy-result-artifact` 受控读取 IPC（R7.3、R7.3.2） |
| 新增/修改 | MCP artifact 写入器接线（复用 `electron/shell/outputArtifactWriter.ts`） | 落盘至 `shell-output/mcp/`（R7.3） |
| 修改 | 启动清理链路（`electron/main.ts` 附近） | **H2**：新增对 `shell-output/mcp` 的 `cleanupExpiredOutputArtifacts` 调用（启动 + 可选每日）——该函数跳过子目录、且既有调用只在执行 shell 时触发；顶层 `shell-output` 既有清理保持不变（R7.5） |
| 修改 | `src/renderer/components/Chat/ToolCallCard.tsx`（接线新增的 `McpToolResultView`） | 「打开完整内容」按钮与失败降级（R7.6） |
| 新增 | `src/renderer/components/Chat/McpToolResultView.perf.measure.test.tsx` | 超长结果展开耗时测量（R2.4.4） |
| 新增 | `src/shared/toolDurationFormat.ts`（+ `.test.ts`） | 耗时格式化 |
| 新增 | `src/renderer/services/mcpToolCatalog.ts`（+ `.test.ts`） | 渲染层 MCP 目录反查 |
| 新增 | `src/renderer/components/Chat/McpToolResultView.tsx`（+ `.test.tsx`） | MCP 结果视图 |
| 新增 | `src/renderer/components/Chat/ToolStatusBadge.tsx` / `ToolDurationBadge.tsx`（可合并） | 状态与耗时徽标（含 leaf 计时） |
| 修改 | `src/renderer/components/Chat/ToolCallCard.tsx` | 标题分支、状态/耗时徽标、MCP 结果视图接线 |
| 修改 | `src/renderer/components/Chat/toolCallDisplay.ts` | `getToolIconKind` 增加 `mcp`；`getToolDescription` 支持 MCP |
| 修改 | `src/renderer/components/Chat/ToolRowIcon.tsx` | 新增 `mcp` 图标分支（`Plug`） |
| 修改 | `src/renderer/components/Chat/ChatMarkdown.tsx` | **D6**：新增 `fragmentKindPrefix` / `allowLocalFileLinks` / `enableMath` 三个可选 props（默认值保持现有行为） |
| 修改 | `src/shared/chatSearchFragments.ts` | **D6 连带**：`SearchSource` 新增 `tool-result-text/-code/-math`、`sourceIdentityKey` 新增分支、为 MCP 结果产出细分片段（§9.4.1） |
| 修改（待确认） | `src/renderer/services/markdownSearchProjection.ts` | **D6 连带**：仅当选择为非 `assistant-*` 前缀复用该投影时才需参数化（§9.4.1） |
| 修改 | `src/shared/toolCallLabel.ts` | 新增 MCP 标签分支（或新增独立 `formatMcpToolLabel` 并从 `formatToolLabel` 调用） |
| 修改 | `src/shared/streamingActivityStatus.ts` | 状态条 label 走新格式化 |
| 修改 | `src/renderer/components/Chat/ChatBubble.tsx`（`ActivityBatch` summary 生成处） | 概述行 label 走新格式化 |
| 修改 | `src/shared/assistantFactAggregator.ts` | `tool-use` 事件可选 `mcp` 字段；`ToolCallRecord` / `ToolCallResultPersisted` 增加可选 `artifactId` 展示引用 |
| 修改 | `electron/toolChatLoop.ts` | 下发 `tool-use` 事实时填充 `mcp`；实时 `tool-result` 事件传递有界 `displayData`，同时将 `persistedDisplayData` 与独立 `artifactId` 写入 fact/持久化链路，不带入模型 payload |
| 修改 | `src/renderer/theme/layout.css` | 徽标样式（`.tool-row__status`、`.tool-row__duration` 等） |
| 修改 | `src/renderer/i18n/resources/{zh-CN,en-US}/chat.json` | 新增 key |
| 修改 | `src/renderer/components/Chat/ToolCallCard.test.tsx`、`toolCallDisplay.test.ts` | 补充断言 |
| 可选 | 远程 IM 进度文案链路（`electron/remote/`、`buildRemoteProgressHookContext`） | R6 一致性 |

---

## 7. 验收标准

### 7.1 功能验收（可在单测/组件测试覆盖）

| 编号 | 验收项 |
|---|---|
| AC1 | 给定 `record.mcp = { serverName: '知乎热榜', originalToolName: 'hot_list' }`，行内标题渲染为 `知乎热榜 · hot_list`，`title` 含描述与映射名 |
| AC2 | 无 `record.mcp`、但目录反查命中 `mcp_s_hot_list_019ce6b1` 时，标题与 AC1 一致（覆盖「本会话信任后自动放行」路径） |
| AC3 | 目录也未命中时，标题为 `未知 MCP 服务 · hot_list`；映射名无法解析时为 `外部 MCP 工具（来源未知）`，且无控制台异常 |
| AC4 | `data = [{ type: 'text', text: '## 标题\n\n- a\n- b' }]` 渲染为 Markdown（不是 JSON），且展示 `成功` 徽标 |
| AC4.1 | `data = { __spaceAssistantMcpResult: 1, content: [{ type: 'text', text: '可读文本' }], structuredContent: { total: 2 } }` 同时展示可读文本与「结构化数据」；实时消息与历史重建结果一致，且两部分均未丢失 |
| AC4.2 | 旧裸结构化对象 `{ content: '业务正文', title: '示例' }` 与 `{ structuredContent: { total: 2 }, title: '示例' }` 均整体按 `structured` 展示，不被误判为 envelope；只有 `__spaceAssistantMcpResult === 1` 的对象走 envelope 分支 |
| AC4.3 | 有效 ≤ 512 KiB 的 PNG 图片块在安全事件流中保留已校验 base64 与解码后 `byteLength`，实时 `displayData` 渲染 `<img>` 缩略图；> 512 KiB 的图片不保留 `data` 且不渲染 `<img>`；伪造 MIME 或无效 base64 只显示元信息且不抛错，任何图片 base64 均不进入 artifact/持久化 |
| AC5 | `data = [{ type: 'text', text: '{"hot":{"title":"x"}}' }]` 渲染为 `json` 高亮代码块，默认折叠 |
| AC6 | `result = { success: false, error: 'MCP 工具调用超时（60000ms 无响应）…' }` 展示 `失败` 徽标 + 可读错误 + 「打开 MCP 服务设置」按钮 |
| AC7 | `status = 'completed'` 且 `duration = 12300` 展示 `12.3s`；`duration = 820` 展示 `820ms`；`duration = 63000` 展示 i18n 分钟格式 |
| AC8 | 自动放行且无 `tool-progress` 的 MCP 调用从 `calling` 到 `tool-result` 期间展示以 `startedAt` 起算的实时耗时、每秒递增；`executing` 同样覆盖；进入终态后停止更新 |
| AC9 | `data` 为空数组/`null` 时展示 `工具返回空结果`，不展示空 `<pre>` |
| AC10 | 结果文本含 `Bearer abc`、`ghp_xxx` 时，卡片展示、`record.result.data`、artifact 与剪贴板载荷均为 `[REDACTED]`；模型投影不因展示脱敏而改变 |
| AC11 | MCP 结果**外层** `data-search-fragment-id`（`tool-result:{toolUseId}`）与改造前一致，搜索命中仍能定位并高亮；引入 D6 细分片段后，同一文本不被重复索引 / 重复高亮（§9.4.1） |
| AC12 | `ActivityBatch` 概述行与 `streamingActivityStatus` label 对同一记录输出与行内标题一致的文案 |
| AC13 | `prefers-reduced-motion: reduce` 下状态徽标无 pulse 动画 |

### 7.2 边界与回归

| 编号 | 验收项 |
|---|---|
| AC14 | 非 MCP 内置工具（`read_file` / `run_shell` / `browser` 等）卡片视觉与行为零回归（现有 `ToolCallCard.test.tsx` 全部通过） |
| AC15 | 老数据（无 `mcp` 字段、无 `duration`）渲染不报错、不显示占位符 |
| AC16 | 无 `window.api.mcpList`（IPC 失败）时仍能渲染，使用降级文案并记录一次 warn |
| AC17 | `calling` / `executing` 卡片的秒级计时更新不引起其他卡片或消息列表整体重渲染（以渲染计数断言；收起态解析开销由 AC21 覆盖，列表滚动基线由 AC22 覆盖） |
| AC18 | 暗色/亮色截图对比检查（沿用项目 visual-check 方式），无对比度低于 4.5:1 的徽标文本 |

### 7.3 性能与 artifact 验收（对应 R2.4 / R7，必须有自动化用例）

| 编号 | 验收项 |
|---|---|
| AC19 | 结果文本 8 KB 时「展开 → 可交互」< 100 ms；64 KB 时 < 300 ms（由性能测量用例输出实际值并回写 R2.4.2） |
| AC20 | 结果文本 > 512 KB（以及 64–512 KB 档）**永久**走纯文本 / 元信息路径：不调用 Markdown 解析、不调用 Shiki 高亮，且断言在「执行刚结束」与「历史回看（重新挂载组件）」两种时点下均成立（以调用计数断言） |
| AC21 | 收起态（含批次收起）对任意长度结果均不执行 Markdown/JSON/XML 判型、富文本转换、高亮与正文 DOM 挂载；主进程投影阶段已完成解析与脱敏（以 renderer 调用计数及主进程投影断言覆盖） |
| AC22 | 200 条消息（含 20 条 MCP 结果）滚动时渲染次数与耗时均不高于改造前基线（复用 `npm run perf:chat-list`） |
| AC23 | 展开超大结果后滚动位置不跳动（锚定断言，并配合 MN5 人工复核） |
| AC24 | 结果 > 512 KB 时落盘成功且返回有效 `artifactId`（`artifact-mcp-<64hex>`）；在 `MCP_ARTIFACT_MAX_BYTES` 内落盘内容为**已脱敏**的完整可读 artifact，超限时设置 `artifactTruncated: true` 并显示真实截断状态；均不含 base64 正文（R7.5） |
| AC24.1 | MCP 结果在改造前**不会**产生任何落盘文件（R7.0 事实校验）；改造后仅新增 `shell-output/mcp/` 下的文件，不触碰既有 shell artifact |
| AC25 | **H1 顺序断言**：结果 > 1,048,576 字符（约 1 MiB）时，落盘文件在未超过 `MCP_ARTIFACT_MAX_BYTES` 时包含完整的**已脱敏 artifact**（而非 `[tool_result omitted…]` 占位符）；若超过文件上限则包含有界已脱敏前缀并设置 `artifactTruncated`，同时交给模型的内容仍为压缩后的占位符 |
| AC25.1 | 完成结果的 `artifactId` 通过 `ToolExecutorResult` → fact → `ToolCallResultPersisted` / `ToolCallRecord` 独立字段传递；模型 payload 与模型历史均不含 `artifactId` |
| AC25.2 | 实时完成卡片可用有效 `artifactId` 打开 artifact；重启后历史重建卡片仍可打开同一 artifact |
| AC25.3 | 512 KiB–1 MiB、> 1 MiB、超过 `MCP_LOCAL_DISPLAY_MAX_BYTES` 三档分别断言：模型只收到模型投影（必要时为占位符），实时内存投影可按规则包含小图预览，持久化只含有界 `persistedDisplayData`；artifact 从安全脱敏源生成，在 `MCP_ARTIFACT_MAX_BYTES` 内保留完整已脱敏文本、结构化数据和 unknown 内容及块元信息，超限才设置 `artifactTruncated`；图片 base64 不进入持久化或 artifact |
| AC25.4 | 复制通过 `mcp:copy-result-artifact` 读取合法 MCP artifact，最多复制 `MCP_RESULT_COPY_MAX_BYTES = 1 MiB` 前缀；读取超过上限或 artifact 带 `artifactTruncated` 状态时均返回 `truncated: true` 并追加 `tool.mcp.truncated`。artifact 缺失时降级复制有界展示前缀/摘要，不复制模型占位符 |
| AC25.5 | 合法 MCP artifact 可复制；shell artifact、伪造 ID、路径穿越、文件已清理和读取失败均被拒绝或安全降级，不暴露路径/原文且无未捕获异常 |
| AC25.6 | 数据用途矩阵的隔离约束成立：模型投影、展示投影、artifact、复制和图片预览分别使用规定来源；未脱敏内容与图片 base64 不进入 `record.result.data`、搜索索引或 artifact；持久化 block 类型在编译期不允许 `image.data` |
| AC25.7 | 主进程通过实时 `tool-result` 事件传递 `displayData`；实时 renderer 直接从一次解析生成的 `displayData.blocks/text/structured` 渲染，且 block 顺序与安全事件流一致；历史 renderer 只从 `persistedDisplayData.blocks/text/structured/summary` 渲染；两者不再读取或重新解析原始 `content`，同一结果的文本和结构化数据一致 |
| AC25.7.1 | 仅含 `structuredContent` 的结果 `isEmpty === false`；空文本但有结构化数据时历史重建仍显示结构化数据，`summary.textChars` 不计结构化 JSON、URI、图片元信息或提示文案 |
| AC25.8 | 超深/超大的 `structuredContent` 在安全脱敏源中不抛异常且不保留敏感值；展示/持久化投影超过各自深度、数量或 `MCP_STRUCTURED_DISPLAY_MAX_BYTES` 限制时仅保留摘要并设置 `structuredTruncated`，artifact 在自身 16 MiB 上限内仍保留完整已脱敏结构化可读内容 |
| AC25.9 | 非法或未知结果块的 `unknown.raw` 在安全脱敏源中完整执行片段级脱敏及图片/base64/凭据剥离；展示/持久化投影再应用 `MCP_UNKNOWN_RAW_MAX_BYTES`，发生展示裁剪时设置 `unknownTruncated`，其内容不得绕过搜索、复制或持久化边界 |
| AC25.9.1 | 仅含约 2 MiB `structuredContent` 或单个/累计超过 16 KiB 的 unknown 内容时，展示投影为有界摘要并设置对应展示截断标记；若 artifact 总候选未超过 `MCP_ARTIFACT_MAX_BYTES`，artifact 仍包含完整已脱敏结构化/unknown 可读内容，且 `artifactTruncated === false` |
| AC25.9.2 | artifact 总候选超过 `MCP_ARTIFACT_MAX_BYTES` 时才设置 `artifactTruncated === true`；artifact 文件、受控元数据、打开状态和复制返回值均传播该状态 |
| AC25.9.3 | 正文和 `.meta.json` 均通过临时文件写入、校验后原子提交；模拟进程中断或任一文件缺失时，artifact 不被标记为可用完整结果，且复制/打开安全降级 |
| AC25.9.4 | 同一结果在实时完成、历史重建和纯结构化/unknown 场景下使用同一 `displayMode` / `artifactRequired` 判定；`renderTextChars === 0` 但 `artifactRequired === true` 时仍显示元信息和有效 artifact 入口 |
| AC25.9.5 | 模拟敏感信息出现在日志、异常、调试输出、远程进度或错误 payload 中时，所有非模型链路均不包含原文；artifact 临时文件、孤儿文件和失败堆栈也不向 renderer 或用户暴露 |
| AC25.9.6 | 实时 `displayData`、历史 `persistedDisplayData` 和 artifact 均从同一可重放安全事件流派生；合法小图片只在实时 `displayData` 保留 base64，artifact/持久化中只保留图片元信息，且三者的文本、结构化数据和 block 顺序符合各自契约 |
| AC25.9.6.1 | 复用现有文本脱敏、递归投影、artifact 写入和路径校验基础能力；MCP 只新增协议/block 适配，不直接复用 shell 专用错误映射或 process tool 字段白名单 |
| AC25.9.7 | 对同一 MCP envelope，原始解析/脱敏遍历只执行一次；`events()` 的多次消费均来自安全中间源，测试通过解析调用计数和结果一致性断言，禁止第二次读取原始 envelope |
| AC25.9.8 | 交错的 text/image/resource/unknown 结果在实时卡片中保持原始 block 顺序；artifact 按固定章节顺序写入；分类 spool 达到 `MCP_ARTIFACT_MAX_BYTES` 后不再无限增长且仍正确设置 `artifactTruncated` |
| AC25.9.9 | 新消息的 `persistedDisplayData` 始终包含 `displayMode`、`artifactRequired` 和 `hasOversizedNonTextContent`；旧消息通过版本适配器补齐后，实时与历史展示不重新解析原始 envelope |
| AC25.9.10 | 安全源超过 artifact 深度、节点数或事件数上限时，不发生栈溢出或无限内存增长；设置 `artifactSafetyRejected` / `artifactUnavailable`，不设置 `artifactTruncated`，并安全降级到持久化摘要 |
| AC25.10 | `JSON.stringify(persistedDisplayData)` 的 UTF-8 字节数始终不超过 `MCP_LOCAL_DISPLAY_MAX_BYTES`；超限按规定优先级收缩并设置 `truncated` |
| AC25.11 | 实时 `tool-result` 事件始终不超过 `MCP_LIVE_DISPLAY_MAX_BYTES`；超限时按规定剥离图片/收缩内容，历史投影、artifact 和模型投影不受错误回退影响 |
| AC25.12 | 仅含超大 `structuredContent`、大量资源块或大量 unknown 块时，即使 `renderTextChars === 0`，只要 artifact 序列化结果超过 `MCP_ARTIFACT_TRIGGER_BYTES` 或投影被截断，仍设置 `hasOversizedNonTextContent` 并生成 artifact；卡片提供元信息及有效 artifactId 对应的打开入口，复制内容来自该 artifact 的受控前缀并遵守 `MCP_RESULT_COPY_MAX_BYTES`，两者均传播 `artifactTruncated` |
| AC25.13 | renderer 展开/收起均不调用 `parseMcpToolResult()` 或脱敏函数；只在展开时执行富文本判型、转换、高亮和 DOM 挂载 |
| AC26 | 落盘失败（模拟权限错误 / 写满）时工具调用仍返回成功，卡片不显示「打开完整内容」，无未捕获异常 |
| AC26.1 | artifact 写入失败时仍持久化脱敏、有界 `persistedDisplayData`，标记 `artifactUnavailable` 与真实 `truncated`；复制 fallback 到该摘要并提示截断，不复制模型占位符 |
| AC27 | `shell:open-output-path` 对 `artifact-mcp-<64hex>` 正确解析到 `shell-output/mcp/`；对越界路径（`../`、绝对路径指向别处）仍返回 `INVALID_PATH`（路径遍历回归） |
| AC28 | `artifactId` 为 `REDACTED_ARTIFACT_ID` 或缺省时，不渲染「打开完整内容」按钮（避免死按钮） |
| AC29 | 引入 D6 的受限 props 后，assistant 正文的搜索 fragment id 与改造前完全一致（回归断言）；`SearchSource` 扩展后既有 kind 的 fragment id 不变；MCP 结果内产生的 fragment 不与正文 fragment 冲突，且外层 `tool-result` 与细分 `tool-result-*` 的层级约定符合 §9.4.1 |

### 7.4 需人工验收（无法单测）

| 编号 | 验收项 |
|---|---|
| MN1 | 接入真实 MCP 服务（如本机 `stdio` echo server、或现有「知乎热榜」远程服务）完成一次成功调用与一次失败调用，卡片三要素（标题/结果/状态+耗时）可读 |
| MN2 | 用户点「本会话信任」后再次调用同一工具，标题仍可读（验证 R5 通路） |
| MN2.1 | 用户点「本会话信任」后再次调用同一 MCP 工具，在未发送 `tool-progress` 的情况下，从开始到返回期间可见运行中徽标与实时耗时，完成后计时停止 |
| MN3 | 服务被删除后回看历史消息，卡片降级正常 |
| MN4 | 飞书/微信远程会话中的进度文案不出现裸映射名 |
| MN5 | 用真实 MCP 服务返回 > 100 KB 结果，连续展开/收起/滚动各 3 次：无可感知卡顿、无滚动跳动、点击「展开全部」有即时反馈 |
| MN6 | 用真实 MCP 服务返回 > 512 KB 结果：点击「打开完整内容」能用系统默认程序打开已脱敏 artifact；在未超过 `MCP_ARTIFACT_MAX_BYTES` 时内容完整，超过时明确显示截断状态；手工删除该文件后再次点击，走失败降级而非死按钮 |

---

## 8. 分期建议

| 阶段 | 内容 | 交付 |
|---|---|---|
| P0 | R2（解析 + 渲染 + 状态徽标 + 脱敏）、R2.4（分层门限 + 性能测量用例，**必做**，否则会引入卡顿回归）、R3（耗时）、R1.1~R1.3（标题与图标，依赖块内元数据与映射名解析） | 包含主进程投影、共享纯函数、renderer 接线及持久化契约；主进程解析/脱敏是实时与历史一致性的前置条件，不能只在 renderer 实现；测试可全自动覆盖 |
| P1 | R5（主进程 `tool-use` 补 `mcp` + 渲染层目录反查）、R1.4 一致性（概述行 / 状态条 / 远程 IM）、R2.3 设置页入口 | 需要主进程改动 + 真机验收 |
| P2 | R7 超长结果 artifact 落盘（含 H1 先落盘后压缩、H2 `mcp/` 子目录清理接线）+「打开完整内容」入口、图片块预览增强、复制粒度优化 | 已决策（D5 / D8），形态见 R7 |

---

## 9. 决策与剩余待确认

### 9.1 已确认决策（评审确认）

| 编号 | 议题 | 结论 | 落地位置 |
|---|---|---|---|
| D1 | 结果展示与复制是否脱敏 | **一律脱敏**：展示与复制均为掩码后文本，不提供「查看原始结果 / 复制原始结果」入口 | R2.5、AC10、AC21 |
| D2 | 行内耗时是否包含等待确认时间 | **包含**：行内展示端到端总耗时，展开态拆分为「等待确认 / 执行 / 总计」，与 `record.duration` 现有口径一致 | R3.2、AC7、AC8 |
| D3 | 超长结果渲染性能与门限 | **先做分层门限（P0 必做）**：短 / 中 / 长 / 超大四档；> 512 KB 不在聊天区渲染完整正文，收起态显示元信息，展开态显示可用的脱敏有界前缀 + 元信息，并提供复制；artifact 落盘留 P2，若 artifact 超过 16 MiB 必须显示截断状态 | R2.4、AC19–AC23、MN5 |
| D4 | 是否新增 MCP 专属图标 | **新增**，使用 `Plug` | R1.3 |
| D5 | 超长结果是否落盘并提供「打开完整内容」 | **做（P2）**：复用 `run_shell` 既有落盘链路，落盘在压缩之前、目录隔离、TTL 7 天；具体形态见 R7。附带前置修复 H1（先落盘后压缩）、H2（`mcp/` 子目录清理接线） | R7、AC24–AC28、MN6 |
| D6 | Markdown 渲染实现方式 | **复用 `ChatMarkdown`，但必须走受限 props，不原样黑盒复用**：新增 `fragmentKindPrefix`（隔离搜索 fragment 命名空间）、禁用本地文件链接、禁用 math。理由与细节见 §9.4 | R2.2、§9.4、AC29 |
| D7 | 是否允许关闭「展示 MCP 服务名」 | **本期不做**（评审确认） | — |
| D8 | 落盘内容是否保留未脱敏原文 | **落盘即脱敏**：写入 artifact 的是在 16 MiB 上限内完整覆盖待落盘序列化结果的掩码内容；超限只保留有界前缀并标记 `artifactTruncated`，与 D1 的「不提供原始内容入口」一致；若未来确需原文，须另加显式风险确认 | R7.5、AC24 |

补充说明（D3）：**不做保护一定会卡，所以保护必须进 P0。** 现状之所以不卡，只是因为结果被 `truncate(text, 4000)` 截断；一旦支持「展开全部」，就必须同时带上门限、懒渲染与实测用例。

### 9.2 剩余待确认（不阻塞 P0）

| 编号 | 事项 | 影响 | 建议 |
|---|---|---|---|
| Q2 | 是否为 MCP 结果增加「重试调用」按钮 | 交互范围 | 非本期，列入后续 |

> 原 Q1（artifact 落盘形态）、Q1.1（落盘是否保留未脱敏原文）、Q3（服务名展示开关）、Q4（Markdown 渲染方式）均已决策，分别见 D5、D8、D7、D6，此处不再重复列出。

### 9.3 风险登记

| 风险 | 说明 | 缓解 |
|---|---|---|
| 性能回归 | 完整渲染放开后，「长结果 + 长列表 + 批量折叠」叠加可能明显掉帧 | R2.4 分层门限 + 懒渲染 + `startTransition` + 性能用例守门（AC19–AC22） |
| 滚动跳动 | 展开 / 收起引起列表高度重算 | R2.4.5 锚定策略 + AC23 / MN5 |
| 脱敏误伤与漏判 | 片段级掩码实现不当会把整段文本替换成 `[REDACTED]`，或漏掉新的 token 形态 | R2.5 片段级替换约束 + 单测覆盖 + 复用 `detectSensitiveParamValue` 规则集 |
| 历史数据缺 `mcp` 字段 | 老消息、服务已删除场景 | R5.2 目录反查 + R1.5 降级文案 + AC15 / AC16 / MN3 |
| 描述文本不可信 | 外部服务的 `description` 可能含指令性内容 | R1.2 仅纯文本展示，不渲染 Markdown / HTML，不进入提示词 |
| 落盘原文丢失 | 现有 `compactResultIfNeeded` 在结果 > 1,048,576 字符（约 1 MiB）时先丢弃原文，导致「打开完整内容」空功能 | H1：先落盘后压缩（AC25 守门） |
| 磁盘持续增长 | 现有清理只在 `run_shell` 执行时触发、且跳过子目录，`mcp/` 下文件不会被回收 | H2：对 `shell-output/mcp` 单独接线清理（启动 + 可选每日）+ TTL 7 天 + 总量上限（R7.5） |

### 9.4 Markdown 渲染方式（D6 结论）

**结论：复用 `ChatMarkdown`，但必须通过新增的可选 props 收窄行为；不原样黑盒复用，也不新建独立 renderer。**

`ChatMarkdown`（`src/renderer/components/Chat/ChatMarkdown.tsx`）已具备 MCP 结果需要的全部能力：remark-gfm 表格、Shiki 代码高亮、表格复制、基础排版。同时它与 assistant 正文有三处强耦合，原样复用会出问题：

| 耦合点 | 现状 | 原样复用的后果 |
|---|---|---|
| 搜索 fragment 命名空间 | 用 `buildFragmentId(messageId, { kind: 'assistant-markdown-text' / 'assistant-code' / 'assistant-math', segmentIndex, … })` 标注每个文本段 / 代码块 / 公式 | 与正文 fragment 命名空间重叠，索引可能碰撞，破坏 AC11「结果 fragment 与改造前一致」与搜索高亮 |
| 本地文件链接 | `<a>` 走 `MarkdownLinkOrStatusDot`，可把相对路径渲染成「打开本地文件」入口 | MCP 结果来自外部服务，属不可信文本，不应产生本地文件打开入口（误导 + 越权感） |
| math 渲染 | `rehype-katex` 始终启用 | MCP 结果多为 JSON / 日志 / 表格，`$` 出现频繁，会被误判为公式并渲染失败或错乱 |

收窄方案（新增 3 个可选 props，**默认值保持现有行为，保证正文零回归**）：

1. `fragmentKindPrefix?: 'assistant' | 'tool-result'`（默认 `'assistant'`）：为 `'tool-result'` 时生成 `tool-result-text` / `tool-result-code` / `tool-result-math` 等 kind，与正文隔离。
2. `allowLocalFileLinks?: boolean`（默认 `true`）：MCP 结果传 `false`，此时相对路径**只作为文本展示**，不产生本地文件打开入口；外链仍按现有 external links 规则处理。
3. `enableMath?: boolean`（默认 `true`）：MCP 结果传 `false`，跳过 KaTeX 插件（顺带降低 R2.4 里 KaTeX 那一条性能风险）。

实现要求：

- 三个 props 的默认值必须与当前行为逐一对齐；`ChatMarkdown` 现有测试全部保持通过（AC29）。
- MCP 结果分支（`McpToolResultView`）只传这三个参数 + 结果 fragment 约定，不复制渲染器实现。
- 若后续发现更多耦合点，倾向于继续以 props 收窄，而不是 fork 一个渲染器（避免两套 Markdown 行为长期漂移）。

#### 9.4.1 连带改动：搜索 fragment（不补会直接卡住 AC11 / AC29）

`ChatMarkdown` 生成的 fragment id 由 `src/shared/chatSearchFragments.ts` 的 `buildFragmentId(messageId, source)` 决定，而 `SearchSource` 是一个**封闭 union**，当前仅有：

```ts
| { kind: 'assistant-markdown-text'; segmentIndex: number; fragmentIndex: number }
| { kind: 'assistant-code'; segmentIndex: number; codeIndex: number; inline: boolean }
| { kind: 'assistant-math'; segmentIndex: number; mathIndex: number; display: boolean }
| { kind: 'tool-label' | 'tool-input' | 'tool-result'; toolUseId: string }
...
```

D6 让 MCP 结果走 `ChatMarkdown` 并传 `fragmentKindPrefix='tool-result'` 后，组件内部会生成 `tool-result-text` / `tool-result-code` / `tool-result-math` 等新 kind。因此**必须同步**：

1. `SearchSource` 新增上述 kind（含定位所需的 `toolUseId` 与索引字段）；
2. `sourceIdentityKey()` 新增对应分支；
3. `buildSearchFragmentsFromMessage()` 为 MCP 结果产出对应的细分片段（否则搜索索引里没有这些片段，命中高亮时会找不到锚点）。

两条兼容约束：

- **AC11 兼容**：现有单条 `{ kind: 'tool-result'; toolUseId }` 片段是「MCP 结果整体」的搜索锚点，**必须继续保留**（结果视图外层 `data-search-fragment-id` 不变）；细分片段是**新增**的、只服务于结果内部高亮。
- **去重**：为避免同一段文本被索引两次（外层整段 + 内层细分），需明确「外层负责定位、内层负责高亮」的层级约定，并以测试固定下来（AC29 补充断言）。

> 注：`src/renderer/services/markdownSearchProjection.ts` 只产出索引与文本、不生成 fragmentId，通常无需改动；但若实现选择为非 `assistant-*` 前缀复用该投影，需按 `fragmentKindPrefix` 参数化（以实现时确认为准）。

---

## 10. 术语

| 术语 | 含义 |
|---|---|
| 映射名（mappedName） | 供模型 API 使用的唯一工具名，形如 `mcp_s_hot_list_019ce6b1`；本需求后仅作为内部标识与 tooltip 中的诊断信息 |
| 原始工具名（originalName） | MCP Server 在 `tools/list` 返回的 `name`，如 `hot_list` |
| 结果块（content block） | MCP `tools/call` 返回的 `content` 数组元素：`text` / `image` / `resource` 等 |
| 端到端总耗时 | 从 `tool-use` 事实到达（`startedAt`）到结果写入（`completedAt`），含排队、等待确认与执行 |
| 执行净耗时 | `completedAt - (confirmedAt ?? startedAt)`，即确认之后真正执行的耗时 |
| 渲染分层门限 | R2.4.2 的四档阈值（8 KB / 64 KB / 512 KB），决定结果是否解析 Markdown、是否 Shiki 高亮、是否允许在聊天区展开渲染；按**文本长度**判定且永久生效，与执行阶段无关（见 R2.4.2.1） |
| artifact 主键 | 落盘文件的引用标识。shell 输出为 `artifact-<64hex>`；MCP 结果为 `artifact-mcp-<64hex>`（R7.3）；无效时回退 `REDACTED_ARTIFACT_ID`，渲染层不得用它调用打开接口 |
