# Shell 与进程工具 Agent-safe 边界加固计划

> 文档日期：2026-09-10
> 适用 worktree：`run-shell-command-failure-diagnosis-tdd`
> 关联主计划：`docs/develop/run-shell-command-failure-diagnosis-and-remediation-plan.md`
> 目标：解决多轮评审中反复出现的路径泄漏、日志旁路、实时/历史链路不一致问题。
> 实施方式：严格采用 TDD；每个步骤必须先有失败测试，再实现，再运行对应验证。

## 1. 计划结论

当前问题不是单个路径正则缺少分支，而是安全边界分散在多个调用点：

```text
executor result
  ├─ Agent tool_result serializer
  ├─ tool.error / tool.result 日志
  ├─ shell.precheck / shell.confirm / shell.security 日志
  ├─ 开发态异常 message / stack / cause
  ├─ 数据库持久化与历史重建
  └─ UI / IM 用户文案
```

如果继续在自由文本正则上追加规则，会在“路径泄漏”和“错误上下文被吞掉”之间反复切换。此次计划将安全边界改为：

1. 结构化字段优先，不把原始 command、code、cwd、executable、artifact path 写入 Agent 日志。
2. Agent payload 使用唯一 canonical serializer；实时和历史链路不得自行拼接。
3. stdout/stderr 在日志中只保留元数据；Agent payload 才保留经过专用策略处理的诊断文本。
4. 结构化路径字段使用字段级投影；自由文本路径脱敏只作为保守兜底，不承担完整解析职责。
5. 无法安全判断边界时，宁可省略文本并返回稳定的 redaction 元数据，不猜测路径边界。

## 2. 非目标与安全原则

### 2.1 非目标

- 不保证从任意自然语言中无损恢复所有路径语法。
- 不在 Agent 日志中保留 stdout/stderr 摘要来满足人工排障需求；人工排障应使用本地 artifact 或受控诊断工具。
- 不把用户可见中文错误文案当作 Agent 诊断协议。
- 不通过新增第三方依赖解决路径解析或脱敏问题。

### 2.2 安全原则

- 默认拒绝：没有明确 allowlist 的字段不得进入 Agent 日志。
- 结构化优先：能用 bytes/hash/status 表达的，不保存原文。
- 原文隔离：原始 command、script、stdout、stderr、cwd、executable 只能留在执行和 artifact 内部链路。
- 单一出口：所有实时 Agent payload、历史 Agent payload、Agent 日志都必须经过统一投影函数。
- 稳定契约：脱敏失败返回稳定的 `redactionFailed` / `serializationFailed` 状态，不抛异常、不伪造进程失败。
- 可验证：每个敏感字段都必须有“不出现原值”的测试；每个诊断字段都必须有“保留结构化信息”的测试。

## 3. 目标安全模型与数据分类

### 3.1 数据分类

| 类别 | 示例 | Agent payload | Agent 日志 | 持久化内部结果 |
|---|---|---:|---:|---:|
| 稳定状态 | `success`、`status`、`exitCode`、`signal` | 保留 | 保留 | 保留 |
| 稳定错误码 | `SHELL_PROCESS_EXIT`、`SCRIPT_TIMEOUT` | 保留 | 保留 | 保留 |
| 结构化诊断 | `caseId`、`terminationReason`、`stdoutBytes` | 保留 | 保留 | 保留 |
| command / script 原文 | shell 命令、Python 源码 | 仅按 Agent-safe 规则处理 | 禁止 | 内部短生命周期 |
| cwd / executable | `/Users/...`、`/usr/bin/...` | 禁止原文 | 禁止原文 | 内部执行需要 |
| stdout / stderr 原文 | 用户文件、token、traceback | 经过专用输出投影 | 禁止 | 可进入 artifact |
| artifact 绝对路径 | `persistedOutputPath` | 禁止；替换为 opaque artifactId | 禁止 | 内部结果保留 |
| 用户文案 | `userMessage` | 可保留 | 仅保留稳定分类 | 持久化保留 |

### 3.2 不变量

对 `run_shell` 和 `run_script` 的任意成功、失败、超时、取消、spawn 失败、拒绝和确认路径，以下内容不得出现在 Agent 日志或 Agent tool_result 字符串中：

- 原始 command 或 script source；
- 原始 cwd、executable、pythonPath、artifact absolute path；
- 原始 stdout/stderr；
- 原始异常 stack、cause message 或包含宿主路径的 error detail；
- 可逆的宿主文件名（artifactId 也必须是 opaque ID）。

同时必须保留：

- 稳定错误码和状态；
- 退出码、signal、terminationReason；
- stdout/stderr 字节数、截断状态、artifact 是否存在；
- 可供 Agent 判断下一步的安全错误类型和结构化诊断。

## 4. 分阶段实施计划

### 阶段 A：建立安全投影 API 与测试夹具

#### A1. 定义数据投影类型

涉及文件：

- 新增 `src/shared/agentSafeProjection.ts`；
- 可复用 `src/shared/agentToolResult.ts` 的稳定错误契约；
- 新增 `src/shared/agentSafeProjection.test.ts`。

TDD 顺序：

1. RED：测试未知字段默认丢弃；稳定字段被保留。
2. RED：测试 `command`、`code`、`cwd`、`executable`、`persistedOutputPath` 原文不出现。
3. RED：测试 stdout/stderr 只产生 bytes/hash/truncated/redaction 元数据。
4. GREEN：实现 typed allowlist projection。
5. REFACTOR：让 `run_shell` 与 `run_script` 共享 `ProcessResultLogProjection`。

建议类型：

```ts
interface AgentSafeProcessMetadata {
  status?: string
  errorCode?: string
  caseId?: string
  exitCode?: number | null
  signal?: string | null
  terminationReason?: string
  durationMs?: number
  stdoutBytes?: number
  stderrBytes?: number
  stdoutSha256?: string
  stderrSha256?: string
  truncated?: boolean
  artifactAvailable?: boolean
  redacted?: boolean
}
```

完成判据：

- projection API 只允许显式列出的字段；
- 传入含循环引用、超深对象、函数、symbol、Error 的未知数据不会抛出；
- 测试覆盖成功、失败、空结果和异常结果；
- `npm run typecheck:shared` 通过。

#### A2. 定义 opaque artifact ID

涉及文件：

- `src/shared/agentSafeProjection.ts`；
- `src/shared/agentToolResult.ts`；
- `electron/shell/outputArtifactWriter.ts` 相关测试。

实现要求：

- 禁止从绝对路径 basename 直接生成 Agent 可见 ID；
- 使用随机 ID 或稳定不可逆 hash；
- Agent 只拿到 `artifactId`、大小、sha256 和是否可读取；
- UI/内部 artifact 打开逻辑仍使用内部路径映射，不把路径回传给 Agent。

完成判据：

- artifact 文件名包含 `customer-token-private` 时，Agent payload 和日志均不出现该文件名；
- 现有 artifact 打开、清理、过期测试继续通过；
- Agent payload 中不存在 `persistedOutputPath`。

### 阶段 B：重构 canonical Agent serializer

#### B1. 取消成功字符串原文短路

涉及文件：

- `src/shared/agentToolResult.ts`；
- `src/shared/agentToolResult.test.ts`。

TDD：

1. RED：成功字符串包含 `/usr/bin/tool`、`C:\\Users\\...`、裸 token 时不得原样返回。
2. RED：成功普通文本仍保持兼容的文本 envelope 或安全纯文本格式。
3. GREEN：所有结果先进入统一 Agent-safe 投影，再决定输出格式。

完成判据：

- 任意 success string 不再绕过 path/secret/size/serialization protection；
- 纯文本兼容性有明确测试，不允许用隐式 early return 规避安全逻辑。

#### B2. 将自由文本脱敏改为保守分层策略

涉及文件：

- 新增 `src/shared/agentSafeText.ts`；
- 删除或废弃 `electron/tools/toolUserErrors.ts` 中承担 Agent 脱敏职责的近似逻辑；
- 更新 `src/shared/agentToolResult.ts`、`electron/tools/runLarkCliExecutor.ts`、`electron/tools/builtinExecutors.ts`。

策略：

1. 结构化路径字段：字段级替换，不依赖自然语言正则。
2. 引号路径：替换路径主体，保留引号和 traceback line/column。
3. 明确格式的 traceback：只处理已识别的 `File "...", line N`、`path:line:column`。
4. URL：不当作宿主路径；需要时只对 URL query 中的 secret 参数做字段级处理。
5. 普通未加引号含空格路径：如果无法判断终点，返回安全占位符和 `redactionReason: 'ambiguous_path'`，不吞掉整行也不留下后缀。
6. 普通相对路径、包路径、错误类型和行号：保持原文。

完成判据：

- `/usr`、`/etc`、`/bin`、`/private`、`/Users`、`/home`、Windows drive、UNC、含空格路径均不泄露；
- `https://example.com/a`、`src/shared/file.ts`、`node_modules/pkg/file.js`、`1/2` 不被误伤；
- `File "...", line 37` 和 `app.py:37:4` 保留行列号；
- 模糊输入不会产生“只遮前半段”或“吞掉后续整行”的结果。

#### B3. 统一 diagnostic、error、userMessage 的投影边界

要求：

- `error` 只能是稳定错误码；
- `userMessage` 只用于用户/Agent 可见的安全文案；
- `diagnostic` 必须经过递归 allowlist sanitizer；
- unknown `Error`、cause、stack 不得直接进入 Agent payload；
- serializer 发生异常时返回稳定 envelope，不抛出 `RangeError`。

完成判据：

- 循环引用、共享引用、超深对象、Error/cause 链均有测试；
- Agent payload 只出现允许字段；
- 实时 serializer 与历史 serializer 的 JSON 结果逐字一致。

### 阶段 C：统一 Agent 日志出口

#### C1. 为日志事件建立 allowlist projector

涉及文件：

- 新增 `electron/agentLogger/agentLogProjection.ts`；
- `electron/agentLogger/agentLogger.ts`；
- `electron/shell/shellAgentLogger.ts`；
- `electron/toolChatLoop.ts`。

事件策略：

| 事件 | 允许字段 |
|---|---|
| `shell.precheck` | request/session/tool IDs、invocationFingerprint、风险分类、计数 |
| `shell.confirm` | request/session/tool IDs、invocationFingerprint、结果、风险分类 |
| `shell.security.*` | request/session/tool IDs、invocationFingerprint、拒绝原因码 |
| `shell.exec.*` | 生命周期状态、pid、shellId、耗时、bytes/hash、signal、redaction flags |
| `tool.error` | toolName、错误码、调用指纹、耗时、结构化 caseId |
| `tool.result` | success、错误码、耗时、进程元数据投影 |

禁止字段：

- `command`、`code`、`input` 原文；
- `stdout`、`stderr`、preview、summary 原文；
- `cwd`、`executable`、`persistedOutputPath`；
- 原始 Error 对象、stack、cause。

完成判据：

- `logAgentEvent` 对目标事件不能直接接收未投影字段；
- 所有 Shell 拒绝、弱拒绝、路径确认、取消、超时、spawn error 事件均经过 projector；
- `shellLogFields.ts` 不再维护第二套 stdout/path 脱敏逻辑；
- 旧的 `redactShellCommandForLog`、`shellIoPreviewForLog` 若无调用者则删除，而不是继续保留。

#### C2. 处理开发态异常日志

涉及文件：

- `electron/agentLogger/agentLogError.ts`；
- `electron/toolChatLoop.ts`；
- 新增 `electron/agentLogger/agentLogProjection.test.ts`。

要求：

- 进程型工具不把原始 `err` 传给通用 Agent logger；
- 只传稳定错误码、错误类别、状态和安全用户文案；
- 非进程型工具可保留现有开发诊断，但必须明确不适用于 shell/script；
- 测试开发态和生产态两种 logger 模式。

完成判据：

- 构造包含绝对路径、token、stack、cause 的 Error，任何 `tool.error` 日志均不出现原值；
- 生产态和开发态测试都通过；
- 日志文件序列化后再次执行泄漏断言仍通过。

### 阶段 D：实时、持久化、历史链路统一

#### D1. 统一实时 tool_result 与历史 tool_result

涉及文件：

- `electron/toolChatLoop.ts`；
- `src/shared/claudeToolHistory.ts`；
- `src/shared/claudeToolHistory.test.ts`；
- `electron/messageCodec.ts` 及测试。

要求：

- 实时和历史都调用同一 `serializeAgentToolResult()`；
- `success=false` 不丢失安全结构化 data；
- 授权/预检失败明确写入 `processResult: null`；
- `userMessage`、稳定 `error`、安全 `data` 的职责保持分离。

完成判据：

- 同一个结果经过实时和历史路径生成相同 payload；
- 应用重启、数据库 round-trip 后 payload 不改变；
- 历史路径没有独立的失败 JSON 拼接逻辑。

#### D2. 检查 fact/event 与其他旁路

逐项检查：

- `emitToolResultFact`；
- `messageCodec`；
- `serializeToolCallsForDb`；
- oversized result compaction；
- remote/IM tool result；
- session recovery/replay；
- UI tool record 与诊断面板。

完成判据：

- 原始 `data` 只存在内部执行/持久化必要位置；
- 所有进入 Agent、日志、IM 或 renderer 的路径都有明确投影；
- 使用 `rg` 检查后不存在进程型工具的原始 `input`、`data`、`stdout`、`stderr` 日志调用点，除非调用点有注释说明为内部安全存储。

### 阶段 E：端到端 TDD 回归矩阵

新增测试夹具：

- `electron/testSupport/agentLogCapture.ts`：捕获所有 Agent log event；
- `src/shared/testSupport/leakAssertions.ts`：统一断言敏感值不出现；
- `electron/tools/processToolSecurity.e2e.test.ts`：覆盖 Shell/Script。

每个场景都必须同时检查：

1. executor result；
2. 实时 Agent tool_result；
3. 持久化结果；
4. 历史重建 tool_result；
5. 所有产生的 Agent 日志事件；
6. UI/IM 使用的 userMessage。

场景矩阵：

| 场景 | 必测输入 | 必测断言 |
|---|---|---|
| 成功 Shell | command 输出裸 token、POSIX/Windows 路径 | success、exitCode 保持；原文不泄露 |
| 非零退出 | stderr 含 traceback、line/column、绝对路径 | 错误码和行列号保留；路径隐藏 |
| 超时 | 长命令、输出含敏感值 | timeout 状态稳定；日志无原文 |
| 用户取消 | abort signal | cancelled 与 timeout 区分 |
| spawn 失败 | `/usr/...`、`/Users/...` executable | executable 不泄露；稳定 spawn 错误码 |
| Shell 拒绝 | 裸秘密、危险路径、弱拒绝 | precheck/security/confirm 日志均无原文 |
| 成功 Script | code 含连接串，stdout 含裸 token | tool.result 只保存元数据 |
| 失败 Script | exception stack 含 cwd/pythonPath | tool.error 不泄露 stack/path |
| artifact | 敏感文件名、绝对 artifact path | 只有 opaque artifactId |
| 复杂对象 | 循环、共享引用、深层数据 | 不抛异常；共享引用不误判循环 |
| URL/相对路径 | URL、包路径、`1/2` | 不误伤诊断上下文 |

完成判据：

- 聚焦测试覆盖所有场景；
- 每个场景至少有一条 RED 测试先证明旧实现失败；
- 全部 Agent log event 经序列化后的字符串均通过统一 leak assertion；
- 不允许只筛选 `shell.exec.*`，必须检查 `shell.*`、`tool.error`、`tool.result` 和相关事件。

## 5. 实施顺序与提交边界

建议拆成以下可独立验证的提交，避免继续在一个大 diff 中叠加正则：

1. `test(security): add agent log and payload leak fixtures`：只增加 RED 测试与夹具。
2. `refactor(security): add typed agent-safe projections`：建立结构化投影和 opaque artifact ID。
3. `fix(agent): route all process results through canonical serializer`：统一实时/历史 payload。
4. `fix(logging): enforce process-tool event allowlists`：统一日志出口，删除 raw input/data/preview。
5. `fix(security): replace free-text path heuristics with conservative redaction`：引号、traceback、结构化字段和模糊文本策略。
6. `test(security): add end-to-end shell and script leak matrix`：完成全链路矩阵。

每个提交都必须满足：

- 相关聚焦测试通过；
- `npm run typecheck:shared` 通过；
- `npm run typecheck:renderer` 通过；
- `git diff --check` 通过；
- 不引入新依赖；
- 不修改无关生成文件。

## 6. 最终验收清单

### 安全

- [x] Agent serializer 没有成功字符串原文短路。
- [x] 所有 process-tool 日志使用 allowlist projection。
- [x] 开发态异常日志不保存 shell/script 原始 stack、cause、message。
- [x] Shell precheck/confirm/security/exec 全链路无原始 command。
- [x] `tool.error` / `tool.result` 无原始 input、code、stdout、stderr。
- [x] cwd、executable、pythonPath、artifact absolute path 不出现。
- [x] artifactId 不可逆且不包含原文件名。
- [x] URL、相对路径、错误类型、traceback 行列号不被无故破坏。

### 正确性

- [x] success、exitCode、signal、timeout、cancelled、spawn_failed 状态来源唯一。
- [x] 实时和历史 tool_result 完全一致。
- [x] 循环对象不会抛异常，共享对象不会误判循环。
- [x] 脱敏失败不会伪造进程失败。
- [x] stdout 中包含 `node_modules` / `dist` 不会改变成功状态。

### 验证

- [x] 聚焦安全测试通过。
- [x] `npm test` 全量通过。
- [x] `npm run typecheck:shared` 通过。
- [x] `npm run typecheck:renderer` 通过。
- [x] `git diff --check` 通过。
- [x] 使用 `rg` 完成 raw logging 旁路审计。
- [x] 评审报告不再存在 P1/P0 阻断项。

## 8. 实施记录与证据

本计划已在 `codex/run-shell-command-failure-diagnosis-tdd` worktree 完成。关键落点如下：

- `src/shared/agentSafeText.ts` 提供唯一自由文本边界：先保护 URL，再识别结构化/明确边界的 POSIX、Windows、UNC 路径；含空格或冒号边界的模糊路径使用安全占位符；保留相对路径、包路径和 traceback 行列号。
- `src/shared/agentSafeProjection.ts`、`src/shared/agentToolResult.ts` 提供结构化 allowlist、稳定错误 envelope、循环/超深数据 fail-closed 处理，以及实时/历史共用的 canonical serializer。
- `electron/agentLogger/agentLogProjection.ts` 与 `electron/shell/shellLogFields.ts` 统一日志投影；命令、脚本、输入使用 fingerprint，stdout/stderr 仅保留大小/hash/redaction 标记，cwd、executable、绝对 artifact path 和异常详情不进入 Agent 日志。`trust.remove` 也纳入目标事件，避免信任管理旁路泄露 shell 命令。
- `electron/toolChatLoop.ts`、`src/shared/claudeToolHistory.ts`、fact/renderer/IM 入口均改为使用安全结果投影；artifact 对外只使用 opaque `artifactId`，旧内部路径仍由主进程受限映射打开。
- 新增 `electron/tools/processToolSecurity.e2e.test.ts`、日志捕获夹具和统一泄漏断言，覆盖成功、失败、超时、取消、拒绝、spawn 失败、Script 异常、artifact、循环/共享对象及 URL/相对路径场景。

TDD 结果：新增安全边界测试先针对旧行为形成 RED，再以结构化投影和单一出口实现转为 GREEN；本轮 v15 修复新增 2 条 RED 测试并转为 GREEN：模糊路径后缀被省略，且 `ambiguous_path` 原因从统一文本脱敏器传播到工具执行结果。当前定向回归为 10 个测试文件、115 项通过。

最终验证证据：

- `npm test -- --reporter=dot`：517 个测试文件、3261 项测试通过。
- `npm run typecheck:shared`：通过。
- `npm run typecheck:renderer`：通过。
- `npm run build:electron`：通过。
- `npx vite build`：4013 个模块转换并构建成功；仅有既有 chunk size warning。
- `git diff --check`：通过。
- `rg` raw logging 旁路审计：生产代码未发现绕过中央投影的 process-tool 原始 command/code/input/stdout/stderr/cwd/executable 日志持久化；仍传递原文的受控调用点均在 logger/projector 边界内。

本记录对应的正式自评报告为 `docs/review/run-shell-agent-safe-boundary-hardening-code-review.md`。它记录了本次 correctness、architecture、security、performance 和 maintainability 评审结果；独立审阅者仍可基于该报告和测试命令复核。

## 7. 完成定义

只有同时满足以下条件，才能把本计划标记为完成：

1. 第 4 节所有阶段均完成，并在计划中勾选具体子项；
2. 所有新增 RED 测试已转为 GREEN，且没有通过删除断言或放宽匹配实现；
3. 实时、历史、日志、持久化和 UI/IM 的敏感数据流均有测试证据；
4. 结构化投影替代了调用点散落的脱敏分支；
5. 全量测试、两套类型检查和 diff 校验均通过；
6. 复评至少验证成功、失败、超时、取消、拒绝、spawn 失败、Script 异常和 artifact 场景；
7. 评审结论为允许合并，且没有未解释的 P1/P0 问题。
