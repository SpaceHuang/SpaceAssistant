# 桌面链路 fail-open-to-user 开发计划（审批失败回退人工确认卡）

- 日期：2026-09-22
- 状态：**待评审，本文不代表功能已实现**
- 定位：**下一步计划**（前置依赖：I4 场景限定修订，已随本文同批完成）
- 定稿状态：§4 与 §8.1–§8.5 **均已定稿**，无待决项
- 上游：`docs/develop/architect/confirmation-answerer-and-auto-approval-design.md`（I1–I5，其中 I4 已修订为场景限定）
- 前置（均已落定）：`docs/develop/desktop-auto-approval-plan.md` 决策 6 由本计划承接；I4 的「不得回退为询问用户」已限定为无人值守上下文；`security-approval-experience-improvement-plan.md` §1「服务故障不自动转人工」已同步限定（见 §8-1）
- 关联：`docs/develop/security-approval-experience-improvement-plan.md`（其 §1 口径与本计划的关系见 §8-1）
- 修订：2026-09-22 吸收评审 v1（`docs/review/desktop-fail-open-to-user-plan-review-v1.md`）——**B1**（回退场景的审计事件序列与统计口径，见 §5.4）、**B2**（`confirmAnswererKind` 派生需联动修改，见 §5.1 第 3 条与 §5.5）、**B3**（回退原因文案需新增 i18n，不能复用 `summaryFor`，见 §5.3）；另吸收 6 项非阻断意见（§5.9 描述收窄、§8.5 提交切分、§5.1 插入点时序、§6.3 IM lane 锚点用例、§5.4「agent 裁决率」按 `cause` 过滤有效裁决、§5.3 `reason` 对齐既有短原因短语形态）
- 范围：**仅桌面链路**（`desktop` lane）。wechat / feishu 与 automation **零行为变化**。

---

## 1. 结论

桌面档位实施后，standard 档把非 locked `ask` 变换为 `auto`。`auto` 的处理顺序是「先跑确定性快通道，定不了则交审批 Agent」。这一步变换**取消了原本会产生的人工确认卡**：在变换之前，这批动作由人工确认；变换之后，它们由审批 Agent 裁决。

而审批 Agent 失败时（不可用 / 超时 / 输出不可解析 / 准入不可得），当前实现一律 fail-closed 拒绝，**不会退回人工确认**——因为回退路径从未接线。结果是桌面这个「有人在场」的场景，反而丢失了它原本就有的人工兜底能力。

本计划补回这条路径：**审批失败时把决定权交还给在场的人**，而不是替人做拒绝的决定。

同时明确一点边界：这**不是**在放宽安全性。回退后产生的仍是标准的、两态的人工确认卡，风险面与「原本的 ask」完全相同；本计划不新增第三种裁决、不放行任何动作。

### 1.1 为什么现在是必做项

| # | 事实 | 来源 |
| --- | --- | --- |
| 1 | standard 档把非 locked `ask` 变换为 `auto` | `desktop-auto-approval-plan.md` §2.1（已实施） |
| 2 | `auto` = 快通道定不了 → 审批 Agent | 同上 §2.3 |
| 3 | 变换后这批动作**不再产生人工确认卡** | 同上（变换即取消卡片） |
| 4 | 审批失败路径当前全 fail-closed，**无卡片可退** | `electron/confirmation/agentChannel.ts`（无 fallback 分支） |
| 5 | I4 的「不得回退为询问用户」**已限定于无人值守上下文** | `architect/confirmation-answerer-and-auto-approval-design.md` §3（本次修订） |

第 5 条是关键：在本次修订之前，I4 字面上禁止任何「回退为询问用户」，因此该缺口被表述为「本轮不做」；修订之后，有人值守链路的失败去向已明确不在 I4 约束内，补齐该路径不再需要重新论证不变量。**这也是本次把 I4 表述限定化列为前置的原因——先解除字面约束，再开工。**

---

## 2. 现状盘点（已确认事实）

| 项 | 现状 | 影响 |
| --- | --- | --- |
| `DesktopChannel` | **仍存在且可用**（包装既有确认注册表与确认卡片），能力未被删除 | 兜底目标通道现成，无需新建通道 |
| `resolveConfirmChannel` 对 desktop + `kind='user'` | 返回 `DesktopChannel` | 普通 `ask` 路径完好 |
| `kind='agent'`（桌面 `auto` 定不了时） | 经工厂构造 `AgentChannel`；其内部失败一律 fail-closed | **缺口所在** |
| 通道选择形态 | `channelFor` / `resolveConfirmChannel` 为**单次选择**，没有「agent 失败后再选一次 user」的组合 | 需新增组合层，而非修改现有分支 |
| 配置类失败 | `denyFallback` 把「配置损坏」与「agent 工厂未接线」归为同一个 `config-error` | 桌面需分道（见 §4-2） |
| 卡片原因展示 | 复用既有 `autoApproveFallback` 字段与 banner（§8.5）；banner 需从文件类卡片提升到确认态统一层级，否则非文件类回退时用户看不到原因 |
| 回退时卡片仍是只读态 | `autoAnswerer` 会使卡片渲染为无按钮的「自动审批中」静态块；且条件写入无法用「不发字段」清除，须显式清（§5.8） |
| 审计事件 | 已有 `confirm.answerer-fallback`（当前用于「降级为拒绝」） | 语义需区分（见 §5-4） |
| waiter 登记条件 | `prepareToolConfirm` 仅在 `answerer === 'user'` 时调用（agent 路径不登记 waiter） | 回退前须补登记，顺序见 §5.1 |
| 渲染端待确认来源 | `chatGetPendingConfirmation` 只查 turnRuntime 的 assistantMessage（要求 `status === 'confirming'`），不查 `toolConfirmRegistry` | 回退时须保持工具为 `confirming`（§5.1 / §5.9） |
| `approval-updated` 接线状态 | 消费端已就位（失败即置 `rejected` 终态），但 `electron/` 侧**无生产点**（SDK 迁移预留） | 迁移接线后回退分支须在其之前（§5.9） |

**缺口一句话**：`AgentChannel` 返回 `ok:false` 之后，没有任何一方知道「这个 lane 有人在场，可以再问一次」。

---

## 3. 目标行为

以 desktop lane 为例（automation 见 §7）：

```
未命中规则
  ├─ 快通道可判定 ──────────────→ 按快通道结论（不变）
  └─ 快通道定不了 → 审批 Agent
        ├─ 拿到裁决 ─────────────→ approve / deny（不变）
        └─ 失败 ───────────────→ 按 §4 矩阵分流
              ├─ 可回退类别（unavailable / timeout） → 【本计划新增】挂人工确认卡
              │                                         ├─ 用户批准 → 执行（并可写 decision_cache）
              │                                         └─ 用户拒绝 → 不执行
              └─ 其余（unparsable / config-error / recursion-blocked） → 仍 deny（不变）
```

用户可见形态：与普通 `ask` 的确认卡**完全一致**（同一个 `DesktopChannel`、同一套卡片），但卡片须能说明「自动处理未完成」及其短原因（§5.3）。

---

## 4. 失败去向矩阵（**已定稿**）

判定表放在通道层（数据化），不放提示词、不进规则集（与 I5 的教训一致：进规则集会被套餐档位改坏）。

**判据（新增 cause 时按此归类）**：区分「环境不可用」与「产品契约问题」——

- **环境 / 运行时问题**（系统能力暂时不足，重试或人工可兜）→ **转人工**；
- **产品缺陷 / 契约问题**（失败本身即是缺陷信号，转人工会掩盖它）→ **保持 deny**；
- **结构性问题**（与人在不在场无关）→ **保持 deny**；
- **有效裁决**（已拿到结论）→ **不回退**。

| `cause` | 含义 | 去向 | 归类与理由 |
| --- | --- | --- | --- |
| `unavailable` | 拿不到准入位、模型或会话调用失败 | **转人工** | 环境问题：典型的「系统能力不足」，人可兜 |
| `timeout` | 审批超出时间上界 | **转人工** | 环境问题：桌面上用户正在等，挂卡片优于替他拒绝（见 §4.1） |
| `unparsable` | 输出无法解析 | **保持 deny** | 契约问题：模型输出不符合同，属需修的缺陷信号，转人工会掩盖它（见 §4.2） |
| `config-error` | 配置损坏 / 通道未接线 | **保持 deny** | 契约问题：同属产品缺陷，且已有独立告警路径 |
| `recursion-blocked` | 递归守卫触发 | **保持 deny** | 结构性问题：与「人在不在场」无关 |
| `agent-deny` | 拿到了裁决，结论为拒绝 | 不适用 | 有效裁决，绝不回退；否则等于「被拒就再问人」，形成绕过（见 §4.3） |

**结论**：桌面回退范围为 **`unavailable` + `timeout`** 两格。

### 4.1 `timeout` → 转人工（已定）

**理由**：桌面上用户正在等这次审批；超时说明系统没能在上界内给出结论，此时挂卡片比替用户做拒绝的决定更符合「有人在场」的处境。且回退后产生的仍是标准两态人工确认卡，风险面与「原本的 `ask`」完全相同。

**必须同时满足**：

1. 卡片原因须显示「超时」，使用户知道已经等待过（而不是卡片无故出现）；
2. 等待上界不放宽（见 §5.6）——用户总等待时间 = 审批上界 + 卡片上界，需在文案上让这个成本可见；
3. **仍须交付回退率观测**（§6.2）：超时若频繁发生，会批量转为人工，使「自动」档形同虚设。这是本格的主要风险，观测是它的缓解手段。

**与参考实现的口径差异（记录在案）**：参考实现（某开源编码 Agent 的自动审批审查器）对超时取「拒绝」，只有输入预算类失败才回退人工。本方选择不同，理由是场景不同——本方桌面上有人在场，而参考实现的审查器在其定位下更接近无人前置审查。此差异属有意偏离，非疏漏。

### 4.2 `unparsable` → 保持 deny（已定）

**理由**：`unparsable` 是**被判模型违反了输出合同**，属产品缺陷信号，与 `config-error` 同类，而不是「环境暂时不可用」。若把它转为人工，则「模型输出格式不稳定」这一缺陷会被人工卡片静默吸收——**症状消失、病根留存**，且无人会发现提示词或解析器需要修。这与参考实现「解析失败 → FailedClosed(denied)」的口径也一致。

**影响（须记录）**：模型输出格式漂移时会表现为操作被拒（用户可见「审批未通过」类的拒绝理由）。这是**预期行为**，不是回归。

**处置路径**：若实测 `unparsable` 率偏高，应按「产品缺陷」处理——检查提示词输出合同与 `parseApprovalVerdict` 的匹配度、模型选择是否合适，而**不是**把它改为转人工。`unparsable` 率因此也是一项应纳入观测的指标（见 §6.2）。

### 4.3 一条不可让步的规则

**`agent-deny` 永不回退。** 审批 Agent 给出了有效裁决（拒绝）时，不得挂人工卡。否则「被 agent 拒绝」会变成「再问一次用户」，用户有可能在被拒后批准——这实质上是绕过裁决，且会诱导「反复重试直到有人批」。若将来确实需要「用户看到风险后明确复批」的能力，那应作为**授权证据变化后的重裁**设计（线索包携带前次结论 + 本次授权证据），而**不是**本计划的回退路径。

---

## 5. 关键设计点

### 5.1 组合位置与插入点

**插入点**：`electron/toolChatLoop.ts` 的 `const channelOutcome = await approvalChannel.request(confirmReq)` 之后、`outcome` 判定之前。这是本计划唯一需要改动的流程位置。

> 时序提示（评审非阻断 3）：该调用形如 `await approvalChannel.request(confirmReq).finally(...)`，`finally` 中会释放审批信号量、回退等待计数并尝试恢复共享租约。因此**拿到 `channelOutcome` 时，finally 的清理已经发生**。回退路径若需要占用同类资源（例如重新发卡片期间的租约/信号量语义），须显式确认无复用冲突，不要默认资源仍被持有。

**不让 `AgentChannel` 内嵌 fallback**：它是桌面与 automation 共用的通用通道，不该知道桌面卡片的存在；且「能否回退」与 lane 相关，属调用方知识。

**抽取形态**：回退时**以同一 `resolveConfirmChannel` 再解析一次，但把回答者固定为 `user`**，复用既有桌面分支。好处是不必新增 `FallbackChannel` 类型，也不必让组合器持有两套卡片状态。（原草案的包装方案会把「传输通道解析」逻辑复制一份，且未涵盖下面三处联动点。）

**三处必须同时做的联动动作**：

1. **先补登记 waiter**。`prepareToolConfirm` 当前只在 `answerer === 'user'` 时调用：

   ```
   if (!remoteContext && (gate.decision.type !== 'require-confirm' || gate.decision.answerer === 'user')) {
     void toolConfirmRegistry.prepareToolConfirm?.(...)
   }
   ```

   即**agent 路径没有登记 waiter**。回退前必须补登记——既有约定是「waiter 必须先于 `confirm-requested` 登记，避免用户点击到悬空卡片」。若只依赖回退后 `waitForToolConfirm` 自动新建（它有 `if (existing) return existing.promise`，无则新建，机制可行），会短暂存在「卡片已出、waiter 未登记」的窗口。

2. **保持工具为 `confirming`**。渲染端 `chatGetPendingConfirmation` 的命中条件是：

   ```
   turn.assistantMessage.toolCalls?.find(c => c.id === toolCallId && c.status === 'confirming')
   ```

   它**只查 turnRuntime 的 assistantMessage**（不查 `toolConfirmRegistry`）；工具状态非 `confirming` 时返回 `not-awaiting`，卡片拿不到 `confirmationReady`，无法交互。因此回退时**不得先把该工具置为终态**（见 §5.9）。

3. **回传实际回答者**（评审 B2，**阻塞项**）。`electron/toolChatLoop.ts` 中 `confirmAnswererKind` 的派生**优先取 `gate.decision.answerer`**：

   ```
   confirmAnswererKind =
     gate.decision.type === 'require-confirm'
       ? gate.decision.answerer          // ← 回退场景下这里恒为 'agent'
       : (channelOutcome.answererKind ?? 'user')
   ```

   回退场景的 gate 决策是 `require-confirm + answerer='agent'`，因此**即使实际由用户在卡片上完成确认**，`confirmAnswererKind` 仍被算成 `'agent'`，于是：

   - 记忆写入被直接跳过（`toolChatLoop.ts` 的 `if (confirmAnswererKind !== 'user')` 分支，log `tool.confirm.non_human_answerer_skip_memory`）；
   - 即使放过去，也会被写入器第一道闸抛错（`decisionCacheWriter.ts` 的 `if (args.answererKind !== 'user') throw new Error('MEMORY_WRITE_NOT_HUMAN_ANSWERER')`）。

   **后果**：§5.5 与交付判据「回退后的人工确认可写 `decision_cache`」**按现状实现必然失败**。这不是测试写法问题，而是漏掉的一处必改点。

   **修改要求**：派生顺序改为**以通道返回的实际回答者为先**，gate 派生只作回落：

   ```
   confirmAnswererKind =
     channelOutcome.answererKind
     ?? (gate.decision.type === 'require-confirm' ? gate.decision.answerer : 'user')
   ```

   安全性说明：`DesktopChannel` 与 `DenyChannel` 的 outcome 均**不携带** `answererKind`，因此这两条路径会回落到既有派生，行为不变；`AgentChannel` 始终携带 `'agent'`，行为亦不变。**只有回退路径**（组合层把最终 outcome 的 `answererKind` 设为 `'user'`）会走到新分支——这正是要修正的那一格。I3 的三道闸本身设计正确，问题只在调用侧的取值来源。

**`cancel()` 需同时转发**：主通道与回退通道都要收到取消，否则回退后的卡片会遗留无人取消的 waiter。

### 5.2 可回退判定必须与「配置损坏」分道

`denyFallback` 当前把「配置损坏」与「agent 工厂未接线」归一为 `config-error`，两者在桌面都应仍 deny；但**回退判定必须能区分「agent 运行时失败」与「agent 根本没接上」**。否则会出现：工厂未接线 → 每次都静默回退人工，「自动」档静默失效且无人察觉。

### 5.3 卡片必须携带原因

用户需要知道「为什么这次让我来确认」。承载方式已定稿为**复用既有 `autoApproveFallback` 字段与卡片 banner**（§8.5）：`reasonCode` 取 `unavailable` / `timeout`（即 §4 矩阵中可回退的两格），`reason` 取**短原因短语**（用户可见）。

> **字段区分（避免实现时混淆）**：`reasonCode` 是**卡片字段**（`AutoApproveFallback['reasonCode']`），`cause` 是**审计字段**（`confirm.outcome` / 回退事件）。两者**语义同源**（都表达「哪一类失败」），但**不是同一个字段、取值也不必逐字相同**——`reasonCode` 面向界面、可加域前缀（见下文命名小项），`cause` 面向审计、须保持既有枚举不变。不要用 `reasonCode` 去写审计，也不要用 `cause` 去驱动卡片分支。

#### 原因文案的来源（评审 B3，**阻塞项**）

原稿写「`reason` 与 `AgentChannel.summaryFor` 同源」——**该表述不成立，已撤销**，原因有两点：

1. `summaryFor` 是 `electron/confirmation/agentChannel.ts` 中的**模块级私有函数**（无 `export`），「同源复用」本身就需要先导出或抽取；
2. 更关键的是**语义冲突**：其四个分支文案全部是 fail-closed 措辞、均带「**已按拒绝处理**」（例如 timeout：「安全审批超时，已按拒绝处理。可改用只读方式完成，或缩小操作范围后重试。」）。把它放进一张**正在等待用户批准/拒绝**的卡片 banner，用户读到的是「已按拒绝处理，请确认本次操作」，自相矛盾。

**因此需要新增用户可见原因文案**（按 i18n 规范，zh-CN / en-US 双份，不得硬编码），两条即可覆盖可回退两格：

| `reasonCode` | `reason`（示例，措辞待定稿） | 卡片实际呈现 |
| --- | --- | --- |
| `unavailable` | `服务暂不可用` | 自动处理未完成：服务暂不可用。本次操作需要您手动确认。 |
| `timeout` | `等待超时` | 自动处理未完成：等待超时。本次操作需要您手动确认。 |

**形态约束（本次修正）**：`reason` 必须是**短原因短语**，**不得**再带「未通过 / 未能完成 / 需要手动确认」这类语义——这些已由 banner 模板承载（模板句为「自动处理未完成：`{{reason}}`。本次操作需要您手动确认。」）。原稿示例写作「自动审批未能完成（服务暂不可用），需要您手动确认」，与模板重复、读起来是「自动处理未完成：自动审批未能完成（…），需要您手动确认」，已撤销。

对齐依据：既有同类字段的 `reason` 即为此形态——`writeFileAutoApproval` 的产出为 `目标路径命中敏感目录` / `写入体量超过自动放行阈值（512 KB > 256 KB）` / `单次替换文本过大（1234 > 1024 字符）`，均为可嵌入模板的短语；新增文案应保持同一形态。

**`reasonCode` 命名（待定稿的小项）**：既有取值为 `sensitive_path` / `oversize` / `edit_too_large`（属「文件自动放行」域）。新增 `unavailable` / `timeout` 虽不与之冲突，但语义偏泛、未标明来源域；建议改用带域前缀的取值（如 `approval_unavailable` / `approval_timeout`），避免与将来其他来源的同类失败混淆。**注意**：前端只消费 `reason` 不消费 `reasonCode`，故该取值可自由选择、不影响渲染。

**注意与 §8.5 的范围区分**：§8.5 已完成的是 banner **模板句**的通用化（「自动处理未完成：{{reason}}。本次操作需要您手动确认。」），解决的是「模板是否适配非写入类工具」；本节解决的是 **`{{reason}}` 插值本身的来源**——两者是不同层次，前者完成不等于后者就绪。可选的一种整洁做法：定义一张共享的「环境失败原因」表，同时供 `summaryFor`（保留其 fail-closed 后缀）与卡片 `reason`（用中性措辞）取用——若如此，`summaryFor` 的「已按拒绝处理」后缀需拆分出去。

**脱敏要求**：原因文案不得暴露内部状态细节（准入队列状态、模型名、配额余量等）。

**覆盖面**：banner 提升到确认态统一层级，七类确认卡片均显示（§8.5）。

**交叉引用**：`notExecutedReason` 的归类（`confirm_unavailable` / `confirm_timeout`）是另一条链路，与本节文案无关，不要互相牵连修改。

### 5.4 审计：两个维度都要正确

这是一个容易做错的地方。回退后的人工确认，**必须同时表达两件事**：

| 维度 | 正确取值 | 做错的后果 |
| --- | --- | --- |
| 谁批的 | `actor='user'`（确实是人在卡片上批的） | 若仍记 `agent`，归因失真 |
| 有没有拿到裁决 | 需能看出「本次是回退」 | 若只记 `cause='user-approved'`，则「审批不可用率」无法统计，服务健康度不可观测 |

建议：实到 outcome 由 `DesktopChannel` 正常落（`actor='user'`、`cause='user-approved' | 'user-denied'`），**另落一条回退事件**携带原 `cause`。既有 `confirm.answerer-fallback` 的语义是「配置异常时降级为拒绝」，与本计划**方向相反、处置动作也相反**，因此不复用——已定稿新增事件名 `confirm.answerer-fallback-to-user`（理由、形态与实现待办见 §8.3）。

#### 回退场景的完整事件序列（评审 B1，**阻塞项**）

原稿只设计了「回退事件 + 用户 outcome」两条，**漏了既有的一条**：`AgentChannel` 对**所有** outcome（含 `ok:false` 的失败）都已统一落 `confirm.outcome`（`actor='agent'` + `actorRef` + `latencyMs`）。

因此一次回退实际会落**三条**事件（同一 `requestId` 关联）：

| # | 事件 | `actor` | `cause` | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `confirm.outcome` | `agent` | `unavailable` / `timeout` | **既有，原稿未提** |
| 2 | `confirm.answerer-fallback-to-user` | `system` | `unavailable` / `timeout`（原 `cause`） | §8.3 新增 |
| 3 | `confirm.outcome` | `user` | `user-approved` / `user-denied` | `DesktopChannel` 正常落 |

**处置（已定稿）：保留双 outcome，并显式定义统计口径。** 不抑制第 1 条，理由：

- **两条 outcome 各自都真实**，不构成错误归因——第 1 条表达「agent 侧没有拿到裁决」，第 3 条表达「用户侧拿到了裁决」；这正是 §5.4 要表达的「有没有拿到裁决」维度；
- 抑制第 1 条需要 `AgentChannel` 知道「本次可能被回退」（桌面语义），破坏「通用通道不知桌面卡片」的分层（§5.1）；且 automation 无回退，不能无条件抑制；
- 真正的问题不是事件多了，而是**下游聚合口径**——这是需要写清的，而非需要删事件的。

**统计口径（下游必须遵守，写入 §6.2）**：

| 指标 | 分子 / 分母 |
| --- | --- |
| **agent 裁决率 / 拒绝率** | 仅取 `actor='agent'` **且 `cause ∈ {agent-approved, agent-deny}`** 的 `confirm.outcome`——**必须按 `cause` 过滤出有效裁决**，否则 `unavailable` / `timeout` / `unparsable` / `config-error` / `recursion-blocked` 等「没拿到裁决」的失败会被计入「agent 拒绝了」，把失败率混进拒绝率 |
| 用户批准率 / 拒绝率 | 仅取 `actor='user'` 的 `confirm.outcome`（`cause ∈ {user-approved, user-denied}`） |
| **回退率** | 分子 = `confirm.answerer-fallback-to-user` 计数；**分母 = `confirm.request` 计数**（**不**用 outcome 计数，避免同一请求被双计） |

**规则**：

- 同一 `requestId` 出现两条 `confirm.outcome` 在回退场景下**属正常**；任何跨 `actor` 合并 `confirm.outcome` 的聚合都是错的；
- `actor='agent'` 的 outcome **不等于**「agent 做了裁决」——它只是「agent 侧给出了结果」，其中多数失败属于「没拿到裁决」（§4 的六个 `cause` 中只有两个是有效裁决）。这一点是本项目最容易被统计写错的地方。

#### 附带缺口：`effectiveTimeoutMs <= 0` 路径不落任何审计

`AgentChannel` 中「审批已超过父任务截止时间」的提前返回（`cause='timeout'`）在 `confirm.request` 记录**之前**就 return 了，因此该路径**既不落 `confirm.request`、也不落 `confirm.outcome`**。

该路径属于 §4 矩阵中的**可回退格**（`timeout`），回退后只会落 `confirm.answerer-fallback-to-user`（第 2 条）与用户 outcome（第 3 条），**缺 agent 侧痕迹**。后果：

- 按 `cause` 分列的回退率会**系统性漏计**这一类超时（分母 `confirm.request` 未计入，分子计入，比率偏高）；
- 审计上无法区分「因父任务截止而提前失败」与「正常参与审批后超时」。

**处置（已定稿：补审计）**：把 `confirm.request` / `confirm.outcome` 的记录**移到该提前返回之前**（该路径属可回退格，应留下 agent 侧痕迹）。改动约数行，不改变返回值与 fail-closed 语义。若实现时评估认为不宜调整该顺序，则**至少**须在 §6.2 记录该口径缺口，不得静默。

### 5.5 回退后的人工确认可写缓存（I3 的正当使用）

回退产生的是**真实人类确认**，因此与普通 `ask` 等价：**可以写入 `decision_cache`**，写入凭证由既有的记忆资格与档位三道闸控制。

这一点需要显式声明，因为它看起来像「agent 失败却产生了缓存」——实际不是：缓存来源是人，不是 agent。I3（记忆只源于人类）在此**恰好被正确使用**，而不是被绕过。

> **前置条件（评审 B2，阻塞项）**：本节的结论**当前不成立**，必须先做 §5.1 第 3 条（回传实际回答者）。若不改 `confirmAnswererKind` 的派生来源，回退后它仍由 `gate.decision.answerer` 派生为 `'agent'`，记忆写入会在调用侧被跳过、或在写入器第一道闸被 `MEMORY_WRITE_NOT_HUMAN_ANSWERER` 抛错。**三道闸本身无需改动**——它们是 I3 的正确实现，问题只在调用侧的取值来源。

### 5.6 等待仍有上界

「有人在」不等于可以无限等。回退后的卡片等待沿用既有确认上界（`CONFIRM_MS`），超时后按既有桌面行为处理。**不得**因为走了回退路径就放宽等待上界。

对 `timeout` 格尤其重要：用户总等待时间 = 审批上界（30s）+ 卡片上界，比原本的 `ask` 更长。这不能通过放宽任一上界来「补偿」，只能通过文案让成本可见（见 §4.1 / §5.3）。

### 5.7 不引入第三种裁决

回退后仍是两态（批准 / 拒绝）。不新增「让用户决定要不要重试自动审批」「让用户选择信任级别」这类选项——那会把审批从两态决策变成多态流程，与既有设计原则冲突。

### 5.8 回退必须显式清除 `autoAnswerer`（UI 前置条件）

desktop 走 agent 裁决时，卡片会被渲染成**只读态**：`ToolCallCard` 在 `status === 'confirming' && record.autoAnswerer` 时直接返回「正在由审批 Agent 自动裁决，无需手动确认」的静态块，**不出任何交互按钮**。回退要成立，必须让卡片变回可交互——否则用户根本没有按钮可点，回退在 UI 层不成立。

**容易踩的陷阱**：多处构造 record 时采用「先展开 `...tool`，再按条件写字段」的写法，条件字段**只在为真时写入**，因此第一次写入 `autoAnswerer: true` 后，再发不带该字段的事件**也清不掉它**（旧值被展开保留）。结果是「卡片看起来在等自动裁决、实际在等人」的静默错状态。

**必须逐处处理（共 5 处写入点）**：

| # | 位置 | 现状 | 需要 |
| --- | --- | --- | --- |
| 1 | `electron/toolChatLoop.ts`（`confirm-requested` 生产） | 仅 agent 路径带 `autoAnswerer: true` | 回退时发一条事件显式表示「不再是 agent 裁决」 |
| 2 | `src/shared/assistantFactAggregator.ts` | `...(event.autoAnswerer ? {...} : {})` | 改为显式赋值（可真可假） |
| 3 | `src/shared/turnDisplayProtocol.ts`（summary 构造） | 同上条件写法 | 同上 |
| 4 | `src/shared/turnDisplayProtocol.ts`（`turnDisplayToMessage`） | 同上条件写法 | 同上 |
| 5 | `src/renderer/components/Chat/ChatMessageList.tsx`（合并 live display） | 同上条件写法 | 同上 |

**类型层**：`ToolCallRecord['autoAnswerer']` 当前为 `?: true`，无法表达显式清除；需放宽为 `?: boolean`（或约定以 `undefined` 表示清除，并把上述 5 处改为「显式赋 `undefined`」而非「跳过字段」）。

**天然生效、无需改动的位置**（清除后即恢复人工语义）：

- `pendingConfirmStore.syncFromProjection` 的过滤 `!tool.autoAnswerer` —— 清除后该工具即进入 pending store；
- `resolveMessageToolsInteractive` 的三处过滤（`messageHasConfirmingTool` / `actionablePendingToolUseIds` / `resolveRequestIdForConfirmingMessage`）；
- 渲染分支 `ToolCallCard` 的 `record.autoAnswerer` 判定。

配套渲染单测：回退后卡片可交互（按钮存在）。

### 5.9 `approval-updated` 当前未接线（但回退分支必须在其之前）

本次验证确认：`approval-updated` 这个 fact 事件**目前在 `electron/` 下没有生产点**——只在 `packages/agent-core/src/history.ts` 的 `HistoryEvent.kind`（另一套语义）与 `assistantFactAggregator`（消费端）出现，属 SDK 迁移预留路径。

但消费端行为已经就位：`assistantFactAggregator` 收到该事件且 `status` 为 `denied` / `unavailable` / `timed-out` / `cancelled` 时，会把工具置为 `rejected` 终态。

> 描述收窄（评审非阻断 1）：原稿写「`terminalTool()` 会阻止后续事件再更新该工具」**表述过宽**。实际只有 `tool-progress` 分支的守卫检查终态，且**只挡 `completed` / `failed`，不挡 `rejected`**；`approval-updated` 分支自身也无终态守卫。这不影响下述结论（顺序依赖仍然成立），但迁移接线时不要据此误以为「置终态后一切后续事件都会被丢弃」。

**对本计划的约束**：一旦该事件在迁移中接线，**回退分支必须发生在其之前**——否则工具先变终态，卡片不再进入确认分支（`status !== 'confirming'`），回退失效，且与 §5.1 第 2 条前置动作冲突。这是本计划与 SDK 迁移之间的一条**顺序依赖**，需在迁移计划中记录。

---

## 6. 交付物

### 6.1 功能

1. 桌面 lane 的审批失败回退人工确认卡（按 §4 矩阵逐格生效）。
2. automation lane 不装配回退（其回答者恒为 `agent` 且无人可退）。
3. wechat / feishu 不装配回退（其失败去向由各自链路策略后续决定，本轮不动）。

### 6.2 可观测性（与功能同等重要）

1. **回退事件**：每次回退落一条审计，事件名 `confirm.answerer-fallback-to-user`（§8.3），携带原 `cause`（`unavailable` / `timeout`）、lane、工具名、requestId。
2. **回退率**：分子 = `confirm.answerer-fallback-to-user` 计数；**分母 = `confirm.request` 计数**——**不得用 `confirm.outcome` 计数作分母**，因为回退场景同一请求会落两条 `confirm.outcome`（§5.4），会把比率算低。实现路径是按事件类型分别取事件列表做**离线统计**；按 `cause` 分列的计数需离线处理（现有查询不含 `cause` 过滤维度，见 §8.4），`cause` 值本身可在事件对象中逐条读到。
3. **`unparsable` 率**：单独统计。它**不**产生回退，但它是「提示词输出合同与解析器是否需要修」的指标（见 §4.2）；缺失这项会让该缺陷长期不可见。
4. **统计口径引用**：任何聚合 `confirm.outcome` 的方（含本计划的回退率、以及既有的裁决率类指标）**必须遵守 §5.4 的口径**——按 `actor` 分列；`actor='agent'` 侧再按 `cause` 过滤出有效裁决（`agent-approved` / `agent-deny`），否则失败会被计入裁决。
5. **导出方式**：按事件类型过滤查询（`securityAuditReader` / 设置页第 5 区），再做离线统计；**按 `cause` 分列需离线处理**（查询维度不含 `cause`，见 §8.4）。**本轮不设阈值、不加告警**（§8.4）——回退率是「审批 Agent 是否健康」的直接指标，但阈值须待实测数据后确定。

> 可观测性的底线与本轮范围：**「能查到」是本计划的交付要求，「自动报警」不是**。代价是无人查看时退化不会被发现，运营前提见 §8.4。

### 6.3 测试

- 逐格单测：§4 矩阵每一行的 `cause` → 期望去向（转人工 / 仍 deny）；
- **审计单测（三条事件序列，评审 B1）**：回退时同一 `requestId` 依次落 ①`confirm.outcome`（`actor='agent'`、原 `cause`）②`confirm.answerer-fallback-to-user`（原 `cause`）③`confirm.outcome`（`actor='user'`）；断言三条的 `actor` / `cause` 组合正确（防止把 ① 漏掉或把 ①③ 写成同一条）；
- 审计单测：配置损坏路径仍落既有 `confirm.answerer-fallback` 且**不**落新事件；
- 审计单测：`effectiveTimeoutMs <= 0` 的提前返回路径补审计后，`confirm.request` 与 `confirm.outcome`（`cause='timeout'`）均存在（§5.4 附带缺口）；
- 负向单测：`agent-deny` 不触发回退；
- 端到端（mock provider）：desktop 审批不可用 / 超时 → 卡片出现 → 批准 / 拒绝双路径；
- 渲染单测：回退后卡片可交互（`autoAnswerer` 已清除、按钮存在；见 §5.8）；
- 渲染单测：banner 覆盖**多种工具类型**（文件类 / shell / MCP 各一），断言原因文案出现（见 §8.5）；
- **硬回归**：automation 全路径零变化；wechat / feishu 零变化；
- **硬回归（评审非阻断 4）**：**IM lane 即使构造出 agent 回答者也不装配回退**——当前 wechat/feishu 恒为 `user`，但引擎对任何 lane 的 `auto-evaluator` 命中都会落 `answerer='agent'`，隔离属「规则是数据」层面而非类型层面；加锚点用例防未来规则集变化；
- 取消链路：主通道被取消时回退通道不遗留活动 attempt；
- **缓存（评审 B2）**：回退后批准**可以**写缓存；由 agent 裁决批准**仍不可**写缓存（I3 锚点用例不回归）。缓存用例须**同时断言**「审计 outcome 的 `actor='user'`」与「实际写入资格的来源为 `'user'`」一致，防止 §5.1 第 3 条的派生修正与审计口径两处再次分叉。

---

## 7. 与其他不变量 / 既有计划的关系

| 项 | 关系 |
| --- | --- |
| I1（回答者与 lane 正交） | 不改变 lane 语义；回退是**同一 lane 内的传输通道回退**，不跨 lane |
| I2（标准唯一） | **不触碰** Skill 与裁决标准 |
| I3（记忆只源于人类） | 回退后由人确认 → 可写缓存，I3 仍成立（见 §5.5） |
| I4（未命中即 fail-closed） | **前置修订已完成**：限定为「无人值守上下文不得回退为 user」，有人值守链路的失败去向明确不在其约束内 |
| I5（递归终止） | 不受影响 |
| `desktop-auto-approval-plan.md` | 其决策 6「本轮不做」已更新为「已单独立项」（指向本文） |
| `security-approval-experience-improvement-plan.md` | 口径关系见 §8-1 |

---

## 8. 待决问题

（§8.1–§8.5 均已落定，无遗留待决项。）

### 8.1 与体验改进计划 §1 的口径措辞冲突（**已落定**）

`security-approval-experience-improvement-plan.md` §1 原文为：「服务故障不自动转人工，不增加审批 Agent 的第三种裁决。」

**处置（已完成）**：该句已限定为「**无人值守（automation）链路**的服务故障不自动转人工」，并明确有人值守链路（桌面 / IM）的失败去向按各自链路策略决定、指向本计划（该文档 §1 与头部关联设计均已更新）。限定的理由：该句的论证前提与 I4 原表述相同——无人场景下转人工等于挂死；限定后与 I4 的场景限定口径一致，且不推翻该计划的其他内容。

其中「**不增加审批 Agent 的第三种裁决**」与本计划完全一致（回退后仍是两态人工确认卡），保留不变。

### 8.2 §4 矩阵的 `timeout` / `unparsable` 两格（**已定稿**）

- `timeout` → **转人工**（理由见 §4.1）；
- `unparsable` → **保持 deny**（理由见 §4.2）。

回退范围因此为 `unavailable` + `timeout` 两格。判定时提炼的归类判据已写入 §4 开头，后续新增 `cause` 按同一判据归类。

### 8.3 回退事件的承载方式（**已定稿：新增事件名 `confirm.answerer-fallback-to-user`**）

**决定**：**不复用** `confirm.answerer-fallback`，新增 `confirm.answerer-fallback-to-user`。

#### 既有事件到底是什么

`confirm.answerer-fallback` 的语义比名字窄得多：它**专指回答者解析阶段的兜底告警**，与运行期无关。

| 项 | 内容 |
| --- | --- |
| 定义 | `src/shared/confirmation/types.ts`（`SecurityAuditEventKind`） |
| 唯一生产点 | `electron/confirmation/channels.ts` 的 `denyFallback()` |
| 触发条件 | 仅两条，且都在**配置异常**路径：① `answerer.kind` 非法；② `kind='agent'` 但 `agentChannelFactory` 未接线。两者都落 `cause='config-error'` |
| 触发时点 | **解析期**（构造通道对象时），请求尚未发出 |
| `actor` | `'system'` |
| 配套动作 | 落事件后返回 `DenyChannel`，由它在 `request()` 时才落 `confirm.outcome(cause='config-error')` |

> `DenyChannel` 有三条构造路径，**只有** `denyFallback()` 这条落该告警事件：显式 `kind='deny'`（`cause='no-answerer'`）与 IM 缺通道实例（同）这两条只落 `confirm.outcome`。因此该事件是**配置健康度信号**，不是「用户被拒」的记录。

#### 四维对照

| 维度 | `confirm.answerer-fallback`（既有） | `confirm.answerer-fallback-to-user`（新增） |
| --- | --- | --- |
| 触发时点 | 解析期（构造通道时） | 运行期（`request()` 返回后） |
| 触发原因 | `config-error`（配置损坏 / 未接线） | `unavailable` / `timeout`（环境失败） |
| 降级目标 | **拒绝** | **人工** |
| 方向 | fail-closed | fail-open-to-user |
| 处置动作 | 去修配置 | 观测健康度 / 等用户点卡片 |

**不复用的核心理由是指标口径隔离**——不只是"避免混淆"：这两类事件的**正确处置动作相反**（前者修 bug，后者可能只是正常波动）。若复用同一事件名，§6.2 的「回退率」会把配置损坏与环境抖动混算：配置一直坏导致的 100% 回退、与偶发超时导致的 5% 回退，会统计成同一个数，指标失去意义。此外 `actor` 与语义方向也对不上——两个 "fallback" 实际指向**相反方向**。

#### 事件形态

| 字段 | 取值 |
| --- | --- |
| `event` | `confirm.answerer-fallback-to-user` |
| `cause` | 原 `cause`（`unavailable` / `timeout`） |
| `actor` | `'system'`（host 因运行期失败改变去向，非回答者动作） |
| 其余 | `ts` / `lane` / `sessionId` / `requestId` / `toolName` |

与实到 outcome 的关系（§5.4）：回退场景同一 `requestId` 会出现**三条**事件——① `confirm.outcome`（agent 失败，`actor='agent'`，既有）、②本事件（`actor='system'`）、③ `confirm.outcome`（`DesktopChannel` 落，`actor='user'`、`cause='user-approved' | 'user-denied'`）。三条以同一 `requestId` 关联；**双 outcome 属有意保留**，下游聚合口径见 §5.4。

#### 实现侧待办

1. `SecurityAuditEventKind` 新增该枚举值（`src/shared/confirmation/types.ts`）；
2. 既有 `confirm.answerer-fallback` 的生产点与语义**保持不变**（§8.4 的边界澄清同理）。

### 8.4 回退率阈值与告警形式（**已定稿：只做审计可查**）

**本轮范围**：回退事件落审计，**可按事件类型 `event` 过滤**查询（新事件名 `confirm.answerer-fallback-to-user`），事件对象内含 `cause` 字段；**不设阈值、不加告警、不做 UI 展示**。

> 能力现状（本次核实）：审计已有只读查询 `electron/confirmation/securityAuditReader.ts`（设置页第 5 区，经 `security:query-audit` 暴露），过滤维度为**时间 / lane / 事件类型 / toolName**，**不含 `cause`**，返回**事件列表**（倒序 + limit）而非聚合。因此「回退率与 `unparsable` 率可导出」的准确含义是：**可按事件类型取到全部相关事件、逐条读 `cause`**；**按 `cause` 的计数与比率需离线分析或另行扩展查询维度**（后者属独立小改动，本计划不做）。

> 边界澄清：本节所指「告警」为**新增的回退率告警**。既有的 `confirm.answerer-fallback` 事件（配置损坏 / 通道未接线时落的配置健康度告警，`cause='config-error'`，`actor='system'`；来历见 §8.3）**保持保留不变**——与 §5.2「配置损坏仍 deny 且保持告警」是同一件事，不受本节约束。

不做阈值与告警的理由：

1. **当前缺基线数据**。没有实测回退率作参照，任何阈值都是拍的；先采集、再定值。
2. **避免过早引入误报通道**。告警一旦存在就需要有人处理，否则会变成被忽略的噪音；而本计划的首要任务是先把回退路径本身做对。
3. **审计可查已能回答关键问题**：「最近是否在批量回退」「回退集中在哪个 `cause`」都可由审计导出回答，足够支撑后续决策。

**代价（须记录，属有意接受的范围裁剪）**：**无人主动查看时，退化不会被发现**——`timeout` 频繁或模型输出格式漂移，都不会自动冒出来。因此本决策隐含一个运营前提：**桌面回退上线后，需要有人按周期查阅审计的回退率与 `unparsable` 率**（频次与责任方由运营侧定，不在本计划范围）。

**后续升级路径**：待积累一段实测回退率后，再按数据定阈值与投放位置（日志告警 / 审计页 / 设置页提示）；届时本文档相应更新。本决策不阻塞实现——落审计是前置动作，阈值可后补。

### 8.5 是否给用户可见的「本次由自动转为人工」提示（**已定稿：复用 `autoApproveFallback`**）

**决定**：**复用既有的 `autoApproveFallback` 字段**承载原因提示——不新增 UI 字段、不改 `facts.summary`。

#### 为什么这是耦合最少的选择

`AutoApproveFallback` 已经在做形状相同的事——「自动路径没走成、回落人工确认，原因是什么」：

| 环节 | 位置 |
| --- | --- |
| 定义 `{ reason: string; reasonCode: string }` | `src/shared/domainTypes.ts` |
| 生产（当前唯一） | `electron/confirmation/toolCallGate.ts`（文件 auto 模式回落） |
| 透传（链路已通） | `assistantFactAggregator`、`pendingConfirmStore`、`turnDisplayProtocol` |
| 消费（渲染 banner） | `src/renderer/components/Chat/WriteConfirmCard.tsx` |
| i18n | `fileAutoApprove.fallbackBanner` |

三个直接好处：

1. **`reasonCode` + `reason` 的双字段设计，正好对应「机器可读 cause + 人可读文案」**——这个分层已经解决，无需重新设计；
2. **透传链已通**，生产端填值即可到卡片；
3. **前端 banner 只消费 `reason`，不消费 `reasonCode`**，因此新增两个 `reasonCode` 不需要动前端映射表。

**为什么不改 `facts.summary.text`**：`ConfirmSummary` 明确定义为「确认界面 / IM 文本共用同一份内容摘要」，改它会连带影响 IM 渠道与审计的 `factsSummary`；且语义上 summary 描述的是「要执行什么」，塞入「超时」会变成「写入 xxx（自动审批超时）」，两件事被压进一个字段。它也不能解决卡片能否交互的问题（见 §5.8）。

#### 措辞已改为通用表述（本轮已完成）

原文案只贴合「文件自动放行」，与回退场景（原因多为「超时」「服务不可用」）不匹配。已改为通用于两类来源的表述：

| 语言包 | 改动后 |
| --- | --- |
| zh-CN | 「自动处理未完成：{{reason}}。本次操作需要您手动确认。」 |
| en-US | 「Automatic handling did not complete: {{reason}}. Please confirm this action manually.」 |

> i18n key `fileAutoApprove.fallbackBanner` **未重命名**（避免改动 i18n 类型映射）；该 key 名此后带 file 作用域色彩，属可接受的遗留。同时更新了 `WriteConfirmCard.test.tsx` 中匹配该文案的断言。
>
> **提交切分（评审非阻断 2）**：这笔措辞改动（`zh-CN/chat.json`、`en-US/chat.json`、`WriteConfirmCard.test.tsx`）属「口径先行」，**目前仍在工作区未提交**，与本计划文档混在一起。建议**先单独提交这笔改动**，避免与后续回退实现混在同一变更里难以回退。
>
> **本项范围限定**：此处完成的只是 banner **模板句**的通用化；`{{reason}}` 插值本身的来源（需新增 i18n 原因文案）**尚未就绪**，见 §5.3。两者不是一回事。

#### 回退侧需要填的值

| 字段 | 取值 |
| --- | --- |
| `reasonCode` | `unavailable` / `timeout`（与 §8.3 事件的 `cause` 同源；命名可加域前缀，见 §5.3 待定小项） |
| `reason` | **新增的短原因短语**（i18n key，zh-CN / en-US 双份，形如「服务暂不可用」/「等待超时」——**不带**模板已承载的「未完成 / 需手动确认」语义）。**不能**复用 `AgentChannel.summaryFor`（该函数未导出，且其文案带「已按拒绝处理」，放进等待确认的卡片语义自相矛盾）。详见 §5.3「原因文案的来源」 |

#### 联动要求

复用本字段的同时，**必须显式清除 `autoAnswerer`**，否则卡片仍是只读态、用户无按钮可点（陷阱与要求见 §5.8）。

#### banner 覆盖面（**本轮一并解决：提升到确认态统一层级**）

**问题**：banner 当前写死在 `WriteConfirmCard` 内部，只有文件类卡片显示；而回退对**七类工具都会发生**（`write_file` / `edit_file` / `run_shell` / 脚本 / `browser` / MCP / `toolkit` / lark-cli）。只修文件类会造成同一行为在不同工具下**体验不一致**（用户会当成缺陷），且 §5.3「卡片必须携带原因」无法达成——回退场景下用户看到的正是「卡片突然出现」，提示条是回答「为什么」的唯一手段。

**这不是「要不要做」的选择题**：`autoApproveFallback` 本身是 `ToolCallRecord` 上的**通用字段**，`assistantFactAggregator` → `pendingConfirmStore` → `turnDisplayProtocol` 全链路都在透传它，`resolveMessageToolsInteractive` 也在读它——**只有最后一跳（渲染）是局部的**。把展示提升到确认态统一层级，同时修掉了这个既存的不一致（将来其他工具引入自动路径时不会再遇到同一问题）。

**实现方案**（改动集中在 `ToolCallCard` 一个文件）：

七个确认分支的结构完全一致：

```
if (xxxConfirming && onConfirm && confirmationReady !== false) {
  return (
    <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
      <XxxConfirmCard ... />
      {earlySearchText ? <pre ... /> : null}
    </div>
  )
}
```

因此只需：在组件内构造一个共享的 banner 节点（读 `record.autoApproveFallback`，复用既有 i18n key 与样式类），在七个分支的 `<XxxConfirmCard>` **之前各插入一行**；并从 `WriteConfirmCard` 内部移除其局部 banner 渲染。

**成本**：单文件约 7 处一行插入 + 1 个共享节点；从 `WriteConfirmCard` 删除局部渲染（约 5 行）；测试把 `WriteConfirmCard.test.tsx` 的 banner 用例上移到 `ToolCallCard.test.tsx`。**不涉及那七个卡片组件本身**。

---

## 9. 风险与回退

| 风险 | 评估 | 缓解 / 回退 |
| --- | --- | --- |
| 回退率过高使「自动」档形同虚设 | **中高**（这是本计划最主要的现实风险；`timeout` 纳入回退范围后覆盖面大于仅 `unavailable`） | §6.2 审计可查先行；**本轮无自动告警，依赖运营侧定期查阅**（§8.4）；实测偏高时收窄 `auto` 的变换范围（规则是数据） |
| 无告警导致退化被长期忽略 | 中（§8.4 决策的固有代价） | 明确记录运营前提：上线后需按周期查阅回退率与 `unparsable` 率；有实测数据后即补阈值（§8.4 升级路径） |
| `timeout` 频繁导致批量转人工，叠加用户等待成本 | 中（已定转人工，该风险被主动接受） | §4.1 三项必须同时满足（原因可见、上界不放宽、观测交付）；实测偏高时重评该格 |
| 配置类失败被静默回退，掩盖产品缺陷 | 中 | §5.2 明确分道：配置损坏仍 deny 且保持告警 |
| `unparsable` 表现为拒绝，被误判为回归 | 低（已明确为预期行为） | §4.2 记录处置路径：按产品缺陷修，不改为转人工；纳入观测 |
| 「被拒就再问人」形成绕过 | 低（§4.3 已禁 `agent-deny` 回退） | 负向单测锚定；评审时重点确认 |
| 卡片原因文案泄露内部状态 | 低 | §5.3 脱敏要求；新增 i18n 原因文案须按该要求编写（不得含准入队列状态、模型名、配额余量） |
| 回退引入双份通道状态 | 中（组合器的 `cancel` 易漏） | §5.1 要求 `cancel` 同时转发；配取消链路测试 |
| 回退路径意外影响 automation | 低（按 lane 装配） | automation 零变化列为硬回归 |
| 卡片残留只读态导致回退不可用 | 中（条件写入不清除旧值，易漏） | §5.8 四项要求 + 渲染单测（按钮存在） |
| banner 提升层级时遗漏某个确认分支 | 中（七个分支平级，新增分支易漏） | §8.5 实现方案逐分支列出；测试覆盖多种工具类型的回退展示 |
| 回退场景的双 `confirm.outcome` 被下游误聚合 | 中（评审 B1；现有聚合若只看 `outcome` 会双重归因） | §5.4 已写死统计口径（按 `actor` 分开、回退率分母用 `confirm.request`）；§6.3 三条事件序列断言锚定 |
| `confirmAnswererKind` 派生未修正，导致回退后缓存写入被跳过/抛错 | 中（评审 B2；已识别且有明确修法，非未知风险） | §5.1 第 3 条列为必做联动点；§6.3 缓存用例加一致性断言 |
| 回退原因文案形态不对（与模板语义重复）或缺失 | 中（评审 B3 及其跟进；复用 `summaryFor` 会得到「已按拒绝处理，请确认」的矛盾文案；写成完整句则会与模板重复） | §5.3 明确：新增**短原因短语**、对齐既有 `writeFileAutoApproval` 的 `reason` 形态、撤销「同源」表述 |
| `effectiveTimeoutMs <= 0` 路径漏计 | 低（评审 B1 附带；仅影响该类超时的比率精度） | §5.4 定为补审计；若实现评估不宜调整顺序，须在 §6.2 显式记录缺口 |

---

## 10. 建议的实施顺序

0. **先提交工作区中已完成的「口径先行」改动**（`zh-CN/chat.json`、`en-US/chat.json`、`WriteConfirmCard.test.tsx`；评审非阻断 2）——与本文档混在同一工作区，单独提交后再开始实现。
1. ~~先落 §8.1 的文档口径~~（**已完成**：体验改进计划 §1 与 I4 表述均已限定）。
2. ~~定稿 §4 矩阵、§8.3 事件承载方式、§8.4 观测范围、§8.5 提示承载与措辞~~（**均已完成**）；~~吸收评审 v1 的 B1–B3~~（**已完成**，见头部修订行）。
3. **实现通道组合层与联动动作**（§5.1：插入点 + ①补登记 waiter + ②保持 `confirming` + ③**回传实际回答者**）+ §5.2 分道，可先只接 `unavailable` 一格跑通端到端。
4. **接入 `timeout` 格** + 审计（三条事件序列 + `effectiveTimeoutMs <= 0` 补审计）与回退率导出（§5.4 / §6.2；不设阈值与告警，§8.4）。
5. **新增回退原因 i18n 文案**（§5.3：zh-CN / en-US 双份，`unavailable` / `timeout` 两条）+ **卡片原因展示 + 覆盖全部确认卡片**（§8.5）+ **逐处清除 `autoAnswerer` 使其可交互**（§5.8 五处写入点 + 类型放宽）+ 投影层核对。
6. **测试与硬回归**（§6.3，含 IM lane 锚点用例与缓存一致性断言）。

第 3 步可独立交付（`unavailable` 一格即已修掉最主要的缺口），后续步骤增量叠加。第 3 步中的 ③ 必须与组合层同批完成——否则回退本身可用但 `decision_cache` 写入不成立（§5.5 前置条件）。

---

## 11. 交付判据

1. desktop lane 的审批失败按 §4 矩阵逐格生效：`unavailable` / `timeout` 转人工，`unparsable` / `config-error` / `recursion-blocked` 仍 deny，`agent-deny` 永不回退；
2. automation / wechat / feishu **零行为变化**（硬回归全绿；含 IM lane 不装配回退的锚点用例）；
3. 回退产生的人工确认与普通 `ask` 在用户可见形态上一致，**且可写 `decision_cache`**——后者以 §5.1 第 3 条（回传实际回答者）已完成为前提（§5.5）；
4. 回退后卡片**可交互**（`autoAnswerer` 已清除，按钮存在；§5.8）；
5. 回退后**全部七类确认卡片**均显示原因说明，且原因文案为**新增短原因短语**（zh-CN / en-US 双份，形态对齐既有 `reason`、不带模板已承载语义），不复用 `summaryFor`（§5.3 / §8.5）；
6. 审计可区分「agent 裁决」与「agent 失败后转人工」：回退场景下三条事件（双 outcome + fallback 事件）的 `actor` / `cause` 组合正确，原 `cause` 可查；下游统计口径按 §5.4 定义——**agent 裁决率须按 `cause` 过滤有效裁决**（`agent-approved` / `agent-deny`），回退率分母用 `confirm.request`；
7. 回退率与 `unparsable` 率**可从审计导出**（按事件类型取列表 + 离线统计）；本轮不要求自动告警（§8.4）；
8. I3 锚点用例不回归（agent 裁决仍不写缓存）；
9. 文档口径已落定：§8.1–§8.5 与评审 v1 的 B1–B3（**均已完成**）。
