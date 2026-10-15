# 云端 main 功能恢复提交逐提交对照审计

日期：2026-10-01  
审计对象：来源云端 tip `8dad0284`（`8dad02848c44692bafa7f61271bc6e3d6f406216`，merge `5debe791` 第二父）相对共同基线 `4e3d44f` 的恢复范围，与当前恢复提交 `59a5d2e2` 及当前工作区实现。  
审计方式：根据恢复计划的 Git 范围逐个枚举 `2c2611c6..8dad0284` 的 46 个云端提交，核对完整 SHA、父提交、主题和首父文件变更；对功能提交进一步比较云端最终树、当前 `main` 和当前恢复改动。提交清单与每项归属见[来源提交台账](./2026-10-01-cloud-main-recovery-source-commit-ledger.tsv)。云端 tip 相对共同基线有 516 个文件名差异，其中包括大量文档删除和架构维护；本轮对计划涉及的安全、usage、grep 功能组做语义核对，不把无关的 516 项树差异冒充为全部逐行审计。

完整的 516 条路径底表见[逐路径审计清单](./2026-10-01-cloud-main-516-path-audit.tsv)。其中 111 项对应前序已审计功能组（脚本安全 58、用量归因 30、grep 16、取消/日志 7）；另外 405 项此前只被旧范围清单归为“排除/架构与文档”，**尚未逐项完成语义核对**。因此本文结论只覆盖恢复计划功能组，不代表 516 项全量审查完成。

## 结论

发现并修复 7 项安全/功能遗漏；另按用户要求恢复 2 项云端策略语义，均有回归测试覆盖：

1. grep fallback 原先重新按获准路径读取内容，许可取得后若路径被替换为指向工作区外的符号链接，可能扫描未获准文件。fallback 现在读取读取许可持有的稳定文件句柄，并在读取前后核对文件身份/状态。另修正三个 fallback 分支未等待异步扫描、导致 `finally` 提前关闭句柄的问题。
2. 脚本会话信任原先只绑定脚本 SHA-256 和会话 ID。同一会话切换工作目录后，完全相同且含相对文件访问的脚本可能作用于不同目标并沿用旧许可。缓存键现同时绑定规范化工作目录的 SHA-256；旧格式记忆不会匹配，新目录会要求再次确认。明文路径不进入信任键。

3. grep fallback 遇到许可目标路径消失时，可能把“无法读取获准目标”当作普通无匹配。现在 fallback 结束时同时核对当前路径身份和许可文件句柄身份，不存在或不一致即丢弃结果并返回可审计的身份变化错误。
4. 云端 grep fallback 会报告大文件跳过、读取失败和总时限导致的部分结果；恢复版曾静默略过或把超时当作整次失败。现在边界摘要会明确告知用户结果不完整，并对这些情况保留已有匹配输出。
5. 云端脚本路径恢复包括多轮评审修正的 IR/分析器绑定语义；当前基线删掉了 `named_expr` 绑定目标、推导式过滤条件、字典推导式 key、decode/global 跨块追踪等实现，来源测试从 801 行缩减为 89 行。将云端 92 项 extractor 回归直接对照当前实现时 46 项失败。现已恢复云端 extractor、IR adapter/types 与内容安全分析修复，相关 92 项来源用例全部通过。
6. 云端 `e9d58480` 在 `predev` 阶段准备当前平台 ripgrep，准备失败只警告、不阻塞开发启动；当前只有打包准备。现已按测试先红后绿恢复 dev 前置准备与 `predev` 接线。
7. 云端 P2 把路径分析不完整时的具体调用名/动态执行原因展示在审批摘要和脚本确认卡；此前当前 Hosted 事实投影链路丢失了该提示。现已恢复提示生成、SDK 确认上下文传递、回合事实投影和确认卡展示，并覆盖策略门、事实聚合和 React 组件测试。声明范围交叉校验信号也已恢复。

## 已按云端语义补齐的策略

- desktop loose 档现按云端 `ruleActionOverrides` 语义自动放行 `script-unmodeled-path-ask`；仅限桌面 loose。动态执行、可疑脚本、敏感路径等更高优先级/locked 规则仍会阻断该放行。
- 云端通过 `scriptPathHint` 把未建模调用名或动态执行原因放入审批摘要和确认卡；该提示链路现已恢复。声明范围一致性信号也已恢复。
- 声明式自动放行现按云端 `allowDeclaredPathScopeScripts` 配置门控实现：默认关闭；仅桌面脚本声明 `workdir-readonly` 且交叉校验一致时允许放行；可疑内容、网络行为、敏感范围或路径探测失败均不满足一致性。和云端相同，该开关目前没有设置界面，默认配置下不会触发。

其余已对照的安全边界包括 policy floor/locked 规则、动态/未分类脚本记忆资格、敏感路径缓存排除、ripgrep unavailable 的降级原因矩阵、取消/超时/真实错误终态、usage 精确事实与估算分离、多模态未知量不伪归因，以及版本分组和查询筛选。对这些对应实现和测试的核对未发现其他需阻断恢复的差异。

## 修复与验证证据

- grep 路径替换测试：模拟许可打开文件后将路径换成外部符号链接，断言 fallback 返回许可句柄内容且不泄漏外部文件内容。
- grep 获准路径消失测试：fallback 开始前移走获准文件，断言返回身份变化错误而非成功的“无匹配”。
- grep 边界结果：覆盖大文件、读取失败和总时限；不完整结果带摘要而非伪装为完整无匹配。
- grep 生命周期：不可用、unsupported spawn 与 `grepWithRg` unavailable 三处分支均等待 fallback 完成后再关闭许可句柄。
- 脚本信任：增加跨工作目录同脚本再次确认断言；策略层要求 workdir 摘要合法才派生记忆键；IPC 装配拒绝缺少摘要的旧/不完整键。
- 来源 Python 路径事实测试、`scriptContentSecurity`、IR adapter、`toolCallGate`、policy/floor、dev ripgrep、fallback、scope 和 Hosted read 集成共 15 个测试文件、456 项通过。
- 单独的脚本信任 cache/gate/runtime 装配回归 214 项通过；来源台账中相关文档/合并提交也逐项标注。
- `typecheck:shared`、`typecheck:renderer`、`typecheck:agent-sdk` 本轮通过；`git diff --check` 通过。确认提示新增的 5 个测试文件共 211 项通过。
- 仓库没有 `typecheck:electron` 命令；Electron 相关改动由聚焦 Vitest、运行时集成用例覆盖。

## 范围和限制

阶段 8 已在本轮按计划顺序重新完成：四组回归、类型与 SDK 边界检查、严格 i18n、全量测试、build、pack:mac。macOS x64/arm64 DMG CRC 均有效，签名、应用架构、ripgrep 哈希/许可及双语用量资源均已核对。完整验收数字见下方逐项进度更新。审计仍不替代一般代码质量评审。

## 516 路径逐项语义核对进度

用户要求把原先未逐项核对的 405 项逐项做语义对照，并以 TDD 修复实际问题。现已完成 405/405 项核对，逐条结论均写入[逐路径审计清单](./2026-10-01-cloud-main-516-path-audit.tsv)；前序 111 项也已按当前工作树复核。检查范围包括源文件对应的云端差异、当前 Hosted SDK/安全边界和相关测试，不用目录级结论代替单路径记录。

本轮完成 renderer/shared 的最后 45 项，并复核前序安全、usage、grep、取消/日志 110 项。定向回归结果：renderer/shared 19 个文件、310 项通过；安全/策略及 Usage 93 个文件、1167 项通过；grep/取消/日志 71 个文件、671 项通过。最终全量 `npm test` 通过 819 个文件、跳过 1 个文件；7294 项通过、106 项跳过（共 7400）。

此次已完成的核对还发现并修复：云端 Anthropic 请求事实会记录缓存断点位置；当前 pi-ai provider 实际发送 system 与末尾 user/tool-result 缓存标记，但 Hosted `request_header` 曾未记录断点。已先添加失败断言并确认红灯，再补充断点计算和 observer 接线，同时覆盖禁用缓存、同窗口断点继承以及真实 wire 请求体。`npx vitest run electron/runtime/agentSdkDesktopObserver.test.ts src/shared/requestContext.test.ts packages/agent-provider-pi-ai/test/anthropicAdapter.test.ts` 通过（3 文件、58 项）；`npm run typecheck:shared` 通过。

全 Electron 类型编译额外暴露出与本次缓存投影无关的工作区问题（`toolCallGate.ts` 重复字段/窄化类型，以及 `builtinExecutors.ts` 文件句柄可空）。这些类型错误随后已按编译失败先红后绿修复：路径事实 fallback 补齐动态执行原因与证据数组、删除重复提示字段，并收紧 grep 注入 stat 的文件类型契约。`npx tsc -p tsconfig.electron.json --noEmit` 通过；`toolCallGate` 与 grep fallback 定向测试 158 项通过。之后将云端 `grepUnavailableMessage.test.ts` 恢复到当前树，原9项全红；按原因和平台修正文案后，grep/安全集成测试 58 项通过。另将 fallback 单文件扫描上限从1 MiB恢复到云端2 MiB：1.5 MiB用例先红后绿，超限仍带部分结果摘要。Electron IPC/Capability/Butler/Hosted 主流程的定向安全回归 14 文件、261 项通过。另在前序 grep/取消/日志复核中，发现 `ripgrepExecutorProcess.test.ts` 仍断言旧版“手工准备”文案，与已接入的 dev 自动准备提示不一致；先复现失败，再将测试改为校验准备命令、自动准备说明及无敏感路径，单文件 7 项通过，grep/取消/日志回归随后 71 文件、671 项通过。阶段 8 复跑期间还发现 arm64 Electron 框架签名错误及双架构同时打包的磁盘峰值问题：签名前显式清理扩展属性、先签 Electron Framework 并等待系统元数据稳定，失败时重试一次；mac 打包改为先 x64、删掉临时 x64 app 后再打 arm64。签名次序/重试与打包顺序新增测试先红后绿。
