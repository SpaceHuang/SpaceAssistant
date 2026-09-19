import type { SessionSkillsState, SkillDefinition, WikiConfig, WikiStatus } from '../../shared/domainTypes'
import { parseTestCardsCommand } from './testCardsCommandService'
import { parseTestPopCommand } from './testPopCommandService'
import { parseWikiCommand } from './wikiCommandService'
import { parseSkillCommand } from './skillCommandService'

export type OutboundMessageKind = 'immediate-command' | 'chat-run'

/** 出站分类的 IO 端口：两端各自注入实现（渲染端 window.api / 主进程直连），分类逻辑保持纯函数 */
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

/** 渲染端过渡期包装（Phase 1c 收敛 submitOutbound 后删除）：注入 IPC 实现后复用纯函数 */
export async function classifyOutboundMessage(
  text: string,
  ctx: {
    wikiConfig: WikiConfig
    sessionSkillsState: SessionSkillsState
  }
): Promise<OutboundMessageKind> {
  return classifyOutboundMessageWithDeps(text, ctx, {
    isDev: import.meta.env.DEV,
    listSkills: () => window.api.skillList(),
    getSkill: (payload) => window.api.skillGet(payload),
    wikiInit: (payload) => window.api.wikiInit(payload),
    wikiStatus: () => window.api.wikiStatus(),
    wikiImportRaw: (payload) => window.api.wikiImportRaw(payload)
  })
}
