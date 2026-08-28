# MCP 外部能力接入与设置管理 — 需求规格

**版本：** 1.2  
**日期：** 2026-08-28  
**状态：** 修订待评审  
**关联文档：** [tools-requirement.md](./tools-requirement.md)、[settings-requirement.md](./settings-requirement.md)、[browser-network-access-settings-requirement.md](./browser-network-access-settings-requirement.md)、[shell-security-enhancement-requirement.md](./shell-security-enhancement-requirement.md)

---

## 1. 背景与目标

### 1.1 背景

SpaceAssistant 已具备内置工具注册、模型工具调用循环、确认卡片、调用结果持久化和工具开关设置。现有能力仅来自应用内置 executor；用户无法把已部署的 GitHub、数据库、知识库、协作平台等 MCP Server 提供给 Agent 使用。

本需求将 SpaceAssistant 定义为 **MCP Client / Host**：它连接用户配置的 MCP Server，把服务端公布的工具转换为当前大模型可调用的工具，并在主进程中执行调用。MCP Server 不直接获得渲染进程、Electron API、数据库或用户本地文件权限。

### 1.2 目标

| 编号 | 目标 |
|---|---|
| G1 | Agent 可在一次对话的工具循环中发现并调用已启用 MCP Server 的工具。 |
| G2 | 设置中提供完整的 MCP Server 增删改查、启停、连通性测试、授权、工具选择与故障诊断入口。 |
| G3 | 首期支持主流 `stdio` 和 Streamable HTTP 传输；支持无认证、手工 access token、常见 API Key 请求头，以及 OAuth 2.1 授权码流程。 |
| G4 | 所有凭据均安全保存、脱敏展示和脱敏记录；任何 token 不进入普通配置 JSON、聊天记录、诊断日志或模型上下文。 |
| G5 | MCP 外部工具复用现有确认、取消、进度、工具卡片和审计链路，并默认遵循最小权限原则。 |
| G6 | 配置变更、服务端工具变化和连接失败不会破坏已有会话或内置工具调用。 |

### 1.3 非目标

- 首期不把 SpaceAssistant 暴露为 MCP Server，不向第三方 Client 提供本地文件、聊天、飞书或浏览器等能力。
- 首期不实现 MCP `resources`、`prompts`、`sampling`、`elicitation`、`roots` 等能力；只接入 Server 的 `tools/list` 与 `tools/call`。后续迭代可在同一连接管理层扩展。
- 首期不支持已废弃的 HTTP+SSE 传输，也不通过 URL Query 参数传递 token。
- 首期不实现 MCP 市场、在线搜索、团队共享、配置导入导出或服务端代理。
- 不因接入 MCP 降低现有内置工具的工作目录、Shell、远程 IM 等安全限制。

### 1.4 术语

| 术语 | 含义 |
|---|---|
| MCP Server | 实现 Model Context Protocol、向 SpaceAssistant 提供工具的外部进程或 HTTP 服务。 |
| 服务配置（Server Profile） | 一个可独立连接、认证、启用及选择工具的 MCP Server 条目。 |
| 映射工具名 | 为满足当前模型 API 名称限制而生成的内部唯一名称，例如 `mcp_github_create_issue`。 |
| 原始工具名 | MCP Server 在 `tools/list` 中返回的 `name`；仅在与 Server 通讯及界面展示中使用。 |
| 凭据 | access token、refresh token、API Key 或 `stdio` 环境变量中的值。桌面应用不保存 OAuth client secret。 |

---

## 2. 使用者与用户故事

### 2.1 使用者

- 希望让 Agent 操作已授权第三方服务的个人开发者。
- 使用本机 `npx`、Python、Docker 等方式启动本地 MCP Server 的高级用户。
- 使用公网 HTTPS MCP 服务、需手工填入 access token 或 OAuth 登录的个人用户。

### 2.2 用户故事

| 编号 | 用户故事 |
|---|---|
| US-01 | 作为开发者，我可以添加一个 `stdio` MCP Server，使 Agent 在聊天中调用其工具。 |
| US-02 | 作为用户，我可以添加一个远程 MCP URL，使用 `Authorization: Bearer <access_token>` 完成认证，而不把 token 写进 URL 或日志。 |
| US-03 | 作为使用 OAuth 的服务用户，我可以点击「连接账户」在浏览器完成登录，应用自动安全保存可刷新凭据。 |
| US-04 | 作为安全敏感用户，我能在 Agent 调用外部工具前查看调用目标和参数，并决定本次允许、拒绝或仅本会话信任。 |
| US-05 | 作为故障排查者，我能从设置中知道服务未启用、认证过期、连接失败或工具列表更新的具体原因，但不会看到明文凭据。 |
| US-06 | 作为远程 IM 用户，我的飞书/微信请求不会在未显式批准的情况下触发任意外部 MCP Server。 |

---

## 3. 范围、兼容性与协议基线

### 3.1 协议基线

- 客户端遵循 MCP 的 JSON-RPC 编码、初始化和 capabilities 协商流程。
- 初始化请求不得声明本期未实现的客户端能力（`sampling`、`elicitation`、`roots` 等）；若 Server 在会话中主动发起这些请求，Client 返回 JSON-RPC「method not found」错误并记录脱敏兼容性诊断。
- 标准传输为 `stdio` 与 **Streamable HTTP**。MCP 规范要求 Client 尽可能支持 `stdio`，并将 Streamable HTTP 作为替代旧 HTTP+SSE 的标准 HTTP 传输。[MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- HTTP 认证使用请求头 `Authorization: Bearer <access-token>`；每个 HTTP 请求均须带认证头，严禁把 token 放入 URI query string。[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- 若 Server 支持标准 OAuth，Client 使用 OAuth 2.1 授权码 + PKCE、Protected Resource Metadata 和 Authorization Server Metadata。`resource` 参数必须绑定到目标 MCP Server。[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

### 3.2 支持矩阵

| 能力 | P0（本期） | 说明 |
|---|---|---|
| `stdio` | 支持 | 主进程启动子进程，经 stdin/stdout 传输 JSON-RPC。 |
| Streamable HTTP | 支持 | 支持 JSON 响应与 SSE 响应、服务端会话 ID、取消请求。 |
| 无认证 | 支持 | 仅适合受信任的本地或公开测试服务。 |
| 手工 Bearer access token | 支持 | 首选的手工 token 方式。 |
| 自定义请求头 API Key | 支持 | 覆盖 `x-api-key`、`X-API-Key`、`Authorization: ApiKey ...` 等服务商方式。 |
| OAuth 2.1 | 支持 | 授权码 + PKCE；自动发现、动态客户端注册优先，手工 client ID 兜底。 |
| token 自动刷新 | 支持 | OAuth Server 返回 refresh token 时支持；手工 token 不推测有效期、不自动刷新。 |
| HTTP+SSE（旧版） | 不支持 | 明确提示用户升级 Server 至 Streamable HTTP。 |
| 资源、提示词 | 不支持 | 不出现在模型可用工具列表。 |
| MCP Server 反向调用客户端能力 | 不支持 | 收到 `sampling` / `elicitation` / 其他 Server request 时拒绝，并显示兼容性错误。 |

### 3.3 兼容与降级原则

- Server 不支持某项可选 capability 时，不影响已支持的工具调用。
- 初始化失败、认证失败或工具列表为空时，该服务不向模型暴露任何工具；内置工具不受影响。
- 服务端发送 `notifications/tools/list_changed` 时，标记工具列表过期并后台刷新；刷新期间继续使用上一次成功列表。刷新失败则保留上一次列表，但下一次调用前必须重新验证连接。
- 配置保存后仅影响**后续**聊天请求。已在执行的工具调用保持其启动时连接与配置快照，除非用户主动取消。

---

## 4. 产品交互与设置入口

### 4.1 入口和导航

在「设置 → 工具」左侧二级导航中，位于「工具开关」之后新增：

| 顺序 | key | 标签 | 说明 |
|---|---|---|---|
| 1 | `switches` | 工具开关 | 现有内置工具开关。 |
| 2 | `mcp` | MCP 服务 | 外部 MCP Server 的管理、认证、工具和连接状态。 |
| 3 | `file` | 文件操作 | 保持现有。 |
| … | … | … | 其余分区顺序保持不变。 |

聊天中的 MCP 工具失败卡片可提供「管理 MCP 服务」链接，打开「设置 → 工具 → MCP 服务」，并定位到相应服务。

MCP 服务采用**分区内保存**：编辑卡片后须点击该卡片的「保存并应用」，由 `mcp:save-profiles` 立即持久化；设置弹窗底部现有「保存」按钮不保存 MCP 草稿。关闭设置或切换分区时，未保存的 MCP 草稿丢弃并提示用户确认，避免与 `config:set` 形成第二个保存通道。

### 4.2 服务列表

服务列表使用与大模型服务一致的卡片式管理，不展示凭据明文。每张卡片必须包含：

| 区域 | 内容与行为 |
|---|---|
| 标题行 | 启用开关、服务显示名称、传输类型标签（`stdio` / `HTTP`）、连接状态、展开/收起、删除。 |
| 摘要 | `stdio` 显示命令（截断）；HTTP 显示规范化后的 endpoint host/path（不含用户名、密码、query、fragment）。 |
| 状态 | `未测试`、`连接中`、`待授权`、`认证过期`、`已连接`、`连接失败`、`工具不可用`、`已停用`。状态说明须可读且可复制。 |
| 工具摘要 | 已发现工具数、已授权工具数；工具列表过期时显示「待刷新」。 |
| 操作 | 测试并刷新、重新连接/重新启动、连接账户或更新 token、查看最近错误、删除。 |

- 默认最多保存 **20** 个服务配置；超出时阻止新增并说明原因。
- 名称为 1–64 个字符，同一配置内不可重复；删除需二次确认。
- 新建服务默认**未启用**。完成首次「测试并刷新」且用户保存至少一个工具白名单后，用户可手动启用；不提供「未测试仍启用」的例外路径。
- 禁用服务立即从后续模型请求中移除其工具，并断开空闲连接；不删除配置和凭据。
- 删除服务时必须同时删除其加密凭据、OAuth 授权状态和工具缓存，聊天历史中的既有工具卡片保留。

### 4.3 新增/编辑服务表单

表单采用「基础信息 → 连接方式 → 认证 → 工具与权限 → 诊断」顺序。未保存的敏感输入只存在渲染进程草稿；仅在用户点击保存或测试时通过专用、一次性 IPC 交给主进程。**OAuth 只允许针对已保存的服务启动**，避免草稿授权成功后凭据归属和取消清理不明确。

#### 4.3.1 基础信息

| 字段 | 规则 |
|---|---|
| 服务名称 | 必填，唯一，1–64 字符。 |
| 启用此服务 | 新建时默认关闭；只有最近一次测试成功、发现至少一个工具且已保存至少一个工具白名单时才可打开。测试后失联、认证失效或工具清单为空时自动关闭。 |
| 传输方式 | 必填单选：`stdio`、`Streamable HTTP`；修改方式时清除不适用的草稿字段，并在保存前二次确认。 |
| 调用超时 | 5–300 秒，默认 60 秒；连接/初始化超时固定 15 秒。 |

#### 4.3.2 `stdio` 连接字段

| 字段 | 规则 |
|---|---|
| 命令 | 必填，作为可执行文件路径或 PATH 命令；不得解析为 Shell 字符串。 |
| 参数 | 可增删的参数数组；每项是一个独立 argv 元素，禁止让用户填写整段 shell 命令。 |
| 工作目录 | 可选，须为本机存在目录；默认应用当前工作目录。 |
| 环境变量 | 可增删的键值对；键名匹配 `[A-Za-z_][A-Za-z0-9_]*`。**所有变量值均按 Secret 处理**，加密保存并以「已配置」展示；再次编辑留空表示不修改，显式清除才删除。 |
| 启动确认 | 首次保存或命令/参数改变时必须勾选「我信任此本地程序及其访问权限」后才可启用或测试。 |

说明文本必须清晰提示：`stdio` Server 是本机程序，可继承用户权限；此处只支持直接启动程序，不支持 `sh -c`、管道、重定向、`&&`、`$()` 或反引号。

**Windows 平台限制（已决策，见开发计划 §8 第 4 条）**：`shell:false` 在 Windows 上无法执行 `.cmd`/`.bat` 批处理垫片（libuv 限制），而 `npx`/`npm`/`pnpm` 在该平台均为 `.cmd` 垫片。P0 在命令解析阶段（含 PATH 解析命中垫片的情况）显性拒绝 `.cmd`/`.bat`，并给出可读引导（改用 `node <入口.js>`、`python`、`docker` 等无 Shell 写法）；§2.1 中「本机 `npx` 启动」的用户故事在 Windows 上通过上述等价写法满足，macOS/Linux 不受影响。Windows 的 npx 体验补偿（引导生成 / 受控安装）列入 P1 评估。

命令、参数和工作目录不是凭据字段：界面必须提示用户将 API Key / token 放入环境变量，不能放入命令或参数；保存和测试时检测常见 token 格式及 `--token`、`--api-key`、`Authorization:` 等敏感参数模式并拒绝，防止凭据进入普通 Profile、进程列表或诊断日志。

#### 4.3.3 Streamable HTTP 连接字段

| 字段 | 规则 |
|---|---|
| MCP Endpoint | 必填，完整绝对 URL；保存时规范化（host 小写、移除 fragment、保留有意义 path）。 |
| URL 限制 | 禁止用户名/密码、query、fragment；默认仅允许 `https://`。`http://` 仅允许 loopback（`localhost`、`127.0.0.1`、`::1`）并显示高风险提示。 |
| 网络边界 | 仅允许公网地址和 loopback；拒绝私网、链路本地、组播及其他保留地址，不提供「忽略校验」开关。企业内网不属于本产品定位和后续需求范围。 |
| 自定义请求头 | 仅在「自定义请求头」认证模式可编辑；不允许设置 `Host`、`Content-Length`、`Connection`、`Cookie`、`Origin`、`Mcp-Session-Id` 等受控头。 |

### 4.4 认证与 access token 配置

认证方式由下表单选，切换方式前须提示将删除或保留哪些旧凭据；未选择认证时不发送认证头。

| 模式 | 适用场景 | 表单字段 | 实际发送/行为 |
|---|---|---|---|
| 无认证 | 本机或公开 Server | 无 | 不发送凭据。 |
| Bearer access token（默认） | OAuth access token、个人访问令牌、JWT | `accessToken`（密码框） | 每次 HTTP 请求发送 `Authorization: Bearer <token>`。 |
| 自定义请求头 | API Key 或服务商私有格式 | 头名称、可选值前缀、token | 每次 HTTP 请求发送 `{headerName}: {prefix}<token>`；例：`x-api-key: sk-...`。 |
| OAuth 2.1 | Server 支持交互登录 | 自动发现；可选 client ID；高级项中的 scopes | 点击「连接账户」后启动授权码 + PKCE 流程，保存 access/refresh token 和过期时间。 |
| `stdio` 环境变量 | 本地 Server 从环境取 token / 配置 | 变量名、值 | 每个值均按 Secret 保存，仅注入该子进程环境，不出现在 HTTP 头或渲染进程。 |

认证规则：

1. HTTP 服务默认选中 **Bearer access token**，同时允许用户切换为无认证、自定义头或 OAuth。
2. Bearer 和自定义头的 token 输入框均为密码框。保存后仅显示「已配置」及最近更新时间；再次留空表示不修改，显式「清除 token」才会删除。
3. 不支持 URL query token、在 endpoint 中嵌入 `user:password`，也不支持把 Bearer token 转发给不同 endpoint、重定向目标或下游服务。
4. OAuth 模式先处理 Server 返回的 `401` 和 `WWW-Authenticate`，按 MCP OAuth 发现流程读取 Protected Resource Metadata / Authorization Server Metadata；授权请求和 token 请求均包含目标 Server 的 `resource` 参数。
5. OAuth 必须使用 PKCE、随机 `state`、固定 loopback 回调监听器；回调 state 不匹配、过期或重复使用时拒绝。浏览器回调完成后立即关闭监听器。授权过程中不允许编辑、删除或切换该服务；用户取消授权或授权失败时不写入 access/refresh token。
6. OAuth Client 的解析顺序为：优先使用 Dynamic Client Registration；不支持时使用与目标 MCP Server / Authorization Server 精确匹配的内置 Client 预设；仍无匹配项时允许用户填写公开 `clientId`。**不**在设置页接受或持久化 OAuth `clientSecret`；桌面应用按 public client 实现。
7. OAuth refresh token 仅在 access token 临近过期或收到一次 `401` 时刷新。刷新失败则状态改为「认证过期」，不自动反复重试，要求用户重新连接。
8. `stdio` 不走 MCP HTTP OAuth 规范；其认证由环境变量或 Server 自身机制提供，符合 MCP 对 `stdio` 从环境获取凭据的建议。环境变量不是 `auth.mode`，可与无认证的 `stdio` 服务并存。

#### 4.4.1 OAuth Client 预设目录

P0 支持内置、只读的 OAuth Client 预设目录，降低不支持 DCR 的主流 MCP 服务的配置门槛。

- 预设随应用版本发布和审查，不从网络静默下载；每项包含 `presetId`、显示名称、允许的 MCP Server origin、Authorization Server issuer、公开 `clientId`、允许 scopes 和 redirect URI 策略。
- 只有发现到的 MCP Server origin 与 Authorization Server issuer 均与预设精确匹配时才可自动选用；不得因名称相似、子域名匹配或用户输入的显示名称而命中。
- 设置页在 OAuth 区域显示实际生效方式：`自动注册（DCR）`、`内置预设：<名称>` 或 `手动 Client ID`。预设的 client ID、issuer、scopes 和 redirect URI 不可在 UI 编辑。
- 首批预设的加入或更新，必须同时具备服务商公开的 OAuth Client 注册依据、回调 URI 验证和集成测试；无法注册或不允许桌面 public client 的服务不得加入。
- 手工 public client ID 始终保留为兜底路径，并提示用户该 ID、授权域和 scopes 由其自行负责；它不能覆盖 Server 通过 metadata 声明的 Authorization Server。

### 4.5 连接测试与工具发现

点击「测试并刷新」后，主进程按以下步骤执行：

1. 校验草稿字段与安全策略；未保存的凭据作为一次性内存值参与测试。
2. 建立连接、发送 `initialize`、完成 `notifications/initialized`，校验 Server 协议版本与 capabilities。
3. 调用 `tools/list`，校验每个工具的名称、描述和 `inputSchema`，生成内部映射名。
4. 显示 Server 名称、协商协议版本、发现工具数、可选工具清单；绝不返回请求头、token、环境变量明文或未经处理的原始错误响应。
5. 用户保存时，持久化配置、加密凭据与合法的工具缓存；用户取消时丢弃草稿和临时连接。

连接测试不调用任何 Server 工具。服务端声明零个工具不是连接错误，但该服务不可启用为 Agent 工具来源，页面显示「未发现可调用工具」。

### 4.6 工具选择与权限配置

成功发现工具后，在服务卡片中显示工具列表：原始工具名、描述、风险提示、启用开关和「调用前确认」策略。默认所有工具为**未授权**，用户至少启用一个工具后服务才会出现在 Agent 可用列表。

| 配置项 | 默认值 | 规则 |
|---|---|---|
| 工具启用 | 关闭 | 按 Server + 原始工具名保存白名单；服务端新增工具不会自动启用。 |
| 调用前确认 | 始终确认 | 每次调用展示确认卡片。 |
| 只读工具可自动调用 | 关闭 | 仅用户手动开启、且 Server 同时声明 `readOnlyHint: true` 与 `destructiveHint: false` 时可选；Server 注解只是提示，不能自动放宽默认策略。 |
| 本会话信任 | 关闭 | 只在确认卡片中供用户选择；会话结束即失效，不写入长期设置。 |
| 远程 IM 可用 | 关闭且不可在本期启用 | 飞书/微信会话一律不注入 MCP 工具，避免远程消息驱动高权限外部操作。 |

- 任一工具的确认卡片至少显示：服务名称、原始工具名、工具描述、结构化参数预览、将要发送的数据大小、风险说明和取消按钮。
- 参数中命中 `token`、`secret`、`password`、`authorization`、`apiKey`（大小写不敏感）的字段默认掩码；用户可单次展开查看完整值再批准。
- 服务端 tool annotations（例如 `readOnlyHint`、`destructiveHint`、`openWorldHint`）仅用于 UI 风险提示，不能绕过 SpaceAssistant 的禁用、确认和远程访问策略。

---

## 5. Agent 工具调用流程

### 5.1 注入模型的工具集合

每次用户发起聊天请求时，主进程基于该请求的配置快照构建工具集合：

```
已启用内置工具
       +
已启用、连通且白名单命中的 MCP 工具
       ↓
模型 API tools 参数
       ↓
模型返回 tool_use
       ↓
内置 executor 或 MCP executor
       ↓
统一工具结果 / 下一轮模型请求
```

- MCP 工具与 `BUILTIN_TOOL_DEFINITIONS` 同时通过现有工具循环注入，现有 `deniedTools` 只控制内置工具，不得误禁用 MCP 工具。
- 每个 MCP 工具必须拥有当前模型 API 可接受且全局唯一的映射工具名。建议规则：`mcp_<serverSlug>_<toolSlug>_<shortHash>`；长度超限时截断 slug 后保留稳定 hash。
- 映射表以 `映射工具名 → serverId + 原始工具名 + 发现版本` 保存于内存和受校验缓存；模型永远不直接决定 endpoint、认证头或 Server ID。
- 工具描述前加不可伪造的来源前缀，例如「外部 MCP 服务 `GitHub` 提供的工具」，并将 Server 返回的 description 视为不可信文本；不得把它当作系统指令执行。
- 只传递经 schema 校验的 JSON Schema。单个工具的 description + schema 序列化后不得超过 16 KiB，schema 最大深度为 20；名称无效、schema 不兼容或超过限制的工具不注入，并在服务诊断中列出原因。
- 每轮模型请求最多注入 **64 个 MCP 工具**，所有 MCP 工具的 description + schema 累计最多 **96 KiB**。超过任一上限时，按服务配置数组顺序、再按 `enabledToolNames` 保存顺序选取；未注入项目在设置页显示「因上下文预算未注入」，绝不静默改变用户的白名单或调用确认策略。
- 内置工具不计入上述 MCP 配额，但最终 `tools` 参数仍须通过当前模型 API 的总大小与名称校验；总量不满足时优先保留内置工具，并以同一排序规则裁剪 MCP 工具。

### 5.2 执行步骤

1. 收到模型的映射工具调用后，先查找本次请求快照的映射；找不到则返回「MCP 工具已变更或服务不可用」，不根据模型输入猜测路由。
2. 按服务与工具策略判断是否需要确认。拒绝、超时或取消时，向模型返回结构化、无敏感信息的工具错误。
3. 调用前以 JSON Schema 校验模型输入，并执行输入上限（默认深度 20、序列化后 256 KB）。
4. 通过已初始化连接发送 `tools/call`。每次调用携带客户端生成的 request ID，用于日志、取消与卡片关联。
5. 等待结果、SSE 消息或超时。若用户取消、会话停止或模型请求中止，向 Server 发送 MCP cancellation notification，并终止/释放本地等待。
6. 将结果转为现有 `ToolCallRecord`，写入聊天历史、展示工具卡片并作为 `tool_result` 进入下一轮模型请求。

### 5.3 并发、重试和生命周期

- 每个服务同一时刻最多 4 个工具调用；应用全局 MCP 并发上限为 8。超过上限时排队，排队状态在工具卡片可见。
- 不自动重试 `tools/call`，因为工具可能非幂等。仅连接初始化和 `tools/list` 可在无副作用前提下重试一次，退避 500–1500 ms。
- HTTP 初始化取得 `Mcp-Session-Id` 后，后续请求必须携带该 header；失效时重新初始化一次。`stdio` 子进程退出时标记断开，并在下一次工具调用前重启一次。
- 工具结果最大 1 MB；文本超过限制时按现有工具结果截断机制处理并明确标记。二进制/图片/资源引用不在首期支持，返回可解释错误而非保存未知内容。
- 每个服务保持空闲连接最多 5 分钟；无活跃调用后关闭。应用退出、服务禁用、配置删除时立即关闭连接和子进程。

### 5.4 错误分类与模型可见文案

| 分类 | 设置页状态 | 返回模型的安全摘要 |
|---|---|---|
| 配置不完整 | 未测试 / 工具不可用 | `MCP 服务配置不完整，无法调用该工具。` |
| 尚未授权 | 待授权 | `MCP 服务尚未完成授权，需要用户在设置中连接账户。` |
| 网络/进程失败 | 连接失败 | `MCP 服务暂时不可达，请稍后重试或使用其他工具。` |
| 认证失败 | 认证过期 | `MCP 服务认证失效，需要用户在设置中重新授权。` |
| 用户拒绝 | 已连接 | `用户拒绝了本次外部工具调用。` |
| 超时/取消 | 已连接 | `MCP 工具调用超时或已取消。` |
| Server 业务错误 | 已连接 | `MCP 工具执行失败：<已脱敏、长度受限的错误摘要>` |
| 协议不兼容 | 工具不可用 | `该 MCP 服务使用了当前版本不支持的协议能力。` |

HTTP 状态、OAuth 错误、JSON-RPC 错误和本地子进程 stderr 的原始内容可供用户在「最近错误」中查看**脱敏后的诊断摘要**，不得直接回灌给模型。

---

## 6. 安全、隐私与审计

### 6.1 凭据存储与展示

- 复用 Electron `safeStorage` 通过操作系统安全能力加密所有 MCP Secret；安全存储不可用时禁止保存包含敏感值的服务，并给出可操作提示。
- 普通 SQLite 配置仅存非敏感元数据、凭据是否已配置、加密 Secret 的引用 ID、更新时间和 OAuth 过期时间；不保存明文。
- Secret 引用按 `mcp:<serverId>:<kind>` 隔离（例如 `access-token`、`refresh-token`、`env:API_KEY`）。不同 Server 绝不共享 token。
- IPC `config:get`、Redux 状态、导出日志和错误对象只返回 `secretPresent` / `credentialStatus`，不得返回密文、明文或可恢复的 token 长度。
- 复制诊断信息前必须执行敏感字段与常见 token 格式脱敏；Chat 工具卡片、Agent 日志、崩溃报告同样适用。

### 6.2 网络与本地进程边界

- HTTP endpoint 校验、DNS 解析与实际连接均须阻止协议降级及 DNS rebinding；连接前后均校验目标 IP 是否违反 §4.3.3 的网络边界。
- 禁止自动跟随跨 origin 重定向。若服务返回 3xx，视为连接失败并要求用户改为配置最终 endpoint。
- `stdio` 使用 `spawn(command, args, { shell: false })` 或语义等价实现；不拼接 shell 命令，不执行未配置的二进制。
- `stdio` stdout 只接受有效 MCP JSON-RPC 行；非协议 stdout 计为协议错误。stderr 仅作为有限、脱敏的诊断信息。
- `stdio` 环境从受控最小继承集构建；最小集必须保留目标平台启动进程所需变量（至少 `PATH`；Windows 还包括 `SystemRoot`、`ComSpec`、`PATHEXT` 等必要项，且按 Windows 环境变量大小写规则去重）。所有用户配置的环境变量值均作为 Secret，只注入该服务子进程；不把应用 API Key、数据库路径或其他服务的凭据注入子进程。

### 6.3 工具调用防护

- MCP 连接、工具描述、schema、调用参数和返回内容一律视为不可信外部输入，须在主进程验证类型、大小、深度与字符编码。
- MCP 工具输出只作为模型可见的工具结果，不能触发 IPC、文件写入、浏览器导航、Shell 命令或二次工具调用；模型若要继续操作，必须显式发起并通过相应确认。
- 任何 MCP 调用都不可读取 SpaceAssistant 的安全存储、聊天数据库或工作目录，除非模型将允许发送的内容作为该次参数明确传入，且用户按策略确认。
- Agent 不能通过工具参数新增/修改 MCP 配置、token、环境变量、endpoint 或权限；这些操作仅允许设置 UI 和受校验 IPC。
- 全局停止按钮必须中止所有该请求下的 MCP 调用及后续工具循环。

### 6.4 审计与保留

- 聊天历史持久化 MCP 工具调用的服务显示名、映射工具名、原始工具名、状态、时间、脱敏参数摘要、脱敏结果摘要、耗时和错误码。
- 审计记录中需有稳定 `serverId`，供服务改名后追溯；删除配置不会修改历史记录。
- 不持久化完整敏感参数或完整大结果；保存内容上限复用现有工具结果限制，超限内容以哈希、字节数与截断标记替代。
- 设置页「最近错误」最多保存每服务 20 条、保留 30 天；用户可一键清除诊断记录，清除不影响聊天历史。

---

## 7. 数据模型与持久化

### 7.1 共享类型（建议）

在独立 `src/shared/mcpTypes.ts` 定义以下**可读、非敏感**类型。该文件中不得出现 token、环境变量值、OAuth code、密文或可恢复的 Secret 长度字段。主进程写入用的仅输入类型应命名为 `Mcp*WriteInput`，只用于专用 IPC 参数校验，不得作为 `config:get`、`mcp:list`、Redux 或组件 props 的返回类型。

```ts
export type McpTransportType = 'stdio' | 'streamable-http'
export type McpAuthMode = 'none' | 'bearer-token' | 'custom-header' | 'oauth'
export type McpConnectionStatus =
  | 'untested'
  | 'connecting'
  | 'auth-required'
  | 'auth-expired'
  | 'connected'
  | 'failed'
  | 'no-tools'
  | 'disabled'

export interface McpServerProfile {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportType
  timeoutSec: number
  auth: {
    mode: McpAuthMode
    secretPresent: boolean
    headerName?: string
    valuePrefix?: string
    oauthClientId?: string
    oauthScopes?: string[]
    accessTokenExpiresAt?: string
  }
  stdio?: {
    command: string
    args: string[]
    cwd?: string
    /** 变量值只存在于一次性写入 payload 与主进程 Secret Store。 */
    env: Array<{ key: string; valuePresent: boolean }>
    commandTrustedAt?: string
  }
  http?: { endpoint: string }
  enabledToolNames: string[]
  toolConfirmPolicy: 'always' | 'readonly-auto'
  discoveredAt?: string
  discoveredProtocolVersion?: string
  status: McpConnectionStatus
  lastError?: { code: string; message: string; occurredAt: string }
  createdAt: string
  updatedAt: string
}

export interface McpToolDescriptor {
  serverId: string
  originalName: string
  mappedName: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  discoveredAt: string
}
```

状态与 UI 文案固定一一对应：`auth-required` 显示「待授权」，`auth-expired` 显示「认证过期」，`no-tools` 显示「工具不可用」，`disabled` 显示「已停用」。运行中的 `connecting` 不持久化；应用重启后回到 `untested`、`auth-required`、`auth-expired` 或最近一次稳定状态。

`McpServerWriteInput` 的 Secret 字段（例如 `accessToken`、`environmentValues`）只允许在 `mcp:save-profiles` 和 `mcp:test-connection` 的**请求体**出现一次。主进程完成验证后立即复制到局部变量、加密或丢弃；不得回传、写 Redux、写普通配置或用于错误文本。

### 7.2 配置键与 Secret

| 数据 | 位置 | 内容 |
|---|---|---|
| 服务元数据 | SQLite `configs` 表的 `config.mcpServers` 键 | `McpServerProfile[]`，不含任何 Secret 明文或密文。 |
| 工具缓存 | SQLite `configs` 表的 `config.mcpToolCache.<serverId>` 键 | 经校验的 `McpToolDescriptor[]`、协议版本、发现时间；删除服务时清除。 |
| 加密凭据 | SQLite `configs` 表的 `secrets.mcp.credentials` 键 + 现有安全存储封装 | 以 `<serverId>:<kind>` 为键的加密值映射，保存 access/refresh token、认证 header 值、所有 `stdio` 环境变量值；解密仅限主进程。 |
| 错误诊断 | 独立 SQLite 表或带上限配置键 | 脱敏后的有限历史。 |

`AppConfig` 不新增 MCP 字段，避免 `config:get` 成为 MCP 配置读写路径；设置页通过 `mcp:list` 获取 `McpConfig`（至少包含 `{ servers: McpServerProfile[] }`）。**MCP 配置不经过 `config:set`**：保存、测试、清除 Secret 与删除均走专用 `mcp:*` IPC。主进程必须验证每个 Secret 只可写入其所属 serverId，且 `secrets.mcp.credentials` 必须遵循与现有 `secrets.llmServiceKeys` 一致的加密读写封装。

### 7.3 迁移与兼容

- 旧版本不存在 `config.mcpServers` 时返回空数组，不阻塞应用启动。
- 所有 Server Profile 使用 UUID；不得以显示名称、endpoint 或命令作为 Secret 键。
- 删除、保存和认证更新必须以 DB 事务协调元数据与 Secret 引用；若安全存储写入失败，不得留下显示为「已配置」的半成品记录。
- 当前 `AppConfig.tools`、内置工具列表、`ToolCallRecord` 和历史消息结构保持向后兼容。必要时为 `ToolCallRecord` 增加可选 `mcp?: { serverId; serverName; originalToolName }` 元数据。

---

## 8. 主进程架构与 IPC

### 8.1 模块职责

| 模块（建议） | 职责 |
|---|---|
| `electron/mcp/mcpConfigStore.ts` | 读取、验证、迁移 Profile 与工具缓存；协调 Secret 引用。 |
| `electron/mcp/mcpSecretStore.ts` | 复用 `secureApiKey.ts` 的加密封装，按 serverId 隔离保存/读取/清除凭据。 |
| `electron/mcp/mcpConnectionManager.ts` | 连接池、initialize、认证、超时、取消、重连、空闲回收。 |
| `electron/mcp/stdioTransport.ts` | 安全启动子进程、JSON-RPC 行协议、stderr 脱敏。 |
| `electron/mcp/streamableHttpTransport.ts` | HTTP/SSE、Mcp-Session-Id、Origin/重定向/地址校验、OAuth 认证头。 |
| `electron/mcp/mcpToolRegistry.ts` | 发现、验证、缓存、映射工具名并按请求快照导出模型工具定义。 |
| `electron/mcp/mcpToolExecutor.ts` | 把模型映射调用路由到 Server，输出 `ToolExecutorResult`。 |
| `electron/mcp/mcpOauthService.ts` | metadata discovery、PKCE、浏览器回调、DCR、刷新令牌。 |

现有 `electron/toolChatLoop.ts` 负责调度与确认，不应直接包含协议细节。`getToolExecutor` / 工具注册机制应扩展为「内置 executor 优先，未命中时查询 MCP 映射注册表」，且 MCP 映射只对当前请求快照有效。

协议实现应优先使用官方 `@modelcontextprotocol/sdk` 的 Client、`StdioClientTransport`、Streamable HTTP transport 与 OAuth 辅助能力；应用仍须自行实现本需求定义的 Profile/Secret 存储、endpoint 校验、工具预算、确认策略、脱敏及 Electron 回调桥接。SDK 必须作为 `package.json` 的**直接生产依赖**并锁定经兼容性测试的版本，不能依赖 Stagehand 的传递依赖，否则打包裁剪和升级均不可控。若 SDK 缺少本需求的某项能力，技术设计需记录缺口、替代实现和安全评审结论后才能自研。

### 8.2 IPC（建议）

| Channel | 输入 | 输出 | 权限要求 |
|---|---|---|---|
| `mcp:list` | 无 | 脱敏的 Profile 列表和状态 | 渲染进程只读。 |
| `mcp:save-profiles` | Profile 草稿、一次性 Secret 写入 | 更新后的脱敏 Profile | 严格 Zod 校验，禁止未知字段。 |
| `mcp:test-connection` | 单一草稿和一次性 Secret | 脱敏测试结果、工具列表 | 不持久化，连接自动释放。 |
| `mcp:refresh-tools` | `serverId` | 新工具列表和状态 | 仅已保存服务。 |
| `mcp:oauth-start` | `serverId` | 授权进度 / 最终状态 | 仅已保存服务；仅主进程生成 state、PKCE。 |
| `mcp:clear-secret` | `serverId`、secret kind | 脱敏 Profile | 需明确用户操作。 |
| `mcp:delete-server` | `serverId` | 成功 | 由主进程删除 Secret、缓存、连接。 |
| `mcp:get-diagnostics` | `serverId` | 脱敏错误列表 | 不含请求头与 token。 |

- 在现有唯一桥接对象 `window.api`（`src/shared/api.ts` 的 `SpaceAssistantApi`）新增扁平、窄类型的 `mcpList`、`mcpSaveProfiles`、`mcpTestConnection`、`mcpRefreshTools`、`mcpOauthStart`、`mcpClearSecret`、`mcpDeleteServer`、`mcpGetDiagnostics` 方法；不得新建 `window.electronAPI`、`window.api.mcp` 命名空间或通用 IPC invoke，也不得在 `electron/preload.ts` 之外新增 `exposeInMainWorld`。
- `mcp:save-profiles` 必须是唯一的 MCP Profile/Secret 持久化通道；`config:set` 不增加 `mcp`、`mcpServers` 或 `mcpSecrets` 白名单字段。`mcp:test-connection` 和 `mcp:oauth-start` 不得顺带保存未经用户确认的 Profile 修改。
- 所有来自 renderer 的 serverId、工具名、endpoint、命令、header 和 Secret 都在主进程再次验证。
- OAuth 回调、DNS/网络连接和子进程启动只允许主进程执行。

---

## 9. 验收标准

### 9.1 功能验收

1. 用户可以新增、编辑、启用、停用、删除 `stdio` 与 Streamable HTTP 服务；刷新应用后非敏感配置、工具选择和状态正确恢复。
2. 新建服务默认停用；未成功测试、未发现工具或未保存工具白名单时，启用开关不可打开。`auth-required`、`auth-expired`、`no-tools` 与界面「待授权」「认证过期」「工具不可用」文案一一对应。
3. 配置一个可用 `stdio` Server 后，测试可显示发现工具；启用其中一个工具后，模型收到该工具定义并可在现有工具循环中成功调用。
4. 配置一个可用 Streamable HTTP Server 后，Client 可完成初始化、保存并发送 `Mcp-Session-Id`，同时正确处理 JSON 与 SSE 响应。
5. Bearer 模式在每个 HTTP 请求带 `Authorization: Bearer <token>`；endpoint、日志、聊天记录、`config:get` 与 UI 不出现 token 明文。
6. 自定义 header 模式仅发送用户配置的允许头和值；受控头、query token、带凭据 URL 均被保存和测试校验拒绝。
7. OAuth Server 的连接账户流程使用浏览器授权、PKCE 和 state 校验；只能对已保存服务启动。取消授权或授权失败不保存 token；DCR、内置预设、手工 Client ID 按 §4.4 的顺序解析且预设必须精确匹配；refresh token 可安全刷新；认证失效后服务停止向模型暴露工具并引导重新授权。
8. 未手动启用的发现工具、后来新增的服务端工具、被禁用服务的工具均不会出现在模型 API `tools` 参数中。超过 64 个 / 96 KiB MCP 预算时，模型工具集合和设置页「未注入」项均遵循 §5.1 的确定性排序。
9. 默认策略下每次 MCP 调用显示确认卡片。用户拒绝、确认超时、停止会话均不会执行该调用，并有可理解的卡片和模型错误结果。
10. 用户显式开启「只读工具可自动调用」后，只有同时满足白名单与安全 annotations 的工具可免确认；其他工具仍确认。
11. MCP 工具在飞书、微信远程会话中不被注入，且模型伪造映射名不能绕过该限制。
12. 调用完成、失败、取消后，聊天历史可正确还原 MCP 来源、状态和脱敏摘要；不破坏已有内置工具卡片。

### 9.2 安全验收

1. 安全存储不可用时，任何包含 Secret 的保存操作失败且不写入半成品 metadata；无认证服务仍可保存。
2. `stdio` 命令不经 Shell 解释。包含 shell 元字符的「整段命令」不能借由参数、工作目录或环境变量绕过直接启动限制。
3. `stdio` 的命令、参数、工作目录中不能保存 token；常见 token 和敏感参数模式被拒绝，用户只能通过加密环境变量配置凭据。
4. HTTPS endpoint 发生跨 origin 重定向、DNS 解析到受禁 IP、URL 含 query/fragment/userinfo 时，测试和运行时均被拒绝且不发送 token。
5. token、refresh token、环境变量值、认证头、OAuth authorization code 在应用日志、异常对象、IPC 响应、数据库配置、工具参数摘要和 UI 截图文本中均被掩码。
6. 服务端返回超大/畸形 schema、非 JSON-RPC stdout、无效 UTF-8、深层 JSON、超大工具结果时，应用安全报错、不崩溃、不阻塞其他聊天。
7. 取消非幂等 `tools/call` 时不重试；网络重连不会重复执行已经发出的工具调用。
8. `McpServerProfile` / `mcp:list` / `config:get` / Redux 数据中不存在环境变量值字段；保存、测试的写入 payload 在主进程完成后不可由任何返回值、错误对象或诊断记录恢复。
9. `config:set` 不能写入任何 MCP 配置或 Secret；仅 `mcp:save-profiles` 能持久化 MCP Profile/Secret。删除服务后，其 `config.mcpToolCache.<serverId>` 与 `secrets.mcp.*` 引用均不可再读取。

### 9.3 测试要求

- 为 Profile schema、endpoint 校验、Secret 引用隔离、映射工具名稳定性、工具过滤、64 个 / 96 KiB 注入预算、风险策略和脱敏规则添加共享层单元测试。
- 为 `stdio` 正常连接、异常 stdout、退出、取消、所有环境变量值掩码以及 Windows 必需继承环境添加主进程测试夹具。
- 为 Streamable HTTP JSON、SSE、session ID、401/OAuth 发现、DCR/预设/手工 Client ID 选择、超时、重定向和 DNS 防护添加 mock server 集成测试。
- 为设置页新增、编辑、清除 token、测试、OAuth 必须先保存、授权状态、工具选择和删除添加 React 测试；所有新可见文案加入中英文 i18n。
- 为 `src/shared/api.ts`、`electron/preload.ts` 与 renderer mock 添加契约测试，确保 MCP API 只从既有 `window.api` 暴露，且不新增通用 IPC 或第二桥接全局对象。
- 运行相关聚焦 Vitest 测试、`npm test`、`npm run typecheck:renderer`、`npm run typecheck:shared` 和 `npm run i18n:check`。

---

## 10. 分期与待确认事项

### 10.1 建议实施顺序

| 阶段 | 交付内容 |
|---|---|
| P0-A | 共享类型、配置/Secret 存储、`stdio` 连接、工具发现/映射、设置基本卡片与手工 token。 |
| P0-B | MCP executor 接入工具循环、确认卡片、工具历史、取消、诊断、HTTP Streamable transport。 |
| P0-C | OAuth 2.1（metadata、PKCE、DCR、精确匹配的 Client 预设/手工 Client ID 兜底、刷新 token）、安全回归与全量验收。 |
| P1 | Resources/Prompts、旧 HTTP+SSE 兼容评估、远程 IM 的细粒度授权、服务配置导入导出。 |

### 10.2 已决策事项

1. **已决定：P0 固定实现，不暴露高级设置。** 每服务最多 4 个并发调用、应用全局最多 8 个、调用默认超时 60 秒、连接/初始化超时 15 秒。参数调整通过后续版本的技术评估和产品变更进入，避免初版设置复杂度与误配置风险。
2. **已决定：P0 支持 OAuth Client 预设目录。** 规则、匹配条件和手工 Client ID 兜底见 §4.4.1；首批目录内容由后续技术设计和服务商接入清单确定。

---

**变更记录：**

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.2 | 2026-08-28 | §4.3.2 补充 Windows 平台限制说明：`shell:false` 下 `.cmd`/`.bat` 垫片（含 `npx`）在命令解析阶段显性拒绝并给出可读引导；体验补偿列入 P1。与开发计划 v1.1 §8 第 4 条决策对齐。 |
| 1.1 | 2026-08-28 | 采纳 v1 评审：统一 `window.api` 桥接与专用 MCP 保存 IPC；移除共享 Profile 中的环境变量值；新服务默认停用并统一授权状态。进一步收紧 `stdio` 环境变量、OAuth 草稿处理和工具上下文预算；明确官方 SDK 为直接依赖。确认固定并发/超时配置与 OAuth Client 预设目录；明确产品定位为个人用户，不纳入企业内网 MCP 能力。 |
| 1.0 | 2026-08-28 | 首次定义 MCP Client 工具接入、设置入口、主流 access token/OAuth 配置、安全边界、架构与验收要求。 |
