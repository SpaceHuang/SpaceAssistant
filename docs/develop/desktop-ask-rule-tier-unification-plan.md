# 桌面链路 ask 规则档位统一方案（按 ruleId 档位覆盖）

> 状态：**已实施并闭环**（v17：实施分支已合入 main（`c96acc2e`）并通过评审；Q1–Q11 全部关闭——Q11 经事实核补后按路径 (a) 完成需求文档 v2.4 同步，残余仅一项 UX 观察留档）
> 关联：`docs/develop/script-path-extraction-false-positive-diagnosis-and-improvement-plan.md`（档位耦合缺陷的发现来源）；`docs/review/desktop-ask-rule-tier-unification-plan-review.md`（v10 评审）
> 决策输入（用户拍板）—— 段5 与段7 的规则：`browser-act-ask-desktop` 改为 `allow`；`default-write-execute-ask` 在**宽松档**改为 `allow`；其余改为 `auto-evaluator`。
> **注**：所谓"快通道 + 机审"对 browser/script/lark 三条**实际只有机审**——本期不为它们另立快通道（见 §4.3、§10 Q2）。
> **范围约束（用户澄清）**—— ① **仅 desktop lane**（wechat / feishu / automation 零变化）；② **严格档不动**（保持「尽量多问人」）；③ **custom 档不动**（用户显式覆盖语义，见 §4.6）。
> 本文只给方案，**不含任何代码改动**。

---

## §0 一句话结论

用户决策的**方向正确**，但要**修正一处我曾过度推广的地方**：严格档的「尽量多问人」是**有意设计**，不是缺陷。真正反常的是**宽松档比标准档还严**——那才是要修的缺陷（见 §1、§3）。

**v11 的关键变更（采纳评审）**：落点由「改基线动作 + 改档位表」**统一收敛为「按 ruleId 的档位覆盖」**（§5）。理由是前者有两个阻断缺陷：

- **B1**：改基线动作是**跨档位共享**的，会**静默波及 custom 档**（§4.6）；
- **B2**：给 `transforms` 加 `loose: { ask: 'auto-evaluator' }` 属 S1（偏差 15）**明令移除的整体宽严变换**（§4.5）。

收敛后：**基线动作零改动、`transforms` / `scopePackages` 零改动、`defaultRules.ts` 零改动**，custom / 严格档天然不受影响，并顺带消除评审 N1。

---

## §1 背景：为什么会有这个问题

桌面链路的「自动」（`auto-evaluator` = 快通道 + 机审）目前**只挂在 `standard` 键上**：

```ts
// src/shared/policy/policyPackages.ts
const DESKTOP_TRANSFORMS: LaneProfile['transforms'] = {
  standard: { ask: 'auto-evaluator' }
}
```

`effectiveActionFor` 在规则产出时按档位查映射（`policyPackages.ts` · `effectiveActionFor`，约 :204-219）：

```ts
if (isTransformExempt(rule)) return rule.action        // locked / deny / confirm-every-time 豁免
if (pkg === 'custom') return rule.action               // custom 恒等
const mapping = LANE_PROFILES[lane].transforms[pkg]
return mapping?.[rule.action] ?? rule.action           // 无映射 → 恒等
```

于是 `loose` / `strict` / `custom` 三条档位**没有 `ask→auto-evaluator` 映射**，所有非 locked 的 `ask` 在这些档位下恒等保留，落 `requireConfirm` → 默认回答者 `user` → **真人卡**。

**结论：对 `loose`（宽松档）而言，这构成缺陷**——它的档位语义是「比标准档更松」，却因缺映射反而更严；本方案修的就是它。**`strict` 落「真人」是有意设计**（严格档就要「尽量多问人」），**`custom` 是用户显式覆盖**——两者都不属缺陷，本次均不动（见 §3、§4.5、§4.6）。

---

## §2 决策范围内的规则（精确清单）

### 段5 —— 数组内非 locked 的 `ask` 规则（4 条）

| 规则 id | 现状 match | 现状动作 / denyClass |
|---|---|---|
| `script-network-ask-desktop` | `lane:['desktop']`, `toolName:'run_script'`, `signals:['script-network']` | `ask` / `insufficient-info` |
| `browser-act-danger-ask` | **无 lane 限定**, `toolName:'browser'`, `signals:['browser-act-dangerous']` | `ask` / `insufficient-info` |
| `browser-act-ask-desktop` | `lane:['desktop']`, `toolName:'browser'`, `signals:['browser-act']` | `ask` / `insufficient-info` |
| `lark-write-ask` | `lane:['desktop','feishu']`, `toolName:'run_lark_cli'`, `signals:['lark-write']`，带 `askUnless` | `ask` / `insufficient-info` |

### 段7 —— 引擎合成兜底（不是数组规则）

`default-write-execute-ask` 由 `policyEngine.applyDefault()`（`policyEngine.ts`）第 ③ 分支产出，覆盖 `write` / `execute` 类未命中专门规则的调用（`write_file` / `edit_file` 是主要消费者）。

### 目标动作

| 规则 | 目标动作 |
|---|---|
| `browser-act-ask-desktop` | **`allow`** |
| `script-network-ask-desktop` | **`auto-evaluator`** |
| `browser-act-danger-ask` | **`auto-evaluator`** |
| `lark-write-ask` | **`auto-evaluator`** |
| `default-write-execute-ask`（合成兜底） | **`allow`**（宽松档放行） |

> **上述目标仅适用于「标准档」与「宽松档」**；**严格档保持现状（`ask` → 真人确认）不动**（见 §3）。
> **本方案不修改任何规则的基线 `action`**——目标动作全部通过 §5 的「按 ruleId 档位覆盖」表达。因此 `defaultRules.ts` 的 `denyClass`、lint 校验、规则排序**均不受影响**（对照 §4.1、§4.2）。
>
> ⚠️ `default-write-execute-ask` 的目标是 **`allow`**（放行），与其余段的 `auto-evaluator`（机审）不同——它**不走 `file-fast-track`**，属实质安全边界变化，见 §4.3.1、§10 Q8。

---

## §3 目标语义矩阵（四档）

> 本矩阵**仅适用于 desktop lane**；wechat / feishu / automation 不在改动范围内。

「自动」= `auto-evaluator`；「真人」= `require-confirm` 且 `answerer=user`；「放行」= `auto-allow`。

| 规则 | 严格 | 标准 | 宽松 | custom | 备注 |
|---|---|---|---|---|---|
| `script-network-ask-desktop` | 真人（不变） | 自动（不变） | **自动**（修正：原真人） | 真人（不变） | 桌面含网络脚本 |
| `browser-act-danger-ask` | 真人（不变） | 自动（不变） | **自动**（修正：原真人） | 真人（不变） | 浏览器高危 act |
| `browser-act-ask-desktop` | 真人（不变） | **放行**（修正：原自动） | **放行**（修正：原真人） | 真人（不变） | 一般浏览器 act（⚠️ 覆盖 allow 会架空 `actRequiresConfirm` 总开关，见 §10 Q11） |
| `lark-write-ask` | 真人（不变） | 自动（不变） | **自动**（修正：原真人） | 真人（不变） | lark-cli 写类 |
| `default-write-execute-ask` | 真人（不变） | 自动（不变） | **放行**（修正：原真人） | 真人（不变） | 写/执行兜底 |

**读法（关键）**：

- **严格列全部「真人（不变）」**——严格档的档位语义就是「尽量多问人」，**有意设计**，本次零改动。
- **custom 列全部「真人（不变）」**——custom 档在 `effectiveActionFor` 中提前 `return rule.action`（:216），**不消费本方案的覆盖**；§5 的机制天然不触及 custom。这修复了评审 B1。
- **标准列本就正确**——标准档已有 `ask→auto-evaluator`；除 `browser-act-ask-desktop` 外无需改动。
- **宽松列才是缺陷所在**——本次修复 = 让宽松档**对齐标准档**（+ `browser-act-ask-desktop` 在标准/宽松放行）。

---

## §4 关键约束（读源码得出，决定落法）

### 4.1 约束一：`defaultRules.lint.test.ts` 三道硬校验（**本方案据此规避**）

`src/shared/policy/defaultRules.lint.test.ts` 对 `DEFAULT_POLICY_RULES` 做静态断言，**只要改基线动作就会触发三处失败**：

| # | 校验 | 若改基线动作会违规的规则 |
|---|---|---|
| L1 | `action ∈ {allow, auto-evaluator}` 必须显式限定 `match.lane` | `browser-act-danger-ask`（当前无 lane） |
| L2 | `action === 'auto-evaluator'` 的 `match.lane` 必须**恰为 `['desktop']`** | `lark-write-ask`（含 `feishu`）、`browser-act-danger-ask`（无 lane） |
| L3 | `action ∈ {allow, auto-evaluator}` 的规则**不得带 `denyClass`** | 段5 全部 4 条（均标 `insufficient-info`） |

**本方案不改基线动作 → L1/L2/L3 均不触发**，`defaultRules.ts` 零改动。这是选择 §5 落点的直接理由之一。

> 代价需如实记录：覆盖层在**运行时**把某条 `ask` 变 `allow`/`auto-evaluator`，而 lint 只校验声明动作——即该保护的**覆盖面**不含覆盖层。本方案中受影响的 `browser-act-ask-desktop` 已带 `lane:['desktop']`，且保留 `denyClass:'insufficient-info'`（基线仍为 `ask`、语义仍正确），故无实际风险；但若**未来**用覆盖层给"无 lane 限定"的规则改动作，会绕过 L1，需评审留意。

### 4.2 约束二：引擎第 4 步按**基线** `action` 过滤（**本方案据此规避**）

`policyEngine.decide()` 第 4 步（`policyEngine.ts:422`）按**规则原始 `action`** 过滤 `auto-evaluator` 条目，且位于默认表（第 6 步）之前。

- 基线 `ask` → 进第 6 步，动作经 `deps.transform()=effectiveActionFor` **产出时**变换（不改规则顺序）；
- 基线 `auto-evaluator` → 进第 4 步，**提前于默认表**，且不经 transform。

**本方案不改基线动作 → 无规则跃迁、规则顺序语义不变**（对照 v10 评审 N2 中该项）。这也是落点选择的第二理由。

### 4.3 约束三：评估器路由里，只有 `write_file`/`edit_file`/`run_shell` 有真快通道

`electron/confirmation/toolCallGate.ts:713-751` 构造 `autoEvaluatorRoutes` 并实现 `autoEvaluator` 端口：

- 内建注册：desktop 下 `write_file`/`edit_file` → `'file-fast-track'`；
- 规则驱动注册：任何 `action:'auto-evaluator'` 且带 `toolName` 的规则，会 `set(toolName, rule.id)`；
- 端口实现只识别 `'shell-precheck-auto-allow'` 与 `'file-fast-track'`，**其余一律返回 `{approve:false, reason:'无评估器'}`**。

因此：

| 目标规则 | toolName | 生效后的真实路径 |
|---|---|---|
| `default-write-execute-ask` | `write_file`/`edit_file`（及所有未命中专门规则的 write/execute） | 标准档：**有快通道** `file-fast-track`；**宽松档改为 `allow` 后不走评估器** |
| `script-network-ask-desktop` | `run_script` | **无快通道** → 端口返回"无评估器" → **直接机审** |
| `browser-act-danger-ask` | `browser` | **无快通道** → **直接机审** |
| `lark-write-ask` | `run_lark_cli` | **无快通道** → **直接机审** |

**必须如实告知**：用户表述的"快通道 + 机审"，对 browser/script/lark 这三条**只实现机审，尚无快通道**。若确需快通道，应另立评估器（见 §10 Q2）。

#### 4.3.1 ⚠️ `default-write-execute-ask` 改 `allow` 的边界含义

`allow` 与 `auto-evaluator` 的差别**不只是"卡不卡"，而是放行门槛**：

| 档位 | 兜底结果 | 放行是否经过边界判定 |
|---|---|---|
| 标准（不变） | `auto-evaluator` | **是**：`file-fast-track`（`evaluateFileToolAutoApproval`）检查 zone / targetKind / 敏感路径 / 越界 / 体量（`> autoApproveMaxBytes`=256KB、`editCharSpan > autoApproveMaxEditChars`=64K 不予自动放行，落机审） |
| 宽松（本次改） | `allow` | **否**：决策阶段直接 `auto-allow`，上述判定**不再影响放行与否** |

**须精确表述（评审 N3 修正）**：宽松档下 gate 层**仍会执行**路径探测与 `evaluateFileToolAutoApproval` 计算，并写入 `file.auto-approve` 审计（`toolCallGate.ts:771-796` 对 desktop write/edit **无条件执行**）；变化的是**这些检查结果不再决定是否放行**。因此会出现如下审计组合：

```
file.auto-approve: autoApproveOutcome='fallback', autoApproveReasonCode='outside_workdir'
policy.decision:   decision='auto-allow', ruleId='default-write-execute-ask'
```

——即"判出越界，但仍放行"。**这是 Q8 决策 A 的预期结果，不是审计异常**；G9 的"可解释"应据此解读（见 §8）。

据此，宽松档下这些调用：

- ✅ 正常文档写入：无卡放行（预期）；
- ⚠️ **写到工作目录外 / 敏感路径 / 超大写入**：**一并放行**（原本会被 `file-fast-track` 拦下）。

规则表里仅剩两条窄 `deny` 仍会拦：`wiki-raw-write-deny`（raw/ 只读源）、`write-target-unsupported-deny`（目标不是普通文件/新文件）。

**这是一处实质安全边界扩张，已由产品确认接受（§10 Q8 = A）**。

### 4.4 约束四：只改桌面——远程 lane 必须零变化

用户约束：改动**仅针对 desktop lane**。本方案的落点（§5 的按 ruleId 覆盖）挂在 `LANE_PROFILES.desktop` 上，且 `effectiveActionFor` 内含 `lane === 'desktop'` 硬编码白名单（§5.1）——**两层保证远程零影响**（见 §5.1「只改桌面的双保险」）。故本方案对远程的外溢风险为**零**，无需像「改基线动作」那样处理 `browser-act-danger-ask` 无 lane / `lark-write-ask` 含 feishu 的问题。

### 4.5 约束五：S1（偏差 15）范围档收口——**本方案不触碰该边界**（评审 B2 应答）

**设计历史（须留痕）**：strict / loose 的**按档位整体宽严变换**（即 `transforms` 里的映射）**曾被有意移除**，改为范围档（`scopePackages`）。原文三处注释：

- `policyPackages.ts:68-74`（`transforms` 字段注释）：「S1（偏差 15）：仅保留 standard 的 desktop『自动』映射（路径选择，非宽严）；**strict / loose 已范围化（scopePackages），不再做宽严变换**」；
- `policyPackages.ts:84-86`（`DESKTOP_TRANSFORMS` 注释）：「S1：strict / loose 宽严映射移除（范围化，见 DESKTOP_SCOPE_PACKAGES）」；
- `effectiveActionFor` 注释（:204-208）：「strict / loose 恒等」。

**v10 方案为何撞上它**：v10 在 `DESKTOP_TRANSFORMS` 新增 `loose: { ask: 'auto-evaluator' }`——这正是 S1 移除的**「按动作类别的整体宽严变换」**，构成对 S1 决策的反向修改。

**v11 为何不撞**：本方案**不修改 `transforms`、不修改 `scopePackages`**，而是新增**第三层「按 ruleId 的档位覆盖」**（`ruleActionOverrides`，§5.1）。其形态与 S1 明确保留的 `scopePackages` 同为**显式清单（enumerate 具体规则 id）**，而非"按动作类别整体变换"——因此**不构成 S1 所禁止的整体宽严变换**，属对该框架的**同构扩展**而非回滚。

**须同步更新的注释（对应 §7 第 4 步）**：

| 位置 | 现状措辞 | 需补 |
|---|---|---|
| `effectiveActionFor` 注释（:204-208） | 「strict / loose 恒等」 | 补一行：`desktop` 另有 `ruleActionOverrides`（按 ruleId）优先于 `transforms`，见 §5.1 |
| `LaneProfile.transforms` 注释（:68-74） | S1 收口描述 | 无需改（`transforms` 未变）；可在 `scopePackages` 旁补注释指向新字段 |

**S1 的实质精神未被破坏**：S1 的目的（见 `DESKTOP_SCOPE_PACKAGES` 注释"较原全域 ask→allow 收窄"）是**防止档位把大片域整体放宽**。本方案对 `loose` 只做 **5 条显式登记**（`DESKTOP_RULE_OVERRIDES.loose`：段5 三条 + `browser-act-ask-desktop` + 合成兜底），未放宽任何未列出的域——**符合 S1 精神**。另有 `browser-navigate-ask-desktop` / `mcp-tool-ask` 两条，**沿用既有 `DESKTOP_SCOPE_PACKAGES.loose` 的 `scope-loose-*` 条目**接管（现状已存在，本方案不改）。

**维护成本与守卫（Q9 = 选法 A，已定）**：覆盖层是**逐条登记**——未来"新增桌面 `ask` 规则"不会自动获得 `auto-evaluator`，会掉回「真人」。这与 `transforms.loose` 的"整体对齐"不同（后者治本，但构成对 S1 的反向修改）。

本方案**选择尊重 S1 的「显式清单」形态（选法 A）**，并以**守卫断言**消除"会漏登记"的隐患：

> **守卫断言（新增，见 §8 G12）**——**定义域与输入以「解析后的规则集」为准**（v13 评审 D1 修正，不可直接对基线集合跑 `effectiveActionFor`）：
>
> - **输入**：`resolvePolicyRules({ lane:'desktop', packages:{ desktop: 'standard' } })` 与 `… { desktop: 'loose' }` **解析后的规则集**（含 `scopePackages` 取代）；
> - **定义域**：桌面可命中的非 locked `ask` 规则，**共 7 条**——数组内 6 条（`script-network-ask-desktop`、`browser-act-danger-ask`、`browser-act-ask-desktop`、`lark-write-ask`、`browser-navigate-ask-desktop`、`mcp-tool-ask`）+ 合成兜底 `default-write-execute-ask`；
> - **断言**：**若某规则在 `standard` 档的生效动作为 `auto-evaluator`，则其 `loose` 档生效动作须为 `auto-evaluator` **或 `allow`****。违背即 CI 红。

**为何定义域是 7 条、断言须含 `allow`**（D1 的要点）：`browser-navigate-ask-desktop` 与 `mcp-tool-ask` 基线同为 `ask`、`standard` 档经 `transforms` 得 `auto-evaluator`，但它们在 `loose` 档**不是**由本方案覆盖层接管，而是由**既有 `scope-loose-*` 条目**取代为 `allow`（比「自动」更松，不构成缺陷）。若守卫只对基线集合跑 `effectiveActionFor`（不经 `resolvePolicyRules` 的 scope 取代），这两条在 loose 侧会判成恒等 `ask` → **误报违例、CI 无谓变红**。

**当前应全绿**：4 条数组规则 + 合成兜底由覆盖层处理为 `auto-evaluator`/`allow`；上述 2 条由 `scope-loose-*`（`allow`）接管——**7 条全部满足「loose 不比 standard 严」**。

含义：**"宽松档比标准档还严"这一缺陷形态一旦复发，测试立刻失败**——实施者被迫在 `DESKTOP_RULE_OVERRIDES.loose` 补登记（或显式声明该规则属有意例外）。这既守住 S1 形态，又消掉了「未来忘记登记」的风险。

### 4.6 约束六：custom 档不得静默波及（评审 B1 应答）

**custom 档语义**：`applyCustom`（`policyPackages.ts:252-264`）= **基线规则 + 用户显式覆盖**；`effectiveActionFor` 对 custom **恒等提前 return**（:216）。

**v10 的错误**：v10 把 `browser-act-ask-desktop` 的**基线**动作从 `ask` 改 `allow`。因基线动作跨档位共享，**desktop × custom** 下未显式覆盖该规则的用户，浏览器 act 会从「真人确认」静默变为「直接放行」——而 v10 的 §3 矩阵无 custom 列、§8 只断言三档，**该变化完全隐身**。这与方案自身对 Q8「须产品确认而非静默改动」的要求矛盾。

**v11 的修复（采纳评审建议 2）**：`browser-act-ask-desktop` 的目标改由**覆盖层**表达（§5.1），**基线保持 `ask`**。于是：

- custom：`effectiveActionFor` 提前 `return rule.action` → `ask`（真人，**不变**）✅
- 严格：不配 strict 覆盖 → 恒等 `ask`（真人，**不变**）✅ ——**并顺带省掉了 v10 的严格档 scope 条目**（§10 Q7 的实现方式随之简化）

---

## §5 落点：按 ruleId 的档位覆盖（逐条显式）

### 5.0 机制：动作先经「基线」再经「覆盖」

引擎判一条规则时，生效动作**分两层**：

1. **基线动作**（`DEFAULT_POLICY_RULES` 里写死的 `action`）——本方案**一律不动**；
2. **档位层**：`effectiveActionFor(lane, pkg, rule)` 把基线动作翻译为生效动作。该层现有两条来源：
   - `transforms`（按**动作类别**映射，S1 后仅剩 `standard.ask→auto-evaluator`）；
   - `scopePackages`（按 ruleId **取代规则**，用于 strict/loose 的域覆盖）。

本方案新增**第三条**：`ruleActionOverrides`（按 ruleId **直接覆盖生效动作**），优先级最高、粒度最细、**不改动前两条**。

> 比喻：`transforms` 是"按法条类型统一颁司法解释"，`scopePackages` 是"逐条修订某几条法条"，`ruleActionOverrides` 是"逐条加一句但书"——三者都只影响"怎么用"，不改"法条原文"。

### 5.1 机制实现（`ruleActionOverrides`）

```ts
// policyPackages.ts —— LaneProfile 增加一个可选字段
export interface LaneProfile {
  // ...既有字段（transforms / scopePackages 均不动）
  /**
   * 按 ruleId 的档位动作覆盖（优先级高于 transforms 的按动作映射）。
   * 形态同 scopePackages：显式清单、逐条登记；不构成 S1 所禁止的「按动作类别整体宽严变换」。
   */
  ruleActionOverrides?: Partial<Record<PolicyPackage, Partial<Record<string, PolicyAction>>>>
}

const DESKTOP_RULE_OVERRIDES: LaneProfile['ruleActionOverrides'] = {
  // 标准档：其余桌面 ask 规则（段5 三条 + browser-navigate-ask-desktop / mcp-tool-ask / 合成兜底）
  // 已由 transforms.standard.ask → auto-evaluator 覆盖；仅本条需放行
  standard: { 'browser-act-ask-desktop': 'allow' },
  // 宽松档：transforms 无 loose 键 → 逐条登记（四条对齐标准档 + browser-act 放行）
  loose: {
    'script-network-ask-desktop': 'auto-evaluator',
    'browser-act-danger-ask': 'auto-evaluator',
    'browser-act-ask-desktop': 'allow',
    'lark-write-ask': 'auto-evaluator',
    'default-write-execute-ask': 'allow'
  }
  // strict 不设：保持恒等 → 全部「真人」（Q7 = B 由此天然满足）
  // custom 不设且不可达：effectiveActionFor 对 custom 提前 return
}
```

```ts
// policyPackages.ts —— effectiveActionFor 增加「按 ruleId 覆盖」分支（含 lane 白名单防御）
export function effectiveActionFor(lane, pkg, rule): PolicyAction {
  if (isTransformExempt(rule)) return rule.action
  if (pkg === 'custom') return rule.action
  const profile = LANE_PROFILES[lane]
  // ⚠️ 硬编码 lane 白名单：按 ruleId 覆盖仅对 desktop 生效（双保险之二）
  if (lane === 'desktop') {
    const byId = rule.id ? profile.ruleActionOverrides?.[pkg]?.[rule.id] : undefined
    if (byId) return byId                          // ← 新增：按 id 优先
  }
  const mapping = profile.transforms[pkg]
  return mapping?.[rule.action] ?? rule.action
}
```

```ts
// policyEngine.ts —— applyDefault 传入带 id 的合成规则（原为裸 { action: 'ask' }）
const synthetic = { id: 'default-write-execute-ask', when: 'invocation' as const, action: 'ask' as const }
const effective = deps.transform ? deps.transform(synthetic) : 'ask'
// allow → autoAllow（该分支已存在，无需新增）；auto-evaluator → 快通道/机审；ask → 真人
```

> **三条边界行为注意**：
> 1. `applyDefault` 第①分支（`default-extraction-failed`）与第②分支（read/outbound 放行）**不受本覆盖影响**，保持原样；
> 2. `deps.transform` 的入参类型需从 `Pick<PolicyRule,'action'|'locked'>`（`src/shared/confirmation/types.ts:569`）放宽为**可选带 `id`**；
> 3. **渲染端必须同步补传 `id`**——否则设置页「显示=实际」断裂（v12 评审 **C1**，详见 §5.1.1）。

#### 5.1.1 渲染端必须同步（v12 评审 C1）

**事实**：设置页两处调用（`src/renderer/components/Config/ToolsSecuritySettingsTab.tsx:237`、`:243`）当前为：

```tsx
effectiveActionFor(lane, pkg, { action: r.action, locked: r.locked })   // ← 未传 id
```

该处注释原文即为「生效动作（**显示=实际**）」——本项目一条文档化原则。因未传 `id`，`ruleActionOverrides` 的 byId 分支**永不命中**，设置页显示的仍是"基线经 `transforms` 变换"后的动作，与引擎实际（消费 byId 覆盖）不一致：

| 场景 | 设置页显示 | 引擎实际 | 风险方向 |
|---|---|---|---|
| `browser-act-ask-desktop` · 标准档 | 「自动」 | 「放行」 | 显示偏严（低危） |
| 段5 三条 · 宽松档 | 「询问」 | 「自动」/「放行」 | **显示偏松**：用户看到"询问"，实际已放行 → **安全 UX 高危** |

> 注：合成兜底规则 `default-write-execute-ask` **不在设置页展示清单内**（它不在 `DEFAULT_POLICY_RULES`，由 `applyDefault` 合成），故不列入本对照；其宽松档 `allow` 不影响设置页展示正确性。

**修复**：渲染端两处调用补传 `r.id`（视图对象自带 `id`）：

```tsx
effectiveActionFor(lane, pkg, { id: r.id, action: r.action, locked: r.locked })
```

两处调用分属不同分支（精确表述，v13 评审 P3 修正）：`:237` 位于 `r.locked` 分支（locked 条目不参与档位变换，补不补 `id` 结果相同，但为一致性同样补传）；`:243` 位于 `pkg !== 'custom'` 分支（**本次 §5.1 覆盖的实际影响面**）。custom 分支走 `Select`、不调 `effectiveActionFor`，故 custom 档展示不受影响。

**v11 论断更正留痕**：v11 §5.1 注 3 曾写「渲染端无需适配」，其依据是上一轮评审针对 `syntheticTransforms` 的核验——但那次核验的前提是**覆盖只作用于合成规则**（合成规则不在设置页展示清单内）。v11 把 byId 覆盖扩展到**数组内展示规则**（段5 四条）后仍沿用旧结论，属**外推错误**。C1 由此产生。

**「只改桌面」的双保险**：

| 层 | 机制 | 作用 |
|---|---|---|
| **一（配置隔离）** | `ruleActionOverrides` 只挂 `LANE_PROFILES.desktop`；远程取 `wechat`/`feishu`（**无该字段**）→ 不命中 | 正常路径下远程零影响 |
| **二（硬编码白名单）** | `effectiveActionFor` 内 `if (lane === 'desktop')` 才查该字段 | 即便将来有人**误给远程 profile 配了**，也不生效 |

两层叠加后，影响面**严格等于**：`desktop × {standard, loose} × 上述登记条目`。

### 5.2 为何不采用另两条落点（决策留痕）

| 落点 | 做法 | 否决理由 |
|---|---|---|
| **改基线动作** | 直接改 `defaultRules.ts` 的 `action` | **B1**：基线跨档位共享 → 静默波及 custom（§4.6）；且触发 lint 三校验（§4.1）、规则跃迁（§4.2）、远程外溢（§4.4） |
| **改档位表** | `DESKTOP_TRANSFORMS` 加 `loose: { ask: 'auto-evaluator' }` | **B2**：属 S1 明令移除的「按动作类别整体宽严变换」（§4.5） |
| **按 ruleId 覆盖（采用）** | `ruleActionOverrides`（§5.1） | 无上述外溢；形态与 S1 保留的 `scopePackages` 同构 |

> 另注：`scopePackages` 亦可表达 `loose` 的 `auto-evaluator`（`scopeVariant` 的 action 参数接受 `auto-evaluator`），但 `scopeVariant` 的 **loose 分支会剥离门控**（`askUnless`/`configRequires`）——对 `lark-write-ask`（带 `askUnless`）会**改变其门控语义**（用户已配"不问"时仍走机审）。覆盖层**不剥离门控**——引擎第 6 步**先算生效动作**（经 `deps.transform`，含本方案覆盖层），**再判 `askUnless` 门控**（`policyEngine.ts:447` → `:450`），且门控放行条件显式包含 `auto-evaluator`；故 `lark-write-ask` 用户已配「不问」时仍直接放行，覆盖层不改其门控语义。故更合适。

### 5.3 逐规则落点

| 规则 | 涉及档位 | 落点 |
|---|---|---|
| `script-network-ask-desktop` | 宽松 | `ruleActionOverrides.loose` → `auto-evaluator` |
| `browser-act-danger-ask` | 宽松 | 同上 |
| `lark-write-ask` | 宽松 | 同上 |
| `default-write-execute-ask` | 宽松 | `ruleActionOverrides.loose` → `allow`（+ `applyDefault` 传 id） |
| `browser-act-ask-desktop` | 标准 + 宽松 | `ruleActionOverrides.standard/.loose` → `allow` |

---

## §6 逐规则改动清单

| # | 规则 | 涉及档位 | 目标 | 覆盖层配置 |
|---|---|---|---|---|
| 1 | `script-network-ask-desktop` | 宽松 | `auto-evaluator` | `loose['script-network-ask-desktop']` |
| 2 | `browser-act-danger-ask` | 宽松 | `auto-evaluator` | `loose['browser-act-danger-ask']` |
| 3 | `lark-write-ask` | 宽松 | `auto-evaluator` | `loose['lark-write-ask']` |
| 4 | `default-write-execute-ask` | 宽松 | `allow` | `loose['default-write-execute-ask']` + `applyDefault` 传 id |
| 5 | `browser-act-ask-desktop` | 标准 + 宽松 | `allow` | `standard['browser-act-ask-desktop']` / `loose[...]` |

> **`defaultRules.ts` 零改动**（无 `action` 修改、无 `denyClass` 删除、无新增 scope 条目）。
> **`DESKTOP_TRANSFORMS` / `DESKTOP_SCOPE_PACKAGES` 零改动。**
> **例外守护**：`default-extraction-failed`（M3 不变换例外）必须继续恒为真人（`answerer=user`），不得登记进覆盖层。

---

## §7 实施步骤

**第 1 步 · 新增覆盖字段与分支**（`policyPackages.ts` + `src/shared/confirmation/types.ts`）

1. `LaneProfile` 增 `ruleActionOverrides?`；`effectiveActionFor` 增「按 ruleId 优先」分支 + `lane === 'desktop'` 白名单（§5.1）。
2. `deps.transform` 入参类型放宽为可选带 `id`（`types.ts:569`）。

**第 2 步 · 配置覆盖**（`policyPackages.ts`）

3. 定义 `DESKTOP_RULE_OVERRIDES`（§5.1），挂到 `LANE_PROFILES.desktop.ruleActionOverrides`。

**第 3 步 · 合成规则传 id**（`policyEngine.ts`）

4. `applyDefault` 第 ③ 分支改为传入 `{ id: 'default-write-execute-ask', ... }`（`allow` 分支已存在，无需新增）。

**第 4 步 · 注释同步**（`policyPackages.ts`）

5. 按 §4.5 表格更新 `effectiveActionFor` 注释（补 `ruleActionOverrides` 说明）；`transforms`/`scopePackages` 的 S1 注释**保持不动**。

**第 4b 步 · 渲染端补传 id**（评审 C1，`src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`）

5b. 两处 `effectiveActionFor(...)` 调用（:237、:243）的规则实参补 `id: r.id`，恢复「显示=实际」（§5.1.1）。custom 分支不涉及。

**第 5 步 · 测试**

6. **须翻转的既有断言**：

| 测试 | 位置 | 冲突内容 | 预期 |
|---|---|---|---|
| `toolDecisionMatrix.test.ts` | :171-175 | 「桌面 act 无当前页域名 → require-confirm / ruleId=browser-act-ask-desktop」 | **保持全绿**（已核验：该文件 `deps()`（:53）**不注入 `transform`** → `effectiveActionFor` 不参与 → 仍 `require-confirm`）。standard 覆盖的断言应**新建**带 `transform` 装配的用例承载（见第 8 项） |
| `toolDecisionMatrix.test.ts` / `toolCallGate.test.ts` | 其余 desktop browser-act / write 用例 | 同上 | **逐条核对**：预期仅"显式注入了 `transform` 的用例"需翻转或新增 |

7. **不须翻转而须"新增"的测试**：`laneProfiles.test.ts` 的 `EXPECTED` 矩阵（其 `effectiveActionFor` 调用**不传 `id`** → 不命中覆盖层 → 矩阵**保持全绿**，仅需**新增**一条带 `id` 的覆盖专项用例）；`policyPackages.scope.test.ts:116-124`（测 `resolvePolicyRules`，覆盖层不改规则集 → **保持全绿**）。
8. **须新增的断言**：四档 × 5 规则符合 §3 矩阵（G2）；`default-extraction-failed` 为真人（G6）；远程不变（G10）；白名单负向用例（G11）；**设置页显示=实际（G13）**——渲染端补传 id 后，覆盖档位行的显示须与引擎实际一致（`ToolsSecuritySettingsTab.test.tsx` 已有同类"standard 显示自动"用例可扩展）。
9. **新增「loose 不得比 standard 严」守卫断言**（G12，§4.5）：**输入取 `resolvePolicyRules` 解析后的规则集**（含 scope 取代），定义域为桌面可命中的非 locked `ask` 规则（数组内 6 条 + 合成兜底 = **7 条**）；断言"standard 生效为 `auto-evaluator` ⇒ loose 生效 ∈ {`auto-evaluator`, `allow`}"。**当前应全绿**——4 条数组规则 + 兜底由覆盖层处理，`browser-navigate-ask-desktop` / `mcp-tool-ask` 由 `scope-loose-*`（allow）接管。价值在**防未来漂移**：新增规则若漏登记（loose 侧落在 `ask`）即 CI 变红。建议置于 `policyPackages.scope.test.ts` 或新增 `policyPackages.askAlignment.test.ts`。

**第 6 步 · 回归**

9. `defaultRules.lint.test.ts`（应全绿——未改基线）、`policyEngine.test.ts` / `policyPackages*.test.ts` / `toolCallGate.test.ts` / `toolDecisionMatrix.test.ts`。

---

## §8 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| G1 | `defaultRules.lint.test.ts` 全绿（基线未改） | 单测 |
| G2 | **四档**生效动作符合 §3 矩阵 | 单测断言 |
| G3 | `browser-act-ask-desktop`：标准/宽松 `allow`；**严格 `ask`（真人）**；**custom `ask`（真人）** | 单测（四档） |
| G4 | 段5 三条（script / browser-danger / lark）在 loose 下为 `auto-evaluator`（`answerer=agent`） | 单测 |
| G4b | `default-write-execute-ask` 在 **loose** 下为 `allow` | 单测 |
| G5 | 上述四条 + 兜底在 **strict** 下仍为真人 | 单测 |
| G5b | `default-write-execute-ask` 在 **standard** 下仍为 `auto-evaluator` | 单测 |
| G5c | 上述全部规则在 **custom** 下仍为真人（B1 回归防护） | 单测 |
| G6 | `default-extraction-failed` 仍恒为真人 | 单测 |
| G7 | `write_file`/`edit_file`：standard 走 `file-fast-track`；loose 为 `allow` 直放。**审计须可解释**：loose 下可能出现 `file.auto-approve=fallback(outside_workdir)` 与 `policy.decision=auto-allow` 并存——**属预期**（§4.3.1） | 集成 + 审计核对 |
| G8 | 规则顺序语义不变（未改基线 → 天然满足） | 单测 |
| G9 | 审计可解释：`ruleId` / `answerer` / 上述组合可复核 | 手工核对 |
| G10 | 远程 lane（wechat/feishu）在 loose 下，**远程可命中的规则**（`browser-act-danger-ask` 无 lane、`lark-write-ask` 含 feishu、兜底 `default-write-execute-ask`）均仍为真人（不变）。注：`browser-act-ask-desktop` / `script-network-ask-desktop` 为 desktop-only（`lane:['desktop']`），远程本就非命中，**不在本项断言内** | 单测 |
| G11 | **硬编码白名单防御**：即便人为在 `LANE_PROFILES.wechat` 配 `ruleActionOverrides`，远程仍不生效 | 单测（负向） |
| G12 | **「loose 不得比 standard 严」守卫**（§4.5，Q9 选法 A 的配套）：输入取 **`resolvePolicyRules` 解析后**的规则集（含 scope 取代）；桌面可命中的非 locked `ask` 规则（数组内 6 条 + 合成兜底 = 7 条）中，凡 `standard` 生效为 `auto-evaluator` 者，`loose` 生效须为 `auto-evaluator` **或 `allow`** | 单测（防未来漂移；当前应全绿） |
| G13 | **设置页显示=实际**（评审 C1，§5.1.1）：渲染端补传 `id` 后，`browser-act-ask-desktop` 标准档显示「放行」、段5 三条宽松档显示「自动」，与引擎实际一致（合成兜底不在设置页展示清单内，**不列入本断言**） | 渲染端测试（`ToolsSecuritySettingsTab.test.tsx`） |

---

## §9 风险与回滚

| 风险 | 来源 | 缓解 |
|---|---|---|
| lint 失败 | **不适用**（未改基线动作） | — |
| 规则顺序跃迁 | **不适用**（未改基线动作） | — |
| 远程 lane 行为变化 | **不适用**（desktop 专属 + 白名单） | — |
| **custom 档静默波及** | 若误用「改基线动作」（v10） | **本方案已规避**（§4.6）；G5c 回归防护 |
| **设置页「显示≠实际」** | 渲染端未传 `id`（评审 C1，若缺 §7 第 4b 步） | §5.1.1 说明 + §7 第 4b 步补传 `r.id`；G13 断言。属**安全 UX 高危**方向（显示"询问"而实际放行） |
| **S1 决策被静默反向修改** | 若误用 `transforms.loose`（v10） | **本方案已规避**（§4.5，新增 §4.5 留痕）；第 4 步注释同步 |
| 覆盖层绕过 lint 保护面 | §4.1 注 | 受覆盖规则已带 lane；未来新登记须评审 |
| **未来新增 `ask` 规则漏登记 → 缺陷复现** | 逐条登记形态（§4.5） | **G12 守卫断言**兜底：standard/loose 不一致即 CI 红 |
| 高危 act 交机审后被放行 | §4.3 | 机审为"审批 Agent 裁决"，非静默放行；复核拒绝率。这三条无快通道、直落机审（Q2 已定） |
| **写入边界收紧失效** | §4.3.1：`default-write-execute-ask` loose 下 `allow`，边界判定不再拦截 | **已由产品确认接受（Q8 = A）**；仅两条窄 `deny` 仍拦；审计仍留判定记录 |
| **总开关 `actRequiresConfirm` 在 desktop 标准/宽松档静默失效** | `browser-act-ask-desktop` 被覆盖为 `allow` 后，开关 ON（默认）/OFF 判定结果相同（2026-09-30 评审 P1）：`browser-act-session-trust-requirement.md` NG1 声明的总开关语义与 L1/L2 信任机制（`actTrustedDomains`/会话信任）在标准/宽松档实质空转；提示倒挂（受信域名有「已信任…自动执行」提示 `toolChatLoop.ts:3224-3247`，未受信域名静默直放）。开关残余作用：act 危险评估是否执行（`toolChatLoop.ts:2196-2197`）、信任提示文案。**事实核补（v16，用户质询触发）**：该开关**自引入起即无设置页入口**（渲染端零引用、git 全历史无 UI 记录、无 IPC 写点），运行时恒为默认 `true`，普通用户不可达；设置页暴露的是信任体系另两项（`actSessionTrustEnabled` / `actHighRiskKeywords`）。故本项定性由「用户可见总开关静默失效」**下修为「内部配置位在标准/宽松档失去区分作用」**——不存在「用户显式偏好被无视」 | **已闭环（Q11 = (a) 文档同步，v17）**：需求文档升 v2.4（NG1 补注 + §5.7 协作表补行）；残余仅「提示倒挂」一项 UX 观察留档 |
| 回滚 | — | 撤销 `DESKTOP_RULE_OVERRIDES` 与 `effectiveActionFor` 新分支、`applyDefault` 传 id 改动；**基线/规则集无需回滚**（未动） |

---

## §10 决策记录（均已关闭）

| # | 问题 | 状态 / 说明 |
|---|---|---|
| Q1 | 落点怎么选？ | **已定（v11 修订）：统一用「按 ruleId 覆盖」**（§5.1）；改基线动作（B1）与改档位表（B2）均否决（§5.2）。 |
| Q2 | browser/script/lark 是否需要**真快通道**？ | **已定：先只有机审**。本期不另立评估器；后续如需，再按 `autoEvaluator` 端口扩展。 |
| Q3 | `browser-act-danger-ask` 的 lane 限定如何处理？ | **已定：不补 lane**。覆盖层按 ruleId 生效，与 lane 限定无关；远程因白名单/空配置天然不变。 |
| Q4 | `browser-act-ask-desktop` 严格档也放行吗？ | **已定：见 Q7**——严格档保持问人。 |
| Q5 | `lark-write-ask` 的 feishu 分支是否不动？ | **已定：不动**。覆盖层只挂 desktop；且覆盖层不剥离 `askUnless` 门控（§5.2）。 |
| Q6 | `strict` 档是否同步获得自动？ | **已定：不获得**。严格档「尽量多问人」为有意设计。 |
| Q7 | `browser-act-ask-desktop` 严格档取什么？ | **已定：真人（选法 B）**。v11 下**无需 scope 条目**——不配 strict 覆盖即恒等 `ask` → 真人（实现较 v10 简化）。 |
| Q8 | `default-write-execute-ask` 宽松档取 `allow` 还是 `auto-evaluator`？ | **已定：`allow`（选法 A）**，已确认接受边界扩张（§4.3.1）。 |
| Q9 | **是否接受"逐条登记"的维护成本**（新增桌面 `ask` 规则不会自动对齐标准档）？ | **已定：选法 A —— 接受逐条登记，并加"标准/宽松对齐"守卫断言**（用户裁决 2026-09-29）。守卫见 §4.5 与 §8 G12：输入取 `resolvePolicyRules` 解析后的规则集，桌面可命中的非 locked `ask` 规则（7 条）中，若 standard 生效为 `auto-evaluator`，则 loose 须为 `auto-evaluator` 或 `allow`——违背即 CI 红，杜绝未来漏登记。备选 (B) 恢复 `transforms.loose` 已否决（构成对 S1 的反向修改）。 |
| Q10 | **custom 档**是否需要产品确认变化？ | **无需**——v11 下 custom 天然不变（§4.6、G5c）；仅作留痕。 |
| Q11 | **`browser-act-ask-desktop` 覆盖为 `allow` 后，`actRequiresConfirm` 在 desktop 标准/宽松档失去区分作用**（2026-09-30 评审 P1；**v16 事实核补**）——如何处置？ | **已关闭（v17，按路径 (a) 文档同步完成）**。核补事实：该开关**自引入起即无设置页入口**（渲染端零引用、git 全历史无 UI 记录、无 IPC 写点），运行时恒为默认 `true`，普通用户不可达——不存在「用户显式偏好被静默无视」；设置页暴露的是信任体系另两项（`actSessionTrustEnabled` / `actHighRiskKeywords`）。同步动作：`browser-act-session-trust-requirement.md` 升 **v2.4**——NG1 补注（开关作用范围收敛为 desktop 严格/自定义档与远程 lane）、§5.7 协作表补「档位覆盖」行、头部补 v2.4 变更记录。残余一项 UX 观察留档：未受信域名 act 在标准/宽松档静默直放，与信任命中「已信任…自动执行」提示不对称（如需可后续为档位放行补 inline 提示）。曾评估的路径 (b)（覆盖尊重开关）因开关用户不可达而价值存疑，弃。 |

---

## 附录 A：证据锚点

| 论断 | 位置 |
|---|---|
| 「自动」仅 standard 独占 | `src/shared/policy/policyPackages.ts` · `DESKTOP_TRANSFORMS`（:87-89） |
| 档位无映射即恒等 | 同上 · `effectiveActionFor`（:210-219） |
| custom 提前 return（恒等） | 同上（:216） |
| custom = 基线 + 用户覆盖 | 同上 · `applyCustom`（:252-264） |
| locked/deny/confirm-every-time 豁免变换 | 同上 · `isTransformExempt`（:200-202） |
| S1 范围档收口注释 | 同上（:68-74、:84-86、:204-208） |
| scope 条目派生（loose 剥离门控） | 同上 · `scopeVariant`（:100-119） |
| lint 三校验 | `src/shared/policy/defaultRules.lint.test.ts`（:8-16、:20-28、:93-99） |
| 第 4 步按基线 `action` 过滤 | `src/shared/policy/policyEngine.ts:422` |
| 第 6 步按 `deps.transform` 产出时变换 | 同上（:447） |
| 合成兜底 `default-write-execute-ask` | 同上 · `applyDefault`（:299-343，`allow` 分支 :336） |
| 回答者派生 | 同上 · `askAnswererFor`（:249-251） |
| `deps.transform` 入参类型 | `src/shared/confirmation/types.ts:569` |
| 评估器路由与端口 | `electron/confirmation/toolCallGate.ts:713-751` |
| 写路径事实与自动审批无条件执行 | 同上（:771-796） |
| 确认诊断取 `denyClass` | 同上（:914-936） |
| 段5 规则定义 | `src/shared/policy/defaultRules.ts:295-330` |
| lane availableActions | `src/shared/policy/policyPackages.ts` · `LANE_PROFILES` |
| 渲染端规则视图来源 | `electron/confirmation/settingsSecurityModel.ts:51-72` |
| **渲染端生效动作调用（未传 id → 评审 C1）** | `src/renderer/components/Config/ToolsSecuritySettingsTab.tsx:237,243` |
| **loose 由 scope 接管的两条规则（评审 D1）** | `src/shared/policy/policyPackages.ts:137-140`（`DESKTOP_SCOPE_PACKAGES.loose`：`browser-navigate-ask-desktop` / `mcp-tool-ask` → `allow`） |
| **引擎第 6 步：先算 effective 再判 askUnless** | `src/shared/policy/policyEngine.ts:447`（transform）→ `:450`（门控） |
| **`toolDecisionMatrix` 的 `deps()` 不注入 `transform`** | `electron/confirmation/toolDecisionMatrix.test.ts:53` |

## 附录 B：修订记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1 | 2026-09-29 | 初稿 |
| v2 | 2026-09-29 | 纳入"仅 desktop lane、远程零变化"约束 |
| v3 | 2026-09-29 | 重写落点章节（改档位表 / 改规则动作），修正"browser-act-ask-desktop 必须改基线动作" |
| v4 | 2026-09-29 | 修正过度推广：严格档为零改动、只修宽松档 |
| v5 | 2026-09-29 | 落地 Q7 = B（严格档保持问人） |
| v6 | 2026-09-29 | 落地 Q8（兜底改 `allow`）；新增合成规则覆盖机制与边界含义节 |
| v7 | 2026-09-29 | 补"只改桌面"论证（配置隔离 + lane 白名单） |
| v8 | 2026-09-29 | 落地硬编码白名单；补 G11 负向用例 |
| v9 | 2026-09-29 | 关闭 Q2（先只有机审）/ Q8（选法 A） |
| v10 | 2026-09-29 | 全文一致性修订（6 处矛盾 + 冗余清理） |
| **v11** | **2026-09-29** | **采纳 v10 评审**：落点统一为「按 ruleId 覆盖」（`ruleActionOverrides`），**基线动作 / `transforms` / `scopePackages` / `defaultRules.ts` 全部零改动**。解决 **B1**（custom 静默波及）、**B2**（与 S1 范围档收口冲突）、**N1**（scope 条目丢 `denyClass`）；**N2** 改为"须翻转清单 + 须新增清单"；**N3** 修正锚点与 §4.3.1 表述（检查仍执行并留审计）。§3 矩阵补 custom 列；§4 新增 §4.5（S1 应答）、§4.6（custom 应答）；§5/§6/§7/§8/§9/§10 相应重写；新增 Q9/Q10。 |
| **v12** | **2026-09-29** | **关闭 Q9（用户裁决 = 选法 A + 守卫断言）**：接受「逐条登记」形态以尊重 S1，并新增 **G12「标准/宽松对齐」守卫断言**（桌面可用的非 locked `ask` 规则，standard 得 `auto-evaluator` ⇒ loose 亦须得；违背即 CI 红）。更新 §4.5、§7 第 9 步、§8（G12）、§9、§10 Q9（关闭）。 |
| **v13** | **2026-09-29** | **采纳 v12 评审 C1 修复**：新增 **§5.1.1「渲染端必须同步」**（两处 `effectiveActionFor` 调用须补传 `id`，否则设置页「显示=实际」断裂——本章程为安全 UX 高危）；修正 §5.1 注 3 的 v11 错误论断并留痕；§7 新增第 4b 步；§8 新增 **G13**（显示=实际）；§9 新增"显示≠实际"风险行。另采纳评审 P3：§7 第 6 项删除"待确认 deps 装配"（已核验 `deps()` 不注入 transform，该用例保持全绿）、第 8 项补 G13；**G10 表述收窄**（改为"远程可命中的规则"，两条 desktop-only 规则不在断言内）。 |
| **v14** | **2026-09-29** | **采纳 v13 评审 D1 修复**：**G12 守卫定义域漏算 2 条规则**（`browser-navigate-ask-desktop`、`mcp-tool-ask`——二者在 loose 由既有 `scope-loose-*` 取代为 `allow`，非经覆盖层）。§4.5 守卫断言改为**输入取 `resolvePolicyRules` 解析后的规则集**、定义域**7 条**、断言改为「standard `auto-evaluator` ⇒ loose ∈ {`auto-evaluator`, `allow`}」；§7 第 9 步、§8 G12、§10 Q9 同步。并更正"4 条显式登记"→**5 条**（§4.5）。另采纳评审 P3：§5.1.1 表格删去"兜底"行（合成规则不在设置页展示）、修正"两处均位于 custom 分支"表述（`:237` 在 locked 分支）、附录 A 文件名笔误（`ToolsSettingsSecurityTab` → `ToolsSecuritySettingsTab`）、§5.2 门控顺序措辞（`policyEngine.ts:447` 先算 effective、`:450` 再判门控）。 |
| **v15** | **2026-09-30** | **实施完成 + 评审处置留痕**：实施分支 `feat/desktop-ask-rule-tier-overrides`（worktree `.worktrees/feat-ask-rule-tier`）全量落地 §5–§7，新增 `policyPackages.ruleOverrides.test.ts`（G2–G6/G10–G12，19 例）+ 渲染端 G13 用例；全量 5964 例回归绿。评审（`docs/review/feat-ask-rule-tier-review.md`）发现 **P1：`browser-act-ask-desktop` 覆盖为 `allow` 后 `actRequiresConfirm` 总开关在标准/宽松档静默失效**——属方案未留痕的连带后果，按路径 **(c) 维持拍板行为 + 补录留痕**（§9 风险表、§10 Q11 开放拍板，路径 a/b 与落法已在 Q11 记录）。同批采纳评审 P3：G12 守卫定义域改为**从 `DEFAULT_POLICY_RULES` 派生**（invocation/非 locked/ask/lane 未限定或含 desktop，新规则自动纳入）并新增「最小域锚点」用例防派生缩水；G11 负向用例补 mutate 单例的执行模型前提注释。 |
| **v16** | **2026-09-30** | **Q11 事实核补（用户质询触发）**：核实 `actRequiresConfirm` **自引入起即无设置页入口**（渲染端零引用、git 全历史无 UI 记录、无 IPC 写点），运行时恒为默认 `true`，普通用户不可达；设置页暴露的是信任体系另两项（`actSessionTrustEnabled` / `actHighRiskKeywords`）。P1 定性由「用户可见总开关静默失效」**下修为「内部配置位在标准/宽松档失去区分作用」**——不存在「用户显式偏好被无视」；路径 (a) 的「设置页开关文案」子项不适用。残余待办收敛为：NG1 文档一致性 + 提示倒挂 UX 观察（受信域名 act 有「已信任自动执行」提示、未受信域名静默直放）。§9 风险表、§10 Q11 同步修正。 |
| **v17** | **2026-09-30** | **Q11 关闭（路径 (a) 文档同步完成，用户指示执行）**：`browser-act-session-trust-requirement.md` 升 **v2.4**——头部补 v2.4 变更记录与关联文档、NG1 补注（开关作用范围收敛为 desktop 严格/自定义档与远程 lane，且为无 UI 入口的内部配置位）、§5.7 协作表补「档位覆盖」行。残余一项 UX 观察留档（未受信域名 act 标准宽松档静默直放，与信任命中提示不对称）。§9 风险表、§10 Q11 状态同步为已闭环。 |
