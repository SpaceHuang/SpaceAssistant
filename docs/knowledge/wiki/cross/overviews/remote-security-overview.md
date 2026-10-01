---
pageType: overview
origin: authored
covers: [p-drivers, p-delivery, p-workspace, p-storage, s-safety, s-capability, p-host-adapters]
boundary: cross
status: active
sourceDocs:
  - docs/analyze/remote-security-analysis.md
codeAnchors:
  - electron/feishu/remoteCommandRouter.ts:129
  - electron/shell/shellSecurity.ts:1
  - electron/pathSecurity.ts:1
  - electron/toolChatLoop.ts:1700
  - electron/tools/builtinExecutors.ts:1404
  - electron/remote/remoteAgentRegistry.ts:1
  - electron/remote/remoteWriteAuthorization.ts:1
  - electron/main.ts:1
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# 远程使用场景安全机制概述

> **原文**：[docs/analyze/remote-security-analysis.md](../../../../analyze/remote-security-analysis.md)
> 版本 v1.0 · 2026-07-14 · 949 行 · `origin: authored`（独立人工分析报告，非卡片合成）
> **内容时效**：止于原文日期 2026-07-14。本页 `updated` 记为本页建立日；正文已标注与当前代码的偏差。

## 定位

覆盖「用户不在电脑前、通过飞书/微信遥控桌面 Agent」这一场景的安全态势。
是当前知识库中**唯一**横跨远程链路与安全边界的权威分析，不可归入任何单一模块。

## 覆盖范围

| 模块 | 在本文中的角色 |
|------|----------------|
| `p-drivers` | 远程指令入口与路由（`imRemoteAgent`、RemoteCommandRouter / WeChatCommandRouter） |
| `p-delivery` | IM 渠道投递与确认（inbound parser、imChannel、出站消息） |
| `s-safety` | 安全机制主体（shellSecurity、pathSecurity、确认策略、策略引擎） |
| `s-capability` | 工具执行面（write_file / run_shell / run_script / browser / run_lark_cli） |
| `p-host-adapters` | Electron 应用层（contextIsolation、preload、IPC、CSP） |
| `p-storage` | 凭据加密、审计日志、去重存储 |
| `p-workspace` | 并发、会话与工作目录守卫 |

## 核心论点：威胁模型已改变

原文 §3.1 设定前提：飞书与微信**均限制为仅 owner 本人**可发指令（飞书 owner 绑定 + p2p only，微信天然私聊）。
在此前提下，威胁重心由「拦截未授权操作」转为「防止 Agent 被 prompt injection 操纵后执行灾难性操作」。

由此得出的推论（原文 §3）：

- 身份认证类机制（白名单、限流）价值下降 —— 只有本人能发指令
- 逐次确认价值下降 —— 用户信任 Agent 做事，每次打断违背产品初衷
- **灾难性防护价值不变甚至上升** —— 注入仍可诱导危险操作
- **提示注入防护升为首要优先级** —— 新模型下唯一能「操纵」Agent 的途径

## 机制评价三分类

| 类别 | 数量 | 代表机制 |
|------|------|----------|
| **必须保留** | 18 | 路径穿越防护、Shell 校验器、Lark CLI 安全、工具入参校验、Shell 环境过滤、OS 级密钥加密、消息去重、并发注册表、切换守卫、敏感目录拦截、上下文隔离、限流、日志脱敏、`remote_read_only`、飞书写确认、远程工具过滤、窗口拦截、审计日志 |
| **无效** | 2 | 微信出站 Y/N 确认（项目已自行移除，决策正确）；`remoteConfirmPolicy` 废弃枚举语义残留 |
| **过于繁琐** | 5 | 本地写双重确认、`run_script` 每次确认、`run_shell` 远程无信任、确认提示信息过载、会话切换四层守卫叠加 |

## 防护缺口分级

| 等级 | 缺口 |
|------|------|
| **高**（可致系统被接管） | ~~§7.1.1 `run_script` 无代码内容级分析~~（**已修复**，见偏差 ⑤）；§7.1.2 设备被盗应用层无解；§7.1.3 渲染进程缺 CSP |
| **中高**（可被绕过） | §7.2.1 Shell 校验纯正则可绕过；§7.2.2 提示注入无防护；§7.2.3 浏览器确认无截图佐证；§7.2.4 `remote_read_only` 名不副实（**策略层重构后已降为 legacy 值**，见偏差 ⑥） |
| **中**（覆盖盲区） | §7.3.1 `buildShellEnv` 过滤不全；§7.3.2 IPC 无来源验证；§7.3.3 远程执行无沙箱；§7.3.4 限流为内存态 |
| **低**（完整性） | §7.4.1 审计日志无防篡改；§7.4.2 去重存储无校验；§7.4.3 孤儿会话无清理；§7.4.4 敏感目录无粒度 |

## 改进建议优先级

| 优先级 | 建议 |
|--------|------|
| P0 | 会话级写授权替代逐次确认；Shell 信任机制扩展到远程 |
| P1 | `remoteConfirmPolicy` UI 二元化；确认提示精简；切换守卫合并 |
| P2 | `run_script` 风险分级；确认超时改为挂起；补 CSP |

## ⚠️ 与当前代码的偏差（2026-09-26 ingest 复核）

逐项核对了原文引用的实现位置，发现四类偏差：

**① P0 建议已落地** —— 原文 §8.3 的「引入会话级写授权机制」**已实现**：
`electron/remote/remoteWriteAuthorization.ts`（含 `recheckRemoteWriteAuthorization`，已被
`electron/toolChatLoop.ts` 引用 3 处，注释载明「等价旧 RemoteWriteGrant 的 generation 校验语义」），
并有 e2e 测试 `remoteWriteGrantLease.e2e.test.ts`。**此条应视为已完成，不再是待办。**

**② 实现位置已改名**

| 原文写法 | 当前实际路径 |
|----------|--------------|
| `runningRemoteAgentRegistry.ts` | `electron/remote/remoteAgentRegistry.ts` |

**③ 文件已不存在于主工作区**

| 原文写法 | 现状 |
|----------|------|
| `remoteConfirmBridge.ts` | 主工作区不存在，仅残留于 `.worktrees/` 旧分支 |
| `feishuConfirmManager.ts` / `weChatConfirmManager.ts` | 同上；相关实现现位于 `electron/feishu/feishuImChannel.ts` |

**④ 原文未提及但已存在** —— `remoteWriteAuthorization` 与 `remoteWriteGrantLease` 测试，
说明远程写授权体系在原文成稿后新增。

**⑤ §7.1.1 的「高威胁缺口」已修复** —— `run_script` 现已接入**代码内容级安全分析**：

新增 `electron/shell/scriptContentSecurity.ts`（`analyzeScriptContent`）与
`electron/confirmation/extractors/scriptAnalysisExtractor.ts`，产出信号：
`script-network`（网络访问）、`script-language-analysis:unverified`（语言未接完整分析）、
`script-path-extraction:unknown`、`script-uncertified`、`clean`。

策略层据此分级：桌面 clean 免确认（`script-clean-allow-desktop`）、
远程含网络直接拒绝（`script-network-deny-remote`）、
无人值守未认证语言拒绝（`automation-unverified-script-language-deny`）。

原文「移除逐次确认后，内容级分析成为防范 prompt injection 的唯一防线」的担忧**已被回应**。

**⑥ `remote_read_only` 已降为 legacy 值** —— 对应原文 §3.3.1 / §6.2.2 / §7.2.4：

`electron/tools/coordinatorConfirmationAdapter.ts:15` 定义
`LegacyPolicyCode = 'remote_read_only' | 'authorization_revoked'`，统一映射为 `'policy'`；
同时 `remoteAllowLocalWrite` **默认值已改为 `true`**
（`electron/remote/remoteToolPolicy.ts:61`），对应原文 §3.3.3 的建议。

**但原文 §7.2.4 指出的「`run_script` / `run_shell` 不受该策略约束」是否已闭合，
需在策略层规则全量对账后确认** —— 本页不作结论。

**⑦ §11.4 的 raw 只读实现位置已变更** —— 与本文相关的 `s-safety` 侧变更：
该机制已从「写执行器内联判断」迁至**策略层声明式规则**
（`src/shared/policy/defaultRules.ts:20` 的 `wiki-raw-write-deny`，`locked: true`），
语义更强（不可被套餐调松）。详见 `requirement-llm-wiki` 卡片的偏差 ①。

**结论**：原文的**分析框架与结论仍然有效**（威胁模型、机制分类、缺口分级），
但**实现位置与部分缺口状态需以当前代码为准** —— 已确认**修复 1 项**（§7.1.1）、
**机制迁移 1 项**（raw 只读）、**待对账 1 项**（§7.2.4）。

## 溯源

| 结论块 | 原文位置 |
|--------|----------|
| 威胁模型与优化方案 | §3 |
| 风险清单（A–H 类） | §4 |
| 安全机制映射 | §5 |
| 机制评价 | §6 |
| 防护缺口 | §7 |
| 总结与建议 | §8 |

## 待建底层卡片

原文引用的具体机制尚无独立卡片。建议后续建立（挂对应模块）：

- `s-safety/analysis-shell-security-verifiers` —— 14 条验证器逐条评价
- `s-safety/analysis-remote-read-only-gap` —— `remote_read_only` 名不副实（§7.2.4）
- `s-capability/analysis-run-script-content-audit` —— `run_script` 内容级分析缺口（§7.1.1）
- `s-safety/design-session-write-authorization` —— 会话级写授权（已实现，需与 §6.3.1 对账）
