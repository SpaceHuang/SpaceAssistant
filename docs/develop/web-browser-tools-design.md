# Agent 网页访问工具 — 技术方案设计

**版本：** 1.1
**日期：** 2026-05-27
**关联需求：** `docs/requirement/web-browser-tools-requirement.md`
**评审依据：** `docs/review/web-browser-tools-review.md`

---

## 目录

1. [架构总览](#1-架构总览)
2. [模块设计](#2-模块设计)
3. [数据流](#3-数据流)
4. [类型与配置扩展](#4-类型与配置扩展)
5. [安全设计](#5-安全设计)
6. [与现有系统的衔接](#6-与现有系统的衔接)
7. [文件清单](#7-文件清单)

---

## 1. 架构总览

### 1.1 分层架构

```
渲染进程                        主进程
──────────                    ──────────
ConfigModal                    toolChatLoop
  BrowserSettingsTab             ├── assertSafeToolInput (browser 分支)
  ↑ config:set                   ├── shouldBlockToolInPlanMode (browser 分支)
  │                              ├── browserActionNeedsConfirmation
  │                              └── getToolExecutor('browser')
  │                                    │
  │                              browserExecutor
  │                                ├── urlSecurity.validateUrl()
  │                                ├── instructionGuards.assertSafeInstruction()
  │                                ├── browserActionPolicy (配额/Plan)
  │                                └── StagehandService
  │                                      └── Stagehand → Playwright Chromium
  │
  └── browser:detect ────────── StagehandService.detectDependencies()
```

### 1.2 核心原则

- **遵循现有 ToolExecutor 模式**：`browserExecutor` 实现 `ToolExecutor` 接口，在 `builtinExecutors.ts` 中注册
- **安全前置**：URL 校验和指令校验在调用 Stagehand SDK 之前执行
- **单例 StagehandService**：主进程全局单例，按 `sessionId` 管理 Stagehand 实例
- **配置驱动**：所有行为由 `BrowserConfig` 控制，默认全部关闭

---

## 2. 模块设计

### 2.1 新增文件

#### 2.1.1 `electron/browser/stagehandService.ts` — Stagehand 生命周期管理

**职责：** 管理 Stagehand 实例的创建、复用、关闭，注入 LLM 凭证，推理配额计数。

```typescript
// 核心类型
interface StagehandSessionState {
  spaceSessionId: string
  stagehand: Stagehand
  lastUrl?: string
  inferenceCountThisRequest: number
  lastActivityAt: number
  createdAt: number
}

// 核心方法
class StagehandService {
  /** 获取或懒创建 Stagehand 实例 */
  getOrCreate(sessionId: string, config: BrowserConfig): Promise<StagehandSessionState>

  /** 关闭并移除 */
  closeSession(sessionId: string): Promise<void>

  /** 关闭所有（应用退出时） */
  closeAll(): Promise<void>

  /** 推理配额：重置（每个 requestId 开始时调用） */
  resetInferenceCount(sessionId: string): void

  /** 推理配额：递增并检查 */
  incrementAndCheck(sessionId: string, max: number): void

  /** 空闲定时器：超时自动 close */
  scheduleIdleClose(sessionId: string, timeoutSec: number): void

  /** 依赖检测（供 browser:detect IPC） */
  detectDependencies(): Promise<DetectResult>
}
```

**设计要点：**
- Stagehand 初始化参数：`env: 'LOCAL'`，`headless` 由 config 控制，`model` 来自 `config.stagehandModel`
- **Stagehand model 回退逻辑：** `config.stagehandModel` 为空串时，从激活的 `LlmServiceProfile.model` 取值；若激活服务未配置模型名，使用 `claude-sonnet-4-6` 作为默认（Stagehand 推荐轻量模型）
- LLM 凭证注入：从 `LlmServiceProfile` 读取 apiKey/baseUrl（通过 `secureApiKey` 解密），设置到 `stagehand` 构造参数的 `apiKey`/`baseUrl`
- 空闲清理：使用 `setTimeout`，每次 `browser` 调用时重置定时器
- **空闲清理竞态防护：** `closeSession` 先清除定时器再 close；`getOrCreate` 中若发现正在关闭的实例（标记 `closing=true`），等待关闭完成后再创建新实例
- 应用退出：在 `app.on('before-quit')` 调用 `closeAll()`
- 单例导出：`export const stagehandService = new StagehandService()`

**Chromium 崩溃恢复：**
- `getOrCreate` 中 `stagehand.init()` 失败 → 标记实例为 `failed`，返回明确错误（含引导文案「请检查 Playwright Chromium 是否正确安装」）
- 执行操作时捕获 `Target closed` / `Protocol error` 等 Playwright 异常 → 标记实例为 `crashed`，自动 `close()` 清理，返回错误「浏览器实例已崩溃，请重试」
- 崩溃后同一 sessionId 下次 `getOrCreate` 会创建新实例

**LLM 错误分类（browserExecutor 层）：**
Stagehand 内部 LLM 调用（observe/extract/act）失败时，按原始错误类型归类为三类用户提示：

| 错误类别 | 匹配特征 | 用户提示 |
|---------|---------|---------|
| 配置错误 | `401` `403` `Invalid API Key` `authentication` | 「Stagehand 模型凭证无效，请在设置中检查 API Key 或切换模型」 |
| 临时网络问题 | `ECONNREFUSED` `ENOTFOUND` `timeout` `5xx` | 「Stagehand 模型服务暂时不可达，请检查网络或稍后重试」 |
| 额度不足 | `429` `quota` `billing` `rate limit` | 「Stagehand 模型调用额度不足，请检查账户配额或切换模型」 |

所有其他错误统一归类为「浏览器操作失败」，不暴露 SDK 内部堆栈。

**依赖检测返回结构：**
```typescript
interface DetectResult {
  stagehand: { installed: boolean; version?: string }
  playwright: { installed: boolean; browsers: string[] }
  node: { version: string; meetsRequirement: boolean }
  canInitialize: boolean
  errors: string[]
}
```

#### 2.1.2 `electron/browser/urlSecurity.ts` — URL 安全校验

**职责：** 在 `page.goto()` 前校验 URL，防止 SSRF、内网访问、非白名单域名。

```typescript
// 核心函数
function validateUrl(url: string, config: BrowserConfig): UrlValidationResult
function extractHostname(url: string): string | null
function isTrustedDomain(hostname: string, trustedDomains: string[]): boolean

type UrlValidationResult =
  | { valid: true; normalizedUrl: string }
  | { valid: false; error: string }
```

**校验规则（按优先级）：**
1. URL 解析（`new URL()`） — 解析失败 → 拒绝
2. 协议：仅 `https:`；若 `allowHttp: true` 则允许 `http:` — 否则拒绝
3. hostname 非空 — 否则拒绝
4. IDN/Punycode 归一化：若 hostname 含非 ASCII 字符或 `xn--` 前缀，先尝试 `new URL(url).hostname` 获取 Unicode 形式，再转 Punycode 做白名单匹配；若 hostname 与原始输入不同且均不在白名单，拒绝并提示「域名不在白名单中」
5. 禁止 IP 字面量（IPv4/IPv6），包括 localhost / 127.0.0.1 / ::1 等回环地址 — 拒绝
6. `allowedDomains` 语义：**空白名单 = 禁止所有 navigate**（安全默认）；非空时 hostname 必须在列表中 — 否则拒绝
7. `normalizedUrl` 返回去除 fragment 的 URL

**`allowedDomains` 与 `trustedDomains` 职责区分：**

| 字段 | 用途 | 空列表语义 |
|------|------|-----------|
| `allowedDomains` | navigate(open) 前置条件——不在列表中的域名一律拒绝 goto | 禁止所有（等于浏览器工具无法打开任何页面） |
| `trustedDomains` | navigate(open) 免确认条件——在列表中的域名跳过用户确认 | 所有 navigate 都需确认（等于无免确认） |

**不检查的内容（由 Playwright route 拦截补充）：**
- 页面内 JS 导航到非白名单域名（由 BrowserContext route handler 处理）

**Playwright route handler 与 urlSecurity 一致性：**
- `allowedDomains=[]` 时 route handler **同样拒绝所有导航**（abort），与 `validateUrl` 行为一致

#### 2.1.3 `electron/browser/instructionGuards.ts` — 指令安全校验

**职责：** 校验 `observe`/`extract`/`act` 的 `instruction` 参数，防止注入和滥用。

```typescript
// 常量
const INSTRUCTION_MAX_LENGTH = 1024
const FORBIDDEN_SUBSTRINGS = [
  'evaluate', 'agent(', 'page.', 'require(', 'import(', '__',
  'javascript:', 'data:', 'vbscript:'
]

// act 多步连接词（中英文，含变体）
const ACT_MULTI_STEP_PATTERNS = [
  // 中文
  '然后', '并且', '之后', '接着', '然后再', '接着就',
  '随后', '下一步', '接下来', '继而',
  // 英文
  'and then', 'after that', 'followed by',
  // 独立连接词（英文 then 需前后有空格/边界以避免误判 "furthermore" 等）
  /\bthen\s+/i,
  // 特殊字符
  ';', '&&', '||', '|'
]

// 核心函数
function assertInstructionLength(instruction: string): void
function assertNoForbiddenSubstrings(instruction: string): void
function assertAtomicAct(instruction: string): void
function assertSafeInstruction(instruction: string | undefined, action: string): void
```

**校验规则：**
- `instruction` 长度 ≤ 1024 字符
- 不含 NUL 字节
- 不含禁止子串（大小写不敏感），新增 `javascript:` `data:` `vbscript:` 防伪协议注入
- `act` 原子性：拒绝含多步连接词（见上表）；拒绝含 `;` `&&` `||` `|` 及换行符
- `then` 使用正则 `/\bthen\s+/i` 匹配，避免误判 `furthermore` `lengthen` 等含 then 子串的单词
- `extract` / `observe` 的 instruction 可为空

#### 2.1.4 `electron/browser/browserActionPolicy.ts` — Action 级策略

**职责：** 定义 action 的确认策略、Plan 只读白名单、推理配额判断。

```typescript
type BrowserAction = 'navigate' | 'observe' | 'extract' | 'act' | 'screenshot' | 'close'

// Plan 探索期允许的只读 action
const PLAN_READONLY_BROWSER_ACTIONS: readonly BrowserAction[] = [
  'observe', 'extract', 'screenshot', 'close'
]

// 需要确认的 action 判断
function browserActionNeedsConfirmation(
  action: BrowserAction,
  input: Record<string, unknown>,
  cfg: BrowserConfig
): boolean

// 是否消耗推理配额
function browserActionConsumesInference(action: BrowserAction): boolean

// Plan 只读判断
function isPlanReadonlyBrowserAction(action: string): boolean
```

**确认策略：**

| action | 条件 | 需确认 |
|--------|------|--------|
| `navigate` (mode=open) | URL ∉ trustedDomains | 是 |
| `navigate` (mode≠open) | — | 否 |
| `act` | `cfg.actRequiresConfirm === true` | 是 |
| 其他 | — | 否 |

**推理配额消费：** 仅 `observe`、`extract`、`act` 消耗配额（每次 +1）。

#### 2.1.5 `electron/tools/browserExecutor.ts` — 工具执行器

**职责：** 实现 `ToolExecutor` 接口，将 `browser` action 映射到 Stagehand/Playwright 调用。

```typescript
const browserExecutor: ToolExecutor = {
  name: 'browser',
  async execute(input, ctx): Promise<ToolExecutorResult>
}
```

**action → 实现映射（固定路径）：**

| action | 实现 | 超时 |
|--------|------|------|
| `navigate` (open) | `urlSecurity.validateUrl()` → `page.goto(url, { waitUntil })` | 90s |
| `navigate` (refresh) | `page.reload()` | 30s |
| `navigate` (back) | `page.goBack()` | 30s |
| `navigate` (forward) | `page.goForward()` | 30s |
| `observe` | `stagehand.observe(instruction, { selector? })` → 截断 | 90s |
| `extract` | `stagehand.extract(instruction, { selector? })` → 截断 | 90s |
| `act` | `instructionGuards.assertAtomicAct()` → `stagehand.act(instruction)` | 90s |
| `screenshot` | `page.screenshot({ path, fullPage })` | 30s |
| `close` | `stagehandService.closeSession()` | 10s |

**执行流程：**
1. 读取 `BrowserConfig`（从 `ctx` 或全局 config 获取）
2. 检查 `browser.enabled` → 否则返回错误
3. 校验 action 枚举值
4. 按 action 执行字段互斥校验（如 navigate+open 必须有 url）
5. 检查推理配额（`stagehandService.incrementAndCheck`）
6. 获取/创建 Stagehand 实例
7. 执行具体操作
8. 截断输出（`maxOutputChars`）
9. 更新 `lastActivityAt`，重置空闲定时器

**截图路径：** `{userDataDir}/browser-captures/{sessionId}/{timestamp}.png`

**进度通知：**
- navigate → `sendProgress('navigating', '正在打开 {url}...')`
- act → `sendProgress('acting', '{instruction 摘要}')`
- observe/extract → `sendProgress('observing'/'extracting')`

### 2.2 修改现有文件

#### 2.2.1 `src/shared/domainTypes.ts`

新增 `BrowserConfig` 接口和默认值，扩展 `AppConfig`：

```typescript
interface BrowserConfig {
  enabled: boolean                    // 默认 false
  env: 'LOCAL' | 'BROWSERBASE'       // MVP 固定 LOCAL
  allowedDomains: string[]            // 默认 []
  trustedDomains: string[]            // 默认 []
  allowHttp: boolean                  // 默认 false
  headless: boolean                   // 默认 true
  stagehandModel: string              // 默认 ''（空串 = 复用聊天模型）
  reuseActiveLlmProfile: boolean      // 默认 true
  actionTimeoutSec: number            // 默认 90
  idleTimeoutSec: number              // 默认 1800
  maxOutputChars: number              // 默认 50000
  maxInferencesPerRequest: number     // 默认 8
  navigateRequiresConfirm: boolean    // 默认 true
  actRequiresConfirm: boolean         // 默认 true
  deniedActions: string[]             // 默认 []
  allowRemoteSessions: boolean        // 默认 false
  captureSubdir: string               // 默认 'browser-captures'
}

// 扩展 AppConfig
interface AppConfig {
  // ...existing...
  browser: BrowserConfig
}
```

#### 2.2.2 `src/shared/builtinToolDefinitions.ts`

新增 `browser` 工具定义（schema 见需求 §7.2）。

#### 2.2.3 `electron/toolInputGuards.ts`

`assertSafeToolInput` 新增 `'browser'` 分支：

```typescript
case 'browser': {
  const action = input.action
  if (typeof action !== 'string' || !BROWSER_ACTIONS.includes(action)) {
    throw new Error('工具参数无效：browser 缺少有效的 action')
  }
  // 按 action 校验必填字段
  if (action === 'navigate') {
    const mode = typeof input.mode === 'string' ? input.mode : 'open'
    if (mode === 'open') {
      reqStringLen(input.url, 'url', 4096)
    }
  }
  if (action === 'extract' || action === 'act') {
    reqStringLen(input.instruction, 'instruction', 1024)
  }
  // observe 的 instruction 可选
  if (action === 'observe' && input.instruction !== undefined && input.instruction !== null) {
    optStringLen(input.instruction, 'instruction', 1024)
  }
  return
}
```

#### 2.2.4 `src/shared/planToolsFilter.ts`

将 browser 的只读 action 加入 Plan 只读工具白名单：

```typescript
// isPlanReadonlyToolName 不需要改 —— browser 作为单一工具，
// 写操作（navigate/act）的拦截在 browserActionPolicy 层完成。
// 但需要让 shouldBlockToolInPlanMode 对 'browser' 工具不直接放行或拒绝，
// 而是在 executor 内部按 action 判断。

// 方案：在 planModeAcl.ts 的 shouldBlockToolInPlanMode 中，
// 'browser' 工具不在此处拦截，由 executor 内部调用 isPlanReadonlyBrowserAction 判断。
// 这样 browser 工具在 Plan 探索期可以被注入，但写操作 action 在执行时被拒绝。
```

**设计决策：** `browser` 作为一个工具整体，在 Plan 探索期**仍然注入**（因为 `observe`/`extract` 只读）。`navigate` 和 `act` 在执行器内部被拒绝。这比在 `shouldBlockToolInPlanMode` 中一刀切阻止更合理。

对应修改 `isPlanReadonlyToolName`：
```typescript
// 新增 'browser' —— 允许注入，具体 action 由 executor 判断
export const PLAN_READONLY_TOOL_NAMES = ['read_file', 'list_directory', 'grep', 'browser'] as const
```

#### 2.2.5 `electron/toolsConfigRuntime.ts`

`filterBuiltinToolsForApi` 新增 browser 过滤逻辑：

```typescript
// 1. browser.enabled === false → 过滤掉
// 2. 远程会话 && !browser.allowRemoteSessions → 过滤掉
```

需要传入 `BrowserConfig` 和远程会话上下文。扩展函数签名或新增参数。

#### 2.2.6 `electron/toolChatLoop.ts`

新增 browser 确认逻辑：

```typescript
// 在 toolNeedsUserConfirmation 中新增
if (toolName === 'browser') {
  return browserActionNeedsConfirmation(
    inputObj.action as BrowserAction,
    inputObj,
    browserConfig
  )
}
```

browser 执行前后需要：
- **执行前**：`stagehandService.resetInferenceCount(sessionId)`（每轮 tool chat 开始时）
- **执行前**：`stagehandService.scheduleIdleClose(sessionId, idleTimeoutSec)`

推理配额重置时机：在 `runToolChatSessionInner` 的 `while(true)` 循环开始前（仅当工具列表包含 `browser` 时）。

#### 2.2.7 `electron/tools/builtinExecutors.ts`

注册 `browserExecutor`：

```typescript
import { browserExecutor } from './browserExecutor'

const registry = new Map<string, ToolExecutor>([
  // ...existing...
  [browserExecutor.name, browserExecutor]
])
```

### 2.3 设置界面

#### `src/renderer/components/Config/BrowserSettingsTab.tsx`

- 依赖检测区域：调用 `browser:detect` IPC，展示 Stagehand/Playwright/Node 状态
- 安装引导：检测失败时提供 npm 命令复制
- 总开关：`browser.enabled`
- Stagehand 模型选择：下拉或输入
- 域名白名单/可信域名：Tag 输入（Ant Design `Select` mode="tags"）
- 安全与配额：headless 开关、超时、maxOutput、maxInferencesPerRequest
- 工具开关：在 `SkillsTab` 中新增一行 `browser` 开关

#### IPC 通道

| 通道 | 方向 | 功能 |
|------|------|------|
| `browser:detect` | 渲染→主 | 调用 `stagehandService.detectDependencies()`，返回检测结果 |

### 2.4 导航拦截（Playwright Route 硬闸）

在 Stagehand 初始化时注册全局 route handler：

```typescript
// 在 getOrCreate() 中，init() 后注册
await stagehand.context.route('**/*', (route) => {
  if (route.request().isNavigationRequest()) {
    const hostname = new URL(route.request().url()).hostname
    if (!isAllowedDomain(hostname, config.allowedDomains)) {
      return route.abort()
    }
  }
  return route.continue()
})
```

这是对 `urlSecurity.validateUrl()` 的补充防御，防止页面内 JS 导航到非白名单域名。

---

## 3. 数据流

### 3.1 完整调用链路（以 `extract` 为例）

```
1. Agent 返回 tool_use: { name: "browser", input: { action: "extract", instruction: "..." } }
2. toolChatLoop 解析 tool_use
3. assertSafeToolInput('browser', input) → 校验 action + instruction 必填
4. shouldBlockToolInPlanMode('browser', ...) → Plan 探索期不拦截（browser 在白名单）
5. toolNeedsUserConfirmation → browserActionNeedsConfirmation → extract=false
6. getToolExecutor('browser').execute(input, ctx)
  6.1 检查 browser.enabled
  6.2 stagehandService.incrementAndCheck(sessionId, maxInferences)
  6.3 stagehandService.getOrCreate(sessionId, config) → new Stagehand() + init()
  6.4 stagehand.extract(instruction, { selector? })
  6.5 截断 extraction 到 maxOutputChars
  6.6 返回 { success: true, data: { extraction: "..." } }
7. toolChatLoop 将结果发回 API
```

### 3.2 确认流（以 `act` 为例）

```
3. assertSafeToolInput('browser', ...) → 通过
4. shouldBlockToolInPlanMode('browser', ...) → Plan 探索期不拦截
5. toolNeedsUserConfirmation → browserActionNeedsConfirmation → act=true
6. sender.send('tool:confirm-request', { toolName: 'browser', input: { action: 'act', instruction: '...' }, riskLevel: 'medium' })
7. 用户点击「批准」
8. waitForToolConfirm 返回 'approved'
9. browserExecutor.execute(...) → stagehand.act(instruction)
```

### 3.3 Plan 探索期拒绝写操作

```
4. shouldBlockToolInPlanMode('browser', ...) → 不拦截（browser 在白名单）
5. 无需确认
6. browserExecutor.execute(...)
  6.1 isPlanReadonlyBrowserAction('navigate') → false
  6.2 返回 { success: false, error: 'Plan 探索期不允许使用 browser navigate。请先完成计划。' }
```

---

## 4. 类型与配置扩展

### 4.1 BrowserConfig 默认值

```typescript
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: false,
  env: 'LOCAL',
  allowedDomains: [],
  trustedDomains: [],
  allowHttp: false,
  headless: true,
  stagehandModel: '',
  reuseActiveLlmProfile: true,
  actionTimeoutSec: 90,
  idleTimeoutSec: 1800,
  maxOutputChars: 50000,
  maxInferencesPerRequest: 8,
  navigateRequiresConfirm: true,
  actRequiresConfirm: true,
  deniedActions: [],
  allowRemoteSessions: false,
  captureSubdir: 'browser-captures'
}
```

### 4.2 工具结果类型

```typescript
// observe 结果
interface ObserveResult {
  actions: Array<{ description: string; method?: string; selector?: string }>
}

// extract 结果
interface ExtractResult {
  extraction: string
}

// screenshot 结果
interface ScreenshotResult {
  path: string
  width: number
  height: number
}

// navigate 结果
interface NavigateResult {
  url: string
  title?: string
}
```

---

## 5. 安全设计

### 5.1 多层防护

```
第一层：assertSafeToolInput     → action 枚举、必填字段、长度限制
第二层：urlSecurity.validateUrl → 协议、域名白名单、IP 字面量拒绝
第三层：instructionGuards       → 禁止子串、原子性检查
第四层：Playwright route        → 导航拦截（防止页面内跳转）
第五层：推理配额               → 限制单轮 LLM 调用次数
```

### 5.2 明确禁止的操作

- `stagehand.agent()` — 多步自主 Agent（代码中不引用）
- `page.evaluate()` — 任意 JS 执行
- 文件上传/下载（MVP）
- Browserbase 云端（MVP）
- 飞书远程会话注入 `browser`（默认 `allowRemoteSessions: false`）

### 5.3 凭据安全

- Stagehand 的 `apiKey` 通过 `secureApiKey.decrypt()` 获取，仅存在于主进程内存
- 不写入 tool result、日志、数据库
- 日志脱敏（复用 `sanitizeForLog` 机制）

### 5.4 操作审计日志

browser 工具的敏感操作（navigate、act）通过 `logAgentEvent` 记录结构化日志，便于安全审计：

```typescript
// 在 browserExecutor 中每次 navigate/act 执行后记录
logAgentEvent('info', 'browser.action', {
  requestId: ctx.requestId,
  sessionId: ctx.sessionId,
  toolUseId: ctx.toolUseId,
  action: input.action,         // 'navigate' | 'act'
  url: action === 'navigate' ? input.url : undefined,
  instruction: action === 'act' ? input.instruction : undefined,
  result: execResult.success ? 'success' : 'failure',
  durationMs
})
```

- `observe`/`extract`/`screenshot` 等只读操作不强制记录（避免日志膨胀），但可通过 `logAgentEvent` 的 `tool.result` 事件追溯
- 日志不包含 API Key、Cookie、完整 DOM 内容
- 复用现有 `agentLogger` 机制，写入 `{userData}/logs/` 目录

---

## 6. 与现有系统的衔接

### 6.1 工具注入流程

```
filterBuiltinToolsForApi(cfg, feishu, browserConfig, remoteContext?)
  1. 基础过滤（tools.enabled, allowedTools, deniedTools）
  2. browser.enabled === false → 过滤 browser
  3. 远程会话 && !browser.allowRemoteSessions → 过滤 browser
  4. browser.deniedActions 不影响注入（仅在执行时检查）
```

### 6.2 应用退出清理

```typescript
// electron/main.ts
app.on('before-quit', async () => {
  await stagehandService.closeAll()
})
```

### 6.3 数据库

- `BrowserConfig` 序列化为 `AppConfig.browser` 字段，存储在 JSON 文件中
- 不需要新的数据库表或字段
- 迁移：旧数据无 `browser` 字段 → `mergeBrowserConfig(undefined)` → 使用默认值

---

## 7. 文件清单

### 7.1 新增文件

| 路径 | 说明 |
|------|------|
| `electron/browser/stagehandService.ts` | Stagehand 生命周期管理 |
| `electron/browser/urlSecurity.ts` | URL/SSRF 安全校验 |
| `electron/browser/instructionGuards.ts` | 指令安全校验 |
| `electron/browser/browserActionPolicy.ts` | Action 级策略（确认/Plan/配额） |
| `electron/tools/browserExecutor.ts` | 浏览器工具执行器 |
| `src/renderer/components/Config/BrowserSettingsTab.tsx` | 设置页 UI |

### 7.2 修改文件

| 路径 | 改动 |
|------|------|
| `src/shared/domainTypes.ts` | 新增 `BrowserConfig` 接口 + 默认值；扩展 `AppConfig` |
| `src/shared/builtinToolDefinitions.ts` | 新增 `browser` 工具定义 |
| `src/shared/planToolsFilter.ts` | `PLAN_READONLY_TOOL_NAMES` 新增 `'browser'` |
| `electron/toolInputGuards.ts` | `assertSafeToolInput` 新增 `'browser'` 分支 |
| `electron/toolsConfigRuntime.ts` | `filterBuiltinToolsForApi` 新增 browser 过滤 |
| `electron/toolChatLoop.ts` | 新增 browser 确认逻辑 + 推理配额重置 |
| `electron/tools/builtinExecutors.ts` | 注册 `browserExecutor` |
| `electron/appIpc.ts` | 新增 `browser:detect` IPC handler |
| `electron/preload.ts` | 新增 `browser:detect` IPC 通道 |
| `src/shared/api.ts` | 新增 `browser:detect` API 类型 |
| `src/renderer/components/Config/ConfigModal.tsx` | 新增「浏览器」Tab |
| `src/renderer/components/Config/SkillsTab.tsx` | 新增 `browser` 工具开关行 |
| `electron/main.ts` | `before-quit` 清理 Stagehand 实例 |
| `package.json` | 新增 `@browserbasehq/stagehand` `playwright` `zod` 依赖 |

### 7.3 测试文件

| 路径 | 说明 |
|------|------|
| `electron/browser/urlSecurity.test.ts` | URL 校验单测 |
| `electron/browser/instructionGuards.test.ts` | 指令校验单测 |
| `electron/browser/browserActionPolicy.test.ts` | Action 策略单测 |
| `electron/browser/stagehandService.test.ts` | StagehandService 单测 |
| `electron/tools/browserExecutor.test.ts` | browserExecutor 单测 |
| `electron/toolInputGuards.test.ts` | 新增 browser 入参校验用例 |

---

**文档版本:** v1.1
**创建日期:** 2026-05-27
**修订记录:** v1.1 — 根据评审意见补充：localhost/回环地址拦截、IDN/Punycode 归一化、allowedDomains/trustedDomains 职责明确、空白名单=禁止所有、act 连接词扩展、Chromium 崩溃恢复、审计日志、LLM 错误分类、空闲清理竞态防护
