# Agent 网页访问工具 — 技术方案与测试方案评审意见

**评审日期：** 2026-05-27
**评审人：** 技术总监
**评审版本：** design.md v1.0 / test-plan.md v1.0

---

## 评审概览

| 评审维度 | 设计方案 | 测试方案 |
|---------|---------|---------|
| 架构设计 | ⭐⭐⭐⭐⭐ | — |
| 安全设计 | ⭐⭐⭐⭐ | — |
| 可测试性 | — | ⭐⭐⭐⭐ |
| 覆盖完整性 | — | ⭐⭐⭐ |
| 与现有系统衔接 | ⭐⭐⭐⭐ | — |

---

## 一、技术设计方案评审

### 1.1 架构设计（优秀）

**优点：**

- 分层架构清晰，遵循现有 `ToolExecutor` 模式，与 `builtinExecutors.ts` 注册机制一致
- StagehandService 单例 + sessionId 管理实例的设计合理，支持会话隔离
- 安全前置（URL 校验、指令校验）放在 executor 之前，符合纵深防御原则
- 配置驱动设计（BrowserConfig 默认全部关闭）体现了安全默认原则

**建议改进：**

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| 1 | **localhost/127.0.0.1 未明确禁止** | urlSecurity §2 | 内网攻击面不止 192.168.x.x，localhost / 127.0.0.1 / ::1 应明确禁止，或至少纳入 trustedDomains 管控 |
| 2 | **IDN / Punycode 域名未处理** | urlSecurity §2 | `xn--fiqs8s.com`（example.com 的 punycode）可绕过白名单检查，应在 extractHostname 后做 punycode 规范化或明确拒绝非 ASCII 域名 |
| 3 | **Chromium 崩溃恢复未设计** | stagehandService | Playwright Chromium 崩溃、超时、OOM 时 session 状态不确定，应有 `try-catch` 包装和 instance 标记清理机制 |
| 4 | **缺少操作审计日志** | 全局 | browser 工具涉及用户确认和敏感操作（navigate/act），应在主进程记录结构化日志（toolName、action、url、timestamp、userId、result），便于安全审计 |
| 5 | **Stagehand LLM 调用失败处理** | browserExecutor | 未说明 apiKey 过期 / baseUrl 不可达 / 配额超限时的错误分类和用户提示，应区分「配置错误」「临时网络问题」「额度不足」三类并给出差异化提示 |
| 6 | **`trustedDomains` 与 `allowedDomains` 职责重叠** | BrowserConfig | 两者均可用于 navigate 确认判断，设计文档 §2.1.4 与需求 §10 表格中的描述存在歧义，建议明确：`allowedDomains` = navigate 前置条件，`trustedDomains` = navigate 免确认条件 |

### 1.2 安全设计（良好，有待加强）

**核心安全设计合理：**

- URL 校验覆盖协议、IP 字面量、白名单
- 指令校验覆盖长度、禁止子串、act 原子性
- Plan 探索期写操作拦截设计正确
- Playwright Route handler 补充 JS 导航防御

**安全缺口：**

| # | 风险 | 建议 |
|---|------|------|
| S1 | **URL fragment 未彻底清理** | normalizeUrl 去除 `#fragment`，但 query string 中的 `javascript:` 伪协议（如 `?url=javascript:alert(1)`）若后续被拼接进 eval 场景仍有风险 |
| S2 | **act 原子性检测可被绕过** | 中文连接词列表不完整，漏掉「然后再」「接着就」「随后」「下一步」「接下来」等常见表达；英文漏掉 `;` 以外的 `&&`、`\|\|`、`\|`（管道符） |
| S3 | **navigation intercept 依赖 allowedDomains** | 当 `allowedDomains=[]`（白名单为空）时，route handler 会放行所有 navigation（因为 isAllowedDomain 对空列表返回 true），与 urlSecurity.validateUrl 的拒绝逻辑不一致 |

---

## 二、测试方案评审

### 2.1 可测试性（良好）

纯函数模块（urlSecurity、instructionGuards、browserActionPolicy）可直接单测，mock 策略合理。

### 2.2 覆盖完整性（中等，建议补充）

**缺失的关键测试用例：**

| # | 测试场景 | 优先级 | 说明 |
|---|---------|--------|------|
| T1 | **Punycode/IDN 域名白名单绕过** | 高 | URL `https://example.com.xn--fiqs8s` 应被正确拒绝或归一化 |
| T2 | **localhost / 127.0.0.1 / ::1** | 高 | 明确验证内网回环地址被拒绝 |
| T3 | **Act 原子性：更多连接词变体** | 高 | `&&`、`\|\|`、`然后再`、`接着就`、`随后`、`下一步` |
| T4 | **Chromium 崩溃后 session 状态** | 中 | StagehandService 在 Playwright 异常退出后仍能正确关闭并清理 |
| T5 | **并发 session 独立配额计数** | 中 | 两个 sessionId 同时使用 browser，互相不干扰配额 |
| T6 | **LLM 凭证失效错误分类** | 中 | apiKey 过期 vs 网络超时 vs 额度超限的错误消息差异化 |
| T7 | **空 allowedDomains 时的 route handler 行为** | 中 | 与 urlSecurity 的一致性验证 |
| T8 | **Idle timeout 竞态** | 低 | 定时器触发 close 与新的 getOrCreate 并发时的处理 |
| T9 | **maxOutputChars 截断边界** | 低 | 正好等于 50000 字符时的边界条件 |
| T10 | **observe 无 instruction 默认值** | 低 | 确认传给 Stagehand.observe 的参数是空字符串而非 undefined |

---

## 三、待解决的技术决策（需确认）

| # | 问题 | 影响范围 | 建议 |
|---|------|---------|------|
| O1 | **Stagehand 内部 LLM 推理失败时，error 是否透传给用户？** | browserExecutor | 建议捕获并归类为「浏览器操作失败」，避免暴露 SDK 内部错误堆栈 |
| O2 | **`allowedDomains=[]` 时的默认行为？** | urlSecurity / route handler | 明确：空列表是「禁止所有」还是「允许所有」（建议前者，与默认关闭原则一致） |
| O3 | **observe/extract 超时后 session 是否保留？** | stagehandService | 建议保留（用户可能重试），仅标记该次推理超限 |
| O4 | **Stagehand model 为空串时是否复用聊天模型？** | BrowserConfig | 设计文档 §4.1 说「空串 = 复用聊天模型」，需在代码中明确 fallback 逻辑 |

---

## 四、总结

**技术设计方案：** 整体架构合理，安全分层清晰，与现有系统衔接方案可行。主要改进方向是加强内网回环地址防护、IDN 域名归一化、操作审计日志、以及 Chromium 崩溃恢复机制。

**测试方案：** 覆盖了核心纯函数和执行路径，建议补充安全相关的边界测试（Punycode、内网地址、act 连接词变体）以及并发/异常场景，确保上线前覆盖所有已知风险点。

---

**建议优先级：**
1. **上线前必须修复（阻塞）：** T2（内网地址）、T3（act 连接词）、T7（空白名单一致性）、O2（空白名单行为明确）
2. **上线前建议补充（重要）：** T1（IDN）、S2（act 原子性）、S3（route handler 一致性）
3. **上线后持续完善（优化）：** T4、T5、T6、S4（审计日志）、S5（LLM 错误分类）
