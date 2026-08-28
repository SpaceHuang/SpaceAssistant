# MCP 外部能力接入 — 开发计划

**版本：** 1.1
**日期：** 2026-08-28
**修订说明：** 采纳 [评审意见](../review/mcp-integration-development-plan-review.md)（B1 阻断项 + A1–A7），并补充独立评估结论。
**需求依据：** [docs/requirement/mcp-integration-requirement.md](../requirement/mcp-integration-requirement.md) v1.2
**代码基线：** 本计划基于对当前仓库的实际调研，涉及文件路径均已在代码中核实。

---

## 1. 总体策略

### 1.1 接入点结论（来自代码调研）

MCP 工具接入现有工具链路，需触及 4 个汇合点：

| 汇合点 | 位置 | 接入方式 |
|---|---|---|
| 工具定义 | `src/shared/builtinToolDefinitions.ts`（`BUILTIN_TOOL_DEFINITIONS`，16 个内置工具） | **不改内置列表**。新增 MCP 定义源，在 `toolChatLoop.ts` 发请求前与内置列表合并（见 §4） |
| Executor 路由 | `electron/tools/builtinExecutors.ts:1034` `getToolExecutor(name)` 静态 Map | 扩展为「内置 Map 优先，未命中时查 MCP 映射注册表」；映射仅对当前请求快照有效 |
| 工具过滤/开关 | `electron/toolsConfigRuntime.ts` `filterBuiltinToolsForApi` | MCP 工具不进入 `deniedTools` 体系；在合并处按 MCP 白名单/启停/远程策略过滤 |
| 确认策略 | `domainTypes.ts:516` `builtinToolNeedsConfirmation` + `toolChatLoop.ts:1504` `tool:confirm-request` | MCP 工具走**新增的确认判定函数**，复用同一 `toolConfirmRegistry` 挂起/恢复机制与渲染确认队列 |

### 1.2 可直接复用的现有机制（不重复造轮子）

- **凭据加密**：`electron/secureApiKey.ts` 的 `isSecretStorageAvailable / encryptSecret / decryptSecret`，以及 `llmServiceResolver.ts` 中 `secrets.llmServiceKeys`（`Record<id, encBase64>` JSON 串存 configs 表）的读写封装模式——MCP Secret Store 照此实现，键名 `secrets.mcp.credentials`。
- **配置存取**：`electron/database/operations.ts` 的 `getConfigValue / setConfigValue / deleteConfigValue`。
- **确认链路**：`electron/toolConfirmRegistry.ts`（挂起 Promise、5 分钟超时）、`pendingConfirmStore.ts`（渲染队列）、`tool:confirm-request / tool:confirm-response` IPC。
- **取消链路**：`electron/chatCancelRegistry.ts`（`signalChatCancel` 级联取消）、`electron/tools/toolExecutionResource.ts` 的 `combineUserAbortAndTimeout`、子进程 `killProcessTree`。
- **结果截断**：`src/shared/toolResultLimits.ts` + `src/shared/oversizedToolResult.ts` 的 `compactOversizedToolResultContent`，MCP 工具结果走同一压缩入口。
- **持久化**：`ToolCallRecord` 已作为消息字段存 SQLite messages 表（`electron/messageCodec.ts`），为 MCP 增加可选 `mcp?: { serverId; serverName; originalToolName }` 元数据即可，不改表结构。
- **远程 IM 隔离**：飞书/微信都走 `imRemoteAgent.ts → runToolChatSession`，差异由 `filterBuiltinToolsForApi` 按 `remoteContext` 过滤。MCP 工具在合并工具集合时判断 `remoteContext` 存在即不注入，天然满足需求 §4.6「远程 IM 不可用」。

### 1.3 SDK 依赖

按需求 §8.1，将 `@modelcontextprotocol/sdk` 加为 `package.json` **直接生产依赖**并锁定版本。需先用 Node 版本和打包流程（`scripts/after-pack.cjs`、`native-bindings-manifest.json` 只涉及原生模块，SDK 为纯 JS，预期无打包问题，但需在 P0-A 做一次 `npm run build && npm run pack:win` 冒烟验证）。SDK 的 Client / StdioClientTransport / StreamableHTTPClientTransport / OAuth 辅助能力尽量复用；Profile/Secret 存储、endpoint 校验、工具预算、确认策略、脱敏全部自研。

---

## 2. 模块划分

按需求 §8.1，新增 `electron/mcp/` 目录，职责与依赖方向如下（单向依赖，避免环）：

```
src/shared/mcpTypes.ts          ← 纯类型 + Zod schema + 名称映射/校验纯函数（无 Node/Electron 依赖）
electron/mcp/
  mcpSecretStore.ts             ← 依赖 secureApiKey.ts + database/operations.ts
  mcpConfigStore.ts             ← 依赖 mcpSecretStore + operations.ts
  mcpDiagnostics.ts             ← 错误诊断环形缓冲（每服务 20 条/30 天），依赖 operations.ts
  endpointPolicy.ts             ← HTTP URL/DNS/IP 边界校验（纯逻辑，可测）
  stdioTransport.ts             ← 子进程安全启动（依赖 electron/spawnUtil.ts 模式，shell:false）
  streamableHttpTransport.ts    ← SDK StreamableHTTPClientTransport + 认证头注入 + 重定向/边界拦截
  mcpConnectionManager.ts       ← 连接池、initialize、超时、取消、空闲回收；依赖上面两个 transport
  mcpOauthService.ts            ← metadata discovery、PKCE、loopback 回调、DCR/预设/手工 clientId、refresh
  mcpToolRegistry.ts            ← tools/list 校验、映射名生成、缓存、按快照导出 Anthropic 工具定义
  mcpToolExecutor.ts            ← ToolExecutor 接口实现，路由 tools/call，输出 ToolExecutorResult
  mcpIpc.ts                     ← mcp:* IPC 处理器注册（被 appIpc.ts 调用）
```

关键设计取舍（可维护性优先）：

1. **`mcpTypes.ts` 放 `src/shared/`** 但不引入任何 Node API，使渲染进程可直接复用类型与展示逻辑；Secret 输入类型 `McpServerWriteInput` 仅出现在 IPC 请求体，不进 `config:get` / Redux。
2. **映射名生成、endpoint 规范化、工具预算裁剪、脱敏规则全部做成纯函数**放 shared 或独立小模块，单测不依赖 Electron。
3. **连接管理器只做生命周期**，协议细节交给 SDK；`toolChatLoop.ts` 不出现任何 MCP 协议代码，只调用 `mcpToolRegistry.buildSnapshotTools(...)` 和扩展后的 `getToolExecutor`。
4. **不抽象「通用外部工具源」接口**——当前只有 MCP 一种外部源，直接实现 MCP，避免过度设计。

---

## 3. 数据模型与持久化

### 3.1 共享类型（`src/shared/mcpTypes.ts`）

按需求 §7.1 定义 `McpTransportType / McpAuthMode / McpConnectionStatus / McpServerProfile / McpToolDescriptor`（字段以需求为准，此处不重复）。配套：

- Zod schema：`McpServerProfileSchema`（读取校验 + 迁移）、`McpServerWriteInputSchema`（`strict()` 禁止未知字段，仅 IPC 请求体用）。
- 纯函数：`sanitizeEndpointForDisplay()`、`generateMappedToolName(serverName, toolName)`（`mcp_<serverSlug>_<toolSlug>_<shortHash>`，超限截断 slug 保留 hash）、`detectSensitiveParamValue()`（命令/参数中的 token 模式检测）、`maskSensitiveArgs()`（参数摘要脱敏，命中 `token|secret|password|authorization|apiKey` 掩码）。

### 3.2 存储键

| 数据 | SQLite configs 键 | 说明 |
|---|---|---|
| Profile 列表 | `config.mcpServers` | `McpServerProfile[]`，无 Secret 明文/密文 |
| 工具缓存 | `config.mcpToolCache.<serverId>` | `McpToolDescriptor[]` + 协议版本 + 发现时间 |
| 加密凭据 | `secrets.mcp.credentials` | `Record<'<serverId>:<kind>', encBase64>`，kind ∈ `access-token / refresh-token / auth-header / env:<KEY>` |
| 错误诊断 | `config.mcpDiagnostics.<serverId>` | 每服务 20 条、30 天滚动 |

- 缺失键一律按空处理，不阻塞启动（需求 §7.3）。
- 保存/删除/认证更新用 DB 事务协调；`encryptSecret` 抛错（safeStorage 不可用）时回滚，不留半成品。
- **写互斥（评审 A1）**：`secrets.mcp.credentials` 沿用单键 JSON 整体读写模式，但 OAuth 后台刷新（P0-C）会引入第二个写入源，与用户保存/删除/`mcp:clear-secret` 交错时存在读改写丢更新风险。`mcpSecretStore` 的所有写操作必须经主进程内**单一互斥队列**串行化「读→改→写」临界区（简单 Promise 链即可，不引入锁库），测试计划补并发写入用例（见 §5）。
- `AppConfig` 不加 MCP 字段。经核实（评审 A4），`config:set`（`appIpc.ts:844`）按固定 payload 字段逐一处理，**不存在通用键值写入通道**，现状即满足需求 §9.2 第 9 条；仅保留一条防御性契约测试断言 `config:set` 忽略/拒绝任何 `mcp*` 字段，不新增白名单机制。

---

## 4. 分阶段开发计划

### P0-A：基础存储 + stdio 连接 + 工具发现 + 设置页骨架

**目标**：用户可添加/测试/保存一个 stdio 服务并发现工具；工具暂不进模型循环。

**阶段状态：** ✅ 已完成（2026-08-28）；P0-A 验收（第 9 项）结论见下

1. **依赖与冒烟**：安装 `@modelcontextprotocol/sdk`；`npm run build` + 一次打包冒烟。

   - **状态：** ✅ 已完成（2026-08-28）—— `@modelcontextprotocol/sdk@1.30.0` 已作为直接生产依赖锁定（CJS/ESM 双构建，主进程 tsc 编译通过）；`npm run build` 通过；`pack:win` 冒烟成功（`release/SpaceAssistant Setup 0.1.5.exe` 130 MB，SDK 纯 JS 无打包问题）。
2. **共享类型与纯函数**：`src/shared/mcpTypes.ts`（类型 + Zod + 映射名/脱敏/敏感参数检测纯函数）。单元测试。

   - **状态：** ✅ 已完成（2026-08-28）—— 类型/Zod schema/`generateMappedToolName`/`deriveUniqueMappedToolName`（A6）/`sanitizeEndpointForDisplay`/`detectSensitiveParamValue`/`maskSensitiveArgs`；`mcpTypes.test.ts` 31 项通过。
3. **存储层**：
   - `mcpSecretStore.ts`：`setSecret(serverId, kind, value) / getSecret / deleteSecretsForServer`，复用 `encryptSecret`，键隔离校验。
   - `mcpConfigStore.ts`：`listProfiles / saveProfiles / deleteServer`（连带清 Secret、工具缓存、诊断），20 个上限、名称唯一校验、事务。
   - `mcpDiagnostics.ts`：追加/读取/清除，写入前过脱敏规则（基底复用 `sanitizeForLog`，追加 MCP 专属规则，见 §8 第 3 条）。
4. **stdio 传输**：`stdioTransport.ts`——`spawn(command, args, {shell:false})`；环境构建：最小继承集（`PATH`；Windows 加 `SystemRoot/ComSpec/PATHEXT` 等，大小写去重）+ 解密后的用户环境变量；stdout 仅接受 JSON-RPC 行，stderr 脱敏后入诊断。优先评估 SDK `StdioClientTransport` 是否允许自定义 env，允许则直接用，不允许再包一层。

   - **状态：** ✅ 已完成（2026-08-28）—— 评估结论：SDK `StdioClientTransport` 允许自定义 env，直接复用并薄封装；命令解析阶段显性拒绝 `.cmd`/`.bat`（含 PATH 解析命中，B1），环境最小继承 + Windows 大小写去重，stderr 逐行脱敏；`stdioTransport.test.ts` 14 项通过（含真实 Node MCP Server spawn 集成）。
   - **Windows `.cmd` 垫片决策（评审 B1，前置决策）**：Node/Electron 以 `shell:false` 在 Windows 上**无法直接执行 `.cmd`/`.bat`**（libuv 限制），而 `npx`/`npm`/`pnpm` 在 Windows 均为 `.cmd` 垫片，`spawn('npx', ...)` 会 `ENOENT`。P0 采纳**方案一（显性拒绝）**：命令解析阶段即拒绝 `.cmd`/`.bat`——包括用户显式填写 `.cmd` 路径，以及 PATH 解析后命中 `.cmd` 垫片的情况——诊断与 UI 给出可读引导（如「Windows 下 `npx` 为脚本垫片、不可直接启动；请改用 `node <server.js>`、`python <server.py>`、`docker run …` 或可执行文件路径」）。安全面不变，限制显性化。
   - 备选方案二（`cmd.exe /d /s /c` 包装 + argv 转义）与「不解析为 Shell 字符串」承诺冲突且属已知 CVE 类别（CVE-2024-27980），P0 不采用；若后续产品确认 `npx` 一键接入是强需求，另行评审豁免并补专项安全测试。
   - 配套测试夹具：Windows 下填写 `npx` 时的确定性「拒绝 + 引导」行为。
5. **连接管理器（stdio 部分）**：`mcpConnectionManager.ts`——initialize（15s 超时）、`notifications/initialized`、capabilities 校验（Server 声明本期不支持能力时记录兼容性诊断）、空闲 5 分钟回收、进程退出标记断开 + 下次调用前重启一次。

   - **状态：** ✅ 已完成（2026-08-28）—— 连接池/超时/兼容性诊断/空闲回收/断线重启均实现；SDK 1.30 不暴露 stdio 协商协议版本，以传输层捕获 initialize 响应补偿；`mcpConnectionManager.test.ts` 6 项通过。
6. **工具注册表（发现与映射）**：`mcpToolRegistry.ts`——`tools/list`、schema 校验（名称、深度 ≤20、单工具 ≤16 KiB）、映射名生成、缓存写入；`notifications/tools/list_changed` 标记过期。**映射名查重（评审 A6）**：发现/合并阶段对映射名全局查重，命中截断 hash 碰撞时确定性再派生（延长 hash，仍冲突再加计数后缀），保证 Anthropic API 工具名全局唯一。

   - **状态：** ✅ 已完成（2026-08-28）—— 校验（名称/深度/字节上限）、映射名生成与查重、缓存写入与 stale 标记；`mcpToolRegistry.test.ts` 10 项通过（含真实连接发现集成）。
7. **IPC + preload + window.api**：`mcpIpc.ts` 注册 `mcp:list / mcp:save-profiles / mcp:test-connection / mcp:delete-server / mcp:clear-secret / mcp:get-diagnostics / mcp:refresh-tools`；`electron/preload.ts` 增加扁平方法；`src/shared/api.ts` 扩展 `SpaceAssistantApi`；契约测试（确认未新增第二桥接对象）。

   - **状态：** ✅ 已完成（2026-08-28）—— `registerMcpIpcHandlers` 已在 `appIpc.ts` 接线；preload 扁平方法 + `api.ts` 类型就绪；契约测试确认单桥接 `window.api`、无通用 invoke、`config:set` 无 MCP 字段；`preload.mcp.test.ts` + `mcpIpc.test.ts` 覆盖，主进程侧 MCP 共 8 文件 72 项通过。
8. **设置页**：
   - `toolsSettingsNav.ts` 的 `TOOLS_SETTINGS_SUB_TABS` 在 `switches` 后插入 `mcp`。
   - 新增 `src/renderer/components/Config/McpSettingsTab.tsx` + `McpServerCard.tsx` + 编辑表单（基础信息 → 连接方式 → 认证 → 工具与权限 → 诊断），draft 管理参考 `useLlmServiceDrafts.ts` 模式但**保存走 `mcp:save-profiles`**，不走弹窗底部「保存」；切换分区/关闭时未保存草稿丢弃并确认。
   - 服务卡片：启停开关（按需求 §4.3.1 的可启用条件禁用）、状态徽标、工具摘要、操作按钮；工具列表含启用开关与「调用前确认」策略。
   - i18n（评审 A2）：新增 `mcp` 命名空间，**zh-CN 与 en-US 同步补齐**（`i18n:check` 校验各 locale key 对齐，只加 zh-CN 会直接失败）；跑 `npm run i18n:generate-types`。

   - **状态：** ✅ 已完成（2026-08-28）—— `ToolsSettingsSubTab`/`TOOLS_SETTINGS_SUB_TABS` 在 `switches` 后插入 `mcp`；新增 `McpSettingsTab` + `McpServerCard`（基础信息/连接方式/认证/工具与权限/诊断），草稿经 `mcpDrafts.ts` 纯函数管理，保存走 `mcp:save-profiles`（分区内保存，卡片「保存并应用」），离开分区时脏草稿确认；`mcp` 命名空间 zh-CN/en-US 同步补齐，`i18n:generate-types` 与 `i18n:check` 通过；`McpSettingsTab.test.tsx` 5 项 + `mcpDrafts.test.ts` 5 项通过。
9. **P0-A 验收**：stdio 服务 CRUD + 测试并刷新可发现工具；安全存储不可用时含 Secret 保存失败且无半成品；命令/参数敏感模式被拒绝；**Windows 下 `npx` 场景行为为「明确拒绝 + 可读引导」且有测试覆盖（B1）**；`npm run i18n:check` 通过。

   - **状态：** ✅ 已完成（2026-08-28）—— MCP 聚焦测试 82 项全绿（含存储/传输/连接/注册表/IPC/契约/设置页）；`npm test` 全量 2511 项中 2492 通过，19 项为环境性失败（Windows 路径分隔符、EPERM fsync、性能阈值，见变更记录）；`typecheck:renderer` / `typecheck:shared` / `tsc -p tsconfig.electron.json` 全部通过；`i18n:check` 通过；`npm run build` 与 `pack:win` 冒烟成功。B1 拒绝 + 引导有专项测试覆盖（`stdioTransport.test.ts`）。

### P0-B：接入工具循环 + 确认卡片 + Streamable HTTP

**目标**：MCP 工具进入真实对话；HTTP 服务可用（无认证/Bearer/自定义头）。

**阶段状态：** ✅ 已完成（2026-08-28）；验收结论见第 7 项

1. **工具集合合并（`toolChatLoop.ts`）**：
   - 在 `runToolChatSessionInner` 构建 tools 参数处（现有 `filterBuiltinToolsForApi` 调用点附近，toolChatLoop.ts:526），新增 `mcpToolRegistry.buildSnapshotTools(ctx)`：仅当 `remoteContext` 为空时注入；输出 Anthropic `Tool[]`，每个工具描述加来源前缀「外部 MCP 服务 `<名称>` 提供的工具」。
   - 实施预算：每轮最多 64 个 MCP 工具、累计 ≤96 KiB；超限按「服务配置数组顺序 → enabledToolNames 保存顺序」确定性裁剪，裁剪项记录供设置页展示「因上下文预算未注入」。
   - 快照：`mappedName → {serverId, originalName, discoveredAt}` 存请求级 Map，随请求生命周期。

   - **状态：** ✅ 已完成（2026-08-28）—— `mcpToolRegistry.buildSnapshotTools`（仅桌面注入、白名单顺序、64 个 / 96 KiB 确定性预算裁剪 + budgetDropped 记录）；`toolChatLoop.ts:550` 合并 MCP 工具定义（描述带来源前缀）；`buildSnapshotFromDb` 请求级快照。
2. **Executor 路由扩展**：
   - `builtinExecutors.ts` `getToolExecutor` 增加回退：未命中内置时，从当前请求的 MCP 快照查 `mcpToolExecutor`（通过 `ToolExecutionContext` 新增可选字段 `mcpSnapshot` 传入，避免全局可变状态）。
   - **伪造映射名分支（评审 A5）**：远程请求不注入 MCP 快照，模型伪造 `mcp_*` 映射名时默认会落入 `toolChatLoop.ts` unknown-tool 通用错误。需在 unknown-tool 分支**之前**按 `mcp_` 前缀 + 快照缺失做区分，返回「MCP 工具已变更或服务不可用」，不暴露是否存在同名服务。
   - `mcpToolExecutor.ts` 实现 `ToolExecutor`：输入 JSON Schema 校验（深度 20、256 KB）、每服务并发 4 / 全局 8 的信号量排队、结果转 `ToolExecutorResult`（>1 MB 走现有 `compactOversizedToolResultContent`）、取消时发送 MCP cancellation notification、`Mcp-Session-Id` 失效重新初始化一次、**不重试 tools/call**。
   - 错误分类按需求 §5.4 映射为安全的模型可见文案；原始错误脱敏后入诊断。

   - **状态：** ✅ 已完成（2026-08-28）—— `resolveMcpExecutor` 回退（内置 Map 优先，快照外不可解析）；伪造 `mcp_*` 名在 unknown-tool 分支前返回「MCP 工具已变更或服务不可用」；`mcpToolExecutor`（参数深度 20 / 256 KiB 校验、每服务 4 / 全局 8 信号量、SDK request signal 取消并自动发 notifications/cancelled、>1 MB 压缩、会话失效重连一次且不重试 tools/call、§5.4 错误分类）。
3. **确认链路**：
   - 新增 `mcpToolNeedsConfirmation(profile, tool)` 判定：默认 `readonly-auto`（Server 声明 `readOnlyHint:true && destructiveHint:false` 的工具免确认，其余确认）；可切换「始终确认」；确认卡片内提供「本会话信任」。
   - **「本会话信任」作用域已定（产品确认 2026-08-28）**：信任绑定到当前聊天 **Session**，切换/新建会话即失效，不写入长期设置；实现上复用现有内置工具确认的会话级状态（与 Write/Shell 卡片「本会话自动批准」语义一致）。
   - 渲染端 `ToolCallCard.tsx` 增加 `McpConfirmCard` 分发（服务名、原始工具名、描述、脱敏参数预览、数据大小、风险提示、取消、本会话信任）。
   - 拒绝/超时/取消返回结构化安全错误；`signalChatCancel` 级联取消所有挂起 MCP 调用。

   - **状态：** ✅ 已完成（2026-08-28）—— `mcpToolNeedsConfirmation`（默认 `readonly-auto`：readonly-auto + 安全注解免确认，其余确认；可切换「始终确认」）；「本会话信任」按 Session 作用域（`mcpSessionTrust`，确认响应经 `tool:confirm-response` 写入）；`McpConfirmCard` 渲染服务名/原始工具名/描述/脱敏参数/信任勾选；拒绝/超时/取消映射安全文案。
4. **持久化**：`ToolCallRecord` 增加可选 `mcp` 元数据（serverId/serverName/originalToolName）；`messageCodec.ts` 序列化/反序列化透传；`claudeToolHistory.ts` 回放兼容。

   - **状态：** ✅ 已完成（2026-08-28）—— `ToolCallRecord.mcp`（含可选 description）+ `messageCodec` 透传 + 回环测试；历史回放兼容（mcp 元数据不进入模型上下文）。
5. **Streamable HTTP**：
   - `endpointPolicy.ts`：URL 规范化与校验（禁 userinfo/query/fragment、仅 https + loopback http、禁私网/保留地址）、受控头黑名单、跨 origin 重定向拒绝（连接前后校验目标 IP，防 DNS rebinding）。
   - `streamableHttpTransport.ts`：基于 SDK transport，注入认证头（Bearer / 自定义头，从 Secret Store 解密注入，token 不进日志），处理 `Mcp-Session-Id`、JSON 与 SSE 响应、旧 HTTP+SSE 识别并提示升级。
   - 设置页表单补 HTTP 字段与认证模式（无认证 / Bearer / 自定义头）。

   - **状态：** ✅ 已完成（2026-08-28）—— `endpointPolicy`（URL 边界、私网/保留地址拒绝、受控头黑名单、DNS 解析 IP 校验）；`streamableHttpTransport`（认证头注入、跨 origin 重定向拒绝、Mcp-Session-Id 由 SDK 管理、旧 HTTP+SSE 提示升级、关闭自动重连重放）；连接管理器 HTTP 分支 + 真实本地 HTTP Server 集成测试；设置页表单已含 endpoint 与认证字段。
6. **远程 IM 测试**：验证飞书/微信会话 tools 参数中无 MCP 工具；模型伪造映射名时返回「MCP 工具已变更或服务不可用」。

   - **状态：** ✅ 已完成（2026-08-28）—— `toolChatLoop.mcp.test.ts` 覆盖远程不注入 + 伪造名拒绝。
7. **P0-B 验收**：需求 §9.1 第 3、4、5、6、8、9、10、11、12 条（除 OAuth 部分）。

   - **状态：** ✅ 已完成（2026-08-28）—— MCP 聚焦 122 项 + toolChatLoop 94 项全绿；`typecheck:renderer` / `typecheck:shared` / 主进程 tsc 通过；`i18n:check` 通过；`npm run build` 通过。

### P0-C：OAuth 2.1 + 安全回归 + 全量验收

**阶段状态：** ✅ 已完成（2026-08-28）；验收结论见第 6 项

1. **OAuth 服务**：`mcpOauthService.ts`——401/`WWW-Authenticate` 处理、Protected Resource Metadata / Authorization Server Metadata 发现、PKCE + 随机 state、固定 loopback 回调监听（完成后立即关闭）、`resource` 参数绑定、授权中锁定该服务编辑。

   - **状态：** ✅ 已完成（2026-08-28）—— 复用 SDK `auth()`/`discoverOAuthServerInfo`（PKCE/state/resource 绑定由 SDK 处理）；自有 provider（Secret Store 读写、loopback 固定端口 42188 回调、浏览器打开）；授权中 `isOAuthFlowActive` 锁定保存/删除/清除；mock Authorization Server 集成测试 3 项。
2. **Client 解析顺序**：DCR 优先 → 内置精确匹配预设（新增只读 `electron/mcp/oauthClientPresets.ts`，随版本发布）→ 手工公开 clientId。不持久化 clientSecret。**首批预设目录（2026-08-28 产品确认）：仅 GitHub 一项**——需具备 GitHub 公开的 OAuth App 注册依据、loopback 回调验证与集成测试后方可在 P0-C 合入；核实不通过则目录留空（结构、精确匹配逻辑与手工 clientId 兜底先行交付），不阻塞 P0-C 主链路。Notion/Linear 等后续按同一准入门槛逐个迭代接入。

   - **状态：** ✅ 已完成（2026-08-28）—— DCR（SDK `registerClient`）→ 预设（`matchOauthClientPreset` 精确匹配 origin+issuer）→ 手工 `oauthClientId` 兜底；`oauthClientPresets.ts` 结构就绪、**目录留空**（GitHub 无公开注册依据证据，未合入）；clientSecret 不持久化。
3. **Token 生命周期**：access/refresh token 入 Secret Store；临期或一次 401 时刷新；刷新失败置 `auth-expired` 并停止暴露工具；取消/失败不写 token。

   - **状态：** ✅ 已完成（2026-08-28）—— `saveTokens`（access/refresh → Secret Store + `accessTokenExpiresAt`）；SDK 在 401 时自动刷新（refresh_token 存在）；刷新失败 `invalidateCredentials` 清 token + 置 `auth-expired`；取消/失败不写 token（集成测试覆盖）。
4. **IPC**：`mcp:oauth-start`（仅已保存服务）；设置页「连接账户」按钮与授权状态展示（`自动注册（DCR）/ 内置预设：<名称> / 手动 Client ID`）。

   - **状态：** ✅ 已完成（2026-08-28）—— `mcp:oauth-start` 仅对已保存服务；`McpServerCard` 增加 OAuth 模式（Client ID 输入 + 「连接账户」按钮）；preload/api 契约测试含 `mcpOauthStart`。
5. **安全回归**（需求 §9.2 全条）：重点补 IPC 响应/错误对象/诊断中 Secret 不可恢复的契约测试、`config:set` 拒绝 mcp 键、删除后 Secret 与缓存不可读。

   - **状态：** ✅ 已完成（2026-08-28）—— 契约测试断言可读类型（`McpServerProfile`/`McpConfig`/`McpSaveProfilesResult`）无 Secret 字段、一次性 Secret 仅存在于 `McpServerWriteInput`；`config:set` 无 MCP 字段（源码断言）；删除后 Secret/缓存不可读（存储层测试）；诊断脱敏（含已知 Secret 字面掩码）。
6. **全量验收**：§9.1 / §9.2 逐条核对，跑全量测试（见 §5）。

   - **状态：** ✅ 已完成（2026-08-28）—— MCP 聚焦 128 项全绿；`typecheck:renderer` / `typecheck:shared` / 主进程 tsc / `i18n:check` 通过；`npm run build` 通过；全量 `npm test` 结果见变更记录（与基线 19 项环境性失败一致，无新增回归）。

---

## 5. 测试计划（对应需求 §9.3）

| 层 | 位置 | 内容 |
|---|---|---|
| 共享层单测 | `src/shared/mcpTypes.test.ts` 等 | Profile schema、endpoint 校验、Secret 键隔离、映射名稳定性、预算裁剪排序、脱敏规则、敏感参数检测 |
| 主进程单测/夹具 | `electron/mcp/*.test.ts` | stdio：正常/异常 stdout/退出/取消/环境继承（含 Windows 必需变量）/全 env 掩码/**Windows `.cmd` 拒绝与引导（B1）**；连接管理器超时与空闲回收；executor 并发上限与排队、取消 notification、结果压缩；**Secret Store 并发写互斥（OAuth 刷新 vs 用户保存/删除，A1）** |
| HTTP 集成 | `electron/mcp/streamableHttpTransport.test.ts` + mock server | JSON/SSE、session ID、401/OAuth 发现、DCR/预设/手工 clientId、超时、跨 origin 重定向拒绝、DNS/IP 边界 |
| 工具循环 | 仿 `electron/toolChatLoop.oversizedToolResult.test.ts` | MCP 工具注入、预算裁剪、确认流、拒绝/取消、远程 IM 不注入、伪造映射名拒绝 |
| 渲染 | `src/renderer/components/Config/McpSettingsTab.test.tsx` 等 | 新增/编辑/清除 token/测试/OAuth 必须先保存/授权状态/工具选择/删除二次确认；草稿丢弃提示 |
| 契约 | `src/shared/api` + preload 测试 | MCP API 仅从 `window.api` 暴露，无通用 invoke、无第二桥接 |

每次阶段收尾运行：聚焦 Vitest → `npm test` → `npm run typecheck:renderer` → `npm run typecheck:shared` → `npm run i18n:check` →（P0 各阶段末）`npm run build`。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| SDK 版本与 Electron Node 兼容性 / 打包裁剪 | P0-A 第一步即锁定版本并做 `pack:win` 冒烟；不依赖 Stagehand 传递依赖 |
| SDK StdioClientTransport 不支持自定义 env / stderr 脱敏 | 评估后薄封装；缺口与自研理由记入技术设计文档（需求 §8.1 要求） |
| `toolChatLoop.ts` 已很大，继续膨胀 | MCP 逻辑全部下沉 `electron/mcp/`，loop 内只加「合并工具定义」与「快照传递」两处薄代码 |
| 远程 IM 意外获得 MCP 工具 | 注入判断前置 `remoteContext` 检查 + 伪造映射名拒绝 + 专项测试 |
| OAuth 真实服务商联调成本高 | P0-C 用 mock Authorization Server 完成自动化测试；真实服务（如 GitHub）手工验证清单作为验收附件 |
| `McpServerWriteInput` 泄漏进 Redux/日志 | 类型层隔离（WriteInput 只作 IPC 参数）+ 契约测试断言响应体无 Secret 字段 |

---

## 7. 里程碑与工作量估算

| 阶段 | 交付 | 估算 |
|---|---|---|
| P0-A | 存储 + stdio + 发现 + 设置页骨架 | 5–7 天 |
| P0-B | 工具循环接入 + 确认卡片 + Streamable HTTP | 5–7 天 |
| P0-C | OAuth + 安全回归 + 全量验收 | 4–6 天 |

P1（Resources/Prompts、导入导出、远程 IM 细粒度授权等）不在本计划内，待 P0 验收后另行立项。

---

## 8. 决策记录（原待确认事项，2026-08-28 全部产品确认完毕）

1. ~~首批 OAuth Client 预设目录内容~~ **已决策（2026-08-28 产品确认）：首批仅 GitHub**，准入核实不通过则目录留空不阻塞 P0-C，见 P0-C 第 2 条。
2. ~~「本会话信任」的作用域~~ **已决策（2026-08-28 产品确认）：按 Session**，见 P0-B 第 3 条。
3. ~~诊断摘要的脱敏规则粒度~~ **已决策（2026-08-28 产品确认）**：复用 `sanitizeForLog`（`electron/logSanitize.ts`）作为基底，`mcpDiagnostics.ts` 写入前追加 MCP 专属规则——额外掩码已知 Secret 值的字面出现（从 Secret Store 取值做子串替换）、endpoint userinfo、header 值、env 值；不建独立脱敏体系。「最近错误」允许显示脱敏后的 HTTP 状态码与 Server 错误 message 正文，保障排查体验。**实施约束**：Secret 字面比对只解密**当次涉及的 serverId** 的 Secret（而非全库解密），在 `mcpDiagnostics.ts` 限定范围。
4. **Windows `npx` 体验补偿**：P0 显性拒绝 `.cmd` 后，最常见的 `npx -y <pkg>` 接入路径在 Windows 上不可用。**讨论结论（2026-08-28 产品确认）**：
   - P0 只做静态引导文案（拒绝提示中说明原因并给出 `node <入口.js>` / `python` / `docker` 替代写法）。
   - **P1 候选 = 方案 2（引导生成）+ 方案 2.5（受控安装）合并实现**，合计约 3–4 天：
     - 方案 2：只读解析本机已安装包的 `package.json` `bin` 入口，自动填成 `node <入口.js>`，安全边界不变。
     - 方案 2.5：代执行安装——`spawn("node", ["<npm-cli.js>", "install", "pkg@x.y.z", "--prefix", "{userData}/mcp-packages/"], {shell:false})`，全程无 Shell（npm 本体是 JS，绕开 `.cmd` 限制）。三条红线：`--ignore-scripts` 默认不执行第三方生命周期脚本、固定精确版本、受控目录；安装动作挂在 §4.3.2 的信任确认之后。**npm-cli.js 定位（P1 专项验证项）**：打包后的 Electron 应用无 `npm_*` 环境变量，需从 PATH 中的 `node.exe` 反推同级 `node_modules/npm/bin/npm-cli.js`，且用户 Node 可能经 nvm/fnm 等版本管理器安装（目录结构不同），P1 评估时需对主流安装方式做兼容性验证与兜底引导。
     - 已知代价：`--ignore-scripts` 使含原生模块（node-gyp 类）或脚本分发二进制的包「装完不能跑」，需预算约半天做 stdio 启动失败时识别未构建原生模块的可读引导；**不提供「含脚本重装」逃生门**，此类用户引导手动 `npm install -g`。
   - 方案 3（一键托管 + 自动升级）不建议做，滑向需求 §1.3 排除的「市场/托管」形态；原评估中「安装器需开 cmd.exe 通道」一条更正为「可用 `node npm-cli.js` 规避」，方案 3 的剩余否决理由是供应链面与自动升级策略。

---

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.2-impl | 2026-08-28 | 按本计划完成 P0-A / P0-B / P0-C 全部实现（worktree `codex/mcp-integration`）。要点：SDK 1.30.0 锁定并 `pack:win` 冒烟通过；新增 `src/shared/mcpTypes.ts` 与 `electron/mcp/`（secret/config/diagnostics/stdio/connection/registry/executor/ipc/endpointPolicy/streamableHttp/oauth/presets/sessionTrust/semaphore）；工具循环合并 MCP 工具、请求级快照、确认卡片与「本会话信任」（Session 作用域）、`ToolCallRecord.mcp` 持久化透传；设置页新增 MCP 分区（分区内保存）。**基线说明**：worktree 首跑全量 `npm test` 为 2492 通过 / 19 失败，全部为环境性失败（Windows 路径分隔符断言、EPERM fsync、性能阈值，涉及 `electron/artifacts/*`、`safeAtomicWrite`、`runShellExecutor`、`toolResultPairing` 等，与 MCP 无关）；完成后的全量结果见 §5 验收。GitHub OAuth 预设未合入（目录留空），待公开注册依据与集成测试后按准入门槛接入。 |
| 1.0 | 2026-08-28 | 初版。 |
| 1.1 | 2026-08-28 | 采纳评审：B1 补 Windows `.cmd`/`.bat` 显性拒绝决策与验收条目；A1 Secret Store 写互斥；A2 i18n 补 en-US；A3 内置工具数更正为 16；A4 更正 `config:set` 无通用写入通道的现状描述；A5 补伪造映射名错误分支；A6 补映射名碰撞确定性再派生；A7 更正 `sanitizeForLog` 位于 `logSanitize.ts`。产品确认：「本会话信任」按 Session 作用域；`npx` 体验补偿定为 P0 静态文案 + P1 候选「引导生成 + 受控安装」（方案 2 + 2.5），含 `--ignore-scripts` 代价与诊断预算说明，更正方案 3 评估中 cmd 通道一条；首批 OAuth Client 预设仅 GitHub，核实不通过则目录留空不阻塞 P0-C；诊断脱敏定为 `sanitizeForLog` 基底 + MCP 专属规则，「最近错误」允许显示脱敏后状态码与错误正文。§8 待确认事项清零，更名为「决策记录」。后续修订：需求文档同步升 v1.2（§4.3.2 补 Windows `.cmd` 限制说明）；方案 2.5 补 npm-cli.js 定位的 P1 专项验证项（PATH 反推、nvm/fnm 兼容）；诊断脱敏补「仅解密当次涉及 serverId」的实施约束。 |
