# SpaceAssistant Plan 模式 vs Superpowers 技能：目标理解与任务拆解方案对比分析

> **状态：已废弃 — 见 [remove-plan-mode-requirement.md](../requirement/remove-plan-mode-requirement.md)**

| 字段 | 内容 |
|------|------|
| 文档版本 | v1.0 |
| 状态 | 完成 |
| 分析日期 | 2026-05-25 |
| 分析范围 | 当前项目 Plan 模式实现 vs Superpowers 技能集在"理解目标→拆解任务"方案上的差异 |

---

## 1. 对比框架

本报告从**目标理解**和**任务拆解**两个核心维度，对比 SpaceAssistant 当前 Plan 模式实现（`electron/plan/`）与 Superpowers 技能集（`brainstorming → writing-plans → executing-plans → subagent-driven-development`）的方案差异。

### 1.1 两套方案的核心流程对比

| 阶段 | SpaceAssistant Plan 模式 | Superpowers 技能集 |
|------|--------------------------|---------------------|
| 需求理解 | 用户输入 → 单次 AI 调用生成计划 | brainstorming: 多轮对话探索 → 设计方案 → 用户审批 |
| 方案设计 | 嵌入在计划文档的「推荐方案」章节 | brainstorming: 提出 2-3 个方案及权衡 → 渐进验证 |
| 任务拆解 | AI 自主决定步骤粒度，写入 `- [ ]` 列表 | writing-plans: 严格的 2-5 分钟/步，含完整代码和命令 |
| 执行策略 | 单 Worker 顺序执行 | subagent-driven: 独立子代理 + 两阶段审查 |
| 验证机制 | 无强制验证 | verification-before-completion: 铁律——无证据不宣称 |

---

## 2. 目标理解阶段的不足

### 2.1 缺乏多轮澄清对话机制

**当前实现**：`electron/plan/planPrompts.ts` 中的 Coordinator 系统提示直接要求 AI「使用只读工具了解上下文」后输出计划。用户提交需求后，AI 一次性完成探索和计划生成，没有中间对话环节。

```typescript
// planPrompts.ts — Coordinator 角色的全部指令
const PLAN_COORDINATOR_RULES = [
  '【角色】你是 SpaceAssistant Plan Mode 的计划协调员（Planner）...',
  '你的唯一交付物是一份可审批的实施计划...',
  '【探索（必须先做）】在输出计划之前，必须使用只读工具了解上下文...',
  '【输出格式（强制）】完整计划 Markdown 只能放在一对标签内：<plan-doc>…</plan-doc>',
  // ...
].join('\n')
```

**Superpowers 方案**：`brainstorming` 技能定义了严格的 9 步流程，其中第 3 步专门用于「一次一个问题」地澄清用户意图：

```
1. Explore project context
2. Offer visual companion (if applicable)
3. Ask clarifying questions — one at a time, understand purpose/constraints/success criteria
4. Propose 2-3 approaches — with trade-offs and your recommendation
5. Present design — in sections, get user approval after each section
6. Write design doc
7. Spec self-review
8. User reviews written spec
9. Transition to implementation
```

**差距**：当前项目缺少「理解需求」的独立阶段。用户说一句话，AI 就直接出计划——没有追问"你这样做是为了解决什么问题？""成功标准是什么？""有哪些约束条件？"这会导致 AI 基于不完整或错误的理解生成计划，增加后续返工成本。

**影响**：Superpowers 的 brainstorming 要求「一次一个问题」（"One question at a time"），防止 AI 一口气问太多问题让用户不知所措。这是经过验证的交互设计模式，当前项目没有采用。

### 2.2 缺乏多方案探索与对比

**当前实现**：计划模板中只有一个「## 3. 推荐方案」章节，AI 被要求直接给出首选方案。不要求探索替代方案或对比权衡。

```markdown
## 3. 推荐方案
<首选方案与理由>
```

**Superpowers 方案**：brainstorming 技能明确要求：

> Propose 2-3 different approaches with trade-offs
> Present options conversationally with your recommendation and reasoning
> Lead with your recommended option and explain why

**差距**：缺少方案对比会让用户失去知情决策的机会。用户只能"批准"或"拒绝"AI 单一方案，无法在多个可行路径中选择最符合其偏好的那一个。

**影响**：用户可能在审批时没有意识到存在更好的替代方案，直到执行过程中才发现问题。

### 2.3 缺乏设计方案与实施计划的分离

**当前实现**：一份计划文档同时包含「目标」「背景」「方案」「执行步骤」「验收标准」。设计方案和执行计划混在同一个文档中。

**Superpowers 方案**：明确分为两个独立阶段和产出物：
- **brainstorming** → `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`（设计规格）
- **writing-plans** → `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`（实施计划）

两个阶段各有独立的审批闸门和自审流程。

**差距**：混合文档导致职责不清。在设计方案尚未充分验证时就讨论执行细节，可能浪费精力。Superpowers 的分层保证了"先确认做什么，再讨论怎么做"。

### 2.4 缺乏设计规格自审机制

**当前实现**：计划解析器 `planParser.ts` 中的 `buildPlanApprovalSummary` 函数仅检查三个关键字段是否含 TODO/TBD 占位符：

```typescript
// planParser.ts - 仅检查占位符
const PLACEHOLDER_RE = /\b(TODO|TBD|待确认|待补充)\b/i
if (hasPlaceholder(goal)) placeholderWarnings.push('「目标」含占位符')
if (hasPlaceholder(solution)) placeholderWarnings.push('「推荐方案」含占位符')
if (parsed.steps.some((s) => hasPlaceholder(s))) placeholderWarnings.push('「执行步骤」含占位符')
```

**Superpowers 方案**：brainstorming 的 Spec Self-Review 包含四项检查：

1. **Placeholder scan**：扫描 TBD/TODO/不完整章节
2. **Internal consistency**：检查架构是否与功能描述一致，是否有矛盾
3. **Scope check**：是否过于庞大需要分解
4. **Ambiguity check**：是否有可被两种方式解读的需求

**差距**：当前项目只有占位符检查，缺少一致性检查、范围检查和歧义检查。例如，一个计划可能步骤 3 依赖步骤 1 创建的文件，但步骤 1 的描述与此不一致——当前方案无法检测此类问题。

---

## 3. 任务拆解阶段的不足

### 3.1 步骤粒度没有强制标准

**当前实现**：计划模板中执行步骤是自由文本的 checkbox 列表：

```markdown
## 4. 执行步骤
- [ ] <步骤 1>
- [ ] <步骤 2>
```

`planParser.ts` 中解析步骤时仅提取文本内容，不做粒度验证：

```typescript
function extractCheckboxSteps(body: string): string[] {
  const section = extractSection(body, '4. 执行步骤')
  // ... 逐行匹配 - [ ] 或 - [x] 或 - [X]
  for (const line of lines) {
    const m = /^-\s*\[[ xX]\]\s*(.+)$/.exec(line.trim())
    if (m) steps.push(m[1]!.trim())
  }
  return steps
}
```

**Superpowers 方案**：writing-plans 技能规定了严格的粒度标准：

```
Each step is one action (2-5 minutes):
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step
```

一个 TDD 周期（写测试→验证失败→实现→验证通过→提交）被拆成 5 个独立步骤。

**差距**：当前项目的步骤粒度由 AI 自行决定，可能出现"实现取消业务逻辑"这样需要 30 分钟的模糊步骤，也可能出现过于细碎的无意义拆分。缺乏标准导致执行质量不可控。

**影响**：模糊的大步骤在执行时 AI 容易偏离方向，因为步骤本身没有提供足够的约束和指导。

### 3.2 步骤缺乏完整的具体内容（No Placeholders 原则）

**当前实现**：步骤仅为一行文本描述。Worker 执行时的系统提示也只是简单传递步骤文本：

```typescript
// planPrompts.ts — Worker 系统提示
export function buildPlanWorkerSystemPrompt(args: {
  planTitle: string; stepIndex: number; stepsTotal: number; stepText: string
}): string {
  return [
    '你处于 SpaceAssistant Plan Mode 执行期（Worker）。',
    `计划：${args.planTitle}`,
    `当前步骤 ${args.stepIndex + 1}/${args.stepsTotal}：${args.stepText}`,
    '仅完成当前步骤；完成后用简短中文总结结果。若被阻塞且无法恢复，说明阻塞原因。'
  ].join('\n')
}
```

Worker 只知道步骤文本，不知道具体要修改哪个文件的哪些行、要运行什么命令、预期输出是什么。

**Superpowers 方案**：writing-plans 的每个 Task 包含：

```markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**
```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**
```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```

每个步骤都包含：精确文件路径、完整代码、精确命令和预期输出。

**差距**：这是两套方案最显著的差异之一。当前项目的计划步骤是"描述性的"（告诉 Worker 做什么），Superpowers 的计划步骤是"规定性的"（告诉 Worker 具体怎么做）。后者大幅减少了执行过程中的猜测和偏差。

Superpowers 明确将这些列为**计划失败**（plan failures）：
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (必须重复完整代码)
- 引用未在任何 Task 中定义的类型/函数/方法

### 3.3 缺乏 TDD 内置流程

**当前实现**：执行步骤没有强制要求 TDD 流程。Worker 可以自由选择实现方式。

**Superpowers 方案**：TDD 内置在 writing-plans 和 subagent-driven-development 的核心流程中：
- writing-plans 的步骤模板就是 TDD 循环：红→绿→重构→提交
- subagent-driven-development 要求子代理使用 `superpowers:test-driven-development` 技能

**差距**：没有 TDD 约束意味着 AI 可能跳过测试、先写大量实现代码再补测试（或干脆不写）。这降低了代码质量和可维护性。

### 3.4 缺乏执行计划的文件结构映射

**当前实现**：计划中的「## 5. 关键要素」章节仅列出涉及文件和不修改的范围，但没有解释每个文件承担什么职责：

```markdown
## 5. 关键要素
- 涉及文件：<路径列表>
- 不修改：<范围说明>
```

**Superpowers 方案**：writing-plans 要求在执行任务定义之前先做文件结构映射：

> Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

**差距**：如果没有先确定文件职责划分，后续的任务拆解可能随意跨文件分配、缺乏内聚性。

### 3.5 缺乏任务级自审机制

**当前实现**：没有对生成的计划进行系统性自审的流程。

**Superpowers 方案**：writing-plans 包含三项自审：

1. **Spec coverage**：逐条对照设计规格，确保每个需求都有对应任务
2. **Placeholder scan**：全文搜索占位符模式
3. **Type consistency**：检查跨任务的类型、签名、属性名是否一致（如 Task 3 中叫 `clearLayers()` 但 Task 7 中叫 `clearFullLayers()`）

**差距**：缺少跨任务一致性检查意味着大型计划中的接口不一致问题要到执行时才会暴露。

---

## 4. 执行阶段的不足

### 4.1 缺乏逐任务审查机制

**当前实现**：Worker 顺序执行每个步骤，执行完成后仅记录结果摘要（`PlanStepResult`），没有独立审查环节：

```typescript
// planOrchestrator.ts - 步骤完成后直接推进
const summary = extractTextFromContent(res.content).slice(0, 500) || '步骤已完成'
let metadata = appendStepResult(session.metadata, {
  stepIndex,
  status: 'completed',
  summary,
  filesModified: []
})
const nextIndex = stepIndex + 1
metadata = advancePlanStep(metadata, nextIndex)
```

**Superpowers 方案**：subagent-driven-development 的每个 Task 经过两阶段审查：

1. **规范合规审查**（Spec Compliance Review）：代码是否符合设计规格？有没有多做或少做？
2. **代码质量审查**（Code Quality Review）：代码质量是否达标？

审查未通过 → 修复 → 重新审查，循环直到通过。

**差距**：当前项目没有独立审查环节，Worker 的执行结果没有经过验证就直接标记为完成。错误只能在后续步骤或最终验收时被发现，返工成本更高。

### 4.2 缺乏子代理上下文隔离

**当前实现**：Worker 执行的 `runWorkerExecution` 使用的是同一个 session 和消息上下文：

```typescript
const res = await runToolChatSession({
  sender: args.sender,
  requestId: args.requestId,
  sessionId: args.sessionId,  // 同一个会话
  messages: args.messages,     // 全量消息历史
  // ...
})
```

PRD 中虽然描述了 Coordinator-Worker 隔离的概念（`WorkerStepResult` 结构体），但在实际代码中 Worker 接收到的是完整消息历史，而非精选上下文。

**Superpowers 方案**：subagent-driven-development 的核心原则就是上下文隔离：

> Fresh subagent per task + two-stage review = high quality, fast iteration
> You delegate tasks to specialized agents with isolated context. By precisely crafting their instructions and context, you ensure they stay focused and succeed at their task.
> They should never inherit your session's context or history — you construct exactly what they need.

**差距**：Worker 接收全量上下文会导致：
1. 大量执行细节快速填满上下文窗口
2. Coordinator 丢失早期的用户意图
3. 后续步骤决策质量下降

### 4.3 缺乏模型分级调度

**当前实现**：所有 Plan 模式调用使用同一模型（用户在配置中选择的模型）。

**Superpowers 方案**：subagent-driven-development 根据任务复杂度选择模型：

| 任务复杂度 | 推荐模型 |
|-----------|---------|
| 1-2 文件，规格明确 | 快速/便宜模型 |
| 多文件，集成关注 | 标准模型 |
| 设计判断，全局理解 | 最强模型 |

**差距**：所有任务用同一模型意味着简单机械任务（如添加字段）和复杂架构决策消耗同等的 Token 成本和时间。

### 4.4 缺乏完成验证铁律

**当前实现**：Worker 执行完成后，系统基于 AI 返回内容推断"步骤已完成"，不做独立验证：

```typescript
const summary = extractTextFromContent(res.content).slice(0, 500) || '步骤已完成'
// 直接标记 completed
```

**Superpowers 方案**：verification-before-completion 技能定义了一条"铁律"：

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

任何完成声明必须经过：识别验证命令 → 运行完整命令 → 读取完整输出 → 确认输出符合预期 → 才能声明。

**差距**：当前项目相信 AI 的自我报告（"步骤已完成"），而非独立验证。Superpowers 基于 24 个失败案例的经验明确反对这种做法。

### 4.5 缺乏结构化完成流程

**当前实现**：计划执行完成后，状态变为 `completed`，没有后续处理流程。

**Superpowers 方案**：finishing-a-development-branch 技能提供四个选项：
1. 本地合并到主分支
2. 创建 PR
3. 保留分支
4. 丢弃分支

并包含工作树清理、测试验证等步骤。

---

## 5. 总结：核心不足与改进方向

### 5.1 结构性不足（按影响程度排序）

| 排名 | 不足 | 当前表现 | Superpowers 做法 | 影响程度 |
|:---:|------|---------|-----------------|:---:|
| 1 | **无多轮澄清对话** | 单次 AI 调用直接生成计划 | 一次一个问题、渐进式理解需求 | 高 |
| 2 | **步骤缺乏完整内容** | 步骤仅一行文本描述 | 每步含完整代码、命令、预期输出 | 高 |
| 3 | **无逐任务审查** | Worker 执行后直接标记完成 | 两阶段审查 + 修复循环 | 高 |
| 4 | **无独立验证机制** | 相信 AI 自我报告 | 铁律：无证据不宣称完成 | 高 |
| 5 | **设计方案与计划未分离** | 混合在同一文档 | spec → plan 分层，各独立审批 | 中 |
| 6 | **无多方案对比** | 单一推荐方案 | 2-3 方案 + 权衡分析 | 中 |
| 7 | **步骤粒度无标准** | AI 自由决定 | 严格的 2-5 分钟/步 + TDD | 中 |
| 8 | **无文件结构映射** | 仅列出涉及文件 | 先定义文件职责再拆解任务 | 中 |
| 9 | **无设计/计划自审** | 仅占位符检查 | 一致性/范围/歧义多维度自审 | 中 |
| 10 | **缺少上下文隔离** | Worker 接收全量历史 | 子代理精确策展上下文 | 中 |
| 11 | **无模型分级调度** | 所有任务同一模型 | 按复杂度选模型 | 低 |
| 12 | **无结构化完成** | 仅标记状态 | 四个选项 + 清理 | 低 |

### 5.2 当前项目已经做得好的方面

为公平起见，当前项目在以下方面与 Superpowers 持平甚至更好：

| 方面 | 说明 |
|------|------|
| **权限隔离** | IPC 层工具 ACL（`planModeAcl.ts`），探索期只读，比 Superpowers 的纯 Prompt 约束更可靠 |
| **审批闸门** | 系统层强制执行，计划未获批前 Agent 无法获得写入工具，Superpowers 依赖 Agent 自觉 |
| **状态持久化** | JSON 数据库完整记录计划状态、版本历史、步骤结果、Git 快照，Superpowers 依赖文件系统 |
| **恢复机制** | 会话中断后可从数据库恢复计划状态继续执行，Superpowers 无此能力 |
| **计划版本管理** | Frontmatter 版本号 + 数据库版本历史数组，完整的拒绝/修订/重新审批循环 |
| **UI 集成** | React + Ant Design 嵌入式审批卡片，10 秒可理解，Superpowers 为纯终端交互 |
| **环境快照** | 审批时记录 Git HEAD，恢复时检测变更并提醒，Superpowers 无此机制 |
| **异常上报** | `plan-abort` 终止机制 + 终止报告卡片，探索期可提前终止 |

### 5.3 优先改进建议

**Phase 1（高优先级——补核心流程短板）**：
1. **引入澄清对话阶段**：在 Plan 模式下，AI 生成计划前必须先进行至少一轮澄清对话（可复用现有聊天流，但限制 AI 在澄清完成前不输出 `<plan-doc>`）
2. **加强计划内容完整性**：在 `planParser.ts` 中扩展验证逻辑，要求每个步骤必须包含：目标文件路径、预期代码变更方向（增/改/删）、验证方式
3. **加入执行后验证步骤**：每个步骤执行完成后，Worker 必须运行验证命令并提供输出证据，不依赖自我报告

**Phase 2（中优先级——提升计划质量）**：
4. **分离设计与计划文档**：当前的 7 章节模板可拆为设计文档（1-3 章）+ 实施计划（4-7 章），各有独立审批
5. **引入多方案对比**：修改 Coordinator 提示，要求 AI 在探索后先口头提出 2-3 个可行方案，用户选择后再生成详细计划
6. **增加计划自审环节**：在审批卡片展示前，系统侧对计划进行一致性检查（步骤依赖分析、文件路径存在性验证）

**Phase 3（低优先级——优化执行效率）**：
7. **上下文策展**：Worker 执行时只传递当前步骤相关的上下文，而非完整历史
8. **模型分级调度**：允许用户为不同计划阶段（探索/执行）配置不同模型

---

## 6. 一句话总结

> **SpaceAssistant Plan 模式的强项在"基础设施"（权限隔离、状态持久化、恢复机制、UI 体验），Superpowers 的强项在"流程设计"（澄清对话、多方案对比、高粒度步骤、逐任务审查、独立验证）。当前项目最关键的不足是：从用户需求到执行步骤之间缺少一个结构化的"理解→设计→验证"中间层，导致计划质量过度依赖单次 AI 调用的输出质量。**

---

## 7. 参考文件清单

### 当前项目 Plan 模式
| 文件路径 | 说明 |
|---------|------|
| `electron/plan/planPrompts.ts` | Coordinator/Worker 系统提示 |
| `electron/plan/planOrchestrator.ts` | 计划编排（规划阶段 + Worker 执行） |
| `electron/plan/planParser.ts` | 计划 Markdown 解析 + 审批摘要生成 |
| `electron/plan/planManager.ts` | 计划 CRUD + 状态管理 + 文件存储 |
| `electron/plan/planDocExtract.ts` | 从 AI 响应中提取 `<plan-doc>` / `<plan-abort>` |
| `electron/plan/planModeAcl.ts` | 计划模式工具访问控制 |
| `src/shared/planTypes.ts` | 计划类型定义 |
| `src/shared/planToolsFilter.ts` | 探索期只读工具过滤 |
| `docs/requirement/通用Agent-Plan模式MVP产品需求文档.md` | Plan 模式 PRD |

### Superpowers 技能
| 文件路径 | 说明 |
|---------|------|
| `skills/brainstorming/SKILL.md` | 需求探索与设计方案生成 |
| `skills/writing-plans/SKILL.md` | 实施计划编写 |
| `skills/executing-plans/SKILL.md` | 计划执行 |
| `skills/subagent-driven-development/SKILL.md` | 子代理驱动开发 |
| `skills/verification-before-completion/SKILL.md` | 完成前验证 |

---

**文档版本**: v1.0
**创建日期**: 2026-05-25
**分析人**: Claude Code Analysis