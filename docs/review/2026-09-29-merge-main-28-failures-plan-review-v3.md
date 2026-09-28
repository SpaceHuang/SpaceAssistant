# 评审（第三轮）：合并后 28 个测试失败修复计划 v3

- 评审对象：`docs/review/2026-09-29-merge-main-28-failures-analysis-and-fix-plan.md`（v3）
- 评审日期：2026-09-29
- 评审方式：逐条核对 v3 修订点 + 代码走查（`writePathFacts.ts`、`toolCallGate.test.ts` fixture 形态）
- **结论：B4（1.3 env 路径按自身语法选 API）与 N5（如实改写）已正确吸收，可签收；但 B3 的处置项 1.4a 规格仍有缺陷——守卫加错了函数、且「抛原 error」与本格自述的目标行为自相矛盾，按文字实施组 1 仍有约 8 个用例无法转绿，并可能误伤现有绿例。其余全部内容可执行。**

## 第二轮问题的复核结论

| 项 | 结论 |
| --- | --- |
| B4（1.3 重写） | ✅ 已修正为「env 路径按自身语法选 API，与 rawPath 分支解耦」，规则正确 |
| N5（免责论证） | ✅ 已如实改写：`/home`、`/Users`、`/root` 不命中 system-dir 根正则、win32 上无 zone 级保护的陈述正确（与正则核对一致），pre-existing 定性准确 |
| B3（1.4a 根守卫） | ❌ 处置规格仍有三处缺陷，见下 |
| 其他（三态分派、回归锚、批次 2/3/4、验收口径、工作量） | ✅ 维持第二轮「可执行」结论 |

## 阻断性问题（1 项）

### B3-残余：1.4a 的守卫规格有三处缺陷，按文字实施无法达成「17 个全部恢复」

**缺陷 1：守卫加错了函数。** 1.4a 标题与变量名（`candidate === '/'`）把守卫定在 `canonicalizeThroughExistingParent`（:60-74）——该函数只处理 **env 路径**（workDir/userDataDir/homeDir/prefixes）。而第二轮 B3 的污染现场是 `probeWritePathFact` 自己的**目标父目录回退**（:131-146，变量名 `parent`）——rawPath `/etc/hosts` 的 lstat ENOENT 后走的就是这个循环，realpath('/') 返回 `E:\` 的污染发生在这里。1.3 的「同构」清单只列了 :99/:106，未列 :131-146。按文字实施，目标回退无守卫 → 混合形态 `E:\/etc/hosts` → 仍归 outside-workdir → write 探测链路约 8 个用例仍红。

**缺陷 2：「终止并抛原 error」与本格目标行为自相矛盾。** 1.4a 自述目标行为是「`targetKind='missing'` + zone 由纯函数判定」——这要求 probe **正常返回** POSIX 形态 normalizedPath 的事实。但两处守卫机制（①「视为不可达按原 error 继续」、②「终止并抛原 error」）的终点都是 `WritePathProbeError` 抛出：`writePathFacts.test.ts:34-37` 直接 `await probeWritePathFact(...)` 并断言 `zone: 'system-dir'`，抛出即红；gate 侧抛出走 `extraction-failed`（toolCallGate.ts:486），ruleId 断言同样失败。正确语义应对齐 readPathFacts 的根守卫（:133）：**到达语法根即静默退出回退，normalizedPath 保持 lexical 形态**，不抛错。此外计划未规定此时必填字段 `parentReal`/`parentIdentity` 的取值（:149-154 会对 parentReal 发 stat，POSIX 根不可 stat 时如何处理需写明，例如 `parentReal='/'` + win32 上 `fs.stat('/')` 可成功）。

**缺陷 3：若按文字把守卫①应用到 env 路径 canonicalize，会误伤 POSIX 形态 env 路径。** win32 上 realpath 对 POSIX 形态路径**永远返回 win32 形态**（`realpath('/tmp')` → `E:\tmp`）——守卫①「POSIX 分支要求 `real.startsWith('/')`」意味着任何 POSIX 形态 env 路径一律「不可达」→ 走查到根 → 抛 WritePathProbeError。而 `toolCallGate.test.ts:98` 的 `base()` 默认 `workDir: '/tmp/wd'` 正是 POSIX 形态字面量（如 :828「run_shell gate 只分析一次」未覆盖 workDir）：现状下该 workDir 可正常 canonicalize（win32 API，realpath 逐级命中存在的 `E:\tmp`），加守卫①后变为抛出 → `shellPathProbeFailed`/`extraction-failed` → **现有绿例转红**，且行为依赖测试机上 `E:\tmp` 是否存在（机器状态相关，本身即是 fixture 缺陷放大）。env 路径 canonicalize 应取 realpath 的真实答案（ truthful ），不适用「语法意图不可达」判定——守卫只应加在 rawPath 目标回退上。

**处置建议（重写 1.4a）**：

1. 守卫目标改为 `probeWritePathFact` 的目标父目录回退（:131-146）：pathApi 为 posix 时 `parent === '/'` 即静默退出循环，normalizedPath 保持 lexical POSIX 形态，不抛错；同时写明 `parentReal`/`parentIdentity` 的兜底取值；
2. 明确 `canonicalizeThroughExistingParent`（env 路径）**不加**形态守卫①——env 路径要真实 realpath 结果；
3. 1.5 回归锚补一条：POSIX 形态 workDir（`/tmp/wd`）+ POSIX 绝对目标 → workDir canonicalize 不抛错；
4. 修正后 1.4 的「不可达收敛」声明才成立（收敛靠根守卫静默退出，而非抛错）。

## 非阻断

- 版本标签残留：标题「（v2）」、`## 5. 修复计划（v2）`、`### 已知边界记录（v2` 未随 v3 内容更新，建议统一为 v3，避免后续引用混乱。

## 总评

v3 已吸收前两轮 6 项中的 5 项（B1/B2/B4/N1–N5 方向全部正确），剩余唯一阻断点集中在 1.4a 一格的规格精度：正确的目标行为已写在格内（missing + 纯函数判 zone），但机制描述（函数定位、抛错语义、env 守卫误伤）与该目标矛盾。按上述处置建议重写 1.4a 后，计划即可进入实施；预计修正不影响 ≈2–2.5 人日的总量估计。
