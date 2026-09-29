# 评审：合并后 28 个测试失败根因分析与修复计划

- 评审对象：`docs/review/2026-09-29-merge-main-28-failures-analysis-and-fix-plan.md`
- 评审日期：2026-09-29
- 评审方式：逐条对照生产代码（`readPathFacts.ts`、`writePathFacts.ts`、`pathClassifier.ts`、`toolCallGate.ts`、`runExtractors.ts`）+ Node 探针实测 + vitest 定向复跑失败用例
- **结论：存在 2 个阻断性问题（B1、B2），修复计划按现文实施会引入比原缺陷更严重的生产回归。根因分析主体（组 1 漂移机制、组 3 symlink EPERM）经实测确认属实，批次 2/3/4 方向正确。**

## 评审中已验证属实的内容

- 组 1 漂移机制属实：win32 上 `path.resolve('E:\\work', '/etc/hosts')` → `E:\etc\hosts`（探针实测），`readPathFacts.ts:41/:97/:112`、`writePathFacts.ts:106` 的平台相关 resolve 确为漂移源。
- 定向复跑 `toolCallGate.test.ts`「V3 run_script \$language 的路径事实进入系统目录真人确认」×3：全部失败，实际信号为 `{ kind: 'path-target', path: 'E:\\etc\\hosts', zone: 'outside-workdir' }`，与文档描述的失败形态一致。
- EACCES 用例（`toolCallGate.test.ts:1290-1293`）、`readReadIntegration.test.ts:121` 断言字面量、组 3 symlink EPERM 分组：与代码核对一致。
- 数量账一致：17+1+9+1=28；confirmation 目录 27 = 17+1+8+1。

## 阻断性问题

### B1：批次 1 修复原则对相对路径致命——「非 win32 语法即 POSIX」会打破 win32 生产主路径

文档 1.1/1.2/1.3 的原则是「路径按自身语法选择解析语义（`isWindowsAbsolute` → win32，否则视为 POSIX 语法）」。但**相对路径没有自身语法可言**，其解析语义由 workDir 决定。探针实测：

```
path.posix.resolve('E:\\work', 'src/x.ts') → '/Develop/SpaceAssistant/E:work/src/x.ts'   // cwd 拼接的乱码
path.win32.resolve('E:\\work', 'src/x.ts') → 'E:\\work\\src\\x.ts'                        // 正确
```

`readPathFacts.ts:112` 与 `writePathFacts.ts:106` 是 win32 上**相对路径读写的主入口**（`read_file`/`write_file` 传 `src/foo.ts` 是常态，此时 `isWindowsAbsolute(rawPath) === false` 而 workDir 是 win32 形态）。按文档方案把这里的 `path.resolve` 改成 `path.posix.resolve`，win32 上所有相对路径的 normalizedPath 都会变成 cwd 拼接形态，zone 归类、permit 绑定、symlink 检测全面失效——这比原缺陷（POSIX 绝对路径误归 outside）严重得多。

正确分派规则应是三态而非二态：

1. rawPath 为 win32 绝对 → win32 语义；
2. rawPath 为 **POSIX 绝对**（`/` 开头且非 win32 绝对）→ posix 语义；
3. rawPath 为**相对路径** → 按 **workDir 的语法** resolve（win32 workDir 用 `path.win32.resolve`，POSIX workDir 用 `path.posix.resolve`）；workDir 与相对路径组合不存在语法歧义。

文档通篇未区分「POSIX 绝对」与「相对」，1.5 的新增单测清单（全是绝对路径用例）也恰好漏掉了「相对路径 + win32 workDir」这个回归锚——按现文实施且按现文验收，该回归不会被任何一条验收口径拦住。

### B2：pathClassifier 根因归属错误——1.2 在修一个未复现的"缺陷"，且快速路径会改变现有正确行为

两条独立证据：

1. **失败信号的形态证明它不来自 pathClassifier**。实测失败信号为 `path: 'E:\\etc\\hosts'`，而 `buildPathSignal`（`pathClassifier.ts:74`）原样透传 `rawPath` 作为 `path` 字段，绝不可能产出漂移后的形态。实际链路是：run_shell / run_script 的 path-target 信号全部来自 `probeWritePathFact`（`toolCallGate.ts:282`、`:484-485`），读取工具来自 `probeReadPathFact`（`runExtractors.ts:128`）。pathClassifier 只在 `shellConfirmationAdapter.ts:53` 与 `runExtractors.ts:52` 使用，不在这些失败用例的链路上。
2. **pathClassifier 对该场景行为本就正确**。`resolveForEnvironment()` win32 分支对 `/etc/hosts`：`replace(/\//g,'\\')` → `path.win32.isAbsolute('\\etc\\hosts') === true`（ rooted 路径）→ 走 `path.win32.normalize`（**不补盘符、不漂移**）→ `isSystemDir` 转小写后 `/etc/hosts` 命中 posixRoot 正则 → 归 `system-dir`。

即文档 1.1 表格中 pathClassifier 这一「落点」不成立：V3 run_script 系列、远程写入 system-dir 的失败全部可由 writePathFacts 一处漂移解释。更危险的是 1.2 提议的「语法不一致时直接判 outside」快速路径：当前 `/etc/hosts` + win32 workDir 在 pathClassifier 下归 `system-dir`，若快速路径在 isSystemDir 检查之前短路，会把 zone 从 system-dir **降级**为 outside-workdir——与文档自己宣称的 fail-safe 方向相反。

处置建议：删除或重写 1.2。若坚持改 pathClassifier，必须先给出一个该组件导致的失败复现（现有 17 个失败均不经过它），并明确快速路径与 isSystemDir 检查的先后顺序。

## 非阻断问题

- **N1（口径矛盾）**：批次 1 验证口径称「预期 16 个转绿（17 减去 writePathFacts 中可能仍需 fixture 修正的）」，但验收口径要求「组 1 的 17 个用例恢复」，且四个批次中没有任何任务项认领这个 fixture 修正。缺口需补任务或改口径。
- **N2（组 2 与组 1 同源）**：EACCES 用例 mock 不命中，正是因为 probe 传入的 target 已漂移为 win32 形态。批次 1 修好后 lexical 回到 `/tmp/wd/blocked.txt`，与 mock 字面量相等，该用例大概率自然转绿——批次 3.1 可能多余。建议实施顺序上先跑批次 1 再定 3.1 是否还需要。
- **N3（pathApi 选择未纳入修复范围）**：`readPathFacts.ts:111`、`writePathFacts.ts:99` 的 `pathApi = windowsInput ? path.win32 : path` 在 win32 上 `path` 即 win32 API。POSIX 语法路径的 dirname/join/relative（父目录回退行走、symlink 组件检测）仍走 win32 API，修复 resolve 后会产出混合分隔符路径。语法驱动原则要贯通到 pathApi 选择，否则 1.1 只做了一半。
- **N4（语义决策需显式化）**：win32 上 `/etc/hosts` 的真实指向是当前盘符 `E:\etc\hosts`（并非系统目录）。将其归 `system-dir` 是「按语法意图而非实际指向」的 fail-safe 策略选择——方向安全，但对真实存在于 `E:\etc` 的文件是行为变更，文档 1.6 的安全侧告知应写明这一点。
- **N5（platform 参数错配隐患）**：`classifyReadPathZone`（`readPathFacts.ts:68`）在 win32 进程 + POSIX 语法路径时 `platform='posix'`，而 userDataDir/homeDir 是 win32 形态，`getBuiltinSensitivePrefixes(userDataDir, 'posix', ...)` 的内置敏感前缀与路径形态可能错配，需确认 sensitive-file 判定方向不漏。

## 处置建议

1. 按 B1 的三态分派规则重写批次 1 的 1.1/1.3，并在 1.5 单测清单中补「相对路径 + win32 workDir → workdir-normal」用例（这是最重要的回归锚）。
2. 按 B2 删除/重写 1.2；pathClassifier 如需改动另行立项并附失败复现。
3. 补齐 N3 的 pathApi 语法驱动，否则批次 1 验收时 symlink/父目录回退路径仍有混合分隔符风险。
4. 解决 N1 口径矛盾后再进入实施。

批次 2（symlink 能力探测 + mock 通路）、批次 3.2、批次 4（win32 全量门禁）无需修改，质量良好。
