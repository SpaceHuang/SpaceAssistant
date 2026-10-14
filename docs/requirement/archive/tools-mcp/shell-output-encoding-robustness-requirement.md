# Shell 输出编解码与可诊断性 — 需求规格

**版本：** 1.2
**日期：** 2026-09-12
**状态：** 已按评审 v1.0 修订（B1/B2 已解决）；D1/D2/D3/D5 已由用户确认、**D4 已否决（不给用户任何编码选项）**、D6/D7 待定（§14.1）；实现已落地，待抽查复评
**关联文档：** [bash-run-shell-current-state-and-optimization-review.md](../develop/bash-run-shell-current-state-and-optimization-review.md)、[tools-requirement.md](./tools-requirement.md)、[评审报告 v1.0](../review/shell-output-encoding-robustness-requirement-review-v1.0.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-12 | 初稿。以 2026-09-11 会话 `52ee622a` 的 `run_shell` 失败为触发，系统性重构「子进程字节 → 文本」链路；含事故字节级还原与 PowerShell prelude 实测矩阵 |
| 1.2 | 2026-09-12 | **D4 否决**：不引入任何用户级编码配置。理由：编码在不同层有不同归属（系统 CP / PowerShell 自身输出，含内部错误的 UTF-16LE / 被调用工具自带的 UTF-8），同一条流可能同时混有以上来源，任何单一用户取值都会有一部分解错；用户既无法判断也不应承担该决策。编码正确性由「启动契约（每个 spawn 点声明）+ 字节级判定 + 可疑留档」在应用内部闭环，见 §14.1 |
| 1.1 | 2026-09-12 | 按评审 v1.0 修订：**B1** 扩展 UTF-16 探测链（新增结构启发式 + `confidence: 'medium'`，纯 CJK 无 BOM 按样本量分档）、**B2** 重写 §8.2（交付与锁定分离，8 KiB 明确为「未判定缓冲上限」）、**M1** 解码点计数统一为 11 处、**M2** 状态与决策口径对齐（§14.1 注明来源）、**M3** 不改既有字段语义并给出兼容评估（§9.6 + 新增风险 R9）、**M4** R5 回滚修正、**T5** 拆为 T5a/T5b/T5c（B1 期望值收尾）并补附录 A.5 复核脚本、4 处行号校正、S1–S5 一般建议 |

---

## 目录

1. [概述](#1-概述)
2. [触发事故与证据链](#2-触发事故与证据链)
3. [现状分析](#3-现状分析)
4. [目标与非目标](#4-目标与非目标)
5. [编码真值来源模型](#5-编码真值来源模型)
6. [设计总览](#6-设计总览)
7. [契约层（L1）](#7-契约层l1)
8. [探测层（L2）](#8-探测层l2)
9. [保真层（L3）](#9-保真层l3)
10. [统一入口与诊断（L4）](#10-统一入口与诊断l4)
11. [测试基线（L5）](#11-测试基线l5)
12. [迁移清单](#12-迁移清单)
13. [实施阶段与验收标准](#13-实施阶段与验收标准)
14. [决策点](#14-决策点)
15. [风险与回滚](#15-风险与回滚)
16. [相关文件](#16-相关文件)
17. [附录 A：事故字节样本与还原脚本](#附录-a事故字节样本与还原脚本)

---

## 1. 概述

### 1.1 问题一句话

`run_shell`（以及其它基于子进程的工具）在 Windows 上会持续遇到「子进程输出无法正确变成文本」的问题：当前实现是**逐 chunk 猜测 UTF-8 / GBK**，既不稳定（会中途改判），又会在猜错时**同时丢失原始字节**，于是模型与用户都拿不到可诊断的信息。

这不是一次偶发 bug，而是「字节 → 文本」这条链路缺少统一设计：解码点散落在 11 处（10 处主进程 + 1 处跨进程共享，见 §3.1），各自的编码假设不同，且没有任何一层保留原始字节。

### 1.2 本需求要解决的四件事

| # | 问题 | 解决方向 |
|---|------|----------|
| R1 | 编码判定靠猜，且会在流中途改判 | 契约优先 + 一次性探测 + 锁定后流式解码 |
| R2 | 猜错后信息不可恢复 | 全链路保留原始字节，产出「可信文本 + 原始字节 + 解码来源」三件套 |
| R3 | 解码实现散落 11 处、策略各不相同 | 收敛为唯一入口，新增 spawn 点不可能再各写一套 |
| R4 | 失败信息不可操作 | 诊断投影：解码来源、Windows 宿主退出码映射、方言错配 hints 进入 `tool_result` |

### 1.3 本需求对「彻底」的定义（判据）

1. 任何子进程的任何字节流，都能给出 **可信文本 + 原始字节 + 解码来源**；解码失败 ≠ 信息丢失。
2. 编码判定**一次完成、可解释、可回溯**，不在流中途重新判定。
3. 能契约化的路径用契约，不能契约化的用探测；**契约失效时探测可以覆盖，且该事实本身被记录为诊断事实**。
4. 全仓库只有一处「字节 → 文本」实现，所有 spawn 点复用。
5. 用字节级 fixture 把以上行为钉死为回归测试。


## 2. 触发事故与证据链

### 2.1 事故时间线

会话 `52ee622a-1f98-494f-b39e-c1635f03285c`，用户指令「把这个需求文档提交一下」，Agent 首选 `run_shell` 执行 git。日志为 `.agent/logs/Agent-20260911.log`（打包模式运行），下表行号均指该文件。

| # | 日志行 | 时间 | 事件 | 关键字段 |
|---|--------|------|------|----------|
| 1 | L1015 | 15:29:37 | `tool.request` `run_shell` | `git status --short && echo ... && git log --oneline -5`（POSIX 语法） |
| 2 | L1017 | 15:29:37 | `tool.error` | `error: "SHELL_DIALECT_MISMATCH"` —— **只有一个裸错误码** |
| 3 | L1018 | 15:29:37 | `llm.request`（607,841 字符） | 回传给模型的该 `tool_result` 仍只有裸错误码：实测请求体不含 `signals`、`posix-operator`、`posix-bash`、`windows-powershell`、「PowerShell 语法」中的任何一项 |
| 4 | L1024 | 15:29:39 | `tool.request` `run_shell` | 模型改写为 PowerShell 语法（`;` + `Write-Output`） |
| 5 | L1029 | 15:29:42 | `shell.exec.spawned` | `pid: 36252`、`executable: powershell.exe`、`shell: builtin-windows-powershell` |
| 6 | L1032 | 15:29:43 | `shell.exec.finish` | `exitCode: 4294901760`、`exitCodeHint: "进程异常退出（退出码 4294901760）"`、`stdoutBytes: 0`、`stderrBytes: 154`、`durationMs: 3072`、`outputArtifactBytes: 0`、`success: false` |
| 7 | L1033 / L1034 | 15:29:43 | `tool.error` / `tool.result` | 模型可见文本 = `命令执行失败（退出码: 4294901760）` + 乱码 stderr（实测该字符串含 **50 个 NUL 字符**） |
| 8 | L1036 → L1040 / L1044 / L1045 / L1046 | 15:29:45 → 15:29:48 | 最小命令 `git status --short` | 同样 `exitCode: 4294901760`、`stderrBytes: 154`、`stdoutBytes: 0` → **与命令内容无关** |
| 9 | L1060 / L1075 | 15:29:53 → 15:30:03 | `run_script`（Python `subprocess`） | Python 通道全程成功：`git version 2.34.0.windows.1`、分支 `main`、`git status --short` 正常返回含中文路径的变更列表 |
| 10 | L1061 | 15:29:53 | 模型 thinking | 模型自行识别「乱码解码：UTF-16LE 的乱码」，手工拼出 `W\0i\0n\0d\0o\0w\0s\0`，并开始反复猜 `0x8009001d` 是哪个 HRESULT（多次猜错） |

由此可直接读出三点事实：

1. **第一次失败是方言错配**，本可自愈（signals/hints 已算出），但这部分信息没有进入 `tool_result`，模型只拿到一个错误码，于是浪费了一轮改写。
2. **第二、三次失败是宿主层启动失败**（`powershell.exe` 在 prelude 之前就退出），工具把唯一的诊断信息（HRESULT `0x8009001d`）以乱码形式交给模型。
3. **Agent 最终绕过 `run_shell`**，用 `run_script` + Python `subprocess` 完成 git 操作。而 `run_script` 之所以可用并非巧合——它显式钉死了编码契约（`PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`，赋值见 `electron/processOutputEncoding.ts:100-102`，调用见 `electron/tools/builtinExecutors.ts:1173-1175`）。

> **耗时口径的坑**：`shell.exec.spawned`（15:29:42.899）→ `shell.exec.finish`（15:29:43.023）只有 **124 ms**，而 `durationMs` 报 **3072 ms**。子进程是快速失败，`durationMs` 覆盖了 spawn 之前约 2.95 s 的计划/确认链。也就是说：**单看 `durationMs` 无法区分「宿主启动失败」与「命令执行慢」**，这是 §3.6 的可诊断性缺口之一。

### 2.2 关键证据：那 154 字节到底是什么

本需求已对事故日志做到**字节级还原**，结论如下。

原始 stderr 字节流（**136 字节**）是下列文本的 UTF-16LE 编码：

```
Windows PowerShell 内部错误。加载托管的 Windows PowerShell 失败，返回错误 8009001d。\r\n
```

即 68 个 UTF-16 码元（含 CRLF），编码后 136 字节：

```
570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000
8551e8901995ef8b0230a0527d8f5862a17b84762000
570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000
3159258d0cffd48fde561995ef8b20003800300030003900300030003100640002300d000a00
```

即：`Windows PowerShell ` → `内部错误。加载托管的` → ` Windows PowerShell ` → `失败，返回错误 8009001d。` → CRLF。

本机可复核的验证结果（Node 内置 `TextDecoder`，与主进程同一实现）：

| 验证项 | 结果 |
|--------|------|
| `new TextDecoder('gbk').decode(B)` 是否**逐字符等于**模型看到的 126 字符乱码 | **true** |
| `new TextDecoder('utf-8').decode(B)` 是否等于该乱码 | false |
| UTF-8 解码结果是否含 `U+FFFD` | **true** |
| GBK 解码结果是否含 CJK | **true** |
| 解码后文本的 UTF-8 字节长度 | **154**（= 日志中的 `stderrBytes`） |
| 原始字节数 | **136** |

把上述事实与 `electron/processOutputEncoding.ts:51-60` 的判定规则对齐：

```ts
export function decodeProcessOutput(buf, platform = process.platform) {   // :51
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (platform !== 'win32') return utf8                                 // :54（原稿漏引这一行）
  const gbk = new TextDecoder('gbk').decode(buf)
  const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s)
  if (hasCjk(gbk) && !hasCjk(utf8)) return gbk
  if (utf8.includes('\uFFFD') && hasCjk(gbk)) return gbk                // ← 本次事故命中这一条
  return utf8
}
```

> 上为逐字引用（仅省略参数/返回类型标注与缩进对齐），遗漏的平台判断行见 `electron/processOutputEncoding.ts:54`。

于是链路被完整解释：

**UTF-16LE 字节 → UTF-8 解码产生 U+FFFD → 启发式回退 GBK → 得到 126 字符乱码 → 记作 `stderrBytes: 154` 的「文本」→ 原样拼进模型可见的 `tool_result`。**
由此得到 6 条结构性结论，构成后续所有设计的出发点：

| # | 结论 | 依据 |
|---|------|------|
| C1 | Windows 上「子进程输出」至少存在 **3 类**真值：UTF-8、OEM 代码页（zh-CN 通常 936/GBK 但并非总是）、**UTF-16LE**（宿主自身报错）。现有实现只承认前 2 类 | 原始字节 = UTF-16LE |
| C2 | 以「UTF-8 解码是否含 U+FFFD」作为回退判据不可靠：本次恰好把唯一有价值的 HRESULT 变成乱码 | 判定分支被命中 |
| C3 | `stderrBytes: 154` 不是原始字节数（原始 136），而是**解码后文本的 UTF-8 长度**，读日志的人会误判 | `electron/shell/boundedOutput.ts:30,54`、`electron/tools/runShellExecutor.ts:431,446` |
| C4 | `outputArtifactBytes: 0` —— **原始字节没有任何留存**。本次能还原靠的是「Windows 本地化字符串可推导 + 逐字节反解验证」，属运气；一般情形不可恢复 | 日志字段 |
| C5 | 50 个 NUL 字符原样进入模型可见文本，模型被迫自己做编码考古并猜 HRESULT | `tool.error` / `tool.result` 的 NUL 计数均为 50 |
| C6 | 失败信息里没有任何「编码来源」元数据，模型与人都无法判断这段文本是否可信 | 日志与 `tool_result` 均无 encoding 字段 |

### 2.3 三个独立问题被压缩成一个错误码

事故里其实同时发生了三类互不相同的失败，但都对模型投影成「一个码 + 一段乱码」：

| 实际发生的事 | 当前投影（模型看到的） | 应有投影 |
|--------------|------------------------|----------|
| 方言错配：命令用 POSIX `&&`，profile 是 PowerShell | `SHELL_DIALECT_MISMATCH` | 错误码 + `signals`（`posix-operator`、`posix-variable`…）+ `hints`（改用 `$env:NAME`、`;` 等）+ 当前 shell profile |
| 宿主启动即失败：`exitCode 0xFFFF0000` | `进程异常退出（退出码 4294901760）` | 映射为「Windows 宿主进程初始化失败」+ `0x8009001D NTE_PROVIDER_DLL_FAIL` 语义 + 建议（改用 `run_script`、检查宿主机安全/加密组件、重试） |
| stderr 是 UTF-16LE 且被判成 GBK | 126 字符乱码（含 NUL） | 可信文本（`Windows PowerShell 内部错误。…错误 8009001d。`）+ 解码来源（`utf16le`）+ 原始字节 artifact |

三者中**只有第一个是「可以靠提示自愈」的**；第三个是「信息本来存在、但被链路毁掉」；第二个是「信息存在、但没被解释」。当前实现把三者压成同一种形态，导致模型既不能自愈，也不能自助。

### 2.4 本机复测：宿主失败是瞬时状态，但可诊断性缺口是常态

为区分「命令/实现问题」与「宿主瞬时状态」，在同一台机器上做了三组复测：

| 复测 | 命令 | 结果 |
|------|------|------|
| A：同参数同命令 | `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <prelude + git status --short>` | **exit 0**，正常输出（含 git 的 `Permission denied` warning）。说明事故当时属**宿主瞬时状态**，与命令内容无关 |
| B：非法 Base64 | 同上但 `-EncodedCommand not!base64!` | exit **0xFFFD0000**（Node 上报 4294836224），stderr 为 136 字节英文提示 `Cannot process the command because the value specified with -EncodedCommand is not properly encoded…` |
| C：宿主环境扰动 | 本机装有安全/加密组件（如 `SangforPWEx`），子进程访问用户目录配置会被拦截 | 任意子进程读 `C:\Users\Space\.config\git\ignore` 一律 `Permission denied`；与 `0x8009001D`（加密提供程序 DLL 相关）指向同一类宿主层干扰 |

结论：

1. **宿主层的失败无法由本应用消除**（第 5 类真值来源、安全软件拦截、系统组件损坏都在应用之外）。
2. 因此本需求的边界是：**不能保证子进程不失败，但必须保证「失败可诊断、字节不丢失、编码不错杀」**。
3. 复测 B 同时给出了两个新的映射需求：`0xFFFD0000` 这类 Windows 宿主退出码需要进映射表；宿主自己写的错误文本也可能是**英文**（取决于宿主 UI 语言），不能再假设「中文乱码就是 GBK」。

### 2.5 事故性质判定

这不是「PowerShell 坏了」的偶发故障，而是一次**结构性缺陷暴露**：

- **编码真值假设过窄**：代码隐含「要么 UTF-8、要么 GBK」，而实际至少有 7 类真值来源（§5）。
- **判定可翻转、可错杀**：启发式判据在本次正好选错，且没有第二道防线（如保真层）。
- **原始字节不留存**：一旦判定错，信息即永久丢失，且 artifact 与主通道共享同一次错误解码（§3.4）。
- **诊断投影不足**：错误码无 Windows 映射、方言 hints 不转发、没有「文本是否可信」的标记（§3.6）。

下一章把这四点落到具体代码位置。
## 3. 现状分析

### 3.1 解码点清单：11 处「字节 → 文本」，策略各不相同

下表为全仓库实测清单（`rg` 全量扫描 `toString(...)` / `TextDecoder` / `new TextDecoder` 后逐一确认）。

| # | 位置 | 形态 | 问题 |
|---|------|------|------|
| 1 | `electron/processOutputEncoding.ts:25-44` `createProcessOutputStreamDecoder` | 非 win32 走 UTF-8 流式；win32 **每来一个 chunk 就重解整块**，再用 `text.slice(lastText.length)` 取增量 | 编码判据一旦在两次 flush 之间翻转，`slice` 会按**字符下标**切到另一份解码结果上 → 增量错位/丢字；且判定无记忆，随时改判（既有目标态文档 §3.8 P1 已记录同一问题） |
| 2 | `electron/processOutputEncoding.ts:51-60` `decodeProcessOutput` | 同时算 UTF-8 与 GBK 全文，用「GBK 含 CJK 且 UTF-8 不含」「UTF-8 含 U+FFFD 且 GBK 含 CJK」二选一 | **本次事故即命中此分支**；`gbk` 是硬编码假设（非 zh-CN 宿主即为错）；U+FFFD 判据不可靠（§2.2） |
| 3 | `electron/processOutputEncoding.ts:9-19` `createStreamTextDecoder` | `TextDecoder` + `{stream:true}`，只支持 `utf-8`/`gbk` | 形态本身是**正确**的（同一编码器跨 chunk 保状态），但编码集合过窄、无探测/无 BOM/无 UTF-16 |
| 4 | `electron/tools/runShellExecutor.ts:168-169`（主通道，经 #1）与 `:546`（`testShellExecutable`，经 #2） | 同一工具内两条解码路径 | 主通道与「测试解释器」结论可能不一致；`durationMs`、字节数口径也不一致 |
| 5 | `electron/tools/builtinExecutors.ts:791,793,800,801,818` `grepWithRg` | ripgrep stdout/stderr **逐 chunk `toString('utf8')`** | 与 shell 通道策略不同；多字节字符跨 chunk 边界必然损坏；截断用 `Buffer.from(text,'utf8')` 再切，可能切断多字节 |
| 6 | `electron/tools/builtinExecutors.ts:1173-1175` `run_script` | `buildPythonScriptEnv()` 钉死 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，解码用 #3 | **正面样例**：契约显式、单侧决定，故事故中成为唯一可用通道（§2.1） |
| 7 | `electron/feishu/larkCliRunner.ts:143,147` 与 `:152-153` | 回调给 UI 的路径逐 chunk `toString('utf8')`；返回给业务的结果用整块 `decodeProcessOutput` | **同一次执行两条不一致的解码**；UI 看到的与业务拿到的不一定相同 |
| 8 | `electron/spawnUtil.ts:53` `runCommandWithTimeout` | `Buffer.concat(chunks).toString('utf8')`；stderr 直接 `ignore`（`:37`） | 消费者含 `builtinExecutors.ts:1135`（Python 探测）、`orphanProcessCleanup.ts:29,35,47,59`（CIM/wmic/ps/taskkill 校验进程属主）、`larkCliRunner.ts:41`；**stderr 被丢弃**，故「宿主为什么失败」在这里直接消失；`orphanProcessCleanup.ts:24-28` 的注释已自认该风险（「审计证据会失真」，目标态文档 `:882` 记录了 `owner-中文-…` → `owner-����-…` 的实测事故） |
| 9 | `electron/appIpc.ts:556-562` `tool:test-interpreter` | 自带 `spawn` + 逐 chunk `toString('utf8')` | 与 #8 同类问题各写一套 |
| 10 | `electron/mcp/stdioTransport.ts:174-182` | MCP 子进程 **stderr** 逐 chunk `toString('utf8')` 后按行切分 | JSON-RPC 帧由 SDK 的 `StdioClientTransport` 解析，故不影响协议；但跨 chunk 切断多字节会污染日志行，也会把一行错误地拆/并 |

另有 1 处跨越进程边界：

| # | 位置 | 形态 | 问题 |
|---|------|------|------|
| 11 | `src/shared/terminalScrollback.ts:122` | 终端回滚缓冲 `new TextDecoder('utf-8', { fatal:false })` | 终端模式下的 PTY 字节被**硬编码**按 UTF-8 解码；其真值取决于 profile（§7），与主通道必须一致，否则「终端里正确、模型看到的乱码」 |

**明确排除在本需求之外（属「文件内容编码」另一命题）**：`electron/tools/readFileStreaming.ts:70,129,159`、`electron/tools/builtinExecutors.ts:319,906`、`electron/tools/readFeishuAttachmentExecutor.ts:25`、`electron/fileReadHelpers.ts:36`。它们读的是用户文件（真值由文件编码/BOM 决定），与「子进程管道字节」是不同问题，混在一起修会导致范围失控（见 N2）。

### 3.2 `ShellProfile.encoding` 是死字段：契约在类型上存在、在行为上不存在

- `electron/shell/shellProfiles.ts:11` 声明 `encoding: 'utf8' | 'utf16le'`，Profile 里也填了值（`:27` macos-bash = `utf8`，`:45` windows-powershell = `utf16le`）。
- `electron/shell/preparedShellExecution.ts:11` 把它纳入 `PreparedShellExecution.profile`，随 plan 一起冻结、并参与 `planDigest`（即「契约」在计划层是被承诺的）。
- 但全仓库**没有任何消费者**读取它：`runShellExecutor` 用的是 `createProcessOutputStreamDecoder()`（不接收 encoding 参数）；`createStreamTextDecoder` 的入参只有 `utf-8 | gbk`，与 `'utf16le'` 类型不兼容，根本传不进去。
- 唯一「使用」它的是测试对快照的冻结断言（`electron/shell/shellProfiles.test.ts:58`）。

结论：**当前不存在任何编码契约**——计划里写着一个值，解码时按另一套启发式走，两者互不校验。这正是 G1/R1 要修的根因。

### 3.3 契约覆盖不到宿主层：prelude 的双刃性（实测）

`WINDOWS_POWERSHELL_PRELUDE`（`electron/shell/shellProfiles.ts:55-57`）在用户命令前注入：

```powershell
$ProgressPreference = 'SilentlyContinue';
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new();
```

本机实测（Windows PowerShell 5.1，管道 stdout，`-NoProfile -NonInteractive -EncodedCommand`）结果如下：

| 场景 | 无 prelude | prelude 设 UTF-8 | prelude 设 936 |
|------|-----------|------------------|----------------|
| PS 自身 `Write-Output "中文测试"` | `d6d0cec4b2e2cad4`（10B，GBK） | `e4b8ade69687e6b58be8af95`（14B，UTF-8） | `d6d0cec4b2e2cad4`（10B，GBK） |
| native 工具硬编码输出（`git log`、raw GBK/UTF-8） | 字节**原样透传** | 字节**原样透传** | 字节**原样透传** |
| native 工具按 console CP 输出（`cmd /c echo 中文`） | GBK 10B | **UTF-8 14B** | GBK 10B |
| PS 把 native 输出变成字符串（`$x = (node raw-gbk)`） | 未测 | **`U+FFFD`×6，信息不可逆** | 字节可逆的坏字符映射 |

由此得到 4 条硬结论：

1. `[Console]::OutputEncoding` 确实能把 **PS 自身写 stdout** 的编码钉死为 UTF-8 —— 这部分契约是有效的。
2. 它同时会改变**按 console CP 输出的子进程**的行为（`cmd` 内建由 GBK 变 UTF-8）—— 即 prelude 会**隐式改变子进程的输出编码**，这是当前最隐蔽的耦合。
3. 对**硬编码自身编码**的工具（`git`、`node`、多数现代 CLI），prelude 不影响其字节：只能靠探测（L2）。
4. **关键风险（实测）**：当命令需要 PS 把 native 输出转成字符串（赋值、管道给 cmdlet、`-match` 比较）时，解码走 `[Console]::OutputEncoding`。设为 UTF-8 时遇到 OEM CP 字节会产出 `U+FFFD`，**不可逆**（实测 8 字节 GBK 变成 6 个替换字符）；设为 936 则是可逆的坏映射。也就是说：**「把 prelude 设成 UTF-8」并不安全，反而在 native 编码不匹配时硬失败**。

同时，宿主**自身**的失败发生在 prelude 之前（本次事故的 136 字节就是 `powershell.exe` 初始化失败时写出的），所以**任何 prelude 契约都覆盖不到这一层**——这类输出必须以探测兜底 + 原始字节留存 + 退出码映射来处理（L2/L3/L4）。

### 3.4 原始字节未保留：一次解码错了，就永久错了

- `electron/shell/boundedOutput.ts:30,54`：`append(chunk)` 收到的是**已解码文本**，内部 `Buffer.from(chunk,'utf8')` 再编码；`snapshot().bytes` 因此是「解码后文本的 UTF-8 长度」。事故中的 `stderrBytes: 154`（原始 136）即由此而来（`runShellExecutor.ts:431,446`）。
- `electron/tools/runShellExecutor.ts:285-304`：同一个 `chunk` 字符串被同时喂给 `stdoutBounded`、`recordArtifact`、`stdout` 累加、`pushProgress` —— **四条下游共享同一次可能错误的解码**。
- `electron/shell/outputArtifactWriter.ts:33-36`：`Buffer.from(text,'utf8')` → artifact 里存的也是「再编码后的 UTF-8」，而非原始字节。事故里 `outputArtifactBytes: 0`；即使非 0，也救不回原始字节。
- `electron/tools/runShellExecutor.ts:546`：`testShellExecutable` 又独立做一次 `decodeProcessOutput`，与主通道结论无关。

结论：**保真层（L3）是当前完全缺失的一环**。没有它，任何探测/判定错误都等价于信息丢失；有了它，误判只是「文本显示不佳」，人可以事后用原始字节重解。

### 3.5 判定可翻转 + 增量错位：结构性风险

需要区分两件事（避免过度归因）：

- **本次事故的直接原因是「单次判定选错编码」**：整段 136 字节被一次性按 GBK 解码（§2.2 已验证 `gbkDecode(B)` 与模型所见完全一致），不存在混合解码。
- **但 #1 的实现方式本身就允许「中途改判 + 增量错位」**：每次 flush 都重解整块并取 `text.slice(lastText.length)`。只要判据在两次 flush 之间翻转（例如前段尚无 CJK、后段出现 CJK），增量就会切到另一份解码结果的字符下标上 → 出现「同一段文本里前后编码不一致」的输出。这类错误**不可自愈**，且比「整段选错」更难排查。

因此本需求把「判定一次、锁定后不改判」列为不可违反的实现原则（§6），并用跨 chunk 用例钉死（§11），而不是把它当成一次偶发。

### 3.6 诊断投影不足：可操作信息在最后一跳丢失

| 缺陷 | 位置 | 后果（本次事故） |
|------|------|------------------|
| Windows 宿主退出码无映射 | `electron/shell/shellExitCodes.ts:1-9` 只映射 1/2/126/127/130/137/143 | `4294901760` 只能显示为「进程异常退出（退出码 4294901760）」，无人能看出是 `0xFFFF0000`（Windows 宿主初始化失败） |
| 方言错配的 `signals`/`hints` 不转发 | `electron/shell/shellDialectMismatch.ts:23-27` 已算出信号与建议；但错误序列化只带 `error`+`userMessage` | 模型只看到 `SHELL_DIALECT_MISMATCH`（L1017/L1018 实测），白白浪费一轮 |
| stderr 原文被原样倒给模型 | `electron/tools/runShellExecutor.ts:510-518` | 50 个 NUL + 乱码进入 `tool_result`，模型要自己做编码考古（L1061） |
| 「文本非空但不可信」不可观测 | `runShellExecutor.ts:468-470` 的 `SHELL_OUTPUT_CAPTURE_LOST` 只在 `bytes>0 && text.length===0` 时触发 | 事故中 text 非空（虽全是乱码）→ 不触发；缺一个「解码可疑」的标记 |
| 编码与进程真值不可见 | `runShellExecutor.ts:414-478` 的 `shell.exec.finish` 字段集 | 无 `encoding`、无原始字节数、无「spawn→exit 实际耗时」（事故中工具报 3072ms，子进程实际只活 124ms） |

### 3.7 与既有目标态文档的落差

`docs/develop/bash-run-shell-current-state-and-optimization-review.md` 已提出方向，但未落地：

| 该文档 | 位置 | 本需求的关系 |
|--------|------|--------------|
| 目标态 profile 含 `encoding: 'utf8' \| 'gbk' \| 'oem' \| 'auto'` | :169 | 本需求把它从「类型占位」变成**有消费者的契约 + 探测兜底**（§7/§8） |
| P1：编码探测可能反复改判，建议启动期确定 + 前导窗口探测一次 | :326-335 | 本需求 §8 给出具体机制（锁定 + 前导缓冲 + 流式解码） |
| 结果缺少输出字节数、输出编码、终止原因等 | :385 | 本需求 §9/§10 给出 `rawArtifact` 与诊断投影的字段契约 |
| PowerShell 5.1 按宿主 OEM CP 写 stdout，按 utf8 解码 → 替换字符（实测） | :882 | 本需求 §7 用实测矩阵把这条经验升级为「契约 + 探测」的明确取舍 |
## 4. 目标与非目标

### 4.1 目标

| # | 目标 | 验收判据（可执行） |
|---|------|--------------------|
| G1 | **编码契约显式化并真正生效**：`ShellProfile.encoding` 有唯一消费者；每次执行在 plan 里确定「本次输出期望编码」及其来源 | 编码值进入 `PreparedShellExecution` 后，解码器由该值构造；删除该字段会编译失败（不再是死字段） |
| G2 | **判定一次、锁定后不改判**：整条流内编码不变；不存在「重解整块 + 字符下标取增量」 | 同一字节流按任意 chunk 切分（含 1 字节切分）解码结果与整块解码一致 |
| G3 | **探测兜底**：契约未知/失效时按确定优先级探测，且探测过程可解释 | 分两档：**① 必须判对**——BOM 样本、含 ASCII 锚点的 UTF-16（LE/BE）、UTF-8 / GBK / Big5 / Shift_JIS 样本、非 zh-CN OEM CP；**② 允许降级**——无 BOM 且无 ASCII 锚点的纯 CJK UTF-16：样本 ≥16 字节时由结构启发式判定（`confidence='medium'`），样本不足时只要求「不丢字节 + `suspect=true`」（§8.1 第 5 行、§8.5）。两档都必须给出 `{encoding, source, confidence}` |
| G4 | **原始字节保真**：文本与字节分离，任何失败都保留可复原的原始字节 | 任意失败路径都能拿到 `rawArtifact{path, sha256, bytes}`，且其内容按原始字节可重解 |
| G5 | **统一入口**：全仓库只有一处「字节 → 文本」实现，11 处解码点全部迁移（10 处主进程 + 1 处跨进程共享 #11） | `rg "toString\('utf8'\)"` 在子进程输出路径上不再命中；新增 spawn 点若绕过入口则测试失败 |
| G6 | **诊断投影可操作**：退出码、方言 hints、编码元数据、可疑标记都进入 `tool_result` 与日志 | 重放本次事故：模型能看到「Windows 宿主初始化失败（0xFFFF0000 / 0x8009001D）」「原始字节已保存」「该文本解码可疑」 |
| G7 | **字节级测试基线**：用真实字节样本钉死回归 | §11 的用例集全部通过，含本次事故的 136 字节真实样本 |
| G8 | **口径分离**：**新增**原始字节口径 `stdoutRawBytes`/`stderrRawBytes`，**不改**既有 `stdoutBytes`/`stderrBytes` 语义（避免历史日志不可比，见 §9.6）；耗时拆分为 plan/spawn/run 三段 | 事故样本的日志中 `stderrRawBytes` = 136、`stderrBytes` = 154（旧口径保持不变），并能读出 spawn→exit = 124ms |

### 4.2 非目标

| # | 非目标 | 理由 |
|---|--------|------|
| N1 | **不负责修复宿主故障**（`0x8009001D`、安全软件拦截、PowerShell 安装损坏） | 属宿主/环境问题；本需求只保证「失败可诊断」，不保证「不失败」（§2.4） |
| N2 | **不做文件内容编码探测**（`read_file`/`grep` 读到的文件字节） | 与管道字节是不同命题（真值由文件 BOM/编码声明决定），混做会让范围与回归面失控 |
| N3 | **不引入新依赖**（iconv/ICU 附加包） | Node 内置 `TextDecoder` 已覆盖 utf-8/utf-16le/utf-16be/gbk/gb18030/big5/shift_jis/euc-kr/windows-1252；OEM CP 用注册表探测 + 内置标签映射即可，避免原生依赖（与仓库「无 node-gyp 依赖」的取向一致） |
| N4 | **不改变终端渲染语义**（xterm 交互、按键、shell 集成） | 只统一「字节 → 文本」入口，不改终端体验 |
| N5 | **不改远程 IM 协议层**（飞书/微信消息本身的编码） | 只统一其中的**子进程输出**解码（如 `larkCliRunner`），消息协议不动 |
| N6 | **不做「猜谜式」修复**（用启发式/LLM 反推乱码原文） | 反推是补救手段；本需求的方向是「不错杀 + 留原始字节」，而不是把猜测做得更聪明 |

## 5. 编码真值来源模型

「子进程输出的编码」不是一个值，而是按**来源**分层的 7 类。设计必须按来源定策略，内容探测只能兜底。

| 来源 | 典型场景 | 实测/证据 | 编码真值 |
|------|----------|-----------|----------|
| S1 契约生效后的子进程输出 | `run_shell` 正常执行：PS 自身输出、`cmd` 内建输出 | §3.3 实测：prelude 设 UTF-8 时 PS 输出 14B UTF-8、`cmd echo` 也为 UTF-8 | 由契约决定（可钉死） |
| S2 **宿主自身失败输出（prelude 之前）** | `powershell.exe` 初始化失败 | §2.2：136 字节 UTF-16LE | **UTF-16LE**（与 profile 无关） |
| S3 `cmd.exe` 自身报错/内建输出 | 「不是内部或外部命令」、`echo` | 无 prelude 时 GBK 10B；`ioMaxBytes` 与 `chcp` 呈宿主差异 | OEM CP（随宿主 console CP 漂移） |
| S4 本地化 native 工具输出 | `git`（UTF-8）、部分老工具/系统工具（OEM CP） | §3.3：`git log` 中文提交两种 prelude 下均为 UTF-8 | 工具自决，需探测 |
| S5 PowerShell progress / CLIXML 流 | 非交互宿主把 progress 序列化为 CLIXML 写入 stderr | `shellProfiles.ts:52-54` 注释已记录（首次启动 "Preparing modules for first use."） | **UTF-16LE + CLIXML 包装**（需剥离或静默） |
| S6 同一管道内混合 | native 输出与 PS 输出交织、stdout/stderr 合并 | §11 用例覆盖；同一 stderr 内混合 UTF-16LE 与 GBK 无法良好处理（见 §8.5 边界） | 不保证可解，只能保真 |
| S7 传输层截断/破坏 | chunk 边界切断多字节；截断处切断多字节；artifact 二次编码 | `builtinExecutors.ts:793,801`、`outputArtifactWriter.ts:33-36` | 必须由实现消除（流式解码 + 原始字节直存） |

三条设计含义：

1. **`gbk` 硬编码只在「zh-CN + S3/S4(OEM)」这一格上巧合正确**。OEM CP 实际可能是 936（zh-CN）、950（zh-TW）、932（ja）、949（ko）、437/850（en-US）——同一份代码在别的语言宿主上会直接失败。
2. **来源（S1/S2/S3）优先于内容**：契约能决定的就不要猜；猜的时候必须记录「我为什么这样判断」。
3. **S5/S6/S7 决定了两个硬要求**：stdout/stderr **分别**独立解码（不能合并判定）；保真层必须存在于解码之前（否则 S7 无法消除）。

## 6. 设计总览

### 6.1 分层

```
                        ┌──────────────────────────────────────────┐
   spawn 子进程 ───────▶ │ L3 保真层  raw bytes（head/tail 环形缓冲）│──▶ artifact（原始字节 + sha256）
                        └───────────────┬──────────────────────────┘
                                        │ 原始 Buffer（只读、按流分开）
                        ┌───────────────▼──────────────────────────┐
                        │ L2 探测层  一次性判定 + 流式解码           │
                        │   BOM → UTF-16 奇偶 → 严格 UTF-8 → OEM CP │
                        │   → 可逆兜底；锁定后不再改判              │
                        └───────────────┬──────────────────────────┘
                                        │ 文本 + {encoding, source, confidence}
                        ┌───────────────▼──────────────────────────┐
                        │ L1 契约层  profile.encoding / per-command │
                        │   → 决定 L2 的首选编码与「期望」事实      │
                        └───────────────┬──────────────────────────┘
                                        │
                        ┌───────────────▼──────────────────────────┐
                        │ L4 投影层  诊断（退出码映射/hints/encoding/ │──▶ tool_result / 日志 / UI
                        │            可疑标记/字节数口径统一）       │
                        └───────────────┬──────────────────────────┘
                                        │
                        ┌───────────────▼──────────────────────────┐
                        │ L5 测试基线：字节级 fixture 回归          │
                        └──────────────────────────────────────────┘
```

五层职责：

- **L1 契约层**：把「我们请求的编码」变成事实（prelude/profile/per-command），并把它写进 plan（§7）。
- **L2 探测层**：唯一判定点，判定一次、锁定、流式解码；输出「文本 + 编码来源 + 置信度」（§8）。
- **L3 保真层**：在任何解码之前保存原始字节，失败/可疑时产出 artifact（§9）。
- **L4 投影层**：把退出码、方言信号、编码元数据、可疑标记翻译成模型/用户可操作的信息（§10）。
- **L5 测试基线**：用真实与构造的字节样本钉死以上行为（§11）。

### 6.2 四条不可违反的实现原则

| 原则 | 含义 | 违反时的典型症状 |
|------|------|------------------|
| **P1 契约优先、探测兜底、保真兜底** | 能契约化的必须契约化；契约不成立时探测；无论判定如何，原始字节必须留存 | 「猜对了是巧合，猜错了信息全丢」 |
| **P2 判定一次** | 每条流（stdout/stderr 各自）在锁定期之后不再改判；不重解历史输出 | 同一段文本前后编码不一致（§3.5） |
| **P3 文本与字节分离** | 文本是「投影」，字节是「事实」；字节数、artifact、截断都以原始字节为准 | `stderrBytes: 154` 掩盖真实 136 字节 |
| **P4 不确定就标注** | 判定置信度不足时显式标注 `encodingSource: 'heuristic'` + `decodeSuspect: true`，并触发原始字节留存 | 「文本非空但全是乱码」被当成成功输出（§3.6） |
## 7. 契约层（L1）

### 7.1 契约的形态

把 `ShellProfile.encoding`（现状 `'utf8' | 'utf16le'`、无消费者）替换为**有唯一消费者**的契约对象：

```ts
export type OutputEncodingContract =
  | { kind: 'utf8' }                    // 我们控制解释器：run_script(PYTHONUTF8)、Node CLI shim
  | { kind: 'oem'; codepage: number }   // 宿主 OEM CP：cmd 内建、系统工具、PS 自身输出（见 §7.3）
  | { kind: 'utf16le' }                 // 已知的宽字符宿主路径：CLIXML / 宿主致命错误
  | { kind: 'auto' }                    // 不做假设，交给 L2 探测（第三方 CLI 的默认值）

export interface ShellProfile {
  // ...
  outputEncoding: OutputEncodingContract       // 必填，且有消费者
  encodingSource: 'builtin' | 'user' | 'detected'
}
```

约束：

- **契约必须进入 plan**：`PreparedShellExecution` 携带 `outputEncoding`（替换死字段），并参与 `planDigest`；解码器由它构造。
- **删除即编译失败**：`createChildStreamDecoder()` 的第一个参数就是该契约（必填），从而不可能出现「计划里写了、解码时不用」。
- **契约里的值不是猜测**：要么来自内置 profile（我们可以决定），要么来自注册表探测（§7.4），要么显式标 `auto`（承认不知道）。禁止把「本次猜测结果」写回契约（避免污染）。

### 7.2 解码结果必须回带契约事实

契约是「期望值」，实际是否成立必须回带，否则冲突会被静默吞掉：

```ts
export interface DecodedStreamMeta {
  encoding: string                      // 实际使用的 TextDecoder 标签（如 'gbk' / 'utf-16le'）
  source: 'contract' | 'bom' | 'utf16-pattern' | 'utf16-structure' | 'strict-utf8' | 'oem-codepage' | 'fallback-latin1'
  confidence: 'exact' | 'high' | 'medium' | 'low'
  codepage?: number
  bomBytes: number                      // BOM 消耗字节数（字节↔文本对齐用）
  contractKind: OutputEncodingContract['kind']
  contractConflict?: 'contract-mismatch' // 契约与探测结论不一致（记录，不静默改判）
}
```

`contractConflict` 必须出现在 `tool_result` 与 `shell.exec.finish` 日志里——它同时是「契约是否可靠」的长期度量：如果某台机器上 `oem` 契约频繁冲突，就说明探测方式或 prelude 需要调整。

### 7.3 PowerShell prelude 的取舍（决策点 D1，附实测依据）

现状 prelude（`electron/shell/shellProfiles.ts:55-57`）同时设置了 `$OutputEncoding` 与 `[Console]::OutputEncoding`（都设 UTF-8），而这两者语义完全不同：

| 旋钮 | 真实语义 | 现状取值 | 影响 |
|------|----------|----------|------|
| `$OutputEncoding` | **写入 native 命令 stdin** 的编码 | UTF-8 | 给 native 工具喂 UTF-8 stdin；老工具可能不认 |
| `[Console]::OutputEncoding` | PS **读 native 输出**与**写自身 stdout** 的编码；设置时还会改变 console CP，从而改变按 console CP 输出的子进程 | UTF-8 | 见下表实测 |

§3.3 的实测矩阵说明现状的收益与代价：

- 收益：PS 自身输出与 `cmd` 内建输出都是 UTF-8，L2 一眼可判、几乎不会误判。
- 代价（实测，不可逆）：命令内部一旦把 native 输出转成字符串（`$x = git log ...`、`git log | Select-String 中文`、`-match`），PS 会用 UTF-8 去解 native 的 OEM 字节 → `U+FFFD`，**原始信息在本应用拿到之前就已丢失**。

三个候选：

| 方案 | prelude 内容 | 优点 | 缺点 |
|------|--------------|------|------|
| **A（现状）** | `[Console]::OutputEncoding = UTF8` | PS 自身/`cmd` 输出统一 UTF-8 | native→字符串路径**硬失败、不可逆**；隐含改变子进程 console CP |
| **B** | `[Console]::OutputEncoding = GetEncoding(OEMCP)` | native→字符串是**字节可逆**的坏映射，不丢字节；PS 自身输出 OEM CP | 下游必须按 OEM CP 解（依赖 L2/契约正确） |
| **C（建议）** | 只保留 `$ProgressPreference='SilentlyContinue'`，不动 `[Console]::OutputEncoding` | 不改变任何子进程行为；PS 自身输出 = 宿主 OEM CP（与 `cmd`、系统工具同源，规则单一）；把「期望编码」交给 plan 契约 | 需要 L1/L2 到位才安全；必须同步迁移 `orphanProcessCleanup.ts:24-28` 里「复用 prelude 固定 UTF-8」的既有绕法 |

**建议采用 C**，理由：

1. 对**最大来源**（S4：native 工具输出）prelude 本来就无影响（实测字节透传），收益为零。
2. 对**有影响的路径**（native→字符串）现状是负收益（实测不可逆损坏）。
3. 规则更单一：PS 自身输出、`cmd` 内建、系统工具都归一到「宿主 OEM CP」一格，可被注册表探测准确表达，不需要每次靠启发式。
4. 决策前提是把 `$ProgressPreference`（S5 治理）**保留**，并把 `outputEncoding: { kind:'oem', codepage }` 写进 plan。

> 该决策需要 Phase 0 实测复核（跑全套 shell 测试 + 用含中文的 native 命令做 matrix），不能只凭本需求的单机结论。若复核发现 C 影响面过大，退路是 A + 「命令模板禁止把 native 输出转字符串」的提示（但这属于靠约束掩盖问题，优先级低于 C）。

### 7.4 OEM CP 探测方式（本机实测）

| 方式 | 实测结果 | 评价 |
|------|----------|------|
| 注册表 `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` → `OEMCP` / `ACP` | 本机 `OEMCP=936`、`ACP=936`、`MACCP=10008` | **推荐作为主真值**：无需 spawn、无鸡生蛋问题、可缓存到进程级 |
| 解析 `chcp` 输出 | 本机报 `Active code page: 936` | 需 spawn 一个 native 进程（自身输出又受 console CP 影响），只作交叉校验 |
| PS 内读 `[Console]::OutputEncoding` | prelude 设 UTF-8 时报 `utf-8`（与 `chcp` 的 936 不一致）；`[Console]::InputEncoding` 报 `gb2312` | **不是真值**（会被 prelude 改变），只能作为诊断展示 |
| Node 侧推断 | 无 API | 不可用 |

OEMCP → `TextDecoder` 标签映射（实测 Node 内置可用性）：

| OEMCP | 宿主语言 | 映射 | 实测 |
|-------|----------|------|------|
| 936 | zh-CN | `gbk`（实为 gb18030 解码器） | OK |
| 950 | zh-TW | `big5` | OK |
| 932 | ja | `shift_jis` | OK |
| 949 | ko | `euc-kr` | OK |
| 1252 | en-US 等（西欧） | `windows-1252` | OK（`latin1`/`iso-8859-1` 也解析为 `windows-1252`） |
| 866 | ru | `ibm866` | OK |
| 850 | DOS 经典（西欧） | **无 WHATWG 对应** | 与 437 同处理：退化为 §8.4 的「可逆兜底 + 标注 low」 |
| **437** | DOS 经典（西欧） | **无 WHATWG 对应（`cp437`/`ibm437` 实测均抛错）** | 退化为 §8.4 的「可逆兜底 + 标注 low」 |

> 注意 `TextDecoder('gbk')` 在 WHATWG 规范下等价于 **gb18030** 解码器（本机实测 `d.encoding === 'gbk'`，实现为 gb18030 兼容解码）。这意味着现有实现「顺手支持了 gb18030」，是好事，但也说明**「gbk」这个字面值在不同实现下可能不指同一个表**，契约与日志必须记实际使用的标签。

### 7.5 已正确的范式：run_script（保留并推广）

`run_script` 是现状里唯一「单侧决定编码」的通道（`electron/tools/builtinExecutors.ts:1173-1175` + `electron/processOutputEncoding.ts:98-103`）：

```ts
env.PYTHONIOENCODING = 'utf-8'                    // 告诉 Python 用什么编码写管道
if (process.platform === 'win32') env.PYTHONUTF8 = '1'
const stdoutDecoder = createStreamTextDecoder('utf-8')   // 与之对应的解码
```

本需求要做的是**把这种范式登记为契约事实**（`outputEncoding: { kind:'utf8' }`），并推广到所有「我们控制解释器/包装器」的通道；对不可控的第三方 CLI 才使用 `auto` + 探测。

### 7.6 契约冲突不静默改判

若契约说 UTF-8、但字节明显不是 UTF-8（如出现 UTF-16LE 的 `0x00` 交错模式）：

1. **不改判**已交付给消费者的文本；
2. 若仍在「前导缓冲」窗口内（尚未交付任何文本，§8.2），允许按探测结果重新解码一次，并记 `contractConflict: 'contract-mismatch'`；
3. 若已越过窗口，则保留契约解码结果 + 标记 `decodeSuspect: true` + **强制留存原始字节**，让上层可以事后重解。
## 8. 探测层（L2）

### 8.1 判定优先级（一次性、按证据强度）

| 顺序 | 判据 | 产出 `source` | 置信度 | 说明 |
|------|------|---------------|--------|------|
| 1 | **BOM**：`EF BB BF` / `FF FE` / `FE FF` | `bom` | exact | 字节自证，最强证据；同时记录 `bomBytes` 供字节↔文本对齐；与契约不符时记 `contractConflict` |
| 2 | **UTF-16 零字节奇偶模式**：样本 ≥16 字节时，某一奇偶位置的 `0x00` 占比 > 80% 且另一位置 < 10% | `utf16-pattern` | high | **本次事故的识别依据**（136 字节里 ASCII 段每位字符后跟 `0x00`）；奇偶决定 LE/BE；`#< CLIXML` 前缀（`23 00 3C 00 …`）天然命中此判据 |
| 3 | **契约**（非 `auto`）：按契约编码解码 | `contract` | high | 契约是「我们请求的编码」；校验与唯一改判窗口见 §8.6 |
| 4 | **严格 UTF-8 校验**：`new TextDecoder('utf-8',{fatal:true})` 不抛错 | `strict-utf8` | high | 取代现状「含 U+FFFD 即回退 GBK」的判据 |
| 5 | **UTF-16 结构启发式**（无 BOM、无零字节锚点时的兜底） | `utf16-structure` | **medium** | 仅当契约未给出（`auto`）**或**契约在 fatal 校验中失败时参与；否则只记录不采纳（契约优先）。判据见下 |
| 6 | **OEM CP**：按 `codepage`（§7.4 注册表/契约）解码 | `oem-codepage` | high | 覆盖不匹配严格 UTF-8 的 GBK/Big5/Shift_JIS/EUC-KR/1252 输出 |
| 7 | **可逆兜底**：`windows-1252`（256 字节全映射，可原样还原） | `fallback-latin1` | **low** | 不是「正确」，而是「不丢字节」；必须触发原始字节留存与可疑标记 |

**第 5 行（UTF-16 结构启发式）的判据**——B1 修订核心。纯 CJK 的 UTF-16 码元两个字节都不为 `0x00`（U+4E00–U+9FFF 的高字节落在 `0x4E`–`0x9F`，低字节 `0x00`–`0xFF`），第 2 行判据对它无效；其字节又**满足不了**严格 UTF-8，若无第 5 行就会直接跌进 OEM CP 被错解。判据：

1. 样本 ≥16 字节且字节数为偶数；
2. 按 LE / BE 两种假设切成码元，各自要求：无未配对代理项（`0xD800`–`0xDFFF`）、控制字符（除 `\t` `\r` `\n`）占比 ≤ 5%；
3. 对每种假设计算 `textScore` = 常见文本区码元占比 − 负分区码元占比；常见文本区 = ASCII 可打印、Latin-1 可打印、CJK 统一表意（`U+4E00–U+9FFF`）、CJK 标点（`U+3000–U+303F`）、全角形式（`U+FF00–U+FFEF`）；负分区 = 私有使用区（`U+E000–U+F8FF`）、CJK 兼容区、未分配码位、替换字符（`U+FFFD`）；
4. 对 OEM CP 解码结果算同样的 `textScore`；仅当 `max(textScore_LE, textScore_BE) ≥ textScore_OEM + 0.5` 时判定 UTF-16（取分更高的一侧），否则**维持前序结论**并继续第 6 行；
5. 置信度固定 `medium`（弱于 BOM / 零字节模式）：不强制 `suspect`，但必须记录 `source='utf16-structure'` 并保留原始字节。

> 判据 3/4 有效的实证：OEM CP（GBK/GB18030）解码任意字节时经常落到**私有使用区**——本次事故的 `0xA17B` 就被 GBK 解成 `U+E501`（附录 A.2 可复核），而 UTF-16 解出的 CJK 码元落在常用区。样本 <16 字节、得分差不足或两侧均为高负分时**不做无把握的猜测**：维持前序结论 + `suspect=true` + 保留原始字节（§8.5）。

**明确废弃的判据**：`hasCjk(gbk) && !hasCjk(utf8)`、`utf8.includes('\uFFFD') && hasCjk(gbk)`（现状 `processOutputEncoding.ts:57-58`）。

废弃理由有两条，且第二条是独立的实现缺陷：

1. 本次事故证明它会**错杀**（UTF-16LE 字节被判成 GBK，把 HRESULT 变成乱码）。
2. **`U+FFFD` 本身可能是合法文本内容**：当用户命令的输出里真的包含替换字符（例如日志回显、或上游已经损坏的文本）时，现状判据会把它误判为 GBK 并整体改写输出——这属于「合法输入被损坏」，比误判编码更糟。

### 8.2 交付与锁定分离（G2 的核心）

> **B2 修订说明**：原稿同时写了「8 KiB 满**或**遇首个换行即判定」与「窗口 = `max(8 KiB, 首个换行前全部字节)`」，两者对「前 20 KiB 无换行」的流给出相反行为。现统一为下述**单一口径**：交付只看「有无歧义」，锁定只看「有无证据」，**8 KiB 是「未判定缓冲」的上限**（既非判定窗口的下限，也不被换行撑大）。

```
chunk₁ chunk₂ … ──▶ [未判定缓冲]
   │
   ├─▶【交付规则】只要「所有仍在场的候选编码」对缓冲前缀解出的文本一致
   │      → 立即交付该前缀（write 返回该文本；纯 ASCII 必然满足 → ASCII 流不因判定而延迟）
   │
   └─▶【判定触发】先到先判，命中任一即锁定：
          a) 强证据：BOM / UTF-16 零字节模式 / CLIXML 前缀
          b) 候选集合收敛到唯一（其余候选被 fatal 校验淘汰）
          c) 未判定缓冲达到 8 KiB（windowBytes）
          d) 流结束（end()）时仍未判定
       a/b 为「有证据」；c/d 按 §8.1 优先级判定，可能落到 suspect

   锁定后：只用该 TextDecoder 的 {stream:true} 增量解码，【永不重新判定】
```

规则：

- **不使用「首个换行」作为判定触发**：换行不携带编码信息，在纯 ASCII 前缀上提前锁定等于无依据地押注（一旦后续出现 GBK 字节就会产生 U+FFFD，且已锁定的编码无法回头）；而 ASCII 段本来就可以即时交付，不需要靠换行来抢延迟。
- **不变量**：**最终文本 = 锁定编码对全部字节的解码**。只要遵守「交付前缀在所有在场候选下解码一致」，该不变量自动成立（已交付的 ASCII 前缀在所有候选下相同）。
- **未判定缓冲上限**：`windowBytes`（默认 8 KiB）。永不换行的长流同样在 8 KiB 处判定。
- **锁定后禁止**：重新拼接历史字节重解、用 `text.slice(lastText.length)` 取增量、根据后续内容改判编码。
- **增量来源**：直接使用 `decoder.decode(chunk, { stream: true })` 的返回值（`TextDecoder` 已处理跨 chunk 的多字节边界），不再自行做字符下标运算。
- **实现提示**：内部维护 ≤3 个候选的流式解码器并逐 chunk 比对输出；任一候选 fatal 失败即淘汰；候选全灭时退到 §8.1 第 7 行。
- **流很短时**（如本次 136 字节）：在 `end()` 触发 d)，按 §8.1 判定一次，行为与「整块解码」一致。

> **延迟口径（与 R1 对齐）**：纯 ASCII 前缀立即可交付，因此只有「从第一个字节起就是非 ASCII 且候选未收敛」的流才会缓冲到 8 KiB。结合现有进度节流（`minBytes: 16KB` / 50ms），体感延迟可忽略。另需在实现时确认：**进度回显也走同一解码器**，不允许为了实时性另开一条 utf-8 快路径（否则又出现两条不一致的解码路径，等同 §3.1 #7）。

### 8.3 接口契约

```ts
// 一次性（短输出、测试、`runCommandWithTimeout` 类调用）
export function decodeChildOutput(
  buf: Buffer,
  opts?: { contract?: OutputEncodingContract; platform?: NodeJS.Platform }
): { text: string; meta: DecodedStreamMeta }

// 流式（长生命周期子进程）
export function createChildStreamDecoder(opts: {
  contract: OutputEncodingContract
  windowBytes?: number                 // 默认 8 * 1024
  platform?: NodeJS.Platform
}): {
  write(chunk: Buffer): string         // 已交付文本增量；窗口内为 ''
  end(): string
  readonly meta: DecodedStreamMeta     // 锁定前为 provisional
  readonly rawBytes: number            // 累计消费的【原始】字节数
  readonly bufferedBytes: number       // 仍在前导缓冲中的字节数
}
```

硬约束（写入单测）：

- 二者**共用同一个 `detectEncoding()`**；
- 对同一字节流，**任意切分方式**（含 1 字节切分、多字节字符中间切开）得到的文本与 `meta` 必须与整块解码完全一致；
- `rawBytes` 永远是原始字节数（G8），与文本长度无关。

### 8.4 兜底与标注

- `confidence: 'low'` ⇒ 强制 `decodeSuspect: true` + 强制原始字节留存（§9）+ 在 `tool_result` 中显式说明「该输出编码无法确定，文本可能失真，原始字节已保存」。
- `confidence: 'medium'`（当前仅 `utf16-structure`）⇒ 不强制 `suspect`，但必须记录 `source` 并保留原始字节；若同时存在 `contractConflict`，则升为 `suspect: true`。
- `windows-1252` 兜底的语义是**可逆**（任何字节都能还原），因此即使文本看起来是乱码，信息也未丢失。
- 兜底不得用于「让测试变绿」：任何测试若依赖兜底路径，必须显式断言 `source === 'fallback-latin1'`。

### 8.5 明确边界（不保证可解，必须写进文档与诊断）

| 情形 | 保证 | 不保证 |
|------|------|--------|
| 同一流内混合编码（如 UTF-16LE 的 ASCII 段 + GBK 中文段） | 原始字节完整、`decodeSuspect` 标记、可事后重解 | **文本正确性**。UTF-16 的 ASCII 段按 GBK 解出的乱码仍含 CJK，无法与「真的 GBK 中文」区分，故不做自动尝试 |
| 二进制/PTY 转义序列 | 原始字节 → 终端（xterm 自行处理） | 文本语义 |
| 宿主内部已发生的损失（§3.3 native→字符串被 PS 用 UTF-8 严格解码） | 标记为 `lossStage: 'host'` | 任何恢复（字节已不存在）——诊断必须能区分「host 损失」与「解码器损失」，否则会把环境问题误判为应用 bug |
| **无 BOM、无 ASCII 锚点的纯 CJK UTF-16**（§8.1 第 5 行） | 样本 ≥16 字节时由结构启发式判定（`medium`）；样本不足时**不猜**，维持前序结论 + `suspect=true` + 保留原始字节 | **一定解对**。该形态在缺少锚点时与 OEM CP 无法仅凭字节完全区分（两种解释都能产出合法文本），因此只提供「可解释的最佳猜测 + 保真」 |
| 无内置解码器的 CP（437/850） | 可逆兜底 + `low` 标注 | 文本正确性 |

### 8.6 契约与探测的交互：唯一允许的一次改判

```
前导字节到达
  ├─ 命中 BOM / UTF-16 零字节模式（强证据）
  │     → 直接按其判定；若与契约不符 → contractConflict = 'contract-mismatch'
  ├─ 否则按契约解码，并在未判定缓冲内做 fatal 校验
  │     ├─ 校验通过 → 锁定契约
  │     └─ 校验失败且【已交付的前缀在所有在场候选下解码一致】 → 允许改为探测结论一次，记 conflict
  │           （§8.1 第 5 行的结构启发式仅在此时、或契约 = 'auto' 时参与）
  └─ 契约 = 'auto' → 直接走探测链（第 4 → 5 → 6 → 7 行）
```

关键点：**「允许改判」的前提是「已交付的前缀在所有在场候选编码下解码一致」**（典型情形是纯 ASCII 前缀——它在任何候选下都相同）。只要守住这条不变量，§8.2 的「最终文本 = 锁定编码对全部字节的解码」就自动成立，不存在对已消费文本的静默篡改——这正是现状 `text.slice(lastText.length)` 出错的地方（§3.5）。
## 9. 保真层（L3）

### 9.1 现状：artifact 是「大输出才留档的解码后文本」

`electron/tools/runShellExecutor.ts:203-225` 的 artifact 逻辑有三个致命特征：

| 特征 | 代码 | 后果 |
|------|------|------|
| **惰性激活**：只有累计文本超过 `ioMaxBytes`（默认 100 KiB）才 `open()` 落盘 | `:207-225` | **本次事故 136 字节 → `outputArtifactBytes: 0`**，根本没有 artifact；「输出不大但编码错」这一最常见场景完全没有留档 |
| **内容是解码后文本**：`recordArtifact(chunk)` 收到的是 `stdoutDecoder.write(b)` 的返回值 | `:285-304` | artifact 与主通道共享同一次（可能错误的）解码；一旦判错，artifact 里也是乱码 |
| **未脱敏** | `recordArtifact` 不经过 `sanitizeToolOutput` | 现状即如此（不是本需求引入的问题），但意味着「原始字节直存」不会降低现有脱敏水平 |

另外 `persistedOutputPath` 只在 `truncated && artifact` 时给出（`:390-392`），因此「输出不完整」与「输出不可信」这两类问题目前都无法通过路径获得原始材料。

> 需要区分两件事：**内存里的原始字节已经足以支持「当场重解」**（§8.6 的前导窗口改判就是靠它，不需要任何文件）；**artifact 的意义是跨进程、跨时间的事后追溯**——进程退出、应用重启后内存即消失，而日志里可能只剩「已解错的文本」。D5 的完整表述见 §14.2。

### 9.2 目标：解码之前保存原始字节

```
chunk(Buffer)
   ├─▶ RawByteBuffer.appendBytes(chunk)      // 事实：原始字节（stdout / stderr 各自独立）
   ├─▶ ChildStreamDecoder.write(chunk)       // 投影：文本（L2）
   └─▶ artifactWriter.appendBytes(chunk)     // 留档：原始字节
```

- 新增 `RawByteBuffer`（head/tail 环形，上限沿用 `ioMaxBytes`，`tail = limit/2`），**取代** `BoundedOutputBuffer` 现在「按文本 append、按文本算字节」的职责。
- `BoundedOutputBuffer` 改造为**只处理原始字节**：`appendBytes(buf)` / `snapshotBytes()`；文本侧的 head/tail 拼接由 L2 的输出决定。
- `OutputArtifactWriter` 增加 `appendBytes(buf: Buffer)`；`append(text)` 若仍被其他调用方使用，则显式标注为「文本路径（非原始字节）」。

### 9.3 截断语义修正

现状截断发生在**文本层**（`truncateIo(stdout, ioMax)`、`BoundedOutputBuffer` 的 `Buffer.from(chunk,'utf8')`），可能截掉半个多字节字符，或让「已截断文本」与「原始字节」永久失配。

目标语义：

1. **截断只发生在原始字节层**：保留 head（前 `ioMax` 字节）与 tail（后 `ioMax/2` 字节），并记录 `omittedBytes`。
2. **文本投影 = 解码(head) + marker + 解码(tail)**；marker 固定为纯 ASCII 的 `\n[… output truncated …]\n`（ASCII 在任何候选编码下解码一致，不会污染判定）。
3. **sha256 只覆盖实际落盘的字节**（head+tail，不含 marker），并在 meta 里记录 `omittedBytes`，使「artifact 与真实流的关系」可解释。

> 代价（必须显式接受）：截断窗口之间的字节**不落盘**（与现状一致，现状也只保留 head/tail 文本）；若要严格完整原始流，只能提高 `ioMaxBytes`。

### 9.4 artifact 契约

```ts
data.rawArtifact = {
  path: string            // userData/shell-output/<sha256(toolUseId)>.log（沿用现有命名）
  bytes: number           // 实际写入字节数（原始）
  rawBytes: number        // 该流的总原始字节数（含 omitted）
  omittedBytes?: number   // 截断省略量
  truncated?: boolean
  sha256: string          // 覆盖实际写入字节
  suspect?: boolean       // decodeSuspect / confidence=low 时置位
  note?: 'unredacted'     // 内容未脱敏（现状同样如此，显式标注）
}
```

**自动产出条件**（任一命中即写出，且不依赖 `ioMaxBytes`）：

1. 执行失败（`exitCode !== 0` / signal / timeout / aborted）；
2. `decodeSuspect === true`（含 `confidence: 'low'`、U+FFFD 计数 > 0、`contractConflict`）；
3. `truncated === true`；
4. 现状既有条件（累计超过 `ioMaxBytes`）。

理由：一次失败执行最多留档 head+tail 两份（每流约 150 KiB 上限），成本可忽略；而「失败时没有材料」是本次事故最实际的痛点。

### 9.5 字节与口径（G8）

**结论先行（M3 修订）**：既有 `stdoutBytes` / `stderrBytes` 的语义**保持现状不变**（仍是「解码后文本的 UTF-8 长度」），新口径以**新增字段**的方式并存，不覆盖旧字段。原因是这两个字段已有日志消费方（清单见 §9.6），改语义会让历史日志与新日志不可比，看起来像回归。

| 字段 | 现状 | 目标 |
|------|------|------|
| `stdoutBytes` / `stderrBytes` | 解码后文本的 UTF-8 长度（事故中 154） | **不变**（事故中仍为 154；不再被当作原始字节数解读） |
| `stdoutRawBytes` / `stderrRawBytes` | 无 | **新增**：原始字节数（事故中 136）——替代原稿「直接改 `*Bytes` 语义」的方案 |
| `stdoutTextBytes` / `stderrTextBytes` | 无 | **新增**：解码后文本的 UTF-8 长度（与既有 `*Bytes` 同值；给新代码一个语义明确的字段名） |
| `decodeReplacements` | 无 | **新增**：解码产生的 U+FFFD 计数（>0 ⇒ `decodeSuspect`） |
| `stdoutSha256` / `stderrSha256` | 对文本取 sha256（`shellLogFields.ts:52-53`） | **不变**；**新增** `stdoutRawSha256` / `stderrRawSha256`（对原始字节） |
| 耗时 | 单一 `durationMs`（事故中 3072ms，掩盖了子进程只活 124ms 的事实） | 拆分为 `planMs` / `spawnToExitMs` / `totalMs`；`durationMs` 保留且 = `totalMs`（不破坏既有聚合） |
| `outputArtifactBytes` | 惰性 artifact 的字节数 | 语义明确为「raw artifact 的**原始**字节数」，并**新增** `outputArtifactReason`；未产出 artifact 时仍为 0 |

> 验收口径（G8）：事故重放时日志中**同时**出现 `stderrRawBytes = 136` 与 `stderrBytes = 154`（两个不同事实），且 `spawnToExitMs ≈ 124`。

### 9.6 日志口径兼容与消费方（M3）

**兼容结论：不引入 breaking change，不需要断裂式的 release note。** 既有字段全部保留原名原义，新字段只增不改；新旧字段在渲染/日志两侧一律按**可选**处理，旧日志缺字段时按 `undefined` 降级。

新增字段（`shell.exec.finish`）：

| 字段 | 含义 |
|------|------|
| `stdoutRawBytes` / `stderrRawBytes` | 原始字节数（G8 新口径；事故中 136） |
| `stdoutTextBytes` / `stderrTextBytes` | 解码后文本的 UTF-8 长度（= 既有 `*Bytes`） |
| `stdoutRawSha256` / `stderrRawSha256` | 对**原始字节**取 sha256 |
| `decodeReplacements` | 解码产生的 U+FFFD 计数 |

既有字段语义**不变**：`stdoutBytes` / `stderrBytes`（文本 UTF-8 长度）、`stdoutSha256` / `stderrSha256`（文本 sha256）、`durationMs`（= `totalMs`）。

**消费方清单（改字段前必查）**：

| 消费方 | 用途 | 兼容评估 |
|--------|------|----------|
| `electron/tools/runShellExecutor.ts:425-427,453-454`（`data` 产出点） | 组装 `tool_result` 的 `data`（字节口径 + artifact 字段） | 旧字段保持同名同义 ⇒ 无需改动；新字段在此产出并走同一 `data` 通道（远程 IM 经 `agentSafeProjection` 同源投影） |
| `electron/agentLogger/agentLogProjection.ts:21-22` | 「Shell 执行」日志投影 | 只读 `stdoutBytes` / `stderrBytes`，语义不变 ⇒ **无需改动** |
| `electron/shell/shellLogFields.ts:20-21` | 日志字段 allowlist（`ALLOWED_KEYS`） | **必须同步登记新字段**，否则静默丢弃（§10.5 的陷阱） |
| `electron/shell/shellLogFields.ts:50-55`（`addOutputMetadata`） | 事件带完整 `stdout` / `stderr` 字符串时派生 `*Bytes` / `*Sha256` / `*Redacted` | 派生值按**文本**计算，与 §9.5 保留的旧口径一致 ⇒ 无需改动；**禁止**把原始字节塞进 `stdout` / `stderr` 这两个同名字段 |
| `src/shared/agentSafeProjection.ts:11-12` | 跨端安全投影 | 同上：新字段需显式加白名单，否则渲染侧看不到 |
| `src/shared/processResultProjection.ts:68-69` | `ProcessResult` 文本投影 | 语义不变 ⇒ **无需改动** |
| `src/shared/shellToolDisplay.ts:26-28,55-57` | 聊天卡片 / `tool_result` 展示 | `stdoutBytes` / `stderrBytes` 语义不变 ⇒ 无需改动；新增字段按可选透传；Phase 3 的 `outputTrust` 提示在此扩展 |
| `outputArtifactBytes` / `outputArtifactSha256` | artifact 的字节数与哈希 | **唯一两处取值会变化的既有字段**：artifact 内容改为原始字节后，二者自然变为「原始字节数 / 原始字节哈希」。消费方只做透传、无逻辑依赖 ⇒ 兼容 |
| `electron/tools/runShellExecutor.test.ts:435-436` | 冻结断言 `outputArtifactBytes === content.length`、`outputArtifactSha256 === sha256(content)` | **需在同一 commit 更新**为按原始字节断言（artifact 语义变更的必然结果，§9.1–§9.3） |

**实现约束**：

1. 新增字段一律**可选**（如 `stdoutRawBytes?: number`），旧调用方/旧日志可缺省；
2. **禁止**把 `stdoutBytes` / `stderrBytes` 重新解释为原始字节数——历史日志（事故中 154）与新日志（136）会不可比，且会让「数值变小」看起来像回归；
3. `outputArtifactBytes` / `outputArtifactSha256` 的**字段名与类型不变、取值口径随 artifact 内容变**（解码后文本 → 原始字节）——这是本需求唯一的既有字段取值变化，必须与冻结测试同 commit，并在提交信息里显式说明；
4. 将来若真要统一到原始字节口径，需按「双写 → 消费方全部迁移 → 再删旧字段」独立立项，不在本需求范围内（作为后续变更的输入记录在此）。

## 10. 统一入口与诊断（L4）

### 10.1 唯一入口

新增目录 `electron/processOutput/`：

| 文件 | 内容 |
|------|------|
| `detectEncoding.ts` | §8.1 的判定链（BOM → UTF-16 模式 → 契约 → 严格 UTF-8 → OEM CP → 可逆兜底），纯函数、可单测 |
| `decodeChildOutput.ts` | `decodeChildOutput()`（一次性）+ `createChildStreamDecoder()`（流式），二者共用 `detectEncoding` |
| `contracts.ts` | `OutputEncodingContract` 类型 + OEMCP 探测（注册表读 + 缓存）+ CP↔标签映射 |
| `lineSplitter.ts` | 基于流式解码器的「按行切分」工具，供 MCP stderr / lark 事件流等行协议复用（避免各自 `toString('utf8')`） |

迁移目标（对应 §3.1 的 11 处）：

| 现状 | 目标 |
|------|------|
| #1/#2/#3 `processOutputEncoding.ts` | 保留 `buildShellEnv` / `buildPythonScriptEnv`（与编解码无关）；`createStreamTextDecoder` / `createProcessOutputStreamDecoder` / `decodeProcessOutput` 收敛进 `processOutput/`，旧函数删除（不留兼容壳，避免新代码再调用旧启发式） |
| #4 `runShellExecutor.ts:168-169` / `:546` | 改为 `createChildStreamDecoder({ contract })` / `decodeChildOutput(buf,{contract})` |
| #5 `grepWithRg` | 改为流式解码器（契约 `utf-8`，因为 ripgrep 输出 UTF-8；但需保留探测兜底） |
| #6 `run_script` | 已正确；改为登记契约 `utf8` 调用新入口 |
| #7 `larkCliRunner` | 单条解码路径：回调与返回值都用同一个流式解码器（契约 `auto`，因为第三方 CLI 自行决定） |
| #8 `spawnUtil.runCommandWithTimeout` | 返回 `{ stdout, stderr, meta }`；stderr 不再丢弃（至少保留 head+tail 与 meta） |
| #9 `appIpc.tool:test-interpreter` | 改为调用 `decodeChildOutput` |
| #10 `mcp/stdioTransport.ts` | 用 `lineSplitter` 替代 `buffer += chunk.toString('utf8')` |
| #11 `terminalScrollback.ts` | 终端字节**不做文本解码**（保持 raw → xterm）；仅回滚/日志投影走新入口并复用同一契约 |

守护措施：

- 单测断言：`rg "toString\('utf8'\)"` 不得命中「子进程输出」路径（白名单显式列出「文件内容」路径，§3.1 已排除）；
- 新增 spawn 点的 code review checklist：是否声明契约、是否走 `processOutput/`、stderr 是否有留档。
### 10.2 Windows 宿主退出码与 HRESULT 映射

现状 `electron/shell/shellExitCodes.ts:1-9` 只映射 POSIX 退出码，Windows 宿主码一律落到「进程异常退出（退出码 N）」。目标实现（`describeExitCode` 升级为结构化返回）：

| 原始值（Node 上报） | 十六进制 | 语义 | 建议 | 来源 |
|---------------------|----------|------|------|------|
| 4294901760 | `0xFFFF0000` | **Windows 宿主进程初始化失败**（本次事故） | 改用 `run_script` 或重试；检查宿主机安全/加密组件；查看原始字节 artifact | 实测（本次事故） |
| 4294836224 | `0xFFFD0000` | `-EncodedCommand` 参数非法（不是合法 Base64） | 属应用内部错误，应直接报 bug（命令构造路径） | 本机实测 |
| 3221225786 | `0xC000013A` | `STATUS_CONTROL_C_EXIT`（Ctrl+C） | 无需重试，属正常中断 | 已知常量 |
| 3221225794 | `0xC0000142` | `STATUS_DLL_INIT_FAILED` | 宿主依赖缺失/安全软件拦截 | 已知常量 |
| 3221225477 | `0xC0000005` | 访问冲突 | 宿主崩溃，附加原始字节 | 已知常量 |
| 3221225725 | `0xC00000FD` | 栈溢出 | 命令递归/脚本问题 | 已知常量 |

同时需要在**文本层**识别并解释 HRESULT：

| 文本特征 | 语义 | 处理 |
|----------|------|------|
| `8009001d` / `0x8009001D` | `NTE_PROVIDER_DLL_FAIL`（加密服务提供程序 DLL 加载/初始化失败） | 在诊断里点明：宿主初始化失败与安全/加密组件相关的可能性，并给出建议 |
| `#< CLIXML` 前缀 | PowerShell 把 progress/错误序列化成 CLIXML | 按 S5 处理（UTF-16LE + CLIXML 剥离或静默） |

实现要求：

- **双解释**：Node 报无符号（4294901760），而 Windows 语义是有符号（-65536）。诊断文本里同时给出两种表示；
- **不建议猜语义**：未收录的码只标 `family: 'unknown-windows-host'`，不要编造解释；
- **建议要可执行**：每条建议必须是模型能直接照做的动作（换工具/重试/读 artifact），而不是「请检查环境」。

### 10.3 方言错配的 signals/hints 必须转发

现状（已实测）：`toolChatLoop.ts:1146-1154` 在计划失败时调用 `buildToolErrorResult(toolUseId, code, { requestId, sessionId })`，**不传 `result`**，于是内容退化为 `serializeAgentToolResult({ success:false, error: code, userMessage: code, data:{ processResult:null } })` —— 模型只拿到错误码（L1017/L1018 实测确认）。

修复设计：

1. `RunShellPlanError`（或等价的计划错误）携带结构化 `data`：`{ code, signals, hints, detectedSyntax, expectedDialect, shellProfileId, executable }`；
2. 该分支把 `data` 通过 `buildToolErrorResult` 的第 4 个参数（`result`）传入，使 `formatToolResultPayload` 正常序列化；
3. 验收：重放事故的第一轮命令 → 模型在**第一轮**就能看到 `signals: ['posix-operator']` 与 hints，不必再试错一次。

> 注意：`signals`/`hints` 是**指令性文本**，进入 `tool_result` 前需经 `sanitizeToolOutput`（与既有的 `securityWarning` 等路径保持一致），避免把用户命令片段回显成注入面。

### 10.4 「文本不可信」必须可见

除了 §10.2 的退出码解释，每次输出都要带一条**机器可读**的诊断行（放在文本投影之后，纯 ASCII，便于稳定断言）：

```
[output-diag] stream=stderr encoding=utf-16le source=utf16-pattern confidence=high replacements=0 contract=oem conflict=contract-mismatch suspect=false rawArtifact=<path|none>
```

配套结构化字段（`data.decode`）：

```ts
data.decode = {
  stdout: { encoding, source, confidence, replacements, suspect },
  stderr: { ... },
  contractConflict?: 'contract-mismatch',
  lossStage?: 'host'        // 区分「宿主内已丢」与「解码器丢」
}
data.outputTrust = 'ok' | 'suspect'
```

渲染/远程路径要求：`outputTrust === 'suspect'` 时，聊天卡片与远程 IM 消息都要显示「输出编码可疑，原始字节已保存」（否则远程用户会继续被乱码误导）。

### 10.5 日志字段扩展（含 allowlist 陷阱）

`shell.exec.finish` 需新增：`stdoutEncoding` / `stderrEncoding` / `encodingSource` / `encodingConfidence` / `contractConflict` / `stdoutRawBytes` / `stderrRawBytes` / `stdoutRawSha256` / `stderrRawSha256` / `stdoutTextBytes` / `stderrTextBytes` / `decodeReplacements` / `rawArtifactPath` / `rawArtifactBytes` / `rawArtifactSha256` / `rawArtifactReason` / `planMs` / `spawnToExitMs` / `lossStage`。

**陷阱**：`electron/shell/shellLogFields.ts:14-28` 是 allowlist，未列入的字段会被**静默丢弃**（`projectShellAgentLogFields` 的 `ALLOWED_KEYS` 判断）。因此新增字段必须同步加白名单，否则「加了字段但日志里看不到」，调排时会误以为没实现。

## 11. 测试基线（L5）

原则：

- **全部用字节级 fixture**：`Buffer.from('<hex>', 'hex')` 内联在测试里，**不新增二进制文件**（便于 review、避免仓库膨胀）；
- 断言对象是 `{ text, meta }`，而不是「看起来对」；
- 归属 `electron` 项目（`node` 环境、`pool: 'forks'`、单 worker），纯函数用例可并行执行；
- **兜底不得用于「让测试变绿」**（S2，与 §8.4 同一原则）：任何走到兜底路径（`fallback-latin1` / `utf16-structure` / `suspect`）的用例，必须**显式断言** `source` / `confidence`，不允许用「文本看起来对」或宽松匹配掩盖判定链未生效；反之，期望值也不得写成「兜底也能过」的弱断言。

| # | 用例 | 输入（hex 片段） | 期望 |
|---|------|------------------|------|
| T1 | **事故真实样本** | 见附录 A（136 字节 UTF-16LE） | `encoding='utf-16le'`、`source='utf16-pattern'`、文本 = 原始中文、`replacements=0`、失败时自动产出 rawArtifact |
| T2 | 任意切分一致性（G2） | T1 的字节，按 1 / 3 / 7 / 64 字节切分 | 与整块解码**逐字符相同** |
| T3 | 无 prelude 的 PS 输出 | `d6d0cec4b2e2cad40d0a` | 解为「中文测试」；`encoding` 为 `gbk`（OEMCP=936 时） |
| T4 | UTF-8（带/不带 BOM） | `e4b8ade69687…` / `efbbbfe4b8ad…` | 均解为「中文测试」；BOM 用例 `bomBytes=3` |
| T5a | UTF-16BE **带 BOM** | `feff4e2d6587…`（≥16 字节） | `encoding='utf-16be'`、`source='bom'`、`confidence='exact'`、`bomBytes=2` |
| T5b | UTF-16BE **无 BOM、纯 CJK**（B1 核心用例） | `4e2d6587` 重复 5 次（20 字节；两字节均非 `0x00`，见附录 A.5），契约 `auto` | `encoding='utf-16be'`、`source='utf16-structure'`、`confidence='medium'`、`suspect=false`（§8.1 第 5 行判据） |
| T5c | UTF-16BE **无 BOM、纯 CJK、样本 <16 字节** | `4e2d6587` 重复 3 次（12 字节），契约 `auto` | **不猜**：维持前序结论 + `suspect=true` + 原始字节保留（§8.5） |
| T6 | 非 GBK 的 OEM CP | Big5 / Shift_JIS / CP437 样本 | 950→`big5`、932→`shift_jis` 解对；437 → `fallback-latin1` + `confidence='low'` + `suspect=true` |
| T7 | **合法文本含 U+FFFD**（回归 §8.1 废弃判据） | `efbfbd` 作为真实内容 + 普通 ASCII | 保持 UTF-8 解码，**不得**改判 GBK |
| T8 | 契约冲突 | 契约 `utf8` + T1 字节 | 前导窗口内：改判为 utf-16le 并记 `contract-mismatch`；越窗后：`suspect=true` |
| T9 | 混合流 | UTF-16LE ASCII 段 + GBK 中文段 | 不抛错、字节不丢、`suspect=true`、`lossStage` 不误报为 `host` |
| T10 | 多字节跨 chunk | UTF-8 三字节拆成 1+1+1；GBK 双字节拆成 1+1 | 无 U+FFFD，文本正确 |
| T11 | 编码「翻转」诱饵 | 前段纯 ASCII（两编码均合法）+ 后段 GBK | 锁定后**不得改判**；输出与整块解码一致 |
| T12 | MCP stdio 中文行 | 中文 JSON 行按任意位置切开 | `lineSplitter` 输出完整行、无 U+FFFD |
| T13 | 终端与文本一致 | 同一字节流分别走 raw（xterm）与文本投影 | raw 字节 = 原始字节；文本编码与契约一致 |
| T14 | rawArtifact 语义 | 失败 / suspect / truncated 各一击 | 必产出；`sha256` 只覆盖落盘字节；`omittedBytes` 正确 |
| T15 | 字节口径与兼容（G8/M3） | 事故字节 + 任意样本 | `*RawBytes` = 原始字节数（136）、`*Bytes` = `*TextBytes` = 文本 UTF-8 长度（154，**旧字段语义不变**）；`decodeReplacements` 计数正确（§9.5/§9.6） |
| T16 | 退出码映射 | `0xFFFF0000` / `0xFFFD0000` / `0xC000013A` | 返回结构化语义与可执行建议；未收录码标 `unknown-windows-host` |
| T17 | hints 转发 | `SHELL_DIALECT_MISMATCH` 计划失败 | `tool_result` 中出现 `signals` 与 `hints`（§10.3） |

回归验收（Gate）额外要求：**用 T1 的字节重放本次事故**，模型侧输出必须能读到「UTF-16LE + HRESULT 8009001d + 原始字节已保存」，且不再出现 50 个 NUL 字符。
## 12. 迁移清单

| # | 文件 | 改动 | 风险 |
|---|------|------|------|
| 1 | `electron/processOutput/`（新增） | `detectEncoding.ts` / `decodeChildOutput.ts` / `contracts.ts` / `lineSplitter.ts` | 低（新增） |
| 2 | `electron/processOutputEncoding.ts` | 保留 `buildShellEnv` / `buildPythonScriptEnv`；删除三个解码函数 | 中（调用方需全部迁移，靠编译期发现） |
| 3 | `electron/shell/shellProfiles.ts`（含 `shellProfiles.test.ts`） | `encoding` → `outputEncoding: OutputEncodingContract`；prelude 按 D1 决策调整；同步更新 `shellProfiles.test.ts:58` 的冻结断言 | **高**（影响所有 PowerShell 执行路径） |
| 4 | `electron/shell/preparedShellExecution.ts` | 契约字段进入 plan 与 `planDigest` | 中（`configRevision`/`planDigest` 变化会触发既有 plan 失效路径） |
| 5 | `electron/shell/boundedOutput.ts` | 改为原始字节缓冲（`appendBytes`/`snapshotBytes`），文本投影移出 | 中 |
| 6 | `electron/shell/outputArtifactWriter.ts` | 增加 `appendBytes`；artifact 语义改为原始字节 | 低 |
| 7 | `electron/shell/shellExitCodes.ts` | Windows 宿主码/HRESULT 映射（结构化返回） | 低 |
| 8 | `electron/shell/shellLogFields.ts` | allowlist 扩充（§10.5） | 低（但不做则字段静默丢失） |
| 9 | `electron/shell/orphanProcessCleanup.ts` | 去掉「复用 prelude 固定 UTF-8」的绕法，改为显式契约 | 中（涉及进程属主校验的审计证据） |
| 10 | `electron/shell/terminalToolContract.ts` | 契约透传 | 低 |
| 11 | `electron/tools/runShellExecutor.ts` | 主改造：契约 → 解码器 → raw 缓冲 → artifact → 诊断字段 | **高** |
| 12 | `electron/tools/builtinExecutors.ts` | `grepWithRg` 走新入口；`run_script` 登记契约 | 中 |
| 13 | `electron/tools/runShellPlan.ts` | 计划错误携带 `data`（signals/hints/encoding） | 中 |
| 14 | `electron/toolChatLoop.ts` | `buildToolErrorResult` 传入 `result`（§10.3） | 中 |
| 15 | `electron/spawnUtil.ts` | `runCommandWithTimeout` 返回 stderr 与 meta | 中（消费者含进程属主校验与 Python 探测） |
| 16 | `electron/appIpc.ts` | `tool:test-interpreter` 走新入口 | 低 |
| 17 | `electron/feishu/larkCliRunner.ts` | 单条解码路径 + `lineSplitter` | 中（飞书 CLI 输出含中文） |
| 18 | `electron/mcp/stdioTransport.ts` | `lineSplitter` 替代 `toString('utf8')` | 低 |
| 19 | `src/shared/terminalScrollback.ts` | 终端保持 raw；文本投影复用契约 | 中（跨进程共享） |
| 20 | `src/shared/domainTypes.ts`、`src/shared/api.ts` | 新增 `OutputEncodingContract` / `DecodedStreamMeta` / `rawArtifact` 类型 | 中（需 `typecheck:shared` + `typecheck:renderer`） |
| 21 | `electron/processOutput/*.test.ts` 等 | §11 用例集 | 低 |
| 22 | `docs/develop/bash-run-shell-current-state-and-optimization-review.md` | 同步 P1/目标态字段（避免两份文档不一致） | 低 |

## 13. 实施阶段与验收标准

### Phase 0 — 决策与基线（不改行为）

1. 复核 §7.3 的 prelude 取舍（A/B/C），跑现有 shell 相关测试确认哪些用例隐含依赖「prelude 固定 UTF-8」；
2. 确认 OEMCP 探测在目标环境（zh-CN / 其他语言宿主）上的可用性；
3. 产出决策记录：已确认项（D1/D2/D3/D5）的**实测复核结果**与未决项（D4/D6/D7）的建议（§14.1；其中 D4 后于 2026-09-12 被**否决**，见 §14.1）。

**Gate 0**：`npm run test:electron` 全绿（基线）；D1（已由用户确认）的**实测复核**完成、影响面已列出；确认无测试依赖「artifact 只在大输出时产出」这一现状。

### Phase 1 — L2 + L3 内核与「事故可诊断」

1. 新建 `electron/processOutput/`（`detectEncoding` + 流式/一次性解码器 + 契约类型 + OEMCP 探测）；
2. `RawByteBuffer` + artifact `appendBytes` + 字节口径字段（G4/G8）；
3. `runShellExecutor` 主通道接入（契约、锁定、字节缓冲、失败自动 artifact）；
4. Windows 退出码映射（§10.2）+ 诊断字段（§10.4/§10.5）；
5. 用例：T1/T2/T3/T5a/T5b/T5c/T7/T10/T11/T15/T16（含 B1 新增的 UTF-16 结构启发式内核用例）。

**Gate 1（关键）**：用附录 A 的真实字节**重放本次事故**：模型可见输出 = 「UTF-16LE 还原文本 + `0xFFFF0000` 宿主初始化失败语义 + HRESULT 8009001d + 原始字节已保存」，且 **不再出现 NUL 字符**；`stderrRawBytes` = 136（旧口径 `stderrBytes` 仍为 154，两者并存见 §9.6）。

### Phase 2 — 统一入口与诊断闭环

1. 迁移 §3.1 其余解码点（`spawnUtil` / `grepWithRg` / `larkCliRunner` / `appIpc` / MCP / terminal）；
2. `lineSplitter` 落地（MCP 与 lark 复用）；
3. `SHELL_DIALECT_MISMATCH` 的 signals/hints 转发（§10.3）；
4. 删除旧解码函数（第 2 项迁移完成后再删，避免半迁移状态）；
5. 用例：T4/T6/T8/T9/T12/T13/T17 + 全量 `npm run test:electron`。

**Gate 2**：`rg "toString\('utf8'\)"` 在子进程输出路径上零命中（白名单仅文件内容路径）；`npm run build:electron:incremental` + `npm run typecheck:renderer` 通过。

### Phase 3 — 体验收敛与长期度量

1. UI/远程 IM 的 `outputTrust: 'suspect'` 提示；
2. `contractConflict` 长期度量（若某 profile 频繁冲突，改为 `auto`）；
3. 按 D1 决策收尾 prelude（若采用 C，需单独 commit 便于回滚）；
4. code review checklist 与既有目标态文档同步。

**Gate 3**：`npm test` 全量 + `npm run build` 验收；本需求 §11 的 19 个用例（T5 已拆为 T5a/T5b/T5c）全部通过。

> 阶段纪律（遵循仓库 AGENTS.md）：开发期只跑定向测试（`npm exec vitest run <文件>`），全量 `npm test` 仅在阶段收尾与提交前执行；每阶段独立提交。
## 14. 决策点

| # | 决策 | 选项 | 建议 | 需谁确认 |
|---|------|------|------|----------|
| D1 | PowerShell prelude 是否继续钉 UTF-8 | A 现状 / B 钉 OEM CP / C 只静默 progress，不动 `[Console]::OutputEncoding` | **C**（§7.3 实测：A 在 native→字符串路径会不可逆损坏；B 保留兼容但规则仍偏） | **已确认**（用户 2026-09-12 拍板）；Phase 0 只做**实测复核**，不再重新定稿 |
| D2 | `ShellProfile.encoding` 是替换还是新增字段 | 替换 / 并存 | **替换**（并存会留下两个真值来源，必然再次漂移） | **已确认**（用户 2026-09-12：可以改）；Phase 0 同步更新冻结断言 |
| D3 | 探测窗口大小与可配置性 | 8 KiB 固定 / 可配置 | **甲**：8 KiB 窗口内不交付文本，到点判定一次并锁死；不足 8 KiB 在 `end()` 时判定（§8.2「交付与锁定分离」）；`windowBytes=0` 退化为「首块即判定」 | **已确认**（用户 2026-09-12 选「甲」）；Phase 0 实测复核首段延迟观感 |
| D4 | 是否新增用户级 `shellConfig.outputEncoding` 覆盖 | 现在做 / 延后 / **不做** | **不做**：不给用户任何编码选项。编码分层归属不同（系统 CP / PowerShell 自身输出（内部错误为 UTF-16LE）/ 被调用工具自带编码），同一条流可能混合以上来源，任何单一取值都会错一部分；正确性由应用内部闭环（启动契约 + 字节判定 + 可疑留档） | **已否决**（用户 2026-09-12） |
| D5 | rawArtifact 默认产出策略 | 总是 / 仅失败与可疑 | **仅失败与可疑**（+ 既有大输出条件）；目录限定 `userData/shell-output`，内容标注 `unredacted` | **已确认**（用户 2026-09-12）；落地前需安全复核（涉及敏感内容） |
| D6 | 终端（xterm）路径是否也走 L2 | 是 / 否 | **否（保持 raw 字节直达 xterm）**，但文本回滚/日志投影必须复用同一契约 | 评审 |
| D7 | 是否把「禁止用 PS 处理 native 文本」写进命令模板提示 | 写 / 不写 | 写进系统提示的 shell 使用说明（低成本，能规避 S5/S6 的一类高发场景） | 评审 |

### 14.1 决策确认结论（2026-09-12，**由用户逐条拍板**）

> **来源与效力（M2 修订）**：下表 D1/D2/D3/D5 的结论来自**需求方（用户）在本会话中的逐条确认**，不是评审人意见；D6/D7 仍是本文档的**建议**（D4 已于 2026-09-12 由用户**否决**，见下表）。因此本节**不等于**「文档已通过评审定稿」——文档状态见文首元信息。Phase 0 对已确认项只做**实测复核**（跑现有测试、确认无隐藏依赖），不再「定稿」。

| # | 结论 | 落地要点 |
|---|------|----------|
| D1 | **已确认：删掉** `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()` 这一行（回到宿主默认编码），prelude 只保留 `$ProgressPreference='SilentlyContinue'` | 理由：实测对硬编码输出的 native 工具无影响（字节透传），却在「native 输出 → PS 字符串」路径造成不可逆损坏。落地时单独 commit；Phase 0 先跑现有 shell 测试，确认没有命令/用例依赖「prelude 固定 UTF-8」这一行为 |
| D2 | **替换** `ShellProfile.encoding` 为有消费者的契约字段，不并存 | 同步更新 `electron/shell/shellProfiles.test.ts` 的冻结断言与 `preparedShellExecution` 的类型 |
| D3 | **已确认：采用甲**——`windowBytes`（默认 8 KiB）是「未判定缓冲」上限，缓冲内不交付文本，到点判定一次并锁死；不足 8 KiB 的流在 `end()` 时判定。交付与锁定的分离见 §8.2（纯 ASCII 前缀可在判定前先行交付） | 采用甲的额外好处：不需要界面/远程协议支持「回退重发」。现有进度节流为 `minBytes: 16KB`（`runShellExecutor.ts:184`），窗口带来的体感延迟可忽略。乙作为 Phase 3 可选项保留（若将来要「先显示后纠正」） |
| D5 | **已确认：内存负责「当场重解」，文件负责「事后可查」**；失败/解码可疑/截断时自动落盘保留的原始字节 | 另需修正：artifact 内容必须是**原始字节**而非解码后文本（否则落盘也没用，见 §9.1）；内容不脱敏（与现状一致），显式标注 `note:'unredacted'`。重新解码本身**不依赖** artifact，见 §14.2 |
| D4 | **已否决：不提供用户级编码配置**（原「延后到 Phase 3」的建议作废） | 编码正确性由应用内部闭环，不向用户暴露编码选项：①契约按 spawn 点声明（`run_script` 的 UTF-8 是我们自己钉的，lark 等第三方 CLI 只能 `auto`）；②实际编码按字节判定一次并锁定；③混合/不可解时不硬猜，标 `suspect` 并留原始字节。若将来要提升某类宿主的覆盖度，方向是**改应用的启动方式/宿主 profile**（应用内部决策），不是给用户加开关 |
| D6 / D7 | 维持建议（D6 终端保持 raw 直达 xterm、D7 写进 shell 使用提示） | 本轮未单独评审 |

### 14.2 关于 D5 的澄清：内存重解 ≠ 落盘追溯（2026-09-12）

- **重新解码不需要文件**：原始字节只要还在内存里（§9.2 的 `RawByteBuffer`）就能随时重解——这正是「8 KiB 窗口内允许改判一次」的实现方式（§8.6）。
- **落盘的唯一目的是事后追溯**：进程退出、应用重启、会话关闭之后，内存里的字节就没了；而日志里留下的可能只是「已经解错的文本」。本次事故正是如此——只有乱码文本、没有原始字节，还原靠的是「Windows 固定文案 + 逐字节反解」的运气。
- 所以 D5 的正式表述是：**内存负责「当场重解」，文件负责「事后可查」**；artifact 不是解码的前置条件，也不参与判定流程。
- 容量口径：内存与 artifact 共用同一套上限（head/tail + `ioMaxBytes`），因此不存在「内存留不下、必须写文件」的因果关系；写文件换来的是跨进程、跨时间的能力。

## 15. 风险与回滚

| # | 风险 | 影响 | 缓解 | 回滚 |
|---|------|------|------|------|
| R1 | 探测窗口带来首段文本延迟（最多 8 KiB） | 进度回显观感变化 | 窗口上限固定 8 KiB（§8.2，**不做换行触发**）；纯 ASCII 前缀在所有候选下一致 ⇒ 立即交付，只有「首个字节起就非 ASCII 且候选未收敛」的流才缓冲到 8 KiB | `windowBytes=0` 恢复「立即交付」（但保留锁定语义，不恢复 `slice` 增量） |
| R2 | OEMCP 探测失败或注册表被改 | 编码整体判错 | 交叉校验 `chcp`；失败降级 `auto` + `suspect`；日志记录 `source` | 契约改 `auto`，回到纯探测 |
| R3 | 契约冲突频繁（某宿主/某工具） | 诊断噪声 | 记录 `contractConflict` 作为长期指标，按 profile 调整契约 | 该 profile 改 `auto` |
| R4 | 按 D1 改 prelude 导致既有命令行为变化（`cmd` 输出由 UTF-8 变回 OEM CP） | 依赖 UTF-8 console CP 的命令输出变化 | Phase 0 实测 + 全量 shell 测试；单独 commit | 单 commit revert 回 A |
| R5 | rawArtifact 落盘带来磁盘占用与敏感内容 | 存储/合规 | 仅失败与可疑时产出 + head/tail 上限 + 明确 `unredacted` 标注 | 自动产出条件退回到现状（仅超过 `ioMaxBytes` 时惰性产出，即不新增自动产出） |
| R6 | 共享类型变更影响渲染进程 | 编译失败 | `npm run typecheck:shared` + `typecheck:renderer`；i18n 文案走 `t()` | 按类型回滚（新增字段全部可选） |
| R7 | 测试环境差异（CI 无 PowerShell/无 936 宿主） | 测试不稳定 | §11 用例全部**不 spawn**，只吃字节 fixture；真机路径单列标记用例 | 标记用例改为 `skipIf` 平台条件 |
| R8 | `shellLogFields` allowlist 漏加字段 | 日志缺字段却以为已实现 | §10.5 显式列出清单 + 单测断言关键字段存在 | — |
| R9 | 日志口径变更被误读（新旧字段并存） | 按旧口径写分析脚本/看板的人拿到不可比数据 | §9.6 明确「旧字段语义不变、`*RawBytes` 是唯一原始字节口径」，并在变更记录与 release note 中说明；`outputArtifactBytes`/`Sha256` 的取值变化与冻结测试同 commit | 撤销新增字段即可（旧字段本就未改，无需回滚） |

**回滚总策略**：Phase 1 只新增文件（不改旧函数），Phase 2 末尾才删除旧解码函数；prelude 改动独立 commit。任一阶段出问题都可单独 revert 而不影响其余阶段。

## 16. 相关文件

**主改造**

- `electron/processOutput/`（新增：`detectEncoding.ts` / `decodeChildOutput.ts` / `contracts.ts` / `lineSplitter.ts`）
- `electron/processOutputEncoding.ts:9-19,25-44,51-60`（解码函数，待迁移并删除）、`:63-110`（env 构造，保留）
- `electron/tools/runShellExecutor.ts:168-169,203-225,285-304,375-400,414-478,510-520,538-546`
- `electron/shell/shellProfiles.ts:11,27,45,52-57,78-86`
- `electron/shell/shellProfiles.test.ts:58`（D2 要求同步更新的冻结断言）
- `electron/shell/preparedShellExecution.ts:6-25`
- `electron/shell/boundedOutput.ts:1-56`
- `electron/shell/outputArtifactWriter.ts:33-36`
- `electron/shell/shellExitCodes.ts:1-9`
- `electron/shell/shellDialectMismatch.ts:23-27`
- `electron/shell/shellLogFields.ts:14-28,50-55`
- `electron/shell/orphanProcessCleanup.ts:24-47`
- `electron/shell/terminalToolContract.ts:1-25`
- `electron/spawnUtil.ts:21-55`
- `electron/tools/builtinExecutors.ts:791-818,1134-1136,1173-1175`
- `electron/tools/runShellPlan.ts`（计划错误携带 data）
- `electron/toolChatLoop.ts:304-326,1146-1154`
- `electron/appIpc.ts:549-566`
- `electron/feishu/larkCliRunner.ts:141-155`
- `electron/mcp/stdioTransport.ts:169-185`
- `src/shared/terminalScrollback.ts:118-124`
- `src/shared/domainTypes.ts`、`src/shared/api.ts`（类型新增）

**既有目标态文档**

- `docs/develop/bash-run-shell-current-state-and-optimization-review.md:169,326-335,385,725,882`

**证据来源**

- `.agent/logs/Agent-20260911.log`：L1015、L1017-1018、L1024、L1029、L1032-1034、L1036、L1040、L1044-1046、L1060-1061、L1075-1078

## 附录 A：事故字节样本与还原脚本

### A.1 原始字节（UTF-16LE，136 字节）

```
570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000
8551e8901995ef8b0230a0527d8f5862a17b84762000
570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000
3159258d0cffd48fde561995ef8b20003800300030003900300030003100640002300d000a00
```

对应文本（68 码元）：

```
Windows PowerShell 内部错误。加载托管的 Windows PowerShell 失败，返回错误 8009001d。\r\n
```

### A.2 可复核的判定脚本（Node，与主进程同实现）

```js
const hex =
  '570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000' +
  '8551e8901995ef8b0230a0527d8f5862a17b84762000' +
  '570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000' +
  '3159258d0cffd48fde561995ef8b20003800300030003900300030003100640002300d000a00'
const B = Buffer.from(hex, 'hex')
console.log('rawBytes =', B.length)                                   // 136
console.log('utf16le  =', JSON.stringify(B.toString('utf16le')))      // 正确原文
const utf8 = new TextDecoder('utf-8').decode(B)
const gbk  = new TextDecoder('gbk').decode(B)
console.log('utf8 has FFFD =', utf8.includes('\uFFFD'))               // true → 现状判据命中
console.log('gbk === 模型所见文本 =', gbk.includes('匭钀'))            // true → 现状最终选了 GBK
console.log('decodedTextBytes =', Buffer.byteLength(gbk, 'utf8'))     // 154 = 日志中的 stderrBytes
```

### A.3 现状解码规则的等价实现（用于回归对比）

```js
function legacyDecodeProcessOutput(buf, platform = process.platform) {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (platform !== 'win32') return utf8   // processOutputEncoding.ts:54
  const gbk  = new TextDecoder('gbk').decode(buf)
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s)
  if (hasCjk(gbk) && !hasCjk(utf8)) return gbk
  if (utf8.includes('\uFFFD') && hasCjk(gbk)) return gbk
  return utf8
}
// legacyDecodeProcessOutput(B) 应等于 gbk 解码结果（即事故中模型看到的 126 字符乱码）
```

### A.4 本机复测证据（§3.3 矩阵的原始数据）

| 场景 | 字节（hex 前缀） | 字节数 |
|------|------------------|--------|
| 无 prelude，`Write-Output "中文测试"` | `d6d0cec4b2e2cad40d0a` | 10 |
| prelude(U)，`Write-Output "中文测试"` | `e4b8ade69687e6b58be8af950d0a` | 14 |
| prelude(936)，`Write-Output "中文测试"` | `d6d0cec4b2e2cad40d0a` | 10 |
| 无 prelude / prelude(U) / prelude(936)，native 写死 GBK 字节 | `d6d0cec4b2e2cad4` | 8（三者完全相同 ⇒ 字节透传） |
| 无 prelude / prelude(U) / prelude(936)，native 写死 UTF-8 字节 | `e4b8ade69687e6b58be8af95` | 12（三者完全相同 ⇒ 字节透传） |
| 无 prelude，`cmd /c echo 中文` | `d6d0cec4b2e2cad40d0a` | 10 |
| prelude(U)，`cmd /c echo 中文` | `e4b8ade69687e6b58be8af950d0a` | 14 |
| prelude(U)，`$x = (node 写死 GBK)` 后输出 | `5befbfbdefbfbdefbfbdc4b2efbfbdefbfbd5d0d0a` | 21（**U+FFFD×6，不可逆**） |
| prelude(936)，`$x = (node 写死 GBK)` 后输出 | `5bd6d0cec4b2e2cad45d0d0a` | 12（坏字符映射，**字节可逆**） |

其它实测：`[Console]::OutputEncoding.WebName` 报 `utf-8` 而 `chcp` 报 `Active code page: 936`（二者不一致，故不能互相替代）；注册表 `OEMCP=936`、`ACP=936`、`MACCP=10008`；`TextDecoder` 实测不支持 `cp437`/`ibm437`，支持 `gbk`/`gb18030`/`big5`/`shift_jis`/`euc-kr`/`windows-1252`/`ibm866`/`utf-16le`/`utf-16be`。

### A.5 无 BOM 纯 CJK UTF-16 的复核（B1 判据依据）

T5b/T5c 的样本是 `4e2d6587`（U+4E2D「中」、U+6587「文」）的重复——**两个字节均非 `0x00`**，所以 §8.1 第 2 行的「奇偶零字节」判据必然不命中，只能靠第 5 行的结构启发式。本机实测：

```js
const B = Buffer.from('4e2d6587'.repeat(5), 'hex')                        // 20 字节 = T5b
console.log('rawBytes =', B.length)                                       // 20
const u = new TextDecoder('utf-16be').decode(B)
const g = new TextDecoder('gbk').decode(B)
console.log('utf16be =', JSON.stringify(u))                               // "中文中文中文中文中文"
console.log('gbk     =', JSON.stringify(g))                               // "N-e嘚-e嘚-e嘚-e嘚-e\uFFFD"
console.log('pua_utf16 =', (u.match(/[\uE000-\uF8FF]/g) || []).length)    // 0
console.log('fffd_gbk  =', (g.match(/\uFFFD/g) || []).length)             // 1
```

实测结论（对应 §8.1 判据 3/4）：

- UTF-16BE 解释 → 5 个常用区 CJK 码元，`textScore` 高；
- GBK 解释 → ASCII 碎片（`N-e`）+ 一个偶合汉字 + **U+FFFD（解码失败）**，`textScore` 被负分项压低；
- 因此 `max(textScore_LE, textScore_BE) ≥ textScore_OEM + 0.5` 成立 ⇒ 判定 `source='utf16-structure'`、`confidence='medium'`。

样本降到 12 字节（`4e2d6587` 重复 3 次，T5c）时不足 16 字节，按 §8.1 判据 1 **不参与**判定 ⇒ 维持前序结论 + `suspect=true` + 保留原始字节。

> 另一类佐证（事故样本）：`0xA17B` 被 GBK 解成**私有使用区**的 `U+E501`（见 A.2），说明 OEM CP 对非本 CP 字节的常见失败形态是「落到负分区」——这正是判据 3 把私用区与替换字符计入负分的原因。

---

**文档结束。** 评审通过后按 §13 的 Phase 0 起步；Phase 0 的产出是已确认决策（D1/D2/D3/D5）的实测复核结果与基线测试结果，不是代码改动。
