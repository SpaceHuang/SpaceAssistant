import type { SkillDefinition } from '../../../src/shared/domainTypes'
import { parseFrontMatter, validateSkillMeta } from '../skillParser'

export const IM_TASK_ORCHESTRATION_SKILL_NAME = 'im-task-orchestration'

export const BUNDLED_IM_TASK_ORCHESTRATION_SKILL_MD = `---
name: im-task-orchestration
description: "在即时通讯中理解任务、先澄清或确认计划，再通过 Inbox 与 workflow 工具处理消息。"
triggers: []
version: "1.0.0"
author: "SpaceAssistant"
---

# 即时通讯任务编排

你正在通过即时通讯为用户处理请求。每轮先读取当前 Inbox 与 workflow 状态，再判断如何处理。

## 决策方式

- 简单、低风险且目标明确的问题可直接回答。
- 复杂任务、重要假设或可能产生外部影响的操作，先整理清晰计划并等待用户明确确认。
- 信息不足时先提出具体澄清问题，不要猜测关键目标。
- 用户修改目标时，更新计划并使用新的 revision；不要继续执行已过期计划。
- 当前 Loop 收到的消息都保留在 Inbox；由本 Skill 判断是追加到当前任务、开始新请求还是继续澄清。

## 消息与状态

- 用 Inbox 工具查看和领取当前即时通讯会话的消息；完成处理后 ack，暂不能处理时 release，长任务继续 renew。
- 用 workflow state 工具保存等待确认或澄清所需的计划、问题与 revision，使后续 Loop 可以恢复。
- 取消任务或修订计划时使用 \`task_cancel\` / \`task_revise_plan\`；不要自行改写可信任务 revision 或待办关联。
- 不得声称消息已完成持久化或任务状态已保存，除非相应工具成功返回。
- 不要将其他会话的消息或状态带入当前任务。
`

let cached: SkillDefinition | null = null

export function getBundledImTaskOrchestrationSkill(): SkillDefinition {
  if (cached) return cached
  const { frontMatter, content } = parseFrontMatter(BUNDLED_IM_TASK_ORCHESTRATION_SKILL_MD)
  const validated = validateSkillMeta(frontMatter)
  if (!validated.ok) throw new Error(validated.error)
  cached = {
    meta: validated.meta,
    content: content.trim(),
    scope: 'builtin',
    directoryPath: '',
    filePath: '',
    lastModified: 0
  }
  return cached
}
