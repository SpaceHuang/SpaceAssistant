# Codex 审批缓存：SpaceAssistant 可借鉴的做法

> 核查日期：2026-10-29。Codex 源码 `/Volumes/MacHub/Hub-Develop/codex`，提交 `c0e88f3c04`；SpaceAssistant 基线 `990d1e2e` 加工作区改动。本文基于静态源码核查，未运行 Codex 或测量延迟。关联方案：[工具调用安全审核性能调研与优化方案](./工具调用安全审核性能调研.md)。

## 结论【人必读】

Codex 中有几项适合用于完善我们的方案：**文件按目标路径分别识别、批量操作检查所有目标、批准范围明确、命中条件包含影响执行的环境信息、复用审核会话降低未命中时的开销。**

这些做法可与已确定的“同工具、同操作、同对象、会话级”方案结合。Codex 的文件缓存是用户选择的会话级记忆，并非安全审核 Agent 的缓存；下文只借鉴其可核查的机制，不把它当成现有方案的直接实现。

## 可以借鉴的做法【人机共读】

### 1. 文件审批按文件对象识别

Codex 的 `ApprovalAction::cache_keys` 对 `apply_patch` 中的每个文件构造 `environment_id + path`，不把 patch 内容放进文件缓存键（`codex-rs/core/src/tools/approvals.rs`、`tools/runtimes/apply_patch.rs`）。其 `ApprovedForSession` 表示用户明确批准在当前会话记忆，不能等同于单次批准。

**应用到本项目**：保持 `edit_file + 编辑 + 文件 A` 与文件内容分离，同一授权范围内修改 A 的不同文字可以复用；修改 B、用 `write_file` 覆盖 A 或用 Shell 操作 A 都是不同键。按现有方案，脚本、可执行程序及固定 CI 配置清单不消费写入缓存。用户确认和 Agent 结论分别记录来源，不能把 Agent 判断写成用户批准。

### 2. 多目标调用必须覆盖全部目标

Codex 的 `with_cached_approval` 要求本次所有 key 都命中才跳过询问；`apply_patch` 为每个目标建键，测试包含移动目标（`tools/sandboxing.rs`、`tools/handlers/apply_patch_tests.rs`）。

**应用到本项目**：提取调用的全部目标，包括移动的源与目的地。一个目标缺失、不同或无法识别，整个调用不使用缓存，进入当前策略。现有方案要求一条范围批准覆盖完整对象集合；Codex 可以组合多条单文件记忆，我们不改变这一既定约束。

### 3. 命令按完整操作和环境区分

Codex 的命令审批键包含规范化后的命令参数、执行环境和工作目录（`tools/runtimes/unified_exec.rs`、`tools/approvals.rs`）。`command_canonicalization.rs` 仅在能解析出单个普通命令时消除 shell 包装差异；复杂脚本保留精确内容。

**应用到本项目**：`run_shell` 不能只以工具名或程序名作为键；命令、参数、工作目录，以及会改变执行目标和副作用的输入都要参与匹配。只对经过测试证明等价的包装做归一化；复杂或无法分析的命令使用精确材料匹配，事实无法核验则回退现有审核。不要因批准一次读取命令就批准删除命令。

### 4. 审核范围与单次批准分开

Codex 的通用会话记忆只保存明确的 `ApprovedForSession`；普通单次 `Approved` 不会被这个缓存写入（`tools/sandboxing.rs`）。

**应用到本项目**：首次审核结果需要明确说明是否批准复用宿主给定的工具、操作和对象范围。Agent 的单次通过没有范围信息时，只批准本次调用；不能自动产生会话级记录。宿主核对范围摘要、审批主体和当前策略后再保存；后续还要核对当前任务的限制和授权代次。

### 5. 审核未命中时复用审核会话

Codex 的同步 Guardian 审核会复用只读审核会话；空闲时续用同一会话和提示词缓存标识，并发时使用独立分支，审核配置变化时重建（`codex-rs/core/src/guardian/review.rs`）。

**应用到本项目**：当前 `runApprovalAgent` 每次创建隐藏内部会话，可以研究让同一外层会话内的审核复用受限审核会话，并仅追加新的审核材料。每次仍要请求模型并独立裁决；策略、模型、授权或任务证据变化时重建或更新审核上下文。并发审核不能相互覆盖，取消和迟到结果不能放行。该优化是否有效取决于模型服务和实际运行，需测审核等待及 token 用量，不能计为审批结果缓存命中。

### 6. 分别统计缓存命中与重新审核

Codex 在申请人工审批时记录工具及结果（`tools/sandboxing.rs`）。这提示我们需要明确区分不同路径，才能验证改动是否真正减少等待。

**应用到本项目**：按工具和链路记录缓存命中、对象不匹配、任务约束不满足、过期、策略或授权变化、不可识别而回退，以及实际 Agent 审核的次数和耗时。一个指令回合应能还原首次与后续调用的审核次数及等待；不记录文件正文、消息或密钥，也不要将审核会话复用误记为审批缓存命中。

## 验收重点【机｜人工可跳过】

- `edit_file` 修改 A 后再修改 A 的不同文字，在范围和当前任务均允许时命中；修改 B 或使用其他工具不命中。
- 多目标操作任一目标未获覆盖时不命中；移动同时核查源和目标。
- Shell 的参数、目标或工作目录改变后不沿用原批准；规范化前后通过等价和反例测试。
- 单次批准不写范围缓存；明确范围批准后，在同一会话内符合当前任务约束才命中；撤销、策略变化、会话删除及进程重启按既有方案验证。
- 审核会话复用时，对不同任务、策略变化、并发、取消、迟到结果和不可信材料注入进行边界测试；测量首次与后续审核实际延迟。

## 复核入口【机｜人工可跳过】

在 Codex 源码根目录：

```bash
rg -n 'with_cached_approval|ApprovedForSession|struct ApprovalStore' codex-rs/core/src/tools/sandboxing.rs
rg -n 'fn cache_keys|ApplyPatchApprovalKey|UnifiedExecApprovalKey' codex-rs/core/src/tools/approvals.rs
rg -n 'struct ApplyPatchApprovalKey|environment_id|path:' codex-rs/core/src/tools/runtimes/apply_patch.rs
rg -n 'approval_keys_include_move_destination' codex-rs/core/src/tools/handlers/apply_patch_tests.rs
rg -n 'canonicalize_command_for_approval|CANONICAL_' codex-rs/core/src/command_canonicalization.rs
rg -n 'cached trunk session|prompt-cache key|ephemeral fork' codex-rs/core/src/guardian/review.rs
```
