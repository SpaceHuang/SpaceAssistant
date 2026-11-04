# 脚本安全判定 finding 化技术方案

> **定位**：`docs/develop/safety-approval/`（安全、确认与审批）主题下的技术方案。目标是把脚本内容安全分析的产出，从"一个动作词"改成"一条条可核验的事实发现"。
> **核对基线**：分支 `codex/test-system-optimization-plan`，commit `02969077`（2026-10-30 读取 `.git/refs/heads/`）。文中所有代码断言均在此时点核对，每条附复现命令。
> **读者标记**：`【人必读】`第 0 层只看这一层即可裁决；`【人机共读】`第 1 层是评审包；`【机｜人工可跳过】`第 2 层与附录是规格与证据。
> **关联**：三阶段职责边界见 [`security-policy-three-stage-architecture-contract.md`](../security-policy-three-stage-architecture-contract.md)；事实契约见 [`security-policy-tool-facts-contract.md`](../security-policy-tool-facts-contract.md)。
> **并行在途**：同目录 [`script-certifier-shape-expansion-and-capability-declaration-improvement-plan.md`](./script-certifier-shape-expansion-and-capability-declaration-improvement-plan.md)（远程认证扩容 + 能力声明 + 检测盲区补齐）与本方案**改同一批文件**——这是变更冲突、需要定先后，**不是功能依赖**（本方案不调用它的任何产出）。**定序已决：本方案先行**，该计划落地时 rebase（见附录 E-1）。

---

## 第 0 层　决策层【人必读】

### 一句话

脚本安全分析现在只回答"这段脚本危险不危险"，然后由策略规则据此拦截或询问；改完之后它回答"这段脚本第几行做了什么、证据是什么"，拦不拦、问不问仍由策略规则决定，但每一个发现都能被另一个 agent 独立复核。

### 只有 3 分钟：先读这几项

1. 下面「需要你决定的事项」里的 D-1 ~ D-4（每条自带背景与后果，不需要翻其他章节）。
2. 「不需要你决定」一节，确认没有把该你拍的事塞给机器。
3. 末尾「自曝三处弱点」，这是我认为最可能被推翻的地方。

### 需要你决定的事项

#### D-1｜确认卡面上要不要逐条列出风险发现

**背景**：当 agent 要执行一段脚本时，桌面会弹确认卡片。现在卡片上的脚本风险信息只有一句话——"脚本含需确认的危险模式"，用户看不到是哪一行、什么写法、为什么算风险。要让他判断，必须把发现逐条列出来（第几行、那段代码、属于哪类构造）。

**要决定什么**：
- A：维持现状，卡片只显示一句总述；
- B：逐条列出（本方案主张），每条一行：行号 + 代码片段 + 发现类型名。

**各自的后果**：
- 选 A：用户和审批 agent 都拿不到可核对的依据，只能凭"系统说有风险"决定；本次的分析侧改造将没有展示出口。
- 选 B：用户每次会多看到几行信息，因此默认只显示前 3 条、其余折叠为"另有 N 条"并可手动展开（上限只在展示层，不影响分析结果全量）。

**可逆性**：可逆。展示层独立，回退只需撤掉该分区。

**依据强度**：卡片当前只显示一句总述，已核对；但"逐条展示是否增加用户负担"没有实测数据。

**决议**：**B**（2026-10-30 批准）。默认最多显示 3 条，第 4 条起折叠为"另有 N 条"，点击展开后显示全部；条数不超过 3 时不出现展开控件；展开状态不记忆（每张确认卡片独立）。

**界面归属卡**（已按上述决议更新）：见附录 B。

#### D-2｜「路径算不出来」怎么处置 —— 不属本方案决策（已归策略层）

**为什么写在这里**：首版把它列为决策项是错的。它问的是"要不要人确认"，那是策略层的取值，不是分析侧能决定的事。

**背景**：脚本要写文件时，系统会尝试从代码里折算出目标路径。路径来自变量、拼接字符串或函数返回值时算不出来。现状代码把"算不出来"与"明确写了绝对路径"合并成同一条命中——于是一个事实层的缺陷（分不清两种情况），被表现成两个看起来像产品取舍的选项。

**本方案只做一件事**：让分析侧能说出"这条是绝对路径"还是"这条算不出来"（两种不同的路径形态，见第 2 层）。算出哪一种属于观测；算出之后怎么办属于策略。

**处置归策略层，但有一条既有约束必须先说清**：这类写入（目标来自变量、拼接或返回值）通常同时被**路径事实**判为"动态执行"，而现有条目 `script-dynamic-execution-confirm` 是逐次真人确认的**底线条目**；底线条目不参与档位变换（判定为 locked、deny 或逐次确认的条目一律不变换）。因此在当前实现下：

- 桌面：**仍是真人逐次确认**，不会自动转交安全审核 agent；
- 远程：真人确认；
- 定时任务：拒绝。

上一版文档写"桌面标准档会自动交审核 agent"——这是错的，已在评审中被指出（B2），此处撤回。把"算不出来"从拒绝改为询问，只改变"命中哪条规则"，**不改变"由人确认"这一结果**。

**要让审核 agent 评估这类写入，需要什么**：必须先能区分"路径未知的写入"与真正的动态执行（`eval`、进程调用、`exec` 等），再单独调整前者的底线条目范围并写清 policy trace。这属于策略层的一次独立变更，见 D-5。

**结论**：本条不需要你现在决定；本轮维持"真人确认"，不改变现有安全 floor。

#### D-3｜分析结果里新增的"逐条发现"，读取方要跟着确认

**背景**：脚本分析的结果会被三类使用方读取：确认卡片、审批 agent 的提示材料、以及策略规则。这次要在结果里新增"逐条发现"（位置、代码片段、证据），属于对外数据形状的变更，凡读它的地方都要跟着确认。

**要决定什么**：
- A：批准新增（以"可选、可缺省"的方式加入，旧读取方不受影响）；
- B：不批准，则本方案无法落地（分析结果里没有承载位置与证据的字段）。

**各自的后果**：
- 选 A：读取方需要核对一遍是否要展示新字段；不做修改的一方仍能工作。
- 选 B：维持现状，问题保留。

**可逆性**：可逆（字段可空，回退即不填）。

**依据强度**：新增字段为可选，已核对现有读取方不会因缺字段失败。

**决议**：**A**（2026-10-30 批准）。新增字段一律**可选、可缺省**，不改变任何既有字段的含义。

**批准后的读取方核对清单**（每处只需回答"是否要读新字段"）：

| 读取方 | 何时核对 | 预期 |
|---|---|---|
| 策略引擎的信号匹配（`signalTokenSet`） | 阶段 2 | 新增类别 token 派生 |
| 记忆资格判定（`memoryEligibility`） | 阶段 2 | 把"是否干净"从读三档改为读发现集合与覆盖度 |
| 确认卡片（阶段 1b） | 阶段 1b | 读发现列表渲染，默认 3 条 + 展开 |
| 审批方的提示材料（线索包 → 审核模型材料） | 阶段 1c | **列为明确交付**（评审 B5）：见「契约卡：审批侧脚本证据」，不得再留"实现时定位" |
| 审计写入 | 按 D-4 决议 | 决定是否落原文片段 |
| 无人读取的原始分析回传字段 | 阶段 3 | 删除 |

#### D-4｜审计里记不记脚本代码（结论 B：记投影骨架，不记原文）

**背景**：每条发现要能复核。审计是独立文件、保留 180 天、可导出，比会话更适合承担"事后回溯"。

**先分清两个场景**：

- **当场审核**（这段脚本要不要执行）：审核方看的是本次调用的事实包，**不看审计文件**。审计存不存原文，对这一侧没有影响。
- **事后取证 / 回溯审计**：复核方读审计文件。存了原文就自足，不存就要回会话里翻。

**要决定什么**：
- A：审计只记发现类型、位置、摘要，不含原文；
- B：审计记**命中的那一行**，以结构投影存储（见决议）——可读骨架、无字面量。

**修正后的风险评估**（首版把它写重了，此处更正）：

- 审计是**本地文件**，不外发就不出机器。用户复制给别人是用户自己的选择，与"导出会话记录"同性质，不是系统新开的口子。
- **脚本不是密钥**。它是用户自己写的自动化代码；即便含内部路径或字段名，也属用户自己的资产，不构成凭证泄漏。
- 写入前仍过既有两套脱敏，凭证形态会被抹掉。
- 真实成本只有两个：审计文件体积略增；导出分享时会连代码一起带出——可接受，不需要为此设开关或加提示。
- 回退成本也可接受：审计是追加写的 JSON Lines，回退即不再写该字段，已写的历史行随 180 天保留期自然过期。

**决议**：**B**（2026-10-30 批准；2026-11-04 按评审 B3/B4 收紧为投影形态），三条：

1. 只记**命中的那一行**，且以**结构投影**存储（字面量→占位、注释→占位，只留骨架），不落整份脚本、不留任何字面量；
2. 投影器放共享层，写入前仍过既有脱敏作为第二道防线——但**不得以"已脱敏"替代投影**（现脱敏覆盖不到嵌套结构与代码内凭证）；
3. 同行记 `snippetSha256`（原始片段的内容摘要，在投影与截断之前计算）与 `contentDigest`（整份脚本）；定位键是（检测编号, 位置）。

上一轮已确定的定位引用（会话、轮次）一并保留：它们让这批记录可定位、可聚合，成本几乎为零。

**这条对当场审核仍然零影响**：审核方读事实包，不读审计；本决策只影响事后回溯的便利度。

**不采纳的**：不加"详细审计"开关（开关要人批且增加组合面，收益撑不起一个开关）；不在导出时弹提示（导出是用户主动行为，知情由审计说明承担）。

#### D-5｜是否允许安全审核 agent 评估"路径未知的写入"（待批，独立决策）

**背景**：现在所有"目标在运行时才确定"的动作都走同一条逐次真人确认条目，且该条目不参与档位变换。要让审核 agent 接手，必须先能区分两类动作：

- **路径未知的写入**（`open(name, 'w')`、`Path(name).write_text(...)`）——目标不可静态求值，但动作类型明确是写文件；
- **真正的动态执行**（`eval`、`exec`、`compile`、进程创建）——可以执行任意代码，风险量级不同。

**要决定什么**：
- A（本方案维持）：两类都保留真人逐次确认，不做区分；
- B：新增可区分的子类，仅"路径未知的写入"交审核 agent，动态执行仍逐次真人确认。

**各自的后果**：
- A：零行为变化；代价是这类脚本每次都打断人，审核 agent 拿不到判断机会。
- B：减少打断；代价是四件事都要做——① 路径事实里增加子类，② 拆分现有底线条目，③ 补 policy trace 与等价验证，④ 接受"审核 agent 只能读代码意图、无法证明运行时路径"。

**可逆性**：B 由条目动作承载，可回退；但其等价验证必须与本方案的其余对拍分列。

**依据强度**：`isTransformExempt` 与逐次确认条目的 locked 语义为代码事实（见附录 A 的 F-22、F-23）；"审核 agent 判断质量"无实测数据。

**决议**：**B**（2026-11-04 批准）。仅"路径未知的写入"交审核 agent 评估；`eval`、`exec`、`compile`、进程创建、动态导入仍逐次真人确认。

**落地设计（四件事）**：

**① 事实层分类模型（覆盖旧标记的全部生产点，评审 R2 修正）**。现状 `dynamicExecution` 是一个大桶，`FILE_CALLS` 里既有 `open`（读与写）、也有 `os.remove`/`unlink`/`rmdir`/`shutil.rmtree`（删除）、`os.rename`/`replace`/`shutil.copy`/`move`（搬运），另有多处绑定链断裂与解析失败也会置位。按原方案"文件类调用统一归新子类"会把读取与删除一起拉进新审核域，超出 D-5 的获批范围。

**承载字段**：`ScriptPathFacts` 新增 `dynamicKinds: ScriptPathDynamicKind[]`（可多值、可同时存在）；`unknownReason` 保留原取值以兼容既有消费方。

| 旧生产点（代码位置） | 新分类 | 属"获批写入域" | 行为 |
|---|---|---|---|
| `PROCESS_CALLS` 命中 | `dynamic-code-execution` | 否 | 逐次真人 |
| `open(...)` 参数非静态，mode 为**写** | `unresolved-write-target` | **是** | 新审核域 |
| `open(...)` 参数非静态，mode 为读或缺省 | `unresolved-read-target` | 否 | 逐次真人 |
| `Path.write_text` / `write_bytes` 的值不可解析 | `unresolved-write-target` | **是** | 新审核域 |
| `Path.read_text` / `read_bytes` 的值不可解析 | `unresolved-read-target` | 否 | 逐次真人 |
| `Path.open` 的值不可解析 | 按 mode 判读 / 写 | 视 mode | 同上 |
| `os.remove` / `unlink` / `rmdir` / `shutil.rmtree` 参数非静态 | `unresolved-destructive-target` | 否 | 逐次真人 |
| `os.rename` / `replace` / `shutil.copy` / `copy2` / `move` 参数非静态 | `unresolved-transfer-target` | 否 | 逐次真人 |
| 绑定链断裂（导入/属性重绑定、赋值重绑定、删除绑定、walrus 重绑定、非模块作用域 `global`/`nonlocal`） | `binding-chain-broken` | 否 | 逐次真人 |
| 解析失败 / 服务未就绪 / 非 Python 语言 / 遍历抛错（`emptyUnknown` 的各调用点） | `path-analysis-unavailable` | 否 | 逐次真人 |
| 置了 `dynamicExecution` 但未映射到上述任一（旧形状、缺字段） | **保守归入 `path-analysis-unavailable`** | 否 | 逐次真人 |

**语义判定要点**：

- `open` 必须按 mode 区分（第二位置参数或 `mode` 关键字，缺省视为读）；写模式沿用内容分析既有定义（含 `w`/`a`/`x`/`+`）。
- 双目标操作（`copy`/`move`/`rename`/`replace`）**不进入**写入审核域——它们同时涉及删除或搬运，超出 D-5 的获批范围。
- 读取、删除、搬运一律**保留原有人工 floor**，不因本次改造改变。

**② 聚合与规则（用"排除式"而非"选中式"，避免漏分类导致 floor 丢失）**：

| token | 派生条件 |
|---|---|
| `script-path-extraction:<kind>` | 每个 `dynamicKinds` 元素各一个 |
| `script-path-extraction:dynamic-execution` | `dynamicKinds` 非空（兼容旧规则） |
| `script-path-extraction:write-target-only` | **当且仅当** `dynamicKinds` 只含 `unresolved-write-target` |
| `script-dynamic-access` | 现有语义不变 |

| 规则 ID | 匹配 | 动作 |
|---|---|---|
| `script-path-unknown-confirm`（既有，改匹配） | `script-dynamic-access`，**排除** `write-target-only` | 逐次真人确认（锁定） |
| `script-dynamic-execution-confirm`（既有，改匹配） | `script-path-extraction:dynamic-execution`，**排除** `write-target-only` | 逐次真人确认（锁定） |
| `script-unresolved-write-review`（新增） | `script-path-extraction:write-target-only` | 桌面标准档：`auto-evaluator`（快通道未裁决交审核 agent）；桌面 strict / custom：询问（人）；远程：询问（人）；定时任务：拒绝 |

**为什么用排除式**：只有"纯写入目标未知"才会产生 `write-target-only`；任何其他原因（读取、删除、搬运、绑定断裂、不可用、可执行代码）都不会产生该 token，因此继续命中两条旧锁定条目、保留原 floor。缺分类或缺字段的旧形状落在"保守归入不可用"，同样不会放开。

**③ policy trace 与等价验证**。新条目带稳定 ID 与 reason；等价对拍按下列矩阵逐格断言（不与本方案的类别等价对拍混在一起）：

| 组合 | 现状 | 目标 |
|---|---|---|
| 仅路径未知**写入** + 桌面标准档 | 逐次真人 | 交审核 agent（快通道未裁决时） |
| 仅路径未知写入 + 桌面 strict / custom | 逐次真人 | 逐次真人（不变） |
| 仅路径未知写入 + 微信 / 飞书 | 逐次真人 | 询问（不变） |
| 仅路径未知写入 + 定时任务 | 拒绝 | 拒绝（不变） |
| 路径未知**读取**（`open(name,'r')`、`Path(name).read_text()`） | 逐次真人 | 逐次真人（**不得变**） |
| 路径未知**删除/搬运**（`os.remove(name)`、`shutil.move(a,b)`） | 逐次真人 | 逐次真人（**不得变**） |
| 绑定链断裂 / 解析失败 / 非 Python | 逐次真人 | 逐次真人（**不得变**，缺省保守） |
| 含 `eval` / 进程 / 动态导入（无论是否同时有写入） | 逐次真人 | 逐次真人（**不得放宽**） |
| 路径已知 | 原行为 | 原行为 |

**④ 明确能力边界**。审核 agent 无法证明运行时路径；它的结论只能是"这段代码的路径来源看起来是否可信"。因此：agent 批准仅对当次调用生效，**不得写入长期记忆**（记忆资格为 `none`），也不得据此放宽同一脚本的后续调用；若材料不足以支撑判断，落人工而非默认批准（见「审批侧脚本证据」的 `undetermined`）。

**不采纳的**：不在本轮把 `eval` / 进程类交给审核 agent（评审明确要求不得泛化解除）；不为该子类新增用户开关。

### 不需要你决定（Agent 负责）

- 事实核查：现状是否真如本方案所述（附录 A 每条附复现命令）。
- 位置信息怎么从语法树带下来（适配器改造方案，见 INV-8）。
- 12 类构造类别的定义与现有检测项的逐一映射（第 2 层）。
- 分类 → 动作的映射表内容，以及它与现状"三条结论"的等价性验证设计。
- 验收用例、golden 对拍、反向测试、契约快照维护。
- 阶段拆分与每阶段回退实体。

### 待批准清单（RP-6）

- **已定**：构造类别命名（不给高中低分级）、检测编号保留作稳定 ID、路径形态（相对 / 绝对 / 含上级目录 / 算不出）留在分析侧、证据不带核验建议。
- **已批**：D-1 = B（逐条展示，默认最多 3 条 + 可展开；界面归属卡见附录 B）；D-3 = A（发现字段以可选、可缺省方式新增，读取方核对清单见 D-3）。
- **已归策略层，不由本方案拍板**：D-2（"算不出路径"的处置。分析侧只说明两种路径形态；处置由策略表决定。**注意**：按 D-5，"仅路径未知的写入"在桌面标准档交审核 agent；含 `eval`/进程类仍逐次真人确认）。
- **待批**：无。D-1 = B、D-3 = A、D-4 = B（结构投影 + 内容摘要）、D-5 = B（拆子类，仅路径未知写入交审核 agent）。
- **不在本轮评审范围**：非 Python 语言的内容分析接入、路径敏感区划的模块归属、审批 agent 的提示词改造。

### 自曝三处弱点

1. **"等价"不可能是全等**。现状把"算不出路径"与"明确越界"合并成同一条命中；改造后前者从拒绝改为询问（策略层取值），这是一处**有意的行为变更**，等价对拍必须把它单列，否则会被误判成回归。推翻条件：golden 样本上出现无法用这处变更解释的差异。
2. **位置信息可能漏挂**。语法树的转换点很多（含结构性穿透节点），漏一处就出现"有发现、无位置"。若实现选择容错（允许无位置继续），"每条发现都必须带位置"这条要求就被削弱。推翻条件：golden 样本产出无位置的发现。
3. **"全量"与"展示上限"容易混**。原则要求分析结果原样交出、不预先删减，但卡片必须有上限；若实现把上限写进分析侧，等于分析侧替审批方做了取舍。推翻条件：代码评审在分析侧发现截断逻辑。

---

## 第 1 层　概要层【人机共读】

### RP-2 链路图

现状与目标只差"中间一层的产出形状"：

```
现状
agent 要执行脚本
  └─> 工具调用关卡（采集事实、交策略裁决）
        ├─> 脚本内容分析 ──> 一个结论词（干净/可疑/危险）
        ├─> 脚本路径事实 ──> 路径列表 + 路径区划
        └─> 事实汇总 ──> 策略引擎裁决（允许 / 询问 / 拒绝）
                          └─> 审批方（人 或 审批 agent）
                          └─> 执行器（执行前比对摘要）

目标（只改第 2 行）
agent 要执行脚本
  └─> 工具调用关卡（采集事实、交策略裁决）           ← 复用
        ├─> 脚本内容分析 ──> 逐条发现（编号/类别/位置/代码/证据）＋ 覆盖度
        ├─> 脚本路径事实 ──> 路径列表 + 路径区划      ← 复用不改
        └─> 事实汇总 ──> 策略引擎裁决                 ← 复用
                          └─> 审批方（凭逐条发现自行核验）
                          └─> 执行器                  ← 复用不改
```

三个必须看得出来：新产出插在"内容分析"与"事实汇总"之间；策略引擎仍是动作的唯一出口；唯一新增的写入方只有内容分析这一处（它产出发现），其余单元不改写这组数据。

### RP-3 变更面表

| 单元 | 作用简述 | 改动类型 | 对应 | 跨边界 |
|---|---|---|---|---|
| `electron/shell/scriptContentSecurity.ts` | 脚本内容分析：产出命中项 | 改承重边界 | INV-1~4、AC-1~3 | 否 |
| `electron/shell/scriptIr/types.ts` | 脚本事实中间表示的类型定义 | 改承重边界 | INV-8 | 否 |
| `electron/shell/scriptIr/pythonAdapter.ts` | 语法树转中间表示 | 改造 | INV-8、AC-1 | 否 |
| `electron/confirmation/extractors/scriptAnalysisExtractor.ts` | 脚本事实提取（关卡依赖） | 改承重边界 | INV-1、INV-5 | 否 |
| `electron/confirmation/toolCallGate.ts` | 工具调用关卡：拦调用、采事实、交策略（permit 依赖它） | 改承重边界 | INV-7 | 否 |
| `electron/confirmation/extractors/scriptPathFacts.ts` | 脚本路径事实提取（路径与动态执行分类） | 改造 | D-5、AC-17 | 否 |
| `src/shared/confirmation/types.ts` | 确认与事实的共享类型（两端依赖它） | 改对外契约 | INV-1、INV-4 | 是 |
| `src/shared/policy/defaultRules.ts` | 默认策略规则表（引擎依赖它） | 改对外契约 | INV-6 | 是 |
| `src/shared/policy/scriptClassDisposition.ts` | 构造类别到动作的映射表（新建） | 新建 | INV-6 | 是 |
| `src/shared/policy/policyEngine.ts` | 策略裁决唯一出口 | 改造 | INV-6 | 否 |
| `src/shared/policy/memoryEligibility.ts` | 记忆资格判定 | 改造 | INV-5 | 否 |
| `electron/confirmation/securityAuditLog.ts` | 安全审计写入与脱敏（独立文件、180 天） | 改造 | INV-9、AC-14 | 否 |
| `electron/confirmation/agentChannel.ts` | 审批线索包组装（审核材料由此进模型） | 改造 | AC-16 | 否 |
| `electron/confirmation/approvalAgent.ts` | 审核材料渲染（审批方输入） | 改造 | AC-16 | 否 |
| `src/shared/confirmation/scriptSnippetProjection.ts` | 脚本片段结构投影器（审计与审核材料共用） | 新建 | INV-9、AC-14 | 是 |
| `src/shared/policy/policyPackages.ts` | 链路档位与动作变换 | 复用不改 | — | 否 |
| 确认卡片组件（`src/renderer/components/Chat/`，具体文件在阶段 1b 定位） | 展示脚本风险分区：默认 3 条、可展开 | 改造 | D-1、AC-10 | 是 |

**复用不改的依据**：档位变换表只按规则 id 映射动作，本次不改映射机制本身（新增条目沿用同一套 id 匹配）；路径事实原计划复用，但 D-5 需要在其中拆出"路径未知写入"与"动态代码执行"两个子原因，故列为改造。

### RP-4 契约面六面

| # | 契约面 | 结论 | 依据 / 门禁 |
|---|---|---|---|
| ① | agent-sdk 接口契约 | **不改** | 发现数据只在宿主内部消费；审批记录的回答者与状态取值不变，不新增枚举。门禁：`npm run check:agent-sdk`、`npm run typecheck:agent-sdk`（实现时附结果） |
| ② | 会话存储接口契约 | **不改** | 发现数据不落库，无新表、无新字段、无写入方变化；`runInTransaction` 约束不涉及。门禁：`npm run check:session-storage-boundary`（实现时附结果） |
| ③ | 进程间通道（IPC / 预加载） | **改**（D-1 已批准） | 确认请求载荷新增发现列表与总数。载荷带**全量**发现，默认只渲染前 3 条、展开在渲染层完成，因此**不新增第二条通道**；单条代码片段沿用既有限长。同步点：预加载脚本的类型声明与渲染侧确认组件 |
| ④ | 共享类型（`src/shared/`） | **改** | 事实信号新增可选字段与发现类型；审批线索包新增 `scriptEvidence`；新增片段投影器；记忆资格判定改读新字段。门禁：`npm run typecheck:shared` |
| ⑤ | 其他持久化格式与迁移 | **不改** | 无数据库 schema 变更、无设置项、无快照格式变更 |
| ⑥ | 领域数据格式 | **改** | 新增一类信号 token 命名空间与若干规则 id；`defaultRules.contract.test.ts` 的规则基线快照需同步，`defaultRules.lint.test.ts` 需为新条目补类别约束 |

### RP-5 量级与拆分判断

- 改既有单元 **14** 个，新建 **2** 个，复用不改 **1** 个。
- `改对外契约` **5** 行（共享类型、默认规则表、新建映射表、确认请求载荷、审计记录格式）；`改承重边界` **4** 处。
- 新增持久化字段 **0**，新增错误码 / 稳定失败分类 **0**，新增 IPC 通道 **0**，阶段 **5** 个（1a 事实产出 / 1b 确认卡片 / 1c 审核材料 / 2 语义矫正 / 3 收口）。
- **拆分判断：不拆**。按门槛（`改对外契约` ≥2 行）应拆分或给论证。依据：五处契约变更共用同一份《发现》结构与同一个片段投影器——共享类型先定形状，映射表与规则按类别读取，确认请求载荷与审核材料读同一份证据，审计读同一投影器；拆成两份会导致同一结构或同一投影实现两处漂移。且本次无持久化、无迁移、无新通道，每阶段可独立回退，风险不因合并而放大。

### 排除方案

- **排除"给风险分高/中/低"**：分级需要上下文（同一条删除操作，删临时文件与删系统文件危害不同），而内容分析刻意不看上下文；分级只能在有上下文的地方产生，因此归策略域。分级放在事实侧，等于把主观判断伪装成观测。
- **排除"每个检测项各自成一条策略规则"**：检测项有二十余条，逐条规则会让规则表膨胀一倍，且"哪些检测项属于同一类构造"仍需一张类别表。本方案先把类别定下来，规则按类别匹配。
- **排除"在分析侧决定'路径算不出来'该怎么办"**：这是策略取值，不是观测。分析侧一旦包含这类判断，等于把策略表的一行藏进代码——无法配置、无法审计，也无法按链路区分（远程没有自动审批档位、定时任务无人可确认）。
- **排除"内容分析与路径事实合并成一个模块"**：路径区划依赖工作目录、用户目录、敏感前缀等上下文，合并会把上下文依赖引入内容分析，破坏"内容分析只需代码文本"这一性质。

---

## 第 2 层　规格层【机｜人工可跳过】

### 术语（一名一义）

| 词 | 含义 | 不要与它混用 |
|---|---|---|
| 发现（finding） | 一次具体命中的完整证据：检测编号、构造类别、位置、代码片段、结构化证据 | 不要用"命中项"指代整体结论 |
| 检测编号 | 稳定 ID（如 A7），用于测试与文档引用，**不含任何严重度含义** | 不要当作类别使用 |
| 构造类别 | 12 类之一（如"文件写入"），描述代码做了什么，不描述后果 | 不要当作动作使用 |
| 覆盖度 | 分析完成到什么程度：完成 / 部分 / 失败 | 不要与"发现条数"混为一谈 |
| 动作 | 允许 / 询问 / 拒绝，只由策略域产出 | 不要出现在事实侧任何字段名或取值中 |

### INV-1｜事实侧不得表达动作或建议（字段白名单）

事实侧产出的结构体，其字段只能属于三类：**观测**（编号、类别、位置、片段、证据）、**覆盖度**、**认证结论**。禁止动作词与指向性字段。

机械守卫：对发现结构与脚本事实信号做递归键名检查，命中下列模式即测试失败：

```
hint|suggest|recommend|remediat|mitigat|fix|advice|should|priority|precedence|benign|acceptable|ignore|severity|risk
```

注意末两项：本方案**不产出** `risk` / `severity` 字段（分级归策略域）。

### INV-2｜位置缺失即整次分析失败（不得静默丢单条）

每条发现必须有 `range`（1-based 行列）与 `snippet`。若任一检测点无法取得位置，**不得丢弃该条继续**——那会把风险静默吞掉——而是把整次分析判为 `coverage=failed`，产出提取失败事实（原因：位置缺失），并按下面的兜底规则处理。

**兜底规则（稳定 ID 与优先级，评审 R1 修正）**：

评审用真实引擎验证：`default-extraction-failed` 位于 `applyDefault()`，只有普通规则、缓存、自动评估都未返回时才执行——因此它**不是优先兜底**。实测 `extraction-failed + script-network` 会命中 `script-network-ask-desktop` 并交审核 agent。所以不能靠"加一个失败信号"保证恒落人工。

本方案改为**专用锁定条目**，利用引擎既有的 `humanFloor` 分支（`confirm-every-time` 或 `humanRequired` 的询问在 deny 之后、自动评估与缓存之前直接返回，回答者为用户）：

| 场景 | 规则 ID | 匹配 | 动作 |
|---|---|---|---|
| 桌面 / 微信 / 飞书 | `script-analysis-incomplete-confirm`（新增，locked） | `toolName: run_script` + `extraction-failed` | `confirm-every-time`（回答者=人） |
| 定时任务 | `script-analysis-incomplete-automation-deny`（新增，locked） | `toolName: run_script` + `extraction-failed` | 拒绝 |

**优先级声明**：拒绝类规则仍先于人工确认（"脚本含明确危险行为"这类 deny 不被失败规则覆盖）；人工确认先于自动评估与旧缓存；因此失败时**不存在**"快通道或记忆越过人工"的路径。

**失败时保留哪些观测**：该次内容分析产出的**发现列表与全部派生 token 一律作废**（不得参与 allow / 自动评估）；其他独立提取器的事实（路径区划、语言未认证、IM 网络候选等）保留，仅用于让人看到信息，不构成放行依据。

**不得用路径事实的 unknown 代替内容覆盖度**：两者是独立观测，路径侧完整时也可能完全没有兜底信号。上述规则只消费 `extraction-failed`。

### INV-3｜逐条而非累计

去重键为（检测编号, `range`）。同一检测编号在不同位置各产一条。现状按编号合并的实现（`addHit` 内 `mergeVerdict`）必须去掉。

### INV-4｜一条构造至少一个类别；跨类产出多条

`class` 为单值；若一次构造同时属于多个类别（如动态导入网络模块），产出多条发现，共享同一 `range`，各自独立可核验。

### INV-5｜覆盖度与发现正交

`coverage=failed` 时不得声称"未发现问题"；`coverage=partial` 必须能说出缺的是哪一段（现有未建模构造抛错即为 partial 的来源）。记忆资格判定与展示文案都读这一维，而不是读"发现条数是否为 0"。

### INV-6｜动作唯一出口在策略域

脚本相关的动作只能由 `src/shared/policy/` 的规则产出。事实侧现有三处直接表达动作的实现必须清除：按链路直接给动作的网络判定、认证未通过时的"允许→询问"改写、把解析失败当作一个结论档位。

**推论（本方案最容易越界的一处）**：任何"要不要人确认 / 要不要交给安全审核 agent"的取舍，分析侧都不得以任何形式表达——包括"建议动作""严重度""是否值得审核"这类间接字段。分析侧只负责把差异说清楚（例如"算不出来"与"绝对路径"是两种形态），差异怎么处置由策略表决定。

### INV-7｜事实侧不裁剪

事实侧产出全部发现；若传输或展示需要上限，由消费方实施，并保留总数与"是否被截断"的标记。事实侧出现任何 `slice` / 上限判断即违规。

### INV-8｜位置信息不得在转换中被丢弃

语法树每个节点自带位置，中间表示必须逐节点保留；结构性穿透节点在递归时必须把位置传下去。禁止"仅危险节点才有位置"的局部挂载（会导致父容器内调用无法回溯位置）。

### INV-9｜审计与审核材料中的脚本片段，必须经过"结构投影"，不能只靠脱敏

评审 B3 指出两处不成立：① 审计脱敏只遍历事件**顶层**白名单字段且只处理字符串，把 `findings` 加入白名单不会遍历到嵌套的片段；② 即便遍历，代码字符串里的凭证不是"键名 + 凭证值"形态——`requests.get(url, auth=('user', 'plain-password'))` 里的密码不会被任何现有替换抹掉。

因此本方案不采用"脱敏后照抄原文"，改为**结构投影**：

| 原文成分 | 投影结果 |
|---|---|
| 字符串字面量 | `'…'`（保留引号形态，f-string 前缀保留） |
| 数字 / 浮点 | `…` |
| 注释 | `# …` |
| 标识符、关键字、运算符、属性名、函数名、参数名 | 原样保留（骨架） |
| 超长行 | 投影后按上限截断，标 `truncated` |
| 投影失败（该行无法解析） | `[unavailable]` |

投影器放 `src/shared/`（两端共用），审计与审核材料共用同一个实现，禁止各写一份。

### 契约卡：审计脚本记录（D-4 = B，含 B3/B4 修正）

```ts
interface ScriptAuditFinding {
  pattern: string
  class: FindingClass
  range: SourceRange
  /** 结构投影后的骨架；不含任何字面量 */
  skeleton: string
  /** 原始片段（截断与投影之前）的内容摘要；定位键另由 (pattern, range) 承担 */
  snippetSha256: string
}

interface ScriptAuditRef {
  sessionId: string
  turnId: string
  contentDigest: string      // 整份脚本的摘要，与事实侧同源
  totalCount: number         // 投影前的发现总数
  truncated: boolean         // 是否超出审计条目上限
  findings: ScriptAuditFinding[]
}
```

**`snippetSha256` 的精确定义**（评审 B4：定位键与内容摘要必须分离）：

- 输入：该 `range` 覆盖的**原始片段文本**，换行统一为 `\n`，**不 trim、不截断、不投影**；
- 算法：`sha256(UTF-8(输入))`，输出小写十六进制；
- 时机：在截断与投影**之前**计算；
- 复算：从会话原文按同一 `range` 取同一段，同法计算应得同值；
- 与 `contentDigest` 的分工：前者证明"这一段没变"，后者证明"整份脚本没变"。

**定位键**：`(pattern, range)`。同一行里替换等长内容时定位键不变、`snippetSha256` 必变——这正是 B4 要求的可判定性。

约束：
- 审计只存**投影后的骨架**，不存任何字面量，也不落整份脚本；
- 写入前仍过既有脱敏（顶层白名单 + 字符串级替换），作为第二道防线；但**不得以"已过脱敏"替代投影**；
- 逐条记录，键为（检测编号, 位置），不做同类合并。

### 契约卡：审批侧脚本证据（评审 B5、R3 修正）

现状：`agentChannel` 把事实投影为 `signals: facts.signals.map((s) => s.kind)`——**只有 kind 字符串**；`ApprovalCluePack` 也没有承载发现的字段。所以"审批 agent 凭逐条发现独立复核"在现有链路上无法成立，只改确认卡片载荷兑现不了。

**评审 R3 的关键区分**：审计的骨架投影是**存储边界**（D-4），不能顺带施加到当场审核材料。`requests.get('https://approved.example')` 与 `requests.get('https://other.example')` 投影出的骨架完全相同，审核方无法判断是否符合用户指定目标；未知目标写入的 `rawPath` 本来就是 `null`，若再只给骨架，审核方没有任何依据。

| 消费者 | 内容合同 | 理由 |
|---|---|---|
| 审计（长期存储、可导出） | 结构投影骨架 + `snippetSha256` | D-4 已批：不留字面量 |
| 审核材料（当场、内存、随请求） | **原文片段**（有上限）+ **结构化证据** | 需要判断具体目标；两者用途不同，共用投影器不代表共用内容合同 |

```ts
interface ApprovalScriptEvidence {
  coverage: 'complete' | 'partial' | 'failed'
  totalCount: number
  truncated: boolean
  contentDigest: string                       // 与 scriptApprovalBinding 同源，绑定执行对象
  /** 材料是否足以支撑独立判断；undetermined 时审批链路必须落人工 */
  sufficiency: 'sufficient' | 'undetermined'
  findings: Array<{
    pattern: string
    class: FindingClass
    range: SourceRange
    /** 原文片段（长度上限与使用方预算一致）；超限时置空并保留 range 供受控回读 */
    snippet: string | null
    /** 结构化证据：模块/属性/主机/路径/路径形态/模式/argv/别名解析链 */
    evidence: ScriptFindingEvidence
    /** 该条材料是否足以判断；缺关键证据时标 insufficient */
    status: 'complete' | 'insufficient'
  }>
}
```

传递契约：

| 环节 | 变更 |
|---|---|
| 事实快照 | 已含 `findings`（D-3 可选字段）与 `coverage` |
| 线索包 `ApprovalCluePack` | 新增可选字段 `scriptEvidence?`，由 `agentChannel` 从 `script-analysis` 构造；**不得只投影 kind**，也不得把审计骨架当作审核材料 |
| 审核模型材料 | 渲染 `scriptEvidence`：逐条（编号 + 类别 + 行号 + 原文片段 + 结构化证据），附总数、截断标记、充分性 |
| 受控回读 | 片段超上限时材料给出 `range` + `contentDigest`，审批链路可**仅针对本次调用**的脚本原文按 `range` 回读；不得读取其他文件 |
| 绑定 | `contentDigest` 与既有 `scriptApprovalBinding.sha256` 取同一值，保证"审核的就是要执行的那份" |

**充分性为硬约束**：任一条 `status='insufficient'`、或材料被截断丢失必要上下文、或 `coverage != 'complete'` → 整体 `sufficiency='undetermined'`；此时审批链路**确定性地**要求人工（不由 agent 自由裁量），不得凭骨架或摘要批准。

**有界规则**：材料超预算时按（类别危害序、行号）取前 N 条，**必须**保留 `totalCount`、`truncated: true`，并把 `sufficiency` 降为 `undetermined`（丢上下文即降级）；禁止把截断后的列表呈现为完整证据。

### 契约卡：发现结构

```ts
type FindingClass =
  | 'process-creation' | 'destructive-fs' | 'dynamic-execution' | 'dynamic-import'
  | 'native-code-load' | 'network-api' | 'file-write' | 'cwd-change'
  | 'reflection' | 'alias-resolution' | 'decode-then-exec' | 'dynamic-dispatch'

interface SourceRange { startLine: number; startCol: number; endLine: number; endCol: number } // 1-based

interface ScriptFinding {
  /** 稳定检测编号，不含严重度语义 */
  pattern: string                 // 'A7' | 'B5' | ...
  class: FindingClass             // 单值；跨类产出多条
  range: SourceRange
  snippet: string                 // 有长度上限，仅在事实侧格式化时不脱敏原始代码
  evidence: ScriptFindingEvidence
}

interface ScriptAnalysisFacts {
  findings: ScriptFinding[]
  coverage: 'complete' | 'partial' | 'failed'
  coverageDetail?: string         // partial 时说明缺失来源（如未建模构造的类型名）
  certification: 'certified' | 'not-certified' | 'not-applicable'
  totalCount: number              // 与 findings.length 恒等；供消费方截断后对账
}
```

事实信号（`src/shared/confirmation/types.ts`）在现有 `script-analysis` 上新增字段，保持旧字段可用：

```ts
| { kind: 'script-analysis'
    signal: 'clean' | 'suspicious' | 'dangerous'   // 阶段 2 删除
    patterns: string[]                              // 阶段 2 改为派生 token 来源
    findings?: ScriptFinding[]                      // 新增，可选
    coverage?: 'complete' | 'partial' | 'failed'    // 新增，可选
    totalCount?: number }
```

`summary.sections` 保留但改为由展示层从 `findings` 渲染；事实侧只维护 `summary.text` 的一句话总述。

### 12 类构造类别与现有检测项映射

| 类别 | 覆盖现有检测编号 | 证据要点 |
|---|---|---|
| `process-creation` | A1（os.system/popen/spawn 族、subprocess.*、pty.*、asyncio 子进程族） | 模块名、属性名、可折叠的 argv |
| `destructive-fs` | A2（os.remove/unlink/rmdir、shutil.rmtree/move、Path.unlink） | 操作名、目标路径（含 Path.unlink 目前缺失的路径） |
| `dynamic-execution` | A3（eval/exec/compile、os.exec*） | 被执行实参或绑定名 |
| `dynamic-import` | A4、B4、B10 | 折叠出的模块名、接收绑定名 |
| `native-code-load` | A5（ctypes.CDLL/WinDLL、cffi） | 库名（可折叠时） |
| `network-api` | A6、B10 | 模块名、属性名、可静态折叠的主机名 |
| `file-write` | A7、A8 | 调用名、mode、`rawPath`、`pathClass` |
| `cwd-change` | A9（os.chdir） | 目标路径 |
| `reflection` | B1、B2、B3、B8（getattr/hasattr/vars/globals/locals、builtins.*） | 目标属性名、解析链 |
| `alias-resolution` | B5、B6、B7 | 别名 → 真实链（如 `o → os.system`） |
| `decode-then-exec` | B11 | 解码函数、绑定名、语句距离 |
| `dynamic-dispatch` | B9（下标调用、getattr 目标不可解析） | 不可解析的原因 |

### 证据形状（按类别）

```ts
type ScriptFindingEvidence =
  | { kind: 'process-create'; module: string; attr: string; argvLiteral?: string }
  | { kind: 'fs-destructive'; operation: string; rawPath: string | null; pathClass: PathClass }
  | { kind: 'dynamic-exec'; entry: 'eval' | 'exec' | 'compile' | string; boundName?: string }
  | { kind: 'dynamic-import'; moduleName: string | null; boundName?: string }
  | { kind: 'native-code'; module: 'ctypes' | 'cffi'; symbol?: string }
  | { kind: 'network'; module: string; attr: string; host?: string }
  | { kind: 'write-path'; call: string; mode: string | null; rawPath: string | null; pathClass: PathClass }
  | { kind: 'cwd-change'; rawPath: string | null; pathClass: PathClass }
  | { kind: 'reflection'; target: string; resolvedChain?: string }
  | { kind: 'alias'; alias: string; resolved: string }
  | { kind: 'decode-exec'; decodeFn: string; boundName: string; stmtDistance: number }
  | { kind: 'dynamic-dispatch'; unresolvableReason: string }
```

### 路径相关字段的归属

| 字段 | 含义 | 位置 | 依赖上下文 |
|---|---|---|---|
| `rawPath` | 代码里那段路径字符串**字面量**（静态折叠结果），折叠不出为 `null` | 事实侧（内容分析） | 否 |
| `pathClass` | 路径字符串形态：`absolute` / `dotdot` / `relative` / `unresolved` | 事实侧（内容分析） | 否 |
| 规范化绝对路径、区划（工作目录内 / 敏感位置 / 系统目录） | 目标落到哪里 | 路径事实提取（复用不改） | 是 |

`pathClass` 只描述字符串形态，**不判断是否敏感目录**。新增 `unresolved` 用以区分现状被合并的两种情况（折叠成功但越界 vs 折叠失败）。

### 决策权迁移：类别 → 动作

新建 `src/shared/policy/scriptClassDisposition.ts`，把现状散在分析器里的三档语义原样搬过来：

```ts
// 概念示意：真源在策略域，可审、可配、可被 floor 校验
const SCRIPT_CLASS_DISPOSITION: Record<FindingClass, DispositionRule[]>
```

与现状的等价对照（阶段 2 的验收基准）：

| 现状结论 | 现状来源 | 目标表达（策略域） |
|---|---|---|
| 直接拒绝 | A5 原生库加载 | `native-code-load` → 拒绝 |
| 直接拒绝 | A7 且路径为绝对 / 含 `..` | `file-write` 且 `pathClass ∈ {absolute, dotdot}` → 拒绝 |
| 询问（原为直接拒绝） | A7 且路径折叠失败 | `file-write` 且 `pathClass = unresolved` → 询问。按 D-5：**仅"纯写入目标未知"**（`write-target-only`）在桌面标准档落**安全审核 agent**，strict/custom 与远程为人确认，定时任务拒绝；**读取、删除、搬运、绑定断裂、解析不可用、`eval`/进程类一律继续逐次真人确认**，不得放宽 |
| 询问 | A1、A2、A3、A4、B 系全部 | 对应类别 → 询问 |
| 询问（远程为拒绝） | A6 网络（桌面询问 / 远程拒绝） | `network-api` → 桌面询问、远程拒绝（由现有链路规则承接） |
| 允许 | A8 相对路径写、A9 切换目录 | `file-write` 且 `relative` → 允许；`cwd-change` → 允许 |

派生 token：`policyEngine` 的 `signalTokenSet` 增加一族 `script-finding:<class>` 与 `script-finding:<class>:<pathClass>`，供规则按类别匹配；同时派生一个"本次是否存在落在询问域或拒绝域的类别"的 token，供现有复合条件规则（可疑 + 路径不完整）改写。这些 token 由策略域的分类表派生，不是事实侧的分级。

### 受影响的现有规则

以下 18 条现有规则以脚本事实为条件（复现命令见附录 A / F-11），需在阶段 2 逐条核对改写或确认沿用：

- 拒绝类 3 条：远程网络拒绝、危险拒绝、以及无人值守三条中的脚本相关拒绝；
- 无人值守拒绝 3 条：路径未知、授权缺失、语言未认证（最后一条不涉及本次改动）；
- 逐次确认 6 条：敏感位置、系统目录、路径不完整、原因未分类、动态执行、可疑且路径未知；
- 询问/放行 6 条：未建模路径询问、声明只读放行、远程未认证询问、远程干净脚本配置化、桌面干净脚本放行、桌面网络询问。

其中"可疑 + 路径未知"一条复合条件需改用派生 token；"干净/可疑/危险"三档作为匹配条件在阶段 2 全部替换为类别条件。

### 状态与所有权

| 状态 | 唯一 writer | 唯一提交点 | 恢复者 |
|---|---|---|---|
| 发现列表 | 脚本内容分析（每调用一次重新产出，无累积状态） | 事实汇总（一次调用一次快照） | 不适用（无持久化，无恢复） |
| 覆盖度 | 脚本内容分析 | 同上 | 不适用 |
| 认证结论 | 现有认证器（不变） | 同上 | 不适用 |
| 动作 | 策略引擎 | 策略引擎返回的唯一决策 | 审批结果（人工/审批 agent） |

### 失败与恢复

| 失败 | 事实侧表现 | 策略侧表现 | 禁止 |
|---|---|---|---|
| 语法解析失败 | `coverage=failed` + 提取失败事实；脚本类发现与派生 token 全部作废 | 专用锁定条目 `script-analysis-incomplete-confirm`（人）；定时任务为 `script-analysis-incomplete-automation-deny`（拒绝） | 不得产出空发现列表并呈现为"干净"；不得沿用 `default-extraction-failed` 作为唯一守卫 |
| 构造未建模 | `coverage=partial` + 缺失来源 | 现有未建模构造规则（按路径事实）兜底 | 不得静默忽略该构造 |
| 位置获取失败 | **整次判为失败**（不再"该检测点不产出发现"）：`coverage=failed` + 提取失败事实 | 同上（专用锁定条目，回答者=人） | 不得丢弃单条继续；不得无位置产出发现 |
| 二次扫描异常 | 提取失败事实 | 同上 | 不得沿用第一次结果并声称完成 |

### 阶段与迁移

| 阶段 | 输入 | 输出 | 出口证据 | 可回退实体 |
|---|---|---|---|---|
| 1a 位置与发现（不动策略） | 现有分析器与中间表示 | 中间表示逐节点带位置；产出发现（先覆盖 `file-write`、`destructive-fs`、`process-creation` 三类）；事实信号新增可选字段 | 新增单测全绿；golden 样本每条发现都有位置；旧结论与新发现并存且不冲突；单次解析门禁保持 | 事实字段可空，撤掉字段填充即回退；策略行为未变 |
| 1b 确认卡片展示（D-1 已批） | 1a 产出 + 确认请求载荷 | 载荷带全量发现与总数；卡片新增分区，默认渲染前 3 条、第 4 条起折叠为"另有 N 条"并可展开；不超过 3 条时不显示展开控件 | 渲染用例覆盖 3 条 / 4 条 / 多条三档；展开后可见条数与总数一致；展开状态不跨卡片记忆；展开控件键盘可达 | 撤掉分区与载荷字段即回退，1a 不受影响 |
| 1c 审核材料传递（评审 B5/R3，必须交付） | 1a 产出 + 线索包 | 线索包新增 `scriptEvidence`：覆盖度、总数、截断标记、内容摘要、充分性、逐条**原文片段 + 结构化证据**（不使用审计骨架）；审核材料渲染该证据；`agentChannel` 不再只投影 kind；材料不足或截断时降为 `undetermined` 并确定性要求人工 | 骨架相同但主机/路径不同的两条发现能取到差异证据；不可核验来源标 `insufficient` 并整体降级；超预算保留总数与截断标记；材料摘要与执行对象绑定一致 | 撤掉 `scriptEvidence` 与渲染即回退，1a/1b 不受影响 |
| 2 语义矫正 | 阶段 1a 产出 | 删除结论词与按链路给动作的判定；三档匹配改为类别匹配；策略域新增分类表与派生 token；改写受影响规则；**路径事实按 D-5 分类矩阵产出 `dynamicKinds` 多值**（写入 / 读取 / 删除 / 搬运 / 代码执行 / 绑定断裂 / 不可用），token 用排除式：只有"纯写入目标未知"进入新条目 `script-unresolved-write-review`（桌面标准档 `auto-evaluator`，strict/custom 与远程询问，定时任务拒绝），两条旧锁定条目改为排除该 token，读取、删除、搬运、绑定断裂、不可用继续命中旧条目 | 三条链路（桌面/微信/飞书）上，旧结论派生动作与新类别派生动作逐条相等，唯一例外是"算不出路径的写入"从拒绝改为询问并单列；**D-5 分类矩阵逐格断言**（仅纯写入 + 桌面标准档 → 审核 agent；读取/删除/搬运/绑定/不可用 → 仍真人；含 `eval`/进程类 → 仍真人；strict/custom、远程、定时任务不变）；反向测试（删掉分类规则后对应类别不再导致该动作）；契约快照与 lint 全绿 | 回退需整体 revert 该阶段提交（规则与事实同批，避免半套） |
| 3 清理与收口 | 阶段 2 | 删除无人读取的原始分析回传字段；`summary.sections` 改由展示层渲染；12 类类别与证据短语的国际化文案收口；审计按 D-4 = B 记录**投影骨架**与 `snippetSha256`（会话、轮次、总数、截断标记）；`script-dangerous-deny` 是否补底线条目按附录 E 单列的独立小决策处理 | 全量测试；`typecheck:shared`；i18n 检查；审计用例断言"只含骨架、无字面量、有 `snippetSha256`、有总数与截断标记、不落整份脚本" | 逐项独立回退 |

**迁移**：无数据库迁移、无设置项迁移、无旧数据兼容问题。规则表变更通过 `defaultRules.contract.test.ts` 的基线快照显式登记。

### 验收

| ID | 断言 | 关联 |
|---|---|---|
| AC-1 | golden 样本产出的每条发现都有 1-based 位置与代码片段 | INV-2、INV-8 |
| AC-2 | 同一检测编号在两处命中产出两条发现 | INV-3 |
| AC-3 | 发现结构与脚本事实信号的键名不含动作词与建议词 | INV-1 |
| AC-4 | 三条链路上，旧结论派生动作与新类别派生动作逐条相等，**唯一例外**是"算不出路径"从拒绝改为询问并单列 | INV-6、D-2 |
| AC-5 | 删掉某条类别规则后，该类别不再导致对应动作 | INV-6 |
| AC-6 | 解析失败时覆盖度为失败，且呈现层不显示"未发现风险" | INV-5 |
| AC-7 | 一次调用只解析一次语法树 | — |
| AC-8 | 事实侧不出现截断逻辑；截断只发生在消费方且保留总数 | INV-7 |
| AC-9 | 事实侧不出现按链路分支的动作判定 | INV-6 |
| AC-10 | 卡片默认最多显示 3 条；超过 3 条时出现展开控件，展开后显示全部；不超过 3 条时无展开控件；展开只改变渲染，不改变事实侧数据 | INV-7、D-1 |
| AC-11 | 审计只存投影骨架与 `snippetSha256`，不含任何字面量；同带会话、轮次、总数、截断标记；凭 `snippetSha256` 可校验片段一致性 | INV-9、D-4 |
| AC-12 | 故障注入使 A5/A7 等检测点拿不到位置时：`coverage=failed` + 提取失败事实；**分别与网络命中、相对路径写入、语言未认证、已有用户动作覆盖、旧 allow 记忆缓存组合**，走真实规则装配→引擎，断言最终 ruleId 与回答者均为"人"，快通道与缓存都不越过人工确认；定时任务断言拒绝；执行器在批准前不调用；路径事实 complete / unknown 各跑一轮 | INV-2 |
| AC-13 | D-5 组合矩阵逐格断言（真实提取器→规则装配→引擎）：仅路径未知写入 + 桌面 standard → 回答者为**审核 agent**（快通道未裁决时）；同场景 strict/custom 与微信/飞书 → 人；定时任务 → 拒绝；含 `eval`/进程/动态导入（无论是否同时有路径未知）→ 人；且该批准不写入记忆 | D-5、F-22 |
| AC-14 | 从完整审计事件经写入函数到最终 JSON Lines：含嵌套骨架、Python 单引号/赋值/调用参数形式的凭证、超长行、普通非敏感代码；直接断言落盘文本不含测试凭证且保留可读骨架 | INV-9 |
| AC-15 | 同 `pattern` 同 `range`、片段内容改变时 `snippetSha256` 必变；同一原始片段复算一致；截断与投影发生在摘要计算之后 | D-4 |
| AC-16 | 构造**骨架相同但实际主机/路径/执行参数不同**的发现（例如两条 `requests.get` 仅 URL 不同），断言审核材料能取到差异证据（host / rawPath / argv）；未知路径写入分别覆盖"可核验来源"与"不可核验来源"（后者该条标 `insufficient`、整体 `undetermined`）；材料超预算时保留 `totalCount` / `truncated` 并降级为 `undetermined`，审批链路**确定性**要求人工；断言实际材料内容，不只断言条数 | INV-7、B5、R3 |
| AC-17 | 分类矩阵：`open(name,'w')` → `unresolved-write-target`；`open(name,'r')`、`Path(name).read_text()` → `unresolved-read-target`；`os.remove(name)`、`shutil.rmtree(name)` → `unresolved-destructive-target`；`shutil.move(a,b)`、`os.rename(a,b)` → `unresolved-transfer-target`；`eval`/`subprocess` → `dynamic-code-execution`；绑定重绑定 → `binding-chain-broken`；解析失败 / 未就绪 / 非 Python → `path-analysis-unavailable`；缺子原因或旧形状 → 保守归入 `path-analysis-unavailable`。断言：只有**纯写入**产生 `write-target-only`；其余组合仍命中两条旧锁定条目（人工 floor 保留）；聚合 token 与 `script-dynamic-access` 照常派生；读取/删除/搬运不得被命名为 write | D-5、F-26 |

---

## 附录

### A. 事实卡

| ID | 断言 | 复现命令（基线 `02969077`） |
|---|---|---|
| F-1 | 脚本中间表示不含任何位置字段 | `rg -n "startPosition\|startIndex\|endPosition\|\brow\b\|column" electron/shell/scriptIr/` → 无命中 |
| F-2 | 命中项结构只有编号与结论两个字段 | `rg -n "interface PatternHit" -A4 electron/shell/scriptContentSecurity.ts` |
| F-3 | 命中按编号合并去重（无法表达两处同编号） | `rg -n "function addHit" -A8 electron/shell/scriptContentSecurity.ts` |
| F-4 | 网络判定按链路直接给动作 | `rg -n "function networkVerdict" -A3 electron/shell/scriptContentSecurity.ts` |
| F-5 | 分析入口返回结论词 | `rg -n "export function analyzeScriptContent" -A25 electron/shell/scriptContentSecurity.ts` |
| F-6 | 认证未通过时把允许改写为询问 | `rg -n "remote_not_certified" -A6 electron/shell/scriptContentSecurity.ts` |
| F-7 | 事实信号只带编号数组 | `rg -n "kind: 'script-analysis'" src/shared/confirmation/types.ts` |
| F-8 | 提取器把结论词翻译成三档 | `rg -n "signal = analysis.verdict" electron/confirmation/extractors/scriptAnalysisExtractor.ts` |
| F-9 | 原始分析回传字段无生产消费点 | `rg -n "rawScriptAnalysis"` → 仅定义、赋值与测试断言 |
| F-10 | 越界与折叠失败合并为同一命中 | `rg -n "addHit\(this.hits, 'A7'" electron/shell/scriptContentSecurity.ts` |
| F-11 | 销毁类命中不带路径证据 | `rg -n "lastAttr === 'unlink'" -A6 electron/shell/scriptContentSecurity.ts` |
| F-12 | 以脚本事实为条件的规则共 18 条 | `rg -c "toolName: 'run_script'" src/shared/policy/defaultRules.ts` |
| F-13 | 危险拒绝条目未标底线条目，而远程网络拒绝已标 | `rg -n "script-dangerous-deny" -A6 src/shared/policy/defaultRules.ts`；`rg -n "script-network-deny-remote" -A6` |
| F-14 | 底线校验只检查已标底线条目 | `rg -n "if \(!base.locked\) continue" src/shared/policy/policyFloor.ts` |
| F-15 | 确认摘要的分区字段在渲染侧未找到消费点 | `rg -n "summary\.sections" src/renderer` → 无命中 |
| F-16 | 已有"删掉规则后不再拒绝"的反向测试手法可复用 | `rg -n "没有危险脚本规则时不保留隐藏的危险信号终局拒绝" src/shared/policy/policyEngine.test.ts` |
| F-17 | 已有单次解析门禁测试 | `ls electron/confirmation/extractors/scriptParseCount.test.ts` |
| F-18 | 提取失败由策略引擎恒定落人工 | `rg -n "default-extraction-failed" src/shared/policy/policyEngine.ts` |
| F-19 | 审计对策略决策事实只留摘要：`factsSummary` 整体替换为 sha256 前 24 位，`factId` 同样哈希，含绝对路径的 `reason` 替换为固定标记 | `rg -n "sha256:" -B4 -A4 electron/confirmation/securityAuditLog.ts` |
| F-20 | 审计脱敏只作用于固定字段名白名单，新增字段不加入白名单就不会被脱敏 | `rg -n "for \(const k of" -A12 electron/confirmation/securityAuditLog.ts` |
| F-21 | 通用日志脱敏覆盖键名与三种凭证形态（`sk-ant-` / `Bearer` / 长 base64），不改写其余文本 | `rg -n "ANTHROPIC_KEY_PATTERN|BEARER_PATTERN|LONG_B64_PATTERN|isSensitiveKey" electron/logSanitize.ts` |
| F-22 | 底线条目不参与档位变换：锁定、拒绝、逐次确认三者均豁免任何档位映射 | `rg -n "function isTransformExempt" -A3 src/shared/policy/policyPackages.ts` |
| F-23 | 动态执行（含路径算不出的写入）为逐次真人确认的锁定条目 | `rg -n "script-dynamic-execution-confirm" -A4 src/shared/policy/defaultRules.ts` |
| F-24 | 审计脱敏只遍历事件顶层固定字段且只处理字符串，嵌套结构不会被遍历 | `rg -n "for \(const k of" -A12 electron/confirmation/securityAuditLog.ts`；`rg -n "typeof v === 'string'" electron/confirmation/securityAuditLog.ts` |
| F-25 | 审批线索包只把事实投影为 kind 字符串，发现内容不会自动随行 | `rg -n "signals: req.facts.signals.map" electron/confirmation/agentChannel.ts` |
| F-26 | 路径事实把"文件目标算不出"与"可执行代码调用"合并为同一个 `dynamicExecution` 标记 | `rg -n "PROCESS_CALLS.has\(chain\)|state.dynamicExecution = true" electron/confirmation/extractors/scriptPathFacts.ts` |
| F-27 | 引擎先结算拒绝与人工底线（逐次确认 / 人必须确认的询问），之后才走缓存与自动评估；合成的兜底规则位于最后 | `rg -n "const humanFloor" -A8 src/shared/policy/policyEngine.ts` |
| F-28 | `dynamicExecution` 共有 9 处生产点（含绑定重绑定、删除绑定、非模块 global/nonlocal） | `rg -c "state.dynamicExecution = true" electron/confirmation/extractors/scriptPathFacts.ts` |
| F-29 | 解析失败 / 服务未就绪 / 非 Python / 遍历抛错统一走 `emptyUnknown()` | `rg -n "emptyUnknown\(\)" electron/confirmation/extractors/scriptPathFacts.ts` |
| F-30 | `FILE_CALLS` 同时包含读取、删除、搬运类调用，并非只有写入 | `rg -n "const FILE_CALLS" -A8 electron/confirmation/extractors/scriptPathFacts.ts` |

**绕过通道清单**（哪些入口不经过本次改造的门）：非 Python 语言的 `run_script` 不走内容分析（现状即如此，产出"语言未认证"事实）；定时任务链路不消费展示层；IM 标准模式另有独立的脚本网络审核候选事实（本次不改其形状）。

### B. 界面归属卡（D-1 = B 已批准，2026-10-30）

1. **放哪个入口**：确认卡片内新增"脚本风险发现"分区。选这里而不是设置页或独立面板，因为风险信息必须与"批准/拒绝"动作同屏，用户才可能在决定前看到。
2. **形态**：列表，每条一行（行号 + 代码片段 + 发现类型名）。**默认最多 3 条**；第 4 条起折叠为"另有 N 条"，点击展开显示全部，不再分页；条数不超过 3 时不出现展开控件；展开状态不记忆，每张卡片独立。
3. **样式来源**：沿用确认卡片既有的"分区标题 + 正文"两段式排版、既有文本色与等宽字体资源；展开控件沿用既有的文本按钮样式（不加图标）。**不新增**独立弹窗、不新增工具栏、不新增分页控件、不新增图标资源。
4. **新增还是改造**：改造——在既有确认卡片内新增一个分区，不新建面板、不新建页签、不改动卡片其余分区。
5. **成本**：用户默认只看得到 3 条，需自己展开才见全部（可能漏看后面的发现）；需维护展开状态与"另有 N 条"的复数文案；需维护 12 类类型名与证据短语的国际化文案；展开控件需键盘可达，并补一条可访问性用例；后续每新增一类发现都要补文案与一条列表渲染用例。

### C. 需求外扩声明

本方案相对现有交付面**新增**以下内容，逐条注明来源：

| 新增面 | 来源 |
|---|---|
| 事实信号新增可选字段（发现列表、覆盖度、总数） | D-3 = A（已批准）；读取方核对清单见 D-3 |
| 新增发现类型与 12 类构造类别 | 已定事项（构造类别命名），无独立需求条款 |
| 新增策略域分类映射表 | 已定事项（动作归策略域）；数据形状已随 D-3 = A 批准 |
| 确认卡片新增一个分区（默认最多 3 条 + 可展开） | D-1 = B（已批准，界面归属卡见附录 B） |
| 确认请求载荷新增发现列表与总数 | D-1 = B（已批准）；读取方同步义务见 RP-4 ③ |
| 审计新增脚本记录（结构投影骨架 + 会话、轮次、内容摘要，不存字面量） | D-4 = B（已批准，按 B3/B4 收紧） |
| 新增信号 token 命名空间 | 规格层实现细节，对用户不可见 |

**无**新增 IPC 通道（只扩展现有确认请求载荷字段）、**无**新增开关与配置项、**无**新增持久化字段、**无**新增错误码。

### D. 人层 ↔ 机层对账（X-3）

| 锚点 | 第 0/1 层说法 | 第 2 层条目 | 对账 |
|---|---|---|---|
| 决策项 | D-1 = B、D-3 = A、D-4 = B、D-5 = B 已批；D-2 已归策略层；无待批 | D-1→附录 B；D-2→决策权迁移表 `unresolved` 行；D-3→契约卡与读取方清单；D-4→决议段与审计记录契约；D-5→D-5 小节与子类表 | ✓ |
| 阶段 | 5 个 | 阶段表 5 行（1a / 1b / 1c / 2 / 3） | ✓ |
| 新增持久化字段 | 0 | 无 | ✓ |
| 新增错误码 / 失败分类 | 0 | 无（覆盖度只有完成/部分/失败三值） | ✓ |
| 受影响公共契约面 | 5 行（共享类型、规则表、新建映射表、确认请求载荷、审计记录格式） | RP-4 ③④⑥ 为"改" | ✓ |
| agent-sdk 面结论 | 不改 | RP-4 ① 不改 + 门禁命令 | ✓ |
| 会话存储面结论 | 不改 | RP-4 ② 不改 + 门禁命令 | ✓ |
| 变更单元数 | 改 14 / 新建 2 / 复用 1 | RP-3 表 17 行 | ✓ |
| 不变量 ↔ 验收 | 无孤立承诺 | INV-1~9 均被 AC-1~17 覆盖（AC-10↔D-1，AC-11↔D-4，AC-12↔INV-2，AC-13/AC-17↔D-5，AC-14↔INV-9，AC-15↔D-4，AC-16↔B5） | ✓ |
| 未验证项 | 3 处自曝弱点 | 附录 E 同 3 条 | ✓ |

### E. 待定项与未验证项

| 项 | 影响 | 谁拍板 |
|---|---|---|
| 「算不出路径」在远程链路是否也交安全审核 agent | 远程链路当前不提供自动审批档位；要改需先扩该档位能力，不属本方案 | 策略层独立调整，不阻塞本方案 |
| D-4 决定后，审计字段清单的最终形态 | 影响日志导出与复核流程 | 项目负责人 |
| 位置补齐后，发现条数会显著多于现状命中条数 | 审批 agent 的提示材料体积上升，需要上限策略；未实测 | 实现阶段测量后报 |
| 12 类类别是否足够覆盖真实脚本 | 若出现跨类或无法归类，需扩类并补策略映射 | 实现阶段以 golden 样本回证 |
| 现有"危险拒绝"条目（F-13）是否应升级为不可覆盖的底线 | 当前它落在用户可覆盖域，与同类远程条目不一致 | 项目负责人（独立于本方案的小决策） |
| 非 Python 语言接入内容分析 | 本方案只覆盖 Python，其余语言维持"语言未认证"事实 | 不在本轮范围 |

### E-1 与同域并行方案的变更冲突（非功能依赖）

> 定性：本方案**不调用**该计划的任何产出，两者在功能上互不依赖；冲突只来自"同一批文件被两边改"。因此需要的是**定先后**，而不是排队等待。

| 项 | 说明 |
|---|---|
| 并行方案 | [`script-certifier-shape-expansion-and-capability-declaration-improvement-plan.md`](./script-certifier-shape-expansion-and-capability-declaration-improvement-plan.md)，草稿（其 D1~D3 待拍板），基线 `main` `26a79788` |
| 它做什么 | ① 给远程认证器补建模形状（现在只认 7 种语句、5 组表达式，导致自动放行车道常年空转）；② 能力声明从路径一族扩到路径/网络/进程三族；③ 补齐检测盲区（`multiprocessing`、`pickle`/`marshal`、`ftplib`/`smtplib`/`xmlrpc`/`telnetlib` 当前零命中） |
| 重叠面 | `scriptContentSecurity.ts`、`scriptPathFacts.ts`、`toolCallGate.ts`、`src/shared/confirmation/types.ts`、`defaultRules.ts`、`labels.ts` —— 与本方案 RP-3 表高度重合 |
| 冲突点 1 | 它新增危险模块与新检测项；本方案要求每个检测项按《发现》结构产出。二者对同一函数的产出形状不同，后落方需 rebase |
| 冲突点 2 | 它新增能力声明族（process / network）与对应规则；本方案阶段 2 把三档匹配条件换成类别条件，其新增规则需按类别条件重写 |
| 定序（已决） | **本方案先行**。该计划落地时 rebase：它新增的危险模块按《发现》结构产出、新增规则按类别条件重写。其"检测盲区补齐"仍应尽快单独推进（属现状漏洞：这些构造当前以干净面貌免确认执行），但与本方案不共享提交批次。 |
| 可共用 | 两者都主张行为等价（它：认证只扩大"可自动放行"的可能性；本方案：类别映射与原三档等价），等价验证可共用同一批 golden 样本 |

### G. 评审核销表（2026-11-04，5 项阻断）

评审报告：`docs/review/2026-11-04-script-finding-model-technical-design-review.md`。本轮只改方案，未改代码、未跑构建与测试；下表的验收项是实施时需补齐的证据。

| 评审项 | 上轮问题 | 本轮状态与落点 |
|---|---|---|
| B1 [P1] | 丢弃无位置发现后没有策略兜底；路径侧 unknown 不能替代内容覆盖度；AC-1 对空集合也通过 | **第二轮 R1 再修正**（首轮处置不成立）。首轮改为"位置缺失即整次分析失败"并复用现有兜底；第二轮实测证明该兜底不是优先路径。现改为专用锁定条目，见 H 表 R1 |
| B2 [P1] | `unresolved → ask` 无法实现"桌面交审核 agent"：路径事实的逐次确认条目锁定，且锁定/拒绝/逐次确认条目一律不参与档位变换 | **已闭合（D-5 定为 B 后更新）**。不再笼统承诺：先把事实层拆成 `unresolved-write-target` 与 `dynamic-code-execution` 两个子原因，再把两条逐次确认条目**收窄**为只匹配后者，新增条目只覆盖前者（桌面标准档交审核 agent、strict/custom 与远程询问、定时任务拒绝）。评审的两条要求均满足——不泛化解除 `eval`/进程类的强制确认；有明确区分契约、规则范围与 policy trace。AC-13 改为矩阵逐格断言，AC-17 断言子类区分与聚合 token 兼容 |
| B3 [P1] | 两套脱敏覆盖不到嵌套片段；代码字符串里的凭证不会被替换 | **已闭合**。审计不再存原文，改为**结构投影**：字面量→占位、注释→占位、只保留骨架；投影器放共享层、审计与审核材料共用；写入前仍过脱敏作为第二道防线；变更面新增审计写入与投影器；AC-14 覆盖嵌套、单引号、赋值、调用参数与超长行 |
| B4 [P2] | `snippetDigest` 按"编号+位置"生成、不含内容，无法校验"是不是同一段" | **已闭合**。定位键与内容摘要分离：`(pattern, range)` 负责定位，`snippetSha256` 负责内容证明；输入定义为原始片段、换行统一为 `\n`、不 trim、不截断、不投影，在投影前计算并给出复算方式；AC-15 断言同键不同内容摘要必变 |
| B5 [P2] | 审批 agent 的证据传递留作"实现时定位"；现有链路只投影 kind 字符串 | **第二轮 R3 再修正**。首轮已补通道与阶段 1c；第二轮指出材料只传骨架无法核验。现区分审计与审核两类内容合同，见 H 表 R3 |

### H. 第二轮评审核销表（2026-11-04 v2，3 项阻断）

评审报告：`docs/review/2026-11-04-script-finding-model-technical-design-review-v2.md`。评审用真实引擎与解析器做了内存探针，下表按其结论逐条处置。

| 评审项 | 上轮问题 | 本轮状态与落点 |
|---|---|---|
| R1 [P1] | `default-extraction-failed` 位于引擎默认兜底，不是优先路径；探针实测 `extraction-failed + script-network` 会命中 `script-network-ask-desktop` 并交审核 agent，因此"加了失败信号就恒落人工"不成立 | **已闭合**。改用**专用锁定条目**并利用引擎既有 `humanFloor` 分支：逐次确认在人必须确认的询问之后、缓存与自动评估之前直接返回，回答者为用户。同时声明**拒绝仍优先于人工确认**；失败时该次脚本类发现与派生 token 全部作废（不得参与 allow / 自动评估），其他提取器事实仅保留供人查看；失败表与 INV-2、AC-12 全面对齐，AC-12 扩到"失败 × 网络 / 相对写入 / 未认证 / 用户动作覆盖 / 旧缓存"组合 |
| R2 [P1] | 按 `FILE_CALLS` 拆分会把读取、删除、搬运一并纳入新审核域，超出 D-5 获批范围；且旧 `dynamicExecution` 还有绑定重绑定、删除绑定、`global`/`nonlocal`、`emptyUnknown` 等多处来源未被映射 | **已闭合**。给出 11 行分类矩阵：`open` 按 mode 分读写、`Path.write_*` 与 `Path.read_*` 分别归类、删除类、搬运类、绑定链断裂、解析不可用、缺省保守归入不可用；新增多值字段 `dynamicKinds` 承载；token 改为**排除式**（只有"纯写入目标未知"产生 `write-target-only`，其余一律继续命中两条旧锁定条目，人工 floor 保留）；AC-17 扩成分类矩阵断言，明确"读取/删除/搬运不得被命名为 write" |
| R3 [P2] | 审核材料只传骨架，`requests.get` 两条仅 URL 不同时骨架相同，审核方无差异证据；AC-16 只验证条数也能通过 | **已闭合**。区分两类内容合同：审计为骨架 + 摘要（D-4 存储边界），审核材料为**原文片段 + 结构化证据**（`ScriptFindingEvidence`），并补"受控回读"（超限时给 range + 摘要，仅读本次调用脚本）；新增 `sufficiency` / `status`，材料不足或被截断即降为 `undetermined`，审批链路**确定性**要求人工，不由 agent 裁量；AC-16 改为断言实际内容差异与降级行为 |

**本轮验证边界**：以上均为方案层处置，未实施、未运行测试；验收项须在实施时按 AC-12/16/17 补齐可执行断言。

### F. 修订记录

- 2026-10-30 首版：由讨论定稿——构造类别命名（不设风险分级）、检测编号保留为稳定 ID、路径格式类型与路径区划分属两侧、证据不含指向性字段。待批 D-1 ~ D-4。
- 2026-10-30 决议 D-1 = B：确认卡片逐条展示，默认最多 3 条、第 4 条起折叠为"另有 N 条"并可展开，不超过 3 条时不出现展开控件，展开状态不记忆。同步更新：界面归属卡（附录 B）、RP-3 / RP-4 / RP-5、阶段表拆为 1a / 1b、新增 AC-10、X-3 对账。待批剩 D-2 ~ D-4。
- 2026-10-30 修正 D-2 归属：原把它列成"要不要人确认"的决策项，是把策略取值混进了分析侧设计。改为——分析侧只负责区分"绝对路径"与"算不出来"两种形态，处置归策略表（桌面标准档经既有档位变换落安全审核 agent、远程要人确认、定时任务拒绝）。同步更新：D-2 小节重写、INV-6 推论、排除方案、决策权迁移表、阶段 2、AC-4、自曝弱点 1、附录 E、X-3。待批剩 D-3 / D-4。
- 2026-10-30 决议 D-3 = A：发现字段以可选、可缺省方式新增，不改变既有字段含义。同步新增"读取方核对清单"（策略匹配、记忆资格、确认卡片、审批方提示材料装配点、审计、待删回传字段）与各自核对时点；附录 C、X-3、待批准清单同步。**唯一待批剩 D-4。**
- 2026-10-30 决议 D-4 = A 并关闭全部决策项：审计只记发现类型 + 行号 + 内容摘要。核对后修正依据——现有审计本就是"落事实不落内容"（策略决策事实只留 sha256 摘要），故 A 不引入新机制，反而 B 需突破既有原则。同步新增 F-19/F-20/F-21、INV-9（审计新增字段必须进脱敏白名单）、AC-11、X-3，并在 D-4 段写明可核验链路与将来放开的三条前置条件。**无待批项。**
- 2026-10-30 复核后升级 D-4 = A+：A 的"事后取证要自己找原脚本"确实不够方便，但 B 不可逆且业务语义抹不掉。改为 A+——审计补四项**定位引用**（会话、轮次、脚本摘要、片段摘要），仍不含原文。依据补充：会话与消息内容属保留核心表、清理需显式授权、不过期，因此"审计比会话短命"，指向会话是可靠方向；且当场审核看的是事实包、不看审计文件，B 对当场审核零收益。同步新增审计引用契约、INV-9 措辞、AC-11、阶段 3 出口证据、附录 C、X-3。
- 2026-10-30 再修正 D-4 = B（撤回 A+）：上一轮把风险写重了——审计是本地文件、不外发不出机器；脚本不是密钥而是用户自己的代码；写入前仍过两套脱敏。把这些当"高危"是风险扩大化。改为 B 的受控形态：只记命中的那一行、过脱敏并进白名单、同行记 digest，保留会话/轮次引用；不加"详细审计"开关、不在导出时弹提示。同步更新决议段、审计记录契约（`ScriptAuditFinding` + `ScriptAuditRef`）、INV-9、AC-11、阶段 3、附录 C、X-3、README。
- 2026-10-30 修正 E-1 定性：原把同域那份"认证扩容/盲区补齐"计划写成"顺序约束"，容易被读成功能依赖。改为——本方案不调用它的任何产出，冲突仅来自同一批文件；给出两种可行顺序（它先 / 我们先），只需明确先后。
- 2026-11-04 定序确定：**本方案先行**，该计划落地时 rebase（见 E-1 的"定序（已决）"行）。
- 2026-11-04 评审 5 项阻断全部处置（核销表见附录 G）：B1 覆盖不足兜底（INV-2 改为"位置缺失即整次分析失败"+ 定时任务锁定拒绝 + AC-12）；B2 撤回"标准档交审核 agent"的错误承诺、新开 D-5（AC-13 断言最终回答者为人）；B3 审计改"结构投影"、投影器入共享层（AC-14）；B4 定位键与内容摘要分离、`snippetSha256` 精确定义（AC-15）；B5 审批侧脚本证据契约 + 阶段 1c（AC-16）。同步更新 RP-3/RP-4/RP-5、阶段表、X-3、附录 A（新增 F-22~F-25）。
- 2026-11-04 决议 D-5 = B：仅"路径未知的写入"交审核 agent，`eval`/进程/动态导入仍逐次真人确认。落地四件事写入 D-5：① 事实层拆 `unresolved-write-target` / `dynamic-code-execution` 两个子原因（聚合 token 保留以兼容旧规则）；② 两条逐次确认条目收窄为只匹配后者，新增 `script-unresolved-write-review` 覆盖前者（桌面标准档 `auto-evaluator`，strict/custom 与远程询问，定时任务拒绝）；③ 组合矩阵逐格等价断言；④ 明确 agent 只能读代码意图、批准不写记忆。同步更新：决策权迁移表、阶段 2、AC-13、新增 AC-17、RP-3（路径事实改为改造）、RP-5、X-3、附录 A（F-26）、核销表 B2 行、README。
- 2026-11-04 第二轮评审 3 项阻断处置（核销表见附录 H）：R1 提取失败兜底改为**专用锁定条目**并利用引擎 `humanFloor`（不再依赖默认兜底），失败时脚本类发现与派生 token 全部作废，AC-12 扩组合矩阵；R2 D-5 分类改为 **11 行矩阵**（`open` 按 mode、删除/搬运/读取各自保留原 floor、绑定断裂与不可用保守归类），新增多值字段 `dynamicKinds`，token 改**排除式**，AC-17 扩为分类矩阵；R3 审核材料改为**原文片段 + 结构化证据**（与审计骨架合同分开），新增 `sufficiency` / `status` 与确定性降级、受控回读，AC-16 改为断言实际内容差异。同步更新：INV-2 兜底表、失败表、D-5 落地设计、审计/审核契约、附录 A（F-27~F-30）、G 表 B1/B5 行。
