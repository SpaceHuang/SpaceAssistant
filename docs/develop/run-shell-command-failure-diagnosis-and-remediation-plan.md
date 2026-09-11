# `run_shell`“命令执行失败”误报与诊断信息不足：系统分析及解决方案

> 文档日期：2026-09-09
> 文档性质：问题分析与开发方案，不包含本次代码实现
> 目标会话：`e0ea885f-f7a2-4c90-a2e8-ec92f274cade`
> 原始记录：`/Users/space/Documents/Develop/sessions/e0ea885f-f7a2-4c90-a2e8-ec92f274cade-20260905/messages.json`
> 修订依据：`docs/review/run-shell-command-failure-diagnosis-and-remediation-plan-review.md`、`docs/review/run-shell-command-failure-diagnosis-and-remediation-plan-review-v2.md`

## 1. 结论摘要

该会话中频繁出现“命令执行失败，请检查命令后重试”，主要不是命令本身频繁失败，而是以下三个问题叠加，其中第一个是能够直接解释目标会话现象的确定根因：

1. **成功 stdout 被错误的脱敏逻辑整段替换。** `toolErrorCommon.ts` 将裸文本 `node_modules`、`dist-electron` 以及部分绝对路径片段视为内部细节；`runShellExecutor` 又对成功命令的 stdout/stderr 调用 `sanitizeToolOutputText`。命中后，`run_shell` 的错误转换逻辑会把整段正常输出替换为“命令执行失败，请检查命令后重试”。因此会出现 `success=true`、`exitCode=0`、stdout 是失败文案的组合。目标会话中的 `du` 和 `ls -a` 输出都可能包含 `node_modules`，与该路径完全吻合。
2. **信号终止信息没有从 `close(code, signal)` 建模出来。** 当前执行器只接收 `code`，忽略 Node.js `close` 事件的第二个 `signal` 参数；外部 SIGTERM/SIGKILL 等终止可能被转换为普通 `exitCode=1`，Agent 无法知道实际终止原因。
3. **工具循环在失败分支丢弃了结构化 `data`。** 当前 `runShellExecutor` 在非零退出、超时、取消、输出超限时已经生成了 stdout、stderr、exitCode、status 等数据，但 `toolChatLoop` 的通用失败分支只把 `execResult.error` 放进 `tool_result`，没有把 `execResult.data` 传给 Agent。因此即使底层已经有诊断信息，Agent 仍然只能看到一条泛化错误。
4. **历史消息重建存在第二个独立的数据丢弃点。** `serializeToolCallsForDb`/`messageCodec` 可以持久化和恢复 `result.data`，但 `src/shared/claudeToolHistory.ts` 的 `buildToolResultBlock()` 对 `success=false` 只序列化 `result.error`。实时下一轮和应用重启/会话恢复后的历史下一轮因此使用不同的 tool_result 契约。
5. **重试键不能只使用稳定错误码。** 如果只按 `toolName + caseId + errorCode + shellProfile` 计数，三个不同命令的非零退出会被错误累计为同一错误；命令级重试必须加入不可逆的调用指纹，基础设施错误和方言专用 breaker 则使用独立作用域。

这会形成恶性循环：

```text
命令实际成功执行
  → stdout 命中内部细节正则，被错误脱敏为失败文案
  → `close` signal 也可能未被记录
  → 失败 tool_result 进一步丢弃 data
  → 持久化后历史重建再次只保留 error
  → Agent 无法判断是命令错误、Shell 错误、路径错误还是输出丢失
  → 只改变命令写法并重试
  → 相同执行器问题再次触发
```

## 2. 目标会话的证据

### 2.1 失败调用的统计

目标会话共有 4 条消息，第二个 Agent 回合包含 32 次工具调用。记录中有 15 次 `run_shell` 的 stdout 是：

```text
命令执行失败，请检查命令后重试
```

这 15 次记录的共同字段是：

```json
{
  "exitCode": 0,
  "stderr": "",
  "interrupted": false,
  "truncated": false
}
```

这里的关键不是 stdout 真为空，而是 stdout 已经被上游替换成了通用错误文案。该文案本身就是结果污染的证据，不应把它当作 shell 原始输出。

被包装成失败文案的命令包括：

- `du -sh remote-vibe deepseek-harness ...` 复合命令；
- `du -sh deepseek-harness/*` 及隐藏文件 glob；
- `du -sh deepseek-harness/node_modules`；
- `cd deepseek-harness/node_modules && ls -la`；
- `cd deepseek-harness/apps/web && du -sh ...`；
- **`cd deepseek-harness/apps/web && ls -a`**。

### 2.2 同一会话中的成功对照

并非所有 shell 命令都失败：

- `du -sh remote-vibe deepseek-harness` 返回 `11M` 和 `1.7G`；
- `du -sh remote-vibe/* ...` 正常返回目录大小；
- `cd deepseek-harness/node_modules && ls -a | grep ...; du -sh .pnpm` 正常返回 `.pnpm` 为 `1.4G`；
- `find` 查找 `apps/web/dist` 正常返回路径；
- `find` 查找 `*.tsbuildinfo` 正常返回文件列表；
- `du -sh apps/web/dist` 正常返回 `12M`。

因此不能把问题概括为“deepseek-harness 不可访问”或“所有大目录命令都执行失败”。失败更集中在输出中包含 `node_modules` 等命中词的场景；`ls -a` 这个明确应有输出、且目录列表很可能包含 `node_modules` 的对照，直接支持“成功输出被脱敏器替换”的根因，而不是“结果传输丢失”。

只有在修复脱敏逻辑后仍出现“执行日志有 stdout 字节、Agent payload 没有 stdout”的情况，才需要进一步调查 capture/serialize/handoff 链路。

### 2.3 唯一明确的运行环境失败

会话中另有 1 次 `run_script` 明确失败：

```text
无法启动 Python，请在设置中检查 pythonPath
```

这是 Python 可执行环境配置问题，与 `run_shell` 的“exitCode=0 但显示失败”属于不同故障类别，不能使用同一条错误文案。

## 3. 根因分层

### 3.1 L0：shell 命令语义层

目标命令本身没有发现足以解释这些失败的语法问题：

```bash
cd deepseek-harness/apps/web && ls -a
```

它只包含目录切换、成功条件连接符和目录列举，既没有复杂 glob，也没有管道、重定向或特殊方言语法。已验证的目录列表也证明目标路径存在。

结论：该命令不是主要根因。

### 3.2 L1：子进程执行层

从会话导出的结果看，shell 进程记录为 `exitCode=0`，且未中断、未超时、未截断。按照正常契约，这应被判定为成功。记录中所谓的 stdout 并不是空字符串，而是已经被替换后的通用失败文案；这与 stdout 命中 `node_modules` 后被整段脱敏的路径一致。

当前工作区的 `runShellExecutor` 已在 `proc.on('close')` 中执行 decoder flush，并把 bounded stdout/stderr 写入 `data`。当前首要修复点不是继续假设采集丢失，而是修复 `sanitizeToolOutputText` 对正常输出的破坏。脱敏修复后，仍应保留采集/序列化/handoff 观测作为二级防线。

### 3.3 L2：输出脱敏层（目标会话的直接根因）

当前确定的污染路径是：

```text
toolErrorCommon.containsInternalDetails()
  → 裸文本 node_modules / dist-electron / 部分绝对路径命中
  → runShellExecutor 对 stdout/stderr 调用 sanitizeToolOutputText()
  → run_shell 的 sanitize 分支把整段文本交给 toToolUserError()
  → 输出被替换成“命令执行失败，请检查命令后重试”
```

这条路径会破坏成功输出和失败 stderr 两类信息。它不能继续作为“普通输出脱敏”使用，也不能让输出脱敏结果承担执行失败语义。

修复原则：

- `success`、`status`、`exitCode`、`signal` 必须来自进程终态，不能由输出内容改变；
- 裸目录名 `node_modules`、`dist` 等不属于秘密，不应单独触发整段隐藏；
- 不再用一套全局路径规则覆盖所有出口；Agent 诊断、本地历史/UI、远程日志/遥测分别使用第 4 节定义的投影策略；
- stdout 与 stderr 不复用面向用户错误文案的 `toToolUserError`；结构化结果优先，只有自由文本兼容场景才使用带出口策略的兜底脱敏；
- 若严格出口因隐私策略必须省略整段，返回中性占位符“输出因隐私策略被省略”，并附带 `redacted=true`、`redactionReason`、`originalBytes`、`visibleBytes`；Agent 诊断出口则优先保留授权 workspace 内的有界诊断上下文；
- 不在脱敏失败时伪造 `命令执行失败`、`exitCode=1` 或 `status=failed`。

需要直接回归验证：成功 stdout 包含 `node_modules`、`dist-electron`、`/tmp/`、Windows 盘符；失败 stderr 同时包含 traceback、文件路径和真正错误原因。`run_script` 当前的逐行删除策略也不能直接复用，因为它可能删除 traceback 的关键行。

### 3.4 L3：结果规范化/错误投影层

当前代码存在一个确定的问题：`electron/toolChatLoop.ts` 的 `formatToolResultPayload()` 能序列化结构化 `data`，但失败分支最终调用：

```ts
buildToolErrorResult(toolUseId, execError, ...)
```

而 `buildToolErrorResult()` 只写入：

```ts
{
  type: 'tool_result',
  tool_use_id: toolUseId,
  content: execError,
  is_error: true
}
```

它没有携带 `execResult.data`。

与此同时，`electron/tools/runShellExecutor.ts` 在以下失败场景已经保留了结构化数据：

- 非零退出：`exitCode`、stdout、stderr、status、exitCodeHint；
- 超时：输出、`timed_out`、termination 信息；
- 取消：输出、`cancelled`；
- 输出超限：输出、`output_limit`、持久化文件信息；
- 进程启动失败：目前主要只返回 code/reason，仍应补充 executable、cwd 和底层错误类别。

因此，Agent 信息不足是当前代码可以直接确认的缺陷，与会话中观察到的结果丢失问题相互独立。

### 3.5 L4：持久化与历史消息重建层

实时 tool loop 不是唯一的 Agent handoff。完整链路是：

```text
executor result
  → assistant ToolCallRecord
  → serializeToolCallsForDb / messageCodec
  → deserializeToolCallsFromDb
  → buildToolResultBlock()
  → buildClaudeToolChatMessages()
  → historical tool_result
```

当前 `serializeToolCallsForDb` 和 `messageCodec` 已经会保存/恢复 `result.data`，但 `src/shared/claudeToolHistory.ts` 的 `buildToolResultBlock()` 在 `success=false` 时只返回 `tc.result.error`。因此失败结果的 `stderr`、`exitCode`、`signal`、`status` 和 `caseId` 会在历史重建阶段丢失，即使它们已经成功写入数据库。

这会影响：

- 应用重启后继续原会话；
- 会话恢复或消息重新加载；
- 重新构建 API history；
- 任何不复用内存中 `messagesForApi` 的后续请求。

实时 tool loop 与历史重建必须共同使用一个 canonical Agent payload serializer，不能在两个位置分别拼接 JSON。历史重建也必须保留 `is_error=true`，但其 content 应是同一个脱敏后的结构化 payload；没有进程结果的授权/预检/确认失败则显式表示 `processResult: null`。

持久化契约应保存稳定机器字段：`error` 使用稳定错误码，`userMessage` 仅供 UI/IM 展示，`data` 保存 Agent-safe 结构化诊断，必要的 `diagnostic` 保存 caseId、类别和可重试性。历史重建不得用 `userMessage` 覆盖 `error`，也不得因为 `success=false` 丢弃 `data`。

### 3.6 L5：进程终态与 signal 建模层

当前 `runShellExecutor` 的 `proc.on('close')` 只接收 `code`，没有接收 Node.js 提供的第二个参数 `signal`。当进程被外部 SIGTERM、SIGKILL 或操作系统信号终止时，`code` 可能为 `null`，当前代码随后把它转换为 `exitCode=1`，并标记为普通 `failed/process_exit`。

这会丢失真正的终止原因。修复要求：

- 使用 `proc.on('close', (code, signal) => ...)`；
- signal 终止时保持 `exitCode: null`，记录 `signal`；
- 增加 `status: 'signalled'` 或等价的稳定错误类别；
- 区分主动超时/取消调用 supervisor 后产生的 signal 与外部 signal；
- `terminationReason` 至少区分 `timeout`、`user_cancel`、`external_signal`、`process_exit`、`transport_error`；
- 主动终止时记录“请求终止”和“已确认退出”两个事实，不能仅以收到 SIGTERM 推断进程树已清理。

需要覆盖 SIGTERM、SIGKILL（平台允许时）、超时和用户取消，并断言 `status`、`terminationReason`、`exitCode`、`signal` 不互相混淆。

### 3.7 L6：错误文案脱敏层

`electron/tools/toolUserErrors.ts` 的设计目标是避免把绝对路径、内部堆栈和实现细节暴露给用户，这个目标是合理的；但当前 `run_shell` 默认错误文案：

```text
命令执行失败，请检查命令后重试
```

同时被用于 Agent 的 `tool_result`，把“面向用户的安全文案”和“面向 Agent 的可诊断结果”混为一层。结果是：

- 用户界面可以只显示简洁文案；
- Agent 却拿不到修复命令所需的退出码、stderr、cwd、shell 和状态；
- 执行器内部日志虽可能有更多信息，但 Agent 无法消费日志。

应拆分为两个契约：`userMessage` 与 `agentPayload`。脱敏不等于删除所有诊断字段。

### 3.8 L7：重试策略层

工具循环按相同 `toolName + error` 统计连续错误，并在达到阈值后停止。这能防止无限重试，但当错误始终是同一条泛化文案时，Agent 既无法修复，也无法判断是否应该换工具；重试次数反而放大了执行器问题。

后续应按错误类别决定重试：

- `process_exit` 且有 stderr：允许 Agent 基于 stderr 修正一次；
- `SHELL_SPAWN_ERROR`、`SHELL_EXECUTOR_RESULT_MISSING`：不应原样重试，应报告基础设施问题；
- `SHELL_DIALECT_MISMATCH`：给出方言和正确示例，禁止重复同一方言；
- `timeout`、`output_limit`：提示缩小范围或改用分段查询；
- 连续相同 `caseId` 达到阈值：立即停止并保留完整诊断摘要。

## 4. 脱敏模块与数据出口策略

本节是本计划的独立安全设计。目标不是建立一个“任何场景都不能出现绝对路径”的全局正则，而是定义不同数据出口允许看到什么，并让执行结果在进入出口前经过对应的投影。这样既避免秘密和未授权内容外泄，也不牺牲 Agent 诊断命令所需的上下文。

### 4.1 第一性原理：脱敏保护的是数据流，不是某个字符串

Shell 的原始结果是混合数据：同一段 stdout 可能同时包含错误类型、绝对路径、用户文件名、第三方库版本和 token。对这样的自由文本做全局替换，无法可靠判断每个片段的语义边界；继续增加路径正则只会在“误泄漏”和“误删诊断信息”之间来回摆动。

因此，脱敏模块必须遵守以下边界：

- **先区分数据出口，再决定投影规则。** Agent 诊断、本地历史/UI、远程日志/遥测和外部 IM 不是同一信任等级。
- **先使用结构化字段，再处理自由文本。** `status`、`exitCode`、`signal`、`shell`、`artifactId`、`stdoutBytes` 等事实不应从错误字符串中猜测。
- **秘密是所有出口的硬限制。** token、密码、Cookie、私钥和秘密环境变量的原值不得进入任何 Agent、日志、遥测、IM 或 renderer 出口。
- **路径不是天然的秘密。** 是否允许路径取决于它的来源、所属 workspace、用途和出口；`C:\`、`/usr/bin` 与用户项目目录不能用同一规则处理。
- **不确定性必须归属于策略。** 不能判断自由文本边界时，严格远程出口应省略原文；诊断出口则应优先保留有界上下文并标记风险，而不是伪造“命令失败”。

### 4.2 数据分类

| 数据类别 | 典型内容 | Agent 诊断出口 | 本地历史/UI | 远程日志/遥测、外部 IM |
|---|---|---|---|---|
| 凭据/秘密 | token、密码、Cookie、私钥、秘密 env 值 | 永不输出原值 | 永不输出原值 | 永不输出原值 |
| 用户/业务内容 | 文件内容、客户名、私有仓库名、用户目录名 | 仅在当前授权 workspace 和任务确有需要时保留 | 可重放 Agent 实际看到的内容 | 默认不输出原文 |
| 宿主路径元数据 | `cwd`、executable、绝对文件路径 | workspace 内可保留相对或必要的绝对路径；workspace 外按策略降级 | 与 Agent 可见结果保持一致 | 使用 scope、basename、fingerprint 或 opaque ID |
| 诊断事实 | error code、exit code、signal、timeout、库名/版本 | 保留 | 保留 | 保留结构化字段 |
| 原始命令和 stdout/stderr | 命令文本、脚本源码、输出尾部 | 有界保留，叠加秘密过滤和输出上限 | 只保存实际展示给 Agent 的版本 | 默认只保留大小、hash、类别和 artifactId |

这里的“用户隐私”采用产品运行时定义，而不是只依赖法定个人信息清单：凡是能识别个人/组织、暴露私有内容或反映用户工作环境，且没有被用户授权给该出口的信息，都按用户/业务内容处理。`/Users/alice/客户项目报价.xlsx` 的风险来自组合信息，而不是因为每个路径字符本身都是秘密。

### 4.3 按出口定义投影策略

#### Agent 诊断出口

该出口服务于“让 Agent 判断下一步怎么修复”。在用户已授权 Agent 操作当前 workspace 的前提下，允许保留：

- 有界 stdout/stderr 诊断上下文；
- error code、status、exitCode、signal、timeout、shell 类型；
- workspace 内路径，优先使用相对表示；只有命令或错误诊断确实需要时才保留绝对表示；
- 公共第三方库名称和版本；
- 指向受控详情的 `artifactId`。

必须隐藏或限制：

- 所有凭据原值、私钥、秘密环境变量值；
- workspace 外与当前修复无关的用户目录、文件名和文件内容；
- 未经授权的完整脚本、完整环境变量和无界输出；
- 远程日志、内部服务地址等仅为基础设施观测服务的信息。

这意味着 Agent 结果不追求“零路径”，而追求“路径可解释且不超出授权范围”。例如 `/usr/bin/python3` 通常是低敏诊断事实；`/Users/alice/customer-a/.env` 暴露了用户和凭据文件位置，应至少隐藏用户/项目部分，并且绝不返回文件内容。

#### 本地历史和 UI 出口

历史记录必须能重放 Agent 实际看到的 `tool_result`，不能为了事后脱敏而生成与实时对话不同的结果。UI 可以根据用户体验需要展示命令、cwd 和输出，但仍使用秘密过滤和有界输出；UI 的“本地可见”不等于允许把相同原文复制到远程日志。

#### 远程日志、遥测和外部 IM 出口

这些出口默认采用严格 allowlist，只发送：

- 稳定错误码和类别；
- status、exitCode、signal、duration、stdout/stderr 字节数；
- 不可逆的 command/plan fingerprint；
- 脱敏原因、artifactId、requestId 和 toolUseId。

默认不发送原始命令、脚本源码、stdout/stderr、绝对 cwd、executable 和完整堆栈。若部署明确需要更丰富的诊断，必须由单独的隐私策略显式启用，并记录保留期限、访问主体和脱敏规则，不能通过复用 Agent serializer 偶然放开。

### 4.4 模块边界和数据流

脱敏模块不应返回一个被所有调用方复用的“万能安全字符串”。建议拆成以下职责：

```text
原始执行结果
  → typed process facts
  → AgentDiagnosticProjection
  → LocalHistoryProjection
  → TelemetryProjection
```

- `typed process facts` 由执行器产生，包含终态、退出原因、输出大小和受控 artifact 引用；
- `AgentDiagnosticProjection` 负责 Agent 可操作的有界上下文；
- `LocalHistoryProjection` 保存 Agent 实际看到的内容，保证实时/历史一致；
- `TelemetryProjection` 只允许远程观测所需的结构化字段。

`sanitizeAgentText()` 只能作为旧接口、第三方异常和无法结构化的自由文本的兼容兜底，不能同时承担 Agent、历史和遥测三种策略。新工具不得先把结构化结果拼成一段文字，再依赖正则恢复字段含义。

### 4.5 路径处理规则

路径处理首先使用结构化来源标记，而不是在任意错误正文中猜测边界。路径投影至少区分：

```ts
type PathScope = 'workspace' | 'system' | 'external' | 'unknown'
type PathVisibility = 'exact' | 'workspace_relative' | 'basename' | 'opaque' | 'omit'
```

规则如下：

1. `workspace` 路径：Agent 诊断默认使用 `workspace_relative`；需要精确调用外部工具时才使用 `exact`，并受当前会话 workspace 授权约束。
2. `system` 路径：公共系统目录和可执行文件路径通常可作为低敏诊断事实保留，但不得因此放宽同一输出中的秘密、用户目录或文件内容。
3. `external` 路径：默认使用 `basename`、类别或 `opaque`，除非用户明确授权该外部位置是本次任务的目标。
4. `unknown` 路径：Agent 诊断出口使用有界、带秘密过滤的上下文；远程出口直接省略原始片段并保留 `pathScope=unknown`、字节数和原因。
5. 自由文本中无法确定边界的片段：严格出口不得依赖诊断关键词猜测正文；应按“当前不确定片段”降级，而不是吞掉或保留整行。

`C:\`、`/usr/bin` 这类系统根路径本身通常不是敏感信息；用户目录、项目目录、客户名、网络挂载点和凭据文件位置则可能敏感。测试必须分别验证“可保留的诊断路径”和“必须限制的用户/业务路径”，不能只用“所有绝对路径均不得出现”作为唯一断言。

### 4.6 秘密和环境变量规则

环境变量按值和用途分类，不把整个环境作为一个可展示对象：

- `API_KEY`、`TOKEN`、`PASSWORD`、`COOKIE`、私钥内容等原值：所有出口拒绝；
- `HOME`、用户名、内部服务地址：按路径/基础设施元数据策略处理；
- `PATH`、`LANG`、`SHELL`、OS 类型：通常可作为有限诊断事实保留；
- 新增环境变量必须进入明确 allowlist，默认不能因为“只是调试”而输出。

秘密检测应覆盖结构化字段和自由文本兜底，但秘密检测结果不能改变进程终态：脱敏失败或输出被省略时，只能设置 `redacted`、`redactionReason`、`visibleBytes` 等元数据，不能把 `exitCode=0` 改成命令失败。

### 4.7 脱敏模块的验收标准

- 同一个执行结果经过 Agent、历史和 telemetry 三个投影后，字段差异符合各自 allowlist；不能用一个字符串断言覆盖三种出口。
- Agent 在授权 workspace 内仍能看到足以定位问题的 cwd、库名、错误类型、行号和必要路径上下文。
- `/usr/bin/python3`、公开包名/version 等低敏事实不会被无条件删除。
- 用户名、客户名、私有项目名、workspace 外路径和秘密文件内容不会进入未授权出口。
- token、密码、Cookie、私钥和秘密环境变量值在所有出口都不出现原值。
- 原始 stdout/stderr 仅在 Agent/local policy 允许且有界时保留；远程日志只保留结构化摘要、大小、hash、fingerprint 或 artifactId。
- 实时和历史 Agent payload 等价；telemetry payload 不因复用 Agent serializer 而意外包含原文。
- 模糊路径在严格出口中安全省略并返回稳定原因；在 Agent 诊断出口中不会为了脱敏误报执行失败或吞掉可确认的错误类型/行号。
- 引入新字段时，没有 allowlist 的字段不会自动进入任何远程出口。

### 4.8 DSH 参考结论

对 `deepseek-harness` 的 shell、session 和 telemetry 设计的对照表明，成熟的做法不是把所有模型可见文本做成“零路径”结果：

- shell executor 先产生 typed process facts，模型结果可以包含有界 stdout/stderr、退出状态和必要的输出引用；
- session history 重放模型实际看到的 `tool_result`，不在历史链路中另行发明一套更激进或更宽松的文本规则；
- telemetry 是独立的 outbound projection，可只保留稳定状态、大小、fingerprint 和关联 ID；
- 凭据继承、任意环境变量和权限范围在执行入口控制，而不是等命令输出完成后依赖正则补救。

本计划采用这一分层思想，但不直接照搬 DSH 的默认暴露程度：默认 Agent policy 仍应隐藏秘密，并按会话 workspace 授权决定路径和业务内容可见范围；需要严格隐私的部署则选择更严格的 Agent/telemetry policy。评审时应分别检查“Agent 是否还能诊断”和“远程出口是否最小化”，不能用“所有出口都不能出现绝对路径”代替两项判断。

## 5. 解决方案设计

### 5.1 建立统一的执行结果模型

为所有进程型工具建立内部结果模型，至少包含：

```ts
type ProcessExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'spawn_failed'
  | 'signalled'
  | 'timed_out'
  | 'cancelled'
  | 'output_limited'
  | 'result_invalid'

interface ProcessExecutionResult {
  status: ProcessExecutionStatus
  exitCode: number | null
  signal?: string | null
  signalSource?: 'external' | 'supervisor' | null
  stdout: string
  stderr: string
  cwd: string
  executable: string
  shell: string
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  persistedOutputPath?: string
  caseId: string
}
```

判定规则必须单一且明确：

| 条件 | status | `success` |
|---|---|---:|
| 进程启动成功，退出码为 0，未取消/超时 | `succeeded` | `true` |
| 进程启动成功，退出码非 0 | `failed` | `false` |
| spawn 抛错或 executable 不存在 | `spawn_failed` | `false` |
| 进程被外部信号终止 | `signalled` | `false` |
| 超时终止 | `timed_out` | `false` |
| 用户取消 | `cancelled` | `false` |
| 达到输出上限 | `output_limited` | `false` |
| 有终态但无法生成合法 result data | `result_invalid` | `false` |

特别要求：`exitCode === 0` 时，除非有明确的 `result_invalid` 或传输错误，不得显示“命令失败”。空 stdout 是合法结果，不是失败原因。通用执行器不得猜测命令“应该有输出”，也不得默认生成 `OUTPUT_EMPTY`；只有测试探针或调用方显式声明 `expectOutput` 时，才允许由外层 oracle 判断输出缺失。

### 5.2 建立实时与历史共用的 canonical Agent payload serializer

失败分支应继续向 Agent 传递结构化诊断，而不是只传 `error` 字符串。该序列化器必须位于 shared 层，由实时 `toolChatLoop` 和 `buildToolResultBlock()` 共同调用；不能分别在 Electron 和历史重建代码中拼 JSON。

建议接口如下：

```ts
function serializeAgentToolResult(input: {
  success: boolean
  error?: string
  userMessage?: string
  data?: unknown
  diagnostic?: unknown
}): string

function buildToolResultBlock(
  tc: ToolCallRecord,
  options?: BuildToolResultBlockOptions
): ToolResultBlockBuild {
  // success=false 也把 result.data 交给同一 serializer；没有 data 时显式输出 null。
}
```

实时路径再由轻量包装器补充 `tool_use_id` 和 `is_error`；历史路径由 `buildToolResultBlock()` 复用同一 `serializeAgentToolResult`，再执行同一超长压缩策略。

Agent 可见内容建议是稳定 JSON，而不是把错误字符串和结果字段拼接成不稳定自然语言：

```json
{
  "ok": false,
  "error": "SHELL_PROCESS_EXIT",
  "userMessage": "命令执行失败，请检查命令后重试",
  "data": {
    "status": "failed",
    "exitCode": 1,
    "stdout": "...",
    "stderr": "具体错误...",
    "cwd": "当前工作目录的安全相对表示",
    "shell": "bash",
    "durationMs": 84,
    "truncated": false,
    "caseId": "SHELL_PROCESS_EXIT"
  }
}
```

历史 round-trip 必须满足：

```text
executor result
  → fact aggregation / ToolCallRecord
  → serializeToolCallsForDb
  → deserializeToolCallsFromDb
  → serializeAgentToolResult
  → buildClaudeToolChatMessages
  → API tool_result
```

执行后紧邻的下一轮与应用重启后的下一轮必须产生等价的 Agent payload；允许外围消息 id、压缩时机和日志字段不同，但不能丢失 `error`、`data.status`、`exitCode`、`signal`、stderr 摘要和 `caseId`。

安全策略：

- 任何出口都不暴露 API key、秘密环境变量、私钥和无界堆栈；Agent 诊断是否保留绝对路径按授权 workspace 和第 4 节的出口策略判断；
- `cwd` 在 Agent 诊断中优先使用 workspace-relative 表示，在远程日志/遥测中使用 scope、fingerprint 或 opaque ID；
- stderr/stdout 不直接复用现有 `sanitizeToolOutputText`：该函数会把命中 `node_modules` 等文本的整段输出转换成错误文案。应按出口调用结构化 projection；自由文本兜底只能保留错误类型、行号等可确认上下文，并叠加长度上限；
- 新脱敏器还必须遮盖秘密值：敏感键赋值（如 `API_KEY`、`TOKEN`、`COOKIE`、`SECRET`）、Bearer token、常见凭据格式和私钥片段；遮盖值但保留错误类型、命令上下文、文件名和行号；
- `persistedOutputPath` 不直接暴露宿主绝对路径，可返回 `artifactId` 或“可继续读取”的工具引用；
- 内部日志保留更完整的 caseId、requestId、toolUseId 和字节统计。

### 5.3 增加“结果完整性校验”

在执行器返回和进入 LLM 前各增加一次校验：

```text
spawned/close event
  → normalizeProcessResult
  → validateProcessResult
  → serializeToolResult
  → validateSerializedToolResult
  → send to Agent
```

当出现以下不可能组合时，不再静默替换为通用错误：

- `success=false`、`exitCode=0`、`status=succeeded`；
- 在结果契约要求保留输出字段时，`status=succeeded` 但结果缺少 stdout/stderr 字段；
- 子进程 `close` 有输出字节统计，但序列化 payload 中 stdout/stderr 为空；
- `status=failed` 却没有 exitCode、signal 或 spawn error 原因；
- 工具结果只有通用 error，且原始 executor data 存在。

建议使用专用 caseId：

- `SHELL_RESULT_CONTRACT_VIOLATION`：执行器结果内部不一致；
- `SHELL_OUTPUT_CAPTURE_LOST`：执行器有输出统计，但最终 payload 没有输出；
- `SHELL_RESULT_SERIALIZATION_FAILED`：JSON/消息适配失败；
- `SHELL_AGENT_PAYLOAD_DEGRADED`：为安全或大小原因降级，需说明降级原因。

### 5.4 覆盖所有失败入口的 Agent payload

统一 payload 不能只覆盖 `runShellExecutor` 的最终通用失败分支。以下入口都必须走同一个 schema：

| 失败入口 | 是否有进程结果 | Agent payload 最少内容 |
|---|---:|---|
| 输入校验失败 | 否 | 稳定错误码、参数字段、可修复提示 |
| 未知工具/工具未启用 | 否 | 工具名、可用工具提示、稳定错误码 |
| 授权拒绝/授权撤销 | 否 | `policy` 类别、拒绝原因、是否可重新授权 |
| Shell 预检拒绝 | 否 | `policy` 类别、规则/风险摘要、替代方式 |
| 用户取消/确认拒绝/确认超时 | 可能有/无 | 决策状态、终止原因、已有输出摘要 |
| Shell plan 失败 | 否 | plan 错误码、dialect/executable 摘要、修复提示 |
| spawn 失败 | 否 | `spawn_failed`、executable、cwd token、底层错误类别 |
| 进程非零退出 | 是 | status、exitCode、signal、stdout/stderr、cwd、shell |
| 外部 signal 终止 | 是 | `signalled`、exitCode=null、signal、signalSource |
| 超时/输出超限 | 是 | status、terminationReason、已有输出、artifact 引用 |
| 依赖恢复分支 | 通常否 | dependency code、恢复动作、是否已激活恢复 Skill |
| executor 抛异常/结果非法 | 不确定 | `executor`/`result_invalid`、requestId、可关联诊断信息 |

`toolChatLoop` 不应让授权、预检、执行异常和依赖恢复继续使用各自的纯字符串出口。进程工具没有进程结果时，payload 应明确 `processResult: null`；普通/MCP 工具不得被强行补成 shell 结构。

`run_script` 的 spawn error、取消等分支也必须在同一阶段补齐最小结构化结果，不能推迟到后续阶段才统一。

### 5.5 将用户文案和 Agent 诊断分离

建议 `ToolExecutorResult` 扩展为：

```ts
interface ToolExecutorResult {
  success: boolean
  error?: string           // 稳定错误码或短错误标题
  userMessage?: string     // UI/IM 面向用户的文案
  data?: unknown           // Agent 与事实管线使用的结构化结果
  diagnostic?: {
    caseId: string
    retryable: boolean
    category: 'command' | 'environment' | 'executor' | 'transport' | 'policy'
  }
  duration?: number
}
```

其中：

- `error` 用稳定 code，例如 `SHELL_PROCESS_EXIT`，供重试策略使用；
- `userMessage` 承担“请检查命令后重试”等简洁显示；
- `data` 传给 Agent，包含脱敏后的事实；
- `diagnostic` 决定是否重试和是否需要上报基础设施问题。

### 5.5.1 结果投影必须按工具身份分流

进程结果的字段白名单不是通用工具结果的 schema。`status`、`stdout`、`stderr`、`cwd`、`executable` 等字段在 MCP 或普通工具中可能只是业务字段，不能通过字段名猜测“这是进程结果”。

因此结果链路必须先取得可信的工具身份，再选择投影策略：

```text
toolName ∈ {run_shell, run_script, run_lark_cli}
  → process result contract
  → PROCESS_KEYS / process status 校验
  → Agent、local history、telemetry 的进程投影

其他内置工具、注册工具、MCP 工具
  → generic tool result contract（只校验 success 外层契约）
  → 递归文本/秘密脱敏
  → 保留 data 中的合法业务字段，不套用 PROCESS_KEYS
```

工具身份应在实时执行、事实持久化、历史重放和日志投影四个边界显式传递；新增进程型工具必须加入集中维护的进程工具注册表，而不是依赖结果内容自动识别。普通工具的 `status: 'failed'` 不得改写外层 `success`，其 `stdout`、`code`、`issueId`、`summary` 等字段也不得因命中进程字段名而丢失。

完成判据：

- MCP 成功返回 `status: 'failed'` 时，外层仍为 `success: true`，且业务字段完整保留；
- MCP/普通工具返回 `status: 'connected'`、`stdout` 或 `code` 时，Agent 实时 payload 与历史重放都保留无敏感业务数据；
- 只有显式进程工具触发 `succeeded`/`failed` 一致性校验和 `PROCESS_KEYS` allowlist；
- 普通工具仍经过通用递归脱敏，秘密和绝对路径不会因“保留开放字段”而原样穿透；
- 进程工具、普通工具和 MCP 工具各有至少一个执行链路回归测试，且工具类型判断不在多个出口复制。

### 5.6 改进 stdout/stderr 采集的可观测性

针对本会话暴露出的“exit 0 + stdout 被错误替换/降级”问题，增加以下指标和日志字段：

| 阶段 | 必须记录的字段 |
|---|---|
| spawn | executable、args 是否脱敏、cwd token、pid、shell profile |
| data | stdoutBytes、stderrBytes、chunkCount、firstOutputAt |
| close | rawExitCode、signal、interrupted、timedOut、truncated |
| normalize | decoder flush 字节数、sanitize 前后长度 |
| redact | 是否脱敏、脱敏原因、原始/可见字节数、是否保留错误上下文 |
| serialize | data 是否存在、payload 长度、是否 compacted |
| Agent handoff | tool_result 是否含 data、is_error、最终 content 摘要 |

不要在日志中记录完整命令输出或敏感命令参数；可记录哈希、长度和安全摘要。只有在采集阶段原始字节非零、且不存在合法的脱敏或压缩解释时，才标记 `SHELL_OUTPUT_CAPTURE_LOST`。如果全部内容因安全策略被隐藏，应标记 `SHELL_AGENT_PAYLOAD_DEGRADED` 并保留 `redacted=true`、`redactionReason`，不能误报为 capture lost。对 `ls -a` 这类可重复问题，可增加仅测试环境启用的 `captureProbe` 字段，用来区分“子进程没有输出”“输出被脱敏”和“结果在链路中丢失”。

### 5.7 调整重试和降级行为

重试不应只按错误文本或稳定错误码判断。命令级失败必须包含调用身份；基础设施失败则使用独立作用域。建议使用两个层次的键：

```text
commandRetryKey = toolName
  + normalizedErrorCode
  + status
  + exitCodeOrSignal
  + shellProfile
  + invocationFingerprint

infraBreakerKey = executorScope
  + infrastructureCaseId
  + dependencyFingerprint
```

其中 `invocationFingerprint` 基于规范化后的工具输入或冻结的 Shell plan 计算不可逆摘要，至少覆盖规范化 command、cwd、shell profile、plan digest 和与执行语义相关的参数；不得把原始命令、token、密码或完整路径写入 retry key、日志或用户提示。若 `planDigest` 已明确覆盖这些字段，可直接使用其摘要；否则必须补充独立 fingerprint。

两类键不能混用：

- `process_exit`、`timed_out`、`output_limited` 等命令级结果按 `commandRetryKey` 计数；
- executable 缺失、结果契约违反、transport 故障等基础设施问题按 `infraBreakerKey` 在会话/执行器范围熔断，可跨命令快速停止；
- `SHELL_DIALECT_MISMATCH` 由现有 dialect breaker 作为唯一计数来源，通用 retry tracker 不再重复累计；
- 不同 command、cwd、plan digest、exit code 或 signal 默认重置命令级连续失败计数。

行为建议：

1. 第一次 `process_exit`：向 Agent 返回 stderr、exitCode、signal、cwd 和 invocation fingerprint 的非敏感摘要，允许基于证据修正。
2. 第一次 `SHELL_OUTPUT_CAPTURE_LOST` 或 `SHELL_RESULT_CONTRACT_VIOLATION`：按基础设施错误处理，立即停止同类基础设施重试，提示“执行器结果异常”，保留 requestId 供日志关联。
3. **同一 commandRetryKey 连续三次**才停止命令级工具循环；三个不同命令即使都为非零退出，也不得触发“相同错误”停止。
4. 同一命令但 cwd、plan digest、exit code 或 signal 改变时，不得错误累计；如果调用方明确声明这是同一重试，可由上层显式传入 retry group，而不是依赖错误文本猜测。
5. `du`、递归搜索等大输出任务：提示使用 `head_limit`、分目录执行或专用目录工具，不让 Agent 无限扩大命令范围。

## 6. 实施顺序

### Phase 0：修复确定性根因并补回归测试

- 先为成功 stdout 包含 `node_modules`、`dist-electron`、绝对路径，以及失败 stderr 包含 traceback/路径/真实错误的场景增加回归测试，并分别断言 Agent 与 telemetry 两种出口；
- 修复 stdout/stderr 投影：不再把正常输出转换成错误文案；增加按出口的 `redacted`、`redactionReason`、`originalBytes`、`visibleBytes`；
- 为 `cd ... && ls -a` 增加真实 shell executor 回归测试，确认目录输出保持可见；
- 为 `close(code, signal)` 增加外部 SIGTERM/SIGKILL、超时和取消回归测试；
- 为 stdout 有输出、stderr 有输出、exit 0、exit 非 0、空输出、超时、取消、输出超限分别固定结果；
- 增加成功输出中的 `node_modules`、系统路径、workspace 路径、workspace 外路径、API key/Bearer token，以及含 traceback 的失败 stderr 语料；断言低敏诊断事实在 Agent 出口可保留、秘密在所有出口消失、远程出口不带原文；
- 严禁用命令“预期输出”作为通用失败判定；`OUTPUT_EMPTY` 只能由显式 oracle 使用；
- 先不改变 UI 文案，确保可以区分执行器结果和 Agent payload。

### Phase 1：统一所有失败入口的 Agent payload

- 修改 `toolChatLoop`，成功与失败结果统一走结构化 `buildToolExecutionResult`；
- 抽取 shared 层 canonical `serializeAgentToolResult`，让实时 tool loop 和 `src/shared/claudeToolHistory.ts` 的 `buildToolResultBlock()` 共用；调用方必须传入工具身份，不能由结果字段猜测是否为进程工具；
- 修复 `buildToolResultBlock()`：`success=false` 时也保留持久化的 `result.data`，继续输出 `is_error=true`；
- 增加 `serializeToolCallsForDb → deserializeToolCallsFromDb → buildClaudeToolChatMessages` 的失败结果 round-trip 测试；
- 覆盖授权拒绝、确认拒绝/超时、预检拒绝、plan 失败、spawn 失败、执行异常、依赖恢复和普通 executor 失败；
- `run_shell`、`run_script` 的所有终态都生成最小结构化结果；有进程结果时保留脱敏 stdout/stderr、exitCode、signal、status，无进程结果时显式返回 `processResult: null`；
- 将 `error` 改为稳定 code，面向用户的中文文案单独生成；
- 保留 `is_error=true`，但不再用它替代诊断 payload。

### Phase 2：完善结果终态与链路校验

- 在 runner/adapter 中禁止用“stdout 为空”推导失败；
- 明确处理 exit code、`close(code, signal)`、timeout、abort、external signal、spawn error；
- 对可疑的输出丢失记录 `SHELL_OUTPUT_CAPTURE_LOST`，但只在有独立字节统计/探针证据时触发；
- 对工具执行结果 schema 做运行时校验。

### Phase 3：完善执行资源和大输出策略

- 检查 `node_modules`/pnpm 链接目录的 `du` 场景，避免执行器等待或采集异常；
- 大输出使用有界缓冲区和 artifact 引用，不让 Agent 接收无界内容；
- 为递归统计提供专用工具或更适合的命令建议；
- 验证 stdout/stderr decoder 在 close 时一定 flush，并在错误路径也 settle Promise。

### Phase 4：扩展到其他进程型工具

- 将 `run_lark_cli`、subagent 等接入同一 process result contract；`run_script` 的最小终态已在 Phase 1 完成；
- 统一错误码、重试分类、诊断字段和用户文案；
- 统一内部日志事件与审计字段，避免每个工具单独包装错误。

## 7. 测试方案与验收标准

### 7.1 单元测试

至少覆盖：

```text
echo hello                         → success=true, exitCode=0, stdout=hello
cd existing && ls -a              → success=true, exitCode=0, stdout 非空
printf 'node_modules\n'            → success=true，原样保留安全目录名，不得变成失败文案
printf '/usr/bin/python3 dist-electron\n' → success=true；系统路径和普通目录名不改变成功状态
printf '/Users/alice/project/app.py\n'    → Agent 诊断按 workspace policy 投影；telemetry 不保留原始路径
printf err >&2; exit 1             → success=false, exitCode=1, stderr=err
printf 'Traceback: /tmp/x/a.py:3\nValueError: bad\n' >&2; exit 1
                                   → 保留异常类型、行号和上下文，仅脱敏路径片段
command-not-found                 → success=false, 非零退出或 spawn/command case
外部 SIGTERM/SIGKILL               → status=signalled, exitCode=null, signal 有值
sleep ...                          → timed_out，含 termination 信息
大于 inline 上限的输出             → output_limited 或 succeeded+truncated，契约一致
成功 executor + data               → Agent tool_result 包含 data
失败 executor + data               → Agent tool_result 仍包含 data
失败 result 持久化后历史重建         → 与实时 payload 等价，仍含 exitCode/signal/status/stderr/caseId
exitCode=0 + 空 stdout             → 不得映射成命令失败
结果 data 在序列化前后丢失          → SHELL_OUTPUT_CAPTURE_LOST
同一命令/同一失败事实连续三次        → 才触发命令级停止
三个不同命令均非零退出              → 不得触发“相同错误”停止
同一命令 cwd/plan/exitCode 改变       → 不得错误累计
命令 retry key / 日志含秘密           → 必须失败
```

### 7.2 集成测试

- 使用与生产一致的 tool loop，检查模型下一轮实际收到的 `tool_result`；
- 对 `cd deepseek-harness/apps/web && ls -a` 断言最终 Agent payload 有目录输出；
- 检查失败时 Agent 能看到 `exitCode`、`stderr`、`status`、`caseId`；
- 执行失败结果写入 `ToolCallRecord` 后经 DB codec 恢复，调用 `buildClaudeToolChatMessages()`，断言历史 `tool_result` 与实时 payload 保持关键字段等价；
- 模拟应用重启/会话恢复/全量 history 重建，确认失败结果不会退化成只有 error 字符串；
- 检查用户 UI 仍可只显示简洁中文错误；
- 检查连续相同基础设施错误不会重复执行三次以上；
- 验证同一命令/同一失败事实连续三次才停止，三个不同命令的非零退出不会合并计数；
- 验证命令级 retry key 包含调用指纹，cwd、plan digest、exitCode 或 signal 改变时计数重置；
- 验证基础设施 breaker 可跨命令熔断，而 dialect breaker 不与通用 retry tracker 双重计数；
- 验证 retry key、日志和用户提示不含原始命令中的 token、密码或其他秘密值；
- 检查日志中可用 `requestId + toolUseId` 串起 spawn、close、serialize、handoff 四个阶段。

### 7.3 验收标准

1. 合法的 `cd ... && ls -a` 不再出现 `exitCode=0` 同时显示“命令执行失败”；输出中出现 `node_modules` 也不改变成功状态。
2. 任意 `run_shell` 失败结果至少向 Agent 提供：错误类别、exitCode 或 signal、stderr/stdout 摘要、cwd token、shell、status、是否截断。
3. 外部 signal、主动超时、用户取消和普通非零退出使用不同的 `status`、`terminationReason`、`exitCode` 和 `signal` 组合。
4. 真实命令失败、Python 环境失败、Shell 启动失败、策略拒绝、结果采集失败使用不同的错误码和处理路径。
5. 执行器有结构化 `data` 时，工具循环不得因 `success=false` 丢弃该 `data`；所有失败入口都符合统一 schema。
6. Agent、历史和 telemetry 不共用一个万能 sanitize 字符串；进程工具遵守进程字段 allowlist，普通/MCP 工具遵守通用递归投影，路径投影保留可确认的 traceback、错误类型和行号，并返回 redaction 元数据。
7. 不会因通用命令 stdout 为空生成 `OUTPUT_EMPTY`；只有显式 oracle 才能判断输出缺失。
8. 发生结果链路丢失时，日志能定位丢失发生在采集、规范化、序列化还是 Agent handoff 阶段。
9. 同类错误三次内停止无效重试，并把可操作的诊断信息交给用户或 Agent。
10. 实时下一轮与持久化历史重建对同一失败工具调用产生等价的 Agent-safe payload；应用重启后仍保留 `exitCode`、`signal`、`status`、stderr 摘要和 `caseId`。
11. 三个不同命令即使都以非零状态退出，也不会因为共享稳定错误码而触发命令级重复错误熔断；只有同一 `commandRetryKey` 连续失败才计入同一命令。
12. 命令级 retry key 不包含原始命令明文或秘密值；基础设施级错误和方言专用 breaker 使用独立计数作用域。

## 8. 代码落点

| 文件 | 建议改动 |
|---|---|
| `electron/tools/runShellExecutor.ts` | 修复成功输出脱敏污染；统一 process result；消费 `close(code, signal)`；补充 capture/contract caseId |
| `electron/toolChatLoop.ts` | 所有失败入口统一生成 Agent payload，失败时保留 `execResult.data` |
| `src/shared/claudeToolHistory.ts` | 历史 `tool_result` 复用 canonical serializer；失败结果保留 `data` 并保持 `is_error=true` |
| `src/shared/claudeToolHistory.test.ts` | 覆盖失败结果历史重建、超长压缩和实时/历史 payload 等价性 |
| `electron/messageCodec.ts` | 确认机器错误码、Agent-safe data、diagnostic 元数据持久化 round-trip 不丢失 |
| `electron/tools/toolUserErrors.ts` | 保留 UI 用户文案；不再把 Agent 输出交给错误文案转换 |
| `electron/tools/toolErrorCommon.ts` | 收紧“内部细节”判定，不能把裸 `node_modules` 等普通输出当作秘密 |
| `src/shared/agentSafeText.ts` / 结果 projection 相关文件 | 将自由文本脱敏限定为兼容兜底；按 Agent/local/telemetry 出口拆分策略，避免一个字符串函数承担所有出口 |
| `electron/tools/types.ts` | 扩展 `ToolExecutorResult` 的 diagnostic/userMessage 和最小终态字段 |
| `electron/toolErrorRetryPolicy.ts` | 引入命令级 invocation fingerprint、基础设施 breaker 和 dialect breaker 的作用域边界 |
| `electron/toolErrorRetryPolicy.test.ts` | 覆盖不同命令不合并、同一调用三次才停止、指纹变化重置和秘密不泄露 |
| `electron/tools/runShellExecutor.test.ts` | 增加脱敏、stdout/stderr、exit code、signal、超时、输出限制回归测试 |
| `electron/toolChatLoop.*.test.ts` | 增加所有失败入口的 tool_result 结构和重复重试测试 |
| `electron/tools/toolUserErrors.test.ts` | 验证 UI 文案与 Agent payload 解耦 |
| `src/shared/domainTypes.ts` / 结果协议相关文件 | 若需要，将稳定的 shell result schema 共享给 renderer/远程链路 |
| `electron/shell/*` | 将 capture、serialization、process lifecycle 的 caseId 和指标集中管理 |

## 9. 不建议的修复方式

- 只把“命令执行失败，请检查命令后重试”改成更长的自然语言；
- 只增加重试次数；
- 让 Agent 继续尝试更多 `du` glob 变体；
- 直接取消错误脱敏，暴露完整绝对路径、环境变量或堆栈；
- 仅依赖内部日志而不修复 Agent 可见的 `tool_result`；
- 把所有 `exitCode=0 + 空 stdout` 都当成失败；
- 将 `run_shell` 的执行器异常与 `run_script` 的 Python 配置错误合并为同一错误码。

## 10. 最终判断

这次问题应按“**执行结果链路可靠性 + Agent 诊断契约 + 调用级重试身份**”处理，而不是按“Agent 命令写错”处理。

最优先的改动是：**先修复 stdout/stderr 脱敏器把正常输出转换成失败文案的问题，再修复 `close(code, signal)` 的终态建模，并让所有失败入口及历史重建统一保留结构化 Agent payload；同时在同一阶段修复命令级 retry key 的调用指纹。** 结果采集、序列化和 handoff 观测是后续防线，不应取代对已确认脱敏根因的修复。这样才能直接消除目标会话中的 `exitCode=0` 假失败，同时让真实的非零退出、signal 终止、环境失败、策略拒绝和不同命令的独立重试可被 Agent 区分处理。

## 11. 本次 TDD 实施记录

本计划已在独立 worktree `codex/run-shell-command-failure-diagnosis-tdd` 中完成实现与验证。本节同时区分“已落地的第一阶段兼容加固”和“本轮新增的数据出口策略”：后者已经形成 shared projection 模块并接入 Agent/history 与进程日志；未来新增进程型工具仍必须显式选择出口策略，不能退回万能字符串脱敏。

- [x] 普通输出不再复用面向用户的错误文案脱敏；`node_modules`、`dist-electron` 等普通目录名不会改变成功状态。
- [x] 路径采用逐片段脱敏，保留 traceback、错误类型、行号和上下文，并返回脱敏元数据。
- [x] `close(code, signal)` 建模为 `status=signalled`、`exitCode=null`、`signal` 和 `terminationReason=external_signal`；timeout/cancel/output-limit 保留原有独立终态。
- [x] 非零退出使用稳定错误码 `SHELL_PROCESS_EXIT`，同时保留 Agent-safe stdout/stderr、退出码、状态、shell、plan digest 和终止信息。
- [x] 失败 executor 的结构化 `data` 不再被实时 tool loop 丢弃；历史 `tool_result` 重建复用 shared canonical serializer 并保持 `is_error=true`。
- [x] 增加 `userMessage`、`diagnostic` 扩展位，区分 UI 文案、稳定错误码和 Agent 诊断事实。
- [x] 命令级 retry key 使用不可逆调用指纹；基础设施错误分类独立，retry key 不包含命令明文。
- [x] `run_script` 所有终态统一返回稳定错误码、`processResult`/状态、退出码或 signal、超时/取消原因及 Agent-safe stdout/stderr。
- [x] `run_lark_cli` 的输入校验、依赖缺失、超时和非零退出统一返回结构化 Agent payload，不再只返回用户文案。
- [x] tool loop 在 executor 返回值进入 Agent 前执行运行时契约校验；非法结果转换为 `SHELL_RESULT_CONTRACT_VIOLATION`，无进程失败显式带 `processResult: null`。
- [x] shell 结果记录 stdout/stderr 字节统计，并在有独立统计但安全 payload 为空时标记 `SHELL_OUTPUT_CAPTURE_LOST`。
- [x] 补充成功输出、失败 stderr、路径脱敏、历史失败 payload 和 retry key 回归测试。
- [x] 新增 `processResultProjection`：按 Agent、local history、telemetry 三个出口投影结构化进程事实；Agent/history 共享结果，telemetry 只保留 allowlist、字节统计、指纹和路径 scope。
- [x] 路径字段按 `workspace/system/external/unknown` 分类；workspace 在 Agent 出口转相对路径，系统可执行文件保留低敏诊断事实，外部路径降级，telemetry 不输出原文路径。
- [x] Agent/history 输出增加默认大小上限；自由文本补充私钥块阻断；`diagnostic` 和进程字段均采用 allowlist，未知字段不自动透传。
- [x] tool loop 将当前授权 workspace 传入实时 payload 与持久化 fact 投影，确保实时/历史结果一致；进程日志使用 telemetry 投影并注入 SHA-256 指纹实现。
- [x] v16 修复：集中维护 `run_shell`、`run_script`、`run_lark_cli` 的进程工具身份；实时结果、事实持久化、历史重放和日志投影只有在显式进程工具上下文中才使用进程契约与 `PROCESS_KEYS`。
- [x] v16 修复：普通内置工具、注册工具和 MCP 工具改用通用递归投影，保留合法 `status`、`stdout`、`code`、业务字段及同级数据；普通结果缺少错误字段时使用独立的 `TOOL_RESULT_CONTRACT_VIOLATION`，不污染 shell 契约。
- [x] 桌面端安装后的默认配置启用 `run_shell`：`DEFAULT_SHELL_CONFIG.enabled=true` 且默认拒绝列表不包含 `run_shell`；已有用户的显式关闭配置保持不变，远程链路继续由锁定策略拒绝执行。

验证结果：默认开启改动的聚焦测试 4 个文件、12 个用例通过；最终 v16 修复聚焦测试 5 个文件、62 个用例通过；`npm run typecheck:shared`、`npm run typecheck:renderer` 通过；在允许本机监听/真实子进程的执行环境中，全量 `npm test -- --reporter=dot` 为 518 个测试文件、3273 个用例通过；`git diff --check` 通过。全量测试产生的性能基准 JSON 已恢复为原始内容。
