# 合并后 28 个测试失败：根因分析与修复计划（v2）

- 分析对象：merge `43b474ab`（feat/tool-invocation-reliability 合入 main）后 `npm run test:electron` 的 28 个失败
- 分析日期：2026-09-29
- 版本：**v3（吸收第二轮计划评审 `2026-09-29-merge-main-28-failures-plan-review-v2.md` 的 B3/B4 阻断处置与 N5 修正；v2 已吸收第一轮 B1/B2 与 N1–N5）**
- v3 修订：批次 1 新增 1.4a（writePathFacts 父目录回退根守卫，B3）；1.3 重写为「env 路径按自身语法选 API」（B4）；已知边界 N5 段如实改写（原「一律落 system-dir 不漏」论证不成立，探针证伪）
- 分析方式：逐用例失败输出比对 + 根因下钻到具体代码行 + Node 探针实测（win32 / Node 24）+ 评审双重复核
- 结论不变的部分：28 个失败全部来自 main 侧 boundary policy layering 系列（fa30f3d6 起）在 Windows 上从未跑过全量，与可靠性分支（R1–R8）的合并内容无关。四组根因分组经评审实测确认属实。
- **v2 修订**：批次 1 由「二态语法分派」重写为「三态分派」（B1）；删除原 1.2 的 pathClassifier 修复项（B2：不在失败链路上且行为本就正确）；pathApi 语法驱动纳入批次 1（N3）；统一验证口径（N1）；EACCES 修复改条件任务（N2）；安全告知显式化（N4/N5）。

## 0. 失败清单与分组总览

| 组 | 根因 | 数量 | 涉及文件 | 性质 |
| --- | --- | --- | --- | --- |
| 组 1 | 平台性路径归类缺陷（生产代码） | 17 | `readPathFacts.ts`、`writePathFacts.ts`（失败链路，v2 修正归属）；`toolCallGate.test.ts`（14）、`readPathFacts.test.ts`（2）、`writePathFacts.test.ts`（1） | **生产缺陷 + 测试红** |
| 组 2 | 探测错误注入 mock 的平台假设（与组 1 同源，见 N2） | 1 | `toolCallGate.test.ts`（EACCES 用例） | 随组 1 修复大概率自然恢复 |
| 组 3 | Windows symlink 创建权限（EPERM） | 9 | `toolCallGate.test.ts`（3）、`readPathFacts.test.ts`（3）、`feishuMediaFacts.test.ts`（2）、`weChatToolExecutor.test.ts`（1） | 测试环境问题 |
| 组 4 | 断言的平台假设（路径分隔符） | 1 | `readReadIntegration.test.ts` | 测试问题 |

## 1. 组 1（17 个）：POSIX 绝对路径在 win32 进程上解析漂移——生产代码缺陷

### 1.1 根因（评审双重复核确认，探针实测钉死）

`readPathFacts.ts` `normalize()`（:41）与 `writePathFacts.ts` 的 `path.resolve(workDir, rawPath)`（:106）使用**进程平台相关**的 `path.resolve`。win32 上：

```
path.resolve('/etc/hosts')  → 'E:\etc\hosts'   // 漂移到当前盘符（探针实测）
path.posix.resolve('/etc/hosts') → '/etc/hosts' // 期望
```

实测失败信号 `{ kind: 'path-target', path: 'E:\etc\hosts', zone: 'outside-workdir' }` 与该漂移形态一致。`isSystemDir()` 的 POSIX 根正则对 `E:/etc/hosts` 不命中 → zone 误归。

### 1.2 失败链路归属（v2 按 B2 修正——原 1.2 归属错误已撤回）

**失败的唯一链路是 `probeWritePathFact` / `probeReadPathFact`**：

- run_shell / run_script 的 path-target 信号：`probeWritePathFact`（`toolCallGate.ts:282`、`:484-485`）——失败信号 `path` 字段是**漂移后的 normalizedPath**，而 pathClassifier 的 `buildPathSignal` 原样透传 rawPath，不可能产出该形态；
- 读取工具：`probeReadPathFact`（`runExtractors.ts:128`）；
- 写工具：`probeWritePathFact`（`toolCallGate.ts:515`）。

**`pathClassifier.ts` 不在这些失败用例的链路上**，且其对同场景行为本就正确：win32 分支对 `/etc/hosts` 走 `path.win32.normalize`（rooted 路径不补盘符、不漂移）→ `/etc/hosts` 命中 posixRoot 正则 → 归 `system-dir`（探针实测确认）。因此：

- ~~原 1.2 修改 pathClassifier~~ **撤回**；
- 新增任务 1.6：为 pathClassifier 的现有正确行为补**回归锚测试**（`/etc/hosts` + win32 workDir → `system-dir`），防止未来误改；
- 已知技术债（另行立项，不在本计划）：pathClassifier 与 probe* 是两套并存的路径归类实现，长期应统一为单一出口。

### 1.3 为什么 CI 没拦住

boundary policy 系列的测试 fixture 大量使用 POSIX 绝对路径。Linux 上 `path.resolve` ≡ `path.posix.resolve` → 全绿；`0bc23ea9` 只修了 toolCallGate.test.ts 的 fixture 生成方式，未触及生产代码解析函数。**该系列从未在 Windows 上跑过全量。**

### 1.4 受影响用例（17 个）

toolCallGate.test.ts（14）：

1. `run_shell gate 只分析一次…`（`cat /etc/hosts` 期望 `shell-system-dir-confirm`，zone 误判 → 实际 auto-allow）
2. `V3 run_shell 将单次分析中的路径事实交给 locked 策略确认`
3. `V3 run_script 静态敏感路径与内容分析共享一次解析…`
4-6. `V3 run_script 'javascript'/'typescript'/'powershell' 的路径事实进入系统目录真人确认`（×3）
7. `V4 remote system read 进入真人确认…`
8. `V4 automation 对敏感/系统读取及飞书媒体越界在显式只读 allow 前终局拒绝`（system read 段 zone 误判 outside 时命中 `remote-outside-read-deny`——终局仍拒、ruleId 断言失败；裁决方向正确、规则定位错误）
9. `远程写入 'system-dir' 目标按真实工作目录范围裁决`（`/etc/...` → 实际 `outside-workdir`）
10-12. `read_file/grep/list_directory 的系统目录目标不可被 custom 普通路径规则放宽`（×3）
13-14. `桌面对 macOS 系统路径 /System/... 与 /Library/... 要求真人确认`（×2）

readPathFacts.test.ts（2）：`识别 macOS 系统目录 /System/... 与 /Library/...`。
writePathFacts.test.ts（1）：`敏感和系统目录优先于工作目录分区`（`/etc/...` → 实际 `outside-workdir`）。

### 1.5 生产影响评估（v2 按 N4 显式化——安全侧需知悉并确认）

win32 运行时上，模型输入 POSIX 形态绝对路径（MSYS/Git Bash 环境、WSL 路径引用、模型生成的跨平台路径）时 zone 被误归 `outside-workdir`，桌面 lane 的 `path-system-dir-ask`（locked 真人确认）不命中，custom 档位可能放行。

**策略本质（N4，需安全侧显式确认）**：修复后 `/etc/hosts` 在 win32 上按**语法意图**归 `system-dir`，而非其真实指向（当前盘符 `E:\etc\hosts`）。这是有意的选择：

- fail-safe 方向：对真实存在于 `E:\etc\` 下的文件，保护从「outside-workdir（custom 可放行）」升格为「system-dir（locked 真人确认）」——行为变更方向是收紧；
- `E:\etc` 不是 Windows 约定的系统目录，误保护的实际代价低；
- 替代方案（按真实指向归 outside）会在 win32 上失去对跨平台路径语意的系统目录保护，与测试即规格的期望矛盾。

## 2. 组 2（1 个）：EACCES 探测错误注入的平台假设（N2：与组 1 同源）

用例 `路径探测遇到 EACCES 时以环境错误终局拒绝…`：mock 以 `String(target) === '/tmp/wd/blocked.txt'` 注入 EACCES。win32 上 probe 传入的 target 已漂移为 win32 形态 → 字符串永不相等 → mock 不生效。**批次 1 修复后 lexical 回到 `/tmp/wd/blocked.txt`，与 mock 字面量相等，大概率自然转绿**——处置改为条件任务（见批次 3.1）。

## 3. 组 3（9 个）：Windows symlink 创建权限

非管理员进程默认无 `SeCreateSymbolicLinkPrivilege`，`fs.symlink()` 直接 EPERM，9 个用例全部在 arrange 阶段抛错。验证的安全语义（symlink 越界逃逸检测）真实且重要，处置见批次 2（能力探测 skip + mock 通路保覆盖）。

## 4. 组 4（1 个）：断言的平台假设

`readReadIntegration.test.ts:121`：`path: 'target/visible.txt'`（正斜杠字面量）vs 执行器 `path.relative` 在 win32 产反斜杠。main 自身遗留。

---

## 5. 修复计划（v2）

### 批次 1（P0·生产缺陷）：路径解析三态语法驱动

**核心原则（v2 按 B1 重写）**：路径解析语义由**三态**决定，任何情况下不得把相对路径交给与其解析基座语法不符的 API：

| 形态 | 判定 | 解析语义 |
| --- | --- | --- |
| ① win32 绝对 | `isWindowsAbsolute(rawPath)` | `path.win32`（normalize / resolve，现状保持） |
| ② POSIX 绝对 | rawPath 以 `/` 开头且非 ① | `path.posix`（绝对路径不涉及 workDir） |
| ③ 相对路径 | 其余 | **按 workDir 的语法**：workDir 为 win32 形态 → `path.win32.resolve(workDir, rel)`；否则 `path.posix.resolve(workDir, rel)` |

> B1 探针依据：`path.posix.resolve('E:\work', 'src/x.ts')` → `'/Develop/SpaceAssistant/E:\work/src/x.ts'`（cwd 拼接乱码）；`path.win32.resolve` → `'E:\work\src\x.ts'`（正确）。相对路径无自身语法，二态方案会把 win32 生产主路径（`read_file src/foo.ts`）全部打碎。

| # | 改动 | 文件 | 说明 |
| --- | --- | --- | --- |
| 1.1 | `normalize()`：引入三态。②→ `path.posix.resolve(value)`（原为平台 `path.resolve`）；① 保持 `path.win32.normalize`；realpath 兜底（:97）的 fallback 同步三态（POSIX 语法失败回退 `path.posix.resolve` 形态） | `readPathFacts.ts` | |
| 1.2 | lexical 解析（:112）与 **pathApi 选择（:111，N3）**：`pathApi = ① ? path.win32 : ② ? path.posix : 按 workDir 语法`；lexical = ① normalize / ② `path.posix.resolve(rawPath)` / ③ 按 workDir 语法的 `resolve(workDir, rawPath)`。dirname/join/relative/父目录回退全部用同 pathApi（否则产出混合分隔符） | `readPathFacts.ts` | N3：语法驱动贯通到 pathApi，不只 resolve |
| 1.3 | `writePathFacts.ts`：与 1.1/1.2 同构——`pathApi`（:99）三态、`lexicalPath`（:106）三态。**v3（B4 修正）：env 路径（workDir/userDataDir/homeDir/customPrefixes）的 canonicalize 按「每个路径自身语法」选 API**（win32 形态 → win32 API；POSIX 形态 → posix API），**与 rawPath 的分支无关**——现状传进程 `path`（win32 上 = win32 API）对 win32 形态 env 路径本就正确；v2 曾指示 POSIX rawPath 分支整体传 `path.posix`，会把 win32 形态 workDir 打成 cwd 拼接乱码并抛 WritePathProbeError（探针实测 `path.posix.resolve('E:	mp\wd')` → `'/Develop/SpaceAssistant/E:	mp\wd'`），重演 B1 | `writePathFacts.ts` | |
| 1.4a | **新增（B3）：`canonicalizeThroughExistingParent` 父目录回退根守卫**。探针实测 v2 实施后的执行轨迹：`/etc/x` realpath ENOENT → `/etc` ENOENT → **`/` realpath 在 win32 成功返回 `'E:'`** → `path.posix.join('E:', ...)` 产出混合形态 `'E:\/etc/x'` → 命中 isWindowsAbsolute → 归一 `e:/etc/x` 后 system-dir 两方向正则都不命中 → 仍归 outside-workdir，write 探测链路的约 8/17 用例仍红。修法（双保险）：① realpath 成功后校验返回形态与 pathApi 语义一致（POSIX 分支要求 `real.startsWith('/')`），不符视为「真实文件系统不可达」，按原 error 继续 fail-closed 流程；② 回退循环加语法根守卫（POSIX API 下 `candidate === '/'` 即终止并抛原 error，防止 `/` 的 win32 realpath 提前返回）。目标行为 = 1.4 的声明：POSIX 语法路径在 win32 上探测不可达 → `targetKind='missing'` + zone 由纯函数判定 | `writePathFacts.ts` | **write 探测链路 8 个用例（run_shell×2、run_script×4、远程写入×1、writePathFacts×1）恢复的前置** |
| 1.4 | 行为边界显式化（写入实现注释与验收文档）：win32 进程上 POSIX 语法路径的真实 fs 探测不可达（`/etc/hosts` 实际探的是当前盘符子树）→ `targetKind='missing'` + zone 由纯函数判 `system-dir`——语义正确（该路径在 win32 文件系统确实不存在），fail-closed。**注意：该声明成立的前提是 1.4a 的根守卫**（无守卫时 `/` 的 win32 realpath 会把循环提前带回混合形态） | 两文件 | |
| 1.5 | **新增跨平台归类单测（回归锚）**：① `E:\work` + `src/x.ts` → `workdir-normal` 且 normalizedPath === `E:\work\src\x.ts`（**B1 回归锚，最高优先**）；② `/tmp/work` + `src/x.ts` → `workdir-normal` 且 `/tmp/work/src/x.ts`；③ POSIX 绝对 + win32 workDir（`/etc/hosts`）→ `system-dir`（**不得被「语法不一致判 outside」快速路径降级**）；④ win32 绝对路径原行为；⑤ pathApi 贯通断言（POSIX 路径的 dirname/join 产 POSIX 形态、无混合分隔符） | 三个 extractors 的 test 文件 | 评审 B1：原清单全是绝对路径，恰好漏掉③类回归锚；v2 补齐①② |
| 1.6 | pathClassifier 回归锚（B2 处置）：新增测试钉住现有正确行为——`/etc/hosts` + win32 workDir → `system-dir`、`C:\Windows\...` → `system-dir`；**不修改 pathClassifier 本体** | `pathClassifier` 测试 | 防「未来误以为它也有漂移」误改 |

**撤回项（B2）**：~~修改 `pathClassifier.resolveForEnvironment`~~、~~「语法不一致直接判 outside」快速路径~~——后者会把 pathClassifier 现有正确的 system-dir 判定降级为 outside-workdir，与 fail-safe 矛盾。pathClassifier 如需改动另行立项并附失败复现。

### 批次 2（P0·测试基建）：Windows symlink 能力探测 + 语义等价的降级验证（v1 方案保留，评审确认无需修改）

| # | 改动 | 说明 |
| --- | --- | --- |
| 2.1 | 新增 `src/test/symlinkCapability.ts`：模块级一次性探测（临时目录 `fs.symlink` 试创建 + 清理，缓存结果），导出 `canCreateSymlinks()` | 5 个测试文件复用；forks 单 worker 下进程级缓存安全 |
| 2.2 | 9 个用例 `it.skipIf(!canCreateSymlinks())`，skip 理由写明「win32 非特权进程无 SeCreateSymbolicLinkPrivilege；安全语义由 2.3 mock 通路在 win32 覆盖」 | 有特权环境 / Linux CI 照常真跑 |
| 2.3 | **关键**：为 symlink 越界检测补 mock 通路用例——不创建真 symlink，`vi.spyOn(fs, 'lstat'/'realpath')` 返回 symlink 形态 stat（`isSymbolicLink() === true` + realpath 指向外部）。覆盖 `feishuMediaFacts.classifyFeishuMediaTarget`、`readPathFacts.probeReadPathFact` symlink 分支、gate 的 wechat/feishu media 事实提取；**win32 无条件执行** | 越界检测语义在每平台都有回归锚 |
| 2.4 | `weChatToolExecutor` symlink 用例同 2.2/2.3 | |

### 批次 3（P1·测试修正，v2 按 N2 调整顺序）

| # | 改动 | 说明 |
| --- | --- | --- |
| 3.1 | EACCES 用例（组 2）：**先重验**——批次 1 修复后 lexical 回到 POSIX 形态，mock 字面量应相等、用例大概率自然转绿；仅当仍红才改 mock 判定为双侧归一比较 | 条件任务（N2） |
| 3.2 | `readReadIntegration.test.ts:121`：断言改 `path: path.join('target', 'visible.txt')`（或对 relative 结果归一 `/`） | 一行级改动（v1 方案保留） |

### 批次 4（P1·门禁固化，v1 方案保留）

1. 修复后 win32 本机全量 `npm run test:electron` **0 failed**；
2. 验收文档记录：boundary policy 系列在 win32 从未跑全量的原因与后果，把「win32 全量」固化为合入门禁；
3. `0bc23ea9` 式 fixture 修改后续必须附 win32 实跑记录。

### 验收口径（v2 按 N1 统一）

- **组 1 的 17 个用例全部恢复**（v1 的「16 个转绿」口径作废）。**v3 前置：write 探测链路的约 8 个用例（run_shell×2、run_script×4、远程写入×1、writePathFacts×1）依赖 1.4a 根守卫**——仅修 resolve 不加守卫时，`/` 的 win32 realpath 会把父目录回退带回混合形态，该 8 个用例仍红。其中 writePathFacts 用例经 1.3/1.4a 修复后自然恢复（`/etc/...` POSIX 绝对 → `path.posix.resolve` → 命中 isSystemDir），**无需 fixture 修正**——推导：该用例 workDir 为 win32 形态临时目录（按自身语法走 win32 API canonicalize，realpath 成功）、目标为 POSIX 绝对，走 ② 分支后不涉及 workDir 拼接；
- 组 2 的 EACCES 用例按 3.1 重验后转绿（自然恢复或一行修正）；
- 组 3 的 9 个用例在非特权 win32 显式 skip（理由可查），新增 mock 通路用例全绿，Linux CI / 特权 win32 上真 symlink 路径照常执行；
- 组 4 转绿；
- win32 本机 `npm run test:electron` **0 failed**；新增回归锚（1.5/1.6）全绿；
- 修订 `tool-invocation-reliability-acceptance-evidence.md`，附 win32 全量运行记录与 N4 策略决策记录。

### 工作量与顺序

| 批次 | 工作量 | 依赖 |
| --- | --- | --- |
| 批次 1（含 1.4a 根守卫 + 1.5/1.6 回归锚） | ≈1 人日（1.4a 约 +2h） | 无 |
| 批次 2 | ≈0.5–1 人日 | 无（可与 1 并行） |
| 批次 3 | ≈0.1 人日 | 3.1 依赖批次 1 |
| 批次 4 | ≈0.2 人日 | 1–3 完成 |
| 合计 | ≈2–2.5 人日 | 1+2 并行 → 3（重验）→ 4 |

### 明确不做 / 边界

- **不修改 `pathClassifier.ts` 本体**（B2）：行为正确且不在失败链路；仅补回归锚。其与 probe* 双实现并存的统一另行立项；
- **不引入「语法不一致判 outside」快速路径**（B2）：会把现有正确的 system-dir 降级；
- 不修改 V4 规则矩阵语义（zone 修正后规则定位自动对齐）；
- 不删除 symlink 用例（以 2.2/2.3 保覆盖）；
- P3 级遗留（`\\?\` 设备路径、`runLarkCliExecutor` 中文句子 error）另列后续。

### 已知边界记录（v2，随批次 1 落地写入验收文档）

- **N4**：win32 上 `/etc/hosts` 按「语法意图」归 system-dir，而非真实指向（当前盘符）；对真实 `E:\etc\` 文件是保护升格（收紧），需安全侧确认接受；
- **N5（v3 如实改写——v2 的「不构成漏判」论证经探针证伪）**：`classifyReadPathZone`（`readPathFacts.ts:68`）对 POSIX 语法路径 `platform='posix'`，而 userDataDir/homeDir 为 win32 形态——`matchSensitive` 双侧 normalize 后形态不同，**内置/用户目录敏感前缀对 POSIX 语法路径不命中**。且 `/home/...`、`/Users/...`、`/root/...` 等 POSIX 用户目录**不命中** system-dir 根正则（探针实测三者均 false）→ 落 `outside-workdir` 且敏感前缀不命中 → **在 win32 上无 zone 级保护**。这是 pre-existing 行为（非本计划回归，现状 `path.resolve` 漂移后同样不命中），但必须如实告知安全侧：该类路径的拦截依赖 gate/permit 层的其它机制或用户显式配置 POSIX 形态 `customSensitivePrefixes`（如 `/home`、`/root`、`/Users`）。`/etc`、`/var`、`/System` 等系统根仍按 1.4/1.4a 归 `system-dir`（更强保护）；
- 语法混用路径（`E:\work` 与 `/etc/...` 同现于一次调用的多个事实）各自按语法归类，互不影响。
