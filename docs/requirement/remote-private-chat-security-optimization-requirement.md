# 远程一对一私聊模型安全机制优化需求规格

> 版本：v1.6  
> 创建日期：2026年7月15日  
> 修订日期：2026年7月15日  
> 状态：方案补强 / P0 未关闭，不得全量发布  
> 前置依赖：[wechat-remote-outbound-confirm-removal-requirement.md](./wechat-remote-outbound-confirm-removal-requirement.md)、[confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md)  
> 关联分析：[../analyze/remote-security-analysis.md](../analyze/remote-security-analysis.md)（**采纳其 §3 方向，并纠正「前提未落地却按已兑现推演」的问题**；不以分析稿 §6/§8「必须保留确认」为冲突依据）  
> 关联评审：[../review/remote-private-chat-security-optimization-requirement-review.md](../review/remote-private-chat-security-optimization-requirement-review.md)、[../review/remote-private-chat-security-optimization-security-ux-review.md](../review/remote-private-chat-security-optimization-security-ux-review.md)（v1.6 采纳后者 P0，并将 P1 纳入分层发布门禁）  
> 关联实现：`toolChatLoop.ts`、`shellSecurity.ts`、`shellCommandTrust.ts`、`remoteConfirmPolicy.ts`、`feishuInboundParser.ts`、`evaluateRemoteToolBlock`、`builtinToolNeedsConfirmation`、`remoteCommandRouter.ts`、`weChatCommandRouter.ts`

---

## 0. 修订摘要

### 0.1 相对 v1.0

| 决策 | 说明 |
|------|------|
| G5 改为「开关一览」 | 不引入通用「每工具确认」配置；确认/拒绝由明确开关与行为规则控制 |
| `remote_read_only` 有替代 | `remoteAllowLocalWrite=false` + `remoteDenyOutbound=true`；废止前置对该枚举的永久依赖 |
| 威胁叙事降调 | 不声称关闭 prompt injection |
| `run_script` 分析升格 | deny/ask/allow 矩阵、绕过面、负例 AC |
| 绑定 / 信任协议规格化 | 生命周期 + IM 协议进正文 |
| 作用域与默认值拍板 | 浏览器仅远程覆盖；限流默认 `60` |

### 0.2 相对 v1.1（v1.2 已关闭复审开放决策）

> 历史决策记录；其中浏览器组合默认和飞书写默认已被 §0.6 / v1.6 的风险分层覆盖。

| 决策 | 定稿 |
|------|------|
| 脚本外联模式 | **远程 `deny`，桌面 `ask`** |
| 绑定超时 / 取消 | **一律 `remoteEnabled=false`**（与清除 owner 一致） |
| 远程浏览器覆盖开关 | 字段名 **`remoteBrowserRequiresConfirm`**（Remote IM 公共配置，默认 `false`=远程免确认） |
| 「信任」误触 | **单独「信任」不写入列表**；仅 `Y trust` / `确认并信任` 等显式短语写入 |
| 长脚本展示 | IM 超长截断 + 引导桌面看全文；ask/deny 语义不变 |
| 一键只读写案 | 需求给出中英文案要点（诚实声明不拦脚本/Shell） |
| 前置文档同步 | `wechat-remote-outbound-…` **v1.1 已落盘**；其余 §6.5 项仍待 |

### 0.3 相对 v1.2（v1.3：必检清单 B 扩版）

| 决策 | 定稿 |
|------|------|
| 原 known bypass → 必检 B | B1–B11（见 §2.2.2）：含 `'o'+'s'` / `'sys'+'tem'` 折叠门禁；**须 ask/deny**，**禁止** `expected: allow` |
| 残余风险 → 仅清单 R | 运行时变量名、多步不可解数据流、字节码/loader 等；**禁止用 B 类充 R** |
| 技术门槛 | 简易 AST + 字符串常量折叠 + 导入别名跟踪 |

### 0.4 相对 v1.3（本版 v1.4：门槛与验收再收紧）

| 决策 | 定稿 |
|------|------|
| 折叠 / 别名 / B11 语义 | 写清可折叠表达式范围、别名作用域、`解码→exec`「紧邻」判定，避免实现各说各话 |
| 分析器输出 | `patterns` 须带回清单编号（如 `B3`、`A6`），供审计与单测断言 |
| 测试纪律 | B 夹具不得标 known bypass；CI/单测约定见 AC-Script-Detect-B / Fold / Alias / Residual-R |
| NG11 / G3 | 与「B 必检、R 残余」对齐，免确认宣传以前述 AC 为 exit criteria |

### 0.5 相对 v1.4（本版 v1.5：按当前工作树校准）

本版不改变已定安全决策，重点修正文档与代码现状的偏差。代码事实以 **2026-07-15 当前工作树**为准；其中多项实现尚处于未提交状态，因此“已实现”不等于“已发布”。

| 调整 | 说明 |
|------|------|
| 状态改为“实现收口 / 待全量验收” | owner 绑定、微信发送者强制、脚本分析、远程确认桥、新访问控制开关及 P1 默认值均已有实现与针对性测试 |
| 现状列改为“当前工作树 / 目标” | 删除仍称“未实现”“默认 10”“无字段”等过期描述 |
| 保留兼容字段边界 | `remoteConfirmPolicy` 可继续反序列化与透传，但不得参与新的确认/拒绝决策；`remote_read_only` 只在配置合并时迁移为两个显式开关 |
| 收口计划替代从零实施计划 | 后续重点为全量回归、审计事件核对、i18n 校验、跨文档同步与发布说明，而非重复建设主体能力 |
| 修正实现索引 | owner 状态机、共享 IM 确认协议、脚本分析文件均已存在，列入关联实现而非“新增文件” |

### 0.6 相对 v1.5（本版 v1.6：安全与 UX 评审补强）

本版采纳安全与 UX 评审的“有条件通过”结论。当前工作树中已有的免确认实现不因此被描述为无效，但在以下 P0 关闭前只能用于受控灰度，不得按现有宽松默认直接迁移存量用户或全量发布。

| 决策 | 定稿 |
|------|------|
| 绑定抗抢跑 | 飞书首条消息直接绑定改为桌面一次性配对码；绑定消息不进入 Agent；错误/过期/复用/并发抢跑均 fail closed |
| 存量迁移 | 新安装可采用低摩擦默认；存量升级在一次性权限摘要完成选择前保持旧安全强度，取消不得半迁移 |
| Shell 信任 | 原始字符串 `startsWith` 不再满足发布门槛；改为结构化简单命令范围。结构化能力落地前，任何 Shell 元语法命令都不得因信任跳过确认 |
| 脚本文案与边界 | “安全脚本”统一改为“未发现已知高风险模式”；新增独立远程开关、资源预算、立即停止与执行摘要要求 |
| 浏览器风险分层 | `navigate` 与 `act` 拆分；`navigate` 可默认免确认，`act` 默认确认。高影响 act 分类稳定前不得默认免确认 |
| 飞书外部写 | 群消息、批量/删除文档、日历邀请等高影响动作必须 ask；无法稳定分类时整体保持确认 |
| 可观测与止损 | 增加用户侧近期活动、主动告警、保留/脱敏/清理规则、会话工具预算和全局紧急停止 |

---

## 1. 概述

### 1.1 背景与问题

SpaceAssistant 支持通过飞书 Bot 和微信 Bot 接收远程指令。历史实现对文件写入、脚本执行、Shell 命令等操作普遍要求 IM Y/N，典型多文件任务确认次数可达 4 次以上。当前工作树已按本需求拆分身份认证、硬拒绝、启发式脚本分析和可选确认；本版需求用于约束收口与回归，防止兼容字段或后续重构重新引入旧的“一刀切确认”行为。

这些确认机制设计于「可能有外部攻击者发送指令」的旧威胁模型下。在**先完成**「飞书 owner 绑定 + p2p only、微信强制绑定发送者」之后，外部身份冒用面大幅下降，逐次确认对「防未授权」的收益下降，而流程成本不变。本需求在该地基上降低摩擦，并保留灾难性硬拦截与可替代的访问控制开关。

### 1.2 威胁模型转变

**前提假设（须产品化落地，不可口头假定）：**

1. 飞书：仅 p2p，且仅已绑定 owner 可驱动 Agent  
2. 微信：仅已绑定发送者可驱动 Agent（见 §2.1.3，**不以「天然一对一」跳过验收**）  
3. 不考虑设备被盗（A2）的应用层防护（见 NG1）  
4. 账号劫持 / Bot 凭据泄露（A3）仍可能存在，但不靠逐次确认防御（确认在凭据被控时同样可被绕过）

| 维度 | 旧威胁模型 | 新威胁模型 |
|------|-----------|-----------|
| 指令来源 | 任意 IM 用户可能发送指令 | 仅已绑定本人可发送指令 |
| 主要残余威胁 | 外部未授权访问 + 注入 + 误操作 | Agent 误操作与内容注入为主；外部身份冒用大幅下降；A3 仍在 |
| 安全目标 | 拦截每一次可疑危险操作 | 防止灾难性损害；用硬拒绝/分析替代多数逐次确认 |
| 用户信任度 | 低（指令可能来自攻击者） | 高（用户信任自己的 Agent 执行任务） |

**价值重估：**

- **身份认证**（owner 绑定、p2p、强制 allowlist）：价值**上升**——是本需求其余简化的地基  
- **逐次确认**：对「防未授权」价值下降；对「防注入诱导」仅提供有限人工闸门，**不可当作注入防护的替代品**  
- **灾难性硬拦截**（路径沙箱、危险 Shell 验证器、密钥过滤）：价值不变甚至上升  
- **提示注入专项防护**（工具输出标记等）：**仍为首要长期优先项，但不在本需求范围**（见 §1.4 / §6.4）；本需求明确接受：在注入缓解未落地前移除多数确认，会抬高「注入成功后的自动破坏」风险，由 owner 绑定 + 硬拦截 + 内容分析 + 审计 + 用户信任边界共同兜底

### 1.3 目标

| ID | 目标 | 优先级 |
|----|------|--------|
| G1 | 飞书实现 owner 绑定 + p2p only | P0 |
| G2 | 远程本地文件写入（`write_file` / `edit_file`）在允许写时无需逐次 IM Y/N | P0 |
| G3 | `run_script`：清单 A/B 达检后方可称“未发现已知高风险模式”；按矩阵 deny/ask；env 过滤、资源预算与停止能力对齐 | P0 |
| G4 | 远程 IM 补齐 Shell「确认并信任」录入协议，复用既有信任存储 | P0 |
| G5 | 废除 `remoteConfirmPolicy` 行为消费；确认/拒绝由明确开关表驱动；保留出站硬拒绝能力 | P0 |
| G6 | 发送者身份强制（飞书 owner / 微信绑定用户）；移除群聊触发配置 | P0 |
| G7 | Shell 安全校验器放松 `redirection` / `command_substitution` / `multiline`，保留灾难性拦截 | P1 |
| G8 | 飞书 `run_lark_cli` 按外部影响分层；高影响写默认确认，分类失败 fail closed | P1 |
| G9 | 远程浏览器 `navigate` 默认可免确认、`act` 默认确认并按动作风险分层；**不改变桌面默认** | P1 |
| G10 | `remoteRateLimitPerMinute` 默认改为 `60` | P1 |

#### 1.3.1 当前工作树完成度

| 能力 | 当前代码证据 | 状态 |
|------|--------------|------|
| 飞书 owner 绑定、超时/取消关闭远程、P2P only | `feishuOwnerBind.ts`、`feishuIpc.ts`、`remoteCommandRouter.ts` | 过渡实现；缺一次性配对码，P0 未关闭 |
| 微信绑定发送者强制 | `weChatIpc.ts`、`weChatCommandRouter.ts` | 已实现，待登录/重绑链路回归 |
| 文件写开关、出站硬拒绝、legacy 迁移 | `toolChatLoop.ts`、`imTypes.ts`、`feishuTypes.ts`、`wechatTypes.ts` | 已实现，待迁移回归 |
| `run_script` A/B/R 分析与过滤环境 | `scriptContentSecurity.ts`、`scriptContentSecurity*.test.ts`、`toolChatLoop.ts` | 已实现，A/B/R 专项测试已具备 |
| 飞书/微信共享确认与信任协议 | `imConfirmReply.ts`、两端 ConfirmManager、`remoteConfirmBridge.ts` | 回复协议已实现；结构化信任 P0 未关闭 |
| Shell 三类规则放宽 | `shellSecurity.ts` | 已实现；在结构化信任/复杂命令强制 ask 前不可全量开放 |
| lark 写默认免确认、远程浏览器组合覆盖、限流 60 | shared 默认配置、`toolChatLoop.phase2RemoteConfirm.test.ts` | 已实现旧方案；需按 v1.6 做高影响分类和 navigate/act 拆分 |
| 存量安全迁移、资源预算、近期活动 | 当前工作树未见完整闭环 | 新增发布门禁 |

“已实现”的判定仅表示当前工作树存在对应逻辑和专项测试；发布门禁仍以 §5 全部适用 AC 通过为准。

### 1.4 非目标

| # | 非目标 | 说明 |
|---|--------|------|
| NG1 | 不考虑设备被盗（A2）的防护 | 设备级安全是唯一有效防线 |
| NG2 | 不移除灾难性防护机制 | `dangerous_rm`、`disk_format`、`privilege`、`pipe_to_shell` 等保留 |
| NG3 | 不移除路径安全防护 | `resolveSafePath` / `resolveSafePathReal` 不变（**仅覆盖文件工具路径，不覆盖 `run_script` 内任意 I/O**） |
| NG4 | 不移除 Shell 环境变量过滤 | `buildShellEnv` 保留，并扩展到 `run_script` |
| NG5 | 不移除审计日志 | 本需求还要求补充增量审计事件（见 §5.7） |
| NG6 | 不引入进程级沙箱隔离 | 独立议题 |
| NG7 | 不引入 CSP 头 | 独立议题 |
| NG8 | 不修改桌面端确认默认行为 | 远程可用覆盖逻辑；不得改坏桌面 `navigateRequiresConfirm` / `actRequiresConfirm` 等默认值 |
| NG9 | 不落地远程内容提示注入防护 | 分析 7.2.2；见 §6.4。本需求**不**把注入防护列为确认移除的安全等价物 |
| NG10 | 不引入通用「每工具确认」配置 UI | 仍只增加经风险评审明确要求的脚本、navigate、act 开关，不扩展成任意工具策略系统 |
| NG11 | 不以 v1 静态分析消灭**清单 R** 类绕过 | **不等于**放过清单 B：B1–B11 为交付门禁。发布说明：启发式闸门、非沙箱；R 可漏、B 不可漏 |

---

## 2. 需求详情

### 2.1 飞书 Owner 绑定与 P2P Only（地基）

> **合并门禁：** 阶段一中「移除写文件逐次确认 / 脚本免确认 / 策略简化」**不得早于** G1/G6 绑定可用合入。可同 PR，但必须同版本可验收。

#### 2.1.1 限制 P2P Only

修改 `feishuInboundParser.ts` 的 `shouldAcceptInbound`，默认拒绝 `chatType === 'group'`，仅接受私聊。

| 项 | 现状 | 目标 |
|----|------|------|
| 群聊消息 | 当前工作树已拒绝 | 保持一律拒绝，并提示可理解原因（见 §5.7） |
| p2p 消息 | 已校验 owner / 绑定窗口 | 仅 owner 可驱动 Agent；绑定窗口内只有精确配对协议可进入绑定状态机，不能驱动 Agent |

#### 2.1.2 Owner 绑定生命周期

采用「桌面发起 → 一次性配对码 → 私聊回传 → 双端通知」：

1. 用户在桌面端开启飞书远程监听且尚未绑定时进入**绑定模式**；此时 `remoteEnabled` 可处于待绑定态，但不得处理业务指令。  
2. 桌面生成并展示一次性配对码：推荐使用去混淆 Base32 字符集的 **8 字符随机码**（展示可分组），至少 40 bit 熵；仅在内存保存摘要，不写明文日志。  
3. 配对窗口默认 **5 分钟**；单窗口最多 **5 次**失败尝试。用户从本人飞书账号向 Bot 发送精确协议 `绑定 <配对码>`（英文 `bind <code>`）。  
4. 仅 p2p、码正确、未过期、未消费且尝试未超限时，原子地消费配对码并把该消息的 `senderOpenId` 写为唯一 owner；同一码的并发请求最多一个成功。  
5. **绑定消息只用于配对，不得作为业务指令继续进入 Agent。**绑定完成后，之后仅接受 `senderOpenId === ownerOpenId` 的 p2p 业务消息。  
6. 桌面与成功配对的私聊同时显示绑定结果；桌面展示可识别账号信息（能力不足时至少展示脱敏 open_id）、绑定时间和“立即撤销/重新绑定”入口。  

| 场景 | 要求行为 |
|------|----------|
| 绑定成功 | 原子消费配对码并退出绑定模式；双端通知；只读展示 owner、绑定时间；审计 `feishu.bind.success`，不记录配对码 |
| 绑定超时 | 退出绑定模式；**强制 `remoteEnabled=false`**（或等价停止监听）；桌面提示超时并提供「重新开启并绑定」入口；审计 `feishu.bind.timeout` |
| 用户取消绑定 | 与超时相同：**`remoteEnabled=false`**；审计 `feishu.bind.cancel` |
| `remoteEnabled=true` 但未绑定 | **不应成为稳定状态**。若配置损坏导致此态：拒绝一切入站业务消息，桌面强提示完成绑定或关闭远程 |
| 错误码 / 非绑定文本 | 不绑定、不触发 Agent；错误码消耗一次尝试，普通文本不泄露配对状态细节 |
| 尝试次数耗尽 | 立即使窗口失效并 `remoteEnabled=false`；需从桌面重新发起；审计仅记次数与结果 |
| 重复 / 并发使用 | 配对码单次使用；通过原子 compare-and-set 保证最多一个 sender 成功 |
| 重绑 | 设置页「重新绑定」：桌面二次确认 → 清空旧 allowlist → 新绑定窗口；旧 open_id **立即失效** |
| 清除 owner | 允许；清除后强制 `remoteEnabled=false`；需再次完整绑定才能远程 |
| 非 owner / 群聊 | 拒绝；不触发 Agent；审计 `feishu.reject.non_owner` / `feishu.reject.group` |

设置页：`remoteSenderAllowlist` / owner 标识**只读**；不可手填伪造。当前工作树的“首条 p2p 直接绑定”仅视为过渡实现，替换为上述配对协议前不得开放后续免确认能力给非测试用户。

#### 2.1.3 微信发送者约束（有改动）

微信 Bot 多为扫码绑定后的会话，但**现网 allowlist 仍可为空（不限制）**。本需求要求：

| 项 | 目标 |
|----|------|
| 远程监听启用时 | 必须存在有效绑定发送者（写入与飞书对称的 allowlist / 既有绑定用户字段） |
| 空 allowlist | **禁止**放行任意微信号私聊指令；拒绝并提示重新绑定 |
| 非绑定发送者 | 拒绝入站，审计 `wechat.reject.non_owner` |

实现可复用既有扫码绑定结果，不必新造飞书式「首条消息绑定」；验收点是「仅绑定用户可驱动」，不是「天然一对一」。

---

### 2.2 确认机制简化

#### 2.2.1 移除本地文件写入逐次确认（P0）

| 项 | 现状 | 目标 |
|----|------|------|
| `write_file` / `edit_file` 远程确认 | 当前工作树已按 `remoteAllowLocalWrite` 分流 | 保持 `true` 时跳过确认、`false` 时硬拒绝 |

**实现要点：**

- 对**新安装或已完成安全摘要的规范化配置**，`evaluateRemoteToolBlock` 中 `remoteAllowLocalWrite` 的 fallback 保持 `?? true`（对齐新装默认）；原始 legacy 配置必须先经过 §2.3.3 的保守迁移层，不能直接依赖该宽松 fallback  
- `remoteAllowLocalWrite === false` 时**硬拒绝** `write_file` / `edit_file`（见 §2.3.3）  
- 写入 diff 仍在会话历史可见  

**安全保障（不变）：** 路径沙箱、敏感工作目录拦截、`toolInputGuards`。

#### 2.2.2 `run_script`：内容分析替代逐次确认（P0）

| 项 | 现状 | 目标 |
|----|------|------|
| 确认 | 当前工作树已先执行 `analyzeScriptContent` | 保持按矩阵 `allow` / `ask` / `deny`，不得被旧总开关绕过 |
| 环境 | 当前工作树已接入过滤环境 | 保持与 Shell 同等的 `buildShellEnv`（或等价过滤），不得泄露 API Key 等 |

**重要事实：** `run_script` 为 `python -c`，**不受** `resolveSafePath` 约束。内容分析是**启发式闸门**，不是沙箱（NG11）。清单 **B 为门禁**，清单 **R 为明示残余**——二者不得混用。

##### 分析技术门槛（exit criteria，P0）

实现最低要求（设计可增补，不可削减）：

| 能力 | 要求 |
|------|------|
| 解析 | 源码 **简易 AST**（禁止「仅靠全文正则」作为唯一手段） |
| 字符串常量折叠 | 对 **字符串字面量** 的 `+` 拼接树（含嵌套，如 `'o'+('s')`、`'sys'+'tem'`）求值为常量；折叠结果用于模块名 / 属性名 / `__import__` / `import_module` 参数 |
| 导入别名跟踪 | 同一函数/模块作用域内：`import X as a`、`from X import y`、`from X import y as z`、简单 `a = import_module(...)` 赋名后，经 `a.dangerous` / `z(...)` 调用须命中 |
| 清单覆盖 | 下文 A、B 每条均有正例单测；期望 **ask 或 deny**；**禁止** `expected: allow` |
| B/R 隔离 | `expected: allow (known bypass)` **仅**允许清单 R；**禁止**用 B1–B11 任一形态充 R（测试命名、注释、夹具路径均须可审计） |

**明确不做（归 R 或后续版本，不挡 P0）：** 完整 SSA/跨函数过程间分析；`"".join([...])` / `chr()` / f-string 拼装（除非设计自愿升级为必检）；任意长度数据流求解。

##### 必检清单 A（基线字面量 / 直接调用）

| ID | 模式 / 条件 | 远程 | 桌面 |
|----|-------------|------|------|
| A1 | `os.system` / `os.popen` / `subprocess.*` / `pty.*` | ask | ask |
| A2 | `shutil.rmtree` / `os.remove` / `os.unlink` / `os.rmdir` / `Path.unlink` / `shutil.move`（删/覆意味） | ask | ask |
| A3 | `eval` / `exec` / `compile` / `os.exec*` / `builtins.eval` / `builtins.exec` | ask | ask |
| A4 | `__import__(…)` / `importlib.import_module(…)`，参数为字面量或可折叠常量，且落入危险模块集合 | ask | ask |
| A5 | `ctypes` / `ctypes.CDLL` / `cffi` 明显加载原生库 | deny | deny |
| A6 | `socket` / `urllib` / `urllib.request` / `http.client` / `requests` / `httpx` 等外联明显模式 | **deny** | **ask** |
| A7 | `open` / `Path.write_text\|write_bytes` 写模式且路径为绝对或含 `..`（字面量或可折叠） | deny | deny |
| A8 | 同上写 API 且工作目录内相对路径 | allow + audit | allow + audit |
| A9 | `os.chdir` | allow + audit | allow + audit |
| A0 | 无命中 | allow | allow |
| A-fail | 分析器失败 / 无法解析 | ask | ask |

##### 必检清单 B（扩版；原「known bypass」升格门禁）

须 ask/deny，**禁止** `expected: allow`。语义等价即中（不要求字节级同构）。

| # | 形态（示例） | 远程 | 桌面 | 最低检出要求 |
|---|-------------|------|------|--------------|
| **B1** | `getattr(os, 'system')` / `getattr(os, "popen")` | ask | ask | 基底可解析为危险模块/`builtins`；属性名为字面量或可折叠常量，且 ∈ 危险属性名集合 |
| **B2** | `getattr(__import__('os'), 'system')` | ask | ask | `__import__` 参数可折叠为危险模块名 |
| **B3** | `getattr(__import__('o'+'s'), 'sys'+'tem')` | ask | ask | **常量折叠门禁**（原 known bypass）；不得因拼接漏检 |
| **B4** | `importlib.import_module('o'+'s')` 后 `.system` / 再 `getattr` | ask | ask | 折叠 + 简单别名/链式 |
| **B5** | `import os as o; o.system(...)` / `import subprocess as sp; sp.run(...)` | ask | ask | 导入别名跟踪 |
| **B6** | `from os import system, remove, popen; system(...)` | ask | ask | `from … import` 危险符号 |
| **B7** | `from os import system as s; s('…')` | ask | ask | 危险符号再别名 |
| **B8** | `builtins.__import__('os')` / `builtins.exec(...)` / `builtins.getattr(...)` | ask | ask | 经 `builtins` 暴露的同危险面 |
| **B9** | `getattr`/`hasattr`，属性参数可折叠为危险名，**即使基底未解析** | ask | ask | **偏严**：禁止 `getattr(x,'system')` 静默 allow |
| **B10** | `__import__` / `import_module`，参数可折叠为危险模块——**即使未见后续调用** | ask | ask | 危险模块导入即提级为 ask（远程外联类模块可按 A6 升 deny） |
| **B11** | `base64.b64decode` / `codecs.decode` / `bytes.fromhex` 的结果，在**同一表达式**或**紧邻语句**传入 `eval`/`exec`/`compile`/`__import__` | ask | ask | 能看见「解码→执行」边即必检 |

**危险模块名集合（P0 下限，设计可增补）：**  
`os`、`subprocess`、`pty`、`ctypes`、`cffi`、`socket`、`urllib`、`http`、`requests`、`httpx`、`importlib`、`builtins`、`shutil`；`pathlib` 仅当配合危险写/删 API；`sys` 仅当后续明显经 `sys.modules` 动态取模（设计细化）。

**危险属性名集合（P0 下限，设计可增补）：**  
`system`、`popen`、`remove`、`unlink`、`rmtree`、`rmdir`、`exec`、`eval`、`execv`、`execve`、`execvp`、`call`、`run`、`Popen`、`check_output`、`check_call`、`CDLL`、`WinDLL`。

**B11「紧邻」判定（定稿）：**

1. 同一表达式内：解码调用直接作为 `eval`/`exec`/`compile`/`__import__` 的参数；或  
2. 同一函数体中，解码结果赋给名 `t`，且在**不超过 3 条**间隔语句内（中间无对 `t` 的重新绑定到无关值）将 `t` 传入上述调用。

超出则归 **R2**，不强迫 v1 全数据流求解。

##### 残余风险清单 R（可 `expected: allow (known bypass)`）

| # | 形态 | 说明 |
|---|------|------|
| R1 | 模块名 / 属性名来自**变量、形参、用户输入**，无法常量折叠 | 如 `getattr(os, name)` |
| R2 | **多步**编解码或跨过多语句/分支，v1 无法按 B11 连接「解码→执行」边 | |
| R3 | `types.FunctionType` / 字节码 / `marshal` / 自定义 loader / `code object` 执行 | 超出简易 AST |
| R4 | 先合法相对路径 `open`/`Path.write_*` 落盘，再间接执行的供应链式载荷 | 非单脚本闭包；属注入/工作流 |

**纪律：** 禁止将 B1–B11（含 B3 折叠样例）标为 R / known bypass。评审与 CI 可将「B 夹具出现在 known-bypass 目录」视为失败。

##### 产品行为与损害控制

**与 `autoAllowScriptExecution`：** 废弃总开关语义；旧 `true` 仍走内容分析；设置页说明「危险脚本仍会确认或拒绝」。

**新增远程开关：** `remoteScriptRequiresConfirm: boolean`。新安装在完成远程安全摘要后可默认 `false`；存量升级默认 `true`，直到用户在升级摘要中选择低摩擦预设。该开关只决定分析结果为 `allow` 时是否仍 ask，绝不覆盖 `ask` / `deny`。产品文案不得称“安全脚本”，统一使用“未发现已知高风险模式”。

**免确认脚本资源边界（P1，全量发布门禁）：**

- 沿用并强制执行脚本超时；超时终止整个可归属进程树，而非只停止父进程。
- 设置有限输出上限，超限截断并审计；不得因无限输出拖垮主进程或 IM 通道。
- 同一远程会话至多 1 个运行中脚本；脚本拉起子进程应计入会话执行预算。若当前平台无法可靠限制子进程数量，至少达到预算后停止继续工具调用并提示桌面处理。
- 桌面和对应 IM 均提供“停止当前远程任务”；桌面另提供“紧急关闭远程”全局入口。
- 执行结束生成摘要：耗时、退出状态、截断情况、命中文件工具/可观察工作区修改；若已有 checkpoint/版本控制恢复能力，摘要提供直达恢复入口，不承诺自动回滚脚本的任意副作用。

**展示：** 桌面 ask 展示全文；IM 超长（建议 4000 字符）截断并引导桌面；不改变 ask/deny；deny 不进 Y/N。

**deny 文案：** 使用“检测到已知高风险模式，远程已拒绝”，并提供“回到桌面审阅并执行”的明确路径；用户界面不直接暴露 A/B 编号，编号仅进入可展开详情、测试和审计。

**实现：** `electron/shell/scriptContentSecurity.ts`

```ts
analyzeScriptContent(code: string, ctx?: { remote?: boolean }): {
  verdict: 'allow' | 'ask' | 'deny'
  patterns: string[]  // 如 'B3', 'A6', 'B10'；供审计与单测
  reason?: string
}
```

外联等按 `ctx.remote` 在 A6/B10 上映射 deny vs ask。

##### 「未发现已知高风险模式的脚本可免确认」对外宣传 exit criteria

同时满足方可声称「未发现已知高风险模式的脚本可远程免确认」：

1. AC-Script-Detect-A / **AC-Script-Detect-B** / **AC-Script-Fold** / **AC-Script-Alias** 全绿  
2. AC-Script-Residual-R 夹具与清单 R 一致，且无 B 充 R  
3. AC-Script-Env 通过  
4. `remoteScriptRequiresConfirm` 的新装/升级默认和资源边界通过 §5 验收  

#### 2.2.3 Shell 信任：复用存储 + 补远程确认桥（P0）

| 项 | 现状 | 目标 |
|----|------|------|
| 信任命中跳过确认 | `shouldSkipShellConfirmForTrust` **已可**跳过远程确认 | 保持 |
| 远程录入 | 当前工作树已有共享解析器和两端 ConfirmManager 接入 | 保持协议一致，并验证竞态与风险确认不可信任 |

**协议（飞书 / 微信文本确认；大小写不敏感；去首尾空白后匹配）：**

| 用户回复 | 行为 |
|----------|------|
| `Y` / `yes` / `是` / `确认` | **仅批准本次**；不写入信任列表 |
| `Y trust` / `yes trust` / `确认并信任` | 批准本次，并将命令前缀写入同一信任表（`addTrustedCommand`） |
| `信任`（单独一词） | **不**批准、**不**写入；回复用法提示，要求使用 `Y` 或 `确认并信任` / `Y trust`（降低中文误触） |
| `N` / `no` / `否` / `取消` | 拒绝 |
| 其他 | 不消费 pending；回复简短用法提示 |

确认提示文案应**优先展示** `Y` / `N` / `确认并信任`（或英文 `Y trust`），避免单独强调「回复信任」。

**约束：**

- `analysis.verdict === 'deny'`：不可信任、不可批准执行  
- `hints.requiresRiskAck` / `securityWarning` / `denyType === 'weak'`：**不展示/不提示**信任选项；文案不得引导无效的信任回复；上述信任短语即使出现也不写入列表（可按「仅批准本次」处理，或与非法回复一样提示——**选定：按非法/不适用处理，不批准不写入**，迫使走桌面风险确认路径若存在）  
- 超时：与现网远程确认超时一致；超时不写信任  
- 多 pending：保持现有 single-flight / per-session 约束  
- 桌面卡片与 IM 双通道：任一通道「确认并信任」成功即写入；另一通道 pending 关闭  
- 信任写入和命中必须遵循 §2.4.3 的结构化范围；不得再以原始字符串 `startsWith` 作为授权依据  

#### 2.2.4 飞书 `run_lark_cli` 写操作风险分层（P1）

| 项 | 现状 | 目标 |
|----|------|------|
| `larkCliWriteRequiresConfirm` | 当前工作树默认 `false` | 高影响分类未达标前改回 `true`；达标后仅低影响写可跟随开关免确认 |

**残余风险（设置页/发布说明必示）：** 飞书写可影响群消息、共享文档、日历等第三方资源；误操作外部影响面大于微信「只回自己」。

**高影响子命令策略（全量发布门禁）：**

以下最小集合必须稳定分类并默认 **ask**：向群聊/多人发送消息，批量修改或删除文档/记录，创建、修改或取消包含他人的日历邀请，以及权限/共享范围变更。其余可证明低影响的写操作才跟随 `larkCliWriteRequiresConfirm`。

若当前版本不能稳定识别上述最小集合，则 `larkCliWriteRequiresConfirm` 必须保持 `true`；当前工作树默认 `false` 仅允许受控灰度，不得作为全量发布默认。分类器应基于解析后的 CLI argv/操作名，而非对完整命令做模糊关键词匹配。

#### 2.2.5 浏览器操作确认：仅远程分层（P1）

| 项 | 现状 | 目标 |
|----|------|------|
| 全局 `navigateRequiresConfirm` / `actRequiresConfirm` | 默认 `true` | **保持不变**（桌面仍默认确认） |
| 远程 | 当前工作树已有独立覆盖 | 保持由下方开关控制，不反向修改桌面默认 |

**配置收敛（Remote IM 公共，`RemoteImCommonConfig` / 飞书与微信共享段）：**

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `remoteBrowserNavigateRequiresConfirm` | `boolean` | 新安装 `false`；存量升级保持原行为 | 仅控制远程 `navigate`；`screenshot` / `observe` 始终不确认 |
| `remoteBrowserActRequiresConfirm` | `boolean` | **`true`** | 控制远程 `act`；高影响动作分类落地前不得默认关闭 |
| `remoteBrowserRequiresConfirm` | `boolean` | deprecated | 旧组合字段仅用于迁移：`true` 映射两者均 true；`false` 不得在存量升级时静默把 act 变为免确认 |

**动作分层：** 即使用户关闭 `remoteBrowserActRequiresConfirm`，提交、发送、购买/支付、删除、授权、修改账号/权限等承诺性动作仍默认 ask；只有纯浏览、无提交填写等低影响动作可免确认。若分类器无法稳定判断，按高影响 ask（fail closed）。

**设置入口：** Remote IM 公共设置（与 `remoteAllowLocalWrite` 等并列），分别展示“页面导航”和“页面交互”，文案标明「仅影响飞书/微信远程，不影响桌面浏览器确认」。确认摘要使用“风险、影响对象、是否可撤销、下一步”四项短格式。

禁止修改 `DEFAULT_BROWSER_CONFIG` 来达到远程免确认（违反 NG8）。

---

### 2.3 策略与访问控制（G5 薄方案）

#### 2.3.1 废除 `remoteConfirmPolicy` 行为消费

**不是**「每个工具一个确认开关」的通用配置系统。

- 停止在运行时消费 `ImConfirmPolicy` / `LegacyImConfirmPolicy` 来决定确认  
- 类型与配置字段标记 `@deprecated`，读取不抛错  
- 确认行为仅由 §3 总表驱动  

#### 2.3.2 废弃 `remote_read_only`，用诚实开关替代

前置需求已于 **v1.1** 改为过渡期语义（见该文档 §0）；本需求落地后完成迁移：

| 新能力 | 语义 |
|--------|------|
| `remoteAllowLocalWrite=false` | 硬拒绝 `write_file` / `edit_file` |
| `remoteDenyOutbound=true`（当前工作树已存在，默认 `false`） | 硬拒绝 `wechat_reply` / `wechat_send`；飞书侧硬拒绝 `run_lark_cli` 写类调用（与 legacy read-only 对 lark 写拦截对齐） |

**明确不承诺：** 不拦截 `run_script` / `run_shell` 副作用写。若要「真正只读远程」，另开需求。

**迁移矩阵：**

| 旧值 / 状态 | 迁移结果 |
|-------------|----------|
| `remoteConfirmPolicy=remote_read_only` | `remoteAllowLocalWrite=false` + `remoteDenyOutbound=true`；策略字段保留但忽略 |
| `always` / `im_confirm` / `inherit` / legacy confirm | 等价「允许出站、确认走各工具开关」 |
| 已手动 `deniedTools` 含出站工具 | 保持 deny；与 `remoteDenyOutbound` 取更严 |

上述矩阵只定义字段语义，**不能作为存量用户自动放宽确认的依据**。存量升级另遵循 §2.3.3。

**一键 UX：** 设置页开关「限制远程写入与出站」（英文建议：`Restrict remote file writes & outbound`）。

文案要点（须 i18n，诚实声明）：

- 中文：开启后：禁止远程 `write_file`/`edit_file`，并禁止微信出站与飞书写工具。**不会**禁止 `run_script` / `run_shell` 对文件或网络的副作用。  
- English: Blocks remote file-write tools and IM/Feishu outbound writes. Does **not** block side effects from `run_script` / `run_shell`.

#### 2.3.3 新安装与存量升级策略（P0）

新增持久化版本 `remoteSecurityConfigVersion`（具体命名可在设计中调整，语义不可省略）。仅当用户完成本版一次性安全摘要并保存选择后写入当前版本；不得仅因应用启动或配置 merge 自动推进版本。

| 场景 | 行为 |
|------|------|
| 新安装 / 从未启用远程 | 首次启用时展示一次安全摘要，可选择“推荐（低摩擦）”或“更安全”；明确列出本地文件写、脚本/Shell 副作用、页面导航、页面交互、飞书外部写和限制开关并非真正只读 |
| 存量配置缺新字段 | 在完成摘要前保持旧有效安全强度：文件写、脚本 allow、browser act、飞书写均继续确认；不得用新字段的宽松默认补齐 |
| legacy `remote_read_only` | 先迁移为两个硬拒绝开关，并默认选择“更安全”；不得因摘要未完成而暂时放开 |
| 已有自定义配置 | 按每一能力取“不比升级前更宽”的值生成初始选择；用户确认后才切换 |
| 摘要取消、关闭或异常退出 | 原子回滚，不写配置版本、不部分保存；保持旧行为 |
| 再次重大放宽 | 提升安全配置版本并重新展示一次摘要；普通文案调整不得重复打扰 |

预设最低语义：

- **推荐（低摩擦）：** 文件工具允许时免确认；未发现已知高风险模式的脚本可免确认；navigate 免确认；browser act 默认确认；飞书高影响写确认；Shell 仅结构化简单命令可持久信任。
- **更安全：** 文件写、脚本 allow、navigate、act、飞书写均确认；出站硬拒绝仍由用户单独决定，避免把“更多确认”和“禁止能力”混为一谈。

摘要保存必须是一次原子配置事务，并记录选择来源和配置版本。之后可在 Remote IM 设置中逐项修改。

#### 2.3.4 `remoteAllowLocalWrite` 语义

| 状态 | 行为 |
|------|------|
| `true`（新装/已迁移默认） | 允许远程两文件写工具；完成当前安全配置版本后不再逐次确认 |
| `false` | 硬拒绝上述两工具；**不**隐含拒绝脚本/Shell 写 |

规范化配置运行时 fallback：`?? true`；raw legacy 配置不得绕过 §2.3.3 直接进入该路径。

#### 2.3.5 / 2.3.6 发送者强制与群聊配置移除

见 §2.1；`remoteGroupTrigger` / `remoteCommandPrefix` `@deprecated`，群聊分支删除，旧字段平滑忽略。

---

### 2.4 Shell 安全校验器精简（P1）

#### 2.4.1 可放松的验证器

| 验证器 | 现状 | 目标 |
|--------|------|------|
| `redirection` | 当前工作树已移出硬拦列表 | 保持放行 |
| `command_substitution` | 当前工作树已移出硬拦列表 | 保持放行 |
| `multiline` | 当前工作树已移出硬拦列表 | 保持放行 |

作用域：远程与桌面**共用**同一 `shellSecurity`；接受桌面同步变宽。

#### 2.4.2 必须保留的验证器

`dangerous_rm`、`disk_format`、`disk_wipe`、`privilege`、`pipe_to_shell`、`dangerous_env`、`lark_cli`、`interactive_shell`、`background_exec`、`dangerous_git`（ask）、`npm_publish`（ask）——保留。

#### 2.4.3 放宽后的残余风险与信任约束

放宽后，用户一旦对看似无害前缀执行「确认并信任」，后续同类命令可含重定向/命令替换，注入场景下更易造成工作目录内破坏或管道外传。

**P0 定稿：结构化简单命令信任。**

1. 信任候选必须先由 Shell parser 解析为**单个简单命令**；信任范围至少保存 `{ executable, fixedArgvPrefix }`，按 token 边界匹配，不保存或使用原始字符串前缀作为授权依据。例如 `npm test` 不得匹配 `npm testing`。  
2. 含以下任一语法时，本次可按安全分析结果执行，但**不可新增持久信任，也不可命中已有信任跳过确认**：`$()`、反引号、管道、重定向、`&&`/`||`/`;`、换行、多命令、前置环境变量赋值、无法静态解析的变量/通配展开。  
3. 信任确认界面展示规范化范围（可执行文件、固定子命令/参数前缀、是否允许尾部参数），而不是只展示本次原始命令。默认尾部参数策略为“允许普通 argv token，禁止任何 Shell 元语法”；对无法解释参数边界的命令使用 exact argv。  
4. 信任项记录创建来源（desktop / feishu / wechat）、创建时间、最后使用时间和规范化范围，设置页支持单项立即撤销。自动失效可后续配置，但不阻塞 P0。  
5. legacy 前缀信任项升级后不得直接获得结构化免确认能力：能无歧义转换的需展示一次迁移摘要；不能转换的标记失效并要求重新信任。  
6. **§2.4 的 Shell 语法放宽不得早于本节结构化信任或“复杂命令永不因信任免确认”的兼容门禁。**

实现可分两步：先落地复杂语法强制 ask 的安全门禁，再上线完整结构化存储/UI；但全量发布前必须完成结构化匹配，不能长期停留在 `startsWith`。

---

### 2.5 速率限制（P1）

| 项 | 现状 | 目标 |
|----|------|------|
| `remoteRateLimitPerMinute` | 当前工作树默认 `60` | 保持 **`60`** |
| `maxParallelChatSessions` | 有 | 保留 |
| `tryClaimRemoteSession` | 有 | 保留 |

一对一下降多发送者洪泛面，但仍保留宽松限流防 Agent 失控 / 注入自刷；`10` 易误伤密集交互。

消息限流之外还必须设置损害预算（P1，全量发布门禁）。默认值按**单次远程任务/request**计算，均可在设计中向更严调整；若需放宽必须重新安全评审：

| 预算 | 默认 | 达限行为 |
|------|------|----------|
| 工具调用总数 | `50` | 暂停任务，要求用户显式继续或停止 |
| 脚本/Shell 累计墙钟时间 | `900s` | 终止当前可归属进程树并暂停 |
| 同时运行的脚本/Shell | `1` | 后续执行排队，不并行启动 |
| 连续外部写 | `10` | 在下一次外部写前 ask；批准后计数清零 |

达到预算后给出“继续/回到桌面/停止”的恢复路径，不得只静默丢消息。“继续”只增加当前任务一次相同额度，不永久修改默认。桌面必须始终可“停止当前任务”和“一键关闭远程”；紧急停止优先于 pending 确认与排队任务。

### 2.6 用户可见活动、审计与隐私（P1）

审计同时服务用户止损和开发排障，但二者展示层分离：

- 设置页提供“近期远程活动”，按会话展示绑定变化、信任新增/撤销、免确认工具、拒绝/预算暂停和外部写；用户可从记录直接进入会话、撤销信任或关闭远程。
- 绑定变化、信任新增及 **5 分钟内连续 3 次**安全拒绝主动通知桌面；绑定/安全设置变更同步通知对应 owner 私聊。普通成功操作只进入活动记录，不逐条推送。
- 本地审计默认保留 **30 天**（允许用户配置更短或手动清理）；仅本机授权用户可访问。提供导出与“清除远程活动”入口，清理不删除必要的当前配置/信任状态。
- 日志采用 allowlist 字段：保存事件类型、时间、来源、会话/请求关联 ID、verdict/pattern 编号和脱敏对象摘要。配对码、token/API key、Cookie、消息正文、完整脚本/命令和完整敏感路径不得明文记录；诊断需要时记录长度、hash、host 或受限 preview。
- 用户侧摘要使用产品语言；分析器编号、validatorId 和迁移内部字段只在可展开技术详情或导出诊断中出现。

---

## 3. 配置项与行为变更总表

### 3.1 配置项变更

| 配置项 | 当前工作树 | 目标约束 | 优先级 |
|--------|------|------|--------|
| `remoteAllowLocalWrite` | 默认与 fallback 均为 `true` | `false`=硬拒绝两文件写工具 | P0 |
| `remoteDenyOutbound` | 已有，默认 `false` | 保持显式硬拒绝语义 | P0 |
| `remoteBrowserNavigateRequiresConfirm` | 待新增 | 新装可 `false`；存量保持旧强度；仅控制 navigate | P1 |
| `remoteBrowserActRequiresConfirm` | 待新增 | 默认 `true`；高影响动作始终 ask | P1 |
| `remoteBrowserRequiresConfirm` | 已有组合字段 | deprecated，仅用于保守迁移 | P1 |
| `remoteScriptRequiresConfirm` | 待新增 | 新装可 `false`；存量默认 `true`；不覆盖分析器 ask/deny | P1 |
| `remoteSecurityConfigVersion` | 待新增 | 仅在用户完成升级摘要后推进 | P0 |
| `remoteConfirmPolicy` | 兼容字段仍可透传 | 禁止行为消费；旧值按 §2.3.2 迁移 | P0 |
| `remoteSenderAllowlist` | 类型可空，路由层 fail closed | 远程可用时必须有绑定身份 | P0 |
| `remoteGroupTrigger` / `remoteCommandPrefix` | legacy 字段可读取 | 废弃忽略，不得恢复群聊入口 | P0 |
| `larkCliWriteRequiresConfirm` | 当前工作树默认 `false` | 分类器未达标前全量发布必须为 `true` | P1 |
| `remoteRateLimitPerMinute` | 默认 `60` | 保持 `60` | P1 |
| 远程任务预算（工具数/累计执行时长/并行执行/连续外部写） | 待新增统一预算 | 默认 `50 / 900s / 1 / 10`，达限暂停而非丢弃 | P1 |
| `autoAllowScriptExecution` | legacy 配置仍可能存在 | 不得绕过内容分析 | P0 |
| 浏览器全局确认默认 | `true` | **不变** | — |

### 3.2 行为变更（非新配置项）

| 行为 | 当前工作树 | 目标约束 | 优先级 |
|------|------|------|--------|
| 远程写文件确认 | allowLocalWrite 时跳过 | 保持；关闭开关时必须硬拒绝 | P0 |
| `run_script` | 已接入清单 A/B 与 R 测试 | 保持折叠/别名门禁；外联远程 deny / 桌面 ask；R 明示残余 | P0 |
| Shell 信任远程录入 | 已有共享回复协议，存储仍为前缀语义 | 保持回复协议并改为 §2.4.3 结构化范围 | P0 |
| `redirection` 等 | 已放行 | 保持危险验证器不退化 | P1 |
| 远程 browser navigate/act | 当前工作树由同一远程开关覆盖 | 拆分；navigate 可免确认，act 默认确认且高影响 fail closed | P1 |

---

## 4. 实施优先级与依赖关系

### 4.1 依赖链

```
[2.1 一次性配对 + P2P + 微信发送者强制]  ← P0 信任地基
        │
        ├── [2.3.3 存量原子迁移]            (P0)
        ├── [2.4.3 结构化 Shell 信任]       (P0)
        ├── [2.2.2 run_script 分析]         (P0/P1 资源门禁)
        ├── [2.2.1 文件写确认移除]          (小流量)
        │
        ├── [2.4 Shell 验证器精简]          (不早于结构化门禁)
        ├── [2.2.4 lark_cli 高影响分类]     (P1)
        ├── [2.2.5 browser navigate/act 分层] (P1)
        └── [2.5/2.6 预算、止损、活动审计]  (P1)
```

### 4.2 当前收口顺序

当前工作树已覆盖 v1.5 主体，但 v1.6 新增 P0/P1 缺口，按以下顺序实施与收口：

1. 先落地一次性配对、存量原子迁移，以及 Shell 复杂语法永不因 legacy 信任免确认；三项完成前限制在内部灰度。
2. 完成结构化 Shell 信任存储/UI/迁移，再开放 Shell 语法放宽与小流量免确认。
3. 拆分脚本、navigate、act 配置；补脚本/会话资源预算、停止与恢复路径；补 browser/lark 高影响分类。
4. 建设近期活动、主动告警、日志保留/脱敏/导出/清理，并统一四项确认摘要。
5. 运行 §5 专项测试和全量回归，核对双通道竞态、deny 不进入确认桥及紧急停止优先级。
6. 完成 §6.5 跨文档和发布说明；全部适用 AC 通过后才可改为“已验收”。

### 4.3 分层发布与回滚

| 阶段 | 可开放能力 | 必须门禁 |
|------|------------|----------|
| 内部灰度 | P2P/owner、显式文件写开关、脚本分析、基础审计 | 仅测试用户；一次性安全摘要；随时停止任务/关闭远程；已知缺口显著提示 |
| 小流量 | 文件写免确认、navigate 免确认、结构化 Shell 信任 | 配对抗抢跑、存量原子迁移、Shell 元语法负例、活动记录与恢复路径通过 |
| 全量 | 脚本免确认新装默认、高影响 browser act 分层、飞书低影响写免确认 | 资源预算、高影响动作分类、用户侧活动/告警、隐私与清理策略全部可验收 |

出现错误绑定、信任范围越权、deny 绕过或任务无法停止时，立即关闭对应免确认 feature flag；必要时通过远程总开关停用入口。配置 schema 必须支持回滚到上一安全版本，回滚不得把显式硬拒绝或用户选择改宽。

---

## 5. 验收标准

### 5.1 身份与绑定

| # | 验收条件 |
|---|---------|
| AC1 | 飞书开启监听且未绑定 → 桌面显示一次性配对码；仅精确 `绑定 <有效码>` 的 p2p sender 可成为 owner；绑定消息不进入 Agent |
| AC2 | 非 owner 消息被拒绝，不触发 Agent；有用户可见提示 |
| AC3 | 群聊一律拒绝，不受旧 `remoteGroupTrigger` 影响 |
| AC4 | 绑定后 allowlist/owner 只读展示正确 |
| AC-Bind-Neg | 未绑定却宣称启用远程：业务消息拒绝并提示 |
| AC-Bind-Timeout | 绑定超时后 **`remoteEnabled=false`**，可复现 |
| AC-Bind-Cancel | 取消绑定后 **`remoteEnabled=false`** |
| AC-Bind-Rebind | 重绑后旧 open_id 立即失效；新 owner 生效 |
| AC-Bind-Code-Neg | 错误码、过期码、已使用码均不能绑定；错误尝试达到上限后窗口失效且远程关闭 |
| AC-Bind-Race | 同一配对码并发提交最多一个 sender 成功；其他请求不触发 Agent |
| AC-Bind-Notify | 绑定成功同时通知桌面和对应私聊；桌面展示脱敏身份、绑定时间和立即撤销入口 |
| AC-WeChat-Sender | 微信空 allowlist 或不匹配发送者时拒绝入站 |

### 5.2 确认与信任

| # | 验收条件 |
|---|---------|
| AC5 | 已完成当前安全配置版本且 `remoteAllowLocalWrite===true` 时远程写文件无 IM Y/N；未完成存量迁移时保持旧确认 |
| AC6 | 分析 `allow` 且 `remoteScriptRequiresConfirm=false` 的脚本可免确认；开关为 true 时仍 ask |
| AC7 | 分析 `ask` 的脚本仍确认；桌面全文；IM 超长可截断并引导桌面 |
| AC7b | 分析 `deny` 的脚本直接拒绝，无 Y/N |
| AC7c | 外联明显模式：**远程 deny**、**桌面 ask** |
| AC8 | 仅结构化简单命令范围命中的 Shell 可远程免确认；原始字符串前缀不得直接授权 |
| AC10 | 信任列表设置页可查改删；远程写入出现在同一列表 |
| AC-Cold-Start | 无信任条目时，典型 `npm test` / `git status` 仍确认 **1** 次 |
| AC-Steady | 已信任结构化简单命令 + 脚本 allow 且对应开关关闭时，多文件修改 + 跑测试确认次数可为 **0** |
| AC-Trust-Protocol | `Y` 只批一次；`Y trust` / `确认并信任` 写入；单独「信任」不批准不写入；非法回复提示用法；`requiresRiskAck` 时信任短语不批准不写入 |
| AC-Trust-Meta-Neg | 信任 `npm test` 后，`npm test $(curl …)`、反引号、重定向、管道、换行追加命令、前置环境变量赋值均不能免确认或新增信任 |
| AC-Trust-Token | `npm test` 可按明确 argv 规则匹配允许尾部参数，但不得匹配 `npm testing`；规则不依赖 `startsWith` |
| AC-Trust-UX | 写入前展示规范化范围；列表可查看来源、创建/最后使用时间并一键撤销；legacy 前缀项不会静默转换为更宽授权 |

### 5.3 策略与迁移

| # | 验收条件 |
|---|---------|
| AC12 | 旧 `remote_read_only` 不抛错，迁移后本地写拒绝 + 出站拒绝 |
| AC13 | 旧群聊/前缀字段不抛错，被忽略 |
| AC14 | 运行时改由新开关，不再靠 `policy==='remote_read_only'` |
| AC15 | 新装/已迁移规范化配置的 `remoteAllowLocalWrite` fallback 为 `true`；raw legacy 缺字段先进入保守迁移，不被此 fallback 静默放宽 |
| AC-Policy-Migrate | 迁移矩阵有测试；一键开关可用；文案含「不拦 run_script/run_shell」要点 |
| AC-Upgrade-Safe | 覆盖各 legacy policy、缺字段和自定义配置；摘要完成前各能力不比升级前更宽 |
| AC-Upgrade-Atomic | 摘要取消/关闭/异常退出不写配置版本、不部分保存；重启仍保持旧行为 |
| AC-Upgrade-Presets | “推荐/更安全”摘要覆盖文件、脚本/Shell、navigate、act、飞书外部写及非真正只读说明；保存后可在设置修改 |

### 5.4 脚本安全

| # | 验收条件 |
|---|---------|
| AC-Script-Detect-A | **基线必检（清单 A）**：至少覆盖 A2/`os.remove`、A1/`subprocess` 或 `os.system`、A7 绝对路径写、A6 外联——不得静默 allow；A6 远程须 deny |
| AC-Script-Detect-B | **扩版必检（清单 B）**：B1–B11 **每种至少 1 条正例单测**，期望 ask 或 deny；**禁止** `expected: allow`。返回 `patterns` 须含对应编号（如 `B3`） |
| AC-Script-Fold | 常量折叠门禁：`getattr(__import__('o'+'s'), 'sys'+'tem')` **必须**非 allow（B3；**不得**再标 known bypass） |
| AC-Script-Alias | 别名门禁：`import os as o; o.system('id')`（B5）与 `from os import system; system('id')`（B6）必须非 allow；建议另加 B7 `from os import system as s` |
| AC-Script-Residual-R | **残余风险（清单 R）**：至少各 1 例覆盖 R1；以及 R2 或 R3；单测可标 `expected: allow (known bypass)` 并写入发布/残余风险清单。**不得用 B 类示例充数**（夹具目录/命名可审计） |
| AC-Script-Env / AC25 | `run_script` 环境不含 API Key 类变量 |
| AC-Script-Budget | 免确认脚本受超时、输出上限和单会话并发限制；超限能终止可归属进程树并给出原因 |
| AC-Script-Stop | 桌面/IM 可停止当前任务，桌面可紧急关闭远程；停止优先于队列和 pending 确认 |
| AC-Script-Summary | 执行后可见耗时、退出状态、截断/预算情况和可观察修改摘要；有 checkpoint 时提供恢复入口 |
| AC-Script-Copy | 用户文案只称“未发现已知高风险模式”；deny 提供回桌面审阅路径，A/B 编号不作为主文案 |

### 5.5 Shell 验证器（P1）

| # | 验收条件 |
|---|---------|
| AC16–AC18 | 重定向、命令替换、多行不被对应验证器误杀 |
| AC19–AC21 | `rm -rf /`、`sudo`、`curl \| sh` 仍拦截 |

### 5.6 其他行为

| # | 验收条件 |
|---|---------|
| AC22 | 高影响飞书动作最小集合均默认 ask；分类不可靠时 `larkCliWriteRequiresConfirm=true`；设置含外部影响警示 |
| AC-Lark-Classify | 群/多人消息、批量/删除文档、日历邀请、权限/共享变更均有正反例；解析失败按 ask |
| AC-Browser-Scope | navigate 与 act 使用独立远程策略；新装 navigate 可免确认、act 默认确认；桌面默认不变 |
| AC-Browser-HighRisk | 提交、发送、购买/支付、删除、授权、账号/权限修改始终 ask；分类失败 ask |
| AC24 | `remoteRateLimitPerMinute` 默认 **60** |
| AC-Outbound-Deny | `remoteDenyOutbound=true` 时 wechat 出站与飞书写被硬拒绝 |

### 5.7 可观测性、文案、i18n、测试

| # | 验收条件 |
|---|---------|
| AC-Reject-Audit | bind / bind.timeout / bind.cancel / reject_non_owner / reject_group / trust_add / script_ask / script_deny / skip_confirm 等可查 |
| AC-i18n | 绑定引导、拒绝原因、确认用法、信任提示、只读 owner、一键限制开关诚实文案等均走 `t()`；`i18n:check` 通过 |
| AC-Tests | 单测覆盖：入站/一次性配对负例与并发、脚本 A/B/R + 资源终止、结构化 trust 与元语法负例、存量原子迁移、browser/lark 风险分类、预算暂停/继续、审计脱敏；集成测试覆盖双通道竞态和紧急停止 |
| AC-Confirm-Summary | 所有用户确认主文案统一展示“风险、影响对象、是否可撤销、下一步”；内部策略编号只在详情/审计出现 |
| AC-Activity | 用户侧近期活动可查看免确认执行、拒绝、信任新增、绑定变化和外部写，并可按会话定位 |
| AC-Audit-Privacy | 明确默认保留期、访问权限、字段脱敏、导出与清理；配对码、密钥、完整敏感命令/脚本不得明文入日志 |
| AC-Alert | 绑定变化、信任新增和短时连续拒绝主动通知；普通成功操作不逐条推送以避免告警疲劳 |
| AC-Task-Budget | 每会话工具次数、累计执行时长、并行任务、连续外部写阈值可测试；达到阈值暂停并给恢复方式 |

**用户可见拒绝文案（需求级）：** 未绑定、非 owner、群聊禁用、出站被拒、脚本 deny、非法确认回复、单独「信任」用法提示。

---

## 6. 关联文件、范围外与文档同步

### 6.1 前置需求（含冲突消解）

| 文档 | 本需求对其的效力 |
|------|------------------|
| [wechat-remote-outbound-confirm-removal-requirement.md](./wechat-remote-outbound-confirm-removal-requirement.md) | 出站确认移除有效；G5 已于该文档 **v1.1** 改为过渡期 + 移交 `remoteDenyOutbound`（**已落盘**） |
| [confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md) | 远程回复协议复用；原“前缀信任”授权粒度被本需求 §2.4.3 收紧，需同步结构化范围与迁移规则 |

### 6.2 关联实现文件

| 文件 | 关联需求 |
|------|----------|
| `electron/feishu/feishuInboundParser.ts` | 2.1.1、群聊移除 |
| `electron/feishu/remoteCommandRouter.ts` | 2.1.2 绑定状态机 |
| `electron/wechat/weChatCommandRouter.ts` | 2.1.3、2.5 |
| `electron/toolChatLoop.ts` | 2.2、2.3 |
| `electron/shell/shellSecurity.ts` | 2.4 |
| `electron/shell/shellCommandTrust.ts` | 2.2.3、2.4.3（由前缀存储升级为结构化范围） |
| `electron/tools/builtinExecutors.ts` | 2.2.2 env |
| `src/shared/imTypes.ts` 等 | 配置：访问控制、脚本/browser 分层、配置版本与 deprecated 迁移 |

### 6.3 本需求已引入的实现文件

| 文件 | 用途 |
|------|------|
| `electron/shell/scriptContentSecurity.ts` | `run_script` 内容分析 |
| `electron/feishu/feishuOwnerBind.ts` | 飞书 owner 绑定状态机 |
| `electron/remote/imConfirmReply.ts` | 飞书/微信共享的文本确认与信任协议 |

### 6.4 关联安全重构（不在范围）

- 7.1.3 CSP  
- 7.2.1 Shell AST 级解析  
- **7.2.2 远程内容提示注入防护**——分期  
- 7.3.2 IPC 来源验证  
- 7.3.3 远程沙箱  

### 6.5 跨文档同步（交付物）

| 项 | 状态 |
|----|------|
| `wechat-remote-outbound-confirm-removal-requirement.md`（G5 / remote_read_only） | **已完成（v1.1）** |
| `feishu-integration-requirement.md` / `wechat-integration-requirement.md` 群聊与旧默认值 | 实现 PR 或紧随文档 PR |
| 设置页 i18n（含诚实一键文案） | 当前工作树已落地中英文文案；待 `i18n:check` 与 UI 回归 |
| 安全/UX 评审 v1.6 新文案（配对码、升级摘要、结构化信任、活动页） | 随补强实现落地，未完成前不全量发布 |
| 分析报告「必须保留 remote_read_only / 群聊」勘误或状态标注 | 可另任务，须有人认领；**实现合入前应关闭或明示挂起** |

---

## 7. 与当前代码事实对齐

| 事实（2026-07-15 当前工作树） | 需求约束 / 尚需证明 |
|------|------|
| `remoteAllowLocalWrite` 默认及运行时 fallback 均为 `true`；关闭时文件工具硬拒绝 | 迁移、缺省配置和飞书/微信两端都要有回归 |
| 飞书路由拒绝群聊并校验 owner；当前绑定仍是窗口内首条 p2p | 必须替换为 §2.1.2 一次性配对码；这是 P0，不可仅补测试 |
| 微信路由在 allowlist 为空或不匹配时拒绝；IPC 会从扫码绑定结果回填 allowlist | 需覆盖旧配置升级、解绑再启用和登录态变化 |
| `scriptContentSecurity.ts` 已实现 A/B 命中编号、常量折叠、别名跟踪和 B11 窗口；R 有独立残余测试 | 仍以 §5.4 全部门禁为准；分析失败必须 ask，远程外联必须 deny |
| `toolChatLoop.ts` 已接入脚本分析、过滤环境、组合式远程浏览器覆盖、lark 写默认免确认和显式访问控制 | 仍需脚本独立开关/预算、navigate/act 拆分和 lark 高影响分类；deny 不能进入确认桥 |
| `imConfirmReply.ts` 已统一 `Y/N/Y trust/确认并信任`；两端 ConfirmManager 已接入；底层信任仍为前缀匹配 | 回复 UX 保持；底层必须按 §2.4.3 改为结构化信任，P0 未关闭 |
| `remoteDenyOutbound`、组合式 `remoteBrowserRequiresConfirm` 已进入共享类型、默认配置和设置页；限流默认 60 | 新增保守升级版本、脚本开关、navigate/act 拆分；验证桌面默认不变 |
| `remoteConfirmPolicy` 及旧 UI/类型仍可能为兼容而存在，路由上下文仍可透传该值 | 允许兼容存在；禁止在工具执行路径把它作为确认/拒绝依据；`remote_read_only` 仅允许在 merge/migration 层映射显式开关 |
| `redirection`、`command_substitution`、`multiline` 已从 Shell 硬拦列表移除 | 结构化信任落地前，含这些元语法的命令必须强制 ask；持续回归其他危险规则 |

若实现与本表再次偏离，应先更新本节的代码证据和风险判断，再调整目标或验收；不得只修改“现状”文字掩盖安全语义变化。

---

## 8. 设计稿应对齐的约束清单（复审保留）

1. 身份地基与减确认同版本可验收  
2. §2.4 不早于 §2.2.3  
3. 脚本分析未达 **AC-Script-Detect-A/B、Fold、Alias** 前，不对外声称“未发现已知高风险模式的脚本可免确认”；R 仅作残余披露，**禁止 B 充 R**。  
4. 绑定配对、存量原子迁移、结构化 Shell 信任为 P0；不得以当前工作树“已有实现”为由降级。  
5. NG8：浏览器只做远程覆盖，不改全局默认；navigate/act 必须拆分，高影响分类失败 ask。  
6. §2.5/2.6 与 §5.7 的预算、止损、审计隐私、活动页和 i18n 纳入全量发布 DoD。  
7. §0.2 的旧浏览器/lark 默认决策已被 v1.6 覆盖；A/B/R 技术门槛保持不变。  

建议设计目录：一次性配对状态机 → 存量安全配置迁移 → 结构化 Shell 信任与 legacy 转换 → `analyzeScriptContent` 及资源预算 → browser navigate/act 风险分类 → lark 高影响 argv 分类 → 活动审计/止损 → 分层发布与回滚 → 测试计划映射 §5 → §6.5 跨文档同步。

---

**文档结束**
