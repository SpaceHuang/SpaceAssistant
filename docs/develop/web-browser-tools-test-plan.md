# Agent 网页访问工具 — 单元测试方案

**版本：** 1.1
**日期：** 2026-05-27
**关联设计：** `docs/develop/web-browser-tools-design.md`
**评审依据：** `docs/review/web-browser-tools-review.md`

---

## 目录

1. [测试范围](#1-测试范围)
2. [测试文件与组织](#2-测试文件与组织)
3. [urlSecurity 测试用例](#3-urlsecurity-测试用例)
4. [instructionGuards 测试用例](#4-instructionguards-测试用例)
5. [browserActionPolicy 测试用例](#5-browseractionpolicy-测试用例)
6. [stagehandService 测试用例](#6-stagehandservice-测试用例)
7. [browserExecutor 测试用例](#7-browserexecutor-测试用例)
8. [toolInputGuards (browser 分支) 测试用例](#8-toolinputguards-browser-分支-测试用例)
9. [Plan 模式集成测试用例](#9-plan-模式集成测试用例)

---

## 1. 测试范围

### 1.1 测试原则

- **纯函数优先**：`urlSecurity`、`instructionGuards`、`browserActionPolicy` 为纯函数，直接单测
- **有副作用隔离**：`StagehandService`、`browserExecutor` 使用 mock 隔离 Stagehand SDK 和 Playwright
- **遵循现有约定**：测试文件就近放置，使用 Vitest + `describe`/`it`/`expect`
- **不测试 UI**：设置页 UI 不在本次单元测试范围（通过手动验收）

### 1.2 不测试的内容

- Stagehand SDK 内部行为（第三方库）
- Playwright Chromium 实际启动（集成/验收测试范围）
- 设置页渲染（组件测试，本次不覆盖）
- IPC 通道通信（端到端测试范围）
- `filterBuiltinToolsForApi` 的 browser 过滤（逻辑简单，由现有测试模式覆盖）

---

## 2. 测试文件与组织

| 文件 | 测试内容 | 环境 |
|------|---------|------|
| `electron/browser/urlSecurity.test.ts` | URL 校验纯函数 | node |
| `electron/browser/instructionGuards.test.ts` | 指令校验纯函数 | node |
| `electron/browser/browserActionPolicy.test.ts` | Action 策略纯函数 | node |
| `electron/browser/stagehandService.test.ts` | StagehandService 生命周期（mock SDK） | node |
| `electron/tools/browserExecutor.test.ts` | browserExecutor（mock StagehandService） | node |
| `electron/toolInputGuards.test.ts` | 新增 browser 分支 | node |

---

## 3. urlSecurity 测试用例

**文件：** `electron/browser/urlSecurity.test.ts`
**测试对象：** `validateUrl(url, config)`、`extractHostname(url)`、`isTrustedDomain(hostname, trustedDomains)`

### 3.1 合法 URL

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | 白名单域名 HTTPS | `url="https://example.com/docs"`, `allowedDomains=["example.com"]` | `{ valid: true, normalizedUrl: "https://example.com/docs" }` |
| 2 | 白名单含子域名（精确匹配） | `url="https://docs.example.com/page"`, `allowedDomains=["docs.example.com"]` | `{ valid: true }` |
| 3 | 允许 HTTP 且 `allowHttp=true` | `url="http://example.com"`, `allowHttp=true`, `allowedDomains=["example.com"]` | `{ valid: true }` |
| 4 | URL 含 fragment 被去除 | `url="https://example.com#section"` | `normalizedUrl` 不含 `#section` |

### 3.2 非法 URL

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 5 | 非白名单域名 | `url="https://evil.com"`, `allowedDomains=["example.com"]` | `{ valid: false, error: "域名不在白名单中" }` |
| 6 | **白名单为空（空白名单=禁止所有）** | `url="https://example.com"`, `allowedDomains=[]` | `{ valid: false, error: "未配置允许的域名" }` |
| 7 | 非 HTTP(S) 协议 | `url="file:///etc/passwd"` | `{ valid: false, error: "不允许的协议" }` |
| 8 | HTTP 但 `allowHttp=false` | `url="http://example.com"`, `allowedDomains=["example.com"]` | `{ valid: false, error: "不允许 HTTP" }` |
| 9 | **localhost** | `url="https://localhost"` | `{ valid: false, error: "不允许 IP 地址或回环地址" }` |
| 10 | **127.0.0.1** | `url="https://127.0.0.1"` | `{ valid: false, error: "不允许 IP 地址或回环地址" }` |
| 11 | **::1** | `url="https://[::1]"` | `{ valid: false, error: "不允许 IP 地址或回环地址" }` |
| 12 | 内网 IP | `url="https://192.168.1.1"` | `{ valid: false, error: "不允许 IP 地址或回环地址" }` |
| 13 | 公网 IP（也是 IP 字面量） | `url="https://8.8.8.8"` | `{ valid: false, error: "不允许 IP 地址或回环地址" }` |
| 14 | 无效 URL | `url="not a url"` | `{ valid: false, error: "无效的 URL" }` |
| 15 | 空 URL | `url=""` | `{ valid: false }` |
| 16 | 无 hostname | `url="https://"` | `{ valid: false }` |
| 17 | `data:` 协议 | `url="data:text/html,<script>"` | `{ valid: false, error: "不允许的协议" }` |
| 18 | `javascript:` 伪协议 | `url="javascript:alert(1)"` | `{ valid: false, error: "无效的 URL" }` |

### 3.3 IDN/Punycode 域名

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 19 | **Punycode 域名绕过白名单** | `url="https://xn--fiqs8s.com"` (example.com), `allowedDomains=["example.com"]` | `{ valid: false }` — 拒绝非白名单域名 |
| 20 | **Punycode 域名正常匹配** | `url="https://xn--fiqs8s.com"`, `allowedDomains=["xn--fiqs8s.com"]` | `{ valid: true }` — hostname 精确匹配 Punycode 形式 |
| 21 | **Unicode 域名** | `url="https://例子.com"` | `{ valid: false, error: "域名不在白名单中" }` — 未被加入白名单则拒绝 |
| 22 | **IDN 同形异义攻击** | `url="https://аррӏе.com"` (西里尔字母), `allowedDomains=["apple.com"]` | `{ valid: false }` — hostname 不同 |

### 3.4 extractHostname

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 23 | 标准 URL | `"https://example.com/path"` | `"example.com"` |
| 24 | 无效 URL | `"not a url"` | `null` |
| 25 | 带端口 | `"https://example.com:8080/path"` | `"example.com"` |

### 3.5 isTrustedDomain

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 26 | 精确匹配 | `hostname="docs.example.com"`, `trustedDomains=["docs.example.com"]` | `true` |
| 27 | 不匹配 | `hostname="evil.com"`, `trustedDomains=["example.com"]` | `false` |
| 28 | 空列表 | `hostname="example.com"`, `trustedDomains=[]` | `false` |

### 3.3 extractHostname

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 17 | 标准 URL | `"https://example.com/path"` | `"example.com"` |
| 18 | 无效 URL | `"not a url"` | `null` |
| 19 | 带端口 | `"https://example.com:8080/path"` | `"example.com"` |

### 3.4 isTrustedDomain

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 20 | 精确匹配 | `hostname="docs.example.com"`, `trustedDomains=["docs.example.com"]` | `true` |
| 21 | 不匹配 | `hostname="evil.com"`, `trustedDomains=["example.com"]` | `false` |
| 22 | 空列表 | `hostname="example.com"`, `trustedDomains=[]` | `false` |

---

## 4. instructionGuards 测试用例

**文件：** `electron/browser/instructionGuards.test.ts`
**测试对象：** `assertSafeInstruction(instruction, action)`、`assertAtomicAct(instruction)`

### 4.1 合法指令

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | 正常 extract 指令 | `instruction="extract the main content"`, `action="extract"` | 不抛异常 |
| 2 | 正常 observe 指令 | `instruction="find all buttons"`, `action="observe"` | 不抛异常 |
| 3 | 空 observe 指令 | `instruction=undefined`, `action="observe"` | 不抛异常 |
| 4 | 空 extract 指令 | `instruction=undefined`, `action="extract"` | 不抛异常（extract 允许空？按需求必填，由 toolInputGuards 校验） |
| 5 | 单步 act 指令（英文） | `instruction="Click the Submit button"`, `action="act"` | 不抛异常 |
| 6 | 单步 act 指令（中文） | `instruction="点击提交按钮"`, `action="act"` | 不抛异常 |
| 7 | 最大长度边界 | `instruction="x".repeat(1024)`, `action="act"` | 不抛异常 |

### 4.2 非法指令

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 8 | 超长指令 | `instruction="x".repeat(1025)` | 抛异常 `"指令过长"` |
| 9 | 含 NUL 字节 | `instruction="click\0btn"` | 抛异常 `"含空字节"` |
| 10 | 含 `evaluate` | `instruction="evaluate document.cookie"` | 抛异常 `"含禁止子串"` |
| 11 | 含 `agent(` | `instruction="run agent(task)"` | 抛异常 `"含禁止子串"` |
| 12 | 含 `page.` | `instruction="page.evaluate(...)"` | 抛异常 `"含禁止子串"` |
| 13 | 含 `require(` | `instruction="require('fs')"` | 抛异常 `"含禁止子串"` |
| 14 | 含 `import(` | `instruction="import('fs')"` | 抛异常 `"含禁止子串"` |
| 15 | 大小写变体 | `instruction="Page.Evaluate"` | 抛异常（大小写不敏感） |
| 16 | **含 `javascript:`** | `instruction="use javascript:void(0)"` | 抛异常 `"含禁止子串"` |
| 17 | **含 `data:`** | `instruction="navigate to data:text/html"` | 抛异常 `"含禁止子串"` |
| 18 | **含 `vbscript:`** | `instruction="run vbscript:msgbox"` | 抛异常 `"含禁止子串"` |

### 4.3 act 原子性

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 19 | 含 `然后` | `instruction="打开页面然后点击按钮"` | 抛异常 `"act 指令须为单步操作"` |
| 20 | 含 `并且` | `instruction="click A 并且 type B"` | 抛异常 |
| 21 | 含 `之后` | `instruction="click A 之后 click B"` | 抛异常 |
| 22 | 含 `接着` | `instruction="click A 接着 click B"` | 抛异常 |
| 23 | **含 `然后再`** | `instruction="click A 然后再 click B"` | 抛异常 |
| 24 | **含 `接着就`** | `instruction="click A 接着就 click B"` | 抛异常 |
| 25 | **含 `随后`** | `instruction="click A 随后 click B"` | 抛异常 |
| 26 | **含 `下一步`** | `instruction="click A 下一步 click B"` | 抛异常 |
| 27 | **含 `接下来`** | `instruction="click A 接下来 click B"` | 抛异常 |
| 28 | **含 `继而`** | `instruction="click A 继而 click B"` | 抛异常 |
| 29 | 含 `and then` | `instruction="click A and then click B"` | 抛异常 |
| 30 | 含 `then`（单词边界） | `instruction="click A then click B"` | 抛异常 |
| 31 | 含 `after that` | `instruction="click A after that click B"` | 抛异常 |
| 32 | **含 `followed by`** | `instruction="click A followed by click B"` | 抛异常 |
| 33 | 含分号 `;` | `instruction="click A; click B"` | 抛异常 |
| 34 | **含 `&&`** | `instruction="click A && click B"` | 抛异常 |
| 35 | **含 `\|\|`** | `instruction="click A \|\| click B"` | 抛异常 |
| 36 | **含 `\|`（管道符）** | `instruction="click A \| click B"` | 抛异常 |
| 37 | 含换行符 | `instruction="click A\nclick B"` | 抛异常 |
| 38 | **`then` 在单词内部不误判** | `instruction="Click the lengthen button"` | 不抛异常 |
| 39 | 复杂但单步（允许） | `instruction="Click the blue Submit button in the top right corner of the form"` | 不抛异常 |

---

## 5. browserActionPolicy 测试用例

**文件：** `electron/browser/browserActionPolicy.test.ts`
**测试对象：** `browserActionNeedsConfirmation()`、`browserActionConsumesInference()`、`isPlanReadonlyBrowserAction()`

### 5.1 确认判断

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | `act` 需确认（默认配置） | `action="act"`, `config={ actRequiresConfirm: true }` | `true` |
| 2 | `act` 免确认（配置关闭） | `action="act"`, `config={ actRequiresConfirm: false }` | `false` |
| 3 | `navigate` open 非可信域名 | `action="navigate"`, `input={ mode: "open", url: "https://unknown.com" }`, `trustedDomains=[]` | `true` |
| 4 | `navigate` open 可信域名 | `action="navigate"`, `input={ mode: "open", url: "https://trusted.com" }`, `trustedDomains=["trusted.com"]` | `false` |
| 5 | `navigate` refresh | `action="navigate"`, `input={ mode: "refresh" }` | `false` |
| 6 | `navigate` back | `action="navigate"`, `input={ mode: "back" }` | `false` |
| 7 | `navigate` forward | `action="navigate"`, `input={ mode: "forward" }` | `false` |
| 8 | `observe` 免确认 | `action="observe"` | `false` |
| 9 | `extract` 免确认 | `action="extract"` | `false` |
| 10 | `screenshot` 免确认 | `action="screenshot"` | `false` |
| 11 | `close` 免确认 | `action="close"` | `false` |

### 5.2 推理配额消费

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 12 | `observe` 消耗推理 | `action="observe"` | `true` |
| 13 | `extract` 消耗推理 | `action="extract"` | `true` |
| 14 | `act` 消耗推理 | `action="act"` | `true` |
| 15 | `navigate` 不消耗 | `action="navigate"` | `false` |
| 16 | `screenshot` 不消耗 | `action="screenshot"` | `false` |
| 17 | `close` 不消耗 | `action="close"` | `false` |

### 5.3 Plan 只读判断

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 18 | `observe` Plan 只读 | `action="observe"` | `true` |
| 19 | `extract` Plan 只读 | `action="extract"` | `true` |
| 20 | `screenshot` Plan 只读 | `action="screenshot"` | `true` |
| 21 | `close` Plan 只读 | `action="close"` | `true` |
| 22 | `navigate` 非 Plan 只读 | `action="navigate"` | `false` |
| 23 | `act` 非 Plan 只读 | `action="act"` | `false` |

---

## 6. stagehandService 测试用例

**文件：** `electron/browser/stagehandService.test.ts`
**测试对象：** `StagehandService` 类（mock `@browserbasehq/stagehand`）

### 6.1 Mock 策略

```typescript
vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    observe: vi.fn().mockResolvedValue([{ description: 'button' }]),
    extract: vi.fn().mockResolvedValue({ extraction: 'content' }),
    act: vi.fn().mockResolvedValue({ success: true }),
    context: {
      pages: vi.fn().mockReturnValue([{ goto: vi.fn().mockResolvedValue(undefined) }]),
      route: vi.fn()
    }
  }))
}))
```

### 6.2 生命周期

| # | 用例 | 预期 |
|---|------|------|
| 1 | `getOrCreate` 首次调用创建新实例 | `Stagehand` 构造函数被调用 1 次，`init()` 被调用 1 次 |
| 2 | `getOrCreate` 同一 sessionId 再次调用返回缓存实例 | `Stagehand` 构造函数仍为 1 次 |
| 3 | `closeSession` 关闭实例 | `stagehand.close()` 被调用，内部 Map 移除 |
| 4 | `closeAll` 关闭所有 | 所有实例的 `close()` 被调用 |
| 5 | `closeSession` 不存在的 sessionId | 不抛异常 |
| 6 | **`init()` 失败 → 标记 failed，返回错误** | `init` mock 抛异常，`getOrCreate` 返回错误（含安装引导文案），实例不在 Map 中 |
| 7 | **Chromium 崩溃后 session 状态恢复** | mock `page.goto` 抛 `Target closed` 错误，实例被标记 crashed + close，下次 `getOrCreate` 创建新实例 |

### 6.3 推理配额

| # | 用例 | 预期 |
|---|------|------|
| 8 | 配额内不抛异常 | `incrementAndCheck(sessionId, 8)` 前 8 次不抛 |
| 9 | 超配额抛异常 | 第 9 次 `incrementAndCheck(sessionId, 8)` 抛 `"推理次数已达上限"` |
| 10 | `resetInferenceCount` 后重新计数 | 重置后第 1 次不抛 |
| 11 | 不同 sessionId 独立计数 | sessionA 超配额不影响 sessionB |
| 12 | **并发 session 配额互不干扰** | 两个 sessionId 交替调用，各自计数独立 |

### 6.4 空闲清理

| # | 用例 | 预期 |
|---|------|------|
| 13 | 空闲超时自动 close | `scheduleIdleClose(sessionId, 1)` 后等待 >1s，实例被关闭 |
| 14 | 活动重置空闲定时器 | 调用 `getOrCreate` 后定时器被重置 |
| 15 | **空闲定时器触发与 getOrCreate 竞态** | 定时器触发 close 的同时另一个调用 `getOrCreate`（通过 `closing` 标记协调），最终只有一个实例存在 |

### 6.5 依赖检测

| # | 用例 | 预期 |
|---|------|------|
| 16 | 检测 Stagehand 已安装 | `detectDependencies()` 返回 `stagehand.installed: true` |
| 17 | 检测 Playwright 已安装 | `detectDependencies()` 返回 `playwright.installed: true` |
| 18 | Node 版本满足要求 | `detectDependencies()` 返回 `node.meetsRequirement: true` |
| 19 | 全部就绪 | `canInitialize: true`，`errors: []` |

---

## 7. browserExecutor 测试用例

**文件：** `electron/tools/browserExecutor.test.ts`
**测试对象：** `browserExecutor.execute(input, ctx)`

### 7.1 Mock 策略

Mock `stagehandService`（通过依赖注入或模块 mock），不启动真实浏览器。

```typescript
vi.mock('../browser/stagehandService', () => ({
  stagehandService: {
    getOrCreate: vi.fn(),
    closeSession: vi.fn(),
    resetInferenceCount: vi.fn(),
    incrementAndCheck: vi.fn()
  }
}))
```

### 7.2 执行前置校验

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | 浏览器未启用 | `config.browser.enabled = false` | `{ success: false, error: "浏览器工具未启用" }` |
| 2 | 无效 action | `input = { action: "invalid" }` | `{ success: false, error: "无效的 action" }` |
| 3 | action 在 deniedActions 中 | `config.browser.deniedActions = ["act"]`, `action = "act"` | `{ success: false, error: "act 已被禁用" }` |
| 4 | navigate open 缺 url | `input = { action: "navigate", mode: "open" }` | `{ success: false, error: "navigate open 缺少 url" }` |
| 5 | extract 缺 instruction | `input = { action: "extract" }` | `{ success: false, error: "extract 缺少 instruction" }` |
| 6 | act 缺 instruction | `input = { action: "act" }` | `{ success: false, error: "act 缺少 instruction" }` |
| 7 | 推理配额超限 | `incrementAndCheck` 抛异常 | `{ success: false, error: "推理次数已达上限" }` |

### 7.3 各 action 正常执行

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 8 | navigate open | `action="navigate"`, `mode="open"`, `url="https://example.com"` | `page.goto()` 被调用，返回 `{ success: true, data: { url, title? } }` |
| 9 | navigate refresh | `action="navigate"`, `mode="refresh"` | `page.reload()` 被调用 |
| 10 | navigate back | `action="navigate"`, `mode="back"` | `page.goBack()` 被调用 |
| 11 | navigate forward | `action="navigate"`, `mode="forward"` | `page.goForward()` 被调用 |
| 12 | observe | `action="observe"`, `instruction="find buttons"` | `stagehand.observe()` 被调用 |
| 13 | observe 无 instruction | `action="observe"` | `stagehand.observe()` 被调用（instruction 为空字符串） |
| 14 | extract | `action="extract"`, `instruction="get main content"` | `stagehand.extract()` 被调用 |
| 15 | act | `action="act"`, `instruction="Click Submit"` | `stagehand.act()` 被调用 |
| 16 | screenshot | `action="screenshot"` | `page.screenshot()` 被调用 |
| 17 | close | `action="close"` | `stagehandService.closeSession()` 被调用 |

### 7.4 输出截断

| # | 用例 | 预期 |
|---|------|------|
| 18 | extract 结果超过 `maxOutputChars` | 返回的 `extraction` 被截断到 `maxOutputChars` |
| 19 | observe 结果超过 `maxOutputChars` | 返回的 actions 列表被截断 |
| 20 | **extract 结果正好等于 `maxOutputChars`** | 不截断，完整返回 |
| 21 | **extract 结果 = `maxOutputChars + 1`** | 被截断到 `maxOutputChars` |

### 7.5 Plan 探索期

| # | 用例 | 预期 |
|---|------|------|
| 22 | Plan 探索期 `navigate` | `{ success: false, error: "Plan 探索期不允许..." }` |
| 23 | Plan 探索期 `act` | `{ success: false, error: "Plan 探索期不允许..." }` |
| 24 | Plan 探索期 `observe` | 正常执行 |
| 25 | Plan 探索期 `extract` | 正常执行 |

### 7.6 错误处理

| # | 用例 | 预期 |
|---|------|------|
| 26 | `page.goto()` 失败（网络错误） | `{ success: false, error: "打开页面失败: ..." }` |
| 27 | `stagehand.extract()` 失败 | `{ success: false, error: "提取内容失败: ..." }` |
| 28 | URL 校验失败 | `{ success: false, error: "URL 不在白名单中" }` |
| 29 | 指令校验失败（act 多步） | `{ success: false, error: "act 指令须为单步操作" }` |
| 30 | Stagehand 未初始化 | `{ success: false, error: "浏览器实例未就绪" }` |

### 7.7 LLM 错误分类

| # | 用例 | mock 错误 | 预期用户提示 |
|---|------|----------|------------|
| 31 | **API Key 无效 (401)** | `Error("401 Unauthorized")` | 含「凭证无效」「检查 API Key」 |
| 32 | **API Key 无效 (403)** | `Error("403 Forbidden")` | 含「凭证无效」「检查 API Key」 |
| 33 | **认证失败** | `Error("Invalid API Key")` | 含「凭证无效」 |
| 34 | **网络不可达** | `Error("ECONNREFUSED")` | 含「服务暂时不可达」「检查网络」 |
| 35 | **DNS 解析失败** | `Error("ENOTFOUND api.example.com")` | 含「服务暂时不可达」 |
| 36 | **超时** | `Error("timeout")` | 含「服务暂时不可达」「稍后重试」 |
| 37 | **服务端 5xx** | `Error("502 Bad Gateway")` | 含「服务暂时不可达」 |
| 38 | **额度不足 (429)** | `Error("429 Too Many Requests")` | 含「额度不足」「检查账户配额」 |
| 39 | **额度不足 (billing)** | `Error("billing quota exceeded")` | 含「额度不足」 |
| 40 | **未知错误不暴露堆栈** | `Error("Internal XYZ failure")` | 「浏览器操作失败」（不含 XYZ） |

### 7.8 边界条件

| # | 用例 | 预期 |
|---|------|------|
| 41 | **observe 无 instruction → 传空字符串** | `stagehand.observe("", ...)` 被调用（非 undefined） |
| 42 | **observe 传入 selector** | `stagehand.observe(instruction, { selector })` 被调用 |

---

## 8. toolInputGuards (browser 分支) 测试用例

**文件：** `electron/toolInputGuards.test.ts`（追加用例）

### 8.1 入参校验

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | 有效 browser navigate | `{ action: "navigate", mode: "open", url: "https://example.com" }` | 不抛异常 |
| 2 | 有效 browser extract | `{ action: "extract", instruction: "get content" }` | 不抛异常 |
| 3 | 有效 browser observe | `{ action: "observe" }` | 不抛异常 |
| 4 | 有效 browser close | `{ action: "close" }` | 不抛异常 |
| 5 | 缺少 action | `{}` | 抛异常 `"缺少有效的 action"` |
| 6 | 无效 action | `{ action: "fly" }` | 抛异常 `"缺少有效的 action"` |
| 7 | navigate open 缺 url | `{ action: "navigate", mode: "open" }` | 抛异常 `"缺少必填参数 url"` |
| 8 | extract 缺 instruction | `{ action: "extract" }` | 抛异常 `"缺少必填参数 instruction"` |
| 9 | act 缺 instruction | `{ action: "act" }` | 抛异常 `"缺少必填参数 instruction"` |
| 10 | url 过长 | `{ action: "navigate", mode: "open", url: "x".repeat(4097) }` | 抛异常 `"url 过长"` |
| 11 | instruction 过长 | `{ action: "extract", instruction: "x".repeat(1025) }` | 抛异常 `"instruction 过长"` |

---

## 9. Plan 模式集成测试用例

**文件：** `electron/plan/planModeAcl.test.ts`（追加用例）

### 9.1 Plan 探索期 browser 工具

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | Plan 探索期 browser 不被 shouldBlockToolInPlanMode 拦截 | `toolName="browser"`, `planToolPhase="planning"` | `{ blocked: false }` |
| 2 | Plan 探索期 browser 写操作在 executor 内被拦截 | 由 browserExecutor 测试覆盖 | — |

---

**文档版本:** v1.1
**创建日期:** 2026-05-27
**修订记录:** v1.1 — 根据评审意见补充：IDN/Punycode 测试、localhost/回环地址测试、act 连接词扩展测试（&& || | 管道符、中文变体）、空白名单一致性测试、Chromium 崩溃恢复测试、并发配额测试、LLM 错误分类测试、空闲竞态测试、截断边界测试、空指令默认值测试
