# MCP SSE Transport 接入开发计划

> 目标：为 MCP 支持补齐旧版 **MCP over SSE**（HTTP+SSE，protocol `2024-11-05`）传输，使 SpaceAssistant 可以接入以知乎热榜（`https://developer.zhihu.com/api/mcp/hot_list/v1/sse`）为代表的 legacy SSE MCP 服务。
>
> 基线：`.worktrees/mcp-integration` 当前实现，`@modelcontextprotocol/sdk` 版本 **1.30.0**。

---

## 1. 背景与差距分析

### 1.1 现有实现

- 传输类型：`McpTransportType = 'stdio' | 'streamable-http'`（`src/shared/mcpTypes.ts:28`），zod schema 同步约束（`mcpTypes.ts:259`）。
- 连接入口：`electron/mcp/mcpConnectionManager.ts` 的 `createSession()`（约 182–228 行）按 `profile.transport` 二选一创建 transport，随后统一包一层 `VersionTrackingTransport` 交给 SDK `Client.connect()`。
- HTTP 安全封装：`electron/mcp/streamableHttpTransport.ts` 已实现 endpoint 校验、DNS 解析后 IP 校验（防 DNS rebinding）、禁跨 origin 重定向、鉴权头注入。
- 鉴权：`McpAuthMode = 'none' | 'bearer-token' | 'custom-header' | 'oauth'`，secret 经 safeStorage 加密存于 `mcpSecretStore.ts`，连接时由 `secretProvider` 按需取出组装 header（`mcpConnectionManager.ts:210-218`）。
- 工具链路：`mcpToolRegistry.ts` / `mcpToolExecutor.ts` / `mcpIpc.ts` 与 transport 无关，无需改动。

### 1.2 差距

知乎热榜服务使用 legacy SSE 协议：客户端 GET `sse` 端点 → 服务端通过 `endpoint` 事件下发带 `sessionId` 的 message URL → 后续 `initialize` / `tools/list` / `tools/call` 走 POST，响应从 SSE 通道异步返回。这与 Streamable HTTP（单端点、POST 直接收响应）不兼容，当前连接会失败。

### 1.3 关键事实（已核实）

SDK 1.30.0 自带 `SSEClientTransport`（`@modelcontextprotocol/sdk/client/sse.js`，已标记 `@deprecated` 但完整可用），其 `SSEClientTransportOptions` 提供三个注入点：

| 选项 | 用途 |
| :- | :- |
| `eventSourceInit?: EventSourceInit` | 定制初始 SSE GET 连接（来自 `eventsource` 包，其 `fetch` 字段可携带自定义 header） |
| `requestInit?: RequestInit` | 定制后续 POST 请求（可放 `Authorization` 等 header） |
| `fetch?: FetchLike` | 替换全部网络请求的 fetch 实现（用于套 endpointPolicy） |

注意点：`eventSourceInit` 一旦设置，SDK 不再自动附加 `authProvider` 的 `Authorization` 头，需手动注入。`SSEClientTransport` 实现了 `setProtocolVersion()`，因此现有 `VersionTrackingTransport` 的协议版本追踪对 SSE 同样生效。

---

## 2. 总体设计

复用现有架构，新增第三种 transport `'sse'`，改动分四层：

```
src/shared/mcpTypes.ts          → 类型与 schema 扩展
electron/mcp/sseTransport.ts    → 新增：安全封装 SSEClientTransport
electron/mcp/mcpConnectionManager.ts → createSession() 增加 'sse' 分支
src/renderer/components/Config/ → 表单/卡片支持选择 SSE + i18n
```

设计约束（与现有 streamable-http 保持一致）：

- endpoint 仅允许 `https:`（loopback 允许 `http:`），复用 `validateMcpEndpoint()`。
- 连接前 DNS 解析校验目标 IP，拒绝私网/保留地址。
- 所有请求（SSE GET + message POST）走同一个 policy fetch：禁跨 origin、3xx 视为失败。
- 鉴权完全复用现有 `auth.mode` 体系，SSE 服务配置 `bearer-token` 即可覆盖知乎的 `Authorization: Bearer <secret>`。
- token 不进日志，诊断事件沿用 `http-diagnostic` 风格（新增 `sse-diagnostic` code）。

---

## 3. 详细任务分解

### Task 1：共享类型扩展（`src/shared/mcpTypes.ts`）

1. `McpTransportType` 改为 `'stdio' | 'streamable-http' | 'sse'`。
2. `McpServerProfile` 与 `McpServerWriteInput` 的 `http?: { endpoint: string }` 语义复用——SSE 服务同样只有一个 URL（sse 端点），message URL 由服务端 `endpoint` 事件下发，无需新增字段。**决策：SSE 复用 `http` 字段，不新增 `sse` 字段**，避免配置结构膨胀。
3. 两处 zod schema（`McpServerProfileSchema`、`McpServerWriteInputSchema` 约 254、339 行）：
   - `transport` enum 加 `'sse'`；
   - superRefine 校验改为 `(transport === 'streamable-http' || transport === 'sse') && !http` 时报错。
4. 更新 `src/shared/mcpTypes.test.ts`：新增 sse profile 的 parse 正例、缺 `http` 的反例。

**验收**：`npm test -- src/shared/mcpTypes.test.ts` 通过。

### Task 2：SSE transport 安全封装（新建 `electron/mcp/sseTransport.ts`）

仿照 `streamableHttpTransport.ts` 结构：

```ts
export type McpSseTransportOptions = {
  endpoint: string
  authHeaders?: Record<string, string>
  onDiagnostic?: (line: string) => void
}

export async function createSseTransport(
  options: McpSseTransportOptions
): Promise<SSEClientTransport>
```

实现要点：

1. `validateMcpEndpoint(options.endpoint)` 校验 URL（复用现有错误类型 `McpEndpointValidationError`，可从 `streamableHttpTransport.ts` 移到 `endpointPolicy.ts` 或直接从本文件导出复用——倾向后者，保持 diff 最小）。
2. 非 loopback 域名执行 `dns.lookup` + `assertEndpointIpAllowed`（可把 `streamableHttpTransport.ts` 中的 `assertResolvedIpsAllowed` 提取为两文件共用的内部 helper，或复制一份；**推荐提取到 `endpointPolicy.ts`**，避免两份漂移）。
3. 构造 policy fetch（逻辑与 streamable-http 版相同：同 origin 检查 + `redirect: 'manual'` + 3xx 拒绝），作为 `SSEClientTransportOptions.fetch` 传入，覆盖 POST 请求。
4. 鉴权头注入：
   - POST 侧：`requestInit: { headers: authHeaders }`。
   - SSE GET 侧：`eventSourceInit.fetch` 包装一层，在请求 init 中合并 `authHeaders`（`eventsource` 包的 `EventSourceInit.fetch` 签名兼容）；同时走第 3 步的 policy fetch。
   - 不传入 `authProvider`（OAuth 流程本期不支持 SSE，见 §5）。
5. 鉴权 header 名校验：`validateMcpHeaderName()` 过滤非法头名，命中 `CONTROLLED_HEADERS` 之外的自定义头按现有规则放行/拒绝。

新增 `electron/mcp/sseTransport.test.ts`：

- endpoint 非法（非 https 公网、私网 IP、解析失败）→ 抛 `McpEndpointValidationError`。
- policy fetch：跨 origin / 3xx → 拒绝。
- `requestInit.headers` 正确携带 Bearer token；`eventSourceInit.fetch` 注入的 header 不泄漏进 diagnostic 文本。

**验收**：`npm test -- electron/mcp/sseTransport.test.ts` 通过。

### Task 3：连接管理器接入（`electron/mcp/mcpConnectionManager.ts`）

1. `createSession()` 在 `streamable-http` 分支后新增：

```ts
} else if (profile.transport === 'sse') {
  if (!profile.http) throw new Error('SSE 服务缺少 endpoint 配置')
  const authHeaders = ... // 与 streamable-http 分支相同的组装逻辑
  rawTransport = await createSseTransport({
    endpoint: profile.http.endpoint,
    authHeaders,
    onDiagnostic: (line) => {
      void this.appendDiagnostic?.(profile.id, { code: 'sse-diagnostic', message: line })
    }
  })
}
```

2. auth header 组装逻辑（210–218 行）与 streamable-http 完全一致，提取为私有方法 `buildAuthHeaders(profile, secretProvider)` 供两个分支调用。
3. 其余链路（`VersionTrackingTransport` 包装、`Client.connect`、超时、onclose 状态回写、`testMcpConnection` 连通性测试）天然兼容，不改。

扩展 `mcpConnectionManager.test.ts`：用 mock SSE 服务（或 mock `createSseTransport`）验证 sse profile 能走到 connect，缺 `http.endpoint` 报中文错误，诊断 code 为 `sse-diagnostic`。

**验收**：`npm test -- electron/mcp/mcpConnectionManager.test.ts` 通过。

### Task 4：设置 UI 与 i18n

1. `src/renderer/components/Config/McpServerForm.tsx`：
   - transport Radio 组增加 `<Radio value="sse">{t('transport.sse')}</Radio>`；
   - 切换逻辑：`sse` 与 `streamable-http` 一样清掉 `stdio`、保留/初始化 `http.endpoint`（现有 92–94 行的三元表达式改为按是否 stdio 二分）；
   - endpoint 输入框渲染条件 `draft.transport === 'streamable-http'` 处同步放宽到 `'sse'`（搜索全文件 `streamable-http` 字样逐个核对）。
2. `src/renderer/components/Config/McpServerCard.tsx`：transport 展示标签支持 sse。
3. `src/renderer/components/Config/mcpDrafts.ts`：draft 初始化/序列化逻辑如有 transport 分支判断，同步处理。
4. i18n：
   - `src/renderer/i18n/resources/zh-CN/mcp.json` 增加 `transport.sse: "SSE（旧版）"`（zh-CN 是 key 真实来源）；
   - `en-US/mcp.json` 对应英文 `"SSE (legacy)"`；
   - 运行 `npm run i18n:generate-types && npm run i18n:check`。
5. 更新 `McpSettingsTab.test.tsx` / `mcpDrafts.test.ts` 相关断言。

**验收**：`npm run i18n:check` 与相关渲染层测试通过。

### Task 5：端到端验证（手动 + 集成）

1. `npm run build:electron` 通过（`tsconfig.electron.json` 编译无错）。
2. 全量 `npm test` 无回归。
3. 手动验证（需要知乎 access secret）：
   - 设置页新增 MCP 服务：transport 选 SSE，endpoint 填 `https://developer.zhihu.com/api/mcp/hot_list/v1/sse`，auth 选 Bearer token 填入 secret；
   - 「测试连接」→ 状态 `connected`，发现工具 `hot_list`；
   - 在聊天中触发工具调用，确认 text/XML 结果原样返回给模型；
   - 断网/错 token 场景：状态与诊断信息正确（`failed` / 401 类错误，不泄漏 token）。
4. 无真实 secret 时的替代：本地起一个 mock SSE MCP server（SDK 的 `SseServerTransport` 已废弃但仍可用，或裸 express 实现 endpoint/message 双端点）做集成测试脚本，放 `scripts/` 下一次性使用，不进测试套件。

---

## 4. 改动文件清单

| 文件 | 动作 |
| :- | :- |
| `src/shared/mcpTypes.ts` | 修改：transport enum、schema |
| `src/shared/mcpTypes.test.ts` | 修改：新增 sse 用例 |
| `electron/mcp/sseTransport.ts` | **新增** |
| `electron/mcp/sseTransport.test.ts` | **新增** |
| `electron/mcp/endpointPolicy.ts` | 修改：提取共用 DNS 校验 helper（可选） |
| `electron/mcp/mcpConnectionManager.ts` | 修改：sse 分支 + auth header 提取 |
| `electron/mcp/mcpConnectionManager.test.ts` | 修改 |
| `src/renderer/components/Config/McpServerForm.tsx` | 修改：Radio + 切换逻辑 |
| `src/renderer/components/Config/McpServerCard.tsx` | 修改：标签展示 |
| `src/renderer/components/Config/mcpDrafts.ts` 及测试 | 按需修改 |
| `src/renderer/i18n/resources/zh-CN/mcp.json` / `en-US/mcp.json` | 修改：新增 key |
| `src/renderer/i18n/types.ts` | 由 `i18n:generate-types` 重新生成 |

---

## 5. 范围外（本期不做）

- **SSE + OAuth**：`SSEClientTransport` 支持 `authProvider`，但与 `eventSourceInit` 并存时需手动补 `Authorization` 头，且 legacy SSE 的 OAuth 发现流程与新协议有差异。知乎场景用 Bearer token 已够，OAuth 模式在 UI 上对 sse transport 置灰或隐藏（Task 4 中处理）。
- **自动协议回退**（streamable-http 失败后自动尝试 SSE）：增加复杂度，暂不做；让用户显式选择。
- resources / prompts 能力：知乎服务明确不提供，现有链路也只消费 tools。

## 6. 风险与注意点

1. **`SSEClientTransport` 已标记 deprecated**：SDK 未来大版本可能移除。封装集中在 `sseTransport.ts` 一个文件，届时升级成本可控；package.json 中 SDK 版本升级时需回归 sse 用例。
2. **`eventSourceInit` 与 `authProvider` 互斥**：设置 `eventSourceInit` 后 SDK 不再自动附加 auth 头，必须确保我们的包装 fetch 在所有路径（含重连）都注入 header——`eventsource` 的重连也走同一个 `fetch`，需在测试中覆盖。
3. **message URL 为相对路径**：知乎返回 `/api/mcp/hot_list/v1/message?sessionId=xxx`，SDK 内部会基于 sse URL 解析为绝对地址；policy fetch 的同 origin 检查因此天然兼容，但要用真实相对路径响应做一遍集成验证（Task 5.4）。
4. **长连接生命周期**：SSE 是常驻连接，`onclose` 触发后的状态回写沿用现有逻辑；需确认断线后 UI 状态为 `failed` 而非卡在 `connecting`。
5. **安全策略一致性**：SSE 与 streamable-http 共用 endpointPolicy 全套校验，禁止为图省事跳过 DNS 检查（DNS rebinding 风险相同）。

## 7. 工作量预估

| 任务 | 预估 |
| :- | :- |
| Task 1 类型扩展 | 0.5h |
| Task 2 sseTransport + 测试 | 2–3h |
| Task 3 连接管理器 | 1h |
| Task 4 UI + i18n | 1–1.5h |
| Task 5 构建/回归/手动验证 | 1–2h |
| **合计** | **约 1 个工作日** |
