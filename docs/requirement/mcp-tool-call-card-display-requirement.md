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
| MCP 结果结构 | `electron/mcp/mcpToolExecutor.ts`：`data = result.structuredContent ?? result.content`，其中 `content` 是 MCP 协议的块数组（`{ type: 'text', text }` / `image` / `resource`） | 用户看到的 `[{"type":"text",…}]` 只是被 `JSON.stringify` 的协议外壳，真正的业务内容埋在 `text` 字段里 |
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
  | { kind: 'image'; mimeType: string; dataLength: number }
  | { kind: 'resource'; uri: string; name?: string; mimeType?: string }
  | { kind: 'unknown'; raw: string }

export type McpResultDisplay = {
  /** 文本块合并结果（多块之间空行分隔） */
  text: string
  /** 结构化内容（structuredContent 或非 content 形态的 data） */
  structured?: unknown
  blocks: McpResultBlock[]
  isEmpty: boolean
}

export function parseMcpToolResult(data: unknown): McpResultDisplay
```

解析规则（按优先级）：

1. `data` 为 MCP `content` 块数组（元素为对象且带字符串 `type`）→ 逐块映射为 `text` / `image` / `resource` / `unknown`。
2. `data` 为普通对象/数组（`structuredContent`）→ 全部放入 `structured`，`text` 置空。
3. `data` 为字符串 → 单 `text` 块。
4. `undefined` / `null` / 空数组 → `isEmpty: true`。

边界：数组元素不是对象、`text` 非字符串、`type` 缺失、超深嵌套等一律降级为 `unknown` 块（`raw` 为 `JSON.stringify` 截断片段），**不得抛异常**。

#### R2.2 渲染规则

| 内容形态 | 渲染方式 |
|---|---|
| 纯文本（非 Markdown 特征） | 等宽 `<pre>`，保留换行（沿用 `sa-command-inset` 视觉） |
| Markdown 特征文本（含 `#`/`\|`/`-`/```/表格等，或 JSON 解析失败时的富文本） | 复用 `ChatMarkdown` 渲染（代码块走 Shiki 高亮、表格可复制） |
| 文本本身是 JSON（`JSON.parse` 成功且为对象/数组） | 代码块 + `json` 高亮 + 默认折叠至 12 行 |
| 文本是 XML/HTML 片段 | 代码块 + `markup` 高亮，转义显示（不执行、不注入 DOM） |
| `image` 块 | 展示「图片结果 · `<mimeType>` · 约 `<KB>`」+ 缩略图（仅当大小 ≤ 512 KiB 时渲染 `<img>`，超过时只显示元信息，避免 base64 撑爆 DOM） |
| `resource` 块 | 展示资源名 + URI（URI 需按展示规则处理成不可点击纯文本或经 `pathSecurity` 白名单后才可点击） |
| `isEmpty` | `t('tool.mcp.resultEmpty')`（「工具返回空结果」） |
| `structured` 非空 | 追加「结构化数据」小节，JSON 代码块 + 折叠 |

渲染实现位于新组件 `src/renderer/components/Chat/McpToolResultView.tsx`，由 `ToolCallCard` 在 `record.mcp`（或目录判定为 MCP 工具）时替代现有 `resultStr` 的 `<pre>` 分支；非 MCP 工具保持现状，避免影响内置工具回归。

**懒解析约束**：只有在卡片展开（`showDetail`）时才调用 `parseMcpToolResult` 与 Markdown 渲染，收起态不解析、不高亮，避免长列表滚动时重复开销。

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
| 脱敏正则扫描 | 展开时对全文执行 | 长文本重复扫描；正则有回溯风险时更慢 |
| 列表高度重算 | 展开使卡片变高 | `react-virtuoso` 需重新测量，可能造成滚动位置跳动 |
| 批量折叠反复挂载 | 批次收起/展开 | 若收起态仍解析渲染，滚动整段历史时开销被反复放大 |

##### R2.4.2 分层门限（按单个结果文本的字符数）

> **单位口径**：本节阈值以**字符数**为准，表中 KB 均指 `1024 字符`（即 8 KB = 8 192 字符、64 KB = 65 536 字符、512 KB = 524 288 字符）。注意与 R2.2 中 `image` 块的 `512 KiB`（**字节**，base64 解码后大小）口径不同，勿混用。

| 区段 | 文本长度 | 收起态 | 展开态 | Markdown | Shiki 高亮 | 脱敏 |
|---|---|---|---|---|---|---|
| 短 | ≤ 8 KB | 不渲染正文 | 按语义完整渲染 | ✅ | ✅ | ✅ |
| 中 | 8–64 KB | 不渲染正文 | 前 20 行 + 「展开全部（共 N 行）」；点击后再渲染完整内容 | ✅ | ✅（单块上限 64 KB） | ✅ |
| 长 | 64–512 KB | 不渲染正文 | 前 20 行 + 「展开全部」；完整内容**以纯文本渲染**（不解析 Markdown、不高亮） | ❌ | ❌ | ✅ |
| 超大 | > 512 KB | 只显示元信息（块数 / 大小 / 行数） | 不在聊天区展开；提供「复制结果」与（P2）「打开完整内容」 | ❌ | ❌ | ✅（分块执行） |

- 门限常量集中在共享模块（如 `MCP_RESULT_RENDER_LIMITS`）定义，便于测试与后续调节；上表数值为**初值**，须由 R2.4.4 实测结论校准后写回本文档。
- 「展开全部」是显式用户意图：点击后先渲染前 20 行并显示 `t('tool.mcp.renderLoading')` 加载态（避免点击无反馈），完整渲染放进 `React.startTransition` / `useDeferredValue`，保证点击与滚动仍响应。
- 收起态**不解析、不高亮、不脱敏**（脱敏下沉到「展开」与「复制」时执行），保证历史列表滚动成本与改造前一致。
- 后端上限继续有效：`mcpToolExecutor.ts` 的 `compactResultIfNeeded` 在 `serialized.length > 1024 * 1024`（即约 1,048,576 **字符**，**非字节**）时，把结果整体替换为占位符；命中截断时提示 `t('tool.mcp.truncated')`。本门限与 R2.4.2 同以**字符数**计，测试造数据时勿按字节。

##### R2.4.2.1 门限的作用域：与「执行中 / 已完成」无关（重要澄清）

**门限是「按结果文本长度」约束渲染路径，不是「按执行阶段」约束。** 具体语义：

1. **执行期间不存在结果内容可渲染。** `tool-progress` 是**通用**进度通道：`electron/toolChatLoop.ts` 为每次工具执行提供 `sendProgress`，内置工具（如 `run_shell` / `run_script`）经 `ctx.sendProgress` 调用，触发 `tool-progress` 事实下发。MCP 的 `tools/call` 是一次性返回、没有增量结果流，`mcpToolExecutor.ts` **未调用** `ctx.sendProgress`，因此 MCP 无 `tool-progress`。因此 MCP 卡片在 `calling` / `confirming` / `executing` 期间只展示**标题 + 状态徽标 + 实时耗时**（以及 `t('tool.pending')` 提示），「不高亮」在这一阶段是无意义的——根本没有内容。
2. **门限在结果落盘后生效，且永久生效。** 结果写入 `record.result.data` 后，是否解析 / 高亮只由该文本的长度决定，**与工具是否刚执行完、以及用户何时回看历史无关**。
3. 因此对「> 512 KB」的正确理解是：**在聊天区永久不解析、不高亮**，无论执行刚结束还是几个月后回看历史消息。它不会在"执行完之后补上高亮"。同理 64–512 KB 档也永久走纯文本。
4. P2 的「打开完整内容」（artifact 落盘）是在**独立查看器**中打开原文，不会把高亮结果搬回聊天区，因此不破坏本门限。
5. 若未来接入 MCP `notifications/progress`（协议允许）向渲染层推送增量文本，实时增量必须走与 `run_shell` 实时输出一致的**纯文本、不高亮**通道（参考 `ShellOutputView` 的 `isLive` 分支），避免出现两套实时渲染策略。

##### R2.4.3 复制路径

- 提供「复制结果」按钮，复制**脱敏后的可读文本**（不是协议 JSON、也不是未脱敏原文）。
- 复制为异步操作：长文本复制期间按钮显示进行中态；超大结果（> 512 KB）复制时在末尾追加截断提示文案。

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
- 掩码只作用于**展示与复制文本**，不改变持久化数据（`record.result.data`）与模型上下文，也不影响搜索索引的可检索性约定（见 R4）。
- 性能约束：掩码正则为线性、无嵌套量词（规避回溯爆炸）；收起态不执行；> 512 KB 文本分块执行（见 R2.4.2）。
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
| `executing` | 实时计时（每秒更新，如 `3s`、`12s`） | 「等待确认 8s · 执行 12s」 |
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

- 实时计时只挂在状态为 `executing` 的卡片上，且使用**独立叶子计时组件**（参考 `ChatRunningElapsed` 的设计：组件内部持有秒级 `now`，只让自身重渲染），不得让 `ChatMessageList` / `ToolCallCard` 列表整体每秒重渲染。
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

> 适用场景：结果文本超过 R2.4.2 的「超大」档（> 512 KB），聊天区不再渲染正文，改为「元信息 + 复制 + 打开完整内容」。本节定义落盘形态。

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
- 打开：复用 `window.api.shellOpenOutputPath(artifactId)`，渲染层不感知目录差异。
- 不新增 IPC 通道，只扩展现有通道的解析前缀；`REDACTED_ARTIFACT_ID` 兜底语义保持不变。

#### R7.4 落盘时机与条件

- **时机**：主进程 `mcpToolExecutor` 拿到 `tools/call` 结果后、`compactResultIfNeeded` **之前**（见 H1）。
- **条件**：仅当解析后的可读文本长度超过 R2.4.2 的「超大」阈值（> 512 KB）时才落盘，避免每次调用都产生文件。
- **不得影响调用结果**：落盘失败（磁盘满、权限）时，`tool-result` 仍按正常成功返回，只是卡片不显示「打开完整内容」入口，并记一次 warn；不得让工具调用失败。
- **异步**：落盘使用 `OutputArtifactWriter` 的流式写入，不阻塞工具循环的返回路径（`close()` 在需要 artifactId 时 await）。

#### R7.5 内容格式、上限与清理

- **格式**：写入**解析后的可读文本**（与 R2.4「长」档同源），若存在 `image` / `resource` 块，则在文本末尾追加一段 JSON 清单，只记 `mimeType` / `bytes` / `uri` 等元信息，**不写 base64 正文**。
- **脱敏**：写入内容为**已掩码**版本（D8，与 D1 一致——不提供查看原始内容的入口）；即 artifact 是「完整但已脱敏的内容」。
- **单文件上限**：建议 16 MB（**字节**；`OutputArtifactWriter` 按 `Buffer` 累计字节数判定 `maxBytes`，常量集中定义）；超限时按既有行为停止写入，并在卡片与文件尾部标注「已截断」。
- **路径安全**：沿用 `OutputArtifactWriter` 的 `mkdir -p` + 既定根目录；文件名不含任何用户输入。
- **清理**：沿用 **TTL 7 天**（与现有 `run_shell` 输出清理、`imProcessedStore` 保留期一致）+ **目录总量上限先到者生效**，最旧优先删除；清理结果记入 agent 日志。**关键点（H2）**：该函数只处理顶层文件、会跳过子目录，故 A2 下必须对 `shell-output/mcp` **单独接一次调用**（启动时 + 可选每日），不能依赖 `runShellExecutor` 里那次（它只扫顶层、且只在执行 shell 时触发）。若改用 A1（同目录混放），则可复用现有调用，但 MCP 文件会与 shell 输出共享同一 TTL / 限额。

#### R7.6 渲染层入口

- 触发条件：`status === 'completed'` 且存在有效 `artifactId`（非空、非 `REDACTED_ARTIFACT_ID`）且当前走「超大」档。
- 文案：`t('tool.mcp.openFullContent')`（「打开完整内容」）。
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
| 修改 | `electron/mcp/mcpToolExecutor.ts` | **H1**：先 artifact 落盘（原文）→ 再 `compactResultIfNeeded`；超阈值时返回 `artifactId`（R7.4） |
| 修改 | `electron/appIpc.ts` | `shell:open-output-path` 支持 `artifact-mcp-<64hex>` 前缀 → `shell-output/mcp/<64hex>.log`（R7.3） |
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
| 修改 | `src/shared/assistantFactAggregator.ts` | `tool-use` 事件可选 `mcp` 字段 |
| 修改 | `electron/toolChatLoop.ts` | 下发 `tool-use` 事实时填充 `mcp` |
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
| AC5 | `data = [{ type: 'text', text: '{"hot":{"title":"x"}}' }]` 渲染为 `json` 高亮代码块，默认折叠 |
| AC6 | `result = { success: false, error: 'MCP 工具调用超时（60000ms 无响应）…' }` 展示 `失败` 徽标 + 可读错误 + 「打开 MCP 服务设置」按钮 |
| AC7 | `status = 'completed'` 且 `duration = 12300` 展示 `12.3s`；`duration = 820` 展示 `820ms`；`duration = 63000` 展示 i18n 分钟格式 |
| AC8 | `status = 'executing'`、`confirmedAt = now - 4000` 时展示实时 `4s` 且每秒递增；进入终态后停止更新 |
| AC9 | `data` 为空数组/`null` 时展示 `工具返回空结果`，不展示空 `<pre>` |
| AC10 | 结果文本含 `Bearer abc`、`ghp_xxx` 时展示为 `[REDACTED]` |
| AC11 | MCP 结果**外层** `data-search-fragment-id`（`tool-result:{toolUseId}`）与改造前一致，搜索命中仍能定位并高亮；引入 D6 细分片段后，同一文本不被重复索引 / 重复高亮（§9.4.1） |
| AC12 | `ActivityBatch` 概述行与 `streamingActivityStatus` label 对同一记录输出与行内标题一致的文案 |
| AC13 | `prefers-reduced-motion: reduce` 下状态徽标无 pulse 动画 |

### 7.2 边界与回归

| 编号 | 验收项 |
|---|---|
| AC14 | 非 MCP 内置工具（`read_file` / `run_shell` / `browser` 等）卡片视觉与行为零回归（现有 `ToolCallCard.test.tsx` 全部通过） |
| AC15 | 老数据（无 `mcp` 字段、无 `duration`）渲染不报错、不显示占位符 |
| AC16 | 无 `window.api.mcpList`（IPC 失败）时仍能渲染，使用降级文案并记录一次 warn |
| AC17 | `executing` 卡片的秒级计时更新不引起其他卡片或消息列表整体重渲染（以渲染计数断言；收起态解析开销由 AC21 覆盖，列表滚动基线由 AC22 覆盖） |
| AC18 | 暗色/亮色截图对比检查（沿用项目 visual-check 方式），无对比度低于 4.5:1 的徽标文本 |

### 7.3 性能与 artifact 验收（对应 R2.4 / R7，必须有自动化用例）

| 编号 | 验收项 |
|---|---|
| AC19 | 结果文本 8 KB 时「展开 → 可交互」< 100 ms；64 KB 时 < 300 ms（由性能测量用例输出实际值并回写 R2.4.2） |
| AC20 | 结果文本 > 512 KB（以及 64–512 KB 档）**永久**走纯文本 / 元信息路径：不调用 Markdown 解析、不调用 Shiki 高亮，且断言在「执行刚结束」与「历史回看（重新挂载组件）」两种时点下均成立（以调用计数断言） |
| AC21 | 收起态（含批次收起）对任意长度结果均不执行解析、高亮与脱敏（以调用计数断言） |
| AC22 | 200 条消息（含 20 条 MCP 结果）滚动时渲染次数与耗时均不高于改造前基线（复用 `npm run perf:chat-list`） |
| AC23 | 展开超大结果后滚动位置不跳动（锚定断言，并配合 MN5 人工复核） |
| AC24 | 结果 > 512 KB 时落盘成功且返回有效 `artifactId`（`artifact-mcp-<64hex>`）；落盘文件内容为**已脱敏**的完整可读文本（D8），不含 base64 正文（R7.5） |
| AC24.1 | MCP 结果在改造前**不会**产生任何落盘文件（R7.0 事实校验）；改造后仅新增 `shell-output/mcp/` 下的文件，不触碰既有 shell artifact |
| AC25 | **H1 顺序断言**：结果 > 1,048,576 字符（约 1 MiB）时，落盘文件包含完整原文（而非 `[tool_result omitted…]` 占位符），同时交给模型的内容仍为压缩后的占位符 |
| AC26 | 落盘失败（模拟权限错误 / 写满）时工具调用仍返回成功，卡片不显示「打开完整内容」，无未捕获异常 |
| AC27 | `shell:open-output-path` 对 `artifact-mcp-<64hex>` 正确解析到 `shell-output/mcp/`；对越界路径（`../`、绝对路径指向别处）仍返回 `INVALID_PATH`（路径遍历回归） |
| AC28 | `artifactId` 为 `REDACTED_ARTIFACT_ID` 或缺省时，不渲染「打开完整内容」按钮（避免死按钮） |
| AC29 | 引入 D6 的受限 props 后，assistant 正文的搜索 fragment id 与改造前完全一致（回归断言）；`SearchSource` 扩展后既有 kind 的 fragment id 不变；MCP 结果内产生的 fragment 不与正文 fragment 冲突，且外层 `tool-result` 与细分 `tool-result-*` 的层级约定符合 §9.4.1 |

### 7.4 需人工验收（无法单测）

| 编号 | 验收项 |
|---|---|
| MN1 | 接入真实 MCP 服务（如本机 `stdio` echo server、或现有「知乎热榜」远程服务）完成一次成功调用与一次失败调用，卡片三要素（标题/结果/状态+耗时）可读 |
| MN2 | 用户点「本会话信任」后再次调用同一工具，标题仍可读（验证 R5 通路） |
| MN3 | 服务被删除后回看历史消息，卡片降级正常 |
| MN4 | 飞书/微信远程会话中的进度文案不出现裸映射名 |
| MN5 | 用真实 MCP 服务返回 > 100 KB 结果，连续展开/收起/滚动各 3 次：无可感知卡顿、无滚动跳动、点击「展开全部」有即时反馈 |
| MN6 | 用真实 MCP 服务返回 > 512 KB 结果：点击「打开完整内容」能用系统默认程序打开且内容完整、已脱敏；手工删除该文件后再次点击，走失败降级而非死按钮 |

---

## 8. 分期建议

| 阶段 | 内容 | 交付 |
|---|---|---|
| P0 | R2（解析 + 渲染 + 状态徽标 + 脱敏）、R2.4（分层门限 + 性能测量用例，**必做**，否则会引入卡顿回归）、R3（耗时）、R1.1~R1.3（标题与图标，依赖块内元数据与映射名解析） | 纯渲染层 + 共享纯函数，不依赖主进程改动；测试可全自动覆盖 |
| P1 | R5（主进程 `tool-use` 补 `mcp` + 渲染层目录反查）、R1.4 一致性（概述行 / 状态条 / 远程 IM）、R2.3 设置页入口 | 需要主进程改动 + 真机验收 |
| P2 | R7 超长结果 artifact 落盘（含 H1 先落盘后压缩、H2 `mcp/` 子目录清理接线）+「打开完整内容」入口、图片块预览增强、复制粒度优化 | 已决策（D5 / D8），形态见 R7 |

---

## 9. 决策与剩余待确认

### 9.1 已确认决策（评审确认）

| 编号 | 议题 | 结论 | 落地位置 |
|---|---|---|---|
| D1 | 结果展示与复制是否脱敏 | **一律脱敏**：展示与复制均为掩码后文本，不提供「查看原始结果 / 复制原始结果」入口 | R2.5、AC10、AC21 |
| D2 | 行内耗时是否包含等待确认时间 | **包含**：行内展示端到端总耗时，展开态拆分为「等待确认 / 执行 / 总计」，与 `record.duration` 现有口径一致 | R3.2、AC7、AC8 |
| D3 | 超长结果渲染性能与门限 | **先做分层门限（P0 必做）**：短 / 中 / 长 / 超大四档；> 512 KB 不进聊天区渲染，改为元信息 + 复制；artifact 落盘留 P2 | R2.4、AC19–AC23、MN5 |
| D4 | 是否新增 MCP 专属图标 | **新增**，使用 `Plug` | R1.3 |
| D5 | 超长结果是否落盘并提供「打开完整内容」 | **做（P2）**：复用 `run_shell` 既有落盘链路，落盘在压缩之前、目录隔离、TTL 7 天；具体形态见 R7。附带前置修复 H1（先落盘后压缩）、H2（`mcp/` 子目录清理接线） | R7、AC24–AC28、MN6 |
| D6 | Markdown 渲染实现方式 | **复用 `ChatMarkdown`，但必须走受限 props，不原样黑盒复用**：新增 `fragmentKindPrefix`（隔离搜索 fragment 命名空间）、禁用本地文件链接、禁用 math。理由与细节见 §9.4 | R2.2、§9.4、AC29 |
| D7 | 是否允许关闭「展示 MCP 服务名」 | **本期不做**（评审确认） | — |
| D8 | 落盘内容是否保留未脱敏原文 | **落盘即脱敏**：写入 artifact 的是掩码后的完整可读文本，与 D1 的「不提供原始内容入口」一致；若未来确需原文，须另加显式风险确认 | R7.5、AC24 |

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
