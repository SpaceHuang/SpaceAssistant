# 浏览器 act 操作会话级信任机制 — 产品需求文档

**版本：** 2.3（基于 v2.2 + 确认界面通俗性评审定稿）
**日期：** 2026-06-20
**状态：** 待评审
**关联文档：**
- [web-browser-tools-requirement.md](./web-browser-tools-requirement.md)（浏览器工具整体设计）
- [browser-network-access-settings-requirement.md](./browser-network-access-settings-requirement.md)（网络访问与可信域名）
- [confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md)（确认卡片信任机制，覆盖 navigate 域名信任与 Shell 命令信任）
- [web-browser-rate-limit-requirement.md](./web-browser-rate-limit-requirement.md)（速率限制）
- [../review/browser-act-session-trust-requirement-review.md](../review/browser-act-session-trust-requirement-review.md)（确认界面信息充分性与通俗性评审，本版据此优化）

> **v2.3 相对 v2.2 的主要变更**（确认界面通俗性优化，面向「只有基本安全/计算机知识」的普通用户）：
> 1. **危险信息从「字符串」升级为「结构化 `dangerInfo`」**：`assessActDanger` 一次产出 `{ source(仅审计), userReason(人话原因), consequence(后果类别), detail }`（§7.2.3），通过 `tool:confirm-request` 捎带（§7.4.4）。前端只读、不复算，符合已定的方案 A。废弃原 `dangerSummary`/`dangerSource` 两个面向用户展示的字段。
> 2. **`dangerSource` 完全退出用户界面**，仅保留在审计日志（§10）。三类来源对用户的决策动作完全相同，展示反而制造疑惑。同步修正 `source='page-effect'` 的死值问题：L-1 命中但 L-2 observe 失败/超时时**保守判 dangerous**（§7.2.3 / §9.3），既消除死值又比「observe 失败即退回信任」更安全。
> 3. **每条危险信号配一句「可能后果」**：按 `consequence` 类别渲染「可能扣钱 / 删数据 / 改登录状态 / 跳未知网站 / 传文件」（§8.2）。小白只能基于「后果」判断，当前完全缺失。
> 4. **危险操作两档视觉强度**：金钱/删除/未知网站 → 强警示（红底）；账号/文件/其他 → 次级警示（橙底）（§8.2），缓解「狼来了」脱敏。
> 5. **信任勾选框补「定心丸」**：勾选框下方补「仅对常规操作免确认；支付/转账/删除等敏感操作仍会每次询问」（§8.1）。这是方案最大安全卖点，原版只字未提。
> 6. **静默放行补 inline 反馈**：会话级/持久化信任命中自动执行时，推送一条非阻断提示「已信任 X 的常规操作，自动执行（敏感操作仍会询问）」（§8.5），闭合 US-07「突然不问」的预期断层。
> 7. **去黑话 + 中性化**：卡片标题 `browser (act)` → 「🌐 浏览器操作」；进度态「正在分析页面风险…」→「正在检查本次操作…」；辅助文案「命中危险动作判定」→「本次操作较为敏感」（§8.1 / §8.2 / §8.5 / §8.6）。
> 8. **`fill` 类操作预览将填入的值**（敏感字段掩码）：仅在危险卡片（observe 已运行、候选含 `arguments`）上落地；普通卡片不跑 observe，不预览——保护 §5.4「无危险页面零推理」成本保证（§8.2 / §8.1 说明）。
> 9. **目标元素高亮同样仅限危险卡片**：评审建议普通卡片也高亮，但 observe 不在普通页面运行；故高亮只在危险卡片提供，普通卡片维持截图（§8.1 说明、§8.2 已有）。

> **v2.2 相对 v2.1 的主要变更**：引入「两级 effect 判定 + 意图关键词」的危险动作识别（§5.4），从「仅查 instruction 关键词」升级为「查页面/目标元素客观 effect」。核心安全性质：危险判定只看页面/元素客观属性（href/form action/label），与 instruction 文本正交，注入可伪装意图但伪装不了元素真实 href。三级（页面级 L-1 → 目标级 L-2 observe → 意图关键词 L-3）中任一命中即「危险动作」，**无视信任强制确认且不记忆信任**。方向 3 补捕获 `ActResult.actions` + 事后 URL 变化用于审计与事后告警。L-2 observe 预检期间推送 `analyzing_risk` 进度态避免卡顿（§8.6）。同步重写 §7.2–§7.5、§8、§9、§10、§12、§13、§14、§15。

> **v2.1 相对 v1.0 草案的主要变更**（已逐项对照当前实现核实）：
> 1. **改用实时 `page.url()`，废弃 lastUrl 快照方案**：act 执行时本就坐在目标页面上，当前 URL 实时可得。`StagehandService` 持有 `stagehand` 实例，可通过 `stagehand.context.pages()[0].url()`（同步、纯读、无副作用）直接读取实时页面 URL（`stagehandService.ts:21-42`）。因此确认判断无需依赖 `StagehandSessionState.lastUrl` 快照，也就**无需在 navigate(open) 后补写 lastUrl**。这同时消除了 v1.0 设想中的 SPA 跳转过时问题（原 OQ-1）与 rateLimit 副作用问题（原 OQ-6），并使 act 信任判定与 rateLimit 域名归属（`browserExecutor.ts:253` 同样用 `page.url()`）取值一致。
> 2. **补强信任撤销与可见性**：明确会话级 act 信任**无法在会话存活期内手动单项撤销**（仅删会话整体清除），新增会话级信任指示的轻量可见性方案（§8.5）。
> 3. **新增分阶段实施顺序**：将改动拆为 P0–P3 四阶段，支持灰度落地（§7.10）。
> 4. **测试矩阵对齐到具体测试文件**：§12.4 给出每个测试文件的最小用例清单。
> 5. **统一抽象决策**：§5.8 明确「本期不合并 `actTrustedDomains` 与 `trustedDomains`」的理由与 Phase 2 演进方向。
> 6. **i18n key 命名合规**：§14.1 的 key 全部调整为 ≤4 层 camelCase，符合 CLAUDE.md 规范。
> 7. **核实记录**：§15.1 列出文档中每一处对实现事实的引用及其核实来源。

---

## 目录

1. [概述](#1-概述)
2. [问题分析](#2-问题分析)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [设计方案](#5-设计方案)
6. [数据模型变更](#6-数据模型变更)
7. [实现要点](#7-实现要点)
8. [UI 与交互设计](#8-ui-与交互设计)
9. [安全与权限](#9-安全与权限)
10. [审计日志](#10-审计日志)
11. [配置迁移与兼容](#11-配置迁移与兼容)
12. [验收标准与测试矩阵](#12-验收标准与测试矩阵)
13. [相关文件](#13-相关文件)
14. [多语言资源规划](#14-多语言资源规划)
15. [待解决问题与核实记录](#15-待解决问题与核实记录)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 的浏览器工具（`browser`）对 `navigate(open)` 与 `act` 两类写操作采用不同的确认策略：

- **`navigate(open)`**：已有完整的「可信域名 + 会话内信任 + 持久化信任」三层机制。用户首次确认访问某域名后，同会话内访问同域名（含子域）不再询问；用户还可在确认卡片勾选「信任此域名」，写入 `BrowserConfig.trustedDomains` 跨会话生效。
- **`act`**：仅由 `BrowserConfig.actRequiresConfirm`（默认 `true`）一刀切控制。**只要该开关开启，每一次 `act` 调用都必须人工确认**，没有任何会话级或域名级信任机制。

> **实现核实**：`electron/browser/browserActionPolicy.ts:13-15`
> ```ts
> if (action === 'act') {
>   return cfg.actRequiresConfirm
> }
> ```
> 与之对照，`navigate` 分支（同文件 16-25 行）已实现「会话级信任 + 持久化信任」两层降级。

这导致一个明显的体验断层：用户已经首次确认 `navigate` 打开某域名、同会话不再问 navigate，但接下来在该域名上执行的每一个 `act`（点击、输入、滚动、选择等）仍然逐一弹出确认卡片。在「自动填表单」「连续点击翻页」「多步表单流程」等场景下，用户必须一直坐在电脑前逐个点击「确认」，与「自动化」的预期严重背离。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 消除体验断层 | 让 act 与 navigate 的会话内信任对齐，避免「同会话同域名反复确认」 |
| 降低操作摩擦 | 用户首次确认 act 后，同会话同域名的后续 act 自动放行，无需反复点击 |
| 安全可控 | 保留高风险指令的强制确认；信任关系可在设置页查看与撤销 |
| 最小侵入 | 复用现有 `browserSessionTrust`、`browserActionPolicy`、`BrowserConfirmCard` 框架，不改变工具调用主流程 |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **与 navigate 信任对齐** | act 会话级信任的域名提取、子域匹配、生命周期与 navigate 完全一致 |
| **安全检查永不绕过** | instruction 安全校验、URL 校验、Plan 只读限制、推理配额、速率限制照常执行 |
| **高风险指令强制确认** | 命中高风险关键词（提交、支付、转账、删除等）的 instruction 不享受信任，每次确认 |
| **用户可控** | 会话级信任默认开启但可关闭；持久化信任需用户主动勾选；设置页可管理 |
| **保守默认** | 持久化 act 信任默认不启用，需用户在确认卡片主动勾选 |

---

## 2. 问题分析

### 2.1 当前痛点

| 场景 | 当前体验 | 期望体验 |
|------|----------|----------|
| 在已确认 navigate 的域名上执行 5 个连续 act（填表单） | 5 次确认卡片，必须逐一点击 | 首次确认后，同会话同域名后续 act 自动放行 |
| 翻页抓取（navigate + act 多轮） | 每轮 act 都要确认 | 同会话同域名 act 仅首次确认 |
| 多步表单（点击 + 输入 + 提交） | 每步都要确认 | 普通步骤免确认；「提交」等高风险指令仍需确认 |
| 跨会话访问常用站点 | 每个新会话首次 act 都要确认 | 用户可主动勾选「信任此域名的操作」，跨会话免确认 |

### 2.2 现有能力差距

| 差距 | 影响 |
|------|------|
| `browserActionNeedsConfirmation` 的 `act` 分支仅看 `cfg.actRequiresConfirm` | 无法根据会话/域名上下文降低确认频率 |
| `BrowserConfirmCard` 对 act 操作不显示信任勾选项（`canTrustDomain` 条件含 `action === 'navigate'`） | 用户无法主动建立持久化 act 信任 |
| `browserSessionTrust` 仅记忆 navigate 的会话内信任（`trustedHostsBySession`） | act 操作无会话内信任概念 |
| `StagehandService` 未暴露只读「当前页面 URL」查询 | 确认判断阶段（executor 前）无法获知 act 所在域名，信任判定无依据 |
| 无高风险指令识别 | 无法区分「点击下一页」与「提交订单」的风险差异 |

### 2.3 关键约束：act 操作的域名来源

`act` 工具调用的 `input` 仅包含 `instruction`，不直接携带 URL。但 act 执行时本就坐在目标页面上，**当前页面 URL 实时可得**：`StagehandService` 持有 `stagehand` 实例，`stagehand.context.pages()[0].url()` 是 Playwright 的同步 getter，纯读无副作用（`stagehandService.ts:27-30, 40`）。

`browserActionNeedsConfirmation` 在 `toolChatLoop` 中、executor 调用前执行——虽拿不到 executor 内部的 `page` 局部变量，但可通过 `stagehandService` 同一实例同步读取实时页面 URL（见 §5.3）。**无需维护 lastUrl 快照，无需在 navigate 后补写。**

**边界情况：**
- 首次操作前（无 navigate、尚无页面）：`pages()` 为空 → 返回 `undefined` → act 仍需确认
- 浏览器实例因 idle 超时关闭：`sessions.get` 返回空或 `pages()` 为空 → 返回 `undefined` → act 仍需确认（用户确认后 executor 会 `getOrCreate` 重建实例）
- 实例异常/崩溃：try/catch 兜底返回 `undefined` → act 仍需确认

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | `act` 操作引入会话级信任：用户首次确认 act 后，同会话同域名（含子域）的后续 act 自动放行 |
| G2 | `act` 确认卡片新增「信任此域名的操作，后续不再询问」勾选项，勾选后写入 `BrowserConfig.actTrustedDomains` 跨会话生效 |
| G3 | 命中高风险关键词的 `act` instruction 不享受任何信任，每次强制确认 |
| G4 | 会话级 act 信任的生命周期与 navigate 一致：删除会话即清除；持久化信任可在设置页管理 |
| G5 | 所有现有安全检查（instruction 校验、URL 校验、Plan 只读、推理配额、速率限制、`deniedActions`）不放松 |
| G6 | `actRequiresConfirm === false` 时行为不变（本需求不改变该开关语义，仅在其为 `true` 时引入信任降级） |
| G7 | act 信任判定使用实时页面 URL（`page.url()`），与 rateLimit 域名归属取值一致 |

### 3.2 非目标

| # | 非目标 | 说明 |
|---|--------|------|
| NG1 | 不移除 `actRequiresConfirm` 开关 | 该开关仍作为「总开关」存在；本需求是在其为 `true` 时的精细化降级 |
| NG2 | 不对 `observe`/`extract`/`screenshot`/`close` 引入信任机制 | 这些操作本就免确认 |
| NG3 | 不引入「信任整个工具」或「全局免确认」 | 仅域名级信任 |
| NG4 | 不对 `navigate` 的非 open 模式（refresh/back/forward）引入信任 | 这些操作本就免确认 |
| NG5 | 不在本期实现「按 instruction 语义聚类信任」或 LLM 风险评估 | 仅按域名 + 高风险关键词分级 |
| NG6 | 不改变飞书远程会话的 browser 注入策略 | 飞书会话默认不注入 browser，本需求不影响 |
| NG7 | 不合并 `actTrustedDomains` 与 `trustedDomains` | 语义不同，分别建立（理由见 §5.8） |
| NG8 | 不引入会话级信任的「单项手动撤销」 | 会话级信任随会话删除整体清除（理由见 §8.5） |

---

## 4. 用户故事

### US-01：连续 act 免确认（核心）

**作为** 用户，**当** 我让 Agent 在某网页上「依次填写姓名、邮箱、电话三个输入框」时，**我希望** 首个 act 确认后，同会话同域名的后续 act 自动执行，**以便** 不必反复点击确认。

### US-02：跨会话信任常用站点

**作为** 用户，**当** 我经常让 Agent 在 `github.com` 上执行操作时，**我希望** 在确认卡片勾选「信任此域名的操作」，**以便** 后续会话不再询问。

### US-03：高风险指令仍需确认

**作为** 注重安全的用户，**当** Agent 执行「点击提交订单」时，**我希望** 仍然弹出确认卡片，**以便** 避免误操作造成损失。

### US-04：管理 act 信任域名

**作为** 用户，**我希望** 在设置页查看和删除已信任的 act 域名列表，**以便** 随时撤销不再信任的站点。

### US-05：关闭会话级 act 信任

**作为** 注重安全的用户，**我希望** 在设置页关闭「act 会话级信任」，**以便** 每个 act 都强制确认（恢复旧行为）。

### US-06：删除会话后信任清除

**作为** 用户，**当** 我删除某会话后，**我希望** 该会话内的 act 信任一并清除，**以便** 新会话访问同站点需重新确认。

### US-07：感知会话内已信任域名（v2.0 新增）

**作为** 用户，**当** 我已在某会话内信任了 `github.com` 的 act 操作后，**我希望** 在下一次 act 确认卡片或设置页能看到「本会话已信任的域名」，**以便** 心理预期一致、避免误以为「确认失效」。

---

## 5. 设计方案

### 5.1 三层信任模型

与 `navigate(open)` 完全对齐的三层信任，按优先级从高到低：

| 层级 | 数据源 | 生命周期 | 触发方式 |
|------|--------|----------|----------|
| L1 持久化 act 信任 | `BrowserConfig.actTrustedDomains` | 跨会话（持久化） | 用户在确认卡片勾选「信任此域名的操作」 |
| L2 会话级 act 信任 | `browserSessionTrust` 内存 Map | 单会话（删除会话即清除） | 用户首次确认 act 后自动记忆 |
| L3 无信任 | — | — | 每次确认 |

**判定顺序（在 `actRequiresConfirm === true` 前提下）：**

```
先做 §5.4 危险动作识别（页面级 effect → 目标级 effect → 意图关键词）：
  ├─ 命中任一危险信号 → 强制确认（无视信任）
  └─ 三级全不命中（非危险动作）→ 进入域信任降级：
        当前页面域名 ∈ actTrustedDomains（L1）？
          ├─ 是 → 免确认
          └─ 否 → 当前页面域名 ∈ 会话级 act 信任（L2）？
                    ├─ 是 → 免确认
                    └─ 否 → 需确认
```

> **正交性**：§5.4 危险动作判定（看 effect）与 §5.1 域信任降级（看域名）正交。危险动作永远确认，无论是否在信任域；非危险动作才看信任决定免确认与否。

### 5.2 域名提取与子域匹配

**完全复用 navigate 信任的域名规则**，确保行为一致：

- 域名提取：`extractTrustableDomain(url)`（来自 `src/shared/browserDomainTrust.ts`，经 `electron/browser/browserDomainTrust.ts` 再导出）
  - `https://docs.github.com/en/actions` → `github.com`
  - `https://www.example.co.uk/path` → `example.co.uk`
  - `https://localhost:3000` → `localhost`
  - `https://192.168.1.100` → `192.168.1.100`
- 子域匹配：`hostnameMatchesTrustedEntry(hostname, trusted)`（来自 `electron/browser/urlSecurity.ts`）
  - 信任 `github.com` → `github.com`、`docs.github.com`、`api.github.com` 均生效
- 会话级记忆：`hostnamesForSessionTrust` 同时登记 `www.sohu.com` 与 `sohu.com`（与 navigate 一致）
- 底层 hostname 提取：`extractHostname(url)`、标准化：`normalizeHostnameForTrust(hostname)`、持久化列表判定：`isTrustedDomain(hostname, trustedDomains[])`

> **实现核实**：以上函数签名均与 `electron/browser/urlSecurity.ts` 一致；`hostnamesForSessionTrust` 已在 `browserSessionTrust.ts:7-15` 实现，act 信任直接复用。

### 5.3 当前页面 URL 获取（实时读取）

act 执行时就坐在目标页面上，当前 URL 实时可得——**无需维护 lastUrl 快照**。`StagehandService` 持有 `stagehand` 实例，可通过 `stagehand.context.pages()[0].url()` 同步读取实时页面 URL（`page.url()` 是 Playwright 的同步 getter，纯读无副作用；类型见 `stagehandService.ts:27-30, 40`）。

新增同步只读方法：

```typescript
/** 同步读取会话当前页面 URL，不创建实例、无副作用；无页面/实例已关闭时返回 undefined */
peekCurrentUrl(sessionId: string): string | undefined {
  try {
    const internal = this.sessions.get(sessionId)
    if (!internal) return undefined
    const pages = internal.state.stagehand.context.pages()
    const page = pages[0]
    return page ? page.url() : undefined
  } catch {
    return undefined
  }
}
```

`toolChatLoop` 在调用 `toolNeedsUserConfirmation` 前，对 `browser` 工具调用 `stagehandService.peekCurrentUrl(sessionId)` 获取实时 URL，传入 `browserActionNeedsConfirmation`。该方法是同步的，与 `toolNeedsUserConfirmation` 的同步签名匹配。

**为何用实时 `page.url()` 而非 lastUrl 快照：**
- act 信任判定与 act 执行在同一页面，实时 URL 即真实操作域名，无歧义
- 无需在 navigate(open) 后额外维护 `lastUrl`，避免快照过时（SPA 跳转）与对 rateLimit 的副作用
- 与 rateLimit 链路取值一致：`browserExecutor.ts:253` 对 act 限流本就用 `page.url()`，act 信任也用 `page.url()`，行为统一

**边界处理：**
- 无页面（首次操作前、实例 idle 关闭、实例崩溃）→ `peekCurrentUrl` 返回 `undefined` → `extractTrustableDomain` 返回 `null` → act 仍需确认
- URL 域名解析失败 → act 仍需确认
- 实例异常抛错 → try/catch 兜底返回 `undefined` → act 仍需确认

### 5.4 危险动作识别：两级 effect 判定 + 意图关键词层

#### 5.4.0 设计转向：从「查意图」到「查效应」

原方案仅凭 `instruction` 文本 + 高风险关键词判定危险——但关键词查的是模型**自述的意图**，不是动作**实际的效应**。提示注入可伪装 instruction（`点击下一页` 实际点中跨域扣款链接），关键词无法覆盖语义等价的有害操作。

人判断 act 危险，看的是「点了哪个元素、会触发什么」（effect），而非「模型说自己想干嘛」（intent）。因此本节把判定改为**与域信任正交的三级 effect 检查**，由「页面级 → 目标元素级 → 意图关键词」逐级精化。三级均命中即「危险动作」，**无视任何信任强制确认**；只有三级全不命中时，才进入 §5.1 的域信任降级逻辑。

> **核心安全性质**：危险动作判定只看页面/元素客观属性（href、form action、method、label），与 `instruction` 文本**独立**。注入攻击可伪装 instruction，但伪装不了它要点中的元素真实 href——除非页面本身即恶意（那归入 §9 的 XSS 跳转风险，由 navigate 确认兜底）。

#### 5.4.1 信息来源（act 时实际可获得，已核实）

| 层 | 信息 | 来源 | 时机 | 成本 | 核实依据 |
|----|------|------|------|------|----------|
| L-0 | 当前页 URL / origin | `page.url()` | 确认前 | 同步，零 | `browserExecutor.ts:247,253` |
| L-1（页面级） | 页面所有 `<form>` 的 action/method、所有可点元素的 href/textContent/role/type | `page.evaluate(...)` | 确认前 | 一次 evaluate，零推理 | `page.evaluate` 已用于 navigate（`:284`） |
| L-2（目标级） | stagehand 将操作的具体候选元素 selector + method + description + arguments | `stagehand.observe(instruction)` | 确认前 | **一次 LLM 推理** | `methods.d.ts:82` `ObserveResult = Action[]`，`Action{selector,description,method?,arguments?}`（`:31-36`） |
| L-3（意图级） | 指令文本命中危险关键词 | `input.instruction` 子串匹配 | 确认前 | 零 | 现状 |
| L-4（事后） | 实际执行的 selector/method/arguments + 事后 `page.url()` 是否变化 | `ActResult.actions` + act 后 `page.url()` | 执行后 | 零（捕获返回值） | `methods.d.ts:21-27` `ActResult{success,actions:Action[],...}` |

> **关键实现约束（已核实）**：`stagehand.act(instruction)` 是「解析+执行」原子的，返回 `ActResult.actions` 时动作已执行，无法用于「执行前」判定。执行前拿候选元素只能用 `stagehand.observe(instruction)`（返回候选 `Action[]`）。两者都消耗一次推理配额——observe 用于**疑似危险页面**的目标精化，act 本身仍走原执行路径。

#### 5.4.2 三级判定流程

在 `actRequiresConfirm === true` 前提下，按成本从低到高执行：

```
0) 取当前页 origin（L-0）

1) 页面级 effect 扫描（L-1，一次 evaluate，零推理）
   扫描页面所有 form/action/method 与可点元素 href/textContent/role/type：
   ├─ 页面存在任一「危险 effect 控件」？  ← 见 5.4.3 危险信号清单
   │   ├─ 否 → 页面非危险，跳过 2，直接进入意图关键词层 3
   │   └─ 是 → 页面疑似危险，进入 2（值得一次 observe 推理）
   │
2) 目标元素级 effect 解析（L-2，一次 observe 推理，仅当 1 命中时触发）
   observe(instruction) 取候选 Action[] → 对每个候选 selector 取其元素真实 effect：
   ├─ 任一候选元素的 effect 命中危险信号？  ← 见 5.4.3
   │   ├─ 是 → 「目标危险」→ 强制确认（无视信任），附带该 effect 摘要给前端
   │   └─ 否 → 目标安全（1 是误报）→ 进入 3
   │
3) 意图关键词层（L-3，零成本，instruction 子串匹配）
   ├─ 命中危险关键词 → 「意图危险」→ 强制确认
   └─ 否 → 非危险动作 → 进入 §5.1 域信任降级（L1 持久化 / L2 会话级 / 需确认）
```

**两级的关系（用户已确认：并行叠加，1 是 2 的廉价筛选器）：**
- 1 管「页面风险面」（粗，可能误报），2 管「目标动作真实效应」（精，兜回 1 误报）。
- 1 不命中 → 不付 observe 成本（多数 act 在无危险页面，零推理）。
- 1 命中 → 才花一次 observe 精化；2 再不命中才放行。
- 两者职责正交，叠加构成「危险 effect 检查」；与 §5.1 域信任正交——信任只决定「非危险动作是否免确认」，危险动作永远确认。

#### 5.4.3 危险 effect 信号清单

页面级（L-1）与目标级（L-2）共用同一份信号判定，区别只在扫描范围（全页 vs 候选元素）：

| 信号 | 判定 | 为何强 |
|------|------|--------|
| 跨域 href | 元素 href 指向与当前 origin 不同的域 | 点击会离开当前信任域，几乎零误报 |
| 危险 form action | `<form action>` 域为外部/支付/删除类，或 method=POST 到非同域 | 表单提交是不可逆副作用的核心载体 |
| 危险按钮 label | textContent/aria-label 命中危险词（提交/支付/转账/删除/确认订单/卸载…） | element 真实文本，伪装不了 instruction |
| 提交型控件 | `type=submit` 或 `role=button` 且属危险 form | 提交动作的本体 |
| 文件上传/下载触发 | `type=file` 或 href 指向下载/带 `download` 属性 | 涉及本地文件系统 |

**与意图关键词的关系**：意图关键词（L-3）保留，作为 effect 检查的**补充下限**——即便页面/元素 effect 都没命中，instruction 直说「转账」仍拦。但 effect 检查是主力，关键词是兜底；口径上 effect 命中即危险，不依赖关键词。

#### 5.4.4 意图关键词（L-3，保留为兜底）

**默认关键词（中英双语，大小写不敏感）：**

| 类别 | 关键词 |
|------|--------|
| 交易/支付 | `支付`、`付款`、`转账`、`结账`、`checkout`、`pay`、`payment`、`transfer` |
| 提交/确认 | `提交订单`、`确认订单`、`place order`、`submit order`、`confirm order` |
| 删除/销毁 | `删除`、`移除`、`清空`、`delete`、`remove`、`clear`、`destroy` |
| 账号/权限 | `登录`、`登出`、`注销`、`login`、`logout`、`sign in`、`sign out`、`register`、`注册` |
| 下载/上传 | `上传`、`下载`、`upload`、`download` |
| 系统操作 | `安装`、`卸载`、`install`、`uninstall` |

**匹配规则：** instruction 小写化子串匹配，命中任一 → 强制确认。关键词列表可在设置页自定义（高级设置，默认折叠，删除时提示降级，见 §9）。

**设计理由：**
- effect 检查（L-1/L-2）覆盖「伪装意图但 effect 危险」的注入；关键词（L-3）兜底「effect 未暴露但意图直白」的情况
- 三级均为客观/文本判定，不引入 NLP/LLM 风险评估的不可预测性
- 与 `instructionGuards.assertAtomicAct` 的「单步操作」校验正交：guards 管指令文本合法性（禁子串/单步），effect 管动作后果危险性

### 5.5 会话级 act 信任的记忆时机

**与 navigate 完全一致：** 用户在确认卡片点击「确认执行」后，记忆该域名。

```typescript
// toolChatLoop.ts 中，act 确认成功后（紧邻现有 navigate 信任记忆逻辑）
if (
  outcome === 'approved' &&
  toolName === 'browser' &&
  inputObj.action === 'act'
) {
  const currentUrl = stagehandService.peekCurrentUrl(sessionId)
  if (currentUrl) {
    rememberBrowserSessionActTrust(sessionId, currentUrl)
  }
}
```

> **实现核实**：现有 navigate 信任记忆位于 `toolChatLoop.ts:1049` 附近，条件为 `browser + navigate + open + 有效 url`，调用 `rememberBrowserSessionTrustedUrl(sessionId, inputObj.url.trim())`。act 信任记忆应紧邻其后平行新增。注意：navigate 记忆的是 `inputObj.url`（用户将访问的 URL），act 记忆的是 `peekCurrentUrl`（act 所在页面的实时 URL）——两者语义不同但都正确。

**注意：** 记忆的是「确认 act 时的当前页面域名」，而非 instruction 内容。即用户确认在 `github.com` 上执行「点击 Issues」后，同会话同域名的后续 act（如「点击某个 issue」）均免确认，除非命中危险动作判定（§5.4 effect 检查或关键词）。

**危险动作不记忆信任：** 若本次 act 被 `assessActDanger` 判为危险（`danger.dangerous === true`），即便用户确认执行，也**不**记忆会话级信任（不调 `rememberBrowserSessionActTrust`）。即危险动作永远逐次确认，不被「确认一次」降级。实现：§7.4.2 记忆条件增加 `&& !dangerAssessment?.dangerous`。

### 5.6 持久化 act 信任的写入

确认卡片新增勾选项「信任此域名的操作，后续不再询问」。勾选后：

1. 渲染进程通过 `tool:confirm-response` IPC 传递 `trustActDomain: string`
2. 主进程 `appIpc.ts` 的 `tool:confirm-response` handler 新增处理（紧邻现有 `trustDomain` 分支）：
   ```typescript
   if (payload.approved && payload.trustActDomain?.trim()) {
     const { addTrustedActDomain } = await import('./browser/browserDomainTrust')
     const browser = readBrowserConfigFromDb(ctx.db)
     const next = addTrustedActDomain(browser, payload.trustActDomain.trim())
     persistBrowserConfig(ctx.db, next)
     logAgentEvent('info', 'browser.trust.actDomain', {
       domain: payload.trustActDomain.trim(),
       timestamp: Date.now()
     })
   }
   ```
3. 同时记忆会话级信任（与 navigate 一致：勾选持久化也意味着本次确认，§5.5 逻辑会自动触发）

> **实现核实**：现有 handler 位于 `electron/appIpc.ts`，已处理 `trustCommand`（Shell）与 `trustDomain`（navigate），结构清晰，新增 `trustActDomain` 分支无侵入。

### 5.7 与现有机制的协作

| 机制 | 关系 |
|------|------|
| `actRequiresConfirm === false` | 总开关关闭时，act 本就免确认，本需求不介入 |
| `actRequiresConfirm === true`（默认） | 本需求在此前提下生效：L1/L2 信任命中则免确认，否则需确认 |
| `deniedActions` 包含 `act` | executor 层拒绝，本需求不改变（信任仅跳过确认，不绕过 executor 校验） |
| Plan 探索期 | `isPlanReadonlyBrowserAction('act')` 返回 `false`，executor 拒绝；本需求不改变 |
| 推理配额 | `browserActionConsumesInference('act')` 返回 `true`，照常计数 |
| 速率限制 | `browserActionNeedsRateLimit('act')` 返回 `true`，照常限流 |
| `instructionGuards.assertSafeInstruction` | executor 内部照常校验，信任不绕过 |
| `urlSecurity.validateUrl` | act 操作不调用 validateUrl（act 不导航），本需求不影响 |
| navigate 会话级信任 | 独立存储，不混淆：`rememberBrowserSessionTrustedUrl` vs `rememberBrowserSessionActTrust` |
| `riskLevel` | act 走 `builtinToolRiskLevel`（非 shell 类），无需改动；`tool:confirm-request` 的 riskLevel 计算保持现状 |
| `autoApproveFallback` | 现有字段保留，act 确认请求照常按现状携带或省略 |

### 5.8 为何不合并 actTrustedDomains 与 trustedDomains（v2.0 新增）

navigate 的 `trustedDomains` 语义是「**允许导航到该域名**」（授权访问，偏白名单/安全边界），act 的 `actTrustedDomains` 语义是「**在该域名上操作免确认**」（信任降级，偏便捷）。两者：

- 触发场景不同：用户可能信任导航到 `bank.com`（已在白名单）但**不**希望 act 自动执行（每次确认）；反之亦然。
- 默认心智不同：navigate 白名单常由 IT/安全策略驱动，act 信任更偏个人习惯。
- 合并会导致「信任导航 = 自动信任操作」的隐式耦合，违背「保守默认」原则。

**Phase 2 演进方向**（非目标）：若后续反馈维护两份列表负担大，可引入「按 (domain, action[]) 的信任矩阵」统一抽象，届时再做迁移工具。本期保持独立。

---

## 6. 数据模型变更

### 6.1 BrowserConfig 扩展

在 `src/shared/domainTypes.ts` 的 `BrowserConfig` 接口新增 3 字段：

```typescript
export interface BrowserConfig {
  // ... 现有 28 个字段（enabled ... rateLimitMaxWaitSec）保持不变 ...

  /** act 操作的会话级信任开关（默认 true） */
  actSessionTrustEnabled: boolean

  /** act 操作的持久化信任域名列表（跨会话生效） */
  actTrustedDomains: string[]

  /** act instruction 高风险关键词（命中则强制确认，不享受信任） */
  actHighRiskKeywords: string[]
}
```

> **实现核实**：当前 `BrowserConfig` 共 28 个字段，`DEFAULT_BROWSER_CONFIG` 中 `actRequiresConfirm: true`、`navigateRequiresConfirm: true`、`trustedDomains: []`、`deniedActions: []` 均已存在；`mergeBrowserConfig` 函数存在。

### 6.2 默认值

```typescript
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  // ... 现有字段 ...
  actSessionTrustEnabled: true,
  actTrustedDomains: [],
  actHighRiskKeywords: [
    '支付', '付款', '转账', '结账',
    'checkout', 'pay', 'payment', 'transfer',
    '提交订单', '确认订单',
    'place order', 'submit order', 'confirm order',
    '删除', '移除', '清空',
    'delete', 'remove', 'clear', 'destroy',
    '登录', '登出', '注销',
    'login', 'logout', 'sign in', 'sign out', 'register', '注册',
    '上传', '下载', 'upload', 'download',
    '安装', '卸载', 'install', 'uninstall'
  ]
}
```

### 6.3 mergeBrowserConfig 兼容

`mergeBrowserConfig` 需处理旧配置缺失新字段的情况：

```typescript
actSessionTrustEnabled: partial.actSessionTrustEnabled ?? DEFAULT_BROWSER_CONFIG.actSessionTrustEnabled,
actTrustedDomains: Array.isArray(partial.actTrustedDomains)
  ? [...partial.actTrustedDomains]
  : DEFAULT_BROWSER_CONFIG.actTrustedDomains,
actHighRiskKeywords: Array.isArray(partial.actHighRiskKeywords)
  ? [...partial.actHighRiskKeywords]
  : DEFAULT_BROWSER_CONFIG.actHighRiskKeywords,
```

### 6.4 ToolConfirmOptions 扩展

`src/shared/toolConfirm.ts` 新增 `trustActDomain` 选项：

```typescript
export type ToolConfirmOptions = {
  trustCommand?: string
  trustDomain?: string       // 现有：navigate 持久化信任
  trustActDomain?: string    // 新增：act 持久化信任
}
```

> **实现核实**：当前 `ToolConfirmOptions` 仅含 `trustCommand` 与 `trustDomain`，`ToolConfirmHandler = (approved, options?) => void`。

### 6.5 PendingConfirmItem 扩展（v2.0 明确）

`src/renderer/services/pendingConfirmStore.ts` 的 `PendingConfirmItem` 需新增可选字段以承载 act 元数据（供 `BrowserConfirmCard` 展示与信任域名提取）：

```typescript
export type PendingConfirmItem = {
  sessionId: string
  requestId: string
  toolUseId: string
  toolName: string
  input: unknown
  riskLevel: ToolRiskLevel
  diff?: ToolCallRecord['confirmDiff']
  shellSecurityHints?: ShellSecurityHints
  autoApproveFallback?: AutoApproveFallback
  // 新增（仅 browser act 操作由后端附带）：
  currentPageUrl?: string     // act 所在页面实时 URL
  dangerInfo?: {              // v2.3：结构化危险信息（替代 dangerSummary/dangerSource）
    userReason: string        // 人话原因，例「跳转到其他网站 pay.example.com」
    consequence: ActDangerConsequence  // 后果类别，驱动文案与视觉档位
    source: 'page-effect' | 'target-effect' | 'keyword'  // 仅审计，前端不展示
    fillPreview?: ActFillPreview[]  // fill 类预览（敏感字段前端掩码）
  }
  sessionTrustedHint?: true   // 本会话已信任该域名但本次仍需确认
  createdAt: number
}
```

> 注意：以上字段均不写入 `input`（不作为工具实际入参传给 LLM/executor），仅用于 UI 展示与信任域名提取。`dangerInfo.fillPreview` 中的 fill 值仅展示给当前用户本人（前端掩码），不入审计日志（§7.5.1）。

---

## 7. 实现要点

### 7.1 `electron/browser/browserSessionTrust.ts`

新增 act 会话级信任的内存 Map 与操作函数（与 navigate 信任平行）：

```typescript
/** 单会话内用户已批准 act 的主机名（仅内存，删除会话即清除） */
const trustedActHostsBySession = new Map<string, Set<string>>()

export function rememberBrowserSessionActTrust(sessionId: string, url: string): void {
  const host = extractHostname(url)
  if (!host || !sessionId) return
  let set = trustedActHostsBySession.get(sessionId)
  if (!set) {
    set = new Set()
    trustedActHostsBySession.set(sessionId, set)
  }
  for (const h of hostnamesForSessionTrust(host)) {
    set.add(h)
  }
}

export function isBrowserSessionActTrustedHost(sessionId: string, hostname: string): boolean {
  const set = trustedActHostsBySession.get(sessionId)
  if (!set || set.size === 0) return false
  for (const t of set) {
    if (hostnameMatchesTrustedEntry(hostname, t)) return true
  }
  return false
}

export function listBrowserSessionActTrustedHosts(sessionId: string): string[] {
  const set = trustedActHostsBySession.get(sessionId)
  return set ? [...set] : []
}

export function clearBrowserSessionActTrust(sessionId: string): void {
  trustedActHostsBySession.delete(sessionId)
}

/** 测试用 */
export function resetBrowserSessionActTrustForTests(): void {
  trustedActHostsBySession.clear()
}
```

**会话清理：** `clearBrowserSessionTrust(sessionId)` 与 `clearBrowserSessionActTrust(sessionId)` 需在会话删除时同时调用。

> **实现核实**：现有 `clearSessionToolResources`（`toolChatLoop.ts:111` 附近）已调用 `clearBrowserSessionTrust(sessionId)`，新增 `clearBrowserSessionActTrust` 调用紧随其后即可。

### 7.2 `electron/browser/browserActionPolicy.ts` 与异步 effect 预检

#### 7.2.1 架构关键点：effect 预检是异步的

§5.4 的 L-1（页面 effect 扫描，一次 `page.evaluate`）与 L-2（observe，一次 LLM 推理）都是**异步**操作。而现有 `browserActionNeedsConfirmation` 是**同步纯函数**，在 `toolChatLoop` 确认判断点（executor 前）同步调用。

因此不能把 effect 检查塞进该同步函数。改为**拆成两段**：

- **同步部分**（保留 `browserActionNeedsConfirmation`）：做意图关键词层（L-3，零成本）+ 域信任降级（L1/L2）。这部分纯同步，签名不变（仅加 `currentPageUrl`）。
- **异步预检部分**（新增 `assessActDanger`）：在确认判断点**之前**异步执行 L-1/L-2 effect 检查，产出「是否危险 + 危险摘要」。其结果作为同步判断的输入前置条件——危险则直接 `needsConfirm = true` 并携带危险摘要，绕过域信任。

调用顺序变为（`toolChatLoop` 中）：

```typescript
// 1) 异步 effect 预检（仅对 browser act；非 act 跳过）
const dangerAssessment =
  toolName === 'browser' && inputObj.action === 'act' && browserConfig?.actRequiresConfirm
    ? await assessActDanger(sessionId, inputObj, browserConfig, stagehandService)
    : null

// 2) 同步确认判断（现在接收 dangerAssessment）
const currentPageUrl = sessionId ? stagehandService.peekCurrentUrl(sessionId) : undefined
let needsConfirm = toolNeedsUserConfirmation(
  toolName,
  inputObj,
  feishuConfig,
  browserConfig,
  sessionId,
  currentPageUrl,
  dangerAssessment   // 新增入参
)
```

#### 7.2.2 同步判断函数（含 effect 结果与域信任）

```typescript
/** 后果类别：驱动「可能后果」文案与视觉警示强度（§8.2）。仅审计/前端展示，不含敏感数据 */
export type ActDangerConsequence =
  | 'money'        // 可能造成金钱损失（支付/下单/转账）
  | 'data-loss'    // 可能删除/清空数据，通常不可逆
  | 'account'      // 可能改变登录状态（登录/登出/注册）
  | 'file'         // 可能上传/下载本地文件
  | 'unknown-site' // 可能跳转未知网站（跨域 href，钓鱼/诱导付款风险）
  | 'generic'      // 其他危险，未归类

/** fill 类操作预览项（仅危险卡片、observe 已运行时携带；敏感字段由前端掩码） */
export type ActFillPreview = {
  selector: string
  method: string   // 'fill' | 'select' 等
  value: string    // 原始填入值（前端按规则掩码后再展示，§8.2）
}

export type ActDangerAssessment = {
  dangerous: boolean
  /** 危险来源层级：仅审计日志用，不对用户展示（§8.2 隐藏 dangerSource） */
  source: 'page-effect' | 'target-effect' | 'keyword' | undefined
  /** 面向用户的通俗原因，例「跳转到其他网站 pay.example.com」「点击了『提交订单』按钮」 */
  userReason: string
  /** 后果类别，驱动「可能后果」文案与视觉档位；非危险时为 undefined */
  consequence: ActDangerConsequence | undefined
  /** 触发危险的具体信号（开发者/审计用），如跨域 href host、命中的关键词；不含 fill 值 */
  detail?: string
  /** fill 类预览（仅当 observe 已运行且候选含 fill arguments 时） */
  fillPreview?: ActFillPreview[]
}

export function browserActionNeedsConfirmation(
  action: BrowserAction,
  input: Record<string, unknown>,
  cfg: BrowserConfig,
  sessionId?: string,
  currentPageUrl?: string,
  danger?: ActDangerAssessment | null  // 新增：异步 effect 预检结果
): boolean {
  if (action === 'act') {
    if (!cfg.actRequiresConfirm) return false
    // 危险动作（effect 或关键词命中）→ 强制确认，无视信任
    if (danger?.dangerous) return true
    // 会话级信任开关关闭 → 每次确认
    if (!cfg.actSessionTrustEnabled) return true
    // 提取当前页面域名
    const host = currentPageUrl ? extractHostname(currentPageUrl) : null
    if (!host) return true
    // L1 持久化信任
    if (isTrustedDomain(host, cfg.actTrustedDomains)) return false
    // L2 会话级信任
    if (sessionId && isBrowserSessionActTrustedHost(sessionId, host)) return false
    return true
  }
  // navigate 分支不变
  if (action === 'navigate') {
    // ... 现有逻辑不变 ...
  }
  return false
}
```

> 意图关键词层（L-3）的判定也移入 `assessActDanger` 统一产出 `ActDangerAssessment`（source='keyword'），使三类危险来源一致对外；同步函数只读 `danger.dangerous`，不再自己查关键词。
>
> **v2.3 结构化变更**：原 `summary: string` 拆为 `userReason`（人话原因）+ `consequence`（后果类别）+ `detail`（审计用信号）；`source` 退化为「仅审计」，不再驱动前端文案。前端按 `userReason` + `consequence` 渲染（§8.2），杜绝 `method=post`、`跨域链接` 等开发术语泄露到界面。

#### 7.2.3 新增 `assessActDanger`（异步，effect 预检核心）

新增模块 `electron/browser/actDangerAssessor.ts`：

```typescript
import type { BrowserConfig } from '../../src/shared/domainTypes'
import type { StagehandService } from './stagehandService'
import { matchHighRiskKeyword, keywordToConsequence } from './browserActionPolicy'
import { extractHostname } from './urlSecurity'

export async function assessActDanger(
  sessionId: string,
  input: Record<string, unknown>,
  cfg: BrowserConfig,
  stagehand: StagehandService,
  signal?: AbortSignal  // 用户中止时中断 observe（见 §7.4.1.1）
): Promise<ActDangerAssessment> {
  const instruction = typeof input.instruction === 'string' ? input.instruction : ''
  const SAFE: ActDangerAssessment = { dangerous: false, source: undefined, userReason: '', consequence: undefined }

  // L-3 意图关键词层（零成本，先做）
  const kw = matchHighRiskKeyword(instruction, cfg.actHighRiskKeywords)
  if (kw) {
    return {
      dangerous: true,
      source: 'keyword',
      userReason: `指令提到「${kw}」`,
      consequence: keywordToConsequence(kw),  // 支付→money、删除→data-loss、登录→account…
      detail: kw
    }
  }

  // L-1 页面级 effect 扫描（一次 evaluate，零推理）
  let pageEffect: PageEffectScan
  try {
    pageEffect = await stagehand.scanPageEffect(sessionId) // 见 §7.3
  } catch {
    return SAFE  // 连页面都扫不了 → 无信息，退回域信任判定（§7.2.3 异常兜底）
  }
  if (!pageEffect.hasDangerousControl) {
    return SAFE  // 页面非危险 → 无需 observe，进入域信任降级
  }

  // L-2 目标级 effect 解析（一次 observe 推理，仅疑似危险页面触发）
  let targetHit: { hit: boolean; summary: string; consequence: ActDangerConsequence; fillPreview?: ActFillPreview[] } | null
  try {
    const candidates = await stagehand.observeActCandidates(sessionId, instruction, signal) // 见 §7.3
    targetHit = await stagehand.resolveCandidateEffect(sessionId, candidates) // 见 §7.3
  } catch {
    // v2.3 关键修正：L-1 已确认页面存在危险控件，但 observe 失败/超时无法精化目标 →
    // 保守判危险（source='page-effect'），而非退回信任。符合 §9.3「宁可误报不漏报」。
    return {
      dangerous: true,
      source: 'page-effect',
      userReason: pageEffectToUserReason(pageEffect),  // 例「该页面含提交类控件」
      consequence: pageEffectToConsequence(pageEffect), // 多为 money/unknown-site
      detail: pageEffect.signals[0]
    }
  }
  if (targetHit?.hit) {
    return {
      dangerous: true,
      source: 'target-effect',
      userReason: targetHit.summary,                 // 人话原因（§7.3.4 拼装）
      consequence: targetHit.consequence,
      detail: targetHit.summary,
      fillPreview: targetHit.fillPreview             // 仅 fill 类候选携带
    }
  }
  // L-1 命中但 L-2 目标安全 → 误报兜回，判定非危险
  return SAFE
}
```

**`keywordToConsequence` / `pageEffectToConsequence` / `pageEffectToUserReason`** 为共享纯函数（放 `actDangerAssessor.ts`），把命中信号映射到 §8.2 的后果类别与人话原因。关键词→后果的映射与 §5.4.4 关键词类别同源（支付/转账→`money`、删除/清空→`data-loss`、登录/登出→`account`、上传/下载→`file`，其余→`generic`）。

**成本控制**：observe 仅在 L-1 扫描命中危险控件时触发（§5.4.2）。多数 act 在无危险页面 → 零推理。疑似危险页面 → 一次 observe 推理（用户已确认值得）。

**异常兜底（v2.3 细化两级失败语义）：**
- **顶层失败**（`scanPageEffect` 抛错、实例关闭、会话不存在）：返回 `SAFE`（非危险），退回纯域信任判定——此时对页面一无所知，宁可少拦不卡死。
- **L-1 命中后 L-2 失败**（observe 超时/抛错）：**保守判危险**（`source='page-effect'`），强制确认。此时已知页面含危险控件，只是无法精化到具体目标，漏报代价高于误报。这一修正同时消除了原设计中 `source='page-effect'` 从不被产出的死值问题（§9.3）。
- observe 失败不重试，避免推理配额浪费。

#### 7.2.4 保留的关键词判定函数（供 assessActDanger 与设置页复用）

```typescript
export function isHighRiskInstruction(instruction: string, keywords: string[]): boolean {
  if (!instruction || keywords.length === 0) return false
  const lower = instruction.toLowerCase()
  return keywords.some((k) => k && lower.includes(k.toLowerCase()))
}

/** 返回命中的那个关键词（用于前端警示展示），未命中返回 undefined */
export function matchHighRiskKeyword(
  instruction: string,
  keywords: string[]
): string | undefined {
  if (!instruction || keywords.length === 0) return undefined
  const lower = instruction.toLowerCase()
  return keywords.find((k) => k && lower.includes(k.toLowerCase()))
}

/** v2.3：关键词→后果类别映射（与 §5.4.4 关键词类别同源），驱动 §8.2 后果文案 */
export function keywordToConsequence(keyword: string): ActDangerConsequence {
  const k = keyword.toLowerCase()
  if (['支付','付款','转账','结账','checkout','pay','payment','transfer',
       '提交订单','确认订单','place order','submit order','confirm order'].some(w => k.includes(w)))
    return 'money'
  if (['删除','移除','清空','delete','remove','clear','destroy'].some(w => k.includes(w)))
    return 'data-loss'
  if (['登录','登出','注销','login','logout','sign in','sign out','register','注册'].some(w => k.includes(w)))
    return 'account'
  if (['上传','下载','upload','download'].some(w => k.includes(w)))
    return 'file'
  if (['安装','卸载','install','uninstall'].some(w => k.includes(w)))
    return 'generic'
  return 'generic'
}
```

需新增 import：`isBrowserSessionActTrustedHost` from `./browserSessionTrust`，`isTrustedDomain`、`extractHostname` from `./urlSecurity`。

> **注意**：`navigate` 分支保持原样，不引入 effect 检查，避免影响已稳定的 navigate 行为。

### 7.3 `electron/browser/stagehandService.ts`

新增以下方法。除 `peekCurrentUrl` 同步外，effect 检查三件套为异步。

#### 7.3.1 `peekCurrentUrl`（同步只读，见 §5.3）

```typescript
peekCurrentUrl(sessionId: string): string | undefined {
  try {
    const internal = this.sessions.get(sessionId)
    if (!internal) return undefined
    const pages = internal.state.stagehand.context.pages()
    const page = pages[0]
    return page ? page.url() : undefined
  } catch {
    return undefined
  }
}
```

#### 7.3.2 `scanPageEffect`（L-1 页面级 effect 扫描，异步、零推理）

一次 `page.evaluate`，扫描页面所有 form 与可点元素的危险 effect 信号（§5.4.3）。不创建实例、不触发导航。

```typescript
async scanPageEffect(sessionId: string): Promise<PageEffectScan> {
  const internal = this.sessions.get(sessionId)
  const page = internal?.state.stagehand.context.pages()[0]
  if (!page) return { hasDangerousControl: false, signals: [] }
  return await page.evaluate(() => {
    // 在浏览器上下文执行；返回危险信号清单
    const currentOrigin = location.origin
    const signals: string[] = []
    const DANGER_WORDS = ['提交','支付','付款','转账','结账','删除','移除','清空',
      '确认订单','提交订单','登录','注销','上传','下载','安装','卸载',
      'submit','pay','payment','transfer','checkout','delete','remove','clear',
      'login','logout','sign in','sign out','register','upload','download','install','uninstall']
    // 跨域链接 / 危险 form action / 危险按钮 label / submit 型控件 / 文件下载上传
    document.querySelectorAll('a[href]').forEach((el) => {
      const a = el as HTMLAnchorElement
      try {
        const u = new URL(a.href, location.href)
        if (u.origin !== currentOrigin) signals.push(`跨域链接: ${a.textContent?.trim().slice(0,40)} → ${u.host}`)
      } catch { /* ignore */ }
    })
    document.querySelectorAll('form').forEach((f) => {
      const action = f.getAttribute('action') || ''
      const method = (f.getAttribute('method') || 'get').toLowerCase()
      try {
        if (action && new URL(action, location.href).origin !== currentOrigin)
          signals.push(`外部表单: method=${method} action=${action}`)
      } catch { /* ignore */ }
    })
    document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]').forEach((el) => {
      const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().toLowerCase()
      if (DANGER_WORDS.some((w) => label.includes(w.toLowerCase())))
        signals.push(`危险按钮: ${label.slice(0,40)}`)
    })
    document.querySelectorAll('input[type=file],a[download]').forEach(() => signals.push('文件上传/下载控件'))
    return { hasDangerousControl: signals.length > 0, signals: signals.slice(0, 20) }
  })
}
```

> `DANGER_WORDS` 与 §5.4.4 关键词列表同源；实施时从配置注入，避免两份硬编码不一致。

#### 7.3.3 `observeActCandidates`（L-2 目标级，异步、一次 LLM 推理）

调用 `stagehand.observe(instruction)` 取候选 `Action[]`。**消耗一次推理配额**——需经 `stagehandService.incrementAndCheck` 计数（与正常 act 同等待遇，防止绕过配额）。

```typescript
async observeActCandidates(sessionId: string, instruction: string, signal?: AbortSignal): Promise<Action[]> {
  const internal = this.sessions.get(sessionId)
  if (!internal) return []
  // 推理配额计数（与 executor act 一致，见 browserExecutor.ts:184）
  // 注意：observe 是否消耗配额由 browserActionConsumesInference('observe') 决定（当前返回 true）
  const result = signal
    ? await raceWithUserAbort(internal.state.stagehand.observe(instruction), signal)
    : await internal.state.stagehand.observe(instruction)
  return Array.isArray(result) ? (result as unknown as Action[]) : []
}
```

> **核实依据**：`ObserveResult = Action[]`，`Action{selector,description,method?,arguments?}`（`methods.d.ts:82,31-36`）。`browserActionConsumesInference('observe')` 返回 `true`（`browserActionPolicy.ts:30`），故 observe 本就计配额。

#### 7.3.4 `resolveCandidateEffect`（L-2 目标 effect 落地，异步、零推理）

对 observe 返回的每个候选 selector，用 `page.$(selector).evaluate()` 读其真实 href/form-action/label，判定是否命中 §5.4.3 危险信号。

```typescript
async resolveCandidateEffect(
  sessionId: string,
  candidates: Action[]
): Promise<{
  hit: boolean
  summary: string             // 人话原因（§8.2 userReason），例「跳转到其他网站 pay.example.com」
  consequence: ActDangerConsequence
  fillPreview?: ActFillPreview[]  // 仅当候选含 method=fill 且有 arguments 时
} | null> {
  const internal = this.sessions.get(sessionId)
  const page = internal?.state.stagehand.context.pages()[0]
  if (!page || candidates.length === 0) return null
  const fillPreview: ActFillPreview[] = []
  for (const c of candidates.slice(0, 5)) { // 仅查前 5 个候选，控制成本
    try {
      // 同时收集 fill 预览（不论是否命中危险，供 §8.2 展示）
      if (c.method === 'fill' && typeof c.arguments === 'string') {
        fillPreview.push({ selector: c.selector, method: 'fill', value: c.arguments })
      }
      const el = await page.$(c.selector)
      if (!el) continue
      const eff = await el.evaluate((node) => {
        const e = node as HTMLElement
        const href = (e as HTMLAnchorElement).href || ''
        const formAction = e.closest('form')?.getAttribute('action') || ''
        const label = (e.textContent || e.getAttribute('aria-label') || '').trim()
        const type = e.getAttribute('type') || ''
        return { href, formAction, label: label.slice(0, 60), type }
      })
      // 命中跨域 href / 危险 form action / 危险 label / submit → 返回人话原因 + 后果类别
      const hit = isDangerousElementEffect(eff, page.url())
      if (hit) {
        return {
          hit: true,
          summary: elementEffectToUserReason(eff),          // 人话，例「跳转到其他网站 pay.example.com」
          consequence: elementEffectToConsequence(eff),     // 跨域→unknown-site、提交订单→money、删除→data-loss…
          fillPreview: fillPreview.length ? fillPreview : undefined
        }
      }
    } catch { /* 单个候选失败跳过，继续下一个 */ }
  }
  // 目标全部安全：仍可能返回已收集的 fillPreview 供误报兜回路径使用（本设计下不展示，故返回 null）
  return null
}
```

> `isDangerousElementEffect` / `elementEffectToUserReason` / `elementEffectToConsequence` 与 §7.3.2 的 `DANGER_WORDS` 同源判定逻辑，抽到共享纯函数（`actDangerAssessor.ts`），避免浏览器上下文与主进程两份。`elementEffectToUserReason` 负责把 `method=post action=/checkout` 这类开发属性翻译成「提交订单到 shop.example.com」等人话（§8.2）。

#### 7.3.5 `peekCurrentUrl` 之外的说明

> 不新增 `recordLastUrl`、不写入 `StagehandSessionState.lastUrl`。`lastUrl` 字段保持现状（仅 `resolveRateLimitDomain` 读取，当前恒空，act 限流走 `page.url()` 兜底——本需求不改变该行为）。

#### 7.3.6 方向 3：act 实际操作元素与事后 URL 捕获

方向 3 在执行后捕获，需改 `browserExecutor`（见 §7.5）。stagehandService 仅提供事后 URL 查询复用 `peekCurrentUrl`；act 返回值捕获在 executor 内进行。

### 7.4 `electron/toolChatLoop.ts`

#### 7.4.1 异步 effect 预检 + 确认判断

`toolNeedsUserConfirmation` 同步签名新增 `danger` 入参；act 分支的 effect 预检在调用前异步完成（见 §7.2.1）。

```typescript
function toolNeedsUserConfirmation(
  toolName: string,
  inputObj: Record<string, unknown>,
  feishuConfig: FeishuConfig | undefined,
  browserConfig: BrowserConfig | undefined,
  sessionId: string | undefined,
  currentPageUrl: string | undefined,  // 新增
  danger: ActDangerAssessment | null   // 新增：异步 effect 预检结果
): boolean {
  if (toolName === 'browser' && browserConfig) {
    const action = inputObj.action
    if (typeof action !== 'string') return true
    return browserActionNeedsConfirmation(
      action as BrowserAction,
      inputObj,
      browserConfig,
      sessionId,
      currentPageUrl,
      danger
    )
  }
  // ... 其余分支不变 ...
}
```

调用处（确认判断前，先异步预检，并推送进度态）：

```typescript
// 1) 异步 effect 预检（仅 browser act）
let dangerAssessment: ActDangerAssessment | null = null
if (
  toolName === 'browser' &&
  inputObj.action === 'act' &&
  browserConfig?.actRequiresConfirm &&
  sessionId
) {
  // 预检可能触发一次 observe 推理（数百 ms~数秒），先推进度态避免「确认卡迟迟不弹」的卡顿感
  sendProgress('analyzing_risk', '正在检查本次操作…')
  try {
    dangerAssessment = await assessActDanger(sessionId, inputObj, browserConfig, stagehandService, signal)
  } catch {
    dangerAssessment = null  // 兜底：预检异常不阻塞，退回纯域信任判定
  }
}

// 2) 同步确认判断
const currentPageUrl = sessionId ? stagehandService.peekCurrentUrl(sessionId) : undefined
let needsConfirm = toolNeedsUserConfirmation(
  toolName,
  inputObj,
  feishuConfig,
  browserConfig,
  sessionId,
  currentPageUrl,
  dangerAssessment
)
```

> **实现核实**：现有调用点位于 `runToolChatSessionInner` 中 executor 调用前（约 `toolChatLoop.ts:879`），`sessionId` 与 `stagehandService` 均在该作用域可用。该调用点本就在 async 函数内，加 `await assessActDanger` 无需改函数签名。
>
> **取消信号**：`assessActDanger` 应接受 `ctx.signal`（用户点「中止」时中断 observe 推理），避免中止后仍空跑一次推理。observe 内部需 race 用户 abort。
>
> **进度态推送的时序约束（已核实）**：现有 `sendProgress` 闭包定义于 `toolChatLoop.ts:1099`，在 `needsConfirm` 计算点（`:879`）**之后**——预检点拿不到该闭包。两种实现方式任选其一：
> - 方式 A（推荐）：将 `sendProgress` 闭包**上提**到 `:879` 之前，使预检与 executor 共用同一推送函数；
> - 方式 B：预检点直接用 `safeWebContentsSend(sender, 'tool:progress', {...})` 推送，绕过闭包。
> 推荐方式 A，保持 progress 推送链路单一。`sender`/`requestId`/`toolUseId` 在 `:879` 作用域均可用，上提无依赖问题。预检进度态 `analyzing_risk` 在确认卡片弹出前展示，确认卡片弹出后由卡片 UI 接管（见 §8.6）。

#### 7.4.1.1 `assessActDanger` 签名（含 signal）

```typescript
export async function assessActDanger(
  sessionId: string,
  input: Record<string, unknown>,
  cfg: BrowserConfig,
  stagehand: StagehandService,
  signal?: AbortSignal  // 用户中止时中断 observe
): Promise<ActDangerAssessment>
```

observe 调用需 `raceWithUserAbort`（复用 `toolExecutionResource`），中止时抛 `isUserAbortError` → 由 §7.4.1 的 try/catch 兜底为 `null`，外层按 `toolChatLoop` 现有中止处理返回 `CHAT_CANCELLED_MESSAGE`。

#### 7.4.2 act 确认成功后记忆会话级信任

在现有 `rememberBrowserSessionTrustedUrl` 调用旁（`toolChatLoop.ts:1049` 附近）新增：

```typescript
if (
  outcome === 'approved' &&
  toolName === 'browser' &&
  inputObj.action === 'act' &&
  !dangerAssessment?.dangerous   // 危险动作不记忆会话级信任（§5.5）
) {
  const currentUrl = stagehandService.peekCurrentUrl(sessionId)
  if (currentUrl) {
    rememberBrowserSessionActTrust(sessionId, currentUrl)
  }
}
```

#### 7.4.3 会话清理

`clearSessionToolResources`（`toolChatLoop.ts:111` 附近）中同时清除 navigate 与 act 的会话级信任：

```typescript
clearBrowserSessionTrust(sessionId)
clearBrowserSessionActTrust(sessionId)
```

#### 7.4.4 `tool:confirm-request` payload 附带 act 元数据

发送确认请求时，对 `browser` `act` 操作附带当前页面 URL、高风险命中关键词、会话级信任命中提示（约 `toolChatLoop.ts:927-937`）：

```typescript
// dangerAssessment 来自 §7.4.1 的异步预检（含 keyword/target-effect/page-effect 三类危险来源）
const actDanger =
  toolName === 'browser' && inputObj.action === 'act' && dangerAssessment?.dangerous
    ? dangerAssessment
    : null
const actCurrentHost = currentPageUrl ? extractHostname(currentPageUrl) : null
// 会话已信任该域名（L2），但本次仍确认（因危险 effect/关键词 或 L3 无信任）→ 前端辅助文案
const sessionTrustedHint =
  !!actCurrentHost &&
  !!sessionId &&
  !actDanger &&
  isBrowserSessionActTrustedHost(sessionId, actCurrentHost)
    ? true
    : undefined

// v2.3：结构化 dangerInfo（人话原因 + 后果类别 + 仅审计的 source + fill 预览），
// 替代原 dangerSummary(string)/dangerSource。前端只读、不复算（方案 A）。
const dangerInfo = actDanger
  ? {
      userReason: actDanger.userReason,
      consequence: actDanger.consequence ?? 'generic',
      source: actDanger.source,            // 仅审计用，前端不展示（§8.2 隐藏 dangerSource）
      ...(actDanger.fillPreview?.length ? { fillPreview: actDanger.fillPreview } : {})
    }
  : undefined

safeWebContentsSend(sender, 'tool:confirm-request', {
  requestId,
  toolUseId,
  toolName,
  input: inputObj,
  riskLevel:
    toolName === 'run_script' || toolName === 'run_lark_cli' || toolName === 'run_shell'
      ? 'high'
      : 'medium',
  ...(toolName === 'browser' && inputObj.action === 'act'
    ? {
        ...(currentPageUrl ? { currentPageUrl } : {}),
        ...(dangerInfo ? { dangerInfo } : {}),
        ...(sessionTrustedHint ? { sessionTrustedHint } : {})
      }
    : {}),
  ...(diff ? { diff } : {}),
  ...(shellSecurityHints ? { shellSecurityHints } : {}),
  ...(autoApproveFallback ? { autoApproveFallback } : {})
})
```

**act 专属可选字段的含义（v2.3 更新）：**

| 字段 | 类型 | 含义 | 前端用途 |
|------|------|------|----------|
| `currentPageUrl` | `string` | act 所在页面实时 URL | 提取信任域名、卡片展示「当前页面」 |
| `dangerInfo` | `{ userReason, consequence, source, fillPreview? }` | 结构化危险信息（人话原因 + 后果类别 + 仅审计 source + fill 预览） | 渲染警示标题/人话原因/可能后果句/两档视觉/fill 预览；隐藏勾选框 |
| `dangerInfo.source` | `'page-effect' \| 'target-effect' \| 'keyword'` | 危险来源层级 | **仅审计用，前端不展示**（§8.2） |
| `dangerInfo.fillPreview` | `ActFillPreview[]` | fill 类候选将填入的值 | 危险卡展示「将填入：…」（敏感字段前端掩码） |
| `sessionTrustedHint` | `true` | 本会话已信任该域名（但本次仍需确认） | 显示「本会话已信任…本次操作较为敏感，仍需确认」辅助文案 |

> **危险判定方案 A（已定，v2.3 强化）**：effect + 关键词判定**只在后端算一次**（`assessActDanger`，见 §7.2.3），结果以结构化 `dangerInfo` 捎带给前端。前端只读取 `userReason`/`consequence`/`fillPreview` 渲染，不持有、不复算关键词或 effect 规则，杜绝后端/前端不一致与开发术语泄露。原 OQ-7 据此收口。

#### 7.4.5 静默放行的 inline 反馈（v2.3 新增，P1）

当 act 因信任命中而 `needsConfirm === false`（自动执行、不弹卡）时，在调用 executor 前推送一条非阻断 inline 提示，闭合 US-07「突然不问」的预期断层（§8.5）：

```typescript
// toolChatLoop.ts 中，needsConfirm === false 且为 browser act 且非危险时
if (
  toolName === 'browser' &&
  inputObj.action === 'act' &&
  !needsConfirm &&
  !dangerAssessment?.dangerous &&
  currentPageUrl
) {
  const host = extractHostname(currentPageUrl)
  const persistent = host ? isTrustedDomain(host, browserConfig?.actTrustedDomains ?? []) : false
  // 仅会话级/持久化信任命中才提示；actRequiresConfirm=false（总开关关闭）不提示，避免噪音
  const sessionTrusted = host && sessionId ? isBrowserSessionActTrustedHost(sessionId, host) : false
  if (host && (persistent || sessionTrusted)) {
    sendProgress('trust_auto_approved', `已信任「${host}」的常规操作，自动执行（敏感操作仍会询问）`)
  }
}
```

**说明：**
- `trust_auto_approved` 复用现有 `tool:progress` → 渲染卡片展示链路（§8.6），仅新增一个 status 值，非阻断、可被后续 `acting` 进度态覆盖。
- `actRequiresConfirm === false`（总开关关闭）导致的免确认**不提示**——那是用户全局配置，非信任命中，提示反成噪音。
- 提示在 executor 的 `acting` 之前推送，用户能看到「自动执行」的因果关系，把「不问」从警报还原为便捷。

### 7.5 `electron/tools/browserExecutor.ts`（方向 3：捕获实际操作元素与事后变化）

当前 `stagehand.act(instruction)` 的返回值在 `browserExecutor.ts:396-399` 被 `await` 后**直接丢弃**——act 实际点中了哪个元素、填了什么值、是否触发了导航，全部丢失，无从审计。方向 3 补齐这块。

#### 7.5.1 捕获 act 返回的 actions

`ActResult` 含 `actions: Action[]`（`methods.d.ts:21-27`），每个 `Action{selector,description,method?,arguments?}` 精确记录「点了哪个 selector、做了什么（click/fill/select）、填了什么值」。改造 act 分支捕获之：

```typescript
// browserExecutor.ts act 分支（现 :395-409）
ctx.sendProgress('acting', instruction.slice(0, 120))
const urlBefore = page.url()
const actResult = await raceWithUserAbort(
  withTimeout(stagehand.act(instruction), navTimeout, 'act'),
  ctx.signal
) as { success?: boolean; actions?: Action[] } | undefined
const urlAfter = page.url()
const navigated = urlAfter !== urlBefore

logAgentEvent('info', 'browser.action', {
  requestId: ctx.requestId,
  sessionId: ctx.sessionId,
  toolUseId: ctx.toolUseId,
  action: 'act',
  instruction: instruction.slice(0, 200),
  actedActions: (actResult?.actions ?? []).map((a) => ({
    method: a.method, selector: a.selector, description: a.description?.slice(0, 80)
  })),
  navigated,
  ...(navigated ? { urlAfter } : {}),
  result: 'success',
  durationMs: Date.now() - started
})
return {
  success: true,
  data: { acted: true, navigated, actions: actResult?.actions?.length ?? 0 },
  duration: Date.now() - started
}
```

> **脱敏**：`arguments`（fill 的实际值，可能含密码/卡号）**不记入日志**，仅记 method/selector/description。审计可追溯「点了什么、是否跳转」，不留敏感输入。

#### 7.5.2 事后 effect 一致性告警（可选增强）

若 `navigated === true` 且跳转后的域与 `assessActDanger` 判定的「安全目标」不符，记一条 `browser.act.effectMismatch` 告警日志。这是对 effect 预检的事后校验——预检说安全，实际却跳到了意料外的域，说明 observe 候选与 stagehand 实际选择不一致，值得回溯。本期可只记日志不阻断。

> **核实依据**：`ActResult` 结构（`methods.d.ts:21-27`）、现有 act 调用点（`browserExecutor.ts:396-399`）、`logAgentEvent` 用法（同文件 :400-408）均已核实。方向 3 不改变 act 执行行为，仅捕获返回值，零功能回归风险。

### 7.6 `electron/browser/browserDomainTrust.ts`

新增 act 持久化信任的操作函数（与 navigate 的 `addTrustedDomain`/`removeTrustedDomains` 平行）：

```typescript
export function addTrustedActDomain(config: BrowserConfig, domain: string): BrowserConfig {
  const d = domain.trim().toLowerCase()
  if (!d) return config
  const set = new Set((config.actTrustedDomains ?? []).map((x) => x.toLowerCase()))
  set.add(d)
  return { ...config, actTrustedDomains: [...set] }
}

export function removeTrustedActDomains(config: BrowserConfig, domains: string[]): BrowserConfig {
  const remove = new Set(domains.map((d) => d.toLowerCase()))
  return {
    ...config,
    actTrustedDomains: (config.actTrustedDomains ?? []).filter((d) => !remove.has(d.toLowerCase()))
  }
}
```

### 7.7 `electron/appIpc.ts`

`tool:confirm-response` IPC handler 新增 `trustActDomain` 处理（见 §5.6）。payload 类型扩展：

```typescript
payload: {
  requestId: string
  toolUseId: string
  approved: boolean
  trustCommand?: string
  trustDomain?: string
  trustActDomain?: string  // 新增
}
```

### 7.8 `src/renderer/components/Chat/BrowserConfirmCard.tsx`

act 操作也显示信任勾选项。关键改动：

```tsx
const action = typeof record.input.action === 'string' ? record.input.action : ''
const mode = typeof record.input.mode === 'string' ? record.input.mode : 'open'

// navigate(open) 的域名来自 input.url；act 的域名来自当前页面 URL（由后端在 confirm-request 时附带）
const trustableDomain = useMemo(() => {
  if (action === 'navigate' && mode === 'open') {
    return urlValue && urlValue !== '(未指定 URL)' ? extractTrustableDomain(urlValue) : null
  }
  if (action === 'act') {
    const pageUrl = typeof record.currentPageUrl === 'string' ? record.currentPageUrl : ''
    return pageUrl ? extractTrustableDomain(pageUrl) : null
  }
  return null
}, [action, mode, urlValue, record.currentPageUrl])

// 危险动作不显示信任勾选项：直接读后端附带的 dangerInfo（方案 A，前端不复算）
const dangerInfo = record.dangerInfo
const isDangerous = action === 'act' && Boolean(dangerInfo)
// v2.3：视觉档位由 consequence 决定（§8.2 两档）
const STRONG_CONSEQUENCES = ['money', 'data-loss', 'unknown-site'] as const
const isStrongDanger = isDangerous && dangerInfo && (STRONG_CONSEQUENCES as readonly string[]).includes(dangerInfo.consequence)
// 会话已信任该域名但本次仍需确认（如危险 effect/关键词 或无信任）→ 显示辅助文案
const sessionTrustedHint = record.sessionTrustedHint === true
const canTrust = !isDangerous && ((action === 'navigate' && mode === 'open') || action === 'act')
const canTrustDomain = canTrust && Boolean(trustableDomain)

// fill 预览值掩码（§8.2）：卡号/长数字→末4，密码类→••••••，其余原样
function maskFillValue(value: string): string {
  if (/\d{8,}/.test(value)) return '****' + value.slice(-4)
  return value
}

const handleConfirm: ToolConfirmHandler = (approved, options) => {
  if (approved && trustChecked && canTrustDomain && trustableDomain) {
    if (action === 'act') {
      onConfirm(approved, { ...options, trustActDomain: trustableDomain })
    } else {
      onConfirm(approved, { ...options, trustDomain: trustableDomain })
    }
    return
  }
  onConfirm(approved, options)
}
```

**渲染要点（v2.3）：**
- 标题统一「🌐 浏览器操作」（navigate 卡为「浏览器导航」），不暴露 `act`。
- 危险卡片警示区按 `dangerInfo` 渲染三段：固定标题「⚠️ 本次操作需要你确认」+ `userReason`（人话原因）+ 按 `consequence` 查表的「可能后果」句（§8.2 表）；**不展示 `dangerInfo.source`**。
- 视觉档位：`isStrongDanger` → 红底强警示；其余危险 → 橙底次级警示。
- `dangerInfo.fillPreview` 非空时，在截图下方渲染「将填入：…」，每项值经 `maskFillValue` 掩码。
- 勾选框下方常驻「定心丸」小字（§8.1）。
- `sessionTrustedHint` 为真时，卡片底部渲染「本会话已信任该域名的常规操作；本次操作较为敏感，仍需你确认。」（去黑话）。

> **实现核实**：现有 `canTrustDomain = action === 'navigate' && mode === 'open' && Boolean(trustDomain)`，act 分支不显示勾选。改动为 act 也允许，并新增危险动作（`dangerInfo` 非空）时不显示。
>
> **危险标识传递采用方案 A（已定，v2.3 强化）**：effect + 关键词判定**只在后端算一次**（§7.2.3 `assessActDanger`），结果通过 `tool:confirm-request` 的结构化 `dangerInfo` 捎带给前端。前端只读取 `userReason`/`consequence`/`fillPreview`、不持有也不复算 effect 规则或关键词列表，杜绝后端/前端不一致与开发术语泄露。同理 `sessionTrustedHint` 也由后端附带。

### 7.9 设置页

在 `src/renderer/components/Config/BrowserSettingsTab.tsx` 的「可信域名」分区下方新增「act 操作信任域名」分区：

```
┌─────────────────────────────────────────────────────────────┐
│ act 操作信任域名（访问时无需确认，跨会话生效）                │
│ ─────────────────────────────────────────────────────────── │
│ ☐ github.com                           2026-06-18 添加      │
│ ☐ docs.example.com                     2026-06-15 添加      │
│                                                           │
│ [添加域名]    [批量删除]                                    │
│                                                           │
│ [✓] 启用 act 会话级信任（首次确认后，同会话同域名免确认）    │
│                                                           │
│ ▸ 高级：高风险关键词（命中则强制确认）                       │
│   [支付, 转账, 提交订单, 删除, 登录, ...]                   │
│   [恢复默认]                                                │
└─────────────────────────────────────────────────────────────┘
```

> **实现核实**：现有 `BrowserSettingsTab.tsx` 已实现 navigate `trustedDomains` 的添加（`patch({ trustedDomains: [...] })`）与批量删除，act 信任域名管理复用同一交互模式，分别 patch `actTrustedDomains`。

**说明：**
- 「act 操作信任域名」与「可信域名」（navigate）独立展示，避免混淆
- 「启用 act 会话级信任」开关默认开启
- 「高风险关键词」默认折叠，展开后可编辑（逗号分隔）与恢复默认

### 7.10 分阶段实施顺序（v2.2 更新，v2.3 补充 UI 通俗化范围）

为降低风险、支持灰度验证，按以下阶段交付：

| 阶段 | 范围 | 交付物 | 可独立验证 |
|------|------|--------|-----------|
| **P0** | act 会话级信任核心 | §7.3.1 `peekCurrentUrl`、§7.1 act 会话信任、§7.2.2 同步判断（无 danger）、§7.4.1–7.4.3、§7.4.5 静默放行提示、§8.1 普通卡（标题去 act + 定心丸） | 同会话同域名连续 act 仅首次确认；自动执行有 inline 提示 |
| **P1** | 危险动作识别（effect 两级 + 关键词） | §7.2.3 `assessActDanger`（结构化 `dangerInfo`）、§7.3.2 `scanPageEffect`、§7.3.3 `observeActCandidates`、§7.3.4 `resolveCandidateEffect`、§5.4 两级判定、§6 默认关键词、§7.8 危险卡片（人话原因 + 后果句 + 两档视觉 + fill 预览、隐藏 source） | 危险动作无视信任强制确认；疑似危险页面触发一次 observe；L-2 失败保守判 page-effect |
| **P2** | 持久化 act 信任 + 方向 3 捕获 | §6.4 `ToolConfirmOptions`、§7.6 `addTrustedActDomain`、§7.7 IPC、§7.8 act 信任勾选项（非危险才显示）、§6.5 `PendingConfirmItem`、§7.4.4 payload、§7.5 `browserExecutor` 捕获 `ActResult.actions` + 事后 URL | 跨会话免确认；act 实际操作可审计 |
| **P3** | 设置页管理 + i18n + 审计 + 事后告警 | §7.9 设置页、§14 i18n（v2.3 结构化后果/定心丸/静默提示 key）、§10 审计日志、§7.5.2 `effectMismatch` 告警 | 可视化管理、日志与事后回溯 |

P0 即可解决用户核心痛点（同会话反复确认）；P1 是安全兜底的核心（effect 检查使域信任不再可怕，应在持久化信任 P2 之前完成）；P2–P3 补齐持久化信任、审计与可见性。每个阶段均应附带对应测试（§12.4）。

> **依赖提示**：P1 的 effect 检查必须先于 P2 的持久化信任落地——否则 L1 跨会话信任在没有 effect 兜底时风险过高。即 P0 → P1 → P2 → P3 顺序不可调换。
>
> **v2.3 通俗化改动的阶段归属**：定心丸（§8.1）与静默放行提示（§7.4.5）随 P0 落地（核心体验）；危险卡片的人话原因/后果句/两档视觉/fill 预览随 P1 落地（依赖 `dangerInfo`）；i18n 新 key 随 P3 落地。

---

## 8. UI 与交互设计

### 8.1 act 确认卡片（核心变更）

非危险动作（effect 三级全不命中）的卡片：

```
┌─────────────────────────────────────────────────────────────┐
│ 🌐 浏览器操作                    ⏳ 确认中                   │
│ ─────────────────────────────────────────────────────────── │
│ 指令：点击 Issues 标签                                      │
│ 当前页面：https://github.com/foo/bar                        │
│ [📷 页面截图]                                               │
│                                                           │
│ [✓] 信任此域名的操作，后续不再询问                          │
│     仅对常规操作（点击、翻页、填写）免确认；                 │
│     支付、转账、删除等敏感操作仍会每次询问。                 │
│                                                           │
│    [✓ 确认执行]    [✗ 拒绝]                                │
└─────────────────────────────────────────────────────────────┘
```

**与 navigate 确认卡片的差异：**
- 标题：「🌐 浏览器操作」（不再暴露内部动作枚举 `act`；navigate 卡片对应「浏览器导航」）
- 详情：显示「指令」「当前页面」与「页面截图」（而非「URL」）
- 信任勾选项文案：「信任此域名的操作，后续不再询问」（navigate 是「信任此域名，后续不再询问」）
- 信任域名来源：当前页面 URL（navigate 是 input.url）
- 截图：act 确认卡附带当前页面截图（direction 1 的可见性收益，复用 `page.screenshot`，`:423` 已有实现）

**勾选框下方的「定心丸」说明（v2.3 新增，P0）：**

勾选框正下方补一行小字：「仅对常规操作（点击、翻页、填写）免确认；支付、转账、删除等敏感操作仍会每次询问。」

这句话把方案最大的安全卖点（§5.5：危险动作永不记忆信任）直接说给用户，同时实现两个产品目标：
- ①降低勾选顾虑——让用户敢勾，提升便捷价值达成率；
- ②校准预期——避免用户盲勾后遇敏感操作仍弹窗时产生「我不是信任了吗」的困惑。

**目标元素高亮与 fill 预览的适用范围（v2.3 明确，独立判断）：**

评审建议普通卡片也高亮目标元素、预览 `fill` 将填入的值。但 §5.4 的核心成本保证是「无危险页面零推理、不跑 observe」——目标 selector 与 `fill` 的 `arguments` 只能通过 `stagehand.observe` 获得。若为每个普通 act 都跑 observe 高亮，会破坏零推理保证并给每次确认增加数百 ms~数秒延迟。因此：

- **普通卡片（非危险动作）：维持截图，不跑 observe、不高亮、不预览 fill 值。** 截图 + 指令文本是零成本下最强的判断辅助。
- **危险卡片（observe 已运行）：高亮目标元素 + 预览 fill 值**（见 §8.2）。这恰好覆盖最需要人眼复核的高风险场景。

> 该取舍在 §12 体验验收 E1（连续 5 个普通 act 零额外 observe 推理）中体现为不变量，不得因高亮需求而破坏。

### 8.2 危险动作的确认卡片（effect 命中）

当后端 `assessActDanger` 判定 `dangerous === true` 时（页面/目标/意图三级任一命中），卡片**不显示**信任勾选项，并在顶部展示分级警示。警示内容由后端附带的**结构化 `dangerInfo`** 驱动（§7.4.4），前端只读取、不复算：

```
┌─────────────────────────────────────────────────────────────┐
│ 🌐 浏览器操作                    ⏳ 确认中                   │
│ ╔══════════════════════════════════════════════════════════╗  ← 强警示：红底
│ ║ ⚠️ 本次操作需要你确认                                     ║
│ ║ 跳转到其他网站 pay.example.com                           ║
│ ║ 可能跳转到一个未知网站，存在钓鱼或被诱导付款的风险。       ║
│ ╚══════════════════════════════════════════════════════════╝
│ ─────────────────────────────────────────────────────────── │
│ 指令：点击 提交订单 按钮                                    │
│ 当前页面：https://shop.example.com/cart                     │
│ [📷 页面截图（含目标元素高亮）]                              │
│ 将填入：卡号 ****1234、姓名 张三（敏感字段已掩码）           │  ← 仅 fill 类且 observe 已运行时
│                                                           │
│    [✓ 我了解风险，确认执行]    [✗ 拒绝]                    │
└─────────────────────────────────────────────────────────────┘
```

**警示区结构（三段，均由 `dangerInfo` 渲染）：**

1. **标题**：固定「⚠️ 本次操作需要你确认」——**不暴露 `dangerSource` 分层**（页面元素/目标元素/指令关键词对用户决策无价值，三种来源动作完全相同，展示反增疑惑）。`dangerSource` 只保留在审计日志（§10）。
2. **人话原因（`dangerInfo.userReason`）**：后端 `assessActDanger` 直接产出通俗短句，例如：
   - 跨域 href →「跳转到其他网站 pay.example.com」
   - 危险 form/提交订单 →「提交订单到 shop.example.com」
   - 危险按钮 label →「点击了『提交订单』按钮」
   - 关键词命中 →「指令提到『转账』」
   - 隐藏 `method`、`action`、`form`、`跨域` 等技术词（这些只进 `detail`/审计）。
3. **可能后果（`dangerInfo.consequence` 驱动）**：按后果类别补一句小白能懂的「会怎样」，这是 v2.3 的核心补充（评审 P0）：

| `consequence` | 人话原因典型场景 | 可能后果文案 | 视觉档位 |
|---------------|------------------|--------------|----------|
| `unknown-site` | 跨域 href 跳转 | 「可能跳转到一个未知网站，存在钓鱼或被诱导付款的风险。」 | 强警示（红底） |
| `money` | 危险 form/提交订单/支付/转账 | 「可能导致实际付款或下单，造成金钱损失。」 | 强警示（红底） |
| `data-loss` | 删除/清空/移除类 | 「可能删除数据，且通常无法撤销。」 | 强警示（红底） |
| `account` | 登录/登出/注册类 | 「可能登录或退出账号，改变你的登录状态。」 | 次级警示（橙底） |
| `file` | 文件上传/下载控件 | 「可能上传或下载文件，涉及本地文件。」 | 次级警示（橙底） |
| `generic` | 未归类的危险信号 | 「该操作存在一定风险，请确认后再执行。」 | 次级警示（橙底） |

**两档视觉强度（v2.3 新增，P2）：** 涉及金钱/不可逆删除/未知网站的强警示用红底 + 醒目图标；账号/文件类用次级橙底。让用户注意力分配与真实后果成正比，缓解「一串红框」导致的脱敏（狼来了效应）。

**`fill` 类操作预览将填入的值（v2.3 新增，P2）：** 当 observe 已运行（即危险卡片）且候选 `Action` 含 `method=fill` 与 `arguments` 时，在截图下方展示「将填入：…」。敏感字段掩码规则：
- 卡号/长数字串（含 8 位以上连续数字）→ 仅显示末 4 位，前缀 `****`；
- 字段 label 含「密码/口令/password」→ 显示为 `••••••`；
- 其余（姓名、邮箱等）原样显示便于核对。

> 展示给当前用户本人与「记入日志」是两回事：§7.5.1 仍保证 `arguments` 不入审计日志；此处仅为确认前预览。普通卡片不跑 observe，故不预览（§8.1 说明）。

> 危险动作卡片**永不显示信任勾选项**——即使用户强行确认，也只放行本次，不记忆会话级/持久化信任（见 §5.5：仅非危险动作确认后才记忆信任）。

### 8.3 信任成功提示

勾选信任并确认后，Toast 提示：

```
✓ 已信任「github.com」的浏览器操作，后续不再询问。
  可在设置页管理信任列表。
```

### 8.4 设置页布局

「网络访问」子 Tab 配置项顺序更新（在现有「可信域名」下方插入）：

1. 允许飞书远程会话使用
2. 运行环境检测（含 BrowserSetupGuide）
3. 操作引擎（Stagehand）
4. 可信域名（navigate）
5. **act 操作信任域名**（新增）
6. **启用 act 会话级信任**（新增，开关）
7. **高风险关键词**（新增，折叠的高级设置）
8. 允许 HTTP
9. 无头模式
10. 操作超时（秒）
11. 空闲自动关闭浏览器组件，释放内存（秒）
12. 禁用操作

### 8.5 会话级信任的可见性与撤销（v2.0 新增，v2.3 优化）

**可见性**：会话级 act 信任是内存态，用户无法在设置页看到（设置页只展示持久化的 `actTrustedDomains`）。为满足 US-07 的心理预期一致性，提供两类轻量可见性：

- **再次确认时（因危险动作或首次仍弹卡）**：在 act 确认卡片底部，若该域名**已在当前会话被信任**，显示一行辅助文案。v2.3 去黑话：「本会话已信任该域名的常规操作；本次操作较为敏感，仍需你确认。」（原版「命中危险动作判定」改为「本次操作较为敏感」）。
- **静默放行时（v2.3 新增，P1）**：当 act 因会话级/持久化信任命中而**自动执行、不再弹卡**时，在工具调用卡片内推送一条**非阻断** inline 提示：「已在本会话信任 github.com 的常规操作，自动执行（敏感操作仍会询问）。」

  **为何要补这条反馈**：原版只为「再次弹卡」设计了提示，没解决「不再弹卡」时的预期断层。注重安全的小白用户面对「第一次问我、之后突然不问」会产生「它怎么不问了？是不是失控了？」的恐慌。这条提示让用户知道「不问」是预期行为且有安全兜底，把「警报」还原为「便捷」。实现见 §7.4.5。

两条文案均由后端在 `tool:confirm-request`（`sessionTrustedHint`）或 `tool:progress`（`trust_auto_approved` status）附带，避免渲染层直接访问主进程内存。

**撤销**：会话级信任**不支持单项手动撤销**（NG8）。理由：
- 会话级信任本质是「本会话内便捷降级」，生命周期与会话绑定，删会话即清除。
- 引入单项撤销需额外的 UI 与状态管理，收益有限；用户若需「停止信任某域名」，可删除会话或在设置页管理持久化信任。
- 持久化信任（L1）支持随时在设置页删除。

### 8.6 危险分析进度态（v2.2 新增，v2.3 措辞中性化）

effect 预检的 L-2 observe 会花一次 LLM 推理（数百 ms~数秒）。这段时间用户在等「确认卡片弹出」，若无反馈会感到卡顿。故在预检期间推送进度态。

**时序**：
```
Agent 发起 act
  → 后端 assessActDanger 开始
  → 推送 sendProgress('analyzing_risk', '正在检查本次操作…')
  → [L-1 扫描] 若命中危险控件 → [L-2 observe 推理，可见 spinner]
  → 预检结束，按结果：
      ├─ 免确认（信任命中、非危险）→ 推 'acting'，直接执行
      └─ 需确认 → 弹出确认卡片（卡片 UI 接管，进度态结束）
```

**渲染层展示**：
- 收到 `tool:progress` 且 `status === 'analyzing_risk'` 时，在工具调用卡片显示 spinner + 文案「正在检查本次操作…」。v2.3 将原「正在分析页面风险…」中性化——「风险」二字在无危险场景里会制造紧张，而该 spinner 在 L-1 不命中时也会短暂出现（仅一次 evaluate，通常 <100ms），中性措辞更平稳。
- 确认卡片弹出（`tool:confirm-request`）后，进度态自然被卡片 UI 取代，无需显式清除。
- 免确认直接执行时，`analyzing_risk` 由后续 `acting` 进度态覆盖（与现有 navigate `navigating`→`acting` 链路一致）。

**安抚说明（低优先级）**：偶发较长的 observe 等待（数秒）可能让小白误以为卡死。可在 spinner 文案旁补「（正在确认是否需要你确认）」之类安抚语，属体验打磨，非阻塞。

**进度态不阻塞**：`analyzing_risk` 纯展示，用户「中止」按钮始终可用（中止时 `assessActDanger` 经 `signal` 中断 observe，外层返回取消）。

**与现有 progress 链路的一致性**：复用 `toolChatLoop` 的 `sendProgress` → `tool:progress` IPC → 渲染卡片展示（`browserExecutor.ts:370/380/395` 的 `observing`/`extracting`/`acting` 同链路）。仅新增一个 `analyzing_risk` status 值，前端按现有 status 渲染逻辑展示，无需新 IPC 通道。v2.3 另新增 `trust_auto_approved` status（§8.5 静默放行提示），同链路推送。

**飞书远程会话**：`analyzing_risk` 与 `trust_auto_approved` 的 message 经现有 `publishFeishuRemoteProgress`（`toolChatLoop.ts:1130`）同步推送，远程用户同样可见。

---

## 9. 安全与权限

### 9.1 安全边界

| 风险类型 | 缓解措施 |
|----------|----------|
| 信任域名后 Agent 执行危险操作（提示注入伪装意图） | §5.4 两级 effect 检查（页面级 + 目标级）+ 意图关键词兜底，危险动作无视信任强制确认、不记忆信任。effect 检查对象是页面/元素客观属性，注入可伪装 instruction 但伪装不了元素真实 href |
| 信任域名被滥用（如 XSS 跳转到恶意域名） | act 信任按实时页面域名判定，跳转到新域名即重新确认；navigate 到新域名仍走 navigate 确认；危险 form/跨域 href 被 effect 检查捕获 |
| 用户误勾选持久化信任 | 勾选后有 Toast 提示；设置页可随时删除 |
| 信任列表无限增长 | 持久化信任由用户主动维护，不自动添加；会话级信任删除会话即清除 |
| instruction 注入 | `instructionGuards.assertSafeInstruction` 照常执行（文本层）；effect 检查（动作层）与之正交，双重防线 |
| 多步指令绕过单步限制 | `assertAtomicAct` 照常执行 |
| Plan 探索期误执行 act | `isPlanReadonlyBrowserAction('act')` 返回 `false`，executor 拒绝 |
| 推理配额耗尽 | `browserActionConsumesInference('act')` 返回 `true`，照常计数；effect 预检的 observe 也计配额 |
| 速率限制绕过 | `browserActionNeedsRateLimit('act')` 返回 `true`，照常限流 |
| observe 预检与 stagehand 实际选择不一致 | 方向 3 事后捕获 `ActResult.actions` + URL 变化，记 `effectMismatch` 告警可回溯 |
| 危险判定误报（effect 命中但目标实际安全） | L-1 页面级粗筛 → L-2 目标级 observe 精化兜回误报；L-2 仍命中才强制确认 |
| 危险判定漏报（页面无危险控件但动作仍有害） | effect 检查为尽力而为的提示，非绝对安全边界；关键词层与 instructionGuards 互补；用户可自定义关键词加严 |

### 9.2 信任不绕过的校验清单

以下校验在 act 信任命中（免确认）时**仍然执行**：

| 校验 | 位置 | 说明 |
|------|------|------|
| `assertSafeToolInput('browser', input)` | `toolChatLoop.ts` | action 枚举、instruction 必填与长度 |
| `shouldBlockToolInPlanMode` | `toolChatLoop.ts` | Plan 探索期不拦截（executor 内部拒绝） |
| `browserConfig.enabled` | `browserExecutor.ts` | 总开关 |
| `browserConfig.deniedActions` | `browserExecutor.ts` | act 被禁用则拒绝 |
| `instructionGuards.assertSafeInstruction` | `browserExecutor.ts` | 长度、禁止子串、单步操作 |
| `stagehandService.incrementAndCheck` | `browserExecutor.ts` | 推理配额 |
| `rateLimitService.acquire` | `browserExecutor.ts` | 速率限制 |
| `isPlanReadonlyBrowserAction` | `browserExecutor.ts` | Plan 只读白名单 |

### 9.3 effect 检查与关键词的局限性（v2.2 更新）

**已知局限：** effect 检查（页面级/目标级）与意图关键词均为**尽力而为的提示，非绝对安全边界**：
- effect 检查依赖 DOM 静态属性（href/form action/label），无法覆盖「元素无危险标记但点击触发 JS 逻辑危险」的场景（如 `onclick` 调用扣款 API 的普通按钮）。
- 关键词无法覆盖语义等价的有害措辞（「点击那个会扣款的按钮」未命中关键词）。
- observe 候选可能与 stagehand 实际 act 选择不一致（预检的目标 ≠ 实际点中的目标）。

**缓解：**
- 两级 effect + 关键词三层叠加，覆盖面远大于单一关键词方案
- 方向 3 事后捕获 `ActResult.actions` + URL 变化，`effectMismatch` 告警可回溯「预检与实际不符」的个案
- 默认关键词与危险 label 词表保守偏严（宁可误报强制确认，不漏报）
- 用户可自定义关键词加严
- 危险动作不记忆信任：即便用户确认一次危险动作，也不降级为免确认，避免「确认一次→后续自动」的信任外溢
- **v2.3：L-1 命中后 L-2 observe 失败/超时 → 保守判危险（`source='page-effect'`），不退回信任**。已知页面含危险控件时，宁可误报强制确认也不放行。仅顶层失败（连 L-1 扫描都做不了、对页面一无所知）才退回域信任判定，避免卡死。
- 未来可在 Phase 2 引入 LLM 风险评估（非目标 NG5）

---

## 10. 审计日志

| 事件 | 记录内容 |
|------|----------|
| act 会话级信任命中（免确认） | `browser.act.sessionTrust.hit` → `{sessionId, host, instruction}` |
| act 持久化信任命中（免确认） | `browser.act.persistentTrust.hit` → `{sessionId, host, instruction}` |
| act 危险动作命中（强制确认） | `browser.act.danger.hit` → `{sessionId, source, userReason, consequence, instruction}` |
| act effect 预检触发 observe（疑似危险页面） | `browser.act.danger.observeTriggered` → `{sessionId, pageEffectSignals}` |
| act 确认成功并记忆会话级信任 | `browser.act.sessionTrust.remember` → `{sessionId, host}` |
| act 危险动作确认但未记忆信任 | `browser.act.danger.confirmedNoTrust` → `{sessionId, source, userReason, consequence}` |
| act 信任命中自动执行（静默放行，v2.3） | `browser.act.trustAutoApproved` → `{sessionId, host, layer: 'session'|'persistent'}` |
| act 实际操作元素与事后变化（方向 3） | `browser.action`（action=act）扩展 `actedActions`/`navigated`/`urlAfter`，`arguments` 不记 |
| act 预检与实际不符（事后告警） | `browser.act.effectMismatch` → `{sessionId, expectedSafe, urlAfter}` |
| 持久化 act 信任添加 | `browser.trust.actDomain` → `{domain, timestamp}` |
| 持久化 act 信任删除 | `trust.remove` → `{type: 'actDomain', item, timestamp}` |
| act 会话级信任开关切换 | `browser.act.sessionTrust.toggle` → `{enabled, timestamp}` |
| 高风险关键词修改 | `browser.act.highRiskKeywords.change` → `{count, timestamp}` |

**日志脱敏：** instruction 内容可能包含用户隐私，日志中 instruction 字段经 `sanitizeForLog` 截断至 200 字符，不记录完整内容。

---

## 11. 配置迁移与兼容

### 11.1 旧配置加载

`mergeBrowserConfig` 处理缺失的新字段（见 §6.3）：

- `actSessionTrustEnabled` 缺失 → 默认 `true`
- `actTrustedDomains` 缺失 → 默认 `[]`
- `actHighRiskKeywords` 缺失 → 默认关键词列表

### 11.2 与现有配置的关系

| 字段 | 关系 |
|------|------|
| `trustedDomains`（navigate） | 独立于 `actTrustedDomains`，不混淆（理由见 §5.8） |
| `actRequiresConfirm` | 总开关；本需求在其为 `true` 时引入信任降级 |
| `navigateRequiresConfirm` | 不受影响 |
| `deniedActions` | 优先级最高，act 被禁用则根本不执行 |

### 11.3 不做的事

- 不自动将 `trustedDomains` 迁移到 `actTrustedDomains`（语义不同，用户需分别建立信任）
- 不自动将 `actTrustedDomains` 迁移到 `trustedDomains`（同上）

---

## 12. 验收标准与测试矩阵

### 12.1 功能验收

| # | 场景 | 预期 |
|---|------|------|
| 1 | 同会话首次 act（域名 A） | 弹出确认卡片 |
| 2 | 同会话首次 act 确认后，同域名 A 的后续 act | 免确认，直接执行 |
| 3 | 同会话同域名 A 的子域 act | 免确认（子域匹配生效） |
| 4 | 同会话不同域名 B 的 act | 弹出确认卡片 |
| 5 | act instruction 命中「提交订单」（意图关键词层） | 弹出确认卡片，无信任勾选项，显示危险警示（source=keyword） |
| 6 | 危险 act 确认后，同会话同域名再次执行同 instruction | 仍弹出确认卡片（危险动作不记忆信任、不享受信任） |
| 7 | act 确认卡片勾选「信任此域名的操作」（非危险动作） | 该域名写入 `actTrustedDomains`，跨会话免确认 |
| 8 | 删除会话后，新会话访问同域名 act | 弹出确认卡片（会话级信任已清除） |
| 9 | 删除会话后，新会话访问已持久化信任的域名 act | 免确认（持久化信任仍在） |
| 10 | 设置页关闭「启用 act 会话级信任」 | 同会话同域名 act 每次都确认（仅 L1 持久化信任生效） |
| 11 | `actRequiresConfirm === false` | act 本就免确认，本需求不介入 |
| 12 | `deniedActions` 包含 `act` | act 被 executor 拒绝，信任不绕过 |
| 13 | Plan 探索期 act | executor 拒绝，信任不绕过 |
| 14 | 推理配额耗尽 | act 返回配额错误，信任不绕过 |
| 15 | 首次操作前（无 navigate 记录）执行 act | 弹出确认卡片（无当前页面 URL） |
| 16 | 设置页删除 act 信任域名 | 该域名后续 act 重新确认 |
| 17 | act 在某页面执行时 `peekCurrentUrl` 返回实时 URL（v2.1） | act 信任据实时页面域名判定，与 act 执行所在页面一致 |
| 18 | 会话级信任命中但本次判为危险（v2.2） | 仍确认，卡片显示「本会话已信任该域名」辅助文案 + 危险警示 |
| 19 | 页面存在跨域 href / 危险 form（L-1 命中，v2.2） | 触发一次 observe 推理；目标元素命中则强制确认（source=target-effect） |
| 20 | 页面有危险控件但 observe 目标实际安全（L-1 命中、L-2 不命中） | 不强制确认，走域信任降级（误报被 L-2 兜回） |
| 21 | 无危险控件的页面执行 act（L-1 不命中） | 不触发 observe（零推理），走域信任降级 |
| 22 | 注入：instruction 无害但目标 href 跨域（v2.2） | effect 检查命中 → 强制确认，即便 instruction 无关键词、域已信任 |
| 23 | act 实际执行后跳转到新域（方向 3） | 记 `ActResult.actions` + `navigated` + `urlAfter`；与预检不符记 `effectMismatch` |
| 24 | 危险 act 卡片渲染（v2.3） | 警示标题固定「本次操作需要你确认」；展示 `dangerInfo.userReason` 人话原因 + 按 `consequence` 的「可能后果」句；**不展示** `dangerInfo.source` |
| 25 | 危险 act 视觉分档（v2.3） | `consequence`∈{money,data-loss,unknown-site}→红底强警示；{account,file,generic}→橙底次级警示 |
| 26 | 信任命中自动执行（v2.3） | 会话级/持久化信任命中免确认时，推送 `trust_auto_approved` inline 提示「已信任…自动执行（敏感操作仍会询问）」；`actRequiresConfirm=false` 免确认不提示 |
| 27 | fill 类危险操作预览（v2.3） | 危险卡（observe 已运行）展示「将填入：…」；含 8 位以上连续数字→`****末4`；密码类→`••••••` |
| 28 | L-1 命中但 L-2 observe 失败（v2.3） | 保守判 dangerous（`source='page-effect'`），强制确认，不退回信任 |
| 29 | 普通卡片零 observe（v2.3 不变量） | 无危险页面 act 不跑 observe，不高亮、不预览 fill；截图 + 指令为唯一判断辅助 |

### 12.2 安全验收

| # | 场景 | 预期 |
|---|------|------|
| S1 | act instruction 含 `page.evaluate` | executor 抛出「指令含禁止子串」，信任不绕过 |
| S2 | act instruction 含「然后」 | executor 抛出「act 指令须为单步操作」，信任不绕过 |
| S3 | act instruction 超过 1024 字符 | executor 抛出「指令过长」，信任不绕过 |
| S4 | 信任域名 A 后，navigate 到域名 B | navigate 走自身确认流程，act 信任不跨域 |
| S5 | SPA 内跳转到新域名后执行含「登录」的 act | 实时 `page.url()` 已变新域名，不在信任集 → effect/关键词强制确认 |
| S6 | 注入：instruction=`点击下一页`，目标 href 跨域到 pay.example.com（v2.2） | L-1 跨域 href 命中 → observe → L-2 目标 effect 命中 → 强制确认（source=target-effect），即便域已信任、instruction 无关键词 |
| S7 | 危险动作确认后，同会话同域再次执行 | 不记忆信任，仍确认（dangerAssessment.dangerous 时跳过 remember） |
| S8 | act 实际跳转到预检未判定的域 | 记 `browser.act.effectMismatch` 告警（不阻断） |

### 12.3 体验验收

| # | 场景 | 预期 |
|---|------|------|
| E1 | 在 github.com 连续执行 5 个 act（无危险） | 仅首次确认，后续 4 次免确认，全程零额外 observe 推理（L-1 不命中） |
| E2 | 危险指令在信任域名上执行 | 仍弹出确认卡片，有警示，无信任勾选项 |
| E3 | 设置页管理 act 信任域名 | 可查看、添加、删除 |
| E4 | 信任成功后有 Toast 提示 | 提示文案正确 |
| E5 | 会话级信任命中后再次因危险确认 | 卡片显示辅助文案 + 危险警示，心理预期一致 |
| E6 | 疑似危险页面的 act 确认卡 | 附带页面截图（含目标元素高亮），便于人判断（direction 1 可见性） |
| E7 | 疑似危险页面的 act 预检期间（v2.2，v2.3 文案中性化） | 卡片弹出前显示「正在检查本次操作…」spinner，不卡顿；中止按钮可用 |
| E8 | 信任命中自动执行（v2.3） | 工具卡片显示「已信任…自动执行（敏感操作仍会询问）」非阻断提示，用户不恐慌 |
| E9 | 危险卡片后果与分档（v2.3） | 不同后果显示对应「可能后果」句；金钱/删除/未知网站红底、账号/文件橙底，视觉与后果成正比 |
| E10 | 危险卡 fill 预览（v2.3） | fill 类操作展示「将填入：…」，卡号末4掩码、密码掩码，便于确认前核对 |

### 12.4 测试文件用例清单（v2.2 更新）

| 测试文件 | 最小用例 |
|----------|----------|
| `electron/browser/browserActionPolicy.test.ts`（扩展） | act 无信任→确认；act 会话级信任命中→免确认；act 持久化信任命中→免确认；act danger.dangerous→确认（无视信任）；`actSessionTrustEnabled=false`→每次确认；`actRequiresConfirm=false`→免确认；无 currentPageUrl→确认；L1 优先于 L2；danger 优先于信任 |
| `electron/browser/actDangerAssessor.test.ts`（新增） | 关键词命中→source=keyword 且 `consequence` 正确（支付→money、删除→data-loss、登录→account）；L-1 不命中→不调 observe、dangerous=false；L-1 命中→调 observe；L-2 命中→source=target-effect 且产出 `userReason`+`consequence`+`fillPreview`；L-1 命中但 L-2 不命中→dangerous=false（误报兜回）；**L-1 命中但 observe 抛错/超时→dangerous=true、source=page-effect（v2.3 保守判定）**；顶层 scanPageEffect 抛错→dangerous=false 不阻塞；`userReason` 不含 `method`/`action`/`跨域` 等开发术语；observe 计推理配额 |
| `electron/browser/browserSessionTrust.test.ts`（扩展） | `rememberBrowserSessionActTrust` 记忆；`isBrowserSessionActTrustedHost` 子域匹配；`listBrowserSessionActTrustedHosts` 返回；`clearBrowserSessionActTrust` 清除；与 navigate 信任隔离（互不影响） |
| `electron/browser/browserDomainTrust.test.ts`（扩展） | `addTrustedActDomain` 去重与小写化；`removeTrustedActDomains` 批量删除；不影响 `trustedDomains` |
| `electron/browser/stagehandService.test.ts`（新增/扩展） | `peekCurrentUrl` 返回当前 `page.url()`，会话不存在/无页面/异常时返回 `undefined`，同步无副作用；`scanPageEffect` 识别跨域 href/危险 form/危险 label；`observeActCandidates` 支持 signal 中断；`resolveCandidateEffect` 命中危险返回 `{hit, summary, consequence, fillPreview}`、候选安全返回 null |
| `electron/tools/browserExecutor.test.ts`（新增/扩展） | act 返回值捕获 `actedActions`/`navigated`/`urlAfter`；`arguments` 不入日志；navigate=false 时无 urlAfter |
| `electron/toolChatLoop.test.ts`（扩展，若存在） | act 前 `await assessActDanger` 且先推 `analyzing_risk` 进度态（文案「正在检查本次操作…」）；预检异常兜底为 null 不阻塞；危险时不记忆会话信任；`clearSessionToolResources` 同时清除两类信任；`tool:confirm-request` 对 act 携带 `currentPageUrl`/`dangerInfo`/`sessionTrustedHint`（不再有 `dangerSummary`/`dangerSource`）；信任命中免确认时推 `trust_auto_approved`、总开关关闭免确认不推 |
| `src/renderer/components/Chat/BrowserConfirmCard.test.tsx`（扩展） | 非危险 act 显示信任勾选项 + 定心丸小字；act 勾选后传 `trustActDomain`；危险（`dangerInfo` 非空）时不显示勾选、渲染 `userReason`+后果句、**不展示 source**、按 `consequence` 分红/橙两档；`fillPreview` 经掩码展示（长数字→末4、密码类→••••••）；act 从 `currentPageUrl` 提取域名；会话信任命中危险时显示辅助文案 |
| `src/shared/domainTypes.test.ts`（若存在） | `mergeBrowserConfig` 缺失新字段时回退默认；`DEFAULT_BROWSER_CONFIG` 新字段正确 |

---

## 13. 相关文件

### 13.1 需修改的文件

| 文件 | 改动 |
|------|------|
| `src/shared/domainTypes.ts` | `BrowserConfig` 新增 3 字段；`DEFAULT_BROWSER_CONFIG`、`mergeBrowserConfig` 更新 |
| `src/shared/toolConfirm.ts` | `ToolConfirmOptions` 新增 `trustActDomain` |
| `electron/browser/browserActionPolicy.ts` | `browserActionNeedsConfirmation` 扩展 act 分支与签名（加 `danger` 入参）；保留 `isHighRiskInstruction`/`matchHighRiskKeyword`；新增 `keywordToConsequence`；新增 `ActDangerAssessment`/`ActDangerConsequence`/`ActFillPreview` 类型 |
| `electron/browser/actDangerAssessor.ts`（新增） | `assessActDanger` 异步两级 effect 预检（关键词→页面级→目标级 observe），产出结构化 `{source, userReason, consequence, detail, fillPreview}`；L-2 失败保守判 `page-effect`；含 `pageEffectToUserReason`/`pageEffectToConsequence`/`elementEffectToUserReason`/`elementEffectToConsequence` 等共享纯函数 |
| `electron/browser/browserSessionTrust.ts` | 新增 act 会话级信任的 Map 与函数（含 `listBrowserSessionActTrustedHosts`） |
| `electron/browser/browserDomainTrust.ts` | 新增 `addTrustedActDomain`、`removeTrustedActDomains` |
| `electron/browser/stagehandService.ts` | 新增 `peekCurrentUrl`、`scanPageEffect`、`observeActCandidates`（含 signal）、`resolveCandidateEffect`（返回结构化 `{hit, summary, consequence, fillPreview}`） |
| `electron/tools/browserExecutor.ts` | act 分支捕获 `ActResult.actions` + 事后 `page.url()` 变化，记审计日志（方向 3）；可选 `effectMismatch` 告警 |
| `electron/toolChatLoop.ts` | act 前 `await assessActDanger`；`toolNeedsUserConfirmation` 传入 `currentPageUrl`/`danger`；危险时不记忆会话级信任；会话清理；`tool:confirm-request` 附带 `currentPageUrl`/`dangerInfo`/`sessionTrustedHint`（方案 A）；信任命中免确认时推 `trust_auto_approved`（§7.4.5） |
| `electron/appIpc.ts` | `tool:confirm-response` handler 处理 `trustActDomain` |
| `src/renderer/services/pendingConfirmStore.ts` | `PendingConfirmItem` 新增 `currentPageUrl`/`dangerInfo`（结构化）/`sessionTrustedHint` |
| `src/renderer/components/Chat/BrowserConfirmCard.tsx` | 标题去 `act` 黑话；非危险 act 显示信任勾选项 + 定心丸小字；危险（读 `dangerInfo`）时不显示勾选、渲染 `userReason`+后果句（不展示 source）、按 `consequence` 红橙两档、`fillPreview` 掩码展示；读 `sessionTrustedHint` 显示辅助文案；附页面截图 |
| `src/renderer/components/Chat/browserConfirmDisplay.ts` | act summary 增加「当前页面」展示；危险标识 |
| `src/renderer/components/Config/BrowserSettingsTab.tsx` | 新增 act 信任域名管理、会话级信任开关、高风险关键词编辑（删除提示降级） |
| `src/renderer/i18n/resources/zh-CN/*.json` 与 `en-US/*.json` | 新增文案 key |

### 13.2 需新增/扩展的测试文件

见 §12.4。

---

## 14. 多语言资源规划

### 14.1 新增 i18n key

> 命名遵循 CLAUDE.md 规范：`模块.组件.语义` 层级，camelCase，最多 4 层。`zh-CN` 为真实来源，新增后运行 `npm run i18n:generate-types`，提交前运行 `npm run i18n:check`。

**命名空间：`config`（设置页）**

| Key | zh-CN |
|-----|-------|
| `config.browser.actTrustTitle` | `act 操作信任域名` |
| `config.browser.actTrustHelper` | `在这些域名上的浏览器操作无需确认，跨会话生效。` |
| `config.browser.actTrustAdd` | `添加域名` |
| `config.browser.actTrustEmpty` | `暂无信任的 act 域名` |
| `config.browser.actSessionTrustEnable` | `启用 act 会话级信任` |
| `config.browser.actSessionTrustHelper` | `首次确认后，同会话同域名的后续 act 操作自动放行。` |
| `config.browser.actHighRiskTitle` | `高风险关键词` |
| `config.browser.actHighRiskHelper` | `命中以下关键词的 act 指令将强制确认，不享受任何信任。` |
| `config.browser.actHighRiskReset` | `恢复默认` |
| `config.browser.actHighRiskPlaceholder` | `逗号分隔，如：支付, 转账, 删除` |

**命名空间：`chat`（确认卡片）**

| Key | zh-CN |
|-----|-------|
| `chat.confirm.browserActTitle` | `浏览器操作` |
| `chat.confirm.browserActTrust` | `信任此域名的操作，后续不再询问` |
| `chat.confirm.browserActTrustSafety` | `仅对常规操作（点击、翻页、填写）免确认；支付、转账、删除等敏感操作仍会每次询问。` |
| `chat.confirm.browserDangerTitle` | `本次操作需要你确认` |
| `chat.confirm.browserDangerReason` | `{{reason}}`（占位渲染 `dangerInfo.userReason`，如「跳转到其他网站 pay.example.com」） |
| `chat.confirm.browserDangerConsequenceMoney` | `可能导致实际付款或下单，造成金钱损失。` |
| `chat.confirm.browserDangerConsequenceDataLoss` | `可能删除数据，且通常无法撤销。` |
| `chat.confirm.browserDangerConsequenceAccount` | `可能登录或退出账号，改变你的登录状态。` |
| `chat.confirm.browserDangerConsequenceFile` | `可能上传或下载文件，涉及本地文件。` |
| `chat.confirm.browserDangerConsequenceUnknownSite` | `可能跳转到一个未知网站，存在钓鱼或被诱导付款的风险。` |
| `chat.confirm.browserDangerConsequenceGeneric` | `该操作存在一定风险，请确认后再执行。` |
| `chat.confirm.browserDangerFillPreview` | `将填入：{{values}}` |
| `chat.confirm.browserCurrentPage` | `当前页面` |
| `chat.confirm.browserActTrustSuccess` | `已信任「{{domain}}」的浏览器操作，后续不再询问。可在设置页管理信任列表。` |
| `chat.confirm.browserSessionTrustedHint` | `本会话已信任该域名的常规操作；本次操作较为敏感，仍需你确认。` |
| `chat.progress.browserAnalyzingRisk` | `正在检查本次操作…` |
| `chat.progress.browserTrustAutoApproved` | `已信任「{{domain}}」的常规操作，自动执行（敏感操作仍会询问）。` |
| `config.browser.actHighRiskRemoveWarn` | `删除关键词将降低对自动操作的保护，确定？` |

> **v2.3 i18n 变更**：删除原 `browserDangerWarnKeyword`/`WarnPage`/`WarnTarget`（开发术语拼接）与 `browserDangerSourcePage`/`SourceTarget`/`SourceKeyword`（来源分层不对用户展示）。新增 `browserActTrustSafety`（定心丸）、`browserDangerReason` + 6 个 `browserDangerConsequence*`（结构化后果）、`browserDangerFillPreview`、`browserActTitle`、`browserTrustAutoApproved`。`browserAnalyzingRisk` 文案中性化。新增 key 后运行 `npm run i18n:generate-types`，提交前运行 `npm run i18n:check`。

### 14.2 类型生成

新增 key 后运行 `npm run i18n:generate-types` 更新类型；提交前运行 `npm run i18n:check` 确保 key 对齐、JSON 合法。

---

## 15. 待解决问题与核实记录

### 15.1 实现事实核实记录（v2.0 新增）

| 文档引用 | 核实来源 | 结论 |
|----------|----------|------|
| act 分支仅看 `actRequiresConfirm` | `electron/browser/browserActionPolicy.ts:13-15` | ✅ 准确 |
| navigate 分支已有两层信任 | `browserActionPolicy.ts:16-25` | ✅ 准确 |
| 会话级信任仅 navigate | `electron/browser/browserSessionTrust.ts`（`trustedHostsBySession`） | ✅ 准确，act 信任需新增 |
| 持久化信任仅 navigate | `electron/browser/browserDomainTrust.ts`（`addTrustedDomain`/`removeTrustedDomains`） | ✅ 准确 |
| `stagehand` 持有可读实时 URL 的实例 | `stagehandService.ts:21-42`（`context.pages()` + `page.url()` 同步） | ✅ 准确，`peekCurrentUrl` 据此实现，无需 lastUrl |
| 确认记忆位置 | `toolChatLoop.ts:1049` 附近 | ✅ 准确 |
| 会话清理位置 | `toolChatLoop.ts:111` `clearSessionToolResources` | ✅ 准确 |
| confirm-request payload 字段 | `toolChatLoop.ts:927-937` | ✅ 准确 |
| `tool:confirm-response` handler | `electron/appIpc.ts`（trustCommand/trustDomain 分支） | ✅ 准确 |
| `BrowserConfirmCard` act 不显示信任 | `canTrustDomain` 含 `action === 'navigate'` | ✅ 准确 |
| `PendingConfirmItem` 结构 | `src/renderer/services/pendingConfirmStore.ts` | ✅ 准确 |
| `BrowserConfig` 字段 | `src/shared/domainTypes.ts`（28 字段） | ✅ 准确 |
| `ToolConfirmOptions` | `src/shared/toolConfirm.ts`（trustCommand/trustDomain） | ✅ 准确 |
| 设置页组件 | `src/renderer/components/Config/BrowserSettingsTab.tsx` | ✅ 准确 |
| urlSecurity 函数签名 | `electron/browser/urlSecurity.ts` | ✅ 准确 |
| `resolveRateLimitDomain` 对 act 用 `page.url()`（`lastUrl` 恒空兜底） | `browserActionPolicy.ts:42-58` + `browserExecutor.ts:253` | ✅ 准确；本需求不写入 lastUrl，act 信任与限流均用实时 `page.url()`，行为一致 |
| `stagehand.observe` 返回候选 Action[] | `node_modules/.../methods.d.ts:82` `ObserveResult = Action[]`；`Action{selector,description,method?,arguments?}`（:31-36） | ✅ 准确；L-2 目标级 effect 解析据此实现 |
| `stagehand.act` 返回 ActResult.actions | `methods.d.ts:21-27` `ActResult{success,actions:Action[],...}` | ✅ 准确；方向 3 据此捕获实际操作元素 |
| act 返回值当前被丢弃 | `browserExecutor.ts:396-399`（`await stagehand.act` 后未取返回值） | ✅ 准确；方向 3 补捕获 |
| observe 消耗推理配额 | `browserActionConsumesInference('observe')` 返回 `true`（`browserActionPolicy.ts:30`） | ✅ 准确；effect 预检 observe 计配额 |
| instructionGuards 为文本层校验 | `electron/browser/instructionGuards.ts`（长度/禁子串/单步） | ✅ 准确；与 effect 检查（动作层）正交，不冲突 |
| `page.evaluate`/`page.screenshot` 可用 | `browserExecutor.ts:284`（evaluate 已用）、`:423`（screenshot 已用） | ✅ 准确；L-1 扫描与确认卡截图复用 |

### 15.2 待解决问题

| # | 问题 | 优先级 | 备注 |
|---|------|--------|------|
| OQ-2 | 高风险关键词列表是否需要支持正则表达式？ | 低 | 当前仅子串匹配；若用户反馈不够灵活再考虑 |
| OQ-3 | 是否需要「会话级信任过期」机制（如 30 分钟无操作后失效）？ | 低 | 当前与 navigate 一致，会话存活期内有效；可后续按需引入 |
| OQ-4 | act 信任是否应该按「页面路径」细分（如信任 `github.com/issues` 但不信任 `github.com/settings`）？ | 低 | 当前按域名，与 navigate 一致；路径级信任复杂度高，暂不引入 |
| OQ-5 | 飞书远程会话是否需要支持 act 信任？ | 中 | 当前飞书会话默认不注入 browser；若未来支持，需评估远程确认流程 |
| OQ-8 | `fillPreview` 敏感字段掩码启发式是否足够？（v2.3 新增） | 中 | 当前规则：8 位以上连续数字→末4、label 含密码类→`••••••`。可能误掩非敏感长数字（如订单号）或漏掩（如分段输入的卡号）。需上线后据真实表单反馈调整，或改用字段 `type`/`autocomplete` 属性判定 |

> 原 OQ-1（lastUrl 与 page.url() 不一致）与 OQ-6（补写 lastUrl 对 rateLimit 副作用）已于 v2.1 因改用实时 `page.url()` 方案而消解。
> 原 OQ-7（危险标识传递方案 A/B）已定方案 A（后端 `assessActDanger` 算一次，以结构化 `dangerInfo` 附带 `userReason`/`consequence`/`source`(仅审计)/`fillPreview` + `sessionTrustedHint`，前端不复算），见 §7.4.4 与 §7.8。v2.3 进一步把 `dangerSummary`/`dangerSource` 重构为 `dangerInfo`。
