# 脚本远程认证快车道扩容与能力声明制 —— 改进计划

> **定位**：修复两处「自动审核空转」——① RemoteCertifier（远程链路正向白名单认证）的建模形状集过窄，认证通过率≈0，已接线的 IM 认证快车道常年无流量；② 脚本能力声明只有路径一族（`@path-scope workdir-readonly`）且只接了 desktop 一条规则，微信/飞书链路无法消费任何声明。
> **状态**：草稿（**决策未定**：D1 / D2 / D3 待拍板；未实施）｜**核对基线**：`main` `26a79788`（2026-10-31）
> **范围**：`electron/shell/scriptContentSecurity.ts`（RemoteCertifier、危险/网络模块集合）、`electron/confirmation/extractors/scriptPathFacts.ts`（声明解析与事实）、`electron/confirmation/toolCallGate.ts`（信号组装与一致性校验）、`src/shared/confirmation/types.ts`、`src/shared/policy/defaultRules.ts`、`src/shared/confirmation/labels.ts`。
> **非本计划范围**：网络出口代理化、OS 级执行沙箱、审批 Agent 上 IM 链路、非 Python 语言的内容分析接入、域名级 `net allowlist` 声明 —— 见 §2.7。
> **读者标记**：【人必读】= 只做取舍的决策界面；【机｜人工可跳过】= 规格与任务编排。
> **篇内路由**：只看要拍板什么 → §0；想知道凭什么这么改 → §1；实现与验收 → §2、§3；只看要跑什么 → §3.2、§4。

---

## 0. 【人必读】决策界面

**一句话**：IM（微信/飞书）链路对「内容完全干净的脚本」早就修好了一条自动放行车道——认证通过 + 用户配置关掉「远程脚本需确认」即可自动执行——但负责发证的 RemoteCertifier 几乎不发证（除直线式脚本外全部构造都会让认证失败），所以车道常年空转，所有脚本都落到人工确认。本计划修三件事：**给认证器补形状**（让它能证更多确实干净的脚本）、**把能力声明从一族扩到三族**（路径/网络/进程）、**补齐检测盲区**（multiprocessing / pickle / ftp/smtp 等当前完全不可见的危险面）。

**只有 3 分钟的话**：读 D1、D2、D3 的「建议」，再看 §1.3 的盲区清单。

### D1｜认证器补形状的节奏

- **背景**：RemoteCertifier 的语句遍历只建模 7 种（import / from_import / assign / expr / if / for / pass），表达式只建模 5 组（叶子字面量 / attr / binop / list、tuple / call）；`while` / `try` / `function_def` / `class_def` / `dict` / `compare` / `f_string` / 推导式等一律认证失败。而 IR（`scriptIr/types.ts`）与 Analyzer（黑名单）早已覆盖全部这些构造——扩认证只是把 Analyzer 已有的遍历语义镜像过来，不新增任何裁决规则。
- **要决定什么**：
  - **A. 一次全量**：一个提交补齐全部形状，最快见效。
  - **B. 分两批（建议）**：先补无绑定语义的形状（while / try / return / assert / dict / compare / f_string / 推导式 / lambda 等），golden 测试过关后再补携带绑定/定义时求值语义的形状（aug_assign / with / walrus / function_def / class_def）。
- **每个选项的后果**：两者都不改变任何 deny/ask 判定（认证只用于把 remote 的 `allow` 从「不可能」变成「可能」，失败只会落回既有人工确认）。差别只在出错时的定位成本：绑定位置（`x = os.system` 这类别名失效点）是历史评审固化的失效点高发区（见 `scriptIr/types.ts` 头部绑定位置强制审查清单），分批能让 golden 测试二分定位、单批回滚。
- **可逆性**：可逆 —— 纯扩容，revert 即回滚。
- **依据强度**：形状集缺失为代码事实（§1.1 命令可复现）；扩形状后的认证通过率提升幅度无实测数据，属待验证假设（§4 外部验收给出实测口径）。
- **建议**：**B**（两批合并在同一迭代内，只是提交与测试门禁分两步）。
- **决议**：（待定）

### D2｜能力声明在微信/飞书链路的 v1 语义

- **背景**：desktop 已有「声明 + 分析一致 → 配置后免确认」规则（`script-declared-path-scope-allow-desktop`，config `allowDeclaredPathScopeScripts` 默认关）。IM 链路目前对声明零消费。
- **要决定什么**：
  - **A. 仅收紧 + 展示（建议）**：声明与事实**不一致**时新增 locked 逐次确认；一致时不改变处置，只在确认卡片展示声明内容（帮人更快判断）。**不新增任何放行**。
  - **B. 认证 + 声明 + 配置开放放行**：在 A 基础上，新增配置键（默认关）：认证通过 + clean + 三族声明全一致时，IM 链路免确认执行。
- **每个选项的后果**：A 零放行面变化，最稳，但 IM 自动化率不因声明制提升（提升全部来自 D1 的认证扩形状）。B 解锁无人值守放行，但必须诚实承认上界：**声明的可信度 = 检测器覆盖面**——P0 硬化（D3）之后，声明一致仍不能排除第三方库的未知能力面；B 只应在 P0 落地并实测后开启。
- **可逆性**：A 可逆；B 由默认关闭的配置键承载，随时可关。
- **依据强度**：「不一致收紧」无争议；「一致即可放行」的可靠性依赖 P0 硬化的完备性，属未验证假设。
- **建议**：**v1 做 A**；B 作为 P3 跟随项实现但默认关（实现成本低，与 A 同批落地，是否开放由你在 P0 验证后决定）。
- **决议**：（待定）

### D3｜能力表前置硬化的范围（P0）

- **背景**：以下构造当前对黑名单与认证器**完全不可见**（零命中、认证放行）：`multiprocessing`（起进程）、`concurrent.futures`（进程池）、`pickle` / `marshal`（反序列化可执行任意代码）、`ftplib` / `smtplib` / `xmlrpc` / `telnetlib`（真实网络出站，但不在网络模块表）。desktop 上这些脚本现在以 clean 面目**免确认直接执行**（`script-clean-allow-desktop`）；IM 上以 clean 面目进入认证快车道判定。若不做 P0，「声明 process none / net none」的一致性校验对这批盲区失效（伪造声明骗过校验），D2=B 即不可靠。
- **要决定什么**：
  - **A. 最小集**：只加 `multiprocessing` / `concurrent`（进程族）。
  - **B. 进程 + 反序列化 + 网络补全（建议）**：进程族 + `pickle` / `marshal` + `ftplib` / `smtplib` / `xmlrpc` / `telnetlib`。
- **每个选项的后果**：**全是收紧向变更**，已有脚本的处置会变严：desktop 上原 clean 直接执行的脚本改为 ask（standard 档位下由审批 Agent 自动评）；IM 上原走网络 deny 的语义扩展到新网络模块（`script-network-deny-remote` locked）。需要发布说明。A 的好处是动静小，但反序列化与网络盲区仍在，D2=B 依旧不可靠。
- **可逆性**：可逆 —— 单集合变更，revert 即回滚。
- **依据强度**：盲区为代码事实（§1.3 命令可复现）；「变严影响多少存量脚本」无实测数据。
- **建议**：**B**。
- **决议**：（待定）

### 不需要你决定（Agent 负责；写出来是为了不占用你的时间）

- 各形状的具体遍历实现（机械镜像 Analyzer 既有语义，不新增裁决规则）。
- 认证版本标记 `script-certifier-v1` → `v2`（形状集与声明语义变更必须进入决策缓存/审批材料的身份指纹）。
- golden 测试用例矩阵、`labels.ts` 新提示文案、审计字段落点（`policy.decision` 既有事件族）。
- `locked floor` 分类文档的同步更新（`security-policy-locked-floor-classification.md`）。

---

## 1. 【人机共读】问题与实证

### 1.1 认证快车道已接线，但常年空转

**链路事实**（三条均有既有代码承载，非本计划新建）：

1. `analyzeScriptContent(code, { remote: true })` 中 `allow` 判定需同时满足「黑名单零命中 + `isScriptCertifiedRemoteSafe` 认证通过」，否则降级为 ask 并由提取器产 `script-uncertified` 信号（`script-uncertified-ask-remote` locked 规则兜底人工）。wechat / feishu / automation 三个 lane 均以 `remote: lane !== 'desktop'` 进入认证（`toolCallGate` 组装 `rawScriptAnalysis` 处）；认证通过是 IM 链路脚本自动化的唯一门票。
2. 门票消费管线完整在位：规则 `script-clean-certified-remote`（`askUnless: { config: 'remoteScriptRequiresConfirm', equals: false, andMigrationComplete: true }`，默认确认）+ IM 套餐场景 `certified-clean-script`（strict→ask / standard→auto-evaluator / loose→allow，见 `imPolicyBehavior.ts` 的 `IM_ACTION_MATRIX`）。
3. desktop 不依赖认证：`script-clean-allow-desktop` 对黑名单沉默的脚本**免确认直接执行**——认证器扩形状不改变 desktop 行为。

**空转原因**：RemoteCertifier 建模形状集过窄（语句 7 种、表达式 6 种），除直线式脚本外全部构造认证失败 → 几乎所有 IM 脚本产 `script-uncertified` → locked ask。

**复现命令**：

```bash
rg -n "class RemoteCertifier" -A 95 electron/shell/scriptContentSecurity.ts
# walkStmts 仅 import/from_import/assign/expr/if/for/pass 有 case，其余 default: this.fail()；
# walkExpr 仅叶子字面量/attr/binop/list、tuple/call 五组有 case。

rg -n "script-clean-certified-remote|certified-clean-script" src/shared/policy/
# 门票管线：defaultRules.ts 规则 + imPolicyBehavior.ts 场景与套餐矩阵。

rg -n "isScriptCertifiedRemoteSafe" electron src
# 消费点：scriptAnalysisExtractor.ts（script-uncertified 信号）、scriptContentSecurity.ts（remote allow 降级）。
```

### 1.2 能力声明已有雏形，但只有一族、一条规则

现状（`parseScriptPathDeclaration`）：只识别脚本首部注解块的 `# @path-scope workdir-readonly` 单值声明；仅容忍 shebang / coding 等注解行，出现第一条非注解语句行即停止；未知值视为未声明。唯一消费规则 `script-declared-path-scope-allow-desktop`（desktop + config `allowDeclaredPathScopeScripts` 默认关），match 要求 `clean + script-path-extraction:unknown + script-path-declaration-consistent`——即声明只用于覆盖「路径提取不完整」这一种缺口，且仅 desktop。

**缺口**：网络族、进程族无声明语法；IM 链路对任何声明零消费；一致性校验是单向的（只查「声明了 readonly 且事实未见越界」，不产「声明与事实冲突」的强信号）。

```bash
rg -n "@path-scope|parseScriptPathDeclaration|script-path-declaration" electron src/shared
rg -n "allowDeclaredPathScopeScripts" electron src/shared
```

### 1.3 检测盲区使「声明一致 → 放行」不可靠（P0 的动机）

以下调用当前**零命中、认证放行**：`multiprocessing.Process(...)`、`concurrent.futures.ProcessPoolExecutor(...)`、`pickle.loads(...)`、`ftplib.FTP(...)` 等。它们不在 `DANGEROUS_MODULES` / `NETWORK_MODULES`，因此：黑名单沉默（desktop `script-clean-allow-desktop` 直接执行）+ 认证放行（认证器只对 `isDangerousModule` 命中失败）→ 一段伪造 `# @path-scope workdir-readonly` 声明的脚本可以通过 desktop 声明免确认规则。这是 D2=B 的前置阻断项，也是独立的现行风险。

```bash
rg -n "multiprocessing|pickle|marshal|ftplib|smtplib|xmlrpc|telnetlib" electron/shell/scriptContentSecurity.ts
# 零命中：这些模块对黑名单与认证器均不可见。
```

---

## 2. 【机｜人工可跳过】规格层

### 2.1 事实卡

**事项一（P0）能力表硬化**

- 输入：模块根名集合。
- 变更点（单点）：`DANGEROUS_MODULES` += `multiprocessing` / `concurrent` / `pickle` / `marshal`；`NETWORK_MODULES` += `ftplib` / `smtplib` / `xmlrpc` / `telnetlib`；Analyzer `analyzeCall` 新增两个定向分支：`chain.module ∈ {multiprocessing, concurrent}` → 复用 A1（进程创建族语义）；`chain.module ∈ {pickle, marshal}` 且末位 attr ∈ {load, loads} → 复用 A3（动态执行族语义）。
- 产出：Analyzer 命中（desktop ask / IM `script-network` deny 或 A 档 ask）；认证器 `walkCall` 因 `isDangerousModule` 命中自动 fail（无需改认证器）。
- 说明：`scriptPathFacts` 的路径侧不需要同步改——未知模块调用已落 `unmodeledCall`（fail-closed）。

**事项二（P1）认证器扩形状**

- 输入：`IrModule`（节点全集已存在，见 `scriptIr/types.ts`；Analyzer 已有逐节点遍历语义）。
- 变更点：`RemoteCertifier.walkStmts` / `walkExpr` 补 case。批 1（无绑定语义）：`while` / `try` / `return` / `assert` / `raise` / `delete` / `break` / `continue` / `global_nonlocal` + 表达式 `dict` / `set` / `compare` / `boolop` / `conditional` / `subscript`（仅非调用位置；调用位置 callee 为 subscript 的既有 fail 语义不变）/ `slice` / `unaryop` / `starred` / `await` / `yield` / `f_string` / `ellipsis` / `comprehension`（elt + 各 generator 的 iter / conditions）/ `lambda`（defaults + body）。批 2（绑定与定义时求值，镜像 Analyzer 既有处理）：`aug_assign`（`applyAssignmentRebind` + walk value）、`with`（walk contextExpr + body）、`named_expr`（walrus，按 Analyzer obs1 语义 rebind + walk value）、`function_def`（decorators / defaults + body 子作用域递归）、`class_def`（decorators / bases + body 子作用域递归）。
- 产出：`certify` 布尔语义不变、覆盖面扩大；`default: this.fail()` 保留（未建模仍失败）。
- 版本：`authenticationVersion: 'script-certifier-v1'` → `'script-certifier-v2'`。

**事项三（P2）能力声明制**

- 输入：脚本首部注解块，多行声明：

  ```python
  # @path-scope workdir-readonly     # 既有，保留
  # @requires net none               # 新增：不发起任何网络访问
  # @requires process none           # 新增：不创建子进程
  ```

- 解析规则：沿用 `parseScriptPathDeclaration` 的首部注解块语义（shebang / coding 容忍、非注解行即停）；同一块内收集多行；任何 `@requires` 值未识别 → 整条视为未声明（向后兼容，fail 向现状）。
- 产出（facts 层）：`ScriptPathFacts` 增加 `capabilities`（pathScope / net / process 三族，未声明为 undefined）；toolCallGate 产信号 `script-capability-declaration` `{ declared, consistent, violations: string[] }`（新信号 kind，进 `src/shared/confirmation/types.ts`）。一致性**两向**校验：声明 `net none` ⇔ 事实无 `script-network`；声明 `process none` ⇔ 事实无 A1/B5 命中（等价 `script-analysis` 为 clean 的进程子集）；声明 `workdir-readonly` ⇔ 既有路径校验。冲突族逐条写入 `violations`。
- 产出（policy 层）：policyEngine 暴露 token `script-capability-declaration-consistent` / `script-capability-declaration-conflict` / `script-capability-declared:<族>`；`defaultRules.ts` 新增/调整规则见 §2.4。
- 展示：`labels.ts` 增加声明提示文案（确认卡片摘要 section），保持与既有 `scriptDeclarationHint` 同风格。

### 2.2 不变量与契约

- **INV-A** 认证只降级不升级：`certify = false` 只阻止 remote `allow`，永不产生 deny（既有语义，P1 不得破坏）。
- **INV-B** fail-closed 保持：未建模构造 → `fail()`；`IrCoverageError` / 解析失败 → `extraction-failed` → ask（既有语义，P1 扩形状后 `default: fail()` 分支必须保留）。
- **INV-C** 单次解析不回归：声明解析是纯文本处理，不进 tree-sitter；`scriptParseCount.test.ts` 门控路径恰好 1 次 parse 的约束不变。
- **INV-D** 声明向后兼容：未识别的声明值 ≡ 未声明；未声明脚本零行为变化；`@path-scope workdir-readonly` 既有规则与信号不受 P2 影响（旧信号保留或随版本标记一并迁移，二选一在实现时定，倾向保留旧信号 + 新信号并存一个版本）。
- **INV-E** locked 底线不动：`script-network-deny-remote` / `script-uncertified-ask-remote` / `script-dangerous-deny` 不进任何档位变换集（P0 扩网络模块表后 IM 的 deny 面扩大正是消费既有 locked 规则，不需要新底线）。
- **INV-F** 新增 locked 条目须盘点：P2 的「声明冲突 → locked confirm-every-time」规则需同步进 [security-policy-locked-floor-classification.md](../security-policy-locked-floor-classification.md)。

### 2.3 阶段归属与登记

- 全部变更落在 **facts 层**（scriptContentSecurity / scriptPathFacts / toolCallGate 信号组装）与 **policy 层**（defaultRules）；final-check 阶段无变化。与 [security-policy-three-stage-architecture-contract.md](../security-policy-three-stage-architecture-contract.md) 同口径。
- `policyFloor.ts` 无需新条目（P2 的 locked 语义走 defaultRules locked 标记）；`imPolicyBehaviorResolvers` / `policyFloor` 中引用 `script-network-deny-remote` / `script-uncertified-ask-remote` 的 excludeSignals 逻辑不受影响（评审候选机制不动）。

### 2.4 场景矩阵

**形状 × 认证（P1 golden 矩阵，每形状两行）**

| 形状 | safe 变体（如 `while i < 3: print(i)`） | dangerous 变体（如 `while True: os.system('x')`） |
| --- | --- | --- |
| 批 1 / 批 2 全部形状 | 认证通过（配合黑名单零命中 → remote allow 可达） | 认证失败 **且** 对应 pattern hit（A1/A3/…） |

**声明 × lane × 配置（P2 处置矩阵，「现」= 基线 `26a79788` 行为）**

| lane | 声明 | 一致性 | 配置 | 处置 |
| --- | --- | --- | --- | --- |
| desktop | 无 | — | — | clean → allow（不变） |
| desktop | 有 | 一致 | `allowDeclaredPathScopeScripts=false`（默认） | confirm（不变） |
| desktop | 有 | 一致 | `=true` | allow（既有规则；P2 起消费三族声明） |
| desktop | 有 | 冲突 | — | 现无处置 → **新增 locked confirm-every-time** |
| wechat/feishu | 无 | — | — | 既有（clean+认证 → `script-clean-certified-remote`；否则 uncertified locked ask）（不变） |
| wechat/feishu | 有 | 一致 | `remoteScriptRequiresConfirm=false` | D2=A：仍 ask，卡片展示声明；P3（D2=B，默认关）：allow |
| wechat/feishu | 有 | 冲突 | — | **新增 locked confirm-every-time**（强于现状的 uncertified ask——冲突是更强的坏事实） |
| automation | 有/无 | — | — | 不消费声明（`automation-script-path-unknown-deny` locked 保持；声明仅 facts 层记录） |

**P0 行为变化矩阵（收紧面，发布说明用）**

| 构造 | desktop 现状 → P0 后 | IM 现状 → P0 后 |
| --- | --- | --- |
| multiprocessing / concurrent.futures | clean 直接执行 → ask（standard 档：审批 Agent 自动评） | clean 快车道判定 → A1 命中（非 network）→ suspicious → uncertified ask |
| pickle.loads / marshal.load | clean 直接执行 → ask | 同上（A3 命中） |
| ftplib / smtplib / xmlrpc / telnetlib | clean 直接执行 → ask（`script-network-ask-desktop`） | clean 快车道判定 → **deny**（`script-network-deny-remote` locked） |

### 2.5 验收清单（AC）

- **AC-1** P1 golden 矩阵全覆盖：批 1 / 批 2 每个形状的 safe 变体 `isScriptCertifiedRemoteSafe = true`；dangerous 变体 `= false` 且 Analyzer hit 不缺。
- **AC-2** 认证失败语义不变：`IrCoverageError` / 未知构造仍 fail 并落 `script-uncertified` → locked ask（既有测试全绿）。
- **AC-3** P0 每个新模块的 Analyzer 测试（desktop ask 档 / IM `script-network` deny 档 / A1、A3 复用档）+ 认证 fail 测试。
- **AC-4** 声明解析测试：多行声明、与 `@path-scope` 混用、未知值 → 未声明、非首部注释忽略、（既有 `@path-scope` 测试不回归）。
- **AC-5** 一致性信号测试：`violations` 逐族列出；`script-capability-declaration` 信号进入 `policy.decision` 审计字段。
- **AC-6** 规则测试：desktop 冲突 → locked confirm-every-time；IM 冲突 → locked confirm-every-time；desktop 三族一致 + config → allow；未声明脚本与基线行为逐一相同（回归矩阵）。
- **AC-7** 版本标记：`authenticationVersion` 升 v2，决策缓存键与审批材料身份包含新值（相关 cache 测试更新）。
- **AC-8** 单次解析不回归：`scriptParseCount.test.ts` 全绿。
- **AC-9** memory 资格：扩形状后 `script-uncertified` 减少，`memoryEligibility` 相关测试按新行为更新（净效应：更多 clean 脚本可进记忆资格）。
- **AC-10** 全量回归：`scriptContentSecurity*.test.ts`、`scriptGolden.test.ts`、`scriptPathFacts.test.ts`、`defaultRules.contract/lint`、`policyDecisionBoundary`、`imPolicyBehavior*`、`toolCallGate.ports` 全绿。

### 2.6 迁移与回滚

- **P0**：收紧向行为变化（§2.4 第三张表）进发布说明；单 commit，revert 即回滚。
- **P1**：纯扩容，无任何既有判定变化；两批各自独立 commit + golden 门禁，可单独 revert。
- **P2**：声明语法向后兼容（未知值 ≡ 未声明）；新增 locked 规则只对「声明存在且冲突」触发，未声明脚本零行为变化；desktop 三族 allow 沿用既有 config（默认关）；`script-certifier-v2` 版本标记使旧缓存自然失效（无需清理任务）。
- **P3**（若 D2=B）：新配置键默认关，settings 变更走既有 `settings.*` 审计事件族（`settingsAudit.ts`）。

### 2.7 非目标

- 网络出口代理化 / 域名级 `net allowlist` 声明（中期项）。
- OS 级执行沙箱（长期项）。
- 审批 Agent（auto-evaluator）上 IM 链路。
- 非 Python 语言（JS/TS/PowerShell）的内容分析接入。
- 黑名单模式 ID 体系重构（A0–A9/B1–B11 语义冻结不变，P0 只复用既有 ID）。

---

## 3. 执行计划

### 3.1 依赖表

| 任务 | 依赖 |
| --- | --- |
| P0 能力表硬化 | D3 拍板 |
| P1-a 认证扩形状批 1 | D1 拍板 |
| P1-b 批 2（绑定/定义时求值） | P1-a golden 全绿 |
| P2 能力声明制 | D2 拍板 + P0（一致性可信度前置） |
| P3 IM 声明放行配置 | D2=B + P0 验证 + P2 |
| P4 收尾归档 | P0–P2（或 P3）全部收口 |

### 3.2 阶段与任务

**阶段 P0：能力表硬化（对应 D3）**

1. `scriptContentSecurity.ts`：扩 `DANGEROUS_MODULES` / `NETWORK_MODULES`；`analyzeCall` 增 multiprocessing/concurrent → A1、pickle/marshal loads → A3 两个定向分支。
2. 测试：`scriptContentSecurity.test.ts` 增新模块用例；`scriptGolden.test.ts` 增对应 golden。
3. 门禁：全量回归（AC-10 清单）+ §2.4 第三张表逐格断言。

**阶段 P1：认证器扩形状（对应 D1）**

1. 批 1：`RemoteCertifier.walkStmts` / `walkExpr` 补无绑定形状 case（§2.1 事项二清单）。
2. 批 1 golden：AC-1 矩阵批 1 部分，落 `scriptContentSecurity.test.ts`（certify 布尔断言）+ `scriptGolden.test.ts`。
3. 批 2：绑定/定义时求值形状（逐项对照 `scriptIr/types.ts` 头部绑定位置审查清单复核）。
4. 批 2 golden：AC-1 批 2 部分。
5. `authenticationVersion` bump v2 + 缓存相关测试更新（AC-7）。

**阶段 P2：能力声明制（对应 D2=A 部分）**

1. `scriptPathFacts.ts`：`parseScriptPathDeclaration` → `parseScriptDeclarations`（多行三族）；`ScriptPathFacts` 增 `capabilities`。
2. `src/shared/confirmation/types.ts`：新信号 kind `script-capability-declaration`。
3. `toolCallGate.ts`：信号组装 + 两向一致性校验（复用既有 `script-path-declaration` 一致性判定的四条件，扩展网络/进程族）。
4. `policyEngine.ts` token 映射 + `defaultRules.ts`：desktop/IM 冲突 locked confirm-every-time 两条新规则；desktop 三族一致 allow 规则扩展（沿用 `allowDeclaredPathScopeScripts`）。
5. `labels.ts` 声明提示文案；审计字段核对（[security-policy-audit-field-map.md](../security-policy-audit-field-map.md) 如需补充字段则同步）。
6. 测试：AC-4 / AC-5 / AC-6。

**阶段 P3（仅 D2=B）：IM 声明放行配置**

1. 新配置键（默认关）+ `imPolicySnapshot` 传递 + `toolCallGate` 消费 + 设置页开关（i18n 全套 key + `npm run i18n:generate-types` + `i18n:check`）。
2. `defaultRules.ts`：IM 声明放行规则（match：clean + 三族一致 + 认证通过，configRequires 新键）。
3. `settingsAudit.ts` 接 `settings.*` 审计。

**阶段 P4：收尾**

1. 本篇按 `docs/develop` 维护方法归档（`git mv` → `archive/safety-approval/`），`safety-approval/README.md` 在途清单更新。
2. 若 D2=B，实测口径见 §4；`security-policy-locked-floor-classification.md` 补 P2 新 locked 条目（INV-F）。

### 3.3 门禁与环境说明

- 每阶段收尾跑：`npm test`；涉 labels/i18n 时 `npm run i18n:check`（P3 加 `npm run i18n:generate-types`）；`npm run check:system-invariant-registry`（仓库门禁）；`npm run build` 确认主进程编译。
- 主进程测试环境为 `node`（vitest `environmentMatchGlobs`），脚本安全相关测试均落主进程侧。

---

## 4. 外部验收（不阻塞源码关闭）

实机验收口径（需要打包或 `npm run dev` 实跑，建议在 P1 收口后做一轮）：

1. **desktop 回归**：含 `while` 循环的纯计算脚本 clean 直接执行行为不变；含 `multiprocessing` 的脚本从「直接执行」变为确认卡（standard 档由审批 Agent 自动评）。
2. **IM 认证快车道实测**：loose 套餐 + `remoteScriptRequiresConfirm=false`，含 `while` / `try` / `dict` 的纯计算 pathlib 读脚本自动执行（认证扩形状的直接收益）；含 `requests.get` 脚本仍 deny（locked 不动）。
3. **声明冲突收紧**：脚本声明 `@requires net none` 但含 `urllib` 调用 → IM/desktop 均逐次确认，确认卡展示冲突族。
4. **认证通过率对比**：对固定脚本样本集（直线式 / 控制流 / 函数式各若干）统计 `script-uncertified` 产信号率，P1 前后对比数据回填本节。

---

## 5. 交付前自检

- [ ] D1 / D2 / D3 决议回填 §0。
- [ ] §2.4 三张矩阵逐格有测试或明确标注「不适用」。
- [ ] INV-A ~ INV-F 逐条核对（认证只降级、fail-closed、单次解析、声明兼容、locked 底线、floor 文档盘点）。
- [ ] AC-1 ~ AC-10 全绿；`npm test` / `npm run check:system-invariant-registry` / `npm run build` 通过。
- [ ] P0 收紧面已写进发布说明。
- [ ] 本篇归档至 `archive/safety-approval/`，`safety-approval/README.md` 在途清单与状态更新。
