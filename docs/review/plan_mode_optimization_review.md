# Plan Mode 优化技术方案评审意见

> 评审日期：2026-05-25
> 评审对象：`docs/develop/plan_mode_optimization_design.md`
> 评审状态：**通过，建议优化部分细节**

---

## 一、方案整体评价

### 1.1 积极评价

| 维度 | 评价 | 说明 |
|------|------|------|
| **设计原则** | ⭐⭐⭐⭐⭐ | "最小代码增量"原则清晰，300行代码目标务实 |
| **不做什么清单** | ⭐⭐⭐⭐⭐ | 明确拒绝过度设计（如7种任务分类、上下文策展等），聚焦核心问题 |
| **向后兼容** | ⭐⭐⭐⭐⭐ | 旧格式计划通过 fallbackStep 降级处理，风险可控 |
| **安全考虑** | ⭐⭐⭐⭐ | 验证命令白名单机制合理，非白名单命令降级不阻塞 |
| **实施阶段划分** | ⭐⭐⭐⭐ | 分两阶段实施，核心功能优先，风险可控 |

### 1.2 待优化项

| 优先级 | 问题描述 | 影响 |
|--------|----------|------|
| **高** | 澄清对话状态管理不明确 | 可能导致对话循环异常 |
| **高** | Worker 验证逻辑与执行职责边界模糊 | 影响可测试性 |
| **中** | 自审规则阈值可配置性不足 | 灵活性受限 |
| **中** | 验证证据存储策略未明确 | 影响长期可维护性 |

---

## 二、详细评审意见

### 2.1 Coordinator 增强（澄清 + 方案探索）

**问题1：澄清对话状态管理缺失**

> **现状**：方案描述"澄清是 Coordinator 提示词中的行为约束"，但未明确多轮澄清对话的状态管理机制。

> **风险**：在 `runPlanningPhase` 单轮调用中，如果模型返回澄清问题而非 `plan-doc`，当前逻辑（第154-202行）无法区分是澄清对话还是计划输出。

> **建议**：
```typescript
// 在 planDocExtract.ts 中增加澄清问题标记
export type PlanDocExtractResult =
  | { kind: 'plan-doc'; content: string }
  | { kind: 'plan-abort'; content: string }
  | { kind: 'clarification-question'; content: string }  // 新增：明确的澄清问题标记
  | { kind: 'clarification-summary'; content: string }
  | { kind: 'none' }
```

**问题2：简单任务快速通道的判断标准**

> **现状**：方案提到"简单任务快速通道"，但未定义"简单任务"的判定标准。

> **建议**：在 `planPrompts.ts` 中明确简单任务判定规则，例如：
- 步骤数 ≤ 3
- 无需文件操作或命令执行
- 不涉及代码修改

---

### 2.2 步骤内容增强

**问题3：Worker 与验证逻辑职责边界**

> **现状**：方案设计 `performStepVerification` 在 `runWorkerExecution` 中执行（第308-321行），验证逻辑与 Worker 执行耦合。

> **风险**：验证失败时直接标记步骤失败（第318行），可能导致计划中断，缺乏人工介入机制。

> **建议**：
```typescript
// 验证失败不直接标记失败，而是记录证据并给出警告
const stepResult: PlanStepResult = {
  stepIndex,
  status: evidence.passed ? 'completed' : 'warning',  // 改为 warning 而非 failed
  summary,
  filesModified: [],
  evidence
}
```

---

### 2.3 执行后验证

**问题4：验证命令白名单的可扩展性**

> **现状**：`isSafeVerificationCommand` 硬编码白名单模式（第404-417行）。

> **建议**：将白名单配置化，支持用户自定义安全命令模式。

**问题5：file_check 类型的检查项未定义**

> **现状**：`PlanStepVerification` 中 `file_check` 的 `checks` 字段未定义具体格式。

> **建议**：明确检查项格式，例如：
```typescript
type FileCheckType = 
  | { type: 'exists' }
  | { type: 'contains'; pattern: string }
  | { type: 'size_min'; bytes: number }
  | { type: 'modified_recent'; minutes: number }

export type PlanStepVerification =
  | { kind: 'command'; command: string; expectedOutput: string }
  | { kind: 'file_check'; expectedFiles: string[]; checks: FileCheckType[] }  // 明确类型
  | { kind: 'self_report'; questions: string[] }
```

---

### 2.4 计划自审增强

**问题6：歧义检查规则的可配置性**

> **现状**：`checkAmbiguity` 中的 `AMBIGUOUS_PATTERNS` 硬编码（第479-483行）。

> **建议**：考虑将歧义模式配置化，便于根据用户反馈调整规则。

**问题7：自审结果的用户反馈机制**

> **现状**：方案仅描述自审结果展示，未提及用户对自审警告的反馈机制。

> **建议**：在审批卡片中支持用户标记"已知风险"，避免重复警告。

---

### 2.5 架构与可维护性

**问题8：证据存储策略**

> **现状**：`PlanStepEvidence` 的 `details` 字段为字符串类型，未定义存储上限和清理策略。

> **建议**：
- 定义 `details` 最大长度（如 2000 字符）
- 考虑定期清理历史证据（如计划完成后保留30天）

**问题9：类型定义位置**

> **现状**：`PlanStepDetail` 等类型定义在 `src/shared/planTypes.ts`。

> **建议**：保持现有位置，但注意与 `electron/plan/` 目录的类型同步。

---

## 三、代码实现建议

### 3.1 关键代码优化建议

**优化1：`extractEnhancedSteps` 的健壮性**

当前方案中的正则表达式（第223行）可能存在边缘情况：

```typescript
// 原方案
const parts = section.split(/(?:^|\n)(?:\*\*)?\s*步骤\s*(\d+)[：:]\s*(.+?)(?:\*\*)?(?:\n|$)/)

// 建议优化：增加对嵌套列表的处理
const stepRegex = /(?:^|\n)\*\*\s*步骤\s*(\d+)[：:]\s*([^*]+?)\*\*(?=\n|$)/gm
```

**优化2：验证执行的错误处理**

当前方案中 `performStepVerification` 的错误处理较为简单（第361-369行），建议增加重试机制：

```typescript
case 'command': {
  if (!isSafeVerificationCommand(v.command)) {
    return { /* 降级处理 */ }
  }
  // 建议：最多重试1次
  for (let retry = 0; retry < 2; retry++) {
    try {
      const output = await execCommand(v.command, args.workDir, { timeout: 30000 })
      const passed = output.includes(v.expectedOutput)
      return { stepIndex: args.stepIndex, verificationMethod: v, passed, details: output.slice(0, 500), timestamp: Date.now() }
    } catch (err) {
      if (retry === 0) continue
      return { stepIndex: args.stepIndex, verificationMethod: v, passed: false, details: `命令执行失败: ${err}`, timestamp: Date.now() }
    }
  }
}
```

---

## 四、测试建议

### 4.1 单元测试覆盖

| 测试场景 | 测试方法 | 预期结果 |
|----------|----------|----------|
| 简单任务快速通道 | 输入"写一封邮件" | 跳过澄清直接出计划 |
| 复杂任务澄清 | 输入"帮我优化一下" | 触发澄清提问 |
| 旧格式计划兼容 | 使用纯文本步骤计划 | 降级为 self_report 验证 |
| 验证命令白名单 | 执行 `npm test` | 自动验证 |
| 非白名单命令 | 执行 `rm -rf /` | 降级为 self_report |
| 自审一致性检查 | frontmatter 与实际步骤数不一致 | 生成警告 |
| 歧义检查 | 计划包含"适当优化" | 生成歧义警告 |

### 4.2 集成测试覆盖

- Coordinator 生成增强格式计划的端到端流程
- Worker 执行步骤并生成验证证据
- 自审结果展示在审批卡片

---

## 五、结论

### 5.1 总体评估

**方案可行性**：✅ 高
- 核心思路清晰，符合"最小增量"原则
- 向后兼容机制完善
- 安全考虑充分

**实施风险**：✅ 可控
- 澄清对话状态管理需补充设计
- Worker 验证失败处理需优化

**建议**：方案整体通过，建议针对上述问题补充细节后进入实施阶段。

### 5.2 优先级排序

| 优先级 | 改进项 | 理由 |
|--------|--------|------|
| P0 | 澄清对话状态管理 | 影响核心流程稳定性 |
| P0 | Worker 验证失败处理 | 避免计划意外中断 |
| P1 | 验证命令白名单配置化 | 提升灵活性 |
| P1 | 证据存储策略 | 影响长期可维护性 |
| P2 | 自审规则配置化 | 用户体验优化 |

---

*评审结束*