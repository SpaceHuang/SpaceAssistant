# 网络访问限速机制 — 需求规格

**版本：** 1.0  
**日期：** 2026-06-06  
**状态：** 待评审  
**关联文档：** [web-browser-tools-requirement.md](./web-browser-tools-requirement.md)、[browser-network-access-settings-requirement.md](./browser-network-access-settings-requirement.md)、[tools-requirement.md](./tools-requirement.md)

---

## 目录

1. [概述](#1-概述)
2. [问题分析](#2-问题分析)
3. [目标与非目标](#3-目标与非目标)
4. [限速策略设计](#4-限速策略设计)
5. [配置项设计](#5-配置项设计)
6. [设置界面设计](#6-设置界面设计)
7. [实现架构](#7-实现架构)
8. [数据模型变更](#8-数据模型变更)
9. [错误处理与用户提示](#9-错误处理与用户提示)
10. [测试计划](#10-测试计划)
11. [验收标准](#11-验收标准)
12. [相关文件](#12-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 的网络访问功能（`browser` 工具）基于 Stagehand/Playwright 实现，当前缺少请求限速机制。当 Agent 处理和分析速度较快时，可能短时间内发起大量 `navigate`、`observe`、`extract`、`act` 等操作，对目标网站形成高频冲击，触发反爬机制（如 IP 封禁、验证码、请求拒绝等）。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 友善访问 | 遵守网站访问礼仪，降低被封禁风险 |
| 稳定运行 | 避免因反爬触发导致的任务中断 |
| 用户可控 | 用户可根据场景调整限速参数 |
| 合理默认 | 默认值对大多数网站友好，无需手动配置 |

---

## 2. 问题分析

### 2.1 当前缺失

| 缺失项 | 影响 |
|--------|------|
| 无请求间隔控制 | 连续 `navigate`/`extract` 可能秒级完成，无等待 |
| 无速率上限 | 单分钟可发起数十次请求 |
| 无域名级限速 | 同一域名可能被高频访问 |
| 无请求队列 | 多请求并发执行，无排队机制 |

### 2.2 触发反爬的典型场景

| 场景 | 说明 |
|------|------|
| 批量抓取 | Agent 分析多个页面，短时间内访问多个 URL |
| 反复尝试 | 页面加载失败后快速重试 |
| 频繁交互 | `observe` + `act` 循环执行，每次触发页面请求 |
| 并发会话 | 多用户/多会话同时访问同一网站 |

### 2.3 反爬后果

| 后果 | 说明 |
|------|------|
| IP 封禁 | 短期或长期禁止访问 |
| 验证码拦截 | 需人工介入才能继续 |
| 请求拒绝 | HTTP 429 Too Many Requests |
| 内容降级 | 返回空内容或错误页面 |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 实现全局请求限速，控制每分钟/每小时请求上限 |
| G2 | 实现请求最小间隔，避免连续请求过于密集 |
| G3 | 实现域名级限速，对同一域名单独控制 |
| G4 | 提供设置界面，允许用户调整限速参数 |
| G5 | 提供合理默认值，无需用户手动配置即可友善访问 |

### 3.2 非目标

| # | 非目标 |
|---|--------|
| NG1 | 不实现复杂的自适应限速（如根据响应动态调整） |
| NG2 | 不实现分布式限速（多客户端协调） |
| NG3 | 不实现请求优先级队列 |
| NG4 | 不修改 Stagehand/Playwright 底层行为 |
| NG5 | 不限速 `close` 操作（无网络请求） |

---

## 4. 限速策略设计

### 4.1 限速层级

采用三层限速策略，从粗到细：

```
全局限速 → 域名限速 → 最小间隔
```

| 层级 | 说明 | 优先级 |
|------|------|--------|
| 全局限速 | 控制所有请求的总速率上限 | 最高（先检查） |
| 域名限速 | 对同一域名的请求单独限速 | 中（按域名隔离） |
| 最小间隔 | 相邻请求的最小时间间隔 | 最低（兜底） |

### 4.2 限速算法

采用 **滑动窗口计数器** 算法：

- 维护一个时间窗口内的请求计数
- 窗口滑动时自动过期旧计数
- 新请求时检查当前窗口计数是否超限
- 超限则等待或拒绝

**优点：**
- 实现简单，内存占用小
- 无需外部存储（Redis 等）
- 适合单客户端场景

### 4.3 请求排队 vs 拒绝

采用 **排队等待** 策略：

- 超限时不立即拒绝，而是等待至可用
- 等待期间可被用户中止（聊天取消）
- 等待超时则返回错误（避免无限等待）
- 用户可在设置中选择「超限拒绝」模式

| 模式 | 行为 |
|------|------|
| `wait`（默认） | 等待至限速窗口可用，最长等待 `maxWaitSec` |
| `reject` | 超限立即返回错误，不等待 |

### 4.4 受限速影响的操作

| 操作 | 是否受限速 | 说明 |
|------|------------|------|
| `navigate` (open) | ✅ | 发起网络请求 |
| `navigate` (refresh) | ✅ | 发起网络请求 |
| `navigate` (back/forward) | ✅ | 可能触发网络请求 |
| `observe` | ✅ | Stagehand 内部可能发起请求 |
| `extract` | ✅ | Stagehand 内部可能发起请求 |
| `act` | ✅ | Stagehand 内部可能发起请求 |
| `screenshot` | ❌ | 本地操作，无网络请求 |
| `close` | ❌ | 本地操作，无网络请求 |

### 4.5 设计说明：限速与可信域名分离

可信域名（`trustedDomains`）属于**内容安全 / 确认策略**逻辑（控制 navigate 是否需用户确认），与**访问行为限速**无关。限速对所有网络操作统一生效，不因域名在可信列表中而豁免。

> 注：「同会话内重复访问同一 URL 可豁免」为历史可选设想，**非本版本目标**。

---

## 5. 配置项设计

### 5.1 新增配置项

| 配置项 | 类型 | 默认值 | 可选值 | 说明 |
|--------|------|--------|--------|------|
| `rateLimitEnabled` | boolean | `true` | - | 是否启用限速 |
| `rateLimitMinIntervalMs` | number | `1000` | 500, 1000, 2000, 3000, 5000 | 相邻请求最小间隔（毫秒） |
| `rateLimitPerMinute` | number | `20` | 10, 20, 30, 40, 60 | 每分钟最大请求数 |
| `rateLimitPerHour` | number | `200` | 100, 200, 300, 500, 1000 | 每小时最大请求数 |
| `rateLimitPerDomainPerMinute` | number | `10` | 5, 10, 15, 20, 30 | 单域名每分钟最大请求数 |
| `rateLimitMode` | enum | `'wait'` | `wait`, `reject` | 超限时的处理方式 |
| `rateLimitMaxWaitSec` | number | `30` | 10, 30, 60, 120 | 等待模式下的最大等待时间（秒） |

### 5.2 默认值说明

| 配置项 | 默认值 | 选择理由 |
|--------|--------|----------|
| `rateLimitMinIntervalMs` | 1000ms | 1 秒间隔对大多数网站友好 |
| `rateLimitPerMinute` | 20 | 每分钟 20 次请求，低于常见反爬阈值（通常 30-60） |
| `rateLimitPerHour` | 200 | 每小时 200 次，适合长时间任务 |
| `rateLimitPerDomainPerMinute` | 10 | 单域名每分钟 10 次，避免对单一网站冲击 |
| `rateLimitMode` | `wait` | 等待比拒绝更友好，任务可继续 |
| `rateLimitMaxWaitSec` | 30 | 30 秒等待上限，避免无限阻塞 |

### 5.3 配置项分组

在设置界面中，限速配置归入 **「限速策略」** 分组，位于「操作引擎（Stagehand）」分组之后。

---

## 6. 设置界面设计

### 6.1 位置与结构

在 **工具 → 网络访问** 子 Tab 中，新增 **「限速策略」** 分组：

```
网络访问子 Tab 结构：
1. 允许飞书远程会话使用
2. 运行环境检测
3. 操作引擎（Stagehand）
   - 操作引擎使用的大模型
   - 单次请求最大推理次数
4. 【新增】限速策略
   - 启用限速
   - 最小请求间隔
   - 每分钟最大请求数
   - 每小时最大请求数
   - 单域名每分钟最大请求数
   - 超限处理方式
   - 最大等待时间
5. 可信域名
6. 允许 HTTP
7. 无头模式
8. 操作超时（秒）
9. 空闲自动关闭浏览器组件，释放内存（秒）
10. 禁用操作
```

### 6.2 UI 组件

| 配置项 | 组件类型 | 说明 |
|--------|----------|------|
| `rateLimitEnabled` | Switch | 启用/禁用限速 |
| `rateLimitMinIntervalMs` | Select | 下拉选择，单位显示为「秒」 |
| `rateLimitPerMinute` | Select | 下拉选择 |
| `rateLimitPerHour` | Select | 下拉选择 |
| `rateLimitPerDomainPerMinute` | Select | 下拉选择 |
| `rateLimitMode` | Select | `等待` / `拒绝` |
| `rateLimitMaxWaitSec` | Select | 仅在 `rateLimitMode=wait` 时显示 |

### 6.3 文案设计

| 配置项 | 标签 | Hint |
|--------|------|------|
| 限速策略 | 限速策略 | 控制请求频率，避免触发网站反爬机制。 |
| 启用限速 | 启用限速 | 关闭后不限速，可能触发网站反爬。 |
| 最小请求间隔 | 最小请求间隔（秒） | 相邻两次请求的最小间隔时间。 |
| 每分钟最大请求数 | 每分钟最大请求数 | 全局请求速率上限。 |
| 每小时最大请求数 | 每小时最大请求数 | 长时间任务的请求总量上限。 |
| 单域名每分钟最大请求数 | 单域名每分钟最大请求数 | 对同一域名的访问频率上限。 |
| 超限处理方式 | 超限处理方式 | 等待：排队至可用；拒绝：立即返回错误。 |
| 最大等待时间 | 最大等待时间（秒） | 等待模式下，超限时的最长等待时间。 |

### 6.4 条件显示

| 条件 | 显示项 |
|------|--------|
| `rateLimitEnabled=false` | 隐藏其他限速配置项 |
| `rateLimitMode=reject` | 隐藏 `rateLimitMaxWaitSec` |

### 6.5 禁用状态提示

当 `rateLimitEnabled=false` 时，分组下方显示警告：

```
⚠️ 限速已关闭，高频请求可能触发网站反爬机制，导致访问被拒绝或 IP 封禁。
```

---

## 7. 实现架构

### 7.1 新增模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 限速器 | `electron/browser/rateLimiter.ts` | 实现滑动窗口计数器与限速逻辑 |
| 限速服务 | `electron/browser/rateLimitService.ts` | 管理限速状态，提供检查/等待接口 |

### 7.2 限速器设计

```typescript
// electron/browser/rateLimiter.ts

interface RateLimitConfig {
  minIntervalMs: number
  perMinute: number
  perHour: number
  perDomainPerMinute: number
  mode: 'wait' | 'reject'
  maxWaitSec: number
}

interface RateLimitState {
  // 全局计数
  minuteWindow: Map<number, number>  // timestamp -> count
  hourWindow: Map<number, number>
  
  // 域名计数
  domainMinuteWindows: Map<string, Map<number, number>>
  
  // 上次请求时间
  lastRequestAt: number
}

class RateLimiter {
  private state: RateLimitState
  
  // 检查是否超限
  checkLimit(domain: string): RateLimitResult
  
  // 等待至可用
  waitForAvailable(domain: string, signal: AbortSignal): Promise<void>
  
  // 记录一次请求
  recordRequest(domain: string): void
  
  // 清理过期计数
  cleanupExpired(): void
}
```

### 7.3 与 browserExecutor 集成

在 `browserExecutor.ts` 中，执行网络操作前调用限速服务：

```typescript
// 伪代码流程
async execute(input, ctx) {
  // ... 前置校验 ...
  
  const action = parseAction(input)
  const domain = extractDomain(input.url)  // 仅 navigate(open) 有 URL
  
  // 检查限速（仅对网络操作）
  if (needsRateLimit(action)) {
    const limitResult = rateLimitService.checkLimit(domain)
    
    if (limitResult.limited) {
      if (cfg.rateLimitMode === 'reject') {
        return { success: false, error: '请求频率超限，请稍后重试' }
      }
      
      // 等待模式
      await raceWithUserAbort(
        rateLimitService.waitForAvailable(domain, ctx.signal),
        ctx.signal
      )
    }
  }
  
  // 执行操作
  // ...
  
  // 记录请求
  rateLimitService.recordRequest(domain)
}
```

### 7.4 域名提取

对于 `observe`/`extract`/`act` 等操作，域名从当前页面 URL 获取：

```typescript
// 从 stagehandSessionState.lastUrl 提取域名
const domain = sessionState.lastUrl ? extractDomain(sessionState.lastUrl) : null
```

### 7.5 状态管理

限速状态存储在主进程内存中：

- 不持久化（重启后清零）
- 每个会话独立限速（可选：全局共享）
- 定期清理过期计数（每 10 秒）

---

## 8. 数据模型变更

### 8.1 BrowserConfig 扩展

在 `src/shared/domainTypes.ts` 中扩展 `BrowserConfig`：

```typescript
export interface BrowserConfig {
  // ... 现有字段 ...
  
  // 限速配置
  rateLimitEnabled: boolean
  rateLimitMinIntervalMs: number
  rateLimitPerMinute: number
  rateLimitPerHour: number
  rateLimitPerDomainPerMinute: number
  rateLimitMode: 'wait' | 'reject'
  rateLimitMaxWaitSec: number
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  // ... 现有默认值 ...
  
  rateLimitEnabled: true,
  rateLimitMinIntervalMs: 1000,
  rateLimitPerMinute: 20,
  rateLimitPerHour: 200,
  rateLimitPerDomainPerMinute: 10,
  rateLimitMode: 'wait',
  rateLimitMaxWaitSec: 30
}
```

### 8.2 mergeBrowserConfig 更新

```typescript
export function mergeBrowserConfig(partial?: Partial<BrowserConfig> | null): BrowserConfig {
  // ... 现有逻辑 ...
  return {
    ...DEFAULT_BROWSER_CONFIG,
    ...partial,
    // 限速字段继承默认值
    rateLimitEnabled: partial?.rateLimitEnabled ?? DEFAULT_BROWSER_CONFIG.rateLimitEnabled,
    rateLimitMinIntervalMs: partial?.rateLimitMinIntervalMs ?? DEFAULT_BROWSER_CONFIG.rateLimitMinIntervalMs,
    // ... 其他限速字段 ...
  }
}
```

---

## 9. 错误处理与用户提示

### 9.1 错误类型

| 错误场景 | 错误消息 |
|----------|----------|
| 超限拒绝模式 | `请求频率超限，请稍后重试。当前限制：每分钟 {perMinute} 次` |
| 等待超时 | `等待可用请求槽位超时（{maxWaitSec} 秒），请稍后重试` |
| 用户中止等待 | `已取消`（复用现有中止消息） |

### 9.2 进度提示

等待期间发送进度通知：

```typescript
ctx.sendProgress('rate_limiting', `等待请求槽位可用...（预计 {waitTime} 秒）`)
```

### 9.3 日志记录

限速事件记录到 Agent 日志：

```typescript
logAgentEvent('info', 'browser.rate_limit', {
  sessionId,
  action,
  domain,
  limitType: 'minute' | 'hour' | 'domain' | 'interval',
  waitMs: 1234,
  result: 'waited' | 'rejected'
})
```

---

## 10. 测试计划

### 10.1 单元测试

| 文件 | 测试内容 |
|------|----------|
| `electron/browser/rateLimiter.test.ts` | 滑动窗口计数器、限速检查、等待逻辑 |
| `electron/browser/rateLimitService.test.ts` | 服务接口、状态管理、清理过期 |
| `electron/tools/browserExecutor.test.ts` | 限速集成、超限拒绝、等待超时、用户中止 |

### 10.2 测试用例

#### 10.2.1 限速器测试

| # | 用例 | 输入 | 预期 |
|---|------|------|------|
| 1 | 未超限 | 请求数 < perMinute | `limited=false` |
| 2 | 分钟超限 | 请求数 = perMinute | `limited=true, limitType='minute'` |
| 3 | 小时超限 | 请求数 = perHour | `limited=true, limitType='hour'` |
| 4 | 域名超限 | 域名请求数 = perDomainPerMinute | `limited=true, limitType='domain'` |
| 5 | 间隔超限 | 上次请求 < minIntervalMs 前 | `limited=true, limitType='interval'` |
| 6 | 等待成功 | 等待至窗口滑动 | 等待完成，返回 |
| 7 | 等待超时 | 等待时间 > maxWaitSec | 抛出超时错误 |
| 8 | 等待中止 | AbortSignal 触发 | 抛出中止错误 |
| 9 | 窗口过期 | 时间戳超出窗口范围 | 计数自动清理 |

#### 10.2.2 executor 集成测试

| # | 用例 | 预期 |
|---|------|------|
| 10 | 拒绝模式超限 | 返回 `{ success: false, error: '请求频率超限...' }` |
| 11 | 等待模式超限 | 等待后继续执行，返回成功 |
| 12 | 等待超时 | 返回 `{ success: false, error: '等待超时...' }` |
| 13 | 用户中止等待 | 返回 `{ success: false, error: '已取消' }` |
| 14 | close 不限速 | 直接执行，不调用限速检查 |
| 15 | screenshot 不限速 | 直接执行，不调用限速检查 |

---

## 11. 验收标准

### 11.1 功能验收

- [ ] 限速配置项在设置界面正确显示
- [ ] 默认值生效，无需用户配置即可友善访问
- [ ] 全局分钟/小时限速正确计数和限制
- [ ] 域名级限速按域名隔离计数
- [ ] 最小间隔限制相邻请求
- [ ] 等待模式下超限请求排队等待
- [ ] 拒绝模式下超限请求立即返回错误
- [ ] 等待超时返回正确错误消息
- [ ] 用户中止等待时正确取消
- [ ] `close`/`screenshot` 不受限速影响
- [ ] 进度通知在等待期间正确显示

### 11.2 UI 验收

- [ ] 「限速策略」分组在「操作引擎」之后
- [ ] 各配置项组件类型正确（Switch/Select）
- [ ] 条件显示逻辑正确（禁用时隐藏其他项）
- [ ] 文案符合设计（标签 + Hint）
- [ ] 禁用状态警告提示显示

### 11.3 测试验收

- [ ] 单元测试覆盖限速器核心逻辑
- [ ] executor 集成测试覆盖限速场景
- [ ] 测试覆盖率 ≥ 80%

---

## 12. 相关文件

| 区域 | 文件 | 变更类型 |
|------|------|----------|
| 类型定义 | `src/shared/domainTypes.ts` | 扩展 BrowserConfig |
| 设置界面 | `src/renderer/components/Config/BrowserSettingsTab.tsx` | 新增限速分组 |
| i18n | `src/renderer/i18n/resources/zh-CN/config.json` | 新增限速文案 |
| 限速器 | `electron/browser/rateLimiter.ts` | 新增 |
| 限速服务 | `electron/browser/rateLimitService.ts` | 新增 |
| 执行器 | `electron/tools/browserExecutor.ts` | 集成限速检查 |
| 单元测试 | `electron/browser/rateLimiter.test.ts` | 新增 |
| 单元测试 | `electron/browser/rateLimitService.test.ts` | 新增 |
| 集成测试 | `electron/tools/browserExecutor.test.ts` | 扩展 |

---

## 附录：常见网站反爬阈值参考

| 网站/类型 | 典型阈值 | 建议 |
|-----------|----------|------|
| 搜索引擎 | 每分钟 30-60 次 | 设置 `perMinute=20` |
| 电商平台 | 每分钟 20-40 次 | 设置 `perMinute=15` |
| 新闻门户 | 每分钟 50-100 次 | 设置 `perMinute=30` |
| API 服务 | 每分钟 60-120 次 | 查看具体 API 文档 |
| 社交平台 | 每分钟 10-30 次 | 设置 `perMinute=10` |

**注意：** 以上为参考值，实际阈值因网站而异。建议从保守值开始，根据实际响应调整。