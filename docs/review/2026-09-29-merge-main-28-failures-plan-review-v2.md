# 评审（第二轮）：合并后 28 个测试失败修复计划 v2

- 评审对象：`docs/review/2026-09-29-merge-main-28-failures-analysis-and-fix-plan.md`（v2）
- 评审日期：2026-09-29
- 评审方式：逐条核对 v2 修订点 + Node 探针实测 v2 方案的关键路径（win32 / Node 24）
- **结论：第一轮 B1/B2 已正确吸收，N1–N4 处置到位；但 v2 方案仍存在 2 个阻断性问题（B3、B4）——按 v2 文字实施，批次 1 无法达成「组 1 的 17 个用例全部恢复」的验收口径（约 8 个仍红），且 1.3 的一条指示会重演 B1 类回归。另有 N5 的免责论证错误会误导安全侧签收。**

## 第一轮问题的复核结论

| 项 | 结论 |
| --- | --- |
| B1（二态→三态分派） | ✅ 已正确修订。①②③分派表正确；1.5 补上了「相对路径 + win32/POSIX workDir」回归锚（①②），正是第一轮指出的缺口 |
| B2（pathClassifier 归属） | ✅ 已正确撤回。1.2 失败链路归属（probeWritePathFact/probeReadPathFact）与实测一致；1.6 改为回归锚而非修改本体；「语法不一致判 outside」快速路径已明确不做 |
| N1（口径矛盾） | ✅ 统一为「17 个全部恢复」并给出推导（但推导本身被 B3 推翻，见下） |
| N2（EACCES 条件任务） | ✅ 3.1 改为先重验，合理 |
| N3（pathApi 贯通） | ⚠️ 1.2 部分正确；1.3 的 env 路径 canonicalize 指示引入新错误（B4） |
| N4（策略本质显式化） | ✅ 1.5 生产影响评估表述准确 |

## 阻断性问题

### B3：writePathFacts 父目录回退行走会在 POSIX 根处被 win32 realpath 污染——批次 1 按 v2 实施后约半数用例仍红

v2 的 1.4 论断「win32 上 POSIX 语法路径的真实 fs 探测会以 ENOENT 收敛」**在文件系统根边界不成立**。探针实测：

```
fs.realpath('/')    → 'E:\\'    // 成功！POSIX 根在 win32 映射到当前盘符根
fs.realpath('/etc') → ENOENT
```

`writePathFacts.ts:131-146` 的父目录回退是 `while (true)` 循环，**没有 readPathFacts 那样的根守卫**（`readPathFacts.ts:133` 的 `while (parent !== pathApi.dirname(parent))` 在 parent 到达 `'/'` 时退出，天然免疫）。按 v2 方案（② 分支 pathApi=posix、lexical=`/etc/...`）模拟执行：

```
lexical = '/etc/spaceassistant-write-test'
parent='/etc' → realpath ENOENT → parent='/'
realpath('/') → 'E:\'（成功）→ normalizedPath = posix.join('E:\', 'etc/...') = 'E:\/etc/spaceassistant-write-test'
```

产物 `E:\/etc/...` 命中 `isWindowsAbsolute`（`E:` 后跟 `\`）→ 归一化后 `e:/etc/...` → posixRoot 正则要求以 `/` 开头、win32 根列表无 `etc` → **仍归 `outside-workdir`，测试仍红**。

影响面（按 1.2 的链路归属估算）：走 `probeWritePathFact` 的用例——run_shell ×2、run_script ×4、远程写入 ×1、`writePathFacts.test.ts` ×1，**约 8/17 在批次 1 后仍红**，N1 统一后的验收口径「17 个全部恢复」不可达。走 `probeReadPathFact` 的约 9 个（read_file/grep/list_directory、macOS 系统路径等）因 :133 根守卫存在可正常转绿。

处置：批次 1 增加一项——writePathFacts 父目录回退对齐 readPathFacts 的根守卫（parent 到达 pathApi 根即停，保持 lexical 形态），或为 ② 分支规定「不对 POSIX 根发 realpath」；同时修正 1.4 的「ENOENT 收敛」论断（realpath('/') 在 win32 成功，收敛靠的是守卫而非 ENOENT）。

### B4：1.3 的 env 路径 canonicalize 指示重演 B1——「POSIX 分支需传 path.posix」错误

v2 1.3 括号内指示：`canonicalizeThroughExistingParent(value, pathApi)` 的 pathApi 实参「按三态传入（POSIX 分支现传进程 path，win32 上即 win32 API，需传 path.posix）」。

该函数处理的是 **env 路径**（workDir/userDataDir/homeDir/customSensitivePrefixes），其语法与 rawPath 的分支无关：win32 上测试 fixture 的 workDir 是 `realpath(mkdtemp('/tmp/...'))` 的产物，即 **win32 形态**（`E:\tmp\...`）。若 ② 分支按指示传 `path.posix`：

```
posix.resolve('E:\tmp\write-fact-zones-XXX') → '/Develop/SpaceAssistant/E:\tmp\...'  // B1 同款 cwd 拼接乱码
→ realpath ENOENT → 回退行走至根 → 抛 WritePathProbeError → gate 落 extraction-failed → 用例换种方式继续红
```

而且**现状（传进程 `path`，win32 上即 win32 API）对 win32 形态 env 路径本就正确**，这里没有缺陷要修。正确规则与 B1 三态同源：**按每个 env 路径自身语法选 API**（`isWindowsAbsolute(value) ? path.win32 : path.posix`），与 rawPath 分支解耦。建议把 1.3 括号内指示改写为此规则，或删除该指示（保持现状）。

## 非阻断问题

- **N5 残留（论证错误，影响安全签收）**：v2「已知边界记录」称内置/用户目录敏感前缀对 POSIX 语法路径不命中「不构成漏判：该类路径一律落 system-dir（更强保护）」。**「一律」不成立**：`/home/user/.ssh/id_rsa`、`/Users/x/.aws/credentials`、`/root/...` 等 POSIX 语法路径不命中 system-dir 根正则（etc|usr|bin|sbin|lib|var|system|library），也不命中 win32 形态敏感前缀 → 落 `outside-workdir`，desktop custom 档位可放行。这是 pre-existing 行为（修复前后一致，非本计划引入的回归），但免责论证错误会误导 N4 要求的安全侧确认。建议如实改写为「POSIX 语法路径中仅系统根名录内的落 system-dir；`/home`、`/Users`、`/root` 下的敏感目标在 win32 上无 sensitive-file 保护，如需覆盖应配置 POSIX 形态 customSensitivePrefixes」，并由安全侧明确接受或立项补 POSIX 内置敏感前缀。
- **影响面估算需实施时复核**：B3 的「约 8/17」是按链路归属的静态估算（run_shell/run_script/远程写入走 write 探测，读取工具走 read 探测），实施时以批次 1 中途重跑为准。

## 处置建议

1. 批次 1 增加「writePathFacts 父目录回退根守卫」任务项（B3），并修正 1.4 论断；
2. 改写或删除 1.3 的 canonicalize pathApi 指示（B4）；
3. 修正 N5 免责论证后再请安全侧签收 N4/N5；
4. 其余内容（三态分派、回归锚清单、批次 2/3/4、撤回项）可按 v2 执行。

预计 B3/B4 修正不改变工作量量级（仍为 ≈2–2.5 人日），但必须在实施前落入计划文字，否则批次 4 的「0 failed」门禁会在批次 1 收尾时直接卡住。
