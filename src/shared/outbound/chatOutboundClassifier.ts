import type { SessionSkillsState, SkillDefinition, WikiConfig, WikiStatus } from '../../shared/domainTypes'
import { parseTestCardsCommand } from './testCardsCommandService'
import { parseTestPopCommand } from './testPopCommandService'
import { parseWikiCommand } from './wikiCommandService'
import { parseSkillCommand } from './skillCommandService'

export type OutboundMessageKind = 'immediate-command' | 'chat-run'

/** 出站分类的 IO 端口：两端各自注入本地实现（渲染端经预加载桥 / 主进程直连），分类逻辑保持纯函数 */
export type OutboundClassifierDeps = {
  isDev: boolean
  listSkills: () => Promise<SkillDefinition[]>
  getSkill: (payload: { name: string }) => Promise<SkillDefinition | null>
  wikiInit: (payload?: {
    overwrite?: boolean
    installSkill?: boolean
  }) => Promise<{ ok: true; rootPath: string; skillInstalled: boolean } | { ok: false; error: string }>
  wikiStatus: () => Promise<WikiStatus>
  wikiImportRaw: (payload: {
    srcRelPath: string
  }) => Promise<{ ok: true; rawRelPath: string; copied: boolean } | { ok: false; error: string }>
}

/** 执行中仍可立即处理的出站消息（/skill list 等），其余进入排队 */
export async function classifyOutboundMessageWithDeps(
  text: string,
  ctx: {
    wikiConfig: WikiConfig
    sessionSkillsState: SessionSkillsState
  },
  deps: OutboundClassifierDeps
): Promise<OutboundMessageKind> {
  const trimmed = text.trim()
  if (!trimmed) return 'chat-run'

  const testCmd = parseTestCardsCommand(trimmed, { isDev: deps.isDev })
  if (testCmd.type === 'command') return 'immediate-command'
  if (testCmd.type === 'run') return 'chat-run'

  const testPopCmd = parseTestPopCommand(trimmed, { isDev: deps.isDev })
  if (testPopCmd.type === 'command') return 'immediate-command'
  if (testPopCmd.type === 'run') return 'immediate-command'

  const wikiCmd = await parseWikiCommand(trimmed, ctx.wikiConfig, ctx.sessionSkillsState, {
    wikiInit: deps.wikiInit,
    wikiStatus: deps.wikiStatus,
    wikiImportRaw: deps.wikiImportRaw
  })
  if (wikiCmd.type === 'command') return 'immediate-command'
  if (wikiCmd.type === 'run') return 'chat-run'

  const skillCmd = await parseSkillCommand(trimmed, ctx.sessionSkillsState, {
    listSkills: deps.listSkills,
    getSkill: deps.getSkill
  })
  if (skillCmd.type === 'command') return 'immediate-command'

  return 'chat-run'
}

