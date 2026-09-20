# `edit_file` 单次匹配失败导致编辑链路整体降级：诊断与改进方案

> 文档日期：2026-09-20
> 文档性质：问题分析与改进方案，本次不含代码实现
> 证据来源：
> - 会话事件流 `sessions/d05fe8a7-2790-4cb6-8fe6-b18ac1b49237-20260920/events.jsonl`（57540 条事件）
> - 代码：`electron/tools/builtinExecutors.ts`、`src/shared/builtinToolMetadata.ts`、`docs/requirement/tools-requirement.md`
> - 同目录既有对照文档：`run-shell-command-failure-diagnosis-and-remediation-plan.md`（该文档处理的是 `run_shell` 侧问题，与本议题同源不同点）
>
> 修订记录：
> - **v1.0**（2026-09-20）：初版。
> - **v1.1**（2026-09-20）：依据评审 `docs/review/20260920-edit-file-match-failure-plan-review.md` 补齐 P0 规格。
>   - **B1（阻断）**：新增 §5.2.1「下发前脱敏预检」——`suggestedOldString` 必经 `sanitizeAgentText`，凡会被改写的候选一律**抑制下发**，杜绝「下发被改写建议 → 连续 3 次相同错误 → 循环中止」这一比现状更差的路径。
>   - **B2（阻断）**：§5.1 算法改为**块窗口**并统一多行语义（单行是 `L = 1` 的特例），新增 `block-too-large` 降级；消除「单行建议 + 多行 new_string」的文件损坏隐患。
>   - **O1**：`difflib` 改指自实现 **LCS + opcode 回溯**，并明确诊断与匹配器共用 EOL 归一视图。
>   - **O2**：候选不唯一时降级 `ambiguous-candidate`，不下发误导性建议。
>   - **O3**：原 §7.1 用例 2 的链路级断言移入 §7.2。
>   - **O4**：新增 `MAX_SUGGESTED_OLD_STRING_CHARS` 长度上限与超限降级。
>   - 单测用例 12 → 18 条（补多行、脱敏预检、长度上限、歧义候选、预检一致性）。
>   - **决策记录**：B1 的预检实现位置确定为**执行器侧（做法 A）**，取舍理由与备选方案见 §5.2.1「实现位置」。
>   - **v1.2**（2026-09-20）：三处收尾修订。
>     - §5.1 步骤 1 明确为**两阶段**（1a 廉价粗筛出 top-K 短名单 → 1b 仅对短名单精算 LCS），消除「逐窗口跑 LCS」在大文件上超时界的歧义；复杂度口径同步改写，O1 段落补「LCS 只对短名单计算」。
>     - §7.1 #16 断言措辞更正：原「不随文件规模线性膨胀」不可满足（扫描本身即线性）→ 改为「随文件规模**至多线性且常数有界**，且不随窗口数乘性膨胀」，并给出可操作的比值断言。
>     - §7.1 #17 引用更正：`projectGenericAgentData` **不存在** → 改为走已导出入口 `projectAgentToolResult` / `serializeAgentToolResult`；`projectGenericData` 为模块内私有，明确禁止直接引用。
>     - 常量表补 `MAX_LCS_WINDOWS`（进精算的窗口数），并在 §5.1 显式区分它与 `MAX_CANDIDATES`（歧义降级阈值）两个不同用途的阈值。
>   - **v1.3**（2026-09-20）：实施记录（分支 `feature/edit-file-diagnosis`，worktree `.worktrees/edit-file-diagnosis`）。
>     - **已落地**：Phase 1 全部（P0-A 诊断 + P0-B 建议与预检 + P1-E 提示）、P1-C（`tolerate_escape_layer` 入参，默认关闭）、P2-F1（`run_script` 描述提示）、P2-G（需求文档与工具描述同步）；Phase 2 单测 24 条（`electron/tools/builtinExecutors.editDiagnosis.test.ts`，覆盖 §7.1 的 18 场景 + 纯函数用例）+ 集成测试 2 条（`electron/toolChatLoop.editDiagnosis.integration.test.ts`：真实 tool loop 的一次修复链路 + B1 反例保护）。
>     - **实现落点**：`electron/tools/editDiagnosis.ts`（新增：块窗口两阶段粗筛/精算 + 最小 LCS/opcode 回溯 + 差异分类 + §5.2.1 预检）；`electron/tools/builtinExecutors.ts`（`occ === 0` 分支接入诊断；新增 `applyEditWithEscapeTolerance`，`applyEditWithEolTolerance` 不变；写路径护栏次序不变）。
>     - **与计划的偏差（1 处，代码内已注释说明）**：常量取值对调为 `MAX_LCS_INPUT_CHARS = 4096 > MAX_SUGGESTED_OLD_STRING_CHARS = 4000`——按本表建议值（4000/4096）时 too-long 抑制不可达（候选块先被精算守卫拦截，§7.1 #8 无法触发）；对调后两阈值语义完整。
>     - **未实施（按计划建议保留）**：P1-D（`read_file` 原始字符视图——§5.4 建议观察 P0 效果后再定）；P2-F2（`run_script` 写文件观测——§5.6 允许「二选一」，已做 F1 提示层）。

## 1. 结论摘要

目标会话中，Agent 在 4 次 `edit_file` 后**永久弃用**该工具，其后 8 次文件修改全部改用 `run_script`（Python 直接读写文件）。直接触发点是**第 4 次 `edit_file` 的唯一一次匹配失败**。

这不是「模型任性换工具」，而是四个缺陷叠加的确定性结果：

1. **目标内容本身是转义文本**（Markdown 表格里记录的正则 `(:\\s*\\(|=>)`），反斜杠是内容的一部分。
2. **工具链不提供「文件里到底有几个反斜杠」的确定性视图**：`read_file` 与 `grep` 的输出都再叠一层 JSON 转义，模型只能靠层数推算。模型在推理中反复试错（原文见 §2.4），最终**猜错一层**。
3. **匹配失败零诊断**：`edit_file` 已经算出命中数为 0（`occ === 0`），却只返回一句固定文案「未找到待替换的字符串」。它不告诉模型差异在哪个字符、差什么、附近最相似的是什么——而「差的就是 2 个反斜杠」这一条信息，足以让模型一次修正。
4. **没有恢复路径**：失败结果里没有任何「如何重试 `edit_file`」的线索，模型只能转向有写能力的另一个工具（`run_script`）——而这个转向**绕过了 `edit_file` 的四道护栏**（未读校验、磁盘一致性校验、检查点备份、原子写）。

后果是三重的：**效率损失约 45% 会话时长**、**安全护栏整体旁路**、**交付物本身被工具缺陷改写**（§4）。

本文给出按性价比排序的改进方案，其中 P0 两项（失败诊断 + 现成修正片段）改动小、不依赖模糊匹配、无安全风险，可在不引入歧义的前提下把「失败→换工具」改为「失败→一次修正后成功」。

## 2. 证据

### 2.1 会话整体画像

| 项 | 值 |
|---|---|
| 轮次 | 1 turn / 1 step / 29 轮 API 请求 |
| 时长 | 约 287 秒（`turn_start` 1789864647650 → `turn_end` 1789864934446） |
| 工具调用 | **64 次**：grep 36、**run_script 12**、read_file 7、list_directory 4、**edit_file 4**、run_shell 1 |
| 失败调用 | 3 次：`run_shell` × 1、`edit_file` × 1、`run_script` × 1（未执行） |

`edit_file` 占比极低（4/64），且全部集中在 t=+136s ~ +148s 的 12 秒窗口内；此后到会话结束**再未使用**。

### 2.2 四次 `edit_file` 的对照：唯一的反斜杠出现在唯一失败的那次

| seq | 时刻 | `old_string` 长度 | **`old_string` 中反斜杠数** | 结果 |
|---|---|---|---|---|
| 24672 | t=+136.1s | 57 | **0** | ✅ 成功 |
| 25564 | t=+139.7s | 213 | **0** | ✅ 成功 |
| 26056 | t=+142.0s | 299 | **0** | ✅ 成功 |
| **27433** | **t=+147.8s** | **244** | **2** | ❌ `未找到待替换的字符串` |

前三次 `old_string` 中反斜杠数均为 0，全部成功；唯一含反斜杠的第 4 次失败。样本量 n=1，但机制在 §2.3 被字符级证据闭环。

### 2.3 字符级定位：只差 2 个反斜杠，其余一字不差

对模型提交的 `old_string`（244 字符）与文件第 58 行真实内容（246 字符，不含行尾 `\n`）做序列比对（LCS 对齐，分析时用 `difflib` 实现），**全部差异只有 2 处，都是插入，且插入的都是反斜杠字符**：

```
[insert] submitted[184:184]=''   file[184:185]='\'      ← 文件多 1 个反斜杠
[insert] submitted[186:186]=''   file[187:188]='\'      ← 文件多 1 个反斜杠
长度：submitted = 244   file = 246   差值 = 2 = 恰好这两个反斜杠
```

对应用户可读形式（用「连续反斜杠字符个数」表述，避免转义展示混淆）：

```
文件第 58 行该处：  ... '(:  [2 个反斜杠]  s*  [2 个反斜杠]  (|=>)' src/shared/agent/invocation.ts` ...
模型提交 old_string：... '(:  [1 个反斜杠]  s*  [1 个反斜杠]  (|=>)' src/shared/agent/invocation.ts` ...
```

**没有全角/半角差异、没有空格差异、没有行尾差异、没有多行错位。** 唯一差异是反斜杠层数少一层。

> 说明：文件真实内容取自会话内 `run_script`（seq 29110）用 Python `repr` 打印的结果，再经等义还原；该 repr 是会话中唯一不依赖 JSON 转义层数的读数。

### 2.4 根因侧证：模型自己无法判别层数（推理原文）

模型在失败后的推理中完整记录了它对转义层数的反复试错。原文摘录：

> 「匹配失败。可能因为 `(:\\s*\\(|=>)` 的实际内容不同。」
> 「read_file 的 17 行显示：`rg -n '(:\\s*\\(|=>)'`；grep 的 17 行显示：`rg -n '(:\\\\s*\\\\(|=>)'`」
> 「**嗯，不同工具返回的转义层数不同。**」
> 「**那到底文件里是 `\s` 还是 `\\s`？**」
> 「read_file 与 grep 的 JSON 序列化……**容易误判**。」
> 「由于反斜杠计数容易出错，我改用不含反斜杠的 old_string 片段……或者用 run_script 直接做字符串替换（Python 更可控、可精确指定）。」

必须精确表述：**不是工具返回了错误内容**。用统一口径（对工具结果对象再做一次 `json.dumps`）复算 `read_file`(seq 303) 与 `grep`(seq 27630) 对同一行的输出，**两者层数相同**。因此问题不在「工具之间不一致」，而在于：**链路中任何一处都不提供「文件里到底有几个反斜杠」的确定性视图**，模型只能推算——而它推错了。

结论：**工具没有把"文件中该处是 2 个反斜杠"这个事实，以任何形式呈现给模型。**

### 2.5 放大器：命中数已算出 0，但只回一句固定文案

`electron/tools/builtinExecutors.ts`（`editFileExecutor`）中的确证代码：

```ts
const occ = countOccurrencesWithEolTolerance(cur, oldS)
if (occ === 0 && oldS !== '') {
  return { success: false, error: '未找到待替换的字符串', duration: Date.now() - started }
}
if (!replaceAll && oldS !== '' && occ > 1) {
  return { success: false, error: '找到多个匹配，请提供更精确的上下文或使用 replace_all', duration: Date.now() - started }
}
```

以及容差函数：

```ts
function countOccurrencesWithEolTolerance(hay: string, needle: string): number {
  return countOccurrences(normalizeLineEndingsForMatch(hay), normalizeLineEndingsForMatch(needle))
}
// normalizeLineEndingsForMatch 仅做 \r\n → \n
```

三点观察：

1. `occ === 0` 与 `occ > 1` 都是失败，但**只有 `occ > 1` 得到了可操作建议**（"提供更精确上下文 / 用 replace_all"）；`occ === 0` 得到的是零信息。
2. 容差设计上，`edit_file` **只对行尾（CRLF/LF）容差**，对反斜杠层数无任何容差——而本场景恰好命中这唯一的盲区。
3. `countOccurrences` 基础设施已具备（能算出 0），**只是没把中间结果暴露出来**。诊断所需的全部素材（文件内容、提交片段、命中数）在函数内部都是现成的。

### 2.6 失败后的完整降级链路（12 次调用，128 秒）

```
t=+147.8s  edit_file        ✗ 匹配失败（唯一一次）
t=+149.9s  grep             找上下文
t=+156.7s  run_script  29110  读文件 + 打印 repr        ← 补「看真实字符」
t=+220.8s  run_script  45491  ✗ model_output_token_limit，工具未执行（白烧约 64s）
t=+228.2s  run_script  47548  二进制读 + 查 CRLF + repr + 正则 + 写回
t=+234.9s  run_script  48748  读 + count 断言 + assert + str.replace + 写回
t=+243.3s  run_script  50645  同上
t=+253.3s  run_script  53321  同上
t=+258.8s  run_script  54211  同上
t=+262.9s  grep
t=+263.2s  read_file
t=+267.8s  run_script  55505  同上
t=+275.8s  run_script  56310  同上
```

其中 8 次 `run_script` 实际写盘（seq 47548 / 48748 / 50645 / 53321 / 54211 / 55505 / 56310，以及 seq 29110 的探查）。这些脚本各自补上了 `edit_file` 本应提供、但当时未提供的能力：

| 模型自建的能力 | 对应 `edit_file` 的哪一环 |
|---|---|
| 打印 `repr` 行 | 「看真实字符」——链路里没有任何等价物 |
| 二进制读 + 检查 `b'\r\n'` 与 BOM | `applyEditWithEolTolerance` 的 EOL 容差 |
| 每条替换 `count == 1` 断言后写盘 | `occ` 计算 + `occ > 1` 拒绝 |
| `str.replace` / 按行索引替换 | `applyEdit` |
| 读写回环 | `safeAtomicWrite` |

**从失败到该轮工具活动结束约 128 秒，占 287 秒会话的约 45%。**

### 2.7 被忽略的代价：降级绕过了四道护栏

`edit_file` 的写路径上挂着四道保护，而 `run_script` 以 Python `open()/write()` 直接在子进程里改文件，**不经过该 executor，因此四道保护全部失效**：

| 护栏 | `edit_file` 中的实现 | `run_script` 写文件 |
|---|---|---|
| 必须先读后写 | `ctx.fileStateCache.hasBeenRead(abs)` → `ERR_FILE_NOT_READ_FOR_EDIT` | ❌ 无 |
| 外部修改检测 | `assertDiskMatchesReadCache(...)` → 「文件已被外部程序修改，请重新读取后再编辑」 | ❌ 无 |
| 检查点备份 | `ctx.toolsConfig.fileCheckpointingEnabled` → `backupIfEnabled(...)` | ❌ 无 |
| 原子写 + 身份校验 | `safeAtomicWrite({ targetPath, parentReal, ..., expectedIdentity })` | ❌ 普通 `write` |

相关落点：`electron/safeAtomicWrite.ts`、`electron/tools/builtinExecutors.ts`。

即：「被迫改用脚本」的代价不只是效率，而是**并发写冲突、外部改动覆盖、无备份可回滚**三类风险全部裸奔。

### 2.8 缺失能力清单（由本次失败反推）

按会话证据，模型在失败后被迫自建了 5 项能力。其中只有 2 项属于「`edit_file` 有但没生效」，3 项属于「链路整体没有」：

| 能力 | 归属 |
|---|---|
| 行尾/BOM 保留 | `edit_file` 有（EOL 容差），但当时的失败让它不再被信任 |
| 唯一命中校验 | `edit_file` 有（`occ`），同上 |
| **编辑器可见「文件真实字符」** | **链路没有** |
| **失败原因诊断（差在哪个字符）** | **链路没有** |
| **失败后的「现成可用的修正片段」** | **链路没有** |

## 3. 根因分层

| 层 | 问题 | 证据 |
|---|---|---|
| L0 内容层 | 目标文档记录了含反斜杠的正则，反斜杠是内容的一部分 | §2.3 |
| L1 呈现层 | `read_file` / `grep` 输出均叠 JSON 转义，无「原始字符」确定性视图；模型只能推算层数 | §2.4 |
| L2 匹配层 | `edit_file` 只做行尾容差，对转义层数无容差；命中 0 即失败 | §2.5 |
| L3 诊断层 | `occ === 0` 只回固定文案，不暴露差异位置/候选/命中数 | §2.5 |
| L4 护栏层 | 降级到 `run_script` 绕过四道写保护 | §2.7 |
| L5 行为层 | 失败结果无恢复路径 → 模型一次失败即永久切换工具 | §2.6 |

**贯穿 L3→L5 的元问题**：**单次失败缺少可用诊断，模型只能换工具。** 这与 `run_shell` 侧（`8009001d` → 无回退链 → 教模型改用 `run_script`）是同一类元问题，但修复落点完全不同：那里缺的是**执行层回退**，这里缺的是**编辑层的可诊断性**。两份方案应各自独立推进。

## 4. 影响

1. **效率**：约 45% 会话时长消耗在失败后的自建能力上，包含一次 64 秒的输出上限空转（`output_tokens=16383` / `maxTokensEffective=16384`，`request_retry: model_output_token_limit`，工具 `notExecuted`）。
2. **安全**：§2.7 的四道护栏在降级路径上全部失效，且这一失效**不会被日志或 UI 单独标注**。
3. **交付物质量**：缺陷改变了产出本身。第 58 行最终落地时，**含反斜杠的正则被整段替换为不含反斜杠的等价写法**：

```
v1.0 原文（含反斜杠正则）：
  rg -n '(:\\s*\\(|=>)' src/shared/agent/invocation.ts

v1.1 落地（当前文件 `docs/develop/runtime-admission-sdk-reuse-plan.md` 第 58 行）：
  rg -n -e resolveWorkDir -e resolveApiKey -e getBrowserDetectContext -e turnBoundary \
    src/shared/agent/invocation.ts → :166 / :172 / :275 / :280
```

即：**文档内容因工具缺陷而被改写**。这也解释了为什么该行的反斜杠最终在文件中消失——它被绕开了，而不是被正确编辑了。

## 5. 改进方案

方案分三档：**P0（必做，低风险高收益）**、**P1（建议做）**、**P2（可选）**。

### 5.1 P0-A：`occ === 0` 时返回结构化诊断

**目标**：把「未找到待替换的字符串」从零信息升级为可操作诊断。「差的是 2 个反斜杠」这类信息一旦呈现，模型一次即可修正。

**改动位置**：`electron/tools/builtinExecutors.ts` 的 `occ === 0` 分支。

**诊断算法**（纯本地、无 I/O；**两阶段**：粗筛为 O(文件行数 × L)，LCS 仅对短名单内窗口精算）：

> 两个阈值用途不同，勿混：`MAX_CANDIDATES` 判「候选是否多到应当放弃」（→ `ambiguous-candidate`，见步骤 2）；`MAX_LCS_WINDOWS` 限「进入 LCS 精算的窗口数」（控成本，见步骤 1a）。

```
diagnoseMissingOldString(fileText, oldS):
  0. 归一视图（与匹配器同口径）：oldS、fileText 均经 normalizeLineEndingsForMatch；
     诊断的行号与 index 一律在该归一视图上度量 —— EOL 容差已由匹配器处理，
     诊断不再另立一套口径，否则 CRLF 文件上行号与偏移会对不齐。      ← O1
  1. 块窗口（两阶段：先粗筛、后精算——不得对每个窗口都跑 LCS）：
     L = oldS 的行数（L ≥ 1；单行即 L = 1 的特例，不单开分支）
     若 L > MAX_DIAGNOSIS_BLOCK_LINES（建议 20）
        → kind = 'block-too-large'，只回 { oldLineCount: L, totalLines }，不下发建议
     1a 粗筛（廉价、无回溯）：以 L 行为窗口在 fileText 上滑动，
        用「逐行共有子串长度占比 / 字符直方图重合度」等线性代价的度量
        聚合出窗口分数，取前 MAX_LCS_WINDOWS（建议 5）个进入短名单；
     1b 精算：仅对短名单内的窗口计算整体 LCS 占比与字符级 opcodes，
        窗口块相似度 = max( 逐行最佳匹配的加权平均 , 整体 LCS 占比 )
  2. 候选筛选（阈值 similarity ≥ 0.5）：
     - 无候选 → kind = 'no-similar-line'（返回 totalLines、oldFirstPreview）
     - 候选数 > MAX_CANDIDATES（建议 5）或 top1 - top2 < MIN_SIM_GAP（建议 0.05）
        → kind = 'ambiguous-candidate'（只回 top1 行号与相似度，不下发建议）  ← O2
  3. 唯一 top1 → 对（候选块, oldS）做行级/字符级对齐并生成 opcodes
     - 非 equal 段最多取 MAX_DIFFS（5）处
     - 全部差异「仅为反斜杠连续字符个数不同」→ kind = 'escape-layer-mismatch'
     - 差异含 \r 等不可见字符                 → kind = 'invisible-char-mismatch'
     - 否则                                   → kind = 'content-mismatch'
  4. 生成 hint（多行时明确「第 X–Y 行整块」，避免模型只改一行）
  5. 返回 { kind, candidateLineRange, similarity, similarityGap, diffs[],
           backslashRuns[], totalLines, oldLineCount,
           suggestedOldString?, suggestedOldStringLength?, usableAsOldString?,
           suppressionReason?, hint }
```

**多行 `old_string` 的语义（B2 收敛点）**：算法**统一按块处理**（步骤 1 的窗口以 `oldS` 行数为准）。这样：

- 单行是 `L = 1` 的特例，不需要两套逻辑；
- `suggestedOldString` 返回的是**整块候选的真实内容**（`candidateLineRange` 覆盖 X–Y 行），模型拿它配原有 `new_string` 重试即可，不会出现「单行建议 + 多行 new_string」→ 只替换一行的损坏；
- `L` 超过 `MAX_DIAGNOSIS_BLOCK_LINES` 时降级为 `block-too-large`，**不下发建议**（宁可不给，也不给可能误配的片段）。

**`kind` 与建议下发的关系**：

| kind | 是否下发 `suggestedOldString` |
|---|---|
| `escape-layer-mismatch` / `invisible-char-mismatch` / `content-mismatch` | 是（但须先通过 §5.2 的可用性预检） |
| `no-similar-line` / `ambiguous-candidate` / `block-too-large` | **否**（只给计数与行号指引） |

**TS 侧序列比对（O1）**：仓库无现成 diff 依赖（`difflib` 是 Python 库，本仓库主进程为 TypeScript），需在 `electron/tools/` 下自实现最小 **LCS + opcode 回溯**（纯函数、可单测）；`skillMatcher` 与 `WriteConfirmCard` 中的匹配逻辑不可复用。为避免最坏情况卡顿，LCS **只对步骤 1a 短名单内的 top-K 窗口计算**（不对全量窗口计算），且仅当候选块与 `oldS` 均 ≤ `MAX_LCS_INPUT_CHARS`（建议 4000 字符）时进行；超限降级为 `block-too-large`。

**建议返回结构**（关键：反斜杠用**计数**表达，而不是用转义文本表达，避免把转义歧义又传回给模型）：

```jsonc
{
  "success": false,
  "error": "EDIT_OLD_STRING_NOT_FOUND",        // 稳定错误码；userMessage 保持不变以兼容展示层
  "userMessage": "未找到待替换的字符串",
  "data": {
    "diagnosis": {
      "kind": "escape-layer-mismatch",
      "candidateLineRange": [58, 58],          // 多行时为 [X, Y]
      "similarity": 0.991,
      "diffs": [
        { "index": 184, "submittedBackslashRun": 1, "fileBackslashRun": 2 },
        { "index": 187, "submittedBackslashRun": 1, "fileBackslashRun": 2 }
      ],
      "usableAsOldString": true,               // 见 §5.2.1 / §5.2.2 的预检与上限
      "hint": "文件第 58 行该处的反斜杠数量比 old_string 多 1 层（文件为 2 个连续反斜杠，提交为 1 个）。请按 diagnosis.suggestedOldString 重试 edit_file。"
    }
  }
}
```

**设计要点**：

- **用 `backslashRun` 计数替代转义文本**。这是本方案的核心巧思：既然「层数不可判别」是根因，就把层数变成**整数**，彻底消除歧义。
- **诊断文本本身也会过出口脱敏**，因此建议片段必须经 §5.2.1 的预检再决定是否下发；「回显文件片段」不能只当作合规注记。
- `oldS === ''`（新建文件）与 `occ > 1`（多处命中）路径**不受影响**。

### 5.2 P0-B：诊断中给出「可用的 `old_string`」建议（含可用性预检）

**目标**：让模型第二次调用即可成功，且**不引入任何模糊匹配**。

诊断已算出候选块真实内容与差异位置，**在通过可用性预检后**把该片段作为建议返回：

```jsonc
"diagnosis": {
  "kind": "escape-layer-mismatch",
  "candidateLineRange": [58, 58],
  "suggestedOldString": "<候选块的真实内容，原样>",
  "suggestedOldStringLength": 246,
  "usableAsOldString": true,
  "note": "该片段取自当前磁盘内容，可直接作为下一次 edit_file 的 old_string"
}
```

优点：

1. **不改匹配语义**——不放松确定性约束，只是把「文件真实内容」告诉模型。
2. **一次修复**——模型复制即成功，无需自己推算层数。
3. **覆盖三类 kind**——对 `content-mismatch`、`invisible-char-mismatch`、`escape-layer-mismatch` 均有效；但**受块窗口（§5.1）与长度上限（§5.2.2）约束**，并非无条件可用。

#### 5.2.1 必做：下发前的脱敏预检（B1）

**问题**：执行器返回的 `data` 在送达模型前必经 `projectGenericData`（`src/shared/processResultProjection.ts`），其中**每个字符串**都会过 `sanitizeAgentText`（`src/shared/agentSafeText.ts`）。该函数做两类确定性替换：

1. **主目录前缀折叠为 `~`**：覆盖原生反斜杠、正斜杠、JSON 转义双反斜杠，以及 Git Bash `/c/...`、WSL `/mnt/c/...`、Cygwin `/cygdrive/c/...` 形态；
2. **秘密脱敏**：`API_KEY` / `TOKEN` / `SECRET` / `COOKIE` / `PASSWORD` 赋值、`Bearer ...`、PEM 块 → `<secret:redacted>`。

`edit_file` **不在** `PROCESS_TOOL_NAMES`（该集合仅 `run_shell` / `run_script` / `run_lark_cli`，见 `src/shared/processResultProjection.ts`），因此必然走通用投影分支，上述替换**必然生效**。

**后果（本方案必须避免）**：候选行一旦含用户主目录绝对路径（文档 / 日志 / 配置类文件极常见）或秘密形态文本，模型收到的 `suggestedOldString` **不再是文件真实内容**。模型照 hint 原样重试 → 再次 `occ === 0` → 返回相同错误码与相同诊断 → 连续 3 次相同错误触发 `shouldStopToolRetry`（`MAX_CONSECUTIVE_SAME_TOOL_ERROR = 3`，`electron/toolChatLoop.ts`）→ **整个工具循环被中止**。即在这类文件上，P0-B 会把「失败 → 换工具」变成「失败 → 两次无效重试 → 循环中止」，**比现状更差**。

**修复规格（实施前必须落地）**：执行器在生成 `suggestedOldString` 前**自调同一函数** `sanitizeAgentText` 做预检：

```
preflight(candidateBlock):
  const { text, redacted } = sanitizeAgentText(candidateBlock)
  if (text !== candidateBlock) → 抑制建议下发
       suggestedOldString = undefined
       usableAsOldString = false
       suppressionReason = 'sanitize-would-rewrite'
       hint 退化为「仅基于 backslashRuns 计数 + 行号范围」的指引（不含完整片段）
  else → 正常下发，usableAsOldString = true
```

三个实现要点：

- **必须用与投影层同一个函数**（`sanitizeAgentText`），不得自写正则近似——否则预检与投影会漂移。
- **必须在同一 `homeRules` 状态下预检**：主目录折叠依赖 `setKnownHomeDir` 注入（主进程启动时调用一次）。若未注入，预检只覆盖秘密脱敏、**漏检主目录折叠**。因此预检须在已注入的主进程内执行，且单测需显式 `setKnownHomeDir(...)` 并在 `afterEach` 重置（参考 `electron/agentLogger/agentLogError.test.ts` 的既有写法）。
- **抑制后 hint 仍须可用**：只给「行号范围 + 反斜杠计数」这类不含原文的信息；本次案例中，「文件该处为 2 个连续反斜杠」这一条就足以让模型自行修正。

**实现位置（已决策：做法 A）**：预检放在**执行器侧**——`edit_file` 在生成 `suggestedOldString` 前自行调用 `sanitizeAgentText`，判定会被改写则抑制下发。

选它而非替代方案（**做法 B**：执行器照常下发，由投影层在发现改写时回填 `usableAsOldString: false`）的理由是**判断只有一处**：脱敏规则变更时同步点明确，且执行器与投影层调用同一个函数，不会出现两套口径。做法 B 在分层上更干净，但要求通用投影层理解 `diagnosis` / `suggestedOldString` 的业务语义，等于让一个原本对所有工具一视同仁的公共层承担单一工具的业务判断，长期更易被改坏，本方案不采纳。

若后续因分层原因改采做法 B，本节的一致性约束（**同一函数**、**同一 `homeRules` 状态**）必须保持不变——否则预检通过而实际仍被改写，会退回到本节描述的最差路径。

#### 5.2.2 必做：建议片段长度上限（O4）

单行可以极长（minified 文件单行可达 MB 级），且 `tool_result` 还叠加 `MAX_TOOL_RESULT_CONTENT_CHARS`（= `READ_FILE_MAX_CHARS` = 2 MiB，见 `src/shared/toolResultLimits.ts`）与 `compactOversizedToolResultContent` 压缩（`electron/toolChatLoop.ts`），建议可能被截断而失效。

**规格**：`suggestedOldString` 长度超过 `MAX_SUGGESTED_OLD_STRING_CHARS`（建议 4096 字符）时：

- **不下发片段**，改下发 `candidateLineRange` 与超限标记；
- `usableAsOldString = false`，`suppressionReason = 'too-long'`；
- hint 给「按行号区间用 `read_file` 读取后再重试」的指引。

**这一项与 P0-A 合并实现成本极低**（诊断已持有候选块原文），但收益最大，建议与 P0-A 同一批次落地。

### 5.3 P1-C（可选）：转义归一后唯一命中回退

**目标**：在可证明无歧义时自动完成编辑，省掉一次往返。

**规则（安全边界必须严格）**：

1. 仅在 `occ === 0` 时尝试。
2. 仅生成**有限变体集**：
   - 对 `oldS` 中每段连续反斜杠，生成「±1 个反斜杠」的变体（上限如 3 层）；
   - 字面 `\n`（两字符）↔ 真实换行 的变体。
   不做任意模糊匹配、不做正则、不做编辑距离搜索。
3. **必须恰好一个变体命中，且该变体在文件中 `occ === 1`**，才允许替换。
4. 命中后结果需显式标注：

```jsonc
"data": {
  "path": "...",
  "bytesWritten": 12345,
  "matchedVariant": { "kind": "escape-layer", "backslashRunDelta": +1 },
  "notice": "已按转义层归一匹配（提交 1 个反斜杠，文件 2 个）"
}
```

5. 若多个变体都命中，或唯一命中的变体 `occ > 1` → **放弃回退**，退回 P0-A 的诊断路径。

**策略选择**：建议**默认关闭**（通过入参 `tolerate_escape_layer: true` 显式开启）。理由：P0-B 已能让模型一次修正，回退的边际收益有限，而任何"自动放宽匹配"的机制都需要长期防误伤。若希望默认开启，则应限定为「仅 `kind === 'escape-layer-mismatch'` 且唯一命中」。

### 5.4 P1-D：`read_file` 提供原始字符视图

**目标**：从源头消除「层数靠猜」。

**方案**：`read_file` 新增可选参数（如 `show_repr: true` 或 `show_backslash_runs: true`），在返回中附**每行的反斜杠计数标注**或 **repr 形式**，仅对命中行/指定区间生效，避免输出膨胀。

**取舍建议**：**P0-A/B 落地后本项边际价值明显下降**（模型不再需要自己探查层数）。建议先做 P0，观察是否仍有同类失败再决定是否实现 P1-D。若实现，须注意：
- 与 `read_file` 现有的分段/截断语义协调；
- 不改变默认行为，避免影响既有历史与缓存口径。

### 5.5 P1-E：失败结果中携带恢复路径（行为层修复）

**目标**：把「单次失败 → 永久切换工具」改为「单次失败 → 按提示重试」。

**做法**：`occ === 0` 失败结果的 `userMessage` 或 `data.diagnosis.hint` 中明确给出重试指引，例如：

> 「未找到待替换的字符串。已定位最相似块（第 58–62 行，相似度 0.99，差异为反斜杠层数）。请使用 `diagnosis.suggestedOldString` 重新调用 `edit_file`，无需改用脚本。」

**建议被抑制时的措辞**（§5.2.1 / §5.2.2 触发）：不得再引用 `suggestedOldString`，改为仅给可操作事实，例如：

> 「未找到待替换的字符串。最相近块为第 58–62 行（相似度 0.99）；其差异为反斜杠连续个数（文件 2 个、提交 1 个）。该片段因长度 / 敏感内容未随诊断下发，请自行读取该行区间后以正确内容重试 `edit_file`，**不要改用脚本写文件**。」

**为什么有效**：会话中该失败结果的 `data` 会被保留并送达模型（`toolChatLoop` 的失败分支保留结构化 `data`，该行为已在 `run-shell-command-failure-diagnosis-and-remediation-plan.md` 中确认）。因此提示能到达决策点。

### 5.6 P2-F：`run_script` 写文件的护栏对齐与观测

**现状**：`run_script` 以子进程 Python 直接写文件，无法在进程内拦截（不做不可行的 hook 设计）。

**务实做法（二选一或组合）**：

- **F1（提示层，低成本）**：在 `run_script` 的工具描述与系统提示中明确——**文件修改优先使用 `edit_file`；若 `edit_file` 匹配失败，请依据其 `diagnosis` 修正后重试，而非改用脚本写文件**。
- **F2（观测层，中成本）**：`run_script` 执行前后对 `workDir` 内文件做轻量快照（path + mtime + size），若检测到「已有文件被修改，但该文件未进入 `edit_file` 的 checkpoint 通道」，则在结果中标注 `{ "detectedDirectWrite": true, "files": [...] }`，并在会话日志中记录一次可审计事件。

不建议的做法：尝试在 Python 子进程内拦截 `open()`（不可靠、可被绕过、成本高）。

### 5.7 P2-G：需求与工具描述同步

`docs/requirement/tools-requirement.md` 当前对 `edit_file` 的规格只有一句「增量编辑文件（字符串替换）」（§工具清单）与工具描述（§工具定义）：

> 「通过字符串替换对文件进行增量编辑。保留原文件换行符格式和文件特性。适用于修改现有文件的部分内容、创建新文件（old_string 为空）、删除内容（new_string 为空）。」

实施本方案后需同步补充：
- 匹配失败的**诊断能力**（返回结构、`kind` 枚举、`suggestedOldString` 语义）；
- 转义容差回退（若采纳 P1-C）的**启用条件与安全边界**；
- `EDIT_OLD_STRING_NOT_FOUND` 稳定错误码及与 `userMessage` 的分工。

## 6. 实施顺序

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| Phase 1 | P0-A 诊断算法（含**块窗口**与 `kind` 枚举）+ 返回结构 | 无 | 低（只增返回字段） |
| Phase 1 | P0-B `suggestedOldString` + **可用性预检（§5.2.1，B1）** + 长度上限（§5.2.2，O4） | 与 P0-A 同批 | 低-中（预检须与投影层同口径） |
| Phase 1 | P1-E 恢复路径提示 | 与 P0-A 同批（同一字段） | 低 |
| Phase 2 | 单元测试与集成测试（§7） | Phase 1 | 低 |
| Phase 3 | 需求文档与工具描述同步（P2-G） | Phase 1 | 低 |
| Phase 4（可选） | P1-C 转义归一回退（默认关闭） | Phase 2 回归通过 | 中（需严格边界测试） |
| Phase 5（可选） | P1-D `read_file` 原始字符视图 | Phase 4 后按需 | 中（涉及默认行为与缓存口径） |
| Phase 6（可选） | P2-F `run_script` 写文件观测 | 无 | 中 |

建议顺序理由：**Phase 1 三项合并为一次改动**，改动面集中在单个函数分支与新增返回字段，不触碰匹配语义与写路径，因此风险最低而收益最高；P1-C/D 这类"放松/扩展"型改动放在回归建立之后。

## 7. 测试方案与验收标准

### 7.1 单元测试（建议新增 `electron/tools/builtinExecutors.editDiagnosis.test.ts`）

复用现有 harness（参考 `builtinExecutors.pathAlias.test.ts` / `builtinExecutors.fileState.test.ts` 的写法）。

必须覆盖：

| # | 场景 | 断言 |
|---|---|---|
| 1 | **本次真实案例复现**：文件该处为 2 个反斜杠，提交 1 个 | `success=false`；`kind === 'escape-layer-mismatch'`；`candidateLineRange === [58,58]`；`diffs[0].fileBackslashRun === 2` 且 `submittedBackslashRun === 1` |
| 2 | 同上，把 `diagnosis.suggestedOldString` 作为 `old_string` 再次调用执行器 | 第二次 `success=true`；`usableAsOldString === true`；建议文本与文件真实片段**逐字符相等** |
| 3 | 反斜杠方向相反（文件 1 个，提交 2 个） | 同 #1，`backslashRun` 反向 |
| 4 | **多行 `old_string`，其中间行差一个反斜杠**（B2 核心） | `kind === 'escape-layer-mismatch'`；`candidateLineRange` 为 `[X,Y]` 且 `Y-X+1 === oldLineCount`；`suggestedOldString` 含**全部** `Y-X+1` 行（不是单行） |
| 5 | 多行 `old_string`，行数 > `MAX_DIAGNOSIS_BLOCK_LINES` | `kind === 'block-too-large'`；`suggestedOldString === undefined` |
| 6 | **候选块含主目录绝对路径**（B1 核心） | `usableAsOldString === false`；`suppressionReason === 'sanitize-would-rewrite'`；`suggestedOldString === undefined`；hint 仍含行号范围与反斜杠计数 |
| 7 | **候选块含 `TOKEN=` 形态秘密文本**（B1 核心） | 同 #6 |
| 8 | 候选块长度 > `MAX_SUGGESTED_OLD_STRING_CHARS` | `usableAsOldString === false`；`suppressionReason === 'too-long'`；`suggestedOldString === undefined` |
| 9 | 完全无关字符串 | `kind === 'no-similar-line'`；不下发建议；不猜测 |
| 10 | 候选过多 / top1 与 top2 相似度接近 | `kind === 'ambiguous-candidate'`；不下发建议（O2） |
| 11 | 多处命中（`occ > 1`） | 仍返回原「找到多个匹配…」；**不进入诊断分支**（回归） |
| 12 | 行尾差异（文件 CRLF，提交 LF） | 仍由 EOL 容差成功；不产生诊断（回归） |
| 13 | `old_string` 为空（新建文件） | 行为不变（回归） |
| 14 | 文件未读（`ERR_FILE_NOT_READ_FOR_EDIT`） | 行为不变，诊断不介入（回归） |
| 15 | 文件被外部修改 | 行为不变（回归） |
| 16 | **性能上界**（大文件 + 多窗口 + 超长行） | 降级为 `block-too-large`（当块超 `MAX_LCS_INPUT_CHARS`）；耗时**随文件规模至多线性且常数有界**——断言「扫描 n 行与 10n 行的耗时比 ≲ 10 倍」，且**不随窗口数乘性膨胀**（验证 §5.1 步骤 1a/1b 两阶段确实生效，即 LCS 调用次数 ≤ K） |
| 17 | **预检与投影的一致性** | 对同一候选块，预检判定「会否被改写」与真实投影结果一致——断言须走**已导出**入口 `projectAgentToolResult`（`src/shared/agentToolResult.ts`）或 `serializeAgentToolResult`，**不得直接引用 `projectGenericData`**（`src/shared/processResultProjection.ts:584`，模块内私有、未导出）；并覆盖「`homeDir` 未注入时不误判为安全」 |
| 18 | P1-C（若采纳）歧义组合 | 两个变体都命中 → 不回退，退回诊断 |

### 7.2 集成测试

- **真实 fixture**：以会话 `d05fe8a7` 的第 58 行原始内容（2 个反斜杠版本）构造 fixture，断言：首次 `edit_file` 失败并给出 `suggestedOldString`；第二次调用成功；整条链路 `run_script` 写文件次数为 **0**。
- **链路级重试断言（原 §7.1 用例 2 的链路部分，O3）**：在真实 tool loop（复用 `toolChatLoop` 既有测试 harness）中，断言模型收到 `diagnosis` 后**只用 `edit_file` 重试**；并断言**不会**出现「连续 3 次相同错误 → `shouldStopToolRetry` 中止循环」——这是 B1 场景的直接反例保护，必须有专项用例覆盖。
- **B1 反例保护（集成层）**：构造候选块含主目录路径的 fixture，断言结果为「建议被抑制 + hint 仍可操作 + 不触发重试熔断」，而不是「下发被改写的建议 + 模型重试 + 循环中止」。
- **回归对照**：以 §2.6 的 12 次调用为反例基线，断言改进后同任务不再出现「失败后 8 次脚本写盘」的形态。
- **护栏断言**：文件修改路径仍经过 `backupIfEnabled` / `safeAtomicWrite`（即不因诊断功能改动而旁路护栏）。

### 7.3 验收标准

1. **反斜杠层差异场景**：`edit_file` 首次失败即返回 `diagnosis`，其中 `kind`、`candidateLineRange`、`backslashRuns` 与真实文件一致（对齐 §2.3 的 index 184 / 187）。
2. **一次修复**：模型使用 `suggestedOldString` 后第二次调用成功，无需任何 `run_script`。
3. **多行完整（B2）**：多行 `old_string` 失败时，建议覆盖**整块** `[X,Y]` 行而非单行；行数超 `MAX_DIAGNOSIS_BLOCK_LINES` 时显式降级 `block-too-large` 且不下发建议。
4. **建议可用性（B1）**：会被出口脱敏改写的候选（含主目录路径或秘密形态）、或超长候选，一律**抑制建议下发**（`usableAsOldString === false`）并给出不含原文的 hint；断言不出现「下发被改写建议 → 连续 3 次相同错误 → 循环中止」。
5. **零歧义**：诊断与回退不改变确定性匹配语义；多处命中、未读、外部修改、行尾差异等既有路径逐条回归通过。
6. **效率**：在等价 fixture 任务下，从失败到收尾的工具调用次数显著下降，且**不再出现 `run_script` 直接写文件**。
7. **兼容**：`userMessage` 保持原文案；新增字段为**追加**，不破坏既有消费者（UI、历史重建、统计）。

## 8. 代码落点

| 文件 | 建议改动 |
|---|---|
| `electron/tools/builtinExecutors.ts` | `editFileExecutor` 的 `occ === 0` 分支接入诊断；`suggestedOldString` 生成前调用 **§5.2.1 预检**；如采纳 P1-C，新增 `applyEditWithEscapeTolerance()` 并保持 `applyEditWithEolTolerance` 不变 |
| `electron/tools/editDiagnosis.ts`（新增） | `diagnoseMissingOldString()`（块窗口 + 候选筛选 + 分类），以及最小 **LCS + opcode 回溯**（纯函数、无 I/O，便于单测） |
| `src/shared/agentSafeText.ts` | **复用，不修改**：预检直接调用 `sanitizeAgentText`；实施时须确认主进程已 `setKnownHomeDir` 注入，否则预检会漏检主目录折叠 |
| `src/shared/toolResultLimits.ts` | 新增诊断上限常量：`MAX_DIAGNOSIS_BLOCK_LINES`、`MAX_SUGGESTED_OLD_STRING_CHARS`、`MAX_LCS_INPUT_CHARS`、`MAX_LCS_WINDOWS`（进精算的窗口数）、`MAX_CANDIDATES`（歧义降级阈值）、`MIN_SIM_GAP` |
| `src/shared/errorCodes.ts` | 新增稳定错误码 `EDIT_OLD_STRING_NOT_FOUND`（保留 `userMessage` 文案兼容） |
| `src/shared/builtinToolMetadata.ts` | `edit_file` 工具描述补充「失败会返回诊断与建议片段，可按建议重试」；`run_script` 描述补充「文件修改优先用 `edit_file`」（P2-F1） |
| `docs/requirement/tools-requirement.md` | 同步 `edit_file` 的匹配失败诊断规格与 `EDIT_OLD_STRING_NOT_FOUND`（P2-G） |
| `electron/tools/readFileStreaming.ts` | （可选，P1-D）原始字符视图参数 |
| `electron/tools/builtinExecutors.editDiagnosis.test.ts` | 新增单元测试（§7.1，18 条） |
| `electron/tools/builtinExecutors.ts` 既有测试 | 回归确认 `occ > 1`、未读、外部修改、EOL 容差路径不变 |

**不建议改动**：`countOccurrences` / `applyEdit` 的匹配语义（保持严格 `indexOf` 与唯一性约束）；`edit_file` 的写路径（`safeAtomicWrite` / `backupIfEnabled`）——护栏是本方案的**保护对象**，不是修改对象。投影层 `projectGenericData` / `sanitizeAgentText` 的脱敏行为也**不应为放行建议而放宽**（见 §9）。

## 9. 不建议的修复方式

- **只把文案改长**（如「未找到待替换的字符串，请检查空格或特殊字符」）——不解决层数不可判别。
- **放宽为模糊/正则匹配**——会削弱唯一性与确定性，且可能被用作变体绕过通道。
- **默认开启转义容差回退**——在缺少歧义测试前，等于把「确定性匹配」改成「尽力匹配」。
- **要求模型总用 `write_file` 重写整个文件**——改变改动粒度，丢失最小 diff 与部分写保护语义，且对大文件有性能与误覆盖风险。
- **只在系统提示里叮嘱「小心反斜杠」**——本次会话中模型已反复自我提醒并仍然猜错（§2.4），提示不构成确定性信息。
- **为放行建议片段而绕过出口脱敏**（如把片段塞进不经 `sanitizeAgentText` 的字段、或放宽 `projectGenericData`）——会把主目录与秘密形态文本写入 Agent 出口，属安全回退；正确做法是 §5.2.1 的**抑制**。
- **P0-B 只做单行、不扩展块级匹配**——多行是本次会话的常态（4 次中第 2、3 次均为多行），单行限定会让 P0-B 在最常见场景失效，并留下「单行建议配多行 new_string」的损坏隐患。
- **把本项与 `run_shell`/`8009001d` 混为一案处理**——同源（单次失败无诊断）但落点不同（执行层回退 vs 编辑层可诊断性），合并会稀释两边的验收标准。

## 10. 附：证据索引

| 事实 | 出处 |
|---|---|
| 会话总览（287s / 64 次调用） | `sessions/d05fe8a7…/events.jsonl`（`turn_start` seq 1、`turn_end` seq 57540） |
| 4 次 `edit_file` 参数与结果 | seq 24672 / 25564 / 26056 / 27433 |
| 失败详情 | seq 27433 结果：`{"success": false, "error": "未找到待替换的字符串"}` |
| 文件真实字符 | seq 29110 的 `run_script`（Python `repr` 输出） |
| 字符级差异 | seq 27433 的 `old_string` 与 seq 29110 repr 还原内容的 `difflib` 对齐 |
| 模型转义试错推理 | seq 27433→30000 区间的 `reasoning_delta` |
| `occ === 0` 分支代码 | `electron/tools/builtinExecutors.ts`（`editFileExecutor`） |
| 四道护栏 | `electron/tools/builtinExecutors.ts`、`electron/safeAtomicWrite.ts` |
| 输出上限空转 | seq 45491 结果 `model_output_token_limit`；`request_retry` seq 45497 |
| 产出被改写 | 当前 `docs/develop/runtime-admission-sdk-reuse-plan.md` 第 58 行（对比 seq 29110 repr 中的原始行） |
| B1：出口脱敏会改写建议 | `src/shared/processResultProjection.ts`（`projectGenericData` → 逐字符串 `sanitizeAgentText`；`PROCESS_TOOL_NAMES` 不含 `edit_file`）、`src/shared/agentSafeText.ts`（主目录折叠 + 秘密脱敏） |
| B1：熔断阈值 | `electron/toolChatLoop.ts`（`MAX_CONSECUTIVE_SAME_TOOL_ERROR = 3`）、`electron/toolErrorRetryPolicy.ts`（`shouldStopToolRetry`） |
| B2：多行是常态 | seq 25564（`old_string` 213 字符、含换行）、seq 26056（299 字符、含换行） |
| O1：无现成 diff 依赖 | 全仓源码无 `difflib` / `SequenceMatcher` / `opcodes` 命中；`skillMatcher`、`WriteConfirmCard` 的匹配逻辑不可复用 |
| O4：结果长度上限 | `src/shared/toolResultLimits.ts`（`MAX_TOOL_RESULT_CONTENT_CHARS = READ_FILE_MAX_CHARS` = 2 MiB） |
| 评审文件 | `docs/review/20260920-edit-file-match-failure-plan-review.md`（B1 / B2 / O1–O4 出处） |
