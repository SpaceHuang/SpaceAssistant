import type { SessionSkillsState, WikiConfig } from '../../shared/domainTypes'
import { parseTestCardsCommand } from './testCardsCommandService'
import { parseTestPopCommand } from './testPopCommandService'
import { parseWikiCommand } from './wikiCommandService'
import { parseSkillCommand } from './skillCommandService'

export type OutboundMessageKind = 'immediate-command' | 'chat-run'

/** 执行中仍可立即处理的出站消息（/skill list 等），其余进入排队 */
export async function classifyOutboundMessage(
  text: string,
  ctx: {
    wikiConfig: WikiConfig
    sessionSkillsState: SessionSkillsState
  }
): Promise<OutboundMessageKind> {
  const trimmed = text.trim()
  if (!trimmed) return 'chat-run'

  const testCmd = parseTestCardsCommand(trimmed)
  if (testCmd.type === 'command') return 'immediate-command'
  if (testCmd.type === 'run') return 'chat-run'

  const testPopCmd = parseTestPopCommand(trimmed)
  if (testPopCmd.type === 'command') return 'immediate-command'
  if (testPopCmd.type === 'run') return 'immediate-command'

  const wikiCmd = await parseWikiCommand(trimmed, ctx.wikiConfig, ctx.sessionSkillsState)
  if (wikiCmd.type === 'command') return 'immediate-command'
  if (wikiCmd.type === 'run') return 'chat-run'

  const skillCmd = await parseSkillCommand(trimmed, ctx.sessionSkillsState)
  if (skillCmd.type === 'command') return 'immediate-command'

  return 'chat-run'
}
