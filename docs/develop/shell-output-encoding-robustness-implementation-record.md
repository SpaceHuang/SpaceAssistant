# Shell 输出编解码健壮性 — 实施记录

- **需求来源**：`docs/requirement/shell-output-encoding-robustness-requirement.md`（v1.1，2026-09-12）
- **落地位置**：worktree `.worktrees/shell-output-encoding`，分支 `codex/shell-output-encoding-robustness`
- **实施日期**：2026-09-12
- **阶段状态**：Phase 0（决策与基线）/ Phase 1（L2 + L3 内核）/ Phase 2（统一入口与诊断闭环）/ Phase 3（体验收敛与长期度量）全部落地
- **唯一入口**：`electron/processOutput/`（§10.1）。本记录同时承担"两条目标态文档不同步"的对照表职责，§12 #22 要求的同步内容见 §6。

## 1. 交付概览

| 模块 | 文件 | 内容 |
|---|---|---|
| 契约层 L1 | `src/shared/outputEncoding.ts` | `OutputEncodingContract` / `OutputEncodingKind` / `OutputEncodingSource` / `DecodeConfidence` / `DecodedStreamMeta` / `StreamDecodeDiagnostics` / `RawArtifactInfo`（主进程与渲染进程共用） |
| 契约层 L1 | `electron/processOutput/contracts.ts` | `AUTO_CONTRACT` / `UTF8_CONTRACT` / `UTF16LE_CONTRACT` / `oemContract()`、`labelForOemCodepage`、`expectedLabelForContract`、`detectOemCodepageSync`（注册表 `OEMCP` + 缓存）、`defaultContractForPlatform` |
| 探测层 L2 | `electron/processOutput/detectEncoding.ts` | §8.1 判定链（BOM → UTF-16 零字节奇偶 → 契约 → 严格 UTF-8 → OEM CP → 可逆兜底）、`textScore`、`tryUtf16Structure`、`isDecodeSuspect` |
| 探测层 L2 | `electron/processOutput/decodeChildOutput.ts` | `decodeChildOutput()`（一次性）+ `createChildStreamDecoder()`（流式，交付与锁定分离，§8.2） |
| 探测层 L2 | `electron/processOutput/lineSplitter.ts` | 行协议复用（MCP stdio / lark 事件流） |
| 探测层 L2 | `electron/processOutput/clixml.ts` | `#< CLIXML` 识别与剥离（§10.2 / S5） |
| 诊断 L4 | `electron/processOutput/diagnostics.ts` | `buildStreamDiagnostics`、`resolveLossStage`、`formatOutputDiagLine`、`resolveOutputTrust` |
| 保真层 L3 | `electron/shell/boundedOutput.ts` | `RawByteBuffer`（head/tail 原始字节环形缓冲）、`RawByteSnapshot`、`TRUNCATION_MARKER`、`rawSnapshotBuffer` |
| 保真层 L3 | `electron/shell/outputArtifactWriter.ts` | `appendBytes()` 原始字节直存；sha256/bytes 只覆盖落盘字节 |
| 保真层 L3 | `electron/shell/outputPipeline.ts` | 快照（`stdout/stderr: RawByteSnapshot`）+ 文本投影（`stdoutText/stderrText`，投影时才解码） |
| 保真层 L3 | `electron/shell/rawTextProjection.ts` | `decodeRawSlice` / `projectRawText`（回滚与日志文本投影复用同一契约） |
| 诊断 L4 | `electron/shell/shellExitCodes.ts` | `describeExitCodeDetails()`（family/semantics/unsigned/signed/advice）+ `describeHresult()` |
| 诊断 L4 | `electron/shell/shellLogFields.ts` | §10.5 allowlist 扩充（不做则字段静默丢失） |
| 主通道 | `electron/tools/runShellExecutor.ts` | 契约 → 解码器 → `RawByteBuffer` → artifact → 诊断字段 → `rawArtifact` → `hints` |
| 测试夹具 | `electron/processOutput/testFixtures.ts` | 事故 136 字节、GBK/UTF-8 中文、UTF-16BE 样本（全部内联 hex，不新增二进制文件） |

## 2. 判定链实现口径（§8.1）

1. **BOM**（`source='bom'`、`confidence='exact'`）：UTF-8 BOM / UTF-16LE BOM / UTF-16BE BOM，`bomBytes` 记录跳过长度。
2. **UTF-16 零字节奇偶**（`utf16-pattern`）：奇数位或偶数位零字节占比 `>= 0.5` 且另一侧 `<= 0.1`，判 `high`。
3. **契约**（`contract`）：`utf8` 严格 UTF-8 通过即判；`oem` 走对应代码页。
4. **严格 UTF-8**（`strict-utf8`）：合法即判 `high`。
5. **OEM CP**（`oem-codepage`）：按探测到的代码页解码。
6. **UTF-16 结构启发式**（`utf16-structure`）：仅当流内自带非 ASCII（避免把纯 ASCII 误判成 UTF-16）、样本 `>= 16` 字节、非严格解码打分 `>= 0.5` 且领先 OEM 候选 `>= 0.1` 时判 `medium`；证据不足（样本过短/分值不够）**不猜**，沿用前序结论并标 `suspect`。
7. **可逆兜底**（`fallback-latin1` = `windows-1252`、`confidence='low'`、`weakEvidence`）：任何字节都能原样还原，必然 `suspect`。

`contractConflict='contract-mismatch'` 只在前导窗口内允许改判一次（§8.6）；越窗后保持已锁定编码并标 `suspect`。

## 3. 与需求文本的偏差（逐条留痕）

需求 v1.1 的正文与附录存在少量内部不一致，或实现后必然与举例数值不同。以下偏差全部有测试与代码依据，**不是"为了过测试"的弱化**：

| # | 需求文本 | 实现 | 理由 |
|---|---|---|---|
| 1 | §8.1 第 2 行 UTF-16 零字节奇偶阈值 80% | `>= 0.5`（另一侧 `<= 0.1`） | 事故样本 136 字节中零字节只占奇数位的 73.5%，按 80% 同一份样本反而不成立；50% + 另一侧上限既能判定事故样本，也不会把单侧密集零字节的二进制数据当文本 |
| 2 | §8.1 第 5 行结构启发式领先 margin 0.5（与绝对下限混用） | 基线用**非严格解码**打分，判据 `score >= 0.5` 且 `>= oemScore + 0.1` | T5b 的 20 字节样本在 GBK 侧同样得到 1.0 分（`4e2d6587`×5 恰好构成合法 GBK 序列），0.5 的 margin 会让两个候选都不达标而卡死；改为"绝对下限 + 小幅领先"可复现地判定 |
| 3 | §8.3 建议"裁掉尾部不完整序列后重试严格解码" | 直接 `TextDecoder(label,{fatal:true}).decode(buf,{stream:true})`，不做裁尾重试 | 裁尾重试会把 `808182` 这类真正非法字节裁成空串后判为"合法 UTF-8"，从而掩盖损坏 |
| 4 | §8.4 suspect 判据未列 NUL | `countNulChars` 计入 `isDecodeSuspect` | 解码后仍含 NUL 是"文本不可信"的强信号（事故症状之一正是 50 个 NUL） |
| 5 | §7.6 契约冲突不静默改判（未写例外） | OEM 契约 + 含非 ASCII + 合法 UTF-8 → 判 `utf-8`/`strict-utf8` 并记 `contract-mismatch` | 第三方 CLI（lark 等）在 OEM 宿主上仍可能输出 UTF-8；合法 UTF-8 是强证据，允许这一次改判并留痕 |
| 6 | §8.4 未按置信度区分契约冲突 | `high` + 契约冲突**不**触发 suspect，`medium` + 冲突才触发 | 合法 UTF-8 / BOM 是确定性证据，若也标 suspect 会让诊断噪声掩盖真实可疑样本 |
| 7 | §9.5 / §11 T15 举例 `stderrBytes = 154`（“旧字段语义不变”） | 事故重放实测 `stderrBytes = stderrTextBytes = 104` | 154 是**旧解码器乱码文本**的 UTF-8 长度；解码修正后同一语义（“解码后文本的 UTF-8 长度”）必然给出 104。字段语义未变、取值随修复而变；`stderrRawBytes = 136` 是与旧口径并存的新事实 |
| 8 | §9.5 未明确 OEM 契约下纯 ASCII 的判定 | Windows OEM 契约下纯 ASCII 判 `gbk` / `oem-codepage`（不判 `utf-8`） | 纯 ASCII 在所有候选下等价，按契约登记来源更可解释；测试不得把这类样本写成 `utf-8` 断言 |

## 4. 字节与日志口径（§9.5 / §9.6）

事故重放（136 字节 UTF-16LE）实测：

| 字段 | 值 | 说明 |
|---|---|---|
| `stderrRawBytes` | 136 | 新增：原始字节数（唯一原始口径） |
| `stderrRawSha256` | 136 字节的 sha256 | 新增 |
| `stderrBytes` / `stderrTextBytes` | 104 | 旧字段语义不变（解码后文本 UTF-8 长度），取值随解码修复而变 |
| `decodeReplacements` | 0 | 判定为 UTF-16LE 后无替换字符 |
| `outputArtifactBytes` / `outputArtifactSha256` | 136 / 原始字节 sha256 | 唯一取值变化的既有字段（artifact 内容由文本改为原始字节），冻结测试同 commit 更新 |
| `planMs` / `spawnToExitMs` / `durationMs` | 三者并存，`durationMs = totalMs` | 事故中子进程只活 124ms 量级，原先被 3072ms 的单一耗时掩盖 |
| `outputArtifactReason` / `rawArtifactReason` | `failed` \| `suspect` \| `truncated` \| `size` | §9.4 自动产出条件 |

日志侧：`shell.exec.finish` 新增字段已登记 `electron/shell/shellLogFields.ts` 的 `ALLOWED_KEYS`（否则静默丢弃）；`outputDiag` 为机器可读的纯 ASCII 诊断行（`[output-diag] stream=… encoding=… source=… confidence=… replacements=… contract=… conflict=… suspect=… rawArtifact=…`）。

## 5. 决策点落地（§14）

| # | 决策 | 落地 |
|---|---|---|
| D1 | prelude 只静默 progress，不再固定 UTF-8 | `WINDOWS_POWERSHELL_PRELUDE = "$ProgressPreference = 'SilentlyContinue';"`；**独立 commit** |
| D2 | `ShellProfile.encoding` 替换为有消费者的契约字段 | `outputEncoding: OutputEncodingContract` + `encodingSource: 'builtin' \| 'user' \| 'detected'`；冻结断言同步更新 |
| D3 | 8 KiB 窗口、判定一次并锁死 | `createChildStreamDecoder` 的 `windowBytes`（默认 8 KiB）；纯 ASCII 前缀可先行交付，`windowBytes=0` 退化为“首块即判定” |
| D4 | 用户级 `shellConfig.outputEncoding` 覆盖 | **已否决**（需求 §14，2026-09-12）：不提供任何用户级编码配置 —— 用户无法判断也不应承担该决策；编码分层归属不同，任何单一取值都会解错一部分，正确性由应用内部闭环 |
| D5 | 内存负责当场重解、文件负责事后可查 | `RawByteBuffer`（内存 head/tail）+ artifact 原始字节直存；失败/可疑/截断自动落盘，`note: 'unredacted'` |
| D6 | 终端保持 raw 直达 xterm | 终端通道零文本解码；文本回滚/日志投影复用同一契约（`src/shared/terminalScrollback.ts`） |
| D7 | 把“禁止用 PS 承接 native 文本”写进 shell 使用说明 | `electron/shell/terminalToolContract.ts` 仅在 Windows PowerShell 方言注入该规则（不污染 POSIX 描述） |

## 6. 迁移清单落地（§12）

| # | 项 | 状态 |
|---|---|---|
| 1-2 | `electron/processOutput/` 新增；`processOutputEncoding.ts` 删除三个解码函数 | ✅ 完成（Gate 2：子进程输出路径 `toString('utf8')` 零命中） |
| 3-4 | `shellProfiles.ts`（D1/D2）；`preparedShellExecution.ts`（契约进入 plan/planDigest） | ✅ |
| 5-6 | `boundedOutput.ts` → `RawByteBuffer`；`outputArtifactWriter.ts` 原始字节 | ✅ |
| 7-8 | `shellExitCodes.ts` 结构化退出码/HRESULT；`shellLogFields.ts` allowlist | ✅ |
| 9 | `orphanProcessCleanup.ts` 去掉“复用 prelude 固定 UTF-8”，改显式契约 | ✅ |
| 10-13 | `terminalToolContract.ts`、`runShellExecutor.ts` 主改造、`builtinExecutors.ts`（grep / run_script）、`runShellPlan.ts` | ✅ |
| 14 | `toolChatLoop.ts` 的 `SHELL_DIALECT_MISMATCH` 转发 `signals` / `hints` | ✅ |
| 15-18 | `spawnUtil.ts` 返回 stderr + meta；`appIpc.ts`；`feishu/larkCliRunner.ts` 单条解码路径；`mcp/stdioTransport.ts` 行切分 | ✅ |
| 19-20 | `terminalScrollback.ts`；共享类型新增 | ✅（新增类型落在 `src/shared/outputEncoding.ts`，在 `typecheck:shared` 覆盖范围内） |
| 21 | §11 用例集 | ✅ 见 §7 |
| 22 | 本文档 + `bash-run-shell-current-state-and-optimization-review.md` 同步 | ✅ 见该文档 §3.8 / §3.13 / Phase 2 / §11.2 / §11.3 |

## 7. 测试基线（§11）

| 用例 | 落地文件 | 说明 |
|---|---|---|
| T1 / T3 / T4 / T5a-c / T6 / T7 / T8 / T9 / T10 | `electron/processOutput/detectEncoding.test.ts` | 字节级 fixture，显式断言 `source` / `confidence` |
| T2 / T11 / T8（越窗） | `electron/processOutput/decodeChildOutput.test.ts` | 切分一致性、锁定后不改判 |
| T12 | `electron/processOutput/lineSplitter.test.ts` | 中文 JSON 行任意切分 |
| T13 | `electron/tools/runShellExecutor.test.ts` | 终端 raw 字节与原始字节逐字节一致 + 文本投影按契约 |
| T14 | `electron/tools/runShellExecutor.test.ts` | failed / suspect / truncated 三处断言：必产出、sha256 只覆盖落盘字节、`omittedBytes` 正确 |
| T15 | `electron/tools/runShellExecutor.test.ts` | `*RawBytes` 与 `*Bytes` / `*TextBytes` 并存且各自口径正确 |
| T16 | `electron/shell/shellExitCodes.test.ts` | `0xFFFF0000` / `0xFFFD0000` / 未收录码 |
| T17 | `src/shared/processResultProjection.test.ts` | signals / hints 到达模型，telemetry 不落自由文本 |
| 诊断行 / lossStage / outputTrust | `electron/processOutput/diagnostics.test.ts` | 机器可读诊断行与损失归因 |
| 契约与 profiles | `electron/shell/shellProfiles.test.ts`、`terminalToolContract.test.ts` | D1 / D2、D7 与 `output_encoding` 字段 |
| 日志 allowlist | `electron/shell/shellLogFields.test.ts` | 新增字段不被静默丢弃 |
| 保真层 | `electron/shell/outputPipeline.test.ts`、`shellLifecycleBenchmark.test.ts` | 快照口径与 100MB 有界性 |
| 投影白名单 | `src/shared/processResultProjection.test.ts`、`src/shared/shellToolDisplay.test.ts` | 新字段透传与非法形态丢弃 |
| UI | `src/renderer/components/Chat/ShellOutputView.test.tsx` | `outputTrust=suspect` 提示（§10.4） |

跨平台说明：本机只实测 Windows；`posix-bash` 相关断言以不 spawn 的纯函数用例覆盖，真机复跑仍以 CI 为准（需求 R7 的已知边界）。

## 8. Gate 验收

- **Gate 1（事故可诊断）**：`electron/tools/runShellExecutor.test.ts` 的 Gate 1 用例把附录 A 的 136 字节原样写进 stderr 并复现宿主失败退出码，断言：`utf-16le` / `utf16-pattern` / `high` / `replacements=0`、文本含“内部错误”与 `8009001d`、**不含 NUL**、`stderrRawBytes=136`、`stderrBytes=104`、`hresult=NTE_PROVIDER_DLL_FAIL (0x8009001D)`、artifact 为原始字节且 sha256 只覆盖落盘字节、日志含 `stderrEncoding` / `encodingSource` / `rawArtifactReason` / `outputTrust`。
- **Gate 2（统一入口）**：`rg "toString\('utf8'\)"` 在子进程输出路径零命中（剩余命中全部是文件内容读取路径，§3.1 已排除）；`tsc -p tsconfig.electron.json --noEmit`、`npm run typecheck:renderer` 通过。
- **Gate 3（全量验收，2026-09-12 本机 Windows x64 实测）**：
  - `npm test`：524 个测试文件 / 3378 个用例，**520 文件 / 3366 用例通过**；4 文件 / 9 用例失败，与 Phase 0 基线**完全一致**，且全部是与本需求无关的环境性失败（Windows 符号链接 `EPERM`：`electron/confirmation/extractors/extractors.test.ts`；ripgrep staging 缺失：`electron/tools/ripgrepBinary.test.ts`、`ripgrepPrepareSecurity.test.ts`、`afterPackRipgrep.test.ts`）。
  - `npm run build`：通过（托盘图标 + renderer + electron 全量构建）。
  - `npm run typecheck:renderer` / `npm run typecheck:shared` / `npm run i18n:check`：通过。
  - 全量首跑曾暴露一处回归（`reason` 进入通用进程投影白名单后，spawn 失败的原始诊断文本会漏进 Agent payload）；已改为「仅计划期诊断 payload（含 `SHELL_*` code / 方言错配标记）才转发 `reason`」，并补 `src/shared/processResultProjection.test.ts` 回归用例。

## 9. 新增 spawn 点的 code review checklist（§10.1）

新增任何启动子进程 / 读取其输出的代码，必须逐条自查：

1. **契约**：是否显式声明输出编码契约（`AUTO_CONTRACT` 也是一种声明）？不得隐式依赖宿主默认编码后再按 UTF-8 硬解。
2. **唯一入口**：是否走 `electron/processOutput/`（一次性 `decodeChildOutput` / 流式 `createChildStreamDecoder` / 行协议 `createLineSplitter`）？**禁止**在子进程输出路径新增 `chunk.toString('utf8')`。
3. **stderr 留档**：stderr 是否保留（原始字节 head/tail 或 meta 摘要）？不得像旧 `runCommandWithTimeout` 那样直接丢弃。
4. **artifact**：失败 / 解码可疑 / 截断时是否产出原始字节 artifact 并写明 `reason`？sha256 必须只覆盖落盘字节。
5. **日志 allowlist**：新增的 `shell.exec.*` 字段是否已登记 `electron/shell/shellLogFields.ts` 的 `ALLOWED_KEYS`（未登记 = 静默丢弃）。
6. **投影白名单**：新增字段是否已加进 `src/shared/processResultProjection.ts` 的 `PROCESS_KEYS` 与对应净化分支（未加 = 模型 / 渲染进程看不到）。
7. **兼容性**：新增结果字段一律可选（`?:`），旧日志缺字段按 `undefined` 降级；禁止重新解释 `stdoutBytes` / `stderrBytes` 的语义。
8. **测试**：是否补充**字节级 fixture** 用例（不新增二进制文件）？走到兜底 / 可疑路径的用例必须显式断言 `source` 与 `confidence`，不得只断言“文本看起来对”。

## 10. contractConflict 长期度量与后续

- `contractConflict` 按流写入 `shell.exec.finish`（字段 + 诊断行 `conflict=`），并进入工具结果 `data.decode.contractConflict`；已知例外是“OEM 契约 + 合法 UTF-8 + 非 ASCII”（见 §3 偏差 5），这类冲突是**预期内**的第三方 CLI 行为。
- 度量口径：按 profile 统计 `conflict != none` 的占比；若某 profile 长期高频冲突，按需求 §15 R3 的处置把该 profile 契约改为 `auto`（`shellProfiles.ts` 一处改动，解码器无需改动）。
- **D4 已否决（不给用户编码选项）**：编码在不同层归属不同 —— 系统 CP（老工具往管道里写什么字节）、PowerShell 自身输出（含内部报错的 UTF-16LE）、被调用工具自带编码（git / npm 多为 UTF-8）；同一命令的同一路输出可能同时混有以上来源，因此任何"用户选择一个编码"的全局配置都会解错一部分，而且用户既看不懂也无从判断。编码正确性改由应用内部三件事闭环：①契约按 spawn 点声明（`run_script` 的 UTF-8 是我们自己钉的；第三方 CLI 用 `auto`）②实际编码按字节判定一次并锁定 ③混合/不可解时标 `suspect` 并留原始字节。若将来要提高某类宿主的覆盖度，方向是调整应用的启动方式或宿主 profile（应用内部决策），不新增用户开关。
- 措辞澄清：Windows 上 profile 的契约取自注册表 `OEMCP`，语义是"按我们当前启动方式推断的先验"，不是对 native 工具输出的保证；最终以字节判定为准，冲突按 §3 偏差 5/6 处理。
- 若将来要统一到“原始字节”单一口径，需按 §9.6 约束 4 独立立项（双写 → 消费方迁移 → 删旧字段），不在本需求范围内。

## 11. 评审修复（2026-09-12，针对 `docs/review/shell-output-encoding-review.md`）

### 11.1 MAJOR（4/4 已修，均带回归用例）

| # | 问题 | 修复口径 | 回归用例 |
|---|---|---|---|
| M1 | tail 截断乱码静默放行 | 新增 `decoderFamily()` 按族对齐：UTF-8 跳续字节、UTF-16 按流内绝对偏移做 2 字节对齐、单字节编码不存在错位；**多字节非自同步编码与未知标签**在切片含非 ASCII 时标 `uncertain`（纯 ASCII 不误标）。`projectRawTextWithAlignment` 汇总为 `alignmentUncertain`，经 `OutputPipelineSnapshot` 与弱证据同权进 `buildStreamDiagnostics`，输出 `outputTrust='suspect'` + hints + rawArtifact | `electron/shell/rawTextProjection.test.ts`（12 例）、`electron/shell/outputPipeline.test.ts`、`electron/tools/runShellExecutor.test.ts`（OEM CP936 截断用例；实测 GBK 偏移 1 得到的 `形牟馐訟BC` 不再被当作真实输出交付） |
| M2 | 诊断行泄漏绝对路径 | 新增导出 `sanitizeArtifactRef()`（白名单：`none` / `artifact-<64hex>` / `artifact-redacted`）；`formatOutputDiagLine` 与 `sanitizeDiagnosticLines` 逐行把 ` rawArtifact=` 之后的值降级，绝对路径（含 OS 用户名）不再进诊断行 | `electron/processOutput/diagnostics.test.ts`、`src/shared/processResultProjection.test.ts` |
| M3 | 终端模式不显示 `outputTrust` 警告 | `ShellScrollbackView` 新增 `outputTrust` prop，终端 scrollback 分支渲染 `.shell-output__trust-warning`（role=status）；`ToolCallCard` 终端分支透传；`ShellOutputView` 在「无输出文本」与收起态也保留提示 | `ShellScrollbackView.test.tsx`、`ShellOutputView.test.tsx`、`ToolCallCard.test.tsx` |
| M4 | `decodeProgressRawTailForXterm` 的 label 是死参数 | 进度事件新增 `rawDelta` / `rawEncoding`（`toolChatLoop` 不再把 base64 当明文进度），`ToolCallRecord` 新增 `progressOutputRawLabel`；`xtermHelpers` 按 label 解码且 **label 变化强制重放**；`ShellTerminalView` 三处调用全链路传标签 | `src/shared/assistantFactAggregator.test.ts`、`src/shared/terminalScrollback.test.ts`、`ShellTerminalView.test.tsx`、`runShellExecutor.test.ts`（T13 断言 `rawEncoding`） |

### 11.2 MINOR（11 项处置）

| # | 结论 | 说明 |
|---|---|---|
| 1 | 不可复现，未改动 | Node `TextDecoder` 默认 `ignoreBOM: false`，会自行剥离 BOM：实测 utf-8 / utf-16le / utf-16 带 BOM 的全量与截断投影均不含 U+FEFF，`lock()` 的 `subarray(bomBytes)` 与最终投影一致；「最终文本以 U+FEFF 开头」在本机 Node 上不成立 |
| 2 | 已修 | 超时 kill 后改走 `decode()`，交付已收集的部分 stdout/stderr；`electron/spawnUtil.test.ts` 补真机用例 |
| 3 | 已修 | `RawByteBuffer` 暴露不拷贝的 `totalBytes` getter，`enforceOutputLimit` 不再每个 chunk 两次 `snapshotBytes()` |
| 4 | 已修 | `builtinExecutors` 的 `if (!truncated)` 只跳过 stdout 的 `end()`，stderr 尾部照常 flush；`ripgrepExecutorProcess.test.ts` 补「大输出 + 单字节 stderr」用例 |
| 5 | 已修 | 兜底解码 meta 由 `utf16-structure/medium` 改为 `fallback-latin1/low` |
| 6 | 已修 | `hresult.meaning` / `hresult.advice` / `exitCodeAdvice` 对齐 `hints` 口径，telemetry 只留 `code` / `name` |
| 7 | 已修 | `hasPlanDiagnosticMarker` 不再「见数组即放行」，`signals` 必须通过 `sanitizeCodeList` 校验且非空 |
| 8 | 接受现状 | 与本评审结论一致：`reg query` 同步读取只发生在首次创建解码器时，有进程级缓存，风险可接受 |
| 9 | 已修 | 删除 `src/renderer/theme/layout.css` 中重复的 `.shell-output__trust-warning` 定义 |
| 10 | 已修 | `electron/shell/shellLogFields.ts` 的 `ALLOWED_KEYS` 补 `outputPersistError`（此前被静默丢弃） |
| 11 | 已修 | 工作区行尾统一为 CRLF（`w/mixed` / `w/lf` 文件）并补齐缺失的末尾换行；`core.autocrlf=true`，`git diff` 内容零差异 |

### 11.3 定向验证

- `npx tsc -p tsconfig.electron.json --noEmit`、`npm run typecheck:renderer`：通过。
- 定向用例（8 个 electron + 7 个 renderer 测试文件）：**15 文件 / 171 用例全通过**（含真机 powershell 的 `runShellExecutor.test.ts`）。

## 12. 评审修复后的全量验收（2026-09-12）

- `npm test`：525 个测试文件 / 3410 个用例，**521 文件 / 3398 用例通过**（另有 3 例 skipped）；4 文件 / 9 用例失败，与 §8 Gate 3 基线**同一组**环境性失败（Windows 符号链接 `EPERM`：`extractors.test.ts`、`ripgrepPrepareSecurity.test.ts`；ripgrep staging 缺失：`ripgrepBinary.test.ts`、`afterPackRipgrep.test.ts`）。相对基线的增量为本次新增的 `rawTextProjection.test.ts` 与评审回归用例。
- `npm run build`：通过（托盘图标 + renderer + electron 全量构建）。
- `npm run typecheck:renderer` / `npm run typecheck:shared` / `npm run i18n:check`：通过。
