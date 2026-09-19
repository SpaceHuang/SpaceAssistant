export {
  classifyOutboundMessageWithDeps,
  type OutboundClassifierDeps,
  type OutboundMessageKind
} from '../../shared/outbound/chatOutboundClassifier'
import { classifyOutboundMessageWithDeps, type OutboundMessageKind } from '../../shared/outbound/chatOutboundClassifier'
import type { SessionSkillsState, WikiConfig } from '../../shared/domainTypes'

/** 渲染端过渡期包装（Phase 1c 收敛 submitOutbound 后删除）：注入 IPC 实现后复用 shared 纯函数 */
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
