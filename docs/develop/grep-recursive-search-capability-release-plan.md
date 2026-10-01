# grep 递归搜索能力释放方案

- 日期：2026-10-01
- 状态：**已按 v1 + v2 评审整改**（评审报告：`docs/review/…-review.md`、`…-review-v2.md`；整改留痕见 §14）；**2026-10-01 追加阶段 H**——敏感条目明示义务兑现 + `explicit` 死字段清理（§1.6 / §7.10 / §8 阶段 H / §9.7b）；**同日追加阶段 I**——grep 输出上下文效率优化（D12 重审：路径相对化 / 超长行统一 / searchScope 瘦身，§7.11 / §8 阶段 I / §9.7c / §10 D12 重审留痕 + D14/D15）；**同日完成 main 合并核查**（64 提交，方案起点契约成立，订正与实施注意见 §15，新增 C8 / AC-50）；**同日完成 v3 评审整改**（报告：`docs/review/grep-recursive-search-capability-release-plan-review-v3.md`，2 阻断 + 2 中等 + 9 轻微全采纳，留痕见 §16，新增 §3.3b / AC-27c / AC-51 / G9a-d）
- 范围：`src/shared/builtinToolDefinitions.ts`、`src/shared/policy/readPolicyV1.ts`、`electron/confirmation/toolCallGate.ts`、`electron/confirmation/readExecutionPermit.ts`、`electron/confirmation/readPermitExecutor.ts`、`electron/confirmation/extractors/runExtractors.ts`、`electron/tools/grepScope.ts`、`electron/tools/builtinExecutors.ts`、`src/shared/domainTypes.ts`、设置页 UI 与 i18n，及对应测试
- 关联文档：
  - `docs/requirement/tools-requirement.md`（§grep：需求原文要求「递归搜索」、`path` 可选默认整个工作目录）
  - `docs/develop/ripgrep-integration-technical-design.md`（rg 集成基线）
  - `docs/develop/grep-abort-response-and-dead-code-cleanup-plan.md`（R6/R7 与降级矩阵）
  - `docs/develop/tool-invocation-reliability-improvement-technical-design.md`（`GrepScope` / `planGrepInvocation` / `normalizeGrepArgs` 定义）
  - `docs/requirement/remote-private-chat-security-optimization-requirement.md` §1.2（威胁模型：残余威胁为「Agent 误操作与内容注入」）

> **行号说明**：文中行号为撰写时快照，实施时请以符号检索定位（`rg -n "<符号名>" <文件>`），不要依赖行号偏移。

> **一句话结论**：当前限制不在 ripgrep，也不在安全策略，而在「读取许可（permit）只能表达单文件」这一实现约束被写成了准入契约。执行层（`grepFallbackJs` 的 `walk`、`planGrepInvocation`、`GREP_DEFAULT_IGNORES`、`grepScope.test.ts` 用例）早已按目录递归实现，只有 gate/permit 停在单目标文件。本方案把 permit 的表达力扩到「目录子树」，不触碰 zone 分类与 policy engine。

---

## 0. 执行计划与环境边界

本方案采用 TDD 推进：每个任务先补失败测试（RED），再实现（GREEN），最后跑聚焦测试 + 类型检查 + 构建门禁。

- 全部任务均可在本地完成，无外部环境依赖。
- 无平台限制项：涉及路径语义的用例已在既有测试中按 Windows/macOS 双向覆盖，本方案复用同一套夹具风格。
- 完成定义：§8 全部任务勾选 + §9 全部 AC 勾选并附证据 + §11 门禁命令全绿。

---

## 1. 问题定义

### 1.1 用户可观察的现状

| 调用 | 现状返回 |
|---|---|
| `grep(pattern, path="electron/tools")`（真实目录） | `V1 文件读取仅支持单个普通文件目标` |
| `grep(pattern, path="electron/tools/*.ts")`（通配） | 同上（措辞完全一致） |
| `grep(pattern, path="electron/tools/builtinExecutors.ts")` | 成功，但返回体含 `skipped 4 directories: node_modules, .git, dist, dist-electron` |
| `grep(pattern)`（省略 path） | 被 schema `required` 拒绝 |

### 1.2 由此产生的行为真空

| 工具 | 对文本搜索的态度 |
|---|---|
| `grep` | 只能搜单个文件；`glob` / `include_ignored` 失去作用对象 |
| `run_shell` | description 明令「文本搜索请用 grep 工具，勿在此执行 grep/findstr/head/find/sed/awk」 |

「要搜的场景搜不了」+「能搜的工具被告知不要用」= Agent 只剩 `run_script` 与 `list_directory + read_file` 逐层翻两个低效出口。**该真空是设计产物，不是巧合。**

### 1.3 三个必须在方案中一并纠正的认知偏差

| 偏差 | 事实 |
|---|---|
| 「不支持正则」 | **不成立**。`pattern` 直达 `rg --regexp`。不支持的是 lookaround / 反向引用，属 ripgrep 默认 Rust regex 引擎边界，非本产品封印。**本方案不修改 pattern 处理。** |
| 「glob / include_ignored 未实现」 | **两者情况不同**。`glob` 已实现且已接入，只是**在唯一允许的模式（单文件）下不生效**（`builtinExecutors.ts` 原文注释：「glob 过滤只对目录递归生效；显式命名的单文件目标不应用」）——属接口自相矛盾。`include_ignored` 则**确有实现缺失**：注释声称对齐 `-uu`，但从未推送 `--no-ignore`，见 §1.5。 |
| 「限制是安全策略要求」 | **不成立**。见 §2.2 证据链：zone 分类不读 `isFile()`，敏感清单全是目录前缀，`readPolicyV1.ts` 自陈「只校验 V1 目标契约；授权动作一律交给统一 policy engine 和生效规则集」。 |

### 1.4 已知 bug（与是否放开递归无关，必须独立修复）

单文件模式返回体虚报跳过目录：

```
No matches found (searched: electron/tools/plannedToolRegistry.ts;
  skipped 4 directories: node_modules, .git, dist, dist-electron;
  skipped directories may contain matches)
```

`planGrepInvocation` 无条件遍历 `GREP_DEFAULT_IGNORES` 并 `fs.existsSync` workDir 下的成员，与搜索根是文件还是目录无关。**只搜单文件的实现不应知道 workDir 下有哪些目录。** 证据：同一 pattern 搜目录被拒、搜文件成功，而成功者还在汇报目录范围——限制与实现由两个不同语义驱动。

### 1.5 已知 bug 二：`include_ignored` 的注释与实现不符（`-uu` 只落了一半）

两处注释均声称对齐 `-uu`：

| 位置 | 原文 |
|---|---|
| `builtinExecutors.ts` `GrepExecArgs.includeIgnored` | 「R6：对齐 ripgrep -uu（`--no-ignore --hidden`）」 |
| `builtinToolDefinitions.ts` grep schema | 「对齐 ripgrep 的 `-uu`：同时解除默认忽略规则与隐藏条目过滤」 |

但 `grepWithRg` 的 `rgArgs` 拼装中**没有任何 `--no-ignore` 系列参数**，实际只有：

```ts
if (plan.hidden) rgArgs.push('--hidden')
for (const g of plan.ignoreGlobs) rgArgs.push('--iglob', g)   // ['!**/node_modules/**', ...]
```

`planGrepInvocation` 亦只在 `includeIgnored` 时**不推**那批反向 glob，并置 `hidden: true`。

**结论**：`-uu` 中「`--hidden`」与「解除 `GREP_DEFAULT_IGNORES` 名单」已落地，「`--no-ignore`」（ignore 文件）从未落地。后果：`include_ignored: true` 也搜不到被 `.gitignore` 忽略的路径——**参数与文档双重承诺，实现缺失**。

该缺失与 D1（§7.9）同源，一并处理；两处注释须修正为与实现相符的表述。

### 1.6 已知 bug 三：敏感条目「明示义务」未兑现 + `explicit` 恒值死字段（2026-10-01 追加）

R6「明示义务」（`tool-invocation-reliability-improvement-technical-design.md` §4.6.1 第 4 条：「任何因敏感路径被跳过的条目，都必须在返回体与 searchScope 中如实上报」；§4.6.3：「敏感路径被跳过同样计入 skipped 并标注原因」）只兑现了一半：

| 项 | 承诺 | 实现 |
|---|---|---|
| 显式点名敏感路径 | 返回体明示「命中敏感路径」 | ✓ `explicitSensitiveHit` → `sensitivePathHit: true` |
| 被排除的敏感条目 | 计入 `skipped` 并标注 `sensitive: true`，文案标注 `(sensitive, not searched)` | ✗ 类型声明（`GrepScope.skipped` 的 `sensitive?: boolean`）与文本分支存在，但**全历史无赋值点**（`git log -S "sensitive: true"` 在 grepScope 无结果；引入提交 `39003e3c` 时点即为 `skipped.push({ name, explicit: false })`） |

后果：在含 `secrets/` / `.env` 的目录中搜索且无匹配时，返回体（文本与 JSON）均不显示「有敏感条目被排除」——Agent 可能把被安全规则挡住的结果误判为全集（无匹配 ≠ 不存在）。实现未做的可推断原因：敏感名单混含**文件**（`.env`）与**目录**（`secrets/`），`skipped` 的「directories」语义容纳不下，实现时绕开、但类型字段与文本分支残留。与 §1.5 属同类缺陷：承诺与实现不符。

同批发现的死字段：`skipped` 条目的 `explicit` 全仓唯一赋值点（`grepScope.ts:106`）硬编码 `false`——显式点名走 `continue` 不进名单（`git log -S "explicit: true"` 全历史无结果），其语义已被「显式点名即解除」机制完整取代，属设计收敛残留。

**处置：已决策纳入（方案一，阶段 H）**——兑现敏感条目明示 + 删除 `explicit`，见 §7.10 / §8 阶段 H / §9.7b（AC-39～AC-43）。

---

## 2. 现状证据（事实核查）

### 2.1 限制点按调用链排序

| 序 | 位置 | 具体机制 | 拦截结果 |
|---|---|---|---|
| 1 | `src/shared/builtinToolDefinitions.ts` grep schema | `path` description 写「必填的单个文件路径……目录、通配路径和多路径不受支持」；`required: ['pattern','path']` | 省略 path 不可表达 |
| 2 | `electron/confirmation/extractors/runExtractors.ts` `hasUnsupportedV1ReadTarget` | 正则含通配符标记（星号、问号、方括号类、花括号类）判通配；字段名 `paths`、`files`、`filePaths`、`file_paths` 判多路径；命中后强制 `targetKind: 'unknown'`、抹掉 `identity` | 通配/多路径被染成不可确定目标 |
| 3 | `electron/confirmation/toolCallGate.ts` `fileReadValidation` | read_file/grep 的 `targetKind` 必须是 `file` / `missing` / `symlink→file` | **目录在此被拒**（`read-v1-target-unsupported`） |
| 4 | `src/shared/policy/readPolicyV1.ts` `validateDesktopReadV1` | 白名单 `['file','symlink','missing']`；`hasUnsupportedPattern` 亦 deny | 与 ③ 同义复述 |
| 5 | `electron/confirmation/toolCallGate.ts` automation 分支 | `lane==='automation' && isReadTool && (无 readPathFact 或 targetKind==='directory' 或 hasUnsupportedPattern)` | automation lane 目录被拒 |
| 6 | `electron/confirmation/toolCallGate.ts` permit 签发 | 条件含 `(readPathFact.targetKind !== 'directory' 或 isListDirectoryTool)` | 目录只对 list_directory 签发 permit |
| 7 | `electron/confirmation/readPermitExecutor.ts` | `permit.targets.length !== 1` → `permit-target-count-mismatch`；`targetKind ∈ {directory,special,unknown}` → `permit-target-kind-not-readable` | 单目标 + 非目录硬约束 |
| 8 | `electron/confirmation/readExecutionPermit.ts` | `ReadPermitScope = 'single-target' 或 'direct-entries'` | **无「子树」档位** |

### 2.2 为什么这不是安全策略（六条对照）

| # | 证据 | 说明 |
|---|---|---|
| E1 | `readPolicyV1.ts` 自陈注释 | 「只校验 V1 目标契约；授权动作一律交给统一 policy engine 和生效规则集」 |
| E2 | `classifyReadPathZone`（位于 `electron/confirmation/extractors/readPathFacts.ts`）全路径前缀匹配 | `isSystemDir()` 走正则根前缀、`under(path, workDir)` 走目录包含、`matchSensitive()` 走前缀——**无一处读 `stat.isFile()`** |
| E3 | `shellSensitivePaths.ts` `getBuiltinSensitivePrefixes` | `~/.ssh`、`~/.gnupg`、`~/Library`、`AppData/Roaming`、`C:\Windows`、userDataDir、`~/.env`（文件，`:33`——【v3 L5 补】）——**多为目录前缀 + 敏感文件点名，zone 分类均不读 `isFile()`** |
| E4 | `matchSensitive` 的 `secrets-directory` 判定 | `normalized.includes(sep + 'secrets' + sep)`——**必须后跟分隔符才命中，即只针对目录** |
| E5 | `defaultRules.ts` 的 read 规则 | `path-sensitive-read-confirm` / **`path-system-dir-ask`** / `read-target-workdir-allow` 全部按 `signals: ['path-target:<zone>']` 匹配，**不区分文件与目录** |
| E6 | `grepScope.ts` 首行注释 | 「**默认忽略 ≠ 访问控制**」——代码自身已区分「范围」与「安全」 |

**结论**：zone 分类与 policy engine 对文件/目录一视同仁；`list_directory` 早就拿到了目录 permit（含目录身份校验 `read-directory-identity-changed`）。目录进不了 grep 路径，只因 permit 的**表达力**只有「单文件」。

### 2.3 执行层早已按目录递归实现（本方案改动量小的根本原因）

| 位置 | 现有实现 |
|---|---|
| `builtinExecutors.ts` `grepFallbackJs` | `st?.isFile?.() ? scanFile(absSearch,false) : await walk(absSearch)`——**递归分支已写好**（stat 失败即落 walk 分支） |
| `builtinExecutors.ts` `walk()` | 逐条目 `if (isSensitivePath(full)) continue`、`FALLBACK_IGNORE_SET`、隐藏条目判定——**目录语义的敏感拦截已写好** |
| `grepScope.ts` `planGrepInvocation` | 产出 `skipped` / `ignoreGlobs` / `hidden` / `sensitiveExcludes`，全部以**目录为搜索根**设计 |
| `grepScope.ts` `formatGrepNoMatchOutput` | 「searched: X; skipped N directories」——**纯目录递归语境的输出契约** |
| `grepScope.test.ts` | 用例主体为目录场景（`sub/node_modules/pkg`、`src/.vite/cache`、`sub/src`）；**另含两条文件点名用例**（`.env` 文件、`secrets/key.txt`） |
| `builtinExecutors.ts` `grepWithRg` | `rgArgs.push(stableFileOnWindows ? '-' : openedFileFd !== undefined ? '/dev/fd/3' : searchPath)`——**`openedFile` 缺省时直接用 `searchPath` 路径搜索，目录路径可直接传入** |

**即执行层不需要为「目录」写新能力，只需被允许进入。**

### 2.4 契约与需求文档的冲突

| 项 | 需求文档 `tools-requirement.md`（:354、:457-462） | 现行 schema |
|---|---|---|
| 描述 | 「在工作目录下**递归搜索**匹配正则表达式的文件内容」 | 「必填的单个文件路径……不支持目录递归」 |
| `path` | 可选，默认整个工作目录 | `required: ['pattern','path']` |
| 执行逻辑 | 「**递归搜索**指定目录下的文本文件」 | 单文件 |

`builtinToolDefinitions.ts` 顶部注释声明「与 docs/requirement/tools-requirement.md 对齐」——现行 schema 逆着该声明写成。

---

## 3. 目标与非目标

### 3.1 目标（能力）

| ID | 能力 | 现状 |
|---|---|---|
| C1 | `path` 省略 → 搜索整个 workDir | schema `required` 拒绝 |
| C2 | `path` = 目录 → 递归搜索 | gate deny |
| C3 | `path` = 文件 → 单文件搜索（回归保持） | 支持 |
| C4 | `glob` 文件名过滤生效 | 死参数 |
| C5 | `include_ignored` 解除默认忽略名单生效 | 死参数 |
| C6 | 「无匹配」返回体不再虚报 skipped | 有 bug（§1.4） |
| C7 | 敏感条目（`.env` 文件、`secrets/` 目录等）在 `skipped` 中如实上报并标注（§1.6） | 类型与文本分支存在但不可达（阶段 H） |
| C8 | workDir 内搜索输出的路径为相对 workDir（阶段 I 重审推翻 D12 原绝对决策） | 每行/每文件重复绝对路径前缀（§7.11 子项 1） |
| C9 | 超长行上限 500→300（显示列宽）且两引擎统一为「行首截断 + 明示标注」 | 500 偏宽 + 两引擎超限行为不一致（§7.11 子项 2） |
| C10 | searchScope 返回体形态去除常态默认值与派生字段 | `engine`/`truncated` 常态值、`skippedCount` 派生值每次重复（§7.11 子项 3） |

### 3.2 非目标

| ID | 项 | 理由 |
|---|---|---|
| N1 | 多路径输入 | 需 permit 表达多目标，改动面翻倍；目录递归 + glob 已覆盖主要场景 |
| N2 | 通配 `path`（`src/**/*.ts`） | rg 的正解是 `-g/--glob`，`path` 通配存在 shell-glob 与 rg-glob 的语义歧义。本方案改为**明确拒绝 + 可操作指引**（§5.4），不支持静默改写语义 |
| N3 | 修改 `pattern` / 正则处理 | 无问题，见 §1.3 |
| N4 | 修改 zone 分类 / policy engine / `defaultRules.ts` | 对目录本就正确处理，见 §2.2 |
| N5 | 给 rg 增加 `--follow` / `-L` | **安全不变量，见 §6.3** |
| N6 | 放宽 `run_shell` 的「勿执行文本搜索」禁令 | 独立议题；本方案不改该禁令 |
| N7 | 让 `run_shell` / 终端复用随包 rg | 见 `ripgrep-integration-technical-design.md` §2.2 |
| N8 | 改动 `read_file` 的目录行为 | `read_file` schema 定位就是文件；其 `fileReadValidation` 分支保持原样 |

### 3.3 能力面决策（M3，**已决策：纳入**）

§7.4 改动 3 去掉 automation 分支的 directory 条件后，**automation lane 对 workDir 内普通目录的递归搜索将 auto-allow 直通**（敏感/系统目录仍由 `automation-sensitive-path-deny` / `automation-system-dir-deny` 拦截，均 `locked: true`）。

**决策：纳入本期（选项 A）。** 依据：

| # | 依据 |
|---|---|
| 1 | **现状本就不自洽**：`automation-readonly-allow`（`defaultRules.ts:527-538`）的 toolName 列表含 `read_file` / `list_directory` / `grep` —— automation lane **现在就能 `list_directory` 列目录**，却搜不了目录。放开是消除不一致，而非新开口子 |
| 2 | grep 只读、不写文件；敏感/系统位置有 `locked` deny 兜底 |
| 3 | 自动化任务恰恰需要搜索能力，保留条件会造成「desktop 能搜、automation 不能」的能力面割裂 |

§9 已补 **AC-27b** 断言该边界（「有意放行」与「失守」可区分）。

> 同时订正：`remote-outside-read-deny` 的 lane 为 `wechat | feishu | automation` **三者**（`defaultRules.ts:46-48`），AC-27 原表述「远程 lane」偏窄。

### 3.3b 能力面决策（v3 M1）：远程 lane（wechat/feishu）同步纳入

**事实**：`fileReadValidation`（`toolCallGate.ts:881`）**无 lane 条件**——它是当前远程 lane 唯一的 grep 目录拦截点（已核实不存在 remote 专属 read 校验）；本方案 §7.4 改动 2 拆分后，远程 lane 的 workDir 内目录递归搜索将沿现状单文件的放行路径**自动获得能力**。原稿对 automation lane 的同类扩大做了 §3.3 决策 + AC-27b，对远程 lane 只字未提，而 §1 关联文档恰引用了远程安全需求的威胁模型。

**决策：纳入（比照 §3.3 选项 A）**。依据：

1. **现状本就不自洽**：远程 lane 现在就能 `list_directory` 列 workDir 内目录（read 规则按 signals 匹配、不区分文件与目录），却搜不了目录——放开是消除不一致；
2. **兜底完备且 locked**：敏感位置 `path-sensitive-read-confirm`（lane 含 wechat/feishu，`confirm-every-time`，locked）；workDir 外 `remote-outside-read-deny`（含 wechat/feishu，locked）；系统目录 `path-system-dir-ask`；
3. **与 §4.2 的描述一致**（「远程会话只允许工作目录内的普通路径」——workDir 内目录递归本就在该语义内）。

**AC-27c** 断言该边界（「有意放行」与「失守」可区分）。

---

## 4. 目标契约（schema）

### 4.1 `src/shared/builtinToolDefinitions.ts` — grep

**改动后 `path` 字段：**

```ts
path: {
  type: 'string',
  description:
    '搜索根：可以是文件或目录，支持相对路径（相对工作目录）与绝对路径；省略时搜索整个工作目录。传入目录会递归搜索其下所有文件。' +
    '文件名过滤请使用 glob 参数，不要在 path 中写通配符。'
}
```

**改动后 `required`：**

```ts
required: ['pattern']    // 原：['pattern', 'path']
```

### 4.2 grep description（整体替换第一句，其余保留）

现状首句：

> 按当前会话安全策略搜索一个明确指定的文件：普通桌面只读可按策略搜索工作目录外路径中的单个文件，敏感或系统位置需真人确认；远程会话只允许工作目录内普通路径中的普通文件。不支持目录递归、通配路径或多路径输入。

替换为：

> 按当前会话安全策略搜索文本内容，搜索根为文件或目录：普通桌面只读可按策略搜索工作目录外的路径，敏感或系统位置需真人确认；远程会话只允许工作目录内的普通路径。传入目录时递归搜索。不支持通配路径或多路径输入（文件名过滤请用 glob 参数）。

**保留不动**的部分（R6 既有承诺，逐字保留）：
- 默认忽略名单段落（`node_modules`、`.git`、`.svn`、`__pycache__`、`dist`、`dist-electron`、`.cursor`；显式指定其内部路径即可搜索，或 `include_ignored: true` 一并解除）
- 敏感文件 / 目录段落（`.env`、`.env.*`、`secrets/` 遍历中始终排除；显式点名才搜索并标注「命中敏感路径」）
- 「无匹配」结果附带 `searchScope`
- `git log -S` 效率提示

### 4.3 需同步的契约文档

| 文件 | 改动 |
|---|---|
| `docs/requirement/tools-requirement.md` | 无需改动（其原文即为「递归搜索」、`path` 可选）；**在 PR 描述中引用为对齐依据** |

### 4.4 验收

- AC-01：`BUILTIN_TOOL_DEFINITIONS` 中 grep 的 `required` 不含 `path`。
- AC-02：grep 的 `path` description 不含「单个文件路径」「不支持目录递归」字样。
- AC-03：`src/shared/builtinToolDefinitions.test.ts` 更新并通过。

---

## 5. 设计：permit 从「单文件」扩到「目录子树」

### 5.1 核心决策：目录 permit 绑定什么

| 候选 | 后果 | 判定 |
|---|---|---|
| 绑定「目录内每个文件」 | 搜索无法工作（新增文件即失效），且决策时未知文件集合 | ✗ |
| 绑定「搜索根自身 identity」 | 根被替换才拒绝；根内增删随意 | **✓ 采用** |

**原理**：permit 的职责是「授权的对象绑定与执行忠实性」，不是风险评估。目录搜索要绑定的客体是**根目录**，不是其中的文件。这与 `list_directory` 现有目录 permit（`targetKind:'directory'` + `scope:'direct-entries'` + 目录身份）**同构**。

### 5.2 `ReadPermitScope` 新增子树档位

`electron/confirmation/readExecutionPermit.ts`：

```ts
// 原
export type ReadPermitScope = 'single-target' | 'direct-entries'

// 改
export type ReadPermitScope = 'single-target' | 'direct-entries' | 'subtree'
```

| scope | 消费者 | 语义 |
|---|---|---|
| `single-target` | probe 层的文件事实取值（`readPathFacts.ts`）；**permit facts 对 read_file/grep 单文件现状不传 scope**（`undefined`） | 绑定单个普通文件 inode + 单 fd 封闭读 |
| `direct-entries` | `list_directory` permit | 绑定目录 inode + 只列直接成员 |
| `subtree` | **grep 目录 permit（新增）** | 绑定根目录 inode + 递归读取其子树 |

> **三层 scope 取值并存，勿混淆**（§10 D6）：probe 层 `single-target` / extractor 层 `direct-entries-snapshot`（仅 list_directory）/ permit 层 `direct-entries`。本方案新增的是 **permit 层**的 `subtree`。

### 5.3 grep 目录 permit 的执行期校验

`electron/confirmation/readPermitExecutor.ts` 新增分支（插入位置：`list_directory` 分支之后、`targetKind === 'directory'` 总拒绝之前）：

```ts
if (toolName === 'grep' && target.targetKind === 'directory') {
  if (target.scope !== 'subtree' || !target.identity) return deny('permit-target-scope-mismatch', 'mechanism')
  try {
    // 防「根被换成链接」：realpath 必须等于决策时冻结的 normalizedPath
    const real = await fs.realpath(target.normalizedPath)
    if (real !== target.normalizedPath) return deny('read-directory-realpath-changed', 'mechanism')
    const stat = await fs.stat(target.normalizedPath)
    // 只绑 dev/ino/mode —— 目录的 size/mtimeMs 随子条目增删即变，不代表「内容变更」（见下方语义说明）
    if (
      !stat.isDirectory() ||
      stat.dev !== target.identity.dev || stat.ino !== target.identity.ino ||
      stat.mode !== target.identity.mode
    ) return deny('read-directory-identity-changed', 'mechanism')
    return { ok: true, path: target.normalizedPath, targetKind: 'directory' }
  } catch {
    return deny('read-directory-unavailable', 'environment')
  }
}
```

**caseId 清单（修正后）**：

| caseId | 状态 |
|---|---|
| `permit-target-scope-mismatch` | **新增** |
| `read-directory-realpath-changed` | **新增** |
| `read-directory-unavailable` | **复用既有**（list_directory catch 分支同 id，`readPermitExecutor.ts:48`，failureClass `environment`——【v3 L2 订正】） |
| `read-directory-identity-changed` | **复用既有**（`:42`，list_directory 目录分支同 id）——**不得**用文件分支的 `read-target-identity-changed`，否则同类错误在 grep 与 list_directory 上报两个 id |

> **§15.1 订正**：上游已在 list_directory 目录分支加入 realpath 校验，且失败报的是 `read-directory-identity-changed`——统一口径：**realpath 失败（grep 与 list_directory）一律报 `read-directory-realpath-changed`**（任务 C8 / AC-50），identity 变化仍报 `read-directory-identity-changed`。**【v3 L2】caseId 台账修正：2 新增**（`permit-target-scope-mismatch`、`read-directory-realpath-changed`）**+ 2 复用**（`read-directory-identity-changed`、`read-directory-unavailable`）。

**目录 identity 只绑 `dev/ino/mode` 的语义说明（修正，阻断项 B2）**：

目录的 `mtimeMs` 与 `size` 会因**任意子条目增删**而变，与文件的「mtime 变 = 内容变」语义完全不同。若照搬文件分支的 5 字段比对：

- **confirm 路径闭环必败**：敏感目录走 `confirm-every-time`（`defaultRules.ts:278`，locked），用户确认窗口内目录一旦有条目变动，执行时必中 identity 校验失败。AC-10 只验 gate 决策层，**验不到这个闭环**。
- **C1（省略 path 搜 workDir 根）命中概率极高**：本应用运行时持续向 workDir 写入（`logs/`、`sessions/<id>/`、`.agent/`）——新建会话目录等操作会改变 workDir 根的 mtime。

因此目录 permit **只绑 `dev/ino/mode`**（标识「还是那个目录 inode」），「根被换成链接」由 **I4 realpath 校验**兜底。目录内容在决策后变化**不视为违约**——这是与文件 permit 的**有意语义差异**，须在评审中确认。

**`list_directory` 既有分支一并收敛（决策：一起修，D10 → 本期纳入）**

`readPermitExecutor.ts:41` 的 list_directory 目录分支存在同样的 5 字段比对（`dev/ino/mode/size/mtimeMs`）。**「单独搞容易漏」，本期一并收敛为 `dev/ino/mode`。**

核查后的影响面：

| 项 | 事实 |
|---|---|
| 消费方 | **仅 Agent 使用**。`listDirectoryExecutor` 生产代码 2 处引用（定义 `builtinExecutors.ts:529`、经 `:2048` `createReadRegisteredTools` 间接注册——【v3 L8 行号订正】）；renderer / `toolChatLoop` 均不引用；UI 文件树走独立的 `fileIpc` / `fileTreeSync`。**注意**：测试文件（`readReadIntegration.test.ts`、`builtinExecutors.pathAlias.test.ts` 等）大量直接 import——C7 收敛 identity 字段时测试影响面按此评估 |
| lane | 四个都可用（desktop / wechat / feishu / automation） |
| 误伤窗口 | auto-allow（desktop + workdir-normal）为同 turn 毫秒级，风险低；**confirm / ask（敏感 `confirm-every-time`、系统目录 `path-system-dir-ask`、workDir 外 deny）窗口为用户思考时间，可达数十秒——期间目录条目一变即 `read-directory-identity-changed`** |
| 安全增益 | `size` 在 NTFS 上常为 0；`mtimeMs` 随子条目增删即变。**列目录不读内容**，「允许看这个目录里的名字」在确认后多一个文件名不构成风险升级 → 二者对列目录**无安全增益**。「目录被替换」由 `dev/ino` 挡住；「原位成链接」由 realpath + `fs.stat` 跟随导致的 `dev/ino` 变化挡住 |
| 测试波及 | **`readPermitExecutor.test.ts:22` 会红**——其 badPermit 用 `size: stat.size + 1` 触发 `read-directory-identity-changed`；收敛后 `size` 不再参与比对，该用例将**假绿**。必须改用 `ino: stat.ino + 1`（或 `dev`/`mode`）构造，见 §8 C7 |

> 说明：目录不返回 `fileHandle`（目录无法作为单个 fd 读取全部内容）。这是与单文件模式的**唯一**实质差异，也是 §6 敏感兜底需要补位的原因。

### 5.4 返回类型：让执行器知道搜索根类型

`readPermitExecutor.ts` 现有返回类型：

```ts
type FilePermitResolveSuccess = { ok: true; path: string; fileHandle: FileHandle }
type DirectoryPermitResolveSuccess = { ok: true; path: string }
```

**改**：给两者加 `targetKind` 判别字段，避免执行器再 `stat` 一次（也避免二次 TOCTOU）：

```ts
type FilePermitResolveSuccess = { ok: true; path: string; targetKind: 'file'; fileHandle: FileHandle }
type DirectoryPermitResolveSuccess = { ok: true; path: string; targetKind: 'directory' }
```

grep 重载签名同步扩展：

```ts
// 原
export function resolveReadPermitTarget(toolName: 'read_file' | 'grep', ...): Promise<FilePermitResolveSuccess | PermitResolveFailure>
// 改
export function resolveReadPermitTarget(toolName: 'read_file' | 'grep', ...): Promise<FilePermitResolveSuccess | DirectoryPermitResolveSuccess | PermitResolveFailure>
```

**连带影响**：`list_directory` 分支（现返回 `{ ok: true, path: target.normalizedPath }`）需补 `targetKind: 'directory'`；`readPermitExecutor.test.ts` 中 `resolves.toEqual({ ok: true, path: dir })` 断言需同步更新。

### 5.5 无 fileHandle 的执行路径（执行层几无改动）

`builtinExecutors.ts` 现有代码已支持：

```ts
permitFileHandle ? { fileHandle: permitFileHandle, platform: process.platform } : undefined
```

以及 `grepWithRg` 内：

```ts
rgArgs.push(stableFileOnWindows ? '-' : openedFileFd !== undefined ? '/dev/fd/3' : searchPath)
```

目录时 `permitFileHandle` 为 `undefined` → `openedFileFd === undefined` → **直接把 `searchPath`（目录）交给 rg**。这正是原生递归入口。

`grepFallbackJs` 同样已就绪：`st.isFile() ? scanFile(absSearch,false) : await walk(absSearch)`。

**唯一需要处理的是 TypeScript 类型收窄**：

```ts
// 原
absSearch = permitted.path
permitFileHandle = permitted.fileHandle
// 改
absSearch = permitted.path
permitFileHandle = permitted.targetKind === 'file' ? permitted.fileHandle : undefined
```

**「执行层几无改动」的边界（修正，M2）**：上述结论对**解析逻辑**成立（stdout 直传，仅按行截断），但对**输出契约不成立**：

| 场景 | rg 路径 | walk 路径（降级） |
|---|---|---|
| **目录模式** | 搜索根**绝对路径**前缀（搜索根参数为绝对路径） | `path.relative(workDir, full)` → **相对路径**；workDir 外得 `../../` 形态 |
| **单文件模式** | **绝对路径**（`mapOpenedFileGrepOutput` 映射为 `permitted.path`） | **相对路径**（同一个 `rel`，`scanFile` 无模式区分） |

**两引擎在两种模式下都不一致**（rg 绝对 / walk 相对）——除 D5 已登记的 glob 语义差异外，这是第二处口径分歧。

**决策：统一为绝对路径（选项 B）。**【2026-10-01 阶段 I 重审：本决策已推翻，改为「workDir 内相对、workDir 外绝对」，见 §7.11 子项 1 / §10 D12；以下保留为历史论证】依据：

1. **单文件模式的 rg 路径现状已是绝对路径**——目录模式走 rg 时天然一致，无需改动；
2. **walk 侧改动可控但需解耦**：`rel` 同时承担 glob 匹配输入与输出显示两个用途，须保留前者、新增 `displayPath` 供后者（详见下方「walk 路径改动」）；
3. 选「相对路径」方案需对 **rg 输出做后处理**（从 `path:line:content` 中切出路径），Windows 盘符含 `:` 会引入解析风险，**代价高而收益仅是「对齐一个从未约定过的形态」**。

**`displayPath` 的取值范围决策（N1 连带项）**：**一律取绝对路径**（目录 + 单文件，不分模式）。

| 选项 | 后果 |
|---|---|
| **一律绝对（采用）** | 目录模式对齐（AC-20b）；**单文件模式的 walk 降级输出也由相对变绝对**——顺手消除该场景的两引擎不一致（D5 的一半） |
| 仅目录模式绝对 | 需给 `scanFile` 增加模式参数；保留一个从未被测试或 AC 约定的历史形态，复杂度换来的收益仅为「少一处行为变更」 |

**必须显式登记的连带行为变更**：单文件 + walk 降级路径的输出路径**由相对变为绝对**。现状**无任何测试断言、无 AC 覆盖**该形态（`grepFallback.test.ts` 的两处路径断言 `:74`/`:101` 均为目录模式调用），故此变更若不登记会**静默发生**。已在 §7.8 与 AC-18 显式登记（非回归，属有意变更）。

**walk 路径改动（§7.6 改动 6）——⚠️ 不能只改一行，须解耦「glob 输入」与「输出显示」**

`rel` 在 `scanFile` 里**有两个用途**（`builtinExecutors.ts:1451-1453`）：

```ts
const rel = path.relative(workDir, full)
if (!matchesGlob(rel, applyGlob)) return   // ① glob 匹配输入——必须是相对路径
```

② 输出显示（`filesWithMatches.push(rel)` `:1497`、`counts.set(rel, matches)` `:1500`、`scanContentLines(rel, …)` `:1489`、`skippedFiles.push({ path: rel })` `:1466`、`noteReadError(rel)` `:1459/:1481`）。

**若直接 `rel → full`，glob 匹配（`*.ts`、`**/*.ts`）将全部失效。** 正确改法是**新增显示路径、保留 glob 输入**：

```ts
async function scanFile(full: string, applyGlob: boolean): Promise<void> {
  const rel = path.relative(workDir, full)   // 保留：glob 匹配输入（不得改）
  if (!matchesGlob(rel, applyGlob)) return
  const displayPath = full                    // 新增：输出显示路径（绝对，与 rg 一致）
  ...
  noteReadError(displayPath)                  // 以下输出点全部改用 displayPath
  skippedFiles.push({ path: displayPath, bytes: size, reason: 'too_large' })
  scanContentLines(displayPath, text)         // / scanContentMultiline 同理
  filesWithMatches.push(displayPath)
  counts.set(displayPath, matches)
}
```

**同时须一致处理的另两处**：

- `walk()` 内 `noteReadError(path.relative(workDir, dir) || '.')`（`:1591`）——边界摘要的读错误目录，改 `dir`
- `listDirectoryExecutor` 的 `path: path.relative(root, p) || '.'`（`:492`）**不在本方案范围**（属 list_directory 输出，独立议题）

> 该改动影响 `files_with_matches` / `count` / `content` 三种输出模式。**核对两引擎**：rg 侧搜索根已传绝对路径，故天然为绝对；walk 侧改后一致。**glob 语义不受影响**（rg 用 `--glob`、walk 用 `matchesGlob`，输入均为相对路径）。须补两条断言：路径形态一致（AC-20b）与 **glob 仍生效**（AC-20c）。

### 5.6 验收

- AC-04：`ReadPermitScope` 含 `'subtree'`。
- AC-05：grep 目录 permit 在根目录 identity（`dev/ino/mode`）变化时返回 **`read-directory-identity-changed`**（与 list_directory 同 id，测试）。
- AC-06：grep 目录 permit 在根目录 realpath 与冻结值不符时返回 `read-directory-realpath-changed`（测试）。
- AC-07：`scope !== 'subtree'` 的目录 permit 传 grep 返回 `permit-target-scope-mismatch`（测试）。
- AC-08：grep 单文件路径**不产生**行为回归（既有 `grepFallback.test.ts` / `ripgrepExecutorProcess.test.ts` 全绿）。

---

## 6. 设计：敏感兜底（rg 路径 vs walk 路径）

### 6.1 两条引擎的排除手段不对等

| 引擎 | 敏感排除手段 | 覆盖面 |
|---|---|---|
| walk（`grepFallbackJs`） | `if (isSensitivePath(full)) continue` 逐条目 | 完整：含绝对前缀 `~/.ssh`、`~/Library`、userDataDir |
| rg（`grepWithRg` + `planGrepInvocation`） | `grepSensitiveExcludes()` → `--iglob '!**/.env'` 等 5 条相对模式 | 仅相对模式，**无法表达绝对前缀** |

`grepScope.ts` 注释称「由 `isSensitivePath` 的同一份规则生成」——实现上仅覆盖 `.env` / `.env.*` / `secrets` 三类，绝对前缀未覆盖。

### 6.2 为什么放开目录后仍然成立

绝对前缀（`~/.ssh` 等）在 rg 路径的暴露面只有一种：**搜索根本身位于敏感位置**。而该情形由 **zone 判定在决策时拦截**：

- `probeReadPathFact` 先 `lstat` → `realpath` → **用 realpath 结果**调 `classifyReadPathZone`
- 根为 `~/.ssh` → zone `sensitive-file` → `path-sensitive-read-confirm`（`confirm-every-time`，locked）；automation lane → `automation-sensitive-path-deny`
- 根为链接（symlink **或 junction**）指向 `~/.ssh` → `realpath` 后仍判 `sensitive-file`（zone 用 realpath 结果；两类链接的 realpath 都会解析到目标）

**根在 workDir 内普通目录**时，敏感绝对前缀天然不在搜索范围内；目录内的 `.env` / `secrets/` 由 `--iglob` 相对模式覆盖。**两条路径合起来无缺口。**

### 6.3 安全不变量（必须静态守卫）

| ID | 不变量 | 理由 |
|---|---|---|
| I1 | `rgArgs` **禁止**出现 `--follow` / `-L` | 遍历时 ripgrep 不跟随链接——**symlink 与 junction 均如此**（§13 第 9-A 组实测）；一旦跟随，「目录内链接指向敏感位置」将成为穿透路径。**该不变量对两类链接同样有效** |
| I2 | `rgArgs` **禁止**出现 `-u` / `--unrestricted` / `--no-ignore` | `-u` 会连 `.gitignore` 一起解除，超出 `include_ignored` 的语义（后者只解除 `GREP_DEFAULT_IGNORES` 名单 + 隐藏过滤） |
| I3 | 敏感排除 glob 必须经 `--iglob`（大小写无关） | `isSensitivePath` 是 lower-case 判定；`--glob` 会让 `Secrets/`、`.ENV` 绕过 |
| I4 | 目录 permit 的 `normalizedPath` 必须是 `realpath` 结果 | 决策时与执行时用同一形态比对，realpath 不一致即拒绝 |
| ~~I5~~ **已排除** | ~~walk 路径须逐条目排除 reparse point~~ | **不需要**。rg 路径：遍历中不跟随 junction（第 9-A 组）。walk 路径：Node 对 junction 报 `isDirectory() === false`、`isSymbolicLink() === true`（第 9b 组），而 `walk()` 的判定为 `if (ent.isDirectory()) … else if (ent.isFile()) …` —— **两个分支都不进，条目被整体跳过**。两条引擎均安全，无需新增实现 |

**链接的行为按「显式给定」还是「遍历中发现」区分，而非按链接类型（D9 实测修正）**

| 场景 | symlink | junction | 依据 |
|---|---|---|---|
| **显式作搜索根** | rg 进入 | rg 进入（E10） | rg 对任何显式给定的路径都直接展开 |
| **遍历中发现** | rg 不跟随 | **rg 不跟随（第 9-A 组实测）** | §13 第 9 组 |

**自我修正（D9）**：此前据 E10 记下「junction ≠ symlink，I1 不覆盖 junction」——**该推论错误**。E10 测的是「**显式**作根」，而 rg 对任何显式给定的路径都会进入（symlink 亦然），故 E10 未体现 junction 的任何特殊性。真实语义按「显式给定 / 遍历中发现」区分，而 **I1 管的正是后者，因此同时覆盖 symlink 与 junction**。据此 **I5 对 rg 路径不成立**，rg 侧不需要新增 reparse point 判定。

「根被换成链接指向敏感位置」由 **I4（realpath 校验）**覆盖：链接的 `realpath` 会解析到目标路径，与决策时冻结值不符即 `read-directory-realpath-changed`。E10 的显式根场景因此在 permit 层已被防住。

**walk 路径（回退引擎）——同样安全（第 9b 组实测）**：`grepFallbackJs` 的 `walk()` 是纯 Node 遍历，不读 rg 的规则，只有 `if (isSensitivePath(full)) continue`（只挡内置敏感前缀）。但它对链接的**类型判定**恰好构成第二道拦截：

```ts
// builtinExecutors.ts walk() —— 现状代码，无需改动
if (ent.isDirectory()) await walk(full)
else if (ent.isFile()) await scanFile(full, true)
```

Node 对 junction 报 `isDirectory() === false` 且 `isSymbolicLink() === true`，symlink 同理 → **两个分支都不匹配，链接条目被整体跳过**（既不入递归，也不被读取）。

**自我修正（D9 第 9b 组）**：此前在本文档推断「对 junction，Node 报 `isDirectory() === true`，walk 会进入」——**与实测相反**。实测为 `isDir=false isLink=true`，故 walk 会跳过。**I5 因此不成立，两条引擎均无需新增 reparse point 判定。**

### 6.4 需新增的静态守卫测试

在 `grepScopeExecutor.test.ts` 或 `toolReliabilityGuards.test.ts` 增补：

```ts
// I1
expect(rgArgsSource).not.toMatch(/--follow|'-L'|"--follow"/)
// I2 —— 须带边界：允许 --no-ignore-vcs，禁止其余 no-ignore 家族（L5）
expect(rgArgsSource).not.toMatch(/'--no-ignore'|"--no-ignore"|'-u'|"--unrestricted"/)
expect(rgArgsSource).not.toMatch(/'--no-ignore'(?!-vcs)/)
// I3
expect(rgArgsSource).toContain("'--iglob'")
```

> **I2 守卫的边界要求（L5）**：`--no-ignore-vcs` 含 `--no-ignore` 子串，朴素包含判断会误伤 G 阶段新增的合法参数。守卫须写成「精确匹配 `--no-ignore`（带闭合引号，或负向断言排除 `-vcs`）」。D6 先于 G6 落地无冲突，但同 PR 合并时需留意顺序。

### 6.5 rg 尊重 `.gitignore`：处置（D1 已采纳，改为设置项控制）

rg 默认尊重 `.gitignore`（`--no-config` 只禁用 `.ripgreprc` / `RIPGREP_CONFIG_PATH`，不禁用 ignore 文件）。故被 `.gitignore` 排除的路径不会出现在结果中，即使它不在 `GREP_DEFAULT_IGNORES` 名单内。

**处置**：由设置项 `grepSearchGitignored`（默认 `false`）控制，详见 §7.9 与阶段 G。默认值与现状一致（零回归），用户可在设置页开启。

参数选型（**已实测确认**，§13 第 2–4、8 组）：

| 参数 | 解除范围 | 是否采用 | 实测证据 |
|---|---|---|---|
| `--no-ignore-vcs` | `.gitignore` + `.git/info/exclude` + global excludes | **✓ 采用**——语义恰好等于「git 忽略的路径」 | E3 解除 `.gitignore`；E8a **不**解除 `.ignore` |
| `--no-ignore` | 上述 + `.ignore` + `.rgignore` | ✗ 越界：`.ignore` 常被用于声明「不要碰」 | E4 / E8b 明确连 `.dotignore` 一起解除 |

**一个必须写进 UI 说明的前提（E1 实测）**：rg **仅当搜索目录下存在 `.git` 时才应用 `.gitignore`**。

```
E1 无 .git 目录 → 全部命中（.gitignore 完全不生效）
E2 mkdir .git 后 → 立即只剩 3 个 tracked 文件
```

即该设置项对**非 git 仓库目录是空操作**——那里本就不忽略。UI 说明与验收（AC-34）须以此为夹具前提（测试须先建 `.git`，否则用例恒真而失去意义）。

### 6.6 验收

见 **§9.3（AC-09～AC-13b）**。本节不重复列表，以免与总表不同步。

---

## 7. 逐文件改动清单

> 所有「行号」仅为定位辅助；以符号名检索为准。

### 7.1 `src/shared/builtinToolDefinitions.ts`

| 项 | 前 | 后 |
|---|---|---|
| grep `path` description | 「必填的单个文件路径；支持相对路径和绝对路径，目录、通配路径和多路径不受支持」 | 见 §4.1 |
| grep `required` | `['pattern', 'path']` | `['pattern']` |
| grep description 首句 | 「……搜索一个明确指定的文件……不支持目录递归、通配路径或多路径输入。」 | 见 §4.2 |

### 7.2 `src/shared/policy/readPolicyV1.ts`

**按工具区分允许的 targetKind**：

```ts
// 前
if (input.hasUnsupportedPattern || !['file', 'symlink', 'missing'].includes(input.targetKind))
  return { type: 'deny', ruleId: 'read-v1-target-unsupported', reason: 'V1 仅支持单个显式文件目标' }

// 后
if (input.hasUnsupportedPattern)
  return { type: 'deny', ruleId: 'read-path-pattern-unsupported', reason: '读取目标不支持通配路径或多路径输入' }
const allowed: ReadTargetKind[] = facts.toolName === 'grep'
  ? ['file', 'directory', 'symlink', 'missing']
  : ['file', 'symlink', 'missing']
if (!allowed.includes(input.targetKind))
  return { type: 'deny', ruleId: 'read-v1-target-unsupported', reason: 'V1 仅支持单个显式文件目标' }
```

> 注意：`facts.toolName` 已在入参 `input.facts` 中，无需新增参数。

### 7.3 `electron/confirmation/extractors/runExtractors.ts`

`hasUnsupportedV1ReadTarget` **保留**（多路径与通配仍不支持），但：

1. **更新注释**，说明其职责已收窄为「标记不可表达的 path 形状」，不再是「V1 只支持单文件」。
2. **补 `directory` 不再被染 unknown 的说明**——当前实现只对通配/多路径生效，目录本就不触发，**无需逻辑改动**，但需防回归（新增测试：目录 path 不得被染成 `unknown`）。
3. `runExtractorsWithReadPathFact` 中 `rawPath` 的缺省值：

```ts
// 前
const rawPath = extractPathField(toolInput) ?? (descriptor.toolName === 'list_directory' ? '.' : '')

// 后
const rawPath = extractPathField(toolInput)
  ?? (descriptor.toolName === 'list_directory' || descriptor.toolName === 'grep' ? '.' : '')
```

**这是 C1（path 省略）的关键改动**。论证修正（**M1**）：无该改动时，grep 的 `rawPath` 为 `''`，经 `probeReadPathFact` resolve 成 **workDir 本身** → `targetKind: 'directory'` → 决策链中 `fileReadValidation`（`toolCallGate.ts:855-858`）**先于** `desktopReadValidation` 命中 → 实际 deny 为 **`read-v1-target-unsupported`**（「V1 文件读取仅支持单个普通文件目标」），而**不是** `read-v1-facts-missing`（该分支被遮蔽、永不执行）。改动方向（grep 缺省 `'.'`）仍正确且必要；B6/A5 的 RED 用例须按 `read-v1-target-unsupported` 断言。

### 7.4 `electron/confirmation/toolCallGate.ts`

**改动 1** — grep 显式路径缺省（`explicitReadPath`）：

```ts
// 前
const explicitReadPath = isListDirectoryTool ? (extractPathField(args.toolInput) ?? '.') : isReadTool ? extractPathField(args.toolInput) : undefined

// 后（grep 与 list_directory 一致，缺省视为 '.'）
const explicitReadPath = isReadTool || isListDirectoryTool ? (extractPathField(args.toolInput) ?? '.') : undefined
```

> `read_file` 仍受 schema `required: ['path']` 保护，缺省不会发生；此处放宽对 read_file 无实质影响。

**改动 2** — 拆分 `fileReadValidation` 为按工具的两条：

```ts
// 前
const fileReadValidation = (args.toolName === 'read_file' || args.toolName === 'grep') && readPathFact &&
  !(['file', 'missing'].includes(readPathFact.targetKind) || (readPathFact.targetKind === 'symlink' && readPathFact.resolvedKind === 'file'))
  ? { type: 'deny' as const, ruleId: 'read-v1-target-unsupported', reason: 'V1 文件读取仅支持单个普通文件目标' }
  : undefined

// 后
const isResolvedDirectory = readPathFact?.targetKind === 'directory' ||
  (readPathFact?.targetKind === 'symlink' && readPathFact.resolvedKind === 'directory')
const isResolvedFile = readPathFact?.targetKind === 'file' ||
  (readPathFact?.targetKind === 'symlink' && readPathFact.resolvedKind === 'file')

const fileReadValidation = args.toolName === 'read_file' && readPathFact &&
  !(['file', 'missing'].includes(readPathFact.targetKind) || isResolvedFile)
  ? { type: 'deny' as const, ruleId: 'read-v1-target-unsupported', reason: 'read_file 仅支持单个普通文件目标' }
  : undefined

// grep：文件或目录均可，missing 允许（由 permit 层报 read-target-missing）
const grepReadValidation = args.toolName === 'grep' && readPathFact &&
  !(['file', 'missing'].includes(readPathFact.targetKind) || isResolvedFile || isResolvedDirectory)
  ? { type: 'deny' as const, ruleId: 'read-v1-target-unsupported', reason: 'grep 搜索根仅支持文件或目录' }
  : undefined
```

决策链（`let decision = ...` 三目串联）中，将 `fileReadValidation` 位置替换为：

```ts
: fileReadValidation
? fileReadValidation
: grepReadValidation
? grepReadValidation
```

**改动 3** — automation 分支去掉 directory 条件：

```ts
// 前
: lane === 'automation' && isReadTool && (!readPathFact || readPathFact.targetKind === 'directory' || readHasUnsupportedPattern)
  ? { type: 'deny' as const, ruleId: 'automation-read-target-unsupported', reason: 'automation lane 仅支持显式、单目标文件读取' }

// 后
: lane === 'automation' && isReadTool && (!readPathFact || readHasUnsupportedPattern)
  ? { type: 'deny' as const, ruleId: 'automation-read-target-unsupported', reason: 'automation lane 仅支持显式、单目标文件或目录读取' }
```

> automation lane 的敏感 / 系统目录由 `automation-sensitive-path-deny` / `automation-system-dir-deny`（`locked: true`）拦截，不依赖本条。

**改动 4** — permit 签发条件与 scope 赋值（两处，`:896` 与 `:902`）：

```ts
// 抽一个局部变量，避免两处条件漂移
const directoryPermittable = isListDirectoryTool || args.toolName === 'grep'
```

条件改为 `(readPathFact.targetKind !== 'directory' || directoryPermittable)`。

**permit facts 构造**（`:902` 之后那段 `buildReadExecutionPermit`）：

```ts
// targetKind 归一：symlink→directory 也表达为 directory
const permitTargetKind = isListDirectoryTool && isResolvedDirectory ? 'directory'
  : args.toolName === 'grep' && isResolvedDirectory ? 'directory'
  : readPathFact.targetKind

// scope 分派
const permitScope: ReadPermitScope | undefined = isListDirectoryTool
  ? 'direct-entries'
  : args.toolName === 'grep' && permitTargetKind === 'directory'
    ? 'subtree'
    : undefined
```

传入 `facts[0]` 时用 `...(permitScope ? { scope: permitScope } : {})`。

**改动 5**（**与 §7.2 联动，非可选**——N2 订正）——若 `readHasUnsupportedPattern === true`，在决策链中优先产出可操作指引：

> **为何不可选**：AC-25 要求通配 path 的文案**含「glob 参数」指引**，而 `readPolicyV1.ts`（§7.2）中 `read-path-pattern-unsupported` 的 reason 是「读取目标不支持通配路径或多路径输入」，**不含指引**。含指引的文案只在本改动里。跳过它，desktop lane 的通配文案将由 `validateDesktopReadV1` 产出 → **AC-25 必挂**。它同时承担「抢先于 `unknown` 染色给出准确原因」的职责（§7.4 改动 2 依赖）。

```ts
const readPatternValidation = readHasUnsupportedPattern
  ? { type: 'deny' as const, ruleId: 'read-path-pattern-unsupported',
      reason: 'path 只接受文件或目录路径；文件名过滤请改用 glob 参数（如 glob:"*.ts"），通配路径与多路径不受支持' }
  : undefined
```

置于 `fileReadValidation` 之前（因通配被染 `unknown` 后会落到 `read-v1-target-unsupported`，需抢先给出准确原因）。

### 7.5 `electron/tools/grepScope.ts`

`planGrepInvocation` 增加 `searchKind`，修复 §1.4 的虚报：

```ts
export function planGrepInvocation(opts: {
  workDir: string
  searchPath: string
  args: Pick<GrepExecArgs, 'includeIgnored'> & { glob?: string }
  engine?: 'ripgrep' | 'walk'
  /** 新增：搜索根类型。'file' 时不产目录忽略 glob 与 skipped 统计 */
  searchKind?: 'file' | 'directory'
}): GrepInvocationPlan
```

`searchKind === 'file'` 时：

```ts
skipped: []            // 不再 existsSync(workDir/node_modules) 等，修复 §1.4 虚报
ignoreGlobs: []        // 文件根无遍历语义；且 rg 的 glob 对显式文件参数本就不生效
hidden: 保持原判定      // 显式文件参数不受 hidden 过滤影响，保持原逻辑避免引入新差异
sensitiveExcludes: 保持 gargs.explicitSensitiveHit 逻辑不变
```

`searchKind` 缺省为 `'directory'`（保持既有调用点语义不变）。

**同时修复 walk 路径的同一问题**：`grepFallbackJs` 的 `assemble()` 在单文件模式下 `skippedTotal` 恒为 0，无虚报；但 `grepExecutor` 的降级分支调用 `planGrepInvocation(..., engine:'walk')` 时同样需传 `searchKind`。

### 7.6 `electron/tools/builtinExecutors.ts`

**改动 1** — 类型收窄（§5.5）：

```ts
permitFileHandle = permitted.targetKind === 'file' ? permitted.fileHandle : undefined
```

**改动 2** — 三处 `planGrepInvocation` 调用点**全部**需处理（修正，阻断项 B1）：

`builtinExecutors.ts` 中实际有 **3 处**调用，方案原稿只列了 2 处，遗漏的正是**驱动 rgArgs 的那一处**：

| 调用点 | 位置 | 作用 |
|---|---|---|
| **`grepWithRg` 内部** | **`:1188`** | **产出真正驱动 `rgArgs` 的 plan**（`--hidden`、`--iglob`、`--no-ignore-vcs` 均消费它）——**原稿遗漏** |
| `grepExecutor` 降级分支 | `:1711` | 产出 walk 引擎的 plan |
| `grepExecutor` rg 分支 | `:1779` | 产出用于 **searchScope 输出**（skipped 统计）的 plan |

**改为「一次规划、两处消费」的透传形态**（`grepWithRg` 签名向后兼容）：

```ts
// grepWithRg 签名增加透传参数（可选，缺省保持原语义）
export async function grepWithRg(
  binaryPath: string, workDir: string, searchPath: string, pattern: string,
  args: GrepExecArgs, timeoutMs: number, signal: AbortSignal,
  onProgress: (msg: string) => void,
  spawnProcess = spawn, killer = processTreeKiller, openedFile?: {...}, onTerminate?: (...) ,
  planOverrides?: { searchKind?: 'file' | 'directory'; searchGitignored?: boolean }   // 新增
): Promise<RipgrepRunResult> {
  ...
  // :1188 —— 原为 planGrepInvocation({ workDir, searchPath, args })
  const plan = planGrepInvocation({ workDir, searchPath, args, ...planOverrides })
```

> **§15.3 订正**：新 main 的 `grepWithRg` 实际签名为 `(..., spawnProcess, openedFile?, killer?, onTerminate?)`——**`openedFile` 与 `killer` 位置互换**；`planOverrides` 作为尾参追加的方式不变，调用点实参序列按现行签名核对。

`grepExecutor` 侧：计算一次 `searchKind` 与 `searchGitignored`，三处调用点统一传：

```ts
const searchKind = permitted.targetKind === 'directory' ? 'directory' : 'file'
const planOverrides = { searchKind, searchGitignored: ctx.toolsConfig.grepSearchGitignored }
// :1711
planGrepInvocation({ workDir: ctx.workDir, searchPath: absSearch, args: gargs, engine: 'walk', ...planOverrides })
// :1779
planGrepInvocation({ workDir: ctx.workDir, searchPath: absSearch, args: gargs, ...planOverrides })
// :1752 调 grepWithRg 时追加最后一个实参
grepWithRg(..., ctx.grepSpawnProcess, processTreeKiller,
  permitFileHandle ? { fileHandle: permitFileHandle, platform: process.platform } : undefined,
  onTerminate, planOverrides)
```

> **明确输出契约**：进入 `formatGrepNoMatchOutput` 的是 **`:1779` 的 plan**（`searchScope` 输出），`:1188` 的 plan 只驱动 rgArgs。两者**必须由同一组 `planOverrides` 产出**，否则 rg 实际行为与对外报告的范围会不一致。

**改动 3** — ~~`grepWithRg` 无需改动~~ **（原表述错误，已删）**：`grepWithRg` 需按上一节增加 `planOverrides` 透传。`openedFile` 缺省时直传 `searchPath` 这一点确实无需改动。

**改动 4** — `grepFallbackJs` **无需改动**（递归分支已就绪）。

**改动 5** — 清理 `const relPath = extractPathField(input) ?? ''`（`:1671` 附近）：确认无下游引用后删除，或补注释说明其为遗留。**实施前必须 `rg -n "relPath" electron/tools/builtinExecutors.ts` 核实。**

### 7.7 `electron/confirmation/readExecutionPermit.ts`

```ts
export type ReadPermitScope = 'single-target' | 'direct-entries' | 'subtree'
```

`buildReadExecutionPermit` 的校验逻辑**无需改动**（它只校验 factId 唯一性、ruleId 一致性、路径为绝对路径，不约束 scope 取值）。

### 7.8 测试文件改动汇总

| 文件 | 改动 |
|---|---|
| `src/shared/policy/readPolicyV1.test.ts` | `directory` 从「fail closed」用例移出，新增「grep + directory 通过」「read_file + directory 拒绝」两条 |
| `electron/confirmation/readPermitExecutor.test.ts` | `list_directory` 断言补 `targetKind: 'directory'`；新增 grep subtree 三组用例（identity 变化 / realpath 变化 / scope 不符） |
| `electron/confirmation/toolCallGate.test.ts` | 新增「grep 目录 auto-allow 产出 subtree permit」「grep 省略 path 产出 workDir subtree permit」「通配 path 报 `read-path-pattern-unsupported`」 |
| `electron/tools/grepScope.test.ts` | 新增「searchKind='file' 时 skipped 为空、ignoreGlobs 为空」 |
| `electron/tools/grepScope.test.ts`（阶段 H，§7.10） | 敏感条目统计（`kind` / `sensitive: true`）、显式点名时不产生敏感条目、单文件模式恒空、`explicit` 字段移除、文案 `(sensitive, not searched)` 分支可达 |
| `electron/tools/ripgrepExecutorProcess.test.ts` 等（阶段 I，§7.11） | searchScope 序列化瘦身（常态默认值省略、`skippedCount` 移除）、超长行两引擎一致性（行首截断 / 显示列宽口径）、路径相对化形态（workDir 内外 / 单文件映射 / `./` 前缀剥离 / glob 不回退） |
| `electron/tools/grepFallback.test.ts` | ① 新增目录递归端到端（含敏感排除、符号链接跳过）；② **更新既有相对路径精确断言为绝对路径**——`:74`（`path: 'big.txt'`）、`:101`（`path: 'big.bin'`）在 D7 后必红（**N1**）；`:90` 的 `toContain('a.txt')` 为包含断言，绝对路径下仍存活。**§15.3**：上游已重构该测试（±384 行），原行号断言不存在——按现行 `toContain` 断言形态执行，并与阶段 I6（改相对）合并处理 |
| `src/shared/builtinToolDefinitions.test.ts` | 断言 grep `required` 不含 `path` |
| `src/shared/domainTypes` 相关测试 | 断言 `mergeToolsConfig` 对缺字段的旧配置补 `grepSearchGitignored: false`（**现状无任何测试文件引用 `mergeToolsConfig`**，本行由 G2 新建，非既有保障 —— L6） |

### 7.9 `domainTypes.ts` + `grepScope.ts` + 设置 UI（D1：搜索被 Git 忽略的路径）

**改动 1 — 配置字段**

```ts
export interface ToolsConfig {
  // ...既有字段
  /** grep 是否搜索被 Git 忽略（.gitignore 等）的路径；默认 false */
  grepSearchGitignored: boolean
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  // ...
  grepSearchGitignored: false
}
```

`mergeToolsConfig` 为 `{ ...DEFAULT_TOOLS_CONFIG, ...partial }`，老配置对象缺该字段时自动取 `false`，**无需数据迁移**。

**改动 2 — `grepScope.ts` 产出**

```ts
export function planGrepInvocation(opts: {
  // ...既有入参
  /** 新增：设置项要求解除 gitignore（调用方的 include_ignored 为另一来源） */
  searchGitignored?: boolean
}): GrepInvocationPlan
```

`GrepInvocationPlan` 增 `noIgnoreVcs: boolean`：

```ts
// 生效语义为 OR：设置项是「下限」，调用方只能往「搜更多」方向偏，
// 不得用 include_ignored: false 推翻用户已开启的设置。
const noIgnoreVcs = Boolean(opts.searchGitignored) || args.includeIgnored
```

**改动 3 — `builtinExecutors.ts` 消费（含 `grepWithRg` 透传，修正 B1）**

`grepWithRg`（`:1169` 附近，`--hidden` 之前，须位于 searchPath 之前）：

```ts
if (plan.noIgnoreVcs) rgArgs.push('--no-ignore-vcs')
```

**接线要点**：`plan` 来自 `grepWithRg` 内部的 `:1188` 调用——它必须拿到 `searchGitignored`，否则本改动永不生效。做法见 §7.6 改动 2 的 `planOverrides` 透传。

`grepExecutor`：三处调用点（`:1188` 经 `grepWithRg` 透传、`:1711`、`:1779`）统一使用同一组 `planOverrides`（含 `searchGitignored: ctx.toolsConfig.grepSearchGitignored`）。

**改动 4 — 设置 UI + i18n（【v3 B2 订正】展开为渲染层贯通链路清单）**

设置页「工具」分区，与 `grepTimeoutSec` 相邻；需 zh-CN / en-US 两个 locale 文案键。**新增字段贯通的渲染层链路（缺一即 typecheck:renderer 红或「未保存更改」脏检查对该开关静默失灵）**：

| 位置 | 内容 | 要求 |
|---|---|---|
| `ToolsSettingsTab.tsx:15-23` | `ToolsSettingsUi` 类型（现有 7 字段） | 增 `grepSearchGitignored: boolean`；该类型三处字面量引用随之更新 |
| `ConfigModal.tsx` 三处 | `useState<ToolsSettingsUi>` 初始字面量（`:177` 附近）、cfg→UI 装载、UI→保存映射 | 三处同步加字段，否则开关不持久化 |
| `configModalSnapshot.ts`（`components/Config/` 下） | 脏检查快照的两处 `toolUi` 逐字段映射 | **两处映射都必须含新字段**（baselineRef 比对漏项无测试拦截） |
| 测试夹具 8+ 处 | `configModalSnapshot.test.ts`（8 处硬编码完整 toolUi 字面量）、`ToolsSettingsTab.autoApprove.test.tsx`、`chatRunnerService.test.ts`、`sessionModelBinding.test.ts` 等 | 字段必填时同步补默认值 |
| i18n | zh-CN / en-US 文案键 | `npm run i18n:generate-types` |

**语义边界（须在 UI 说明与 schema 中体现）**

| 项 | 语义 |
|---|---|
| 与 `include_ignored` 关系 | **OR（单向放宽）**。任一方为真即追加 `--no-ignore-vcs`；调用方无法用 `include_ignored: false` 推翻用户设置 |
| 敏感排除 | **不受影响**。`.env` / `.env.*` / `secrets/` 走独立的 `--iglob` 组，此开关不解除（R6 承诺不变） |
| walk 路径 | `grepFallbackJs` 的 `walk` 不解析 ignore 文件，**无需改动**；既有「rg 尊重、walk 不尊重」的分歧在开关开启时反而收敛为一致 |
| `--no-ignore` 系列 | **禁止**（§6.3 I2）。此开关只追加 `--no-ignore-vcs`，不追加 `--no-ignore` / `-u` / `--unrestricted` |

### 7.10 `electron/tools/grepScope.ts`（+ `formatGrepNoMatchOutput`）——敏感条目明示义务兑现（阶段 H，2026-10-01 追加）

**背景**（§1.6）：`sensitive` 标注与 `explicit` 字段均为「承诺/预留了、实现从未兑现」的残留。本节兑现前者、删除后者。**敏感排除行为完全不变**（rg `--iglob` 组 / walk `isSensitivePath` continue 原样）——本节只补「上报」，不改「排除」。

**设计决策**：

| 项 | 决策 | 理由 |
|---|---|---|
| `skipped` 类型 | `Array<{ name: string; kind: 'file' \| 'directory'; sensitive?: boolean }>`；**删除 `explicit`** | 敏感名单混含文件（`.env`）与目录（`secrets/`），原「directories」语义容纳不下是实现绕开的根因；`explicit` 的语义已被「显式点名即解除（`isExplicitTarget` → `continue`）」完整取代且从未产出 `true` |
| 统计口径 | 目录模式（`searchKind='directory'`）对**搜索根**做一次浅层 readdir（一层），条目经敏感判定命中 → `push({ name, kind, sensitive: true })` | plan 层一处统计、两引擎天然同口径（walk 复用同一 plan，§2.3）；深层条目不逐条上报（D13，文案兜底） |
| 判定基准（【v3 M2 订正】） | 浅层统计的条目判定为**条目名模式匹配**：名 === `.env`、名以 `.env.` 开头、名 === `secrets`——与 `grepSensitiveExcludes()` 的**名称语义**对齐；**不得直接用 `isSensitivePath`**——其 secrets 判定要求两侧分隔符（`sep+secrets+sep`），对根级裸 `workDir/secrets` 不命中，而 rg 侧 `'!**/secrets'` 实际排除它，三者覆盖面本就不重合（rg glob ⊋ isSensitivePath，对根级 secrets 目录） | 防「上报了但没排除」或「排除了但没上报」；H1 的 RED 用例（根级 `.env` 文件 + `secrets/` 目录）恰好覆盖该差异，保留。排除安全性不受影响：walk 对 `secrets/` 的**内容**路径仍命中 `sep+secrets+sep`（条目级排除有效），本订正只影响 H 阶段的上报判定 |
| 开关联动 | 仅 `explicitSensitiveHit === false` 时统计 | 点名敏感路径时 `sensitiveExcludes` 为空、条目实际被搜索，不产生「未搜索」条目——与排除 glob 同一开关，名单与实际行为一致 |
| 文案 | `formatGrepNoMatchOutput` 计数词 `directories` → `items`，敏感条目走**既有** `(sensitive, not searched)` 分支 | 激活不可达分支；单一名单内联标注，不新增重复段。形如 `No matches found (searched: X; skipped 5 items: node_modules, .git, .env (sensitive, not searched), secrets (sensitive, not searched); skipped items may contain matches)` |
| status | **不新增** `no_match_with_sensitive_skips` | 敏感事实在名单内联可见即满足「不得隐瞒」；新增枚举需同步 schema/文档/测试，收益低。如评审要求一等信号，加 `scope` 内计数而非新 status 枚举 |
| `skippedCount` | 保留不动 | 派生字段瘦身（含 `engine`/`truncated` 常态值省略）不在本期范围，如需另立方案 |

**与其他改动的联动**：`searchKind='file'`（§7.5）时 `skipped` 恒空 → 敏感统计自动跳过（AC-19 不回退）；`include_ignored` / `grepSearchGitignored`（§7.9）不解除敏感排除（R6 既有承诺）→ 敏感 skipped 条目恒报、不受两者影响；搜索根本身位于敏感位置（§6.2）时 `explicitSensitiveHit=true` → 不统计，与「条目实际被搜索」自洽。

### 7.11 grep 输出上下文效率优化（阶段 I，2026-10-01 追加）

背景：grep 是 Agent 最高频的工具，其返回体形态对上下文的累积消耗此前从未作为决策变量进入评审（D12 原评审仅覆盖正确性 / 一致性 / 解析风险）。本节三项优化的共同约束：**不减少模型可获得的信息，只降低同一信息的表达成本**。三项互相独立、可单独交付。原「零 rg 输出后处理」原则保留唯一登记例外（子项 1 的 `./` 前缀窄剥离）。

**子项 1：输出路径相对化（推翻 D12 原决策，重审留痕见 §10）**

| 项 | 决策 | 理由 |
|---|---|---|
| rg 侧 | `searchPath` 在 workDir 内时改传**相对路径**（rg 进程 cwd 已为 workDir，`builtinExecutors.ts:1185` 附近）——rg 输出路径形态跟随输入形态，零输出解析 | 原决策反对的「Windows 盘符冒号解析风险」仅存在于「改输出」路线；「改输入」不触碰输出解析，原反对理由不适用 |
| 范围判定 | **workDir 内 → 相对；workDir 外 → 绝对** | `../../` 形态长且一眼分不出项目内外；绝对路径保留可读性与无歧义性 |
| `.` 根前缀 | rg 相对根输出带 `.` + 分隔符前缀（组 11c 实测 `.\cn.txt`）→ rg 侧对输出做**行首 `./`（`.\`）窄剥离，仅搜索根为 workDir 根时**；子目录根无此前缀，无需处理 | 否则 rg（`.\x`）与 walk（`x`）形态分叉；固定 2 字符字面量、无歧义——「零输出加工」的唯一登记例外 |
| walk 侧 | §5.5 的 `displayPath` 改取 `path.relative(workDir, full)`（workDir 外取原值）——与 glob 匹配输入 `rel` 同源，实现比原「一律绝对」更简 | |
| 单文件 stdin | `mapOpenedFileGrepOutput` 映射目标改相对（workDir 内时） | AC-20d 表述已随本节更新（§9.4） |
| 落地前核实 | renderer / 远程 IM 是否解析 grep output 中的路径（跳转 / 链接化）；若有，展示层以 workDir 解析相对路径 | 工具链后续调用不受影响（`read_file` 等本就接受相对路径） |
| 收益量级 | content 模式（head_limit 默认 100 行）每次约省 2000–4000 token；files_with_matches 按文件数 | 绝对路径前缀约 20–40 token/行 |

**子项 2：超长行统一「行首截断 + 明示标注」（决策登记 D14/D15）**

| 项 | 决策 | 理由 |
|---|---|---|
| 上限 | `--max-columns` 500 → **300**；rg 增推 `--max-columns-preview`（常推参数） | 500 字符 ≈ 125–250 token/行；压缩 JS / 长 JSON 行命中一次即数百 token |
| 形态 | 两引擎统一为「**行首截断 + 明示被截断**」：rg preview（组 11 实测 = 行首 + `[... omitted end of long line]`）；walk `clampLine` 同形态 | rg 原生参数即可表达，「匹配点居中」无原生支持（见否决项） |
| 计长口径 | rg 按**显示列宽**计（组 11b 实测：ASCII 1 列、东亚宽字符 2 列）；walk 由「字符数」改**显示宽度预算**（轻量宽度函数，CJK 范围 =2），按字符边界切（不产生坏字节） | 字符口径下中文行两引擎窗口长度差 2 倍；emoji 组合序列等极端形态允许偏差，登记为近似 |
| 尾缀文案 | rg 原生 `[... omitted end of long line]` / walk 保留 `[行被截断]`，**不逐字统一**（D15） | 对模型语义等价（均明示截断）；rg 文案不可定制，为文案做输出替换不值得 |
| 否决项 | 「匹配点居中窗口」：rg 无此原生参数（组 11 实测修正预设），唯一途径是程序接管 rg 输出截断（流式加工 + 多匹配 / 跨行 / 二进制边界），成本与「零输出加工」原则冲突 | 信息缺口由模型换精确 pattern / 格式化后重搜 / read_file 目标区域兜底——grep 的定位是「发现与定位」，不是「精读展示」 |
| multiline | 命中块同规则（walk 块内换行转义后截断；rg `-U` 块同受 `--max-columns` 约束） | |

**子项 3：searchScope 序列化瘦身**

| 项 | 决策 | 理由 |
|---|---|---|
| `engine` | 仅 `walk` 时输出（`ripgrep` 为常态默认值，省略即默认——JSON 通用惯例，模型熟悉） | 绝大多数调用恒为 ripgrep |
| `truncated` / `limitReason` | 仅 `truncated === true` 时输出 | 常态 `false` 无信息量 |
| `skippedCount` | **返回体形态删除**；`GrepScope` 内存类型保留（`status` 判定等内部逻辑依赖），仅序列化形态裁剪 | skipped 数组长度的派生值，模型可自行数出 |
| 契约边界 | schema 仅承诺「无匹配附带 searchScope」；字段级省略不违反承诺；no_match 与成功路径**同规则** | `root` + `skipped` 名单完整保留，范围事实无损；no_match 的文本 + JSON 双份依 §9.7b 结论保留 |
| 收益量级 | 每次调用省 10–20 token；walk / 截断场景字段照常出现 | |

---

## 8. 实施任务清单

> 全部为本地可完成任务。按 TDD：先 RED，再 GREEN，最后跑 §11 门禁。任务按依赖顺序排列。

### 阶段 A：契约与事实层（无行为变更风险）

- [x] **A1** — 修改 `src/shared/builtinToolDefinitions.ts` grep schema（§7.1）：`required: ['pattern']`、`path` description 重写、description 首句替换。
- [x] **A2** — RED：`src/shared/builtinToolDefinitions.test.ts` 加断言「grep required 不含 path」「path description 不含『单个文件路径』」。
- [x] **A3** — GREEN：A1 使 A2 通过。
- [x] **A4** — 修改 `runExtractors.ts`（§7.3）：`rawPath` 缺省对 grep 用 `'.'`；`hasUnsupportedV1ReadTarget` 注释更新。
- [x] **A5** — RED：新增用例「grep 的 path 为真实目录时 `readPathFact.targetKind === 'directory'`（不得被染 `unknown`）」「grep 省略 path 时 `rawPath` 归一到 `.`」。
- [x] **A6** — GREEN：A4 使 A5 通过。

### 阶段 B：gate 决策层

- [x] **B1** — 修改 `toolCallGate.ts` 改动 1（`explicitReadPath` 缺省，§7.4）。
- [x] **B2** — 修改 `toolCallGate.ts` 改动 2（拆分 `fileReadValidation` / `grepReadValidation`，§7.4）+ 改动 5（`readPatternValidation`）。
- [x] **B3** — 修改 `toolCallGate.ts` 改动 3（automation 分支去掉 directory 条件）。
- [x] **B4** — 修改 `toolCallGate.ts` 改动 4（`directoryPermittable`、targetKind 归一、scope 分派）。
- [x] **B5** — 修改 `src/shared/policy/readPolicyV1.ts`（§7.2 按工具区分允许 kind + 通配专用 ruleId）。
- [x] **B6** — RED：`readPolicyV1.test.ts` 更新（§7.8）+ `toolCallGate.test.ts` 新增三条（§7.8）。
- [x] **B7** — GREEN：B1–B5 使 B6 通过。
- [x] **B8** — 核实并清理 `relPath`（§7.6 改动 5）。

### 阶段 C：permit 表达力

- [x] **C1** — `readExecutionPermit.ts` 加 `'subtree'`（§7.7）。
- [x] **C2** — `readPermitExecutor.ts` 加返回类型的 `targetKind` 判别字段（§5.4），含 `list_directory` 分支补字段。
- [x] **C3** — `readPermitExecutor.ts` 加 grep 目录分支（§5.3），caseId 台账为 **2 新增**（`permit-target-scope-mismatch`、`read-directory-realpath-changed`）**+ 2 复用**（`read-directory-identity-changed`、`read-directory-unavailable`——v3 L2）；目录 identity 只绑 `dev/ino/mode`（**B2**）。
- [x] **C4** — `readPermitExecutor.ts` 调整既有 `targetKind === 'directory'` 总拒绝的位置（移到 grep 分支之后）。
- [x] **C5** — RED：`readPermitExecutor.test.ts` 更新既有断言 + 新增 grep subtree 三组用例。
- [x] **C6** — GREEN：C1–C4 使 C5 通过。
- [x] **C7** — **list_directory 目录 identity 一并收敛为 `dev/ino/mode`**（`readPermitExecutor.ts:41`，决策「一起修」）。RED：**修正 `readPermitExecutor.test.ts:22` 的 badPermit——原用 `size: stat.size + 1` 构造，收敛后将假绿，改用 `ino: stat.ino + 1`**；并新增「目录条目增删后 identity 校验仍通过」用例（对应 AC-21c）。
- [x] **C8** — 【§15.1】realpath 失败 caseId 统一：list_directory 目录分支既有的 realpath 检查（上游已加，失败现报 `read-directory-identity-changed`）收敛为 `read-directory-realpath-changed`；grep 目录分支（C3）同 id。RED：`readPermitExecutor.test.ts` 新增「list_directory 根 realpath 变化 → `read-directory-realpath-changed`」用例并核对既有断言（对应 AC-50）。

### 阶段 D：执行层与 scope 规划

- [x] **D1** — `builtinExecutors.ts` 改动 1（`permitFileHandle` 类型收窄）。
- [x] **D2** — `grepScope.ts` 加 `searchKind` 参数与 file 分支（§7.5）。
- [x] **D3** — `builtinExecutors.ts` 改动 2（**三处**调用点统一 `planOverrides`）+ `grepWithRg` 增加透传参数（**B1**）。
- [x] **D4** — RED：`grepScope.test.ts` 新增「searchKind='file' 时 skipped/ignoreGlobs 为空」。
- [x] **D5** — GREEN：D2–D3 使 D4 通过；同时验证 §1.4 的虚报消失（见 AC-14）。
- [x] **D6** — 静态守卫测试（§6.4）三条不变量。
- [x] **D7** — **walk 路径输出改为绝对路径**（§5.5 决策 B）：**解耦 glob 输入与输出显示**——保留 `rel` 供 `matchesGlob`，新增 `displayPath = full` 供 `filesWithMatches` / `counts` / `scanContentLines` / `skippedFiles` / `noteReadError` 使用（**直接改 `rel` 会致 glob 失效**）；`walk()` 内 `:1591` 一并处理。**同时更新 `grepFallback.test.ts:74`/`:101` 的既有相对路径断言为绝对**（**N1**：不改则 E3 必红）。补 AC-20b / AC-20c。

### 阶段 E：端到端与回归

- [x] **E1** — `grepFallback.test.ts` 新增目录递归端到端（敏感文件排除；**symlink 与 junction 均应被跳过**——两条引擎已实测，见 §6.3/§13）。
- [x] **E2** — 新增「grep 目录递归命中多文件」的 rg 路径端到端用例（复用 `ripgrepExecutorProcess.test.ts` 的夹具风格）。
- [x] **E3** — 回归：`grepFallback.test.ts`、`grepScope.test.ts`、`grepScopeExecutor.test.ts`、`ripgrepExecutorProcess.test.ts`、`grepAbortResponse.test.ts`、`grepChatSignal.test.ts`、`grepNormalize.test.ts`、`grepInputContract.test.ts`、`grepUnavailableMessage.test.ts` 全绿。**基线说明（N1）**：`grepFallback.test.ts` 的两处路径断言已随 D7 改为绝对（非回归失败）。
- [x] **E4** — 回归：`toolCallGate.test.ts`、`readPermitExecutor.test.ts`、`readReadIntegration.test.ts`、`readConfirmationFlow.test.ts`、`readExecutionPermit.test.ts`、`toolDecisionMatrix.test.ts` 全绿。
- [x] **E5** — 手动验证：真机执行 C1–C6 六项能力各一次，记录返回体（见 §9 证据要求）。

### 阶段 F：文档与收口

- [x] **F1** — 更新 `docs/develop/ripgrep-integration-technical-design.md` §0.1，登记「单文件契约已放开为文件/目录」的口径变更。
- [x] **F2** — 在本文件回填 §9 各 AC 的证据（测试名 / 命令输出 / 截图）。
- [x] **F3** — 在本文件登记 §10 待决项的结论。

### 阶段 G：Git 忽略路径设置项（D1，可独立交付）

> 与本方案主目标正交（动的是配置体系 + 设置 UI + i18n + 参数拼装，不碰 permit 表达力），可独立提交。

- [x] **G1** — `domainTypes.ts` 增 `grepSearchGitignored: boolean` 与默认 `false`（§7.9 改动 1）。
- [x] **G2** — RED：断言「缺该字段的旧配置经 `mergeToolsConfig` 后为 `false`」「显式 `true` 被保留」。
- [x] **G3** — GREEN：G1 使 G2 通过。
- [x] **G4** — `grepScope.ts` 增 `searchGitignored` 入参与 `noIgnoreVcs` 产出（§7.9 改动 2）。
- [x] **G5** — RED：`grepScope.test.ts` 断言「`searchGitignored: true` → `noIgnoreVcs: true`」「仅 `includeIgnored: true` → `true`」「二者皆假 → `false`」。
- [x] **G6** — `grepWithRg` 消费 `--no-ignore-vcs`（§7.9 改动 3）。
- [x] **G7** — `grepExecutor` 三处调用点（经 `grepWithRg` 透传 + `:1711` + `:1779`）统一传 `ctx.toolsConfig.grepSearchGitignored`（**B1**：漏 `grepWithRg` 则 `--no-ignore-vcs` 永不推送、AC-34/37 必红）。
- [x] **G8** — RED：扩展 §6.4 的 I2 守卫——断言「`--no-ignore-vcs` 仅在 `plan.noIgnoreVcs` 为真时出现」「`rgArgs` 不含 `--no-ignore`（**精确匹配，不误伤 `--no-ignore-vcs`**）/ `-u` / `--unrestricted`」。守卫正则须带边界（**L5**）。
- [x] **G9** — 【v3 B2 拆分】渲染层贯通：G9a 设置页 UI 控件 + i18n（zh-CN / en-US，§7.9 改动 4）→ G9b `ToolsSettingsUi` 类型 + `ConfigModal` 三处（初始/装载/保存）→ G9c `configModalSnapshot` 两处 `toolUi` 映射补字段 → G9d 测试夹具同步（`configModalSnapshot.test.ts` 8 处等）。每步后跑 `npm run typecheck:renderer`；G9c 后快照测试须含「字段翻转 → 脏检查判定有变化」用例（AC-51）。
- [x] **G10** — 修正 `include_ignored` 两处注释（§1.5），改为「解除默认忽略名单与隐藏过滤；不解除 ignore 文件（后者由 `grepSearchGitignored` 控制）」。
- [x] **G11** — 回填 §10 D7 两条待实测结论（**已完成**，见 §13 结论表）。
- [x] **G12** — RED/GREEN：AC-34 的测试夹具须先建 `.git` 目录（否则 `.gitignore` 不生效，用例恒真——§6.5 E1 实测）。
- [x] **G13** — 补 §13 第 9/9b 组实验（目录内部 junction）——**已完成**：两条引擎均跳过链接，**I5 不成立，无实现任务**（§6.3 / §10 D9）。

### 阶段 H：敏感条目明示义务兑现（§7.10，2026-10-01 追加，可独立交付）

> 与主目标正交（只动 `skipped` 名单的产出与文案，不碰 permit / gate / 排除行为），可独立提交。

- [x] **H1** — RED：`grepScope.test.ts` 新增——workDir 根级存在 `.env`（文件）与 `secrets/`（目录）时，目录模式 `plan.scope.skipped` 含两条 `sensitive: true` 条目且 `kind` 分别为 `'file'` / `'directory'`；`explicitSensitiveHit=true`（显式点名敏感路径）时不产生敏感条目；`searchKind='file'` 时 `skipped` 为空；`skipped` 条目不含 `explicit` 字段。
- [x] **H2** — GREEN：§7.10 类型改造（`kind` / `sensitive`，删 `explicit`）+ `planGrepInvocation` 浅层敏感条目统计（判定依据见 §7.10「判定基准」行——v3 M2 订正后为条目名模式匹配）。
- [x] **H3** — RED：`grepScope.test.ts` 断言无匹配文案含 `(sensitive, not searched)`（激活既有不可达分支，同步红绿验证——回退实现应转红）。
- [x] **H4** — GREEN：`formatGrepNoMatchOutput` 计数词改 `items` 并透传条目标注。
- [x] **H5** — 回归：E3 清单全绿（含 AC-19 单文件虚报回归）+ 真机验证一次「含 `.env` / `secrets/` 的工作目录无匹配返回体」（E5 风格，记录返回体作为 AC-40 证据）。

### 阶段 I：grep 输出上下文效率优化（§7.11，2026-10-01 追加，三项可独立交付）

> 子项 3（I1/I2）改动面最小、可先行；子项 1（I5/I6）依赖 §13 组 11c 的前缀剥离决策；子项 2（I3/I4）独立。

- [x] **I1** — RED：返回体序列化形态断言——成功 + rg + 无截断：searchScope 不含 `engine`/`truncated`/`skippedCount`；walk：含 `engine:'walk'`；截断：含 `truncated:true` + `limitReason`；no_match 同规则。
- [x] **I2** — GREEN：`grepExecutor` 的 data 组装按条件构造 searchScope 序列化形态（内存 `GrepScope` 类型不动，§7.11 子项 3）。**【v3 L6 措辞订正，行号再订正】**rg 成功与 no_match **共用一次组装**（`:1779-1786` 附近）、walk 降级一处（`:1731` 附近）——「三处」指 `searchScope` 输出点（`:1731`/`:1793`/`:1803`；`:1711` 是 walk 分支的 plan 调用点），组装实为两处。
- [x] **I3** — RED：静态守卫扩展（§6.4 I 系同文件）——`rgArgs` 常含 `--max-columns 300` 与 `--max-columns-preview`；`clampLine` 显示宽度口径用例（中文行按 2 列/字计）。
- [x] **I4** — GREEN：`grepWithRg` 参数更新 + walk `clampLine` 显示宽度预算截断；两引擎同一超长夹具（ASCII / 中文 / 匹配位于行中后段）输出形态一致性用例。
- [x] **I5** — RED：路径形态用例——workDir 内搜索输出相对路径（两引擎一致、无 `./` 前缀）、workDir 外输出绝对、单文件 stdin 映射相对、`glob` 过滤不受影响（AC-20c 不回退）。
- [x] **I6** — GREEN：rg 调用侧传相对 `searchPath`（workDir 内时）+ `./` 前缀窄剥离（仅 `.` 根场景）+ `mapOpenedFileGrepOutput` 相对化 + walk `displayPath` 相对化。
- [x] **I7** — 【v3 §五】核实项已提前关闭：renderer 与远程桥（feishu/wechat/remote）均**不解析** grep 输出中的路径（无 searchScope/no_match 消费点，结果按通用文本展示/回传模型）——路径相对化无展示层连带改造；本任务收窄为回归 E3 + E4 + 真机一次（E5 风格，记录改后返回体形态对照作为 AC-44～AC-49 证据）。

---

## 9. 验收标准（AC）

> 判定规则：每条 AC 必须同时满足「状态勾选」+「证据列已填写」。**未附证据的勾选视为未完成。**

> AC 编号为全局唯一编号，在各章首次给出（AC-01～03 见 §4.4、AC-04～08 见 §5.6、AC-09～13b 见 §6.6）。
> 本节为**唯一汇总表**，按编号升序呈现；各章不再重复列表，只保留一句指引。

### 9.1 契约与 schema（AC-01～AC-03）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-01 | grep schema `required` 为 `['pattern']` | `builtinToolDefinitions.test.ts` | ☑ | builtinToolDefinitions.test.ts「grep 契约放开为文件/目录递归搜索：required 不含 path」✓（提交 f91d3e60） |
| AC-02 | `path` description 不含「单个文件路径」「不支持目录递归」 | 同上 | ☑ | 同文件「grep 的 path description 不再宣称单文件契约」✓ |
| AC-03 | `src/shared/builtinToolDefinitions.test.ts` 更新并通过 | 同上 | ☑ | npx vitest run src/shared/builtinToolDefinitions.test.ts → 13 passed |

### 9.2 permit 表达力（AC-04～AC-08）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-04 | `ReadPermitScope` 含 `'subtree'` | C1 + 三处类型检查 | ☑ | readExecutionPermit.ts ReadPermitScope 含 subtree；三处类型检查全绿（AC-28 命令） |
| AC-05 | grep 目录 permit 在根 identity（`dev/ino/mode`）变化时返回 **`read-directory-identity-changed`**（与 list_directory 同 id——B3） | C5 | ☑ | readPermitExecutor.test「grep 目录 permit：identity（dev/ino/mode）变化 → read-directory-identity-changed」（与 AC-21 同源） |
| AC-06 | grep 目录 permit 在根 realpath 与冻结值不符时返回 `read-directory-realpath-changed` | C5 | ☑ | readPermitExecutor.test「grep 目录 permit：根 realpath 与冻结值不符 → read-directory-realpath-changed」（与 AC-22 同源） |
| AC-07 | `scope !== 'subtree'` 的目录 permit 传 grep 返回 `permit-target-scope-mismatch` | C5 | ☑ | readPermitExecutor.test「grep 目录 permit：scope 非 subtree → permit-target-scope-mismatch」（it.each undefined/direct-entries，与 AC-23 同源） |
| AC-08 | grep 单文件路径**不产生**行为回归 | E3 全绿 | ☑ | E3 回归：grep 系 58 passed，基线外零失败（见 §17 基线说明） |

### 9.3 安全不变量与敏感兜底（AC-09～AC-13b）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-09 | `rgArgs` 不含 `--follow`/`-L`/`-u`/`--unrestricted`/`--no-ignore`；敏感排除经 `--iglob` | D6 静态守卫 | ☑ | grepScopeExecutor.test 守卫「I1 无 --follow/-L」「I2 精确匹配 --no-ignore/-u/--unrestricted」「I3 敏感排除经 --iglob」（运行时 rgArgs 捕获） |
| AC-10 | 搜索根为敏感目录 → zone `sensitive-file` → desktop `confirm-every-time`（**须覆盖「确认→执行」闭环**：确认窗口内目录条目变动不得导致执行失败——B2） | B6 用例 + 闭环用例 | ☑ | toolCallGate.test 既有「敏感目标仍由 locked 真人确认规则优先裁决」+ readPermitExecutor「确认窗口内条目增删后执行仍成功」（AC-21b 闭环：目录只绑 dev/ino/mode） |
| AC-11 | automation lane 搜索敏感目录 → `automation-sensitive-path-deny` 拒绝 | B6 用例 | ☑ | toolCallGate.test 既有 automation-sensitive-path-deny 用例（回归确认） |
| AC-12 | 目录递归中 `.env`、`.env.*`、`secrets/` 不出现在结果 | E1 | ☑ | grepFallback.test「递归命中多文件且默认忽略/隐藏/敏感条目不出现在结果」（.env/.env.*/secrets 全断言） |
| AC-13 | 目录内 **symlink** 指向敏感目录时内容不可见 | E1 | ☑ | grepFallback.test「目录内 symlink/junction 指向敏感位置时内容不可见」（非 Windows 走 symlink 分支） |
| AC-13b | 目录内 **junction** 指向敏感目录时内容不可见（两条引擎均已实测跳过，见 §6.3；**不再依赖 D9**） | E1 | ☑ | 同上用例（Windows junction 无需特权，恒验证） |

### 9.4 能力（AC-14～AC-20）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-14 | `grep(pattern, path=<目录>)` 返回匹配结果，不再返回 `V1 文件读取仅支持单个普通文件目标` | E5 手动 + E2 端到端 | ☑ | toolCallGate「desktop read V1：目录 grep 放行并签 subtree permit」+ ripgrepExecutorProcess 真 rg「目录递归命中多文件」（node_modules 排除对照） |
| AC-15 | `grep(pattern)` 省略 path 时搜索整个 workDir | E5 手动 | ☑ | toolCallGate「grep 省略 path 按工作目录根探测并签发 subtree permit」 |
| AC-16 | `grep(pattern, path=<目录>, glob="*.ts")` 的 glob 生效（结果只含 `.ts`） | E5 手动 + 新用例 | ☑ | grepFallback「displayPath 解耦后 glob 过滤仍生效（*.ts 只留 ts）」；真机 GUI 验证留待用户（E5） |
| AC-17 | `grep(pattern, path=<目录>, include_ignored=true)` 能搜到默认忽略目录内的匹配 | E5 手动 + 新用例 | ☑ | grepFallback「include_ignored 解除默认忽略名单与隐藏过滤（敏感不解除）」+ grepScopeExecutor T-R6-2（点名解除） |
| AC-18 | `grep(pattern, path=<单文件>)` 行为与改动前一致（回归）。**例外（N1，有意变更 ×2）**：单文件 **walk 降级**路径的输出路径形态两次有意变更——阶段 D 相对→绝对（§5.5），阶段 I 绝对→相对（§7.11），均不算回归 | E3 全绿 + AC-20d | ☑ | E3 全绿；单文件 rg 主链路的 file closed 为 Windows 既有缺陷（主 checkout 并行修复中，§17） |
| AC-19 | 单文件模式返回体**不再**含 `skipped N directories`（§1.4 修复）。**H4 订正**：文案计数词已随 §7.10 改为 `skipped N items` | D4 + E5 | ☑ | grepScope「searchKind=file：skipped 恒空、ignoreGlobs 恒空」+ formatGrepNoMatchOutput 计数词 items（H4） |
| AC-20 | 目录模式「无匹配」仍带 `searchScope`（R6 承诺不退化） | E2 | ☑ | grepSearchScopeSerialization「rg no_match：searchScope 同规则省略常态字段」（no_match 必带 scope） |
| AC-20b | **两引擎（rg / walk）目录模式输出的路径形态一致**（原「均为绝对路径——决策 B」；**阶段 I 重审**：改为 workDir 内相对 / workDir 外绝对，§7.11） | D7 用例 + I5 | ☑ | grepFallback「workDir 内目录搜索输出相对路径且无 ./ 前缀」+ ripgrepExecutorProcess 真 rg AC-47 用例 |
| AC-20c | **walk 路径改相对后 `glob` 仍生效**（`*.ts` / `**/*.ts` 过滤结果不变——防「连带改坏 glob」） | D7 用例 + I5 | ☑ | grepFallback「displayPath 解耦后 glob 过滤仍生效」+「** 深层 glob 由 rg --glob 处理」（D5 已知差异不变） |
| AC-20d | **单文件 + walk 降级路径的输出为 workDir 内相对路径**（阶段 I 重审后的形态；防止该形态静默漂移） | D7 用例 + I5 | ☑ | grepFallback「单文件 walk 降级路径输出 workDir 内相对路径」 |

### 9.5 安全与边界（AC-21～AC-27、AC-27c、AC-50）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-21 | grep 目录 permit 的根 identity（`dev/ino/mode`）变化 → **`read-directory-identity-changed`**（B3） | C5 | ☑ | readPermitExecutor「grep 目录 permit：identity 变化 → read-directory-identity-changed」（与 AC-05 同源） |
| AC-21b | **确认窗口内目录条目增删后，执行仍成功**（grep 目录 permit 只绑 `dev/ino/mode`，不绑 `mtimeMs`/`size`——B2） | C5 闭环用例 | ☑ | readPermitExecutor「grep 目录 permit：确认窗口内条目增删后执行仍成功」（不绑 size/mtimeMs） |
| AC-21c | **`list_directory` 同样**：目录条目增删后 identity 校验仍通过（`readPermitExecutor.ts:41` 收敛为 `dev/ino/mode`——决策「一起修」） | C7 用例 | ☑ | readPermitExecutor「list_directory 目录条目增删后 identity 校验仍通过」 |
| AC-21d | `readPermitExecutor.test.ts` 的目录 badPermit 改用 `ino` 构造（防 `size` 不再参比后的**假绿**——C7） | C7 + code review | ☑ | badPermit 改用 mode+1 构造（实施发现：计划建议的 ino+1 在 NTFS 大 ino（>2^53）下被浮点精度吞掉——+1 恒等于原值） |
| AC-22 | grep 目录 permit 的根 realpath 变化 → `read-directory-realpath-changed` | C5 | ☑ | readPermitExecutor realpath 用例（与 AC-06 同源） |
| AC-23 | `scope !== 'subtree'` 的目录 permit → `permit-target-scope-mismatch` | C5 | ☑ | scope mismatch 用例（与 AC-07 同源） |
| AC-24 | `read_file` 传目录仍被拒（N8 不回归） | B6 用例 | ☑ | toolCallGate「desktop read V1…」内 readFileOnDir 断言（read_file 目录 → read-v1-target-unsupported，permit 不签发） |
| AC-25 | 通配 path 报 `read-path-pattern-unsupported`，文案含「glob 参数」指引 | B6 用例 | ☑ | toolCallGate 通配断言「read-path-pattern-unsupported」且 reason 含「glob 参数」 |
| AC-26 | 多路径字段（`paths` 等）仍被拒绝 | A5 / B6 | ☑ | toolCallGate 多路径字段断言「read-path-pattern-unsupported」（染 unknown 不变） |
| AC-27 | 远程 lane（wechat/feishu）搜索 workDir 外目录 → `remote-outside-read-deny` | 既有规则，回归确认 | ☑ | toolCallGate.test 既有「大小写不同的 POSIX 目录外目标…locked 拒绝」（remote-outside-read-deny，回归确认） |
| AC-27b | **automation lane + workDir 内普通目录递归搜索 = 放行**（有意能力面，M3）；敏感/系统目录仍被 `automation-sensitive-path-deny` / `automation-system-dir-deny` 拒绝 | B6 用例 | ☑ | toolCallGate「wechat/feishu/automation lane 对 workDir 内目录/省略路径 grep 放行并签 subtree permit」+ 既有 automation-sensitive/system-deny locked 用例 |
| AC-50 | list_directory 与 grep 的目录 **realpath 失败统一报 `read-directory-realpath-changed`**（消除与 identity 的 caseId 混用——§15.1） | C8 用例 | ☑ | readPermitExecutor「list_directory 根 realpath 与冻结值不符时报 read-directory-realpath-changed」（C8 统一） |
| AC-27c | 【v3 M1】**wechat/feishu lane + workDir 内普通目录递归 = 放行**（有意能力面，§3.3b）；workDir 外目录仍 `remote-outside-read-deny`（AC-27）；敏感位置仍 `path-sensitive-read-confirm`（`confirm-every-time`，locked） | B6 用例 | ☑ | 同 AC-27b 用例的 wechat/feishu 分支 + AC-27 回归（outside deny）+ 敏感 confirm（locked） |

> **【v3 L7 注】** AC-05 ≈ AC-21、AC-06 ≈ AC-22、AC-07 ≈ AC-23 为 §9.2 与 §9.5 的双登记（内容同源）——验收证据同源共用，不得两边不同步；补证据时两行同时回填。

### 9.6 工程门禁（AC-28～AC-32）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-28 | 三处类型检查全绿（renderer / electron / shared）。**【v3 B1 订正】**验证方式为 `npm run typecheck:renderer` + `npm run typecheck:shared` + `npx tsc -p tsconfig.electron.json --noEmit`——不得使用根 `tsconfig.json`（全量 include、基线即红、无脚本使用） | §11 命令 | ☑ | npm run typecheck:renderer ✓ + npm run typecheck:shared ✓ + npx tsc -p tsconfig.electron.json --noEmit ✓（exit 0） |
| AC-29 | `npm run build` 通过 | §11 命令 | ☑ | npm run build 通过（见 §17 门禁留痕） |
| AC-30 | i18n 检查通过（若涉及文案 key） | §11 命令 | ☑ | npm run i18n:check → ✅ passed（zh-CN/en-US config.json 新增 grepSearchGitignoredLabel/Hint） |
| AC-31 | `git diff --check` 无空白错误 | §11 命令 | ☑ | git diff --check 干净（方案文档 EOF 空行已修正） |
| AC-32 | E3 + E4 回归测试全绿 | §11 命令 | ☑ | E3+E4 回归：失败名单与主仓库基线 diff 逐条一致（IDENTICAL）；基线=Windows 环境 run_shell/run_script system-dir、writePathFacts POSIX、grepFallback 正斜杠/symlink 等既有失败 |

### 9.7 Git 忽略路径设置项（阶段 G，AC-33～AC-38）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-33 | 默认（`grepSearchGitignored: false`）行为与改动前逐字一致 | E3 回归 | ☑ | domainTypes.toolsConfig.test「默认 false」「缺字段补 false」+ ripgrepExecutorProcess 真 rg「设置关闭：ignored.txt 不出现」 |
| AC-34 | 设为 `true` 时，被 `.gitignore` 忽略的文件出现在结果中（夹具须先建 `.git`，否则用例恒真） | E5 手动 + 新用例 | ☑ | ripgrepExecutorProcess 真 rg「设置开启：ignored.txt 出现」（夹具先建 .git——§6.5 E1 前提） |
| AC-35 | 设为 `true` 时，`.env` / `.env.*` / `secrets/` 仍不出现在结果中 | 新用例 | ☑ | 同上用例：.env/secrets 仍不出现（敏感 iglob 组不受 --no-ignore-vcs 影响） |
| AC-36 | `include_ignored: true` 与设置项为 OR（设置项为 `false` 时仍能全解除） | G5 用例 | ☑ | grepScope「仅 includeIgnored: true → noIgnoreVcs: true」「OR 语义」 |
| AC-37 | `rgArgs` 含 `--no-ignore-vcs` 时不含 `--no-ignore` / `-u` / `--unrestricted` | G8 守卫 | ☑ | grepScopeExecutor「推送 --no-ignore-vcs 时 rgArgs 仍不含 --no-ignore/-u/--unrestricted」（it.times true/false） |
| AC-38 | `include_ignored` 注释与实现相符（不再声称对齐 `-uu`） | G10 + code review | ☑ | builtinExecutors includeIgnored 注释 + builtinToolDefinitions include_ignored schema 订正（不再声称对齐 -uu；G10 code review） |
| AC-51 | 【v3 B2】`configModalSnapshot` 对 `grepSearchGitignored` **翻转敏感**：快照映射含该字段，翻转后「未保存更改」判定生效（防脏检查静默失灵回归） | G9c 用例 | ☑ | configModalSnapshot.test「AC-51：快照对 grepSearchGitignored 翻转敏感」（翻转后快照变化、复检稳定）+ 8 处夹具补字段 |

### 9.7b 敏感条目明示义务兑现（阶段 H，AC-39～AC-43）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-39 | `GrepScope.skipped` 条目含 `kind: 'file' \| 'directory'` 与 `sensitive?: boolean`，且不含 `explicit` 字段 | H1/H2 + 类型检查 | ☑ | grepScope「skipped 条目不含 explicit 死字段」用例 + 类型改造（kind/sensitive）+ electron tsc 绿 |
| AC-40 | workDir 根级存在 `.env`（文件）与 `secrets/`（目录）时，目录模式（rg 与 walk 两引擎）无匹配返回体的名单含两条目且标注 `(sensitive, not searched)` | H1/H3 + H5 真机 | ☑ | grepScope「目录模式对根级 .env（file）与 secrets/（directory）产出 sensitive:true 条目」+ H3 文案用例「(sensitive, not searched) + skipped N items」（plan 层两引擎共用，§2.3）；真机 GUI 返回体留待用户（E5 风格） |
| AC-41 | 显式点名敏感路径（`explicitSensitiveHit=true`）时 `skipped` 不产生敏感条目（与 `sensitiveExcludes` 同开关，名单与实际行为一致） | H1 用例 | ☑ | grepScope「explicitSensitiveHit=true 时不产生敏感条目」 |
| AC-42 | 单文件模式 `skipped` 恒空——敏感统计不破坏 §1.4 修复（AC-19） | H1 用例 + E3 回归 | ☑ | grepScope「searchKind=file 时 skipped 恒空——敏感统计不破坏 §1.4 修复」 |
| AC-43 | 敏感**排除**行为不回归（`.env`、`.env.*`、`secrets/` 仍不出现在结果中——AC-12 不受本节影响，本节只补上报） | E3 回归 | ☑ | grepFallback AC-12 用例回归全绿（敏感排除行为不变，本阶段只补上报） |

### 9.7c grep 输出上下文效率优化（阶段 I，AC-44～AC-49）

| ID | 验收内容 | 验证方式 | 状态 | 证据 |
|---|---|---|---|---|
| AC-44 | 成功 + rg + 无截断的返回体 searchScope 不含 `engine`/`truncated`/`skippedCount`；walk 时含 `engine:'walk'`；截断时含 `truncated:true` + `limitReason`；no_match 同规则 | I1/I2 | ☑ | grepSearchScopeSerialization 4 用例（rg 成功/no_match/walk/walk 截断）全绿 |
| AC-45 | 超长行两引擎统一：行首 300 显示列 + 截断标注（rg preview / walk `clampLine`）；中文行窗口宽度一致（显示列宽口径） | I3/I4 | ☑ | grepFallback 中文 200 字（400 列）截断 + ASCII 290/310 边界用例；rg 侧 --max-columns 300 + preview（§13 组 11/11b 实测同形态） |
| AC-46 | `rgArgs` 常含 `--max-columns 300` 与 `--max-columns-preview`（静态守卫） | I3 | ☑ | grepScopeExecutor「rgArgs 常含 --max-columns 300 与 --max-columns-preview」 |
| AC-47 | workDir 内搜索（目录/文件）输出路径为相对 workDir 且无 `./` 前缀（rg 与 walk 一致） | I5/I6 | ☑ | ripgrepExecutorProcess 真 rg「workDir 内目录搜索：输出相对路径且无 ./ 前缀」（dump 留痕：`a.txt`+`sub\b.txt`） |
| AC-48 | workDir 外搜索输出绝对路径 | I5 | ☑ | ripgrepExecutorProcess 真 rg「workDir 外搜索根：输出绝对路径」 |
| AC-49 | 单文件 stdin 映射路径为相对（workDir 内时）；`glob` 过滤不回退（AC-20c）；I7 核实结论已登记 | I5/I6/I7 | ☑ | grepScopeExecutor T-R6-6 单文件显式文件映射相对形态（.env）；mapOpenedFileGrepOutput 随 searchPath 相对化；glob 不回退=AC-20c 用例；I7 结论=§16.4（renderer/远程桥无消费点） |

### 9.8 「任务是否完成」的判定

**本方案完成的充要条件**：§8 全部任务勾选 **且** §9 全部 AC 勾选并附证据 **且** §11 门禁命令全绿。

任一条未满足即视为未完成，不得以「核心功能已实现」为由部分交付——本方案改动集中在契约层与许可层，**部分交付会留下契约与实现对不齐的状态**（正是本方案要消除的问题）。

---

## 10. 风险与待决项

| ID | 项 | 处置 |
|---|---|---|
| ~~D1~~ **已采纳** | rg 尊重 `.gitignore`，与「搜索全目录」的直觉存在差异（§6.5） | 改为设置项 `grepSearchGitignored`（默认 `false`）控制，见 §7.9 / 阶段 G / AC-33～AC-38。默认值与现状一致，无回归 |
| D2 | 目录递归在大仓库下的耗时 | `grepTimeoutSec`（默认 60s）、`head_limit`、`--max-columns 300`（阶段 I 自 500 下调，§7.11 子项 2）均已就位；本期**不新增**索引或缓存（与需求文档 OQ-2 一致） |
| D3 | 通配 path 是否未来自动拆分为 `path` + `glob` | 本期**明确拒绝 + 指引**（N2）；自动拆分违反「不静默改变语义」，须独立评审 |
| D4 | 多路径输入 | 本期非目标（N1）；如后续需要，permit 层需支持多 target，`permit-target-count-mismatch` 的语义需重新设计 |
| D5 | walk 路径与 rg 路径在 glob 语义上的差异 | 两引擎共用 `planGrepInvocation` 的产出，但 rg 的 `--iglob` 与 walk 的 `matchGlob` 实现不同；本期不统一，登记为已知差异 |
| D6 | `readPathFact.scope` 字段在 grep 路径上仍为 `single-target`（gate 用 targetKind 判定，不读 scope） | 本期**不改** `readPathFacts.ts`（scope 是 permit 概念，探测层不应产出）；如评审要求一致性，改为在 `runExtractorsWithReadPathFact` 中按工具产出对应 scope 快照值 |
| ~~D7~~ **已实测** | `--no-ignore-vcs` 的两个行为待实测点（§13 第 2–6 组） | **① 覆盖父目录 `.gitignore`：成立**（E6a 从 `sub/` 默认仅 `tracked2.txt` → E6b 加参数后 `ignored2.txt` 出现；E6c `--no-ignore-parent` 同效）。**② 与反向 `--iglob` 叠加互不干扰：成立**（E5 中 `nm/node_modules/pkg/x.txt` 仍被 `!**/node_modules/**` 排除）。均按推断成立，无需修订 §6.5 / §7.5 |
| ~~D8~~ **已解除** | 实测受阻登记 | 已由真机实验解除：rg 14.1.1（`resources/ripgrep/win32-x64/rg.exe`）上完成 §13 第 1–8 组，夹具为全中性命名，结果见 §13 结论表。登记保留仅为追溯 |
| ~~D9~~ **已完全关闭** | junction 在目录递归中的行为（§6.3） | **rg**：遍历中不跟随 junction（第 9-A 组）。**walk**：Node 报 `isDir=false isLink=true`（第 9b 组），两个分支均不匹配 → 跳过。**I5 不成立**，无需新增实现。已修正两处错误推断 |
| ~~D10~~ **已纳入本期** | `list_directory` 既有目录分支的 identity 含 `size` + `mtimeMs`（`readPermitExecutor.ts:41`） | **决策：一起修**（「单独搞容易漏」）。收敛为 `dev/ino/mode`；核查确认 `size`/`mtimeMs` 对「列目录」无安全增益（§5.3）。连带修正 `readPermitExecutor.test.ts:22` 的假绿用例，见 §8 C7 / AC-21c / AC-21d |
| D11 | **决策-执行窗口的残余风险（接受登记，M4；§15.2 收窄）** | ① ~~降级路径不消费 permitFileHandle~~ **已被上游修复**：fallback 单文件路径消费 `stableFileHandle` 句柄封闭读 + 读前后 stat 复核；② rg / walk **目录遍历**仍只在 resolve 时校验根一次、随后自行遍历子树——残余风险收窄为仅目录模式。**本方案不解决**（permit 模型固有窗口）。**接受理由**：窗口内造成敏感泄露需同时绕过 zone 判定与「链接不跟随」，残余风险与现状单文件模式同级 |
| ~~D12~~ **原决策已被阶段 I 重审推翻** | 目录模式输出路径口径（rg 绝对路径 vs walk 相对路径，M2） | 原决策：统一绝对路径（选项 B）——仅以正确性 / 解析风险为维度，token 成本未进入决策变量。**重审（2026-10-01，阶段 I）**：改为「workDir 内相对、workDir 外绝对」——rg 输入侧相对化零解析，原「盘符冒号风险」仅适用于改输出路线；`./` 前缀窄剥离为「零输出加工」的唯一登记例外。见 §7.11 子项 1 / §8 阶段 I / AC-47～AC-49；历史论证保留于 §5.5 |
| D13 | **敏感条目统计为浅层口径（阶段 H 依附决策）**：仅搜索根直接子条目（readdir 一层），深层敏感条目被 rg `--iglob` 排除但不逐条上报；且统计对象是**搜索根**，与默认忽略名单「按 workDir 根级 existsSync」的口径不同 | 本期接受登记。理由：敏感名含通配（`.env.*`）无固定名单可 `existsSync`，逐层统计需全量 walk（成本翻倍，与「范围规划须轻量」相悖）；深层兜底由既有文案「skipped items may contain matches」承担。默认名单口径本期不动（避免范围膨胀），如需统一另立方案 |
| D14 | **超长行统一为「行首截断」（阶段 I 决策）** | rg `--max-columns-preview` 实测即「行首 + 截断标注」（组 11），原生参数即可两引擎对齐；「匹配点居中」被否决——rg 无原生参数、程序接管截断成本高，信息缺口由模型换精确 pattern / 格式化后重搜 / read_file 目标区域兜底（§7.11 子项 2） |
| D15 | **截断尾缀文案不逐字统一（阶段 I 接受登记）** | rg `[... omitted end of long line]`（不可定制）/ walk `[行被截断]`，对模型语义等价（均明示截断）；不为文案做输出替换（§7.11 子项 2） |

---

## 11. 门禁命令

```bash
# 聚焦测试（阶段 A–E 逐段落跑）
npx vitest run src/shared/builtinToolDefinitions.test.ts src/shared/policy/readPolicyV1.test.ts
npx vitest run electron/confirmation/readPermitExecutor.test.ts electron/confirmation/readExecutionPermit.test.ts electron/confirmation/toolCallGate.test.ts
npx vitest run electron/tools/grepScope.test.ts electron/tools/grepFallback.test.ts electron/tools/ripgrepExecutorProcess.test.ts electron/tools/grepScopeExecutor.test.ts

# 回归集（阶段 E）
npx vitest run electron/confirmation/ electron/tools/ src/shared/policy/

# 类型检查（【v3 B1 订正】根 tsconfig.json 为全量 include（electron+src 含测试），无脚本使用、基线即红——不得作为门禁；按项目既有口径三处）
npm run typecheck:renderer        # tsc -p tsconfig.renderer.json --noEmit
npm run typecheck:shared          # node scripts/check-shared-config-types.mjs（自定义一致性校验脚本，内部经 tsc -p tsconfig.renderer.gate.json 执行）
npx tsc -p tsconfig.electron.json --noEmit

# 构建与检查
npm run build
npm run i18n:check      # 若存在该脚本；否则跳过并在 F2 说明
git diff --check
```

> **【v3 L4 注】** vitest 配置文件实为 `vitest.config.mts`，当前为三项目（electron / renderer / renderer-perf）——上列 vitest 命令按文件路径执行、不受项目结构影响，无需改动；AGENTS.md 的配置描述已同步订正。

---

## 12. 附：改动后的 rg 参数形态对照

**单文件**

```
rg --no-config --color never --regexp <pattern> [-i] [--glob <g>] [-l|--count --with-filename|-n [-C N] [-U --multiline-dotall]]
   --max-columns 300 --max-columns-preview [--hidden] --iglob <sensitive...> /dev/fd/3     # Unix
rg ... -                                                              # Windows（stdin 传句柄内容）
```

**目录递归（本方案启用）**

```
rg --no-config --color never --regexp <pattern> [-i] [--glob <g>] [-l|--count --with-filename|-n [-C N] [-U --multiline-dotall]]
   --max-columns 300 --max-columns-preview [--hidden]
   --iglob '!**/node_modules/**' ...                                   # 未解除的默认忽略名单
   --iglob '!**/.env' '!**/.env.*' '!**/.env/**' '!**/secrets/**' '!**/secrets'
   <searchRootRel>                                                     # 搜索根：workDir 内相对 / workDir 外绝对（阶段 I §7.11 子项 1）
```

**必须不出现的参数**：`--follow`、`-L`、`-u`、`--unrestricted`、`--no-ignore`（§6.3 I1/I2）。

**条件性出现的参数**：`--no-ignore-vcs` —— 仅当 `plan.noIgnoreVcs`（设置项 `grepSearchGitignored` 与 `include_ignored` 的 OR）为真时追加（§7.9 / 阶段 G）。

**常推参数（阶段 I）**：`--max-columns 300` 与 `--max-columns-preview`——超长行「行首截断 + 明示标注」，显示列宽口径（§7.11 子项 2 / D14）。

---

## 13. 附：对照实验与实测结论（已执行）

> **执行状态：全部 12 组（1–8、9-A/9-B/9b、10）已于 2026-10-01 实测完成，D7/D9 均关闭。**
> 夹具全部为中性命名，不含任何凭据形态内容。

**夹具**

```bash
# 在任意临时目录下执行；以下路径均相对当前目录（repo 根）
mkdir -p rg-exp/repo && cd rg-exp/repo
mkdir -p build sub nm/node_modules/pkg keep
printf 'NEEDLE tracked\n'     > tracked.txt
printf 'NEEDLE ignored\n'     > ignored.txt
printf 'NEEDLE dotignore\n'   > dotignore.txt
printf 'NEEDLE build\n'       > build/a.txt
printf 'NEEDLE sub-tracked\n' > sub/tracked2.txt
printf 'NEEDLE sub-ignored\n' > sub/ignored2.txt
printf 'NEEDLE nm\n'          > nm/node_modules/pkg/x.txt
printf 'NEEDLE keep\n'        > keep/ok.txt
printf 'ignored.txt\nbuild/\nsub/ignored2.txt\nnm/node_modules/\n' > .gitignore
printf 'dotignore.txt\n'      > .ignore
git init -q
```

```bash
# 下表中 rg 代指随包 ripgrep 二进制：
#   开发态 <repo>/resources/ripgrep/<target>/rg；打包态 Contents/Resources/bin/rg
# 命令均以 . 为搜索根（当前目录即 rg-exp/repo）
```

| # | 命令（`rg` 代指随包二进制，在 `rg-exp/repo` 下执行） | 观测点 | 对应待决 |
|---|---|---|---|
| 1 | `rg --no-config --color never -l NEEDLE .` | 基线：应为 `tracked.txt`、`keep/ok.txt`、`sub/tracked2.txt` | — |
| 2 | 同上加 `--no-ignore-vcs` | **`ignored.txt`、`build/a.txt` 是否出现**；`nm/node_modules/pkg/x.txt` 是否出现；`dotignore.txt` 应仍不出现 | D7-② 主语义、参数选型 |
| 3 | 同上加 `--no-ignore` | 对照：应比 #2 更宽（含 `dotignore.txt`） | 参数选型复核 |
| 4 | 加 `--no-ignore-vcs --iglob '!**/node_modules/**'` | **`nm/...` 是否被排除**（预期排除）→ 验证与既有反向 glob 不冲突 | D7-② |
| 5 | 在 `sub/` 下分别执行默认与 `--no-ignore-vcs` | 后者是否出现 `ignored2.txt`（该条目在**父目录** `.gitignore`） | D7-① 父目录覆盖 |
| 6 | 在 `sub/` 下执行加 `--no-ignore-parent` | 对照：用于区分「层次控制」与「类别控制」 | D7-① |
| 7 | `rg --no-ignore-vcs NEEDLE ignored.txt` | 显式文件参数是否绕过 ignore | §7.5 |
| 8 | 建 junction/symlink 指向 `build/` 后作显式根 | rg 是否进入链接目标 | §6.3 I1 |
| **9** | **在 `keep/` 内建 junction 指向仓库外目录，再执行 `rg --no-ignore-vcs NEEDLE keep`** | **内部条目为 junction 时 rg 是否进入其目标**——决定 I1 是否覆盖 | **§6.3 I1 / §10 D9** |
| **9b** | 用 Node 复刻 `walk()` 的判定：`readdir(keep,{withFileTypes:true})` 打印 `link` 的 `isDirectory()` / `isSymbolicLink()` | **Node 是否把 junction 报为目录**——决定 **walk 路径**是否需要 I5 | **§6.3 I5 / §10 D9** |

**执行结果（2026-10-01 实测，rg 14.1.1 / win32-x64；对应上表各组的实际输出）**

夹具：`rg-exp/repo/` 下的 `tracked.txt`、`ignored.txt`、`build/a.txt`、`dotignore.txt`、`sub/tracked2.txt`、`sub/ignored2.txt`、`nm/node_modules/pkg/x.txt`、`keep/ok.txt`；`.gitignore` 含 `ignored.txt / build/ / sub/ignored2.txt / nm/node_modules/`，`.ignore` 含 `dotignore.txt`。

| 组 | 命令 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | 默认搜 `.`（无 `.git`） | 全部 7 项命中，含 `ignored.txt`、`build/a.txt` | **无 `.git` 时 `.gitignore` 完全不生效** |
| 2 | 同上（`git init` 后） | 仅 `tracked.txt`、`keep/ok.txt`、`sub/tracked2.txt` | `.git` 存在即启用 `.gitignore` |
| 3 | 加 `--no-ignore-vcs` | 命中 `ignored.txt`、`build/a.txt`、`nm/...x.txt`、`sub/ignored2.txt`；**不含** `dotignore.txt` | **`--no-ignore-vcs` 覆盖 `.gitignore`，不解除 `.ignore`** ✓ |
| 4 | 加 `--no-ignore` | 额外含 `dotignore.txt` | `--no-ignore` 比 `--no-ignore-vcs` 更宽 ✓ 印证选型 |
| 5 | `--no-ignore-vcs` 加 `--iglob '!**/node_modules/**'` | `nm/node_modules/pkg/x.txt` **被排除** | **与反向 glob 叠加互不干扰** ✓ D7-② |
| 5b | 仅 `--iglob '!**/node_modules/**'`（= 现状 `include_ignored` 路径） | **仅 3 个 tracked 文件** | **实锤 §1.5**：现有 `include_ignored` 搜不到 `.gitignore` 忽略的路径 |
| 6 | `cd sub` 后搜 `.`，再加 `--no-ignore-vcs` | 前者仅 `tracked2.txt`；后者出现 `ignored2.txt` | **覆盖父目录 `.gitignore`** ✓ D7-① |
| 7 | 显式点名 `ignored.txt` / `build/a.txt` / `build` | 三者**均命中** | 显式文件/目录参数**绕过** `.gitignore`；佐证 §7.5 置空 `ignoreGlobs` 的安全性 |
| 8 | `--no-ignore-vcs --hidden` / 仅 `--hidden` | 隐藏过滤与 `--no-ignore-vcs` 相互独立 | 两参数正交，互不替代 |
| 9-对照 | `type keep/link/plain.txt` | 输出 `NEEDLE_PLAIN` | junction 有效，夹具成立 |
| 9-B | 显式指向 `keep/link` 作搜索根 | 命中 `link/plain.txt`（exit=0） | **显式给定路径 rg 会进入**（symlink 亦然，非 junction 特有） |
| **9-A** | **搜根 `repo`（junction 在内部）** | **仅 `normal.txt`；不含 `link/plain.txt`（exit=0，已搜到内容，非无匹配）** | **rg 遍历中不跟随 junction** → 与 symlink 一致，**I1 覆盖，rg 路径无需 I5** |
| 9b | Node `Dirent` on junction：`readdirSync(keep,{withFileTypes:true})` | **`link isDir=false isLink=true`** | **Node 不把 junction 报为目录** → `walk()` 两个分支均不匹配 → 条目被跳过 → **walk 路径也安全，I5 不成立** |
| 10 | junction 作显式根 | **进入并命中目标内文件** | 同 9-B；**不构成 I1 缺口**（原「junction ≠ symlink」推论已作废，见 §6.3） |
| **11** | `--max-columns 40` vs 同 + `--max-columns-preview`（1000 字符行，NEEDLE 在第 580 列）；一行双匹配对照 | 前者 `1:[Omitted long matching line]`；后者 `1:<行首40字符> [... omitted end of long line]`（双匹配同样显示行首） | **preview = 行首 + 截断标注，非匹配点居中**（修正「rg preview 显示匹配附近」的预设）——「行首截断」可由 rg 原生参数表达，§7.11 子项 2 / D14 |
| **11b** | 中文行（200 汉字 + 行尾 NEEDLE）`--max-columns 100 --max-columns-preview` | 预览约 50 个汉字 + 截断标注 | `--max-columns` 按**显示列宽**计（ASCII 1 列、东亚宽字符 2 列；50×2=100 列），非字节 / 字符——walk 侧截断须按显示宽度预算对齐（§7.11 子项 2） |
| **11c** | `rg NEEDLE .`（相对根） | 输出路径前缀为 `.` + 分隔符（Windows 实测 `.\cn.txt`）；子目录根（`src`）无前缀 | 相对根输出**带 `./` 前缀**——阶段 I 取「rg 侧行首 `./` 前缀窄剥离（仅 `.` 根场景）」，为「零输出加工」的唯一登记例外（§7.11 子项 1） |

**回填状态**：D7 已填（两点均成立）；D8 已解除；**D9 已完全关闭**（第 9-A / 9b 组）——rg 与 walk 两条引擎均不进入链接。§6.3 已据第 9/9b/10 组重写链接语义，含**两处自我修正**（「junction ≠ symlink」错误推论；「Node 报 junction 为目录」错误推断）；§6.5 已补第 1–2 组的「需 `.git` 才生效」前提。**2026-10-01 补第 11/11b/11c 组**（阶段 I：超长行统一与路径相对化的参数形态依据，含一处预设修正——rg preview 为行首而非匹配点居中；一处口径修正——`--max-columns` 按显示列宽而非字节）。

---

## 14. 附录：v1 评审整改记录（2026-10-01）

> 评审报告：`docs/review/grep-recursive-search-capability-release-plan-review.md`。
> 每条均已回源码核验；**无一条为误报**，全部采纳。

### 14.1 阻断项

| 编号 | 问题 | 核验 | 整改位置 |
|---|---|---|---|
| **B1** | `grepWithRg` 内部第 3 处 `planGrepInvocation`（`:1155`，**驱动 rgArgs 的那一处**）被遗漏；§7.6「无需改动」与 §7.9「修改 grepWithRg」自相矛盾；G7 接线后 `--no-ignore-vcs` 永不推送 | `rg -n planGrepInvocation` 确认共 **3 处**（`:1155`/`:1720`/`:1807`），属实 | §7.6 改动 2（改为 `planOverrides` 透传，列全三处）、§7.6 改动 3（删错误表述）、§7.9 改动 3、§8 D3/G7 |
| **B2** | 目录 identity 比对含 `mtimeMs`（+`size`）：confirm 窗口内条目增删即执行必败；C1 场景 workDir 根 mtime 极易漂移 | `readPermitExecutor.ts:41` 确认含 5 字段，属实 | §5.3（改绑 `dev/ino/mode` + 语义说明）、§10 D10（list_directory 同问题独立登记）、AC-10/AC-21b（补闭环验收） |
| **B3** | caseId 分裂：grep 目录用文件分支的 `read-target-identity-changed`，而 list_directory 目录用 `read-directory-identity-changed` | `:42` vs `:66/:107` 确认，属实 | §5.3（改用 `read-directory-identity-changed` + 修正 caseId 清单）、§5.6 AC-05、§9.2 AC-05、AC-21 |

### 14.2 中等问题

| 编号 | 问题 | 整改位置 |
|---|---|---|
| **M1** | §7.3 论证错误：省略 path 的 deny 实为 `read-v1-target-unsupported`（`fileReadValidation` 先于 `desktopReadValidation` 命中），非 `read-v1-facts-missing` | §7.3（改写论证 + 指定 RED 断言口径） |
| **M2** | 目录模式输出路径口径：rg 绝对路径 vs walk 相对路径，未管理 | §5.5（新增边界说明 + 决策要求）、§10 D12 |
| **M3** | automation lane 能力面扩大无 AC 覆盖 | §3.3（新增决策节 + 倾向）、AC-27b；并订正 `remote-outside-read-deny` 的 lane 为三者 |
| **M4** | 决策-执行窗口残余风险未登记（walk 不消费 permit；rg 只校验根） | §10 D11（登记为接受风险，附理由） |

### 14.3 轻微订正

| 编号 | 整改 |
|---|---|
| L1 | §2.2 E5：`path-system-dir-confirm` → **`path-system-dir-ask`** |
| L2 | §2.2 E2：补 `classifyReadPathZone` 位于 `electron/confirmation/extractors/readPathFacts.ts` |
| L3 | §2.3：`grepScope.test.ts` 描述补充「另含两条文件点名用例（`.env`、`secrets/key.txt`）」 |
| L4 | §5.2：澄清三层 scope 并存（probe `single-target` / extractor `direct-entries-snapshot` / permit `direct-entries`，新增 `subtree`） |
| L5 | §6.4 I2 守卫：正则加边界，避免误伤 `--no-ignore-vcs` |
| L6 | §7.8：注明 `mergeToolsConfig` 现状无测试引用，该行由 G2 新建 |
| L7 | §2.3：`grepFallbackJs` 写法订正为 `st?.isFile?.()`（stat 失败落 walk） |

### 14.4 评审确认成立的核心论断（未改动）

§1.1 现状表、§1.4 skipped 虚报、§1.5 `include_ignored` 缺 `--no-ignore`、§2.1 限制点 1–8、§2.2 六条证据链、§2.3 执行层就绪、§2.4 需求文档冲突、§5.4 返回类型与重载签名、§7.9 基建就绪、§7.6 改动 5 的 `relPath` 死代码、17 个测试文件存在性——**全部经评审逐项核验属实，未作改动**。

### 14.5 遗留待决（评审新增）→ 全部已决策

| 项 | 结论 |
|---|---|
| D10 | **一起修**（`list_directory` 目录 identity 收敛为 `dev/ino/mode`）。核查确认 `size`/`mtimeMs` 对「列目录」无安全增益（§5.3）。连带修正 `readPermitExecutor.test.ts:22` 假绿用例 → §8 C7 / AC-21c / AC-21d |
| D12 | **统一绝对路径**。单文件现状即绝对；walk 侧须解耦 `rel`（glob 输入，保留相对）与 `displayPath`（输出，改绝对）——见 §5.5 / §8 D7 / AC-20b/20c |

### 14.6 用户决策记录（2026-10-01）

| # | 议题 | 决策 | 落点 |
|---|---|---|---|
| 一 | automation lane 是否纳入目录搜索 | **A 纳入** | §3.3 / AC-27b |
| 二 | 目录模式输出路径口径 | **B 统一绝对路径**（`displayPath` 一律绝对，含单文件 walk） | §5.5 / §8 D7 / AC-20b/20c/20d / D12 |
| 三 | `list_directory` 既有 identity 是否一并收敛 | **一起修**（「单独搞容易漏」） | §5.3 / §8 C7 / AC-21c/21d / D10 |
| 四 | 决策-执行窗口残余风险 | **登记接受，本期不处理** | §10 D11 |

### 14.7 v2 评审整改记录（2026-10-01）

> 评审报告：`docs/review/grep-recursive-search-capability-release-plan-review-v2.md`。
> 结论：v1 的 3 阻断 + 4 中等 + 7 轻微**全部闭环**；v2 新发现 1 阻断 + 2 非阻断，均已采纳。

| 编号 | 问题 | 核验 | 整改位置 |
|---|---|---|---|
| **N1** 🔴 | D7 输出绝对化打破 `grepFallback.test.ts:74`/`:101` 的既有**相对路径精确断言**，而 §7.8 只写「新增用例」、E3 要求全绿 → 门禁必红；连带**单文件 walk 输出形态静默变化**，无测试无 AC 拦截 | `:74` `path: 'big.txt'`、`:101` `path: 'big.bin'` 确为 `toMatchObject` 精确断言，且调用为目录模式（`grepFallbackJs(root, root, ...)`），属实 | §5.5（`displayPath` 一律绝对 + 显式登记连带变更）、§7.8（补更新既有断言）、§8 D7（补更新断言）、§8 E3（基线说明）、AC-18（例外）、**新增 AC-20d** |
| **N2** 🟡 | §7.4 改动 5 标「可选」，但 AC-25 依赖其文案 → 跳过必挂 | 确认 `readPolicyV1.ts` 的 reason 不含 glob 指引，属实 | §7.4 改动 5（去「可选」+ 说明为何不可选） |
| **N3** 🟢 | §5.5 对照表「单文件（现状）绝对路径」只对 rg 成立 | 属实（walk 单文件同为 `rel`） | §5.5 对照表（拆为「场景 × 引擎」两维） |

---

## 15. 附录：main 合并后核查与订正（2026-10-01）

> 背景：main 合入 64 个提交（cloud recovery 恢复系列 + queued task bar，`8dad0284..9f753bc4`），方案相关路径 114 文件（+11876/−4844），含多个 grep 与安全层提交（`a8fbd537` / `72169b23` / `3a20195a` / `1b1b7910` / `f69db8a6` 等）。
> **核查结论：方案未被抢先实施，全部关键锚点保持方案前提状态**——grep schema `required: ['pattern','path']`；`ReadPermitScope` 两档无 `subtree`；`GrepScope.skipped` 三字段形态与 `directories` 文案；`--max-columns 500`；无 `grepSearchGitignored`；gate `fileReadValidation` 合并分支与 `explicitReadPath` 原样；`hasUnsupportedV1ReadTarget`（grep 限定 + 通配/多路径检测）原样；defaultRules 五条 read 规则（`remote-outside-read-deny` / `path-sensitive-read-confirm` / `path-system-dir-ask` / `read-target-workdir-allow` / `automation-readonly-allow`）全部在；`planGrepInvocation` 仍 3 处调用点；`scanFile` 的 `rel` 双用途 / `clampLine` / `walk` 结构均在。以下为订正与实施注意。

### 15.1 订正（阻断项 B4）：realpath 失败 caseId 与 list_directory 分裂

上游已为 list_directory 目录分支新增 realpath 校验，但失败 caseId **复用** `read-directory-identity-changed`；本方案 §5.3 / AC-06 为 grep 目录 realpath 设计的是新 id `read-directory-realpath-changed`——不处理则同类失败在两工具上报两个 id（正是 v1 评审 B3 反对的分裂）。

**决策：统一为 `read-directory-realpath-changed`**（B3 精神「同类同 id」+ D10 精神「一起修」）：grep 目录分支按 §5.3 原设计；list_directory 既有 realpath 失败的 caseId 一并收敛。任务 **C8**，验收 **AC-50**。

### 15.2 订正：§10 D11 ① 已被上游修复

`grepFallbackJs` 现签名带 `stableFileHandle?: FileHandle`：单文件场景（`!applyGlob && full === absSearch`）用句柄封闭读 + 读前后 stat 双重复核——D11 ①「降级路径不消费 permit 句柄、自行读文件」不再成立；D11 ②（rg / walk 目录遍历仍只校验根一次）继续成立。残余风险登记已收窄为仅目录模式（§10 D11 行同步更新）。

### 15.3 订正：签名与测试引用漂移

| 项 | 现状（新 main） | 对方案的影响 |
|---|---|---|
| `grepWithRg` 签名 | `(..., spawnProcess, openedFile?, killer?, onTerminate?)`——**`openedFile` 与 `killer` 位置互换**（原稿基于 `spawnProcess, killer, openedFile, onTerminate`） | §7.6 / §7.9 的 `planOverrides` 尾参追加方式不变；调用点实参序列按现行签名核对 |
| `grepFallback.test.ts` | 上游重构（±384 行）：原 `:74`/`:101` 的 `toMatchObject` 相对路径精确断言已不存在，现为 `toContain('src/a.ts-1-before')` 等字符串包含断言；**walk 输出仍为相对路径** | §7.8 / §8 D7 的「更新既有相对路径断言」按现行断言形态执行，并与阶段 I6（改相对）合并处理，避免两次返工 |
| 行号 | 全面漂移（如 `--max-columns` `:1168`→`:1203`；`planGrepInvocation` 三处 `:1188`/`:1711`/`:1779`） | 重申文档头部原则：以符号检索定位，不依赖行号快照 |

### 15.4 实施期注意点（不改变方案设计）

| # | 项 | 注意 |
|---|---|---|
| ① | **输入字段别名归一化**：read 工具现接受 `filePath` / `file_path` 字段变体（`builtinExecutors.pathAlias.test.ts`，`describe('path field alias normalization')`） | 阶段 A 的 `rawPath` 缺省 `'.'`（§7.3）与 §7.4 改动 1 必须在别名解析**之后**判断——两者触碰同一段代码 |
| ② | **fallback 正则已隔离**：`grepFallbackJs` 内正则执行移入 Worker 线程（`regexWorker`，防 ReDoS 阻塞），且遍历前先验证正则（`3a20195a` / `1b1b7910`） | 阶段 H / I 对 walk 内部改动不受影响（结构已核对）；fallback 相关测试注意 Worker 环境 |
| ③ | **新增 `toolInvocationCoordinator` 编排层**：gate 决策被包进 phase 链（plan→gate→confirm→validate→execute，`hooks.decide` 即 gate 段） | 阶段 B 改 gate 决策函数本体不受影响；B6 / C5 测试可能需经 coordinator 入口，实施时确认 |
| ④ | **相邻新基建 `directoryHandleReader`**：以「子进程 cwd 作内核持有的目录引用」做目录绑定（比 realpath 更强，防路径替换重定向枚举），已用于 **list_directory（读路径）执行器**（`builtinExecutors.ts:552`）；写路径用姊妹模块 `directoryHandleWriter`（经 `safeAtomicWrite.ts` 消费）。**【v3 L1 订正】原表述「写路径执行器」有误** | 与 §5.3（realpath + `dev/ino/mode`）并存不冲突；登记可选增强——grep 目录模式可考虑 rg spawn `cwd` = 搜索根以占住 inode（与 §7.11 的 `./` 前缀剥离设计兼容），不强制 |

### 15.5 外围确认（无碍）

`buildReadExecutionPermit` 加深冻结快照（`structuredClone` + `freezeDeep`）——不冲突 §7.7「无需改动」；`resolveReadPermitTarget` 新增 `ctx.signal` 取消（新 caseId `read-permit-cancelled`）——§5.4 重载签名扩展时保持兼容；grep 已注册进 `readRegisteredTools`（`registerReadTool('grep', ...)`），`readPermitExecutor` 分支覆盖 `read_feishu_attachment` 等新工具——注册层演进不影响本方案的执行器内部改动点；E3 / E4 回归清单文件全部存在，按新基线执行。

---

## 16. 附录：v3 评审整改记录（2026-10-01）

> 评审报告：`docs/review/grep-recursive-search-capability-release-plan-review-v3.md`。评审结论：v2 问题全部闭环；新发现 2 阻断 + 2 中等 + 9 轻微，**全部采纳**。评审 §五的增量核验（§15 合并核查锚点抽查、rg `cwd: workDir`、§1.6 git 考古、C7 假绿用例、`grepWithRg` 签名订正）全部确认属实。

### 16.1 阻断项

| 编号 | 问题 | 核验 | 整改位置 |
|---|---|---|---|
| **B1** | §11 门禁命令 `npx tsc -p tsconfig.json --noEmit` 基线即红：根 tsconfig 全量 include（electron+src 含全部测试）、`module: ESNext / moduleResolution: Bundler`、**无任何脚本使用**；`typecheck:shared` 实为自定义校验脚本（`node scripts/check-shared-config-types.mjs`，内部经 tsc -p `tsconfig.renderer.gate.json` 执行，非裸 tsc 全量口径）——AC-28 按原命令永不可达 | 实测 exit=2（错误全在既有测试/setup 文件，与工作区改动无关） | §11 与 AC-28 改为项目既有口径三条：`npm run typecheck:renderer` + `npm run typecheck:shared` + `npx tsc -p tsconfig.electron.json --noEmit` |
| **B2** | 阶段 G 改动面清单不全：`grepSearchGitignored` 的渲染层贯通链路（`ToolsSettingsUi` 类型 7 字段、`ConfigModal.tsx` 三处字面量、`configModalSnapshot.ts` 两处 `toolUi` 映射、8+ 处硬编码测试夹具）未登记——typecheck 必红，或快照漏项致「未保存更改」检测静默失灵（v2 N1 同类） | `ToolsSettingsUi` 确无新字段、`ConfigModal:177` 确认 | §7.9 改动 4 展开为链路清单（含快照必须含字段的明确要求）、G9 拆分 G9a–G9d、新增 **AC-51**（快照对字段翻转敏感） |

### 16.2 中等问题

| 编号 | 问题 | 核验 | 整改位置 |
|---|---|---|---|
| **M1** | 远程 lane（wechat/feishu）目录递归放行无决策记录与 AC：`fileReadValidation` 无 lane 条件，是远程 lane 唯一目录拦截点；拆分后 wechat/feishu 的 workDir 内目录搜索自动获得能力（v1 M3 同类） | 核验属实；`remote-outside-read-deny` 只拦 outside、`path-sensitive-read-confirm`（含 wechat/feishu，locked）兜底敏感位置 | 新增 **§3.3b** 决策（纳入，比照 §3.3）+ **AC-27c**（放行 / outside-deny / sensitive-confirm 三态断言） |
| **M2** | §7.10「判定同源」前提不成立：`matchSensitive` 的 secrets 判定要求两侧分隔符（`sep+secrets+sep`，`shellSensitivePaths.ts:83`），根级裸 `secrets/` 不命中，而 rg `'!**/secrets'`（`grepScope.ts:34`）排除它——H2 按 `isSensitivePath` 实施则 AC-40 必红 | 两处源码确认，rg glob ⊋ isSensitivePath（对根级 secrets 目录） | §7.10 判定基准改为**条目名模式匹配**（与 `grepSensitiveExcludes()` 名称语义对齐）；H1 RED 用例（根级 `.env` + `secrets/`）恰好覆盖该差异、保留；排除安全性不受影响（walk 的内容路径仍命中） |

### 16.3 轻微订正（L1–L9）

| 编号 | 处置 |
|---|---|
| L1 | §15.4④ 已订正：`directoryHandleReader` 用于 **list_directory（读路径）**（`:552`）；写路径为姊妹模块 `directoryHandleWriter`（经 `safeAtomicWrite.ts` 消费） |
| L2 | §5.3 caseId 台账修正：**2 新增 + 2 复用**（`read-directory-unavailable` 实为复用 list_directory catch 分支）；C3 任务同步 |
| L3 | §7.6 / §7.9 / G7 的 `planGrepInvocation` 行号统一订正为新值（`:1188`/`:1711`/`:1779`；`grepWithRg` 调用 `:1752`）；§14.1 历史留痕保留原快照不改 |
| L4 | §11 补注：vitest 实为 `vitest.config.mts` **三项目**（electron / renderer / renderer-perf），命令按文件路径执行不受影响；AGENTS.md 配置描述已同步订正 |
| L5 | §2.2 E3 补 `~/.env`（文件前缀，`shellSensitivePaths.ts:33`） |
| L6 | 阶段 I2 措辞精确化：data 组装实为**两处**（rg 成功与 no_match 共用一次 + walk 一处），「三处」指输出点 |
| L7 | §9.5 加同源注：AC-05 ≈ AC-21、AC-06 ≈ AC-22、AC-07 ≈ AC-23 为双登记，证据同源共用、两行同时回填 |
| L8 | §5.3 影响面表行号订正（定义 `:529`、经 `:2048` `createReadRegisteredTools` 间接注册）+ 补测试文件大量直接 import 的影响面注（C7 收敛时按此评估） |
| L9 | `read-v1-target-unsupported` 同 ruleId 双文案（gate「V1 文件读取仅支持单个普通文件目标」/ `readPolicyV1.ts:8`「V1 仅支持单个显式文件目标」）系两处**有意各表**——RED 断言按「ruleId + 所在层」分别断言，不跨层复制文案 |

### 16.4 评审增量核验采纳

- **I7 前提提前关闭**：renderer 与远程桥（feishu/wechat/remote）均不解析 grep 输出路径——I7 收窄为回归 + 真机（§8 已更新）。
- **§15.4① 边界补充**：`wechat_send` / `wechat_reply` 的 `filePath` **禁止**走别名归一化（`toolPathField.ts:7-9`）——阶段 A 的 §7.3 / §7.4 改动 1 触碰同段代码时勿波及此例外。

---

## 17. 附录：实施记录与证据基线（2026-10-01，TDD 执行留痕）

> 执行环境：worktree `.worktrees/feat-grep-recursive-search`（分支 `feat/grep-recursive-search`，基于 386e04b6，后合入 main@3c8ed640）。全程按 §0 TDD：每阶段先 RED 后 GREEN，阶段收尾提交（f91d3e60 → 1d7f523a 共 9 个阶段提交 + 文档回填）。

### 17.1 实施发现（计划未预见，均已现场处置）

| # | 发现 | 处置 |
|---|---|---|
| 1 | **badPermit 的 `ino+1` 构造在 NTFS 上失效**：Windows 目录 ino（如 4.1e16）超过 `Number.MAX_SAFE_INTEGER`，`+1` 被浮点精度吞掉（`x === x+1`），C7 防假绿用例将假绿 | 改用 `mode+1` 构造（小整数，跨平台安全）；AC-21d 证据同步 |
| 2 | **forks worker 的 `process.cwd()` 不是项目根**：真 rg 端到端用例（E2/G12/I5）经 `process.cwd()` 拼 resources 路径找不到二进制，**全部静默跳过假绿** | `findRealRg` 改 `fileURLToPath(import.meta.url)` 推导仓库根 + `SA_TEST_RG_BIN` 环境变量 + 主 checkout 回退三级探测；修复后真机用例首次真正执行 |
| 3 | **块注释中的 glob 字面序列会提前终止注释**：`/* … '!**/secrets' … */` 的 `**/` 含 `*/` 子串 | 注释文本规避该序列（grepScope `isSensitiveEntryName`） |
| 4 | **walk fallback 读后复核在目录 permit 下必然 veto**：`handleStat` 无句柄时为 null → 一律判「身份变化」。目录 permit 放开（阶段 C）后暴露 | 目录身份复核改绑 dev/ino/mode（§5.3 B2 口径）；有句柄的单文件路径保持 5 字段双重复核 |
| 5 | **walk 侧 files_with_matches/count/content 目录模式截断静默无标记**：`slice`/提前停止不产生 boundary，executor 的 truncated 判定链（`已按 head_limit=` 标记）不触发 | 截断时补 boundary 提示（R6 范围透明），与 rg 侧标记同语义 |
| 6 | **junction node_modules 的 workspace symlink 漂移**：整目录 junction 到主仓库时，`@spaceassistant/*` 的 file: 依赖解析到主仓库 packages，tsc 报「同名类型双声明」 | worktree node_modules 重建为「逐项 junction + @spaceassistant 三包定向 worktree」；后改真实 `npm install` 一劳永逸 |
| 7 | **main 在执行期间前进**（386e04b6 → 3c8ed640，shell 方言修复等 8 提交） | 已合入分支（merge d038bd58）；主 checkout 工作区另有未提交的 grep 句柄修复（`file closed` → `read-target-identity-changed-during-read`），与本分支无冲突、未依赖 |

### 17.2 测试基线说明（Windows 本机环境的既有失败，与本次改动无关）

以下失败在**基线提交（未含本方案改动）同样失败**，已用 stash/对照 worktree 逐一验证；E3/E4 回归的失败名单与基线 `diff` **逐条一致（IDENTICAL）**：

- `toolCallGate.test` 8 条：run_shell/run_script「system-dir」zone 判定（POSIX 路径夹具在 Windows 的环境差异）
- `writePathFacts.test` 2 条：POSIX 绝对目标/敏感目录优先（同上）
- `grepFallback.test` 2 条：`src/a.ts` 正斜杠断言（Windows 输出反斜杠）、EPERM symlink（本机无文件 symlink 特权，junction 可用）
- `grepChatSignal.test` 1 条：Hosted turn abort（基线复现，偶发）
- `builtinExecutors.pathAlias.test` 5 条 + `readFeishuAttachmentExecutor.test` 2 条：`file closed`（rg Windows stdin 泵送后 destroy 关闭 fd，executor 事后 stat 必 EBADF）——**主 checkout 工作区的未提交修改正在修此问题**（句柄异常归入 identity-changed），本分支未依赖该修复
- `readReadIntegration.test` 3 条：同族 symlink 特权依赖

### 17.3 门禁留痕

| 门禁 | 结果 |
|---|---|
| `npx vitest run src/shared/builtinToolDefinitions.test.ts src/shared/policy/readPolicyV1.test.ts` | 全绿（13 + 10 passed） |
| `npx vitest run electron/confirmation/ src/shared/policy/` | 919 passed / 15 failed（= 基线名单） |
| `npx vitest run electron/tools/` | 667 passed / 10 failed（= 基线名单，含 17.2） |
| `npm run typecheck:renderer` | ✓ exit 0 |
| `npm run typecheck:shared` | ✓ ok |
| `npx tsc -p tsconfig.electron.json --noEmit` | ✓ exit 0 |
| `npm run i18n:check` | ✅ passed（0 in source） |
| `npm run i18n:generate-types` | 已执行（合并 main 后重生成） |
| `git diff --check` | 干净（方案文档 EOF 空行已修正） |
| `npm test`（全量） | 7510 passed / 42 failed（828 文件）；同口径五目录对照：分支 28 failed vs 基线(3c8ed640) 29 failed——**零新增失败**（基线多 1 条 flaky：grepFallback regex worker cancel），名单 diff 无分支新增项 |
| `npm run build` | ✓ exit 0（tray icon + renderer + electron + pi-ai closure check 全通过） |

### 17.4 E5/H5/I7 真机验证的替代与留待

- **已完成的真机等价验证**：真随包 rg.exe（14.1.1 win32-x64）端到端——目录递归命中多文件（AC-14）、默认忽略排除、`.gitignore`×`grepSearchGitignored` 开/关（AC-33/34/35，夹具含 `.git`）、workDir 内相对/workDir 外绝对路径形态（AC-47/48，dump 留痕）。
- **留待用户真机 GUI 操作**（无法由自动化替代）：Electron 应用内发起 `grep(pattern)` / `grep(pattern, path=<目录>)` 等 C1~C6 六项能力各一次、含 `.env`/`secrets/` 目录的无匹配返回体（AC-40 返回体原件）、设置页开关的实际点击保存。测试覆盖已等价锁定行为语义，GUI 操作仅作最终确认。
