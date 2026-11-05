# 阶段 2 关闭证据

## 关闭范围

- 基线：阶段 1c 收口提交 `c388309b`。
- 阶段 2 最终实现及登记提交：`fbfc20c3`、`f42d6fa0`；F30～F37 的逐任务实现、测试与证据提交共 17 个，连同上述两项阶段内修正/登记合计 19 个提交。
- 精确变更文件：131 个唯一文件，按 `git diff --name-only c388309b f42d6fa0` 生成，完整清单见 [`phase-2-files.md`](phase-2-files.md)。
- 依赖闭包：F30 依赖 F04/F12/F23；F31～F37 按计划顺序依赖前序任务，F36 同时依赖已关闭的 F12/F23 与已验证的 F35；本阶段作为单一回退单位，不拆开 findings、路径事实、策略规则和消费者迁移。
- 覆盖证据：F30 的 12 类生产样本；F31 记忆资格；F32 旧字段生产/消费盘点；F33 路径类别；F34/F35 token、规则与 D-5 行为；F36 原子退役旧模型；F37 真实 extractor→rule assembly→engine 矩阵。各项细节见同目录 F30～F37 证据。

## 阶段提交

| 任务/用途 | 提交 |
|---|---|
| F30 生产发现类别 | `b89d24773921`，`61e0a1f8916e` |
| F31 记忆资格迁移 | `299f334582fa`，`5fecb494b0b7` |
| F32 兼容边界与旧字段盘点 | `f7838e9f1068`，`25fbf1df69b0` |
| 类型对齐修正 | `f140a9e840f9` |
| F33 路径事实分类 | `361d10718d23`，`58c11de21cdf` |
| F34 类别映射与 token | `0adf937844d3`，`7f328ed6eef8` |
| F35 替代规则与 D-5 floor | `bbe3a3fee5d0`，`fd50f6c00a09` |
| F36 原子切换与证据 | `3a110da94171`，`db88f1b0e781` |
| F37 真实链路矩阵与证据 | `842b15ea5b7f`，`aee27eff3289` |
| F38 发现并修正 path token 类别混淆 | `fbfc20c3700a` |
| 新增 locked floor 登记 | `f42d6fa0656c` |

## 验证结果

- 合并阶段回归：24 files / 1043 tests passed（脚本分析、提取、gate、策略、IM 延迟审批和记忆资格）。
- `npm run typecheck:shared`：通过。
- `npm run build:electron:incremental`：通过，包含其运行时闭包与 session-storage 边界门禁。
- `npm run check:system-invariant-registry`：通过，12 registrations / 42 test references；本阶段未新增 system invariant。
- `git diff --check`：通过。
- `npm test`：1259 files passed / 1 skipped；12274 tests passed / 140 skipped。
- 全量测试发现的 path token 混淆已先以 RED 用例复现，再修复：有明确 `dynamicKinds` 时，只有 `dynamic-code-execution` 产生动态执行 token；无类别的旧兼容形状仍按 `unknownReason` 保守派生。其他明确非写入路径类别通过 `script-non-write-path-confirm` 保持锁定真人确认；纯 unresolved write 仍走独立 D-5 review；network candidate 和真实系统路径继续由各自规则处理。新增 rule ID 已加入 locked floor inventory 并由契约测试覆盖。

## 回退实体、顺序与隔离 smoke

- 回退实体：本阶段从 `c388309b` 后开始的 19 个提交整体撤销。回退顺序为：`f42d6fa0` → `fbfc20c3` → `aee27eff` → `842b15ea` → `db88f1b0` → `3a110da9` → `fd50f6c0` → `bbe3a3fe` → `7f328ed6` → `0adf9378` → `58c11de2` → `361d1071` → `f140a9e8` → `25fbf1df` → `f7838e9f` → `5fecb494` → `299f3345` → `61e0a1f8` → `b89d2477`。
- 在隔离 detached worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/script-finding-model-phase2-revert-smoke` 逐提交执行 `git revert --no-edit`。最终回退提交为 `0df7101b37c8`；回退后 `git diff --exit-code c388309b HEAD` 通过，代码树与阶段 1c 基线一致，工作树干净。
- 回退后运行：

  ```text
  npm exec -- vitest run electron/shell/scriptContentSecurity.test.ts electron/confirmation/extractors/extractors.test.ts electron/confirmation/toolCallGate.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/memoryEligibility.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts --reporter=dot
  ```

  结果：6 files / 471 tests passed；旧 script-analysis 路径和阶段 1c 策略消费者可用。隔离 worktree 随后移除。

阶段 2 回退顺序与范围已核实；F38 完成后，阶段 3 的独立审计增量仍可单独回退，历史审计数据不在本阶段回退范围内。
