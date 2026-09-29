# run_script 路径提取假阳性：诊断与改进方案

- 状态：已实施（2026-09-30，P0 / P1 / P2 全量落地；同日评审 B1/B2/B3 阻断项已修复，见 §12.7；端到端真机验收遗留，见 §12.6）
- 触发场景：会话 `a7981827-5a20-4eab-a6fd-a2971e12659c`（"会话 27"）中 `run_script` 反复弹人工确认卡
- 涉及模块：`electron/confirmation/extractors/scriptPathFacts.ts`、`electron/shell/scriptIr/pythonAdapter.ts`、`src/shared/policy/defaultRules.ts`
- 关联文档：`docs/develop/script-security-parser-treesitter-upgrade-plan.md`、`docs/develop/security-approval-experience-improvement-plan.md`
- v1 评审：`docs/review/script-path-extraction-false-positive-plan-review.md`

---

## 0. 一句话结论

用户看到的现象**不是"审核 Agent 没生效"**，而是 `run_script` 命中了 `defaultRules.ts` 里的 `script-path-unknown-confirm`（`locked: true` 的 `confirm-every-time` 规则），它**设计上就不经过审核 Agent、强制真人逐次确认**。而触发它的原因是**路径提取器的能力缺口**：`os.path.join`、`os.walk`、`json.*`、`collections.*`、`re.*`、函数定义等一切未被白名单建模的调用，都被判为 `script-path-extraction: unknown`。

这是**把"工具能力不足"固化成了不可绕过的安全铁律**，本方案的目标是修正它。

---

## 1. 现象与定位

### 1.1 用户问题

> 为什么 `a7981827-...` 会话的脚本执行一直在弹确认框？审核 Agent 没生效吗？

### 1.2 审批链路的三个候选环节

| 环节 | 位置 | 本会话实证 |
|---|---|---|
| 策略引擎判定 | `src/shared/policy/policyEngine.ts` `decide()` | 268 条 `policy.decision` |
| 人工确认卡 | `confirm-every-time` 规则 | `run_script` × 5 |
| 审核 Agent（机审） | `ask` → `answerer: 'agent'` | MCP 调用 × 4，真实裁决 |

### 1.3 审计日志（唯一可信来源）

审批事件**不落在** `sessions/events.jsonl`（该机制本就不把审批写进会话落盘），而在 `.agent/logs/SecurityAudit-20260929.log`。

按目标会话过滤后：

```
事件类型          数量
policy.decision   268
confirm.request     9   (run_script 5 + MCP 4)
confirm.outcome     9   (approved 7 / rejected 2)
file.auto-approve  41
```

`run_script` 判定明细（20 条 `policy.decision`）：

```
15 × auto-allow       rule = script-clean-allow-desktop
 5 × require-confirm  rule = script-path-unknown-confirm
```

### 1.4 关键对照：审核 Agent 确实在工作

`confirm.request` / `confirm.outcome` 全量 9 条：

| 序号 | 工具 | outcome | cause | 备注 |
|---|---|---|---|---|
| 1 | `queryMyTokenrank` | rejected | **agent-deny** | 审核 Agent 拒绝 |
| 2 | `queryMyTokenrank` | approved | **agent-approved** | 审核 Agent 放行 |
| 3 | `queryPublicTokenrank` | approved | **agent-approved** | 审核 Agent 放行 |
| 4 | `getPartyDetail` | rejected | **agent-deny** | 审核 Agent 拒绝 |
| 5 | `run_script` | approved | **user-approved** | 真人点卡 |
| 6 | `run_script` | approved | **user-approved** | 真人点卡 |
| 7 | `run_script` | approved | **user-approved** | 真人点卡 |
| 8 | `run_script` | approved | **user-approved** | 真人点卡 |
| 9 | `run_script` | approved | **user-approved** | 真人点卡 |

**MCP 那 4 次是 `agent-approved` / `agent-deny` —— 审核 Agent（机审）真实介入并裁决过。**
而 `run_script` 的 5 次 `cause` 全是 `user-approved`，**从未经过审核 Agent**。

### 1.5 代码依据

```ts
// src/shared/policy/defaultRules.ts
{
  id: 'script-path-unknown-confirm',
  when: 'invocation',
  match: { lane: ['desktop','wechat','feishu'], toolName: 'run_script',
           signals: ['script-path-extraction:unknown'] },
  action: 'confirm-every-time', locked: true,
  reason: '脚本路径提取不完整，需真人确认'
}
```

```ts
// src/shared/policy/policyEngine.ts  decide()
// 第 1 步之后、缓存查询之前：
const confirmEveryTime = invocationRules.find(
  (r) => r.locked && r.action === 'confirm-every-time' && ruleMatchesInvocation(r, facts, context, deps)
)
if (confirmEveryTime) {
  // 决策 3：confirm-every-time 始终人工逐次确认（不因 lane 落 agent）
  return requireConfirm(confirmEveryTime, facts, context.sessionId, context.lane, constraints, 'user')
}
```

`locked: true` + `confirm-every-time` + 显式 `'user'` 回答者，三者叠加 ⇒ **任何套餐、任何档位、任何自动审批都无法覆盖，且绝不派生给审核 Agent**。它不是 `ask`（`ask` 才会被派生给审批 Agent）。

### 1.6 时间轴：15 → 5 的分界

20 条决策的 `signals` 字段分成两组，且分界点正好夹在应用重启标记之间：

```
... 最后一个 auto-allow         ts=1790645601535  signals=['script-analysis','script-uncertified']
    cache.generation-reset      ts=1790645969040  ← 应用重启（带上了新构建）
    第一个 require-confirm      ts=1790646272338  signals=['script-analysis','script-uncertified','script-path-extraction']
```

| 组 | 条数 | signals | 含 `script-path-extraction` |
|---|---|---|---|
| auto-allow | 15 | `['script-analysis','script-uncertified']` | ❌ 无 |
| require-confirm | 5 | `[..., 'script-path-extraction']` | ✅ 有 |

**前 15 次跑在旧构建上（该特性尚未上线），后 5 次跑在新构建上。** 该特性上线后，这类脚本 **5/5 必弹**（不是"部分脚本触发"）。

---

## 2. 探针实测（决定性证据）

### 2.1 方法

临时探针 `electron/confirmation/extractors/zz-probe.test.ts`（临时文件，调查结束已删除），调用真实 `extractScriptPathFacts()`，覆盖 20 组最小片段 + 21 段该会话的真实 `run_script` 脚本（`electron/**/*.test.ts` 走 `vitest --project electron`，`setup-electron-parser.ts` 会初始化脚本解析器）。

> 证据边界：探针由**用户在本地终端手动执行**（Agent 的 `run_shell` 三次被机审拒），以下是其真实 stdout。

### 2.2 最小片段矩阵

```
[FRAG] f1  纯 print                              => complete  dynamic=false paths=[]
[FRAG] f2  裸 os.path.join（全字面量，无 IO）     => unknown   dynamic=true  paths=[]
[FRAG] f3  join赋值给变量 + open(变量)            => unknown   dynamic=true  paths=[]
[FRAG] f4  直接 open(join(...)) 全字面量          => unknown   dynamic=true  paths=[]
[FRAG] f5  join 结果用于 open 但 join 是变量      => unknown   dynamic=true  paths=[]
[FRAG] f6  os.path.dirname                       => unknown   dynamic=true  paths=[]
[FRAG] f7  os.walk 遍历                          => unknown   dynamic=true  paths=[]
[FRAG] f8  collections.Counter                   => unknown   dynamic=true  paths=[]
[FRAG] f9  json.loads                           => unknown   dynamic=true  paths=[]
[FRAG] f10 re.sub                               => unknown   dynamic=true  paths=[]
[FRAG] f11 函数定义                              => unknown   dynamic=true  paths=[]
[FRAG] f12 类定义                                => unknown   dynamic=true  paths=[]
[FRAG] f13 纯算术赋值                            => complete  dynamic=false paths=[]
[FRAG] f14 自增赋值 x += 1                        => unknown   dynamic=true  paths=[]
[FRAG] f15 字面量 open("/tmp/a")                 => complete  dynamic=false paths=["/tmp/a"]
[FRAG] f16 混合：字面量 open + 变量 open          => unknown   dynamic=true  paths=["/tmp/static"]
[FRAG] f17 subprocess                            => unknown   dynamic=true  paths=[]
[FRAG] f18 pathlib 链式 Path("/a").read_text()    => complete  dynamic=false paths=["/a"]
[FRAG] f19 典型会话写法（全字面量 join + 变量open）=> unknown   dynamic=true  paths=[]
[FRAG] f20 全字面量 join，结果不再被使用          => unknown   dynamic=true  paths=[]
```

**f4 是最关键的实测结论**：即使 `join` 参数全是字面量、且直接喂给 `open`，`paths` 仍为 `[]`。原因见 §3.2 —— 嵌套内层的 `os.path.join(...)` 调用节点自身就撞上 catch-all。

**只有 4 种写法能判 `complete`**：`print()`、纯算术、`open("字面量")`、`Path("字面量").read_text()`。要在数据分析脚本里同时避开 `join`/`walk`/`json`/`collections`/`re`/函数定义/变量中转 —— 等于不能写脚本。**所以"改脚本写法"这条路不存在。**

### 2.3 真实脚本批量判定

```
[SCRIPT  0..20] 全部 unknown  dynamic=true  paths=0
[SUMMARY] total=21 complete=0 unknown=21
```

21 段脚本全部 `unknown`，且**静态路径提取数全为 0**。特征分布：

| 特征 | 段数 |
|---|---|
| 含 `open()` | 21 |
| 含 `os.path.join` | 15 |
| 含 `json` | 15 |
| 含 `collections.Counter` | 12 |
| 含函数定义 | 5 |

平均 2037 字符，均为多步数据分析脚本。

---

## 3. 根因（代码级）

### 3.1 catch-all：未建模的调用一律 unknown

`electron/confirmation/extractors/scriptPathFacts.ts` `walkExpr()` call 分支末尾：

```ts
const isPathConstructor = chain === 'Path' || Boolean(chain?.endsWith('.Path'))
if (!(chain && (FILE_CALLS.has(chain) || PROCESS_CALLS.has(chain) || KNOWN_NON_IO_CALLS.has(chain)))
    && !isPathMethod && !isPathConstructor) state.unknown = true
```

三个白名单：

```ts
FILE_CALLS        // 18 个：open / pathlib.Path.read_text / os.remove / shutil.copy ...
PROCESS_CALLS     // 17 个：subprocess.* / os.system / eval / exec / __import__ ...
KNOWN_NON_IO_CALLS// 24 个：print / range / len / str / int / enumerate / zip ...
```

`os.path.join` **不在任何白名单** ⇒ 必然 `unknown`。**判据是"函数名不在名单"，与该调用实际做了什么无关。**

### 3.2 嵌套也躲不掉

`walkExpr` 对 `call` 分支会递归 `expr.args.forEach(walkExpr)`。因此 `open(os.path.join("d","events.jsonl"))` 中，内层 `os.path.join` 节点**自己**触发 catch-all → `unknown`，且内层参数不会进 `paths`。这就是 f4 的现象。

### 3.3 一整类无条件 unknown

除 catch-all 外，还有几处无条件设 unknown：

| 代码位置 | 触发 | 是否合理 |
|---|---|---|
| `case 'function_def': state.unknown = true` | 定义函数 | ❌ 定义本身无 IO（函数体已在递归扫描） |
| `case 'class_def': state.unknown = true` | 定义类 | ❌ 同上 |
| `case 'aug_assign': state.unknown = true` | `x += 1` | ❌ 仅当目标是 import 绑定名才有害 |
| `case 'delete': ... state.unknown = true` | `del x` | 需评估 |
| `case 'f_string'` 有插值 | `f"{x}"` | 部分合理（插值不可静态化），但全静态 f-string 已支持 |
| `case 'global_nonlocal'` | `global x` | 需评估 |

### 3.4 与内容分析器的结论矛盾

同一次 `run_script`，门控产出两组信号（`toolCallGate.ts:474–488`）：

- 内容分析器 → `script-analysis: clean`，摘要"脚本静态分析未发现危险模式"
- 路径提取器 → `script-path-extraction: unknown`

**一个说"没发现危险"，一个说"不知道去哪，必须拦"**，且后者 `locked` 一票定音。

### 3.5 设计意图的问题

`unknown` 的真实语义是**"我们的分析器能力不足"**，却被赋予了与 `path-target:sensitive-file`（**确定踩了敏感路径**）同等的处置强度（`locked` + `confirm-every-time`）。这是本节要修正的核心。

---

## 4. 影响面

| 维度 | 现状 |
|---|---|
| 命中率 | 数据分析类脚本 **100% 弹卡**（21/21） |
| 可规避性 | 无 —— 唯一 `complete` 的写法等于放弃写脚本 |
| 可覆盖性 | 无 —— `locked: true`，套餐/档位/信任列表均不可覆盖 |
| 用户体验 | 每段脚本都要手点；且确认卡不说明"为何判未知" |
| 安全收益 | **接近零** —— 假阳性来自纯字符串函数，不触及文件系统 |

---

## 5. 改进方案

### 5.0 设计原则

> **把 `unknown` 的触发，从"出现未建模调用"收窄到"未建模调用触达 IO / 动态执行面"。**

危险动作**各有定向检测**，不依赖"未建模即危险"这个假设：

| 危险面 | 现有定向检测 |
|---|---|
| 写/删文件 | `FILE_CALLS` 写类 + `writePathFacts` |
| 起进程 | `PROCESS_CALLS` |
| 网络访问 | `script-network` 信号（`NETWORK_PATTERN_IDS`） |
| 动态执行 | `PROCESS_CALLS` 含 `eval/exec/compile` |

---

### P0 — 提取器能力补齐（不动策略规则、不碰安全语义）

#### P0-1 路径构造器纳入字符串折叠

`foldStringIr` 已支持 `string` / `binop'+'` / 单元素 tuple / 全静态 f-string。**扩展折叠规则**，使其能对以下路径构造器求值：

| 构造器 | 处理 |
|---|---|
| `os.path.join(a, b, ...)` | 全参数静态可折时，按平台分隔符折叠 |
| `os.path.dirname` / `basename` / `splitext` | 同上（单参数） |
| `pathlib.PurePath` / `Path` 的 `/` 运算 | `PurePath("a") / "b"` → `a/b` |

**扩展点**：`electron/shell/scriptIr/pythonAdapter.ts` 的 `foldStringIr`，或新增 `foldPathIr` 在 `scriptPathFacts.ts` 侧消费。

> 依据：f2 / f6。

#### P0-2 局部变量常量传播（关键）

`p = os.path.join(d, "events.jsonl"); open(p, "r")` —— `open(p)` 的实参是**变量**。即使 P0-1 把 join 折好了，**不做局部变量传播仍会 unknown**。

**做法**：在 `walkStatements` 中维护 `name → 可折常量` 环境（仅记录静态可折的路径/字符串赋值），`walkExpr` 遇到 `name` 时查环境；查得到则用其值参与路径判定，查不到维持现状（unknown）。

**约束**：
- 只传播**单次赋值、无重绑定**的名字（重绑定即失效，走 unknown）；
- **失效点必须覆盖全部写入路径**：`assign`（含元组解包 / 下标 / 属性赋值）、**`aug_assign`**（`x += ...`）、**`for` 与 comprehension 的目标**（`for x in ...`）、**`del`（`delete`）**、`with ... as x`。任一出现即从环境移除该名——**严禁只处理 `assign`**，否则 `p = "静态路径"; p += os.environ["X"]; open(p)` 会被误判为可静态确定；
  - **`del` 的取名字段是 `IrExpr[]` 而非 `string`**：IR 里 `delete: { targets: IrExpr[] }`，移除环境前需先从各 `IrExpr` 提取 name（`{ kind:'name', id }` → `id`）；非 name 形态（下标 / 属性）直接忽略；
  - **comprehension 目标的失效属无害的过度保守**（`comprehension` 元素的 `target` 是 `string`，但其内部赋值本就不可静态追），照常移除即可，无需特殊处理；
- 不传播跨函数 / 跨作用域（保持保守）；
- 上限保护：环境条目数、折叠深度设上限，防爆炸。

**扩展点**：`walkStatements` 的 `case 'assign'`，与 `newScope()` 平级新增 `constEnv`。

> 依据：f3 / f5 / f19。**这是上一版方案遗漏的必需项** —— 只折 join 不传播变量，f4 之外仍有一半脚本弹卡。

#### P0-3 扩展"纯计算"白名单

将以下前缀加入 `KNOWN_NON_IO_CALLS`（或新增 `KNOWN_PURE_MODULES` 前缀表）：

```
os.path.*        json.*          re.*            math.*
collections.*    itertools.*     functools.*     datetime.*
hashlib.*        base64.*        string.*        textwrap.*
pathlib.PurePath.*
```

**安全边界**：**只能按 `os.path.*` 前缀放，不得整 `os.*`**（`os.remove` / `os.system` 在其中，属危险面）。同理 `pathlib.Path` 的写方法不在放行之列。

> 依据：f8 / f9 / f10。

#### P0-4 删除三处无条件 unknown

```diff
- case 'aug_assign': state.unknown = true; walkExpr(stmt.value, scope, paths, state); break
+ case 'aug_assign':
+   // IR 里 aug_assign 是单数 target（types.ts），不是 assign 的复数 targets
+   if (scope.modules.has(stmt.target) || scope.attrs.has(stmt.target)) state.unknown = true
+   walkExpr(stmt.value, scope, paths, state); break

- case 'function_def': state.unknown = true; ...
+ case 'function_def': ...   // 函数体已在递归扫描，定义本身不设 unknown

- case 'class_def': state.unknown = true; ...
+ case 'class_def': ...      // 同上
```

`function_def` / `class_def` 的函数体**本来就通过 `walkStatements(stmt.body, ...)` 递归扫描**，额外设 unknown 是多余的。

> 依据：f11 / f12 / f14。
> ⚠️ 需评估：去掉后，函数体内若有未建模调用仍会 unknown，安全性不降低；但要补测试确认"函数体里藏的 IO 仍能被检出"。

---

### P1 — 语义分级与规则松绑

#### P1-1 `unknown` 拆成两个语义

| 新语义 | 触发 | 处置 |
|---|---|---|
| `dynamic-execution` | eval / exec / compile / 动态 import / subprocess | 维持高处置（信息真断裂） |
| `unmodeled-call` | 不认识的标准库调用（P0 后应大幅减少） | **不作为风险信号**，最多算"覆盖不全"的提示 |

实现：`ScriptPathFacts.completeness` 之外增设 `unknownReason: 'dynamic-execution' | 'unmodeled-call' | null`，`signalTokenSet` 产出 `script-path-extraction:unknown` 时附带分类。

> ⚠️ **B2 前置条件（评审阻断项）**：P1-1 在当前实现下**无法直接实施**。
> 现状 `scriptPathFacts.ts` 末行是 `dynamicAccess: state.unknown` —— **`dynamicAccess` 与 `completeness` 共用同一个 `state.unknown` 标志**，因此任何 `unknown`（含纯 `os.path.join` 触发的）都带 `dynamicAccess: true` → `signalTokenSet` 都会产出 `script-dynamic-access` token。若 P1-2 的 locked 规则消费该 token，**命中集合与今天的 `script-path-unknown-confirm` 完全相同，"松绑"不会发生**。
> 所以 P1-1 必须先把单一 `state.unknown` 拆成**双标志**（如 `state.dynamicExecution` / `state.unmodeledCall`），并**同步修改以下 6 处**：
> 1. `scriptPathFacts.ts`：`state` 类型与两处赋值点（`PROCESS_CALLS` / catch-all）、三个无条件 unknown 点按语义归入 `unmodeledCall`；
> 2. `scriptPathFacts.ts`：`emptyUnknown()` 的返回值语义（fail-closed 出口该归哪一类）；
> 3. `scriptPathFacts.ts`：末行 `ScriptPathFacts` 返回构造；
> 4. `src/shared/confirmation/types.ts`：`kind: 'script-path-extraction'` 的信号类型增补分类字段；
> 5. `policyEngine.ts` `signalTokenSet()`：`case 'script-path-extraction'` 的分支，按新语义产出 token；
> 6. `toolCallGate.ts`：路径探测失败时**补发**的那条 `script-path-extraction`（`completeness:'unknown', dynamicAccess:true`）也要带分类，否则该分支会重新落回动态执行类。
> 7. **`script-path-extraction:unknown` token 必须对两类继续产出**（只额外**增加**分类 token，不得**替换**）。否则 `automation-script-path-unknown-deny`（`match: { lane:['automation'], toolName:'run_script', signals:['script-path-extraction:unknown'] }`，`locked` deny）会失效——automation lane 的「路径不可确认即拒绝」将退化为落 `automation-default-confirm`（`locked` ask，回答者派为审批 Agent），语义从**拒绝**变为**交审批 Agent 裁决**，属安全倒退。即：`unmodeled-call` 也应产出 `:unknown`，只是不再产出 `script-dynamic-access`。

#### P1-2 让强度依赖脚本的其他事实

> ⚠️ **B1 修正（评审阻断项）**：原稿写的 `signals: ['script-analysis:clean', ...]` 是**死代码**——`signalTokenSet` 对 `script-analysis` 只产出裸 token `clean`（`policyEngine.ts`：`tokens.add(signal.signal)`），**不存在 `script-analysis:clean` 这个 token**。且原稿遗漏了落位上的致命点（见下方三条硬要求）。

```diff
- {
-   id: 'script-path-unknown-confirm',
-   match: { ..., toolName: 'run_script', signals: ['script-path-extraction:unknown'] },
-   action: 'confirm-every-time', locked: true,
- }
+ // 真·动态执行：维持强处置（依赖 P1-1 的双标志拆分）
+ {
+   id: 'script-dynamic-execution-confirm',
+   match: { lane: ['desktop','wechat','feishu'], toolName: 'run_script',
+            signals: ['script-dynamic-access'] },
+   action: 'confirm-every-time', locked: true,
+   reason: '脚本含动态执行面，路径不可静态确认，需真人确认'
+ }
+ // clean + 仅路径未建模：降为 ask（可被信任列表 / 档位裁决）
+ // 注意 lane 数组须与 script-path-unknown-confirm 一致（desktop/wechat/feishu）
+ {
+   id: 'script-unmodeled-path-ask',
+   when: 'invocation',
+   match: { lane: ['desktop','wechat','feishu'], toolName: 'run_script',
+            signals: ['clean','script-path-extraction:unknown'] },
+   action: 'ask',
+   reason: '脚本无危险模式，但路径分析未完全覆盖，需确认'
+ }
```

**三条实施硬要求（原稿遗漏，缺任一则后果比现状更糟）**：

1. **token 必须是裸 `clean`**，不是 `script-analysis:clean`（后者永不命中）。
2. **规则必须排在所有匹配裸 `clean` token 的 `run_script` 条目之前**。`defaultRules.ts` 默认表里匹配裸 `clean` 的 `run_script` 条目有**两条**，且都排在本规则之前：

   | 规则（默认表中的实际顺序） | lane | action | 危险点 |
   |---|---|---|---|
   | `script-clean-certified-remote` | `wechat`/`feishu` | `ask` | 带 `askUnless: { config:'remoteScriptRequiresConfirm', equals:false, andMigrationComplete:true }` |
   | `script-clean-allow-desktop` | `desktop` | `allow` | 无条件放行 |

   默认表是「首条命中即返回」。若本规则只前置到 `script-clean-allow-desktop` 之前而落在 `script-clean-certified-remote` 之后：
   - **桌面 lane**：clean+unknown 脚本先命中 `script-clean-allow-desktop` → 静默 `auto-allow`、零确认；
   - **远程 lane**：先命中 `script-clean-certified-remote`，在 `remoteScriptRequiresConfirm=false` **且迁移完成**时，`askUnlessHolds()` 成立（`policyEngine.ts:239–246`）→ ask 被降为 allow → 同样静默放行。

   两者都使「摘掉 locked」变成**完全放行本应确认的脚本**，比现状（locked 逐次确认）更松动，属安全倒退。
3. **建议落位**：紧随 `script-network-ask-desktop` 之后（该位置在默认表内、且早于上述两条匹配裸 `clean` 的条目），lane 数组与 `script-path-unknown-confirm` 保持一致。

> 注：`script-clean-certified-remote` 与 `script-clean-allow-desktop` 均属「规范条目」——`defaultRules.ts` 头注释原文：「其中的**六条脚本规则（连同其顺序）**为规范条目，是 P1 等价验收的裁决依据，不得自由调整」。因此本条规则的插入位置需走**规范条目评审**，不能只当作普通编辑。

#### P1-3 摘掉 `locked`

`script-path-unknown-confirm` 表达的是"我分析能力不足"，**不是"已知危险"**。真正该 `locked` 的是 `script-sensitive-path-confirm`（确定踩敏感路径）、`script-network-deny-remote`（远程禁网络）那类。**能力不足的兜底必须允许用户用信任覆盖。**

---

### P2 — 可解释性与信任记忆

| # | 项 | 做法 |
|---|---|---|
| P2-1 | 确认卡回显命中原因 | 现在 facts 只说"未发现危险模式"，用户看不到"因 `os.path.join` 判未知"。应回显**具体行号 / 调用名**，并附免确认写法建议 |
| P2-2 | 脚本内容指纹信任 | 同一脚本被批准 N 次后提供"记住此脚本"，下次直接放行（会话级或持久级） |
| P2-3 | 声明式契约 | 允许脚本首行注解 `# @path-scope workdir-readonly`，分析器据此走轻处置 |

---

## 6. 安全边界论证

**核心问题：放宽会不会削弱安全？**

现在的设计隐含假设："不认识的调用 ⇒ 可能干坏事"。但 §5.0 已列出，危险动作**各有定向检测**，不依赖这个假设。`os.path.join` 是**纯字符串函数，碰不到文件系统**。

需要诚实指出的边界案例：

```python
p = some_unknown_func()   # 未知来源
open(p)                   # 参数非静态字符串 → 仍 unknown（此逻辑保留）
```

**结论：P0 的放宽不会漏掉"未知来源的路径"** —— 只放过"未知来源但与路径无关的调用"。判定从"出现即触发"收窄到"结果流入 IO 路径参数、或本身是动态执行时才触发"。

---

## 7. 验收标准

### 7.1 探针转正为回归测试

将探针矩阵（f1–f20）固化为 `scriptPathFacts.test.ts` 的新用例，期望值：

| 片段 | 期望（P0 后） |
|---|---|
| f2 `os.path.join("/a","b")` | `complete` |
| f4 `open(os.path.join("d","events.jsonl"))` | `complete`, paths=["d/events.jsonl"]（**平台分隔符待拍板，见 §10 第 6 项**） |
| f6 `os.path.dirname` | `complete` |
| f8 `collections.Counter` | `complete` |
| f9 `json.loads` | `complete` |
| f10 `re.sub` | `complete` |
| f11 函数定义（体内无 IO） | `complete` |
| f12 类定义（体内无 IO） | `complete` |
| f14 `x += 1` | `complete` |
| f3/f5/f19 变量中转 | `complete`（依赖 P0-2） |
| f7 `os.walk(".")` | 视 P0-3 是否含 walk；含则 `complete` |
| f15/f18 字面量 | 维持 `complete` |
| **f16/f17 含变量 open / subprocess** | **维持 `unknown`**（不得回归为 complete） |

### 7.2 真实脚本

21 段历史脚本：`completeness` 应为 `complete`；**`paths` 不再全为 0**。若仍有 `unknown`，须能解释是哪一行的哪个调用。

### 7.3 不回归

- 现有 `scriptPathFacts.test.ts` 全部用例（含"任何动态文件路径、别名调用或进程执行都 unknown"）保持通过；
- `scriptPathFacts.test.ts` 中 `customApi()` → unknown 等"真未知"用例仍 unknown。

### 7.4 端到端

- 复现会话场景：`run_script` 执行统计脚本**不再弹卡**（命中 `script-clean-allow-desktop`）；
- 构造 `subprocess.run` / `eval` / 变量 open 脚本：**仍弹卡**。

---

## 8. 实施顺序与回归面

```
P0-1 路径构造器折叠      ┐
P0-2 变量常量传播        ├─ 提取器改动，只影响 unknown 判定，不改危险动作检测 → 回归面小
P0-3 纯计算白名单        │  建议独立成一个"路径提取器假阳性修复"迭代
P0-4 删无条件 unknown    ┘
  ↓
P1-1 unknown 分级        ┐
P1-2 规则降 ask          ├─ 触及 defaultRules.ts，需策略评审 + 等价验收
P1-3 摘 locked           ┘
  ↓
P2 提示 / 信任 / 契约    → 体验与可运维性
```

**P0 是正解且低风险**：它只影响 `unknown` 的判定，不改变任何危险动作的检测，可以先行落地。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| P0-2 常量传播漏判 → 假阴性（危险路径被当安全） | 保守策略：仅单次静态赋值；只要出现重绑定/参数传递/函数返回值即放弃传播。新增负向用例（§7.3） |
| P0-3 白名单过宽 | 严格前缀（`os.path.*` 而非 `os.*`）；每个模块配负向用例（如 `os.remove` 必须仍 unknown） |
| P0-4 去掉无条件 unknown 后漏检 | 补"函数体内藏 IO / 进程调用"的用例，确认仍检出 |
| 规则改动影响其他 lane | P1-2 的 `ask` 规则保持 lane 限定；automation 仍走其 locked 规则集 |
| 回滚 | P0 全部在提取器内部，回滚即还原 `scriptPathFacts.ts` / `pythonAdapter.ts`；P1 回滚即还原 `defaultRules.ts` |

---

## 10. 待确认项

1. **`os.walk` 怎么定性？** 它是只读遍历（无 IO 副作用），但会枚举整个目录树。是否纳入 P0-3 白名单，还是保留 caution 级？（影响 f7 期望值）
2. **P0-2 的传播范围**：是否只做**单文件内的顶层赋值**，还是接受简单的顺序传播（含 if/for 内）？越宽假阳性越少、假阴性风险越高。
3. **P1-2 的 `ask` 降级是否可接受？** 在 desktop standard 档位下 `ask` 会被档位变换为 `auto-evaluator`（进审核 Agent）。这意味着"clean + 未建模路径"的脚本会**由审核 Agent 裁决**，而非真人逐次点。这是相对现状的**行为变化**，需安全拍板。
4. **P2-2 脚本指纹信任的范围**：会话级还是持久级？持久级是否等同于把 `locked` 绕过？
5. **五道 fail-closed 闸门是否分级？** 现状「语法错误 / `IrCoverageError` / 解析服务未就绪 / 遍历抛出」**统一落 `emptyUnknown()`**，下游无法区分「脚本有语法错误」与「脚本用了未建模 API」。若要支持 P1-1 的双标志，需先定：哪些闸门归 `dynamic-execution`、哪些归 `unmodeled-call`、解析器未就绪是否应单独一类（`infra-unavailable`，与脚本内容无关）。
6. **`os.path.join` 的折叠结果按哪个平台的分隔符？** `foldStringIr` 是纯静态函数、不知目标平台，而 `os.path.join` 的分隔符依运行平台（posix `/`、nt `\`）。三种选法各有代价：① 按当前运行平台（`process.platform`）——但在 Windows 上分析、Linux 执行时不准；② 统一用 `/`——与 Windows 实际不符，但路径分区探测（`probeWritePathFact`）通常能归一化；③ 同时产出两种形态——最稳但可能使 `paths` 出现重复项。**建议 ②+③ 折中：用 `/` 折叠并把 `\` 变体一并交给探测。** 此项影响 f4 期望值，需拍板。

---

## 附录 A：`scriptPathFacts.ts` 模块讲解

> 给评审者的自足背景——不必自己去拼 `toolCallGate` → `extractors` → `policyEngine` 这条链。

### A.1 一句话定位

它是 `run_script` 的**事实提取器**：把一段待执行脚本静态分析成一句可判定的话——

> 「这段脚本会碰哪些文件路径；如果碰不到全部，是因为我分析不出来。」

它**不做判定**（不决定放行/拒绝），只产出事实；判定由策略引擎负责。这是整个确认框架的分层纪律。

### A.2 在安全体系中的位置

#### 完整数据流

```
模型发出 run_script(code, language)
        │
        ▼
┌─────────────────────────────────────────────────┐
│ electron/confirmation/toolCallGate.ts  run_script 分支 │  门控层：把「调用」变成「事实」
│   ① parsePythonModule(code)        ← 恰好 1 次 parse   │
│   ② extractScriptPathFacts(...)   ◀── 本模块           │
│   ③ extractScriptSignals(...)     内容安全分析          │
│   ④ probeWritePathFact(paths…)    路径分区探测          │
│   ⑤ 组装 ContentFacts.signals                          │
└─────────────────────────────────────────────────┘
        │  ContentFacts { toolName, actionClass, baseRiskLevel, signals, summary }
        ▼
┌─────────────────────────────────────────────────┐
│ src/shared/policy/policyEngine.ts  decide()      │  策略层：把「事实」变成「决策」
│   signalTokenSet(facts)  ← 信号 → token 集合      │
│   第1步 locked confirm-every-time 短路            │
│   第2步 缓存 / 第4步 自动审批器 / 第6步 默认表      │
└─────────────────────────────────────────────────┘
        │  Decision: auto-allow | require-confirm | deny
        ▼
   确认卡（真人）/ 审核 Agent / 直接执行
        │
        ▼
   .agent/logs/SecurityAudit-*.log   ← 审计
```

#### 在提取器家族里的位置

`electron/confirmation/extractors/` 下是一组平行提取器，各管一类事实：

| 提取器 | 产出信号 | 谁用 |
|---|---|---|
| `commandSequenceExtractor` | `command-sequence` | `run_shell` |
| `scriptAnalysisExtractor` | `script-analysis` / `script-network` / `script-uncertified` | `run_script` |
| **`scriptPathFacts.ts`** | **`script-path-extraction`** + 派生 `path-target` | **`run_script`** |
| `browserDomainExtractor` | `browser-action` / `network-egress` | `browser` |
| `mcpPayloadExtractor` | `mcp-tool` / `mcp-invocation` | MCP 调用 |
| `readPathFacts` / `writePathFacts` | `path-target` | 读/写文件工具 |

#### 两条路径不对等（重要）

`runExtractors.ts`（descriptor 驱动的通用编排）的 `EXTRACTOR_IMPLEMENTATIONS` 里注册了 `'script-analysis'`，**但没有注册路径提取**：

```ts
const EXTRACTOR_IMPLEMENTATIONS: Record<string, ...> = {
  'command-sequence': ...,
  'script-analysis': (input, env) => { ... extractScriptSignals(code, env) ... },  // ← 只有内容安全
  'browser-domain': ...,
  ...
}
```

也就是说：**路径提取不在通用编排里**，它是 `toolCallGate` 的 `run_script` **专用分支**直接调用的。通用编排负责内容安全信号，专用分支额外挂上路径信号。

这解释了为什么 `scriptPathFacts.test.ts` 是直接单测它、而非走 descriptor 契约。

### A.3 它起什么作用

#### 输出：三个字段

```ts
export type ScriptPathFacts = {
  paths: string[]                       // 静态提取到的文件路径
  completeness: 'complete' | 'unknown'  // 能否穷尽脚本的全部文件访问
  dynamicAccess: boolean                // 是否存在动态访问面
}
```

#### 两条事实链，各自有出口

**链 A：`paths` → 路径分区**

提取到的每个路径交给 `probeWritePathFact()` 探测，产出一条 `path-target`（带 `zone`：`workdir-normal` / `outside-workdir` / `sensitive-file` / `system-dir`）。

> 注意：这里用的是 **write** 探针——脚本的**读路径也按写入语义分区**（`toolCallGate.ts` 传的是 `probeWritePathFact`）。

`zone` 再被两条规则消费：

```ts
{ id: 'script-sensitive-path-confirm', signals: ['path-target:sensitive-file'],
  action: 'confirm-every-time', locked: true, reason: '脚本涉及敏感位置，需真人确认' }
{ id: 'script-system-dir-confirm', signals: ['path-target:system-dir'],
  action: 'confirm-every-time', locked: true, reason: '脚本涉及系统目录，需真人确认' }
```

**链 B：`completeness` → 判定是否「信息不足」**

`completeness: 'unknown'` 变成信号，进而成 token：

```ts
// policyEngine.signalTokenSet
case 'script-path-extraction':
  tokens.add(signal.kind)                                     // 'script-path-extraction'
  tokens.add(`script-path-extraction:${signal.completeness}`)  // ':unknown' / ':complete'
  if (signal.dynamicAccess) tokens.add('script-dynamic-access')
  break
```

然后被这条规则一票拦截：

```ts
{ id: 'script-path-unknown-confirm',
  match: { lane: ['desktop','wechat','feishu'], toolName: 'run_script',
           signals: ['script-path-extraction:unknown'] },
  action: 'confirm-every-time', locked: true }
```

**`locked: true`** 是最重的一档——引擎在第 1 步就短路，**先于缓存查询**，任何套餐/档位/信任列表都覆盖不了：

```ts
// policyEngine.decide() 第 1 步之后
const confirmEveryTime = invocationRules.find(
  (r) => r.locked && r.action === 'confirm-every-time' && ruleMatchesInvocation(...)
)
if (confirmEveryTime) {
  // 决策 3：始终人工逐次确认（不因 lane 落 agent）
  return requireConfirm(confirmEveryTime, ..., 'user')
}
```

另有一条 automation 侧的对称规则：

```ts
{ id: 'automation-script-path-unknown-deny', lane: ['automation'],
  action: 'deny', locked: true, reason: '无人值守调用无法确认脚本访问路径' }
```

#### 一处语义偏移（与 §3.5 呼应）

模块自身的约定写得很清楚（`extractScriptPathFacts` 的 JSDoc）：

> 基于与脚本安全分析相同 Python 语法树 IR 提取文件路径；**未知或间接效果一律 fail-closed**。

所以 `unknown` 的原意是「**我的分析结果不可信，请人类看一眼**」——**能力声明**，不是**危险声明**。

但策略层把它当成了危险声明，赋予了与「确定踩敏感路径」同级的 `locked` 强制力。

**两个已核实的旁证**：

1. `script-dynamic-access` 这个 token 虽然被产出，**但 `defaultRules.ts` 全文没有任何规则消费它**（grep 仅命中 `script-network` / `script-path-extraction:unknown` / `script-uncertified`）——即「动态执行」与「未建模调用」目前在策略层**没有区分度**；
2. 同理，`completeness: 'complete'` 会产出 `script-path-extraction:complete` token，也无任何规则匹配——属"可产出但未消费"的事实。

### A.4 内部实现

#### 入口：语言分派

```ts
export function extractScriptPathFacts(
  code: string, language: ScriptPathLanguage = 'python', preParsedIr?: IrModule
): ScriptPathFacts {
  if (language === 'javascript' || language === 'typescript') return extractTypeScriptPathFacts(code, language)
  if (language === 'powershell') return extractPowerShellPathFacts(code)
  if (language !== 'python') return emptyUnknown()          // 未接入语言 → 直接 unknown
  ...
}
```

`emptyUnknown()` 是全模块的 **fail-closed 出口**：

```ts
function emptyUnknown(): ScriptPathFacts {
  return { paths: [], completeness: 'unknown', dynamicAccess: true }
}
```

入口处**没有 `bash`** 等语言，一律落到 `emptyUnknown()`。

#### Python 路径：五道 fail-closed 闸门

```ts
let ir = preParsedIr
if (!ir) {
  try { ir = parsePythonModule(code) } catch { return emptyUnknown() }   // 闸① 语法错误 / IrCoverageError
}
if (!scriptParserService.getStatus().ready) return emptyUnknown()        // 闸② 解析器未就绪
const paths = new Set<string>()
const state = { unknown: false }
try { walkStatements(ir.body, newScope(), paths, state) }
catch { return emptyUnknown() }                                          // 闸③ 遍历抛出
return { paths: [...paths], completeness: state.unknown ? 'unknown' : 'complete', dynamicAccess: state.unknown }
```

加上两条隐含闸门：**闸④** `IrCoverageError`（适配器遇到未建模语法构造，见 A.4.3）、**闸⑤** 解析服务未初始化。

**关键**：`扫描失败` 与 `扫到但看不懂` 走**同一个出口**——最终都表现为 `unknown`，下游无法区分「脚本有语法错误」和「脚本用了 `json.loads`」。

#### 上游依赖：tree-sitter → IR

```
tree-sitter-python CST
   │  pythonAdapter.ts（按 pythonNodeClassification 四分类穷尽映射）
   ▼
IrModule { body: IrStmt[] }        // scriptIr/types.ts
```

`scriptIr/types.ts` 开头明确了这条纪律：

> 2. 每个节点种类在适配器遍历时必须落入四分类之一（已建模 / 可忽略叶子 / 结构性穿透 / 抛 `IrCoverageError`），禁止静默丢弃（§3 不变量 7）；
> 3. 「语法能解析」≠「已建模」——未建模构造由适配器抛错落人工（fail-closed）。

所以本模块拿到的 IR 是**已经保证过覆盖性**的——凡是能走到 `walkStatements` 的，都是适配器认识的构造。

#### 核心：两个递归遍历函数

**`walkStatements`** — 维护 import 作用域 + 逐语句：

```ts
function walkStatements(stmts, inherited, paths, state) {
  const scope = { modules: new Map(inherited.modules), attrs: new Map(inherited.attrs) }
  for (const stmt of stmts) {
    if (stmt.kind === 'import' || stmt.kind === 'from_import') { bindImport(scope, stmt); continue }
    switch (stmt.kind) {
      case 'assign':
        stmt.targets.forEach((name) => {
          if (scope.modules.has(name) || scope.attrs.has(name)) state.unknown = true  // 重绑定 import 名
        })
        walkExpr(stmt.value, scope, paths, state)
        break
      case 'aug_assign':  state.unknown = true; walkExpr(stmt.value, ...); break
      case 'expr':        walkExpr(stmt.value, scope, paths, state); break
      case 'if'/'for'/'while'/'with'/'try': walkExpr(test…); walkStatements(body, scope, ...); …
      case 'function_def': state.unknown = true; …walkStatements(stmt.body, scope, …); break
      case 'class_def':    state.unknown = true; …walkStatements(stmt.body, scope, …); break
      case 'delete':       stmt.targets.forEach(() => { state.unknown = true; … }); break
      case 'global_nonlocal': state.unknown = true; break
      …
    }
  }
}
```

**scope 的两个 map**（定义在 `pythonAdapter.ts`）：

- `modules`：`import os` → `os → "os"`；`import numpy as np` → `np → "numpy"`
- `attrs`：`from os import remove as rm` → `rm → { module:"os", attr:"remove" }`

这是别名的来源；`bindImport` 只处理 `import` / `from_import` 两种语句。

**关键局限**：`aug_assign`、`function_def`、`class_def`、`delete`、`global_nonlocal` 是**无条件**设 `unknown` 的，与这些语句实际做了什么无关。而且 **`assign` 不记录常量值**——`p = "x"` 之后 `p` 在分析器眼里仍是「未知名字」，**没有常量传播**。

**`walkExpr`** — 递归表达式，只对 `call` 做判定：

```ts
function walkExpr(expr, scope, paths, state) {
  if (expr.kind === 'call') {
    const chain = resolveIrChain(expr.callee, scope).fullName     // 解析全名（含别名）
    if (chain && PROCESS_CALLS.has(chain)) state.unknown = true    // 进程 / 动态执行

    // 形态1：Path(x).read_text() —— 链式方法
    const isPathMethod = receiverConstructor && ['open','read_text',…].includes(pathMethod)
    if (isPathMethod) { 取 receiver.args[0] 静态值 → paths.add / 否则 unknown; }

    // 形态2：白名单文件调用 open / os.remove / shutil.copy …
    else if (chain && FILE_CALLS.has(chain)) {
      const count = (rename/copy/move 类 ? 2 : 1)
      if (args 数量不足 或 前 count 个有任一非静态) state.unknown = true
      for (arg of args.slice(0, count)) { 静态 → paths.add }
      for (kw of kwargs) if (['file','path','src','dst','source','destination'].includes(kw.name)) { … }
    }

    // 形态3：Path(...) 构造器本身
    const isPathConstructor = chain === 'Path' || chain?.endsWith('.Path')

    // ★ catch-all —— 假阳性的主来源
    if (!(chain && (FILE_CALLS.has(chain) || PROCESS_CALLS.has(chain) || KNOWN_NON_IO_CALLS.has(chain)))
        && !isPathMethod && !isPathConstructor) state.unknown = true

    walkExpr(expr.callee, …); expr.args.forEach(walkExpr); expr.kwargs.forEach(kw => walkExpr(kw.value))
    return
  }
  switch (expr.kind) { /* attr/binop/unaryop/compare/… 纯结构性递归 */ }
}
```

**三个名单就是全部语义知识**：

| 名单 | 条数 | 命中行为 |
|---|---|---|
| `FILE_CALLS` | 18 | 取实参当路径；实参非静态 → unknown |
| `PROCESS_CALLS` | 17 | → unknown |
| **`KNOWN_NON_IO_CALLS`** | **24** | **显式不设 unknown**（安全侧白名单） |
| catch-all | — | 都不在 → **unknown** |

`resolveIrChain` 负责把 `os.path.join`、`sp.join`（别名）、`Path`（from-import 后）解析成**规范全名**（`{ root, module, attrs, fullName }`），这是名单能匹配上的前提。

#### 字符串折叠：能力边界

路径必须能**静态求值**才能进 `paths`。折叠函数只有四条规则（`pythonAdapter.ts:922`）：

```ts
export function foldStringIr(expr: IrExpr): string | null {
  if (expr.kind === 'string') return expr.value
  if (expr.kind === 'binop' && expr.op === '+') {           // "a" + "b"
    const left = foldStringIr(expr.left), right = foldStringIr(expr.right)
    if (left !== null && right !== null) return left + right
  }
  if (expr.kind === 'tuple' && expr.elts.length === 1) return foldStringIr(expr.elts[0]!)  // (x,)
  if (expr.kind === 'f_string' && expr.interpolations.length === 0) return expr.staticParts.join('')
  return null
}
```

**不含任何函数调用**——`os.path.join` 不在折叠规则里，所以「路径构造器」这一族（`join`/`dirname`/`basename`/`splitext`、`PurePath /`）**全部无法求值**。这与 A.4.4 的 catch-all 叠加，是假阳性的两个来源。

#### JS/TS 与 PowerShell：同构设计

**JS/TS**（用 typescript compiler，非 tree-sitter）：`parseDiagnostics > 0` → `emptyUnknown()`。危险侧是 `child_process` / `worker_threads`；`fs` / `fs/promises` 的调用名必须在 `JS_FILE_APIS`(35 个) 内，否则 unknown；其余任何调用不在 `JS_SAFE_CALLS`(6 个) 内 → unknown。函数声明 / 类 / 箭头函数 / `import =` → unknown。

**PowerShell**：先跑 `extractPowershellCommandFacts`，`unresolved` 或 `substitutions` 非空 → unknown；`start-process` / `iex` / `Invoke-Expression` / `&` → unknown；文件 cmdlet（`PS_FILE_APIS` 10 个）取 `-LiteralPath` / `-Path` 等参数值（含 `$` `(` `{` 即 unknown）；其余不在 `PS_SAFE_CALLS`(12 个) → unknown。

**三种语言同构**：危险名单 + 安全白名单 + catch-all → unknown。

#### 消费侧：`paths` 如何变成 `path-target`

回到 `toolCallGate.ts` 的 `run_script` 分支：

```ts
signals.push({ kind: 'script-path-extraction', completeness: scriptPaths.completeness, dynamicAccess: scriptPaths.dynamicAccess })
for (const rawPath of scriptPaths.paths) {
  try {
    const pathFact = await probeWritePathFact({ rawPath, workDir, userDataDir, homeDir, customSensitivePrefixes })
    signals.push({ kind: 'path-target', path: pathFact.normalizedPath, zone: pathFact.zone })
  } catch {
    signals.push({ kind: 'extraction-failed', reason: 'script-path-probe-failed' })
    signals.push({ kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true })  // 再落一次 unknown
  }
}
```

**注意探测失败会再补一个 `unknown` 信号**——所以 `paths` 一旦探测失败，即便前面算出了 `complete`，也会被推翻。

另外有个刻意的约束（`scriptParseCount.test.ts`）：**整条门控路径只 parse 一次**，`preParsedIr` 向下透传给 `extractScriptPathFacts` 与 `extractScriptSignals`，避免重复解析大脚本。

### A.5 归纳：这个模块的设计特征

| 维度 | 做法 |
|---|---|
| 定位 | 只产事实，不判定 |
| 输入 | 脚本源码 + 语言（Python 可复用预解析 IR） |
| 上游 | tree-sitter → IR（有穷尽性保证的四分类适配） |
| 语义来源 | 三份**硬编码名单**（语法树本身答不了"这个调用危不危险"） |
| 求值能力 | 仅字面量 / `+` / 单元素 tuple / 全静态 f-string / import 别名解析 |
| 判定极性 | **未命中白名单即 `unknown`**（安全侧穷举） |
| 兜底 | 五道 fail-closed 闸门，统一出口 `emptyUnknown()` |
| 输出 | `paths`（→ path-target zone）+ `completeness`（→ locked 确认） |
| 与策略的接口 | 信号 → `signalTokenSet` → `script-path-extraction:unknown` / `script-dynamic-access`（后者无人消费） |

一句话概括它的内在张力：

> **它建在 tree-sitter 之上，却把「语法可解析」当成了「语义可知」**——用一份不可穷举的**安全侧**名单去回答"这个调用危不危险"，于是"我没建模"直接等价于"结果不可信"，再被策略层升格为不可绕过的强制确认。

这正是本方案 §5.0 的收敛点：**枚举危险侧（有界）而非安全侧（无界）**，把 `unknown` 的粒度从「脚本级」降到「sink 实参级」，并摘掉 `locked`。

---

## 附录 B：证据索引

| 证据 | 位置 |
|---|---|
| 本会话审批事件全量 | `.agent/logs/SecurityAudit-20260929.log`（按 `sessionId=a7981827-...` 过滤） |
| 会话事件流（316,884 条） | `sessions/a7981827-5a20-4eab-a6fd-a2971e12659c-20260929/events.jsonl` |
| 生产规则 | `src/shared/policy/defaultRules.ts`（`script-path-unknown-confirm` 等六条脚本规则） |
| 策略引擎 | `src/shared/policy/policyEngine.ts`（`decide()` 第 1 步 locked confirm-every-time 短路） |
| 信号 token 化 | `src/shared/policy/policyEngine.ts` `signalTokenSet()` |
| 提取器 | `electron/confirmation/extractors/scriptPathFacts.ts` |
| 提取器家族 / 通用编排 | `electron/confirmation/extractors/runExtractors.ts`（`EXTRACTOR_IMPLEMENTATIONS` 无路径提取） |
| IR 类型与覆盖纪律 | `electron/shell/scriptIr/types.ts`（`IrCoverageError`、四分类约束） |
| 字符串折叠 / 链解析 | `electron/shell/scriptIr/pythonAdapter.ts`（`foldStringIr:922`、`resolveIrChain:942`） |
| 单次解析约束 | `electron/confirmation/extractors/scriptParseCount.test.ts` |
| 门控装配 | `electron/confirmation/toolCallGate.ts:466–494`（`run_script` 专用分支） |
| 已删除的临时探针 | `electron/confirmation/extractors/zz-probe.test.ts`（调查用，已删） |

> **证据边界**：本文中 §2 的探针输出为**用户在本机终端手动执行**所得（Agent 的 `run_shell` 多次被安全审批拒绝）；判定逻辑的代码级解释由 Agent 给出。§1 的审计数据来自落盘日志，可直接复核。

---

## 11. 修订记录

### 11.1 v2 阻断项（B1 / B2）

| 编号 | 原稿问题 | 处置 |
|---|---|---|
| **B1** | P1-2 的 `signals: ['script-analysis:clean']` 是**死代码**（token 不存在）；且摘 `locked` 后会被默认表首条 `script-clean-allow-desktop` 抢先放行 → **静默 auto-allow，比现状更糟** | §5 P1-2 已改：token → 裸 `clean`；新增**两条实施硬要求**（token 正确性 + 必须前置；并注明 `script-clean-allow-desktop` 属规范条目，排位变更需走规范评审） |
| **B2** | `dynamicAccess` 与 `completeness` 共用 `state.unknown`，故 `script-dynamic-access` 无法区分两类 unknown → P1-1/P1-2 自相矛盾、松绑不会发生 | §5 P1-1 已加**前置条件**：必须拆双标志，并列明**必须同步修改的 6 处**（含 `toolCallGate.ts` 补发信号的分类） |

### 11.2 v2 非阻断项（N1–N5）

| 编号 | 原稿问题 | 处置 |
|---|---|---|
| N1 | P0-4 diff 用 `stmt.targets.forEach`，但 IR 里 `aug_assign` 是**单数** `target: string`（`types.ts`），按原文无法编译 | §5 P0-4 diff 已改为 `stmt.target`，并加注释说明与 `assign` 的复数形式不同 |
| N2 | `FILE_CALLS` / `PROCESS_CALLS` 计数写反（实际 18 / 17） | §3.1 与附录 A.4.4 两处均已更正 |
| N3 | P0-2 的失效点只提了 `assign`，漏掉其他写入路径 | §5 P0-2 约束已补：`aug_assign` / `for` 与 comprehension 目标 / `del` / `with ... as`，并加负向示例 |
| N4 | f4 期望值与平台分隔符表述不一致 | §7.1 表已加平台注，§10 新增第 6 项专述三种选法与建议 |
| N5 | 五道 fail-closed 闸门未分级 | §10 新增第 5 项，作为 P1-1 双标志的定案前置 |

### 11.3 v3 阻断项与非阻断项

**B3（阻断）** —— B1 的同失效类在**远程 lane 的第二个实例**：

| 项 | 说明 |
|---|---|
| 原稿问题 | v2 的落位要求只写「排在 `script-clean-allow-desktop` 之前」，漏掉了更靠前的 `script-clean-certified-remote`（lane `['wechat','feishu']`、`signals:['clean']`、`action:'ask'`、带 `askUnless:{ config:'remoteScriptRequiresConfirm', equals:false, andMigrationComplete:true }`）。按 v2 字面落位，远程 lane 上「clean + 已认证 + 路径未建模」的脚本会先命中它；当 `remoteScriptRequiresConfirm=false` 且迁移完成时 `askUnlessHolds()` 成立（`policyEngine.ts:239–246`）→ ask 降为 allow → **静默放行**，而现状该类脚本是 locked 逐次确认 |
| 处置 | §5 P1-2 已改：硬要求由「两条」扩为「**三条**」。② 改为「必须排在**所有**匹配裸 `clean` token 的 `run_script` 条目之前」，并以表格列明这两条及其危险点；③ 新增建议落位「紧随 `script-network-ask-desktop` 之后」；diff 中的 `match` 已**显式写出 lane 数组** `['desktop','wechat','feishu']` 并加注释 |

| 编号 | 原稿问题 | 处置 |
|---|---|---|
| N6 | P0-2 失效点写「`del`」，但未说明 IR 里 `delete.targets` 是 `IrExpr[]`（**表达式**），不能直接当名字用 | §5 P0-2 已补：移除环境前需先从 `IrExpr` 提取 name（`{kind:'name', id}` → `id`），非 name 形态忽略 |
| N7 | comprehension 目标失效未讨论 | §5 P0-2 已注明：该失效属**无害的过度保守**（其内部赋值本就不可静态追），照常移除即可 |
| N8 | P1-1 未说明 `:unknown` token 的去留，而 `automation-script-path-unknown-deny` 依赖它 | §5 P1-1 的 B2 前置条件已增补**第 7 点**：`:unknown` 必须对两类**继续产出**（只增分类 token，不得替换），否则 automation 的「路径未知即拒绝」会退化为「交审批 Agent 裁决」，属安全倒退 |

### 11.4 未改动

- 诊断部分（§1–§4）经评审核实**全部准确**，未改；
- 附录 A（模块讲解）、附录 B（证据索引）除计数更正外未改；
- **未改动任何生产代码**（`scriptPathFacts.ts` / `pythonAdapter.ts` / `defaultRules.ts` / `policyEngine.ts` / `toolCallGate.ts` 均未触碰）。

### 11.5 放行状态

- 评审结论：**P0 维持放行**（v2 评审已核验 P0 及 N1–N5 修正）；
- **P1 仍待复审**：需 B1 / B2 / B3 落实并复核；
- 当前状态：**待复审（v3）**。

---

## 12. 实施记录（2026-09-30）

- 分支 / worktree：`fix/script-path-extraction-fp` @ `.worktrees/script-path-extraction-fp`
- 提交：`2af615d8`（P0）→ `b6c83c25`（P1）→ `df55acd0`（P2），每阶段 TDD（先红后绿）独立提交
- 验收：定向测试全程红绿驱动；收尾全量 `npm test` 761 文件 / 5990 用例通过；
  `typecheck:renderer` / `typecheck:shared` / `i18n:check` / `build:electron:incremental` / `npm run build` 通过

### 12.1 P0 落地（提交 2af615d8）

- **P0-1**：新增模块内 `foldPathIr`（方案给出的两个扩展点之二——不改动共享的 `foldStringIr`）：
  `os.path.join / dirname / basename / splitext[01]`、`Path`/`PurePath` 构造器与 `/` 运算、
  常量环境名字查找；别名形态（`import os.path as osp` / `from os.path import join`）经
  `resolveIrChain` 归一后同样折叠，并归一 `import os.path` 产生的 `os.path.path.*` 链。
- **P0-2**：`walkStatements` 维护 `consts / pure / handles / defs` 四环境。失效点全量覆盖
  （N3/N6/N7）：`assign`（含元组解包）、`aug_assign`（IR 丢失运算符，一律失效）、
  `for` 与 comprehension 目标、`del`（从 `IrExpr` 提取 name，非 name 形态忽略）、`with-as`。
  实施细化（§10-2 拍板保守）：**分支 / 循环 / try / with 体内的赋值只失效不绑定**（分支可能不执行，
  绑定值不确定）；**循环体两遍扫描**——第一遍收集首轮静态路径，第二遍在体内写入已失效的环境上重扫，
  使 loop-carried 重绑定（`for` 内 `p = "/b"` 后次轮 `open(p)`）落 unknown，防假阴性。
  常量不跨函数 / 类作用域；`defs` 登记本模块定义的函数 / 类名，调用点不再触发 catch-all（P0-4 配套）。
- **P0-3**：`KNOWN_PURE_PREFIXES` 13 族前缀白名单；`os` 只放 `os.path.*`，`pathlib` 只放
  `PurePath`。纯值接收者（`counter.update()`）与文件句柄方法（`with open(p) as f: f.read()`）
  经 `pure / handles` 集合豁免。
- **P0-4**：删除 `function_def / class_def / aug_assign` 三处无条件 unknown；函数体 /
  类体仍递归扫描（安全底线用例：体内藏 IO / 进程调用仍检出）。
- **§10-1 拍板**：`os.walk` **不入**白名单——只读但枚举整棵目录树，维持 unknown。
- **§10-6 拍板**：折叠统一用 `/`，平台变体交 `probeWritePathFact` 归一。
- 探针矩阵 f1–f20 全量转正 + 负向用例（未知来源 open、别名进程调用、分支 / 循环重绑定、
  `del`、with-as、元组解包、`p += os.environ["X"]`、函数包裹形参 open 等）。

### 12.2 P1 落地（提交 b6c83c25）

- **P1-1（B2 前置全量落实）**：单一 `state.unknown` 拆为 `dynamicExecution / unmodeledCall`
  双标志；`ScriptPathFacts` 增设 `unknownReason`；`types.ts` 信号、`toolCallGate`（主推送 +
  探测失败补发）、`signalTokenSet` 按方案列明的 6 处同步。`:unknown` token **只增不替**
  （N8），分类 token `script-path-extraction:dynamic-execution | unmodeled-call` 附加产出；
  automation deny 语义不变（双向回归用例）。
- 分类归属（方案未细化处的拍板）：
  - 动态路径（FILE_CALLS 非静态实参、`Path(变量)` 方法、kwargs 非静态）→ **dynamic-execution**
    （§7.4「变量 open 仍弹卡」的硬要求）；
  - import 名重绑定 / `del` import 名 → dynamic-execution（事实链断裂）；
  - catch-all 未建模调用、`global_nonlocal`、插值 f-string → unmodeled-call；
  - 五道 fail-closed 闸门（语法错误 / 解析器未就绪 / 遍历抛出 / 未接入语言 / 解析失败）
    → **保守归 dynamic-execution**（§10-5：与脚本内容无关的失败不松绑；`infra-unavailable`
    细分留待后续需要时再拆）；
  - JS/TS 与 PowerShell 未拆双标志，unknown 保守归 dynamic-execution（行为与现状一致）。
- **P1-2（B1/B3 硬要求全量落实）**：`script-path-unknown-confirm` 一拆为二——
  `script-dynamic-execution-confirm`（locked，消费 `script-dynamic-access`）+ 
  `script-unmodeled-path-ask`（非 locked，signals 裸 `clean` + `:unknown`，denyClass 已标注）。
  落位：先于 `script-clean-certified-remote` / `script-clean-allow-desktop`（硬要求②，
  B3 回归用例覆盖远程 `remoteScriptRequiresConfirm=false` 场景）；**置于 locked 的
  `script-uncertified-ask-remote` 之后**——比方案建议位（紧随 `script-network-ask-desktop`）
  更严：远程未认证保护（locked）优先于本条非 locked ask，防止自定义套餐覆写本条后截胡。
- **P1 边界补强（方案遗漏）**：suspicious 内容 + unknown 路径的组合，旧规则曾无差别兜住；
  松绑后为避免其漏到默认兜底，新增 `script-suspicious-path-unknown-confirm`
  （locked confirm-every-time）——**松绑仅限 clean**。
- **P1-3**：能力缺口类（unmodeled-call）摘掉 locked，可被档位 / 信任覆盖（standard 档
  ask → 审批 Agent，§10-3 行为变化按方案落地并写明注释）。
- **记忆收敛**：unknown 脚本的缓存 / 档位资格调整——路径键只覆盖已静态提取的路径，
  缓存命中会连未建模路径一起放行；最终形态见 §12.3 P2-2（unmodeled → 会话级 exact-content，
  dynamic → 禁用）。

### 12.3 P2 落地（提交 df55acd0）

- **P2-1**：提取器收集 unknown 证据（调用名 + 分类，去重、封顶 8 条防爆炸）；门控构建
  `scriptPathHint` 文案（`CONFIRMATION_LABELS` 集中管理），同时追加进确认摘要（IM 侧
  `factsSummary` 可见）与确认卡（`ScriptConfirmCard` 新增提示行）。数据通道镜像
  `shellSecurityHints` 的全部 9 个触点（ToolCallRecord / FactEvent / turnDisplayProtocol /
  pendingConfirmStore / resolveMessageToolsInteractive / ToolCallCard memo 等）。
  行号未回显——IR 适配器不携带位置信息，按方案「行号 / 调用名」二选一取调用名。
- **P2-2（§10-4 拍板：会话级）**：门控计算脚本内容 sha256 指纹 → 信号携带 `contentDigest` →
  `deriveCacheKeys` 派生会话级 `{ kind: 'script-content', digest, sessionId }` 缓存键
  （仅 unmodeled-call；dynamic-execution 走 locked 确认，constraints 已阻断缓存读取，不派生）。
  **路径键在 unknown 时整体抑制**——防不同脚本经重叠静态路径命中缓存而放行未知路径。
  `memoryEligibility`：unmodeled → session-only（`script-path-unknown-session-only`），
  dynamic → none。设置页「确认记忆管理」新增展示分支（i18n zh-CN / en-US，摘要展示指纹前 12 位）。
  持久级不提供——持久脚本指纹信任等效于把 unknown 判定长期固化，超出本方案边界。
- **P2-3**：`parseScriptPathDeclaration` 识别首部 `# @path-scope workdir-readonly`
  （容忍 shebang / coding 注解行，首个声明 scope 未识别即视为未声明）；门控交叉验证
  （`dynamicAccess=false` + 无 script-network + 分析 clean + 提取路径 zone 全为 workdir-normal）
  产 `script-path-declaration` 信号；放行规则 `script-declared-path-scope-allow-desktop`
  以 `configRequires: { allowDeclaredPathScopeScripts, equals: true }` **默认关闭**——
  声明是作者断言（不可信输入），开启即接受「声明即授权」信任模型；未开启时回落 unmodeled ask。

### 12.4 与方案的偏差清单

| # | 偏差 | 理由 |
|---|---|---|
| 1 | P1-2 落位改在 `script-uncertified-ask-remote` 之后 | 方案建议位会让非 locked ask 先于 locked 未认证保护命中，自定义套餐覆写即绕过远程未认证确认 |
| 2 | 新增 `script-suspicious-path-unknown-confirm`（locked） | 旧 `script-path-unknown-confirm` 曾无差别兜住 suspicious+unknown；仅按 clean 松绑后该组合会漏到默认兜底，需保持强处置 |
| 3 | unknown 脚本记忆资格由「全禁」收敛为「unmodeled 会话级」 | P2-2 需要 exact-content 会话信任；路径键整体抑制 + dynamic 禁用保持安全面不变 |
| 4 | P2-3 放行规则默认关闭（config 门控） | 声明是不可信输入，未经交叉验证 + 显式开启不得放行 |
| 5 | `Path` 实例经常量中转后调方法（`p = Path("/a")/"b"; p.read_text()`）可静态提取 | P0-1 语义的自然延伸（超报方向，安全） |

### 12.5 验收对照（§7）

- §7.1 探针矩阵：全量转正（P0 describe 27 用例），期望值按 §10 拍板调整（f7 维持 unknown、f4 统一 `/`）；
- §7.3 不回归：原 11 用例全部保持通过（含 customApi 真 unknown、语法错误 fail-closed、
  动态 / 别名 / 进程 unknown）；全部 toEqual 断言随类型演进补齐新字段；
- §7.2 真实脚本：21 段历史脚本位于会话 `events.jsonl`（userData），单测环境不可复现；
  以 f19（典型会话写法：join + json + Counter + with-open-as）等价覆盖，判 complete 且
  paths 提取正确；残留 unknown 场景（形参 open 等）均有用例并归类可解释；
- §7.4 端到端：见 §12.6。

### 12.6 遗留验收项（需真机 / 真实会话）

1. **端到端弹卡验证**：复现会话场景验证 `run_script` 统计脚本不再弹卡（命中
   `script-clean-allow-desktop`）、`subprocess` / `eval` / 变量 open 仍弹卡——策略层已有
   等价单测（`policyEngine.test.ts` P1/P2 describe），但真实应用 + 真实 LLM 调用的
   全链路（门控 → 引擎 → 确认卡 UI）需在真机跑一轮；
2. **审计日志抽查**：新规则 `script-dynamic-execution-confirm` / `script-unmodeled-path-ask`
   的 `policy.decision` 事件与 ruleOrigin 标注；
3. **P2-2 会话信任体验**：确认卡「记住 · 本会话此脚本」档位在真实确认流中的呈现与命中；
4. **P2-3 开关**：`allowDeclaredPathScopeScripts` 目前无设置 UI 入口（config 门控默认关闭），
   如需对外开放需补设置页开关与文案。

### 12.7 评审修复记录（2026-09-30 第二轮）

评审报告：`docs/review/script-path-extraction-fp-review.md`（3 阻断 + 9 非阻断，均动态复现）。
三个阻断项全部为**确认门完全绕过**级（判 complete 不弹卡），且 49 个既有用例全部 miss——
缺失的正是负向对抗用例，修复按评审给出的 3 组定向测试先行转红再修。

| 项 | 根因 | 修复 | 测试 |
|---|---|---|---|
| B1 | `invalidateName` 不清理 `defs`——def 名被 `=` / `for` 目标 / 分支内重绑定为 `os.system` 后调用走 `isLocalDefCall` 豁免 | `invalidateName` 补 `defs.delete`；且 def 名被重绑定视为事实链断裂，与 import 重绑定同级置 `dynamic-execution`（评审"更稳妥"建议） | B1a–d 四变体（含 with-as）+ 未重绑定对照 |
| B2 | 适配层把元组目标拼成 `"p,q"` 文本，`isSimpleName` 不过 → `for p, q in items` 后 `open(p)` 用旧常量判 complete | `invalidateName` 按逗号切分逐名失效（下标/属性片段仍非简单名自然跳过） | B2a（for）/ B2b（comprehension） |
| B3 | `import os.path` 无 alias 时绑 `os → os.path`，`os.system` 被解析成 `os.path.system` 命中纯白名单 | `bindImport` 无 alias 绑 `root→root`（Python 真实语义：`import x.y` 绑根名）；别名形态不变 | B3a（os.system）/ B3b（os.popen、os.remove 变量）/ 折叠对照（`os.path.join` 不受影响） |

非阻断项处置：

- **N1**（global 改写场景降级 unmodeled、卡片路径展示误导）：`global_nonlocal` 恢复基线强度归
  `dynamic-execution`（函数体 env 看不到外层 consts，影响面无法精确判定 → locked、禁记忆）；
- **N2**（上限保护未落实）：补三项——`CONST_ENV_CAP=256`（常量环境条目）、
  `FOLD_DEPTH_CAP=32`（折叠递归深度，超限返回 null 保守不折叠）、
  `DOUBLE_SCAN_DEPTH_CAP=4`（循环双扫嵌套层数，超限只扫一遍并保守置 unmodeled）；
- **N3**（with-as 重绑定 def 名）：随 B1 的 `invalidateName` 统一覆盖；
- **N4/N5**（记忆资格防御）：unknown 分支的 dynamic 判定改为「`unknownReason !== 'unmodeled-call'`
  或同 facts 含 extraction-failed」——`unknownReason: null` 与探测失败组合一律 fail-closed 禁记忆；
  `signalTokenSet` 对 unknown 无分类的组合强制产 `script-dynamic-access`（落 locked，不落 ask）；
- **N6**（gate 侧零覆盖）：补门控级断言——`scriptPathHint` 含调用名、信号携带 64 位
  `contentDigest`、`script-path-declaration` 信号与 consistent 值；
- **N7**（hint fallback 文案硬编码 + 注释失实）：文案入 `CONFIRMATION_LABELS`，注释更正；
- **N8**（声明交叉验证漏 extraction-failed）：`consistent` 增加探测失败排除；
- **N9**（`allowDeclaredPathScopeScripts` 死开关）：维持默认关闭方向（安全），启用前需补
  AppConfig 字段与设置 UI——已列 §12.6-4，本项不改代码。

修复后验证：评审 3 组定向测试 + N 系列防御用例转绿（提取器 62 用例）；相关 8 套件
313 用例通过；全量 `npm test` 与 `typecheck` 复验通过（见提交记录）。
