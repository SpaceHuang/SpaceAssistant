import type { ClaudeChatMessageWithBlocks } from './api'
import { getStrictToolResultPairing } from './toolResultPairingStrict'

export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER = '[Tool result missing due to internal error]'
export const ORPHAN_REMOVED_MESSAGE = '[Orphaned tool result removed due to conversation resume]'
export const NO_CONTENT_MESSAGE = '[no content]'

export interface PairingRepairReport {
  repaired: boolean
  originalCount: number
  repairedCount: number
  fixes: {
    missingToolResult: number
    orphanedToolResult: number
    duplicateToolUseId: number
    duplicateToolResultId: number
    leadingAssistantDropped: number
    roleAlternationFixed: number
    emptyMessageFilled: number
  }
  messageStructure: string[]
}

export class ToolResultPairingError extends Error {
  readonly report: PairingRepairReport

  constructor(report: PairingRepairReport) {
    super(
      `ensureToolResultPairing: 配对不匹配（严格模式），拒绝修复以避免向模型注入合成数据。` +
        `修复详情: ${JSON.stringify(report.fixes)}。` +
        `消息结构: ${report.messageStructure.join('; ')}`
    )
    this.name = 'ToolResultPairingError'
    this.report = report
  }
}

type ContentBlock = Record<string, unknown>

export interface EnsureToolResultPairingOptions {
  strict?: boolean
}

function emptyFixes(): PairingRepairReport['fixes'] {
  return {
    missingToolResult: 0,
    orphanedToolResult: 0,
    duplicateToolUseId: 0,
    duplicateToolResultId: 0,
    leadingAssistantDropped: 0,
    roleAlternationFixed: 0,
    emptyMessageFilled: 0
  }
}

function isBlockArray(content: unknown): content is ContentBlock[] {
  return Array.isArray(content)
}

function getToolUseIds(content: ContentBlock[]): string[] {
  return content.filter((b) => b.type === 'tool_use' && typeof b.id === 'string').map((b) => b.id as string)
}

function getToolResultIds(content: ContentBlock[]): string[] {
  return content
    .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map((b) => b.tool_use_id as string)
}

function buildSyntheticResult(toolUseId: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
    is_error: true
  }
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function ensureNonEmptyContent(
  role: 'user' | 'assistant',
  content: string | ContentBlock[],
  fixes: PairingRepairReport['fixes']
): string | ContentBlock[] {
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      fixes.emptyMessageFilled++
      return role === 'user' ? ORPHAN_REMOVED_MESSAGE : NO_CONTENT_MESSAGE
    }
    return content
  }
  if (content.length === 0) {
    fixes.emptyMessageFilled++
    return [textBlock(NO_CONTENT_MESSAGE)]
  }
  return content
}

function mergeMessages(a: ClaudeChatMessageWithBlocks, b: ClaudeChatMessageWithBlocks): ClaudeChatMessageWithBlocks {
  const mergeContent = (
    left: string | ContentBlock[],
    right: string | ContentBlock[]
  ): string | ContentBlock[] => {
    if (typeof left === 'string' && typeof right === 'string') return `${left}\n${right}`.trim()
    const leftBlocks = typeof left === 'string' ? [textBlock(left)] : [...left]
    const rightBlocks = typeof right === 'string' ? [textBlock(right)] : [...right]
    return [...leftBlocks, ...rightBlocks]
  }
  return {
    role: a.role,
    content: mergeContent(a.content as string | ContentBlock[], b.content as string | ContentBlock[]),
    id: a.id ?? b.id,
    timestamp: a.timestamp ?? b.timestamp
  }
}

function buildMessageStructure(messages: ClaudeChatMessageWithBlocks[]): string[] {
  return messages.map((m, idx) => {
    if (!isBlockArray(m.content)) return `[${idx}] ${m.role}(text)`
    const toolUses = getToolUseIds(m.content)
    const toolResults = getToolResultIds(m.content)
    return `[${idx}] ${m.role}(use=[${toolUses.join(',')}],result=[${toolResults.join(',')}])`
  })
}

function throwIfStrict(report: PairingRepairReport, strict: boolean): void {
  if (strict && report.repaired) throw new ToolResultPairingError(report)
}

function processBlockMessages(
  messages: ClaudeChatMessageWithBlocks[],
  fixes: PairingRepairReport['fixes'],
  strict: boolean,
  report: PairingRepairReport
): ClaudeChatMessageWithBlocks[] {
  const allSeenToolUseIds = new Set<string>()
  const seenToolResultIds = new Set<string>()
  let pendingToolUseIds: string[] = []
  const result: ClaudeChatMessageWithBlocks[] = []

  const flushPendingResults = (userBlocks: ContentBlock[]): ContentBlock[] => {
    if (pendingToolUseIds.length === 0) return userBlocks

    const resultIds = new Set(getToolResultIds(userBlocks))
    const patched = [...userBlocks]
    for (const id of pendingToolUseIds) {
      if (!resultIds.has(id)) {
        fixes.missingToolResult++
        report.repaired = true
        throwIfStrict(report, strict)
        patched.push(buildSyntheticResult(id))
      }
    }
    pendingToolUseIds = []
    return patched
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      if (pendingToolUseIds.length > 0) {
        fixes.missingToolResult += pendingToolUseIds.length
        report.repaired = true
        throwIfStrict(report, strict)
        result.push({
          role: 'user',
          content: pendingToolUseIds.map((id) => buildSyntheticResult(id))
        })
        pendingToolUseIds = []
      }
      result.push(msg)
      continue
    }

    if (!isBlockArray(msg.content)) {
      result.push(msg)
      continue
    }

    if (msg.role === 'assistant') {
      if (pendingToolUseIds.length > 0) {
        fixes.missingToolResult += pendingToolUseIds.length
        report.repaired = true
        throwIfStrict(report, strict)
        result.push({
          role: 'user',
          content: pendingToolUseIds.map((id) => buildSyntheticResult(id))
        })
        pendingToolUseIds = []
      }

      const deduped: ContentBlock[] = []
      const newPending: string[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (allSeenToolUseIds.has(block.id)) {
            fixes.duplicateToolUseId++
            report.repaired = true
            throwIfStrict(report, strict)
            continue
          }
          allSeenToolUseIds.add(block.id)
          newPending.push(block.id)
          deduped.push(block)
        } else {
          deduped.push(block)
        }
      }
      pendingToolUseIds = newPending
      result.push({ ...msg, content: deduped })
      continue
    }

    let blocks: ContentBlock[] = []
    for (const block of msg.content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const id = block.tool_use_id
        if (!allSeenToolUseIds.has(id)) {
          fixes.orphanedToolResult++
          report.repaired = true
          throwIfStrict(report, strict)
          continue
        }
        if (seenToolResultIds.has(id)) {
          fixes.duplicateToolResultId++
          report.repaired = true
          throwIfStrict(report, strict)
          continue
        }
        seenToolResultIds.add(id)
        blocks.push(block)
      } else {
        blocks.push(block)
      }
    }

    blocks = flushPendingResults(blocks)

    if (blocks.length === 0) {
      fixes.orphanedToolResult++
      report.repaired = true
      throwIfStrict(report, strict)
      result.push({ role: 'user', content: ORPHAN_REMOVED_MESSAGE })
      continue
    }

    result.push({ ...msg, content: blocks })
  }

  if (pendingToolUseIds.length > 0) {
    fixes.missingToolResult += pendingToolUseIds.length
    report.repaired = true
    throwIfStrict(report, strict)
    result.push({
      role: 'user',
      content: pendingToolUseIds.map((id) => buildSyntheticResult(id))
    })
  }

  return result
}

function dropLeadingAssistants(
  messages: ClaudeChatMessageWithBlocks[],
  fixes: PairingRepairReport['fixes'],
  report: PairingRepairReport,
  strict: boolean
): ClaudeChatMessageWithBlocks[] {
  let trimmed = [...messages]
  while (trimmed.length > 0 && trimmed[0]!.role === 'assistant') {
    fixes.leadingAssistantDropped++
    report.repaired = true
    throwIfStrict(report, strict)
    trimmed = trimmed.slice(1)
  }
  if (trimmed.length === 0) {
    fixes.leadingAssistantDropped++
    report.repaired = true
    throwIfStrict(report, strict)
    return [{ role: 'user', content: ORPHAN_REMOVED_MESSAGE }]
  }
  return trimmed
}

function fixRoleAlternation(
  messages: ClaudeChatMessageWithBlocks[],
  fixes: PairingRepairReport['fixes'],
  report: PairingRepairReport,
  strict: boolean
): ClaudeChatMessageWithBlocks[] {
  if (messages.length === 0) return messages
  const out: ClaudeChatMessageWithBlocks[] = [messages[0]!]
  for (let i = 1; i < messages.length; i++) {
    const prev = out[out.length - 1]!
    const cur = messages[i]!
    if (prev.role === cur.role) {
      fixes.roleAlternationFixed++
      report.repaired = true
      throwIfStrict(report, strict)
      out[out.length - 1] = mergeMessages(prev, cur)
    } else {
      out.push(cur)
    }
  }
  return out
}

function fillEmptyMessages(
  messages: ClaudeChatMessageWithBlocks[],
  fixes: PairingRepairReport['fixes'],
  report: PairingRepairReport,
  strict: boolean
): ClaudeChatMessageWithBlocks[] {
  return messages.map((m) => {
    const before = JSON.stringify(m.content)
    const content = ensureNonEmptyContent(m.role, m.content as string | ContentBlock[], fixes)
    if (JSON.stringify(content) !== before) {
      report.repaired = true
      throwIfStrict(report, strict)
    }
    return { ...m, content }
  })
}

export function ensureToolResultPairing(
  messages: ClaudeChatMessageWithBlocks[],
  opts?: EnsureToolResultPairingOptions
): { messages: ClaudeChatMessageWithBlocks[]; report: PairingRepairReport } {
  const strict = opts?.strict ?? getStrictToolResultPairing()
  const report: PairingRepairReport = {
    repaired: false,
    originalCount: messages.length,
    repairedCount: 0,
    fixes: emptyFixes(),
    messageStructure: []
  }

  let working = dropLeadingAssistants(messages, report.fixes, report, strict)
  working = fixRoleAlternation(working, report.fixes, report, strict)
  working = processBlockMessages(working, report.fixes, strict, report)
  working = fillEmptyMessages(working, report.fixes, report, strict)

  report.repairedCount = working.length
  if (report.repaired) {
    report.messageStructure = buildMessageStructure(working)
  }

  return { messages: working, report }
}

/** 只读校验：检测是否需要修复，不修改消息 */
export function validateToolResultPairing(messages: ClaudeChatMessageWithBlocks[]): PairingRepairReport {
  try {
    return ensureToolResultPairing(messages, { strict: true }).report
  } catch (e) {
    if (e instanceof ToolResultPairingError) return e.report
    throw e
  }
}
