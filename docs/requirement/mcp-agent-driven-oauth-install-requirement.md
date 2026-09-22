# 聊天 Agent 自主接入远程 MCP（Streamable HTTP + OAuth 2.1/PKCE/DCR）改进方案

- 日期：2026-09-17
- 状态：**部分被取代（2026-09-17 评审）**——「mcp_manage 专用工具」路线（§5.2.2/§5.2.3）经评审否决，由《agent-toolkit-capability-gateway-requirement.md》的能力集合网关取代；§5.2.1 保留；P1 全部有效；P2①② 有效、③④ 随 toolkit Phase 3 生效；§0/§5.1 的 P0 端到端承诺按 toolkit Phase 2/3 分期。详见文末修订记录。
- 来源场景：用户向 SpaceAssistant 聊天 Agent 下达「在本机完成生财有术 MCP OAuth 2.1 + PKCE 接入（连接名 `scys-mcp`，地址 `https://mcp.scys.com/shengcai-web/mcp`，仅浏览器人工确认授权）」任务，Agent 回复「当前项目不支持这类 MCP 安装方式」。
- 只读参考：OpenAI Codex CLI 源码（上游仓库的本地只读检出，本仓库分析未做任何修改）。

---

## 0. TL;DR

1. **「不支持」不是协议层缺失，而是 Agent 工具面缺失。** SpaceAssistant 已有完整的 MCP 集成模块（`electron/mcp/`，提交 `1355504a`），支持 stdio / Streamable HTTP 传输和 `none / bearer-token / custom-header / oauth` 四种认证模式，OAuth 流程含服务发现、PKCE、动态客户端注册（DCR）、loopback 回调、safeStorage 凭据存储。**但这些能力只暴露给设置页 UI（`window.api.mcp*` IPC），聊天 Agent 的内置工具集中没有任何 MCP 管理工具**，因此 Agent 无法自主完成「添加连接 → 发起 OAuth → 等待浏览器回调 → 刷新工具 → 只读验证」的全链路。
2. **对生财有术服务端的实测（2026-09-17）证明协议层不存在障碍**：该服务端支持 RFC 9728 资源元数据发现、DCR（`registration_endpoint`）、S256 PKCE、public client（`token_endpoint_auth_methods: ["none"]`）、`scope="mcp"`——SpaceAssistant 现有 OAuth 流程手工走设置页即可接入。
3. 改进方案分三阶段：**P0** 把 MCP 管理能力做成 Agent 可调用的内置工具（抽取 mcpService 层 + 确认门控 + 结果脱敏）；**P1** OAuth 健壮化（结构化错误码、回调端口回退、重定向分级、registration 生命周期）；**P2** 会话联动（配置变更事件、授权过期推送、remote lane 评估）。P0 完成后，用户那类「只点一次浏览器授权」的接入任务即可由 Agent 端到端完成。

---

## 1. 背景与问题定义

用户任务（节选）要求 Agent 在本机连续执行：

| # | 任务要求 | 归纳的能力需求 |
|---|---|---|
| 1 | 读取当前 Agent 的真实产品名称、版本、MCP 配置能力与运行环境 | Agent 可自省产品能力（系统提示注入） |
| 2-3 | 不写入 macOS 钥匙串；配置与 OAuth 必须在本机同一运行环境完成 | 平台凭据存储策略；本机主进程执行 |
| 4 | 识别远程 MCP 配置入口，用 Streamable HTTP + OAuth 2.1 + PKCE + 服务发现 + DCR 完成；不写固定 token / Authorization Header / client_secret | 远程 MCP + OAuth 全协议栈 |
| 5 | 外部命令用参数数组；**缺能力时停止并准确说明，不许偷偷降级** | 结构化工具参数 + 结构化错误码 |
| 6 | 先检查已有连接 / 凭据 / 进行中流程；最多一次 OAuth | 状态查询 + 授权单飞锁 |
| 7 | 打开本机浏览器，loopback 回调自动接收，用户只确认授权 | 浏览器拉起 + 本地回调服务器 |
| 8 | 授权后 reload/reconnect；不行则提示重启 | 工具集热刷新 |
| 9 | 列出工具并实际执行一次只读 MCP 调用验证 | 工具注入 + MCP 工具执行 |
| 10 | 全程不泄露 token / code / code_verifier / client_secret | 凭据脱敏 |
| 11 | 汇报客户端、环境、配置位置、结果，不回显凭据 | 结果汇报规范 |

早期需求文档 `docs/requirement/tools-requirement.md` 中「本期不支持 MCP」的决策已被后续迭代取代：提交 `1355504a feat(mcp): implement MCP external capability integration (P0-A/B/C)` 落地了完整 MCP 模块。

---

## 2. 现状盘点：产品已有什么

### 2.1 MCP 模块（`electron/mcp/`，主进程）

| 能力 | 实现 | 证据 |
|---|---|---|
| 传输层 | stdio、Streamable HTTP、SSE（兼容） | `stdioTransport.ts`、`streamableHttpTransport.ts`、`sseTransport.ts` |
| 认证模式 | `none / bearer-token / custom-header / oauth` | `src/shared/mcpTypes.ts:29` |
| OAuth 服务发现 | SDK `discoverOAuthServerInfo`（RFC 9728 资源元数据 + RFC 8414 授权服务器元数据） | `mcpOauthService.ts:242` |
| PKCE / state | PKCE 由官方 SDK 生成，verifier 仅存流程内存不落库；state 每次随机 | `mcpOauthService.ts:126-129, 211-215` |
| 动态客户端注册（DCR） | 服务端宣告 `registration_endpoint` 时由 SDK 自动注册并持久化 client info；否则回退「内置预设（`oauthClientPresets.ts`）→ 手工 Client ID」 | `mcpOauthService.ts:251-267, 147-149` |
| loopback 回调 | `http.createServer` 监听 `127.0.0.1:42188` 固定端口，路径 `/callback`，state 校验，5 分钟超时 | `mcpOauthService.ts:29-30, 53-90` |
| 浏览器拉起 | `shell.openExternal`（可注入测试缝） | `mcpOauthService.ts:200-203` |
| 授权单飞 | 每 serverId 一把进行中锁，授权中禁止编辑/删除/清凭据 | `mcpOauthService.ts:43-51`、`mcpIpc.ts:100, 159, 176` |
| 凭据存储 | `secrets.mcp.credentials` 单键 JSON，复用 `safeStorage` 加密（Windows DPAPI），写操作经单一互斥链串行化 | `mcpSecretStore.ts:13, 56-63` |
| endpoint 安全策略 | 禁 userinfo/query/fragment；仅 https 或 http-loopback；拒绝私网/保留地址（DNS 解析后二次校验防 rebinding）；受控头黑名单 | `endpointPolicy.ts:93-144`、`streamableHttpTransport.ts:32-51` |
| 重定向策略 | 所有 3xx 一律拒绝（含同源），要求配置最终 endpoint | `streamableHttpTransport.ts:65-73` |
| 工具桥接 | 每请求从 DB 构建工具快照注入 Anthropic tools；按 server+tool 生成映射名并去重；执行器带每服务/全局并发信号量、取消通知、超大结果落 artifact | `toolChatLoop.ts:628-640, 1236-1237`、`mcpToolRegistry.ts:108-146`、`mcpToolExecutor.ts` |
| 确认门控 | MCP 工具接入统一确认体系（含策略迁移） | `electron/confirmation/mcpConfirmPolicyMigration.ts`、`toolDecisionMatrix` |
| 诊断 | 每服务脱敏诊断日志，工具失败时附给模型 | `mcpDiagnostics.ts`、`mcpToolExecutor.ts` |

### 2.2 暴露面：只有设置页 UI

`mcp:list / save-profiles / test-connection / delete-server / clear-secret / get-diagnostics / clear-diagnostics / oauth-start / refresh-tools` 九个 IPC 通道（`mcpIpc.ts:87-242`）全部经 `preload.ts:320-328` 暴露给渲染进程，唯一调用方是设置页 `McpSettingsTab.tsx`（表单添加服务 → 测试连接 / OAuth 授权按钮 → 刷新工具，见 `McpSettingsTab.tsx:293-311`）。

### 2.3 Agent 工具面：没有任何 MCP 管理工具

`electron/tools/`（内置执行器目录）与 `plannedToolRegistry.ts` 中检索 `mcp` 仅命中结果展示类型引用（`McpResultDisplay`），不存在添加连接、发起授权、刷新工具之类的 Agent 可调用工具。聊天循环中 MCP 工具快照仅桌面 lane 注入，远程 lane（飞书/微信）显式为空（`toolChatLoop.ts:630` 注释）。

---

## 3. 差距分析：为什么「不支持这类 MCP 安装方式」

### 3.1 根因：产品能力 ≠ Agent 能力

「产品支持某能力」与「聊天 Agent 能自主使用该能力」在本产品中是两层：

- 产品层：远程 MCP + OAuth 全栈**已实现**（见 §2.1）。
- Agent 层：Agent 只能调用内置工具（`electron/tools/` 注册）与已注入的 MCP 映射工具。**MCP 的"安装/授权"环节没有任何工具入口**，只有人类可操作的设置页。

因此面对「由你（Agent）在本机完成接入」的任务，Agent 的正确回答就是「不支持」——按任务第 5 条的要求，它也不应该偷偷降级为「让用户手工配置」或「用 shell 绕过」。

### 3.2 Agent 无法用通用工具替代（安全设计使然）

- 配置存于应用 SQLite（`config.mcpServers`，`mcpConfigStore.ts:34-37`），Agent 即使经 shell 直写数据库，也绕过了 schema 校验、确认体系与审计，且不会触发连接与 OAuth 流程。
- 凭据经 `safeStorage` 加密（OS 用户级密钥），Agent 侧无法产出合法密文，也不应接触明文。
- OAuth 回调依赖主进程 loopback HTTP 服务器 + `shell.openExternal`，Agent 的 shell 环境不具备等价能力。

### 3.3 生财有术服务端实测：协议层无障碍

对 `https://mcp.scys.com/shengcai-web/mcp` 的只读探测（2026-09-17，详见附录 A）：

1. 未授权访问返回 `401` + `WWW-Authenticate: Bearer resource_metadata="https://mcp.scys.com/.well-known/oauth-protected-resource", scope="mcp"`（标准 RFC 9728 入口）。
2. 资源元数据：`authorization_servers: ["https://mcp.scys.com/mcp-oauth"]`，`scopes_supported: ["mcp"]`。
3. 授权服务器元数据（RFC 8414 路径插入式）：**支持 DCR**（`registration_endpoint: .../register`）、PKCE `["S256"]`、`token_endpoint_auth_methods_supported: ["none"]`（public client）、`authorization_code + refresh_token`、还提供 `revocation_endpoint`。

结论：SpaceAssistant 现有 OAuth 流程**手工**走设置页即可接入（SDK 会自动完成 DCR，scope 由 SDK 的 SEP-835 策略从 WWW-Authenticate/资源元数据自动解析，见 `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js:219-224`）。任务失败的根因完全在 §3.1 的 Agent 能力层，而非协议不兼容。

### 3.4 次级健壮性差距（即便手工配置也可能踩坑）

| # | 差距 | 现状 | 影响 | Codex 对照 |
|---|---|---|---|---|
| G1 | 回调端口固定 `42188` | 端口被占/防火墙拦截即失败；redirect URI 与端口强绑定 | 环境敏感 | 绑 `127.0.0.1:0` 临时端口 + RFC 8252 loopback 端口补全（`perform_oauth_login.rs`、`oauth_callback.rs`） |
| G2 | 错误粒度不足 | 发现失败 → 统一提示「需填写 Client ID」 | Agent/用户难自纠（分不清「服务器无 OAuth」「元数据不可达」「策略拦截」） | 结构化 `OAuthProviderError` + discovery 瞬时错误不误判为不支持 |
| G3 | 重定向全拒绝 | 同源 3xx 也拒绝 | 网关 308 补尾斜杠等场景误伤 | Legacy 模式允许跟随，仅 Agent 插件模式禁止 |
| G4 | 无 CIMD | 仅 DCR / 预设 / 手工 Client ID | 只支持 CIMD 的新授权服务器无法接入 | Auto 策略：CIMD 优先，DCR 兜底（`oauth_client_registration.rs`） |
| G5 | registration 无登出/吊销 | `mcp:clear-secret` 只清 token，client info 永久留存 | 凭据生命周期不完整 | `codex mcp logout` 清 keyring + 回退文件 |
| G6 | 配置变更无事件推送 | 快照按请求构建，下一条消息生效；UI 手动刷新 | 「授权完成后会话自动可用」无反馈 | 会话内 `refresh_mcp_config` 热重建连接 |
| G7 | 运行中授权过期 | 标记 `auth-expired`，工具错误附诊断 | 无主动推送引导重新授权 | 401 返回结构化错误 + `www_authenticate` meta，UI 引导 login |
| G8 | remote lane 不注入 MCP | 飞书/微信会话快照为空 | IM 场景不可用（明确的范围决策，见 §7） | — |

---

## 4. Codex 参考实现对照（只读分析）

Codex 的 MCP 客户端构建在官方 `rmcp = 3.2.0` 之上，PKCE/state/DCR/token 交换全部下沉到协议库，自研层只做策略与安全加固——与 SpaceAssistant「下沉到 `@modelcontextprotocol/sdk` 1.30.0」的选型一致。可借鉴点按价值排序：

| 能力点 | Codex 做法 | SpaceAssistant 现状 | 借鉴 |
|---|---|---|---|
| **add 即登录** | `codex mcp add --url` 添加时即做 OAuth discovery，检测到 OAuth 支持自动发起登录（`cli/src/mcp_cmd.rs:431-460`） | 无 Agent 入口，UI 分「添加→测试→授权」多步 | P0 工具的 `add` 动作内置 discovery 反馈，引导 Agent 连续调用 `login` |
| 客户端注册策略 | Auto：元数据宣告 CIMD 支持则 CIMD，否则 RFC 7591 DCR；已有 client_id 则直连 | DCR → 预设 → 手工 | CIMD 列为长期项（G4） |
| 回调服务器 | 临时端口；每服务器唯一路径 ID（sha256(serverURL)）；RFC 9207 `iss` 校验防 mix-up；RFC 8252 预注册端口补全 | 固定端口 + state 校验 | G1 的端口回退即可，mix-up 防护可后续增强 |
| Token 存储 | keyring → age 加密文件 → 0600 明文回退，三级策略；refresh 前跨进程文件锁 + issuer 绑定校验 | safeStorage + SQLite 单键 + 进程内写互斥（单实例场景够用） | 现状可接受；跨实例/多窗口时再引入锁 |
| 401 运行时 | 不自动弹授权：返回结构化错误结果 + `meta["mcp/www_authenticate"]`，由 UI 引导重新 login；有效 refresh token 时静默刷新 | `invalidateCredentials('tokens')` → `auth-expired` + 诊断 | G7 推送增强 |
| 配置热刷新 | `Session::refresh_mcp_config` 会话内失效门闩 + 按新配置重建连接 | 请求级快照，下一条消息生效 | G6 事件推送 |
| scope 协商 | `--scopes > 配置 > discovery scopes_supported`；`invalid_scope` 自动去 scope 重试一次 | SDK SEP-835（WWW-Authenticate → PRM → clientMetadata） | 已覆盖 scys 场景；可把 `profile.auth.oauthScopes` 显式传入 SDK `auth()` 作覆盖项 |
| 超时默认 | startup 30s / tool 300s | 连接超时与 `timeoutSec` 可配 | 对齐默认值语义即可 |

> Codex 关键文件索引：`codex-rs/rmcp-client/src/{perform_oauth_login.rs, oauth.rs, oauth_client_registration.rs, oauth_callback.rs, rmcp_client.rs}`、`codex-rs/codex-mcp/src/connection_manager.rs`、`codex-rs/config/src/mcp_types.rs`、`codex-rs/cli/src/mcp_cmd.rs`。

---

## 5. 改进方案

### 5.1 目标与非目标

**目标**

1. 聊天 Agent 可通过内置工具自主完成远程 MCP 的「添加 → 授权 → 刷新工具 → 调用验证」全链路，用户只在浏览器确认一次授权。
2. Agent 可查询 MCP 配置/凭据/授权状态，缺能力时得到结构化错误码并准确转述（对齐来源任务第 5 条）。
3. 凭据零暴露：工具结果、日志、诊断均不含 token / code / verifier / client_secret。

**非目标**

- 飞书/微信远程 lane 的 MCP 注入（G8，范围决策另行评审）。
- CIMD 注册方式（依赖 SDK 上游，列为开放问题）。
- 自研 OAuth 协议实现（继续下沉到 `@modelcontextprotocol/sdk`）。
- macOS 平台凭据策略变更（当前仅 Windows；safeStorage 在 macOS 默认走 Keychain，若未来需要「禁 Keychain」场景，另立需求做应用层加密回退）。

### 5.2 P0：Agent 可调用的 MCP 管理工具（核心）

**5.2.1 抽取 service 层**

`mcpIpc.ts` 中内联的编排逻辑（test-connection 的草稿 secret 合并、oauth 触发、refresh-tools 的连接生命周期）抽取为 `electron/mcp/mcpService.ts`，IPC 处理器与 Agent 工具执行器共用同一入口，避免双实现漂移。

**5.2.2 新增内置工具 `mcp_manage`**

参数为结构化对象（不拼 shell 字符串），动作枚举：

| action | 入参 | 行为 | 默认确认策略 |
|---|---|---|---|
| `list` | — | 列出服务（id/名称/传输/认证模式/状态/已启用工具数），**不含任何 secret** | 免确认（只读） |
| `status` | serverId | 状态 + 最近脱敏诊断 + 授权是否进行中（`isOAuthFlowActive`） | 免确认（只读） |
| `add` | name、transport(`http`/`stdio`)、endpoint 或 command/args/env、auth 模式、可选 oauthScopes | 校验 endpoint 策略 → 保存 profile → 自动做一次 OAuth discovery，返回「支持 OAuth(DCR)/需 Client ID/不支持 OAuth 仅 Bearer」的结构化结论 | **需确认**（展示完整 endpoint） |
| `login` | serverId | 已有有效 token 则直接返回已授权；否则复用 `startOAuthFlow`（单飞锁防重复 OAuth），拉起浏览器等待 loopback 回调 | **需确认** |
| `logout` | serverId | 清 token + client info；服务端支持 `revocation_endpoint` 时调用吊销（G5） | **需确认** |
| `refresh` | serverId | 复用 refresh-tools 逻辑：重连、重建工具缓存、更新状态 | 免确认 |
| `remove` | serverId | 删除服务并吊销其工具 | **需确认** |

MCP 业务工具本身（已注入的映射工具）的调用路径不变，仍走现有确认门控（`confirmation/mcpConfirmPolicyMigration.ts`）。

**5.2.3 安全与脱敏约束**

- 工具结果统一走 `logSanitize` / 既有 `secretPresent` 旗标模式：只返回布尔存在性，不返回明文；授权 URL 可返回（本身无凭据），`code`/`state`/`verifier` 永不返回。
- `add` 的 endpoint 强制经过 `endpointPolicy.ts` 既有校验（私网/重定向/受控头），无旁路。
- `mcp_manage` 仅桌面 lane 注册（与 mcpSnapshot 的 lane 策略一致）。

**5.2.4 系统提示与产品自省（来源任务第 1 条）**

在 llmSystemPrompt 中注入本产品的 MCP 能力简述：支持的能力（传输/认证/DCR）、配置存放位置（应用数据库 + safeStorage）、标准接入流程（`add → login → refresh → 调用只读工具验证`）、以及「能力不足时报告错误码而非编造命令」的要求。这直接解决 Agent 自省与准确报错。

### 5.3 P1：OAuth 健壮化

1. **结构化错误码**（G2）：`startOAuthFlow` 失败时区分并向上返回：`oauth-metadata-unreachable` / `oauth-unsupported` / `oauth-no-dcr-and-no-client-id` / `oauth-dcr-rejected` / `oauth-callback-port-busy` / `oauth-timeout` / `endpoint-policy-blocked`。UI 提示与 Agent 工具结果同源，Agent 可据此自纠（如改用 bearer-token 模式）。
2. **回调端口回退**（G1）：优先绑 `42188`，占用时回退 OS 临时端口；DCR 场景 redirect URI 以实际端口注册；预注册场景（手工 Client ID/预设）保持固定端口并在错误码中明示。
3. **重定向分级**（G3）：同源 3xx 允许跟随（上限 3 跳），跨源仍拒绝；策略常量可配置。
4. **scope 覆盖**：`profile.auth.oauthScopes` 非空时显式传入 SDK `auth()` 的 `scope` 参数，覆盖 SEP-835 自动解析。
5. **registration 生命周期**（G5）：`logout` 同步清除 client info；有 `revocation_endpoint` 时先吊销。

### 5.4 P2：会话联动与体验

1. **变更事件**：服务增删/授权完成/工具刷新后，主进程广播 `mcp:servers-changed`；设置页自动刷新，聊天面板提示「MCP 工具已更新，下一条消息生效」（G6）。
2. **授权过期推送**：`auth-expired` 状态变化推送到渲染端，聊天内引导一键重新授权（G7）。
3. **授权等待提示**：OAuth 进行中复用浮动通知提示「请在浏览器完成授权」。
4. **端到端验收路径**（即来源任务的改造后形态）：Agent `add(scys-mcp, http, endpoint, oauth)` → 返回「支持 DCR」→ `login`（用户浏览器点一次授权）→ `refresh` 返回工具清单 → Agent 直接调用一个只读映射工具 → 按「客户端/环境/配置位置/授权结果/重载状态/只读调用结果」汇报，全程不回显凭据。

---

## 6. 测试与验收边界

**当前环境可单测验证（本地闭环）**

- `mcpService` 各 action：内存 SQLite + 注入 fetch 的 discovery mock（`mcpOauthService.test.ts` 已有 `authorize`/`openBrowser` 测试缝，直接复用）。
- DCR 全流程 mock IdP：注册返回 client_id、state 不匹配拒绝、回调超时、端口占用回退路径。
- `mcp_manage` 工具：schema 校验、确认门控矩阵（七类动作的默认策略）、结果脱敏快照（注入含 token 形态的 mock 响应断言零泄漏）。
- 重定向分级、endpoint 策略回归（`endpointPolicy.test.ts`、`streamableHttpTransport.test.ts` 既有用例保持通过）。
- 边界回归（带状态/外部耦合，按 AGENTS.md 纪律）：授权单飞锁与编辑互斥（授权中 add/remove/login 的竞态）、工具吊销与待确认请求清理。

**需真机 / 外部系统 / 人工验收**

- 生财有术真实浏览器授权（用户点击确认）与真实 DCR 注册。
- Windows `safeStorage`（DPAPI）真机加解密；防火墙对 127.0.0.1 监听的行为。
- 真实服务端 token 过期 → 静默刷新 → 过期失效的全周期。

**分阶段验收标准**

- P0：Agent 在对话中完成对任意支持 DCR 的 mock/真实服务的 add→login→refresh→只读调用，用户交互仅浏览器一次点击；`npm run test:electron` 定向用例全绿。
- P1：七类错误码在 mock IdP 下逐一可触发且文案准确；端口占用场景自动回退成功。
- P2：授权完成/过期事件在聊天面板可见；`npm test` 全量通过。

---

## 7. 风险与开放问题

1. **自动化安装的安全边界**：`add/login` 需确认的默认策略不可放宽；确认卡片必须完整展示 endpoint，防诱导配置恶意端点（endpointPolicy 已挡私网/重定向，但公网恶意端点仍需人工确认把关）。
2. **SDK 双路径行为差异**：`startOAuthFlow` 先显式 `discoverOAuthServerInfo` 再 connect，部分服务器 discovery 端点缺失但 `WWW-Authenticate` 完整——需保证失败回落到 SDK 401 自发现路径（现实现已有 fallback 注释，`mcpOauthService.ts:247-249`，补测试固化）。
3. **CIMD**：SDK 1.30.0 无 CIMD 支持；若目标服务器只支持 CIMD，短期无法接入，跟踪 `@modelcontextprotocol/sdk` 上游进展。
4. **多窗口/多实例**：凭据写互斥为进程内实现，跨进程刷新锁暂无需求（单实例锁已由 Electron 保证），引入多实例时参考 Codex 的文件锁方案。
5. **remote lane（G8）**：IM 会话无法使用 MCP 工具是有意的隔离决策，若要放开需先评审工具确认在无 UI 场景下的交互方式（飞书审批流已有先例）。

---

## 附录 A：生财有术 MCP 端点探测记录（2026-09-17，只读 GET）

**1) `GET https://mcp.scys.com/shengcai-web/mcp`** → `401`

```
www-authenticate: Bearer resource_metadata="https://mcp.scys.com/.well-known/oauth-protected-resource", scope="mcp"
{"error":"invalid_token"}
```

**2) `GET https://mcp.scys.com/.well-known/oauth-protected-resource`**

```json
{
  "resource": "https://mcp.scys.com/shengcai-web/mcp",
  "resource_name": "生财有术 MCP",
  "authorization_servers": ["https://mcp.scys.com/mcp-oauth"],
  "scopes_supported": ["mcp"],
  "bearer_methods_supported": ["header"]
}
```

**3) `GET https://mcp.scys.com/.well-known/oauth-authorization-server/mcp-oauth`**

```json
{
  "issuer": "https://mcp.scys.com/mcp-oauth",
  "authorization_endpoint": "https://mcp.scys.com/mcp-oauth/authorize",
  "token_endpoint": "https://mcp.scys.com/mcp-oauth/token",
  "revocation_endpoint": "https://mcp.scys.com/mcp-oauth/revoke",
  "registration_endpoint": "https://mcp.scys.com/mcp-oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp"],
  "authorization_response_iss_parameter_supported": false
}
```

## 附录 B：现状文件索引

| 文件 | 职责 |
|---|---|
| `src/shared/mcpTypes.ts` | 领域类型与 zod schema（认证模式、profile、并发/预算常量） |
| `electron/mcp/mcpConfigStore.ts` | `config.mcpServers` / 工具缓存 / 诊断的存取 |
| `electron/mcp/mcpConnectionManager.ts` | 连接池、`testConnection`、OAuth 授权服务器 origin 解析 |
| `electron/mcp/mcpOauthService.ts` | OAuth 全流程（发现/DCR/PKCE/回调/token 存储） |
| `electron/mcp/mcpSecretStore.ts` | safeStorage 加密凭据存取（写互斥链） |
| `electron/mcp/mcpIpc.ts` | 九个 `mcp:*` IPC 处理器（P0 抽取 mcpService 的对象） |
| `electron/mcp/mcpToolRegistry.ts` / `mcpToolExecutor.ts` | 工具发现/映射命名/执行/取消/超限落盘 |
| `electron/mcp/endpointPolicy.ts` / `streamableHttpTransport.ts` | endpoint 安全策略与传输封装 |
| `electron/toolChatLoop.ts:628-640` | 请求级 MCP 工具快照注入与执行器解析 |
| `src/renderer/components/Config/McpSettingsTab.tsx` 等 | 设置页 UI（当前唯一配置入口） |

---

## 修订记录

- **2026-09-17 评审结论**：§5.2 的「mcp_manage 专用内置工具」路线经评审**否决**——按场景逐个追加专用工具会持续膨胀模型上下文，改为「能力集合网关」（两个稳定工具 + 内部能力注册表）承载，见《agent-toolkit-capability-gateway-requirement.md》及评审报告（`agent-toolkit-capability-gateway-requirement-review.md`，本地过程产物，不入版本控制）。
- 保留与生效关系：§5.2.1（mcpService 抽取）保留，由 toolkit Phase 2 沿用；§5.3 P1（OAuth 健壮化）全部有效；§5.4 P2①②（变更事件、过期推送）有效，③④（浮动通知、端到端验收路径）随 toolkit Phase 3 生效；§0/§5.1 的「用户只在浏览器确认一次授权」端到端承诺由 toolkit 分期兑现——Phase 2 降级为设置页授权，Phase 3 恢复。
